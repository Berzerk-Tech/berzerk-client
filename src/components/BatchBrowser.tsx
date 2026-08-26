import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
} from "react";
import { getStationId } from "../lib/station";
import { subscribePrintJobsChanged } from "../lib/realtime";
import { printJob as itagPrintJob } from "../lib/itag/iprint";
import { applyMargin, type ApplyMarginInput } from "../lib/settings";
import * as printJobsService from "../services/printJobs";
import type {
  RfidPrintJob,
  RfidPrintJobStatus,
  JobAwaitingMovimentacao,
} from "../services/printJobs";
import { getIprintConfig, toRustConfig } from "../services/iprintConfig";
import { invoke } from "@tauri-apps/api/core";
import {
  buildPrintItems,
  fetchPendingBatches,
  fetchTodayHistory,
  markBatchRfidPrinted,
  unmarkBatchRfidPrinted,
  resolveBatch,
  searchBatchesGlobal,
  RECEIPT_STATUS_LABEL,
  type GlobalSearchEntry,
  type ProductionBatch,
  type ResolvedBatch,
  type PrintedBatchEntry,
} from "../services/batches";
import { logAction } from "../services/actionLog";
import { BatchCard, type CardState } from "./BatchCard";
import { PrintConfirmModal, type PrintOverride } from "./PrintConfirmModal";
import { BackButton } from "./BackButton";
import { AmbientBackground } from "./AmbientBackground";

const MAX_VISIBLE = 50;

/**
 * Movimentação via iTAG DESLIGADA por enquanto (pedido do Leonardo, 2026-07-28):
 * ainda não funciona e estava atrapalhando a operação. Esconde o contador e a
 * seção "Aguardando movimentação"; o código por baixo fica intacto — religar é
 * só virar esta flag.
 */
const MOVIMENTACAO_ENABLED: boolean = false;
// Uma chamada por lote (`GET /etiquetagem/lotes/:id/eans`) contra as três do
// Supabase. A concorrência agora só evita abrir 50 conexões de uma vez contra a
// API — não há mais rate limit de edge function a respeitar.
const CONCURRENCY = 6;

type PrintingState = { jobId: string; startedAt: number };
type Filter =
  | "all"
  | "ready"
  | "blocked"
  | "queue"
  | "history"
  | "awaiting";
type MovingState = { startedAt: number };

function formatError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object") {
    const err = e as { message?: string; code?: string; hint?: string };
    const parts: string[] = [];
    if (err.message) parts.push(err.message);
    if (err.code) parts.push(`[${err.code}]`);
    if (err.hint) parts.push(`hint: ${err.hint}`);
    if (parts.length > 0) return parts.join(" · ");
    try {
      return JSON.stringify(e);
    } catch {
      return String(e);
    }
  }
  return String(e);
}

async function resolveAllWithConcurrency(
  batches: ProductionBatch[],
  concurrency: number,
): Promise<ResolvedBatch[]> {
  const out: ResolvedBatch[] = new Array(batches.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, batches.length) },
    async () => {
      while (next < batches.length) {
        const i = next++;
        try {
          out[i] = await resolveBatch(batches[i]);
        } catch (e) {
          console.warn(
            "[BatchBrowser] resolveBatch failed for",
            batches[i].batch_code,
            e,
          );
          out[i] = {
            batch: batches[i],
            eans: {},
            skus: {},
            sources: {},
            missingSizes: batches[i].sizes.map((s) => s.size),
            isPrintable: false,
            catalogTitle: batches[i].design_name,
            catalogColor: batches[i].shirt_color,
            motivo: null,
          };
        }
      }
    },
  );
  await Promise.all(workers);
  return out;
}

export function BatchBrowser({
  operatorId,
  operatorEmail,
  onBack,
}: {
  /**
   * `sub` do JWT do Cognito. A API resolve o ator sozinha pelo Bearer — isto
   * aqui só alimenta o que ainda é LOCAL: o payload de auditoria que vai à
   * iTAG e o rótulo do operador na tela.
   */
  operatorId: string;
  operatorEmail: string;
  onBack: () => void;
}) {
  const [batches, setBatches] = useState<ResolvedBatch[]>([]);
  const [history, setHistory] = useState<PrintedBatchEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [printing, setPrinting] = useState<Map<string, PrintingState>>(
    new Map(),
  );
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [now, setNow] = useState(() => Date.now());
  const [filter, setFilter] = useState<Filter>("all");
  const [pendingConfirm, setPendingConfirm] = useState<ResolvedBatch | null>(
    null,
  );
  const [query, setQuery] = useState("");
  // batch_ids que têm impressão de teste pendente — habilita "Descartar teste".
  const [batchesWithTest, setBatchesWithTest] = useState<Set<string>>(
    new Set(),
  );
  const [activeJobs, setActiveJobs] = useState<RfidPrintJob[]>([]);
  const [awaitingJobs, setAwaitingJobs] = useState<JobAwaitingMovimentacao[]>(
    [],
  );
  const [movingJobs, setMovingJobs] = useState<Map<string, MovingState>>(
    new Map(),
  );
  const [realtimeStatus, setRealtimeStatus] = useState<
    "connecting" | "connected" | "disconnected"
  >("connecting");
  // Busca na base toda (sem filtro de status/estampa): acionada pelo operador
  // quando o lote não está na listagem normal. null = ainda não buscou.
  const [globalResults, setGlobalResults] = useState<
    GlobalSearchEntry[] | null
  >(null);
  const [searchingGlobal, setSearchingGlobal] = useState(false);
  const [resolvingGlobal, setResolvingGlobal] = useState<Set<string>>(
    new Set(),
  );

  const stationId = getStationId();

  const load = useCallback(async (showRefreshing: boolean) => {
    if (showRefreshing) setRefreshing(true);
    try {
      const [pending, hist] = await Promise.all([
        fetchPendingBatches(),
        fetchTodayHistory(),
      ]);
      const visible = pending.slice(0, MAX_VISIBLE);
      // Resolve tudo de uma vez. Antes havia DOIS passos — um rápido com o
      // cache local e outro em background chamando a edge `shopify-analytics`
      // — porque aquele fallback era lento e podia falhar. O catálogo do nexus
      // responde numa chamada por lote, então o segundo passo (e o cache em
      // localStorage que o amortizava) deixaram de existir.
      const resolved = await resolveAllWithConcurrency(visible, CONCURRENCY);
      setBatches(resolved);
      setHistory(hist);
      // Quais lotes visíveis têm impressão de teste pra limpar (botão no card).
      // allSettled-style: falha aqui não derruba o load.
      try {
        const testSet = await printJobsService.fetchBatchesWithTestJobs(
          visible.map((b) => b.id),
        );
        setBatchesWithTest(testSet);
      } catch (e) {
        console.warn("[BatchBrowser] fetchBatchesWithTestJobs failed:", e);
      }
      setLoadError(null);
    } catch (e) {
      console.error("[BatchBrowser] load error:", e);
      setLoadError(formatError(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  // Mantém a lista em sintonia com o industrial: lote entra/sai da etapa "Env.
  // Recebimento" lá e tem que refletir aqui sem clicar Atualizar. O Realtime do
  // Supabase não está habilitado pra silk_records, então poll silencioso (sem
  // limpar caches → barato) + refetch ao focar a janela.
  useEffect(() => {
    const POLL_MS = 30_000;
    const refetch = () => {
      if (document.visibilityState === "visible") void load(false);
    };
    const id = setInterval(refetch, POLL_MS);
    document.addEventListener("visibilitychange", refetch);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", refetch);
    };
  }, [load]);

  // Fila de impressão: fetch + evento `print-jobs.changed` do WS do nexus.
  //
  // Substitui o Realtime do Supabase (`postgres_changes` em `rfid_print_jobs`,
  // canal `rfid-print-jobs-queue`). Mesma disciplina do resto do app: o WS é
  // GATILHO — quem recebe refaz o fetch —, e `onChange` também dispara ao
  // (re)conectar, ressincronizando o que se perdeu offline.
  useEffect(() => {
    let alive = true;
    async function loadJobs() {
      // Independentes: uma falha na lista de movimentação não pode derrubar a
      // fila de impressão. allSettled isola as duas.
      const [jobsRes, awaitingRes] = await Promise.allSettled([
        printJobsService.fetchActivePrintJobs(),
        printJobsService.fetchJobsAwaitingMovimentacao(),
      ]);
      if (!alive) return;
      if (jobsRes.status === "fulfilled") {
        setActiveJobs(jobsRes.value);
      } else {
        console.warn("[BatchBrowser] fetchActivePrintJobs falhou:", jobsRes.reason);
      }
      if (awaitingRes.status === "fulfilled") {
        setAwaitingJobs(awaitingRes.value);
      } else {
        console.warn(
          "[BatchBrowser] fetchJobsAwaitingMovimentacao falhou:",
          awaitingRes.reason,
        );
      }
    }
    const parar = subscribePrintJobsChanged(
      () => void loadJobs(),
      (status) => {
        if (alive) setRealtimeStatus(status);
      },
    );
    return () => {
      alive = false;
      parar();
    };
  }, []);

  // Tick por segundo quando há jobs imprimindo (local OU global)
  const hasPrintingJobs =
    printing.size > 0 || activeJobs.some((j) => j.status === "imprimindo");
  useEffect(() => {
    if (!hasPrintingJobs) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [hasPrintingJobs]);

  const requestPrint = useCallback((resolved: ResolvedBatch) => {
    if (!resolved.isPrintable) return;
    setPendingConfirm(resolved);
  }, []);

  // Descarta SÓ as etiquetas de teste de um lote: apaga os EPCs dos jobs
  // is_test e cancela esses jobs. O LOTE continua na Produção pra impressão
  // real. Recarrega pra refletir o estado do banco.
  const handleDiscardTest = useCallback(
    async (batchId: string, batchCode: string) => {
      const ok = window.confirm(
        `Descartar as etiquetas de TESTE do lote ${batchCode}?\n\n` +
          "Apaga só os EPCs gravados em impressões de teste. O lote continua " +
          "na Produção pra impressão real.",
      );
      if (!ok) return;
      // Otimista: remove o lote da marca de "tem teste" pra sumir o botão.
      setBatchesWithTest((prev) => {
        const next = new Set(prev);
        next.delete(batchId);
        return next;
      });
      try {
        await printJobsService.discardTestForBatch(batchId);
        logAction({
          action: "descartar_teste",
          batchId,
        });
      } catch (e) {
        console.error("[BatchBrowser] discardTestForBatch failed:", e);
        window.alert(
          `Falha ao descartar teste de ${batchCode}: ${formatError(e)}`,
        );
      } finally {
        load(false);
      }
    },
    [load, operatorId, operatorEmail],
  );

  const confirmAndPrint = useCallback(
    async (marginConfig: ApplyMarginInput, override?: PrintOverride) => {
      const resolved = pendingConfirm;
      if (!resolved) return;
      setPendingConfirm(null);
      const batch = resolved.batch;

      setErrors((m) => {
        if (!m.has(batch.id)) return m;
        const next = new Map(m);
        next.delete(batch.id);
        return next;
      });

      const isManual = !!override?.manualItems;
      const isTest = !!override?.test;
      // Manual ganha da margem; teste sobrescreve tudo no fim.
      let items = override?.manualItems
        ? override.manualItems
        : applyMargin(buildPrintItems(resolved), marginConfig);
      // MODO TESTE — REMOVER APÓS HOMOLOGAÇÃO
      // Sobrescreve a lista: 1 único item com `count` etiquetas no 1º tamanho.
      if (override?.test && items.length > 0) {
        items = [{ ...items[0], quantity: override.test.count }];
      }
      const totalRequested = items.reduce((sum, i) => sum + i.quantity, 0);

      let jobId: string;
      try {
        // Sem `batchCode`, `shirtColor`, `designName`, `totalEtiquetas` nem
        // operador: o servidor lê o retrato do lote no banco, soma o total dos
        // itens e resolve o ator pelo Bearer. Menos coisa que o cliente pode
        // mandar errado.
        jobId = await printJobsService.createPrintJob({
          batchId: batch.id,
          items,
          stationId,
          isTest,
          isManual,
        });
      } catch (e) {
        setErrors((m) => new Map(m).set(batch.id, formatError(e)));
        return;
      }

      setPrinting((m) =>
        new Map(m).set(batch.id, { jobId, startedAt: Date.now() }),
      );

      try {
        const result = await itagPrintJob({
          jobId,
          batchId: batch.id,
          batchCode: batch.batch_code,
          items,
          shirtColor: resolved.catalogColor ?? batch.shirt_color,
          designName: batch.design_name,
          operatorId,
          audit: { operatorName: operatorEmail },
        });

        if (result.success) {
          // Grava a contagem REAL de etiquetas queimadas (EPCs da iTAG), que
          // pode ser < solicitado em impressão parcial. Se foi teste, o lote
          // passa a ter teste pra limpar.
          await printJobsService.markDone(jobId, result.count);
          const partial = result.count > 0 && result.count < totalRequested;
          if (isTest) {
            setBatchesWithTest((prev) => new Set(prev).add(batch.id));
            logAction({
              action: "impressao_teste",
              batchId: batch.id,
              jobId,
              details: { printed: result.count, requested: totalRequested },
            });
          } else if (partial) {
            // PARCIAL: NÃO estampa — o lote FICA na fila pra completar as
            // etiquetas que faltam (impressão manual por tamanho). Estampar
            // aqui tirava o lote da fila com peças sem etiqueta (lote 1146:
            // 1000 de 1474, as 474 restantes sumiam da vista).
            setErrors((m) =>
              new Map(m).set(
                batch.id,
                `Impressão parcial: ${result.count} de ${totalRequested} etiquetas. ` +
                  "O lote continua na fila — use a impressão manual (✋) pra completar o restante.",
              ),
            );
            logAction({
              action: "impressao_parcial",
              batchId: batch.id,
              jobId,
              details: { printed: result.count, requested: totalRequested },
            });
          } else if (result.count > 0) {
            // Estampa rfid_impresso_at — é o que tira o lote da fila e o põe
            // no Histórico (fonte única; count 0 = nada queimado, não estampa).
            let stamped = 0;
            try {
              stamped = await markBatchRfidPrinted(batch.id);
              if (stamped === 0) {
                console.warn(
                  `[BatchBrowser] rfid_impresso_at não estampado pra ${batch.batch_code} ` +
                    "(já estampado ou RLS sem UPDATE em production_batches).",
                );
              }
            } catch (e) {
              console.warn("[BatchBrowser] markBatchRfidPrinted falhou:", e);
            }
            logAction({
              action: "impressao_concluida",
              batchId: batch.id,
              jobId,
              details: {
                printed: result.count,
                requested: totalRequested,
                isManual,
                stamped: stamped > 0,
              },
            });
          }
        } else {
          const detail = result.stage ? ` (${result.stage})` : "";
          const msg = result.error + detail;
          await printJobsService.markFailed(jobId, msg);
          setErrors((m) => new Map(m).set(batch.id, msg));
          logAction({
            action: "impressao_falhou",
            batchId: batch.id,
            jobId,
            details: { error: msg },
          });
        }
      } catch (e) {
        const msg = formatError(e);
        try {
          await printJobsService.markFailed(jobId, msg);
        } catch {
          /* swallow */
        }
        setErrors((m) => new Map(m).set(batch.id, msg));
        logAction({
          action: "impressao_falhou",
          batchId: batch.id,
          jobId,
          details: { error: msg },
        });
      } finally {
        setPrinting((m) => {
          const next = new Map(m);
          next.delete(batch.id);
          return next;
        });
        load(false);
      }
    },
    [pendingConfirm, stationId, operatorId, operatorEmail, load],
  );

  // Reimpressão: limpa a estampa e o lote volta pra fila. Pro caso de job
  // `done` cuja impressão física falhou (iTAG gera EPCs na hora, impressora
  // pode falhar depois sem feedback).
  const handleReprint = useCallback(
    async (entry: PrintedBatchEntry) => {
      const ok = window.confirm(
        `Voltar o lote ${entry.batch_code} pra fila de impressão?\n\n` +
          "Use quando a impressão física falhou. As etiquetas do job antigo " +
          "continuam no inventário; a movimentação só move o que a iTAG " +
          "confirmar impresso.",
      );
      if (!ok) return;
      try {
        await unmarkBatchRfidPrinted(entry.id);
        logAction({
          action: "reimpressao_enfileirada",
          batchId: entry.id,
          details: { origem: "historico" },
        });
      } catch (e) {
        window.alert(
          `Falha ao voltar ${entry.batch_code} pra fila: ${formatError(e)}`,
        );
      } finally {
        load(false);
      }
    },
    [load, operatorId, operatorEmail],
  );

  // Mudou o termo → resultado da base toda fica obsoleto.
  useEffect(() => {
    setGlobalResults(null);
  }, [query]);

  const handleGlobalSearch = useCallback(async () => {
    const term = query.trim();
    if (!term) return;
    setSearchingGlobal(true);
    try {
      setGlobalResults(await searchBatchesGlobal(term));
    } catch (e) {
      window.alert(`Busca na base toda falhou: ${formatError(e)}`);
    } finally {
      setSearchingGlobal(false);
    }
  }, [query]);

  // "Voltar pra fila" a partir da busca global: limpa a estampa de impresso.
  // Se o lote não estiver mais na etapa Env. Recebimento, avisa que ele só
  // reaparece na fila quando o industrial trouxer ele de volta pra etapa.
  const handleGlobalReturnToQueue = useCallback(
    async (entry: GlobalSearchEntry) => {
      const inStage = entry.batch.receiptStatus === "enviado_recebimento";
      const statusLabel =
        RECEIPT_STATUS_LABEL[entry.batch.receiptStatus] ??
        entry.batch.receiptStatus;
      const ok = window.confirm(
        `Voltar o lote ${entry.batch.batch_code} pra fila de impressão?\n\n` +
          (inStage
            ? "Ele volta a aparecer na lista de Prontos pra imprimir."
            : `Atenção: o lote está em "${statusLabel}" no industrial — a estampa ` +
              "de impresso será limpa, mas ele só reaparece na fila quando voltar " +
              "pra etapa Env. Recebimento."),
      );
      if (!ok) return;
      try {
        await unmarkBatchRfidPrinted(entry.batch.id);
        logAction({
          action: "reimpressao_enfileirada",
          batchId: entry.batch.id,
          details: {
            origem: "busca_global",
            receiptStatus: entry.batch.receiptStatus,
          },
        });
        setGlobalResults((prev) =>
          prev?.map((g) =>
            g.batch.id === entry.batch.id
              ? { ...g, rfid_impresso_at: null }
              : g,
          ) ?? prev,
        );
      } catch (e) {
        window.alert(
          `Falha ao voltar ${entry.batch.batch_code} pra fila: ${formatError(e)}`,
        );
      } finally {
        load(false);
      }
    },
    [load, operatorId, operatorEmail],
  );

  // Imprimir direto do resultado da busca global (consulta/reimpressão):
  // resolve EAN13 e abre o mesmo modal de confirmação do fluxo normal.
  const handleGlobalPrint = useCallback(
    async (entry: GlobalSearchEntry) => {
      const id = entry.batch.id;
      if (resolvingGlobal.has(id)) return;
      setResolvingGlobal((s) => new Set(s).add(id));
      try {
        const resolved = await resolveBatch(entry.batch);
        if (!resolved.isPrintable) {
          window.alert(
            `Lote ${entry.batch.batch_code} sem cobertura de EAN13 ` +
              `(faltam: ${resolved.missingSizes.join(", ") || "todos"}). ` +
              "Coordenador precisa cadastrar no catálogo do industrial.",
          );
          return;
        }
        setPendingConfirm(resolved);
      } catch (e) {
        window.alert(`Falha ao preparar impressão: ${formatError(e)}`);
      } finally {
        setResolvingGlobal((s) => {
          const next = new Set(s);
          next.delete(id);
          return next;
        });
      }
    },
    [resolvingGlobal],
  );

  const q = query.trim().toLowerCase();
  const matchesQuery = (text: string | null | undefined) =>
    !q || (text ? text.toLowerCase().includes(q) : false);
  const batchMatches = (b: ResolvedBatch) =>
    !q ||
    matchesQuery(b.batch.batch_code) ||
    matchesQuery(b.batch.design_name) ||
    matchesQuery(b.catalogTitle);

  // Lote agrupado é sempre imprimível; o único gate restante é a cobertura de
  // EAN13 (isPrintable). Sem EAN → "Faltando info".
  const ready = batches.filter((b) => b.isPrintable && batchMatches(b));
  const blocked = batches.filter((b) => !b.isPrintable && batchMatches(b));
  const filteredHistory = history.filter(
    (h) => !q || matchesQuery(h.batch_code) || matchesQuery(h.design_name),
  );
  const filteredAwaiting = awaitingJobs.filter(
    (a) =>
      !q ||
      matchesQuery(a.job.batch_code) ||
      matchesQuery(a.job.design_name),
  );

  const totalReady = batches.filter((b) => b.isPrintable).length;
  const totalBlocked = batches.length - totalReady;

  const handleMovimentar = useCallback(
    async (entry: JobAwaitingMovimentacao) => {
      const job = entry.job;
      if (movingJobs.has(job.id)) return;
      const config = getIprintConfig();
      if (!config.basicUser || !config.basicPass) {
        window.alert("Credenciais iTAG não configuradas em Settings.");
        return;
      }
      const ok = window.confirm(
        `Movimentar ${entry.pendingCount} EPC(s) do lote ${job.batch_code} ` +
          `pra situação ${config.situacaoDestino}?\n\n` +
          `Empresa origem ${config.empresaOrigem} → destino ${config.empresaDestino}.`,
      );
      if (!ok) return;

      setMovingJobs(
        (m) => new Map(m).set(job.id, { startedAt: Date.now() }),
      );
      try {
        const epcs = await printJobsService.fetchEpcsByJob(job.id);
        let pendingEpcs = epcs.filter((e) => !e.moved_at).map((e) => e.epc);
        if (pendingEpcs.length === 0) {
          // Nada a mover — refresh e sai
          const refreshed = await printJobsService.fetchJobsAwaitingMovimentacao();
          setAwaitingJobs(refreshed);
          return;
        }

        // Reconcilia com a iTAG: pergunta a situação REAL dos EPCs antes de
        // mover, em vez de confiar cego no estado local. Só move o que a iTAG
        // confirma existir no inventário (= impresso de fato). Se a consulta
        // falhar, segue com o estado local pra não travar a movimentação.
        const codigoInventario = epcs.find(
          (e) => e.codigo_inventario_itag != null,
        )?.codigo_inventario_itag;
        if (codigoInventario != null) {
          try {
            // Pagina até o fim: job grande (ex: 1474 EPCs) não cabe numa página
            // de 500 — sem o loop, só os 500 primeiros eram confirmados.
            const real: Array<{ epc: string; situacao: number | null }> = [];
            const PAGE_SIZE = 500;
            for (let page = 0; page < 40; page++) {
              const chunk = await invoke<
                Array<{ epc: string; situacao: number | null }>
              >("itag_iprint_query_inventory", {
                config: toRustConfig(config),
                codigoInventario,
                page,
                size: PAGE_SIZE,
              });
              real.push(...chunk);
              if (chunk.length < PAGE_SIZE) break;
            }
            const realByEpc = new Map<string, number | null>();
            for (const r of real) {
              realByEpc.set(r.epc.trim().toUpperCase(), r.situacao);
            }
            // Atualiza situação local com a verdade da iTAG.
            await printJobsService.reconcileSituacaoFromItag(
              real
                .filter((r) => r.situacao != null)
                .map((r) => ({ epc: r.epc, situacao: r.situacao as number })),
            );
            // Só move o que a iTAG confirma ter impresso.
            const confirmed = pendingEpcs.filter((e) =>
              realByEpc.has(e.trim().toUpperCase()),
            );
            if (confirmed.length < pendingEpcs.length) {
              console.warn(
                `[BatchBrowser] reconcile: ${pendingEpcs.length - confirmed.length} EPC(s) ` +
                  `pendentes não constam na iTAG — não serão movimentados.`,
              );
            }
            pendingEpcs = confirmed;
          } catch (recErr) {
            console.warn(
              "[BatchBrowser] reconcile com iTAG falhou, seguindo com estado local:",
              recErr,
            );
          }
        }

        if (pendingEpcs.length === 0) {
          window.alert(
            `Nenhum EPC do lote ${job.batch_code} foi confirmado como impresso na iTAG. ` +
              "Verifique a impressão antes de movimentar.",
          );
          const refreshed = await printJobsService.fetchJobsAwaitingMovimentacao();
          setAwaitingJobs(refreshed);
          return;
        }

        await invoke("itag_iprint_movimentar", {
          config: toRustConfig(config),
          epcs: pendingEpcs,
          notaFiscal: job.batch_code,
          situacaoDestino: config.situacaoDestino,
          empresaOrigem: config.empresaOrigem,
          empresaDestino: config.empresaDestino,
        });

        await printJobsService.markMoved({
          epcs: pendingEpcs,
          situacaoDestino: config.situacaoDestino,
        });
        logAction({
          action: "movimentar",
          batchId: job.batch_id,
          jobId: job.id,
          details: {
            epcs: pendingEpcs.length,
            situacaoDestino: config.situacaoDestino,
            empresaOrigem: config.empresaOrigem,
            empresaDestino: config.empresaDestino,
          },
        });

        const refreshed = await printJobsService.fetchJobsAwaitingMovimentacao();
        setAwaitingJobs(refreshed);
      } catch (e) {
        const msg = formatError(e);
        console.error("[BatchBrowser] handleMovimentar failed:", e);
        logAction({
          action: "movimentar_falhou",
          batchId: job.batch_id,
          jobId: job.id,
          details: { error: msg },
        });
        window.alert(`Movimentação falhou: ${msg}`);
      } finally {
        setMovingJobs((m) => {
          const next = new Map(m);
          next.delete(job.id);
          return next;
        });
      }
    },
    [movingJobs, operatorId, operatorEmail],
  );

  function cardStateFor(batchId: string): CardState {
    const p = printing.get(batchId);
    if (p) {
      return {
        kind: "printing",
        elapsedSec: Math.floor((now - p.startedAt) / 1000),
      };
    }
    const e = errors.get(batchId);
    if (e) return { kind: "failed", error: e };
    return { kind: "idle" };
  }

  const toggleFilter = (f: Filter) =>
    setFilter((cur) => (cur === f ? "all" : f));

  const showQueue = filter === "all" || filter === "queue";
  const showAwaiting = filter === "all" || filter === "awaiting";
  const showReady = filter === "all" || filter === "ready";
  const showBlocked = filter === "all" || filter === "blocked";
  const showHistory = filter === "all" || filter === "history";

  const printingCount = activeJobs.filter((j) => j.status === "imprimindo").length;
  const failedCount = activeJobs.filter((j) => j.status === "falhou").length;

  // iTAG cloud reachability: inferido do histórico recente.
  // Sem endpoint de health-check dedicado, usa o último outcome conhecido:
  // - failed recente → vermelho
  // - done recente → verde
  // - sem dados → cinza
  const itagStatus: "ok" | "failing" | "unknown" = (() => {
    const HOUR = 60 * 60 * 1000;
    const cutoff = Date.now() - HOUR;
    const recentFailed = activeJobs.some(
      (j) =>
        j.status === "falhou" &&
        j.completed_at &&
        new Date(j.completed_at).getTime() > cutoff,
    );
    if (recentFailed) return "failing";
    const recentDone = history.some(
      (h) => new Date(h.rfid_impresso_at).getTime() > cutoff,
    );
    if (recentDone) return "ok";
    return "unknown";
  })();

  const handleCancelJob = useCallback((job: RfidPrintJob) => {
    if (job.status === "imprimindo") {
      const ok = window.confirm(
        `Cancelar impressão de ${job.batch_code}?\n\n` +
          "A impressora RFID pode continuar imprimindo as etiquetas que já foram enviadas pra ela. " +
          "Use isso só pra remover da fila visual.",
      );
      if (!ok) return;
    }
    printJobsService.cancelPrintJob(job.id).catch((e) => {
      console.error("[BatchBrowser] cancelPrintJob failed:", e);
    });
  }, []);

  return (
    <div style={page}>
      <AmbientBackground variant="flat" />
      <header style={subHeader}>
        <div style={subHeaderLeft}>
          <BackButton onClick={onBack} />
        </div>
        <div style={subHeaderCenter}>
          <h2 style={subHeaderTitle}>Impressão</h2>
          <div style={searchWrap}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={searchIcon}
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.3-4.3" />
            </svg>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar por código de lote ou estampa…"
              style={searchInput}
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                style={clearBtn}
                aria-label="Limpar busca"
              >
                ✕
              </button>
            )}
          </div>
        </div>
        <div style={subHeaderRight}>
          <StatusChip
            label="Realtime"
            tone={
              realtimeStatus === "connected"
                ? "ok"
                : realtimeStatus === "connecting"
                  ? "warn"
                  : "fail"
            }
            tooltip={
              realtimeStatus === "connected"
                ? "Realtime conectado (atualiza ao vivo)"
                : realtimeStatus === "connecting"
                  ? "Conectando ao Realtime…"
                  : "Sem conexão Realtime — Atualizar manualmente"
            }
          />
          <StatusChip
            label="iTAG"
            tone={
              itagStatus === "ok"
                ? "ok"
                : itagStatus === "failing"
                  ? "fail"
                  : "neutral"
            }
            tooltip={
              itagStatus === "ok"
                ? "iTAG cloud OK — último print recente concluído"
                : itagStatus === "failing"
                  ? "iTAG cloud falhou na última hora — pode ter problema"
                  : "iTAG cloud sem dados recentes — status desconhecido"
            }
          />
          <button
            onClick={() => load(true)}
            disabled={refreshing}
            style={refreshing ? refreshBtnBusy : refreshBtn}
          >
            {refreshing ? "Atualizando…" : "Atualizar"}
          </button>
        </div>
      </header>

      <main style={main}>
        <div style={statsRow}>
          <Stat
            label="prontos"
            value={totalReady}
            accent="success"
            active={filter === "ready"}
            onClick={() => toggleFilter("ready")}
          />
          <Stat
            label="faltando"
            value={totalBlocked}
            accent="warning"
            active={filter === "blocked"}
            onClick={() => toggleFilter("blocked")}
          />
          {activeJobs.length > 0 && (
            <Stat
              label="na fila"
              value={activeJobs.length}
              accent="info"
              active={filter === "queue"}
              onClick={() => toggleFilter("queue")}
            />
          )}
          {MOVIMENTACAO_ENABLED && awaitingJobs.length > 0 && (
            <Stat
              label="movimentar"
              value={awaitingJobs.length}
              accent="info"
              active={filter === "awaiting"}
              onClick={() => toggleFilter("awaiting")}
            />
          )}
          <Stat
            label="impressos hoje"
            value={history.length}
            accent="muted"
            active={filter === "history"}
            onClick={() => toggleFilter("history")}
          />
        </div>

        {loadError && (
          <div style={errorBox}>
            <strong>Erro ao carregar:</strong>{" "}
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
              {loadError}
            </span>
          </div>
        )}

        {loading ? (
          <div style={loadingState}>Carregando lotes…</div>
        ) : (
          <>
            {showQueue && activeJobs.length > 0 && (
              <Section
                title="Fila de impressão"
                count={activeJobs.length}
                accent={
                  failedCount > 0
                    ? "warning"
                    : printingCount > 0
                      ? "info"
                      : "muted"
                }
              >
                <div style={queueList}>
                  {activeJobs.map((j) => (
                    <PrintJobRow
                      key={j.id}
                      job={j}
                      nowTs={now}
                      onCancel={handleCancelJob}
                    />
                  ))}
                </div>
              </Section>
            )}

            {MOVIMENTACAO_ENABLED && showAwaiting && filteredAwaiting.length > 0 && (
              <Section
                title="Aguardando movimentação"
                count={filteredAwaiting.length}
                accent="info"
                hint="Lotes impressos cujos EPCs ainda não foram movimentados no iTAG. Clica em 'Movimentar' pra liberar pro uso."
              >
                <div style={queueList}>
                  {filteredAwaiting.map((a) => (
                    <AwaitingMovRow
                      key={a.job.id}
                      entry={a}
                      moving={movingJobs.has(a.job.id)}
                      onMovimentar={handleMovimentar}
                    />
                  ))}
                </div>
              </Section>
            )}

            {showReady && (
              <Section
                title="Prontos pra imprimir"
                count={ready.length}
                accent="success"
              >
                {ready.length === 0 ? (
                  <EmptyState text="Sem lotes prontos no momento." />
                ) : (
                  ready.map((r) => (
                    <BatchCard
                      key={r.batch.id}
                      resolved={r}
                      state={cardStateFor(r.batch.id)}
                      onPrint={requestPrint}
                      onDiscardTest={() =>
                        handleDiscardTest(r.batch.id, r.batch.batch_code)
                      }
                      hasTest={batchesWithTest.has(r.batch.id)}
                    />
                  ))
                )}
              </Section>
            )}

            {showBlocked && blocked.length > 0 && (
              <Section
                title="Faltando info"
                count={blocked.length}
                accent="warning"
                hint="Coordenador precisa cadastrar EAN13 no catálogo do industrial."
              >
                {blocked.map((r) => (
                  <BatchCard
                    key={r.batch.id}
                    resolved={r}
                    state={cardStateFor(r.batch.id)}
                    onPrint={requestPrint}
                    onDiscardTest={() =>
                      handleDiscardTest(r.batch.id, r.batch.batch_code)
                    }
                    hasTest={batchesWithTest.has(r.batch.id)}
                  />
                ))}
              </Section>
            )}

            {showHistory && filteredHistory.length > 0 && (
              <Section
                title="Histórico de hoje"
                count={filteredHistory.length}
                accent="muted"
              >
                <div style={historyList}>
                  {filteredHistory.map((h) => (
                    <div key={h.id} style={historyRow}>
                      {h.thumbnail_url ? (
                        <img
                          src={h.thumbnail_url}
                          alt=""
                          loading="lazy"
                          style={historyThumb}
                        />
                      ) : (
                        <span style={historyThumbPlaceholder} />
                      )}
                      <span style={historyCode}>{h.batch_code}</span>
                      <span style={historyName}>{h.design_name ?? "—"}</span>
                      <span style={historyQty}>{h.total_pieces} etiq.</span>
                      <span style={historyTime}>
                        {formatTime(h.rfid_impresso_at)}
                      </span>
                      <button
                        type="button"
                        style={historyReprintBtn}
                        title="Impressão física falhou? Volta o lote pra fila."
                        onClick={() => handleReprint(h)}
                      >
                        ↩ Voltar pra fila
                      </button>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {q &&
              ready.length === 0 &&
              blocked.length === 0 &&
              filteredHistory.length === 0 &&
              filteredAwaiting.length === 0 && (
                <EmptyState
                  text={`Nenhum lote na fila bate com "${query}".`}
                />
              )}

            {q && globalResults === null && (
              <div style={globalSearchWrap}>
                <button
                  onClick={handleGlobalSearch}
                  disabled={searchingGlobal}
                  style={searchingGlobal ? globalSearchBtnBusy : globalSearchBtn}
                >
                  {searchingGlobal
                    ? "Buscando na base toda…"
                    : `🔍 Buscar "${query.trim()}" na base toda`}
                </button>
                <span style={globalSearchHint}>
                  Procura em todos os lotes do industrial, incluindo já
                  impressos e fora da etapa de recebimento.
                </span>
              </div>
            )}

            {q && globalResults !== null && (
              <Section
                title="Base toda"
                count={globalResults.length}
                accent="muted"
                hint="Todos os status — consulte, reimprima ou volte o lote pra fila."
              >
                {globalResults.length === 0 ? (
                  <EmptyState
                    text={`Nada na base toda pra "${query.trim()}".`}
                  />
                ) : (
                  <div style={historyList}>
                    {globalResults.map((g) => (
                      <GlobalResultRow
                        key={g.batch.id}
                        entry={g}
                        resolving={resolvingGlobal.has(g.batch.id)}
                        onPrint={handleGlobalPrint}
                        onReturnToQueue={handleGlobalReturnToQueue}
                      />
                    ))}
                  </div>
                )}
              </Section>
            )}

            {!q &&
              filter !== "all" &&
              ((filter === "ready" && ready.length === 0) ||
                (filter === "blocked" && blocked.length === 0) ||
                (filter === "history" && history.length === 0) ||
                (filter === "awaiting" && awaitingJobs.length === 0)) && (
                <EmptyState text="Sem entradas nessa categoria." />
              )}
          </>
        )}
      </main>

      {pendingConfirm && (
        <PrintConfirmModal
          resolved={pendingConfirm}
          onCancel={() => setPendingConfirm(null)}
          onConfirm={confirmAndPrint}
        />
      )}
    </div>
  );
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function formatElapsedSec(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

const JOB_STATUS_LABEL: Record<RfidPrintJobStatus, string> = {
  na_fila: "Aguardando",
  imprimindo: "Imprimindo",
  concluido: "Concluído",
  falhou: "Falhou",
  cancelado: "Cancelado",
};

const JOB_STATUS_STYLE: Record<RfidPrintJobStatus, CSSProperties> = {
  na_fila: {
    background: "var(--bg-input)",
    color: "var(--text-secondary)",
    borderColor: "var(--border)",
  },
  imprimindo: {
    background: "var(--info-bg)",
    color: "var(--info-text)",
    borderColor: "var(--info-border)",
  },
  concluido: {
    background: "var(--bg-input)",
    color: "var(--text-secondary)",
    borderColor: "var(--border)",
  },
  falhou: {
    background: "var(--danger-bg)",
    color: "var(--danger-text)",
    borderColor: "var(--danger-border)",
  },
  cancelado: {
    background: "var(--bg-input)",
    color: "var(--text-muted)",
    borderColor: "var(--border)",
  },
};

function PrintJobRow({
  job,
  nowTs,
  onCancel,
}: {
  job: RfidPrintJob;
  nowTs: number;
  onCancel: (job: RfidPrintJob) => void;
}) {
  const startedTs = job.started_at ? new Date(job.started_at).getTime() : null;
  const elapsed =
    job.status === "imprimindo" && startedTs
      ? Math.max(0, Math.floor((nowTs - startedTs) / 1000))
      : null;
  const completed = job.completed_at ? formatTime(job.completed_at) : null;
  const cancelLabel =
    job.status === "falhou" ? "Descartar" : "Cancelar";

  return (
    <div style={queueRow}>
      <span style={{ ...queueBadge, ...JOB_STATUS_STYLE[job.status] }}>
        {JOB_STATUS_LABEL[job.status].toUpperCase()}
      </span>
      <div style={queueInfo}>
        <div style={queueTopLine}>
          <span style={queueCode}>{job.batch_code}</span>
          <span style={queueDesign}>
            {job.design_name ?? "—"}
            {job.shirt_color && (
              <>
                <span style={queueDot}>·</span>
                {job.shirt_color}
              </>
            )}
          </span>
        </div>
        {job.status === "falhou" && job.error_message && (
          <div style={queueError}>{job.error_message}</div>
        )}
      </div>
      <div style={queueMeta}>
        <span style={queueQty}>{job.total_etiquetas} etiq.</span>
        {elapsed != null && (
          <span style={queueTime}>{formatElapsedSec(elapsed)}</span>
        )}
        {job.status === "falhou" && completed && (
          <span style={queueTime}>{completed}</span>
        )}
        {job.status === "na_fila" && <span style={queueTime}>aguarda…</span>}
      </div>
      <button
        onClick={() => onCancel(job)}
        style={cancelRowBtn}
        title={cancelLabel}
        aria-label={cancelLabel}
      >
        ✕
      </button>
    </div>
  );
}

function AwaitingMovRow({
  entry,
  moving,
  onMovimentar,
}: {
  entry: JobAwaitingMovimentacao;
  moving: boolean;
  onMovimentar: (e: JobAwaitingMovimentacao) => void;
}) {
  const completed = entry.job.completed_at
    ? formatTime(entry.job.completed_at)
    : null;
  // Progresso REAL: totalCount = EPCs de fato gravados (impressos). Solicitado
  // = total_etiquetas. Parcial quando saiu menos do que pediu.
  const requested = entry.job.total_etiquetas;
  const printed = entry.totalCount;
  const partial = requested > 0 && printed < requested;
  return (
    <div style={queueRow}>
      <span
        style={{
          ...queueBadge,
          ...(partial ? JOB_STATUS_STYLE.falhou : JOB_STATUS_STYLE.concluido),
        }}
      >
        {partial ? "PARCIAL" : "IMPRESSO"}
      </span>
      <div style={queueInfo}>
        <div style={queueTopLine}>
          <span style={queueCode}>{entry.job.batch_code}</span>
          <span style={queueDesign}>
            {entry.job.design_name ?? "—"}
            {entry.job.is_test && <span style={queueDot}> · 🧪 teste</span>}
            {entry.job.is_manual && <span style={queueDot}> · ✋ manual</span>}
            {entry.job.shirt_color && (
              <>
                <span style={queueDot}>·</span>
                {entry.job.shirt_color}
              </>
            )}
          </span>
        </div>
      </div>
      <div style={queueMeta}>
        <span style={queueQty}>
          {printed} impressa{printed === 1 ? "" : "s"}
          {partial && ` de ${requested}`} · {entry.pendingCount} a movimentar
        </span>
        {completed && <span style={queueTime}>{completed}</span>}
      </div>
      <button
        onClick={() => onMovimentar(entry)}
        disabled={moving}
        style={moving ? mvBtnBusy : mvBtn}
        title="Movimentar EPCs pendentes pra situação destino"
      >
        {moving ? "Movendo…" : "Movimentar"}
      </button>
    </div>
  );
}

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function GlobalResultRow({
  entry,
  resolving,
  onPrint,
  onReturnToQueue,
}: {
  entry: GlobalSearchEntry;
  resolving: boolean;
  onPrint: (e: GlobalSearchEntry) => void;
  onReturnToQueue: (e: GlobalSearchEntry) => void;
}) {
  const b = entry.batch;
  const printed = entry.rfid_impresso_at != null;
  const statusLabel =
    RECEIPT_STATUS_LABEL[b.receiptStatus] ?? b.receiptStatus ?? "—";
  return (
    <div style={globalRow}>
      {b.thumbnail_url ? (
        <img src={b.thumbnail_url} alt="" loading="lazy" style={historyThumb} />
      ) : (
        <span style={historyThumbPlaceholder} />
      )}
      <span style={historyCode}>{b.batch_code}</span>
      <span style={historyName}>
        {b.design_name ?? "—"}
        {b.shirt_color && ` · ${b.shirt_color}`}
      </span>
      <span style={globalStatus}>
        {statusLabel}
        {entry.deleted && " · EXCLUÍDO"}
      </span>
      <span style={historyQty}>
        {b.total_pieces > 0 ? `${b.total_pieces} etiq.` : "sem grade"}
      </span>
      <span style={historyTime}>
        {printed
          ? `impresso ${formatDateTime(entry.rfid_impresso_at as string)}`
          : "não impresso"}
      </span>
      {printed && !entry.deleted && (
        <button
          type="button"
          style={historyReprintBtn}
          title="Limpa a estampa de impresso — o lote volta pra fila se estiver na etapa Env. Recebimento."
          onClick={() => onReturnToQueue(entry)}
        >
          ↩ Voltar pra fila
        </button>
      )}
      {!entry.deleted && b.total_pieces > 0 && (
        <button
          type="button"
          style={resolving ? mvBtnBusy : mvBtn}
          title="Abre o fluxo de impressão pra este lote, mesmo fora da fila."
          onClick={() => onPrint(entry)}
          disabled={resolving}
        >
          {resolving ? "Preparando…" : printed ? "Reimprimir" : "Imprimir"}
        </button>
      )}
    </div>
  );
}

function StatusChip({
  label,
  tone,
  tooltip,
}: {
  label: string;
  tone: "ok" | "warn" | "fail" | "neutral";
  tooltip: string;
}) {
  const color =
    tone === "ok"
      ? "var(--success-dot)"
      : tone === "warn"
        ? "var(--warning-dot)"
        : tone === "fail"
          ? "var(--danger-text)"
          : "var(--text-faint)";
  return (
    <div style={statusChip} title={tooltip} aria-label={tooltip}>
      <span style={{ ...statusDot, background: color }} />
      <span style={statusLabel}>{label}</span>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
  active,
  onClick,
  disabled,
}: {
  label: string;
  value: number;
  accent: "success" | "warning" | "muted" | "info";
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  const color =
    accent === "success"
      ? "var(--success-text)"
      : accent === "warning"
        ? "var(--warning-text)"
        : accent === "info"
          ? "var(--info-text)"
          : "var(--text-secondary)";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        ...statBlock,
        background: active ? "var(--bg-card)" : "transparent",
        borderColor: active ? "var(--border-strong)" : "transparent",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      <div style={{ ...statValue, color }}>{value}</div>
      <div style={statLabel}>{label}</div>
    </button>
  );
}

function Section(props: {
  title: string;
  count: number;
  accent: "success" | "warning" | "muted" | "info";
  hint?: string;
  children: React.ReactNode;
}) {
  const accentColor =
    props.accent === "success"
      ? "var(--success-text)"
      : props.accent === "warning"
        ? "var(--warning-text)"
        : props.accent === "info"
          ? "var(--info-text)"
          : "var(--text-muted)";
  return (
    <section style={section}>
      <header style={sectionHeader}>
        <span style={{ ...sectionTitle, color: accentColor }}>
          {props.title}
        </span>
        <span style={sectionCount}>{props.count}</span>
      </header>
      {props.hint && <div style={sectionHint}>{props.hint}</div>}
      {props.children}
    </section>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div style={emptyState}>{text}</div>;
}

const page: CSSProperties = {
  minHeight: "100vh",
  background: "var(--bg)",
  color: "var(--text)",
  display: "flex",
  flexDirection: "column",
  position: "relative",
};

const subHeader: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr auto 1fr",
  gap: 18,
  alignItems: "center",
  padding: "22px 40px",
  borderBottom: "1px solid var(--border)",
  background: "var(--bg)",
  position: "sticky",
  top: 0,
  zIndex: 5,
};

const subHeaderLeft: CSSProperties = {
  gridColumn: "1",
  justifySelf: "start",
};

const subHeaderCenter: CSSProperties = {
  gridColumn: "2",
  justifySelf: "center",
  display: "flex",
  alignItems: "center",
  gap: 18,
};

const subHeaderRight: CSSProperties = {
  gridColumn: "3",
  justifySelf: "end",
  display: "flex",
  alignItems: "center",
  gap: 12,
};

const searchWrap: CSSProperties = {
  width: 380,
  display: "flex",
  alignItems: "center",
  gap: 8,
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "0 10px",
};

const searchIcon: CSSProperties = {
  width: 14,
  height: 14,
  color: "var(--text-muted)",
  flexShrink: 0,
};

const searchInput: CSSProperties = {
  flex: 1,
  background: "transparent",
  border: 0,
  outline: "none",
  color: "var(--text)",
  fontSize: 13,
  padding: "8px 0",
  fontFamily: "inherit",
};

const clearBtn: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 12,
  padding: 2,
  flexShrink: 0,
};

const historyThumb: CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 4,
  objectFit: "cover",
  background: "var(--bg-input)",
  flexShrink: 0,
};

const historyThumbPlaceholder: CSSProperties = {
  ...historyThumb,
  display: "inline-block",
};

const subHeaderTitle: CSSProperties = {
  margin: 0,
  fontSize: 15,
  fontWeight: 600,
  color: "var(--text)",
  letterSpacing: -0.2,
};

const refreshBtn: CSSProperties = {
  background: "var(--bg-card)",
  color: "var(--text-secondary)",
  border: "1px solid var(--border)",
  padding: "6px 14px",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 500,
};

const refreshBtnBusy: CSSProperties = {
  ...refreshBtn,
  opacity: 0.6,
  cursor: "wait",
};

const main: CSSProperties = {
  position: "relative",
  flex: 1,
  padding: "28px 40px",
  maxWidth: 1280,
  width: "100%",
  margin: "0 auto",
  boxSizing: "border-box",
};

const statsRow: CSSProperties = {
  display: "flex",
  gap: 8,
  marginBottom: 28,
  padding: "6px 0 16px",
  borderBottom: "1px solid var(--border)",
};

const statBlock: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: 4,
  padding: "10px 18px",
  border: "1px solid transparent",
  borderRadius: 10,
  transition: "background 120ms, border-color 120ms",
};

const statValue: CSSProperties = {
  fontSize: 26,
  fontWeight: 700,
  lineHeight: 1,
  letterSpacing: -0.5,
};

const statLabel: CSSProperties = {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: 0.8,
  fontWeight: 600,
  color: "var(--text-muted)",
};

const section: CSSProperties = {
  marginBottom: 32,
};

const sectionHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  marginBottom: 12,
};

const sectionTitle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 1.2,
};

const sectionCount: CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  color: "var(--text-muted)",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  padding: "2px 7px",
  borderRadius: 999,
  fontFamily: "var(--font-mono)",
};

const sectionHint: CSSProperties = {
  fontSize: 12,
  color: "var(--text-muted)",
  marginBottom: 12,
  marginTop: -4,
};

const emptyState: CSSProperties = {
  padding: 32,
  background: "var(--bg-card)",
  border: "1px dashed var(--border)",
  borderRadius: 10,
  color: "var(--text-muted)",
  textAlign: "center",
  fontSize: 13,
};

const loadingState: CSSProperties = {
  padding: 40,
  textAlign: "center",
  color: "var(--text-muted)",
  fontSize: 13,
};

const errorBox: CSSProperties = {
  background: "var(--danger-bg)",
  color: "var(--danger-text)",
  border: "1px solid var(--danger-border)",
  padding: "12px 16px",
  borderRadius: 8,
  fontSize: 13,
  marginBottom: 20,
  lineHeight: 1.5,
};

const historyList: CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  overflow: "hidden",
};

const historyRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto auto 1fr auto auto auto",
  gap: 14,
  alignItems: "center",
  padding: "8px 14px",
  borderBottom: "1px solid var(--border)",
  fontSize: 13,
};

const historyCode: CSSProperties = {
  fontFamily: "var(--font-mono)",
  color: "var(--text)",
  fontWeight: 600,
};

const historyName: CSSProperties = {
  color: "var(--text-secondary)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const historyQty: CSSProperties = {
  color: "var(--text-muted)",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
};

const historyTime: CSSProperties = {
  color: "var(--text-faint)",
  fontSize: 11,
  fontFamily: "var(--font-mono)",
};

const historyReprintBtn: CSSProperties = {
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text-muted)",
  fontSize: 11,
  padding: "4px 8px",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const globalRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto auto 1fr auto auto auto auto auto",
  gap: 14,
  alignItems: "center",
  padding: "8px 14px",
  borderBottom: "1px solid var(--border)",
  fontSize: 13,
};

const globalStatus: CSSProperties = {
  color: "var(--text-muted)",
  fontSize: 11,
  fontFamily: "var(--font-mono)",
  whiteSpace: "nowrap",
};

const globalSearchWrap: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 8,
  padding: "18px 0",
};

const globalSearchBtn: CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text)",
  fontSize: 13,
  fontWeight: 600,
  padding: "10px 18px",
  cursor: "pointer",
};

const globalSearchBtnBusy: CSSProperties = {
  ...globalSearchBtn,
  opacity: 0.6,
  cursor: "wait",
};

const globalSearchHint: CSSProperties = {
  color: "var(--text-faint)",
  fontSize: 11,
};

const queueList: CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  overflow: "hidden",
};

const queueRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto 1fr auto auto",
  gap: 14,
  alignItems: "center",
  padding: "12px 14px",
  borderBottom: "1px solid var(--border)",
  fontSize: 13,
};

const statusChip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 9px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 999,
  fontSize: 11,
};

const statusDot: CSSProperties = {
  display: "inline-block",
  width: 7,
  height: 7,
  borderRadius: "50%",
};

const statusLabel: CSSProperties = {
  color: "var(--text-secondary)",
  fontWeight: 500,
  letterSpacing: 0.2,
};

const mvBtn: CSSProperties = {
  background: "var(--accent)",
  color: "var(--accent-text)",
  border: 0,
  borderRadius: 6,
  padding: "8px 14px",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.8,
  textTransform: "uppercase",
  cursor: "pointer",
};

const mvBtnBusy: CSSProperties = {
  ...mvBtn,
  opacity: 0.6,
  cursor: "wait",
};

const cancelRowBtn: CSSProperties = {
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 11,
  width: 26,
  height: 26,
  display: "grid",
  placeItems: "center",
  padding: 0,
};

const queueBadge: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.7,
  padding: "3px 8px",
  borderRadius: 999,
  border: "1px solid",
  alignSelf: "center",
};

const queueInfo: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  minWidth: 0,
};

const queueTopLine: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: 10,
  overflow: "hidden",
};

const queueCode: CSSProperties = {
  fontFamily: "var(--font-mono)",
  color: "var(--text)",
  fontWeight: 700,
  fontSize: 14,
};

const queueDesign: CSSProperties = {
  color: "var(--text-secondary)",
  fontSize: 13,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const queueDot: CSSProperties = {
  margin: "0 6px",
  color: "var(--text-faint)",
};

const queueError: CSSProperties = {
  fontSize: 11,
  color: "var(--danger-text)",
  background: "var(--danger-bg)",
  border: "1px solid var(--danger-border)",
  padding: "4px 8px",
  borderRadius: 6,
  marginTop: 2,
};

const queueMeta: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  gap: 2,
};

const queueQty: CSSProperties = {
  fontSize: 12,
  color: "var(--text-muted)",
  fontFamily: "var(--font-mono)",
};

const queueTime: CSSProperties = {
  fontSize: 11,
  color: "var(--text-faint)",
  fontFamily: "var(--font-mono)",
};

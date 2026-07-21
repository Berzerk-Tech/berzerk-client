import {
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
} from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { getStationId } from "../lib/station";
import { printJob as itagPrintJob } from "../lib/itag/iprint";
import { applyMargin, type ApplyMarginInput } from "../lib/settings";
import { clearLookupCaches } from "../services/ean13Lookup";
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
  resolveBatch,
  type ProductionBatch,
  type ResolvedBatch,
  type PrintedBatchEntry,
} from "../services/batches";
import { BatchCard, type CardState } from "./BatchCard";
import { PrintConfirmModal, type PrintOverride } from "./PrintConfirmModal";
import { BackButton } from "./BackButton";
import { AmbientBackground } from "./AmbientBackground";

const MAX_VISIBLE = 50;
// Concorrência baixa pra não estourar rate limit do shopify-analytics.
// O cache module-level dedupa requests pro mesmo product_id, então
// mesmo com 50 batches só batemos 1x por produto único.
const CONCURRENCY = 4;

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
  opts?: { skipShopifyFallback?: boolean },
): Promise<ResolvedBatch[]> {
  const out: ResolvedBatch[] = new Array(batches.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, batches.length) },
    async () => {
      while (next < batches.length) {
        const i = next++;
        try {
          out[i] = await resolveBatch(batches[i], opts);
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
            shopifyTitle: batches[i].design_name,
            shopifyColor: batches[i].shirt_color,
            shopifyReference: null,
            shopifyFallbackAvailable: false,
          };
        }
      }
    },
  );
  await Promise.all(workers);
  return out;
}

export function BatchBrowser({
  session,
  onBack,
}: {
  session: Session;
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
  const [searchingShopify, setSearchingShopify] = useState<Set<string>>(
    new Set(),
  );

  const stationId = getStationId();
  const operatorId = session.user.id;
  const operatorEmail = session.user.email ?? "(sem email)";

  const load = useCallback(async (showRefreshing: boolean) => {
    if (showRefreshing) {
      setRefreshing(true);
      clearLookupCaches();
    }
    try {
      const [pending, hist] = await Promise.all([
        fetchPendingBatches(),
        fetchTodayHistory(),
      ]);
      const visible = pending.slice(0, MAX_VISIBLE);
      // Pula shopify-analytics no load — usa só cache local (unified_products
      // + cache em memória/localStorage do Shopify). Lotes sem cobertura
      // completa ficam com `shopifyFallbackAvailable: true` e o operador
      // pode disparar a busca via botão no card.
      const resolved = await resolveAllWithConcurrency(visible, CONCURRENCY, {
        skipShopifyFallback: true,
      });
      setBatches(resolved);
      setHistory(hist);

      // 2º passo (background): lotes com produto Shopify vinculado mas sem EAN
      // local viram `shopifyFallbackAvailable`. Resolve via Shopify sozinho —
      // assim "just works" como o painel do industrial, sem clicar "Buscar no
      // Shopify". O cache (localStorage 1h) deixa as próximas cargas rápidas.
      const needShopify = resolved.filter((r) => r.shopifyFallbackAvailable);
      if (needShopify.length > 0) {
        void (async () => {
          try {
            const reresolved = await resolveAllWithConcurrency(
              needShopify.map((r) => r.batch),
              CONCURRENCY,
              { skipShopifyFallback: false },
            );
            const byId = new Map(reresolved.map((r) => [r.batch.id, r]));
            setBatches((prev) => prev.map((b) => byId.get(b.batch.id) ?? b));
          } catch (e) {
            console.warn("[BatchBrowser] auto Shopify resolve falhou:", e);
          }
        })();
      }
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

  // Fila de impressão: fetch + Realtime sub em rfid_print_jobs
  useEffect(() => {
    let alive = true;
    async function loadJobs() {
      // Independentes — se a tabela rfid_epc_inventory ainda não existir,
      // não derrubar a fila de impressão. allSettled isola as falhas.
      const [jobsRes, awaitingRes] = await Promise.allSettled([
        printJobsService.fetchActivePrintJobs(),
        printJobsService.fetchJobsAwaitingMovimentacao(),
      ]);
      if (!alive) return;
      if (jobsRes.status === "fulfilled") {
        setActiveJobs(jobsRes.value);
      } else {
        console.warn("[BatchBrowser] fetchActivePrintJobs failed:", jobsRes.reason);
      }
      if (awaitingRes.status === "fulfilled") {
        setAwaitingJobs(awaitingRes.value);
      } else {
        console.warn(
          "[BatchBrowser] fetchJobsAwaitingMovimentacao failed:",
          awaitingRes.reason,
        );
      }
    }
    loadJobs();
    const channel = supabase
      .channel("rfid-print-jobs-queue")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "rfid_print_jobs" },
        () => loadJobs(),
      )
      .subscribe((status) => {
        if (!alive) return;
        if (status === "SUBSCRIBED") setRealtimeStatus("connected");
        else if (status === "CHANNEL_ERROR" || status === "CLOSED" || status === "TIMED_OUT")
          setRealtimeStatus("disconnected");
        else setRealtimeStatus("connecting");
      });
    return () => {
      alive = false;
      supabase.removeChannel(channel);
    };
  }, []);

  // Tick por segundo quando há jobs imprimindo (local OU global)
  const hasPrintingJobs =
    printing.size > 0 || activeJobs.some((j) => j.status === "printing");
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
      } catch (e) {
        console.error("[BatchBrowser] discardTestForBatch failed:", e);
        window.alert(
          `Falha ao descartar teste de ${batchCode}: ${formatError(e)}`,
        );
      } finally {
        load(false);
      }
    },
    [load],
  );

  // Re-resolve um lote específico forçando o fallback do Shopify. Usado
  // quando o operador clica "Buscar no Shopify" em card bloqueado por
  // EAN13 faltante. Resultado substitui a entry correspondente em batches[].
  const handleSearchShopify = useCallback(async (resolved: ResolvedBatch) => {
    const batchId = resolved.batch.id;
    setSearchingShopify((s) => {
      const next = new Set(s);
      next.add(batchId);
      return next;
    });
    try {
      const updated = await resolveBatch(resolved.batch, {
        skipShopifyFallback: false,
      });
      setBatches((prev) =>
        prev.map((b) => (b.batch.id === batchId ? updated : b)),
      );
    } catch (e) {
      console.warn("[BatchBrowser] handleSearchShopify failed:", e);
    } finally {
      setSearchingShopify((s) => {
        const next = new Set(s);
        next.delete(batchId);
        return next;
      });
    }
  }, []);

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
        jobId = await printJobsService.createPrintJob({
          batchId: batch.id,
          batchCode: batch.batch_code,
          items,
          shirtColor: resolved.shopifyColor ?? batch.shirt_color,
          designName: batch.design_name,
          totalEtiquetas: totalRequested,
          operatorId,
          operatorEmail,
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
          shirtColor: resolved.shopifyColor ?? batch.shirt_color,
          designName: batch.design_name,
          operatorId,
          audit: { operatorName: operatorEmail },
        });

        if (result.success) {
          // Grava a contagem REAL de etiquetas queimadas (EPCs da iTAG), que
          // pode ser < solicitado em impressão parcial. Se foi teste, o lote
          // passa a ter teste pra limpar.
          await printJobsService.markDone(jobId, result.count);
          if (isTest) {
            setBatchesWithTest((prev) => new Set(prev).add(batch.id));
          } else {
            // Estampa rfid_impresso_at — é o que tira o lote da fila e o põe
            // no Histórico. Falha aqui não é fatal: a defesa no
            // fetchPendingBatches (filtro por job done) segura a fila.
            try {
              const stamped = await markBatchRfidPrinted(batch.id);
              if (stamped === 0) {
                console.warn(
                  `[BatchBrowser] rfid_impresso_at não estampado pra ${batch.batch_code} ` +
                    "(já estampado ou RLS sem UPDATE em production_batches).",
                );
              }
            } catch (e) {
              console.warn("[BatchBrowser] markBatchRfidPrinted falhou:", e);
            }
          }
        } else {
          const detail = result.stage ? ` (${result.stage})` : "";
          const msg = result.error + detail;
          await printJobsService.markFailed(jobId, msg);
          setErrors((m) => new Map(m).set(batch.id, msg));
        }
      } catch (e) {
        const msg = formatError(e);
        try {
          await printJobsService.markFailed(jobId, msg);
        } catch {
          /* swallow */
        }
        setErrors((m) => new Map(m).set(batch.id, msg));
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

  const q = query.trim().toLowerCase();
  const matchesQuery = (text: string | null | undefined) =>
    !q || (text ? text.toLowerCase().includes(q) : false);
  const batchMatches = (b: ResolvedBatch) =>
    !q ||
    matchesQuery(b.batch.batch_code) ||
    matchesQuery(b.batch.design_name) ||
    matchesQuery(b.shopifyTitle);

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
            const real = await invoke<
              Array<{ epc: string; situacao: number | null }>
            >("itag_iprint_query_inventory", {
              config: toRustConfig(config),
              codigoInventario,
              page: 0,
              size: 500,
            });
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
          operatorId,
        });

        const refreshed = await printJobsService.fetchJobsAwaitingMovimentacao();
        setAwaitingJobs(refreshed);
      } catch (e) {
        const msg = formatError(e);
        console.error("[BatchBrowser] handleMovimentar failed:", e);
        window.alert(`Movimentação falhou: ${msg}`);
      } finally {
        setMovingJobs((m) => {
          const next = new Map(m);
          next.delete(job.id);
          return next;
        });
      }
    },
    [movingJobs, operatorId],
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

  const printingCount = activeJobs.filter((j) => j.status === "printing").length;
  const failedCount = activeJobs.filter((j) => j.status === "failed").length;

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
        j.status === "failed" &&
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
    if (job.status === "printing") {
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
          {awaitingJobs.length > 0 && (
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

            {showAwaiting && filteredAwaiting.length > 0 && (
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
                      onSearchShopify={handleSearchShopify}
                      searchingShopify={searchingShopify.has(r.batch.id)}
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
                    onSearchShopify={handleSearchShopify}
                    searchingShopify={searchingShopify.has(r.batch.id)}
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
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {q &&
              ready.length === 0 &&
              blocked.length === 0 &&
              filteredHistory.length === 0 && (
                <EmptyState
                  text={`Nenhum lote bate com "${query}".`}
                />
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
  queued: "Aguardando",
  printing: "Imprimindo",
  done: "Concluído",
  failed: "Falhou",
  cancelled: "Cancelado",
};

const JOB_STATUS_STYLE: Record<RfidPrintJobStatus, CSSProperties> = {
  queued: {
    background: "var(--bg-input)",
    color: "var(--text-secondary)",
    borderColor: "var(--border)",
  },
  printing: {
    background: "var(--info-bg)",
    color: "var(--info-text)",
    borderColor: "var(--info-border)",
  },
  done: {
    background: "var(--bg-input)",
    color: "var(--text-secondary)",
    borderColor: "var(--border)",
  },
  failed: {
    background: "var(--danger-bg)",
    color: "var(--danger-text)",
    borderColor: "var(--danger-border)",
  },
  cancelled: {
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
    job.status === "printing" && startedTs
      ? Math.max(0, Math.floor((nowTs - startedTs) / 1000))
      : null;
  const completed = job.completed_at ? formatTime(job.completed_at) : null;
  const cancelLabel =
    job.status === "failed" ? "Descartar" : "Cancelar";

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
        {job.status === "failed" && job.error_message && (
          <div style={queueError}>{job.error_message}</div>
        )}
      </div>
      <div style={queueMeta}>
        <span style={queueQty}>{job.total_etiquetas} etiq.</span>
        {elapsed != null && (
          <span style={queueTime}>{formatElapsedSec(elapsed)}</span>
        )}
        {job.status === "failed" && completed && (
          <span style={queueTime}>{completed}</span>
        )}
        {job.status === "queued" && <span style={queueTime}>aguarda…</span>}
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
          ...(partial ? JOB_STATUS_STYLE.failed : JOB_STATUS_STYLE.done),
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

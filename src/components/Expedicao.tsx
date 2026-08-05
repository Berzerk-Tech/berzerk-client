import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type SVGProps,
} from "react";
import { BackButton } from "./BackButton";
import { AmbientBackground } from "./AmbientBackground";
import { OperatorChip } from "./OperatorChip";
import { useRfid } from "../contexts/RfidContext";
import { beepError, beepOk } from "../lib/beep";
import { printEtiqueta, printEngineStatus } from "../lib/printer";
import { getLabelPrinter } from "../services/printerConfig";
import { gerarDanfeSimplificadaPdf } from "../lib/danfe";
import {
  epcMatch,
  expedicaoErrorCode,
  getDocumentos,
  isEndpointMissing,
  markLabelPrinted,
  shipErrorMessage,
  shipOrder,
  type Documentos,
  type EpcMatch,
  type ExpedicaoOrder,
  type JaExpedido,
} from "../services/expedicao";
import {
  getExpedicaoMode,
  isExpedicaoSimulacao,
  type ExpedicaoMode,
} from "../services/expedicaoMode";
import type { EpcLookupItem, OrderItem } from "../services/orders";

type Props = { onBack: () => void };

// ============================================================
// Fluxo físico da mesa (UX rica com feedback contínuo, estilo posvenda):
//   1. LER       — leitura das peças; o app identifica o pedido
//   2. IMPRIMIR  — etiqueta J&T + DANFE saem sozinhas (dispara a mesa)
//   3. EMBALAR   — operador coloca o pedido no saco
//   4. FECHAR    — botão vermelho da máquina fecha + despacha
//
// MODO TESTE  — roda tudo, mas NÃO chama o ship (zero efeito no sistema).
// MODO OFICIAL— ao fechar, chama o ship (marca shipped + Tiny).
// ============================================================

type Step = "ler" | "imprimir" | "embalar" | "fechar";

type ReadEntry = { epc: string; desc: string; ts: number };
type SessionEntry = { order: ExpedicaoOrder; at: Date; modo: ExpedicaoMode };

type Flow =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "choose"; matches: EpcMatch[] }
  | { kind: "identified"; order: ExpedicaoOrder; lidas: string[]; faltam: string[] }
  | { kind: "printing"; order: ExpedicaoOrder }
  | { kind: "packing"; order: ExpedicaoOrder; lidas: string[]; override?: string }
  | { kind: "done"; order: ExpedicaoOrder; modo: ExpedicaoMode; enfileirado: boolean }
  | { kind: "error"; code: string; message: string; order?: ExpedicaoOrder };

const PACKING_MS = 5000;
const RESOLVE_DEBOUNCE_MS = 250;
// Peças na mesa sem pedido resolvido (separação atrasada, rede, etc.): tenta de
// novo sozinho — o operador não tem mouse/teclado, "Nova leitura" é exceção.
const RESOLVE_RETRY_MS = 4000;
const BUFFER_WARN = 12;
/**
 * Uma peça é considerada "na mesa" enquanto foi lida nos últimos PRESENCE_TTL ms.
 * Passou disso sem ser relida (o leitor limpa o buffer periodicamente), ela sai
 * do conjunto — é assim que a remoção reflete sem desarmar/piscar o leitor.
 */
const PRESENCE_TTL = 3400;

/** Pedido corrente do fluxo (quando há um). */
function orderOf(flow: Flow): ExpedicaoOrder | null {
  switch (flow.kind) {
    case "identified":
    case "printing":
    case "packing":
    case "done":
      return flow.order;
    case "error":
      return flow.order ?? null;
    default:
      return null;
  }
}

// ---- matching EPC→item (mesma lógica da Separação/posvenda) ----------------
function normGtin(v: string | null | undefined): string | null {
  const d = v?.replace(/\D/g, "").replace(/^0+/, "");
  return d || null;
}
function gtinCandidates(...vals: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const v of vals) {
    const t = v?.trim();
    if (t && /^\d{8,14}$/.test(t)) {
      const n = normGtin(t);
      if (n) out.add(n);
    }
  }
  return Array.from(out);
}
function matchItem(items: OrderItem[], look: EpcLookupItem, used: Map<string, number>): OrderItem | null {
  const remaining = (it: OrderItem) => it.quantidade - (used.get(it.id) ?? 0);
  const tagGtins = gtinCandidates(look.ean13, look.sku);
  const byGtin = items.find((it) => remaining(it) > 0 && gtinCandidates(it.ean, it.sku).some((g) => tagGtins.includes(g)));
  if (byGtin) return byGtin;
  const lookSku = look.sku?.trim().toUpperCase();
  return items.find((it) => lookSku && it.sku?.trim().toUpperCase() === lookSku && remaining(it) > 0) ?? null;
}

function jaExpedidoMsg(js: JaExpedido[]): string {
  const j = js[0];
  const quando = j?.shippedAt
    ? new Date(j.shippedAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : null;
  const quem = j?.shippedByEmail ?? j?.shippedBy ?? null;
  const det = [quando && `em ${quando}`, quem && `por ${quem}`].filter(Boolean).join(" ");
  return `O pedido #${j?.numero ?? ""} já foi expedido${det ? ` ${det}` : ""}. Tire essas peças da mesa e aperte Nova leitura.`;
}

function statusOfStep(flow: Flow, step: Step): "active" | "done" | "pending" {
  const order: Record<Step, number> = { ler: 0, imprimir: 1, embalar: 2, fechar: 3 };
  const cur: Partial<Record<Flow["kind"], Step>> = {
    idle: "ler",
    reading: "ler",
    choose: "ler",
    identified: "ler",
    printing: "imprimir",
    packing: "embalar",
    done: "fechar",
  };
  const c = cur[flow.kind];
  if (!c) return "pending";
  if (c === step) return "active";
  return order[c] > order[step] ? "done" : "pending";
}

export function Expedicao({ onBack }: Props) {
  const rfid = useRfid();
  const [modo] = useState<ExpedicaoMode>(() => getExpedicaoMode());
  const simulacao = isExpedicaoSimulacao();
  const [flow, setFlow] = useState<Flow>({ kind: "idle" });
  const flowRef = useRef<Flow>(flow);
  flowRef.current = flow;

  const [scan, setScan] = useState("");
  const [bufferSize, setBufferSize] = useState(0);
  const [packingProgress, setPackingProgress] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<Map<string, number>>(new Map());
  const [readLog, setReadLog] = useState<ReadEntry[]>([]);
  const [session, setSession] = useState<SessionEntry[]>([]);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [engineWarn, setEngineWarn] = useState<string | null>(null);
  const [reprintingId, setReprintingId] = useState<string | null>(null);
  // Automação (power-user): bipar → imprimir sozinho quando o pedido completa.
  const [autoPrint, setAutoPrint] = useState(true);
  const autoPrintRef = useRef(true);
  autoPrintRef.current = autoPrint;

  const inputRef = useRef<HTMLInputElement | null>(null);
  const mesaRef = useRef<Set<string>>(new Set());
  const processedRef = useRef<Set<string>>(new Set());
  // Presença: EPC → timestamp da última leitura (TTL define quem está "na mesa").
  const presentRef = useRef<Map<string, number>>(new Map());
  const descCacheRef = useRef<Map<string, string>>(new Map());
  const lastPresentSigRef = useRef<string>("");
  const lastSigRef = useRef<string>("");
  // Assinatura do último conjunto que FALHOU no match — os retries desse mesmo
  // conjunto são silenciosos (sem beep/aviso repetido).
  const lastFailSigRef = useRef<string>("");
  const resolveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modoRef = useRef<ExpedicaoMode>(modo);
  modoRef.current = modo;

  useEffect(() => {
    if (simulacao) return;
    void printEngineStatus()
      .then((s) => {
        if (!s.ok) setEngineWarn(s.message ?? "Motor de impressão indisponível.");
      })
      .catch(() => {});
  }, []);

  const showNotice = useCallback((msg: string | null, ms = 6000) => {
    setNotice(msg);
    if (msg) window.setTimeout(() => setNotice((n) => (n === msg ? null : n)), ms);
  }, []);

  useEffect(() => {
    if (flow.kind === "idle" || flow.kind === "identified" || flow.kind === "packing" || flow.kind === "done") {
      inputRef.current?.focus();
    }
  }, [flow.kind]);

  // ---- limpa tudo pra um novo ciclo / repetição ----
  // Zera o que já foi processado/visto — as peças fisicamente na mesa voltam a
  // contar no próximo poll de presença (sem rearmar o leitor).
  const reiniciar = useCallback(() => {
    if (resolveTimer.current) clearTimeout(resolveTimer.current);
    mesaRef.current = new Set();
    processedRef.current = new Set();
    presentRef.current = new Map();
    lastPresentSigRef.current = "";
    lastSigRef.current = "";
    lastFailSigRef.current = "";
    setProgress(new Map());
    setReadLog([]);
    setBufferSize(0);
    setOverrideOpen(false);
    setFlow({ kind: "idle" });
  }, []);

  // ---- resolução do pedido a partir do conjunto atual da mesa ----
  const doResolve = useCallback(async () => {
    const epcs = Array.from(mesaRef.current).filter((e) => !processedRef.current.has(e));
    const k = flowRef.current.kind;
    // Conjunto vazio: se estava mostrando pedido/escolha/erro, volta pra PRONTO.
    if (epcs.length === 0) {
      if (k === "reading" || k === "choose" || k === "identified" || k === "error") setFlow({ kind: "idle" });
      lastSigRef.current = "";
      lastFailSigRef.current = "";
      return;
    }
    // Não interrompe impressão/embalagem/conclusão.
    if (k === "printing" || k === "packing" || k === "done") return;

    // Mesmo conjunto que acabou de falhar → retry automático SILENCIOSO (sem
    // piscar a tela nem repetir beep/aviso). Assim que o pedido ficar pronto no
    // nexus (ou a rede voltar), identifica sozinho — sem "Nova leitura".
    const sigNow = epcs.slice().sort().join(",");
    const retrying = sigNow === lastFailSigRef.current;
    if (!retrying) setFlow({ kind: "reading" });
    const scheduleRetry = () => {
      lastFailSigRef.current = sigNow;
      if (resolveTimer.current) clearTimeout(resolveTimer.current);
      resolveTimer.current = setTimeout(() => void doResolve(), RESOLVE_RETRY_MS);
    };
    try {
      const { matches, unmatchedEpcs, jaExpedidos } = await epcMatch(epcs);
      if (matches.length === 0) {
        if (!retrying) beepError();
        if (jaExpedidos.length > 0) {
          setFlow({ kind: "error", code: "ja_expedido", message: jaExpedidoMsg(jaExpedidos) });
          scheduleRetry();
          return;
        }
        if (!retrying)
          showNotice(
            unmatchedEpcs.length > 0
              ? `Peça(s) sem pedido pronto na mesa (${unmatchedEpcs.length}). Aguardando aparecer no sistema…`
              : "Nenhum pedido encontrado pra essas tags. Aguardando aparecer no sistema…",
          );
        setFlow({ kind: "idle" });
        scheduleRetry();
        return;
      }
      lastFailSigRef.current = "";
      if (matches.length > 1) {
        beepError();
        setFlow({ kind: "choose", matches });
        return;
      }
      const m = matches[0];
      beepOk();
      if (jaExpedidos.length > 0) {
        showNotice(`⚠ Tem peça de pedido já expedido na mesa (#${jaExpedidos[0].numero ?? ""}). Confira.`);
      } else if (unmatchedEpcs.length > 0) {
        showNotice(`⚠ ${unmatchedEpcs.length} peça(s) na mesa não são deste pedido — confira antes de fechar.`);
      }
      await identifica(m);
    } catch (e) {
      handleResolveError(e);
      scheduleRetry();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showNotice]);

  const handleResolveError = useCallback((e: unknown) => {
    if (isEndpointMissing(e)) {
      setFlow({
        kind: "error",
        code: "nexus_pendente",
        message: "O servidor de expedição não respondeu (endpoint /expedicao/epc-match). Verifique a conexão com o nexus.",
      });
      return;
    }
    const code = expedicaoErrorCode(e);
    setFlow({
      kind: "error",
      code: code ?? "falha_match",
      message:
        code === "missing_permission"
          ? "Seu usuário não tem a permissão de Expedição (expedicao:operate). Peça o papel de expedidor no admin do nexus."
          : "Falha ao consultar o servidor de expedição. Verifique a conexão e tente de novo.",
    });
  }, []);

  // ---- identifica um match: progresso por item + trava de completude ----
  const identifica = useCallback(
    async (m: EpcMatch) => {
      const order = m.order;
      try {
        const resolved = await rfid.resolveEpcs(m.tagsLidas);
        const used = new Map<string, number>();
        for (const epc of m.tagsLidas) {
          const look = resolved.get(epc.toUpperCase());
          const it = look ? matchItem(order.items, look, used) : null;
          if (it) used.set(it.id, (used.get(it.id) ?? 0) + 1);
        }
        setProgress(used);
      } catch {
        setProgress(new Map());
      }
      setFlow({ kind: "identified", order, lidas: m.tagsLidas, faltam: m.tagsFaltantes });
      // Completo + automação ligada → imprime sozinho. Senão espera o operador.
      if (m.tagsFaltantes.length === 0 && autoPrintRef.current) {
        void iniciarImpressao(order, m.tagsLidas);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rfid],
  );

  // ---- impressão (J&T → DANFE) → embalagem ----
  const iniciarImpressao = useCallback(
    async (order: ExpedicaoOrder, lidas: string[], override?: string) => {
      setOverrideOpen(false);
      setFlow({ kind: "printing", order });
      const oficial = modoRef.current === "oficial";
      const printer = getLabelPrinter();
      let docs: Documentos;
      try {
        docs = await getDocumentos(order.id);
      } catch (e) {
        if (isEndpointMissing(e)) {
          if (oficial) {
            setFlow({ kind: "error", code: "documentos_indisponivel", message: "Servidor de documentos indisponível (etiqueta/DANFE). Não é possível expedir.", order });
            return;
          }
          showNotice("Documentos indisponíveis — seguindo em modo teste sem imprimir.");
          setFlow({ kind: "packing", order, lidas, override });
          return;
        }
        setFlow({ kind: "error", code: "documentos_falha", message: "Falha ao buscar os documentos do pedido.", order });
        return;
      }

      // 1) Etiqueta J&T (dispara a máquina). Pré-requisito rígido no oficial.
      if (docs.etiqueta) {
        try {
          const out = await printEtiqueta(docs.etiqueta.base64, docs.etiqueta.formato, { jobName: `JT ${order.numero ?? order.id}`, printer });
          if (!out.ok) throw new Error(out.message ?? "impressão falhou");
          if (oficial && order.numero) await markLabelPrinted(order.numero, order.tinyAccount);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (oficial) {
            setFlow({ kind: "error", code: "etiqueta_impressao", message: `Falha na etiqueta J&T: ${msg}. Verifique a impressora — o pedido não avança sem a etiqueta.`, order });
            return;
          }
          showNotice(`Etiqueta J&T não imprimiu (${msg}) — seguindo em teste.`);
        }
      } else if (oficial) {
        setFlow({ kind: "error", code: "etiqueta_ausente", message: "Etiqueta da transportadora (J&T) ainda não chegou pra este pedido. Aguarde a etiqueta antes de expedir.", order });
        return;
      } else {
        showNotice("Sem etiqueta J&T ainda — seguindo em teste sem imprimir.");
      }

      // 2) DANFE (quando houver) — best-effort nos dois modos.
      if (docs.danfe) {
        try {
          const pdf = gerarDanfeSimplificadaPdf(docs.danfe);
          if (pdf) {
            const out = await printEtiqueta(pdf, "pdf", { jobName: `DANFE ${order.numero ?? order.id}`, printer });
            if (!out.ok) showNotice(`DANFE não imprimiu: ${out.message ?? "erro"}`);
          }
        } catch (e) {
          showNotice(`Falha ao gerar/imprimir a DANFE: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      setFlow({ kind: "packing", order, lidas, override });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showNotice],
  );

  // ---- reimpressão a partir do histórico ----
  const reprint = useCallback(
    async (order: ExpedicaoOrder) => {
      setReprintingId(order.id);
      const printer = getLabelPrinter();
      try {
        const docs = await getDocumentos(order.id);
        let printed = false;
        if (docs.etiqueta) {
          await printEtiqueta(docs.etiqueta.base64, docs.etiqueta.formato, { jobName: `JT ${order.numero ?? order.id}`, printer });
          printed = true;
        }
        if (docs.danfe) {
          const pdf = gerarDanfeSimplificadaPdf(docs.danfe);
          if (pdf) {
            await printEtiqueta(pdf, "pdf", { jobName: `DANFE ${order.numero ?? order.id}`, printer });
            printed = true;
          }
        }
        showNotice(printed ? `Reimpressão de #${order.numero ?? ""} enviada.` : `Pedido #${order.numero ?? ""} sem documentos pra reimprimir.`);
      } catch (e) {
        showNotice(`Falha na reimpressão: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setReprintingId(null);
      }
    },
    [showNotice],
  );

  // ---- timer da embalagem → conclui o ciclo ----
  useEffect(() => {
    if (flow.kind !== "packing") {
      setPackingProgress(0);
      return;
    }
    const start = Date.now();
    const id = setInterval(() => {
      const ratio = Math.min(1, (Date.now() - start) / PACKING_MS);
      setPackingProgress(ratio);
      if (ratio >= 1) {
        clearInterval(id);
        void concluirCiclo();
      }
    }, 80);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow.kind]);

  const concluirCiclo = useCallback(async () => {
    const f = flowRef.current;
    if (f.kind !== "packing") return;
    const { order, lidas, override } = f;
    for (const e of mesaRef.current) processedRef.current.add(e);

    const registra = (enfileirado: boolean) => {
      setSession((s) => [{ order, at: new Date(), modo: modoRef.current }, ...s].slice(0, 12));
      setFlow({ kind: "done", order, modo: modoRef.current, enfileirado });
      window.setTimeout(() => {
        setProgress(new Map());
        // Reabre a presença: as peças ainda na mesa reaparecem, mas as do pedido
        // despachado já estão em processedRef (não re-identificam).
        lastPresentSigRef.current = "";
        lastSigRef.current = "";
        setFlow((cur) => (cur.kind === "done" ? { kind: "idle" } : cur));
      }, 1500);
    };

    if (modoRef.current === "teste") {
      registra(false);
      return;
    }

    try {
      await shipOrder(order.id, lidas, override ? { motivo: override } : undefined);
      registra(false);
    } catch (e) {
      const code = expedicaoErrorCode(e);
      if (!code) {
        enqueueRetry(order.id, lidas, override);
        showNotice(`Sem confirmar a expedição de #${order.numero ?? ""} (rede). Enfileirado pra reenvio — a mesa segue.`);
        registra(true);
      } else {
        showNotice(`Expedição de #${order.numero ?? ""} recusada: ${shipErrorMessage(code)} Confira no sistema.`);
        registra(true);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showNotice]);

  // ---- fila de retry do ship ----
  const retryQueue = useRef<Array<{ orderId: string; lidas: string[]; override?: string }>>([]);
  const enqueueRetry = useCallback((orderId: string, lidas: string[], override?: string) => {
    retryQueue.current.push({ orderId, lidas, override });
  }, []);
  useEffect(() => {
    const id = setInterval(() => {
      if (retryQueue.current.length === 0 || modoRef.current !== "oficial") return;
      const job = retryQueue.current[0];
      void shipOrder(job.orderId, job.lidas, job.override ? { motivo: job.override } : undefined)
        .then(() => {
          retryQueue.current.shift();
          showNotice(`Expedição de um pedido pendente foi confirmada.`);
        })
        .catch(() => {});
    }, 15000);
    return () => clearInterval(id);
  }, [showNotice]);

  // ---- PRESENÇA: recebe o conjunto ATUAL na mesa a cada poll ----
  // Reflete a mesa o tempo todo (Leitura ao vivo sempre mostra o que está lá),
  // e tirar/pôr peça reflete na hora (via TTL). Congela durante processamento.
  const onPresenceRef = useRef<(cur: string[]) => void>(() => {});
  onPresenceRef.current = (cur: string[]) => {
    const now = Date.now();
    for (const raw of cur) {
      const e = raw.trim().toUpperCase();
      if (e) presentRef.current.set(e, now);
    }
    const k = flowRef.current.kind;
    // Durante impressão/embalagem/conclusão, congela o conjunto (não deixa a
    // presença do próximo pedido "vazar" pro ciclo atual).
    if (k === "printing" || k === "packing" || k === "done") return;

    // Poda por TTL (peça que não é relida "sai" da mesa).
    for (const [e, ts] of presentRef.current) {
      if (now - ts > PRESENCE_TTL) presentRef.current.delete(e);
    }
    const present = Array.from(presentRef.current.keys());
    const presentSig = present.slice().sort().join(",");
    if (presentSig === lastPresentSigRef.current) return; // nada mudou
    lastPresentSigRef.current = presentSig;

    // Leitura ao vivo = conjunto atual (com descrição do produto).
    setReadLog(present.map((e) => ({ epc: e, desc: descCacheRef.current.get(e) ?? "", ts: presentRef.current.get(e) ?? now })));
    setBufferSize(present.length);
    const missing = present.filter((e) => !descCacheRef.current.has(e));
    if (missing.length > 0) {
      void rfid
        .resolveEpcs(missing)
        .then((map) => {
          let any = false;
          for (const e of missing) {
            const look = map.get(e);
            const d = look ? [look.name, look.size, look.ean13].filter(Boolean).join(" · ") : "";
            if (d) {
              descCacheRef.current.set(e, d);
              any = true;
            }
          }
          if (any) setReadLog((prev) => prev.map((x) => (x.desc ? x : { ...x, desc: descCacheRef.current.get(x.epc) ?? "" })));
        })
        .catch(() => {});
    }

    // Conjunto que alimenta a identificação (tira o que já foi despachado).
    const mesa = present.filter((e) => !processedRef.current.has(e));
    const sig = mesa.slice().sort().join(",");
    if (sig !== lastSigRef.current) {
      lastSigRef.current = sig;
      mesaRef.current = new Set(mesa);
      if (resolveTimer.current) clearTimeout(resolveTimer.current);
      resolveTimer.current = setTimeout(() => void doResolve(), RESOLVE_DEBOUNCE_MS);
    }
  };

  const startPresenceSession = rfid.startPresenceSession;
  useEffect(() => {
    const stop = startPresenceSession((cur) => onPresenceRef.current(cur));
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startPresenceSession]);

  const handleSubmit = (ev: FormEvent) => {
    ev.preventDefault();
    const e = scan.trim().toUpperCase();
    setScan("");
    if (!e) return;
    // Digitação manual: injeta como peça "presente" agora.
    onPresenceRef.current([e]);
  };

  const escolher = (m: EpcMatch) => {
    setFlow({ kind: "reading" });
    void identifica(m).catch(handleResolveError);
  };

  const confirmarOverride = (motivo: string) => {
    const f = flowRef.current;
    if (f.kind !== "identified") return;
    setOverrideOpen(false);
    void iniciarImpressao(f.order, f.lidas, motivo);
  };

  const imprimirManual = () => {
    const f = flowRef.current;
    if (f.kind !== "identified") return;
    void iniciarImpressao(f.order, f.lidas);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key.toLowerCase() === "r") {
        e.preventDefault();
        reiniciar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reiniciar]);

  const order = orderOf(flow);

  return (
    <div style={page}>
      <AmbientBackground variant="flat" />

      <header style={subHeader}>
        <div style={hLeft}>
          <BackButton onClick={onBack} />
          <OperatorChip />
        </div>
        <h2 style={title}>Expedição</h2>
        <div style={hRight}>
          <AutoToggle on={autoPrint} onToggle={() => setAutoPrint((v) => !v)} />
          <ModoBadge modo={modo} />
          <MesaChip connected={rfid.connected} host={rfid.host} onReconnect={() => void rfid.reconnect()} />
        </div>
      </header>

      {modo === "teste" && (
        <div style={testeBanner}>
          MODO TESTE — o fluxo roda inteiro, mas <strong>nada é expedido no sistema</strong>. Pode refazer à vontade.
        </div>
      )}
      {simulacao && <div style={mockBanner}>SIMULAÇÃO — pedidos fictícios (sem servidor). Desligue em Configurações → Expedição pra usar dados reais.</div>}
      {!rfid.connected && (
        <div style={warnBanner}>
          Mesa RFID desconectada ({rfid.host}). A leitura volta sozinha ao reconectar.{" "}
          <button style={inlineBtn} onClick={() => void rfid.reconnect()}>tentar agora</button>
        </div>
      )}
      {engineWarn && <div style={warnBanner}>Impressão: {engineWarn}</div>}
      {bufferSize > BUFFER_WARN && (
        <div style={warnBanner}>Muitas tags na mesa ({bufferSize}). Se tiver peça de outro pedido, tire e aperte <strong>R</strong>.</div>
      )}
      {notice && <div style={noticeBanner}>ℹ {notice}</div>}

      <StepIndicator flow={flow} />

      <div style={layoutRow}>
        <LiveReadPanel readLog={readLog} order={order} connected={rfid.connected} />

        <main style={stage}>
          <StageCenter
            flow={flow}
            progress={progress}
            packingProgress={packingProgress}
            autoPrint={autoPrint}
            onChoose={escolher}
            onForce={() => setOverrideOpen(true)}
            onPrint={imprimirManual}
            onSeal={() => void concluirCiclo()}
            onRestart={reiniciar}
          />
        </main>

        <HistorySidebar session={session} reprintingId={reprintingId} onReprint={(o) => void reprint(o)} />
      </div>

      <footer style={footer}>
        <form onSubmit={handleSubmit} style={scanForm}>
          <span style={scanIconBox}><ScanIcon /></span>
          <input
            ref={inputRef}
            autoFocus
            value={scan}
            onChange={(e) => setScan(e.target.value)}
            placeholder="Aguardando bipada — ou digite o EPC e tecle Enter"
            style={scanInput}
            className="berzerk-scan-input"
          />
          <button type="button" onClick={reiniciar} style={restartBtn} title="Nova leitura (R)">↺ Nova leitura</button>
        </form>
      </footer>

      {overrideOpen && flow.kind === "identified" && (
        <OverrideModal faltam={flow.faltam.length} onCancel={() => setOverrideOpen(false)} onConfirm={confirmarOverride} />
      )}
    </div>
  );
}

// ============================================================
// Centro — estado do pedido (painel verde + grade de peças)
// ============================================================
function StageCenter({
  flow,
  progress,
  packingProgress,
  autoPrint,
  onChoose,
  onForce,
  onPrint,
  onSeal,
  onRestart,
}: {
  flow: Flow;
  progress: Map<string, number>;
  packingProgress: number;
  autoPrint: boolean;
  onChoose: (m: EpcMatch) => void;
  onForce: () => void;
  onPrint: () => void;
  onSeal: () => void;
  onRestart: () => void;
}) {
  if (flow.kind === "idle") {
    return (
      <div style={centerBlock}>
        <div style={{ ...heroDot, background: "var(--success-dot)" }} />
        <h1 style={heroDisplay}>PRONTO</h1>
        <p style={heroHint}>Coloque o próximo pedido na mesa</p>
      </div>
    );
  }
  if (flow.kind === "reading") {
    return (
      <div style={centerBlock}>
        <div style={{ ...heroDot, background: "var(--info-text)", animation: "berzerk-pulse-dot 1.2s ease-in-out infinite" }} />
        <h1 style={{ ...heroDisplay, fontSize: 72, color: "var(--info-text)" }}>LENDO</h1>
        <p style={heroHint}>Identificando o pedido pelas peças…</p>
      </div>
    );
  }
  if (flow.kind === "choose") {
    return (
      <div style={centerBlock}>
        <h1 style={{ ...heroDisplay, fontSize: 44, color: "var(--warning-text)" }}>QUAL PEDIDO?</h1>
        <p style={heroHint}>As tags bateram com mais de um pedido — escolha:</p>
        <div style={chooseRow}>
          {flow.matches.map((m) => (
            <button key={m.order.id} onClick={() => onChoose(m)} style={chooseCard}>
              <code style={{ fontSize: 18, fontWeight: 700 }}>#{m.order.numero ?? m.order.id.slice(0, 8)}</code>
              <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{m.order.clienteNome ?? ""}</span>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{m.tagsMatched}/{m.tagsTotal} tags</span>
            </button>
          ))}
        </div>
      </div>
    );
  }
  if (flow.kind === "error") {
    return (
      <div style={{ ...centerBlock, padding: "0 24px" }}>
        <div style={{ ...heroDot, background: "var(--danger-text)" }} />
        <h1 style={{ ...heroDisplay, fontSize: 56, color: "var(--danger-text)" }}>OPA</h1>
        <p style={{ ...heroHint, fontSize: 16, maxWidth: 560, color: "var(--text)" }}>{flow.message}</p>
        <button style={redBtn} onClick={onRestart}>Nova leitura</button>
      </div>
    );
  }

  // identified / printing / packing / done — painel verde + grade
  // (idle/reading/choose/error já retornaram acima, então flow tem `order`).
  const order = flow.order;
  const faltam = flow.kind === "identified" ? flow.faltam.length : 0;
  const total = order.rfidTags?.length ?? 0;
  const lidasN = flow.kind === "identified" ? total - flow.faltam.length : total;
  const completo = faltam === 0;
  const doneTeste = flow.kind === "done" && flow.modo === "teste";

  return (
    <div style={orderWrap}>
      <OrderPanel
        order={order}
        lidasN={lidasN}
        total={total}
        tone={flow.kind === "done" ? (doneTeste ? "warning" : "success") : completo ? "success" : "warning"}
        headline={
          flow.kind === "done"
            ? doneTeste ? "✓ CONFERIDO (teste)" : "✓ ENVIADO"
            : flow.kind === "printing"
              ? "IMPRIMINDO"
              : completo ? "PEDIDO IDENTIFICADO" : "FALTAM PEÇAS"
        }
      />

      <div style={itemsScroll} className="thin-scroll">
        <ItemsGrid items={order.items} progress={progress} />
      </div>

      {flow.kind === "identified" && (
        <div style={actionsRow}>
          <button style={ghostBtn} onClick={onRestart}>Cancelar (R)</button>
          {!completo && <button style={forceBtn} onClick={onForce}>Forçar impressão (faltam {faltam})</button>}
          {completo && !autoPrint && <button style={redBtn} onClick={onPrint}>Imprimir e embalar</button>}
          {completo && autoPrint && <span style={autoHint}>Automação ligada — imprimindo…</span>}
        </div>
      )}

      {flow.kind === "packing" && (
        <div style={packingBarWrap}>
          <div style={packingBar}><div style={{ ...packingFill, width: `${packingProgress * 100}%` }} /></div>
          <div style={actionsRow}>
            <button style={ghostBtn} onClick={onRestart}>Cancelar</button>
            <button style={redBtn} onClick={onSeal}>Próximo pedido</button>
          </div>
        </div>
      )}
    </div>
  );
}

function OrderPanel({
  order,
  lidasN,
  total,
  tone,
  headline,
}: {
  order: ExpedicaoOrder;
  lidasN: number;
  total: number;
  tone: "success" | "warning";
  headline: string;
}) {
  const accent = tone === "success" ? "var(--success-text)" : "var(--warning-text)";
  const bg = tone === "success" ? "var(--success-bg)" : "var(--warning-bg)";
  const border = tone === "success" ? "var(--success-border)" : "var(--warning-border)";
  return (
    <div style={{ ...orderPanel, background: bg, borderColor: border }}>
      <div style={orderPanelTop}>
        <span style={{ ...orderKicker, color: accent }}>― {headline} ―</span>
        <span style={orderAccount}>{order.tinyAccount}</span>
      </div>
      <div style={orderPanelMain}>
        <div style={orderCol}>
          <span style={orderLabel}>Pedido</span>
          <code style={{ ...orderNumero, color: accent }}>#{order.numero ?? order.tinyOrderId ?? order.id.slice(0, 8)}</code>
        </div>
        <div style={orderMeta}>
          {order.clienteNome && <Meta label="Cliente" value={order.clienteNome} />}
          {order.separatedBy && <Meta label="Separado por" value={order.separatedBy} />}
          {order.trackingNumber && <Meta label="Rastreio" value={order.trackingNumber} mono />}
        </div>
        <div style={orderProgress}>
          <div style={tagsBar}>
            <div style={{ ...tagsFill, width: `${total ? (lidasN / total) * 100 : 0}%`, background: accent }} />
          </div>
          <span style={{ ...tagsLabel, color: accent }}>{lidasN}/{total} peças</span>
        </div>
      </div>
    </div>
  );
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={metaCol}>
      <span style={metaLabel}>{label}</span>
      <span style={{ ...metaValue, fontFamily: mono ? "var(--font-mono)" : "inherit" }}>{value}</span>
    </div>
  );
}

// ============================================================
// Grade de peças (imagem + selinho verde) — o coração da UX
// ============================================================
function ItemsGrid({ items, progress }: { items: OrderItem[]; progress: Map<string, number> }) {
  if (items.length === 0) return <div style={heroHint}>Pedido sem itens cadastrados.</div>;
  return (
    <div style={itemsGrid}>
      {items.map((it) => (
        <ItemCard key={it.id} item={it} count={progress.get(it.id) ?? 0} />
      ))}
    </div>
  );
}

function ItemCard({ item, count }: { item: OrderItem; count: number }) {
  const ok = count >= item.quantidade;
  return (
    <div style={{ ...itemCard, ...(ok ? itemCardDone : null) }}>
      <div style={itemImgWrap}>
        {item.imagemUrl ? (
          <img src={item.imagemUrl} alt="" style={itemImg} loading="lazy" />
        ) : (
          <div style={itemImgEmpty}><IconShirt style={{ width: 30, height: 30 }} /></div>
        )}
        {item.quantidade > 1 && <span style={qtyBadge}>x{item.quantidade}</span>}
        <span style={{ ...checkRing, ...(ok ? checkRingOn : null) }}>{ok ? "✓" : ""}</span>
      </div>
      <div style={itemBody}>
        <span style={itemName}>{item.nome ?? item.sku ?? item.ean ?? "Item"}</span>
        <div style={itemFooter}>
          <span style={itemEan}>{item.ean ?? item.sku ?? "—"}</span>
          <span style={{ ...itemCount, color: ok ? "var(--success-text)" : "var(--text)" }}>
            {Math.min(count, item.quantidade)}/{item.quantidade}
          </span>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Leitura ao vivo (esquerda) — transparência do sistema
// ============================================================
function LiveReadPanel({ readLog, order, connected }: { readLog: ReadEntry[]; order: ExpedicaoOrder | null; connected: boolean }) {
  const tags = order?.rfidTags ? new Set(order.rfidTags.map((t) => t.toUpperCase())) : null;
  return (
    <aside style={livePanel}>
      <div style={liveHeader}>
        <span style={{ ...liveDot, background: connected ? "var(--success-dot)" : "var(--danger-text)", animation: connected ? "berzerk-pulse-dot 1.4s ease-in-out infinite" : "none" }} />
        <span style={liveTitle}>Leitura ao vivo</span>
        {readLog.length > 0 && <span style={liveCount}>{readLog.length}</span>}
      </div>
      <div style={liveList} className="thin-scroll">
        {readLog.length === 0 ? (
          <span style={liveEmpty}>Aproxime as peças — cada tag lida aparece aqui.</span>
        ) : (
          readLog.map((e) => {
            const status = tags ? (tags.has(e.epc) ? "ok" : "fora") : "lendo";
            return (
              <div key={`${e.epc}-${e.ts}`} style={liveRow}>
                <span style={{ ...liveRowIcon, color: status === "ok" ? "var(--success-text)" : status === "fora" ? "var(--warning-text)" : "var(--text-muted)" }}>
                  {status === "ok" ? "✓" : status === "fora" ? "!" : "•"}
                </span>
                <div style={liveRowBody}>
                  <span style={liveRowDesc}>{e.desc || "resolvendo…"}</span>
                  <code style={liveRowEpc}>{e.epc}</code>
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}

// ============================================================
// Histórico (direita) — miniaturas + Reimprimir
// ============================================================
function HistorySidebar({ session, reprintingId, onReprint }: { session: SessionEntry[]; reprintingId: string | null; onReprint: (o: ExpedicaoOrder) => void }) {
  return (
    <aside style={histPanel}>
      <div style={histHeader}>
        <span style={histTitle}>Histórico</span>
        <span style={histSub}>sessão</span>
      </div>
      <div style={histList} className="thin-scroll">
        {session.length === 0 ? (
          <span style={liveEmpty}>Os pedidos despachados nesta sessão aparecem aqui.</span>
        ) : (
          session.map((s, i) => {
            const thumbs = s.order.items.map((it) => it.imagemUrl).filter((u): u is string => !!u).slice(0, 3);
            const count = s.order.items.reduce((a, it) => a + it.quantidade, 0);
            return (
              <div key={`${s.order.id}-${i}`} style={histCard}>
                <div style={histCardTop}>
                  <code style={histNumero}>#{s.order.numero ?? s.order.id.slice(0, 8)}</code>
                  <span style={{ ...histDot, background: s.modo === "teste" ? "var(--warning-text)" : "var(--success-dot)" }} title={s.modo === "teste" ? "teste" : "expedido"} />
                </div>
                {s.order.clienteNome && <span style={histCliente}>{s.order.clienteNome}</span>}
                <div style={histThumbs}>
                  {thumbs.map((u, j) => <img key={j} src={u} alt="" style={histThumb} loading="lazy" />)}
                  {thumbs.length === 0 && <span style={histThumbEmpty}>{count} {count === 1 ? "item" : "itens"}</span>}
                </div>
                <button style={reprintBtn} disabled={reprintingId === s.order.id} onClick={() => onReprint(s.order)}>
                  {reprintingId === s.order.id ? "Reimprimindo…" : "↻ Reimprimir"}
                </button>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
}

// ============================================================
// Header widgets
// ============================================================
function AutoToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      style={{ ...autoToggle, background: on ? "var(--info-bg)" : "var(--bg-card)", borderColor: on ? "var(--info-border)" : "var(--border)", color: on ? "var(--info-text)" : "var(--text-muted)" }}
      title="Bipar e imprimir automaticamente quando o pedido completa"
    >
      <span style={{ ...autoSwitch, background: on ? "var(--info-text)" : "var(--text-faint)", justifyContent: on ? "flex-end" : "flex-start" }}>
        <span style={autoKnob} />
      </span>
      Auto
    </button>
  );
}

function ModoBadge({ modo }: { modo: ExpedicaoMode }) {
  const oficial = modo === "oficial";
  return (
    <span
      style={{ ...modoBadge, cursor: "default", background: oficial ? "var(--danger-bg, #fee2e2)" : "var(--warning-bg)", borderColor: oficial ? "var(--danger-border, #fca5a5)" : "var(--warning-border)", color: oficial ? "var(--danger-text, #b91c1c)" : "var(--warning-text)" }}
      title="Modo definido em Configurações → Expedição"
    >
      <span style={{ ...modoDot, background: oficial ? "var(--danger-text, #b91c1c)" : "var(--warning-text)" }} />
      {oficial ? "OFICIAL" : "TESTE"}
    </span>
  );
}

function MesaChip({ connected, host, onReconnect }: { connected: boolean; host: string; onReconnect: () => void }) {
  return (
    <button style={mesaChip} onClick={onReconnect} title={host}>
      <span style={{ ...mesaDot, background: connected ? "var(--success-dot)" : "var(--danger-text)" }} />
      <span style={mesaText}>{connected ? "Mesa conectada" : "Mesa offline"}</span>
    </button>
  );
}

function StepIndicator({ flow }: { flow: Flow }) {
  const steps: Array<{ id: Step; label: string }> = [
    { id: "ler", label: "Ler" },
    { id: "imprimir", label: "Imprimir" },
    { id: "embalar", label: "Embalar" },
    { id: "fechar", label: "Fechar" },
  ];
  return (
    <div style={stepperWrap}>
      {steps.map((step, i) => {
        const status = statusOfStep(flow, step.id);
        return (
          <div key={step.id} style={stepCell}>
            <div style={stepRow}>
              <span style={{ ...stepDot, ...(status === "active" ? stepDotActive : {}), ...(status === "done" ? stepDotDone : {}) }}>
                {status === "done" ? "✓" : String(i + 1)}
              </span>
              <span style={{ ...stepLabel, color: status === "pending" ? "var(--text-faint)" : "var(--text)", fontWeight: status === "active" ? 700 : 500 }}>{step.label}</span>
            </div>
            {i < steps.length - 1 && <span style={{ ...stepBar, background: status === "done" ? "var(--text)" : "var(--border)" }} />}
          </div>
        );
      })}
    </div>
  );
}

function OverrideModal({ faltam, onCancel, onConfirm }: { faltam: number; onCancel: () => void; onConfirm: (motivo: string) => void }) {
  const [motivo, setMotivo] = useState("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div style={modalOverlay} onClick={onCancel}>
      <div style={modalCard} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: 0, fontSize: 18 }}>Forçar impressão</h3>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>
          Faltam {faltam} tag{faltam === 1 ? "" : "s"} pra completar o pedido. Isso fica registrado (auditável). Descreva o motivo:
        </p>
        <textarea autoFocus value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: peça sem tag, conferido manualmente…" style={modalTextarea} />
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button style={ghostBtn} onClick={onCancel}>Cancelar</button>
          <button style={{ ...redBtn, opacity: motivo.trim() ? 1 : 0.5 }} disabled={!motivo.trim()} onClick={() => onConfirm(motivo.trim())}>Forçar e imprimir</button>
        </div>
      </div>
    </div>
  );
}

function ScanIcon() {
  return (
    <svg width={28} height={28} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="6" width="2" height="12" /><rect x="7" y="6" width="1" height="12" /><rect x="10" y="6" width="3" height="12" /><rect x="15" y="6" width="1" height="12" /><rect x="18" y="6" width="2" height="12" />
    </svg>
  );
}
function IconShirt(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z" />
    </svg>
  );
}

// ============================================================
// Keyframes
// ============================================================
if (typeof document !== "undefined" && !document.getElementById("berzerk-exp-styles")) {
  const s = document.createElement("style");
  s.id = "berzerk-exp-styles";
  s.textContent = `
    @keyframes berzerk-pulse-dot { 0%,100%{transform:scale(1);opacity:1} 50%{transform:scale(1.5);opacity:.6} }
    .berzerk-scan-input:focus { outline:none; border-color:var(--text)!important; background:var(--bg-elevated)!important; }
  `;
  document.head.appendChild(s);
}

// ============================================================
// Styles
// ============================================================
const page: CSSProperties = { height: "100vh", background: "var(--bg)", color: "var(--text)", display: "flex", flexDirection: "column", position: "relative", overflow: "hidden" };
const subHeader: CSSProperties = { position: "relative", display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", gap: 18, padding: "14px 28px", borderBottom: "1px solid var(--border)", background: "var(--bg)" };
const hLeft: CSSProperties = { gridColumn: "1", justifySelf: "start", display: "flex", alignItems: "center", gap: 12 };
const hRight: CSSProperties = { gridColumn: "3", justifySelf: "end", display: "flex", alignItems: "center", gap: 10 };
const title: CSSProperties = { margin: 0, fontSize: 17, fontWeight: 600, color: "var(--text)", gridColumn: "2" };

const testeBanner: CSSProperties = { padding: "7px 28px", background: "var(--warning-bg)", color: "var(--warning-text)", fontSize: 12.5, textAlign: "center", borderBottom: "1px solid var(--warning-border)" };
const mockBanner: CSSProperties = { padding: "6px 28px", background: "var(--info-bg)", color: "var(--info-text)", fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", textAlign: "center" };
const warnBanner: CSSProperties = { padding: "7px 28px", background: "var(--danger-bg, var(--warning-bg))", color: "var(--danger-text, var(--warning-text))", fontSize: 13, textAlign: "center" };
const noticeBanner: CSSProperties = { padding: "7px 28px", background: "var(--info-bg)", color: "var(--info-text)", fontSize: 13, textAlign: "center" };
const inlineBtn: CSSProperties = { background: "transparent", border: 0, color: "inherit", textDecoration: "underline", cursor: "pointer", fontSize: 13, fontWeight: 700 };

const autoToggle: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 8, padding: "6px 12px 6px 8px", border: "1px solid", borderRadius: 999, cursor: "pointer", fontSize: 12, fontWeight: 700, letterSpacing: 0.5 };
const autoSwitch: CSSProperties = { width: 30, height: 18, borderRadius: 999, padding: 2, display: "flex", alignItems: "center", transition: "background 140ms" };
const autoKnob: CSSProperties = { width: 14, height: 14, borderRadius: "50%", background: "white" };
const modoBadge: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 7, padding: "7px 12px", border: "1px solid", borderRadius: 999, fontSize: 12, fontWeight: 800, letterSpacing: 1 };
const modoDot: CSSProperties = { width: 8, height: 8, borderRadius: "50%" };
const mesaChip: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 8, padding: "7px 12px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 999, cursor: "pointer", color: "var(--text-secondary)" };
const mesaDot: CSSProperties = { width: 8, height: 8, borderRadius: "50%" };
const mesaText: CSSProperties = { fontSize: 12, fontWeight: 600 };

const stepperWrap: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "center", padding: "16px 40px", borderBottom: "1px solid var(--border)" };
const stepCell: CSSProperties = { display: "flex", alignItems: "center", flex: "0 0 auto" };
const stepRow: CSSProperties = { display: "flex", alignItems: "center", gap: 10 };
const stepDot: CSSProperties = { width: 26, height: 26, borderRadius: "50%", background: "var(--bg-card)", border: "1px solid var(--border)", color: "var(--text-muted)", display: "grid", placeItems: "center", fontSize: 12, fontFamily: "var(--font-mono)", fontWeight: 700, transition: "all 200ms" };
const stepDotActive: CSSProperties = { background: "var(--text)", color: "var(--accent-text)", borderColor: "var(--text)", transform: "scale(1.1)" };
const stepDotDone: CSSProperties = { background: "var(--success-dot)", color: "white", borderColor: "var(--success-dot)" };
const stepLabel: CSSProperties = { fontSize: 11.5, letterSpacing: 1.5, textTransform: "uppercase" };
const stepBar: CSSProperties = { width: 54, height: 1, margin: "0 14px" };

const layoutRow: CSSProperties = { position: "relative", flex: 1, minHeight: 0, display: "flex" };
const stage: CSSProperties = { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", padding: "20px 24px", overflow: "hidden" };

const centerBlock: CSSProperties = { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, textAlign: "center" };
const heroDot: CSSProperties = { width: 14, height: 14, borderRadius: "50%" };
const heroDisplay: CSSProperties = { margin: 0, fontFamily: "var(--font-display)", fontSize: 88, fontWeight: 400, letterSpacing: 2, lineHeight: 1, color: "var(--text)" };
const heroHint: CSSProperties = { margin: 0, fontSize: 14, color: "var(--text-secondary)" };

const chooseRow: CSSProperties = { display: "flex", gap: 12, flexWrap: "wrap", justifyContent: "center", marginTop: 8 };
const chooseCard: CSSProperties = { display: "flex", flexDirection: "column", alignItems: "center", gap: 4, padding: "16px 22px", background: "var(--bg-card)", border: "1px solid var(--border-strong)", borderRadius: 12, cursor: "pointer", color: "var(--text)", minWidth: 160 };

const orderWrap: CSSProperties = { display: "flex", flexDirection: "column", gap: 14, flex: 1, minHeight: 0 };
const orderPanel: CSSProperties = { border: "2px solid", borderRadius: 16, padding: "14px 20px", display: "flex", flexDirection: "column", gap: 10 };
const orderPanelTop: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between" };
const orderKicker: CSSProperties = { fontSize: 11, letterSpacing: 3, textTransform: "uppercase", fontWeight: 800 };
const orderAccount: CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700, color: "var(--text-muted)", border: "1px solid var(--border)", borderRadius: 6, padding: "2px 8px", background: "var(--bg)" };
const orderPanelMain: CSSProperties = { display: "flex", alignItems: "center", gap: 24, flexWrap: "wrap" };
const orderCol: CSSProperties = { display: "flex", flexDirection: "column", gap: 2 };
const orderLabel: CSSProperties = { fontSize: 10, letterSpacing: 2, textTransform: "uppercase", color: "var(--text-muted)", fontWeight: 700 };
const orderNumero: CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 30, fontWeight: 700, lineHeight: 1 };
const orderMeta: CSSProperties = { display: "flex", gap: 22, flexWrap: "wrap", flex: 1 };
const metaCol: CSSProperties = { display: "flex", flexDirection: "column", gap: 2 };
const metaLabel: CSSProperties = { fontSize: 10, letterSpacing: 1.5, textTransform: "uppercase", color: "var(--text-muted)", fontWeight: 700 };
const metaValue: CSSProperties = { fontSize: 14, fontWeight: 600, color: "var(--text)" };
const orderProgress: CSSProperties = { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4, marginLeft: "auto" };
const tagsBar: CSSProperties = { width: 160, height: 6, background: "rgba(0,0,0,.15)", borderRadius: 999, overflow: "hidden" };
const tagsFill: CSSProperties = { height: "100%", transition: "width 200ms" };
const tagsLabel: CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 700 };

const itemsScroll: CSSProperties = { flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" };
const itemsGrid: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 12, paddingBottom: 4 };
const itemCard: CSSProperties = { display: "flex", flexDirection: "column", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", transition: "border-color 160ms" };
const itemCardDone: CSSProperties = { borderColor: "var(--success-border)" };
const itemImgWrap: CSSProperties = { position: "relative", aspectRatio: "1 / 1", background: "var(--bg-input)", display: "grid", placeItems: "center" };
const itemImg: CSSProperties = { width: "100%", height: "100%", objectFit: "cover" };
const itemImgEmpty: CSSProperties = { color: "var(--text-faint)" };
const qtyBadge: CSSProperties = { position: "absolute", top: 6, left: 6, background: "var(--text)", color: "var(--accent-text)", fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 700, padding: "1px 7px", borderRadius: 999 };
const checkRing: CSSProperties = { position: "absolute", top: 6, right: 6, width: 24, height: 24, borderRadius: "50%", border: "2px solid var(--border-strong)", background: "var(--bg)", display: "grid", placeItems: "center", fontSize: 13, fontWeight: 800, color: "white" };
const checkRingOn: CSSProperties = { background: "var(--success-dot)", borderColor: "var(--success-dot)" };
const itemBody: CSSProperties = { display: "flex", flexDirection: "column", gap: 6, padding: "8px 10px" };
const itemName: CSSProperties = { fontSize: 12, fontWeight: 600, color: "var(--text)", lineHeight: 1.25, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" };
const itemFooter: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 };
const itemEan: CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const itemCount: CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 700, flexShrink: 0 };

const actionsRow: CSSProperties = { display: "flex", gap: 12, alignItems: "center", justifyContent: "center" };
const autoHint: CSSProperties = { fontSize: 13, color: "var(--info-text)", fontWeight: 600 };
const packingBarWrap: CSSProperties = { display: "flex", flexDirection: "column", gap: 12, alignItems: "center" };
const packingBar: CSSProperties = { width: "60%", height: 4, background: "rgba(0,0,0,.18)", borderRadius: 999, overflow: "hidden" };
const packingFill: CSSProperties = { height: "100%", background: "var(--warning-text)", transition: "width 80ms linear" };

const redBtn: CSSProperties = { padding: "13px 26px", fontSize: 14, fontWeight: 700, border: 0, borderRadius: 10, background: "#dc2626", color: "white", cursor: "pointer", textTransform: "uppercase", letterSpacing: 1 };
const ghostBtn: CSSProperties = { padding: "12px 18px", fontSize: 13, fontWeight: 600, border: "1px solid var(--border)", borderRadius: 10, background: "transparent", color: "var(--text-secondary)", cursor: "pointer", textTransform: "uppercase", letterSpacing: 1 };
const forceBtn: CSSProperties = { padding: "12px 20px", background: "transparent", color: "var(--warning-text)", border: "1px solid var(--warning-border)", borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 700 };

// --- Live read panel ---
const livePanel: CSSProperties = { width: 288, flexShrink: 0, borderRight: "1px solid var(--border)", background: "var(--bg-elevated)", display: "flex", flexDirection: "column", minHeight: 0 };
const liveHeader: CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "14px 16px", borderBottom: "1px solid var(--border)" };
const liveDot: CSSProperties = { width: 8, height: 8, borderRadius: "50%" };
const liveTitle: CSSProperties = { fontSize: 13, fontWeight: 700, color: "var(--text)", flex: 1 };
const liveCount: CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-muted)" };
const liveList: CSSProperties = { flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, padding: 12 };
const liveEmpty: CSSProperties = { fontSize: 12, color: "var(--text-muted)", padding: "8px 4px", lineHeight: 1.5 };
const liveRow: CSSProperties = { display: "flex", gap: 8, padding: "8px 10px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8 };
const liveRowIcon: CSSProperties = { fontSize: 13, fontWeight: 800, lineHeight: 1.4, flexShrink: 0 };
const liveRowBody: CSSProperties = { display: "flex", flexDirection: "column", gap: 2, minWidth: 0 };
const liveRowDesc: CSSProperties = { fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const liveRowEpc: CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

// --- History sidebar ---
const histPanel: CSSProperties = { width: 300, flexShrink: 0, borderLeft: "1px solid var(--border)", background: "var(--bg-elevated)", display: "flex", flexDirection: "column", minHeight: 0 };
const histHeader: CSSProperties = { display: "flex", alignItems: "baseline", justifyContent: "space-between", padding: "14px 16px", borderBottom: "1px solid var(--border)" };
const histTitle: CSSProperties = { fontSize: 14, fontWeight: 700, color: "var(--text)" };
const histSub: CSSProperties = { fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 1 };
const histList: CSSProperties = { flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, padding: 12 };
const histCard: CSSProperties = { display: "flex", flexDirection: "column", gap: 8, padding: 10, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12 };
const histCardTop: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between" };
const histNumero: CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 14, fontWeight: 700, color: "var(--text)" };
const histDot: CSSProperties = { width: 8, height: 8, borderRadius: "50%" };
const histCliente: CSSProperties = { fontSize: 12, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const histThumbs: CSSProperties = { display: "flex", gap: 6 };
const histThumb: CSSProperties = { width: 42, height: 42, borderRadius: 6, objectFit: "cover", background: "var(--bg-input)", border: "1px solid var(--border)" };
const histThumbEmpty: CSSProperties = { fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" };
const reprintBtn: CSSProperties = { padding: "7px 10px", fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", border: "1px solid var(--border)", borderRadius: 8, background: "transparent", color: "var(--text-secondary)", cursor: "pointer" };

const footer: CSSProperties = { position: "relative", display: "flex", flexDirection: "column", gap: 10, padding: "14px 28px 18px", borderTop: "1px solid var(--border)", background: "var(--bg)" };
const scanForm: CSSProperties = { display: "flex", alignItems: "center", gap: 14 };
const scanIconBox: CSSProperties = { display: "grid", placeItems: "center", width: 50, height: 50, borderRadius: 12, background: "var(--bg-card)", border: "1px solid var(--border)", color: "var(--text)", flexShrink: 0 };
const scanInput: CSSProperties = { flex: 1, padding: "14px 18px", fontSize: 16, fontFamily: "var(--font-mono)", background: "var(--bg-input)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 10, boxSizing: "border-box" };
const restartBtn: CSSProperties = { padding: "13px 16px", fontSize: 13, fontWeight: 700, border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-card)", color: "var(--text-secondary)", cursor: "pointer", flexShrink: 0 };

const modalOverlay: CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "grid", placeItems: "center", zIndex: 50, padding: 24 };
const modalCard: CSSProperties = { display: "flex", flexDirection: "column", gap: 14, background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 16, padding: 24, width: 460, maxWidth: "100%" };
const modalTextarea: CSSProperties = { minHeight: 80, padding: "10px 12px", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text)", fontSize: 14, resize: "vertical", fontFamily: "inherit" };

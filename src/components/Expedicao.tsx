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
import { LARGURA_PICKING, imagemLeve, miniaturaLeve } from "../lib/imagens";
import { printEngineStatus } from "../lib/printer";
import {
  documentoDaConta,
  imprimirDocumentoDoPedido,
  rotuloDocumento,
} from "../lib/reimpressao";
import { ExpedicaoHistoryModal } from "./ExpedicaoHistoryModal";
import {
  EXP_ERR,
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
import { conferir, type Conferencia } from "../lib/conferenciaExpedicao";
import type { EpcLookupItem, LeituraResolvida, OrderItem } from "../services/orders";

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
  | { kind: "identified"; order: ExpedicaoOrder }
  | { kind: "printing"; order: ExpedicaoOrder }
  | { kind: "packing"; order: ExpedicaoOrder; lidas: string[]; override?: string }
  | { kind: "done"; order: ExpedicaoOrder; modo: ExpedicaoMode; enfileirado: boolean }
  | {
      kind: "error";
      code: string;
      message: string;
      order?: ExpedicaoOrder;
      /** Só no `ja_expedido`: o pedido lá atrás, pra oferecer a reimpressão. */
      jaExpedido?: JaExpedido;
    };

const PACKING_MS = 5000;
const RESOLVE_DEBOUNCE_MS = 250;
// Peças na mesa sem pedido resolvido (separação atrasada, rede, etc.): tenta de
// novo sozinho — o operador não tem mouse/teclado, "Nova leitura" é exceção.
const RESOLVE_RETRY_MS = 4000;
const BUFFER_WARN = 12;
/**
 * Fila de `ship` pendente (falha de rede ao fechar o pacote) — PERSISTIDA por
 * estação. Sem isso, fechar o app com reenvio pendente deixava o pedido
 * `awaiting_pickup` no nexus e o Tiny sem `enviado`, com a peça já ensacada.
 */
const SHIP_RETRY_KEY = "berzerk_expedicao_ship_retry_v1";
type ShipRetryJob = {
  orderId: string;
  numero: string | null;
  lidas: string[];
  override?: string;
  /** Conta Tiny — pra reapertar `markLabelPrinted` quando o ship devolve JT_LABEL_REQUIRED. */
  conta?: "FM" | "JT";
  /** O servidor apontou peça faltando e a trava de supervisor está ligada: só sai com motivo humano. */
  precisaMotivo?: boolean;
  /** Resolução EPC→peça das tags lidas (nuvem iTAG) — o nexus casa as peças por ela. */
  leituras?: LeituraResolvida[];
  /** Job preso no modal já foi reapertado UMA vez com leituras (e ainda assim caiu na conferência). */
  reapertadoComLeituras?: boolean;
};

/** Códigos em que o servidor discorda da conferência da mesa — precisam de motivo HUMANO (trava de supervisor). */
const CODIGOS_CONFERENCIA = new Set<string>(["tags_incompletas", "pecas_insuficientes", "liberacao_necessaria"]);
/** Códigos em que repetir não resolve: alguém mexeu no pedido no Nexus. */
const CODIGOS_DEFINITIVOS = new Set<string>([EXP_ERR.INVALID_STATUS, EXP_ERR.ORDER_NOT_FOUND]);

type ShipTentativa =
  | { ok: true }
  | { ok: false; tipo: "rede" | "aguardar" | "conferencia" | "definitivo"; code: string | null };

/**
 * Depois que o pacote saiu da mesa o ship TEM que passar — um pedido embalado
 * e não expedido vira pedido "não enviado" no Tiny e cliente sem aviso.
 * Política por código:
 * - sem código (rede)            → fila persistente, reenvia sozinho;
 * - JT_LABEL_REQUIRED            → registra a impressão de novo e repete (é só carimbo);
 * - TRACKING_REQUIRED / outros   → fila, tenta de novo (o rastreio chega);
 * - tags_incompletas & cia.      → NUNCA override automático: a trava de supervisor
 *                                  existe pra um humano decidir — abre o modal de motivo;
 * - invalid_status / not_found   → desiste e avisa (alguém mexeu no Nexus).
 */
async function expedirEmbalado(job: ShipRetryJob, segundaVez = false): Promise<ShipTentativa> {
  try {
    await shipOrder(job.orderId, job.lidas, job.override ? { motivo: job.override } : undefined, job.leituras);
    return { ok: true };
  } catch (e) {
    const code = expedicaoErrorCode(e);
    if (!code) return { ok: false, tipo: "rede", code: null };
    if (code === EXP_ERR.JT_LABEL_REQUIRED && job.numero && job.conta && !segundaVez) {
      try {
        await markLabelPrinted(job.numero, job.conta);
      } catch {
        return { ok: false, tipo: "aguardar", code };
      }
      return expedirEmbalado(job, true);
    }
    if (CODIGOS_CONFERENCIA.has(code)) return { ok: false, tipo: "conferencia", code };
    if (CODIGOS_DEFINITIVOS.has(code)) return { ok: false, tipo: "definitivo", code };
    return { ok: false, tipo: "aguardar", code };
  }
}

function loadShipRetry(): ShipRetryJob[] {
  try {
    const raw = localStorage.getItem(SHIP_RETRY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (j): j is ShipRetryJob =>
        !!j && typeof j === "object" && typeof (j as ShipRetryJob).orderId === "string" && Array.isArray((j as ShipRetryJob).lidas),
    );
  } catch {
    return [];
  }
}

function saveShipRetry(jobs: ShipRetryJob[]): void {
  try {
    if (jobs.length === 0) localStorage.removeItem(SHIP_RETRY_KEY);
    else localStorage.setItem(SHIP_RETRY_KEY, JSON.stringify(jobs));
  } catch {
    /* ignore */
  }
}
/**
 * Uma peça é considerada "na mesa" enquanto foi lida nos últimos PRESENCE_TTL ms.
 * Passou disso sem ser relida (o leitor limpa o buffer periodicamente), ela sai
 * do conjunto — é assim que a remoção reflete sem desarmar/piscar o leitor.
 */
const PRESENCE_TTL = 3400;
/**
 * Tolerância cresce com a lotação da mesa: com dezenas de tags o leitor demora
 * mais pra reler cada uma (colisão de inventário) e, com o TTL fixo, tags do
 * pedido sumiam e voltavam a cada ciclo — a tela alternava "FALTAM PEÇAS" ↔
 * "PRONTO" sem ninguém tocar na mesa (vídeo 04/09, pedido #865205 em cima de
 * uma pilha de outro pedido). Até 8 tags é o TTL de sempre; cada tag a mais
 * soma 250 ms, teto de 10 s.
 */
const PRESENCE_TTL_POR_TAG_EXTRA = 250;
const PRESENCE_TTL_MAX = 10000;
function presenceTtl(tagsNaMesa: number): number {
  return Math.min(PRESENCE_TTL_MAX, PRESENCE_TTL + Math.max(0, tagsNaMesa - 8) * PRESENCE_TTL_POR_TAG_EXTRA);
}

/**
 * EPCs que OUTRO pedido `awaiting_pickup` da mesa reivindica. Não podem contar
 * no pedido escolhido — senão um slot "Surpresa" engoliria a peça do vizinho.
 */
function alheiasDe(matches: EpcMatch[], escolhido: EpcMatch): Set<string> {
  const out = new Set<string>();
  for (const outro of matches) {
    if (outro.order.id === escolhido.order.id) continue;
    for (const t of outro.order.rfidTags ?? []) out.add(t.trim().toUpperCase());
  }
  return out;
}

function jaExpedidoMsg(js: JaExpedido[]): string {
  const j = js[0];
  const quando = j?.shippedAt
    ? new Date(j.shippedAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : null;
  const quem = j?.shippedByEmail ?? j?.shippedBy ?? null;
  const det = [quando && `em ${quando}`, quem && `por ${quem}`].filter(Boolean).join(" ");
  return `O pedido #${j?.numero ?? ""} já foi expedido${det ? ` ${det}` : ""}. Tire essas peças da mesa — ou reimprima o documento, se ele não saiu.`;
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
  // Conferência da mesa (peças lidas × grade × tags da separação) — ver
  // `lib/conferenciaExpedicao.ts`. É o que a grade e o painel mostram.
  const [conf, setConf] = useState<Conferencia | null>(null);
  const confRef = useRef<Conferencia | null>(null);
  confRef.current = conf;
  const [readLog, setReadLog] = useState<ReadEntry[]>([]);
  const [session, setSession] = useState<SessionEntry[]>([]);
  const [overrideOpen, setOverrideOpen] = useState(false);
  // Espelho do modal pro loop de leitura (que roda fora do render): enquanto a
  // operadora escreve a justificativa, a mesa fica CONGELADA — o leitor oscila
  // (tag some/volta) e cada oscilação re-identificava o pedido, apitando de
  // novo a cada segundo e, se a tag sumisse, fechava o modal no meio da frase.
  const overrideOpenRef = useRef(false);
  overrideOpenRef.current = overrideOpen;
  // Timer ÚNICO do retry de "rastreio ausente" — sem ref, cada entrada no ramo
  // criava uma cadeia de 4 s independente (rajada no /documentos e risco de
  // duas etiquetas).
  const rastreioTimer = useRef<number | null>(null);
  // Guard de reentrada do fechamento do ciclo (timer da embalagem × "Próximo pedido").
  const concluindoRef = useRef(false);
  const [engineWarn, setEngineWarn] = useState<string | null>(null);
  const [reprintingId, setReprintingId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
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
  // Geração da resolução em curso: cada `doResolve` incrementa e resultados
  // de chamadas antigas (mesa mudou no meio do epc-match/lookup) são
  // descartados — sem isso, respostas fora de ordem faziam a tela alternar
  // entre estados (pedido grande, 37 tags oscilando: "tela branca voltando").
  const resolveGenRef = useRef(0);
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

  // O modal de justificativa só renderiza em "identified"; se o flow sair daí
  // por baixo (falha de rede, mesa esvaziou) ele desmonta sem `onCancel` e o
  // congelamento da leitura ficaria ligado pra sempre — a mesa parava, calada.
  useEffect(() => {
    if (flow.kind !== "identified" && overrideOpen) {
      setOverrideOpen(false);
      overrideOpenRef.current = false;
    }
  }, [flow.kind, overrideOpen]);
  useEffect(
    () => () => {
      if (rastreioTimer.current) window.clearTimeout(rastreioTimer.current);
    },
    [],
  );

  // ---- limpa tudo pra um novo ciclo / repetição ----
  // Zera o que já foi processado/visto — as peças fisicamente na mesa voltam a
  // contar no próximo poll de presença (sem rearmar o leitor).
  const reiniciar = useCallback(() => {
    if (resolveTimer.current) clearTimeout(resolveTimer.current);
    if (rastreioTimer.current) window.clearTimeout(rastreioTimer.current);
    mesaRef.current = new Set();
    processedRef.current = new Set();
    presentRef.current = new Map();
    lastPresentSigRef.current = "";
    lastSigRef.current = "";
    lastFailSigRef.current = "";
    setConf(null);
    setReadLog([]);
    setBufferSize(0);
    setOverrideOpen(false);
    setFlow({ kind: "idle" });
  }, []);

  // ---- resolução do pedido a partir do conjunto atual da mesa ----
  /** Impressão/embalagem/conclusão em curso: nenhum resultado de leitura pode mexer na tela. */
  const mesaOcupada = () => {
    const k = flowRef.current.kind;
    return k === "printing" || k === "packing" || k === "done";
  };

  const doResolve = useCallback(async () => {
    // Modal de justificativa aberto: não re-identifica nem muda de estado.
    // A mesa é re-lida quando o modal fecha (cancelar → `doResolve`; forçar →
    // vai pra impressão, que já ignora o leitor).
    if (overrideOpenRef.current) return;
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
    const gen = ++resolveGenRef.current;
    // Pedido já identificado na tela: re-resolve POR BAIXO, sem voltar pra
    // "LENDO". Antes, cada tag que oscilava no leitor derrubava a grade das
    // peças pro hero de leitura e trazia de volta meio segundo depois —
    // num pedido de 30+ peças isso era contínuo (relato 04/09: "tela branca
    // do nada e voltando").
    if (!retrying && k !== "identified") setFlow({ kind: "reading" });
    const scheduleRetry = () => {
      lastFailSigRef.current = sigNow;
      if (resolveTimer.current) clearTimeout(resolveTimer.current);
      resolveTimer.current = setTimeout(() => void doResolve(), RESOLVE_RETRY_MS);
    };
    try {
      const { matches, unmatchedEpcs, jaExpedidos } = await epcMatch(epcs);
      if (gen !== resolveGenRef.current) return; // mesa mudou no meio — resultado velho
      if (mesaOcupada()) return; // impressão/embalagem começou enquanto o epc-match voava
      if (matches.length === 0) {
        if (!retrying) beepError();
        if (jaExpedidos.length > 0) {
          setFlow({
            kind: "error",
            code: "ja_expedido",
            message: jaExpedidoMsg(jaExpedidos),
            jaExpedido: jaExpedidos[0],
          });
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
      // Apita só quando o pedido MUDA (ou é o primeiro); re-identificar o
      // mesmo pedido a cada tag lida virava apito contínuo.
      const f = flowRef.current;
      const mesmoPedido = f.kind === "identified" && f.order.id === m.order.id;
      if (!mesmoPedido) beepOk();
      if (jaExpedidos.length > 0 && !mesmoPedido) {
        showNotice(`⚠ Tem peça de pedido já expedido na mesa (#${jaExpedidos[0].numero ?? ""}). Confira.`);
      }
      // `unmatchedEpcs` NÃO é mais sinônimo de "peça alheia": num pedido
      // separado no legado as peças dos slots "Surpresa" não estão em
      // `rfid_tags` e caem aqui, mas são deste pedido. Quem decide é a
      // conferência (`conf.fora`), lá embaixo.
      await identifica(m, alheiasDe(matches, m), gen);
    } catch (e) {
      if (gen !== resolveGenRef.current) return; // resolução mais nova já assumiu a tela
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

  // ---- identifica um match: conferência da mesa + trava de completude ----
  // A conferência olha a MESA INTEIRA, não só `tagsLidas` (a interseção com
  // `rfid_tags`): pedido separado no legado tem menos tags gravadas do que
  // peças, e as peças de fora da lista precisam contar pros slots "Surpresa".
  const identifica = useCallback(
    async (m: EpcMatch, alheias: Set<string>, gen?: number) => {
      const order = m.order;
      const naMesa = Array.from(mesaRef.current);
      let resolved = new Map<string, EpcLookupItem>();
      try {
        resolved = await rfid.resolveEpcs(naMesa);
      } catch {
        /* sem lookup a conferência cai nas tags da separação */
      }
      if (gen !== undefined && gen !== resolveGenRef.current) return; // resolução mais nova em curso
      if (mesaOcupada()) return;
      const c = conferir({ items: order.items, naMesa, rfidTags: order.rfidTags, resolved, alheias });
      setConf(c);
      setFlow({ kind: "identified", order });
      if (c.fora.length > 0) {
        showNotice(`⚠ ${c.fora.length} peça(s) na mesa não são deste pedido — tire da mesa antes de fechar.`);
      }
      // Completo + automação ligada → imprime sozinho. Senão espera o operador.
      if (c.completo && autoPrintRef.current) {
        void iniciarImpressao(order, c.contadas);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rfid, showNotice],
  );

  // ---- impressão (J&T → DANFE) → embalagem ----
  const iniciarImpressao = useCallback(
    async (order: ExpedicaoOrder, lidas: string[], override?: string) => {
      setOverrideOpen(false);
      // Invalida qualquer resolve/identifica em voo: a etiqueta vai sair, e um
      // resultado atrasado re-identificando o pedido imprimiria de novo (saco a mais).
      resolveGenRef.current++;
      setFlow({ kind: "printing", order });
      const oficial = modoRef.current === "oficial";
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

      // UM documento, UMA página: a etiqueta da J&T, em qualquer conta (ver
      // `documentoDaConta` — a DANFE deixou de ser a etiqueta da FM quando a
      // conta passou a sair pela J&T). NUNCA os dois — a máquina de embalagem solta
      // um saco por etiqueta impressa, então a segunda página vira um saco a
      // mais no chão. Era esse o bug de produção: a mesa mandava etiqueta E
      // DANFE como dois jobs pra mesma térmica.
      // Sem rastreio o ship é recusado (TRACKING_REQUIRED) — então não
      // imprime: a trava tem que pegar ANTES do saco sair da máquina.
      // Tenta de novo sozinho; a etiqueta costuma voltar com o AWB em minutos.
      if (oficial && !docs.trackingNumber) {
        setFlow({
          kind: "error",
          code: "rastreio_ausente",
          message: `O pedido #${order.numero ?? ""} ainda não tem o rastreio da J&T — a etiqueta não é impressa sem ele. Tentando de novo sozinho…`,
          order,
        });
        if (rastreioTimer.current) window.clearTimeout(rastreioTimer.current);
        rastreioTimer.current = window.setTimeout(() => {
          rastreioTimer.current = null;
          const f = flowRef.current;
          if (f.kind === "error" && f.code === "rastreio_ausente" && f.order?.id === order.id) {
            // `lidas` da conferência ATUAL: a operadora pode ter completado o pedido enquanto esperava.
            void iniciarImpressao(order, confRef.current?.contadas ?? lidas, override);
          }
        }, RESOLVE_RETRY_MS);
        return;
      }

      const documento = documentoDaConta(order.tinyAccount);
      const rotulo = rotuloDocumento(documento);
      const r = await imprimirDocumentoDoPedido(order, "mesa", docs);

      if (!r.ok) {
        // No oficial o documento é pré-requisito: sem papel, não expede.
        if (oficial) {
          setFlow({
            kind: "error",
            code: documento === "etiqueta" ? "etiqueta_ausente" : "danfe_ausente",
            message: `${r.mensagem} Verifique a impressora — o pedido não avança sem a ${rotulo}.`,
            order,
          });
          return;
        }
        showNotice(`${r.mensagem} Seguindo em teste.`);
        setFlow({ kind: "packing", order, lidas, override });
        return;
      }

      // `printed_at` da etiqueta é o carimbo de embalagem que o `ship` exige —
      // só existe pra conta JT (FM não tem linha em `jt_shipping_labels`).
      if (oficial && documento === "etiqueta" && order.numero) {
        try {
          await markLabelPrinted(order.numero, order.tinyAccount);
        } catch {
          /* o ship reaperta o carimbo ao devolver JT_LABEL_REQUIRED (ver expedirEmbalado) */
        }
      }

      setFlow({ kind: "packing", order, lidas, override });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showNotice],
  );

  /**
   * Reimpressão — da sidebar da sessão, do histórico do dia ou da tela "já foi
   * expedido". Mesma escolha por conta da mesa (UM documento, UMA página) e
   * sem tocar no status: reimprimir não é transição de negócio.
   */
  const reprint = useCallback(
    async (order: { id: string; numero: string | null; tinyAccount: string }, origem: "historico" | "ja_expedido") => {
      setReprintingId(order.id);
      const r = await imprimirDocumentoDoPedido(order, origem);
      setReprintingId(null);
      showNotice(r.mensagem);
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

  /**
   * Resolução EPC→peça das tags contadas, pela nuvem iTAG (cache do
   * RfidContext — sem ida à rede na prática). Vai no `ship` como `leituras`,
   * igual ao `complete` da separação: é a MESMA fonte que a mesa usou pra
   * conferir, então servidor e mesa passam a concordar sobre o que foi lido.
   */
  const leiturasDaMesa = useCallback(
    async (tags: string[]): Promise<LeituraResolvida[]> => {
      try {
        const map = await rfid.resolveEpcs(tags);
        return tags.flatMap((t) => {
          const epc = t.toUpperCase();
          const l = map.get(epc);
          return l ? [{ epc, ean13: l.ean13, sku: l.sku, size: l.size, name: l.name ?? null }] : [];
        });
      } catch {
        return [];
      }
    },
    [rfid],
  );
  // Ref pro loop da fila: `rfid` (value do RfidContext) muda a cada render do
  // provider, e o efeito da fila não pode ser reiniciado por isso.
  const leiturasRef = useRef(leiturasDaMesa);
  leiturasRef.current = leiturasDaMesa;

  const concluirCiclo = useCallback(async () => {
    const f = flowRef.current;
    if (f.kind !== "packing") return;
    if (concluindoRef.current) return; // timer da embalagem chegou em cima do "Próximo pedido"
    concluindoRef.current = true;
    const { order, lidas, override } = f;
    // Só as peças CONTADAS deste pedido saem de cena. Marcar a mesa inteira
    // escondia a tag do pedido vizinho pro resto da sessão — ele nunca mais
    // completava (FALTAM PEÇAS + pecas_insuficientes num pedido inteiro).
    for (const e of lidas) processedRef.current.add(e.toUpperCase());

    const registra = (enfileirado: boolean) => {
      concluindoRef.current = false;
      setSession((s) => [{ order, at: new Date(), modo: modoRef.current }, ...s].slice(0, 12));
      setFlow({ kind: "done", order, modo: modoRef.current, enfileirado });
      window.setTimeout(() => {
        setConf(null);
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

    const job: ShipRetryJob = {
      orderId: order.id,
      numero: order.numero,
      lidas,
      override,
      conta: order.tinyAccount,
      leituras: await leiturasDaMesa(lidas),
    };
    const r = await expedirEmbalado(job);
    if (r.ok) {
      registra(false);
      return;
    }
    const num = `#${order.numero ?? ""}`;
    switch (r.tipo) {
      case "rede":
        enqueueRetry(job);
        showNotice(`Sem confirmar a expedição de ${num} (rede). Enfileirado pra reenvio — a mesa segue.`);
        break;
      case "aguardar":
        enqueueRetry(job);
        showNotice(`Expedição de ${num} ainda não passou: ${shipErrorMessage(r.code ?? "")} Vai tentar de novo sozinho.`);
        break;
      case "conferencia":
        enqueueRetry({ ...job, precisaMotivo: true });
        setLiberacao({ ...job, precisaMotivo: true });
        break;
      case "definitivo":
        showNotice(`Expedição de ${num} recusada: ${shipErrorMessage(r.code ?? "")} Confira no Nexus.`, 15000);
        break;
    }
    registra(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showNotice]);

  // ---- fila de retry do ship ----
  // Sobrevive a fechar/reabrir o app (localStorage) — ver SHIP_RETRY_KEY.
  const retryQueue = useRef<ShipRetryJob[]>(loadShipRetry());
  // Só pra re-renderizar a barra de pendências quando a fila muda (a fila vive no ref).
  const [, setQueueVersion] = useState(0);
  const setQueue = useCallback((jobs: ShipRetryJob[]) => {
    retryQueue.current = jobs;
    saveShipRetry(jobs);
    setQueueVersion((v) => v + 1);
  }, []);
  const enqueueRetry = useCallback(
    (job: ShipRetryJob) => setQueue([...retryQueue.current.filter((j) => j.orderId !== job.orderId), job]),
    [setQueue],
  );
  // Pedido embalado que o servidor recusou por conferência: modal de motivo (humano).
  const [liberacao, setLiberacao] = useState<ShipRetryJob | null>(null);
  const liberacaoRef = useRef<ShipRetryJob | null>(null);
  liberacaoRef.current = liberacao;
  const pendentesDeMotivo = retryQueue.current.filter((j) => j.precisaMotivo);
  const pendentesAguardando = retryQueue.current.filter((j) => !j.precisaMotivo);
  // Foco no campo de bipagem — NUNCA com um modal aberto: o efeito do filho
  // (foco no modal) roda antes deste, e o input roubava as teclas 1–6/Enter.
  useEffect(() => {
    if (overrideOpen || liberacao) return;
    if (flow.kind === "idle" || flow.kind === "identified" || flow.kind === "packing" || flow.kind === "done") {
      inputRef.current?.focus();
    }
  }, [flow.kind, overrideOpen, liberacao]);
  const confirmarLiberacao = useCallback(
    async (motivo: string) => {
      const job = liberacao;
      if (!job) return;
      if (modoRef.current !== "oficial") {
        setLiberacao(null);
        showNotice("Modo teste: nada é expedido. Volte pro modo oficial pra liberar este pedido.");
        return;
      }
      setLiberacao(null);
      const comMotivo: ShipRetryJob = { ...job, override: motivo, precisaMotivo: false };
      const num = job.numero ? `#${job.numero}` : "o pedido";
      const r = await expedirEmbalado(comMotivo);
      if (r.ok) {
        setQueue(retryQueue.current.filter((j) => j.orderId !== job.orderId));
        showNotice(`Expedição de ${num} confirmada com liberação: ${motivo}.`);
        return;
      }
      if (r.tipo === "definitivo") {
        setQueue(retryQueue.current.filter((j) => j.orderId !== job.orderId));
        showNotice(`Expedição de ${num} recusada: ${shipErrorMessage(r.code ?? "")} Confira no Nexus.`, 15000);
        return;
      }
      // rede/aguardar/conferência de novo: guarda o motivo e deixa a fila reapertar.
      enqueueRetry({ ...comMotivo, precisaMotivo: r.tipo === "conferencia" });
      showNotice(`Expedição de ${num} ainda não passou (${shipErrorMessage(r.code ?? "")}). Vai tentar de novo sozinho.`);
    },
    [liberacao, setQueue, enqueueRetry, showNotice],
  );
  const retryBusyRef = useRef(false);
  useEffect(() => {
    const pendentes = retryQueue.current.length;
    if (pendentes > 0) {
      showNotice(`${pendentes} expedição(ões) pendente(s) de sessão anterior — reenviando em segundo plano.`);
    }
    const id = setInterval(() => {
      if (retryQueue.current.length === 0 || modoRef.current !== "oficial") return;
      if (retryBusyRef.current) return; // não empilha requests se a rede está lenta
      retryBusyRef.current = true;
      // Quem precisa de motivo humano não é reapertado às cegas — exceto UMA
      // vez com `leituras` preenchidas, se ainda não tinha: pedido que caiu no
      // modal só porque o servidor não achou o EPC na réplica passa sozinho.
      const temLeituras = (j: ShipRetryJob) => (j.leituras?.length ?? 0) > 0;
      // Job com o modal de motivo aberto é da pessoa, não do loop.
      const emLiberacao = liberacaoRef.current?.orderId;
      const job =
        retryQueue.current.find((j) => !j.precisaMotivo && j.orderId !== emLiberacao) ??
        retryQueue.current.find((j) => j.precisaMotivo && !j.reapertadoComLeituras && j.orderId !== emLiberacao);
      if (!job) {
        retryBusyRef.current = false;
        return;
      }
      const rotulo = job.numero ? `#${job.numero}` : "um pedido pendente";
      // Sem leituras (nuvem iTAG fora na hora): tenta resolver de novo agora.
      const tentativa = temLeituras(job)
        ? Promise.resolve(job)
        : leiturasRef.current(job.lidas).then((leituras) => ({ ...job, leituras }));
      void tentativa
        .then((j) => expedirEmbalado(j).then((r) => [j, r] as const))
        .then(([j, r]) => {
          // Reconcilia por orderId: se o supervisor liberou pelo modal nesse
          // meio tempo, o job já saiu da fila e não pode voltar.
          if (!retryQueue.current.some((x) => x.orderId === job.orderId)) return;
          const semEle = retryQueue.current.filter((x) => x.orderId !== job.orderId);
          if (r.ok) {
            setQueue(semEle);
            showNotice(`Expedição de ${rotulo} foi confirmada.`);
          } else if (r.tipo === "definitivo") {
            setQueue(semEle);
            showNotice(`Expedição de ${rotulo} recusada: ${shipErrorMessage(r.code ?? "")} Confira no Nexus.`, 15000);
          } else if (r.tipo === "conferencia") {
            // Só marca "já reapertei" se de fato foi com leituras; sem elas
            // (nuvem fora) fica elegível de novo quando ela voltar.
            setQueue([...semEle, { ...j, precisaMotivo: true, reapertadoComLeituras: j.reapertadoComLeituras || temLeituras(j) }]);
          } else {
            setQueue([...semEle, j]);
          }
        })
        .finally(() => {
          retryBusyRef.current = false;
        });
    }, 15000);
    return () => clearInterval(id);
  }, [showNotice, setQueue]);

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

    // Poda por TTL (peça que não é relida "sai" da mesa) — TTL cresce com a lotação.
    const ttl = presenceTtl(presentRef.current.size);
    for (const [e, ts] of presentRef.current) {
      if (now - ts > ttl) presentRef.current.delete(e);
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
              if (descCacheRef.current.size > 5000) descCacheRef.current.clear();
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
    const f = flowRef.current;
    const alheias = f.kind === "choose" ? alheiasDe(f.matches, m) : new Set<string>();
    setFlow({ kind: "reading" });
    const gen = ++resolveGenRef.current;
    void identifica(m, alheias, gen).catch(handleResolveError);
  };

  const confirmarOverride = (motivo: string) => {
    const f = flowRef.current;
    if (f.kind !== "identified") return;
    setOverrideOpen(false);
    void iniciarImpressao(f.order, confRef.current?.contadas ?? [], motivo);
  };

  const imprimirManual = () => {
    const f = flowRef.current;
    if (f.kind !== "identified") return;
    void iniciarImpressao(f.order, confRef.current?.contadas ?? []);
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
          <button style={historicoBtn} onClick={() => setHistoryOpen(true)} title="O que a mesa expediu hoje — e reimpressão">
            🕐 Histórico
          </button>
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
      {pendentesDeMotivo.length > 0 && !liberacao && (
        <div style={pendBar}>
          <span>
            ⚠{" "}
            {pendentesDeMotivo.length === 1
              ? `Pedido #${pendentesDeMotivo[0].numero ?? ""} foi embalado mas o servidor apontou peça faltando`
              : `${pendentesDeMotivo.length} pedidos embalados com peça faltando segundo o servidor`}
            {" "}— só expede com motivo (trava de supervisor ligada).
          </span>
          <button type="button" style={pendBtn} onClick={() => setLiberacao(pendentesDeMotivo[0])}>
            Informar motivo
          </button>
        </div>
      )}
      {pendentesAguardando.length > 0 && (
        <div style={pendBarSoft}>
          ⏳ {pendentesAguardando.length === 1
            ? `Envio do pedido #${pendentesAguardando[0].numero ?? ""} pendente`
            : `${pendentesAguardando.length} envios pendentes`}
          {" "}— reenviando sozinho a cada 15 s (rede ou rastreio). O pacote pode seguir.
        </div>
      )}
      {liberacao && (
        <OverrideModal
          faltam={0}
          intro={`O pedido #${liberacao.numero ?? ""} já foi embalado, mas o servidor apontou peça faltando e a trava de supervisor está ligada. Informe o motivo pra expedir:`}
          onCancel={() => setLiberacao(null)}
          onConfirm={(motivo) => void confirmarLiberacao(motivo)}
        />
      )}

      <StepIndicator flow={flow} />

      <div style={layoutRow}>
        <LiveReadPanel readLog={readLog} conf={conf} connected={rfid.connected} />

        <main style={stage}>
          <StageCenter
            flow={flow}
            conf={conf}
            packingProgress={packingProgress}
            autoPrint={autoPrint}
            onChoose={escolher}
            onForce={() => setOverrideOpen(true)}
            onPrint={imprimirManual}
            onSeal={() => void concluirCiclo()}
            onRestart={reiniciar}
            reprintingId={reprintingId}
            onReprint={(o) => void reprint(o, "ja_expedido")}
          />
        </main>

        <HistorySidebar session={session} reprintingId={reprintingId} onReprint={(o) => void reprint(o, "historico")} />
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
        <OverrideModal
          faltam={Math.max(conf ? conf.total - conf.lidas : 0, conf?.faltantes.length ?? 0)}
          onCancel={() => {
            setOverrideOpen(false);
            overrideOpenRef.current = false;
            // Reprocessa o que mudou na mesa enquanto o modal segurava a leitura.
            if (resolveTimer.current) clearTimeout(resolveTimer.current);
            resolveTimer.current = setTimeout(() => void doResolve(), RESOLVE_DEBOUNCE_MS);
          }}
          onConfirm={confirmarOverride}
        />
      )}

      {historyOpen && <ExpedicaoHistoryModal onClose={() => setHistoryOpen(false)} />}
    </div>
  );
}

// ============================================================
// Centro — estado do pedido (painel verde + grade de peças)
// ============================================================
function StageCenter({
  flow,
  conf,
  packingProgress,
  autoPrint,
  onChoose,
  onForce,
  onPrint,
  onSeal,
  onRestart,
  reprintingId,
  onReprint,
}: {
  flow: Flow;
  conf: Conferencia | null;
  packingProgress: number;
  autoPrint: boolean;
  onChoose: (m: EpcMatch) => void;
  onForce: () => void;
  onPrint: () => void;
  onSeal: () => void;
  onRestart: () => void;
  reprintingId: string | null;
  onReprint: (o: { id: string; numero: string | null; tinyAccount: string }) => void;
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
    // "Já foi expedido" deixou de ser beco sem saída: se a impressora travou e
    // o papel não saiu, o embalador reimprime daqui mesmo — sem mandar o
    // pedido de volta pra separação, e sem mudar status nenhum.
    const ja = flow.jaExpedido;
    const doc = ja ? documentoDaConta(ja.tinyAccount) : null;
    return (
      <div style={{ ...centerBlock, padding: "0 24px" }}>
        <div style={{ ...heroDot, background: "var(--danger-text)" }} />
        <h1 style={{ ...heroDisplay, fontSize: 56, color: "var(--danger-text)" }}>OPA</h1>
        <p style={{ ...heroHint, fontSize: 16, maxWidth: 560, color: "var(--text)" }}>{flow.message}</p>
        <div style={erroAcoesRow}>
          {ja && doc && (
            <button
              style={reimprimirGrandeBtn}
              disabled={reprintingId === ja.orderId}
              onClick={() =>
                onReprint({ id: ja.orderId, numero: ja.numero, tinyAccount: ja.tinyAccount })
              }
            >
              {reprintingId === ja.orderId
                ? "Reimprimindo…"
                : `↻ Reimprimir ${doc === "etiqueta" ? "etiqueta" : "DANFE"}`}
            </button>
          )}
          <button style={redBtn} onClick={onRestart}>Nova leitura</button>
        </div>
      </div>
    );
  }

  // identified / printing / packing / done — painel verde + grade
  // (idle/reading/choose/error já retornaram acima, então flow tem `order`).
  const order = flow.order;
  // Progresso = PEÇAS (grade do pedido), não tags gravadas: pedido separado no
  // legado tem menos `rfid_tags` do que peças. Ver `conferenciaExpedicao.ts`.
  const total = conf?.total ?? order.items.reduce((a, it) => a + it.quantidade, 0);
  const lidasN = flow.kind === "identified" ? (conf?.lidas ?? 0) : total;
  const completo = flow.kind === "identified" ? (conf?.completo ?? false) : true;
  const faltam = Math.max(total - lidasN, conf?.faltantes.length ?? 0);
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
        <ItemsGrid items={order.items} progress={conf?.porItem ?? new Map()} />
      </div>

      {flow.kind === "identified" && (
        <div style={actionsRow}>
          <button style={ghostBtn} onClick={onRestart}>Cancelar (R)</button>
          {!completo && <button style={forceBtn} onClick={onForce}>Forçar impressão (faltam {faltam} peça{faltam === 1 ? "" : "s"})</button>}
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
          {nomeSeparador(order) && <Meta label="Separado por" value={nomeSeparador(order)!} />}
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
// "Separado por": o nexus manda o nome em `separatedByNome`; `separatedBy`
// hoje é o id do ator (UUID) — não mostra id cru pra operadora.
function nomeSeparador(order: ExpedicaoOrder): string | null {
  const nome = order.separatedByNome?.trim();
  if (nome) return nome;
  const raw = order.separatedBy?.trim();
  if (!raw) return null;
  return UUID_RE.test(raw) ? null : raw;
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  // Só foto que o CDN entrega pequena; foto do Tiny full-res derrubava o webview.
  const foto = imagemLeve(item.imagemUrl, LARGURA_PICKING);
  return (
    <div style={{ ...itemCard, ...(ok ? itemCardDone : null) }}>
      <div style={itemImgWrap}>
        {foto ? (
          <img
            src={foto}
            alt=""
            style={itemImg}
            loading="lazy"
            decoding="async"
          />
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
function LiveReadPanel({ readLog, conf, connected }: { readLog: ReadEntry[]; conf: Conferencia | null; connected: boolean }) {
  // ✓ = peça que a conferência contou pra ESTE pedido (tag da separação ou peça
  // real cobrindo um slot "Surpresa"); ! = peça que não é deste pedido.
  const contadas = conf ? new Set(conf.contadas) : null;
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
            const status = contadas ? (contadas.has(e.epc) ? "ok" : "fora") : "lendo";
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
          session.map((s, i) => (
            <div key={`${s.order.id}-${i}`} style={histCard}>
              <div style={histCardTop}>
                <code style={histNumero}>#{s.order.numero ?? s.order.id.slice(0, 8)}</code>
                <span style={{ ...histDot, background: s.modo === "teste" ? "var(--warning-text)" : "var(--success-dot)" }} title={s.modo === "teste" ? "teste" : "expedido"} />
              </div>
              {s.order.clienteNome && <span style={histCliente}>{s.order.clienteNome}</span>}
              <HistItens items={s.order.items} />
              <button style={reprintBtn} disabled={reprintingId === s.order.id} onClick={() => onReprint(s.order)}>
                {reprintingId === s.order.id ? "Reimprimindo…" : "↻ Reimprimir"}
              </button>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

/** Quantas miniaturas cabem na linha do card antes do "+N" (regra do legado). */
const HIST_THUMBS_VISIVEIS = 3;

/**
 * Peças do pedido no card do histórico: até 3 miniaturas e um "+N" que abre o
 * resto (o legado tinha esse botão e a mesa usa pra conferir o que foi no
 * pacote). Aberto, lista TODAS as peças, com nome/tamanho e quantidade, inclusive
 * as sem foto — que no modo compacto não aparecem.
 */
function HistItens({ items }: { items: OrderItem[] }) {
  const [aberto, setAberto] = useState(false);
  const count = items.reduce((a, it) => a + it.quantidade, 0);
  // Foto do Tiny full-res não conta: não é renderizada (ver `imagemLeve`).
  const comFoto = items.filter((it) => !!miniaturaLeve(it.imagemUrl));
  const ocultos = items.length - Math.min(comFoto.length, HIST_THUMBS_VISIVEIS);

  if (aberto) {
    return (
      <div style={histItensLista}>
        {items.map((it) => (
          <div key={it.id} style={histItemRow}>
            {miniaturaLeve(it.imagemUrl) ? (
              <img src={miniaturaLeve(it.imagemUrl) ?? undefined} alt="" style={histThumb} loading="lazy" decoding="async" />
            ) : (
              <span style={{ ...histThumb, ...histThumbPlaceholder }}>—</span>
            )}
            <span style={histItemNome}>
              {it.nome ?? it.sku ?? it.ean ?? "Peça"}
              {it.tamanho ? ` · ${it.tamanho}` : ""}
            </span>
            {it.quantidade > 1 && <code style={histItemQtd}>×{it.quantidade}</code>}
          </div>
        ))}
        <button type="button" style={histMaisBtn} onClick={() => setAberto(false)}>
          − Recolher
        </button>
      </div>
    );
  }

  return (
    <div style={histThumbs}>
      {comFoto.slice(0, HIST_THUMBS_VISIVEIS).map((it) => (
        <img key={it.id} src={miniaturaLeve(it.imagemUrl) ?? undefined} alt="" style={histThumb} loading="lazy" decoding="async" />
      ))}
      {ocultos > 0 && (
        <button type="button" style={histMaisTile} onClick={() => setAberto(true)} title={`Ver todas as ${items.length} peças`}>
          +{ocultos}
        </button>
      )}
      {comFoto.length === 0 && ocultos === 0 && (
        <span style={histThumbEmpty}>{count} {count === 1 ? "item" : "itens"}</span>
      )}
    </div>
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

/**
 * Motivos prontos pra forçar a impressão. A mesa não tem tempo (nem gente
 * confortável) pra digitar: escolhe com um clique ou com a tecla do número.
 * "Outro" abre o texto livre. O texto vai como está pro `override.motivo` do
 * nexus (mín. 3 caracteres lá).
 */
const MOTIVOS_OVERRIDE = [
  "Supervisor liberou",
  "Peça sem tag",
  "Tag não lê",
  "Conferido na mão",
  "Peça em falta, cliente avisado",
] as const;
const MOTIVO_MIN = 3;

function OverrideModal({
  faltam,
  intro,
  onCancel,
  onConfirm,
}: {
  faltam: number;
  intro?: string;
  onCancel: () => void;
  onConfirm: (motivo: string) => void;
}) {
  const [escolhido, setEscolhido] = useState<number | null>(null);
  const [outro, setOutro] = useState(false);
  const [texto, setTexto] = useState("");
  const motivo = outro ? texto.trim() : escolhido !== null ? MOTIVOS_OVERRIDE[escolhido] : "";
  const pronto = motivo.length >= MOTIVO_MIN;
  const confirmar = () => pronto && onConfirm(motivo);
  // Tira o foco do campo de bipagem: senão o número digitado cai lá dentro e o
  // Enter dispara o form da bipada junto com a confirmação.
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCancel();
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT") return; // campo de bipagem com foco: não interpreta
      const noTexto = tag === "TEXTAREA";
      if (e.key === "Enter" && !noTexto) {
        e.preventDefault();
        confirmar();
        return;
      }
      if (noTexto) return;
      const n = Number(e.key);
      if (n >= 1 && n <= MOTIVOS_OVERRIDE.length) {
        e.preventDefault();
        setOutro(false);
        setEscolhido(n - 1);
      } else if (n === MOTIVOS_OVERRIDE.length + 1) {
        setEscolhido(null);
        setOutro(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onCancel, motivo, pronto]);

  return (
    <div style={modalOverlay} onClick={onCancel}>
      <div ref={cardRef} tabIndex={-1} style={{ ...modalCard, outline: "none" }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ margin: 0, fontSize: 18 }}>Forçar impressão</h3>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>
          {intro ?? `Faltam ${faltam} peça${faltam === 1 ? "" : "s"} pra completar o pedido. Fica registrado quem forçou e por quê. Escolha o motivo:`}
        </p>
        <div style={motivoGrid}>
          {MOTIVOS_OVERRIDE.map((m, i) => {
            const on = !outro && escolhido === i;
            return (
              <button
                key={m}
                type="button"
                style={{ ...motivoBtn, ...(on ? motivoBtnOn : null) }}
                onClick={() => {
                  setOutro(false);
                  setEscolhido(i);
                }}
              >
                <span style={motivoNum}>{i + 1}</span>
                {m}
              </button>
            );
          })}
          <button
            type="button"
            style={{ ...motivoBtn, ...(outro ? motivoBtnOn : null) }}
            onClick={() => {
              setEscolhido(null);
              setOutro(true);
            }}
          >
            <span style={motivoNum}>{MOTIVOS_OVERRIDE.length + 1}</span>
            Outro motivo…
          </button>
        </div>
        {outro && (
          <textarea autoFocus value={texto} onChange={(e) => setTexto(e.target.value)} placeholder="Escreva o motivo" style={modalTextarea} />
        )}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button style={ghostBtn} onClick={onCancel}>Cancelar</button>
          <button style={{ ...redBtn, opacity: pronto ? 1 : 0.5 }} disabled={!pronto} onClick={confirmar}>
            Forçar e imprimir
          </button>
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
const erroAcoesRow: CSSProperties = { display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", justifyContent: "center" };
const reimprimirGrandeBtn: CSSProperties = { padding: "13px 26px", fontSize: 14, fontWeight: 700, border: "1px solid var(--border-strong)", borderRadius: 10, background: "var(--bg-input)", color: "var(--text)", cursor: "pointer", textTransform: "uppercase", letterSpacing: 1 };
const historicoBtn: CSSProperties = { padding: "8px 14px", fontSize: 12, fontWeight: 700, border: "1px solid var(--border)", borderRadius: 999, background: "var(--bg-card)", color: "var(--text-secondary)", cursor: "pointer" };

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
const histThumbPlaceholder: CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", color: "var(--text-faint)", fontSize: 12, flexShrink: 0 };
const histMaisTile: CSSProperties = { ...histThumb, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, fontFamily: "var(--font-mono)", color: "var(--text-secondary)", cursor: "pointer", padding: 0 };
const histItensLista: CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };
const histItemRow: CSSProperties = { display: "flex", alignItems: "center", gap: 8, minWidth: 0 };
const histItemNome: CSSProperties = { flex: 1, minWidth: 0, fontSize: 11, color: "var(--text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" };
const histItemQtd: CSSProperties = { fontSize: 11, color: "var(--text)", fontFamily: "var(--font-mono)", flexShrink: 0 };
const histMaisBtn: CSSProperties = { alignSelf: "flex-start", padding: "4px 8px", fontSize: 11, border: "1px solid var(--border)", borderRadius: 6, background: "transparent", color: "var(--text-muted)", cursor: "pointer" };
const reprintBtn: CSSProperties = { padding: "7px 10px", fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", border: "1px solid var(--border)", borderRadius: 8, background: "transparent", color: "var(--text-secondary)", cursor: "pointer" };

const footer: CSSProperties = { position: "relative", display: "flex", flexDirection: "column", gap: 10, padding: "14px 28px 18px", borderTop: "1px solid var(--border)", background: "var(--bg)" };
const scanForm: CSSProperties = { display: "flex", alignItems: "center", gap: 14 };
const scanIconBox: CSSProperties = { display: "grid", placeItems: "center", width: 50, height: 50, borderRadius: 12, background: "var(--bg-card)", border: "1px solid var(--border)", color: "var(--text)", flexShrink: 0 };
const scanInput: CSSProperties = { flex: 1, padding: "14px 18px", fontSize: 16, fontFamily: "var(--font-mono)", background: "var(--bg-input)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 10, boxSizing: "border-box" };
const restartBtn: CSSProperties = { padding: "13px 16px", fontSize: 13, fontWeight: 700, border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-card)", color: "var(--text-secondary)", cursor: "pointer", flexShrink: 0 };

const modalOverlay: CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "grid", placeItems: "center", zIndex: 50, padding: 24 };
const modalCard: CSSProperties = { display: "flex", flexDirection: "column", gap: 14, background: "var(--bg-elevated)", border: "1px solid var(--border)", borderRadius: 16, padding: 24, width: 460, maxWidth: "100%" };
const modalTextarea: CSSProperties = { minHeight: 80, padding: "10px 12px", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text)", fontSize: 14, resize: "vertical", fontFamily: "inherit" };
const pendBar: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 14px", background: "var(--danger-bg)", border: "1px solid var(--danger-border)", color: "var(--danger-text)", fontSize: 13, fontWeight: 600 };
const pendBarSoft: CSSProperties = { padding: "8px 14px", background: "var(--info-bg)", border: "1px solid var(--info-border)", color: "var(--info-text)", fontSize: 12, fontWeight: 600 };
const pendBtn: CSSProperties = { padding: "8px 14px", fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, border: 0, borderRadius: 8, background: "#dc2626", color: "white", cursor: "pointer", flexShrink: 0 };
const motivoGrid: CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 };
const motivoBtn: CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "14px 12px", fontSize: 15, fontWeight: 600, textAlign: "left", border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-input)", color: "var(--text)", cursor: "pointer", lineHeight: 1.2 };
const motivoBtnOn: CSSProperties = { borderColor: "var(--info-text)", background: "var(--info-bg)", color: "var(--info-text)" };
const motivoNum: CSSProperties = { display: "inline-flex", alignItems: "center", justifyContent: "center", width: 24, height: 24, borderRadius: 6, border: "1px solid var(--border)", fontFamily: "var(--font-mono)", fontSize: 12, flexShrink: 0, color: "var(--text-muted)" };

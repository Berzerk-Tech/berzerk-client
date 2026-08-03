import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type SVGProps,
} from "react";
import { BackButton } from "./BackButton";
import { AmbientBackground } from "./AmbientBackground";
import { OperatorChip } from "./OperatorChip";
import { useRfid } from "../contexts/RfidContext";
import { beepError, beepOk } from "../lib/beep";
import { subscribeQueueChanged } from "../lib/realtime";
import { SupervisorModal } from "./SupervisorModal";
import { SeparacaoHistoryModal } from "./SeparacaoHistoryModal";
import { PickingFiltersModal, emptyFilters, loadFilters, saveFilters } from "./PickingFiltersModal";
import { ApiError } from "../lib/api";
import {
  claimOrder,
  completeSeparacao,
  getQueueList,
  releaseSeparacao,
  type ClaimResponse,
  type EpcLookupItem,
  type LiberacaoFaltante,
  type LiberacaoSupervisor,
  type Order,
  type OrderItem,
  type QueueFilters,
  type QueueListItem,
  type QueueListResponse,
  type SeparationMode,
} from "../services/orders";

const SHADOW = import.meta.env.VITE_SEPARACAO_SHADOW === "true";

/** Tamanhos conhecidos pra extrair do nome quando o item vem sem `tamanho`. */
const KNOWN_SIZES = new Set([
  "PP", "P", "M", "G", "GG", "XG", "XXG", "G1", "G2", "G3", "XGG",
]);

/**
 * Tamanho efetivo do item: o campo `tamanho` (normalizado), ou extraído do nome
 * ("Oversized - Leg Day - XG") — pedidos espelhados do legado chegam com
 * `tamanho` null e sem isso o agrupamento do misto quebra. Varre os segmentos
 * de trás pra frente porque o tamanho costuma ser o último ("… - M - Rosa" é a
 * exceção coberta).
 */
function itemSize(it: OrderItem): string | null {
  const direct = it.tamanho?.trim().toUpperCase();
  if (direct) return direct;
  if (!it.nome) return null;
  const tokens = it.nome.split(/\s+[-–]\s+/).map((t) => t.trim().toUpperCase());
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (KNOWN_SIZES.has(tokens[i])) return tokens[i];
  }
  return null;
}

/** Mesma normalização de GTIN do nexus: só dígitos, sem zeros à esquerda. */
function normGtin(v: string | null | undefined): string | null {
  const d = v?.replace(/\D/g, "").replace(/^0+/, "");
  return d || null;
}

function normSku(v: string | null | undefined): string | null {
  const s = v?.trim().toUpperCase();
  return s || null;
}

/**
 * Identificadores GTIN de um item/tag: o EAN e TAMBÉM o SKU quando ele é um
 * código de barras puro (8–14 dígitos) — o Tiny às vezes manda o EAN no campo
 * SKU com `ean` null, e o card até MOSTRA esse número (ean ?? sku), mas o
 * casamento só por `ean` rejeitava a peça (bug real de campo, pedido #793823).
 */
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

type Phase = "loading" | "separating" | "empty" | "error";

/** Progresso de conferência de um item. */
type ItemProgress = { count: number; epcs: string[] };

/**
 * Sobressalente: tag lida que NÃO cabe no pedido. `excedente` = unidade a mais
 * de um produto do pedido; `alheia` = peça de outro pedido; `desconhecida` =
 * EPC que nenhuma fonte resolveu. Enquanto houver sobressalente o pedido NÃO
 * conclui (paridade com o legado: ele garantia só o faltante; aqui garantimos
 * também que não vai peça a mais) — a operadora tira a peça da mesa e
 * reinicia a leitura (R).
 */
type ExtraTag = {
  epc: string;
  label: string;
  kind: "excedente" | "alheia" | "desconhecida";
  /** Item do pedido excedido (pinta o card de vermelho). */
  itemId?: string;
};

/** Entrada do console de leitura (o que o leitor viu e como resolvemos). */
type LogEntry = {
  ts: number;
  epc: string;
  desc: string;
  status: "ok" | "extra" | "unknown";
};

const LOG_MAX = 50;

type Props = {
  title: string;
  kicker: string;
  /** Como puxar o próximo pedido (fila normal por tamanho, ou mistos). */
  claim: (filters?: QueueFilters) => Promise<ClaimResponse>;
  /** Texto quando a fila esvazia. */
  emptyHint: string;
  /** Fila ativa (mode+size) — habilita a sidebar com os próximos pedidos. */
  queue?: { mode: SeparationMode; size: string };
  onBack: () => void;
};

export function SeparacaoRunner({ title, kicker, claim, emptyHint, queue, onBack }: Props) {
  const rfid = useRfid();
  const [phase, setPhase] = useState<Phase>("loading");
  const [order, setOrder] = useState<Order | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  // progresso por item (ref pra ler dentro do closure de leitura; state pra render)
  const progressRef = useRef<Map<string, ItemProgress>>(new Map());
  // Sobressalentes por EPC (bloqueiam o Concluir até reiniciar a leitura).
  const extrasRef = useRef<Map<string, ExtraTag>>(new Map());
  // Console de leitura (mais novo primeiro, cap LOG_MAX).
  const logRef = useRef<LogEntry[]>([]);
  const [, forceRender] = useState(0);
  const tick = () => forceRender((n) => n + 1);
  const orderRef = useRef<Order | null>(null);
  orderRef.current = order;
  // Época da sessão de leitura: bump = para a sessão atual e abre outra (o
  // buffer da mesa é limpo no arranque) — é o "Reiniciar (R)".
  const [sessionEpoch, setSessionEpoch] = useState(0);
  // Filtros de picking (data + produtos) — por estação, sobrevivem a reload.
  const [filters, setFilters] = useState<QueueFilters>(() => loadFilters());
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  // Troca de pedido por clique em andamento (não deixa concorrer com claim).
  const switchingRef = useRef(false);
  // Aviso não-bloqueante (claim por clique falhou, degradação de endpoint…).
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 8000);
  }, []);

  const resetLeitura = useCallback(() => {
    progressRef.current = new Map();
    extrasRef.current = new Map();
    logRef.current = [];
  }, []);

  const fetchNext = useCallback(async () => {
    setPhase("loading");
    setError(null);
    resetLeitura();
    try {
      const { order: next } = await claim(filtersRef.current);
      if (!next) {
        setOrder(null);
        setPhase("empty");
        return;
      }
      setOrder(next);
      setPhase("separating");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  }, [claim, resetLeitura]);

  // Primeiro pedido ao montar.
  useEffect(() => {
    void fetchNext();
  }, [fetchNext]);

  const allDone = useCallback((ord: Order): boolean => {
    const prog = progressRef.current;
    return ord.items.every((it) => (prog.get(it.id)?.count ?? 0) >= it.quantidade);
  }, []);

  const collectedTags = useCallback((): string[] => {
    const tags: string[] = [];
    for (const p of progressRef.current.values()) tags.push(...p.epcs);
    return tags;
  }, []);

  const finish = useCallback(async () => {
    const ord = orderRef.current;
    // Sobressalente na mesa TRAVA o complete — senão iria peça a mais.
    if (!ord || completing || extrasRef.current.size > 0) return;
    setCompleting(true);
    try {
      await completeSeparacao(ord.id, collectedTags());
      await fetchNext();
    } catch (e) {
      // Banner (não setError): a fase segue "separating" e o setError só
      // renderiza na fase de erro — sem isso a falha do complete ficava muda.
      showNotice(
        `Falha ao concluir: ${e instanceof Error ? e.message : String(e)} — tenta de novo ou chama o suporte.`,
      );
    } finally {
      setCompleting(false);
    }
  }, [completing, collectedTags, fetchNext, showNotice]);

  /**
   * Reinicia a conferência do pedido atual: a operadora tirou a peça errada da
   * mesa e relê tudo do zero (as peças certas continuam lá e voltam no próximo
   * inventário). Zera progresso/sobressalentes/console e reabre a sessão de
   * leitura — o arranque limpa o buffer físico da mesa.
   */
  const restartLeitura = useCallback(() => {
    if (completing) return;
    resetLeitura();
    setSessionEpoch((n) => n + 1);
    tick();
  }, [completing, resetLeitura]);

  /**
   * Avança pra um pedido ESPECÍFICO clicado na fila (ex.: o atual espera
   * reposição). Sem duplicação: devolve o atual (release) e claima o clicado
   * ATOMICAMENTE no nexus — se outra estação levou primeiro, avisa e volta
   * pro fluxo normal. Nexus antigo (sem o endpoint) degrada com aviso.
   */
  const jumpToOrder = useCallback(
    async (target: QueueListItem) => {
      if (switchingRef.current || completing) return;
      const ord = orderRef.current;
      if (ord && ord.id === target.id) return;
      switchingRef.current = true;
      setPhase("loading");
      setError(null);
      try {
        if (ord && ord.status === "separating") {
          orderRef.current = null;
          setOrder(null);
          await releaseSeparacao(ord.id).catch(() => {
            /* best-effort: o janitor recupera */
          });
        }
        resetLeitura();
        const { order: next } = await claimOrder(target.id);
        if (!next) {
          await fetchNext();
          return;
        }
        setOrder(next);
        setPhase("separating");
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          showNotice(
            `O pedido #${target.numero ?? ""} acabou de ser puxado por outra estação — seguindo com o próximo da fila.`,
          );
        } else if (e instanceof ApiError && e.status === 404) {
          showNotice(
            "O servidor ainda não suporta avançar por clique (aguardando atualização do nexus) — puxando o próximo da fila.",
          );
        } else {
          showNotice(e instanceof Error ? e.message : String(e));
        }
        await fetchNext();
      } finally {
        switchingRef.current = false;
      }
    },
    [completing, fetchNext, resetLeitura, showNotice],
  );

  // === Liberação por supervisor (concluir SEM todas as peças no RFID) ===
  const [supervisorOpen, setSupervisorOpen] = useState(false);

  /** Itens com saldo não lido — contexto do modal + auditoria no nexus. */
  const faltantes = useCallback((): LiberacaoFaltante[] => {
    const ord = orderRef.current;
    if (!ord) return [];
    return ord.items
      .map((it) => ({
        itemId: it.id,
        nome: it.nome,
        tamanho: itemSize(it),
        faltam: it.quantidade - (progressRef.current.get(it.id)?.count ?? 0),
      }))
      .filter((f) => f.faltam > 0);
  }, []);

  const supervisorConfirm = useCallback(
    async (liberacao: LiberacaoSupervisor) => {
      const ord = orderRef.current;
      if (!ord) return;
      // Erros sobem pro modal (PIN errado etc.) — só fecha quando concluir.
      await completeSeparacao(ord.id, collectedTags(), liberacao);
      setSupervisorOpen(false);
      await fetchNext();
    },
    [collectedTags, fetchNext],
  );

  // Acha o item esperado que casa com a tag lida. Casa por QUALQUER
  // identificador GTIN dos dois lados (ean OU sku-que-é-código-de-barras,
  // normalizados — Tiny mistura os campos), com fallback de SKU textual.
  const matchItem = useCallback((ord: Order, look: EpcLookupItem): OrderItem | null => {
    const prog = progressRef.current;
    const remaining = (it: OrderItem) => it.quantidade - (prog.get(it.id)?.count ?? 0);
    const tagGtins = gtinCandidates(look.ean13, look.sku);
    // 1) GTIN cruzado (ean↔ean, ean↔sku-numérico, etc.)
    const byGtin = ord.items.find((it) => {
      if (remaining(it) <= 0) return false;
      const itemGtins = gtinCandidates(it.ean, it.sku);
      return tagGtins.some((g) => itemGtins.includes(g));
    });
    if (byGtin) return byGtin;
    // 2) skuEquivalence: mesmo SKU textual (EAN legado do mesmo produto/tamanho)
    const lookSku = normSku(look.sku);
    const bySku = ord.items.find(
      (it) => lookSku && normSku(it.sku) === lookSku && remaining(it) > 0,
    );
    if (bySku) return bySku;
    return null;
  }, []);

  /**
   * Item do pedido que a tag referencia IGNORANDO o saldo — usado pra
   * classificar sobressalente: se casa aqui mas não no matchItem, é unidade a
   * MAIS de um produto do pedido (excedente), não peça alheia.
   */
  const itemDoPedido = useCallback((ord: Order, look: EpcLookupItem): OrderItem | null => {
    const tagGtins = gtinCandidates(look.ean13, look.sku);
    const byGtin = ord.items.find((it) => {
      const itemGtins = gtinCandidates(it.ean, it.sku);
      return tagGtins.some((g) => itemGtins.includes(g));
    });
    if (byGtin) return byGtin;
    const lookSku = normSku(look.sku);
    return ord.items.find((it) => lookSku && normSku(it.sku) === lookSku) ?? null;
  }, []);

  // Última tag lida que NÃO pertence ao pedido — mostrada num banner pra
  // operadora (e pra debug em campo: diz o que a tag É, não só que falhou).
  const [reject, setReject] = useState<string | null>(null);
  const rejectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showReject = useCallback((msg: string) => {
    setReject(msg);
    if (rejectTimerRef.current) clearTimeout(rejectTimerRef.current);
    rejectTimerRef.current = setTimeout(() => setReject(null), 8000);
  }, []);

  /** Registra uma entrada no console de leitura (mais novo primeiro). */
  const pushLog = useCallback((entry: Omit<LogEntry, "ts">) => {
    logRef.current = [{ ...entry, ts: Date.now() }, ...logRef.current].slice(0, LOG_MAX);
  }, []);

  // Handler de tags lido sempre fresco via ref — assim a sessão de leitura NÃO
  // reinicia a cada render (só quando muda o pedido).
  const onTagsRef = useRef<(newEpcs: string[]) => void>(() => {});
  onTagsRef.current = (newEpcs: string[]) => {
    void (async () => {
      const ord = orderRef.current;
      if (!ord) return;
      const resolved = await rfid.resolveEpcs(newEpcs);
      let changed = false;
      for (const epc of newEpcs) {
        const epcU = epc.toUpperCase();
        const look = resolved.get(epcU);
        const item = look ? matchItem(ord, look) : null;
        if (item) {
          const prog = progressRef.current.get(item.id) ?? { count: 0, epcs: [] };
          prog.count += 1;
          // Uma tag por unidade lida (o nexus valida rfidTags.length vs grade).
          prog.epcs.push(epcU);
          progressRef.current.set(item.id, prog);
          pushLog({
            epc: epcU,
            desc: [look!.name ?? item.nome, look!.size, look!.ean13].filter(Boolean).join(" · "),
            status: "ok",
          });
          changed = true;
          beepOk();
        } else {
          beepError();
          if (look) {
            const desc = [look.name, look.size, look.ean13].filter(Boolean).join(" · ");
            // Excedente do próprio pedido (produto certo, unidade a mais) ou
            // peça de outro pedido? Muda a mensagem E o card que fica vermelho.
            const excedido = itemDoPedido(ord, look);
            extrasRef.current.set(epcU, {
              epc: epcU,
              label: desc || epcU,
              kind: excedido ? "excedente" : "alheia",
              itemId: excedido?.id,
            });
            pushLog({ epc: epcU, desc: desc || "(sem descrição)", status: "extra" });
            if (excedido) {
              showReject(
                `Peça SOBRESSALENTE: ${desc} — o pedido já tem as unidades desse produto. Tire a peça da mesa e reinicie (R).`,
              );
            } else {
              // Diagnóstico de campo: mostra os códigos que o pedido ainda espera
              // (ean/sku dos itens com saldo) pra divergência aparecer na hora.
              const esperados = ord.items
                .filter((it) => it.quantidade - (progressRef.current.get(it.id)?.count ?? 0) > 0)
                .map((it) => it.ean ?? it.sku ?? "?")
                .slice(0, 5)
                .join(", ");
              showReject(
                `Peça lida não pertence a este pedido: ${desc} — pedido espera: ${esperados}. Tire a peça da mesa e reinicie (R).`,
              );
            }
          } else {
            extrasRef.current.set(epcU, { epc: epcU, label: epcU, kind: "desconhecida" });
            pushLog({ epc: epcU, desc: "não identificada em nenhuma fonte", status: "unknown" });
            showReject(`Tag não identificada em nenhuma fonte: ${epcU}`);
          }
          tick();
        }
      }
      if (changed) {
        tick();
        if (allDone(ord) && extrasRef.current.size === 0) {
          setReject(null);
          void finish();
        }
      }
    })();
  };

  // Sessão de leitura contínua enquanto há pedido em separação. Reinicia ao
  // trocar de pedido ou quando a operadora pede "Reiniciar (R)" (sessionEpoch).
  useEffect(() => {
    if (phase !== "separating" || !order) return;
    const stop = rfid.startReadingSession((newEpcs) => onTagsRef.current(newEpcs));
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, order?.id, rfid, sessionEpoch]);

  // Atalhos migrados do posvenda (as atendentes já têm decorado):
  //   K = liberar com supervisor (era o "Concluir sem RFID (K)" — aqui a
  //       exceção passa pelo PIN do supervisor);
  //   R = reiniciar a leitura (sobressalente/divergência na mesa).
  // Ignorados digitando em input/textarea/select (e modificadores).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable)
          return;
      }
      const key = e.key.toLowerCase();
      if (key === "k") {
        if (phase !== "separating" || !orderRef.current || completing || supervisorOpen) return;
        e.preventDefault();
        setSupervisorOpen(true);
        return;
      }
      if (key === "r") {
        if (phase !== "separating" || !orderRef.current || completing || supervisorOpen) return;
        const temLeitura =
          extrasRef.current.size > 0 ||
          Array.from(progressRef.current.values()).some((p) => p.count > 0);
        if (!temLeitura) return;
        e.preventDefault();
        restartLeitura();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, completing, supervisorOpen, restartLeitura]);

  // Devolve o pedido pra fila se sair no meio.
  useEffect(() => {
    return () => {
      const ord = orderRef.current;
      if (ord && ord.status === "separating") {
        void releaseSeparacao(ord.id).catch(() => {
          /* best-effort: o janitor recupera */
        });
      }
    };
  }, []);

  const handleBack = () => {
    const ord = orderRef.current;
    if (ord && ord.status === "separating") {
      void releaseSeparacao(ord.id).catch(() => {});
      orderRef.current = null;
    }
    onBack();
  };

  const [historyOpen, setHistoryOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const extras = Array.from(extrasRef.current.values());
  const filtrosAtivos =
    (filters.includeProducts?.length ?? 0) +
    (filters.excludeProducts?.length ?? 0) +
    (filters.dateFrom || filters.dateTo ? 1 : 0);

  const aplicarFiltros = (f: QueueFilters) => {
    setFilters(f);
    saveFilters(f);
  };

  return (
    <div style={page}>
      <AmbientBackground />
      <header style={topBar}>
        <BackButton onClick={handleBack} />
        <div style={titleWrap}>
          <span style={kickerStyle}>― {kicker} ―</span>
          <h1 style={titleStyle}>{title}</h1>
        </div>
        <button style={topBarBtn} onClick={() => setFiltersOpen(true)}>
          Filtros{filtrosAtivos > 0 ? ` (${filtrosAtivos})` : ""}
        </button>
        <button style={topBarBtn} onClick={() => setHistoryOpen(true)}>
          🕐 Histórico
        </button>
        <OperatorChip />
        <MesaStatus
          connected={rfid.connected}
          host={rfid.host}
          onReconnect={() => void rfid.reconnect()}
        />
      </header>

      {SHADOW && (
        <div style={shadowBanner}>
          MODO SHADOW — rodando em paralelo ao pós-venda; não é sistema-de-registro.
        </div>
      )}
      {!rfid.connected && (
        <div style={mesaDownBanner}>
          Mesa RFID desconectada ({rfid.host}). A leitura volta sozinha ao reconectar.{" "}
          <button style={inlineReconnect} onClick={() => void rfid.reconnect()}>
            tentar agora
          </button>
        </div>
      )}
      {extras.length > 0 && (
        <div style={extrasBanner}>
          ⛔{" "}
          {extras.length === 1
            ? "1 peça sobressalente na mesa"
            : `${extras.length} peças sobressalentes na mesa`}{" "}
          — tire da mesa e aperte <strong>R</strong> pra reiniciar a leitura. O pedido não
          conclui com peça a mais.
        </div>
      )}
      {reject && extras.length === 0 && <div style={rejectBanner}>⚠ {reject}</div>}
      {notice && <div style={noticeBanner}>ℹ {notice}</div>}

      <div style={layoutRow}>
        {queue && (
          <QueueSidebar
            mode={queue.mode}
            size={queue.size}
            currentOrder={order}
            filters={filters}
            onJump={(item) => void jumpToOrder(item)}
          />
        )}
        <main style={main}>
          {phase === "loading" && <Centered>Puxando próximo pedido…</Centered>}
          {phase === "error" && (
            <Centered>
              <div style={errorBox}>{error}</div>
              <button style={primaryBtn} onClick={() => void fetchNext()}>
                Tentar de novo
              </button>
            </Centered>
          )}
          {phase === "empty" && (
            <Centered>
              <div style={emptyTitle}>Fila vazia</div>
              <p style={emptyText}>{emptyHint}</p>
              {filtrosAtivos > 0 && (
                <p style={emptyText}>
                  Você tem filtros de picking ativos — eles também valem pro claim.{" "}
                  <button style={inlineReconnect} onClick={() => setFiltersOpen(true)}>
                    revisar filtros
                  </button>
                </p>
              )}
              <button style={primaryBtn} onClick={() => void fetchNext()}>
                Procurar de novo
              </button>
            </Centered>
          )}
          {phase === "separating" && order && (
            <OrderView
              order={order}
              progress={progressRef.current}
              extras={extras}
              completing={completing}
              onComplete={() => void finish()}
              onRestart={restartLeitura}
              onSkip={handleBack}
              onSupervisor={() => setSupervisorOpen(true)}
            />
          )}
        </main>
        {phase === "separating" && order && (
          <ReadLogPanel entries={logRef.current} reading={rfid.connected} />
        )}
      </div>

      {supervisorOpen && (
        <SupervisorModal
          faltantes={faltantes()}
          onCancel={() => setSupervisorOpen(false)}
          onConfirm={supervisorConfirm}
        />
      )}
      {historyOpen && <SeparacaoHistoryModal onClose={() => setHistoryOpen(false)} />}
      {filtersOpen && (
        <PickingFiltersModal
          filters={filters}
          queue={queue}
          onApply={(f) => {
            aplicarFiltros(f);
            setFiltersOpen(false);
          }}
          onClear={() => {
            aplicarFiltros(emptyFilters());
            setFiltersOpen(false);
          }}
          onClose={() => setFiltersOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * Console de leitura ao vivo (coluna direita — o espaço que sobrava): cada tag
 * que o leitor viu e COMO foi resolvida (peça do pedido, sobressalente, não
 * identificada). É o feedback visual que a operadora tinha no posvenda.
 */
function ReadLogPanel({ entries, reading }: { entries: LogEntry[]; reading: boolean }) {
  return (
    <aside style={logPanel}>
      <div style={logHeader}>
        <span style={{ ...logDot, background: reading ? "var(--success-dot)" : "var(--danger-text)" }} />
        <span style={logTitle}>Leitura ao vivo</span>
        <span style={logCount}>{entries.length > 0 ? `${entries.length}` : ""}</span>
      </div>
      <div style={logList}>
        {entries.length === 0 && (
          <span style={logEmpty}>
            Aproxime as peças da mesa — cada tag lida aparece aqui com o que ela é.
          </span>
        )}
        {entries.map((e) => (
          <div key={`${e.epc}-${e.ts}`} style={logEntryStyle(e.status)}>
            <div style={logEntryTop}>
              <span style={logStatusIcon}>
                {e.status === "ok" ? "✓" : e.status === "extra" ? "⛔" : "?"}
              </span>
              <span style={logDesc}>{e.desc}</span>
            </div>
            <div style={logMetaRow}>
              <span style={logEpc}>{e.epc}</span>
              <span style={logTime}>
                {new Date(e.ts).toLocaleTimeString("pt-BR", {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </span>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

/**
 * Sidebar com a fila da vez (réplica do painel esquerdo do posvenda): o pedido
 * em separação fica pinado no topo e os próximos vêm da listagem read-only da
 * API, na MESMA ordem em que o claim vai entregá-los. Atualiza por push
 * (`queue.changed` via WS) com fallback de 60s.
 */
function QueueSidebar({
  mode,
  size,
  currentOrder,
  filters,
  onJump,
}: {
  mode: SeparationMode;
  size: string;
  currentOrder: Order | null;
  filters: QueueFilters;
  /** Clique num card: avança pra ESTE pedido (release do atual + claim dele). */
  onJump: (item: QueueListItem) => void;
}) {
  const [data, setData] = useState<QueueListResponse | null>(null);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");

  // Debounce da busca: o filtro roda no servidor (indexado), não aqui.
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    let alive = true;
    const load = () => {
      getQueueList({ mode, size, q: q || undefined, filters, limit: 50 })
        .then((d) => {
          if (alive) setData(d);
        })
        .catch(() => {
          /* rede: mantém a última lista boa */
        });
    };
    load();
    const unsubscribe = subscribeQueueChanged(load);
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
      unsubscribe();
    };
  }, [mode, size, q, filters]);

  const searching = q.length > 0;
  const current = !searching && currentOrder ? queueItemFromOrder(currentOrder) : null;

  return (
    <aside style={sidebar}>
      <div style={sidebarHeader}>
        <span style={sidebarTitle}>Fila {size}</span>
        <span style={sidebarCount}>
          {data ? `${data.total + (current ? 1 : 0)} pedidos` : "…"}
        </span>
      </div>
      <input
        style={sidebarSearch}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Buscar pedido, cliente ou item…"
        spellCheck={false}
      />
      <span style={sidebarHint}>Clique num pedido pra avançar direto pra ele.</span>
      <div style={sidebarList}>
        {current && <QueueCard item={current} pinned />}
        {data?.items.map((it) => (
          <QueueCard key={it.id} item={it} onClick={() => onJump(it)} />
        ))}
        {data && data.items.length === 0 && !current && (
          <span style={sidebarEmpty}>
            {searching ? "Nada encontrado nessa fila." : "Fila vazia."}
          </span>
        )}
        {data && data.total > data.items.length && (
          <span style={sidebarMore}>+{data.total - data.items.length} pedidos na fila…</span>
        )}
      </div>
    </aside>
  );
}

/** O pedido claimado sai da fila na API — remontamos o card dele pra pinar no topo. */
function queueItemFromOrder(order: Order): QueueListItem {
  return {
    position: 0,
    id: order.id,
    numero: order.numero ?? order.tinyOrderId,
    clienteNome: order.clienteNome ?? null,
    dataEmissao: order.dataEmissao ?? null,
    prioritario: order.prioritario ?? false,
    predominantSize: order.predominantSize,
    separationMode: order.separationMode,
    itemCount: order.items.reduce((a, it) => a + it.quantidade, 0),
    imagens: order.items
      .map((it) => it.imagemUrl)
      .filter((u): u is string => !!u)
      .slice(0, 4),
    createdAt: order.createdAt,
  };
}

function QueueCard({
  item,
  pinned,
  onClick,
}: {
  item: QueueListItem;
  pinned?: boolean;
  onClick?: () => void;
}) {
  const shownThumbs = item.imagens.slice(0, 3);
  const extra = item.itemCount - shownThumbs.length;
  return (
    <div
      onClick={onClick}
      title={onClick ? "Avançar pra este pedido" : undefined}
      style={{
        ...qCard,
        ...(item.prioritario ? qCardPrio : null),
        ...(pinned ? qCardActive : null),
        ...(onClick ? { cursor: "pointer" } : null),
      }}
    >
      <span style={qPos}>{pinned ? "▶" : String(item.position).padStart(2, "0")}</span>
      <div style={qBody}>
        <div style={qTopRow}>
          <span style={qNumero}>#{item.numero ?? "—"}</span>
          {item.prioritario && <span style={qPrioBadge}>Prio</span>}
        </div>
        {item.clienteNome && <span style={qCliente}>{item.clienteNome}</span>}
        <div style={qThumbRow}>
          {shownThumbs.map((u, i) => (
            <img key={i} src={u} alt="" style={qThumb} loading="lazy" />
          ))}
          {shownThumbs.length === 0 && <span style={qThumbEmpty}>{item.itemCount} itens</span>}
          {shownThumbs.length > 0 && extra > 0 && <span style={qThumbMore}>+{extra}</span>}
        </div>
      </div>
      <div style={qRight}>
        {item.predominantSize && <span style={qSizeChip}>{item.predominantSize}</span>}
        {item.dataEmissao && <span style={qDate}>{fmtData(item.dataEmissao)}</span>}
      </div>
    </div>
  );
}

/** Corpo do card: paddings + nome + rodapé (compacto quando o card estreita). */
function cardBodyHeight(cardW: number): number {
  return cardW < 200 ? 64 : 88;
}

/**
 * Tamanho de card que faz o pedido INTEIRO caber no espaço disponível, sem
 * scroll — o scrollbar no meio da tela parecia um divisor e era o incômodo
 * número 1 das operadoras. Mede o container de verdade (ResizeObserver) e
 * testa contagens de coluna: pra cada uma, o card é limitado pela largura da
 * coluna E pela altura da linha (imagem quadrada + corpo); vence a maior.
 * Só quando nem o card mínimo cabe (pedido gigante, ~0,5%) o container rola.
 */
function useFitCards(nMain: number, nOff: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState<{ cardW: number; fits: boolean }>({ cardW: 250, fits: true });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const GAP = 14;
    const MAXW = 260;
    const MINW = 140;
    const BANNER = nOff > 0 ? 46 + GAP : 0;
    const total = nMain + nOff;
    const compute = () => {
      const W = el.clientWidth;
      const H = el.clientHeight;
      if (!W || !H || total === 0) return;
      let best: number | null = null;
      for (let cols = 1; cols <= Math.min(total, 12); cols++) {
        const rows = Math.ceil(nMain / cols) + (nOff > 0 ? Math.ceil(nOff / cols) : 0);
        const wByWidth = Math.min((W - (cols - 1) * GAP) / cols, MAXW);
        const rowH = (H - BANNER - (rows - 1) * GAP) / rows;
        const w = Math.floor(Math.min(wByWidth, rowH - cardBodyHeight(wByWidth)));
        if (w >= MINW) best = Math.max(best ?? 0, w);
      }
      setFit((prev) => {
        const next = best ? { cardW: best, fits: true } : { cardW: 150, fits: false };
        return prev.cardW === next.cardW && prev.fits === next.fits ? prev : next;
      });
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [nMain, nOff]);

  return { ref, ...fit };
}

function OrderView({
  order,
  progress,
  extras,
  completing,
  onComplete,
  onRestart,
  onSkip,
  onSupervisor,
}: {
  order: Order;
  progress: Map<string, ItemProgress>;
  extras: ExtraTag[];
  completing: boolean;
  onComplete: () => void;
  onRestart: () => void;
  onSkip: () => void;
  onSupervisor: () => void;
}) {
  const totalExpected = order.items.reduce((a, it) => a + it.quantidade, 0);
  const totalDone = order.items.reduce(
    (a, it) => a + Math.min(progress.get(it.id)?.count ?? 0, it.quantidade),
    0,
  );
  const temExtras = extras.length > 0;
  const done = totalExpected > 0 && totalDone >= totalExpected && !temExtras;
  // Itens do pedido com unidade excedente lida — o card fica vermelho.
  const excedidos = new Set(extras.map((e) => e.itemId).filter(Boolean) as string[]);

  // Mesma leitura do posvenda: itens do tamanho da fila em cima; os de tamanho
  // diferente (pedido misto) ficam numa seção própria, com divisor de alerta.
  // Compara pelo tamanho EFETIVO (campo ou nome, normalizado); item sem tamanho
  // resolvível fica em cima — não dá pra afirmar que difere.
  const predominant = order.predominantSize?.trim().toUpperCase() ?? null;
  const isMixed = order.separationMode === "total" && !!predominant;
  const differs = (it: OrderItem) => {
    const s = itemSize(it);
    return s !== null && s !== predominant;
  };
  const mainItems = isMixed ? order.items.filter((it) => !differs(it)) : order.items;
  const offSizeItems = isMixed ? order.items.filter(differs) : [];

  const { ref: fitRef, cardW, fits } = useFitCards(mainItems.length, offSizeItems.length);
  const grid: CSSProperties = {
    ...cardsGrid,
    gridTemplateColumns: `repeat(auto-fit, ${cardW}px)`,
  };

  return (
    <div style={orderWrap}>
      <div style={orderHeader}>
        <div>
          <span style={orderLabel}>Pedido</span>
          <div style={orderNumber}>
            #{order.numero ?? order.tinyOrderId ?? order.id.slice(0, 8)}
          </div>
        </div>
        <div style={orderMeta}>
          {order.prioritario && <span style={badgePrio}>Prioritário</span>}
          {order.channel && <span style={badge}>{order.channel}</span>}
          {order.dataEmissao && <span style={badge}>{fmtData(order.dataEmissao)}</span>}
          {order.predominantSize && <span style={badgeStrong}>{order.predominantSize}</span>}
          {order.separationMode === "total" && <span style={badgeWarn}>MISTO</span>}
        </div>
        {order.clienteNome && <span style={clienteNomeStyle}>{order.clienteNome}</span>}
        <div style={progressBadge}>
          {totalDone}/{totalExpected} itens
        </div>
      </div>

      {order.items.length === 0 && <div style={emptyText}>Pedido sem itens cadastrados.</div>}

      <div ref={fitRef} style={fits ? cardsArea : cardsAreaScroll}>
        <div style={grid}>
          {mainItems.map((it) => (
            <ItemCard
              key={it.id}
              item={it}
              count={progress.get(it.id)?.count ?? 0}
              cardW={cardW}
              excedido={excedidos.has(it.id)}
            />
          ))}
        </div>

        {offSizeItems.length > 0 && (
          <>
            <div style={sizeBanner}>
              ⚠{" "}
              {offSizeItems.length === 1
                ? "1 item de tamanho diferente neste pedido"
                : `${offSizeItems.length} itens de tamanho diferente neste pedido`}{" "}
              — confira antes de concluir
            </div>
            <div style={grid}>
              {offSizeItems.map((it) => (
                <ItemCard
                  key={it.id}
                  item={it}
                  count={progress.get(it.id)?.count ?? 0}
                  cardW={cardW}
                  excedido={excedidos.has(it.id)}
                  offSize
                />
              ))}
            </div>
          </>
        )}
      </div>

      <div style={actionsRow}>
        <button style={ghostBtn} onClick={onSkip} disabled={completing}>
          Devolver à fila
        </button>
        {temExtras && (
          <button style={restartBtn} onClick={onRestart} disabled={completing}>
            ↺ Reiniciar leitura (R)
          </button>
        )}
        {!done && (
          <button style={supervisorBtn} onClick={onSupervisor} disabled={completing}>
            🔓 Liberar com supervisor (K)
          </button>
        )}
        <button
          style={done && !completing ? primaryBtn : temExtras ? primaryBtnBlocked : primaryBtnDisabled}
          onClick={onComplete}
          disabled={!done || completing}
        >
          {completing
            ? "Concluindo…"
            : done
              ? "Concluir separação"
              : temExtras
                ? "Sobressalente na mesa — reinicie (R)"
                : "Aguardando leitura…"}
        </button>
      </div>
    </div>
  );
}

/** Card de item no estilo do posvenda: foto grande, xN, nome, EAN e chip do tamanho. */
function ItemCard({
  item,
  count,
  offSize,
  cardW,
  excedido,
}: {
  item: OrderItem;
  count: number;
  offSize?: boolean;
  /** Largura calculada pelo fit — abaixo de 200px o corpo compacta. */
  cardW: number;
  /** Unidade sobressalente lida deste produto — card fica vermelho. */
  excedido?: boolean;
}) {
  const dense = cardW < 200;
  const ok = count >= item.quantidade && !excedido;
  const size = itemSize(item);
  return (
    <div
      style={{
        ...card,
        ...(offSize ? cardOffSize : null),
        ...(ok ? cardDone : null),
        ...(excedido ? cardExcedido : null),
      }}
    >
      <div style={cardImageWrap}>
        {item.imagemUrl ? (
          <img src={item.imagemUrl} alt="" style={cardImage} loading="lazy" />
        ) : (
          <div style={cardImageEmpty}>
            <IconShirt style={dense ? emptyShirtIconDense : emptyShirtIcon} />
            sem imagem
          </div>
        )}
        <span style={item.quantidade > 1 ? qtyBadgeMulti : qtyBadge}>x{item.quantidade}</span>
        <span style={checkRing(ok)}>{ok ? "✓" : excedido ? "!" : ""}</span>
      </div>
      <div style={dense ? cardBodyDense : cardBody}>
        <span style={dense ? cardNameDense : cardName}>
          {item.nome ?? item.sku ?? item.ean ?? "Item"}
        </span>
        <div style={cardFooter}>
          <span style={cardEan}>{item.ean ?? item.sku ?? "—"}</span>
          <span style={cardFooterRight}>
            <span style={excedido ? cardCountExcedido : cardCount}>
              {excedido ? `${count}/${item.quantidade}!` : `${Math.min(count, item.quantidade)}/${item.quantidade}`}
            </span>
            {size && (
              <span style={offSize ? sizeChipOff : sizeChip}>
                {offSize ? `↔ ${size}` : size}
              </span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Camiseta em contorno pro placeholder de imagem — "sem imagem" deixa de
    parecer erro de carregamento. */
function IconShirt(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z" />
    </svg>
  );
}

function fmtData(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function MesaStatus({
  connected,
  host,
  onReconnect,
}: {
  connected: boolean;
  host: string;
  onReconnect: () => void;
}) {
  return (
    <button style={mesaChip} onClick={onReconnect} title={host}>
      <span style={{ ...mesaDot, background: connected ? "var(--success-dot)" : "var(--danger-text)" }} />
      <span style={mesaText}>{connected ? "Mesa conectada" : "Mesa offline"}</span>
    </button>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div style={centered}>{children}</div>;
}

// ============================================================
// Styles
// ============================================================
const page: CSSProperties = {
  height: "100vh",
  background: "var(--bg)",
  color: "var(--text)",
  display: "flex",
  flexDirection: "column",
  position: "relative",
  overflow: "hidden",
};

const topBar: CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
  gap: 18,
  padding: "16px 32px",
  borderBottom: "1px solid var(--border)",
};

const titleWrap: CSSProperties = { display: "flex", flexDirection: "column", gap: 2, flex: 1 };

const kickerStyle: CSSProperties = {
  fontSize: 10,
  letterSpacing: 3,
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontWeight: 700,
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 20,
  fontWeight: 700,
  letterSpacing: -0.3,
  color: "var(--text)",
};

const layoutRow: CSSProperties = {
  position: "relative",
  flex: 1,
  minHeight: 0,
  display: "flex",
};

/** Sem overflow aqui: quem decide rolar (só no pedido gigante) é a área de
    cards — o scrollbar no meio da tela parecia um divisor entre o pedido e a
    Leitura ao vivo. */
const main: CSSProperties = {
  position: "relative",
  flex: 1,
  display: "flex",
  flexDirection: "column",
  padding: "24px 32px",
  maxWidth: 1100,
  width: "100%",
  margin: "0 auto",
  boxSizing: "border-box",
  overflow: "hidden",
  minHeight: 0,
};

// --- Sidebar da fila (réplica do painel esquerdo do posvenda) ---

const sidebar: CSSProperties = {
  width: 300,
  flexShrink: 0,
  display: "flex",
  flexDirection: "column",
  borderRight: "1px solid var(--border)",
  background: "var(--bg-elevated)",
  minHeight: 0,
};

const sidebarHeader: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 8,
  padding: "14px 16px",
  borderBottom: "1px solid var(--border)",
};

const sidebarTitle: CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  color: "var(--text)",
};

const sidebarCount: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--text-muted)",
};

const sidebarSearch: CSSProperties = {
  margin: "10px 12px 0",
  padding: "8px 12px",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: 9,
  color: "var(--text)",
  fontSize: 13,
  outline: "none",
};

const sidebarList: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 12,
};

const sidebarEmpty: CSSProperties = {
  fontSize: 13,
  color: "var(--text-muted)",
  padding: "12px 4px",
};

const sidebarMore: CSSProperties = {
  fontSize: 12,
  color: "var(--text-muted)",
  textAlign: "center",
  padding: "6px 0 10px",
};

const qCard: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  padding: "10px 12px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
};

const qCardPrio: CSSProperties = {
  border: "1px solid var(--danger-border)",
};

const qCardActive: CSSProperties = {
  border: "1px solid var(--info-border)",
  background: "var(--info-bg)",
};

const qPos: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  fontWeight: 700,
  color: "var(--text-faint)",
  paddingTop: 2,
  flexShrink: 0,
  width: 18,
};

const qBody: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  flex: 1,
  minWidth: 0,
};

const qTopRow: CSSProperties = { display: "flex", alignItems: "center", gap: 8 };

const qNumero: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 14,
  fontWeight: 700,
  color: "var(--text)",
};

const qPrioBadge: CSSProperties = {
  fontSize: 9,
  fontWeight: 800,
  letterSpacing: 1,
  textTransform: "uppercase",
  padding: "1px 7px",
  borderRadius: 999,
  background: "var(--danger-bg)",
  color: "var(--danger-text)",
  border: "1px solid var(--danger-border)",
};

const qCliente: CSSProperties = {
  fontSize: 12,
  color: "var(--text-secondary)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const qThumbRow: CSSProperties = { display: "flex", alignItems: "center", gap: 6 };

const qThumb: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 6,
  objectFit: "cover",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
};

const qThumbEmpty: CSSProperties = {
  fontSize: 11,
  color: "var(--text-muted)",
  fontFamily: "var(--font-mono)",
};

const qThumbMore: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  fontWeight: 700,
  color: "var(--text-secondary)",
  padding: "0 6px",
};

const qRight: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  gap: 4,
  flexShrink: 0,
};

const qSizeChip: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  fontWeight: 700,
  padding: "1px 8px",
  borderRadius: 999,
  background: "var(--bg-input)",
  color: "var(--text)",
  border: "1px solid var(--border-strong)",
};

const qDate: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  color: "var(--text-muted)",
};

const centered: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 16,
  color: "var(--text-secondary)",
  textAlign: "center",
};

const shadowBanner: CSSProperties = {
  padding: "8px 32px",
  background: "var(--warning-bg)",
  color: "var(--warning-text)",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 1,
  textTransform: "uppercase",
  textAlign: "center",
};

const mesaDownBanner: CSSProperties = {
  padding: "10px 32px",
  background: "var(--danger-bg, var(--warning-bg))",
  color: "var(--danger-text, var(--warning-text))",
  fontSize: 13,
  textAlign: "center",
};

const rejectBanner: CSSProperties = {
  padding: "10px 32px",
  background: "var(--warning-bg)",
  color: "var(--warning-text)",
  fontSize: 13,
  fontWeight: 600,
  textAlign: "center",
};

const inlineReconnect: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "inherit",
  textDecoration: "underline",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 700,
};

/** Preenche o main inteiro — a área de cards (flex 1) é quem dita o fit. */
const orderWrap: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  width: "100%",
  flex: 1,
  minHeight: 0,
};

/**
 * Área dos cards no modo FIT (o normal): sem scroll nenhum — o useFitCards
 * dimensiona os cards pra caber; conteúdo centralizado verticalmente.
 */
const cardsArea: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
  justifyContent: "center",
  gap: 14,
};

/** Fallback pra pedido gigante (~0,5%): aí sim rola, com card mínimo. */
const cardsAreaScroll: CSSProperties = {
  ...cardsArea,
  overflowY: "auto",
  justifyContent: "flex-start",
};

const orderHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 16,
  flexWrap: "wrap",
};

const orderLabel: CSSProperties = {
  fontSize: 10,
  letterSpacing: 2,
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontWeight: 700,
};

const orderNumber: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 28,
  fontWeight: 700,
  color: "var(--text)",
};

const orderMeta: CSSProperties = { display: "flex", gap: 8, alignItems: "center" };

const badge: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  padding: "3px 10px",
  borderRadius: 6,
  background: "var(--bg-elevated)",
  border: "1px solid var(--border)",
  color: "var(--text-secondary)",
  textTransform: "uppercase",
  letterSpacing: 1,
};

const badgeStrong: CSSProperties = { ...badge, color: "var(--text)", background: "var(--bg-card)" };
const badgeWarn: CSSProperties = {
  ...badge,
  color: "var(--warning-text)",
  background: "var(--warning-bg)",
  border: "1px solid var(--warning-border)",
};
const badgePrio: CSSProperties = {
  ...badge,
  color: "var(--danger-text)",
  background: "var(--danger-bg)",
  border: "1px solid var(--danger-border)",
};

const clienteNomeStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: "var(--text-secondary)",
};

const progressBadge: CSSProperties = {
  marginLeft: "auto",
  fontFamily: "var(--font-mono)",
  fontSize: 16,
  fontWeight: 700,
  color: "var(--text)",
  padding: "6px 14px",
  borderRadius: 10,
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
};

/** auto-fit + largura máxima + centralizado: pedido de 2 itens não deixa a
    direita da tela morta (cards ficam no meio, tamanho estável). */
const cardsGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 250px))",
  gap: 14,
  justifyContent: "center",
};

const card: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 14,
  overflow: "hidden",
};

const cardDone: CSSProperties = {
  border: "1px solid var(--success-border)",
  boxShadow: "0 0 0 1px var(--success-border)",
};

const cardOffSize: CSSProperties = {
  border: "1px solid var(--info-border)",
};

const cardImageWrap: CSSProperties = {
  position: "relative",
  aspectRatio: "1",
  background: "var(--bg-elevated)",
};

const cardImage: CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
  display: "block",
};

const cardImageEmpty: CSSProperties = {
  width: "100%",
  height: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  fontSize: 11,
  letterSpacing: 1,
  textTransform: "uppercase",
  color: "var(--text-faint)",
};

const emptyShirtIcon: CSSProperties = { width: 38, height: 38, opacity: 0.6 };

const qtyBadge: CSSProperties = {
  position: "absolute",
  top: 8,
  right: 8,
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  fontWeight: 700,
  padding: "3px 8px",
  borderRadius: 8,
  background: "rgba(0, 0, 0, 0.65)",
  color: "#fafafa",
};

const qtyBadgeMulti: CSSProperties = {
  ...qtyBadge,
  background: "var(--warning-dot)",
  color: "#0a0a0a",
  fontSize: 14,
};

const checkRing = (ok: boolean): CSSProperties => ({
  position: "absolute",
  top: 8,
  left: 8,
  width: 26,
  height: 26,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  fontSize: 14,
  fontWeight: 800,
  color: ok ? "#0a0a0a" : "transparent",
  background: ok ? "var(--success-dot)" : "rgba(0, 0, 0, 0.4)",
  border: `2px solid ${ok ? "var(--success-dot)" : "rgba(255, 255, 255, 0.35)"}`,
});

const cardBody: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "10px 12px 12px",
};

const cardName: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: "var(--text)",
  lineHeight: 1.3,
  minHeight: 36,
};

const cardFooter: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};

const cardFooterRight: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
};

const cardEan: CSSProperties = {
  fontSize: 11,
  color: "var(--text-muted)",
  fontFamily: "var(--font-mono)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const cardCount: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  fontWeight: 700,
  color: "var(--text)",
};

const sizeChip: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  fontWeight: 700,
  padding: "2px 9px",
  borderRadius: 999,
  background: "var(--success-bg)",
  color: "var(--success-text)",
  border: "1px solid var(--success-border)",
};

const sizeChipOff: CSSProperties = {
  ...sizeChip,
  background: "var(--info-bg)",
  color: "var(--info-text)",
  border: "1px solid var(--info-border)",
};

/** Alerta de grade mista: banner de verdade, não texto solto — o operador
    precisa bater o olho e ver que tem tamanho diferente no pedido. */
const sizeBanner: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "11px 16px",
  background: "var(--info-bg)",
  border: "1px solid var(--info-border)",
  borderRadius: 10,
  color: "var(--info-text)",
  fontSize: 14,
  fontWeight: 700,
  textAlign: "center",
};

const actionsRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  marginTop: 8,
};

/** Ação principal: verde sólido de alto contraste. */
const primaryBtn: CSSProperties = {
  padding: "13px 24px",
  background: "var(--success-dot)",
  color: "#04150c",
  border: "1px solid var(--success-dot)",
  borderRadius: 10,
  cursor: "pointer",
  fontSize: 15,
  fontWeight: 800,
};

/** Estado de espera ("Aguardando leitura…"): verde suave, mas legível — não some. */
const primaryBtnDisabled: CSSProperties = {
  ...primaryBtn,
  background: "var(--success-bg)",
  border: "1px solid var(--success-border)",
  color: "var(--success-text)",
  cursor: "not-allowed",
  fontWeight: 700,
};

const ghostBtn: CSSProperties = {
  padding: "13px 20px",
  background: "transparent",
  color: "var(--text-secondary)",
  border: "1px solid var(--border-strong)",
  borderRadius: 10,
  cursor: "pointer",
  fontSize: 14,
  fontWeight: 600,
};

const supervisorBtn: CSSProperties = {
  ...ghostBtn,
  color: "var(--warning-text)",
  border: "1px dashed var(--border-strong)",
};

const errorBox: CSSProperties = {
  padding: "12px 16px",
  background: "var(--warning-bg)",
  border: "1px solid var(--warning-border)",
  borderRadius: 10,
  color: "var(--warning-text)",
  fontSize: 13,
  maxWidth: 460,
};

const emptyTitle: CSSProperties = {
  fontFamily: "var(--font-display)",
  fontSize: 44,
  color: "var(--text)",
};

const emptyText: CSSProperties = { fontSize: 14, color: "var(--text-secondary)", maxWidth: 420 };

const mesaChip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "7px 12px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 999,
  cursor: "pointer",
  color: "var(--text-secondary)",
};

const mesaDot: CSSProperties = { width: 8, height: 8, borderRadius: "50%" };

const mesaText: CSSProperties = { fontSize: 12, fontWeight: 600 };

// --- Novidades v0.5: sobressalentes, console de leitura, filtros, histórico ---

const topBarBtn: CSSProperties = {
  padding: "8px 14px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 999,
  color: "var(--text-secondary)",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

/** Sobressalente é BLOQUEIO, não aviso — vermelho de verdade, como no legado. */
const extrasBanner: CSSProperties = {
  padding: "12px 32px",
  background: "var(--danger-bg)",
  color: "var(--danger-text)",
  border: "1px solid var(--danger-border)",
  fontSize: 14,
  fontWeight: 700,
  textAlign: "center",
};

const noticeBanner: CSSProperties = {
  padding: "9px 32px",
  background: "var(--info-bg)",
  color: "var(--info-text)",
  fontSize: 13,
  fontWeight: 600,
  textAlign: "center",
};

const sidebarHint: CSSProperties = {
  margin: "6px 14px 0",
  fontSize: 11,
  color: "var(--text-faint)",
};

const cardExcedido: CSSProperties = {
  border: "1px solid var(--danger-border)",
  boxShadow: "0 0 0 2px var(--danger-border)",
};

const cardBodyDense: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: "8px 10px 10px",
};

const cardNameDense: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text)",
  lineHeight: 1.25,
  minHeight: 0,
  overflow: "hidden",
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
};

const cardCountExcedido: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  fontWeight: 800,
  color: "var(--danger-text)",
};

const emptyShirtIconDense: CSSProperties = { width: 26, height: 26, opacity: 0.6 };

const restartBtn: CSSProperties = {
  padding: "13px 20px",
  background: "var(--danger-bg)",
  color: "var(--danger-text)",
  border: "1px solid var(--danger-border)",
  borderRadius: 10,
  cursor: "pointer",
  fontSize: 14,
  fontWeight: 800,
};

/** Concluir travado por sobressalente: vermelho apagado, mensagem no botão. */
const primaryBtnBlocked: CSSProperties = {
  padding: "13px 24px",
  background: "var(--danger-bg)",
  border: "1px solid var(--danger-border)",
  color: "var(--danger-text)",
  borderRadius: 10,
  cursor: "not-allowed",
  fontSize: 15,
  fontWeight: 700,
};

// --- Console de leitura (coluna direita) ---

const logPanel: CSSProperties = {
  width: 300,
  flexShrink: 0,
  display: "flex",
  flexDirection: "column",
  borderLeft: "1px solid var(--border)",
  background: "var(--bg-elevated)",
  minHeight: 0,
};

const logHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "14px 16px",
  borderBottom: "1px solid var(--border)",
};

const logDot: CSSProperties = { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 };

const logTitle: CSSProperties = { fontSize: 14, fontWeight: 700, color: "var(--text)", flex: 1 };

const logCount: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--text-muted)",
};

const logList: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: 12,
};

const logEmpty: CSSProperties = {
  fontSize: 12,
  color: "var(--text-muted)",
  lineHeight: 1.5,
  padding: "8px 4px",
};

const logEntryStyle = (status: LogEntry["status"]): CSSProperties => ({
  display: "flex",
  flexDirection: "column",
  gap: 3,
  padding: "8px 10px",
  borderRadius: 10,
  background:
    status === "ok" ? "var(--success-bg)" : status === "extra" ? "var(--danger-bg)" : "var(--warning-bg)",
  border: `1px solid ${
    status === "ok"
      ? "var(--success-border)"
      : status === "extra"
        ? "var(--danger-border)"
        : "var(--warning-border)"
  }`,
});

const logEntryTop: CSSProperties = { display: "flex", alignItems: "baseline", gap: 7 };

const logStatusIcon: CSSProperties = { fontSize: 12, fontWeight: 800, flexShrink: 0 };

const logDesc: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text)",
  lineHeight: 1.3,
  minWidth: 0,
};

const logMetaRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};

const logEpc: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  color: "var(--text-muted)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const logTime: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  color: "var(--text-faint)",
  flexShrink: 0,
};

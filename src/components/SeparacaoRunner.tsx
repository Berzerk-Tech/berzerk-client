import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { BackButton } from "./BackButton";
import { AmbientBackground } from "./AmbientBackground";
import { useRfid } from "../contexts/RfidContext";
import { beepError, beepOk } from "../lib/beep";
import { subscribeQueueChanged } from "../lib/realtime";
import {
  completeSeparacao,
  getQueueList,
  releaseSeparacao,
  type ClaimResponse,
  type EpcLookupItem,
  type Order,
  type OrderItem,
  type QueueListItem,
  type QueueListResponse,
  type SeparationMode,
} from "../services/orders";

const MAX_TAGS_PER_ITEM = 2;
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

type Phase = "loading" | "separating" | "empty" | "error";

/** Progresso de conferência de um item. */
type ItemProgress = { count: number; epcs: string[] };

type Props = {
  title: string;
  kicker: string;
  /** Como puxar o próximo pedido (fila normal por tamanho, ou mistos). */
  claim: () => Promise<ClaimResponse>;
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
  const [, forceRender] = useState(0);
  const tick = () => forceRender((n) => n + 1);
  const orderRef = useRef<Order | null>(null);
  orderRef.current = order;

  const fetchNext = useCallback(async () => {
    setPhase("loading");
    setError(null);
    progressRef.current = new Map();
    try {
      const { order: next } = await claim();
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
  }, [claim]);

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
    if (!ord || completing) return;
    setCompleting(true);
    try {
      await completeSeparacao(ord.id, collectedTags());
      await fetchNext();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCompleting(false);
    }
  }, [completing, collectedTags, fetchNext]);

  // Acha o item esperado que casa com a tag lida (EAN exato → fallback SKU).
  const matchItem = useCallback((ord: Order, look: EpcLookupItem): OrderItem | null => {
    const prog = progressRef.current;
    const remaining = (it: OrderItem) => it.quantidade - (prog.get(it.id)?.count ?? 0);
    // 1) EAN exato
    const byEan = ord.items.find((it) => it.ean && it.ean === look.ean13 && remaining(it) > 0);
    if (byEan) return byEan;
    // 2) skuEquivalence: mesmo SKU (EAN legado do mesmo produto/tamanho)
    const bySku = ord.items.find((it) => it.sku && look.sku && it.sku === look.sku && remaining(it) > 0);
    if (bySku) return bySku;
    return null;
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
        const look = resolved.get(epc.toUpperCase());
        const item = look ? matchItem(ord, look) : null;
        if (item) {
          const prog = progressRef.current.get(item.id) ?? { count: 0, epcs: [] };
          prog.count += 1;
          if (prog.epcs.length < MAX_TAGS_PER_ITEM) prog.epcs.push(epc.toUpperCase());
          progressRef.current.set(item.id, prog);
          changed = true;
          beepOk();
        } else {
          beepError();
        }
      }
      if (changed) {
        tick();
        if (allDone(ord)) void finish();
      }
    })();
  };

  // Sessão de leitura contínua enquanto há pedido em separação. Só reinicia ao
  // trocar de pedido (deps mínimas).
  useEffect(() => {
    if (phase !== "separating" || !order) return;
    const stop = rfid.startReadingSession((newEpcs) => onTagsRef.current(newEpcs));
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, order?.id, rfid]);

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

  return (
    <div style={page}>
      <AmbientBackground />
      <header style={topBar}>
        <BackButton onClick={handleBack} />
        <div style={titleWrap}>
          <span style={kickerStyle}>― {kicker} ―</span>
          <h1 style={titleStyle}>{title}</h1>
        </div>
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

      <div style={layoutRow}>
        {queue && <QueueSidebar mode={queue.mode} size={queue.size} currentOrder={order} />}
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
              <button style={primaryBtn} onClick={() => void fetchNext()}>
                Procurar de novo
              </button>
            </Centered>
          )}
          {phase === "separating" && order && (
            <OrderView
              order={order}
              progress={progressRef.current}
              completing={completing}
              onComplete={() => void finish()}
              onSkip={handleBack}
            />
          )}
        </main>
      </div>
    </div>
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
}: {
  mode: SeparationMode;
  size: string;
  currentOrder: Order | null;
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
      getQueueList({ mode, size, q: q || undefined, limit: 50 })
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
  }, [mode, size, q]);

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
      <div style={sidebarList}>
        {current && <QueueCard item={current} pinned />}
        {data?.items.map((it) => <QueueCard key={it.id} item={it} />)}
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

function QueueCard({ item, pinned }: { item: QueueListItem; pinned?: boolean }) {
  const shownThumbs = item.imagens.slice(0, 3);
  const extra = item.itemCount - shownThumbs.length;
  return (
    <div
      style={{
        ...qCard,
        ...(item.prioritario ? qCardPrio : null),
        ...(pinned ? qCardActive : null),
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

function OrderView({
  order,
  progress,
  completing,
  onComplete,
  onSkip,
}: {
  order: Order;
  progress: Map<string, ItemProgress>;
  completing: boolean;
  onComplete: () => void;
  onSkip: () => void;
}) {
  const totalExpected = order.items.reduce((a, it) => a + it.quantidade, 0);
  const totalDone = order.items.reduce(
    (a, it) => a + Math.min(progress.get(it.id)?.count ?? 0, it.quantidade),
    0,
  );
  const done = totalExpected > 0 && totalDone >= totalExpected;

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

      <div style={cardsGrid}>
        {mainItems.map((it) => (
          <ItemCard key={it.id} item={it} count={progress.get(it.id)?.count ?? 0} />
        ))}
      </div>

      {offSizeItems.length > 0 && (
        <>
          <div style={sizeDivider}>
            <span style={sizeDividerLine} />
            <span style={sizeDividerText}>
              ⚠ {offSizeItems.length}{" "}
              {offSizeItems.length === 1
                ? "item de tamanho diferente"
                : "itens de tamanho diferente"}
            </span>
            <span style={sizeDividerLine} />
          </div>
          <div style={cardsGrid}>
            {offSizeItems.map((it) => (
              <ItemCard key={it.id} item={it} count={progress.get(it.id)?.count ?? 0} offSize />
            ))}
          </div>
        </>
      )}

      <div style={actionsRow}>
        <button style={ghostBtn} onClick={onSkip} disabled={completing}>
          Devolver à fila
        </button>
        <button
          style={done && !completing ? primaryBtn : primaryBtnDisabled}
          onClick={onComplete}
          disabled={!done || completing}
        >
          {completing ? "Concluindo…" : done ? "Concluir separação" : "Aguardando leitura…"}
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
}: {
  item: OrderItem;
  count: number;
  offSize?: boolean;
}) {
  const ok = count >= item.quantidade;
  const size = itemSize(item);
  return (
    <div
      style={{
        ...card,
        ...(offSize ? cardOffSize : null),
        ...(ok ? cardDone : null),
      }}
    >
      <div style={cardImageWrap}>
        {item.imagemUrl ? (
          <img src={item.imagemUrl} alt="" style={cardImage} loading="lazy" />
        ) : (
          <div style={cardImageEmpty}>sem imagem</div>
        )}
        <span style={item.quantidade > 1 ? qtyBadgeMulti : qtyBadge}>x{item.quantidade}</span>
        <span style={checkRing(ok)}>{ok ? "✓" : ""}</span>
      </div>
      <div style={cardBody}>
        <span style={cardName}>{item.nome ?? item.sku ?? item.ean ?? "Item"}</span>
        <div style={cardFooter}>
          <span style={cardEan}>{item.ean ?? item.sku ?? "—"}</span>
          <span style={cardFooterRight}>
            <span style={cardCount}>
              {Math.min(count, item.quantidade)}/{item.quantidade}
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

const main: CSSProperties = {
  position: "relative",
  flex: 1,
  display: "flex",
  flexDirection: "column",
  padding: "32px",
  maxWidth: 1100,
  width: "100%",
  margin: "0 auto",
  boxSizing: "border-box",
  overflowY: "auto",
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

const inlineReconnect: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "inherit",
  textDecoration: "underline",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 700,
};

const orderWrap: CSSProperties = { display: "flex", flexDirection: "column", gap: 20, width: "100%" };

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

const cardsGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
  gap: 14,
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
  display: "grid",
  placeItems: "center",
  fontSize: 11,
  letterSpacing: 1,
  textTransform: "uppercase",
  color: "var(--text-faint)",
};

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

const sizeDivider: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
  margin: "4px 0",
};

const sizeDividerLine: CSSProperties = {
  flex: 1,
  height: 1,
  background: "var(--info-border)",
};

const sizeDividerText: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: "var(--info-text)",
  whiteSpace: "nowrap",
};

const actionsRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  marginTop: 8,
};

const primaryBtn: CSSProperties = {
  padding: "13px 24px",
  background: "var(--success-bg)",
  color: "var(--success-text)",
  border: "1px solid var(--success-border)",
  borderRadius: 10,
  cursor: "pointer",
  fontSize: 15,
  fontWeight: 700,
};

const primaryBtnDisabled: CSSProperties = { ...primaryBtn, opacity: 0.5, cursor: "not-allowed" };

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

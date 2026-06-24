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
import {
  completeSeparacao,
  releaseSeparacao,
  type ClaimResponse,
  type EpcLookupItem,
  type Order,
  type OrderItem,
} from "../services/orders";

const MAX_TAGS_PER_ITEM = 2;
const SHADOW = import.meta.env.VITE_SEPARACAO_SHADOW === "true";

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
  onBack: () => void;
};

export function SeparacaoRunner({ title, kicker, claim, emptyHint, onBack }: Props) {
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

  return (
    <div style={orderWrap}>
      <div style={orderHeader}>
        <div>
          <span style={orderLabel}>Pedido</span>
          <div style={orderNumber}>{order.numero ?? order.tinyOrderId ?? order.id.slice(0, 8)}</div>
        </div>
        <div style={orderMeta}>
          {order.channel && <span style={badge}>{order.channel}</span>}
          {order.predominantSize && <span style={badgeStrong}>{order.predominantSize}</span>}
          {order.separationMode === "total" && <span style={badgeWarn}>MISTO</span>}
        </div>
        <div style={progressBadge}>
          {totalDone}/{totalExpected} itens
        </div>
      </div>

      <div style={itemsList}>
        {order.items.length === 0 && (
          <div style={emptyText}>Pedido sem itens cadastrados.</div>
        )}
        {order.items.map((it) => {
          const count = progress.get(it.id)?.count ?? 0;
          const ok = count >= it.quantidade;
          return (
            <div key={it.id} style={ok ? itemRowDone : itemRow}>
              <span style={checkDot(ok)}>{ok ? "✓" : ""}</span>
              <div style={itemBody}>
                <span style={itemName}>{it.nome ?? it.sku ?? it.ean ?? "Item"}</span>
                <span style={itemSub}>
                  {it.tamanho ? `Tam ${it.tamanho}` : ""} {it.ean ? `· ${it.ean}` : ""}
                </span>
              </div>
              <span style={itemCount}>
                {Math.min(count, it.quantidade)}/{it.quantidade}
              </span>
            </div>
          );
        })}
      </div>

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
  minHeight: "100vh",
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

const main: CSSProperties = {
  position: "relative",
  flex: 1,
  display: "flex",
  flexDirection: "column",
  padding: "32px",
  maxWidth: 880,
  width: "100%",
  margin: "0 auto",
  boxSizing: "border-box",
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

const itemsList: CSSProperties = { display: "flex", flexDirection: "column", gap: 10 };

const itemRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
  padding: "14px 18px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
};

const itemRowDone: CSSProperties = {
  ...itemRow,
  background: "var(--success-bg)",
  border: "1px solid var(--success-border)",
};

const checkDot = (ok: boolean): CSSProperties => ({
  width: 26,
  height: 26,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  fontSize: 14,
  fontWeight: 800,
  color: ok ? "var(--success-text)" : "transparent",
  border: `2px solid ${ok ? "var(--success-text)" : "var(--border-strong)"}`,
  flexShrink: 0,
});

const itemBody: CSSProperties = { display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 };

const itemName: CSSProperties = { fontSize: 15, fontWeight: 600, color: "var(--text)" };

const itemSub: CSSProperties = {
  fontSize: 12,
  color: "var(--text-muted)",
  fontFamily: "var(--font-mono)",
};

const itemCount: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 18,
  fontWeight: 700,
  color: "var(--text)",
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

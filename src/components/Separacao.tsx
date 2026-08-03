import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { BackButton } from "./BackButton";
import { AmbientBackground } from "./AmbientBackground";
import { OperatorChip } from "./OperatorChip";
import { SeparacaoRunner } from "./SeparacaoRunner";
import { useRfid } from "../contexts/RfidContext";
import { ApiError } from "../lib/api";
import { subscribeQueueChanged } from "../lib/realtime";
import {
  claimNext,
  claimNextMixed,
  getQueueCounts,
  type QueueCounts,
  type QueueFilters,
} from "../services/orders";

type Props = { onBack: () => void };

/**
 * Filas FIXAS da Separação (regra do Victor): só os 5 tamanhos que existem de
 * verdade na operação. Tamanhos raros são agrupados — o claim manda a lista de
 * tamanhos reais do bucket, então nenhum pedido fica órfão:
 *   PP → fila P;  XXG/G1/G2/G3/qualquer outro → fila XG.
 * "SEM TAMANHO" fica FORA (pedidos antigos, pré-junho — o corte por data é
 * feito no nexus).
 */
const QUEUES = ["P", "M", "G", "GG", "XG"] as const;
type Queue = (typeof QUEUES)[number];

function queueFor(sizeKey: string): Queue | null {
  const s = sizeKey.trim().toUpperCase();
  if ((QUEUES as readonly string[]).includes(s)) return s as Queue;
  if (s === "PP") return "P";
  if (s === "SEM TAMANHO") return null;
  return "XG";
}

/** Cada tamanho tem duas abas: Puro (grade normal) e Mistos (grade mista). */
type QueueMode = "puro" | "mistos";

/** Fila escolhida: um tamanho por vez, na aba ativa. */
type Selected = string | null;

export function Separacao({ onBack }: Props) {
  const rfid = useRfid();
  const [mode, setMode] = useState<QueueMode>("puro");
  const [selected, setSelected] = useState<Selected>(null);
  const [confirmed, setConfirmed] = useState<{
    size: Queue;
    mode: QueueMode;
    /** Tamanhos REAIS do bucket no momento do confirm (o claim usa esta lista). */
    sizes: string[];
  } | null>(null);
  const [counts, setCounts] = useState<QueueCounts | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  // Contagem das filas: o WS do nexus empurra `queue.changed` (tiny-sync,
  // claim, complete, release) e cada evento refaz o fetch; o intervalo de 60s
  // é só rede de segurança pro WS cair. Erro de auth/permissão é a API dizendo
  // quem pode operar — mostra, não engole. Falha de rede segue silenciosa.
  useEffect(() => {
    let alive = true;
    const load = () => {
      getQueueCounts()
        .then((c) => {
          if (!alive) return;
          setCounts(c);
          setAuthError(null);
        })
        .catch((err) => {
          if (!alive || !(err instanceof ApiError)) return;
          if (err.status === 403) {
            setAuthError(
              "Seu usuário não tem a permissão de Separação (separacao:operate). Peça pra liberar no Nexus (Operadores).",
            );
          } else if (err.status === 401) {
            setAuthError(
              "A API não reconheceu sua sessão. Troque de usuário e entre de novo; se persistir, avise o suporte.",
            );
          }
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
  }, []);

  // Os filtros de picking moram no runner (por estação) e valem no claim.
  const claim = useCallback(
    (filters?: QueueFilters) => {
      if (!confirmed) return claimNext([""], filters);
      return confirmed.mode === "mistos"
        ? claimNextMixed(confirmed.sizes, filters)
        : claimNext(confirmed.sizes, filters);
    },
    [confirmed],
  );

  if (confirmed) {
    const isMixed = confirmed.mode === "mistos";
    return (
      <SeparacaoRunner
        title={isMixed ? "Separação — Mistos" : "Separação"}
        kicker={`Fila ${confirmed.size} — ${isMixed ? "Mistos" : "Puro"}`}
        emptyHint={
          isMixed
            ? "Nenhum pedido misto pronto nesse tamanho. Tente outra aba ou aguarde a sincronização."
            : "Nenhum pedido pronto nessa fila. Tente outra ou aguarde a sincronização."
        }
        claim={claim}
        queue={{ mode: isMixed ? "total" : "normal", size: confirmed.size }}
        onBack={() => setConfirmed(null)}
      />
    );
  }

  const recordFor = (m: QueueMode): Record<string, number> =>
    (m === "mistos" ? counts?.mixedBySize : counts?.sizes) ?? {};

  // Contadores agrupados nas 5 filas fixas (SEM TAMANHO fica de fora do total).
  const bucketed = (m: QueueMode): Record<Queue, number> => {
    const out: Record<Queue, number> = { P: 0, M: 0, G: 0, GG: 0, XG: 0 };
    for (const [k, v] of Object.entries(recordFor(m))) {
      const q = queueFor(k);
      if (q) out[q] += v;
    }
    return out;
  };
  const countFor = (q: Queue, m: QueueMode): number => bucketed(m)[q];
  const totalFor = (m: QueueMode): number =>
    Object.values(bucketed(m)).reduce((acc, n) => acc + n, 0);

  /** Tamanhos reais que caem no bucket (pro claim cobrir XXG/G1/G2/G3 etc.). */
  const sizesForQueue = (q: Queue, m: QueueMode): string[] => {
    const keys = Object.keys(recordFor(m))
      .map((k) => k.trim().toUpperCase())
      .filter((k) => queueFor(k) === q);
    return Array.from(new Set([q, ...keys]));
  };

  const effectiveSelected = selected as Queue | null;

  return (
    <div style={page}>
      <AmbientBackground />
      <header style={topBar}>
        <BackButton onClick={onBack} />
        <div style={titleWrap}>
          <span style={kicker}>― Separação ―</span>
          <h1 style={title}>Escolha a fila</h1>
        </div>
        <OperatorChip />
        <button style={mesaChip} onClick={() => void rfid.reconnect()} title={rfid.host}>
          <span
            style={{
              ...mesaDot,
              background: rfid.connected ? "var(--success-dot)" : "var(--danger-text)",
            }}
          />
          <span style={mesaText}>{rfid.connected ? "Mesa conectada" : "Mesa offline"}</span>
        </button>
      </header>

      {!rfid.connected && (
        <div style={mesaDownBanner}>
          Mesa RFID desconectada ({rfid.host}). Configure/ligue a mesa antes de começar.{" "}
          <button style={inlineReconnect} onClick={() => void rfid.reconnect()}>
            tentar agora
          </button>
        </div>
      )}

      {authError && <div style={mesaDownBanner}>{authError}</div>}

      <main style={main}>
        <p style={lead}>
          Você entra em <strong>uma fila por vez</strong>. Cada tamanho tem duas abas —{" "}
          <strong>Puro</strong> (grade única) e <strong>Mistos</strong> (grade mista) — o
          número é quantos pedidos estão prontos agora.
        </p>

        <div style={tabsRow}>
          <div style={modeTabs}>
            {(["puro", "mistos"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                style={mode === m ? modeTabOn : modeTab}
              >
                {m === "puro" ? "Puro" : "Mistos"}
                <span style={mode === m ? modeTabCountOn : modeTabCount}>{totalFor(m)}</span>
              </button>
            ))}
          </div>
          {counts !== null && (
            <span style={totalHint}>
              {totalFor("puro") + totalFor("mistos")} pedidos no total
            </span>
          )}
        </div>

        <div style={grid}>
          {QUEUES.map((q) => (
            <QueueTile
              key={q}
              label={q}
              count={countFor(q, mode)}
              selected={effectiveSelected === q}
              onClick={() => setSelected((p) => (p === q ? null : q))}
            />
          ))}
        </div>

        <button
          onClick={() =>
            effectiveSelected &&
            setConfirmed({
              size: effectiveSelected,
              mode,
              sizes: sizesForQueue(effectiveSelected, mode),
            })
          }
          disabled={!effectiveSelected}
          style={!effectiveSelected ? startBtnDisabled : startBtn}
        >
          Começar a separar
          {effectiveSelected
            ? ` — ${effectiveSelected} ${mode === "mistos" ? "Mistos" : "Puro"}`
            : ""}
        </button>
      </main>
    </div>
  );
}

function QueueTile({
  label,
  count,
  selected,
  onClick,
  wide,
}: {
  label: string;
  count: number;
  selected: boolean;
  onClick: () => void;
  wide?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="berzerk-module-card"
      style={{
        ...(selected ? tileOn : tile),
        ...(wide ? { gridColumn: "span 2" } : null),
      }}
    >
      <span style={{ ...tileLabel, ...(label.length > 4 ? { fontSize: 20 } : null) }}>
        {label}
      </span>
      <span style={count > 0 ? countBadge : countBadgeZero}>
        {count} {count === 1 ? "pedido" : "pedidos"}
      </span>
    </button>
  );
}

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

const kicker: CSSProperties = {
  fontSize: 10,
  letterSpacing: 3,
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontWeight: 700,
};

const title: CSSProperties = {
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
  gap: 28,
  padding: "48px 32px",
  maxWidth: 1100,
  width: "100%",
  margin: "0 auto",
  boxSizing: "border-box",
  alignItems: "center",
  justifyContent: "center",
};

const lead: CSSProperties = {
  margin: 0,
  fontSize: 14,
  color: "var(--text-secondary)",
  lineHeight: 1.5,
  textAlign: "center",
  maxWidth: 640,
};

/** 5 filas, SEMPRE numa linha só (pedido do Victor) — as colunas encolhem
    juntas em tela menor em vez de quebrar. */
const grid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(5, minmax(0, 210px))",
  gap: 18,
  width: "100%",
  justifyContent: "center",
};

/** Toggle centralizado; total logo abaixo, bem discreto (pedido do Victor/Leo —
    do lado ele brigava com o layout). */
const tabsRow: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 8,
};

const totalHint: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--text-faint)",
};

const modeTabs: CSSProperties = {
  display: "inline-flex",
  gap: 4,
  padding: 4,
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
};

const modeTab: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "10px 22px",
  background: "transparent",
  border: 0,
  borderRadius: 9,
  color: "var(--text-secondary)",
  fontSize: 14,
  fontWeight: 700,
  cursor: "pointer",
  transition: "background 140ms, color 140ms",
};

const modeTabOn: CSSProperties = {
  ...modeTab,
  background: "var(--bg-input)",
  color: "var(--text)",
  boxShadow: "inset 0 0 0 1px var(--border-strong)",
};

const modeTabCount: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  padding: "1px 8px",
  borderRadius: 999,
  background: "var(--bg-input)",
  color: "var(--text-muted)",
};

const modeTabCountOn: CSSProperties = {
  ...modeTabCount,
  background: "var(--info-bg)",
  color: "var(--info-text)",
};

/** Mesmo look dos cards da home (radius 16, hover com lift via
    .berzerk-module-card) — pedido do Victor: replicar o estilo aqui. */
const tile: CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 14,
  padding: "40px 0 34px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 16,
  color: "var(--text-secondary)",
  cursor: "pointer",
  transition: "background 160ms, border-color 160ms, transform 160ms",
  fontFamily: "inherit",
};

const tileOn: CSSProperties = {
  ...tile,
  background: "var(--info-bg)",
  color: "var(--info-text)",
  border: "1px solid var(--info-border)",
};

const tileLabel: CSSProperties = {
  fontFamily: "var(--font-display)",
  fontSize: 46,
  fontWeight: 400,
  letterSpacing: 1,
  lineHeight: 1,
  color: "var(--text)",
};

const countBadge: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  padding: "2px 10px",
  borderRadius: 999,
  background: "var(--success-bg)",
  color: "var(--success-text)",
  border: "1px solid var(--success-border)",
};

const countBadgeZero: CSSProperties = {
  ...countBadge,
  background: "var(--bg-elevated)",
  color: "var(--text-muted)",
  border: "1px solid var(--border)",
};

/** Ação principal: verde sólido de alto contraste (galpão tem monitor com brilho baixo). */
const startBtn: CSSProperties = {
  padding: "14px 28px",
  background: "var(--success-dot)",
  color: "#04150c",
  border: "1px solid var(--success-dot)",
  borderRadius: 10,
  cursor: "pointer",
  fontSize: 15,
  fontWeight: 800,
};

const startBtnDisabled: CSSProperties = {
  ...startBtn,
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  color: "var(--text-muted)",
  cursor: "not-allowed",
  fontWeight: 700,
};

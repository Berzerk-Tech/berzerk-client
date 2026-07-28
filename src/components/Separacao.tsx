import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { BackButton } from "./BackButton";
import { AmbientBackground } from "./AmbientBackground";
import { SeparacaoRunner } from "./SeparacaoRunner";
import { useRfid } from "../contexts/RfidContext";
import { ApiError } from "../lib/api";
import { subscribeQueueChanged } from "../lib/realtime";
import { claimNext, claimNextMixed, getQueueCounts, type QueueCounts } from "../services/orders";

type Props = { onBack: () => void };

/**
 * Ordem canônica de exibição das filas. Os tamanhos em si vêm da API (contadores
 * por tamanho): fila zerada some, tamanho novo (G3, etc.) aparece sozinho.
 * Tamanho fora desta lista vai pro fim, em ordem alfabética.
 */
const SIZE_ORDER = ["PP", "P", "M", "G", "GG", "XG", "XXG", "G1", "G2", "G3", "XGG"];

function sortSizes(sizes: string[]): string[] {
  const rank = (s: string) => {
    const i = SIZE_ORDER.indexOf(s);
    return i === -1 ? SIZE_ORDER.length : i;
  };
  return [...sizes].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Cada tamanho tem duas abas: Puro (grade normal) e Mistos (grade mista). */
type QueueMode = "puro" | "mistos";

/** Fila escolhida: um tamanho por vez, na aba ativa. */
type Selected = string | null;

export function Separacao({ onBack }: Props) {
  const rfid = useRfid();
  const [mode, setMode] = useState<QueueMode>("puro");
  const [selected, setSelected] = useState<Selected>(null);
  const [confirmed, setConfirmed] = useState<{ size: string; mode: QueueMode } | null>(null);
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

  const claim = useCallback(() => {
    if (!confirmed) return claimNext([""]);
    return confirmed.mode === "mistos"
      ? claimNextMixed([confirmed.size])
      : claimNext([confirmed.size]);
  }, [confirmed]);

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
  const countFor = (size: string, m: QueueMode): number => recordFor(m)[size] ?? 0;
  const totalFor = (m: QueueMode): number =>
    Object.values(recordFor(m)).reduce((acc, n) => acc + n, 0);

  // Filas visíveis = tamanhos com pedido AGORA na aba ativa (dinâmico, da API).
  const visibleSizes = sortSizes(
    Object.keys(recordFor(mode)).filter((s) => countFor(s, mode) > 0),
  );
  // Seleção só vale se a fila ainda existe (pode zerar entre um push e outro).
  const effectiveSelected = selected && visibleSizes.includes(selected) ? selected : null;

  return (
    <div style={page}>
      <AmbientBackground />
      <header style={topBar}>
        <BackButton onClick={onBack} />
        <div style={titleWrap}>
          <span style={kicker}>― Separação ―</span>
          <h1 style={title}>Escolha a fila</h1>
        </div>
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
            <span style={totalHint}>{totalFor("puro") + totalFor("mistos")} pedidos no total</span>
          )}
        </div>

        {counts === null ? (
          <p style={gridHint}>Carregando filas…</p>
        ) : visibleSizes.length === 0 ? (
          <p style={gridHint}>
            Nenhum pedido pronto na aba {mode === "mistos" ? "Mistos" : "Puro"} agora.
          </p>
        ) : (
          <div style={grid}>
            {visibleSizes.map((s) => (
              <QueueTile
                key={s}
                label={s}
                count={countFor(s, mode)}
                selected={effectiveSelected === s}
                onClick={() => setSelected((p) => (p === s ? null : s))}
              />
            ))}
          </div>
        )}

        <button
          onClick={() => effectiveSelected && setConfirmed({ size: effectiveSelected, mode })}
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
      style={{
        ...(selected ? tileOn : tile),
        ...(wide ? { gridColumn: "span 2" } : null),
      }}
    >
      <span style={{ ...tileLabel, ...(label.length > 4 ? { fontSize: 13 } : null) }}>
        {label}
      </span>
      <span style={count > 0 ? countBadge : countBadgeZero}>{count}</span>
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
  padding: "40px 32px",
  maxWidth: 1100,
  width: "100%",
  margin: "0 auto",
  boxSizing: "border-box",
  alignItems: "flex-start",
};

const lead: CSSProperties = {
  margin: 0,
  fontSize: 14,
  color: "var(--text-secondary)",
  lineHeight: 1.5,
};

const grid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
  gap: 10,
  width: "100%",
};

const gridHint: CSSProperties = {
  margin: 0,
  fontSize: 14,
  color: "var(--text-muted)",
  padding: "24px 0",
};

const tabsRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 16,
};

const totalHint: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  color: "var(--text-muted)",
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

const tile: CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  padding: "22px 0",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  color: "var(--text-secondary)",
  cursor: "pointer",
};

const tileOn: CSSProperties = {
  ...tile,
  background: "var(--info-bg)",
  color: "var(--info-text)",
  border: "1px solid var(--info-border)",
};

const tileLabel: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 22,
  fontWeight: 700,
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

const startBtn: CSSProperties = {
  padding: "14px 28px",
  background: "var(--success-bg)",
  color: "var(--success-text)",
  border: "1px solid var(--success-border)",
  borderRadius: 10,
  cursor: "pointer",
  fontSize: 15,
  fontWeight: 700,
};

const startBtnDisabled: CSSProperties = { ...startBtn, opacity: 0.5, cursor: "not-allowed" };

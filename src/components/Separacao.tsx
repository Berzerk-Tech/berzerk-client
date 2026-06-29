import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { BackButton } from "./BackButton";
import { AmbientBackground } from "./AmbientBackground";
import { SeparacaoRunner } from "./SeparacaoRunner";
import { useRfid } from "../contexts/RfidContext";
import { claimNext, claimNextMixed, getQueueCounts, type QueueCounts } from "../services/orders";

type Props = { onBack: () => void };

/** Tamanhos atendidos pela fila normal. */
const SIZES = ["PP", "P", "M", "G", "GG", "XG", "XXG"];
const MISTOS = "mistos";

/** Fila escolhida: um tamanho OU mistos (uma fila por vez). */
type Selected = string | null;

export function Separacao({ onBack }: Props) {
  const rfid = useRfid();
  const [selected, setSelected] = useState<Selected>(null);
  const [confirmed, setConfirmed] = useState<Selected>(null);
  const [counts, setCounts] = useState<QueueCounts | null>(null);

  // Contagem das filas, atualizada periodicamente.
  useEffect(() => {
    let alive = true;
    const load = () => {
      getQueueCounts()
        .then((c) => {
          if (alive) setCounts(c);
        })
        .catch(() => {
          /* API fora: mostra sem contador */
        });
    };
    load();
    const id = setInterval(load, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const claim = useCallback(
    () => (confirmed === MISTOS ? claimNextMixed() : claimNext([confirmed ?? ""])),
    [confirmed],
  );

  if (confirmed) {
    const isMixed = confirmed === MISTOS;
    return (
      <SeparacaoRunner
        title={isMixed ? "Separação — Mistos" : "Separação"}
        kicker={isMixed ? "Fila de mistos" : `Fila ${confirmed}`}
        emptyHint={
          isMixed
            ? "Nenhum pedido misto pronto no momento."
            : "Nenhum pedido pronto nessa fila. Tente outra ou aguarde a sincronização."
        }
        claim={claim}
        onBack={() => setConfirmed(null)}
      />
    );
  }

  const countFor = (q: string): number =>
    q === MISTOS ? counts?.mixed ?? 0 : counts?.sizes?.[q] ?? 0;

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

      <main style={main}>
        <p style={lead}>
          Você entra em <strong>uma fila por vez</strong>. Escolha um tamanho ou a
          fila de mistos — o número é quantos pedidos estão prontos agora.
        </p>

        <div style={grid}>
          {SIZES.map((s) => (
            <QueueTile
              key={s}
              label={s}
              count={countFor(s)}
              selected={selected === s}
              onClick={() => setSelected((p) => (p === s ? null : s))}
            />
          ))}
          <QueueTile
            label="Mistos"
            count={countFor(MISTOS)}
            selected={selected === MISTOS}
            onClick={() => setSelected((p) => (p === MISTOS ? null : MISTOS))}
          />
        </div>

        <button
          onClick={() => selected && setConfirmed(selected)}
          disabled={!selected}
          style={!selected ? startBtnDisabled : startBtn}
        >
          Começar a separar
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
      <span style={tileLabel}>{label}</span>
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
  gridTemplateColumns: "repeat(8, minmax(0, 1fr))",
  gap: 10,
  width: "100%",
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

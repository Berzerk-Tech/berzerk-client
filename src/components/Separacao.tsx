import { useCallback, useState, type CSSProperties } from "react";
import { BackButton } from "./BackButton";
import { AmbientBackground } from "./AmbientBackground";
import { SeparacaoRunner } from "./SeparacaoRunner";
import { claimNext } from "../services/orders";

type Props = { onBack: () => void };

/** Tamanhos atendidos pela fila normal. */
const SIZES = ["PP", "P", "M", "G", "GG", "XG", "XXG"];

export function Separacao({ onBack }: Props) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmedSizes, setConfirmedSizes] = useState<string[] | null>(null);

  // Estável: o runner usa isso em efeitos; função nova a cada render causaria
  // re-claim em loop.
  const claim = useCallback(
    () => claimNext(confirmedSizes ?? []),
    [confirmedSizes],
  );

  if (confirmedSizes) {
    return (
      <SeparacaoRunner
        title="Separação"
        kicker={`Fila ${confirmedSizes.join(" · ")}`}
        emptyHint="Nenhum pedido pronto pros tamanhos selecionados. Tente outro tamanho ou aguarde a sincronização."
        claim={claim}
        onBack={() => setConfirmedSizes(null)}
      />
    );
  }

  const toggle = (s: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  const start = () => {
    if (selected.size === 0) return;
    setConfirmedSizes(SIZES.filter((s) => selected.has(s)));
  };

  return (
    <div style={page}>
      <AmbientBackground />
      <header style={topBar}>
        <BackButton onClick={onBack} />
        <div style={titleWrap}>
          <span style={kicker}>― Separação ―</span>
          <h1 style={title}>Escolha os tamanhos</h1>
        </div>
      </header>

      <main style={main}>
        <p style={lead}>
          Selecione o(s) tamanho(s) que você vai separar. Você puxa os pedidos da
          fila desses tamanhos — nada fica pré-atribuído.
        </p>

        <div style={grid}>
          {SIZES.map((s) => {
            const on = selected.has(s);
            return (
              <button key={s} onClick={() => toggle(s)} style={on ? chipOn : chip}>
                {s}
              </button>
            );
          })}
        </div>

        <button onClick={start} disabled={selected.size === 0} style={selected.size === 0 ? startBtnDisabled : startBtn}>
          Começar a separar
        </button>
      </main>
    </div>
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

const titleWrap: CSSProperties = { display: "flex", flexDirection: "column", gap: 2 };

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
  maxWidth: 720,
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
  gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))",
  gap: 12,
  width: "100%",
};

const chip: CSSProperties = {
  padding: "20px 0",
  fontFamily: "var(--font-mono)",
  fontSize: 22,
  fontWeight: 700,
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  color: "var(--text-secondary)",
  cursor: "pointer",
};

const chipOn: CSSProperties = {
  ...chip,
  background: "var(--info-bg)",
  color: "var(--info-text)",
  border: "1px solid var(--info-border)",
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

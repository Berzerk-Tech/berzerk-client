import { useState, type CSSProperties } from "react";
import type { BalancoFilas } from "../services/orders";
import { diferencaComTiny, linhasDoBalanco, medidoHa, milhar } from "../lib/balancoTiny";

const CHAVE = "berzerk-balanco-tiny-aberto";

function lerAberto(): boolean {
  try {
    return localStorage.getItem(CHAVE) !== "0";
  } catch {
    return true;
  }
}

/** Bloco recolhível "Conta com o Tiny" abaixo do total do período, na tela de filas. */
export function BalancoTiny({ balanco, agora }: { balanco: BalancoFilas; agora?: number }) {
  const [aberto, setAberto] = useState(lerAberto);
  const alternar = () => {
    const novo = !aberto;
    setAberto(novo);
    try {
      localStorage.setItem(CHAVE, novo ? "1" : "0");
    } catch {
      /* sem storage: só não lembra */
    }
  };
  const linhas = linhasDoBalanco(balanco);
  const dif = balanco.tiny ? diferencaComTiny(balanco.abertos, balanco.tiny.total) : null;

  return (
    <div style={caixa} data-testid="balanco-tiny">
      <button style={titulo} onClick={alternar} aria-expanded={aberto}>
        {aberto ? "▾" : "▸"} Conta com o Tiny (todos os canais)
      </button>
      {aberto && (
        <div style={corpo}>
          {linhas.map((l) => (
            <div key={l.chave} style={linha}>
              <span>{l.rotulo}</span>
              <span style={num}>{milhar(l.valor)}</span>
            </div>
          ))}
          <div style={{ ...linha, ...total }}>
            <span>Abertos no Nexus</span>
            <span style={num}>{milhar(balanco.abertos)}</span>
          </div>
          {balanco.tiny && dif ? (
            <div style={linha}>
              <span>
                Faturados no Tiny <span style={fraco}>({medidoHa(balanco.tiny.medidoEm, agora)})</span>
              </span>
              <span>
                <span style={num}>{milhar(balanco.tiny.total)}</span>{" "}
                <span style={dif.alerta ? alerta : fraco}>{dif.texto}</span>
              </span>
            </div>
          ) : (
            <div style={{ ...linha, ...fraco }}>Tiny: sem medição agora</div>
          )}
          <span style={fraco}>O Tiny só tira o pedido de faturado quando ele é expedido.</span>
        </div>
      )}
    </div>
  );
}

const caixa: CSSProperties = {
  alignSelf: "center",
  minWidth: 320,
  maxWidth: 460,
  width: "100%",
  border: "1px solid var(--border, rgba(255,255,255,0.12))",
  borderRadius: 8,
  background: "var(--surface-2, transparent)",
  fontSize: 12,
};
const titulo: CSSProperties = {
  width: "100%",
  textAlign: "left",
  background: "transparent",
  border: "none",
  color: "var(--text)",
  fontSize: 12,
  fontWeight: 600,
  padding: "8px 12px",
  cursor: "pointer",
};
const corpo: CSSProperties = { display: "flex", flexDirection: "column", gap: 4, padding: "0 12px 10px" };
const linha: CSSProperties = { display: "flex", justifyContent: "space-between", gap: 12, color: "var(--text)" };
const total: CSSProperties = { fontWeight: 700, borderTop: "1px solid var(--border, rgba(255,255,255,0.12))", paddingTop: 4, marginTop: 2 };
const num: CSSProperties = { fontFamily: "var(--font-mono)" };
const fraco: CSSProperties = { color: "var(--text-faint)" };
const alerta: CSSProperties = { color: "var(--danger, #f59e0b)", fontWeight: 600 };

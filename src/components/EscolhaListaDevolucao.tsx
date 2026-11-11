import type { CSSProperties } from "react";
import { TODAS_AS_LISTAS, type ListaDoLote } from "../lib/listasDoLote";

type Props = {
  listas: ListaDoLote[];
  /** Total que "Todas" devolve (o lote inteiro). */
  total: number;
  valor: string;
  onChange: (valor: string) => void;
};

const plural = (n: number) => `${n} ${n === 1 ? "pedido" : "pedidos"}`;

/** Seletor "Lista 1 / Lista 2 / Todas" do diálogo de devolver lista impressa. */
export function EscolhaListaDevolucao({ listas, total, valor, onChange }: Props) {
  if (listas.length < 2) return null;
  return (
    <div style={caixa}>
      <span style={rotulo}>Qual lista devolver?</span>
      <div style={linha}>
        {listas.map((l) => (
          <button
            key={l.chave}
            type="button"
            style={valor === l.chave ? ativo : botao}
            onClick={() => onChange(l.chave)}
          >
            Lista {l.numero} <span style={qtd}>· {plural(l.ids.length)}</span>
          </button>
        ))}
        <button
          type="button"
          style={valor === TODAS_AS_LISTAS ? ativo : botao}
          onClick={() => onChange(TODAS_AS_LISTAS)}
        >
          Todas <span style={qtd}>· {plural(total)}</span>
        </button>
      </div>
    </div>
  );
}

const caixa: CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };
const rotulo: CSSProperties = { fontSize: 13, fontWeight: 600, opacity: 0.8 };
const linha: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8 };
const botao: CSSProperties = {
  padding: "10px 16px",
  borderRadius: 10,
  border: "1px solid var(--border, #45475a)",
  background: "transparent",
  color: "inherit",
  fontSize: 14,
  cursor: "pointer",
};
const ativo: CSSProperties = {
  ...botao,
  border: "1px solid var(--accent, #cba6f7)",
  background: "var(--accent-bg, rgba(203,166,247,0.15))",
  fontWeight: 700,
};
const qtd: CSSProperties = { opacity: 0.7, fontWeight: 400 };

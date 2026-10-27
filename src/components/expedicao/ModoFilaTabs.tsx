import type { CSSProperties } from "react";
import type { ModoFila } from "../../lib/unicosExpedicao";

const MODOS: ReadonlyArray<{ id: ModoFila; rotulo: string; dica: string }> = [
  { id: "pedidos", rotulo: "Pedidos", dica: "Fluxo de sempre: a peça na mesa identifica o pedido separado" },
  { id: "unicos", rotulo: "Únicos", dica: "Pedidos de uma peça, por estampa e tamanho: bipou a peça, o próximo pedido dela sai" },
];

/** Seletor "Pedidos | Únicos" ao lado das abas de canal (só no e-commerce). */
export function ModoFilaTabs({
  modo,
  onChange,
  unicosIndisponivel,
  unicosSoOficial,
}: {
  modo: ModoFila;
  onChange: (m: ModoFila) => void;
  unicosIndisponivel: boolean;
  /** Modo teste: o `separar` grava no servidor, então Únicos só no modo oficial. */
  unicosSoOficial?: boolean;
}) {
  return (
    <div style={tabs} role="tablist" aria-label="Modo da mesa">
      {MODOS.map((m) => {
        const bloqueado = m.id === "unicos" && (unicosIndisponivel || !!unicosSoOficial);
        return (
          <button
            key={m.id}
            type="button"
            role="tab"
            aria-selected={modo === m.id}
            disabled={bloqueado}
            style={{ ...(modo === m.id ? tabOn : tab), ...(bloqueado ? { opacity: 0.45, cursor: "not-allowed" } : {}) }}
            onClick={() => onChange(m.id)}
            title={
              bloqueado
                ? unicosSoOficial
                  ? "Únicos só no modo oficial"
                  : "Atualize a API: a fila de únicos ainda não existe no servidor"
                : m.dica
            }
          >
            {m.rotulo}
          </button>
        );
      })}
    </div>
  );
}

const tabs: CSSProperties = { display: "inline-flex", gap: 4, padding: 4, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 12 };
const tab: CSSProperties = { padding: "7px 16px", background: "transparent", border: 0, borderRadius: 9, color: "var(--text-secondary)", fontSize: 13, fontWeight: 700, cursor: "pointer", transition: "background 140ms, color 140ms" };
const tabOn: CSSProperties = { ...tab, background: "var(--bg-input)", color: "var(--text)", boxShadow: "inset 0 0 0 1px var(--border-strong)" };

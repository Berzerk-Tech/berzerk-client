// Diálogo curto pra a PRÓPRIA operadora soltar um pedido da lista impressa
// (falta peça), sem PIN de supervisor. A lista continua com os demais.
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { OBSERVACAO_MAX, montarBodySoltar } from "../lib/soltar-pedido";
import type { MotivoSoltar, ReleaseBody } from "../services/orders";

type Props = {
  numero: string | null;
  /** Resolve quando o servidor soltou; rejeita com o erro (mostrado aqui, exceto o que o pai tratar). */
  onConfirm: (body: ReleaseBody) => Promise<void>;
  onCancel: () => void;
};

export function SoltarPedidoDialog({ numero, onConfirm, onCancel }: Props) {
  const [motivo, setMotivo] = useState<MotivoSoltar>("falta_peca");
  const [obs, setObs] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const confirmar = async () => {
    if (enviando) return;
    setEnviando(true);
    setErro(null);
    try {
      await onConfirm(montarBodySoltar(motivo, obs));
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
      setEnviando(false);
    }
  };

  return (
    <div style={overlay} onMouseDown={(e) => e.target === e.currentTarget && !enviando && onCancel()}>
      <div role="dialog" aria-modal="true" aria-label="Soltar pedido da lista" style={sheet}>
        <h2 style={title}>Soltar pedido{numero ? ` ${numero}` : ""} da lista</h2>
        <p style={msg}>O pedido volta pra fila e sai da sua lista. Os outros da lista continuam com você.</p>
        <label style={radio}>
          <input type="radio" name="motivo-soltar" checked={motivo === "falta_peca"} onChange={() => setMotivo("falta_peca")} />
          Falta peça
        </label>
        <label style={radio}>
          <input type="radio" name="motivo-soltar" checked={motivo === "outro"} onChange={() => setMotivo("outro")} />
          Outro
        </label>
        <textarea
          style={area}
          placeholder="Observação (opcional)"
          maxLength={OBSERVACAO_MAX}
          value={obs}
          onChange={(e) => setObs(e.target.value)}
          rows={2}
        />
        {erro && <div style={erroBox}>{erro}</div>}
        <div style={row}>
          <button type="button" style={ghost} onClick={onCancel} disabled={enviando}>
            Cancelar
          </button>
          <button type="button" style={primary} onClick={() => void confirmar()} disabled={enviando}>
            {enviando ? "Soltando…" : "Soltar pedido"}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlay: CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex",
  alignItems: "center", justifyContent: "center", zIndex: 200, padding: 24,
};
const sheet: CSSProperties = {
  width: "min(440px, 100%)", background: "var(--bg-elevated)", border: "1px solid var(--border-strong)",
  borderRadius: 16, padding: "22px 24px", display: "flex", flexDirection: "column", gap: 12,
  boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
};
const title: CSSProperties = { margin: 0, fontSize: 20, fontWeight: 700 };
const msg: CSSProperties = { margin: 0, fontSize: 14, color: "var(--text-secondary)", lineHeight: 1.45 };
const radio: CSSProperties = { display: "flex", gap: 8, alignItems: "center", fontSize: 15 };
const area: CSSProperties = {
  resize: "none", padding: 10, borderRadius: 8, border: "1px solid var(--border)",
  background: "var(--bg-card)", color: "inherit", font: "inherit",
};
const erroBox: CSSProperties = { color: "var(--danger-text, #f87171)", fontSize: 13 };
const row: CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 4 };
const ghost: CSSProperties = {
  padding: "10px 16px", borderRadius: 10, border: "1px solid var(--border)", background: "transparent",
  color: "inherit", cursor: "pointer", font: "inherit",
};
const primary: CSSProperties = {
  padding: "10px 16px", borderRadius: 10, border: "1px solid var(--warning-border)",
  background: "var(--warning-bg)", color: "var(--warning-text)", cursor: "pointer", font: "inherit", fontWeight: 600,
};

// Confirmação in-app. Substitui `window.confirm`, que no WebView2 do Tauri v2
// retorna `false` SEM mostrar nada — a tecla K e o botão "Concluir com
// faltantes" caíam nesse buraco e "não acontecia nada" (01/09).
//
// Teclado, como o resto da mesa: Enter confirma, Esc cancela. O foco vai pro
// próprio diálogo (não pro botão) — se o botão tivesse foco, o Enter viraria
// clique E atalho, disparando a conclusão duas vezes.
import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";

export type ConfirmDialogProps = {
  titulo: string;
  mensagem?: ReactNode;
  /** Linhas de detalhe (ex.: as peças que faltam), listadas dentro do diálogo. */
  detalhes?: { label: string; meta?: string | null; valor?: string }[];
  confirmarLabel?: string;
  cancelarLabel?: string;
  /** `warning` = ação com consequência (concluir faltando peça): faixa e botão âmbar. */
  tom?: "neutro" | "warning";
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  titulo,
  mensagem,
  detalhes,
  confirmarLabel = "Confirmar",
  cancelarLabel = "Cancelar",
  tom = "neutro",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const confirmRef = useRef(onConfirm);
  const cancelRef = useRef(onCancel);
  confirmRef.current = onConfirm;
  cancelRef.current = onCancel;

  useEffect(() => {
    sheetRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelRef.current();
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        confirmRef.current();
      }
    };
    // capture: chega antes dos atalhos globais da mesa (R, K, P…).
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const warning = tom === "warning";
  return (
    <div style={overlay} onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-titulo"
        tabIndex={-1}
        style={{ ...sheet, ...(warning ? sheetWarning : null) }}
      >
        <div style={head}>
          <span style={warning ? iconWarning : iconNeutro} aria-hidden="true">
            {warning ? "!" : "?"}
          </span>
          <div style={headText}>
            <h2 id="confirm-dialog-titulo" style={title}>
              {titulo}
            </h2>
            {mensagem && <p style={msg}>{mensagem}</p>}
          </div>
        </div>

        {detalhes && detalhes.length > 0 && (
          <ul style={lista}>
            {detalhes.map((d, i) => (
              <li key={i} style={linha}>
                <span style={linhaLabel}>{d.label}</span>
                {d.meta && <span style={linhaMeta}>{d.meta}</span>}
                {d.valor && <span style={warning ? linhaValorWarning : linhaValor}>{d.valor}</span>}
              </li>
            ))}
          </ul>
        )}

        <div style={row}>
          <button type="button" style={btnGhost} onClick={onCancel}>
            {cancelarLabel}
            <kbd style={kbd}>Esc</kbd>
          </button>
          <button
            type="button"
            style={warning ? btnWarning : btnPrimary}
            onClick={onConfirm}
          >
            {confirmarLabel}
            <kbd style={warning ? kbdOnWarning : kbdOnPrimary}>Enter</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}

const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.6)",
  backdropFilter: "blur(2px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 200,
  padding: 24,
};

const sheet: CSSProperties = {
  width: "min(480px, 100%)",
  background: "var(--bg-elevated)",
  border: "1px solid var(--border-strong)",
  borderRadius: 16,
  padding: "22px 24px",
  display: "flex",
  flexDirection: "column",
  gap: 16,
  boxShadow: "0 24px 60px rgba(0,0,0,0.45)",
  outline: "none",
};

const sheetWarning: CSSProperties = {
  borderColor: "var(--warning-border)",
  boxShadow: "0 0 0 1px var(--warning-border), 0 24px 60px rgba(0,0,0,0.45)",
};

const head: CSSProperties = { display: "flex", gap: 14, alignItems: "flex-start" };

const iconBase: CSSProperties = {
  flexShrink: 0,
  width: 40,
  height: 40,
  borderRadius: 12,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontFamily: "var(--font-display)",
  fontSize: 22,
  lineHeight: 1,
};
const iconNeutro: CSSProperties = {
  ...iconBase,
  background: "var(--info-bg)",
  color: "var(--info-text)",
  border: "1px solid var(--info-border)",
};
const iconWarning: CSSProperties = {
  ...iconBase,
  background: "var(--warning-bg)",
  color: "var(--warning-text)",
  border: "1px solid var(--warning-border)",
};

const headText: CSSProperties = { display: "flex", flexDirection: "column", gap: 6, minWidth: 0 };
const title: CSSProperties = { margin: 0, fontSize: 20, fontWeight: 700, lineHeight: 1.2 };
const msg: CSSProperties = { margin: 0, fontSize: 15, color: "var(--text-secondary)", lineHeight: 1.45 };

const lista: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  display: "flex",
  flexDirection: "column",
  border: "1px solid var(--border)",
  borderRadius: 10,
  background: "var(--bg-card)",
  overflow: "hidden",
  maxHeight: 220,
  overflowY: "auto",
};
const linha: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 14px",
  borderTop: "1px solid var(--border)",
  fontSize: 14,
};
const linhaLabel: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const linhaMeta: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  fontWeight: 700,
  padding: "2px 8px",
  borderRadius: 6,
  background: "var(--bg-input)",
  color: "var(--text-secondary)",
};
const linhaValor: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  fontWeight: 700,
  minWidth: 64,
  textAlign: "right",
};
const linhaValorWarning: CSSProperties = { ...linhaValor, color: "var(--warning-text)" };

const row: CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 10 };

const btnBase: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 10,
  padding: "12px 18px",
  borderRadius: 10,
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "inherit",
};
const btnGhost: CSSProperties = {
  ...btnBase,
  background: "transparent",
  color: "var(--text)",
  border: "1px solid var(--border-strong)",
};
const btnPrimary: CSSProperties = {
  ...btnBase,
  background: "var(--accent)",
  color: "var(--accent-text)",
  border: "1px solid transparent",
  fontWeight: 700,
};
const btnWarning: CSSProperties = {
  ...btnBase,
  background: "var(--warning-dot)",
  color: "#1a1206",
  border: "1px solid transparent",
  fontWeight: 700,
};

const kbd: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  fontWeight: 700,
  padding: "2px 6px",
  borderRadius: 5,
  background: "var(--bg-input)",
  color: "var(--text-muted)",
  border: "1px solid var(--border)",
  lineHeight: 1.2,
};
const kbdOnPrimary: CSSProperties = {
  ...kbd,
  background: "rgba(0,0,0,0.12)",
  color: "var(--accent-text)",
  border: "1px solid rgba(0,0,0,0.18)",
  opacity: 0.85,
};
const kbdOnWarning: CSSProperties = {
  ...kbdOnPrimary,
  color: "#1a1206",
};

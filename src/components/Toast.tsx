import { useEffect, type CSSProperties } from "react";

type Props = {
  message: string;
  onDismiss: () => void;
  /** ms até sumir sozinho — default 4s. */
  durationMs?: number;
};

/** Toast simples no canto, auto-dismiss. Usado hoje só pelo handoff de login do Nexus. */
export function Toast({ message, onDismiss, durationMs = 4000 }: Props) {
  useEffect(() => {
    const t = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(t);
  }, [onDismiss, durationMs]);

  return (
    <div style={wrap} role="status">
      <span style={dot} />
      <span style={text}>{message}</span>
      <button type="button" onClick={onDismiss} style={closeBtn} aria-label="Fechar">
        ×
      </button>
    </div>
  );
}

const wrap: CSSProperties = {
  position: "fixed",
  top: 16,
  right: 16,
  zIndex: 300,
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 12px 10px 14px",
  background: "var(--success-bg)",
  color: "var(--success-text)",
  border: "1px solid var(--success-border)",
  borderRadius: 10,
  fontSize: 13,
  fontWeight: 500,
  boxShadow: "0 8px 24px -8px rgba(0, 0, 0, 0.35)",
  animation: "berzerk-toast-in 200ms ease-out",
};

const dot: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: "50%",
  background: "var(--success-dot)",
  flexShrink: 0,
};

const text: CSSProperties = { lineHeight: 1.4 };

const closeBtn: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "inherit",
  opacity: 0.7,
  fontSize: 16,
  lineHeight: 1,
  cursor: "pointer",
  padding: "0 2px",
};

if (typeof document !== "undefined" && !document.getElementById("berzerk-toast-keyframes")) {
  const style = document.createElement("style");
  style.id = "berzerk-toast-keyframes";
  style.textContent = `
    @keyframes berzerk-toast-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
  `;
  document.head.appendChild(style);
}

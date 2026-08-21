import { useEffect, useState, type CSSProperties } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { signInWithGoogle } from "../lib/auth";
import { takeLogoutReason } from "../lib/idleSession";
import { BerzerkLogo } from "./BerzerkLogo";
import { AmbientBackground } from "./AmbientBackground";

export function Login() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState<string>("");
  // Motivo do último logout forçado (consumido na leitura — some no próximo login).
  const [reason] = useState(() => takeLogoutReason());

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion(""));
  }, []);

  async function handleClick() {
    setError(null);
    setBusy(true);
    const { error } = await signInWithGoogle();
    if (error) {
      setError(error.message);
      setBusy(false);
      return;
    }
    setTimeout(() => setBusy(false), 60000);
  }

  function handleCancel() {
    setBusy(false);
    setError(null);
  }

  return (
    <div style={page}>
      <AmbientBackground />

      <main style={panel}>
        <header style={brandStack}>
          <BerzerkLogo style={logoStyle} />
          <h1 style={wordmark}>BERZERK</h1>
        </header>

        <section style={authSection}>
          <p style={kicker}>Acesso restrito</p>
          <p style={cardSub}>
            Apenas contas <code style={domainTag}>@berzerk.com.br</code>
          </p>

          {reason && (
            <div style={infoBox}>
              {reason.kind === "idle"
                ? `Sessão encerrada por inatividade (${reason.minutes} min sem uso). Entre com a SUA conta pra continuar.`
                : `Sessão encerrada pelo servidor: ${reason.message}. Entre de novo pra continuar.`}
            </div>
          )}
          {error && <div style={errorBox}>{error}</div>}

          {!busy ? (
            <button
              type="button"
              onClick={handleClick}
              style={primaryBtn}
              className="berzerk-login-btn"
            >
              <GoogleG />
              <span>Entrar com Google</span>
            </button>
          ) : (
            <div style={busyStack}>
              <div style={spinnerWrap}>
                <Spinner />
                <span style={spinnerText}>Abrindo o navegador…</span>
              </div>
              <p style={busyNote}>
                Continue o login no navegador.<br />
                Esta janela voltará automaticamente.
              </p>
              <button type="button" onClick={handleCancel} style={cancelBtn}>
                Cancelar
              </button>
            </div>
          )}
        </section>
      </main>

      <footer style={footer}>
        <span style={footerTag}>v{version || "…"}</span>
        <span style={footerSep}>·</span>
        <span style={footerTag}>Berzerk Tech</span>
      </footer>
    </div>
  );
}

function Spinner() {
  return (
    <svg width={18} height={18} viewBox="0 0 20 20" style={{ animation: "berzerk-spin 0.9s linear infinite" }}>
      <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2" />
      <path d="M10 2 a8 8 0 0 1 8 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function GoogleG() {
  return (
    <svg width={18} height={18} viewBox="0 0 18 18" aria-hidden="true" style={{ flexShrink: 0 }}>
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.83.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58C13.46.9 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}

if (typeof document !== "undefined" && !document.getElementById("berzerk-login-keyframes")) {
  const style = document.createElement("style");
  style.id = "berzerk-login-keyframes";
  style.textContent = `
    @keyframes berzerk-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    @keyframes berzerk-fade-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    .berzerk-login-btn:hover { background: var(--bg-card-hover) !important; border-color: var(--border-strong) !important; }
    .berzerk-login-btn:active { transform: translateY(1px); }
  `;
  document.head.appendChild(style);
}

const page: CSSProperties = {
  minHeight: "100vh",
  background: "var(--bg)",
  color: "var(--text)",
  display: "grid",
  placeItems: "center",
  position: "relative",
  overflow: "hidden",
  padding: "32px",
};

const panel: CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 48,
  animation: "berzerk-fade-in 480ms ease-out",
  padding: "0 16px",
};

const brandStack: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 6,
};

const logoStyle: CSSProperties = {
  width: 52,
  height: 56,
  color: "var(--text)",
  marginBottom: 8,
};

const wordmark: CSSProperties = {
  fontFamily: "var(--font-display)",
  fontSize: 76,
  margin: 0,
  letterSpacing: 2,
  lineHeight: 1,
  color: "var(--text)",
};

const authSection: CSSProperties = {
  width: 360,
  maxWidth: "100%",
  textAlign: "center",
  display: "flex",
  flexDirection: "column",
  gap: 0,
};

const kicker: CSSProperties = {
  margin: 0,
  fontSize: 10,
  letterSpacing: 2,
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontWeight: 700,
};

const cardSub: CSSProperties = {
  margin: 0,
  marginTop: 8,
  marginBottom: 24,
  fontSize: 14,
  color: "var(--text-secondary)",
};

const domainTag: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  background: "var(--bg-input)",
  padding: "2px 7px",
  borderRadius: 4,
  color: "var(--text)",
  border: "1px solid var(--border)",
};

const primaryBtn: CSSProperties = {
  width: "100%",
  padding: "14px 20px",
  fontSize: 14,
  fontWeight: 600,
  border: "1px solid var(--border-strong)",
  borderRadius: 12,
  background: "var(--bg-card)",
  color: "var(--text)",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 12,
  transition: "background 120ms, border-color 120ms, transform 80ms",
  boxShadow: "0 1px 0 rgba(255, 255, 255, 0.04) inset, 0 4px 16px -8px rgba(0, 0, 0, 0.25)",
};

const busyStack: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "stretch",
  gap: 16,
  animation: "berzerk-fade-in 200ms ease-out",
};

const spinnerWrap: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  padding: "10px",
  color: "var(--text-secondary)",
};

const spinnerText: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
};

const busyNote: CSSProperties = {
  margin: 0,
  fontSize: 12,
  textAlign: "center",
  color: "var(--text-muted)",
  lineHeight: 1.6,
};

const cancelBtn: CSSProperties = {
  padding: "10px",
  fontSize: 12,
  fontWeight: 500,
  background: "transparent",
  color: "var(--text-secondary)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  cursor: "pointer",
};

const infoBox: CSSProperties = {
  background: "var(--warning-bg)",
  color: "var(--warning-text)",
  border: "1px solid var(--warning-border)",
  padding: "10px 14px",
  borderRadius: 10,
  fontSize: 12,
  marginBottom: 14,
  lineHeight: 1.5,
  textAlign: "left",
};

const errorBox: CSSProperties = {
  background: "var(--danger-bg)",
  color: "var(--danger-text)",
  border: "1px solid var(--danger-border)",
  padding: "10px 14px",
  borderRadius: 10,
  fontSize: 12,
  marginBottom: 14,
  lineHeight: 1.5,
  textAlign: "left",
};

const footer: CSSProperties = {
  position: "absolute",
  bottom: 24,
  display: "flex",
  alignItems: "center",
  gap: 10,
  fontSize: 11,
  color: "var(--text-faint)",
  fontFamily: "var(--font-mono)",
  letterSpacing: 1,
};

const footerTag: CSSProperties = {};
const footerSep: CSSProperties = { opacity: 0.5 };

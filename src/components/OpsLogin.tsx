import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { BackButton } from "./BackButton";
import { AmbientBackground } from "./AmbientBackground";
import {
  CognitoError,
  LockedOutError,
  lockoutSecondsLeft,
  signInOps,
} from "../lib/cognito";

type Props = {
  onAuthenticated: () => void;
  onBack: () => void;
};

/** Login do operador de Separação no pool ops (username + senha). */
export function OpsLogin({ onAuthenticated, onBack }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lockLeft, setLockLeft] = useState(lockoutSecondsLeft());
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Conta regressiva do lockout.
  useEffect(() => {
    if (lockLeft <= 0) return;
    timerRef.current = setInterval(() => {
      const left = lockoutSecondsLeft();
      setLockLeft(left);
      if (left <= 0 && timerRef.current) clearInterval(timerRef.current);
    }, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [lockLeft]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy || lockLeft > 0) return;
    setError(null);
    setBusy(true);
    try {
      await signInOps(username.trim(), password);
      onAuthenticated();
    } catch (err) {
      if (err instanceof LockedOutError) {
        setLockLeft(err.secondsLeft);
        setError(null);
      } else if (err instanceof CognitoError) {
        const left = lockoutSecondsLeft();
        if (left > 0) setLockLeft(left);
        setError(
          err.code === "NotAuthorizedException" || err.code === "UserNotFoundException"
            ? "Usuário ou senha inválidos."
            : err.message,
        );
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  const locked = lockLeft > 0;

  return (
    <div style={page}>
      <AmbientBackground />
      <header style={topBar}>
        <BackButton onClick={onBack} />
        <div style={titleWrap}>
          <span style={kicker}>― Separação ―</span>
          <h1 style={title}>Entrar</h1>
        </div>
      </header>

      <main style={main}>
        <form onSubmit={onSubmit} style={card}>
          <p style={lead}>Identifique-se pra começar a separar.</p>

          <label style={field}>
            <span style={label}>Usuário</span>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={busy || locked}
              style={input}
            />
          </label>

          <label style={field}>
            <span style={label}>Senha</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy || locked}
              style={input}
            />
          </label>

          {error && <div style={errorBox}>{error}</div>}
          {locked && (
            <div style={lockBox}>
              Muitas tentativas. Tente novamente em <strong>{lockLeft}s</strong>.
            </div>
          )}

          <button
            type="submit"
            disabled={busy || locked || !username.trim() || !password}
            style={busy || locked || !username.trim() || !password ? btnDisabled : btn}
          >
            {busy ? "Entrando…" : "Entrar"}
          </button>
        </form>
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
  display: "grid",
  placeItems: "center",
  padding: 32,
};

const card: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  width: "100%",
  maxWidth: 360,
  padding: 28,
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 16,
};

const lead: CSSProperties = { margin: 0, fontSize: 14, color: "var(--text-secondary)" };

const field: CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };

const label: CSSProperties = {
  fontSize: 10,
  letterSpacing: 1.5,
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontWeight: 700,
};

const input: CSSProperties = {
  padding: "12px 14px",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  color: "var(--text)",
  fontSize: 15,
};

const errorBox: CSSProperties = {
  padding: "10px 14px",
  background: "var(--warning-bg)",
  border: "1px solid var(--warning-border)",
  borderRadius: 10,
  color: "var(--warning-text)",
  fontSize: 13,
};

const lockBox: CSSProperties = {
  padding: "10px 14px",
  background: "var(--danger-bg, var(--warning-bg))",
  border: "1px solid var(--danger-border, var(--warning-border))",
  borderRadius: 10,
  color: "var(--danger-text, var(--warning-text))",
  fontSize: 13,
};

const btn: CSSProperties = {
  padding: "13px 20px",
  background: "var(--success-bg)",
  color: "var(--success-text)",
  border: "1px solid var(--success-border)",
  borderRadius: 10,
  cursor: "pointer",
  fontSize: 15,
  fontWeight: 700,
};

const btnDisabled: CSSProperties = { ...btn, opacity: 0.5, cursor: "not-allowed" };

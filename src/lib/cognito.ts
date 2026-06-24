// Login dos operadores de Separação no pool Cognito `berzerk-ops` (username +
// senha, USER_PASSWORD_AUTH inline — sem Hosted UI, sem SDK). É o pool dedicado
// pra chão de fábrica (contas criadas por admin, sem email corporativo).
//
// Lockout: 5 falhas → 60s travado (igual à descrição do pós-venda).

const REGION = import.meta.env.VITE_COGNITO_REGION ?? "us-east-1";
const CLIENT_ID = import.meta.env.VITE_COGNITO_OPS_CLIENT_ID ?? "";

const STORE_KEY = "berzerk_ops_session_v1";
const LOCK_KEY = "berzerk_ops_lock_v1";
const MAX_FAILURES = 5;
const LOCK_MS = 60_000;
/** Renova o token quando faltam menos de 60s pra expirar. */
const REFRESH_SKEW_MS = 60_000;

export type OpsSession = {
  username: string;
  accessToken: string;
  idToken: string;
  refreshToken: string;
  /** epoch ms */
  expiresAt: number;
};

type LockState = { fails: number; until: number };

export function isCognitoConfigured(): boolean {
  return CLIENT_ID.length > 0;
}

function endpoint(): string {
  return `https://cognito-idp.${REGION}.amazonaws.com/`;
}

async function cognitoCall<T>(target: string, body: unknown): Promise<T> {
  const res = await fetch(endpoint(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-amz-json-1.1",
      "X-Amz-Target": `AWSCognitoIdentityProviderService.${target}`,
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const type = String(data.__type ?? "").split("#").pop() ?? "CognitoError";
    const message = String(data.message ?? type);
    throw new CognitoError(type, message);
  }
  return data as T;
}

export class CognitoError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CognitoError";
  }
}

export class LockedOutError extends Error {
  constructor(readonly secondsLeft: number) {
    super(`Bloqueado por ${secondsLeft}s após várias tentativas.`);
    this.name = "LockedOutError";
  }
}

// ── lockout ────────────────────────────────────────────────────────────────

function getLock(): LockState {
  try {
    const raw = localStorage.getItem(LOCK_KEY);
    if (!raw) return { fails: 0, until: 0 };
    return JSON.parse(raw) as LockState;
  } catch {
    return { fails: 0, until: 0 };
  }
}

function setLock(state: LockState): void {
  try {
    localStorage.setItem(LOCK_KEY, JSON.stringify(state));
  } catch {
    /* ignore */
  }
}

/** Segundos restantes de bloqueio (0 = liberado). */
export function lockoutSecondsLeft(): number {
  const { until } = getLock();
  const ms = until - Date.now();
  return ms > 0 ? Math.ceil(ms / 1000) : 0;
}

function registerFailure(): void {
  const lock = getLock();
  const fails = lock.fails + 1;
  if (fails >= MAX_FAILURES) {
    setLock({ fails: 0, until: Date.now() + LOCK_MS });
  } else {
    setLock({ fails, until: 0 });
  }
}

function clearFailures(): void {
  setLock({ fails: 0, until: 0 });
}

// ── token store ──────────────────────────────────────────────────────────

function storeSession(s: OpsSession): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(s));
}

export function getOpsSession(): OpsSession | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as OpsSession) : null;
  } catch {
    return null;
  }
}

export function signOutOps(): void {
  localStorage.removeItem(STORE_KEY);
}

// ── auth ─────────────────────────────────────────────────────────────────

type AuthResultResponse = {
  AuthenticationResult?: {
    AccessToken: string;
    IdToken: string;
    RefreshToken?: string;
    ExpiresIn: number;
  };
};

/** Login username+senha. Respeita lockout (5 falhas → 60s). */
export async function signInOps(username: string, password: string): Promise<OpsSession> {
  const left = lockoutSecondsLeft();
  if (left > 0) throw new LockedOutError(left);

  try {
    const res = await cognitoCall<AuthResultResponse>("InitiateAuth", {
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: CLIENT_ID,
      AuthParameters: { USERNAME: username, PASSWORD: password },
    });
    const r = res.AuthenticationResult;
    if (!r) throw new CognitoError("NoResult", "Cognito não retornou tokens (desafio pendente?).");
    const session: OpsSession = {
      username,
      accessToken: r.AccessToken,
      idToken: r.IdToken,
      refreshToken: r.RefreshToken ?? "",
      expiresAt: Date.now() + r.ExpiresIn * 1000,
    };
    storeSession(session);
    clearFailures();
    return session;
  } catch (e) {
    if (e instanceof CognitoError) registerFailure();
    throw e;
  }
}

async function refreshOps(session: OpsSession): Promise<OpsSession | null> {
  if (!session.refreshToken) return null;
  try {
    const res = await cognitoCall<AuthResultResponse>("InitiateAuth", {
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: CLIENT_ID,
      AuthParameters: { REFRESH_TOKEN: session.refreshToken },
    });
    const r = res.AuthenticationResult;
    if (!r) return null;
    const next: OpsSession = {
      ...session,
      accessToken: r.AccessToken,
      idToken: r.IdToken,
      // refresh token não volta no refresh — mantém o atual
      expiresAt: Date.now() + r.ExpiresIn * 1000,
    };
    storeSession(next);
    return next;
  } catch {
    signOutOps();
    return null;
  }
}

/** Access token válido pra Authorization (renova se perto de expirar). null se deslogado. */
export async function getValidAccessToken(): Promise<string | null> {
  let session = getOpsSession();
  if (!session) return null;
  if (session.expiresAt - Date.now() < REFRESH_SKEW_MS) {
    session = await refreshOps(session);
    if (!session) return null;
  }
  return session.accessToken;
}

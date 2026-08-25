// Cliente HTTP da separacao-api (nexus). Base URL configurável + bearer token.
//
// AUTENTICAÇÃO: a sessão do NEXUS (Cognito, pool staff) — quem logou é quem
// separa. O Bearer é o `id_token` (o access token do Cognito não carrega
// `email`, e a API usa o e-mail pra casar `usuarios`/papéis). O nexus valida o
// token nativamente e resolve as permissões pelo RBAC dele; o app só reflete o
// que a API responder.

import { getIdToken } from "./cognito";
import { forceLogout } from "./idleSession";

const DEFAULT_BASE = "http://localhost:3010";

export function apiBaseUrl(): string {
  return (import.meta.env.VITE_SEPARACAO_API_URL ?? DEFAULT_BASE).replace(/\/$/, "");
}

async function getAuthToken(): Promise<string | null> {
  try {
    return await getIdToken();
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type RequestOpts = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | undefined>;
  signal?: AbortSignal;
};

export async function apiRequest<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const url = new URL(apiBaseUrl() + path);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v != null) url.searchParams.set(k, v);
    }
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  const token = await getAuthToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(url.toString(), {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });

  const text = await res.text();
  const data = text ? safeJson(text) : null;
  // 204 (o log de ações da etiquetagem) volta sem corpo — `data` fica null e o
  // caller que tipou `void` não vê diferença.
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    if (data && typeof data === "object" && "message" in data) {
      msg = String((data as { message: unknown }).message);
    }
    // Backstop do nexus: sessão encerrada do lado de lá (inatividade/admin).
    // SÓ com código explícito — um 401 avulso (refresh do token em voo,
    // introspecção GoTrue falhando) não pode derrubar a operadora.
    if (res.status === 401 && isSessionExpired(data)) {
      void forceLogout({ kind: "server", message: msg });
    }
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}

function isSessionExpired(body: unknown): boolean {
  return (
    !!body &&
    typeof body === "object" &&
    "error" in body &&
    (body as { error: unknown }).error === "SESSION_EXPIRED"
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

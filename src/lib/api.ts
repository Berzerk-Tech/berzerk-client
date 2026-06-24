// Cliente HTTP da separacao-api (nexus). Base URL configurável + bearer token.
//
// AUTENTICAÇÃO (transição): hoje usamos o access token do Supabase como bearer.
// Quando o Cognito entrar (Fase 2), basta trocar `getAuthToken()` pra ler o
// token store do Cognito — o resto do app não muda.

import { supabase } from "./supabase";
import { getValidAccessToken, isCognitoConfigured } from "./cognito";

const DEFAULT_BASE = "http://localhost:3010";

export function apiBaseUrl(): string {
  return (import.meta.env.VITE_SEPARACAO_API_URL ?? DEFAULT_BASE).replace(/\/$/, "");
}

/**
 * Token pro header Authorization. Preferência: sessão do pool ops (Cognito) —
 * é o login da operadora de Separação. Fallback: sessão Supabase (transição,
 * pros módulos que ainda não migraram).
 */
async function getAuthToken(): Promise<string | null> {
  if (isCognitoConfigured()) {
    const opsToken = await getValidAccessToken();
    if (opsToken) return opsToken;
  }
  try {
    const { data } = await supabase.auth.getSession();
    return data.session?.access_token ?? null;
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
  method?: "GET" | "POST";
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
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    if (data && typeof data === "object" && "message" in data) {
      msg = String((data as { message: unknown }).message);
    }
    throw new ApiError(res.status, msg, data);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// Cliente HTTP da separacao-api (nexus). Base URL configurável + bearer token.
//
// AUTENTICAÇÃO: a mesma sessão Google (Supabase) do app — quem logou é quem
// separa. O nexus valida esse token (bridge HS256) e resolve as permissões
// pelo RBAC dele (papéis por email); o app só reflete o que a API responder.

import { supabase } from "./supabase";

const DEFAULT_BASE = "http://localhost:3010";

export function apiBaseUrl(): string {
  return (import.meta.env.VITE_SEPARACAO_API_URL ?? DEFAULT_BASE).replace(/\/$/, "");
}

async function getAuthToken(): Promise<string | null> {
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

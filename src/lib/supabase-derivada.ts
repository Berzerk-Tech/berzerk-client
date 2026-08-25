// Sessão Supabase DERIVADA da sessão do Nexus — sem segundo login.
//
// Depois do corte (fase 1 do `docs/plano-corte-supabase.md` do nexus), quem
// autentica é o Cognito. Mas a Etiquetagem e o Rastreio ainda falam direto com
// o Supabase (`silk_records`, `rfid_print_jobs`, `rfid_epc_inventory`, …) até a
// fase 3, e essas tabelas têm RLS: precisam de uma sessão GoTrue de verdade.
//
// Então o app pede uma ao Nexus: `POST /desktop/handoff` (Bearer Cognito)
// devolve `berzerk://auth?token_hash=…&type=magiclink`; extraímos o
// `token_hash` e fazemos `verifyOtp` em silêncio. A operadora não vê nada.
//
// Se falhar (503 sem config, 403 sem permissão, rede), o app SEGUE LOGADO no
// Nexus: Separação e Expedição funcionam normalmente e só a Etiquetagem/
// Rastreio avisam que estão indisponíveis. Nada de derrubar a sessão por causa
// de um subsistema legado.

import { supabase } from "./supabase";
import { apiRequest, ApiError } from "./api";
import { getSessao } from "./cognito";

export const ETIQUETAGEM_INDISPONIVEL_MSG =
  "Etiquetagem indisponível: sessão do Supabase não pôde ser criada";

export type EstadoSupabase =
  | { estado: "ausente" }
  | { estado: "derivando" }
  | { estado: "ok" }
  | { estado: "falhou"; motivo: string };

let estado: EstadoSupabase = { estado: "ausente" };
const ouvintes = new Set<(e: EstadoSupabase) => void>();

export function estadoSupabase(): EstadoSupabase {
  return estado;
}

export function onEstadoSupabase(fn: (e: EstadoSupabase) => void): () => void {
  ouvintes.add(fn);
  return () => {
    ouvintes.delete(fn);
  };
}

function setEstado(novo: EstadoSupabase): void {
  estado = novo;
  for (const fn of ouvintes) {
    try {
      fn(novo);
    } catch (err) {
      console.warn("[supabase-derivada] ouvinte falhou:", err);
    }
  }
}

type HandoffDto = { url: string; expiraEm?: string };

let emVoo: Promise<boolean> | null = null;

/**
 * Garante uma sessão Supabase para a Etiquetagem. Chamar depois do login no
 * Cognito e no boot. Idempotente e barato quando já existe sessão.
 * `forcar: true` refaz o handoff mesmo com sessão (botão "tentar de novo").
 */
export function garantirSessaoSupabase(opcoes: { forcar?: boolean } = {}): Promise<boolean> {
  if (emVoo) return emVoo;
  emVoo = derivar(opcoes.forcar === true).finally(() => {
    emVoo = null;
  });
  return emVoo;
}

async function derivar(forcar: boolean): Promise<boolean> {
  if (!forcar) {
    const { data } = await supabase.auth.getSession();
    if (data.session) {
      setEstado({ estado: "ok" });
      return true;
    }
  }

  // Sem sessão do Nexus não há o que derivar (boot antes do login).
  const nexus = await getSessao();
  if (!nexus) {
    setEstado({ estado: "ausente" });
    return false;
  }

  setEstado({ estado: "derivando" });
  try {
    const dto = await apiRequest<HandoffDto>("/desktop/handoff", { method: "POST", body: {} });
    const tokenHash = extrairTokenHash(dto?.url);
    if (!tokenHash) {
      return falhar("o Nexus não devolveu um link de sessão válido");
    }
    return aplicarTokenHash(tokenHash);
  } catch (err) {
    return falhar(motivoDoErro(err));
  }
}

/**
 * Troca um `token_hash` de magic link por sessão Supabase. Usado pelo handoff
 * e pelo deep link `berzerk://auth` (contrato mantido por compatibilidade).
 */
export async function aplicarTokenHash(tokenHash: string): Promise<boolean> {
  try {
    // NUNCA logar o token_hash — é credencial de sessão de vida curta.
    const { data, error } = await supabase.auth.verifyOtp({
      type: "magiclink",
      token_hash: tokenHash,
    });
    if (error || !data.session) {
      return falhar(error?.message ?? "o link de sessão expirou ou já foi usado");
    }
    setEstado({ estado: "ok" });
    return true;
  } catch (err) {
    return falhar(motivoDoErro(err));
  }
}

/** Derruba só a sessão Supabase (o logout do app chama junto com o do Cognito). */
export async function encerrarSessaoSupabase(): Promise<void> {
  try {
    await supabase.auth.signOut();
  } catch (err) {
    console.warn("[supabase-derivada] signOut falhou:", err);
  }
  setEstado({ estado: "ausente" });
}

function falhar(motivo: string): false {
  console.warn("[supabase-derivada] sessão não derivada:", motivo);
  setEstado({ estado: "falhou", motivo });
  return false;
}

function motivoDoErro(err: unknown): string {
  if (err instanceof ApiError) {
    const corpo = err.body as { mensagem?: string; motivo?: string; error?: string } | undefined;
    if (err.status === 403) {
      return "a sua conta não tem permissão para abrir sessão do desktop no Nexus";
    }
    return corpo?.mensagem ?? corpo?.motivo ?? corpo?.error ?? err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/** `berzerk://auth?token_hash=<hash>&type=magiclink` → `<hash>`. */
export function extrairTokenHash(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("token_hash");
  } catch {
    return null;
  }
}

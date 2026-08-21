// Sessão CURTA por inatividade — máquina compartilhada da separação: quem logou
// é quem separa, e a conta não pode ficar "aberta" pra próxima operadora usar.
//
// Divisão com o nexus:
// - NEXUS decide QUEM tem timeout e de QUANTO (admin configura por papel/usuário)
//   e expõe em `GET /separacao/me → sessaoInatividadeMinutos` (null/ausente = sem limite).
// - APP mede a inatividade. Só ele enxerga o que é atividade de verdade: leitura
//   RFID, tecla, clique. O nexus só vê requisições — o poll de fila (60s) e o
//   realtime pareceriam "ativo", e um pedido grande separado com EPCs em cache
//   pode passar minutos sem bater na API e pareceria "parado".
// - Backstop opcional do nexus (ainda NÃO implementado lá): 401 com
//   `{ error: "SESSION_EXPIRED" }` também derruba a sessão aqui (ver `apiRequest`).
//
// A sessão em si é Supabase/GoTrue (o nexus só valida o token), então "derrubar"
// = `supabase.auth.signOut()` → App volta pro Login (prompt=select_account).

import { supabase } from "./supabase";

let lastActivity = Date.now();

/** Marca atividade da operadora (tecla, clique, leitura RFID). Barato — só atribuição. */
export function touchActivity(): void {
  lastActivity = Date.now();
}

export function lastActivityAt(): number {
  return lastActivity;
}

export type LogoutReason =
  | { kind: "idle"; minutes: number }
  | { kind: "server"; message: string };

const REASON_KEY = "berzerk_logout_reason_v1";

/** Motivo do último logout forçado — o Login lê (e consome) pra explicar à operadora. */
export function takeLogoutReason(): LogoutReason | null {
  try {
    const raw = localStorage.getItem(REASON_KEY);
    if (!raw) return null;
    localStorage.removeItem(REASON_KEY);
    return JSON.parse(raw) as LogoutReason;
  } catch {
    return null;
  }
}

type BeforeLogout = () => void | Promise<void>;
const beforeLogout = new Set<BeforeLogout>();

/**
 * Registra algo que precisa rodar ANTES de perder o token (ex.: a Separação
 * devolve o claim do pedido atual — depois do signOut o release iria sem
 * Authorization e o pedido ficaria preso até o janitor). Retorna o unsubscribe.
 */
export function onBeforeForcedLogout(fn: BeforeLogout): () => void {
  beforeLogout.add(fn);
  return () => {
    beforeLogout.delete(fn);
  };
}

/** Teto pros hooks de beforeLogout — não deixa uma API lenta segurar o logout. */
const BEFORE_LOGOUT_CAP_MS = 2500;
let inFlight: Promise<void> | null = null;

/** Derruba a sessão (idempotente: chamadas concorrentes reaproveitam a mesma). */
export function forceLogout(reason: LogoutReason): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      localStorage.setItem(REASON_KEY, JSON.stringify(reason));
    } catch {
      /* sem storage: só perde a mensagem no Login */
    }
    const hooks = Array.from(beforeLogout).map((fn) =>
      Promise.resolve()
        .then(fn)
        .catch(() => undefined),
    );
    await Promise.race([
      Promise.allSettled(hooks),
      new Promise((r) => setTimeout(r, BEFORE_LOGOUT_CAP_MS)),
    ]);
    try {
      await supabase.auth.signOut();
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// WebSocket do nexus (API Gateway WS): o backend EMPURRA eventos quando algo
// muda — `queue.changed` (fila de separação: tiny-sync, claim, complete,
// release) e `print-jobs.changed` (jobs de etiqueta RFID criados/concluídos/
// cancelados/falhos). O handshake valida o mesmo token da API (id token do
// Cognito via query param `?token=`, ver ws-handlers do nexus).
//
// WS é gatilho, não fonte de verdade: quem assina refaz o fetch ao receber o
// evento e mantém um polling lento de fallback — se o WS cair, nada quebra.

import { getIdToken } from "./cognito";

/** Eventos que o servidor empurra. Discriminados por `type`. */
export type EventoRealtime = "queue.changed" | "print-jobs.changed";

const WS_URL = (import.meta.env.VITE_SEPARACAO_WS_URL ?? "").replace(/\/$/, "");

const INITIAL_RETRY_MS = 3_000;
const MAX_RETRY_MS = 60_000;

/**
 * Assina UM evento do servidor. `onChange` também dispara ao (re)conectar —
 * ressincroniza o que se perdeu enquanto estava offline. Devolve o unsubscribe.
 *
 * `onStatus` (opcional) reporta o estado da conexão para a UI mostrar o
 * indicador "tempo real" — a Etiquetagem tinha isso com o Realtime do Supabase
 * e a operadora usa o pontinho para saber se pode confiar na tela.
 */
export function subscribeEvento(
  evento: EventoRealtime,
  onChange: () => void,
  onStatus?: (status: "connecting" | "connected" | "disconnected") => void,
): () => void {
  if (!WS_URL) {
    // Sem WS configurado a tela não fica mentindo que está em tempo real.
    onStatus?.("disconnected");
    return () => {};
  }

  let ws: WebSocket | null = null;
  let stopped = false;
  let retryMs = INITIAL_RETRY_MS;
  let timer: number | undefined;

  const schedule = () => {
    if (stopped) return;
    onStatus?.("disconnected");
    timer = window.setTimeout(() => void connect(), retryMs);
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
  };

  const connect = async () => {
    if (stopped) return;
    onStatus?.("connecting");
    let token: string | undefined;
    try {
      token = (await getIdToken()) ?? undefined;
    } catch {
      /* sem sessão: tenta mesmo assim; o connect leva 401 e cai no retry */
    }
    // Re-checa DEPOIS do await: se o unsubscribe rodou enquanto buscávamos o
    // token, criar o socket aqui vazaria uma conexão viva pra sempre (o
    // ws?.close() do unsubscribe já passou e não alcança este socket).
    if (stopped) return;
    const url = token ? `${WS_URL}?token=${encodeURIComponent(token)}` : WS_URL;

    try {
      ws = new WebSocket(url);
    } catch {
      schedule();
      return;
    }
    ws.onopen = () => {
      retryMs = INITIAL_RETRY_MS;
      onStatus?.("connected");
      onChange();
    };
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data as string) as { type?: string };
        // Uma conexão só recebe TODOS os eventos (o broadcast do nexus não tem
        // rooms) — cada assinante filtra pelo `type` que lhe interessa.
        if (data.type === evento) onChange();
      } catch {
        /* mensagem não-JSON: ignora, o fallback lento cobre */
      }
    };
    ws.onclose = () => schedule();
  };

  void connect();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}

/** Atalho histórico: a fila de separação. */
export function subscribeQueueChanged(onChange: () => void): () => void {
  return subscribeEvento("queue.changed", onChange);
}

/**
 * Jobs de etiquetagem. Substitui o Realtime do Supabase que a Etiquetagem
 * assinava (`postgres_changes` em `rfid_print_jobs`, canal
 * `rfid-print-jobs-queue`).
 */
export function subscribePrintJobsChanged(
  onChange: () => void,
  onStatus?: (status: "connecting" | "connected" | "disconnected") => void,
): () => void {
  return subscribeEvento("print-jobs.changed", onChange, onStatus);
}

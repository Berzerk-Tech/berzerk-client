// WebSocket do nexus (API Gateway WS): o backend EMPURRA `queue.changed`
// quando a fila de separação muda (tiny-sync, claim, complete, release) —
// substitui o polling agressivo. O handshake valida o mesmo token da API
// (id token do Cognito via query param `?token=`, ver ws-handlers do nexus).
//
// WS é gatilho, não fonte de verdade: quem assina refaz o fetch ao receber o
// evento e mantém um polling lento de fallback — se o WS cair, nada quebra.

import { getIdToken } from "./cognito";

const WS_URL = (import.meta.env.VITE_SEPARACAO_WS_URL ?? "").replace(/\/$/, "");

const INITIAL_RETRY_MS = 3_000;
const MAX_RETRY_MS = 60_000;

/**
 * Assina os eventos `queue.changed`. `onChange` também dispara ao (re)conectar
 * — ressincroniza o que se perdeu enquanto estava offline. Devolve o unsubscribe.
 */
export function subscribeQueueChanged(onChange: () => void): () => void {
  if (!WS_URL) return () => {};

  let ws: WebSocket | null = null;
  let stopped = false;
  let retryMs = INITIAL_RETRY_MS;
  let timer: number | undefined;

  const schedule = () => {
    if (stopped) return;
    timer = window.setTimeout(() => void connect(), retryMs);
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
  };

  const connect = async () => {
    if (stopped) return;
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
      onChange();
    };
    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data as string) as { type?: string };
        if (data.type === "queue.changed") onChange();
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

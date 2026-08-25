// Login do app = NEXUS (Cognito, pool staff, Google @berzerk.com.br).
//
// Este arquivo é só a cola com o shell Tauri: o loopback HTTP Rust
// (`127.0.0.1:54321/oauth-callback`) e o evento `oauth-callback-url`. Toda a
// lógica de OAuth/PKCE, store e refresh vive em `cognito.ts`.
//
// Custom schemes (berzerk-print://) foram trocados por loopback HTTP porque o
// Chrome 120+ bloqueia silenciosamente custom schemes em redirects sem user
// gesture imediato. Isso segue valendo com o Cognito — a rota é a mesma, mudou
// só quem troca o `code`.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { concluirLogin, iniciarLogin } from "./cognito";

export async function signInWithGoogle(): Promise<{ error: Error | null }> {
  return iniciarLogin();
}

/**
 * Trata o que o loopback recebeu. Um pouso sem `code` (o retorno do `/logout`
 * do Hosted UI, por exemplo) não é erro — sai calado.
 */
export async function handleOAuthCallback(callbackPath: string): Promise<{ error: Error | null }> {
  const { error, ignorado } = await concluirLogin(callbackPath);
  if (ignorado) return { error: null };
  return { error };
}

export function listenForOAuthCallback(handler: (url: string) => void): () => void {
  let unlisten: UnlistenFn | null = null;
  let errUnlisten: UnlistenFn | null = null;
  let stopped = false;

  listen<string>("oauth-callback-url", (event) => {
    handler(event.payload);
  })
    .then((fn) => {
      if (stopped) fn();
      else unlisten = fn;
    })
    .catch(() => {});

  listen<string>("oauth-callback-error", (event) => {
    console.error("[oauth-loopback] erro do server:", event.payload);
  })
    .then((fn) => {
      if (stopped) fn();
      else errUnlisten = fn;
    })
    .catch(() => {});

  return () => {
    stopped = true;
    if (unlisten) unlisten();
    if (errUnlisten) errUnlisten();
  };
}

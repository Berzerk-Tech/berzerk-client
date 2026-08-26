// Deep links vindos do Nexus (botão "Abrir Berzerk Client").
//
// Contrato combinado com o Nexus (não mudar sem avisar lá):
//   berzerk://auth?token_hash=<hash>&type=magiclink   (0.6.0 — compatibilidade)
//   berzerk://login                                   (0.7.0)
//   berzerk://open
//
// O que mudou na 0.8.0: a Etiquetagem saiu do Supabase (fase 3 do
// `docs/plano-corte-supabase.md` do nexus), e com ela o ÚNICO consumidor do
// `token_hash`. O parâmetro continua sendo aceito e IGNORADO — o Nexus em
// produção ainda emite `berzerk://auth?token_hash=…` para clientes antigos, e
// um link desses tem de continuar abrindo o app logado em vez de dar erro.
//
// Hoje os três hosts fazem a mesma coisa útil: focar a janela e, se não houver
// sessão do Nexus, disparar o login PKCE no navegador (que já está logado no
// Google — costuma voltar sozinho).
//
// No Windows/Linux o SO abre uma SEGUNDA instância do app com a URL como argv —
// o `tauri-plugin-single-instance` (feature `deep-link`) repassa isso pra
// PRIMEIRA instância, que reemite como o evento `deep-link://new-url` (o mesmo
// que o `onOpenUrl` abaixo escuta). Não precisamos tratar argv manualmente.

import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getSessaoSync, iniciarLogin } from "./cognito";

const SCHEME = "berzerk:";

export type DeepLinkAuthResult =
  | { kind: "success"; email: string }
  | { kind: "error"; message: string };

type Handlers = {
  /** Resultado do `berzerk://auth` — hoje só diz "está logado" ou o erro do login. */
  onAuthResult?: (result: DeepLinkAuthResult) => void;
  /** O link disparou o login no navegador — a tela de login mostra o "aguardando". */
  onLoginIniciado?: () => void;
};

/**
 * Liga os listeners de deep link. Chamar UMA vez no boot do app (App.tsx),
 * junto do `listenForOAuthCallback`. Devolve o cleanup.
 */
export function initDeepLinks(handlers: Handlers): () => void {
  let stopped = false;
  let unlisten: (() => void) | null = null;

  // URL que já abriu o app nesta execução (cold start via deep link).
  getCurrent()
    .then((urls) => {
      if (!stopped && urls) handleUrls(urls, handlers);
    })
    .catch((err) => console.warn("[deep-link] getCurrent falhou:", err));

  // Deep links recebidos com o app já rodando (macOS nativo, ou repasse da
  // segunda instância no Windows/Linux via single-instance).
  onOpenUrl((urls) => handleUrls(urls, handlers))
    .then((fn) => {
      if (stopped) fn();
      else unlisten = fn;
    })
    .catch((err) => console.warn("[deep-link] onOpenUrl falhou:", err));

  return () => {
    stopped = true;
    unlisten?.();
  };
}

function handleUrls(urls: string[], handlers: Handlers): void {
  for (const raw of urls) {
    void handleUrl(raw, handlers);
  }
}

async function handleUrl(raw: string, handlers: Handlers): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    console.warn("[deep-link] URL malformada, ignorando:", raw);
    return;
  }

  if (url.protocol !== SCHEME) {
    console.warn("[deep-link] scheme desconhecido, ignorando:", url.protocol);
    return;
  }

  // berzerk://auth?... → hostname = "auth". berzerk://open → hostname = "open".
  const host = url.hostname || url.pathname.replace(/^\/+/, "");

  switch (host) {
    case "open":
      await focusWindow();
      return;
    case "login":
      await focusWindow();
      await dispararLogin(handlers);
      return;
    case "auth":
      await handleAuth(url, handlers);
      return;
    default:
      console.warn("[deep-link] host desconhecido, ignorando:", host);
  }
}

async function focusWindow(): Promise<void> {
  try {
    const win = getCurrentWindow();
    await win.unminimize();
    await win.show();
    await win.setFocus();
  } catch (err) {
    console.warn("[deep-link] falha ao focar janela:", err);
  }
}

/** Abre o login PKCE no navegador. Já logado no Nexus = volta sem digitar nada. */
async function dispararLogin(handlers: Handlers): Promise<boolean> {
  if (getSessaoSync()) return true;
  handlers.onLoginIniciado?.();
  const { error } = await iniciarLogin();
  if (error) {
    handlers.onAuthResult?.({ kind: "error", message: error.message });
    return false;
  }
  return true;
}

/**
 * `berzerk://auth?token_hash=…` — o link que o Nexus emite hoje.
 *
 * O `token_hash` é IGNORADO desde a 0.8.0: ele existia para derivar a sessão
 * Supabase da Etiquetagem, que agora fala com a API do Nexus. O host continua
 * aceito de propósito — o Nexus em produção segue emitindo esses links, e um
 * link legítimo tem de abrir o app logado em vez de dar erro na cara de quem
 * clicou.
 */
async function handleAuth(_url: URL, handlers: Handlers): Promise<void> {
  await focusWindow();

  if (getSessaoSync()) {
    handlers.onAuthResult?.({
      kind: "success",
      email: getSessaoSync()?.email ?? "(sem email)",
    });
    return;
  }

  const ok = await dispararLogin(handlers);
  // `dispararLogin` já reportou o erro; o sucesso vem pelo callback do PKCE.
  if (!ok) return;
}

// Deep links vindos do Nexus (botão "Abrir Berzerk Client").
//
// Contrato combinado com o Nexus (não mudar sem avisar lá):
//   berzerk://auth?token_hash=<hash>&type=magiclink   (0.6.0 — compatibilidade)
//   berzerk://login                                   (0.7.0)
//   berzerk://open
//
// O que mudou na 0.7.0: quem manda na identidade é o Cognito. O `token_hash`
// do Nexus (magic link do Supabase) deixou de ser LOGIN e virou só o atalho pra
// sessão Supabase DERIVADA que a Etiquetagem ainda precisa. Por isso:
//
// - sem sessão do Nexus, `auth` dispara primeiro o login PKCE no navegador
//   (que já está logado no Nexus/Google — costuma voltar sozinho) e só depois
//   aplica o `token_hash`;
// - com sessão do Nexus, aplica o `token_hash` direto (economiza um handoff);
// - `berzerk://login` só dispara o login;
// - `berzerk://open` só foca a janela.
//
// No Windows/Linux o SO abre uma SEGUNDA instância do app com a URL como argv —
// o `tauri-plugin-single-instance` (feature `deep-link`) repassa isso pra
// PRIMEIRA instância, que reemite como o evento `deep-link://new-url` (o mesmo
// que o `onOpenUrl` abaixo escuta). Não precisamos tratar argv manualmente.

import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getSessaoSync, iniciarLogin, onSessaoChange } from "./cognito";
import { aplicarTokenHash, garantirSessaoSupabase } from "./supabase-derivada";

const SCHEME = "berzerk:";

export type DeepLinkAuthResult =
  | { kind: "success"; email: string }
  | { kind: "error"; message: string };

export const LINK_INVALIDO_MSG = "Link expirado ou inválido — entre com o Google.";

type Handlers = {
  /** Resultado de aplicar o `token_hash` (sessão da Etiquetagem). */
  onAuthResult?: (result: DeepLinkAuthResult) => void;
  /** O link disparou o login no navegador — a tela de login mostra o "aguardando". */
  onLoginIniciado?: () => void;
};

/** `token_hash` que chegou antes da sessão do Nexus — aplicado quando ela existir. */
let tokenHashPendente: string | null = null;

/**
 * Liga os listeners de deep link. Chamar UMA vez no boot do app (App.tsx),
 * junto do `listenForOAuthCallback`. Devolve o cleanup.
 */
export function initDeepLinks(handlers: Handlers): () => void {
  let stopped = false;
  let unlisten: (() => void) | null = null;

  // Login concluído com um `token_hash` na fila: aplica agora.
  const pararSessao = onSessaoChange((sessao) => {
    if (!sessao || !tokenHashPendente) return;
    const hash = tokenHashPendente;
    tokenHashPendente = null;
    void aplicarComAviso(hash, handlers);
  });

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
    pararSessao();
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

async function handleAuth(url: URL, handlers: Handlers): Promise<void> {
  await focusWindow();

  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type");

  // NUNCA logar tokenHash — é credencial de sessão de curta duração.
  if (!tokenHash || type !== "magiclink") {
    console.warn("[deep-link] auth sem token_hash/type=magiclink, ignorando");
    handlers.onAuthResult?.({ kind: "error", message: LINK_INVALIDO_MSG });
    return;
  }

  // Sem sessão do Nexus, o login vem primeiro: o `token_hash` sozinho não
  // autentica mais nada (só serve pra Etiquetagem). Fica na fila e é aplicado
  // assim que o PKCE voltar.
  if (!getSessaoSync()) {
    tokenHashPendente = tokenHash;
    const ok = await dispararLogin(handlers);
    if (!ok) tokenHashPendente = null;
    return;
  }

  await aplicarComAviso(tokenHash, handlers);
}

async function aplicarComAviso(tokenHash: string, handlers: Handlers): Promise<void> {
  const ok = await aplicarTokenHash(tokenHash);
  if (!ok) {
    // Link velho/já usado não é motivo pra travar: o handoff normal (Bearer
    // Cognito) tenta de novo e costuma resolver.
    const derivou = await garantirSessaoSupabase({ forcar: true });
    if (!derivou) {
      handlers.onAuthResult?.({ kind: "error", message: LINK_INVALIDO_MSG });
      return;
    }
  }
  handlers.onAuthResult?.({
    kind: "success",
    email: getSessaoSync()?.email ?? "(sem email)",
  });
}

// Handoff de login vindo do Nexus (botão "Abrir Berzerk Client").
//
// Contrato combinado com o Nexus (não mudar sem avisar lá):
//   berzerk://auth?token_hash=<hash>&type=magiclink
//   berzerk://open
//
// O Nexus gera o link com `supabase.auth.admin.generateLink({ type: 'magiclink', email })`
// no MESMO projeto Supabase deste app. Aqui só consumimos com `verifyOtp`.
//
// No Windows/Linux o SO abre uma SEGUNDA instância do app com a URL como argv —
// o `tauri-plugin-single-instance` (feature `deep-link`) repassa isso pra
// PRIMEIRA instância, que reemite como o evento `deep-link://new-url` (o mesmo
// que o `onOpenUrl` abaixo escuta). Não precisamos tratar argv manualmente.

import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { supabase } from "./supabase";

const SCHEME = "berzerk:";

export type DeepLinkAuthResult =
  | { kind: "success"; email: string }
  | { kind: "error"; message: string };

export const LINK_INVALIDO_MSG = "Link expirado ou inválido — entre com o Google.";

type Handlers = {
  onAuthResult?: (result: DeepLinkAuthResult) => void;
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

  // Não dá pra saber o e-mail do link ANTES de verificá-lo (token_hash é opaco),
  // então não dá pra comparar com a sessão atual e só trocar "se for outro
  // e-mail". Em vez disso: se já existe sessão, sempre desloga antes de tentar
  // o verifyOtp. Isso cobre os dois casos do contrato — troca limpa quando o
  // e-mail é diferente, e a tela de login com a mensagem de erro quando o link
  // está expirado/usado (nenhuma sessão residual fica "logada errado").
  const { data: current } = await supabase.auth.getSession();
  if (current.session) {
    await supabase.auth.signOut();
  }

  const { data, error } = await supabase.auth.verifyOtp({
    type: "magiclink",
    token_hash: tokenHash,
  });

  if (error || !data.session) {
    console.error("[deep-link] verifyOtp falhou:", error?.message ?? "sessão ausente");
    handlers.onAuthResult?.({ kind: "error", message: LINK_INVALIDO_MSG });
    return;
  }

  handlers.onAuthResult?.({
    kind: "success",
    email: data.session.user.email ?? "(sem email)",
  });
}

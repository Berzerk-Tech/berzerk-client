// Deep links vindos do Nexus (botão "Abrir Berzerk Client").
//
// Contrato combinado com o Nexus (não mudar sem avisar lá):
//   berzerk://auth?email=<email>                      (0.9.1 — handoff atual)
//   berzerk://auth?token_hash=<hash>&type=magiclink   (0.6.0 — compatibilidade)
//   berzerk://login                                   (0.7.0)
//   berzerk://open
//
// O que o handoff é HOJE: o Nexus não manda mais credencial nenhuma no link —
// manda só o e-mail de quem clicou. Quem prova a identidade é o próprio
// Cognito: o app dispara o PKCE no navegador do sistema, que ACABOU de logar
// no Nexus e por isso tem a sessão do Hosted UI viva; o `authorize` volta
// sozinho pro loopback e a pessoa não digita nada. É a fase 1.3 do
// `docs/plano-corte-supabase.md` do nexus.
//
// O que estava quebrado até a 0.9.0: o `token_hash` do Supabase (o handoff
// antigo) deixou de ser consumido na 0.8.0 — o link não autenticava mais nada —
// e o login disparado aqui pedia `prompt=select_account`. Resultado: clicar em
// "Abrir Berzerk Client" abria o app e jogava a pessoa de volta no navegador,
// na tela de escolher conta do Google. O `token_hash` continua sendo aceito e
// IGNORADO (links de versões antigas do Nexus ainda chegam).
//
// No Windows/Linux o SO abre uma SEGUNDA instância do app com a URL como argv —
// o `tauri-plugin-single-instance` (feature `deep-link`) repassa isso pra
// PRIMEIRA instância, que reemite como o evento `deep-link://new-url` (o mesmo
// que o `onOpenUrl` abaixo escuta). Com o app FECHADO não há evento nenhum: a
// URL só existe no argv do processo que está subindo, e quem a entrega é o
// `getCurrent()` no boot — por isso os dois caminhos ficam ligados aqui.

import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getSessao, getSessaoSync, iniciarLogin } from "./cognito";
import { bloqueioAtual } from "./updateGate";

const SCHEME = "berzerk:";

export type DeepLinkAuthResult =
  | { kind: "success"; email: string }
  | { kind: "error"; message: string };

type Handlers = {
  /** Resultado do `berzerk://auth` — hoje só diz "está logado" ou o erro do login. */
  onAuthResult?: (result: DeepLinkAuthResult) => void;
  /** O link disparou o login no navegador — a tela de login mostra o "aguardando". */
  onLoginIniciado?: (email: string | null) => void;
};

/** URLs já tratadas nesta execução — cold start e evento podem trazer a mesma. */
const jaTratadas = new Set<string>();
/** Um login em voo por vez: dois links seguidos não abrem duas abas. */
let loginEmVoo = false;

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
    if (jaTratadas.has(raw)) {
      // Cold start entrega a mesma URL pelo `getCurrent` e (em algumas
      // plataformas) pelo evento. Tratar duas vezes abriria dois logins.
      console.info("[deep-link] URL repetida, ignorando:", raw);
      continue;
    }
    jaTratadas.add(raw);
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
  // Com barra (`berzerk://auth/?x=1`) o hostname é o mesmo; sem host mas com
  // path (`berzerk:auth`) o fallback abaixo cobre.
  const host = (url.hostname || url.pathname.replace(/^\/+/, "")).toLowerCase();

  switch (host) {
    case "open":
      await focusWindow();
      return;
    case "login":
    case "auth":
      if (bloqueioAtual()) {
        // Mesa bloqueada por atualização obrigatória (0.9.2): a janela vem pra
        // frente — quem clicou espera ver o app — mas nada de login. Abrir o
        // navegador aqui tiraria a operadora justamente da tela que ela precisa
        // resolver, e o login não a levaria a lugar nenhum atrás do bloqueio.
        console.info("[deep-link] bloqueio de atualização ativo, só focando a janela");
        await focusWindow();
        return;
      }
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

/**
 * `berzerk://auth?email=…` / `berzerk://login` — "abre já logado".
 *
 * Ordem importa: primeiro RESOLVE a sessão (renovando pelo refresh token se
 * estiver vencida) e só então decide entre "já está logado" e "manda pro
 * navegador". A versão anterior olhava só a sessão em memória (`getSessaoSync`)
 * e podia anunciar "conectado" sobre uma sessão que o boot ia descartar logo
 * em seguida — a pessoa clicava em "abrir logado" e caía na tela de login.
 */
async function handleAuth(url: URL, handlers: Handlers): Promise<void> {
  await focusWindow();

  // Handoff do Nexus: e-mail de quem clicou. `login_hint` é o nome do parâmetro
  // no OAuth; aceito também pra quem preferir mandar assim.
  const email = url.searchParams.get("email") ?? url.searchParams.get("login_hint");

  const sessao = (await getSessao()) ?? getSessaoSync();
  if (sessao) {
    handlers.onAuthResult?.({ kind: "success", email: sessao.email ?? "(sem email)" });
    return;
  }

  await dispararLogin(handlers, email);
}

/**
 * Abre o login PKCE no navegador SEM o seletor de contas: o navegador que
 * mandou o link acabou de logar no Nexus, então o Cognito devolve o código
 * sozinho e a janela do navegador se fecha em ~1,5s (ver
 * `oauth_loopback_response.html`). Se a sessão do Hosted UI tiver expirado, o
 * `login_hint` faz o Google já escolher a conta certa.
 */
async function dispararLogin(handlers: Handlers, email: string | null): Promise<boolean> {
  if (getSessaoSync()) return true;
  if (loginEmVoo) return true;
  loginEmVoo = true;
  handlers.onLoginIniciado?.(email);
  const { error } = await iniciarLogin({ seletorDeConta: false, email });
  if (error) {
    loginEmVoo = false;
    console.error("[deep-link] login pelo handoff falhou:", error.message);
    handlers.onAuthResult?.({ kind: "error", message: error.message });
    return false;
  }
  // O sucesso (ou o erro) chega pelo callback do PKCE, que o App.tsx escuta —
  // é lá que a trava é liberada, via `liberarLoginDoHandoff`.
  return true;
}

/**
 * Libera a trava do login iniciado por deep link. O App.tsx chama quando o
 * callback do PKCE volta (com ou sem erro) e quando a pessoa cancela.
 */
export function liberarLoginDoHandoff(): void {
  loginEmVoo = false;
}

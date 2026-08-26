// Sessão do NEXUS (Cognito, pool staff) — a identidade do app.
//
// Porte do `packages/auth/src/cognito.ts` do nexus para o desktop: Authorization
// Code + PKCE contra o Hosted UI, indo direto pro Google
// (`identity_provider=Google`), com o callback no loopback HTTP que o app já
// sobe (`127.0.0.1:54321/oauth-callback`, ver `src-tauri/src/oauth_loopback.rs`).
//
// O Bearer da API e do WS é o **id token**: o access token do Cognito NÃO
// carrega `email`, e a API do nexus usa o e-mail do token para o provisioning
// JIT em `usuarios`, para casar papéis no 1º login e para o
// `POST /desktop/handoff` (ver `identity/token-claims.ts` e
// `jwt-auth.guard.ts` lá). É também o que o app web do nexus manda.
//
// Desde a 0.8.0 esta é a ÚNICA sessão do app: a Etiquetagem e o Rastreio, os
// últimos consumidores do Supabase, passaram a falar com a API do nexus.

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

const SESSAO_KEY = "berzerk_cognito_sessao_v1";
const FLUXO_KEY = "berzerk_cognito_pkce_v1";
/** Renova o token com esta folga antes de expirar (o id token vale 1h). */
const MARGEM_RENOVACAO_MS = 2 * 60_000;
/** Fluxo de login abandonado no meio expira — não fica verifier órfão no storage. */
const FLUXO_TTL_MS = 15 * 60_000;

export type SessaoCognito = {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  /** Epoch ms em que o id/access token expira. */
  expiraEm: number;
  email: string | null;
  sub: string;
  nome: string | null;
};

type Config = {
  /** Domínio do Hosted UI, sem barra final. Ex.: https://auth.cloud.berzerk.com.br */
  dominio: string;
  clientId: string;
  regiao: string;
};

function lerConfig(): Config | null {
  const env = import.meta.env;
  const dominioBruto = env.VITE_COGNITO_DOMAIN?.trim();
  const clientId = env.VITE_COGNITO_CLIENT_ID?.trim();
  if (!dominioBruto || !clientId) return null;
  const dominio = (dominioBruto.startsWith("http") ? dominioBruto : `https://${dominioBruto}`).replace(/\/$/, "");
  return { dominio, clientId, regiao: env.VITE_COGNITO_REGION?.trim() || "us-east-1" };
}

const config = lerConfig();

/** Sem `VITE_COGNITO_DOMAIN`/`VITE_COGNITO_CLIENT_ID` não há login possível. */
export function cognitoConfigurado(): boolean {
  return config !== null;
}

export const CONFIG_AUSENTE_MSG =
  "Login não configurado nesta instalação (VITE_COGNITO_DOMAIN / VITE_COGNITO_CLIENT_ID).";

// ── Store local ──────────────────────────────────────────────────────────────

let sessao: SessaoCognito | null = carregar();
const ouvintes = new Set<(s: SessaoCognito | null) => void>();

function carregar(): SessaoCognito | null {
  try {
    const raw = localStorage.getItem(SESSAO_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SessaoCognito;
    return parsed?.idToken && parsed?.refreshToken ? parsed : null;
  } catch {
    return null;
  }
}

function guardar(nova: SessaoCognito | null): void {
  sessao = nova;
  try {
    if (nova) localStorage.setItem(SESSAO_KEY, JSON.stringify(nova));
    else localStorage.removeItem(SESSAO_KEY);
  } catch {
    /* sem storage: a sessão vale só enquanto o app estiver aberto */
  }
  for (const fn of ouvintes) {
    try {
      fn(nova);
    } catch (err) {
      console.warn("[cognito] ouvinte falhou:", err);
    }
  }
}

/** Sessão em memória, SEM renovar (para render síncrono). Pode estar expirada. */
export function getSessaoSync(): SessaoCognito | null {
  return sessao;
}

/** Sessão válida, renovando pelo refresh token quando perto de expirar. */
export async function getSessao(): Promise<SessaoCognito | null> {
  if (!sessao) return null;
  if (sessao.expiraEm - Date.now() > MARGEM_RENOVACAO_MS) return sessao;
  return renovar();
}

/** Bearer da API e do WS. `null` quando não há sessão (ou a renovação falhou). */
export async function getIdToken(): Promise<string | null> {
  const atual = await getSessao();
  return atual?.idToken ?? null;
}

/** Avisa login, logout e renovação. Devolve o unsubscribe. */
export function onSessaoChange(fn: (s: SessaoCognito | null) => void): () => void {
  ouvintes.add(fn);
  return () => {
    ouvintes.delete(fn);
  };
}

// ── Renovação ────────────────────────────────────────────────────────────────

let renovacaoEmVoo: Promise<SessaoCognito | null> | null = null;

/** Renova pelo `refresh_token` (idempotente: chamadas concorrentes compartilham). */
function renovar(): Promise<SessaoCognito | null> {
  if (renovacaoEmVoo) return renovacaoEmVoo;
  renovacaoEmVoo = (async () => {
    const atual = sessao;
    if (!config || !atual) return null;
    try {
      const res = await fetch(`${config.dominio}/oauth2/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: config.clientId,
          refresh_token: atual.refreshToken,
        }).toString(),
      });
      if (!res.ok) {
        // 400 `invalid_grant` = refresh revogado/expirado (30 dias): a sessão
        // acabou de verdade. Erro de rede (throw) NÃO derruba — a sessão fica
        // como está e a próxima chamada tenta de novo.
        if (res.status >= 400 && res.status < 500) {
          guardar(null);
          return null;
        }
        return atual;
      }
      const raw = (await res.json()) as {
        id_token: string;
        access_token: string;
        refresh_token?: string;
        expires_in: number;
      };
      const nova = daResposta(raw, atual.refreshToken);
      guardar(nova);
      return nova;
    } catch (err) {
      console.warn("[cognito] falha ao renovar (mantendo a sessão):", err);
      return atual;
    } finally {
      renovacaoEmVoo = null;
    }
  })();
  return renovacaoEmVoo;
}

// ── Login (PKCE) ─────────────────────────────────────────────────────────────

/**
 * Sobe o loopback, monta a URL do Hosted UI e abre no navegador do sistema.
 * O `code` volta pelo evento `oauth-callback-url` (ver `auth.ts`).
 */
export type OpcoesLogin = {
  /**
   * Mostrar o seletor de contas do Google (`prompt=select_account`).
   *
   * `true` (padrão) no botão "Entrar com Google": a mesa é compartilhada e a
   * operadora que chega precisa escolher a conta DELA em vez de herdar a
   * anterior. Também é o que evita o beco sem saída do `org_internal` (o Google
   * pegaria a conta ativa — um gmail pessoal — e o app é Internal).
   *
   * `false` no handoff do Nexus ("Abrir Berzerk Client"): quem clicou ACABOU de
   * provar quem é no navegador, e é justamente a sessão viva do Hosted UI que
   * faz o `authorize` voltar sozinho, sem tela nenhuma. Pedir `select_account`
   * aqui é o que jogava a pessoa de volta pro navegador pedindo login.
   */
  seletorDeConta?: boolean;
  /**
   * E-mail de quem pediu o login (vem no deep link do Nexus) — vira
   * `login_hint`, que o Google usa pra já escolher a conta certa quando a
   * sessão do Hosted UI expirou e o navegador tem mais de uma conta logada.
   * Parâmetro desconhecido é ignorado pelo Cognito, então no pior caso é inerte.
   */
  email?: string | null;
};

export async function iniciarLogin(opcoes: OpcoesLogin = {}): Promise<{ error: Error | null }> {
  if (!config) return { error: new Error(CONFIG_AUSENTE_MSG) };

  let redirectUri: string;
  try {
    redirectUri = await invoke<string>("start_oauth_listener");
  } catch (err) {
    return { error: err instanceof Error ? err : new Error(String(err)) };
  }

  const { verifier, challenge } = await gerarPkce();
  const state = novoState();
  guardarFluxo({ state, verifier, redirectUri, criadoEm: Date.now() });

  const seletorDeConta = opcoes.seletorDeConta ?? true;
  const email = opcoes.email?.trim();

  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    scope: "openid email profile",
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    // Direto pro Google, sem a tela de seleção de provedor do Cognito.
    identity_provider: "Google",
    ...(seletorDeConta ? { prompt: "select_account" } : {}),
    ...(email ? { login_hint: email } : {}),
  });

  try {
    await openUrl(`${config.dominio}/oauth2/authorize?${params}`);
  } catch (err) {
    return { error: err instanceof Error ? err : new Error(String(err)) };
  }
  return { error: null };
}

/**
 * Troca o `code` do callback por tokens e grava a sessão.
 * `resultado: 'ignorado'` = o loopback recebeu algo que não é um retorno de
 * login (o pouso do `/logout`, por exemplo) — não é erro.
 */
export async function concluirLogin(
  callbackUrl: string,
): Promise<{ error: Error | null; ignorado?: boolean }> {
  if (!config) return { error: new Error(CONFIG_AUSENTE_MSG) };

  let url: URL;
  try {
    url = new URL(callbackUrl, "http://127.0.0.1:54321");
  } catch (err) {
    return { error: err instanceof Error ? err : new Error(String(err)) };
  }

  const erro = url.searchParams.get("error");
  if (erro) {
    return { error: new Error(url.searchParams.get("error_description") ?? erro) };
  }

  const code = url.searchParams.get("code");
  if (!code) return { error: null, ignorado: true };

  const fluxo = consumirFluxo(url.searchParams.get("state"));
  if (!fluxo) {
    return {
      error: new Error("Este login expirou ou começou em outra janela. Entre de novo."),
    };
  }

  try {
    const res = await fetch(`${config.dominio}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: config.clientId,
        code,
        code_verifier: fluxo.verifier,
        redirect_uri: fluxo.redirectUri,
      }).toString(),
    });
    if (!res.ok) {
      return { error: new Error(`Falha na troca do código por tokens: HTTP ${res.status}`) };
    }
    const raw = (await res.json()) as {
      id_token: string;
      access_token: string;
      refresh_token: string;
      expires_in: number;
    };
    guardar(daResposta(raw, raw.refresh_token));
    return { error: null };
  } catch (err) {
    return { error: err instanceof Error ? err : new Error(String(err)) };
  }
}

// ── Logout ───────────────────────────────────────────────────────────────────

/**
 * Limpa a sessão local e, por padrão, encerra também a sessão do Hosted UI no
 * navegador. Sem isso a máquina fica com o Cognito "logado" e o próximo
 * `authorize` poderia devolver um code da operadora ANTERIOR sem passar pelo
 * Google — inaceitável numa mesa compartilhada. O pouso do `/logout` é o mesmo
 * loopback, que responde a página "pode fechar esta janela".
 */
export async function sair(opcoes: { encerrarNoNavegador?: boolean } = {}): Promise<void> {
  const encerrar = opcoes.encerrarNoNavegador ?? true;
  const tinhaSessao = sessao !== null;
  guardar(null);
  limparFluxos();
  if (!config || !encerrar || !tinhaSessao) return;
  try {
    const logoutUri = await invoke<string>("start_oauth_listener");
    const params = new URLSearchParams({ client_id: config.clientId, logout_uri: logoutUri });
    await openUrl(`${config.dominio}/logout?${params}`);
  } catch (err) {
    // Sessão local já foi embora — não conseguir abrir o navegador não pode
    // travar o logout.
    console.warn("[cognito] logout no navegador falhou:", err);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function daResposta(
  raw: { id_token: string; access_token: string; refresh_token?: string; expires_in: number },
  refreshTokenAtual: string,
): SessaoCognito {
  const claims = lerClaims(raw.id_token);
  return {
    idToken: raw.id_token,
    accessToken: raw.access_token,
    // O refresh_token só volta na troca do code; no refresh o Cognito omite.
    refreshToken: raw.refresh_token ?? refreshTokenAtual,
    expiraEm: Date.now() + (raw.expires_in ?? 3600) * 1000,
    email: typeof claims.email === "string" ? claims.email : null,
    sub: typeof claims.sub === "string" ? claims.sub : "",
    nome: typeof claims.name === "string" ? claims.name : null,
  };
}

/** Claims do id token. Leitura, NÃO validação — quem valida é a API (JWKS). */
function lerClaims(idToken: string): Record<string, unknown> {
  try {
    const payload = idToken.split(".")[1];
    if (!payload) return {};
    const b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = decodeURIComponent(
      atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="))
        .split("")
        .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`)
        .join(""),
    );
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function base64url(buf: Uint8Array): string {
  let str = "";
  for (let i = 0; i < buf.length; i++) str += String.fromCharCode(buf[i]!);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function gerarPkce(): Promise<{ verifier: string; challenge: string }> {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  const verifier = base64url(bytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

function novoState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

type Fluxo = { state: string; verifier: string; redirectUri: string; criadoEm: number };

/** O fluxo é indexado pelo `state` — dois logins seguidos não se atropelam. */
function guardarFluxo(fluxo: Fluxo): void {
  try {
    const vivos = lerFluxos().filter((f) => Date.now() - f.criadoEm < FLUXO_TTL_MS);
    localStorage.setItem(FLUXO_KEY, JSON.stringify([...vivos, fluxo]));
  } catch {
    /* sem storage: o callback falha com mensagem clara */
  }
}

function lerFluxos(): Fluxo[] {
  try {
    const raw = localStorage.getItem(FLUXO_KEY);
    const parsed = raw ? (JSON.parse(raw) as Fluxo[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function consumirFluxo(state: string | null): Fluxo | null {
  const fluxos = lerFluxos();
  const achado = state ? fluxos.find((f) => f.state === state) : undefined;
  const restantes = fluxos.filter(
    (f) => f !== achado && Date.now() - f.criadoEm < FLUXO_TTL_MS,
  );
  try {
    localStorage.setItem(FLUXO_KEY, JSON.stringify(restantes));
  } catch {
    /* ignora */
  }
  return achado ?? null;
}

function limparFluxos(): void {
  try {
    localStorage.removeItem(FLUXO_KEY);
  } catch {
    /* ignora */
  }
}

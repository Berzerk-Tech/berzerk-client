// Modo "Únicos" da Expedição (27/10): fila de pedidos e-commerce de UMA peça,
// agrupada por estampa × tamanho. Aqui só o que é puro (testável sem tela):
// persistência do modo/grupo, busca, mensagens de erro e a montagem do match.

import { ApiError } from "./api";
import type { EpcMatch, ExpedicaoOrder, OrderBumpConfig, UnicoGrupo, UnicoSepararResponse, UnicoTipo } from "../services/expedicao";
import { UNICOS_ERR } from "../services/expedicao";

export type ModoFila = "pedidos" | "unicos";

/** Máximo de EPCs que o `separar` aceita; acima disso é mais de uma peça na mesa. */
export const UNICOS_MAX_TAGS = 10;

// Chave própria: `berzerk_expedicao_modo_v1` já é o modo oficial/teste (services/expedicaoMode).
const MODO_KEY = "berzerk_expedicao_fila_v1";
const GRUPO_KEY = "berzerk_expedicao_unicos_grupo_v1";

export type GrupoEscolhido = { estampa: string; tamanho: string };

export function getModoFila(): ModoFila {
  try {
    return localStorage.getItem(MODO_KEY) === "unicos" ? "unicos" : "pedidos";
  } catch {
    return "pedidos";
  }
}

export function setModoFila(modo: ModoFila): void {
  try {
    localStorage.setItem(MODO_KEY, modo);
  } catch {
    /* ignore */
  }
}

export function getGrupoEscolhido(): GrupoEscolhido | null {
  try {
    const raw = localStorage.getItem(GRUPO_KEY);
    if (!raw) return null;
    const g = JSON.parse(raw) as Partial<GrupoEscolhido>;
    if (typeof g.estampa === "string" && g.estampa && typeof g.tamanho === "string" && g.tamanho) {
      return { estampa: g.estampa, tamanho: g.tamanho };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function setGrupoEscolhido(g: GrupoEscolhido | null): void {
  try {
    if (g) localStorage.setItem(GRUPO_KEY, JSON.stringify(g));
    else localStorage.removeItem(GRUPO_KEY);
  } catch {
    /* ignore */
  }
}

/** Minúsculo e sem acento — a busca da tela não pode depender de como se digita. */
export function normalizarBusca(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/** "LEG DAY · G" — o título grande do cabeçalho. */
export function rotuloGrupo(g: GrupoEscolhido): string {
  return `${g.estampa} · ${g.tamanho}`.toUpperCase();
}

export function mesmoGrupo(a: GrupoEscolhido | null | undefined, b: GrupoEscolhido | null | undefined): boolean {
  return !!a && !!b && a.estampa === b.estampa && a.tamanho === b.tamanho;
}

/** Filtra os grupos por estampa, tamanho ou tipo de peça (cada palavra da busca precisa casar). */
export function filtrarGrupos(grupos: UnicoGrupo[], busca: string): UnicoGrupo[] {
  const palavras = normalizarBusca(busca).split(/\s+/).filter(Boolean);
  if (palavras.length === 0) return grupos;
  return grupos.filter((g) => {
    const alvo = normalizarBusca([g.estampa, g.tamanho, ...(g.tipos ?? []).map((t) => t.produtoNome)].join(" "));
    return palavras.every((p) => alvo.includes(p));
  });
}

export type ErroUnicos = {
  code: string;
  message: string;
  /** Erro que só muda com a mesa: não adianta o retry automático. */
  definitivo: boolean;
  /** Mostra o botão "Trocar fila" no painel de erro. */
  trocarFila?: boolean;
};

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * 404 do Nest sem rota ("Cannot GET /expedicao/unicos"): a API ainda não tem a fila.
 * Um 404 de gateway/proxy (sem esse corpo) é passageiro e NÃO desliga o modo.
 */
export function unicosRotaAusente(e: unknown): boolean {
  if (!(e instanceof ApiError) || e.status !== 404) return false;
  const b = e.body;
  if (!b || typeof b !== "object") return false;
  const m = (b as Record<string, unknown>).message;
  return typeof m === "string" && m.startsWith("Cannot ");
}

/** Erro do `separar` (ou de rede) → texto pt-BR pro painel da mesa. */
export function erroSepararUnico(e: unknown, grupo: GrupoEscolhido | null): ErroUnicos {
  if (e instanceof ApiError && e.body && typeof e.body === "object") {
    const b = e.body as Record<string, unknown>;
    const code = str(b.error);
    const peca = `${str(b.produtoNome)} ${str(b.tamanho)}`.trim();
    switch (code) {
      case UNICOS_ERR.PECA_DE_OUTRA_FILA:
        return {
          code,
          message: `Esta peça é ${[str(b.estampa), str(b.tamanho)].filter(Boolean).join(" ")}. A fila escolhida é ${grupo ? rotuloGrupo(grupo) : "outra"}.`,
          definitivo: true,
          trocarFila: true,
        };
      case UNICOS_ERR.SEM_PEDIDO_UNICO:
        return { code, message: `Nenhum pedido único aguardando ${peca || "esta peça"}.`, definitivo: false };
      case UNICOS_ERR.VARIAS_PECAS:
        return { code, message: "Deixe só uma peça na mesa.", definitivo: true };
      case UNICOS_ERR.EPC_NAO_RESOLVIDO:
        return { code, message: "Peça não reconhecida (etiqueta sem cadastro).", definitivo: true };
      case UNICOS_ERR.PEDIDO_INDISPONIVEL:
        return { code, message: "Bipe a peça de novo.", definitivo: false };
      case UNICOS_ERR.ORDER_BUMP_NECESSARIO: {
        const ob = b.orderBump && typeof b.orderBump === "object" ? (b.orderBump as Record<string, unknown>) : {};
        const nome = str(ob.produtoNome) || "o item do order bump";
        return {
          code,
          message: `Este pedido tem order bump: leia a peça junto com ${nome}.`,
          definitivo: false,
        };
      }
      case UNICOS_ERR.BUMP_SEM_PEDIDO: {
        const ob = b.orderBump && typeof b.orderBump === "object" ? (b.orderBump as Record<string, unknown>) : {};
        const nome = str(ob.produtoNome) || "o item do order bump";
        return {
          code,
          message: `Nenhum pedido de ${peca || "esta peça"} leva ${nome}. Se o item não é desta caixa, tire-o da mesa e leia só a peça.`,
          definitivo: false,
        };
      }
      case "missing_permission":
        return {
          code,
          message: "Seu usuário não tem a permissão de Expedição (expedicao:operate). Peça o papel de expedidor no admin do nexus.",
          definitivo: true,
        };
    }
  }
  if (unicosRotaAusente(e)) {
    return { code: "nexus_pendente", message: "Atualize a API: a fila de únicos ainda não existe no servidor.", definitivo: true };
  }
  // 4xx desconhecido (409 do complete, 422, 400 do zod…): refazer o POST não muda nada.
  if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
    const b = e.body && typeof e.body === "object" ? (e.body as Record<string, unknown>) : {};
    return { code: str(b.error) || "erro_servidor", message: str(b.message) || "Recusado pelo servidor.", definitivo: true };
  }
  // Só falha de rede e 5xx chegam aqui.
  return { code: "sem_conexao", message: "Sem conexão, bipe de novo.", definitivo: false };
}

/** O `order` do `separar` entra no fluxo existente como um match de 1 peça. */
export function matchDoSeparar(order: ExpedicaoOrder, lidas: string[]): EpcMatch {
  const l = Array.from(new Set(lidas.map((t) => t.toUpperCase())));
  const todas = (order.rfidTags ?? []).map((t) => t.toUpperCase());
  const matched = l.filter((t) => todas.includes(t));
  return {
    order,
    tagsLidas: l,
    tagsFaltantes: todas.filter((t) => !l.includes(t)),
    tagsMatched: matched.length || l.length,
    tagsTotal: todas.length || l.length,
  };
}

/** Replay de pedido que já saiu: não reimprime, só avisa. */
export function replayJaExpedido(r: UnicoSepararResponse): boolean {
  return r.replay === true && r.order.status === "shipped";
}

/** Ordem de exibição dos tamanhos; o que não está aqui vai pro fim. */
export const ORDEM_TAMANHOS = ["PP", "P", "M", "G", "GG", "XG", "XGG", "U"];

/** Compara tamanhos pela posição em `ORDEM_TAMANHOS`; desconhecidos no fim, em ordem alfabética. */
export function ordenarTamanhos(a: string, b: string): number {
  const na = a.trim().toUpperCase();
  const nb = b.trim().toUpperCase();
  const ia = ORDEM_TAMANHOS.indexOf(na);
  const ib = ORDEM_TAMANHOS.indexOf(nb);
  if (ia >= 0 && ib >= 0) return ia - ib;
  if (ia >= 0) return -1;
  if (ib >= 0) return 1;
  return na.localeCompare(nb);
}

/** Texto do botão Order bump: "Order bump: A, B" ou "desligado". */
export function rotuloOrderBump(ob: OrderBumpConfig | null | undefined): string {
  if (!ob || !ob.ativo) return "Order bump: desligado";
  const nomes = ob.produtos.map((p) => p.nome).join(", ");
  return nomes ? `Order bump: ${nomes}` : "Order bump: ativo";
}

const SEPARADORES = /^[\s\-–—·|/:,]+|[\s\-–—·|/:,]+$/g;

/** Caractere a caractere, pra o índice do texto normalizado bater com o original. */
function normalizarPorChar(s: string): string {
  let out = "";
  for (const c of s) {
    const n = c.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    out += n.length === 1 ? n : c.toLowerCase().slice(0, 1) || c;
  }
  return out;
}

/**
 * Tipo da peça sem a estampa e sem separadores soltos:
 * "Oversized - Legends" (estampa "Legends") → "Oversized". Sobrou nada → o nome inteiro.
 */
export function tipoBaseDoProduto(produtoNome: string, estampa: string): string {
  const nome = produtoNome.trim();
  const alvo = normalizarPorChar(estampa).trim();
  let base = nome;
  if (alvo) {
    const i = normalizarPorChar(nome).indexOf(alvo);
    if (i >= 0) base = nome.slice(0, i) + " " + nome.slice(i + alvo.length);
  }
  base = base.replace(/\s+/g, " ").replace(SEPARADORES, "").trim();
  return base || nome;
}

/** "Oversized · Preto" (sem cor: só "Oversized"). */
export function rotuloTipo(tipo: Pick<UnicoTipo, "produtoNome" | "cor">, estampa: string): string {
  const base = tipoBaseDoProduto(tipo.produtoNome, estampa);
  const cor = tipo.cor?.trim();
  return cor ? `${base} · ${cor}` : base;
}

/** Um tipo só → "Oversized · Preto"; vários → "Oversized · Preto 8 · Poliamida · Azul 2". */
export function rotuloTipos(tipos: UnicoTipo[], estampa: string): string {
  if (tipos.length === 0) return "";
  if (tipos.length === 1) return rotuloTipo(tipos[0], estampa);
  return tipos.map((t) => `${rotuloTipo(t, estampa)} ${t.pedidos}`).join(" · ");
}

/** Soma os tipos de vários grupos por produto + cor, mais pedidos primeiro. */
export function somarTipos(grupos: UnicoGrupo[]): UnicoTipo[] {
  const mapa = new Map<string, UnicoTipo>();
  for (const g of grupos) {
    for (const t of g.tipos ?? []) {
      const chave = `${t.produtoId}|${(t.cor ?? "").trim().toLowerCase()}`;
      const atual = mapa.get(chave);
      if (atual) {
        atual.pedidos += t.pedidos;
        if (!atual.imagemUrl && t.imagemUrl) atual.imagemUrl = t.imagemUrl;
      } else {
        mapa.set(chave, { ...t });
      }
    }
  }
  return Array.from(mapa.values()).sort((a, b) => b.pedidos - a.pedidos);
}

/** Tipos de uma estampa (todos os tamanhos) e a foto do dominante (senão a do grupo). */
export function tiposDaEstampa(grupos: UnicoGrupo[]): { tipos: UnicoTipo[]; imagemUrl: string | null } {
  const tipos = somarTipos(grupos);
  const imagemUrl = tipos.find((t) => t.imagemUrl)?.imagemUrl ?? grupos.find((g) => g.imagemUrl)?.imagemUrl ?? null;
  return { tipos, imagemUrl };
}

export type EstampaAgrupada = {
  estampa: string;
  imagemUrl: string | null;
  /** Tipos de peça da estampa (todos os tamanhos), mais pedidos primeiro. */
  tipos: UnicoTipo[];
  pedidos: number;
  prioritarios: number;
  comOrderBump: number;
  /** Os grupos originais da estampa, na ordem PP…U. */
  tamanhos: UnicoGrupo[];
};

/** Agrupa os grupos estampa × tamanho por estampa, mantendo a ordem de primeira aparição. */
export function agruparPorEstampa(grupos: UnicoGrupo[]): EstampaAgrupada[] {
  const mapa = new Map<string, EstampaAgrupada>();
  for (const g of grupos) {
    let e = mapa.get(g.estampa);
    if (!e) {
      e = { estampa: g.estampa, imagemUrl: null, tipos: [], pedidos: 0, prioritarios: 0, comOrderBump: 0, tamanhos: [] };
      mapa.set(g.estampa, e);
    }
    e.pedidos += g.pedidos;
    e.prioritarios += g.prioritarios ?? 0;
    e.comOrderBump += g.comOrderBump ?? 0;
    e.tamanhos.push(g);
  }
  const lista = Array.from(mapa.values());
  for (const e of lista) {
    e.tamanhos.sort((a, b) => ordenarTamanhos(a.tamanho, b.tamanho));
    const t = tiposDaEstampa(e.tamanhos);
    e.tipos = t.tipos;
    e.imagemUrl = t.imagemUrl;
  }
  return lista;
}

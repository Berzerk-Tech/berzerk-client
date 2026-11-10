// Pedidos de reposição pela mesa (nexus 10/11, `/reposicao/pedidos`): a separadora
// pede peças pros repositores direto da tela de Separação, só pro tamanho da
// fila em que está. Tipos replicados do contrato zod do nexus (o client não
// importa aquele pacote).
//
// Nexus antigo responde 404 nestas rotas e quem não tem `reposicao:pedir`
// recebe 403: nos dois casos o recurso simplesmente não existe pra esta
// estação (`null`/`sem_suporte`), nunca erro na tela.

import { ApiError, apiRequest } from "../lib/api";

export const TAMANHOS_REPOSICAO = ["P", "M", "G", "GG", "XG"] as const;
export type TamanhoReposicao = (typeof TAMANHOS_REPOSICAO)[number];

/** Pedidos vêm em múltiplos desta quantidade. */
export const PACOTE_REPOSICAO = 10;

export type CorReposicao = "preta" | "off" | "colorida";

export type ItemCatalogoReposicao = {
  produtoId: string;
  nome: string;
  nomeCurto: string;
  imagemUrl: string | null;
  grupo: string;
  cor: CorReposicao;
  corIndefinida: boolean;
  picking: number;
  limite: number;
  pendenteQtd: number;
  pendentePedidos: number;
  faltaQtd: number;
  estado: "ativo" | "sem_picking" | "inativado";
  fixado: boolean;
};

export type LimitesReposicao = {
  /** 0 = sem teto. */
  porPessoa: number;
  pendentesMeus: number;
  fila: number;
  pendentesFila: number;
};

export type CatalogoReposicao = {
  tamanho: TamanhoReposicao;
  atualizadoEm: string;
  pickingDisponivel: boolean;
  itens: ItemCatalogoReposicao[];
  minhaFila?: { tamanhos: TamanhoReposicao[] };
  limites?: LimitesReposicao;
};

export type LinhaPedidoReposicao = {
  id: string;
  produtoId: string;
  nome: string;
  imagemUrl: string | null;
  cor: CorReposicao;
  tamanho: TamanhoReposicao;
  qtd: number;
  status: "pendente" | "atendido" | "cancelado";
  criadoEm: string;
  atendidoEm: string | null;
  atendidoPorNome: string | null;
  falta: boolean;
  faltaEm: string | null;
  faltaPorNome: string | null;
};

export type MeusPedidosReposicao = {
  /** Relógio do servidor no momento da resposta. */
  agora: string;
  /** `agora` do servidor − relógio local ao receber (relógio de estação costuma estar errado). */
  deslocamentoMs?: number;
  pendentes: LinhaPedidoReposicao[];
  atendidos24h: LinhaPedidoReposicao[];
};

export type ItemPedidoReposicao = { produtoId: string; tamanho: TamanhoReposicao; qtd: number };

/** Corpos dos 409 do `POST /reposicao/pedidos` (código em `error`). */
export type ErroPedidoReposicao =
  | { error: "limite"; message?: string; produtoId: string; tamanho: TamanhoReposicao; limite: number; pendente: number }
  | { error: "fora_da_fila"; message?: string; tamanhos: TamanhoReposicao[] }
  | { error: "limite_pessoa"; message?: string; limite: number; pendentes: number }
  | { error: "fila_cheia"; message?: string; limite: number; pendentes: number }
  | { error: "produto_inativo"; message?: string; produtoId: string };

const SEM_SUPORTE = new Set([403, 404]);

function semSuporte(e: unknown): boolean {
  return e instanceof ApiError && SEM_SUPORTE.has(e.status);
}

function corpoErro(e: unknown): Record<string, unknown> | null {
  if (!(e instanceof ApiError) || e.status !== 409 || !e.body || typeof e.body !== "object") return null;
  return e.body as Record<string, unknown>;
}

export function ehTamanhoReposicao(t: unknown): t is TamanhoReposicao {
  return typeof t === "string" && (TAMANHOS_REPOSICAO as readonly string[]).includes(t);
}

function tamanhosDe(v: unknown): TamanhoReposicao[] {
  return Array.isArray(v) ? v.filter(ehTamanhoReposicao) : [];
}

export type ResultadoCatalogo =
  | { kind: "ok"; catalogo: CatalogoReposicao }
  | { kind: "fora_da_fila"; tamanhos: TamanhoReposicao[] }
  | { kind: "sem_suporte" };

export async function getCatalogoReposicao(tamanho: TamanhoReposicao): Promise<ResultadoCatalogo> {
  try {
    const c = await apiRequest<CatalogoReposicao>("/reposicao/pedidos/catalogo", { query: { tamanho } });
    return { kind: "ok", catalogo: { ...c, itens: Array.isArray(c.itens) ? c.itens : [] } };
  } catch (e) {
    if (semSuporte(e)) return { kind: "sem_suporte" };
    const b = corpoErro(e);
    if (b?.error === "fora_da_fila") return { kind: "fora_da_fila", tamanhos: tamanhosDe(b.tamanhos) };
    throw e;
  }
}

/** `null` = sem suporte (404/403). */
export async function getMeusPedidosReposicao(): Promise<MeusPedidosReposicao | null> {
  try {
    const m = await apiRequest<MeusPedidosReposicao>("/reposicao/pedidos/meus");
    const servidor = Date.parse(m.agora);
    return {
      agora: m.agora,
      deslocamentoMs: Number.isNaN(servidor) ? 0 : servidor - Date.now(),
      pendentes: Array.isArray(m.pendentes) ? m.pendentes : [],
      atendidos24h: Array.isArray(m.atendidos24h) ? m.atendidos24h : [],
    };
  } catch (e) {
    if (semSuporte(e)) return null;
    throw e;
  }
}

export type ResultadoCriar =
  | { kind: "ok"; pedidos: { id: string; produtoId: string; tamanho: TamanhoReposicao; qtd: number }[] }
  | { kind: "erro"; erro: ErroPedidoReposicao }
  | { kind: "sem_suporte" };

/**
 * `idempotencyKey`: uma por tentativa de envio do carrinho, REUSADA em qualquer
 * reenvio do mesmo carrinho (o servidor devolve os mesmos pedidos, sem duplicar).
 */
export async function criarPedidosReposicao(itens: ItemPedidoReposicao[], idempotencyKey?: string): Promise<ResultadoCriar> {
  try {
    const r = await apiRequest<{ pedidos: { id: string; produtoId: string; tamanho: TamanhoReposicao; qtd: number }[] }>(
      "/reposicao/pedidos",
      { method: "POST", body: idempotencyKey ? { itens, idempotencyKey } : { itens } },
    );
    return { kind: "ok", pedidos: Array.isArray(r?.pedidos) ? r.pedidos : [] };
  } catch (e) {
    if (semSuporte(e)) return { kind: "sem_suporte" };
    const b = corpoErro(e);
    const codigo = b?.error;
    if (b && (codigo === "limite" || codigo === "produto_inativo" || codigo === "fora_da_fila" || codigo === "limite_pessoa" || codigo === "fila_cheia")) {
      return { kind: "erro", erro: { ...b, tamanhos: tamanhosDe(b.tamanhos) } as unknown as ErroPedidoReposicao };
    }
    throw e;
  }
}

/** Cancela pedidos dela ainda pendentes. Devolve quantos foram cancelados. */
export async function cancelarPedidosReposicao(ids: string[]): Promise<number> {
  const r = await apiRequest<{ cancelados?: number }>("/reposicao/pedidos/cancelar", {
    method: "POST",
    body: { ids },
  });
  return r?.cancelados ?? 0;
}

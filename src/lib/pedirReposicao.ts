// Pedir reposição pela mesa — regras puras (limites, ordenação, textos).
// Tela: components/PedirReposicaoModal.tsx. Serviço: services/reposicaoPedidos.ts.

import type { Order } from "../services/orders";
import {
  PACOTE_REPOSICAO,
  type CatalogoReposicao,
  type ErroPedidoReposicao,
  type ItemCatalogoReposicao,
  type LimitesReposicao,
  type MeusPedidosReposicao,
} from "../services/reposicaoPedidos";
import { produtoDe } from "./mistos";

/** Teto de um card quando o picking não respondeu (o servidor decide). */
const TETO_SEM_PICKING = 10_000;

/** Só entra na lista o produto ativo com necessidade (ou, sem picking, todos os ativos). */
export function itensPediveis(c: Pick<CatalogoReposicao, "itens" | "pickingDisponivel">): ItemCatalogoReposicao[] {
  return c.itens.filter((i) => i.estado === "ativo" && (!c.pickingDisponivel || i.picking > 0));
}

/** Quanto ainda dá pra pedir deste produto (múltiplo de 10, nunca negativo). */
export function maximoDoCard(item: ItemCatalogoReposicao, pickingDisponivel: boolean): number {
  if (!pickingDisponivel) return TETO_SEM_PICKING;
  const folga = item.limite - item.pendenteQtd;
  return Math.max(0, Math.floor(folga / PACOTE_REPOSICAO) * PACOTE_REPOSICAO);
}

/** Carrinho: produtoId → peças (múltiplos de 10). */
export type Carrinho = Record<string, number>;

export function somarPacote(carrinho: Carrinho, item: ItemCatalogoReposicao, pickingDisponivel: boolean): Carrinho {
  const atual = carrinho[item.produtoId] ?? 0;
  if (atual + PACOTE_REPOSICAO > maximoDoCard(item, pickingDisponivel)) return carrinho;
  return { ...carrinho, [item.produtoId]: atual + PACOTE_REPOSICAO };
}

export function tirarPacote(carrinho: Carrinho, produtoId: string): Carrinho {
  const atual = carrinho[produtoId] ?? 0;
  const { [produtoId]: _, ...resto } = carrinho;
  return atual - PACOTE_REPOSICAO > 0 ? { ...resto, [produtoId]: atual - PACOTE_REPOSICAO } : resto;
}

/** Catálogo novo: encosta o carrinho no novo máximo e tira o que sumiu/zerou. */
export function ajustarCarrinho(carrinho: Carrinho, c: Pick<CatalogoReposicao, "itens" | "pickingDisponivel">): Carrinho {
  const porId = new Map(c.itens.map((i) => [i.produtoId, i]));
  const novo: Carrinho = {};
  let mudou = false;
  for (const [id, qtd] of Object.entries(carrinho)) {
    const item = porId.get(id);
    const max = item && item.estado === "ativo" ? maximoDoCard(item, c.pickingDisponivel) : 0;
    const q = Math.min(qtd, max);
    if (q > 0) novo[id] = q;
    if (q !== qtd) mudou = true;
  }
  return mudou ? novo : carrinho;
}

export function totaisDoCarrinho(carrinho: Carrinho): { itens: number; pecas: number } {
  const qtds = Object.values(carrinho);
  return { itens: qtds.length, pecas: qtds.reduce((a, q) => a + q, 0) };
}

/**
 * Teto pessoal: cada produto do carrinho vira um pedido em aberto. `0`/ausente
 * = sem teto. `excede` bloqueia o envio.
 */
export function situacaoDoTeto(
  limites: LimitesReposicao | undefined,
  itensNoCarrinho: number,
): { mostrar: boolean; texto: string; excede: boolean } {
  if (!limites || limites.porPessoa <= 0) return { mostrar: false, texto: "", excede: false };
  const excede = limites.pendentesMeus + itensNoCarrinho > limites.porPessoa;
  const livres = Math.max(0, limites.porPessoa - limites.pendentesMeus);
  const base = `Você tem ${limites.pendentesMeus} de ${limites.porPessoa} pedidos em aberto.`;
  return {
    mostrar: true,
    excede,
    texto: excede
      ? `${base} Dá pra pedir mais ${livres} ${livres === 1 ? "produto" : "produtos"} agora; tire ${itensNoCarrinho - livres} do pedido ou espere a reposição chegar.`
      : base,
  };
}

/** Normaliza nome pra casar produto do pedido com o do catálogo (sem acento/caixa/tamanho). */
export function chaveDeProduto(nome: string, tamanho?: string | null): string {
  return produtoDe(nome, tamanho)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Chaves dos produtos dos pedidos que ela tem na mesa, no tamanho pedido. */
export function chavesDaMesa(pedidos: readonly Order[], tamanho: string): Set<string> {
  const s = new Set<string>();
  for (const o of pedidos) {
    for (const it of o.items) {
      if ((it.tamanho ?? "").toUpperCase() !== tamanho.toUpperCase()) continue;
      const nome = it.produto ?? it.nome;
      if (nome) s.add(chaveDeProduto(nome, it.tamanho));
    }
  }
  return s;
}

export function estaNaMesa(item: ItemCatalogoReposicao, chaves: ReadonlySet<string>, tamanho: string): boolean {
  if (chaves.size === 0) return false;
  return chaves.has(chaveDeProduto(item.nome, tamanho)) || chaves.has(chaveDeProduto(item.nomeCurto, tamanho));
}

function semAcento(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Filtra pela busca e ordena: os da mesa primeiro (picking desc), depois por nome. */
export function ordenarItens(
  itens: ItemCatalogoReposicao[],
  opts: { busca: string; chavesMesa: ReadonlySet<string>; tamanho: string },
): ItemCatalogoReposicao[] {
  const termo = semAcento(opts.busca).trim();
  const lista = termo
    ? itens.filter((i) => semAcento(`${i.nome} ${i.nomeCurto}`).includes(termo))
    : itens.slice();
  const naMesa = (i: ItemCatalogoReposicao) => estaNaMesa(i, opts.chavesMesa, opts.tamanho);
  return lista.sort((a, b) => {
    const ma = naMesa(a);
    const mb = naMesa(b);
    if (ma !== mb) return ma ? -1 : 1;
    if (ma && mb && a.picking !== b.picking) return b.picking - a.picking;
    return a.nomeCurto.localeCompare(b.nomeCurto, "pt-BR");
  });
}

/** Texto do 409 em linguagem simples. */
export function mensagemDoErro(e: ErroPedidoReposicao): string {
  switch (e.error) {
    case "limite":
      return "Alguém já pediu esse produto. O máximo foi ajustado; confira o pedido e envie de novo.";
    case "fila_cheia":
      return "Os repositores estão com a fila cheia. Tente de novo em alguns minutos.";
    case "limite_pessoa":
      return `Você já tem ${e.pendentes} ${e.pendentes === 1 ? "pedido" : "pedidos"} em aberto. Espere a reposição chegar.`;
    case "produto_inativo":
      return "Este produto não está mais disponível pra pedido.";
    case "fora_da_fila":
      return "Você só pode pedir reposição do tamanho da fila em que está separando.";
    case "chave_em_uso":
      return "Não deu pra confirmar este pedido. Confira em Meus pedidos antes de enviar de novo.";
  }
}

/** Relógio do servidor: `Date.now()` corrigido pelo deslocamento medido na última resposta de "meus". */
export function agoraDoServidor(m: Pick<MeusPedidosReposicao, "deslocamentoMs"> | null | undefined, relogioMs: number): number {
  return relogioMs + (m?.deslocamentoMs ?? 0);
}

/** Assinatura estável do carrinho (tamanho + itens), pra saber se mudou desde a última chave. */
export function assinaturaDoCarrinho(tamanho: string, carrinho: Carrinho): string {
  return `${tamanho}|${Object.entries(carrinho).sort(([a], [b]) => a.localeCompare(b)).map(([id, q]) => `${id}:${q}`).join(",")}`;
}

/** "há 3 min", "agora", "há 2 h". */
export function rotuloHa(iso: string | null | undefined, agoraMs: number): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const min = Math.max(0, Math.floor((agoraMs - t) / 60_000));
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  return `há ${Math.floor(h / 24)} d`;
}

/** Reposto nos últimos N min conta como "acabou de chegar" no botão. */
export const JANELA_REPOSTO_RECENTE_MIN = 10;

export type ResumoMeus = {
  pendentes: number;
  falta: number;
  repostoRecente: number;
  /** O que o botão destaca (falta vence). */
  destaque: "falta" | "reposto" | null;
};

export function resumoDosMeus(m: MeusPedidosReposicao | null, agoraMs: number): ResumoMeus {
  if (!m) return { pendentes: 0, falta: 0, repostoRecente: 0, destaque: null };
  const falta = m.pendentes.filter((p) => p.falta).length;
  const repostoRecente = m.atendidos24h.filter((p) => {
    const t = p.atendidoEm ? Date.parse(p.atendidoEm) : NaN;
    return !Number.isNaN(t) && agoraMs - t <= JANELA_REPOSTO_RECENTE_MIN * 60_000;
  }).length;
  return {
    pendentes: m.pendentes.length,
    falta,
    repostoRecente,
    destaque: falta > 0 ? "falta" : repostoRecente > 0 ? "reposto" : null,
  };
}

/** Tamanho inicial a consultar: o da fila da mesa, se for um dos cinco. */
export function tamanhoInicial(queue: { size: string; sizes?: string[] }, validos: readonly string[]): string | null {
  const cand = [queue.size, ...(queue.sizes ?? [])].map((s) => s.toUpperCase());
  return cand.find((s) => validos.includes(s)) ?? null;
}

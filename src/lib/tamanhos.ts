/** Ordem de exibição dos tamanhos; o que não está aqui vai pro fim. Régua única do client. */
export const ORDEM_TAMANHOS = ["PP", "P", "M", "G", "GG", "XG", "XXG", "XGG", "G1", "G2", "G3", "U"];

/** Posição do tamanho na régua; desconhecido (ou vazio) = `Infinity`. */
export function posicaoTamanho(t: string | null | undefined): number {
  const i = ORDEM_TAMANHOS.indexOf((t ?? "").trim().toUpperCase());
  return i >= 0 ? i : Number.POSITIVE_INFINITY;
}

/** Compara tamanhos pela régua; desconhecidos no fim, em ordem alfabética. */
export function compararTamanhos(a: string, b: string): number {
  const na = a.trim().toUpperCase();
  const nb = b.trim().toUpperCase();
  const ia = posicaoTamanho(na);
  const ib = posicaoTamanho(nb);
  if (ia !== ib) return ia < ib ? -1 : 1;
  return na.localeCompare(nb);
}

/**
 * Ordena por tamanho de forma ESTÁVEL: mesmo tamanho mantém a ordem original;
 * desconhecido/sem tamanho vai pro fim (também na ordem original). Não muta.
 */
export function ordenarPorTamanho<T>(itens: readonly T[], tamanhoDe: (item: T) => string | null | undefined): T[] {
  return itens
    .map((item, i) => ({ item, i, p: posicaoTamanho(tamanhoDe(item)) }))
    .sort((a, b) => (a.p === b.p ? a.i - b.i : a.p < b.p ? -1 : 1))
    .map((x) => x.item);
}

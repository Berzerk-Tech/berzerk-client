// Exclusão do galpão por TAMANHO: a chave de um item é produto + tamanho
// (`null` = todos os tamanhos). Funções puras, usadas pelo PickingFiltersModal.

import type { ExclusaoGlobal } from "../services/exclusoesGlobais";

export type SelGlobal = { produto: string; tamanho: string | null };

export const TODOS_TAMANHOS = "Todos os tamanhos";

export const chaveGlobal = (produto: string, tamanho: string | null | undefined): string =>
  `${produto.trim().toLowerCase()}|${(tamanho ?? "").trim().toUpperCase()}`;

export const selDeTermos = (termos: ExclusaoGlobal[]): SelGlobal[] =>
  termos.map((t) => ({ produto: t.produto ?? t.termo, tamanho: t.tamanho ?? null }));

export const temSel = (l: SelGlobal[], produto: string, tamanho: string | null): boolean =>
  l.some((x) => chaveGlobal(x.produto, x.tamanho) === chaveGlobal(produto, tamanho));

/** Tem alguma exclusão (de qualquer tamanho) deste produto? */
export const temTermo = (l: SelGlobal[], produto: string): boolean =>
  l.some((x) => x.produto.trim().toLowerCase() === produto.trim().toLowerCase());

/**
 * Diff contra o que a tela carregou, por produto + tamanho: só o que esta estação
 * mudou vai pro servidor. "Moletom|P" entrar não toca em "Moletom|todos".
 */
export function diffGlobal(base: SelGlobal[], sel: SelGlobal[]): { entraram: SelGlobal[]; sairam: SelGlobal[] } {
  const b = new Set(base.map((x) => chaveGlobal(x.produto, x.tamanho)));
  const s = new Set(sel.map((x) => chaveGlobal(x.produto, x.tamanho)));
  return {
    entraram: sel.filter((x) => !b.has(chaveGlobal(x.produto, x.tamanho))),
    sairam: base.filter((x) => !s.has(chaveGlobal(x.produto, x.tamanho))),
  };
}

/** Item do servidor que corresponde a um produto + tamanho (pra achar o id na remoção). */
export const acharGlobal = (termos: ExclusaoGlobal[], produto: string, tamanho: string | null): ExclusaoGlobal | undefined =>
  termos.find((t) => chaveGlobal(t.produto ?? t.termo, t.tamanho) === chaveGlobal(produto, tamanho));

/**
 * Corpo do POST de um item que entrou: com API sem `aceitaTamanho` o tamanho
 * nunca vai (comportamento antigo: termo único, todos os tamanhos).
 */
export const tamanhoParaEnvio = (aceitaTamanho: boolean | undefined, tamanho: string | null): string | null =>
  aceitaTamanho ? tamanho : null;

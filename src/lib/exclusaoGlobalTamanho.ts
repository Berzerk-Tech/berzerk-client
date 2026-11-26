// Exclusão do galpão por TAMANHO: a chave de um item é produto + tamanho
// (`null` = todos os tamanhos). Funções puras, usadas pelo PickingFiltersModal.

import type { ExclusaoGlobal, ExclusoesGlobais, NivelExclusao } from "../services/exclusoesGlobais";

export type SelGlobal = { produto: string; tamanho: string | null; /** Nível da marcação nova (só com `aceitaNivel`). */ nivel?: NivelExclusao };

export const TODOS_TAMANHOS = "Todos os tamanhos";

export const chaveGlobal = (produto: string, tamanho: string | null | undefined): string =>
  `${produto.trim().toLowerCase()}|${(tamanho ?? "").trim().toUpperCase()}`;

export const selDeTermos = (termos: ExclusaoGlobal[]): SelGlobal[] =>
  termos.map((t) => ({ produto: t.produto ?? t.termo, tamanho: t.tamanho ?? null, ...(t.nivel ? { nivel: t.nivel } : null) }));

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

/**
 * Troca a base (servidor) com o modal aberto sem perder nem ressuscitar nada:
 * sel = (sel que ainda existe no servidor, com a versão dele) ∪ (rascunhos da estação que NÃO estavam
 * na base antiga) ∪ (termos novos do servidor). Termo que saiu do servidor (reposição atendeu, expirou,
 * outra estação tirou) sai do rascunho e não é re-enviado no "Aplicar".
 */
export function fundirComServidor(sel: SelGlobal[], baseAntiga: SelGlobal[], termosNovos: ExclusaoGlobal[]): SelGlobal[] {
  const k = (x: SelGlobal) => chaveGlobal(x.produto, x.tamanho);
  const novos = new Map(selDeTermos(termosNovos).map((x) => [k(x), x]));
  const antiga = new Set(baseAntiga.map(k));
  const out: SelGlobal[] = [];
  const vistos = new Set<string>();
  for (const x of sel) {
    const n = novos.get(k(x));
    if (n) out.push(n);
    else if (!antiga.has(k(x))) out.push(x);
    else continue;
    vistos.add(k(x));
  }
  for (const [chave, n] of novos) if (!vistos.has(chave) && !antiga.has(chave)) out.push(n);
  return out;
}

/**
 * Nível enviado numa marcação NOVA. Sem `aceitaNivel` (nexus antigo): nada (corpo de sempre).
 * Quem não é supervisor marca sempre `bancada`; a supervisão usa o que escolheu.
 */
export const nivelParaEnvio = (
  g: Pick<ExclusoesGlobais, "aceitaNivel" | "podeMarcarFabrica"> | null | undefined,
  escolhido: NivelExclusao,
): NivelExclusao | undefined => (g?.aceitaNivel ? (g.podeMarcarFabrica ? escolhido : "bancada") : undefined);

/**
 * Esta estação pode tirar o item do galpão? Sem tamanho/nível no nexus: tudo ou nada
 * (`soLeitura`). Com eles: `podeRemover` do servidor por termo, e termo "fábrica" só
 * a supervisão tira (defesa se o servidor não mandar `podeRemover`). Item ainda não salvo: pode.
 */
export function podeTirarItem(
  g: ExclusoesGlobais | null | undefined,
  x: SelGlobal,
  soLeitura: boolean,
): boolean {
  if (!g?.aceitaTamanho && !g?.aceitaNivel) return !soLeitura;
  const t = acharGlobal(g.termos, x.produto, x.tamanho);
  if (!t) return true;
  if (t.podeRemover === false) return false;
  if (g.aceitaNivel && t.nivel === "fabrica" && t.podeRemover === undefined && !g.podeMarcarFabrica) return false;
  return true;
}

/** Quantos produtos distintos da seleção têm termo "fábrica" salvo (rodapé "N no galpão (X fábrica)"). */
export function contarFabrica(sel: SelGlobal[], g: ExclusoesGlobais | null | undefined): number {
  if (!g?.aceitaNivel) return 0;
  const vistos = new Set<string>();
  for (const x of sel) {
    const t = acharGlobal(g.termos, x.produto, x.tamanho);
    if ((t?.nivel ?? x.nivel) === "fabrica") vistos.add(x.produto.trim().toLowerCase());
  }
  return vistos.size;
}

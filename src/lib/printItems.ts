// Núcleo puro de "EAN + quantidade por tamanho → itens de impressão",
// extraído de `buildPrintItems` (src/services/batches.ts) pra ser reaproveitado
// pela impressão AVULSA (produto sem lote — ver NEXUS_ETIQUETAGEM_AVULSA.md).
//
// A função NÃO sabe nada de lote nem de catálogo: quem chama já resolveu
// EAN/SKU/quantidade por tamanho e só passa como montar a descrição impressa.

import { compareSizes } from "./grade";
import type { PrintJobItem } from "./itag/iprint";

export type SizeEntry = {
  size: string;
  quantity: number;
  ean13: string | null;
  sku: string | null;
};

export type BuildItemsOptions = {
  /**
   * true = também descarta tamanho com quantidade 0 (ou negativa). Usado só
   * pela tela AVULSA, onde a operadora digita a quantidade — deixar linhas
   * zeradas de fora evita item vazio no job.
   *
   * O fluxo POR LOTE não passa isto: a grade do lote já vem sem entradas
   * zeradas (`parseGrade` descarta quantidade 0), e o filtro original aqui
   * era só por EAN — manter o default `false` garante que `buildPrintItems`
   * fique byte a byte como antes da extração (review 22/09: o filtro de
   * quantidade tinha vazado pro núcleo compartilhado e mudava esse
   * comportamento sem necessidade).
   */
  descartarZeros?: boolean;
};

function temEan(e: SizeEntry): e is SizeEntry & { ean13: string } {
  return !!e.ean13;
}

function temEanEQuantidade(e: SizeEntry): e is SizeEntry & { ean13: string } {
  return !!e.ean13 && e.quantity > 0;
}

/**
 * Monta os itens de impressão a partir de uma linha por tamanho (EAN/SKU) e
 * da quantidade escolhida pra cada tamanho.
 *
 * Regras:
 *  - tamanho sem EAN nunca entra (não tem o que gravar no `ean13` do item);
 *  - com `descartarZeros: true`, quantidade 0 (ou negativa) também fica de
 *    fora (ver `BuildItemsOptions`);
 *  - ordem final é a canônica de tamanho (`compareSizes`, "U" incluso) — é a
 *    ordem que a iTAG imprime e que o servidor usa pra casar EPC↔tamanho.
 */
export function buildItemsFromEans(
  entries: SizeEntry[],
  describe: (size: string) => string,
  opts: BuildItemsOptions = {},
): PrintJobItem[] {
  const filtro = opts.descartarZeros ? temEanEQuantidade : temEan;
  return entries
    .filter(filtro)
    .slice()
    .sort((a, b) => compareSizes(a.size, b.size))
    .map((e) => ({
      size: e.size,
      quantity: e.quantity,
      ean13: e.ean13,
      sku: e.sku ?? e.ean13,
      description: describe(e.size),
    }));
}

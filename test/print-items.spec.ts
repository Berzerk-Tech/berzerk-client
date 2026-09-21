// Núcleo puro de "EAN + quantidade por tamanho → itens de impressão"
// (src/lib/printItems.ts), extraído de buildPrintItems (por lote) pra ser
// reaproveitado pela impressão avulsa (por produto). Ver NEXUS_ETIQUETAGEM_AVULSA.md.
import { describe, expect, it } from "vitest";
import { buildItemsFromEans, type SizeEntry } from "../src/lib/printItems";
import { compareSizes } from "../src/lib/grade";

const describe1x1 = (size: string) => `Produto - ${size}`;

describe("buildItemsFromEans", () => {
  it("grade normal: monta um item por tamanho, na ordem canônica PP→XXG", () => {
    const entries: SizeEntry[] = [
      { size: "G", quantity: 10, ean13: "111", sku: "s-g" },
      { size: "PP", quantity: 5, ean13: "222", sku: "s-pp" },
      { size: "M", quantity: 8, ean13: "333", sku: "s-m" },
    ];
    const items = buildItemsFromEans(entries, describe1x1);
    expect(items.map((i) => i.size)).toEqual(["PP", "M", "G"]);
    expect(items[0]).toEqual({
      size: "PP",
      quantity: 5,
      ean13: "222",
      sku: "s-pp",
      description: "Produto - PP",
    });
  });

  it("tamanho único 'U': entra normalmente, sem quebrar a ordem", () => {
    const entries: SizeEntry[] = [{ size: "U", quantity: 70, ean13: "999", sku: "sku-u" }];
    const items = buildItemsFromEans(entries, describe1x1);
    expect(items).toEqual([
      { size: "U", quantity: 70, ean13: "999", sku: "sku-u", description: "Produto - U" },
    ]);
  });

  it("tamanho sem EAN fica de fora", () => {
    const entries: SizeEntry[] = [
      { size: "P", quantity: 10, ean13: null, sku: null },
      { size: "M", quantity: 10, ean13: "333", sku: "s-m" },
    ];
    const items = buildItemsFromEans(entries, describe1x1);
    expect(items.map((i) => i.size)).toEqual(["M"]);
  });

  it("com descartarZeros: quantidade 0 fica de fora, mesmo com EAN (uso da tela avulsa)", () => {
    const entries: SizeEntry[] = [
      { size: "P", quantity: 0, ean13: "111", sku: "s-p" },
      { size: "M", quantity: 3, ean13: "222", sku: "s-m" },
    ];
    const items = buildItemsFromEans(entries, describe1x1, { descartarZeros: true });
    expect(items.map((i) => i.size)).toEqual(["M"]);
  });

  it("SEM descartarZeros (default, uso do fluxo por lote): quantidade 0 continua entrando", () => {
    // buildPrintItems (lote) nunca passou `descartarZeros` — a grade do lote
    // já vem sem entradas zeradas (parseGrade descarta qty 0), e o filtro
    // original era só por EAN. O default aqui tem que preservar esse
    // comportamento byte a byte.
    const entries: SizeEntry[] = [
      { size: "P", quantity: 0, ean13: "111", sku: "s-p" },
      { size: "M", quantity: 3, ean13: "222", sku: "s-m" },
    ];
    const items = buildItemsFromEans(entries, describe1x1);
    expect(items.map((i) => i.size)).toEqual(["P", "M"]);
  });

  it("sku ausente cai pro EAN", () => {
    const entries: SizeEntry[] = [{ size: "M", quantity: 1, ean13: "555", sku: null }];
    const items = buildItemsFromEans(entries, describe1x1);
    expect(items[0].sku).toBe("555");
  });
});

describe("compareSizes com 'U'", () => {
  it("'U' não quebra a ordenação da grade normal — fica depois de PP..XXG", () => {
    const sizes = ["G", "U", "PP", "M"];
    expect(sizes.slice().sort(compareSizes)).toEqual(["PP", "M", "G", "U"]);
  });

  it("lista só com 'U' ordena sem erro", () => {
    expect(["U"].slice().sort(compareSizes)).toEqual(["U"]);
  });

  it("'U' fica antes de um tamanho totalmente desconhecido", () => {
    const sizes = ["ZZZ", "U"];
    expect(sizes.slice().sort(compareSizes)).toEqual(["U", "ZZZ"]);
  });
});

// Heurística de "item parecido" pra tag `alheia` na mesa de separação: sem
// isso a operadora lia "peça de OUTRO pedido" e achava bug de vínculo entre
// pedidos quando na verdade era só o produto errado (pedido 869033: leu
// "Oversized - Angel - XG" em vez de "Oversized - Forget Angel - XG").
import { describe, expect, it } from "vitest";
import { itemParecidoDoPedido, itemSize } from "../src/lib/itemParecido";
import type { OrderItem } from "../src/services/orders";

function item(partial: Partial<OrderItem> & { id: string; nome: string }): OrderItem {
  return {
    ean: null,
    sku: null,
    tamanho: null,
    quantidade: 1,
    imagemUrl: null,
    ...partial,
  };
}

describe("itemParecidoDoPedido", () => {
  it("acha o item de mesmo tamanho com mais palavras em comum (caso 869033)", () => {
    const itens = [
      item({ id: "1", nome: "Oversized - Forget Angel - XG", tamanho: "XG" }),
      item({ id: "2", nome: "Oversized - Leg Day - XG", tamanho: "XG" }),
    ];
    const parecido = itemParecidoDoPedido(itens, { name: "Oversized - Angel - XG", size: "XG" });
    expect(parecido?.id).toBe("1");
  });

  it("ignora item de tamanho diferente mesmo com nome idêntico", () => {
    const itens = [item({ id: "1", nome: "Oversized - Angel - XG", tamanho: "M" })];
    const parecido = itemParecidoDoPedido(itens, { name: "Oversized - Angel - XG", size: "XG" });
    expect(parecido).toBeNull();
  });

  it("sem nenhuma palavra em comum, não indica parecido", () => {
    const itens = [item({ id: "1", nome: "Camiseta Basic Preta", tamanho: "XG" })];
    const parecido = itemParecidoDoPedido(itens, { name: "Oversized - Angel - XG", size: "XG" });
    expect(parecido).toBeNull();
  });

  it("sem nome lido, não indica parecido (só o tamanho não basta)", () => {
    const itens = [item({ id: "1", nome: "Oversized - Angel - XG", tamanho: "XG" })];
    const parecido = itemParecidoDoPedido(itens, { name: null, size: "XG" });
    expect(parecido).toBeNull();
  });

  it("sem tamanho lido, não indica parecido", () => {
    const itens = [item({ id: "1", nome: "Oversized - Angel - XG", tamanho: "XG" })];
    const parecido = itemParecidoDoPedido(itens, { name: "Oversized - Angel - XG", size: null });
    expect(parecido).toBeNull();
  });

  it("desempate: escolhe o item com MAIS palavras em comum, não o primeiro", () => {
    const itens = [
      item({ id: "1", nome: "Oversized - Angel - XG", tamanho: "XG" }),
      item({ id: "2", nome: "Oversized - Forget Angel - XG", tamanho: "XG" }),
    ];
    const parecido = itemParecidoDoPedido(itens, {
      name: "Oversized - Forget Angel - XG",
      size: "XG",
    });
    expect(parecido?.id).toBe("2");
  });
});

describe("itemSize", () => {
  it("usa o campo tamanho quando presente", () => {
    expect(itemSize(item({ id: "1", nome: "qualquer", tamanho: "gg" }))).toBe("GG");
  });

  it("extrai do fim do nome quando tamanho vem null (pedido espelhado do legado)", () => {
    expect(itemSize(item({ id: "1", nome: "Oversized - Leg Day - XG" }))).toBe("XG");
  });

  it("sem tamanho identificável, retorna null", () => {
    expect(itemSize(item({ id: "1", nome: "Camiseta Basic Preta" }))).toBeNull();
  });
});

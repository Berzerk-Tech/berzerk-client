import { describe, expect, it } from "vitest";
import { folhasDaReimpressao, type ItemReimpressao } from "../src/lib/reimprimirManual";

const item = (id: string, bump?: { produtoNome: string; tamanho: string | null }): ItemReimpressao => ({
  orderId: id,
  numero: id,
  cliente: null,
  tracking: null,
  comBump: !!bump,
  bump: bump ?? null,
});

describe("reimpressão: sequência de folhas", () => {
  it("sem capa do tamanho: só as etiquetas", () => {
    const f = folhasDaReimpressao([item("1"), item("2")]);
    expect(f.map((x) => x.tipo)).toEqual(["etiqueta", "etiqueta"]);
  });

  it("pedido com bump leva a capa do bloco antes da etiqueta", () => {
    const m = { produtoNome: "Meia", tamanho: "M" };
    const f = folhasDaReimpressao([item("1"), item("2", m), item("3", m)]);
    expect(f.map((x) => x.tipo)).toEqual(["etiqueta", "capaBump", "etiqueta", "etiqueta"]);
  });

  it("reimprimir um pedido com bump só: capa de 1 pedido + etiqueta", () => {
    const f = folhasDaReimpressao([item("9", { produtoNome: "Meia", tamanho: "G" })]);
    expect(f.map((x) => x.tipo)).toEqual(["capaBump", "etiqueta"]);
    expect(f[0].tipo === "capaBump" && f[0].pedidos).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import { conhecidosDoLote, mesclarLote } from "../src/lib/loteParcial";
import type { Order } from "../src/services/orders";

const p = (id: string, v = "v1"): Order => ({ id, updatedAt: v }) as Order;

describe("conhecidosDoLote", () => {
  it("mapeia id e updatedAt e pula pedido sem updatedAt", () => {
    const sem = { id: "c" } as Order;
    expect(conhecidosDoLote([p("a", "x"), sem, p("b", "y")])).toEqual([
      { id: "a", v: "x" },
      { id: "b", v: "y" },
    ]);
  });
});

describe("mesclarLote", () => {
  const atual = [p("a"), p("b"), p("c")];

  it("resposta completa (sem parcial/ids) devolve orders como veio", () => {
    const orders = [p("x")];
    expect(mesclarLote(atual, { orders })).toBe(orders);
    expect(mesclarLote(atual, { orders, ids: ["x", "a"] })).toBe(orders);
    expect(mesclarLote(atual, { orders, parcial: false, ids: ["x"] })).toBe(orders);
  });

  it("parcial: mantém o conhecido, troca o que mudou, remove o que saiu e segue a ordem de ids", () => {
    const b2 = p("b", "v2");
    const d = p("d");
    const r = mesclarLote(atual, { orders: [b2, d], ids: ["d", "c", "b"], parcial: true });
    expect(r?.map((o) => o.id)).toEqual(["d", "c", "b"]);
    expect(r?.[2]).toBe(b2);
    expect(r?.[1]).toBe(atual[2]);
  });

  it("parcial sem nada novo reaproveita o lote em memória", () => {
    expect(mesclarLote(atual, { orders: [], ids: ["c", "a"], parcial: true })).toEqual([atual[2], atual[0]]);
  });

  it("devolve null quando falta id em ambos", () => {
    expect(mesclarLote(atual, { orders: [], ids: ["a", "zzz"], parcial: true })).toBeNull();
  });
});

describe("podeSerParcial", () => {
  it("nunca antes do primeiro lote completo, e só dentro do intervalo", async () => {
    const { podeSerParcial, LOTE_COMPLETO_A_CADA_MS } = await import("../src/lib/loteParcial");
    const agora = 1_800_000_000_000;
    expect(podeSerParcial(agora, 0)).toBe(false);
    expect(podeSerParcial(agora, agora - 1_000)).toBe(true);
    expect(podeSerParcial(agora, agora - LOTE_COMPLETO_A_CADA_MS)).toBe(false);
  });
});

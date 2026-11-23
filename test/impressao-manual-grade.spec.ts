import { describe, expect, it } from "vitest";
import { planoDaGrade, rotuloDaGrade, totalDaGrade } from "../src/lib/impressaoManualGrade";

describe("impressão manual: plano da grade toda", () => {
  it("ordena pela régua canônica de tamanhos e ignora tamanho sem pedido", () => {
    const plano = planoDaGrade([
      { tamanho: "XG", pedidos: 14 },
      { tamanho: "G", pedidos: 38 },
      { tamanho: "GG", pedidos: 16 },
      { tamanho: "P", pedidos: 92 },
      { tamanho: "M", pedidos: 90 },
      { tamanho: "PP", pedidos: 0 },
      { tamanho: "G1", pedidos: 2 },
    ]);
    expect(plano.map((t) => t.tamanho)).toEqual(["P", "M", "G", "GG", "XG", "G1"]);
    expect(totalDaGrade(plano)).toBe(252);
  });

  it("soma tamanho repetido e mostra o rótulo da confirmação", () => {
    const plano = planoDaGrade([
      { tamanho: "P", pedidos: 92 },
      { tamanho: "M", pedidos: 90 },
      { tamanho: "G", pedidos: 38 },
      { tamanho: "GG", pedidos: 16 },
      { tamanho: "XG", pedidos: 14 },
      { tamanho: "P", pedidos: 0 },
    ]);
    expect(rotuloDaGrade(plano)).toBe("P 92 · M 90 · G 38 · GG 16 · XG 14 — 250 pedidos");
    expect(rotuloDaGrade([{ tamanho: "U", pedidos: 1 }])).toBe("U 1 — 1 pedido");
  });

  it("grade vazia dá plano vazio", () => {
    expect(planoDaGrade([])).toEqual([]);
    expect(planoDaGrade([{ tamanho: "P", pedidos: 0 }])).toEqual([]);
  });
});

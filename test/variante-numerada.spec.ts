import { describe, expect, it } from "vitest";
import { corDaVariante, varianteNumerada } from "../src/lib/varianteNumerada";

describe("varianteNumerada", () => {
  it.each([
    ["Oversized Freaky Season - Ganley 1 - P", 1],
    ["Oversized Freaky Season — Ganley 2 — P", 2],
    ["Oversized Freaky Season – Ganley 3 – GG", 3],
    ["Oversized Freaky Season - Ganley 2", 2],
    ["Ganley 1", 1],
    ["Oversized - Ganley 2 GG", 2],
    ["Boné - Ganley 4 - TU", 4],
    ["Boné - Ganley 4 - U", 4],
    ["Boné - Ganley 4 - Único", 4],
  ])("%s → %s", (nome, esperado) => {
    expect(varianteNumerada(nome)).toBe(esperado);
  });

  it.each([
    ["Short Dry Fit 2 em 1"],
    ["Short Dry Fit 2 em 1 - M"],
    ["Camiseta - Legacy 2024 - P"],
    ["Top 10"],
    ["Oversized - 2 - P"],
    ["2"],
    ["Short 2 - Preto - Symbol - G"],
    ["Oversized - Rux - G1"],
    ["Oversized - Rux - G2 - G"],
    ["Oversized - Rux"],
    [""],
    [null],
    [undefined],
  ])("%s → null", (nome) => {
    expect(varianteNumerada(nome as string | null | undefined)).toBeNull();
  });
});

describe("corDaVariante", () => {
  it("1–5 têm cores distintas e fixas", () => {
    const fundos = [1, 2, 3, 4, 5].map((n) => corDaVariante(n).fundo);
    expect(new Set(fundos).size).toBe(5);
    expect(corDaVariante(1).fundo).toBe("#2563eb");
    expect(corDaVariante(2).fundo).toBe("#ea580c");
  });
  it("cobre 1–9", () => {
    for (let n = 1; n <= 9; n++) expect(corDaVariante(n).fundo).toMatch(/^#/);
  });
});

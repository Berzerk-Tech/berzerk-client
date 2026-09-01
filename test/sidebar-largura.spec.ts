// Largura da sidebar da fila: limites e persistência na estação.

import { beforeEach, describe, expect, it } from "vitest";
import {
  LARGURA_MAX,
  LARGURA_MIN,
  LARGURA_PADRAO,
  gravarLarguraSidebar,
  lerLarguraSidebar,
  limitarLargura,
} from "../src/lib/sidebarLargura";

beforeEach(() => localStorage.clear());

describe("limitarLargura", () => {
  it("nunca colapsa nem estoura a tela", () => {
    expect(limitarLargura(0)).toBe(LARGURA_MIN);
    expect(limitarLargura(-50)).toBe(LARGURA_MIN);
    expect(limitarLargura(5000)).toBe(LARGURA_MAX);
    expect(limitarLargura(NaN)).toBe(LARGURA_PADRAO);
  });
  it("arredonda pra inteiro dentro da faixa", () => {
    expect(limitarLargura(400.6)).toBe(401);
  });
});

describe("persistência", () => {
  it("sem nada gravado usa o padrão", () => {
    expect(lerLarguraSidebar()).toBe(LARGURA_PADRAO);
  });
  it("o que a operadora arrastou volta na próxima abertura", () => {
    gravarLarguraSidebar(420);
    expect(lerLarguraSidebar()).toBe(420);
  });
  it("valor corrompido no storage cai no padrão ou na faixa", () => {
    localStorage.setItem("berzerk_separacao_sidebar_largura_v1", "abc");
    expect(lerLarguraSidebar()).toBe(LARGURA_PADRAO);
    localStorage.setItem("berzerk_separacao_sidebar_largura_v1", "99999");
    expect(lerLarguraSidebar()).toBe(LARGURA_MAX);
  });
});

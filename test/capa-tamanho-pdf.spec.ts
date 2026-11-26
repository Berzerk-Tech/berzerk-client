import { describe, expect, it } from "vitest";
import { gerarCapaTamanhoPdf, gerarCapaBumpPdf } from "../src/lib/capaTamanhoPdf";

describe("gerarCapaTamanhoPdf", () => {
  it("gera um PDF de 1 página, não vazio", () => {
    const b64 = gerarCapaTamanhoPdf({ estampa: "Kurabu", cor: "Preto", tamanho: "GG", pedidos: 136, comBump: 5, operador: "ana@berzerk.com.br", quando: new Date(2026, 10, 12, 9, 30) });
    expect(b64.startsWith("JVBERi")).toBe(true);
    expect(b64.length).toBeGreaterThan(500);
    const pdf = Buffer.from(b64, "base64").toString("latin1");
    expect((pdf.match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBe(1);
  });

  it("aceita sem cor, sem bump e tamanho largo", () => {
    expect(gerarCapaTamanhoPdf({ estampa: "Estampa com nome muito comprido para quebrar em duas linhas na capa", tamanho: "XGG", pedidos: 1, comBump: 0 }).length).toBeGreaterThan(500);
  });
});

describe("gerarCapaBumpPdf", () => {
  const paginas = (b64: string) => (atob(b64).match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  it("gera 1 página com produto e tamanho", () => {
    const b64 = gerarCapaBumpPdf({ produtoNome: "Meia Berzerk Cano Alto Preta", tamanho: "m", pedidos: 7, estampa: "BabyMetal", tamanhoGrupo: "p" });
    expect(atob(b64).startsWith("%PDF")).toBe(true);
    expect(paginas(b64)).toBe(1);
  });
  it("aceita tamanho nulo e servidor antigo (sem produto)", () => {
    expect(paginas(gerarCapaBumpPdf({ produtoNome: "Meia", tamanho: null, pedidos: 1, estampa: "X", tamanhoGrupo: "P" }))).toBe(1);
    expect(paginas(gerarCapaBumpPdf({ pedidos: 3, estampa: "X", tamanhoGrupo: "P" }))).toBe(1);
  });
});

describe("tipo de peça na capa", () => {
  const textos = (b64: string) => atob(b64);
  it("imprime o tipo inteiro; sem tipo a capa sai como antes", () => {
    const base = { estampa: "Symbol", tamanho: "GG", pedidos: 3, comBump: 0, quando: new Date(2026, 10, 12, 9, 30) };
    expect(textos(gerarCapaTamanhoPdf({ ...base, tipo: "Poliamida Tech Running" }))).toContain("(Poliamida Tech Running) Tj");
    for (const tipo of [undefined, null, "  "]) {
      expect(textos(gerarCapaTamanhoPdf({ ...base, tipo }))).not.toContain("Poliamida");
    }
  });
  it("tipo longo quebra em até 2 linhas, sem reticências", () => {
    const pdf = textos(gerarCapaTamanhoPdf({ estampa: "Symbol", tamanho: "P", pedidos: 3, comBump: 0, tipo: "Poliamida Tech Running Extra Longo 8 · Algodão Egípcio 2" }));
    expect(pdf).not.toContain("...");
    expect(pdf).toContain("Poliamida");
    expect(pdf).toContain("cio 2)");
  });
  it("tipo longo ou com vários tipos continua em 1 página", () => {
    const b64 = gerarCapaTamanhoPdf({ estampa: "Symbol", tamanho: "P", pedidos: 3, comBump: 0, tipo: "Poliamida Tech Running Extra Longo 8 · Algodão Egípcio Premium 2 · Jersey 1" });
    expect((atob(b64).match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBe(1);
  });
  it("capa de bump aceita tipo", () => {
    const b64 = gerarCapaBumpPdf({ pedidos: 3, estampa: "X", tamanhoGrupo: "P", tipo: "Oversized" });
    expect((atob(b64).match(/\/Type\s*\/Page[^s]/g) ?? []).length).toBe(1);
  });
});

describe("tipo muito longo", () => {
  it("passou de 3 linhas: o excedente vira '+N tipos'", () => {
    const tipos = Array.from({ length: 12 }, (_, i) => `Tipo Comprido Numero ${i + 1} 3`).join(" · ");
    const pdf = atob(gerarCapaTamanhoPdf({ estampa: "X", tamanho: "P", pedidos: 36, comBump: 0, tipo: tipos }));
    expect(pdf).toMatch(/\+\d+ tipos\) Tj/);
    expect(pdf).toContain("Tipo Comprido Numero 1 3");
  });
});

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

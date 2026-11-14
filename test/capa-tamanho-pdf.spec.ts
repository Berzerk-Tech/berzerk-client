import { describe, expect, it } from "vitest";
import { gerarCapaTamanhoPdf } from "../src/lib/capaTamanhoPdf";

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

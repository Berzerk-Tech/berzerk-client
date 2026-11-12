// Etiqueta Zebra do Filtro Mistos: função pura jsPDF → base64.
import { describe, expect, it } from "vitest";
import { gerarMistosPdf } from "../src/lib/mistosPdf";
import type { PickingMisto } from "../src/lib/mistos";

function linha(i: number, total = 10): PickingMisto {
  return {
    produto: `Oversized - Produto bem comprido pra testar a quebra em duas linhas ${i}`,
    imagemUrl: null,
    grade: { P: total - 4, G: 2, GG: 2, XG: 0 },
    total,
    pedidos: 3,
  };
}

function paginas(base64: string): number {
  const pdf = Buffer.from(base64, "base64").toString("latin1");
  return (pdf.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

describe("gerarMistosPdf", () => {
  it("gera um PDF (base64) com 1 produto em 1 página", () => {
    const b64 = gerarMistosPdf({ fila: "M", pedidos: 3, linhas: [linha(1)] });
    expect(b64.startsWith("JVBERi")).toBe(true);
    expect(paginas(b64)).toBe(1);
  });

  it("40 produtos passam de 1 página; consulta também gera", () => {
    const linhas = Array.from({ length: 40 }, (_, i) => linha(i));
    const b64 = gerarMistosPdf({ fila: "M", pedidos: 90, linhas, consulta: true });
    expect(paginas(b64)).toBeGreaterThan(1);
  });

  it("o total das linhas vai pro PDF (somado no rodapé)", () => {
    const b64 = gerarMistosPdf({ fila: "G", pedidos: 2, linhas: [linha(1, 1234), linha(2, 11)] });
    // jsPDF não comprime o stream por padrão: o texto aparece no conteúdo.
    const pdf = Buffer.from(b64, "base64").toString("latin1");
    expect(pdf).toContain("1.245");
  });

  it("lista vazia ainda sai (uma página)", () => {
    expect(paginas(gerarMistosPdf({ fila: "M", pedidos: 0, linhas: [] }))).toBe(1);
  });
});

describe("gerarMistosPdf com PP/G3", () => {
  it("linha com PP e G3 gera o PDF e mostra as caixas extras", () => {
    const l: PickingMisto = { ...linha(1), grade: { P: 1, G: 2, GG: 0, XG: 0, PP: 3, G3: 1 } };
    const pdf = Buffer.from(gerarMistosPdf({ fila: "M", pedidos: 2, linhas: [l, linha(2)] }), "base64").toString("latin1");
    expect(pdf).toContain("(PP)");
    expect(pdf).toContain("(G3)");
  });
  it("sem PP/G3 nenhuma caixa extra", () => {
    const pdf = Buffer.from(gerarMistosPdf({ fila: "M", pedidos: 1, linhas: [linha(1)] }), "base64").toString("latin1");
    expect(pdf).not.toContain("(PP)");
    expect(pdf).not.toContain("(G3)");
  });
});

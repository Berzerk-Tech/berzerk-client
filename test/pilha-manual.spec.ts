import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { capasDeBumpPorPedido, nomeArquivoPilha, sequenciaDaPilha } from "../src/lib/pilhaManual";
import { montarPdfPilha } from "../src/lib/montarPdfPilha";
import { gerarCapaBumpPdf, gerarEtiquetaSimuladaPdf } from "../src/lib/capaTamanhoPdf";
import type { ImpressaoManualPedido } from "../src/services/expedicao";

const ped = (id: string, bump?: { produtoNome: string; tamanho: string | null } | null, comBump = !!bump): ImpressaoManualPedido => ({
  orderId: id, numero: id, cliente: null, tracking: null, emitidoEm: null, comBump, ...(bump !== undefined ? { bump } : {}),
});
const tipos = (l: ReturnType<typeof sequenciaDaPilha>) => l.map((f) => (f.tipo === "etiqueta" ? f.pedido.orderId : f.tipo === "capaBump" ? `B${f.pedidos}:${f.produtoNome}/${f.tamanho}` : "capa"));

describe("sequenciaDaPilha", () => {
  it("sem bump: capa + etiquetas", () => {
    expect(tipos(sequenciaDaPilha([ped("1"), ped("2")]))).toEqual(["capa", "1", "2"]);
  });
  it("bump com 2 tamanhos: uma capa por bloco", () => {
    const m = { produtoNome: "Meia", tamanho: "M" };
    const g = { produtoNome: "Meia", tamanho: "G" };
    const seq = sequenciaDaPilha([ped("1"), ped("2", m), ped("3", m), ped("4", g)]);
    expect(tipos(seq)).toEqual(["capa", "1", "B2:Meia/M", "2", "3", "B1:Meia/G", "4"]);
    expect([...capasDeBumpPorPedido([ped("1"), ped("2", m), ped("3", m), ped("4", g)]).keys()]).toEqual(["2", "4"]);
  });
  it("servidor antigo: bloco único sem produto", () => {
    expect(tipos(sequenciaDaPilha([ped("1"), ped("2", undefined, true), ped("3", undefined, true)]))).toEqual(["capa", "1", "B2:null/null", "2", "3"]);
  });
});

describe("nomeArquivoPilha", () => {
  it("slug sem acento e data", () => {
    expect(nomeArquivoPilha("Estampa Açaí", "GG", new Date(2026, 10, 13, 9, 5))).toBe("unicos-estampa-acai-gg-20261113-0905.pdf");
  });
});

describe("montarPdfPilha", () => {
  it("junta todas as páginas de PDFs e imagens", async () => {
    const duas = await PDFDocument.create();
    duas.addPage([100, 100]);
    duas.addPage([100, 100]);
    const b64Duas = Buffer.from(await duas.save()).toString("base64");
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ).toString("base64");
    const bytes = await montarPdfPilha([
      { tipo: "pdf", base64: gerarCapaBumpPdf({ pedidos: 1, estampa: "X", tamanhoGrupo: "P" }) },
      { tipo: "pdf", base64: b64Duas },
      { tipo: "imagem", base64: png, formato: "png" },
      { tipo: "pdf", base64: gerarEtiquetaSimuladaPdf("1", null) },
    ]);
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(5);
  });
});

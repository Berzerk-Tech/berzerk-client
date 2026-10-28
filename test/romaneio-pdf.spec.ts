// Romaneio da gaiola (A4, duas colunas): função pura jsPDF → base64.
import { describe, expect, it } from "vitest";
import { gerarRomaneioPdf, LINHAS_POR_PAGINA } from "../src/lib/romaneioPdf";
import type { Manifest } from "../src/services/expedicao";

function manifest(n: number): Manifest {
  return {
    id: "m-1",
    manifestNumber: 7,
    manifestDate: "2026-10-15",
    orderCount: n,
    closedAt: "2026-10-15T18:20:00.000Z",
    closedByName: "Maria",
    notes: "Gaiola 12",
    orders: Array.from({ length: n }, (_, i) => ({
      orderId: `o-${i}`,
      tinyOrderNumber: `${800000 + i}`,
      tinyAccount: i % 2 ? "FM" : "JT",
      cliente: `Cliente com nome bem comprido pra testar o corte da coluna ${i}`,
      trackingCode: `BR${String(100000 + i).padStart(9, "0")}JT`,
      printedAt: "2026-10-15T15:04:00.000Z",
    })),
  };
}

function paginas(base64: string): number {
  const pdf = Buffer.from(base64, "base64").toString("latin1");
  return (pdf.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

describe("gerarRomaneioPdf", () => {
  it("gera um PDF (base64) com 1 página pra poucos pedidos e várias pra 350", () => {
    const pequeno = gerarRomaneioPdf({ gaiolaNumero: 12, romaneio: manifest(5) });
    expect(pequeno.startsWith("JVBERi")).toBe(true); // "%PDF"
    expect(paginas(pequeno)).toBe(1);
    const grande = gerarRomaneioPdf({ gaiolaNumero: 12, romaneio: manifest(350) });
    expect(paginas(grande)).toBeGreaterThanOrEqual(3);
    expect(paginas(grande)).toBeLessThanOrEqual(5);
  });

  it("96 pedidos cabem em 1 página com a assinatura (última página divide as colunas ao meio)", () => {
    expect(LINHAS_POR_PAGINA).toBeGreaterThanOrEqual(100);
    expect(paginas(gerarRomaneioPdf({ gaiolaNumero: 12, romaneio: manifest(96) }))).toBe(1);
    // 110 enche a folha; a assinatura vai pra uma segunda.
    expect(paginas(gerarRomaneioPdf({ gaiolaNumero: 12, romaneio: manifest(110) }))).toBe(2);
    // 160 = 110 + 50: a segunda folha fica com 25/25 e a assinatura cabe nela.
    expect(paginas(gerarRomaneioPdf({ gaiolaNumero: 12, romaneio: manifest(160) }))).toBe(2);
  });

  it("romaneio vazio ainda sai (uma página, sem quebrar) e sem número de gaiola", () => {
    const vazio = gerarRomaneioPdf({ gaiolaNumero: null, romaneio: { ...manifest(0), notes: null, closedByName: null } });
    expect(vazio.startsWith("JVBERi")).toBe(true);
    expect(paginas(vazio)).toBe(1);
  });
});

// 0.9.57: o `/separacao/epc-lookup` do nexus diz a `fonte` — `itag_espelho`
// (etiqueta impressa, confiável e cacheável) ou `inventario` (provisório).
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiRequest = vi.fn();
vi.mock("../src/lib/api", async () => {
  const real = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...real, apiRequest: (...a: unknown[]) => apiRequest(...a) };
});

const o = await import("../src/services/orders");

describe("epcLookup — fonte da resolução do nexus (26/10)", () => {
  beforeEach(() => apiRequest.mockReset());

  it("itag_espelho vira itag_espelho; inventario/ausente vira nexus; `nome` vira `name`", async () => {
    apiRequest.mockResolvedValue({
      items: [
        { epc: "A", ean13: "7890005373842", sku: "ALFA-G", size: "G", batchCode: null, nome: "Oversized - Alfa - G", fonte: "itag_espelho" },
        { epc: "B", ean13: "7890005373841", sku: null, size: "M", batchCode: "L1", fonte: "inventario" },
        { epc: "C", ean13: "7890005373843", sku: null, size: null, batchCode: null },
      ],
    });
    const { items } = await o.epcLookup(["A", "B", "C"]);
    expect(items.map((i) => [i.epc, i.fonte, i.name])).toEqual([
      ["A", "itag_espelho", "Oversized - Alfa - G"],
      ["B", "nexus", null],
      ["C", "nexus", null],
    ]);
  });

  it("fonteConfiavel: só iTAG (nuvem ou espelho) dispensa o aviso e entra no cache", () => {
    expect(o.fonteConfiavel("itag")).toBe(true);
    expect(o.fonteConfiavel("itag_espelho")).toBe(true);
    expect(o.fonteConfiavel("nexus")).toBe(false);
    expect(o.fonteConfiavel("sgtin")).toBe(false);
    expect(o.fonteConfiavel(undefined)).toBe(false);
  });

  it("leituraDe leva a fonte pro complete/ship (o nexus cura o inventário com itag_espelho)", () => {
    expect(o.leituraDe("A", { epc: "A", ean13: "1", sku: null, size: "G", batchCode: null, name: "x", fonte: "itag_espelho" }).fonte).toBe(
      "itag_espelho",
    );
  });
});

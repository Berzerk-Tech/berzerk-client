// Data escolhida na tela de seleção das filas: normalização, rótulo, merge com os filtros salvos e
// serialização na contagem (`GET /separacao/queues`).
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  filtrosDaData,
  mesclarFiltrosIniciais,
  normalizarData,
  rotuloDaData,
  somarDias,
} from "../src/lib/dataDaSelecao";

const apiRequest = vi.fn();
vi.mock("../src/lib/api", async () => {
  const real = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...real, apiRequest: (...a: unknown[]) => apiRequest(...a) };
});
const o = await import("../src/services/orders");

describe("dataDaSelecao", () => {
  it("normaliza: lado único vira dia, invertido troca, vazio é null", () => {
    expect(normalizarData({ de: "2026-11-15" })).toEqual({ de: "2026-11-15", ate: "2026-11-15" });
    expect(normalizarData({ de: "2026-11-15", ate: "2026-11-10" })).toEqual({ de: "2026-11-10", ate: "2026-11-15" });
    expect(normalizarData({ de: "lixo" })).toBeNull();
    expect(normalizarData(null)).toBeNull();
  });

  it("rótulo e somarDias", () => {
    expect(rotuloDaData({ de: "2026-11-15", ate: "2026-11-15" })).toBe("15/11");
    expect(rotuloDaData({ de: "2026-11-10", ate: "2026-11-15" })).toBe("10/11 a 15/11");
    expect(rotuloDaData(null)).toBe("");
    expect(somarDias("2026-12-01", -1)).toBe("2026-11-30");
  });

  it("merge: a data da seleção sobrepõe a salva e mantém os outros filtros", () => {
    const salvos = { dateFrom: "2026-11-01", dateTo: "2026-11-01", excludeProducts: ["x"] };
    expect(mesclarFiltrosIniciais(salvos, { de: "2026-11-15", ate: "2026-11-16" })).toEqual({
      dateFrom: "2026-11-15",
      dateTo: "2026-11-16",
      excludeProducts: ["x"],
    });
  });

  it("merge sem data devolve os salvos intactos", () => {
    const salvos = { excludeProducts: ["x"] };
    expect(mesclarFiltrosIniciais(salvos, null)).toBe(salvos);
  });
});

describe("getQueueCounts com data", () => {
  beforeEach(() => apiRequest.mockReset().mockResolvedValue({}));

  it("manda dateFrom/dateTo na query", async () => {
    await o.getQueueCounts(filtrosDaData({ de: "2026-11-10", ate: "2026-11-15" }), "ecommerce");
    const q = apiRequest.mock.calls[0][1].query;
    expect(q.dateFrom).toBe("2026-11-10");
    expect(q.dateTo).toBe("2026-11-15");
  });

  it("sem data: sem dateFrom/dateTo (chamada de antes)", async () => {
    await o.getQueueCounts(filtrosDaData(null), "ecommerce");
    const q = apiRequest.mock.calls[0][1].query;
    expect(q.dateFrom).toBeUndefined();
    expect(q.dateTo).toBeUndefined();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const apiRequest = vi.fn();
vi.mock("../src/lib/api", async () => {
  const real = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...real, apiRequest: (...a: unknown[]) => apiRequest(...a) };
});

import { getUnicosPedidos, separarUnico } from "../src/services/expedicao";

describe("cor no serviço de únicos (undefined omite, null manda vazio)", () => {
  beforeEach(() => apiRequest.mockReset().mockResolvedValue({ pedidos: [] }));

  it("getUnicosPedidos", async () => {
    await getUnicosPedidos("S", "M");
    expect(apiRequest.mock.calls[0][1].query).toEqual({ estampa: "S", tamanho: "M" });
    await getUnicosPedidos("S", "M", null);
    expect(apiRequest.mock.calls[1][1].query).toEqual({ estampa: "S", tamanho: "M", cor: "" });
    await getUnicosPedidos("S", "M", "PRETO");
    expect(apiRequest.mock.calls[2][1].query).toEqual({ estampa: "S", tamanho: "M", cor: "PRETO" });
  });

  it("separarUnico", async () => {
    apiRequest.mockResolvedValue({});
    await separarUnico({ rfidTags: ["A"], estampa: "S", tamanho: "M" });
    expect(apiRequest.mock.calls[0][1].body).not.toHaveProperty("cor");
    await separarUnico({ rfidTags: ["A"], estampa: "S", tamanho: "M", cor: null });
    expect(apiRequest.mock.calls[1][1].body.cor).toBe("");
    await separarUnico({ rfidTags: ["A"], estampa: "S", tamanho: "M", cor: "PRETO" });
    expect(apiRequest.mock.calls[2][1].body.cor).toBe("PRETO");
  });
});

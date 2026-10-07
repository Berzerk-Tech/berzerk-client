// Service de Devoluções: chunk de 200 EPCs e mescla das respostas.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoteItem, LoteResumo } from "../src/services/devolucoes";

const apiRequest = vi.fn();
vi.mock("../src/lib/api", async () => {
  const real = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...real, apiRequest: (...a: unknown[]) => apiRequest(...a) };
});

const { adicionarEpcs, epcsEmOutroLote, removerEpc, listarLotes } = await import("../src/services/devolucoes");
const { ApiError } = await import("../src/lib/api");

function resumo(total: number): LoteResumo {
  return { total, devolviveis: total, naoEncontrados: 0, naoExpedidos: 0, jaDevolvidas: 0 };
}
function item(epc: string): LoteItem {
  return {
    id: epc,
    epc,
    situacao: "devolvida",
    orderId: "o1",
    orderNumber: "1",
    sku: "SKU",
    tamanho: "M",
    ean13: null,
    varianteId: null,
    lidoEm: "2026-10-07T10:00:00.000Z",
    aplicadaEm: null,
  };
}

describe("adicionarEpcs", () => {
  beforeEach(() => {
    apiRequest.mockReset();
  });

  it("quebra em chunks de 200 e mescla adicionados/repetidos/invalidos, com o último resumo", async () => {
    const epcs = Array.from({ length: 450 }, (_, i) => `E${String(i).padStart(4, "0")}`);
    let acumulado = 0;
    apiRequest.mockImplementation(async (_path: string, opts: { body: { epcs: string[] } }) => {
      const lote = opts.body.epcs;
      acumulado += lote.length;
      return {
        adicionados: lote.slice(0, 1).map(item),
        repetidos: lote.slice(1, 2),
        invalidos: lote.slice(2, 3),
        resumo: resumo(acumulado),
      };
    });

    const r = await adicionarEpcs("lote-1", epcs);

    expect(apiRequest).toHaveBeenCalledTimes(3);
    const tamanhos = apiRequest.mock.calls.map((c) => (c[1] as { body: { epcs: string[] } }).body.epcs.length);
    expect(tamanhos).toEqual([200, 200, 50]);
    expect(apiRequest.mock.calls[0]![0]).toBe("/expedicao/devolucoes/lotes/lote-1/epcs");
    expect((apiRequest.mock.calls[0]![1] as { method: string }).method).toBe("POST");
    expect(r.adicionados.map((i) => i.epc)).toEqual(["E0000", "E0200", "E0400"]);
    expect(r.repetidos).toEqual(["E0001", "E0201", "E0401"]);
    expect(r.invalidos).toEqual(["E0002", "E0202", "E0402"]);
    expect(r.resumo.total).toBe(450);
  });

  it("uma chamada só quando cabe em um chunk", async () => {
    apiRequest.mockResolvedValue({ adicionados: [], repetidos: [], invalidos: [], resumo: resumo(0) });
    await adicionarEpcs("l", ["A", "B"]);
    expect(apiRequest).toHaveBeenCalledTimes(1);
  });

  it("erro de um chunk sobe pro chamador", async () => {
    apiRequest.mockRejectedValue(new ApiError(409, "x", { error: "epc_em_outro_lote", epcs: [{ epc: "A", loteId: "z" }] }));
    await expect(adicionarEpcs("l", ["A"])).rejects.toBeInstanceOf(ApiError);
  });
});

describe("outros wrappers", () => {
  beforeEach(() => {
    apiRequest.mockReset().mockResolvedValue({});
  });

  it("removerEpc faz DELETE com o EPC codificado", async () => {
    await removerEpc("l1", "AB/C");
    expect(apiRequest).toHaveBeenCalledWith("/expedicao/devolucoes/lotes/l1/epcs/AB%2FC", { method: "DELETE" });
  });

  it("listarLotes manda os filtros como query string", async () => {
    await listarLotes({ de: "2026-09-07", limit: 100 });
    expect(apiRequest).toHaveBeenCalledWith("/expedicao/devolucoes/lotes", {
      query: { status: undefined, de: "2026-09-07", ate: undefined, limit: "100" },
    });
  });

  it("epcsEmOutroLote extrai os EPCs do body do 409", () => {
    const e = new ApiError(409, "x", { error: "epc_em_outro_lote", epcs: [{ epc: "A", loteId: "1" }, { epc: "B", loteId: "2" }] });
    expect(epcsEmOutroLote(e)).toEqual(["A", "B"]);
    expect(epcsEmOutroLote(new Error("x"))).toEqual([]);
  });
});

describe("reintegrarAteZerar", () => {
  const reint = (status: string, pendente: number) => ({
    lote: { id: "l" },
    reintegracao: { status, em: null, porVariante: [], resumo: { total: 2, ok: 2 - pendente, erro: 0, semGid: 0, semVariante: 0, pendente } },
  });
  const semEspera = () => Promise.resolve();

  beforeEach(() => {
    apiRequest.mockReset();
  });

  it("repete em sequência até resumo.pendente === 0", async () => {
    apiRequest.mockResolvedValueOnce(reint("pendente", 1)).mockResolvedValueOnce(reint("ok", 0));
    const { reintegrarAteZerar } = await import("../src/services/devolucoes");
    const prog: number[] = [];
    const r = await reintegrarAteZerar("l", (p) => prog.push(p.reintegracao!.resumo.pendente), semEspera);
    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(prog).toEqual([1, 0]);
    expect(r.reintegracao!.status).toBe("ok");
  });

  it("409 reintegracao_em_andamento espera e tenta de novo; depois de 10 desiste", async () => {
    const { reintegrarAteZerar, ReintegracaoOcupadaError } = await import("../src/services/devolucoes");
    const ocupado = new ApiError(409, "x", { error: "reintegracao_em_andamento" });
    apiRequest.mockRejectedValueOnce(ocupado).mockResolvedValueOnce(reint("ok", 0));
    const esperas: number[] = [];
    await reintegrarAteZerar("l", undefined, async (ms) => void esperas.push(ms));
    expect(esperas).toEqual([3000]);

    apiRequest.mockReset().mockRejectedValue(ocupado);
    await expect(reintegrarAteZerar("l", undefined, semEspera)).rejects.toBeInstanceOf(ReintegracaoOcupadaError);
    expect(apiRequest).toHaveBeenCalledTimes(11);
  });

  it("erro de rede sobe pro chamador", async () => {
    const { reintegrarAteZerar } = await import("../src/services/devolucoes");
    apiRequest.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(reintegrarAteZerar("l", undefined, semEspera)).rejects.toBeInstanceOf(TypeError);
  });
});

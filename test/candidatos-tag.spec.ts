// Peça lida fora de qualquer pedido (23/11): lógica pura dos candidatos de troca
// de tag + o merge entre chunks do epc-match.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  classificarErroTrocaTag,
  decidirSemMatch,
  mensagemTrocaTag,
  candidatosParaFaltante,
  mesclarCandidatos,
  prepararCandidatos,
  restantesAposTroca,
  ordenarPedidosCandidato,
  resumoItens,
  rotuloPecaLida,
} from "../src/lib/candidatosTag";
import type { CandidatoTag, ExpedicaoOrder } from "../src/services/expedicao";

const apiRequest = vi.fn();
vi.mock("../src/lib/api", async () => {
  const real = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return { ...real, apiRequest: (...a: unknown[]) => apiRequest(...a) };
});

const order = (id: string, createdAt: string): ExpedicaoOrder => ({ id, createdAt, numero: id, items: [] }) as unknown as ExpedicaoOrder;
const cand = (epc: string, pedidos: Array<[string, string]>, mais = 0): CandidatoTag => ({
  epc,
  nome: "Oversized Rux",
  tamanho: "M",
  ean: null,
  sku: null,
  pedidos: pedidos.map(([id, em]) => ({ order: order(id, em), epcAtual: `ATUAL-${id}` })),
  maisPedidos: mais,
});

describe("mesclarCandidatos", () => {
  it("dedupe por EPC, une pedidos sem repetir e fica com o maior maisPedidos", () => {
    const r = mesclarCandidatos([
      [cand("aa", [["1", "2026-01-01"]], 2)],
      [cand("AA", [["1", "2026-01-01"], ["2", "2026-01-02"]], 5), cand("bb", [["3", "2026-01-03"]])],
    ]);
    expect(r).toHaveLength(2);
    const aa = r.find((c) => c.epc === "AA")!;
    expect(aa.pedidos.map((p) => p.order.id)).toEqual(["1", "2"]);
    expect(aa.maisPedidos).toBe(5);
  });

  it("descarta peça que casou noutro chunk e candidato sem pedidos; aceita undefined", () => {
    const r = mesclarCandidatos([undefined, [cand("AA", [["1", "x"]]), cand("BB", []), cand("CC", [["2", "x"]])]], new Set(["AA"]));
    expect(r.map((c) => c.epc)).toEqual(["CC"]);
  });
});

describe("decidirSemMatch", () => {
  const ja = [{ epc: "AA" }] as never;
  it("já expedido vence candidatos", () => {
    expect(decidirSemMatch({ jaExpedidos: ja, candidatos: [cand("BB", [["1", "x"]])] }).tipo).toBe("ja_expedido");
  });
  it("candidatos com pedido abrem a tela e repassam exigePin", () => {
    const r = decidirSemMatch({ jaExpedidos: [], candidatos: [cand("BB", [["1", "x"]])], trocaTagExigePin: true });
    expect(r).toMatchObject({ tipo: "candidatos", exigePin: true });
    expect(decidirSemMatch({ jaExpedidos: [], candidatos: [cand("BB", [["1", "x"]])] })).toMatchObject({ exigePin: false });
  });
  it("sem campo (Nexus antigo), vazio ou sem pedidos = aviso antigo", () => {
    expect(decidirSemMatch({ jaExpedidos: [] }).tipo).toBe("aviso");
    expect(decidirSemMatch({ jaExpedidos: [], candidatos: [] }).tipo).toBe("aviso");
    expect(decidirSemMatch({ jaExpedidos: [], candidatos: [cand("BB", [])] }).tipo).toBe("aviso");
  });
});

describe("mensagens e erros", () => {
  it("uma mensagem por motivo e genérica pro desconhecido", () => {
    expect(mensagemTrocaTag("status_mudou")).toBe("Esse pedido já saiu da embalagem.");
    expect(mensagemTrocaTag("tag_ja_vinculada")).toBe("Essa peça já está em outro pedido.");
    expect(mensagemTrocaTag("tag_atual_mudou")).toBe("O pedido mudou, leia de novo.");
    expect(mensagemTrocaTag("produto_diferente")).toBe("Essa peça não é do mesmo produto e tamanho.");
    expect(mensagemTrocaTag("novo_motivo")).toMatch(/leia de novo/i);
    expect(mensagemTrocaTag(null)).toMatch(/leia de novo/i);
  });
  it("classifica 409, 422 de PIN e o resto", () => {
    expect(classificarErroTrocaTag({ error: "troca_tag_recusada", motivo: "status_mudou" })).toEqual({ tipo: "recusada", motivo: "status_mudou" });
    expect(classificarErroTrocaTag({ error: "troca_tag_exige_pin" })).toEqual({ tipo: "exige_pin" });
    expect(classificarErroTrocaTag({ error: "pin_invalido" })).toEqual({ tipo: "outro" });
    expect(classificarErroTrocaTag(null)).toEqual({ tipo: "outro" });
  });
});

describe("apresentação", () => {
  it("mantém a ordem do servidor (mais recente primeiro): o primeiro é o Sugerido", () => {
    const c = cand("AA", [["recente", "2026-02-01"], ["antigo", "2026-01-01"]]);
    expect(ordenarPedidosCandidato(c).map((p) => p.order.id)).toEqual(["recente", "antigo"]);
  });
  it("rótulo da peça e resumo de itens", () => {
    expect(rotuloPecaLida({ nome: "Oversized", tamanho: "M" })).toBe("Oversized · M");
    expect(rotuloPecaLida({ nome: null, tamanho: null })).toBe("Peça sem cadastro");
    expect(resumoItens([{ nome: "A", tamanho: "M", quantidade: 2 }, { nome: "B", quantidade: 1 }, { nome: "C", quantidade: 1 }, { nome: "D", quantidade: 1 }])).toBe("2x A (M), B, C e mais 1");
  });
});

describe("epcMatch com candidatos (chunks)", () => {
  beforeEach(() => apiRequest.mockReset());

  it("mescla candidatos e PIN entre chunks de 200; sem campo nada muda", async () => {
    const { epcMatch } = await import("../src/services/expedicao");
    const epcs = Array.from({ length: 250 }, (_, i) => `E${String(i).padStart(4, "0")}`);
    apiRequest
      .mockResolvedValueOnce({ matches: [], unmatchedEpcs: ["E0001"], jaExpedidos: [], candidatos: [cand("E0001", [["1", "x"]])] })
      .mockResolvedValueOnce({ matches: [], unmatchedEpcs: ["E0001", "E0210"], jaExpedidos: [], candidatos: [cand("E0001", [["2", "y"]]), cand("E0210", [["3", "z"]])], trocaTagExigePin: true });
    const r = await epcMatch(epcs);
    expect(apiRequest).toHaveBeenCalledTimes(2);
    expect(r.candidatos?.map((c) => c.epc).sort()).toEqual(["E0001", "E0210"]);
    expect(r.candidatos?.find((c) => c.epc === "E0001")?.pedidos).toHaveLength(2);
    expect(r.trocaTagExigePin).toBe(true);

    apiRequest.mockReset().mockResolvedValueOnce({ matches: [], unmatchedEpcs: ["E1"], jaExpedidos: [] });
    const antigo = await epcMatch(["E1"]);
    expect("candidatos" in antigo).toBe(false);
    expect("trocaTagExigePin" in antigo).toBe(false);
  });

  it("candidato cuja peça casou com pedido em outro chunk é descartado", async () => {
    const { epcMatch } = await import("../src/services/expedicao");
    const epcs = Array.from({ length: 250 }, (_, i) => `E${String(i).padStart(4, "0")}`);
    const o = { ...order("9", "x"), rfidTags: ["E0001"] };
    apiRequest
      .mockResolvedValueOnce({ matches: [], unmatchedEpcs: ["E0001"], jaExpedidos: [], candidatos: [cand("E0001", [["1", "x"]])] })
      .mockResolvedValueOnce({ matches: [{ order: o, tagsLidas: ["E0001"], tagsFaltantes: [], tagsMatched: 1, tagsTotal: 1 }], unmatchedEpcs: [], jaExpedidos: [] });
    const r = await epcMatch(epcs);
    expect(r.candidatos).toBeUndefined();
    expect(r.matches).toHaveLength(1);
  });
});

describe("trocarTagDoPedido", () => {
  it("POST na rota nova com EPCs em maiúsculo e liberação opcional", async () => {
    const { trocarTagDoPedido } = await import("../src/services/expedicao");
    apiRequest.mockReset().mockResolvedValue({ match: {} });
    await trocarTagDoPedido("ord-1", { epcLido: "aa", epcAtual: null });
    expect(apiRequest).toHaveBeenCalledWith("/expedicao/orders/ord-1/trocar-tag", { method: "POST", body: { epcLido: "AA", epcAtual: null } });
    await trocarTagDoPedido("ord-1", { epcLido: "aa", epcAtual: "bb", liberacao: { supervisorId: "s", pin: "1", motivo: "m" } });
    expect(apiRequest.mock.calls[1][1].body).toEqual({ epcLido: "AA", epcAtual: "BB", liberacao: { supervisorId: "s", pin: "1", motivo: "m" } });
  });
});

describe("prepararCandidatos e restantesAposTroca", () => {
  const mlOrder = (id: string) => ({ ...order(id, "x"), canal: "mercado_livre" }) as unknown as ExpedicaoOrder;
  it("filtra ignorados e pedidos de outro canal; sem pedido do canal não sobra candidato", () => {
    const a = cand("AA", [["1", "x"]]);
    const b = { ...cand("BB", [["2", "x"]]), pedidos: [{ order: mlOrder("2"), epcAtual: null }] };
    const c = cand("CC", [["3", "x"]]);
    const r = prepararCandidatos([a, b, c], { ignorar: new Set(["CC"]), pedidoDoCanal: (o) => (o as { canal?: string }).canal !== "mercado_livre" });
    expect(r.map((x) => x.epc)).toEqual(["AA"]);
    expect(prepararCandidatos(undefined, { pedidoDoCanal: () => true })).toEqual([]);
  });
  it("restantes: só quem está na mesa, tem o mesmo pedido, restrito a ele; epcAtual trocado fica pro próximo ciclo", () => {
    const b = cand("BB", [["1", "x"], ["2", "y"]]);
    const c = cand("CC", [["1", "x"]]);
    const d = cand("DD", [["9", "x"]]);
    const e = cand("EE", [["1", "x"]]); // fora da mesa
    const r = restantesAposTroca([b, c, d, e], "1", new Set(["BB", "CC", "DD"]), ["ATUAL-1"]);
    expect(r.map((x) => x.epc)).toEqual(["BB", "CC"]);
    expect(r[0].pedidos.map((p) => p.order.id)).toEqual(["1"]);
    const obsoleto = restantesAposTroca([b], "1", new Set(["BB"]), ["OUTRA-TAG"]);
    expect(obsoleto).toEqual([]);
  });
});

describe("candidatosParaFaltante", () => {
  const m = (id: string, faltantes: string[]) => ({ order: { id }, tagsFaltantes: faltantes });
  it("só oferece com peça faltando e candidato do MESMO pedido, restrito a ele", () => {
    const cs = [cand("XX", [["1", "a"], ["2", "b"]]), cand("YY", [["3", "c"]])];
    const r = candidatosParaFaltante(cs, m("1", ["A"]));
    expect(r.map((c) => c.epc)).toEqual(["XX"]);
    expect(r[0].pedidos.map((p) => p.order.id)).toEqual(["1"]);
    expect(candidatosParaFaltante(cs, m("1", []))).toEqual([]);
    expect(candidatosParaFaltante(undefined, m("1", ["A"]))).toEqual([]);
  });
});

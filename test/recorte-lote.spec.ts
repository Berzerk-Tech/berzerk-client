// Recorte de exibição do lote (16/11): pedido de lista impressa nunca some por
// filtro local, o filtro de data não atravessa o dia e o rodapé diz o motivo.
import { beforeEach, describe, expect, it } from "vitest";
import type { Order } from "../src/services/orders";
import { hojeSP, loadFilters, saveFilters } from "../src/components/PickingFiltersModal";
import {
  contarOcultos,
  motivoOculto,
  partesDosOcultos,
  passaNosFiltros,
  resumoDosOcultos,
} from "../src/lib/recorteLote";

function pedido(id: string, nome: string, dataEmissao: string, extra: Partial<Order> = {}): Order {
  return {
    id,
    tinyOrderId: null,
    numero: id,
    channel: null,
    status: "pending" as Order["status"],
    predominantSize: "M",
    separationMode: "puro",
    claimedBy: "op-1",
    claimedAt: null,
    separatedBy: null,
    separatedAt: null,
    rfidTags: null,
    items: [{ id: `${id}-0`, ean: null, sku: null, nome, tamanho: "M", quantidade: 1, imagemUrl: null }],
    dataEmissao,
    createdAt: "",
    updatedAt: "",
    ...extra,
  } as Order;
}

const HOJE = "2026-11-06T15:00:00Z";

describe("lista impressa não é escondida por filtro local", () => {
  const impresso = pedido("a", "Calça Legging - M", "2026-10-31T15:00:00Z", { listaEm: "2026-11-05T10:00:00Z" });
  const solto = pedido("b", "Calça Legging - M", "2026-10-31T15:00:00Z");

  it("data", () => {
    const f = { dateFrom: "2026-11-06", dateTo: "2026-11-06" };
    expect(passaNosFiltros(impresso, f)).toBe(true);
    expect(passaNosFiltros(solto, f)).toBe(false);
  });
  it("exclude (inclusive exclusão do galpão) e include", () => {
    expect(passaNosFiltros(impresso, { excludeProducts: ["legging"] })).toBe(true);
    expect(passaNosFiltros(solto, { excludeProducts: ["legging"] })).toBe(false);
    expect(passaNosFiltros(impresso, { includeProducts: ["oversized"] })).toBe(true);
    expect(motivoOculto(impresso, { excludeProducts: ["legging"] }, "M", ["legging"])).toBeNull();
  });
});

describe("filtro de data salvo não atravessa o dia", () => {
  beforeEach(() => localStorage.clear());

  it("mantém data salva hoje e grava o carimbo", () => {
    const hoje = hojeSP();
    saveFilters("total", "M", { dateFrom: hoje, dateTo: hoje, excludeProducts: ["x"] });
    const f = loadFilters("total", "M");
    expect(f.dateFrom).toBe(hoje);
    expect(f.excludeProducts).toEqual(["x"]);
  });
  it("descarta a data de outro dia e preserva o resto", () => {
    localStorage.setItem(
      "berzerk_picking_filters_v2",
      JSON.stringify({
        "total:M": { dateFrom: "2026-01-01", dateTo: "2026-01-01", salvoEm: "2026-01-01", excludeProducts: ["x"], soUnicos: true },
      }),
    );
    const f = loadFilters("total", "M");
    expect(f.dateFrom).toBeUndefined();
    expect(f.dateTo).toBeUndefined();
    expect(f.excludeProducts).toEqual(["x"]);
    expect(f.soUnicos).toBe(true);
  });
  it("entrada antiga sem carimbo perde a data, não o resto", () => {
    const hoje = hojeSP();
    localStorage.setItem(
      "berzerk_picking_filters_v2",
      JSON.stringify({ "total:M": { dateFrom: hoje, dateTo: hoje, includeProducts: ["y"] } }),
    );
    const f = loadFilters("total", "M");
    expect(f.dateFrom).toBeUndefined();
    expect(f.includeProducts).toEqual(["y"]);
  });
});

describe("ocultos por motivo", () => {
  const lote = [
    pedido("1", "Oversized - M", "2026-11-05T15:00:00Z"), // outra data
    pedido("2", "Oversized - M", "2026-11-05T15:00:00Z"), // outra data
    pedido("3", "Bermuda Falta - M", HOJE), // galpão
    pedido("4", "Regata - M", HOJE), // filtro de produto dela
    pedido("5", "Oversized - M", HOJE), // visível
    pedido("6", "Oversized - M", "2026-11-05T15:00:00Z", { listaEm: "x" }), // impresso: visível
    pedido("7", "Bermuda Falta - M", "2026-11-05T15:00:00Z"), // data vence o galpão
  ];
  const efetivos = { dateFrom: "2026-11-06", dateTo: "2026-11-06", excludeProducts: ["regata", "falta"] };

  it("conta por motivo, com precedência data → galpão → produto", () => {
    const c = contarOcultos(lote, efetivos, "M", ["falta"]);
    expect(c).toEqual({ data: 3, galpao: 1, produto: 1, unicos: 0, mistos: 0, total: 5 });
    expect(lote.length - c.total).toBe(lote.filter((o) => passaNosFiltros(o, efetivos, "M")).length);
  });
  it("monta o texto só com motivos > 0 e singular/plural", () => {
    const c = contarOcultos(lote, efetivos, "M", ["falta"]);
    expect(resumoDosOcultos(c)).toBe("5 ocultos: 3 de outras datas · 1 com produto em falta · 1 pelo filtro de produto");
    expect(partesDosOcultos(c).map((p) => p.motivo)).toEqual(["data", "galpao", "produto"]);
    expect(resumoDosOcultos({ data: 1, galpao: 0, produto: 0, unicos: 0, mistos: 0, total: 1 })).toBe("1 oculto: 1 de outra data");
    expect(resumoDosOcultos(contarOcultos([], {}))).toBe("");
  });
  it("só únicos", () => {
    expect(motivoOculto(pedido("u", "A - M", HOJE, { unico: false }), { soUnicos: true })).toBe("unicos");
  });
});

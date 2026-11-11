// Devolver UMA lista de mistos (11/11): o diálogo do supervisor mandava o lote
// inteiro e a Lista 2 ia embora junto com a 1.
import { describe, expect, it } from "vitest";
import { TODAS_AS_LISTAS, chaveDaLista, idsDaDevolucao, listasDoLote } from "../src/lib/listasDoLote";

const lote = [
  { id: "b1", listaEm: "2026-11-11T13:00:00Z", listaId: "L2" },
  { id: "a1", listaEm: "2026-11-11T12:00:00Z", listaId: "L1" },
  { id: "a2", listaEm: "2026-11-11T12:00:01Z", listaId: "L1" },
  { id: "s1", listaEm: null },
];

describe("listasDoLote", () => {
  it("numera pela lista mais antiga e agrupa por listaId", () => {
    expect(listasDoLote(lote)).toEqual([
      { chave: "L1", numero: 1, ids: ["a1", "a2"] },
      { chave: "L2", numero: 2, ids: ["b1"] },
    ]);
  });

  it("sem listaId agrupa pelo carimbo", () => {
    const r = listasDoLote([
      { id: "x", listaEm: "2026-11-11T12:00:00Z" },
      { id: "y", listaEm: "2026-11-11T12:00:00Z" },
      { id: "z", listaEm: "2026-11-11T12:30:00Z" },
    ]);
    expect(r.map((l) => l.ids)).toEqual([["x", "y"], ["z"]]);
  });

  it("devolver uma lista leva só os pedidos dela", () => {
    expect(idsDaDevolucao(lote, "L1")).toEqual(["a1", "a2"]);
    expect(idsDaDevolucao(lote, "L2")).toEqual(["b1"]);
  });

  it("todas (ou chave que sumiu) leva o lote inteiro, como antes", () => {
    expect(idsDaDevolucao(lote, TODAS_AS_LISTAS)).toEqual(["b1", "a1", "a2", "s1"]);
    expect(idsDaDevolucao(lote, "nao-existe")).toEqual(["b1", "a1", "a2", "s1"]);
  });

  it("chaveDaLista", () => {
    expect(chaveDaLista(lote[0])).toBe("L2");
    expect(chaveDaLista(lote[3])).toBeNull();
    expect(chaveDaLista(null)).toBeNull();
  });
});

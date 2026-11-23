import { beforeEach, describe, expect, it } from "vitest";
import {
  HISTORICO_KEY,
  HISTORICO_MAX_PEDIDOS,
  buscarNoHistorico,
  gravarConclusao,
  lerHistorico,
  podarHistorico,
  registrarConclusao,
  totalDePedidos,
  type Historico,
  type HistoricoPedido,
} from "../src/lib/impressaoManualHistorico";

const DIA = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 10, 23, 12, 0, 0);
const ped = (n: number | string, tamanho = "P"): HistoricoPedido => ({ orderId: `o${n}`, numero: `${n}`, cliente: `Cli ${n}`, tracking: `JT${n}`, comBump: false, tamanho });
const meta = (loteId: string, estampa = "Leg Day", cor: string | null = "Preto") => ({ loteId, estampa, cor });

describe("histórico local da impressão manual", () => {
  beforeEach(() => localStorage.clear());

  it("cria o lote no 1º pedido, junta os seguintes (tamanhos em ordem canônica) e não duplica", () => {
    let h: Historico = [];
    h = registrarConclusao(h, meta("L1"), ped(1, "G"), T0);
    h = registrarConclusao(h, meta("L1"), ped(2, "P"), T0 + 1000);
    h = registrarConclusao(h, meta("L1"), ped(2, "P"), T0 + 2000);
    expect(h).toHaveLength(1);
    expect(h[0].tamanhos).toEqual(["P", "G"]);
    expect(h[0].pedidos.map((p) => p.orderId)).toEqual(["o1", "o2"]);
    expect(h[0].em).toBe(T0);
  });

  it("poda lote com mais de 3 dias e deixa o mais recente primeiro", () => {
    const velho = registrarConclusao([], meta("velho"), ped(1), T0 - 3 * DIA - 1);
    const novo = registrarConclusao([], meta("novo"), ped(2), T0 - DIA);
    const limite = registrarConclusao([], meta("limite"), ped(3), T0 - 3 * DIA);
    const h = podarHistorico([...velho, ...novo, ...limite], T0);
    expect(h.map((l) => l.id)).toEqual(["novo", "limite"]);
  });

  it("respeita o teto de pedidos: some o lote mais antigo e corta o excedente do que fica", () => {
    const lote = (id: string, em: number, n: number, ini: number) => ({
      id,
      em,
      estampa: "X",
      cor: null,
      tamanhos: ["P"],
      pedidos: Array.from({ length: n }, (_, i) => ped(ini + i)),
    });
    const h = podarHistorico([lote("a", T0 - 3000, 1500, 0), lote("b", T0 - 2000, 1500, 10000), lote("c", T0 - 1000, 1000, 20000)], T0);
    expect(totalDePedidos(h)).toBe(HISTORICO_MAX_PEDIDOS);
    expect(h.map((l) => l.id)).toEqual(["c", "b"]);
    expect(h[0].pedidos).toHaveLength(1000);
    expect(h[1].pedidos).toHaveLength(1000);
    // do lote cortado ficam os pedidos mais recentes (fim da lista)
    expect(h[1].pedidos[0].orderId).toBe("o10500");
  });

  it("busca por número de pedido, estampa, cor e tamanho", () => {
    let h: Historico = [];
    h = registrarConclusao(h, meta("L1", "Leg Day", "Preto"), ped(111, "P"), T0);
    h = registrarConclusao(h, meta("L1", "Leg Day", "Preto"), ped(222, "G"), T0);
    h = registrarConclusao(h, meta("L2", "Árvore", null), ped(333, "M"), T0 + 1);
    expect(buscarNoHistorico(h, "")).toBe(h);
    const porNumero = buscarNoHistorico(h, "222");
    expect(porNumero).toHaveLength(1);
    expect(porNumero[0].pedidos.map((p) => p.numero)).toEqual(["222"]);
    expect(buscarNoHistorico(h, "arvore").map((l) => l.id)).toEqual(["L2"]);
    expect(buscarNoHistorico(h, "leg preto")[0].pedidos).toHaveLength(2);
    expect(buscarNoHistorico(h, "zzz")).toEqual([]);
  });

  it("persiste e lê do localStorage; lixo vira lista vazia", () => {
    gravarConclusao(meta("L1"), ped(1), T0);
    gravarConclusao(meta("L1"), ped(2), T0);
    expect(lerHistorico(T0).flatMap((l) => l.pedidos).map((p) => p.numero)).toEqual(["1", "2"]);
    localStorage.setItem(HISTORICO_KEY, "{nao e json");
    expect(lerHistorico(T0)).toEqual([]);
    localStorage.setItem(HISTORICO_KEY, JSON.stringify({ a: 1 }));
    expect(lerHistorico(T0)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { proximoPedidoAposRefresh } from "../src/lib/pedidoFixo";
import { compararTamanhos, ordenarPorTamanho } from "../src/lib/tamanhos";
import { itemSize } from "../src/lib/itemParecido";
import { montarReimpressao } from "../src/lib/listaReimpressao";
import type { ListaDetalheResponse } from "../src/services/listas";
import type { OrderItem } from "../src/services/orders";

const o = (id: string) => ({ id });

describe("proximoPedidoAposRefresh", () => {
  it("mantém o pedido atual se ainda vem na resposta (com o objeto novo)", () => {
    const novo = { id: "a", x: 2 };
    expect(proximoPedidoAposRefresh({ atual: o("a"), orders: [o("b"), novo] })).toEqual({ tipo: "manter", pedido: novo });
  });
  it("não troca por filtro/leitura em refresh automático", () => {
    expect(proximoPedidoAposRefresh({ atual: o("a"), orders: [o("a")], foraDoFiltroSemLeitura: true }).tipo).toBe("manter");
  });
  it("troca de filtro pela operadora cede o pedido escondido sem leitura", () => {
    expect(
      proximoPedidoAposRefresh({ atual: o("a"), orders: [o("a")], acaoExplicita: true, foraDoFiltroSemLeitura: true }).tipo,
    ).toBe("escolher");
  });
  it("pedido que sumiu da resposta = saiu (não escolhe outro)", () => {
    expect(proximoPedidoAposRefresh({ atual: o("a"), orders: [o("b")] }).tipo).toBe("saiu");
  });
  it("sem pedido na mesa = escolher (ação explícita ou mesa nunca vazia por saída)", () => {
    expect(proximoPedidoAposRefresh({ atual: null, orders: [o("b")] }).tipo).toBe("escolher");
    expect(proximoPedidoAposRefresh({ atual: null, orders: [o("b")], pedidoSaiu: true, acaoExplicita: true }).tipo).toBe("escolher");
  });
  it("refresh de fundo com mesa vazia por pedido que saiu = segue vazia", () => {
    expect(proximoPedidoAposRefresh({ atual: null, orders: [o("b")], pedidoSaiu: true }).tipo).toBe("vazio");
  });
});

describe("tamanhos", () => {
  it("ordena estável, desconhecido no fim", () => {
    const l = [
      { t: "GG", n: 1 },
      { t: "P", n: 2 },
      { t: "ZZ", n: 3 },
      { t: "GG", n: 4 },
      { t: null, n: 5 },
      { t: "M", n: 6 },
    ];
    expect(ordenarPorTamanho(l, (x) => x.t).map((x) => x.n)).toEqual([2, 6, 1, 4, 3, 5]);
    expect(["XG", "P", "U", "G"].sort(compararTamanhos)).toEqual(["P", "G", "XG", "U"]);
  });
  it("itemSize reconhece token final sem hífen", () => {
    expect(itemSize({ nome: "Oversized Symbol GG", tamanho: null } as OrderItem, { sufixoSemHifen: true })).toBe("GG");
    expect(itemSize({ nome: "Oversized Symbol GG", tamanho: null } as OrderItem)).toBeNull();
    expect(itemSize({ nome: "Regata Gym", tamanho: null } as OrderItem, { sufixoSemHifen: true })).toBeNull();
  });
});

describe("montarReimpressao", () => {
  const base = {
    id: "l1",
    criadoEm: "2026-11-10T17:32:00.000Z",
    escopo: "lote",
    operadorId: "u",
    operadorNome: "Ana Souza",
    recuperacoes: 0,
    recuperadaEm: null,
    recuperadaPor: null,
  } as const;
  const ped = (orderId: string, itens: [string, string, number][], separadoEm: string | null = null) => ({
    orderId,
    numero: orderId,
    tinyAccount: "fm",
    clienteNome: null,
    itens: itens.map(([nome, tamanho, quantidade]) => ({ nome, tamanho, ean: null, sku: null, quantidade })),
    statusAtual: "ready" as const,
    claimedByAtual: null,
    claimedPorMim: false,
    separadoEm,
    recuperavel: true,
  });
  it("sem modo do servidor, mesmo com pedido misto, é picking", () => {
    const d: ListaDetalheResponse = { ...base, pedidos: [ped("1", [["Leg Day - M", "M", 2], ["Myth - G", "G", 1]])] };
    expect(montarReimpressao(d, "Ana").tipo).toBe("picking");
  });
  it("mistos: inclui pedido concluído e conta no cabeçalho", () => {
    const d: ListaDetalheResponse = {
      ...base,
      modo: "mistos",
      pedidos: [
        ped("1", [["Leg Day - M", "M", 2], ["Myth - G", "G", 1]]),
        ped("2", [["Zeus - M", "M", 1], ["Myth - G", "G", 1]], "2026-11-10T18:00:00Z"),
      ],
    };
    const r = montarReimpressao(d, "Ana");
    expect(r.tipo).toBe("mistos");
    if (r.tipo !== "mistos") return;
    expect(r.doc.fila).toBe("M");
    expect(r.doc.linhas[0].total).toBe(2);
    expect(r.doc.reimpressao).toContain("REIMPRESSÃO");
    expect(r.doc.reimpressao).toContain("1/2 concluídos");
  });
  it("picking: seções por tamanho em ordem", () => {
    const d: ListaDetalheResponse = { ...base, pedidos: [ped("1", [["A - G", "G", 1]]), ped("2", [["B - P", "P", 2]])] };
    const r = montarReimpressao(d, "Ana");
    expect(r.tipo).toBe("picking");
    if (r.tipo !== "picking") return;
    expect(r.doc.secoes.map((s) => s.tamanho)).toEqual(["P", "G"]);
  });
});

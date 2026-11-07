// Filtro Mistos — a regra pura (src/lib/mistos.ts), batida contra o protótipo
// do Lucas (separacao-dev.html, 04/11/2026): produto = nome sem o tamanho;
// misto do M = peças do M saem da bancada, só as de OUTRO tamanho vêm do
// picking; fica na fila o misto cujas peças de outro tamanho são TODAS dos
// produtos marcados (em P–XG); ranking por "fecha sozinho".
import { describe, expect, it } from "vitest";
import type { Order, QueueProduct } from "../src/services/orders";
import {
  fechamCom,
  ordenarPorProdutoFora,
  passaNoFiltroMistos,
  pedidosMistos,
  pedidosMistosDaFila,
  pickingMistos,
  produtoDe,
  rankingMistos,
  tamanhoDaLinha,
  tamanhosForaDaFila,
  totalDele,
  totalFora,
  pedidosMistosNosFiltros,
} from "../src/lib/mistos";

function linha(nome: string, tamanho: string | null, quantidade: number, orderIds: string[]): QueueProduct {
  return { nome, tamanho, ean: null, imagemUrl: null, quantidade, pedidos: orderIds.length, orderIds };
}

function pedido(id: string, pred: string, itens: { nome: string; tamanho: string; quantidade?: number }[]): Order {
  return {
    id,
    tinyOrderId: null,
    numero: id,
    channel: null,
    status: "pending" as Order["status"],
    predominantSize: pred,
    separationMode: "total",
    claimedBy: "op-1",
    claimedAt: null,
    separatedBy: null,
    separatedAt: null,
    rfidTags: null,
    items: itens.map((it, k) => ({
      id: `${id}-${k}`,
      ean: null,
      sku: null,
      nome: it.nome,
      tamanho: it.tamanho,
      quantidade: it.quantidade ?? 1,
      imagemUrl: null,
    })),
    createdAt: "",
    updatedAt: "",
  };
}

describe("produtoDe", () => {
  it("tira o tamanho do fim do nome, com ou sem hífen", () => {
    expect(produtoDe("Oversized - Baki - G", "G")).toBe("Oversized - Baki");
    expect(produtoDe("Short Dry Fit 2 em 1 - Symbol GG", "GG")).toBe("Short Dry Fit 2 em 1 - Symbol");
    expect(produtoDe("Oversized - Surpresa - XG", null)).toBe("Oversized - Surpresa");
    expect(produtoDe("Bermuda Moletom - Marinho - G3", "G3")).toBe("Bermuda Moletom - Marinho");
  });
  it("exige separador antes do tamanho — não corta a última letra do nome (revisão 04/11)", () => {
    expect(produtoDe("Regata Gym - M", "M")).toBe("Regata Gym");
    expect(produtoDe("Legging Top - G", "G")).toBe("Legging Top");
    expect(produtoDe("Moletom Gang - P", "P")).toBe("Moletom Gang");
    expect(produtoDe("Regata Gym", "M")).toBe("Regata Gym");
  });
  it("número solto só sai depois de hífen — 'Short Dry Fit 2 em 1' fica inteiro", () => {
    expect(produtoDe("Short Dry Fit 2 em 1 - GG", "GG")).toBe("Short Dry Fit 2 em 1");
    expect(produtoDe("Short Dry Fit 2 em 1", null)).toBe("Short Dry Fit 2 em 1");
    expect(produtoDe("Tênis Runner - 42", "42")).toBe("Tênis Runner");
  });
  it("não mutila nome sem tamanho nem nome que é só o tamanho", () => {
    expect(produtoDe("Oversized - Surpresa", null)).toBe("Oversized - Surpresa");
    expect(produtoDe("M", "M")).toBe("M");
  });
});

describe("tamanhoDaLinha", () => {
  it("usa o campo e, sem ele, o fim do nome", () => {
    expect(tamanhoDaLinha({ nome: "x", tamanho: "gg" })).toBe("GG");
    // Só por espaço NÃO é tamanho — a mesma regra do `itemSize` e do nexus.
    expect(tamanhoDaLinha({ nome: "Short … Symbol GG", tamanho: null })).toBe("");
    expect(tamanhoDaLinha({ nome: "Short - Symbol - XG", tamanho: null })).toBe("XG");
    expect(tamanhoDaLinha({ nome: "Sem tamanho nenhum", tamanho: null })).toBe("");
  });
});

describe("pedidosMistosDaFila", () => {
  it("reconstrói pedido → peças pelos orderIds e separa dele/fora", () => {
    const fila = [
      linha("Leg Day - M", "M", 2, ["a", "b"]),
      linha("Zeus - M", "M", 1, ["a"]),
      linha("Myth - G", "G", 1, ["a"]),
      linha("Surpresa - P", "P", 1, ["b"]),
    ];
    const peds = pedidosMistosDaFila(fila, "M");
    const a = peds.find((p) => p.id === "a")!;
    expect(a.pred).toBe("M");
    expect(a.dele.map((i) => i.produto)).toEqual(["Leg Day", "Zeus"]);
    expect(a.fora.map((i) => `${i.produto}/${i.tamanho}`)).toEqual(["Myth/G"]);
    const b = peds.find((p) => p.id === "b")!;
    expect(b.fora.map((i) => i.produto)).toEqual(["Surpresa"]);
  });
  it("distribui a sobra de quantidade pros primeiros pedidos", () => {
    const fila = [linha("Surpresa - G", "G", 3, ["a", "b"]), linha("Leg Day - M", "M", 2, ["a", "b"])];
    const peds = pedidosMistosDaFila(fila, "M");
    expect(peds.find((p) => p.id === "a")!.fora[0].quantidade).toBe(2);
    expect(peds.find((p) => p.id === "b")!.fora[0].quantidade).toBe(1);
  });
  it("pedido sem peça do tamanho da fila mas com peça do bucket usa ela como predominante", () => {
    const fila = [linha("Leg Day - XXG", "XXG", 1, ["a"]), linha("Myth - G", "G", 1, ["a"])];
    const [a] = pedidosMistosDaFila(fila, "XG", ["XG", "XXG", "G1", "G2", "G3"]);
    expect(a.pred).toBe("XXG");
    expect(a.fora.map((i) => i.produto)).toEqual(["Myth"]);
  });
});

describe("pedidosMistos (fila ∪ lote)", () => {
  it("o lote entra com itens exatos e vence a fila no mesmo id; pedido sem peça fora sai", () => {
    const lote = [pedido("a", "M", [{ nome: "Leg Day - M", tamanho: "M" }, { nome: "Myth - G", tamanho: "G", quantidade: 2 }])];
    const fila = [linha("Leg Day - M", "M", 2, ["a", "c"]), linha("Zeus - M", "M", 1, ["c"])];
    const peds = pedidosMistos({ fila, lote, size: "M" });
    expect(peds.map((p) => p.id)).toEqual(["a"]); // "c" é puro-M disfarçado: sem peça fora
    expect(peds[0].noLote).toBe(true);
    expect(peds[0].fora[0].quantidade).toBe(2);
  });
});

describe("rankingMistos + fechamCom", () => {
  const peds = pedidosMistosDaFila(
    [
      linha("Leg Day - M", "M", 4, ["a", "b", "c", "d"]),
      linha("Surpresa - G", "G", 3, ["a", "b", "c"]),
      linha("Punk Pink - GG", "GG", 2, ["b", "d"]),
      linha("Vintage - G3", "G3", 1, ["c"]),
    ],
    "M",
  );
  it("ordena por fecha sozinho, depois por aparece", () => {
    const r = rankingMistos(peds);
    expect(r.map((x) => [x.produto, x.aparece, x.sozinho])).toEqual([
      ["Surpresa", 3, 1], // só o "a" fecha sozinho (b tem Punk Pink, c tem Vintage G3)
      ["Punk Pink", 2, 1], // "d"
      ["Vintage", 1, 0], // G3 nunca fecha
    ]);
  });
  it("fica o pedido cujas peças fora são TODAS dos marcados e em P–XG", () => {
    expect(fechamCom(peds, ["Surpresa"]).map((p) => p.id)).toEqual(["a"]);
    expect(fechamCom(peds, ["surpresa", "PUNK PINK"]).map((p) => p.id).sort()).toEqual(["a", "b", "d"]);
    // "c" tem Vintage em G3: fora de P–XG, nunca entra.
    expect(fechamCom(peds, ["Surpresa", "Punk Pink", "Vintage"]).map((p) => p.id).sort()).toEqual(["a", "b", "d"]);
    expect(fechamCom(peds, [])).toEqual([]);
  });
});

describe("passaNoFiltroMistos (Order do lote)", () => {
  const o = pedido("a", "M", [{ nome: "Leg Day - M", tamanho: "M" }, { nome: "Myth - G", tamanho: "G" }]);
  it("sem filtro passa; com filtro aplica a regra pelo nome sem tamanho", () => {
    expect(passaNoFiltroMistos(o, undefined, "M")).toBe(true);
    expect(passaNoFiltroMistos(o, [], "M")).toBe(true);
    expect(passaNoFiltroMistos(o, ["Myth"], "M")).toBe(true);
    expect(passaNoFiltroMistos(o, ["Zeus"], "M")).toBe(false);
  });
  it("item sem tamanho no campo usa o tamanho do nome", () => {
    const semCampo = pedido("b", "M", [{ nome: "Leg Day - M", tamanho: "" }, { nome: "Myth - G", tamanho: "" }]);
    expect(passaNoFiltroMistos(semCampo, ["Myth"], "M")).toBe(true);
  });
});

describe("pickingMistos", () => {
  it("agrupa as peças fora por produto, com a grade dos outros tamanhos, do maior pro menor", () => {
    const peds = pedidosMistosDaFila(
      [
        linha("Leg Day - M", "M", 3, ["a", "b", "c"]),
        linha("Surpresa - G", "G", 2, ["a", "b"]),
        linha("Surpresa - P", "P", 1, ["c"]),
        linha("Punk Pink - GG", "GG", 1, ["a"]),
      ],
      "M",
    );
    expect(tamanhosForaDaFila("M")).toEqual(["P", "G", "GG", "XG"]);
    const pick = pickingMistos(peds, "M");
    expect(pick.map((x) => x.produto)).toEqual(["Surpresa", "Punk Pink"]);
    expect(pick[0].grade).toEqual({ P: 1, G: 2, GG: 0, XG: 0 });
    expect(pick[0].total).toBe(3);
    expect(pick[0].pedidos).toBe(3);
    expect(totalFora(peds)).toBe(4);
    expect(totalDele(peds)).toBe(3);
  });
});

describe("ordenarPorProdutoFora (Nicole via Roger, 06/11/2026)", () => {
  // Pedido do M com uma peça "fora" (G) do produto dado; sem produto = só peça do M.
  const com = (id: string, fora?: string, extra: Partial<Order> = {}): Order => ({
    ...pedido(id, "M", [{ nome: "Base - M", tamanho: "M" }, ...(fora ? [{ nome: `${fora} - G`, tamanho: "G" }] : [])]),
    ...extra,
  });
  const ids = (os: Order[]) => os.map((o) => o.id);

  it("agrupa por produto fora, na ordem de primeira aparição, e manda sem-fora pro fim", () => {
    const entrada = [com("A", "X"), com("B", "Y"), com("C", "X"), com("D")];
    expect(ids(ordenarPorProdutoFora(entrada, "M"))).toEqual(["A", "C", "B", "D"]);
    expect(ids(entrada)).toEqual(["A", "B", "C", "D"]); // não muta
  });
  it("é estável dentro do grupo e ignora caixa na chave", () => {
    const entrada = [com("1", "Zeus"), com("2", "Leg"), com("3", "zeus"), com("4", "Zeus")];
    expect(ids(ordenarPorProdutoFora(entrada, "M"))).toEqual(["1", "3", "4", "2"]);
  });
});

// Victor (07/11/2026): o quadro "N fecham" ignorava o filtro de exclusão — as
// meninas marcavam 10 produtos pra fechar 58 mistos e o claim entregava 2.
describe("pedidosMistosNosFiltros (mesma régua ilike %termo% do claim)", () => {
  const peds = pedidosMistosDaFila(
    [
      linha("Leg Day - M", "M", 3, ["a", "b", "c"]),
      linha("Surpresa - G", "G", 2, ["a", "b"]),
      linha("Calça RUX - Phantom - G", "G", 1, ["c"]),
      linha("Short Dry Fit 2 em 1 - M", "M", 1, ["b"]),
    ],
    "M",
  );
  it("sem termos devolve tudo", () => {
    expect(pedidosMistosNosFiltros(peds, [], undefined).map((p) => p.id)).toEqual(["a", "b", "c"]);
  });
  it("exclusão tira o pedido com QUALQUER peça (dele ou fora) cujo nome contém o termo, case-insensitive", () => {
    expect(pedidosMistosNosFiltros(peds, ["calça rux"]).map((p) => p.id)).toEqual(["a", "b"]);
    expect(pedidosMistosNosFiltros(peds, ["SHORT DRY FIT"]).map((p) => p.id)).toEqual(["a", "c"]);
    expect(pedidosMistosNosFiltros(peds, ["leg day"])).toEqual([]);
  });
  it("adição mantém só pedido com algum termo; termo vazio é ignorado", () => {
    expect(pedidosMistosNosFiltros(peds, [" "], ["phantom"]).map((p) => p.id)).toEqual(["c"]);
    expect(pedidosMistosNosFiltros(peds, ["surpresa"], ["leg day"]).map((p) => p.id)).toEqual(["c"]);
  });
});

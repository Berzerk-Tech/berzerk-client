import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/lib/api";
import {
  agruparPorEstampa,
  erroSepararUnico,
  filtrarGrupos,
  getGrupoEscolhido,
  getModoFila,
  matchDoSeparar,
  ordenarTamanhos,
  replayJaExpedido,
  rotuloOrderBump,
  rotuloGrupo,
  setGrupoEscolhido,
  setModoFila,
  unicosRotaAusente,
} from "../src/lib/unicosExpedicao";
import type { ExpedicaoOrder, UnicoGrupo } from "../src/services/expedicao";

const grupos: UnicoGrupo[] = [
  { estampa: "Leg Day", tamanho: "G", pedidos: 5, tipos: [{ produtoId: "1", produtoNome: "Oversized", pedidos: 3 }, { produtoId: "2", produtoNome: "Regata", pedidos: 2 }] },
  { estampa: "Ação Direta", tamanho: "M", pedidos: 2, tipos: [{ produtoId: "3", produtoNome: "Camiseta", pedidos: 2 }] },
];

describe("filtrarGrupos", () => {
  it("busca vazia devolve tudo", () => expect(filtrarGrupos(grupos, "  ")).toHaveLength(2));
  it("ignora acento e caixa", () => expect(filtrarGrupos(grupos, "acao direta").map((g) => g.estampa)).toEqual(["Ação Direta"]));
  it("casa pelo tipo de peça e exige todas as palavras", () => {
    expect(filtrarGrupos(grupos, "regata").map((g) => g.estampa)).toEqual(["Leg Day"]);
    expect(filtrarGrupos(grupos, "leg regata g")).toHaveLength(1);
    expect(filtrarGrupos(grupos, "leg camiseta")).toHaveLength(0);
  });
});

describe("erroSepararUnico", () => {
  const g = { estampa: "Leg Day", tamanho: "G" };
  const api = (status: number, body: unknown) => new ApiError(status, "x", body);
  it("peça de outra fila", () => {
    const e = erroSepararUnico(api(409, { error: "peca_de_outra_fila", estampa: "Ember", tamanho: "M", produtoNome: "Oversized" }), g);
    expect(e.message).toBe("Esta peça é Ember M. A fila escolhida é LEG DAY · G.");
    expect(e.trocarFila).toBe(true);
    expect(e.definitivo).toBe(true);
  });
  it("sem pedido único (retenta)", () => {
    const e = erroSepararUnico(api(409, { error: "sem_pedido_unico", estampa: "Leg Day", tamanho: "G", produtoNome: "Regata" }), g);
    expect(e.message).toBe("Nenhum pedido único aguardando Regata G.");
    expect(e.definitivo).toBe(false);
  });
  it("várias peças, não resolvido, indisponível", () => {
    expect(erroSepararUnico(api(409, { error: "varias_pecas" }), g).message).toBe("Deixe só uma peça na mesa.");
    expect(erroSepararUnico(api(422, { error: "epc_nao_resolvido" }), g).message).toBe("Peça não reconhecida (etiqueta sem cadastro).");
    const i = erroSepararUnico(api(409, { error: "pedido_indisponivel" }), g);
    expect(i.message).toBe("Bipe a peça de novo.");
    expect(i.definitivo).toBe(false);
  });
  it("404 do Nest sem rota = API sem a fila; 404 de gateway não desliga o modo", () => {
    const nest = api(404, { statusCode: 404, message: "Cannot POST /expedicao/unicos/separar", error: "Not Found" });
    expect(erroSepararUnico(nest, g).code).toBe("nexus_pendente");
    expect(unicosRotaAusente(nest)).toBe(true);
    expect(unicosRotaAusente(api(404, null))).toBe(false);
    expect(unicosRotaAusente(api(404, { message: "Not Found" }))).toBe(false);
    const gw = erroSepararUnico(api(404, { message: "Not Found" }), g);
    expect(gw.code).not.toBe("nexus_pendente");
  });
  it("4xx desconhecido é definitivo (sem retry); 5xx e rede não", () => {
    const e = erroSepararUnico(api(409, { error: "invalid_status", message: "Pedido não está pronto." }), g);
    expect(e).toMatchObject({ code: "invalid_status", message: "Pedido não está pronto.", definitivo: true });
    expect(erroSepararUnico(api(400, null), g)).toMatchObject({ code: "erro_servidor", message: "Recusado pelo servidor.", definitivo: true });
    expect(erroSepararUnico(api(422, { error: "x" }), g).definitivo).toBe(true);
    expect(erroSepararUnico(api(503, { error: "x" }), g)).toMatchObject({ code: "sem_conexao", definitivo: false });
  });
  it("rede = sem conexão", () => {
    const r = erroSepararUnico(new TypeError("fetch"), g);
    expect(r.message).toBe("Sem conexão, bipe de novo.");
    expect(r.definitivo).toBe(false);
  });
});

describe("matchDoSeparar / replay", () => {
  const order = { id: "o1", numero: "10", status: "awaiting_pickup", rfidTags: ["aaa"] } as unknown as ExpedicaoOrder;
  it("monta o match de 1 peça com a tag em maiúsculas", () => {
    const m = matchDoSeparar(order, ["aaa", "AAA"]);
    expect(m.tagsLidas).toEqual(["AAA"]);
    expect(m.tagsFaltantes).toEqual([]);
    expect(m.tagsMatched).toBe(1);
    expect(m.tagsTotal).toBe(1);
  });
  it("replay só é 'já expedido' quando shipped", () => {
    expect(replayJaExpedido({ order, replay: true })).toBe(false);
    expect(replayJaExpedido({ order: { ...order, status: "shipped" }, replay: true })).toBe(true);
    expect(replayJaExpedido({ order: { ...order, status: "shipped" }, replay: false })).toBe(false);
  });
});

describe("persistência", () => {
  beforeEach(() => localStorage.clear());
  it("modo e grupo sobrevivem; padrão é Pedidos", () => {
    expect(getModoFila()).toBe("pedidos");
    setModoFila("unicos");
    expect(getModoFila()).toBe("unicos");
    expect(getGrupoEscolhido()).toBeNull();
    setGrupoEscolhido({ estampa: "Leg Day", tamanho: "G" });
    expect(getGrupoEscolhido()).toEqual({ estampa: "Leg Day", tamanho: "G" });
    expect(rotuloGrupo(getGrupoEscolhido()!)).toBe("LEG DAY · G");
    setGrupoEscolhido(null);
    expect(getGrupoEscolhido()).toBeNull();
  });
});

describe("ordenarTamanhos", () => {
  it("segue PP…U, ignora caixa/espaço e põe desconhecidos no fim em ordem alfabética", () => {
    const l = ["U", "xg", " M ", "ZZ", "PP", "AA", "G", "P"].sort(ordenarTamanhos).map((t) => t.trim().toUpperCase());
    expect(l).toEqual(["PP", "P", "M", "G", "XG", "U", "AA", "ZZ"]);
  });
});

describe("agruparPorEstampa", () => {
  const g = (estampa: string, tamanho: string, pedidos: number, extra: Partial<UnicoGrupo> = {}): UnicoGrupo => ({ estampa, tamanho, pedidos, ...extra });
  it("soma pedidos e prioritários, pega a primeira imagem não nula e ordena os tamanhos", () => {
    const r = agruparPorEstampa([
      g("Leg Day", "XG", 1, { prioritarios: 1 }),
      g("Leg Day", "P", 6, { imagemUrl: "a.jpg", prioritarios: 2 }),
      g("Leg Day", "ZZZ", 1, { imagemUrl: "b.jpg" }),
      g("Leg Day", "M", 2),
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ estampa: "Leg Day", pedidos: 10, prioritarios: 3, imagemUrl: "a.jpg" });
    expect(r[0].tamanhos.map((t) => t.tamanho)).toEqual(["P", "M", "XG", "ZZZ"]);
  });
  it("mantém a ordem de primeira aparição das estampas e imagem nula quando não há", () => {
    const r = agruparPorEstampa([g("B", "M", 1), g("A", "G", 1), g("B", "G", 1)]);
    expect(r.map((e) => e.estampa)).toEqual(["B", "A"]);
    expect(r[0].imagemUrl).toBeNull();
    expect(r[0].prioritarios).toBe(0);
  });
});

describe("order bump", () => {
  const api = (status: number, body: unknown) => new ApiError(status, "x", body);
  it("order_bump_necessario não é definitivo e cita o produto", () => {
    const e = erroSepararUnico(
      api(409, { error: "order_bump_necessario", orderBump: { produtoId: "9", produtoNome: "Touca Berzerk" } }),
      { estampa: "Leg Day", tamanho: "G" },
    );
    expect(e.code).toBe("order_bump_necessario");
    expect(e.definitivo).toBe(false);
    expect(e.message).toBe("Este pedido tem order bump: leia a peça junto com Touca Berzerk.");
  });
  it("bump_sem_pedido não é definitivo e diz pra tirar o item da mesa", () => {
    const e = erroSepararUnico(
      api(409, { error: "bump_sem_pedido", produtoNome: "Oversized Leg Day", tamanho: "G", orderBump: { produtoId: "9", produtoNome: "Touca Berzerk" } }),
      { estampa: "Leg Day", tamanho: "G" },
    );
    expect(e.code).toBe("bump_sem_pedido");
    expect(e.definitivo).toBe(false);
    expect(e.message).toBe("Nenhum pedido de Oversized Leg Day G leva Touca Berzerk. Se o item não é desta caixa, tire-o da mesa e leia só a peça.");
  });
  it("agrupa comOrderBump por estampa (ausente = 0)", () => {
    const g: UnicoGrupo[] = [
      { estampa: "Leg Day", tamanho: "G", pedidos: 3, comOrderBump: 2 },
      { estampa: "Leg Day", tamanho: "M", pedidos: 1 },
    ];
    expect(agruparPorEstampa(g)[0].comOrderBump).toBe(2);
  });
  it("rótulo do botão", () => {
    expect(rotuloOrderBump(null)).toBe("Order bump: desligado");
    expect(rotuloOrderBump({ ativo: false, produtos: [] })).toBe("Order bump: desligado");
    expect(rotuloOrderBump({ ativo: true, produtos: [{ id: "1", nome: "Touca", imagemUrl: null }] })).toBe("Order bump: Touca");
  });
});

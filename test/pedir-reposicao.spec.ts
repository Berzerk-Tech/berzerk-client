// Pedir reposição — regras puras (limites, ordenação, textos).
import { describe, expect, it } from "vitest";
import type { Order } from "../src/services/orders";
import type { ItemCatalogoReposicao } from "../src/services/reposicaoPedidos";
import {
  ajustarCarrinho,
  chavesDaMesa,
  itensPediveis,
  maximoDoCard,
  mensagemDoErro,
  ordenarItens,
  resumoDosMeus,
  rotuloHa,
  agoraDoServidor,
  assinaturaDoCarrinho,
  situacaoDoTeto,
  somarPacote,
  tamanhoInicial,
  tirarPacote,
} from "../src/lib/pedirReposicao";

function item(o: Partial<ItemCatalogoReposicao> & { produtoId: string }): ItemCatalogoReposicao {
  return {
    nome: `Oversized - ${o.produtoId}`,
    nomeCurto: o.produtoId,
    imagemUrl: null,
    grupo: "Oversized",
    cor: "preta",
    corIndefinida: false,
    picking: 30,
    limite: 30,
    pendenteQtd: 0,
    pendentePedidos: 0,
    faltaQtd: 0,
    estoqueLoja: null,
    estado: "ativo",
    fixado: false,
    ...o,
  };
}

describe("limite do card", () => {
  it("limite − pendente, em múltiplos de 10", () => {
    expect(maximoDoCard(item({ produtoId: "a", limite: 30, pendenteQtd: 10 }), true)).toBe(20);
    expect(maximoDoCard(item({ produtoId: "a", limite: 30, pendenteQtd: 30 }), true)).toBe(0);
    expect(maximoDoCard(item({ produtoId: "a", limite: 0 }), true)).toBe(0);
  });
  it("sem picking disponível o app não bloqueia pelo limite", () => {
    expect(maximoDoCard(item({ produtoId: "a", limite: 0 }), false)).toBeGreaterThan(1000);
  });
  it("carrinho soma de 10 em 10 e para no teto", () => {
    const i = item({ produtoId: "a", limite: 20 });
    let c = somarPacote({}, i, true);
    c = somarPacote(c, i, true);
    c = somarPacote(c, i, true);
    expect(c).toEqual({ a: 20 });
    expect(tirarPacote(c, "a")).toEqual({ a: 10 });
    expect(tirarPacote({ a: 10 }, "a")).toEqual({});
  });
  it("ajustarCarrinho encosta no novo máximo sem perder o resto", () => {
    const antes = { a: 30, b: 10, c: 10 };
    const novo = ajustarCarrinho(antes, {
      pickingDisponivel: true,
      itens: [item({ produtoId: "a", limite: 30, pendenteQtd: 20 }), item({ produtoId: "b" }), item({ produtoId: "c", estado: "inativado" })],
    });
    expect(novo).toEqual({ a: 10, b: 10 });
    const igual = { a: 10 };
    expect(ajustarCarrinho(igual, { pickingDisponivel: true, itens: [item({ produtoId: "a" })] })).toBe(igual);
  });
});

describe("lista", () => {
  it("só ativos com picking > 0 (sem picking disponível, todos os ativos)", () => {
    const itens = [item({ produtoId: "a" }), item({ produtoId: "b", picking: 0 }), item({ produtoId: "c", estado: "sem_picking" })];
    expect(itensPediveis({ itens, pickingDisponivel: true }).map((i) => i.produtoId)).toEqual(["a"]);
    expect(itensPediveis({ itens, pickingDisponivel: false }).map((i) => i.produtoId)).toEqual(["a", "b"]);
  });
  it("ordena: da mesa primeiro (picking desc), depois por nome; busca sem acento", () => {
    const itens = [
      item({ produtoId: "z", nome: "Oversized - Zeus", nomeCurto: "Zeus", picking: 10 }),
      item({ produtoId: "m", nome: "Oversized - Myth", nomeCurto: "Myth", picking: 20 }),
      item({ produtoId: "k", nome: "Oversized - Kurabu", nomeCurto: "Kurabu", picking: 90 }),
    ];
    const pedido = {
      items: [
        { id: "1", ean: null, sku: null, nome: "Oversized - Zeus - M", tamanho: "M", quantidade: 1, imagemUrl: null },
        { id: "2", ean: null, sku: null, nome: "Oversized - Myth - M", tamanho: "M", quantidade: 1, imagemUrl: null },
        { id: "3", ean: null, sku: null, nome: "Oversized - Kurabu - G", tamanho: "G", quantidade: 1, imagemUrl: null },
      ],
    } as unknown as Order;
    const chaves = chavesDaMesa([pedido], "M");
    expect(ordenarItens(itens, { busca: "", chavesMesa: chaves, tamanho: "M" }).map((i) => i.produtoId)).toEqual(["m", "z", "k"]);
    expect(ordenarItens(itens, { busca: "MYTH", chavesMesa: chaves, tamanho: "M" }).map((i) => i.produtoId)).toEqual(["m"]);
    expect(ordenarItens(itens, { busca: "", chavesMesa: new Set(), tamanho: "M" }).map((i) => i.produtoId)).toEqual(["k", "m", "z"]);
  });
});

describe("teto pessoal", () => {
  it("sem teto (0) não mostra", () => {
    expect(situacaoDoTeto({ porPessoa: 0, pendentesMeus: 3, fila: 0, pendentesFila: 0 }, 2).mostrar).toBe(false);
    expect(situacaoDoTeto(undefined, 2).mostrar).toBe(false);
  });
  it("mostra X de Y e bloqueia o que estoura", () => {
    const lim = { porPessoa: 5, pendentesMeus: 3, fila: 0, pendentesFila: 0 };
    const ok = situacaoDoTeto(lim, 2);
    expect(ok).toMatchObject({ mostrar: true, excede: false });
    expect(ok.texto).toContain("3 de 5");
    const ruim = situacaoDoTeto(lim, 3);
    expect(ruim.excede).toBe(true);
    expect(ruim.texto).toContain("tire 1");
  });
});

describe("textos e rótulos", () => {
  it("erros 409 em linguagem simples", () => {
    expect(mensagemDoErro({ error: "fila_cheia", limite: 5, pendentes: 5 })).toBe(
      "Os repositores estão com a fila cheia. Tente de novo em alguns minutos.",
    );
    expect(mensagemDoErro({ error: "limite_pessoa", limite: 3, pendentes: 3 })).toBe(
      "Você já tem 3 pedidos em aberto. Espere a reposição chegar.",
    );
  });
  it("agoraDoServidor corrige relógio da estação e assinatura do carrinho é estável", () => {
    expect(agoraDoServidor({ deslocamentoMs: 60_000 }, 1000)).toBe(61_000);
    expect(agoraDoServidor(null, 1000)).toBe(1000);
    expect(assinaturaDoCarrinho("M", { b: 10, a: 20 })).toBe(assinaturaDoCarrinho("M", { a: 20, b: 10 }));
    expect(assinaturaDoCarrinho("M", { a: 10 })).not.toBe(assinaturaDoCarrinho("G", { a: 10 }));
  });
  it("rotuloHa", () => {
    const agora = Date.parse("2026-11-10T12:00:00Z");
    expect(rotuloHa("2026-11-10T11:59:40Z", agora)).toBe("agora");
    expect(rotuloHa("2026-11-10T11:55:00Z", agora)).toBe("há 5 min");
    expect(rotuloHa("2026-11-10T09:00:00Z", agora)).toBe("há 3 h");
    expect(rotuloHa(null, agora)).toBe("");
  });
  it("resumo do botão: falta vence, reposto só se recente", () => {
    const agora = Date.parse("2026-11-10T12:00:00Z");
    const l = (o: object) => ({ id: "x", falta: false, atendidoEm: null, ...o }) as never;
    expect(resumoDosMeus(null, agora).destaque).toBeNull();
    expect(resumoDosMeus({ agora: "", pendentes: [l({}), l({ falta: true })], atendidos24h: [] }, agora)).toMatchObject({ pendentes: 2, destaque: "falta" });
    expect(resumoDosMeus({ agora: "", pendentes: [], atendidos24h: [l({ atendidoEm: "2026-11-10T11:55:00Z" })] }, agora).destaque).toBe("reposto");
    expect(resumoDosMeus({ agora: "", pendentes: [], atendidos24h: [l({ atendidoEm: "2026-11-10T08:00:00Z" })] }, agora).destaque).toBeNull();
  });
  it("tamanho inicial vem da fila", () => {
    const v = ["P", "M", "G", "GG", "XG"];
    expect(tamanhoInicial({ size: "M", sizes: ["M"] }, v)).toBe("M");
    expect(tamanhoInicial({ size: "XG", sizes: ["XG", "XXG"] }, v)).toBe("XG");
    expect(tamanhoInicial({ size: "PP", sizes: ["PP"] }, v)).toBeNull();
  });
});

// `claimLote` com `novaLista` (pipeline de listas nos mistos, 15/10): o campo
// só vai no body quando pedido (nexus antigo ignora; o app antigo não manda),
// `novos` volta tipado e o 409 `limite_listas_abertas` tem parse próprio.
//
// `apiRequest` é um stub manual (não `vi.fn`): no vitest 5 um erro lançado de
// dentro de um `vi.fn` marca o teste como falho mesmo tratado pelo código.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Chamada = [string, { body?: Record<string, unknown> } | undefined];
const chamadas: Chamada[] = [];
let resposta: () => unknown = () => Promise.resolve(null);
vi.mock("../src/lib/api", async () => {
  const real = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...real,
    apiRequest: (path: string, opts?: { body?: Record<string, unknown> }) => {
      chamadas.push([path, opts]);
      return resposta();
    },
  };
});

const { ApiError } = await import("../src/lib/api");
const { claimLote, limiteListasAbertas } = await import("../src/services/orders");

describe("claimLote novaLista", () => {
  beforeEach(() => {
    chamadas.length = 0;
  });

  it("sem novaLista o body é o de sempre (com canal ecommerce)", async () => {
    resposta = () => Promise.resolve({ orders: [], fila: { restantes: 3 } });
    const r = await claimLote({ mode: "total", sizes: ["M"] });
    expect(r.novos).toBeUndefined();
    const [path, opts] = chamadas[0];
    expect(path).toBe("/separacao/lote");
    expect(opts?.body).toEqual({ mode: "total", sizes: ["M"], canal: "ecommerce" });
  });

  it("com novaLista manda o campo e devolve novos", async () => {
    resposta = () => Promise.resolve({ orders: [], fila: { restantes: 0 }, novos: ["a", "b"] });
    const r = await claimLote({ mode: "total", sizes: ["M"], novaLista: true });
    expect(r.novos).toEqual(["a", "b"]);
    expect(chamadas[0][1]?.body).toMatchObject({ mode: "total", sizes: ["M"], novaLista: true });
  });

  it("409 limite_listas_abertas sobe intacto e tem parse com a mensagem montada no client", async () => {
    const corpo = { error: "limite_listas_abertas", message: "Você já tem 2 listas em aberto.", listasAbertas: 2, limite: 2 };
    resposta = () => Promise.reject(new ApiError(409, corpo.message, corpo));
    let erro: unknown = null;
    try {
      await claimLote({ mode: "total", sizes: ["M"], novaLista: true });
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(ApiError);
    expect(chamadas).toHaveLength(1); // 409 não é recusa de valor: não repete com `mixed`
    expect(limiteListasAbertas(erro)).toEqual({
      message:
        "Você já tem 2 listas em aberto (limite 2). Conclua uma lista ou chame o supervisor para devolver uma antes de tirar outra.",
      listasAbertas: 2,
      limite: 2,
    });
    // Sem os números no corpo, cai no texto do servidor.
    expect(limiteListasAbertas(new ApiError(409, "x", { error: "limite_listas_abertas", message: "do servidor" }))?.message).toBe("do servidor");
    expect(limiteListasAbertas(new ApiError(409, "x", { error: "outro" }))).toBeNull();
  });
});

describe("claimLote com Filtro Mistos (PP–G3, sem limite)", () => {
  beforeEach(() => {
    chamadas.length = 0;
    resposta = () => Promise.resolve({ orders: [] });
  });

  it("com mistosProdutos manda mistosTamanhos e NÃO manda quantidade", async () => {
    await claimLote({ mode: "total", sizes: ["M"], quantidade: 100, filters: { mistosProdutos: ["Zeus"] } });
    const body = chamadas[0][1]?.body ?? {};
    expect(body.mistosProdutos).toEqual(["Zeus"]);
    expect(body.mistosTamanhos).toEqual(["PP", "P", "M", "G", "GG", "XG", "G3"]);
    expect("quantidade" in body).toBe(false);
  });

  it("sem filtro manda quantidade como sempre e não leva mistosTamanhos", async () => {
    await claimLote({ mode: "total", sizes: ["M"], quantidade: 100 });
    const body = chamadas[0][1]?.body ?? {};
    expect(body.quantidade).toBe(100);
    expect("mistosTamanhos" in body).toBe(false);
    expect("mistosProdutos" in body).toBe(false);
  });
});

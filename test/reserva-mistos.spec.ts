// Partes puras do "Imprimir e reservar" do Filtro Mistos.
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/lib/api";
import { folhaDosReservados, motivoDaFalhaDoLote, reservarComRollback, separarFolha, textoCarimbo, textoForaDaFolha, textoReservados } from "../src/lib/reservaMistos";
import type { Order } from "../src/services/orders";

function pedido(id: string, itens: Array<[string, string, number]>): Order {
  return {
    id,
    predominantSize: "M",
    items: itens.map(([nome, tamanho, quantidade], i) => ({
      id: `${id}-${i}`, nome, produto: nome.replace(/ - (M|G|GG)$/, ""), tamanho, ean: null, imagemUrl: null, quantidade,
    })),
  } as unknown as Order;
}

describe("folhaDosReservados", () => {
  it("soma só as peças de outro tamanho dos pedidos reivindicados e usa a contagem real", () => {
    const f = folhaDosReservados(
      [
        pedido("a", [["Over - Leg Day - M", "M", 1], ["Over - Surpresa - G", "G", 2]]),
        pedido("b", [["Over - Surpresa - GG", "GG", 1]]),
      ],
      "M",
    );
    expect(f.pedidos).toBe(2);
    expect(f.linhas).toHaveLength(1);
    expect(f.linhas[0]).toMatchObject({ produto: "Over - Surpresa", total: 3, grade: { P: 0, G: 2, GG: 1, XG: 0 } });
  });
});

describe("textoReservados", () => {
  it("igual, menos e mais que o previsto", () => {
    expect(textoReservados(2, 2)).toBe("2 pedidos reservados pra você.");
    expect(textoReservados(1, 1)).toBe("1 pedido reservado pra você.");
    expect(textoReservados(3, 5)).toContain("Reservados 3 de 5 pedidos");
    expect(textoReservados(6, 5)).toContain("Reservados 6 pedidos (o quadro previa 5");
  });
});

describe("motivoDaFalhaDoLote", () => {
  it("reconhece limite de listas e produto reservado; o resto é null", () => {
    const limite = new ApiError(409, "x", { error: "limite_listas_abertas", message: "Você já tem 2 lista(s) em aberto." });
    expect(motivoDaFalhaDoLote(limite)).toContain("Nada foi impresso");
    const res = new ApiError(409, "x", { error: "mistos_produto_reservado", termo: "Surpresa", operadora: { sub: "s", nome: "Ana" } });
    const t = motivoDaFalhaDoLote(res)!;
    expect(t).toContain("Surpresa");
    expect(t).toContain("por Ana");
    expect(motivoDaFalhaDoLote(new Error("boom"))).toBeNull();
  });
});

describe("separarFolha / textos", () => {
  it("tira da folha o que já estava na mão dela", () => {
    const a = pedido("a", [["Over - X - G", "G", 1]]);
    const b = { ...pedido("b", [["Over - X - G", "G", 1]]), iniciadoEm: "2026-11-10T10:00:00Z" } as Order;
    const { paraFolha, fora } = separarFolha([a, b], (o) => !!o.iniciadoEm);
    expect(paraFolha.map((o) => o.id)).toEqual(["a"]);
    expect(fora.map((o) => o.id)).toEqual(["b"]);
    expect(textoForaDaFolha(0)).toBe("");
    expect(textoForaDaFolha(1)).toBe("1 pedido já estava na sua mesa e não entrou na folha.");
    expect(textoForaDaFolha(3)).toBe("3 pedidos já estavam na sua mesa e não entraram na folha.");
    expect(textoCarimbo(2, 2)).toBe("");
    expect(textoCarimbo(1, 3)).toBe("1 de 3 pedidos carimbados.");
  });
});

describe("reservarComRollback", () => {
  const antes = { includeProducts: ["A"] };
  const novo = { mistosProdutos: ["Surpresa"] };
  const montar = (puxar: () => Promise<Order[] | undefined>, mesa: string[] = []) => {
    const chamadas: unknown[] = [];
    const deps = {
      filtrosAnteriores: antes,
      aplicarFiltro: vi.fn((f: unknown) => void chamadas.push(f)),
      puxar: vi.fn(puxar),
      idsNaMesa: () => mesa,
      traduzirErro: (e: unknown) => `erro: ${e instanceof Error ? e.message : String(e)}`,
    };
    return { deps, chamadas };
  };

  it("sucesso: aplica o filtro uma vez, não restaura e marca fora da folha o que já estava na mesa ou iniciado", async () => {
    const a = pedido("a", [["Over - X - G", "G", 1]]);
    const b = pedido("b", [["Over - X - G", "G", 1]]);
    const c = { ...pedido("c", [["Over - X - G", "G", 1]]), iniciadoEm: "2026-11-10T10:00:00Z" } as Order;
    const { deps, chamadas } = montar(async () => [a, b, c], ["b"]);
    const r = await reservarComRollback(deps, novo);
    expect(chamadas).toEqual([novo]);
    expect(r).toMatchObject({ ok: true, foraDaFolha: ["b", "c"] });
    if (r.ok) expect(r.novos.map((o) => o.id)).toEqual(["a", "b", "c"]);
  });

  it("409/rede ao puxar: restaura o filtro anterior e devolve o motivo", async () => {
    const { deps, chamadas } = montar(async () => {
      throw new Error("409");
    });
    const r = await reservarComRollback(deps, novo);
    expect(r).toEqual({ ok: false, motivo: "erro: 409" });
    expect(chamadas).toEqual([novo, antes]);
  });

  it("mesa ocupada (undefined) e fila vazia também restauram", async () => {
    const u = montar(async () => undefined);
    expect((await reservarComRollback(u.deps, novo)).ok).toBe(false);
    expect(u.chamadas).toEqual([novo, antes]);
    const v = montar(async () => []);
    expect((await reservarComRollback(v.deps, novo)).ok).toBe(false);
    expect(v.chamadas).toEqual([novo, antes]);
  });
});

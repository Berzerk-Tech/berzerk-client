import { describe, expect, it } from "vitest";
import { ApiError } from "../src/lib/api";
import { textoReservadosPorOutras } from "../src/lib/mistos";
import {
  ehListaImpressaSemSuporte,
  montarBodySoltar,
  podeSoltarSemPin,
  textoPedidoSolto,
} from "../src/lib/soltar-pedido";

describe("soltar pedido da lista", () => {
  it("monta o body do release com motivo e observação aparada/limitada", () => {
    expect(montarBodySoltar("falta_peca")).toEqual({ motivo: "falta_peca" });
    expect(montarBodySoltar("outro", "  sem a P  ")).toEqual({ motivo: "outro", observacao: "sem a P" });
    expect(montarBodySoltar("falta_peca", "x".repeat(300)).observacao).toHaveLength(200);
  });

  it("mostra o botão sem PIN só com listaEm e pedido dela", () => {
    expect(podeSoltarSemPin({ listaEm: "2026-11-05T10:00:00Z", claimedBy: "op-1" }, "op-1")).toBe(true);
    expect(podeSoltarSemPin({ listaEm: null, claimedBy: "op-1" }, "op-1")).toBe(false);
    expect(podeSoltarSemPin({ listaEm: "2026-11-05T10:00:00Z", claimedBy: "op-2" }, "op-1")).toBe(false);
    expect(podeSoltarSemPin({ listaEm: "2026-11-05T10:00:00Z", claimedBy: "op-1" }, undefined)).toBe(false);
  });

  it("409 lista_impressa cai no fallback do PIN; outros erros não", () => {
    expect(ehListaImpressaSemSuporte(new ApiError(409, "x", { error: "lista_impressa" }))).toBe(true);
    expect(ehListaImpressaSemSuporte(new ApiError(409, "lista_impressa"))).toBe(true);
    expect(ehListaImpressaSemSuporte(new ApiError(409, "outro", { error: "invalid_status" }))).toBe(false);
    expect(ehListaImpressaSemSuporte(new ApiError(500, "lista_impressa"))).toBe(false);
    expect(ehListaImpressaSemSuporte(new Error("lista_impressa"))).toBe(false);
  });

  it("texto do toast", () => {
    expect(textoPedidoSolto("700001", { restantesNaLista: 4 })).toBe("Pedido 700001 solto da lista (restam 4 na lista).");
    expect(textoPedidoSolto("700001", { restantesNaLista: 0 })).toContain("a lista acabou");
    expect(textoPedidoSolto(null, {})).toBe("Pedido solto da lista.");
  });

  it("reservados por outra operadora no rodapé do Filtro Mistos", () => {
    expect(textoReservadosPorOutras(undefined)).toBeNull();
    expect(
      textoReservadosPorOutras([
        { termo: "Sailor Moon", operadora: { nome: "Ana" } },
        { termo: "Atlas", operadora: { nome: null } },
      ]),
    ).toBe("Em uso por outra operadora: Sailor Moon (Ana), Atlas");
  });
});

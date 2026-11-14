import { beforeEach, describe, expect, it } from "vitest";
import {
  aplicarPausa,
  comBump,
  continuar,
  indiceAtual,
  lerLoteEmCurso,
  limparLoteEmCurso,
  novoLote,
  paraLiberar,
  pedirPausa,
  proximoPedido,
  registrarConcluido,
  registrarErroConclusao,
  registrarPulo,
  resumo,
  salvarLoteEmCurso,
  terminou,
} from "../src/lib/impressaoManualLote";
import type { ImpressaoManualPedido } from "../src/services/expedicao";

const ped = (n: number, comBump = false): ImpressaoManualPedido => ({ orderId: `o${n}`, numero: `${n}`, cliente: null, tracking: `JT${n}`, emitidoEm: null, comBump });

describe("impressão manual: máquina de estados do lote", () => {
  beforeEach(() => localStorage.clear());

  it("avança na ordem e termina", () => {
    let l = novoLote("L1", [ped(1), ped(2)]);
    expect(proximoPedido(l)?.orderId).toBe("o1");
    expect(indiceAtual(l)).toBe(1);
    l = registrarConcluido(l, "o1");
    expect(proximoPedido(l)?.orderId).toBe("o2");
    l = registrarConcluido(l, "o2");
    expect(proximoPedido(l)).toBeNull();
    expect(terminou(l)).toBe(true);
    expect(paraLiberar(l)).toEqual([]);
  });

  it("pausa só vale entre etiquetas e continuar retoma", () => {
    let l = novoLote("L1", [ped(1), ped(2)]);
    l = pedirPausa(l);
    expect(l.pausado).toBe(false);
    expect(proximoPedido(l)?.orderId).toBe("o1"); // etiqueta em curso segue
    l = registrarConcluido(l, "o1");
    l = aplicarPausa(l);
    expect(proximoPedido(l)).toBeNull();
    l = continuar(l);
    expect(proximoPedido(l)?.orderId).toBe("o2");
  });

  it("pulado não é concluído e vai pra liberar; resumo conta tudo", () => {
    let l = novoLote("L1", [ped(1), ped(2), ped(3)]);
    l = registrarPulo(l, ped(1), "sem etiqueta");
    l = registrarConcluido(l, "o2");
    expect(proximoPedido(l)?.orderId).toBe("o3");
    expect(paraLiberar(l)).toEqual(["o1", "o3"]);
    const r = resumo(l);
    expect(r).toMatchObject({ total: 3, expedidos: 1, naoImpressos: 1 });
    expect(r.pulados[0]).toMatchObject({ orderId: "o1", motivo: "sem etiqueta" });
  });

  it("etiqueta_ausente conta como pulado; outro erro fica registrado e segue", () => {
    let l = novoLote("L1", [ped(1), ped(2)]);
    l = registrarErroConclusao(l, ped(1), { status: 409, codigo: "etiqueta_ausente", mensagem: "x" });
    expect(l.pulados).toHaveLength(1);
    l = registrarErroConclusao(l, ped(2), { status: 409, codigo: "pedido_nao_reservado", mensagem: "y" });
    expect(l.errosConclusao[0].codigo).toBe("pedido_nao_reservado");
    expect(l.interrompido).toBeNull();
    expect(terminou(l)).toBe(true);
  });

  it("403 pausa o lote; 3 falhas de rede seguidas pausam; sucesso zera o contador", () => {
    let l = novoLote("L1", [ped(1), ped(2), ped(3), ped(4)]);
    const rede = { mensagem: "offline", rede: true };
    l = registrarErroConclusao(l, ped(1), rede);
    l = registrarErroConclusao(l, ped(2), rede);
    expect(l.interrompido).toBeNull();
    l = registrarConcluido(l, "o3");
    expect(l.falhasRedeSeguidas).toBe(0);
    l = registrarErroConclusao(l, ped(4), rede);
    expect(l.interrompido).toBeNull();
    let m = novoLote("L2", [ped(1), ped(2), ped(3)]);
    for (const n of [1, 2, 3]) m = registrarErroConclusao(m, ped(n), rede);
    expect(m.interrompido).toMatch(/3 falhas/);
    const f = registrarErroConclusao(novoLote("L3", [ped(1)]), ped(1), { status: 403, codigo: "impressao_manual_nao_liberada", mensagem: "x" });
    expect(f.interrompido).toMatch(/403/);
    expect(proximoPedido(f)).toBeNull();
  });

  it("conta order bump", () => {
    expect(comBump(novoLote("L", [ped(1), ped(2, true), ped(3, true)]))).toBe(2);
  });

  it("persiste só o que falta e limpa", () => {
    let l = novoLote("L9", [ped(1), ped(2)]);
    l = registrarConcluido(l, "o1");
    salvarLoteEmCurso(l);
    expect(lerLoteEmCurso()).toEqual({ loteId: "L9", orderIds: ["o2"] });
    limparLoteEmCurso();
    expect(lerLoteEmCurso()).toBeNull();
  });
});

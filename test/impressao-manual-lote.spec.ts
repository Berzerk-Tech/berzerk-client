import { beforeEach, describe, expect, it } from "vitest";
import {
  adicionarReserva,
  aplicarPausa,
  comBump,
  continuar,
  feitosDoTamanho,
  indiceAtual,
  lerLoteEmCurso,
  limparLoteEmCurso,
  novoLote,
  novoLoteVazio,
  paraLiberar,
  pedirPausa,
  proximoPedido,
  registrarConcluido,
  registrarErroConclusao,
  registrarPulo,
  registrarTamanhoVazio,
  resumo,
  resumoPorTamanho,
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

describe("impressão manual: grade toda (união de reservas)", () => {
  beforeEach(() => localStorage.clear());

  it("junta reservas por tamanho, cada pedido guarda a sua reserva e o seu tamanho", () => {
    let l = novoLoteVazio();
    l = adicionarReserva(l, "LP", "P", [ped(1), ped(2)]);
    l = adicionarReserva(l, "LM", "M", [ped(3)]);
    l = adicionarReserva(l, "LM2", "M", [ped(4)]);
    expect(l.loteId).toBe("LP");
    expect(l.loteIds).toEqual(["LP", "LM", "LM2"]);
    expect(l.pedidos.map((p) => [p.orderId, p.loteId, p.tamanho])).toEqual([
      ["o1", "LP", "P"],
      ["o2", "LP", "P"],
      ["o3", "LM", "M"],
      ["o4", "LM2", "M"],
    ]);
    expect(proximoPedido(l)?.orderId).toBe("o1");
    expect(feitosDoTamanho(registrarConcluido(l, "o1"), "P")).toBe(1);
  });

  it("resumo por tamanho em ordem canônica, com vazios registrados", () => {
    let l = novoLoteVazio();
    l = adicionarReserva(l, "LG", "G", [ped(5), ped(6)]);
    l = adicionarReserva(l, "LP", "P", [ped(1), ped(2), ped(3)]);
    l = registrarTamanhoVazio(registrarTamanhoVazio(l, "M"), "M");
    l = registrarConcluido(l, "o1");
    l = registrarPulo(l, l.pedidos[3], "sem etiqueta");
    l = registrarErroConclusao(l, l.pedidos[4], { codigo: "x", mensagem: "falhou" });
    l = registrarConcluido(l, "o5");
    expect(l.tamanhosVazios).toEqual(["M"]);
    expect(resumoPorTamanho(l)).toEqual([
      { tamanho: "P", total: 3, expedidos: 1, pulados: 1, erros: 1, naoImpressos: 0 },
      { tamanho: "G", total: 2, expedidos: 1, pulados: 0, erros: 0, naoImpressos: 1 },
    ]);
  });

  it("persiste a união pendente (reservado e não expedido) com todos os ids de reserva", () => {
    let l = novoLoteVazio();
    l = adicionarReserva(l, "LP", "P", [ped(1), ped(2)]);
    l = adicionarReserva(l, "LM", "M", [ped(3)]);
    l = registrarConcluido(l, "o1");
    salvarLoteEmCurso(l);
    expect(lerLoteEmCurso()).toEqual({ loteId: "LP", loteIds: ["LP", "LM"], orderIds: ["o2", "o3"] });
  });

  it("lê lote salvo no formato antigo (sem loteIds) sem perder nada", () => {
    localStorage.setItem("berzerk_unicos_impressao_manual_lote_v1", JSON.stringify({ loteId: "L9", orderIds: ["a", "b", 3] }));
    expect(lerLoteEmCurso()).toEqual({ loteId: "L9", orderIds: ["a", "b"] });
  });

  it("novoLote antigo continua valendo (um tamanho só)", () => {
    const l = novoLote("L1", [ped(1)], "G");
    expect(l.loteIds).toEqual(["L1"]);
    expect(l.pedidos[0]).toMatchObject({ loteId: "L1", tamanho: "G" });
  });
});

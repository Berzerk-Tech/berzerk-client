// Grade toda: um tamanho por vez (reserva → capa → etiquetas), tamanho vazio pulado, resumo por tamanho
// e reimpressão sem dar baixa.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ordem: string[] = [];
const reservar = vi.fn();
const concluir = vi.fn();
const liberar = vi.fn();
const getDocumentos = vi.fn();
const imprimirDoc = vi.fn();
const printEtiqueta = vi.fn();

vi.mock("../src/services/expedicao", async () => {
  const real = await vi.importActual<typeof import("../src/services/expedicao")>("../src/services/expedicao");
  return {
    ...real,
    reservarImpressaoManual: (...a: unknown[]) => reservar(...a),
    concluirImpressaoManual: (...a: unknown[]) => concluir(...a),
    liberarImpressaoManual: (...a: unknown[]) => liberar(...a),
    getDocumentos: (...a: unknown[]) => getDocumentos(...a),
    getUnicosPedidos: vi.fn(async () => []),
  };
});
vi.mock("../src/services/orders", () => ({ getMe: async () => ({ email: "op@berzerk.com.br" }) }));
vi.mock("../src/lib/printer", () => ({ printEtiquetaUnica: (...a: unknown[]) => printEtiqueta(...a) }));
vi.mock("../src/lib/reimpressao", async () => {
  const real = await vi.importActual<typeof import("../src/lib/reimpressao")>("../src/lib/reimpressao");
  return { ...real, imprimirDocumentoDoPedido: (...a: unknown[]) => imprimirDoc(...a) };
});
vi.mock("../src/services/printerConfig", () => ({ getLabelPrinter: () => "Térmica" }));

const { ImpressaoManualDialog } = await import("../src/components/expedicao/ImpressaoManualDialog");
const { lerHistorico } = await import("../src/lib/impressaoManualHistorico");

const ped = (n: number) => ({ orderId: `o${n}`, numero: `${n}`, cliente: `Cli ${n}`, tracking: `JT${n}`, emitidoEm: null, comBump: false });

function props() {
  return {
    grupo: { estampa: "Leg Day", tamanho: "P", cor: "Preto" },
    grade: [
      { tamanho: "G", pedidos: 1 },
      { tamanho: "M", pedidos: 1 },
      { tamanho: "P", pedidos: 2 },
    ],
    totalNaFila: 4,
    podeImprimir: true,
    onFechar: () => {},
    onAtualizar: () => {},
  };
}

describe("ImpressaoManualDialog — grade toda", () => {
  beforeEach(() => {
    localStorage.clear();
    ordem.length = 0;
    for (const m of [reservar, concluir, liberar, getDocumentos, imprimirDoc, printEtiqueta]) m.mockReset();
    reservar.mockImplementation(async (a: { tamanho: string }) => {
      ordem.push(`reservar:${a.tamanho}`);
      if (a.tamanho === "P") return { loteId: "LP", grupo: {}, pedidos: [ped(1), ped(2)], parcial: false, restantesNaFila: 0 };
      if (a.tamanho === "M") return { loteId: "LM", grupo: {}, pedidos: [], parcial: false, restantesNaFila: 0 };
      return { loteId: "LG", grupo: {}, pedidos: [ped(3)], parcial: false, restantesNaFila: 0 };
    });
    concluir.mockImplementation(async (a: { orderId: string; loteId: string }) => {
      ordem.push(`concluir:${a.orderId}@${a.loteId}`);
      return { orderId: a.orderId, numero: null, status: "shipped" };
    });
    liberar.mockResolvedValue({ liberados: 0 });
    getDocumentos.mockResolvedValue({ etiqueta: { base64: "x", formato: "pdf" } });
    imprimirDoc.mockImplementation(async (o: { id: string }, origem: string) => {
      ordem.push(`imprimir:${o.id}:${origem}`);
      return { ok: true, mensagem: "ok" };
    });
    printEtiqueta.mockImplementation(async (_b: string, _f: string, o: { jobName: string }) => {
      ordem.push(`capa:${o.jobName}`);
      return { ok: true };
    });
  });
  afterEach(() => cleanup());

  it("mostra a grade em ordem canônica e imprime tamanho a tamanho, reservando só na vez de cada um", async () => {
    render(<ImpressaoManualDialog {...props()} />);
    expect(screen.getByLabelText("Tamanhos da grade").textContent).toBe("P 2 · M 1 · G 1 — 4 pedidos");
    fireEvent.click(screen.getByRole("button", { name: /Imprimir grade toda/ }));

    await screen.findByText(/resumo/, undefined, { timeout: 8000 });
    expect(ordem).toEqual([
      "reservar:P",
      "capa:CAPA Leg Day Preto P",
      "imprimir:o1:mesa",
      "concluir:o1@LP",
      "imprimir:o2:mesa",
      "concluir:o2@LP",
      "reservar:M",
      "reservar:G",
      "capa:CAPA Leg Day Preto G",
      "imprimir:o3:mesa",
      "concluir:o3@LG",
    ]);
    expect(screen.getByText("3 de 3 expedidos")).toBeTruthy();
    expect(screen.getByText(/Sem pedidos disponíveis.*M/)).toBeTruthy();
    // o que não ficou expedido (nada) vai pro liberar; histórico tem os 3 pedidos num lote só
    expect(liberar).toHaveBeenCalledWith([]);
    const h = lerHistorico();
    expect(h).toHaveLength(1);
    expect(h[0].tamanhos).toEqual(["P", "G"]);
    expect(h[0].pedidos).toHaveLength(3);
  }, 15000);

  it("reimprimir no resumo usa só a impressão (2a via), sem concluir/reservar/liberar", async () => {
    render(<ImpressaoManualDialog {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: /Imprimir grade toda/ }));
    await screen.findByText(/resumo/, undefined, { timeout: 8000 });
    const antesConcluir = concluir.mock.calls.length;
    const antesReservar = reservar.mock.calls.length;
    const antesLiberar = liberar.mock.calls.length;
    ordem.length = 0;

    fireEvent.click(screen.getByRole("button", { name: "Reimprimir pedido 2" }));
    await waitFor(() => expect(screen.getAllByText("enviada").length).toBe(1));
    expect(ordem).toEqual(["imprimir:o2:historico"]);
    expect(concluir.mock.calls.length).toBe(antesConcluir);
    expect(reservar.mock.calls.length).toBe(antesReservar);
    expect(liberar.mock.calls.length).toBe(antesLiberar);
  }, 15000);

  it("reimprimir mostra o erro da linha e não derruba as outras", async () => {
    render(<ImpressaoManualDialog {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: /Imprimir grade toda/ }));
    await screen.findByText(/resumo/, undefined, { timeout: 8000 });
    imprimirDoc.mockResolvedValueOnce({ ok: false, mensagem: "impressora offline" });
    fireEvent.click(screen.getByRole("button", { name: "Reimprimir pedido 1" }));
    await screen.findByText(/erro: impressora offline/);
    fireEvent.click(screen.getByRole("button", { name: "Reimprimir pedido 3" }));
    await waitFor(() => expect(screen.getAllByText("enviada").length).toBe(1));
  }, 15000);

  it("403 impressao_manual_nao_liberada no meio aborta a grade e libera o resto", async () => {
    const { ApiError } = await import("../src/lib/api");
    reservar.mockImplementation(async (a: { tamanho: string }) => {
      if (a.tamanho === "P") return { loteId: "LP", grupo: {}, pedidos: [ped(1)], parcial: false, restantesNaFila: 0 };
      throw new ApiError(403, "nao liberada", { error: "impressao_manual_nao_liberada" });
    });
    render(<ImpressaoManualDialog {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: /Imprimir grade toda/ }));
    await screen.findByText(/resumo/, undefined, { timeout: 8000 });
    expect(screen.getByText(/não liberada para o seu cadastro/)).toBeTruthy();
    expect(reservar.mock.calls.map((c) => (c[0] as { tamanho: string }).tamanho)).toEqual(["P", "M"]);
    expect(concluir).toHaveBeenCalledTimes(1);
  }, 15000);

  it("Pausar durante a impressão para o lote depois do pedido em curso (não perde a pausa)", async () => {
    let liberarO1: (v: { ok: boolean; mensagem: string }) => void = () => {};
    imprimirDoc.mockImplementationOnce((o: { id: string }) => {
      ordem.push(`imprimir:${o.id}`);
      return new Promise((r) => {
        liberarO1 = r;
      });
    });
    render(<ImpressaoManualDialog {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: /Imprimir grade toda/ }));
    await waitFor(() => expect(ordem).toContain("imprimir:o1"));
    fireEvent.click(screen.getByRole("button", { name: "Pausar" }));
    liberarO1({ ok: true, mensagem: "ok" });
    await screen.findByRole("button", { name: "Continuar" }, { timeout: 8000 });
    expect(ordem).toContain("concluir:o1@LP");
    expect(imprimirDoc).toHaveBeenCalledTimes(1);
    expect(ordem.filter((x) => x === "imprimir:o2:mesa")).toHaveLength(0);
  }, 15000);

  it("Pausar no último pedido de um tamanho não reserva o próximo tamanho", async () => {
    reservar.mockImplementation(async (a: { tamanho: string }) => {
      ordem.push(`reservar:${a.tamanho}`);
      return { loteId: `L${a.tamanho}`, grupo: {}, pedidos: [ped(a.tamanho === "P" ? 1 : 3)], parcial: false, restantesNaFila: 0 };
    });
    let liberarO1: (v: { ok: boolean; mensagem: string }) => void = () => {};
    imprimirDoc.mockImplementationOnce(() => new Promise((r) => (liberarO1 = r)));
    render(<ImpressaoManualDialog {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: /Imprimir grade toda/ }));
    await waitFor(() => expect(imprimirDoc).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Pausar" }));
    liberarO1({ ok: true, mensagem: "ok" });
    await screen.findByRole("button", { name: "Continuar" }, { timeout: 8000 });
    expect(reservar.mock.calls.map((c) => (c[0] as { tamanho: string }).tamanho)).toEqual(["P"]);
  }, 15000);

  it("rodada vazia com sobra no servidor vira 'ficaram na fila', não 'alguém pegou antes'", async () => {
    reservar.mockImplementation(async (a: { tamanho: string }) => {
      if (a.tamanho === "P") return { loteId: "LP", grupo: {}, pedidos: [ped(1)], parcial: false, restantesNaFila: 0 };
      if (a.tamanho === "M") return { loteId: "LM", grupo: {}, pedidos: [], parcial: true, restantesNaFila: 7 };
      return { loteId: "LG", grupo: {}, pedidos: [], parcial: false, restantesNaFila: 0 };
    });
    render(<ImpressaoManualDialog {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: /Imprimir grade toda/ }));
    await screen.findByText(/resumo/, undefined, { timeout: 8000 });
    expect(screen.getByText(/M: 7 pedidos ficaram na fila \(servidor ocupado\), tente de novo/)).toBeTruthy();
    expect(screen.getByText(/Sem pedidos disponíveis.*G/)).toBeTruthy();
    expect(screen.queryByText(/Sem pedidos disponíveis.*M/)).toBeNull();
  }, 15000);

  it("na grade não há Baixar PDF e a tela orienta imprimir um tamanho por vez", () => {
    render(<ImpressaoManualDialog {...props()} />);
    expect(screen.queryByRole("button", { name: /Baixar PDF/ })).toBeNull();
    expect(screen.getByText("Para PDF, imprima um tamanho por vez.")).toBeTruthy();
  });

  it("desmontar a tela para o loop: não reserva nem imprime mais nada", async () => {
    let liberarO1: (v: { ok: boolean; mensagem: string }) => void = () => {};
    imprimirDoc.mockImplementationOnce(() => new Promise((r) => (liberarO1 = r)));
    const { unmount } = render(<ImpressaoManualDialog {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: /Imprimir grade toda/ }));
    await waitFor(() => expect(imprimirDoc).toHaveBeenCalledTimes(1));
    unmount();
    liberarO1({ ok: true, mensagem: "ok" });
    await new Promise((r) => setTimeout(r, 300));
    expect(imprimirDoc).toHaveBeenCalledTimes(1);
    expect(reservar.mock.calls.map((c) => (c[0] as { tamanho: string }).tamanho)).toEqual(["P"]);
  }, 15000);
});

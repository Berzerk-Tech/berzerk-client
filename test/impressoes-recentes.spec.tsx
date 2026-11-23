import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getHistory = vi.fn();
const imprimirDoc = vi.fn();
const concluir = vi.fn();

vi.mock("../src/services/expedicao", async () => {
  const real = await vi.importActual<typeof import("../src/services/expedicao")>("../src/services/expedicao");
  return { ...real, getExpedicaoHistory: (...a: unknown[]) => getHistory(...a), concluirImpressaoManual: (...a: unknown[]) => concluir(...a) };
});
vi.mock("../src/lib/reimpressao", async () => {
  const real = await vi.importActual<typeof import("../src/lib/reimpressao")>("../src/lib/reimpressao");
  return { ...real, imprimirDocumentoDoPedido: (...a: unknown[]) => imprimirDoc(...a) };
});

const { ImpressoesRecentesDialog } = await import("../src/components/expedicao/ImpressoesRecentesDialog");
const { gravarConclusao } = await import("../src/lib/impressaoManualHistorico");

const ped = (n: number, tamanho = "P") => ({ orderId: `o${n}`, numero: `${n}`, cliente: `Cli ${n}`, tracking: `JT${n}`, comBump: false, tamanho });

describe("Impressões recentes", () => {
  beforeEach(() => {
    localStorage.clear();
    getHistory.mockReset();
    concluir.mockReset();
    imprimirDoc.mockReset().mockResolvedValue({ ok: true, mensagem: "ok" });
  });
  afterEach(() => cleanup());

  it("lista o histórico, busca por número e reimprime um pedido sem concluir", async () => {
    gravarConclusao({ loteId: "L1", estampa: "Leg Day", cor: "Preto" }, ped(111));
    gravarConclusao({ loteId: "L1", estampa: "Leg Day", cor: "Preto" }, ped(222, "G"));
    gravarConclusao({ loteId: "L2", estampa: "Árvore", cor: null }, ped(333, "M"));
    render(<ImpressoesRecentesDialog onFechar={() => {}} />);
    expect(screen.getAllByText(/pedidos?$/).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText("Buscar nas impressões recentes"), { target: { value: "arvore" } });
    expect(screen.queryByText(/Leg Day/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Buscar nas impressões recentes"), { target: { value: "222" } });
    const resumo = screen.getByText(/Leg Day/);
    fireEvent.click(resumo);
    fireEvent.click(screen.getByRole("button", { name: "Reimprimir pedido 222" }));
    await waitFor(() => expect(imprimirDoc).toHaveBeenCalledTimes(1));
    expect(imprimirDoc.mock.calls[0][0]).toMatchObject({ id: "o222", numero: "222" });
    expect(imprimirDoc.mock.calls[0][1]).toBe("historico");
    expect(concluir).not.toHaveBeenCalled();
  });

  it("'Reimprimir lote' pede confirmação e só depois imprime todas", async () => {
    gravarConclusao({ loteId: "L1", estampa: "Leg Day", cor: null }, ped(1));
    gravarConclusao({ loteId: "L1", estampa: "Leg Day", cor: null }, ped(2));
    render(<ImpressoesRecentesDialog onFechar={() => {}} />);
    fireEvent.click(screen.getByText(/Leg Day/));
    fireEvent.click(screen.getByRole("button", { name: "Reimprimir lote" }));
    expect(imprimirDoc).not.toHaveBeenCalled();
    await screen.findByText("Reimprimir 2 etiquetas?");
    const confirmar = screen.getAllByRole("button").find((b) => b.textContent?.startsWith("Reimprimir") && b.querySelector("kbd"));
    fireEvent.click(confirmar!);
    await waitFor(() => expect(imprimirDoc).toHaveBeenCalledTimes(2));
  });

  it("reimprime por número de pedido usando o histórico de expedição do servidor", async () => {
    getHistory.mockResolvedValue({
      items: [{ id: "ox", numero: "9001", clienteNome: "Fulana", trackingNumber: "JT9", canal: "ecommerce" }],
      total: 1,
      totals: { pedidos: 1, itens: 1, tags: 1 },
    });
    render(<ImpressoesRecentesDialog onFechar={() => {}} />);
    fireEvent.change(screen.getByLabelText("Número do pedido"), { target: { value: " 9001 " } });
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    await screen.findByText("#9001");
    expect(getHistory).toHaveBeenCalledWith({ q: "9001", todos: true, limit: 10 });
    fireEvent.click(screen.getByRole("button", { name: "Reimprimir pedido 9001" }));
    await waitFor(() => expect(imprimirDoc).toHaveBeenCalledTimes(1));
    expect(imprimirDoc.mock.calls[0][0]).toMatchObject({ id: "ox", canal: "ecommerce" });
  });
});

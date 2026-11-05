// Exclusão GLOBAL ("falta no galpão", Stefhany 04/11/2026) na aba Exclusão do
// Filtro Inteligente: união global ∪ local, switch "Em todas as estações",
// chips de origem e o PUT só quando a global mudou.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueProduct } from "../src/services/orders";

const getQueueProducts = vi.fn();
vi.mock("../src/services/orders", async () => {
  const real = await vi.importActual<typeof import("../src/services/orders")>("../src/services/orders");
  return { ...real, getQueueProducts: (...a: unknown[]) => getQueueProducts(...a) };
});
const getExclusoesGlobais = vi.fn();
const adicionarExclusaoGlobal = vi.fn();
const removerExclusaoGlobal = vi.fn();
vi.mock("../src/services/exclusoesGlobais", async () => {
  const real = await vi.importActual<typeof import("../src/services/exclusoesGlobais")>(
    "../src/services/exclusoesGlobais",
  );
  return {
    ...real,
    getExclusoesGlobais: () => getExclusoesGlobais(),
    adicionarExclusaoGlobal: (...a: unknown[]) => adicionarExclusaoGlobal(...a),
    removerExclusaoGlobal: (...a: unknown[]) => removerExclusaoGlobal(...a),
  };
});
vi.mock("../src/lib/printer", () => ({ printPdfBase64: vi.fn(async () => ({ ok: true })) }));
vi.mock("../src/services/printerConfig", () => ({ getLabelPrinter: () => null }));

import { PickingFiltersModal } from "../src/components/PickingFiltersModal";

const FILA: QueueProduct[] = [
  { nome: "Moletom Cargo", tamanho: "M", ean: "1", imagemUrl: null, quantidade: 2, pedidos: 2, orderIds: ["a", "b"] },
  { nome: "Camiseta Zeus", tamanho: "M", ean: "2", imagemUrl: null, quantidade: 1, pedidos: 1, orderIds: ["c"] },
];
const GLOBAIS = {
  termos: [{ id: "1", termo: "Moletom Cargo", criadoPor: "Stefhany", criadoEm: "2026-11-04T15:30:00.000Z" }],
  atualizadoEm: "2026-11-04T15:30:00.000Z",
};
const QUEUE = { mode: "normal" as const, size: "M", sizes: ["M"] };
const props = { filters: {}, queue: QUEUE, onApply: vi.fn(), onClear: vi.fn(), onClose: vi.fn() };

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  getQueueProducts.mockReset().mockImplementation(async () => ({ products: FILA }));
  getExclusoesGlobais.mockReset().mockResolvedValue(GLOBAIS);
  adicionarExclusaoGlobal.mockReset().mockImplementation(async (termo: string) => ({
    termos: [...GLOBAIS.termos, { id: "2", termo, criadoPor: null, criadoEm: null }],
    atualizadoEm: "2026-11-04T16:00:00.000Z",
  }));
  removerExclusaoGlobal.mockReset().mockImplementation(async () => ({ termos: [], atualizadoEm: "2026-11-04T16:01:00.000Z" }));
  props.onApply.mockReset();
});

describe("Filtro Exclusão com lista do galpão", () => {
  it("mostra o termo global marcado com chip 'galpão' e o switch; marcar novo (switch ligado) salva na global", async () => {
    render(<PickingFiltersModal {...props} />);
    await waitFor(() => expect(screen.getByText("Em todas as estações")).toBeTruthy());
    await waitFor(() => expect(screen.getByText("galpão")).toBeTruthy());
    expect(screen.getByText("galpão").getAttribute("title")).toContain("Stefhany");

    // Marca um novo (vai pra global) e desmarca o Moletom (sai da global): diff por termo.
    fireEvent.click(screen.getByText("Camiseta Zeus"));
    fireEvent.click(screen.getByText("Moletom Cargo"));
    fireEvent.click(screen.getByRole("button", { name: "Aplicar filtros" }));
    await waitFor(() => expect(props.onApply).toHaveBeenCalledTimes(1));
    expect(adicionarExclusaoGlobal).toHaveBeenCalledTimes(1);
    expect(adicionarExclusaoGlobal).toHaveBeenCalledWith("Camiseta Zeus");
    expect(removerExclusaoGlobal).toHaveBeenCalledTimes(1);
    expect(removerExclusaoGlobal).toHaveBeenCalledWith("1");
    const [f, extra] = props.onApply.mock.calls[0];
    expect(f.excludeProducts).toBeUndefined();
    expect(extra.exclusoesGlobais).toBeTruthy();
  });

  it("switch desligado: o novo vai pra lista local, ganha chip 'só aqui' e a global não é salva", async () => {
    localStorage.setItem("berzerk_exclusao_global_v1", "0");
    render(<PickingFiltersModal {...props} />);
    await waitFor(() => screen.getByText("galpão"));
    fireEvent.click(screen.getByText("Camiseta Zeus"));
    expect(screen.getByText("só aqui")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Aplicar filtros" }));
    await waitFor(() => expect(props.onApply).toHaveBeenCalledTimes(1));
    expect(adicionarExclusaoGlobal).not.toHaveBeenCalled();
    expect(removerExclusaoGlobal).not.toHaveBeenCalled();
    expect(props.onApply.mock.calls[0][0].excludeProducts).toEqual(["Camiseta Zeus"]);
  });

  it("falha no POST: mostra o erro, mantém o modal aberto e refaz o GET", async () => {
    adicionarExclusaoGlobal.mockRejectedValue(new Error("500"));
    render(<PickingFiltersModal {...props} />);
    await waitFor(() => screen.getByText("galpão"));
    fireEvent.click(screen.getByText("Camiseta Zeus"));
    fireEvent.click(screen.getByRole("button", { name: "Aplicar filtros" }));
    await waitFor(() => expect(screen.getByText(/Não consegui salvar a exclusão do galpão/)).toBeTruthy());
    expect(props.onApply).not.toHaveBeenCalled();
    expect(getExclusoesGlobais.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("nexus sem rota (GET null): sem switch, sem chip, comportamento de hoje", async () => {
    getExclusoesGlobais.mockResolvedValue(null);
    render(<PickingFiltersModal {...props} />);
    await waitFor(() => screen.getByText("Camiseta Zeus"));
    fireEvent.click(screen.getByText("Camiseta Zeus"));
    expect(screen.queryByText("Em todas as estações")).toBeNull();
    expect(screen.queryByText("só aqui")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Aplicar filtros" }));
    await waitFor(() => expect(props.onApply).toHaveBeenCalledTimes(1));
    expect(adicionarExclusaoGlobal).not.toHaveBeenCalled();
    expect(removerExclusaoGlobal).not.toHaveBeenCalled();
    expect(props.onApply.mock.calls[0][0].excludeProducts).toEqual(["Camiseta Zeus"]);
  });
});

// Exclusão do galpão por tamanho: chave termo+tamanho, seletor só com `aceitaTamanho`, item travado.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/lib/api";
import { diffGlobal, tamanhoParaEnvio } from "../src/lib/exclusaoGlobalTamanho";
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
const T = (id: string, termo: string, tamanho: string | null, extra = {}) => ({
  id,
  termo: tamanho ? `${termo} - ${tamanho}` : termo,
  produto: termo,
  tamanho,
  criadoPor: "Stefhany",
  criadoEm: "2026-11-04T15:30:00.000Z",
  ...extra,
});
const props = {
  filters: {},
  queue: { mode: "normal" as const, size: "M", sizes: ["M"] },
  onApply: vi.fn(),
  onClear: vi.fn(),
  onClose: vi.fn(),
};

afterEach(cleanup);
beforeEach(() => {
  localStorage.clear();
  getQueueProducts.mockReset().mockImplementation(async () => ({ products: FILA }));
  getExclusoesGlobais.mockReset();
  adicionarExclusaoGlobal.mockReset().mockImplementation(async () => ({ termos: [], atualizadoEm: null }));
  removerExclusaoGlobal.mockReset().mockImplementation(async () => ({ termos: [], atualizadoEm: null }));
  props.onApply.mockReset();
});

describe("diff por termo + tamanho (puro)", () => {
  it("mesmo termo com tamanhos diferentes são itens distintos", () => {
    const base = [{ produto: "Moletom Cargo", tamanho: null }];
    const sel = [
      { produto: "moletom cargo", tamanho: null },
      { produto: "Moletom Cargo", tamanho: "P" },
    ];
    const d = diffGlobal(base, sel);
    expect(d.entraram).toEqual([{ produto: "Moletom Cargo", tamanho: "P" }]);
    expect(d.sairam).toEqual([]);
    expect(diffGlobal(sel, base).sairam).toEqual([{ produto: "Moletom Cargo", tamanho: "P" }]);
  });
  it("sem aceitaTamanho o tamanho nunca vai no envio", () => {
    expect(tamanhoParaEnvio(undefined, "P")).toBeNull();
    expect(tamanhoParaEnvio(false, "P")).toBeNull();
    expect(tamanhoParaEnvio(true, "P")).toBe("P");
  });
});

describe("normalização do contrato", () => {
  it("produto vem da API ou cai no termo; termosGlobais usa produto e só os sem tamanho", async () => {
    const { getExclusoesGlobais: real, termosGlobais } = await vi.importActual<
      typeof import("../src/services/exclusoesGlobais")
    >("../src/services/exclusoesGlobais");
    void real;
    const g = {
      atualizadoEm: null,
      termos: [
        { id: "1", termo: "Oversized - G", produto: "Oversized", tamanho: "G", criadoPor: null, criadoEm: null },
        { id: "2", termo: "Short", produto: "Short", tamanho: null, criadoPor: null, criadoEm: null },
      ],
    };
    expect(termosGlobais(g)).toEqual(["Short"]);
  });
});

describe("Filtro Exclusão do galpão por tamanho", () => {
  it("com aceitaTamanho: mesa de puros pré-seleciona o tamanho da mesa e envia no POST", async () => {
    getExclusoesGlobais.mockResolvedValue({ termos: [], atualizadoEm: null, aceitaTamanho: true });
    render(<PickingFiltersModal {...props} />);
    await waitFor(() => expect(screen.getByText("Em todas as estações")).toBeTruthy());
    fireEvent.click(screen.getByText("Camiseta Zeus"));
    const box = await screen.findByTestId("escolha-tamanho");
    expect(box.querySelector('[aria-pressed="true"]')?.textContent).toBe("M");
    fireEvent.click(screen.getByRole("button", { name: "Excluir" }));
    fireEvent.click(screen.getByRole("button", { name: "Aplicar filtros" }));
    await waitFor(() => expect(props.onApply).toHaveBeenCalledTimes(1));
    expect(adicionarExclusaoGlobal).toHaveBeenCalledWith("Camiseta Zeus", "M");
  });

  it("mistos: padrão Todos os tamanhos (sem tamanho no POST)", async () => {
    getExclusoesGlobais.mockResolvedValue({ termos: [], atualizadoEm: null, aceitaTamanho: true });
    render(<PickingFiltersModal {...props} queue={{ mode: "total", size: "M", sizes: ["M"] }} />);
    await waitFor(() => expect(screen.getByText("Em todas as estações")).toBeTruthy());
    fireEvent.click(await screen.findByText("Camiseta Zeus"));
    const box = await screen.findByTestId("escolha-tamanho");
    expect(box.querySelector('[aria-pressed="true"]')?.textContent).toBe("Todos os tamanhos");
    fireEvent.click(screen.getByRole("button", { name: "Excluir" }));
    fireEvent.click(screen.getByRole("button", { name: "Aplicar filtros" }));
    await waitFor(() => expect(adicionarExclusaoGlobal).toHaveBeenCalledWith("Camiseta Zeus"));
  });

  it("API velha (sem aceitaTamanho): sem seletor, marca direto, sem tamanho", async () => {
    getExclusoesGlobais.mockResolvedValue({ termos: [], atualizadoEm: null });
    render(<PickingFiltersModal {...props} />);
    await waitFor(() => expect(screen.getByText("Em todas as estações")).toBeTruthy());
    fireEvent.click(screen.getByText("Camiseta Zeus"));
    expect(screen.queryByTestId("escolha-tamanho")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Aplicar filtros" }));
    await waitFor(() => expect(adicionarExclusaoGlobal).toHaveBeenCalledWith("Camiseta Zeus"));
  });

  it("lista mostra tamanho, quem e pedidos presos; podeRemover=false trava o item", async () => {
    getExclusoesGlobais.mockResolvedValue({
      aceitaTamanho: true,
      atualizadoEm: null,
      termos: [
        T("1", "Moletom Cargo", "P", { pedidosPresos: { total: 7, puros: 5, mistos: 2 } }),
        T("2", "Moletom Cargo", null, { podeRemover: false }),
      ],
    });
    render(<PickingFiltersModal {...props} />);
    const lista = await screen.findByTestId("lista-galpao");
    expect(lista.textContent).toContain("prende 7 pedidos");
    expect(lista.textContent).toContain("Todos");
    expect(lista.textContent).not.toContain("Moletom Cargo - P");
    expect(screen.getByTestId("item-travado").textContent).toContain("Só quem tirou ou a supervisão devolve");
    // tirar só o P: remove por id 1, não toca no travado
    fireEvent.click(screen.getByRole("button", { name: /Tirar Moletom Cargo P do galpão/ }));
    fireEvent.click(screen.getByRole("button", { name: "Aplicar filtros" }));
    await waitFor(() => expect(removerExclusaoGlobal).toHaveBeenCalledTimes(1));
    expect(removerExclusaoGlobal).toHaveBeenCalledWith("1");
    expect(adicionarExclusaoGlobal).not.toHaveBeenCalled();
  });

  it("403 exclusao_global_nao_permitida vira a mensagem de item travado", async () => {
    getExclusoesGlobais.mockResolvedValue({ aceitaTamanho: true, atualizadoEm: null, termos: [T("1", "Moletom Cargo", "P")] });
    removerExclusaoGlobal.mockRejectedValue(
      new ApiError(403, "forbidden", { error: "exclusao_global_nao_permitida" }),
    );
    render(<PickingFiltersModal {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: /Tirar Moletom Cargo P do galpão/ }));
    fireEvent.click(screen.getByRole("button", { name: "Aplicar filtros" }));
    await waitFor(() => expect(screen.getByText(/Só quem tirou ou a supervisão devolve/)).toBeTruthy());
    expect(props.onApply).not.toHaveBeenCalled();
  });
});

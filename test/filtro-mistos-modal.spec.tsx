// Filtro Mistos no Filtro Inteligente (protótipo do Lucas, 04/11/2026): aba só
// nas filas de mistos, lista por "fecha sozinho", quadro de resultado e o
// `mistosProdutos` no onApply.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueProduct } from "../src/services/orders";

const getQueueProducts = vi.fn();
vi.mock("../src/services/orders", async () => {
  const real = await vi.importActual<typeof import("../src/services/orders")>("../src/services/orders");
  return { ...real, getQueueProducts: (...a: unknown[]) => getQueueProducts(...a) };
});
const printPdfBase64 = vi.fn(async () => ({ ok: true, printer: "Zebra" }));
vi.mock("../src/lib/printer", () => ({ printPdfBase64: (...a: unknown[]) => printPdfBase64(...(a as [])) }));
vi.mock("../src/services/printerConfig", () => ({ getLabelPrinter: () => null }));

import { PickingFiltersModal } from "../src/components/PickingFiltersModal";

function linha(nome: string, tamanho: string, orderIds: string[], comProduto = true): QueueProduct {
  return {
    nome,
    produto: comProduto ? nome.replace(/ - (M|G|GG|G3)$/, "") : undefined, tamanho, ean: null, imagemUrl: null, quantidade: orderIds.length, pedidos: orderIds.length, orderIds,
  };
}

const FILA: QueueProduct[] = [
  linha("Oversized - Leg Day - M", "M", ["a", "b", "c"]),
  linha("Oversized - Surpresa - G", "G", ["a", "b"]),
  linha("Oversized - Punk Pink - GG", "GG", ["b"]),
  linha("Oversized - Vintage - G3", "G3", ["c"]),
];

const QUEUE = { mode: "total" as const, size: "M", sizes: ["M"] };
const props = { filters: {}, onApply: vi.fn(), onClear: vi.fn(), onClose: vi.fn() };

afterEach(cleanup);
beforeEach(() => {
  getQueueProducts.mockReset();
  getQueueProducts.mockImplementation(async () => ({ products: FILA }));
  props.onApply.mockReset();
  printPdfBase64.mockClear();
});

const texto = (el: HTMLElement) => (el.textContent ?? "").replace(/\s+/g, " ").trim();

describe("PickingFiltersModal — aba Filtro Mistos", () => {
  it("lista do que mais fecha sozinho pro que menos e mostra o quadro e a grade ao marcar", async () => {
    render(<PickingFiltersModal {...props} queue={QUEUE} />);
    fireEvent.click(await screen.findByRole("button", { name: /Filtro Mistos/ }));

    await waitFor(() => expect(screen.getAllByText("fecha sozinho").length).toBe(3));
    const nomes = ["Oversized - Surpresa", "Oversized - Punk Pink", "Oversized - Vintage"];
    const html = document.body.textContent ?? "";
    const pos = nomes.map((n) => html.indexOf(n));
    expect(pos.every((p) => p >= 0)).toBe(true);
    expect(pos[0]).toBeLessThan(pos[1]);
    expect(pos[1]).toBeLessThan(pos[2]);
    expect(texto(screen.getByTestId("quadro-mistos"))).toContain("Do que mais fecha mistos do M");

    fireEvent.click(screen.getByText("Oversized - Surpresa"));
    const quadro = texto(screen.getByTestId("quadro-mistos"));
    expect(quadro).toContain("1 mistos do M fecham (de 3)");
    expect(quadro).toContain("1 peças");
    expect(screen.getByText("pegar")).toBeTruthy();
    expect(document.body.textContent).toContain("1 produto marcado");
  });

  it("Aplicar filtros manda mistosProdutos e as imagens dos marcados", async () => {
    render(<PickingFiltersModal {...props} queue={QUEUE} />);
    fireEvent.click(await screen.findByRole("button", { name: /Filtro Mistos/ }));
    await waitFor(() => screen.getByText("Oversized - Surpresa"));
    fireEvent.click(screen.getByText("Oversized - Surpresa"));
    fireEvent.click(screen.getByRole("button", { name: "Aplicar filtros" }));
    expect(props.onApply).toHaveBeenCalledTimes(1);
    const [f, extra] = props.onApply.mock.calls[0];
    expect(f.mistosProdutos).toEqual(["Oversized - Surpresa"]);
    expect(Object.keys(extra.imagens)).toEqual(["Oversized - Surpresa"]);
  });

  it("Imprimir mistos manda a folha de consulta e não fecha o modal", async () => {
    render(<PickingFiltersModal {...props} queue={QUEUE} />);
    fireEvent.click(await screen.findByRole("button", { name: /Filtro Mistos/ }));
    await waitFor(() => screen.getByText("Oversized - Surpresa"));
    expect(screen.queryByRole("button", { name: /Imprimir mistos/ })).toBeNull();
    fireEvent.click(screen.getByText("Oversized - Surpresa"));
    fireEvent.click(screen.getByRole("button", { name: /Imprimir mistos/ }));
    await waitFor(() => expect(screen.getByText(/Enviado pra Zebra/)).toBeTruthy());
    expect(printPdfBase64).toHaveBeenCalledTimes(1);
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("filtro salvo abre com o contador, e a aba não existe em fila de puros", async () => {
    const { unmount } = render(
      <PickingFiltersModal {...props} queue={QUEUE} filters={{ mistosProdutos: ["Oversized - Surpresa"] }} abaInicial="mistos" />,
    );
    expect(await screen.findByRole("button", { name: "Filtro Mistos (1)" })).toBeTruthy();
    await waitFor(() => expect(texto(screen.getByTestId("quadro-mistos"))).toContain("fecham (de 3)"));
    unmount();
    render(<PickingFiltersModal {...props} queue={{ mode: "normal", size: "M", sizes: ["M"] }} />);
    expect(screen.queryByRole("button", { name: /Filtro Mistos/ })).toBeNull();
  });

  it("nexus sem `produto` nas linhas e no lote: a aba não existe mesmo em modo total", async () => {
    getQueueProducts.mockImplementation(async () => ({
      products: FILA.map((p) => ({ ...p, produto: undefined })),
    }));
    render(<PickingFiltersModal {...props} queue={QUEUE} />);
    await waitFor(() => expect(getQueueProducts).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByRole("button", { name: /Filtro Mistos/ })).toBeNull();
  });
});

// Filtro Inteligente e Picking Geral — relatos de 02/09.
//
// 1. "A calça XG do meu pedido não aparece no filtro de exclusão": o
//    `queue-products` do nexus só enxerga a FILA (pedidos sem dono). O que a
//    operadora já puxou pro lote só existe em memória — o modal agora lista
//    fila ∪ lote.
// 2. "O Picking não tem botão de imprimir": filtro herdado da estação esconde
//    tudo e a folha vem vazia. O modal agora avisa no topo, com "Limpar filtros".

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Order, QueueProduct } from "../src/services/orders";
import { agregarLote, mesclarProdutos } from "../src/lib/agregarLote";

const getQueueProducts = vi.fn();
vi.mock("../src/services/orders", async () => {
  const real = await vi.importActual<typeof import("../src/services/orders")>("../src/services/orders");
  return { ...real, getQueueProducts: (...a: unknown[]) => getQueueProducts(...a) };
});
vi.mock("../src/lib/printer", () => ({ printPdfBase64: vi.fn(async () => ({ ok: true })) }));
vi.mock("../src/services/printerConfig", () => ({ getLabelPrinter: () => null }));
vi.mock("../src/lib/pickingPdf", () => ({ gerarPickingPdf: vi.fn(() => "") }));

import { PickingFiltersModal } from "../src/components/PickingFiltersModal";
import { PickingGeralModal } from "../src/components/PickingGeralModal";

function pedido(n: number, itens: { nome: string; tamanho: string; ean?: string }[]): Order {
  return {
    id: `ord-${n}`,
    tinyOrderId: `${700000 + n}`,
    numero: `${700000 + n}`,
    channel: "tiny",
    status: "ready",
    predominantSize: "M",
    separationMode: "normal",
    claimedBy: "op-1",
    claimedAt: "2026-09-02T12:00:00.000Z",
    separatedBy: null,
    separatedAt: null,
    rfidTags: null,
    items: itens.map((it, i) => ({
      id: `ord-${n}-it-${i}`,
      ean: it.ean ?? `78900000${n}${i}`,
      sku: `SKU-${n}-${i}`,
      nome: it.nome,
      tamanho: it.tamanho,
      quantidade: 1,
      imagemUrl: null,
    })),
    createdAt: "2026-09-02T12:00:00.000Z",
    updatedAt: "2026-09-02T12:00:00.000Z",
    clienteNome: `Cliente ${n}`,
    dataEmissao: "2026-09-02T12:00:00.000Z",
    prioritario: false,
  } as Order;
}

const DA_FILA: QueueProduct[] = [
  { nome: "Camiseta Zeus", tamanho: "M", ean: "1", imagemUrl: null, quantidade: 4, pedidos: 4, orderIds: ["q1", "q2", "q3", "q4"] },
];
const LOTE = [
  pedido(1, [{ nome: "Camiseta Zeus", tamanho: "M", ean: "1" }, { nome: "Calça Cargo", tamanho: "XG" }]),
  pedido(2, [{ nome: "Camiseta Bubble", tamanho: "M" }]),
];
const QUEUE = { mode: "normal" as const, size: "M", sizes: ["M"] };

afterEach(cleanup);
// `mockImplementation`, não `mockResolvedValue`: no vitest 3.2 o segundo deixa
// a rejeição do teste "fila fora do ar" escapar como erro não tratado.
beforeEach(() => {
  getQueueProducts.mockReset();
  getQueueProducts.mockImplementation(async () => ({ products: DA_FILA }));
});

describe("mesclarProdutos", () => {
  it("une fila e lote sem contar em dobro; o que veio do lote é marcado", () => {
    const r = mesclarProdutos("normal", DA_FILA, agregarLote(LOTE, "normal"));
    const zeus = r.find((p) => p.nome === "Camiseta Zeus")!;
    expect(zeus.quantidade).toBe(5);
    expect(zeus.pedidos).toBe(5);
    expect(zeus.noLote).toBe(true);
    const calca = r.find((p) => p.nome === "Calça Cargo")!;
    expect(calca.noLote).toBe(true);
    expect(calca.tamanho).toBe("XG");
  });
});

describe("PickingFiltersModal — fila ∪ lote", () => {
  it("lista a calça XG que só existe no lote (a fila do servidor não a tem)", async () => {
    render(
      <PickingFiltersModal filters={{}} queue={QUEUE} lote={LOTE} onApply={() => {}} onClear={() => {}} onClose={() => {}} />,
    );
    await waitFor(() => expect(screen.getByText("Calça Cargo")).toBeTruthy());
    expect(screen.getAllByText("no lote").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("XG")).toBeTruthy();
  });

  it("a busca acha a calça pelo nome", async () => {
    render(
      <PickingFiltersModal filters={{}} queue={QUEUE} lote={LOTE} onApply={() => {}} onClear={() => {}} onClose={() => {}} />,
    );
    await waitFor(() => screen.getByText("Calça Cargo"));
    fireEvent.change(screen.getByPlaceholderText(/Buscar produto/), { target: { value: "calça" } });
    expect(screen.getByText("Calça Cargo")).toBeTruthy();
    expect(screen.queryByText("Camiseta Zeus")).toBeNull();
  });

  it("com a fila fora do ar, o lote ainda aparece", async () => {
    getQueueProducts.mockImplementation(async () => {
      throw new Error("fila indisponível");
    });
    render(
      <PickingFiltersModal filters={{}} queue={QUEUE} lote={LOTE} onApply={() => {}} onClear={() => {}} onClose={() => {}} />,
    );
    await waitFor(() => screen.getByText("fila indisponível"));
    expect(screen.getByText("Calça Cargo")).toBeTruthy();
    expect(screen.getByText("Camiseta Bubble")).toBeTruthy();
  });
});

describe("PickingGeralModal — filtros ativos", () => {
  const base = { queue: QUEUE, lote: [] as Order[], operadora: "Sabrina", onClose: () => {} };

  it("sem filtro: nenhum banner", () => {
    render(<PickingGeralModal {...base} data={null} filters={{}} />);
    expect(screen.queryByText(/Filtros ativos nesta estação/)).toBeNull();
  });

  it("com data e exclusão: banner no topo e 'Limpar filtros' zera a estação", () => {
    const onLimparFiltros = vi.fn();
    render(
      <PickingGeralModal
        {...base}
        data="2026-09-01"
        filters={{ dateFrom: "2026-09-01", dateTo: "2026-09-01", excludeProducts: ["Calça Cargo", "Moletom"] }}
        onLimparFiltros={onLimparFiltros}
      />,
    );
    const banner = screen.getByRole("status");
    expect(banner.textContent).toContain("Filtros ativos nesta estação");
    expect(banner.textContent).toContain("01/09");
    expect(banner.textContent).toContain("2 produtos excluídos");
    fireEvent.click(screen.getByRole("button", { name: "Limpar filtros" }));
    expect(onLimparFiltros).toHaveBeenCalledTimes(1);
  });
});

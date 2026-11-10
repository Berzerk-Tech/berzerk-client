// Filtro Mistos no Filtro Inteligente (protótipo do Lucas, 04/11/2026): aba só
// nas filas de mistos, lista por "fecha sozinho", quadro de resultado e o
// `mistosProdutos` no onApply.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Order, QueueProduct } from "../src/services/orders";

const getQueueProducts = vi.fn();
const marcarListaImpressa = vi.fn();
vi.mock("../src/services/orders", async () => {
  const real = await vi.importActual<typeof import("../src/services/orders")>("../src/services/orders");
  return {
    ...real,
    getQueueProducts: (...a: unknown[]) => getQueueProducts(...a),
    marcarListaImpressa: (...a: unknown[]) => marcarListaImpressa(...a),
  };
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
  marcarListaImpressa.mockReset();
  marcarListaImpressa.mockResolvedValue({ presos: 2, listaId: "L1" });
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
    await waitFor(() => expect(props.onApply).toHaveBeenCalledTimes(1));
    const [f, extra] = props.onApply.mock.calls[0];
    expect(f.mistosProdutos).toEqual(["Oversized - Surpresa"]);
    expect(Object.keys(extra.imagens)).toEqual(["Oversized - Surpresa"]);
  });

  it("Só consultar manda a folha de consulta, não reserva nada e não fecha o modal", async () => {
    const onReservarMistos = vi.fn();
    render(<PickingFiltersModal {...props} onReservarMistos={onReservarMistos} queue={QUEUE} />);
    fireEvent.click(await screen.findByRole("button", { name: /Filtro Mistos/ }));
    await waitFor(() => screen.getByText("Oversized - Surpresa"));
    expect(screen.queryByRole("button", { name: /Só consultar/ })).toBeNull();
    fireEvent.click(screen.getByText("Oversized - Surpresa"));
    fireEvent.click(screen.getByRole("button", { name: /Só consultar/ }));
    await waitFor(() => expect(screen.getByText(/Enviado pra Zebra/)).toBeTruthy());
    expect(printPdfBase64).toHaveBeenCalledTimes(1);
    expect(onReservarMistos).not.toHaveBeenCalled();
    expect(marcarListaImpressa).not.toHaveBeenCalled();
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

function pedido(id: string, itens: Array<[string, string]>): Order {
  return {
    id,
    numero: id,
    predominantSize: "M",
    items: itens.map(([nome, tamanho], i) => ({
      id: `${id}-${i}`,
      nome,
      produto: nome.replace(/ - (M|G|GG)$/, ""),
      tamanho,
      ean: null,
      imagemUrl: null,
      quantidade: 1,
    })),
  } as unknown as Order;
}

describe("PickingFiltersModal — Imprimir e reservar", () => {
  const NOVOS = [
    pedido("a", [["Oversized - Leg Day - M", "M"], ["Oversized - Surpresa - G", "G"]]),
    pedido("b", [["Oversized - Leg Day - M", "M"], ["Oversized - Surpresa - G", "G"]]),
  ];
  const ordem: string[] = [];

  async function abrirComSurpresa(extra: Record<string, unknown>) {
    render(<PickingFiltersModal {...props} {...extra} queue={QUEUE} />);
    fireEvent.click(await screen.findByRole("button", { name: /Filtro Mistos/ }));
    await waitFor(() => screen.getByText("Oversized - Surpresa"));
    fireEvent.click(screen.getByText("Oversized - Surpresa"));
  }

  beforeEach(() => {
    ordem.length = 0;
    marcarListaImpressa.mockImplementation(async () => {
      ordem.push("carimbo");
      return { presos: 2, listaId: "L1" };
    });
    printPdfBase64.mockImplementation(async () => {
      ordem.push("imprime");
      return { ok: true, printer: "Zebra" };
    });
  });

  it("aplica o filtro, puxa a lista nova, carimba os reivindicados e só então imprime", async () => {
    const onReservarMistos = vi.fn(async (f: unknown) => {
      ordem.push("lote");
      return { ok: true as const, novos: [NOVOS[0]], filtros: f as never };
    });
    const onListaImpressa = vi.fn();
    await abrirComSurpresa({ onReservarMistos, onListaImpressa });
    fireEvent.click(screen.getByRole("button", { name: /Imprimir e reservar/ }));
    await waitFor(() => expect(screen.getByText(/Folha enviada pra Zebra/)).toBeTruthy());

    expect(ordem).toEqual(["lote", "carimbo", "imprime"]);
    expect(onReservarMistos.mock.calls[0][0]).toMatchObject({ mistosProdutos: ["Oversized - Surpresa"] });
    expect(marcarListaImpressa.mock.calls[0][0]).toMatchObject({ orderIds: ["a"], escopo: "lote" });
    expect(onListaImpressa).toHaveBeenCalledWith(["a"], "L1");
    expect(document.body.textContent).toContain("1 pedido reservado pra você");
  });

  it("servidor entregou número diferente do quadro: o status diz o número real", async () => {
    // O quadro da fixture promete 1 pedido; o servidor entrega 2.
    const onReservarMistos = vi.fn(async (f: unknown) => ({ ok: true as const, novos: NOVOS, filtros: f as never }));
    await abrirComSurpresa({ onReservarMistos });
    fireEvent.click(screen.getByRole("button", { name: /Imprimir e reservar/ }));
    await waitFor(() => expect(screen.getByText(/Reservados 2 pedidos \(o quadro previa 1/)).toBeTruthy());
    expect(marcarListaImpressa.mock.calls[0][0]).toMatchObject({ orderIds: ["a", "b"] });
  });

  it("limite de listas (ou qualquer falha do lote): não carimba nem imprime e diz o motivo", async () => {
    const onReservarMistos = vi.fn(async () => ({ ok: false as const, motivo: "Você já tem 2 lista(s) em aberto. Nada foi impresso." }));
    await abrirComSurpresa({ onReservarMistos });
    fireEvent.click(screen.getByRole("button", { name: /Imprimir e reservar/ }));
    await waitFor(() => expect(screen.getByText(/já tem 2 lista/)).toBeTruthy());
    expect(marcarListaImpressa).not.toHaveBeenCalled();
    expect(printPdfBase64).not.toHaveBeenCalled();
  });

  it("carimbo falhando: não imprime e avisa que os pedidos ficaram na mesa sem carimbo", async () => {
    marcarListaImpressa.mockImplementation(async () => {
      throw new Error("500");
    });
    const onReservarMistos = vi.fn(async (f: unknown) => ({ ok: true as const, novos: NOVOS, filtros: f as never }));
    const onListaImpressa = vi.fn();
    await abrirComSurpresa({ onReservarMistos, onListaImpressa });
    fireEvent.click(screen.getByRole("button", { name: /Imprimir e reservar/ }));
    await waitFor(() => expect(screen.getByText(/NÃO foi carimbada/)).toBeTruthy());
    expect(document.body.textContent).toContain("estão na SUA mesa");
    expect(printPdfBase64).not.toHaveBeenCalled();
    expect(onListaImpressa).not.toHaveBeenCalled();
  });

  it("impressora falhando depois do carimbo: avisa que já está reservado e cita o Picking Geral", async () => {
    printPdfBase64.mockImplementation(async () => ({ ok: false, printer: null, message: "sem papel" }) as never);
    const onReservarMistos = vi.fn(async (f: unknown) => ({ ok: true as const, novos: NOVOS, filtros: f as never }));
    await abrirComSurpresa({ onReservarMistos });
    fireEvent.click(screen.getByRole("button", { name: /Imprimir e reservar/ }));
    await waitFor(() => expect(screen.getByText(/JÁ estão reservados com você/)).toBeTruthy());
    expect(document.body.textContent).toContain("Picking Geral");
  });

  it("pedidos que já estavam na mão dela: carimbam, mas saem da folha e o status conta quantos", async () => {
    const onReservarMistos = vi.fn(async (f: unknown) => ({ ok: true as const, novos: NOVOS, foraDaFolha: ["b"], filtros: f as never }));
    await abrirComSurpresa({ onReservarMistos });
    fireEvent.click(screen.getByRole("button", { name: /Imprimir e reservar/ }));
    await waitFor(() => expect(screen.getByText(/Folha enviada/)).toBeTruthy());
    expect(marcarListaImpressa.mock.calls[0][0].orderIds).toEqual(["a", "b"]);
    expect(document.body.textContent).toContain("1 pedido já estava na sua mesa e não entrou na folha");
    expect(printPdfBase64).toHaveBeenCalledTimes(1);
  });

  it("todos já estavam na mão dela: carimba, não imprime e explica", async () => {
    const onReservarMistos = vi.fn(async (f: unknown) => ({ ok: true as const, novos: NOVOS, foraDaFolha: ["a", "b"], filtros: f as never }));
    await abrirComSurpresa({ onReservarMistos });
    fireEvent.click(screen.getByRole("button", { name: /Imprimir e reservar/ }));
    await waitFor(() => expect(screen.getByText(/Nenhum pedido sobrou pra folha/)).toBeTruthy());
    expect(printPdfBase64).not.toHaveBeenCalled();
  });

  it("carimbo parcial: recarrega os pedidos, imprime só os presos e diz 'X de Y carimbados'", async () => {
    marcarListaImpressa.mockImplementation(async () => ({ presos: 1, listaId: "L1" }));
    const onReservarMistos = vi.fn(async (f: unknown) => ({ ok: true as const, novos: NOVOS, filtros: f as never }));
    const onRecarregarPedidos = vi.fn(async () => [{ ...NOVOS[0], listaEm: "2026-11-10T10:00:00Z" }, NOVOS[1]] as never);
    const onListaImpressa = vi.fn();
    await abrirComSurpresa({ onReservarMistos, onRecarregarPedidos, onListaImpressa });
    fireEvent.click(screen.getByRole("button", { name: /Imprimir e reservar/ }));
    await waitFor(() => expect(screen.getByText(/Folha enviada/)).toBeTruthy());
    expect(document.body.textContent).toContain("1 de 2 pedidos carimbados");
    expect(onListaImpressa).toHaveBeenCalledWith(["a"], "L1");
    expect(printPdfBase64).toHaveBeenCalledTimes(1);
  });

  it("carimbo parcial sem como conferir os presos: não imprime", async () => {
    marcarListaImpressa.mockImplementation(async () => ({ presos: 1, listaId: "L1" }));
    const onReservarMistos = vi.fn(async (f: unknown) => ({ ok: true as const, novos: NOVOS, filtros: f as never }));
    const onListaImpressa = vi.fn();
    await abrirComSurpresa({ onReservarMistos, onListaImpressa });
    fireEvent.click(screen.getByRole("button", { name: /Imprimir e reservar/ }));
    await waitFor(() => expect(screen.getByText(/1 de 2 pedidos carimbados/)).toBeTruthy());
    expect(printPdfBase64).not.toHaveBeenCalled();
    expect(onListaImpressa).not.toHaveBeenCalled();
  });

  it("enquanto reserva o modal não fecha (Esc, overlay, Cancelar) e o desfecho sai no aviso da tela", async () => {
    let soltar: (v: { ok: false; motivo: string }) => void = () => {};
    const onReservarMistos = vi.fn(() => new Promise<{ ok: false; motivo: string }>((r) => (soltar = r)));
    const onClose = vi.fn();
    const onImprimindo = vi.fn();
    const onAviso = vi.fn();
    await abrirComSurpresa({ onReservarMistos, onClose, onImprimindo, onAviso });
    fireEvent.click(screen.getByRole("button", { name: /Imprimir e reservar/ }));
    await waitFor(() => expect(onReservarMistos).toHaveBeenCalled());
    expect(onImprimindo).toHaveBeenCalledWith(true);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onClose).not.toHaveBeenCalled();
    soltar({ ok: false, motivo: "Você já tem 2 lista(s) em aberto. Nada foi impresso." });
    await waitFor(() => expect(onAviso).toHaveBeenCalledWith(expect.stringContaining("já tem 2 lista")));
    expect(onImprimindo).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancelar" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("sem produto marcado o botão não existe; sem o callback só há a consulta; duplo clique reserva uma vez", async () => {
    const onReservarMistos = vi.fn(
      () => new Promise<never>(() => undefined), // fica pendurado: simula o lote em voo
    );
    render(<PickingFiltersModal {...props} onReservarMistos={onReservarMistos} queue={QUEUE} />);
    fireEvent.click(await screen.findByRole("button", { name: /Filtro Mistos/ }));
    await waitFor(() => screen.getByText("Oversized - Surpresa"));
    expect(screen.queryByRole("button", { name: /Imprimir e reservar/ })).toBeNull();
    fireEvent.click(screen.getByText("Oversized - Surpresa"));
    const btn = screen.getByRole("button", { name: /Imprimir e reservar/ });
    fireEvent.click(btn);
    fireEvent.click(btn);
    await waitFor(() => expect(onReservarMistos).toHaveBeenCalledTimes(1));
    expect((screen.getByRole("button", { name: /Imprimir e reservar/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

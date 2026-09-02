// "Listas impressas" — folha de picking IMPRESSA vira snapshot em
// `separacao_listas` (02/09), pro pedido que sumir da mesa antes de embalar
// poder voltar por ela.
//
// 1. `PickingGeralModal`: "Imprimir Tudo" carimba o LOTE inteiro
//    (`escopo: 'lote'`); "Imprimir <tamanho>" carimba só quem contribui pra
//    aquela seção (`escopo: 'secao'`) — antes desta mudança o botão de seção
//    também prendia o lote inteiro.
// 2. `ListasImpressasModal`: lista as impressões, expande o snapshot com o
//    estado atual de cada pedido e recupera os `ready` sem dono pra mesa.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/lib/api";
import type { Order } from "../src/services/orders";

const marcarListaImpressa = vi.fn();
vi.mock("../src/services/orders", async () => {
  const real = await vi.importActual<typeof import("../src/services/orders")>(
    "../src/services/orders",
  );
  return { ...real, marcarListaImpressa: (...a: unknown[]) => marcarListaImpressa(...a) };
});
vi.mock("../src/lib/printer", () => ({ printPdfBase64: vi.fn(async () => ({ ok: true })) }));
vi.mock("../src/services/printerConfig", () => ({ getLabelPrinter: () => null }));
vi.mock("../src/lib/pickingPdf", () => ({ gerarPickingPdf: vi.fn(() => "") }));

const getListas = vi.fn();
const getListaDetalhe = vi.fn();
const recuperarLista = vi.fn();
vi.mock("../src/services/listas", () => ({
  getListas: (...a: unknown[]) => getListas(...a),
  getListaDetalhe: (...a: unknown[]) => getListaDetalhe(...a),
  recuperarLista: (...a: unknown[]) => recuperarLista(...a),
}));

const { PickingGeralModal } = await import("../src/components/PickingGeralModal");
const { ListasImpressasModal } = await import("../src/components/ListasImpressasModal");

function pedido(n: number, itens: { nome: string; tamanho: string }[]): Order {
  return {
    id: `ord-${n}`,
    tinyOrderId: `${700000 + n}`,
    numero: `${700000 + n}`,
    channel: "tiny",
    status: "ready",
    predominantSize: itens[0]?.tamanho ?? "M",
    separationMode: "normal",
    claimedBy: "op-1",
    claimedAt: "2026-09-02T12:00:00.000Z",
    separatedBy: null,
    separatedAt: null,
    rfidTags: null,
    items: itens.map((it, i) => ({
      id: `ord-${n}-it-${i}`,
      ean: `78900000${n}${i}`,
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

const M_ORDER = pedido(1, [{ nome: "Camiseta Zeus", tamanho: "M" }]);
const G_ORDER = pedido(2, [{ nome: "Bermuda Cargo", tamanho: "G" }]);
const LOTE = [M_ORDER, G_ORDER];
const QUEUE = { mode: "normal" as const, size: "M", sizes: ["M"] };

describe("PickingGeralModal — snapshot da lista impressa", () => {
  afterEach(cleanup);
  beforeEach(() => {
    marcarListaImpressa.mockReset().mockResolvedValue({ presos: 2, listaId: "lista-1" });
  });

  it("Imprimir Tudo carimba o LOTE inteiro com escopo 'lote'", async () => {
    const onListaImpressa = vi.fn();
    render(
      <PickingGeralModal
        queue={QUEUE}
        data={null}
        filters={{}}
        lote={LOTE}
        operadora="Sabrina"
        onListaImpressa={onListaImpressa}
        onClose={() => {}}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Imprimir Tudo/ }));
    });
    await waitFor(() => expect(marcarListaImpressa).toHaveBeenCalledTimes(1));

    const payload = marcarListaImpressa.mock.calls[0][0];
    expect(payload.escopo).toBe("lote");
    expect(new Set(payload.orderIds)).toEqual(new Set(["ord-1", "ord-2"]));
    expect(payload.filtros).toEqual({});
    expect(payload.secoes).toHaveLength(2);
    expect(payload.secoes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tamanho: "M", linhas: [{ produto: "Camiseta Zeus", qtd: 1 }] }),
        expect.objectContaining({ tamanho: "G", linhas: [{ produto: "Bermuda Cargo", qtd: 1 }] }),
      ]),
    );
    expect(onListaImpressa).toHaveBeenCalledWith(expect.arrayContaining(["ord-1", "ord-2"]), "lista-1");
  });

  it("Imprimir <tamanho> carimba só os pedidos daquela seção, com escopo 'secao'", async () => {
    const onListaImpressa = vi.fn();
    render(
      <PickingGeralModal
        queue={QUEUE}
        data={null}
        filters={{}}
        lote={LOTE}
        operadora="Sabrina"
        onListaImpressa={onListaImpressa}
        onClose={() => {}}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^Imprimir G$/ }));
    });
    await waitFor(() => expect(marcarListaImpressa).toHaveBeenCalledTimes(1));

    const payload = marcarListaImpressa.mock.calls[0][0];
    expect(payload.escopo).toBe("secao");
    expect(payload.orderIds).toEqual(["ord-2"]);
    expect(payload.secoes).toEqual([{ tamanho: "G", linhas: [{ produto: "Bermuda Cargo", qtd: 1 }] }]);
    expect(onListaImpressa).toHaveBeenCalledWith(["ord-2"], "lista-1");
  });
});

describe("ListasImpressasModal", () => {
  afterEach(cleanup);
  beforeEach(() => {
    getListas.mockReset();
    getListaDetalhe.mockReset();
    recuperarLista.mockReset();
  });

  it("lista as impressões e recupera os pedidos recuperáveis", async () => {
    getListas.mockResolvedValue({
      listas: [
        {
          id: "lista-1",
          criadoEm: "2026-09-02T13:00:00.000Z",
          escopo: "lote",
          totalPedidos: 2,
          totalPecas: 5,
          pedidosRecuperaveis: 1,
          recuperacoes: 0,
          recuperadaEm: null,
        },
      ],
    });
    recuperarLista.mockResolvedValue({
      recuperados: 1,
      jaComigo: 0,
      ignorados: [{ numero: "700003", motivo: "separado" }],
    });
    const onRecuperado = vi.fn();

    render(<ListasImpressasModal onClose={() => {}} onRecuperado={onRecuperado} />);
    await waitFor(() => expect(screen.getByText(/Recuperar pedidos \(1\)/)).toBeTruthy());

    const card = screen.getByText(/Recuperar pedidos/).closest("div")!.parentElement!;
    expect(card.textContent).toContain("2 pedidos");
    expect(card.textContent).toContain("5 peças");
    expect(card.textContent).toContain("1 recuperável");

    getListas.mockResolvedValue({
      listas: [
        {
          id: "lista-1",
          criadoEm: "2026-09-02T13:00:00.000Z",
          escopo: "lote",
          totalPedidos: 2,
          totalPecas: 5,
          pedidosRecuperaveis: 0,
          recuperacoes: 1,
          recuperadaEm: "2026-09-02T13:05:00.000Z",
        },
      ],
    });
    fireEvent.click(screen.getByText(/Recuperar pedidos \(1\)/));
    await waitFor(() => expect(recuperarLista).toHaveBeenCalledWith("lista-1"));
    await waitFor(() =>
      expect(screen.getByText(/1 pedido voltou pra sua mesa/)).toBeTruthy(),
    );
    expect(screen.getByText(/0 já estavam com você/)).toBeTruthy();
    expect(screen.getByText(/1 ignorado \(#700003 já separado\)/)).toBeTruthy();
    expect(onRecuperado).toHaveBeenCalledTimes(1);
  });

  it("expande uma lista e mostra o badge de cada pedido pelo estado atual", async () => {
    getListas.mockResolvedValue({
      listas: [
        {
          id: "lista-1",
          criadoEm: "2026-09-02T13:00:00.000Z",
          escopo: "secao",
          totalPedidos: 2,
          totalPecas: 3,
          pedidosRecuperaveis: 1,
          recuperacoes: 0,
          recuperadaEm: null,
        },
      ],
    });
    getListaDetalhe.mockResolvedValue({
      id: "lista-1",
      criadoEm: "2026-09-02T13:00:00.000Z",
      escopo: "secao",
      operadorId: "op-1",
      operadorNome: "Sabrina",
      recuperacoes: 0,
      recuperadaEm: null,
      recuperadaPor: null,
      pedidos: [
        {
          orderId: "ord-1",
          numero: "700001",
          tinyAccount: "acc",
          clienteNome: "Cliente 1",
          itens: [{ nome: "Camiseta Zeus", tamanho: "M", ean: "1", sku: "SKU-1", quantidade: 1 }],
          statusAtual: "ready",
          claimedByAtual: null,
          claimedPorMim: false,
          separadoEm: null,
          recuperavel: true,
        },
        {
          orderId: "ord-2",
          numero: "700002",
          tinyAccount: "acc",
          clienteNome: "Cliente 2",
          itens: [{ nome: "Bermuda Cargo", tamanho: "G", ean: "2", sku: "SKU-2", quantidade: 1 }],
          statusAtual: "separating",
          claimedByAtual: "op-2",
          claimedPorMim: false,
          separadoEm: null,
          recuperavel: false,
        },
      ],
    });

    render(<ListasImpressasModal onClose={() => {}} />);
    await waitFor(() => expect(screen.getByText(/Recuperar pedidos \(1\)/)).toBeTruthy());
    fireEvent.click(screen.getByText("▸"));

    await waitFor(() => expect(getListaDetalhe).toHaveBeenCalledWith("lista-1"));
    await waitFor(() => expect(screen.getByText("#700001")).toBeTruthy());
    expect(screen.getByText("Recuperável")).toBeTruthy();
    expect(screen.getByText("Com outra operadora")).toBeTruthy();
  });

  it("404 no nexus antigo mostra aviso amigável em vez de estourar erro", async () => {
    getListas.mockRejectedValue(new ApiError(404, "HTTP 404"));

    render(<ListasImpressasModal onClose={() => {}} />);
    await waitFor(() =>
      expect(screen.getByText(/aguardando atualização do nexus/)).toBeTruthy(),
    );
  });
});

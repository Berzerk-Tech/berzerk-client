// Fiação da tela de filas pra entrega em mãos: a seção aparece com a lista do
// servidor (e some no 404), "Separar" chama o claim-order e entra na mesa com
// `retomandoLista` + `pedidoInicial`, "Continuar" no pedido que já é dela
// não reclaima, e o 409 `pedido_indisponivel` vira aviso.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntregaEmMaosPedido, Order } from "../src/services/orders";

const getEntregaEmMaos = vi.fn();
const getMeusPedidos = vi.fn();
const claimOrder = vi.fn();
const devolverLote = vi.fn(async () => ({ devolvidos: 0 }));
const runnerProps: Record<string, unknown>[] = [];

vi.mock("../src/services/orders", async () => {
  const real = await vi.importActual<typeof import("../src/services/orders")>("../src/services/orders");
  return {
    ...real,
    getQueueCounts: vi.fn(async () => ({ sizes: { M: 2 }, mixedBySize: {} })),
    getMeusPedidos: (...a: unknown[]) => getMeusPedidos(...a),
    getEntregaEmMaos: (...a: unknown[]) => getEntregaEmMaos(...a),
    claimOrder: (...a: unknown[]) => claimOrder(...a),
    devolverLote: (...a: unknown[]) => devolverLote(...(a as [])),
  };
});
vi.mock("../src/components/SeparacaoRunner", () => ({
  SeparacaoRunner: (props: Record<string, unknown>) => {
    runnerProps.push(props);
    return <div data-testid="runner">{String(props.kicker)}</div>;
  },
}));
vi.mock("../src/components/OperatorChip", () => ({ OperatorChip: () => null }));
vi.mock("../src/contexts/RfidContext", () => ({
  useRfid: () => ({ connected: true, host: "http://localhost:9093", reconnect: async () => {} }),
}));
vi.mock("../src/lib/realtime", () => ({ subscribeQueueChanged: () => () => {} }));
vi.mock("../src/lib/cognito", () => ({
  getSessaoSync: () => ({ sub: "op-1", email: "operadora@berzerk.com.br" }),
}));

const { ApiError } = await import("../src/lib/api");
const { Separacao } = await import("../src/components/Separacao");
const { SEM_TAMANHO } = await import("../src/lib/filas");

function marcado(n: number, extra: Partial<EntregaEmMaosPedido> = {}): EntregaEmMaosPedido {
  return {
    orderId: `ord-${n}`,
    numero: `${700000 + n}`,
    clienteNome: `Influencer ${n}`,
    yampiOrderNumber: null,
    status: "ready",
    itens: [{ nome: "Camiseta", tamanho: "M", quantidade: 2 }],
    totalPecas: 2,
    claimedBy: null,
    claimedPorNome: null,
    separadoEm: null,
    separadoPorNome: null,
    marcadoEm: "2026-10-15T12:00:00.000Z",
    marcadoPorNome: "Luana",
    ...extra,
  };
}

function order(n: number, extra: Partial<Order> = {}): Order {
  return {
    id: `ord-${n}`,
    tinyOrderId: `${700000 + n}`,
    numero: `${700000 + n}`,
    channel: "tiny",
    status: "separating",
    predominantSize: "M",
    separationMode: "normal",
    claimedBy: "op-1",
    claimedAt: null,
    separatedBy: null,
    separatedAt: null,
    rfidTags: null,
    items: [],
    createdAt: "2026-10-15T12:00:00.000Z",
    updatedAt: "2026-10-15T12:00:00.000Z",
    entregaEmMaos: true,
    ...extra,
  } as Order;
}

async function montar() {
  render(<Separacao onBack={() => {}} />);
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

describe("Tela de filas: Entrega em mãos", () => {
  beforeEach(() => {
    runnerProps.length = 0;
    getMeusPedidos.mockReset().mockResolvedValue({ orders: [] });
    claimOrder.mockReset();
    devolverLote.mockClear();
    getEntregaEmMaos.mockReset().mockResolvedValue({ pedidos: [marcado(1)], pendentes: [] });
  });
  afterEach(() => cleanup());

  it("nexus sem a rota (null) esconde a seção", async () => {
    getEntregaEmMaos.mockResolvedValue(null);
    await montar();
    expect(screen.queryByText(/Entrega em mãos/)).toBeNull();
  });

  it("Separar faz o claim-order e entra na mesa segurando a fila (retomandoLista + pedidoInicial)", async () => {
    claimOrder.mockResolvedValue({ order: order(1) });
    await montar();
    fireEvent.click(screen.getByText("Separar"));
    await flush();
    expect(claimOrder).toHaveBeenCalledWith("ord-1");
    expect(screen.getByTestId("runner").textContent).toBe("Entrega em mãos");
    const props = runnerProps.at(-1)!;
    expect(props.retomandoLista).toBe(true);
    expect((props.pedidoInicial as Order).id).toBe("ord-1");
    expect(props.queue).toEqual({ mode: "normal", size: "M", sizes: ["M"] });
  });

  it("pedido sem tamanho entra pela fila Sem tamanho, não XG", async () => {
    claimOrder.mockResolvedValue({ order: order(1, { predominantSize: null, separationMode: "total" }) });
    await montar();
    fireEvent.click(screen.getByText("Separar"));
    await flush();
    const props = runnerProps.at(-1)!;
    expect(props.queue).toEqual({ mode: "total", size: SEM_TAMANHO, sizes: [SEM_TAMANHO] });
  });

  it("409 pedido_indisponivel vira aviso com a mensagem do servidor e recarrega a lista", async () => {
    claimOrder.mockImplementation(() =>
      Promise.reject(new ApiError(409, "x", { error: "pedido_indisponivel", status: "separating", message: "A mesa 2 já pegou esse pedido." })),
    );
    await montar();
    expect(getEntregaEmMaos).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("Separar"));
    await flush();
    expect(screen.getByText("A mesa 2 já pegou esse pedido.")).toBeTruthy();
    expect(screen.queryByTestId("runner")).toBeNull();
    expect(getEntregaEmMaos).toHaveBeenCalledTimes(2);
  });

  it("separating de OUTRA mesa mostra o nome sem botão; o MEU mostra Continuar e entra sem reclaimar", async () => {
    getEntregaEmMaos.mockResolvedValue({
      pedidos: [
        marcado(2, { status: "separating", claimedBy: "op-9", claimedPorNome: "Nicole" }),
        marcado(1, { status: "separating", claimedBy: "op-1", claimedPorNome: "Eu" }),
      ],
      pendentes: [],
    });
    getMeusPedidos.mockResolvedValue({ orders: [order(1)] });
    await montar();
    expect(screen.getByText("separando: Nicole")).toBeTruthy();
    expect(screen.queryByText("Separar")).toBeNull();
    fireEvent.click(screen.getByText("Continuar"));
    await flush();
    expect(claimOrder).not.toHaveBeenCalled();
    expect((runnerProps.at(-1)!.pedidoInicial as Order).id).toBe("ord-1");
  });

  it("Retomar com entrega em mãos em aberto entra no meus-pedidos com ele aberto", async () => {
    getEntregaEmMaos.mockResolvedValue({ pedidos: [], pendentes: [] });
    getMeusPedidos.mockResolvedValue({ orders: [order(5, { entregaEmMaos: false }), order(1)] });
    await montar();
    fireEvent.click(screen.getByText("Retomar"));
    await flush();
    const props = runnerProps.at(-1)!;
    expect(props.retomandoLista).toBe(true);
    expect((props.pedidoInicial as Order).id).toBe("ord-1");
  });

  it("status antes de ready não tem botão e aparece como aguardando", async () => {
    getEntregaEmMaos.mockResolvedValue({ pedidos: [marcado(3, { status: "invoiced" })], pendentes: [] });
    await montar();
    expect(screen.queryByText("Separar")).toBeNull();
    expect(screen.getAllByText(/aguardando faturar/).length).toBeGreaterThanOrEqual(1); // linha + contagem do cabeçalho
  });
});

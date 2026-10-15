// Entrega em mãos (15/10): a mesa entra com o pedido pego pelo clique
// (`pedidoInicial`) SEM puxar a fila automática, abre ele por cima do filtro
// salvo e o deixa fora do Picking Geral.
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Order } from "../src/services/orders";

const claimLote = vi.fn();
const getMe = vi.fn();
const getMeusPedidos = vi.fn();
const completeSeparacao = vi.fn();

vi.mock("../src/services/orders", async () => {
  const real = await vi.importActual<typeof import("../src/services/orders")>("../src/services/orders");
  return {
    ...real,
    claimLote: (...a: unknown[]) => claimLote(...a),
    getMe: (...a: unknown[]) => getMe(...a),
    getMeusPedidos: (...a: unknown[]) => getMeusPedidos(...a),
    getQueueDates: vi.fn(async () => ({ dates: [], total: 0, semData: 0 })),
    iniciarSeparacao: vi.fn(async () => null),
    releaseSeparacao: vi.fn(async () => null),
    devolverLote: vi.fn(async () => ({ devolvidos: 0 })),
    completeSeparacao: (...a: unknown[]) => completeSeparacao(...a),
    marcarListaImpressa: vi.fn(async () => ({ presos: 0, listaId: null })),
    getSupervisores: vi.fn(async () => ({ supervisores: [] })),
  };
});
vi.mock("../src/services/listas", async () => {
  const real = await vi.importActual<typeof import("../src/services/listas")>("../src/services/listas");
  return { ...real, getListas: vi.fn(async () => ({ listas: [] })), recuperarLista: vi.fn() };
});
vi.mock("../src/lib/printer", () => ({ printPdfBase64: vi.fn(async () => ({ ok: true })) }));
vi.mock("../src/services/printerConfig", () => ({ getLabelPrinter: () => null }));
vi.mock("../src/lib/pickingPdf", () => ({ gerarPickingPdf: vi.fn(() => "") }));
vi.mock("../src/contexts/RfidContext", () => ({
  useRfid: () => ({
    connected: true,
    host: "http://localhost:9093",
    lastError: null,
    reconnect: async () => {},
    startReadingSession: () => ({ stop: () => {}, reset: async () => {} }),
    startPresenceSession: () => () => {},
    resolveEpcs: async () => new Map(),
  }),
}));
vi.mock("../src/lib/realtime", () => ({
  subscribeQueueChanged: () => () => {},
  subscribeEvento: () => () => {},
  subscribePrintJobsChanged: () => () => {},
}));
vi.mock("../src/lib/beep", () => ({ beepOk: () => {}, beepError: () => {} }));
vi.mock("../src/lib/cognito", () => ({
  getSessaoSync: () => ({ sub: "op-1", email: "operadora@berzerk.com.br" }),
  getIdToken: async () => null,
  sair: async () => {},
  getSessao: async () => null,
  onSessaoChange: () => () => {},
}));

const { SeparacaoRunner } = await import("../src/components/SeparacaoRunner");
const { saveFilters } = await import("../src/components/PickingFiltersModal");

function pedido(n: number, extra: Partial<Order> = {}): Order {
  return {
    id: `ord-${n}`,
    tinyOrderId: `${700000 + n}`,
    numero: `${700000 + n}`,
    channel: "tiny",
    status: "separating",
    predominantSize: "M",
    separationMode: "total",
    claimedBy: "op-1",
    claimedAt: "2026-10-15T12:00:00.000Z",
    separatedBy: null,
    separatedAt: null,
    rfidTags: null,
    listaEm: null,
    listaId: null,
    items: [
      { id: `ord-${n}-it-0`, ean: `789000000${n}0`, sku: `SKU-${n}-0`, nome: `Camiseta ${n} - G`, tamanho: "G", quantidade: 1, imagemUrl: null },
    ],
    createdAt: "2026-10-15T12:00:00.000Z",
    updatedAt: "2026-10-15T12:00:00.000Z",
    clienteNome: `Cliente ${n}`,
    dataEmissao: "2026-10-15T12:00:00.000Z",
    prioritario: false,
    ...extra,
  } as Order;
}

const EM_MAOS = pedido(9, { entregaEmMaos: true, clienteNome: "Influencer Nove" });

async function montar(pedidoInicial: Order | undefined = EM_MAOS) {
  render(
    <SeparacaoRunner
      title="Separação — Entrega em mãos"
      kicker="Entrega em mãos"
      emptyHint="Nenhum pedido de entrega em mãos na sua mesa."
      queue={{ mode: "total", size: "M", sizes: ["M"] }}
      retomandoLista
      pedidoInicial={pedidoInicial}
      onBack={() => {}}
    />,
  );
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
}

describe("Entrega em mãos na mesa", () => {
  beforeEach(() => {
    localStorage.clear();
    claimLote.mockReset().mockResolvedValue({ orders: [], fila: { restantes: 0 } });
    getMeusPedidos.mockReset().mockResolvedValue({ orders: [] });
    completeSeparacao.mockReset();
    getMe.mockReset().mockResolvedValue({ actorId: "op-1", email: "operadora@berzerk.com.br", permissions: ["separacao:operate"], liberacaoSupervisorAtiva: false });
  });
  afterEach(() => cleanup());

  it("abre o pedido pego pelo clique sem puxar a fila automática, mesmo fora do meus-pedidos", async () => {
    await montar();
    expect(claimLote).not.toHaveBeenCalled();
    expect(getMeusPedidos).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("#700009").length).toBeGreaterThanOrEqual(1); // card + cabeçalho da mesa
    expect(screen.getAllByText("Entrega em mãos").length).toBeGreaterThanOrEqual(1);
  });

  it("com lote dela em aberto, o pedido de entrega em mãos abre na mesa e vem primeiro na coluna", async () => {
    getMeusPedidos.mockResolvedValue({ orders: [pedido(1), pedido(2), EM_MAOS] });
    await montar();
    expect(claimLote).not.toHaveBeenCalled();
    // Cabeçalho da mesa (▶) é o pedido de entrega em mãos.
    expect(screen.getByText("▶").parentElement?.textContent).toContain("700009");
    // Card dele vem antes dos outros na coluna.
    const numeros = screen.getAllByText(/^#70000[129]$/).map((el) => el.textContent);
    expect(numeros[0]).toBe("#700009");
  });

  it("filtro salvo da fila não esconde o pedido de entrega em mãos", async () => {
    // Mesmo formato do `saveFilters` (chave por fila): um dia de 2020 esconderia tudo.
    saveFilters("total", "M", { dateFrom: "2020-01-01", dateTo: "2020-01-01" });
    await montar();
    expect(screen.getAllByText("#700009").length).toBeGreaterThanOrEqual(1); // card + cabeçalho da mesa
    expect(screen.queryByText(/fora do filtro/)).toBeNull();
  });
});

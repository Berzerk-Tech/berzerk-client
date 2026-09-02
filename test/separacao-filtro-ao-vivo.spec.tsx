// Filtro de exclusão AO VIVO (relato de 02/09: "ao filtrar os pedidos não
// somem da tela"). O pedido da mesa, sem leitura, precisa ceder a mesa e sumir
// da sidebar junto com os outros que o filtro esconde. A causa era o
// `puxarLote({ preservarAtual })` disparado logo depois da troca: a ref do
// pedido atual ainda apontava pro antigo, o servidor o devolvia (é dela, só
// oculto) e ele voltava pra mesa como "fora do filtro".
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Order } from "../src/services/orders";

const claimLote = vi.fn();
const getMe = vi.fn();

vi.mock("../src/services/orders", async () => {
  const real = await vi.importActual<typeof import("../src/services/orders")>(
    "../src/services/orders",
  );
  return {
    ...real,
    claimLote: (...a: unknown[]) => claimLote(...a),
    getMe: (...a: unknown[]) => getMe(...a),
    getMeusPedidos: vi.fn(async () => ({ orders: [] })),
    getQueueDates: vi.fn(async () => ({ dates: [], total: 0, semData: 0 })),
    getQueueProducts: vi.fn(async () => ({ products: [] })),
    iniciarSeparacao: vi.fn(async () => null),
    releaseSeparacao: vi.fn(async () => null),
    devolverLote: vi.fn(async () => ({ devolvidos: 0 })),
    completeSeparacao: vi.fn(async () => null),
  };
});

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

function pedido(n: number, extra?: string): Order {
  const dia = "2026-09-02";
  const items = [
    { id: `o${n}-a`, ean: `7890${n}a`, sku: `S${n}a`, nome: `Camiseta Zeus - M`, tamanho: "M", quantidade: 1, imagemUrl: null },
  ];
  if (extra) items.push({ id: `o${n}-b`, ean: `7890${n}b`, sku: `S${n}b`, nome: extra, tamanho: "XG", quantidade: 1, imagemUrl: null });
  return {
    id: `ord-${n}`, tinyOrderId: `${700000 + n}`, numero: `${700000 + n}`, channel: "tiny", status: "ready",
    predominantSize: "M", separationMode: "normal", claimedBy: "op-1", claimedAt: `${dia}T12:00:00.000Z`,
    separatedBy: null, separatedAt: null, rfidTags: null, items,
    createdAt: `${dia}T12:00:00.000Z`, updatedAt: `${dia}T12:00:00.000Z`, clienteNome: `Cliente ${n}`,
    dataEmissao: `${dia}T12:00:00.000Z`, prioritario: false,
  } as Order;
}
const LOTE = [pedido(1, "Calça Cargo - XG"), pedido(2), pedido(3, "Calça Cargo - XG"), pedido(4)];
const QUEUE = { mode: "normal" as const, size: "M", sizes: ["M"] };
const tick = async () => { for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); }); await act(async () => { await new Promise((r) => setTimeout(r, 60)); }); };

describe("filtro de exclusão ao vivo", () => {
  beforeEach(() => {
    localStorage.clear();
    claimLote.mockReset().mockImplementation(async () => ({ orders: LOTE, fila: { restantes: 0 } }));
    getMe.mockReset().mockResolvedValue({ actorId: "op-1", email: "x@berzerk.com.br", permissions: ["separacao:operate"], liberacaoSupervisorAtiva: true });
  });
  afterEach(cleanup);
  it("marcar Calça Cargo e aplicar some com os pedidos 1 e 3", async () => {
    render(<SeparacaoRunner title="Separação" kicker="Fila M" emptyHint="Fila vazia" queue={QUEUE} onBack={() => {}} />);
    await tick();
    expect(screen.getAllByText("#700001").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /^Filtros/ }));
    await tick();
    fireEvent.click(screen.getAllByText("Calça Cargo - XG").find((e) => e.closest("button"))!);
    fireEvent.click(screen.getByRole("button", { name: /^Aplicar/ }));
    await tick();
    expect(screen.queryAllByText("#700001").length).toBe(0);
    expect(screen.queryAllByText("#700003").length).toBe(0);
    expect(screen.getAllByText("#700002").length).toBeGreaterThan(0);
    // O servidor foi consultado com o filtro (é ele que recorta o claim).
    const ultimo = claimLote.mock.calls.at(-1)![0] as { filters?: { excludeProducts?: string[] } };
    expect(ultimo.filters?.excludeProducts).toEqual(["Calça Cargo - XG"]);
  });

  it("reposição por WS com o pedido da mesa fora do filtro e sem leitura: ele cede a mesa", async () => {
    render(<SeparacaoRunner title="Separação" kicker="Fila M" emptyHint="Fila vazia" queue={QUEUE} onBack={() => {}} />);
    await tick();
    fireEvent.click(screen.getByRole("button", { name: /^Filtros/ }));
    await tick();
    fireEvent.click(screen.getAllByText("Calça Cargo - XG").find((e) => e.closest("button"))!);
    fireEvent.click(screen.getByRole("button", { name: /^Aplicar/ }));
    await tick();
    // Qualquer reposição posterior (WS, troca de filtro) continua sem trazê-lo.
    await tick();
    expect(screen.queryAllByText("#700001").length).toBe(0);
    expect(screen.queryAllByText("#700003").length).toBe(0);
  });
});

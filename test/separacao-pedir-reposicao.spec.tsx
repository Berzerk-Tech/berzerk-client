// Botão "Pedir reposição" no runner: só com suporte do nexus; abrir não derruba a mesa.
import { Profiler, StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Order } from "../src/services/orders";

const getMeusReposicao = vi.fn();
vi.mock("../src/services/reposicaoPedidos", async () => {
  const real = await vi.importActual<typeof import("../src/services/reposicaoPedidos")>("../src/services/reposicaoPedidos");
  return {
    ...real,
    getMeusPedidosReposicao: () => getMeusReposicao(),
    getCatalogoReposicao: vi.fn(async () => ({ kind: "fora_da_fila", tamanhos: [] })),
  };
});

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
  subscribeExclusoesGlobaisChanged: () => () => {},
  subscribeEventos: () => () => {},
  subscribeEvento: () => () => {},
  subscribePrintJobsChanged: () => () => {},
}));

const getExclusoesGlobais = vi.fn(async (): Promise<unknown> => null);
vi.mock("../src/services/exclusoesGlobais", async () => {
  const real = await vi.importActual<typeof import("../src/services/exclusoesGlobais")>(
    "../src/services/exclusoesGlobais",
  );
  return { ...real, getExclusoesGlobais: () => getExclusoesGlobais() };
});

vi.mock("../src/lib/beep", () => ({ beepOk: () => {}, beepError: () => {} }));

vi.mock("../src/lib/cognito", () => ({
  getSessaoSync: () => ({ sub: "op-1", email: "operadora@berzerk.com.br" }),
  getIdToken: async () => null,
  sair: async () => {},
  getSessao: async () => null,
  onSessaoChange: () => () => {},
}));

const { SeparacaoRunner } = await import("../src/components/SeparacaoRunner");

function pedido(n: number, opts: { dia?: string; nome?: string } = {}): Order {
  const dia = opts.dia ?? "2026-08-27";
  return {
    id: `ord-${n}`,
    tinyOrderId: `${700000 + n}`,
    numero: `${700000 + n}`,
    channel: "tiny",
    status: "ready",
    predominantSize: "M",
    separationMode: "normal",
    claimedBy: "op-1",
    claimedAt: `${dia}T12:00:00.000Z`,
    separatedBy: null,
    separatedAt: null,
    rfidTags: null,
    items: Array.from({ length: 3 }, (_, i) => ({
      id: `ord-${n}-it-${i}`,
      ean: `789000000${n}${i}`,
      sku: `SKU-${n}-${i}`,
      nome: opts.nome ?? `Camiseta Oversized ${n}-${i} - M`,
      tamanho: "M",
      quantidade: 1,
      imagemUrl: `https://cdn.shopify.com/s/files/1/0653/3975/2616/files/peca-${n}-${i}.jpg?v=1772119324`,
    })),
    createdAt: `${dia}T12:00:00.000Z`,
    updatedAt: `${dia}T12:00:00.000Z`,
    clienteNome: `Cliente ${n}`,
    dataEmissao: `${dia}T12:00:00.000Z`,
    prioritario: false,
  };
}

const LOTE = Array.from({ length: 10 }, (_, i) => pedido(i + 1));

const QUEUE = { mode: "normal" as const, size: "M", sizes: ["M"] };


const QUEUE_ = { mode: "normal" as const, size: "M", sizes: ["M"] };

async function montar() {
  render(<SeparacaoRunner title="Separação" kicker="Fila M — Puro" emptyHint="Fila vazia" queue={QUEUE_} onBack={() => {}} />);
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
}

describe("SeparacaoRunner — Pedir reposição", () => {
  beforeEach(() => {
    localStorage.clear();
    claimLote.mockReset().mockResolvedValue({ orders: [pedido(1)], fila: { restantes: 0 } });
    getMe.mockReset().mockResolvedValue({ actorId: "op-1", email: "operadora@berzerk.com.br", permissions: ["separacao:operate"], liberacaoSupervisorAtiva: true });
  });
  afterEach(() => cleanup());

  it("sem suporte (null): botão invisível", async () => {
    getMeusReposicao.mockReset().mockResolvedValue(null);
    await montar();
    expect(screen.queryByText(/Pedir reposição/)).toBeNull();
  });

  it("com suporte: botão com contador, abre o painel sem refazer o lote", async () => {
    getMeusReposicao.mockReset().mockResolvedValue({
      agora: "2026-11-10T12:00:00Z",
      pendentes: [{ id: "1", falta: false }, { id: "2", falta: true }],
      atendidos24h: [],
    });
    await montar();
    const btn = await screen.findByText(/Pedir reposição/);
    expect(btn.textContent).toContain("não tem!");
    const claims = claimLote.mock.calls.length;
    fireEvent.click(btn);
    await screen.findByText("Você precisa estar com pedidos na mesa pra pedir reposição.");
    expect(claimLote.mock.calls.length).toBe(claims);
  });
});

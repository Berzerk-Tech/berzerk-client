// Regra de negócio (Leonardo, 04/09): pedido de LISTA IMPRESSA fica com quem
// imprimiu até o fim do dia. Nenhum caminho do app pode devolvê-lo pra fila —
// nem "Devolver à fila" no card, nem sair da fila. Foi a causa de "os mistos
// sumiram"; este teste segura a regra.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Order } from "../src/services/orders";

const claimLote = vi.fn();
const getMe = vi.fn();
const releaseSeparacao = vi.fn(async () => null);
const devolverLote = vi.fn(async () => ({ devolvidos: 0 }));

vi.mock("../src/services/orders", async () => {
  const real = await vi.importActual<typeof import("../src/services/orders")>("../src/services/orders");
  return {
    ...real,
    claimLote: (...a: unknown[]) => claimLote(...a),
    getMe: (...a: unknown[]) => getMe(...a),
    getMeusPedidos: vi.fn(async () => ({ orders: [] })),
    getQueueDates: vi.fn(async () => ({ dates: [], total: 0, semData: 0 })),
    iniciarSeparacao: vi.fn(async () => null),
    releaseSeparacao: (...a: unknown[]) => releaseSeparacao(...(a as [])),
    devolverLote: (...a: unknown[]) => devolverLote(...(a as [])),
    completeSeparacao: vi.fn(async () => null),
  };
});
vi.mock("../src/services/listas", async () => {
  const real = await vi.importActual<typeof import("../src/services/listas")>("../src/services/listas");
  return { ...real, getListas: vi.fn(async () => ({ listas: [] })), recuperarLista: vi.fn() };
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

function pedido(n: number, listaEm: string | null): Order {
  return {
    id: `ord-${n}`,
    tinyOrderId: `${700000 + n}`,
    numero: `${700000 + n}`,
    channel: "tiny",
    status: "ready",
    predominantSize: "M",
    separationMode: "normal",
    claimedBy: "op-1",
    claimedAt: "2026-09-04T12:00:00.000Z",
    separatedBy: null,
    separatedAt: null,
    rfidTags: null,
    listaEm,
    items: [
      {
        id: `ord-${n}-it-0`,
        ean: `789000000${n}0`,
        sku: `SKU-${n}-0`,
        nome: `Camiseta Oversized ${n} - M`,
        tamanho: "M",
        quantidade: 1,
        imagemUrl: null,
      },
    ],
    createdAt: "2026-09-04T12:00:00.000Z",
    updatedAt: "2026-09-04T12:00:00.000Z",
    clienteNome: `Cliente ${n}`,
    dataEmissao: "2026-09-04T12:00:00.000Z",
    prioritario: false,
  } as Order;
}

// 1–3 com lista impressa (o pedido da mesa é o #700001), 4–5 sem.
const LOTE = [1, 2, 3].map((n) => pedido(n, "2026-09-04T14:34:43.000Z")).concat([4, 5].map((n) => pedido(n, null)));

async function montar(onBack = () => {}) {
  render(<SeparacaoRunner title="Separação" kicker="Fila M — Mistos" emptyHint="Fila vazia" queue={{ mode: "total", size: "M", sizes: ["M"] }} onBack={onBack} />);
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
}

describe("lista impressa fica com a operadora até o fim do dia", () => {
  beforeEach(() => {
    localStorage.clear();
    releaseSeparacao.mockClear();
    devolverLote.mockClear();
    claimLote.mockReset().mockResolvedValue({ orders: LOTE, fila: { restantes: 0 } });
    getMe.mockReset().mockResolvedValue({
      actorId: "op-1",
      email: "operadora@berzerk.com.br",
      permissions: ["separacao:operate"],
      liberacaoSupervisorAtiva: true,
    });
  });
  afterEach(() => cleanup());

  it("\"Devolver à fila\" no pedido de lista não chama release e avisa", async () => {
    await montar();
    expect(screen.getAllByText("#700001").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText("Devolver à fila"));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(releaseSeparacao).not.toHaveBeenCalled();
    expect(screen.getByText(/fica com você até o fim do dia/)).toBeTruthy();
  });

  it("sair da fila devolve só os pedidos SEM lista, nunca com incluirLista", async () => {
    const onBack = vi.fn();
    await montar(onBack);
    fireEvent.click(screen.getByLabelText("Voltar ao menu"));
    await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
    expect(devolverLote).toHaveBeenCalledTimes(1);
    const [ids, opts] = devolverLote.mock.calls[0] as unknown as [string[], { incluirLista?: boolean } | undefined];
    expect(ids.sort()).toEqual(["ord-4", "ord-5"]);
    expect(opts?.incluirLista).not.toBe(true);
    expect(onBack).toHaveBeenCalled();
  });
});

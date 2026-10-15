// Pipeline de listas nos mistos (Roger, CD, 15/10): com a lista 1 na mesa a
// operadora "tira" a lista 2 pelo botão, que puxa SÓ a lista em montagem
// (`novaLista`) e abre o Picking Geral num escopo que carimba/imprime só ela.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/lib/api";
import type { Order } from "../src/services/orders";

const claimLote = vi.fn();
const getMe = vi.fn();
const marcarListaImpressa = vi.fn();
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
    releaseSeparacao: vi.fn(async () => null),
    devolverLote: (...a: unknown[]) => devolverLote(...(a as [])),
    completeSeparacao: vi.fn(async () => null),
    marcarListaImpressa: (...a: unknown[]) => marcarListaImpressa(...a),
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

function pedido(n: number, listaEm: string | null, listaId: string | null = listaEm ? `lista-${listaEm}` : null): Order {
  return {
    id: `ord-${n}`,
    tinyOrderId: `${700000 + n}`,
    numero: `${700000 + n}`,
    channel: "tiny",
    status: "ready",
    predominantSize: "M",
    separationMode: "total",
    claimedBy: "op-1",
    claimedAt: "2026-10-15T12:00:00.000Z",
    separatedBy: null,
    separatedAt: null,
    rfidTags: null,
    listaEm,
    listaId,
    items: [
      { id: `ord-${n}-it-0`, ean: `789000000${n}0`, sku: `SKU-${n}-0`, nome: `Camiseta ${n} - G`, tamanho: "G", quantidade: 1, imagemUrl: null },
    ],
    createdAt: "2026-10-15T12:00:00.000Z",
    updatedAt: "2026-10-15T12:00:00.000Z",
    clienteNome: `Cliente ${n}`,
    dataEmissao: "2026-10-15T12:00:00.000Z",
    prioritario: false,
  } as Order;
}

const LISTA_1 = "2026-10-15T13:00:00.000Z";
const LISTA_2 = "2026-10-15T15:30:00.000Z";
// Lista 1 impressa (1–3) + 2 sem lista (4–5).
const LOTE = [1, 2, 3].map((n) => pedido(n, LISTA_1)).concat([4, 5].map((n) => pedido(n, null)));

async function montar(queue = { mode: "total" as const, size: "M", sizes: ["M"] }) {
  render(<SeparacaoRunner title="Separação" kicker="Fila M — Mistos" emptyHint="Fila vazia" queue={queue} onBack={() => {}} />);
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
}
const tick = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });

describe("Tirar nova lista (mistos)", () => {
  beforeEach(() => {
    localStorage.clear();
    marcarListaImpressa.mockReset().mockResolvedValue({ presos: 4, listaId: "lista-2" });
    devolverLote.mockClear();
    claimLote.mockReset().mockResolvedValue({ orders: LOTE, fila: { restantes: 10 } });
    getMe.mockReset().mockResolvedValue({ actorId: "op-1", email: "operadora@berzerk.com.br", permissions: ["separacao:operate"], liberacaoSupervisorAtiva: false });
  });
  afterEach(() => cleanup());

  it("puxa só a lista em montagem, mantém o pedido da mesa e imprime/carimba só os novos", async () => {
    await montar();
    expect(claimLote).toHaveBeenCalledTimes(1);
    expect(claimLote.mock.calls[0][0]).not.toHaveProperty("novaLista");
    const botao = screen.getByText("➕ Tirar nova lista");

    const novos = [4, 5, 6, 7].map((n) => pedido(n, null));
    claimLote.mockResolvedValueOnce({ orders: [...LOTE.slice(0, 3), ...novos], fila: { restantes: 6 }, novos: novos.map((o) => o.id) });
    fireEvent.click(botao);
    await tick();
    expect(claimLote).toHaveBeenCalledTimes(2);
    expect(claimLote.mock.calls[1][0]).toMatchObject({ mode: "total", novaLista: true });
    // O pedido da mesa (#700001, da lista 1) não mudou.
    expect(screen.getAllByText("#700001").length).toBeGreaterThan(0);
    // Picking Geral abre no escopo da lista nova, com só os 4 pedidos.
    expect(screen.getByText("Nova lista (4)")).toBeTruthy();

    fireEvent.click(screen.getByText("🖨 Imprimir Tudo"));
    await tick();
    expect(marcarListaImpressa).toHaveBeenCalledTimes(1);
    const args = marcarListaImpressa.mock.calls[0][0] as { orderIds: string[]; escopo: string };
    expect(args.escopo).toBe("lote");
    expect([...args.orderIds].sort()).toEqual(["ord-4", "ord-5", "ord-6", "ord-7"]);
    expect(args.orderIds).not.toContain("ord-1");
  });

  it("fila sem pedidos novos (novos vazio) avisa e não abre impressão", async () => {
    await montar();
    claimLote.mockResolvedValueOnce({ orders: LOTE, fila: { restantes: 0 }, novos: [] });
    fireEvent.click(screen.getByText("➕ Tirar nova lista"));
    await tick();
    expect(screen.getByText(/Fila sem pedidos novos/)).toBeTruthy();
    expect(screen.queryByText(/Nova lista \(/)).toBeNull();
    expect(marcarListaImpressa).not.toHaveBeenCalled();
    expect(devolverLote).not.toHaveBeenCalled();
  });

  it("nexus sem novaLista (resposta sem `novos`) devolve o que ele puxou sem folha e avisa", async () => {
    await montar();
    // O servidor antigo ignorou o campo e completou o lote com 2 pedidos novos sem lista.
    claimLote.mockResolvedValueOnce({ orders: [...LOTE, pedido(6, null), pedido(7, null)], fila: { restantes: 0 } });
    fireEvent.click(screen.getByText("➕ Tirar nova lista"));
    await tick();
    expect(devolverLote).toHaveBeenCalledTimes(1);
    expect([...(devolverLote.mock.calls[0] as unknown as [string[]])[0]].sort()).toEqual(["ord-6", "ord-7"]);
    expect(screen.getByText(/ainda não sabe tirar lista nova/)).toBeTruthy();
    expect(screen.queryByText("#700006")).toBeNull(); // não entrou na sidebar
    expect(screen.queryByText(/Nova lista \(/)).toBeNull();
  });

  it("409 limite_listas_abertas mostra a mensagem do servidor", async () => {
    await montar();
    const corpo = { error: "limite_listas_abertas", message: "Você já tem 2 listas em aberto. Confira uma antes.", listasAbertas: 2, limite: 2 };
    claimLote.mockRejectedValueOnce(new ApiError(409, corpo.message, corpo));
    fireEvent.click(screen.getByText("➕ Tirar nova lista"));
    await tick();
    expect(screen.getByText(/Você já tem 2 listas em aberto/)).toBeTruthy();
    expect(screen.queryByText(/Nova lista \(/)).toBeNull();
  });

  it("botão só aparece nos mistos com lista impressa na mesa", async () => {
    claimLote.mockResolvedValue({ orders: [4, 5].map((n) => pedido(n, null)), fila: { restantes: 0 } });
    await montar();
    expect(screen.queryByText("➕ Tirar nova lista")).toBeNull();
    cleanup();
    claimLote.mockResolvedValue({ orders: LOTE, fila: { restantes: 0 } });
    await montar({ mode: "normal", size: "M", sizes: ["M"] });
    expect(screen.queryByText("➕ Tirar nova lista")).toBeNull();
  });

  it("sidebar ordena lista 1 antes da lista 2 (e sem lista por último) e numera os cards", async () => {
    // Servidor devolve fora de ordem: lista 2, sem lista, lista 1.
    const lote = [pedido(7, LISTA_2), pedido(9, null), pedido(1, LISTA_1), pedido(8, LISTA_2), pedido(2, LISTA_1)];
    claimLote.mockResolvedValue({ orders: lote, fila: { restantes: 0 } });
    await montar();
    const chips = screen.getAllByText(/^Lista [12]$/).map((el) => el.textContent);
    expect(chips).toEqual(["Lista 1", "Lista 1", "Lista 2", "Lista 2"]);
    // O pedido da mesa é o primeiro da ordem nova: #700001 (lista 1), não #700007.
    const cards = screen.getAllByText(/^#70000[0-9]$/).map((el) => el.textContent);
    expect(cards.indexOf("#700001")).toBeLessThan(cards.indexOf("#700007"));
    expect(cards.indexOf("#700007")).toBeLessThan(cards.indexOf("#700009"));
  });
});

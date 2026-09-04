// Entrar na fila de MISTOS pela tela de escolha (tab → tamanho → confirmar) e
// chegar no runner sem a árvore cair. Existe por causa da 0.9.33 (04/09): um
// hook colocado depois do `if (confirmed) return` derrubou a tela em branco
// exatamente nesse clique — e o teste do runner não passa por aqui.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const claimLote = vi.fn();
const getMe = vi.fn();

vi.mock("../src/services/orders", async () => {
  const real = await vi.importActual<typeof import("../src/services/orders")>("../src/services/orders");
  return {
    ...real,
    claimLote: (...a: unknown[]) => claimLote(...a),
    getMe: (...a: unknown[]) => getMe(...a),
    getMeusPedidos: vi.fn(async () => ({ orders: [] })),
    getQueueCounts: vi.fn(async () => ({ counts: {}, total: 0 })),
    getQueueDates: vi.fn(async () => ({ dates: [], total: 0, semData: 0 })),
    iniciarSeparacao: vi.fn(async () => null),
    releaseSeparacao: vi.fn(async () => null),
    devolverLote: vi.fn(async () => ({ devolvidos: 0 })),
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

const { Separacao } = await import("../src/components/Separacao");

const tick = async (n = 8) => {
  for (let i = 0; i < n; i++) await act(async () => { await Promise.resolve(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
};
const botao = (re: RegExp) => screen.getAllByRole("button").find((b) => re.test(b.textContent ?? ""));

describe("Separação — entrar na fila de mistos pela tela de escolha", () => {
  beforeEach(() => {
    localStorage.clear();
    claimLote.mockReset().mockResolvedValue({ orders: [], fila: { restantes: 0 } });
    getMe.mockReset().mockResolvedValue({
      actorId: "op-1",
      email: "operadora@berzerk.com.br",
      permissions: ["separacao:operate"],
      liberacaoSupervisorAtiva: true,
    });
  });
  afterEach(() => cleanup());

  it("tab Mistos → tamanho M → confirmar chega no runner sem derrubar a tela", async () => {
    const erros: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => { erros.push(a); });
    render(<Separacao onBack={() => {}} />);
    await tick();
    const tabMistos = botao(/^Mistos/);
    expect(tabMistos).toBeTruthy();
    fireEvent.click(tabMistos!);
    const tileM = botao(/^M(\d|\s|$)/);
    expect(tileM).toBeTruthy();
    fireEvent.click(tileM!);
    const confirmar = botao(/^Começar a separar/);
    expect(confirmar?.textContent).toMatch(/M Mistos/);
    expect(confirmar).toBeTruthy();
    fireEvent.click(confirmar!);
    await tick(12);
    // Runner montou (kicker da fila) e nenhum erro de hooks/render no console.
    expect(screen.getAllByText(/Fila M — Mistos/).length).toBeGreaterThan(0);
    expect(erros.filter((e) => /hooks|Rendered more|Rendered fewer|Uncaught/i.test(String(e))).length).toBe(0);
    spy.mockRestore();
  });
});

// Aba "Mercado Livre" da tela Escolha a fila (19/10): contagem e lote com
// `canal`, 409 `fila_mercado_livre_desligada` e e-commerce idêntico ao de antes.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const claimLote = vi.fn();
const getQueueCounts = vi.fn();
const getMe = vi.fn();

vi.mock("../src/services/orders", async () => {
  const real = await vi.importActual<typeof import("../src/services/orders")>("../src/services/orders");
  return {
    ...real,
    claimLote: (...a: unknown[]) => claimLote(...a),
    getQueueCounts: (...a: unknown[]) => getQueueCounts(...a),
    getMe: (...a: unknown[]) => getMe(...a),
    getMeusPedidos: vi.fn(async () => ({ orders: [] })),
    getEntregaEmMaos: vi.fn(async () => null),
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
const { ApiError } = await import("../src/lib/api");

const tick = async (n = 8) => {
  for (let i = 0; i < n; i++) await act(async () => { await Promise.resolve(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
};
const botao = (re: RegExp) => screen.getAllByRole("button").find((b) => re.test(b.textContent ?? ""));

describe("Separação — aba Mercado Livre", () => {
  beforeEach(() => {
    localStorage.clear();
    claimLote.mockReset().mockResolvedValue({ orders: [], fila: { restantes: 0 } });
    getQueueCounts.mockReset().mockResolvedValue({ sizes: { M: 3 }, mixedBySize: {} });
    getMe.mockReset().mockResolvedValue({
      actorId: "op-1",
      email: "operadora@berzerk.com.br",
      permissions: ["separacao:operate"],
      liberacaoSupervisorAtiva: true,
    });
  });
  afterEach(() => cleanup());

  it("e-commerce (padrão) lê as contagens com canal ecommerce", async () => {
    render(<Separacao onBack={() => {}} />);
    await tick();
    expect(getQueueCounts).toHaveBeenCalled();
    expect(getQueueCounts.mock.calls.every((c) => c[1] === "ecommerce")).toBe(true);
  });

  it("canal Mercado Livre lê as contagens do canal e manda canal no lote", async () => {
    render(<Separacao onBack={() => {}} />);
    await tick();
    fireEvent.click(botao(/^Mercado Livre/)!);
    await tick();
    expect(getQueueCounts).toHaveBeenLastCalledWith(undefined, "mercado_livre");
    fireEvent.click(botao(/^M(\d|\s|$)/)!);
    const confirmar = botao(/^Começar a separar/);
    expect(confirmar?.textContent).toMatch(/M Puro · Mercado Livre/);
    fireEvent.click(confirmar!);
    await tick(12);
    expect(screen.getAllByText(/Fila M — Puro · Mercado Livre/).length).toBeGreaterThan(0);
    expect(claimLote).toHaveBeenCalled();
    expect(claimLote.mock.calls[0][0]).toMatchObject({ mode: "normal", canal: "mercado_livre" });
  });

  it("e-commerce manda canal ecommerce no lote", async () => {
    render(<Separacao onBack={() => {}} />);
    await tick();
    fireEvent.click(botao(/^M(\d|\s|$)/)!);
    fireEvent.click(botao(/^Começar a separar/)!);
    await tick(12);
    expect(claimLote).toHaveBeenCalled();
    expect(claimLote.mock.calls[0][0].canal).toBe("ecommerce");
  });

  it("409 fila_mercado_livre_desligada mostra o aviso e não deixa começar", async () => {
    getQueueCounts.mockImplementation(async (_f: unknown, canal?: string) => {
      if (canal === "mercado_livre") {
        throw new ApiError(409, "desligada", { error: "fila_mercado_livre_desligada", message: "x" });
      }
      return { sizes: { M: 3 }, mixedBySize: {} };
    });
    render(<Separacao onBack={() => {}} />);
    await tick();
    fireEvent.click(botao(/^Mercado Livre/)!);
    await tick();
    expect(screen.getByText("Fila Mercado Livre ainda não liberada no Nexus")).toBeTruthy();
    expect(screen.queryByText(/HTTP 409/)).toBeNull();
    expect((botao(/^Começar a separar/) as HTMLButtonElement).disabled).toBe(true);
    // Volta pro e-commerce: tiles de novo, sem aviso.
    fireEvent.click(botao(/^E-commerce/)!);
    await tick();
    expect(screen.queryByText("Fila Mercado Livre ainda não liberada no Nexus")).toBeNull();
  });
});

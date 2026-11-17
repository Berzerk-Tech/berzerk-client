// Troca de filtro (16/11, supervisor Matheus): o que ela vê é o que ela tem.
// Servidor simulado com posse CONTADA SEM FILTRO, teto e fila por dia; o claim
// devolve a posse fora do recorte (como o `lote()` do nexus: sem `iniciado_em`,
// sem lista). O client só devolve antes quando não há claim (mesa presa em
// lista) e NUNCA devolve o pedido da mesa. A posse nunca passa do teto (o bug
// de 27/08: 81 pedidos acumulados) e a troca nunca se perde com a mesa ocupada.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Order, QueueFilters } from "../src/services/orders";

const claimLote = vi.fn();
const devolverLote = vi.fn();
const getMe = vi.fn();
const getMeusPedidos = vi.fn();

vi.mock("../src/services/orders", async () => {
  const real = await vi.importActual<typeof import("../src/services/orders")>("../src/services/orders");
  return {
    ...real,
    claimLote: (...a: unknown[]) => claimLote(...a),
    devolverLote: (...a: unknown[]) => devolverLote(...a),
    getMe: (...a: unknown[]) => getMe(...a),
    getMeusPedidos: (...a: unknown[]) => getMeusPedidos(...a),
    getQueueDates: vi.fn(async () => ({ dates: ["2026-10-31", "2026-11-03", "2026-11-05", "2026-11-06"].map((date) => ({ date, count: 30 })), total: 120, semData: 0 })),
    getQueueProducts: vi.fn(async () => ({ products: [] })),
    iniciarSeparacao: vi.fn(async () => null),
    releaseSeparacao: vi.fn(async () => null),
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

vi.mock("../src/lib/beep", () => ({ beepOk: () => {}, beepError: () => {} }));

vi.mock("../src/lib/cognito", () => ({
  getSessaoSync: () => ({ sub: "op-1", email: "operadora@berzerk.com.br" }),
  getIdToken: async () => null,
  sair: async () => {},
  getSessao: async () => null,
  onSessaoChange: () => () => {},
}));

const { SeparacaoRunner } = await import("../src/components/SeparacaoRunner");

const DIAS = ["2026-10-31", "2026-11-03", "2026-11-05", "2026-11-06"];
const TETO = 10;
const QUEUE = { mode: "normal" as const, size: "M", sizes: ["M"] };

function pedido(n: number, dia: string, extra: Partial<Order> = {}): Order {
  return {
    id: `ord-${n}`, tinyOrderId: `${700000 + n}`, numero: `${700000 + n}`, channel: "tiny", status: "ready",
    predominantSize: "M", separationMode: "normal", claimedBy: "op-1", claimedAt: `${dia}T15:00:00.000Z`,
    separatedBy: null, separatedAt: null, rfidTags: null,
    items: [{ id: `ord-${n}-it`, ean: `789${n}`, sku: `S${n}`, nome: "Camiseta Zeus - M", tamanho: "M", quantidade: 1, imagemUrl: null }],
    createdAt: `${dia}T15:00:00.000Z`, updatedAt: `${dia}T15:00:00.000Z`, clienteNome: `Cliente ${n}`,
    dataEmissao: `${dia}T15:00:00.000Z`, prioritario: false, ...extra,
  } as Order;
}

/** 30 pedidos por dia, ids 1..120 (dia i = 30*i+1 .. 30*i+30). */
const TODOS: Order[] = DIAS.flatMap((d, i) => Array.from({ length: 30 }, (_, k) => pedido(30 * i + k + 1, d)));

let posse: Set<string>;
let eventos: string[];

function noFiltro(o: Order, f: QueueFilters) {
  const dia = o.dataEmissao!.slice(0, 10);
  return !(f.dateFrom && dia < f.dateFrom) && !(f.dateTo && dia > f.dateTo);
}
const porId = (id: string) => TODOS.find((o) => o.id === id)!;

const tick = async () => {
  for (let i = 0; i < 14; i++) await act(async () => { await Promise.resolve(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
};

/** Aplica um recorte pelo seletor "Data" (as opções já estão carregadas). */
async function escolherDia(rotuloAtual: RegExp, de: string, ate: string) {
  fireEvent.click(screen.getAllByRole("button", { name: rotuloAtual })[0]);
  const pronto = () => {
    expect(screen.getByLabelText("De").querySelector(`option[value="${de}"]`)).toBeTruthy();
    expect(screen.getByLabelText("Até").querySelector(`option[value="${ate}"]`)).toBeTruthy();
  };
  // Sem waitFor: com timers falsos ele não anda; só drena microtarefas.
  for (let i = 0; i < 40; i++) {
    try {
      pronto();
      break;
    } catch (e) {
      if (i === 39) throw e;
      await act(async () => { await Promise.resolve(); });
    }
  }
  fireEvent.change(screen.getByLabelText("De"), { target: { value: de } });
  fireEvent.change(screen.getByLabelText("Até"), { target: { value: ate } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Aplicar" })); });
}

const montar = (extra: Record<string, unknown> = {}) =>
  render(<SeparacaoRunner title="Separação" kicker="Fila M" emptyHint="Fila vazia" queue={QUEUE} onBack={() => {}} {...extra} />);

describe("troca de filtro", () => {
  beforeEach(() => {
    localStorage.clear();
    posse = new Set();
    eventos = [];
    claimLote.mockReset().mockImplementation(async (p: { filters?: QueueFilters }) => {
      eventos.push("claim");
      const f = p.filters ?? {};
      // `lote()` do nexus: devolve a posse fora do recorte (sem iniciado_em/lista)…
      if (f.dateFrom || f.dateTo) {
        for (const id of [...posse]) if (!porId(id).listaEm && !porId(id).iniciadoEm && !noFiltro(porId(id), f)) posse.delete(id);
      }
      // …e completa até o teto (posse contada SEM filtro) com a fila que bate.
      for (const o of TODOS) {
        if (posse.size >= TETO) break;
        if (!posse.has(o.id) && noFiltro(o, f)) posse.add(o.id);
      }
      return { orders: TODOS.filter((o) => posse.has(o.id)), fila: { restantes: 100 } };
    });
    getMeusPedidos.mockReset().mockImplementation(async () => ({ orders: TODOS.filter((o) => posse.has(o.id)) }));
    devolverLote.mockReset().mockImplementation(async (ids: string[]) => {
      eventos.push("devolver");
      for (const id of ids) posse.delete(id);
      return { devolvidos: ids.length };
    });
    getMe.mockReset().mockResolvedValue({ actorId: "op-1", email: "x@berzerk.com.br", permissions: ["separacao:operate"], liberacaoSupervisorAtiva: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it("5 trocas de data seguidas: 1 claim por troca, posse nunca passa do teto e só o filtro novo fica com ela", async () => {
    montar();
    await tick();
    expect(posse.size).toBe(TETO);
    let rotulo: RegExp = /^Data ▾$/;
    for (const [de, ate] of [
      ["2026-11-03", "2026-11-03"],
      ["2026-11-05", "2026-11-05"],
      ["2026-11-06", "2026-11-06"],
      ["2026-10-31", "2026-11-03"],
      ["2026-11-06", "2026-11-06"],
    ]) {
      eventos = [];
      await escolherDia(rotulo, de, ate);
      await tick();
      expect(posse.size).toBeLessThanOrEqual(TETO);
      for (const id of posse) expect(noFiltro(porId(id), { dateFrom: de, dateTo: ate })).toBe(true);
      expect(eventos).toEqual(["claim"]); // o servidor devolve no claim; o client não devolve em dobro
      rotulo = /▾$/;
    }
    expect(devolverLote).not.toHaveBeenCalled();
    expect(posse.size).toBe(TETO);
    expect(screen.queryByText(/ocultos?:/)).toBeNull();
  });

  describe("mesa presa em lista (sem claim: getMeusPedidos)", () => {
    // Retomando lista: lote sem lista no lote (só pedidos de 31/10) → mesa fica no primeiro.
    const preparar = () => {
      for (const o of TODOS.slice(0, 4)) posse.add(o.id);
      claimLote.mockReset().mockRejectedValue(new Error("não deve haver claim"));
    };

    it("devolve os de outra data, NUNCA o pedido da mesa, e a lista continua visível", async () => {
      const lista = pedido(101, "2026-10-31", { listaEm: "2026-11-06T10:00:00Z", listaId: "l1" });
      const base = getMeusPedidos.getMockImplementation()!;
      for (const o of TODOS.slice(0, 3)) posse.add(o.id);
      getMeusPedidos.mockReset().mockImplementation(async () => ({
        orders: [...(await base()).orders.filter((o: Order) => posse.has(o.id)), lista],
      }));
      claimLote.mockReset();
      montar({ retomandoLista: true });
      await tick();
      await escolherDia(/^Data ▾$/, "2026-11-06", "2026-11-06");
      await tick();
      expect(devolverLote).toHaveBeenCalledTimes(1);
      const ids = devolverLote.mock.calls[0][0] as string[];
      expect(ids).not.toContain("ord-101"); // lista nunca
      expect(devolverLote.mock.calls[0][1]).toBeUndefined();
      expect(claimLote).not.toHaveBeenCalled(); // presa em lista: sem claim
      // A lista segue visível; os devolvidos não estão mais na sidebar.
      expect(screen.getAllByText("#700101").length).toBeGreaterThan(0);
      for (const id of ids) expect(screen.queryAllByText(`#${700000 + Number(id.slice(4))}`).length).toBe(0);
    });

    it("sem nenhum visível o pedido da mesa fica de fora da devolução (mesmo com leitura chegando durante o devolver)", async () => {
      preparar();
      let soltar!: () => void;
      devolverLote.mockReset().mockImplementation((ids: string[]) => new Promise((r) => { soltar = () => { for (const id of ids) posse.delete(id); r({ devolvidos: ids.length }); }; }));
      montar({ retomandoLista: true });
      await tick();
      const naMesa = (await getMeusPedidos.mock.results[0].value).orders[0].id as string;
      await escolherDia(/^Data ▾$/, "2026-11-06", "2026-11-06");
      await tick();
      expect(devolverLote).toHaveBeenCalledTimes(1);
      const ids = devolverLote.mock.calls[0][0] as string[];
      expect(ids.length).toBe(3);
      expect(ids).not.toContain(naMesa);
      soltar();
      await tick();
      // O pedido da mesa continua com ela (1 oculto), nada foi zerado.
      expect(screen.getByText(/1 oculto:/)).toBeTruthy();
    });

    it("409 no devolver: a troca segue pro recarregamento do lote mesmo assim", async () => {
      preparar();
      devolverLote.mockReset().mockRejectedValue(Object.assign(new Error("409"), { status: 409 }));
      montar({ retomandoLista: true });
      await tick();
      const antes = getMeusPedidos.mock.calls.length;
      await escolherDia(/^Data ▾$/, "2026-11-06", "2026-11-06");
      await tick();
      expect(devolverLote).toHaveBeenCalledTimes(1);
      expect(getMeusPedidos.mock.calls.length).toBeGreaterThan(antes);
      expect(screen.queryByText(/Não deu pra devolver/)).toBeNull();
    });
  });

  it("troca com a mesa ocupada fica PENDENTE e é aplicada quando libera", async () => {
    montar();
    await tick();
    // 1ª troca: o claim fica preso (mesa ocupada).
    let liberar!: () => void;
    const base = claimLote.getMockImplementation()!;
    claimLote.mockImplementationOnce(async (p: unknown) => {
      await new Promise<void>((r) => { liberar = r; });
      return base(p);
    });
    await escolherDia(/^Data ▾$/, "2026-11-03", "2026-11-03");
    await act(async () => { await Promise.resolve(); });
    // 2ª troca com a 1ª ainda em voo; a espera estoura com timers falsos.
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    await escolherDia(/▾$/, "2026-11-06", "2026-11-06");
    await vi.advanceTimersByTimeAsync(6000);
    const claimsAntes = claimLote.mock.calls.length;
    expect((claimLote.mock.calls.at(-1)![0] as { filters: QueueFilters }).filters.dateFrom).toBe("2026-11-03");
    // Libera a mesa: a troca pendente é aplicada com o filtro MAIS NOVO.
    await act(async () => { liberar(); await Promise.resolve(); });
    await vi.advanceTimersByTimeAsync(500);
    vi.useRealTimers();
    await tick();
    expect(claimLote.mock.calls.length).toBe(claimsAntes + 1);
    expect((claimLote.mock.calls.at(-1)![0] as { filters: QueueFilters }).filters.dateFrom).toBe("2026-11-06");
    for (const id of posse) expect(noFiltro(porId(id), { dateFrom: "2026-11-06", dateTo: "2026-11-06" })).toBe(true);
  });
});

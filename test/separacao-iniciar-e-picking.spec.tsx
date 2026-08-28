// `iniciado_em` e o que "Meu lote" mostra (28/08).
//
// O app marcava `POST /separacao/:id/iniciar` ao ABRIR o card. Como o servidor
// (`lote()`) só devolve à fila o que está fora do recorte E não foi iniciado
// nem teve lista impressa, qualquer pedido em que a operadora só passou o olho
// ficava preso com ela: ao trocar o filtro/a data a mesa acumulava pedidos de
// outro dia/produto que ninguém mais podia pegar, e "Meu lote" no Picking
// Geral saía maior que o recorte.
//
// Agora `iniciar` sai na PRIMEIRA LEITURA VÁLIDA. O que fica fora do recorte
// sem leitura volta pra fila (servidor); o pedido em conferência que ficou
// fora do recorte continua à vista, à parte, na sidebar e no picking.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EpcLookupItem, Order, QueueFilters } from "../src/services/orders";

const claimLote = vi.fn();
const getMe = vi.fn();
const iniciarSeparacao = vi.fn();
const getQueueProducts = vi.fn();

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
    getQueueProducts: (...a: unknown[]) => getQueueProducts(...a),
    iniciarSeparacao: (...a: unknown[]) => iniciarSeparacao(...a),
    releaseSeparacao: vi.fn(async () => null),
    devolverLote: vi.fn(async () => ({ devolvidos: 0 })),
    completeSeparacao: vi.fn(async () => null),
    marcarListaImpressa: vi.fn(async () => ({ presos: 0 })),
  };
});

/** Última sessão de leitura aberta pelo runner — o teste emite tags por ela. */
let emitirTags: (epcs: string[]) => void = () => {};
const resolveEpcs = vi.fn();

vi.mock("../src/contexts/RfidContext", () => ({
  useRfid: () => ({
    connected: true,
    host: "http://localhost:9093",
    lastError: null,
    reconnect: async () => {},
    startReadingSession: (cb: (epcs: string[]) => void) => {
      emitirTags = cb;
      return { stop: () => {}, reset: async () => {} };
    },
    startPresenceSession: () => () => {},
    resolveEpcs: (...a: unknown[]) => resolveEpcs(...a),
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

function pedido(n: number, dia: string, nome: string, ean: string): Order {
  return {
    id: `ord-${n}`,
    tinyOrderId: `${700000 + n}`,
    numero: `${700000 + n}`,
    channel: "tiny",
    status: "ready",
    predominantSize: "M",
    separationMode: "normal",
    claimedBy: "op-1",
    claimedAt: `${dia}T15:00:00.000Z`,
    separatedBy: null,
    separatedAt: null,
    rfidTags: null,
    items: [
      {
        id: `ord-${n}-it-0`,
        ean,
        sku: `SKU-${n}`,
        nome,
        tamanho: "M",
        quantidade: 2,
        imagemUrl: null,
      },
    ],
    createdAt: `${dia}T15:00:00.000Z`,
    updatedAt: `${dia}T15:00:00.000Z`,
    clienteNome: `Cliente ${n}`,
    dataEmissao: `${dia}T15:00:00.000Z`,
    prioritario: false,
  };
}

// #700001 tem CALÇA (o filtro de exclusão a tira); #700002 é camiseta.
const COM_CALCA = pedido(1, "2026-08-27", "Calça Cargo Preta - M", "7890000000011");
const CAMISETA = pedido(2, "2026-08-27", "Camiseta Oversized Zeus - M", "7890000000022");
const TODOS = [COM_CALCA, CAMISETA];

const QUEUE = { mode: "normal" as const, size: "M", sizes: ["M"] };

/**
 * O recorte que o `POST /separacao/lote` faz: o que está fora do filtro volta
 * pra fila, EXCETO o que já foi iniciado (`iniciadoEm`) ou teve lista impressa.
 */
function loteDoServidor(f: QueueFilters, iniciados: Set<string>): Order[] {
  return TODOS.filter((o) => {
    const nome = o.items[0].nome.toLowerCase();
    const dentro =
      !(f.excludeProducts ?? []).some((t) => nome.includes(t.toLowerCase())) &&
      (!f.includeProducts?.length ||
        f.includeProducts.some((t) => nome.includes(t.toLowerCase())));
    return dentro || iniciados.has(o.id);
  }).map((o) => (iniciados.has(o.id) ? { ...o, iniciadoEm: "2026-08-28T12:00:00.000Z" } : o));
}

function look(epc: string, ean13: string): EpcLookupItem {
  return { epc, ean13, sku: null, size: "M", batchCode: null };
}

async function drenar(n = 10) {
  for (let i = 0; i < n; i++) await act(async () => { await Promise.resolve(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
}

async function montar() {
  render(
    <SeparacaoRunner
      title="Separação"
      kicker="Fila M — Puro"
      emptyHint="Fila vazia"
      queue={QUEUE}
      onBack={() => {}}
    />,
  );
  await drenar(14);
}

/** Emite uma tag que casa com o item do pedido informado. */
async function lerPecaDe(o: Order, epc: string) {
  resolveEpcs.mockResolvedValueOnce(new Map([[epc, look(epc, o.items[0].ean!)]]));
  await act(async () => { emitirTags([epc]); });
  await drenar(6);
}

describe("iniciar só na primeira leitura", () => {
  const iniciados = new Set<string>();

  beforeEach(() => {
    localStorage.clear();
    iniciados.clear();
    resolveEpcs.mockReset().mockResolvedValue(new Map());
    iniciarSeparacao.mockReset().mockImplementation(async (id: string) => {
      iniciados.add(id);
      return { id, iniciadoEm: "2026-08-28T12:00:00.000Z" };
    });
    claimLote
      .mockReset()
      .mockImplementation(async (p: { filters?: QueueFilters }) =>
        ({ orders: loteDoServidor(p.filters ?? {}, iniciados), fila: { restantes: 4 } }));
    getMe.mockReset().mockResolvedValue({
      actorId: "op-1",
      email: "operadora@berzerk.com.br",
      permissions: ["separacao:operate"],
      liberacaoSupervisorAtiva: true,
    });
    getQueueProducts.mockReset().mockResolvedValue({ products: [] });
  });
  afterEach(() => cleanup());

  it("abrir o card NÃO marca iniciado; a primeira peça lida marca", async () => {
    await montar();
    // O pedido está na mesa (o card abriu), mas nada foi lido ainda.
    expect(screen.getAllByText("#700001").length).toBeGreaterThan(0);
    expect(iniciarSeparacao).not.toHaveBeenCalled();

    await lerPecaDe(COM_CALCA, "E28011AAAAAAAAAAAAAA0001");
    expect(iniciarSeparacao).toHaveBeenCalledWith("ord-1");
    expect(iniciarSeparacao).toHaveBeenCalledTimes(1);

    // Idempotente: a segunda peça do mesmo pedido não repete a chamada.
    await lerPecaDe(COM_CALCA, "E28011AAAAAAAAAAAAAA0002");
    expect(iniciarSeparacao).toHaveBeenCalledTimes(1);
  });

  it("pedido só olhado sai do lote quando o filtro o exclui", async () => {
    await montar();
    fireEvent.click(screen.getByRole("button", { name: /Filtros/ }));
    await drenar();
    fireEvent.change(screen.getByPlaceholderText(/Adicionar termo manual/i), {
      target: { value: "Calça" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Adicionar$/ }));
    await drenar();
    fireEvent.click(screen.getByRole("button", { name: /^Aplicar/ }));
    await drenar();

    // Nunca foi iniciado ⇒ o servidor devolveu à fila e a mesa seguiu.
    expect(iniciarSeparacao).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("#700001")).toBeNull());
    expect(screen.getAllByText("#700002").length).toBeGreaterThan(0);
  });
});

describe("Meu lote com pedido em conferência fora do filtro", () => {
  const iniciados = new Set<string>();

  beforeEach(() => {
    localStorage.clear();
    iniciados.clear();
    resolveEpcs.mockReset().mockResolvedValue(new Map());
    iniciarSeparacao.mockReset().mockImplementation(async (id: string) => {
      iniciados.add(id);
      return { id, iniciadoEm: "2026-08-28T12:00:00.000Z" };
    });
    claimLote
      .mockReset()
      .mockImplementation(async (p: { filters?: QueueFilters }) =>
        ({ orders: loteDoServidor(p.filters ?? {}, iniciados), fila: { restantes: 4 } }));
    getMe.mockReset().mockResolvedValue({
      actorId: "op-1",
      email: "operadora@berzerk.com.br",
      permissions: ["separacao:operate"],
      liberacaoSupervisorAtiva: true,
    });
    getQueueProducts.mockReset().mockResolvedValue({ products: [] });
  });
  afterEach(() => cleanup());

  it("fica à parte na sidebar e numa seção própria do Picking Geral", async () => {
    await montar();
    // Conferência COMEÇADA no pedido com calça: ele não volta pra fila.
    await lerPecaDe(COM_CALCA, "E28011AAAAAAAAAAAAAA0001");
    expect(iniciarSeparacao).toHaveBeenCalledWith("ord-1");

    // Agora o filtro exclui calça.
    fireEvent.click(screen.getByRole("button", { name: /Filtros/ }));
    await drenar();
    fireEvent.change(screen.getByPlaceholderText(/Adicionar termo manual/i), {
      target: { value: "Calça" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Adicionar$/ }));
    await drenar();
    fireEvent.click(screen.getByRole("button", { name: /^Aplicar/ }));
    await drenar();

    // Ele continua na mesa (tem leitura) e agora aparece MARCADO na sidebar.
    expect(screen.getAllByText("#700001").length).toBeGreaterThan(0);
    expect(screen.getByText(/em conferência · fora do filtro/i)).toBeTruthy();

    // Picking Geral, escopo "Meu lote": a calça sai numa seção própria.
    fireEvent.click(screen.getAllByRole("button", { name: /Picking Geral/ })[0]);
    await drenar();
    expect(screen.getByText("Em conferência (fora do filtro)")).toBeTruthy();
    expect(screen.getAllByText("Calça Cargo Preta - M").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Camiseta Oversized Zeus - M").length).toBeGreaterThan(0);
  });

  it("sem pedido fora do recorte não existe a seção", async () => {
    await montar();
    fireEvent.click(screen.getAllByRole("button", { name: /Picking Geral/ })[0]);
    await drenar();
    expect(screen.queryByText("Em conferência (fora do filtro)")).toBeNull();
  });
});

// Seletor "Data" da sidebar COM um filtro de produto já ativo (relato de campo
// de 28/08: nessa ordem a data não dava pra escolher; na ordem inversa — data
// primeiro, filtro depois — funcionava).
//
// A causa é de DADO, não de clique: `/separacao/queue-dates` enumera só a fila
// `ready` SEM DONO, e o `claimLote` que sai junto com o filtro puxa pro lote
// dela exatamente os pedidos que casam. Com o filtro ativo a fila que sobra
// pode não ter mais nenhum dia daquele produto, e o menu vinha só com
// "Todos (0)" — nada pra clicar. Os mocks abaixo reproduzem isso: com filtro
// de produto o servidor devolve a fila VAZIA, e as datas têm que vir do lote.
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Order, QueueFilters } from "../src/services/orders";

const claimLote = vi.fn();
const getMe = vi.fn();
const getQueueDates = vi.fn();

vi.mock("../src/services/orders", async () => {
  const real = await vi.importActual<typeof import("../src/services/orders")>(
    "../src/services/orders",
  );
  return {
    ...real,
    claimLote: (...a: unknown[]) => claimLote(...a),
    getMe: (...a: unknown[]) => getMe(...a),
    getMeusPedidos: vi.fn(async () => ({ orders: [] })),
    getQueueDates: (...a: unknown[]) => getQueueDates(...a),
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

function pedido(n: number, dia: string, nome: string): Order {
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
        ean: `789000000${n}0`,
        sku: `SKU-${n}-0`,
        nome,
        tamanho: "M",
        quantidade: 1,
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

// Dois dias e dois produtos. 15:00Z pra data local (America/Sao_Paulo) do
// pedido bater com o dia ISO — é o fuso que o app e o SQL usam pra recortar.
const TODOS: Order[] = [
  pedido(1, "2026-08-26", "Camiseta Oversized Zeus - M"),
  pedido(2, "2026-08-27", "Camiseta Oversized Ares - M"),
  pedido(3, "2026-08-27", "Regata Atlas - M"),
];

const QUEUE = { mode: "normal" as const, size: "M", sizes: ["M"] };

/** O recorte que o servidor faz no `POST /separacao/lote`. */
function passaNoServidor(o: Order, f: QueueFilters): boolean {
  const dia = o.dataEmissao!.slice(0, 10);
  if (f.dateFrom && dia < f.dateFrom) return false;
  if (f.dateTo && dia > f.dateTo) return false;
  const nome = o.items[0].nome.toLowerCase();
  if (f.includeProducts?.length && !f.includeProducts.some((t) => nome.includes(t.toLowerCase())))
    return false;
  if (f.excludeProducts?.length && f.excludeProducts.some((t) => nome.includes(t.toLowerCase())))
    return false;
  return true;
}

async function montar() {
  render(
    <StrictMode>
      <SeparacaoRunner
        title="Separação"
        kicker="Fila M — Puro"
        emptyHint="Fila vazia"
        queue={QUEUE}
        onBack={() => {}}
      />
    </StrictMode>,
  );
  for (let i = 0; i < 14; i++) await act(async () => { await Promise.resolve(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
}

async function drenar() {
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve(); });
}

/** Último `filters` que o app mandou ao servidor no `claimLote`. */
function filtrosDoUltimoClaim() {
  const call = claimLote.mock.calls.at(-1);
  return (call?.[0] as { filters?: Record<string, unknown> } | undefined)?.filters ?? {};
}

describe("seletor Data com filtro de produto ativo", () => {
  beforeEach(() => {
    localStorage.clear();
    claimLote
      .mockReset()
      .mockImplementation(async (p: { filters?: QueueFilters }) => ({
        orders: TODOS.filter((o) => passaNoServidor(o, p.filters ?? {})),
        fila: { restantes: 7 },
      }));
    getMe.mockReset().mockResolvedValue({
      actorId: "op-1",
      email: "operadora@berzerk.com.br",
      permissions: ["separacao:operate"],
      liberacaoSupervisorAtiva: true,
    });
    // A FILA (sem dono) esgota assim que há filtro de produto: é o caso de
    // campo. Sem filtro ela continua cheia — daí a ordem inversa funcionar.
    getQueueDates.mockReset().mockImplementation(async (p: { filters?: QueueFilters }) => {
      const f = p.filters ?? {};
      if (f.includeProducts?.length || f.excludeProducts?.length)
        return { dates: [], total: 0, semData: 0 };
      return {
        dates: [
          { date: "2026-08-26", count: 12 },
          { date: "2026-08-27", count: 5 },
        ],
        total: 20,
        semData: 3,
      };
    });
  });
  afterEach(() => cleanup());

  it("lista as datas do lote dela mesmo com a fila esgotada pelo filtro", async () => {
    // Filtro de produto JÁ ativo — a ordem que quebrava em campo.
    localStorage.setItem(
      "berzerk_picking_filters_v2",
      JSON.stringify({ "normal:M": { excludeProducts: ["Regata Atlas - M"] } }),
    );
    await montar();

    // A sidebar já recorta pelo produto: a Regata sai, as camisetas ficam.
    expect(screen.queryByText("#700003")).toBeNull();
    expect(screen.getAllByText("#700001").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: /^Data ▾$/ }));
    const item = await waitFor(() => screen.getByRole("button", { name: /27\/08\/2026/ }), {
      timeout: 2000,
    });
    expect(screen.queryByText("Carregando datas…")).toBeNull();
    // Os dois dias do lote dela, não só o que a fila (vazia) traria.
    expect(screen.getByRole("button", { name: /26\/08\/2026/ })).toBeTruthy();

    await act(async () => { fireEvent.click(item); });
    await drenar();

    // 1) o dia único foi pro servidor sem perder o filtro de produto
    expect(filtrosDoUltimoClaim()).toMatchObject({
      dateFrom: "2026-08-27",
      dateTo: "2026-08-27",
      excludeProducts: ["Regata Atlas - M"],
    });
    // 2) o botão passa a mostrar a data escolhida
    expect(screen.getAllByRole("button", { name: /27\/08\/2026 ▾/ }).length).toBeGreaterThan(0);
    // 3) a sidebar recorta pelo dia (o pedido de 26/08 sai)
    await waitFor(() => expect(screen.queryByText("#700001")).toBeNull());
    expect(screen.getAllByText("#700002").length).toBeGreaterThan(0);
  });

  it("soma fila e lote na contagem, sem contar o mesmo pedido duas vezes", async () => {
    // Sem filtro de produto: a fila responde 12/5 (total 20, 3 sem data) e o
    // lote dela tem 1 pedido em 26/08 e 2 em 27/08.
    await montar();
    fireEvent.click(screen.getByRole("button", { name: /^Data ▾$/ }));
    await waitFor(() => screen.getByRole("button", { name: /26\/08\/2026/ }));
    expect(screen.getByRole("button", { name: /26\/08\/2026 \(13\)/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /27\/08\/2026 \(7\)/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Todos \(23\)/ })).toBeTruthy();
  });

  it("com filtro de ADIÇÃO: escolher a data continua funcionando e o menu reabre cheio", async () => {
    localStorage.setItem(
      "berzerk_picking_filters_v2",
      JSON.stringify({ "normal:M": { includeProducts: ["Camiseta"] } }),
    );
    await montar();

    fireEvent.click(screen.getByRole("button", { name: /^Data ▾$/ }));
    const item = await waitFor(() => screen.getByRole("button", { name: /26\/08\/2026/ }));
    await act(async () => { fireEvent.click(item); });
    await drenar();

    expect(filtrosDoUltimoClaim()).toMatchObject({
      dateFrom: "2026-08-26",
      dateTo: "2026-08-26",
      includeProducts: ["Camiseta"],
    });

    // Reabrir: o dia escolhido continua clicável (o lote agora só tem ele) e
    // "Todos" segue disponível pra desfazer o recorte.
    fireEvent.click(screen.getByRole("button", { name: /26\/08\/2026 ▾/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Todos/ })).toBeTruthy());
    expect(screen.queryByText("Carregando datas…")).toBeNull();
  });
});

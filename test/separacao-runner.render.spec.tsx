// Smoke de RENDER do runner da separação: entra numa fila com um lote de 10
// pedidos (o caminho da bancada) e conta os COMMITS. Existe por causa do
// incidente de 27/08 — a mesa entrava na fila de puros e o WebView2 morria com
// "Out of Memory" antes de mostrar o pedido. A causa era um laço de render;
// um teto de commits pega qualquer regressão do mesmo tipo.
import { Profiler, StrictMode } from "react";
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

/** Renderiza o runner contando COMMITS. Teto baixo de propósito: entrar numa
 *  fila é um punhado de commits (loading → lote → /me), nunca dezenas. */
async function montarEContarCommits(): Promise<number> {
  let commits = 0;
  render(
    <StrictMode>
      <Profiler id="runner" onRender={() => { commits += 1; }}>
        <SeparacaoRunner
          title="Separação"
          kicker="Fila M — Puro"
          emptyHint="Fila vazia"
          queue={QUEUE}
          onBack={() => {}}
        />
      </Profiler>
    </StrictMode>,
  );
  // Deixa as promessas do lote e do /me assentarem e o React drenar efeitos.
  for (let i = 0; i < 12; i++) await act(async () => { await Promise.resolve(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
  return commits;
}

describe("SeparacaoRunner — entrar na fila", () => {
  beforeEach(() => {
    localStorage.clear();
    claimLote.mockReset().mockResolvedValue({ orders: LOTE, fila: { restantes: 42 } });
    getMe.mockReset().mockResolvedValue({
      actorId: "op-1",
      email: "operadora@berzerk.com.br",
      permissions: ["separacao:operate"],
      liberacaoSupervisorAtiva: true,
    });
  });
  afterEach(() => cleanup());

  it("sem filtro salvo: estabiliza em poucos commits e mostra o pedido", async () => {
    const commits = await montarEContarCommits();
    // 2, e não 1: o StrictMode monta/desmonta/remonta os efeitos de propósito.
    // O que importa é que o lote NÃO é re-buscado em laço.
    expect(claimLote.mock.calls.length).toBeLessThanOrEqual(2);
    expect(screen.getAllByText("#700001").length).toBeGreaterThan(0);
    expect(commits).toBeLessThan(40);
  });

  it("pede a imagem redimensionada ao CDN — nunca a original", () => {
    // Regressão do OOM de 27/08: a original do CDN da Shopify tem 2083×2706
    // (~23 MB decodificada) e o lote inteiro entra em tela de uma vez.
    return montarEContarCommits().then(() => {
      const imgs = Array.from(document.querySelectorAll("img"));
      expect(imgs.length).toBeGreaterThan(0);
      for (const img of imgs) {
        expect(img.getAttribute("src")).toContain("width=");
        expect(img.getAttribute("loading")).toBe("lazy");
        expect(img.getAttribute("decoding")).toBe("async");
      }
    });
  });

  it("sidebar da fila: arrasta a borda, persiste e não colapsa", async () => {
    await montarEContarCommits();
    const alca = screen.getByRole("separator", { name: "Redimensionar fila" });
    const aside = alca.parentElement as HTMLElement;
    expect(aside.tagName).toBe("ASIDE");
    expect(aside.style.width).toBe("350px");

    // jsdom não tem PointerEvent nem pointer capture: MouseEvent carrega
    // `button`/`clientX`, que é o que o hook lê; capture só não pode estourar.
    if (!("PointerEvent" in window)) (window as any).PointerEvent = MouseEvent;
    (alca as any).setPointerCapture = () => {};
    (alca as any).hasPointerCapture = () => false;

    // Puxa 80 px pra direita.
    await act(async () => {
      fireEvent.pointerDown(alca, { button: 0, clientX: 350, pointerId: 1 });
      fireEvent.pointerMove(alca, { clientX: 430, pointerId: 1 });
      fireEvent.pointerUp(alca, { clientX: 430, pointerId: 1 });
    });
    expect(aside.style.width).toBe("430px");
    expect(localStorage.getItem("berzerk_separacao_sidebar_largura_v1")).toBe("430");

    // Joga tudo pra esquerda: para no mínimo, não some (diferente do VS Code).
    await act(async () => {
      fireEvent.pointerDown(alca, { button: 0, clientX: 430, pointerId: 1 });
      fireEvent.pointerMove(alca, { clientX: -2000, pointerId: 1 });
      fireEvent.pointerUp(alca, { clientX: -2000, pointerId: 1 });
    });
    expect(aside.style.width).toBe("240px");

    // Duplo clique volta ao padrão.
    await act(async () => { fireEvent.doubleClick(alca); });
    expect(aside.style.width).toBe("350px");
    expect(localStorage.getItem("berzerk_separacao_sidebar_largura_v1")).toBe("350");
  });

  it("sidebar da fila: abre com a largura gravada na estação", async () => {
    localStorage.setItem("berzerk_separacao_sidebar_largura_v1", "480");
    await montarEContarCommits();
    const alca = screen.getByRole("separator", { name: "Redimensionar fila" });
    expect((alca.parentElement as HTMLElement).style.width).toBe("480px");
  });

  it("com data de ONTEM salva no localStorage: não entra em laço", async () => {
    // Chave v2, por fila (mode:size) — v1 era global e vazava entre filas.
    localStorage.setItem(
      "berzerk_picking_filters_v2",
      JSON.stringify({
        "normal:M": { dateFrom: "2026-08-26", dateTo: "2026-08-26" },
      }),
    );
    const commits = await montarEContarCommits();
    expect(commits).toBeLessThan(40);
  });

  it("com produto EXCLUÍDO salvo no localStorage: não entra em laço", async () => {
    localStorage.setItem(
      "berzerk_picking_filters_v2",
      JSON.stringify({ "normal:M": { excludeProducts: ["camiseta"] } }),
    );
    const commits = await montarEContarCommits();
    expect(commits).toBeLessThan(40);
  });
});

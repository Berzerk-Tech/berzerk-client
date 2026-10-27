// Modo Únicos da Expedição (27/10)
// (cabeçalho herdado do spec do Mercado Livre)
// Pedido do Mercado Livre na mesa de expedição (20/10): a mesa tem um canal
// (aba J&T / Mercado Livre, como a Separação) e só aceita pedido daquele canal.
// No canal ML o documento é a DANFE simplificada (a etiqueta do Mercado
// Envios é impressa no Tiny / Mercado Livre): não espera rastreio J&T, não
// marca etiqueta, imprime a DANFE e vai pra embalagem → ship.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExpedicaoOrder } from "../src/services/expedicao";
import { ApiError } from "../src/lib/api";

const TAG = "E28011AAAAAAAAAAAAAA0001";

const epcMatch = vi.fn();
const separarUnico = vi.fn();
const getUnicos = vi.fn();
const getUnicosPedidos = vi.fn();
const getDocumentos = vi.fn();
const markLabelPrinted = vi.fn();
const shipOrder = vi.fn();
const obterEtiquetaMl = vi.fn();
const invoke = vi.fn();
let presence: ((cur: string[]) => void) | null = null;

vi.mock("../src/services/expedicao", async () => {
  const real = await vi.importActual<typeof import("../src/services/expedicao")>("../src/services/expedicao");
  return {
    ...real,
    epcMatch: (...a: unknown[]) => epcMatch(...a),
    separarUnico: (...a: unknown[]) => separarUnico(...a),
    getUnicos: (...a: unknown[]) => getUnicos(...a),
    getUnicosPedidos: (...a: unknown[]) => getUnicosPedidos(...a),
    getDocumentos: (...a: unknown[]) => getDocumentos(...a),
    markLabelPrinted: (...a: unknown[]) => markLabelPrinted(...a),
    shipOrder: (...a: unknown[]) => shipOrder(...a),
    obterEtiquetaMl: (...a: unknown[]) => obterEtiquetaMl(...a),
  };
});
vi.mock("../src/contexts/RfidContext", () => ({
  useRfid: () => ({
    connected: true,
    host: "http://localhost:9093",
    lastError: null,
    reconnect: async () => {},
    startReadingSession: () => ({ stop: () => {}, reset: async () => {} }),
    startPresenceSession: (cb: (cur: string[]) => void) => {
      presence = cb;
      return () => {
        presence = null;
      };
    },
    resolveEpcs: async () => new Map(),
  }),
}));
vi.mock("../src/lib/beep", () => ({ beepOk: () => {}, beepError: () => {} }));
// A impressão silenciosa é um comando Rust — no jsdom só observamos o invoke.
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("../src/lib/cognito", () => ({ getSessaoSync: () => null, onSessaoChange: () => () => {} }));

const { Expedicao } = await import("../src/components/Expedicao");


function pedidoUnico(status: ExpedicaoOrder["status"] = "awaiting_pickup"): ExpedicaoOrder {
  const now = new Date().toISOString();
  return {
    id: "ord-un",
    tinyOrderId: "900002",
    numero: "900002",
    tinyAccount: "JT",
    status,
    channel: "tiny",
    canal: "ecommerce",
    clienteNome: "Cliente Único",
    dataEmissao: now,
    prioritario: false,
    trackingNumber: "JT123",
    rfidTags: [TAG],
    separatedBy: "Stefanie",
    separatedAt: now,
    shippedBy: null,
    shippedAt: null,
    shippedWithoutLabel: false,
    labelPrintedAt: null,
    hasDanfeCached: false,
    items: [{ id: "it-1", ean: null, sku: "LD-G", nome: "Oversized Leg Day G", tamanho: "G", quantidade: 1, imagemUrl: null }],
    createdAt: now,
    updatedAt: now,
  };
}

const GRUPO = { estampa: "Leg Day", tamanho: "G" };

async function abrirGrupo() {
  render(<Expedicao onBack={() => {}} />);
  await waitFor(() => expect(presence).toBeTruthy());
}

describe("Expedição — modo Únicos", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("berzerk_expedicao_modo_v1", "oficial");
    localStorage.setItem("berzerk_expedicao_fila_v1", "unicos");
    localStorage.setItem("berzerk_expedicao_unicos_grupo_v1", JSON.stringify(GRUPO));
    presence = null;
    epcMatch.mockReset();
    separarUnico.mockReset().mockResolvedValue({ order: pedidoUnico(), replay: false, grupo: GRUPO });
    getUnicos.mockReset().mockResolvedValue({
      grupos: [{ ...GRUPO, pedidos: 3, prioritarios: 1, imagemUrl: null, tipos: [{ produtoId: "p", produtoNome: "Oversized", cor: null, pedidos: 3 }] }],
      totalPedidos: 3,
      filaUnicosAtiva: false,
    });
    getUnicosPedidos.mockReset().mockResolvedValue([
      { id: "ord-un", numero: "900002", cliente: "Cliente Único", produtoNome: "Oversized", prioritario: true },
    ]);
    getDocumentos.mockReset().mockResolvedValue({ danfe: null, etiqueta: { base64: "JVBERi0=", formato: "pdf" }, trackingNumber: "JT123" });
    markLabelPrinted.mockReset().mockResolvedValue(undefined);
    shipOrder.mockReset().mockResolvedValue({ gaiola: null });
    invoke.mockReset().mockImplementation(async (cmd: string) =>
      cmd === "print_engine_status" ? { ok: true, printer: null, message: null, engine: "sumatra" } : { ok: true },
    );
  });
  afterEach(() => cleanup());

  it("sem grupo escolhido mostra os cards, o aviso da trava e escolhe a fila", async () => {
    localStorage.removeItem("berzerk_expedicao_unicos_grupo_v1");
    render(<Expedicao onBack={() => {}} />);
    expect(await screen.findByText(/Trava desligada/)).toBeTruthy();
    expect(screen.getAllByText("3 pedidos", { exact: false }).length).toBeGreaterThan(0);
    fireEvent.click(await screen.findByTitle("Escolher a fila Leg Day G"));
    expect(await screen.findByText("LEG DAY · G")).toBeTruthy();
    expect(JSON.parse(localStorage.getItem("berzerk_expedicao_unicos_grupo_v1") ?? "{}")).toEqual(GRUPO);
  });

  it("bipou: chama o separar com o grupo, imprime, expede e não repete o EPC parado na mesa", async () => {
    await abrirGrupo();
    expect(await screen.findByText("LEG DAY · G")).toBeTruthy();
    await act(async () => {
      presence?.([TAG]);
    });
    await waitFor(() => expect(separarUnico).toHaveBeenCalledTimes(1));
    expect(separarUnico.mock.calls[0][0]).toMatchObject({ rfidTags: [TAG], estampa: "Leg Day", tamanho: "G" });
    expect(epcMatch).not.toHaveBeenCalled();
    await waitFor(() => expect(shipOrder).toHaveBeenCalled(), { timeout: 9000 });
    expect(shipOrder.mock.calls[0][0]).toBe("ord-un");
    // A peça continua na mesa: segue lendo e NÃO separa de novo.
    await act(async () => {
      presence?.([TAG]);
    });
    await new Promise((r) => setTimeout(r, 600));
    expect(separarUnico).toHaveBeenCalledTimes(1);
  }, 20000);

  it("peça de outra fila: avisa, oferece Trocar fila e não expede", async () => {
    separarUnico.mockReset().mockRejectedValue(
      new ApiError(409, "x", { error: "peca_de_outra_fila", estampa: "Ember", tamanho: "M", produtoNome: "Oversized" }),
    );
    await abrirGrupo();
    await act(async () => {
      presence?.([TAG]);
    });
    expect(await screen.findByText(/Esta peça é Ember M\. A fila escolhida é LEG DAY · G\./)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Trocar fila" }).at(-1)!);
    expect(localStorage.getItem("berzerk_expedicao_unicos_grupo_v1")).toBeNull();
    expect(shipOrder).not.toHaveBeenCalled();
  });

  it("replay de pedido já expedido não reimprime", async () => {
    separarUnico.mockReset().mockResolvedValue({ order: pedidoUnico("shipped"), replay: true, grupo: GRUPO });
    await abrirGrupo();
    await act(async () => {
      presence?.([TAG]);
    });
    expect(await screen.findByText(/Pedido #900002 já foi expedido/)).toBeTruthy();
    expect(getDocumentos).not.toHaveBeenCalled();
    expect(shipOrder).not.toHaveBeenCalled();
  });

  it("modo teste: Únicos desabilitado, cai em Pedidos e não chama o separar", async () => {
    localStorage.setItem("berzerk_expedicao_modo_v1", "teste");
    render(<Expedicao onBack={() => {}} />);
    await waitFor(() => expect(presence).toBeTruthy());
    const aba = (await screen.findByRole("tab", { name: "Únicos" })) as HTMLButtonElement;
    expect(aba.disabled).toBe(true);
    expect(aba.title).toBe("Únicos só no modo oficial");
    expect(screen.getByRole("tab", { name: "Pedidos" }).getAttribute("aria-selected")).toBe("true");
    epcMatch.mockResolvedValue({ matches: [], unmatchedEpcs: [TAG], jaExpedidos: [] });
    await act(async () => {
      presence?.([TAG]);
    });
    await waitFor(() => expect(epcMatch).toHaveBeenCalled());
    expect(separarUnico).not.toHaveBeenCalled();
  });

  it("trocar fila com a mesa ocupada: botão desabilitado e nada muda", async () => {
    await abrirGrupo();
    await act(async () => {
      presence?.([TAG]);
    });
    await waitFor(() => expect(separarUnico).toHaveBeenCalledTimes(1));
    // Impressão/embalagem em curso (não chega ao ship tão cedo).
    const btn = (await screen.findByRole("button", { name: "Trocar fila" })) as HTMLButtonElement;
    await waitFor(() => expect(btn.disabled).toBe(true));
    fireEvent.click(btn);
    expect(JSON.parse(localStorage.getItem("berzerk_expedicao_unicos_grupo_v1") ?? "null")).toEqual(GRUPO);
  });

  it("erro 4xx desconhecido não refaz o POST", async () => {
    separarUnico.mockReset().mockRejectedValue(new ApiError(409, "x", { error: "invalid_status", message: "Pedido não está pronto." }));
    await abrirGrupo();
    await act(async () => {
      presence?.([TAG]);
    });
    expect(await screen.findByText("Pedido não está pronto.")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 4600));
    expect(separarUnico).toHaveBeenCalledTimes(1);
  }, 12000);

  it("no Mercado Livre o seletor de modo some e o modo volta a Pedidos", async () => {
    render(<Expedicao onBack={() => {}} />);
    expect(await screen.findByRole("tab", { name: "Únicos" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Mercado Livre" }));
    await waitFor(() => expect(screen.queryByRole("tab", { name: "Únicos" })).toBeNull());
    expect(localStorage.getItem("berzerk_expedicao_fila_v1")).toBe("pedidos");
  });
});

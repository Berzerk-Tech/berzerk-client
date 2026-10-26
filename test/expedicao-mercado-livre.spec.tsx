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

function pedidoMl(canal: "ecommerce" | "mercado_livre" = "mercado_livre"): ExpedicaoOrder {
  const now = new Date().toISOString();
  return {
    id: "ord-ml",
    tinyOrderId: "900001",
    numero: "900001",
    tinyAccount: "FM",
    status: "awaiting_pickup",
    channel: "tiny",
    canal,
    clienteNome: "Cliente ML",
    dataEmissao: now,
    prioritario: false,
    trackingNumber: null,
    rfidTags: [TAG],
    separatedBy: "Stefanie",
    separatedAt: now,
    shippedBy: null,
    shippedAt: null,
    shippedWithoutLabel: false,
    labelPrintedAt: null,
    hasDanfeCached: false,
    items: [{ id: "it-1", ean: null, sku: "CAM-M", nome: "Camiseta M", tamanho: "M", quantidade: 1, imagemUrl: null }],
    createdAt: now,
    updatedAt: now,
  };
}

async function abrirPedido() {
  render(<Expedicao onBack={() => {}} />);
  await waitFor(() => expect(presence).toBeTruthy());
  await act(async () => {
    presence?.([TAG]);
  });
}

const DANFE = { chave_acesso: "35250100000000000100550010001234561000000019", numero: "77", emitente: {}, cliente: {}, itens: [] };

describe("Expedição — pedido Mercado Livre", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("berzerk_expedicao_modo_v1", "oficial");
    localStorage.setItem("berzerk_expedicao_canal_v1", "mercado_livre");
    presence = null;
    epcMatch.mockReset().mockResolvedValue({
      matches: [{ order: pedidoMl(), tagsLidas: [TAG], tagsFaltantes: [], tagsMatched: 1, tagsTotal: 1 }],
      unmatchedEpcs: [],
      jaExpedidos: [],
    });
    getDocumentos.mockReset().mockResolvedValue({ danfe: DANFE, etiqueta: null, trackingNumber: null });
    markLabelPrinted.mockReset().mockResolvedValue(undefined);
    shipOrder.mockReset().mockResolvedValue({ gaiola: null });
    obterEtiquetaMl.mockReset().mockResolvedValue({ ok: false, erro: { codigo: "x", mensagem: "Etiqueta ainda não disponível no Tiny." } });
    invoke.mockReset().mockImplementation(async (cmd: string) =>
      cmd === "print_engine_status" ? { ok: true, printer: null, message: null, engine: "sumatra" } : { ok: true },
    );
  });
  afterEach(() => cleanup());

  it("no canal ML: imprime a DANFE (uma página), não espera rastreio nem marca etiqueta, e expede", async () => {
    await abrirPedido();
    expect(await screen.findByText("MERCADO LIVRE", {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText(/Sai a DANFE/)).toBeTruthy();
    // Embalagem (5 s) e depois o ship normal.
    await waitFor(() => expect(shipOrder).toHaveBeenCalled(), { timeout: 9000 });
    expect(shipOrder.mock.calls[0][0]).toBe("ord-ml");
    expect(getDocumentos).toHaveBeenCalledWith("ord-ml");
    const impressoes = invoke.mock.calls.filter(([cmd]) => cmd === "print_pdf_silent");
    expect(impressoes).toHaveLength(1);
    expect((impressoes[0] as [string, { jobName: string; printSettings: string }])[1].jobName).toContain("DANFE");
    expect((impressoes[0] as [string, { jobName: string; printSettings: string }])[1].printSettings).toBe("1,fit");
    expect(markLabelPrinted).not.toHaveBeenCalled();
    expect(screen.queryByText(/ainda não tem o rastreio/)).toBeNull();
    expect(screen.queryByText(/SEM etiqueta/)).toBeNull();
  }, 20000);

  it("no canal ML com etiqueta obrigatória e sem etiqueta: não imprime, não embala nem expede", async () => {
    getDocumentos.mockResolvedValue({ danfe: DANFE, etiqueta: null, trackingNumber: null, etiquetaMl: null, etiquetaMlObrigatoria: true });
    await abrirPedido();
    expect(await screen.findByText(/ainda não disponível no Tiny/, {}, { timeout: 3000 })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 300));
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "print_pdf_silent")).toHaveLength(0);
    expect(shipOrder).not.toHaveBeenCalled();
  }, 10000);

  it("no canal ML sem NF: trava em danfe_ausente, não embala nem expede", async () => {
    getDocumentos.mockResolvedValue({ danfe: null, etiqueta: null, trackingNumber: null });
    await abrirPedido();
    expect(await screen.findByText(/não avança sem a DANFE/, {}, { timeout: 3000 })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 300));
    expect(invoke.mock.calls.filter(([cmd]) => cmd === "print_pdf_silent")).toHaveLength(0);
    expect(shipOrder).not.toHaveBeenCalled();
  }, 10000);

  it("mesa no canal J&T recusa pedido ML (canal_errado): não busca documento, não imprime, não expede", async () => {
    localStorage.setItem("berzerk_expedicao_canal_v1", "ecommerce");
    await abrirPedido();
    expect(await screen.findByText(/é Mercado Livre, e a mesa está no canal J&T/, {}, { timeout: 3000 })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 300));
    expect(getDocumentos).not.toHaveBeenCalled();
    expect(shipOrder).not.toHaveBeenCalled();
  }, 10000);

  it("mesa no canal ML recusa pedido do e-commerce (canal_errado)", async () => {
    epcMatch.mockResolvedValue({
      matches: [{ order: pedidoMl("ecommerce"), tagsLidas: [TAG], tagsFaltantes: [], tagsMatched: 1, tagsTotal: 1 }],
      unmatchedEpcs: [],
      jaExpedidos: [],
    });
    await abrirPedido();
    expect(await screen.findByText(/é J&T, e a mesa está no canal Mercado Livre/, {}, { timeout: 3000 })).toBeTruthy();
    expect(getDocumentos).not.toHaveBeenCalled();
  }, 10000);

  it("a aba do canal persiste e o padrão é J&T", async () => {
    localStorage.removeItem("berzerk_expedicao_canal_v1");
    render(<Expedicao onBack={() => {}} />);
    const abaJt = (await screen.findByRole("tab", { name: "J&T" })) as HTMLButtonElement;
    const abaMl = screen.getByRole("tab", { name: "Mercado Livre" }) as HTMLButtonElement;
    expect(abaJt.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(abaMl);
    await waitFor(() => expect(abaMl.getAttribute("aria-selected")).toBe("true"));
    expect(localStorage.getItem("berzerk_expedicao_canal_v1")).toBe("mercado_livre");
  });

  it("409 invalid_status motivo expedicao_manual segue definitivo (não reenfileira)", async () => {
    shipOrder.mockReset().mockRejectedValue(
      new ApiError(409, "x", {
        error: "invalid_status",
        motivo: "expedicao_manual",
        message: "Pedido do Mercado Livre sai pela expedição manual.",
      }),
    );
    await abrirPedido();
    await waitFor(() => expect(shipOrder).toHaveBeenCalledTimes(1), { timeout: 9000 });
    expect(await screen.findByText(/recusada/, {}, { timeout: 3000 })).toBeTruthy();
    expect(localStorage.getItem("berzerk_expedicao_ship_retry_v1") ?? "[]").not.toContain("ord-ml");
    expect(markLabelPrinted).not.toHaveBeenCalled();
  }, 20000);
});

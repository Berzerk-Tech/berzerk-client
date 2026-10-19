// Pedido do Mercado Livre na mesa de expedição (19/10, interino): a etiqueta é
// impressa no Tiny / Mercado Livre, então a mesa NÃO espera rastreio J&T, não
// busca documento, não marca etiqueta e vai direto pra embalar → ship.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExpedicaoOrder } from "../src/services/expedicao";
import { ApiError } from "../src/lib/api";

const TAG = "E28011AAAAAAAAAAAAAA0001";

const epcMatch = vi.fn();
const getDocumentos = vi.fn();
const markLabelPrinted = vi.fn();
const shipOrder = vi.fn();
let presence: ((cur: string[]) => void) | null = null;

vi.mock("../src/services/expedicao", async () => {
  const real = await vi.importActual<typeof import("../src/services/expedicao")>("../src/services/expedicao");
  return {
    ...real,
    epcMatch: (...a: unknown[]) => epcMatch(...a),
    getDocumentos: (...a: unknown[]) => getDocumentos(...a),
    markLabelPrinted: (...a: unknown[]) => markLabelPrinted(...a),
    shipOrder: (...a: unknown[]) => shipOrder(...a),
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
vi.mock("../src/lib/printer", async () => {
  const real = await vi.importActual<typeof import("../src/lib/printer")>("../src/lib/printer");
  return { ...real, printEngineStatus: async () => ({ ok: true, printer: null, message: null, engine: "sumatra" }) };
});
vi.mock("../src/lib/cognito", () => ({ getSessaoSync: () => null, onSessaoChange: () => () => {} }));

const { Expedicao } = await import("../src/components/Expedicao");

function pedidoMl(): ExpedicaoOrder {
  const now = new Date().toISOString();
  return {
    id: "ord-ml",
    tinyOrderId: "900001",
    numero: "900001",
    tinyAccount: "FM",
    status: "awaiting_pickup",
    channel: "tiny",
    canal: "mercado_livre",
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

describe("Expedição — pedido Mercado Livre", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("berzerk_expedicao_modo_v1", "oficial");
    presence = null;
    epcMatch.mockReset().mockResolvedValue({
      matches: [{ order: pedidoMl(), tagsLidas: [TAG], tagsFaltantes: [], tagsMatched: 1, tagsTotal: 1 }],
      unmatchedEpcs: [],
      jaExpedidos: [],
    });
    getDocumentos.mockReset().mockResolvedValue({ danfe: null, etiqueta: null, trackingNumber: null });
    markLabelPrinted.mockReset().mockResolvedValue(undefined);
    shipOrder.mockReset().mockResolvedValue({ gaiola: null });
  });
  afterEach(() => cleanup());

  it("não espera rastreio, não imprime nem marca etiqueta e expede com gaiola null", async () => {
    await abrirPedido();
    expect(await screen.findByText("MERCADO LIVRE", {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText("Etiqueta: imprimir no Tiny / Mercado Livre")).toBeTruthy();
    // Embalagem (5 s) e depois o ship normal.
    await waitFor(() => expect(shipOrder).toHaveBeenCalled(), { timeout: 9000 });
    expect(shipOrder.mock.calls[0][0]).toBe("ord-ml");
    expect(getDocumentos).not.toHaveBeenCalled();
    expect(markLabelPrinted).not.toHaveBeenCalled();
    expect(screen.queryByText(/ainda não tem o rastreio/)).toBeNull();
    expect(screen.queryByText(/SEM etiqueta/)).toBeNull();
  }, 20000);

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

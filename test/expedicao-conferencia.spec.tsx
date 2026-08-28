// Conferência da mesa de expedição — o incidente do pedido #862169 (28/08).
//
// O pedido tinha 10 itens "Oversized - Surpresa - <tam>", foi separado no
// LEGADO (que gravou UMA tag em `rfid_tags` pras 10 peças) e o espelho trouxe
// o pedido pro Nexus com essa única tag. Na mesa, a expedição contava 1 peça e
// o pedido não fechava: o casamento era só por GTIN/SKU, e uma peça real
// (Kagehime M) nunca casa com o item "Surpresa".
//
// A régua agora é a interseção de duas verdades: todas as `rfid_tags` gravadas
// lidas E peças lidas (EPCs distintos) ≥ soma das quantidades da grade.

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EpcLookupItem, OrderItem } from "../src/services/orders";
import type { EpcMatchResponse, ExpedicaoOrder } from "../src/services/expedicao";
import { conferir, isSurpresaSlot } from "../src/lib/conferenciaExpedicao";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TAG_LEGADO = "E28011AAAAAAAAAAAAAA0001";
/** As 10 peças físicas: etiquetas reais (Kagehime, Fury…), nenhuma "Surpresa". */
const PECAS = Array.from({ length: 10 }, (_, i) => ({
  epc: `E28011BBBBBBBBBBBBBB00${String(i + 1).padStart(2, "0")}`,
  ean13: `789000000000${i}`,
}));
/** A tag do legado é a etiqueta da 1ª peça — é assim que o epc-match acha o pedido. */
PECAS[0].epc = TAG_LEGADO;

function item(over: Partial<OrderItem> = {}): OrderItem {
  return {
    id: "it-surpresa",
    ean: null,
    sku: "SURP-M",
    nome: "Oversized - Surpresa - M",
    tamanho: "M",
    quantidade: 10,
    imagemUrl: null,
    ...over,
  };
}

function look(epc: string, ean13: string, sku: string | null = null): EpcLookupItem {
  return { epc, ean13, sku, size: "M", batchCode: null };
}

function resolvidas(epcs: Array<{ epc: string; ean13: string }>): Map<string, EpcLookupItem> {
  return new Map(epcs.map((p) => [p.epc, look(p.epc, p.ean13)]));
}

// ---------------------------------------------------------------------------
// Regra pura
// ---------------------------------------------------------------------------

describe("conferir — pedido separado no legado (rfid_tags incompleta)", () => {
  const items = [item()];

  it("uma peça lida num pedido de 10 conta 1/10 e não fecha", () => {
    const c = conferir({
      items,
      naMesa: [TAG_LEGADO],
      rfidTags: [TAG_LEGADO],
      resolved: resolvidas([PECAS[0]]),
    });
    expect(c.lidas).toBe(1);
    expect(c.total).toBe(10);
    expect(c.completo).toBe(false);
    expect(c.porItem.get("it-surpresa")).toBe(1);
  });

  it("as 10 peças reais cobrem os slots Surpresa e fecham o pedido", () => {
    const c = conferir({
      items,
      naMesa: PECAS.map((p) => p.epc),
      rfidTags: [TAG_LEGADO],
      resolved: resolvidas(PECAS),
    });
    expect(c.lidas).toBe(10);
    expect(c.completo).toBe(true);
    expect(c.fora).toEqual([]);
    expect(c.porItem.get("it-surpresa")).toBe(10);
    // O `ship` continua mandando as tags lidas — agora as 10, não só a do legado.
    expect(c.contadas).toHaveLength(10);
    expect(c.contadas).toContain(TAG_LEGADO);
  });

  it("o mesmo EPC lido duas vezes conta uma peça só", () => {
    const c = conferir({
      items,
      naMesa: [TAG_LEGADO, TAG_LEGADO.toLowerCase(), ` ${TAG_LEGADO} `],
      rfidTags: [TAG_LEGADO],
      resolved: resolvidas([PECAS[0]]),
    });
    expect(c.lidas).toBe(1);
  });

  it("tag da separação que ainda não apareceu na mesa segura o pedido", () => {
    const c = conferir({
      items,
      naMesa: PECAS.slice(1).map((p) => p.epc),
      rfidTags: [TAG_LEGADO],
      resolved: resolvidas(PECAS.slice(1)),
    });
    expect(c.faltantes).toEqual([TAG_LEGADO]);
    expect(c.completo).toBe(false);
  });
});

describe("conferir — peça que não é deste pedido", () => {
  it("EPC desconhecido, fora de rfid_tags, vira aviso e não conta", () => {
    const intruso = "E28011CCCCCCCCCCCCCC9999";
    const c = conferir({
      items: [item()],
      naMesa: [...PECAS.map((p) => p.epc), intruso],
      rfidTags: [TAG_LEGADO],
      resolved: resolvidas(PECAS),
    });
    expect(c.fora).toEqual([intruso]);
    expect(c.lidas).toBe(10);
    expect(c.porItem.get("it-surpresa")).toBe(10);
  });

  it("peça reivindicada por OUTRO pedido da mesa não preenche o slot Surpresa", () => {
    const doVizinho = "E28011DDDDDDDDDDDDDD0007";
    const c = conferir({
      items: [item({ quantidade: 2 })],
      naMesa: [TAG_LEGADO, doVizinho],
      rfidTags: [TAG_LEGADO],
      resolved: resolvidas([PECAS[0], { epc: doVizinho, ean13: "7891111111111" }]),
      alheias: new Set([doVizinho]),
    });
    expect(c.fora).toEqual([doVizinho]);
    expect(c.lidas).toBe(1);
    expect(c.completo).toBe(false);
  });
});

describe("conferir — pedido normal (casamento por GTIN)", () => {
  const camisa = item({ id: "it-1", ean: "7890000000001", sku: "CAM-M", nome: "Oversized - Fury - M", quantidade: 2 });
  const calca = item({ id: "it-2", ean: "7890000000002", sku: "CAL-M", nome: "Calça - M", quantidade: 1 });

  it("cada tag cai no seu item, respeitando a quantidade", () => {
    const naMesa = ["EPC-A", "EPC-B", "EPC-C"];
    const c = conferir({
      items: [camisa, calca],
      naMesa,
      rfidTags: naMesa,
      resolved: new Map([
        ["EPC-A", look("EPC-A", "7890000000001")],
        ["EPC-B", look("EPC-B", "7890000000001")],
        ["EPC-C", look("EPC-C", "7890000000002")],
      ]),
    });
    expect(c.porItem.get("it-1")).toBe(2);
    expect(c.porItem.get("it-2")).toBe(1);
    expect(c.completo).toBe(true);
  });

  it("sem lookup do inventário, as tags da separação ainda contam", () => {
    const naMesa = ["EPC-A", "EPC-B", "EPC-C"];
    const c = conferir({
      items: [camisa, calca],
      naMesa,
      rfidTags: naMesa,
      resolved: new Map(),
    });
    expect(c.lidas).toBe(3);
    expect(c.completo).toBe(true);
  });

  it("pedido sem rfid_tags (legado antigo) fecha pela grade", () => {
    const c = conferir({
      items: [calca],
      naMesa: ["EPC-C"],
      rfidTags: null,
      resolved: new Map([["EPC-C", look("EPC-C", "7890000000002")]]),
    });
    expect(c.faltantes).toEqual([]);
    expect(c.completo).toBe(true);
  });
});

describe("isSurpresaSlot", () => {
  it("reconhece pelo nome do item do Tiny e pelos permitidos do nexus", () => {
    expect(isSurpresaSlot(item())).toBe(true);
    expect(isSurpresaSlot(item({ nome: "Oversized - Fury - M", sku: "FURY-M" }))).toBe(false);
    expect(
      isSurpresaSlot(item({ nome: "Slot X", sku: "X", surpresaPermitidos: ["CAM-M"] })),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Render da mesa
// ---------------------------------------------------------------------------

const epcMatch = vi.fn();
let presence: ((cur: string[]) => void) | null = null;

vi.mock("../src/services/expedicao", async () => {
  const real =
    await vi.importActual<typeof import("../src/services/expedicao")>("../src/services/expedicao");
  return {
    ...real,
    epcMatch: (...a: unknown[]) => epcMatch(...a),
    getDocumentos: vi.fn(async () => ({ danfe: null, etiqueta: null, trackingNumber: "JT1" })),
    markLabelPrinted: vi.fn(async () => {}),
    shipOrder: vi.fn(async () => null),
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
    resolveEpcs: async (epcs: string[]) => {
      const conhecidas = resolvidas(PECAS);
      return new Map(
        epcs
          .map((e) => e.toUpperCase())
          .filter((e) => conhecidas.has(e))
          .map((e) => [e, conhecidas.get(e)!]),
      );
    },
  }),
}));

vi.mock("../src/lib/beep", () => ({ beepOk: () => {}, beepError: () => {} }));
vi.mock("../src/lib/printer", async () => {
  const real = await vi.importActual<typeof import("../src/lib/printer")>("../src/lib/printer");
  return { ...real, printEngineStatus: async () => ({ ok: true, printer: null, message: null, engine: "sumatra" }) };
});
vi.mock("../src/lib/cognito", () => ({
  getSessaoSync: () => null,
  onSessaoChange: () => () => {},
}));

const { Expedicao } = await import("../src/components/Expedicao");

function pedidoSurpresa(): ExpedicaoOrder {
  const now = new Date().toISOString();
  return {
    id: "ord-862169",
    tinyOrderId: "862169",
    numero: "862169",
    tinyAccount: "JT",
    status: "awaiting_pickup",
    channel: "tiny",
    clienteNome: "Cliente Surpresa",
    dataEmissao: now,
    prioritario: false,
    trackingNumber: "JT0009999999",
    rfidTags: [TAG_LEGADO],
    separatedBy: "Stefanie",
    separatedAt: now,
    shippedBy: null,
    shippedAt: null,
    shippedWithoutLabel: false,
    labelPrintedAt: now,
    hasDanfeCached: true,
    items: [item()],
    createdAt: now,
    updatedAt: now,
  };
}

/** O que o `/expedicao/epc-match` devolve: só a tag do legado casa em `rfid_tags`. */
function respostaMatch(epcs: string[]): EpcMatchResponse {
  const order = pedidoSurpresa();
  const tags = (order.rfidTags ?? []).map((t) => t.toUpperCase());
  const lidas = epcs.filter((e) => tags.includes(e));
  if (lidas.length === 0) return { matches: [], unmatchedEpcs: epcs, jaExpedidos: [] };
  return {
    matches: [
      {
        order,
        tagsLidas: lidas,
        tagsFaltantes: tags.filter((t) => !lidas.includes(t)),
        tagsMatched: lidas.length,
        tagsTotal: tags.length,
      },
    ],
    unmatchedEpcs: epcs.filter((e) => !tags.includes(e)),
    jaExpedidos: [],
  };
}

async function porNaMesa(epcs: string[]) {
  await act(async () => {
    presence?.(epcs);
  });
}

describe("Mesa de expedição — pedido #862169 (10 Surpresa, 1 tag)", () => {
  beforeEach(() => {
    presence = null;
    epcMatch.mockReset().mockImplementation(async (epcs: string[]) => respostaMatch(epcs));
  });
  afterEach(() => cleanup());

  it("com só a tag do legado na mesa mostra 1/10 e não libera o pedido", async () => {
    render(<Expedicao onBack={() => {}} />);
    await waitFor(() => expect(presence).toBeTruthy());
    await porNaMesa([TAG_LEGADO]);

    expect(await screen.findByText("1/10 peças", {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByText(/FALTAM PEÇAS/)).toBeTruthy();
  });

  it("com as 10 peças reais na mesa fecha 10/10", async () => {
    render(<Expedicao onBack={() => {}} />);
    await waitFor(() => expect(presence).toBeTruthy());
    await porNaMesa(PECAS.map((p) => p.epc));

    expect(await screen.findByText("10/10 peças", {}, { timeout: 3000 })).toBeTruthy();
  });

  it("peça que não é do pedido avisa e não entra na conta", async () => {
    render(<Expedicao onBack={() => {}} />);
    await waitFor(() => expect(presence).toBeTruthy());
    await porNaMesa([TAG_LEGADO, "E28011CCCCCCCCCCCCCC9999"]);

    expect(await screen.findByText("1/10 peças", {}, { timeout: 3000 })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText(/não são deste pedido/)).toBeTruthy(),
    );
  });
});

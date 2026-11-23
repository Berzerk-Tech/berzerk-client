// Tela de candidatos na Expedição (23/11): peça lida fora de qualquer pedido.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/lib/api";

const TAG = "E28011AAAAAAAAAAAAAA0001";
const OUTRA = "E28011AAAAAAAAAAAAAA0002";

const epcMatch = vi.fn();
const trocarTagDoPedido = vi.fn();
let presence: ((cur: string[]) => void) | null = null;

vi.mock("../src/services/expedicao", async () => {
  const real = await vi.importActual<typeof import("../src/services/expedicao")>("../src/services/expedicao");
  return {
    ...real,
    epcMatch: (...a: unknown[]) => epcMatch(...a),
    trocarTagDoPedido: (...a: unknown[]) => trocarTagDoPedido(...a),
  };
});
vi.mock("../src/services/orders", async () => {
  const real = await vi.importActual<typeof import("../src/services/orders")>("../src/services/orders");
  return { ...real, getSupervisores: vi.fn(async () => ({ supervisores: [{ id: "sup-1", nome: "Sup", temPin: true }] })) };
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
vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => undefined }));
vi.mock("../src/lib/cognito", () => ({ getSessaoSync: () => null, onSessaoChange: () => () => {} }));

const { Expedicao } = await import("../src/components/Expedicao");

const pedido = (id: string, numero: string, createdAt: string) => ({
  id,
  numero,
  tinyAccount: "FM",
  status: "awaiting_pickup",
  channel: "shopify",
  canal: "ecommerce",
  clienteNome: `Cliente ${numero}`,
  dataEmissao: createdAt,
  prioritario: false,
  trackingNumber: "JT1",
  rfidTags: ["ATUAL1"],
  separatedBy: "u1",
  separatedByNome: "Duda",
  separatedAt: createdAt,
  items: [{ id: "i1", ean: null, sku: null, nome: "Oversized Rux M", tamanho: "M", quantidade: 1, imagemUrl: null }],
  createdAt,
  updatedAt: createdAt,
});
const CAND = (exigePin = false, mais = 0) => ({
  matches: [],
  unmatchedEpcs: [TAG],
  jaExpedidos: [],
  trocaTagExigePin: exigePin,
  candidatos: [
    {
      epc: TAG,
      nome: "Oversized Rux",
      tamanho: "M",
      ean: null,
      sku: null,
      maisPedidos: mais,
      pedidos: [
        { order: pedido("o2", "222", "2026-11-02T10:00:00Z"), epcAtual: "ATUAL2" },
        { order: pedido("o1", "111", "2026-11-01T10:00:00Z"), epcAtual: "ATUAL1" },
      ],
    },
  ],
});
const esperar = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));
async function mesa(cur: string[]) {
  await act(async () => {
    presence?.(cur);
  });
}
async function abrir() {
  render(<Expedicao onBack={() => {}} />);
  await waitFor(() => expect(presence).toBeTruthy());
  await mesa([TAG]);
  expect(await screen.findByText("Esta peça não está em nenhum pedido", {}, { timeout: 3000 })).toBeTruthy();
}

describe("Expedição — candidatos de troca de tag", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("berzerk_expedicao_modo_v1", "oficial");
    localStorage.setItem("berzerk_expedicao_canal_v1", "ecommerce");
    presence = null;
    epcMatch.mockReset().mockResolvedValue(CAND());
    trocarTagDoPedido.mockReset();
  });
  afterEach(() => cleanup());

  it("mostra a lista com o mais antigo como Sugerido e 'e mais N'", async () => {
    epcMatch.mockResolvedValue(CAND(false, 3));
    await abrir();
    expect(screen.getByText("Oversized Rux · M")).toBeTruthy();
    expect(screen.getByText("Sugerido")).toBeTruthy();
    // ordem do servidor (mais recente primeiro), sem reordenar: o primeiro é o Sugerido
    const numeros = screen.getAllByText(/^#\d+$/).map((e) => e.textContent);
    expect(numeros).toEqual(["#222", "#111"]);
    expect(screen.getByText("e mais 3 pedidos")).toBeTruthy();
    expect(screen.getAllByText("Usar esta peça neste pedido")).toHaveLength(2);
  });

  it("sem retry automático e tag nova na mesa não troca a lista", async () => {
    await abrir();
    await esperar(1500);
    await mesa([TAG, OUTRA]);
    await esperar(300);
    expect(screen.getByText("Esta peça não está em nenhum pedido")).toBeTruthy();
    expect(epcMatch).toHaveBeenCalledTimes(1);
  }, 10000);

  it("Cancelar volta ao PRONTO, reavalia a mesa e não reabre com a mesma tag", async () => {
    await abrir();
    fireEvent.click(screen.getByText("Cancelar"));
    await waitFor(() => expect(screen.queryByText("Esta peça não está em nenhum pedido")).toBeNull());
    await waitFor(() => expect(epcMatch).toHaveBeenCalledTimes(2)); // reavaliou a mesa atual
    await esperar(300);
    expect(screen.queryByText("Esta peça não está em nenhum pedido")).toBeNull();
  }, 10000);

  it("o ignorar é só enquanto a tag está na mesa: ao sair e voltar a tela reabre", async () => {
    await abrir();
    fireEvent.click(screen.getByText("Cancelar"));
    await waitFor(() => expect(epcMatch).toHaveBeenCalledTimes(2));
    await esperar(3700);
    await mesa([]); // poda por TTL: a tag saiu da mesa
    await esperar(300);
    await mesa([TAG]);
    expect(await screen.findByText("Esta peça não está em nenhum pedido", {}, { timeout: 3000 })).toBeTruthy();
  }, 15000);

  it("peça candidata que sai da mesa (sem troca em curso) fecha a tela e reavalia", async () => {
    await abrir();
    await mesa([]);
    await esperar(3700);
    epcMatch.mockResolvedValue({ matches: [], unmatchedEpcs: [OUTRA], jaExpedidos: [], trocaTagExigePin: false });
    await mesa([OUTRA]);
    await waitFor(() => expect(epcMatch).toHaveBeenCalledTimes(2));
    expect(epcMatch.mock.calls[1][0]).toEqual([OUTRA]);
    await waitFor(() => expect(screen.queryByText("Esta peça não está em nenhum pedido")).toBeNull());
  }, 15000);

  it("pedidos de outro canal não abrem a tela nem disparam a troca", async () => {
    const c = CAND();
    for (const p of c.candidatos[0].pedidos) (p.order as { canal?: string }).canal = "mercado_livre";
    epcMatch.mockResolvedValue(c);
    render(<Expedicao onBack={() => {}} />);
    await waitFor(() => expect(presence).toBeTruthy());
    await mesa([TAG]);
    await waitFor(() => expect(epcMatch).toHaveBeenCalled());
    await esperar(300);
    expect(screen.queryByText("Esta peça não está em nenhum pedido")).toBeNull();
    expect(trocarTagDoPedido).not.toHaveBeenCalled();
  }, 10000);

  it("duas peças candidatas ao mesmo pedido: segue pra 2 de 2 restrita a ele e só então identifica", async () => {
    const base = CAND();
    const ped = pedido("o1", "111", "2026-11-01T10:00:00Z");
    const cand2 = { ...base.candidatos[0], epc: OUTRA, pedidos: [{ order: ped, epcAtual: "ATUAL3" }, { order: pedido("o9", "999", "2026-11-09T10:00:00Z"), epcAtual: "X" }] };
    epcMatch.mockResolvedValue({ ...base, unmatchedEpcs: [TAG, OUTRA], candidatos: [base.candidatos[0], cand2] });
    trocarTagDoPedido
      .mockResolvedValueOnce({ match: { order: { ...ped, rfidTags: [TAG, "ATUAL3"] }, tagsLidas: [TAG], tagsFaltantes: [], tagsMatched: 1, tagsTotal: 2 } })
      .mockResolvedValueOnce({ match: { order: { ...ped, rfidTags: [TAG, OUTRA] }, tagsLidas: [TAG, OUTRA], tagsFaltantes: [], tagsMatched: 2, tagsTotal: 2 } });
    render(<Expedicao onBack={() => {}} />);
    await waitFor(() => expect(presence).toBeTruthy());
    await mesa([TAG, OUTRA]);
    expect(await screen.findByText(/\(1 de 2\)/, {}, { timeout: 3000 })).toBeTruthy();
    fireEvent.click(screen.getAllByText("Usar esta peça neste pedido")[1]); // #111
    expect(await screen.findByText(/\(2 de 2\)/)).toBeTruthy();
    expect(screen.getAllByText("Usar esta peça neste pedido")).toHaveLength(1); // restrita ao #111
    fireEvent.click(screen.getByText("Usar esta peça neste pedido"));
    await waitFor(() => expect(trocarTagDoPedido).toHaveBeenCalledTimes(2));
    expect(trocarTagDoPedido.mock.calls[1]).toEqual(["o1", { epcLido: OUTRA, epcAtual: "ATUAL3" }]);
    await waitFor(() => expect(screen.queryByText("Esta peça não está em nenhum pedido")).toBeNull());
  }, 10000);

  it("mesa vazia quando a troca volta: vai pra PRONTO, não identifica", async () => {
    let resolver: (v: unknown) => void = () => {};
    trocarTagDoPedido.mockImplementation(() => new Promise((r) => (resolver = r)));
    await abrir();
    fireEvent.click(screen.getAllByText("Usar esta peça neste pedido")[0]);
    await waitFor(() => expect(trocarTagDoPedido).toHaveBeenCalled());
    await esperar(3700);
    await mesa([]);
    await esperar(300);
    expect(screen.getByText("Esta peça não está em nenhum pedido")).toBeTruthy(); // troca em curso segura a tela
    const ped = pedido("o1", "111", "2026-11-01T10:00:00Z");
    await act(async () => resolver({ match: { order: ped, tagsLidas: [TAG], tagsFaltantes: [], tagsMatched: 1, tagsTotal: 1 } }));
    await waitFor(() => expect(screen.queryByText("Esta peça não está em nenhum pedido")).toBeNull());
    expect(screen.getByText("PRONTO")).toBeTruthy();
  }, 15000);

  it("Nova leitura fecha o modal de PIN da troca", async () => {
    epcMatch.mockResolvedValue(CAND(true));
    await abrir();
    fireEvent.click(screen.getAllByText("Usar esta peça neste pedido")[0]);
    expect(await screen.findByText(/Usar peça no pedido/)).toBeTruthy();
    fireEvent.click(screen.getByTitle("Nova leitura (R)"));
    await waitFor(() => expect(screen.queryByText(/Usar peça no pedido/)).toBeNull());
  }, 10000);

  it("sucesso segue o fluxo de um match único", async () => {
    const ped = pedido("o1", "111", "2026-11-01T10:00:00Z");
    trocarTagDoPedido.mockResolvedValue({ match: { order: ped, tagsLidas: [TAG], tagsFaltantes: [], tagsMatched: 1, tagsTotal: 1 } });
    await abrir();
    fireEvent.click(screen.getAllByText("Usar esta peça neste pedido")[1]); // #111
    await waitFor(() => expect(trocarTagDoPedido).toHaveBeenCalledWith("o1", { epcLido: TAG, epcAtual: "ATUAL1" }));
    await waitFor(() => expect(screen.queryByText("Esta peça não está em nenhum pedido")).toBeNull());
    expect(await screen.findByText(/Oversized Rux M/)).toBeTruthy();
  }, 10000);

  it("409 mostra o motivo e refaz o epc-match", async () => {
    trocarTagDoPedido.mockRejectedValue(new ApiError(409, "x", { error: "troca_tag_recusada", motivo: "tag_ja_vinculada" }));
    await abrir();
    fireEvent.click(screen.getAllByText("Usar esta peça neste pedido")[0]);
    expect(await screen.findByText(/Essa peça já está em outro pedido\./)).toBeTruthy();
    await waitFor(() => expect(epcMatch).toHaveBeenCalledTimes(2));
  }, 10000);

  it("trocaTagExigePin abre o PIN antes de chamar a troca", async () => {
    epcMatch.mockResolvedValue(CAND(true));
    await abrir();
    fireEvent.click(screen.getAllByText("Usar esta peça neste pedido")[0]);
    expect(await screen.findByText(/Usar peça no pedido/)).toBeTruthy();
    expect(trocarTagDoPedido).not.toHaveBeenCalled();
  }, 10000);

  it("422 troca_tag_exige_pin abre o diálogo de PIN", async () => {
    trocarTagDoPedido.mockRejectedValue(new ApiError(422, "x", { error: "troca_tag_exige_pin" }));
    await abrir();
    fireEvent.click(screen.getAllByText("Usar esta peça neste pedido")[0]);
    expect(await screen.findByText(/Usar peça no pedido/)).toBeTruthy();
  }, 10000);

  it("sem candidatos (Nexus antigo) segue o aviso e o retry de sempre", async () => {
    epcMatch.mockResolvedValue({ matches: [], unmatchedEpcs: [TAG], jaExpedidos: [] });
    render(<Expedicao onBack={() => {}} />);
    await waitFor(() => expect(presence).toBeTruthy());
    await mesa([TAG]);
    await waitFor(() => expect(epcMatch.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 4000 });
    expect(screen.queryByText("Esta peça não está em nenhum pedido")).toBeNull();
  }, 10000);

  describe("pedido identificado com peça faltando", () => {
    const FALTA = () => {
      const ped = pedido("o1", "111", "2026-11-01T10:00:00Z");
      return {
        matches: [{ order: { ...ped, rfidTags: [OUTRA, "FALTANTE1"] }, tagsLidas: [OUTRA], tagsFaltantes: ["FALTANTE1"], tagsMatched: 1, tagsTotal: 2 }],
        unmatchedEpcs: [TAG],
        jaExpedidos: [],
        trocaTagExigePin: false,
        candidatos: [{ epc: TAG, nome: "Oversized Rux", tamanho: "M", ean: null, sku: null, maisPedidos: 0, pedidos: [{ order: ped, epcAtual: "FALTANTE1" }] }],
      };
    };
    async function abrirFalta() {
      epcMatch.mockResolvedValue(FALTA());
      render(<Expedicao onBack={() => {}} />);
      await waitFor(() => expect(presence).toBeTruthy());
      await mesa([OUTRA, TAG]);
      expect(await screen.findByText(/mas é do mesmo produto e tamanho da que falta/i, {}, { timeout: 3000 })).toBeTruthy();
    }

    it("oferece a troca restrita ao pedido; Cancelar volta ao estado normal sem reabrir", async () => {
      await abrirFalta();
      expect(screen.getAllByText("Usar esta peça neste pedido")).toHaveLength(1);
      fireEvent.click(screen.getByText("Cancelar"));
      await waitFor(() => expect(screen.queryByText(/mas é do mesmo produto e tamanho da que falta/i)).toBeNull());
      expect(trocarTagDoPedido).not.toHaveBeenCalled();
      await esperar(300);
      expect(screen.queryByText(/mas é do mesmo produto e tamanho da que falta/i)).toBeNull();
    }, 10000);

    it("depois da troca re-resolve a mesa", async () => {
      trocarTagDoPedido.mockResolvedValue({ match: { order: pedido("o1", "111", "2026-11-01T10:00:00Z"), tagsLidas: [OUTRA, TAG], tagsFaltantes: [], tagsMatched: 2, tagsTotal: 2 } });
      await abrirFalta();
      epcMatch.mockResolvedValue({ matches: [{ order: pedido("o1", "111", "2026-11-01T10:00:00Z"), tagsLidas: [OUTRA, TAG], tagsFaltantes: [], tagsMatched: 2, tagsTotal: 2 }], unmatchedEpcs: [], jaExpedidos: [], trocaTagExigePin: false });
      const antes = epcMatch.mock.calls.length;
      fireEvent.click(screen.getByText("Usar esta peça neste pedido"));
      await waitFor(() => expect(trocarTagDoPedido).toHaveBeenCalledWith("o1", { epcLido: TAG, epcAtual: "FALTANTE1" }));
      await waitFor(() => expect(epcMatch.mock.calls.length).toBeGreaterThan(antes));
      await waitFor(() => expect(screen.queryByText(/mas é do mesmo produto e tamanho da que falta/i)).toBeNull());
    }, 10000);
  });
});

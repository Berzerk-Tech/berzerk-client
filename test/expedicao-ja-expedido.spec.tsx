// Tela "já foi expedido → Reimprimir" na mesa (06/11): ela sumia em até 4 s —
// no retry automático ou quando o pacote saía do campo do leitor a mesa
// voltava pra PRONTO antes da operadora alcançar o botão. Agora a tela segura
// até Reimprimir, "Nova leitura" ou uma tag DIFERENTE aparecer na mesa.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TAG = "E28011AAAAAAAAAAAAAA0001";
const OUTRA = "E28011AAAAAAAAAAAAAA0002";

const epcMatch = vi.fn();
const imprimirDocumentoDoPedido = vi.fn();
let presence: ((cur: string[]) => void) | null = null;

vi.mock("../src/services/expedicao", async () => {
  const real = await vi.importActual<typeof import("../src/services/expedicao")>("../src/services/expedicao");
  return { ...real, epcMatch: (...a: unknown[]) => epcMatch(...a) };
});
vi.mock("../src/lib/reimpressao", async () => {
  const real = await vi.importActual<typeof import("../src/lib/reimpressao")>("../src/lib/reimpressao");
  return { ...real, imprimirDocumentoDoPedido: (...a: unknown[]) => imprimirDocumentoDoPedido(...a) };
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

const JA = {
  epc: TAG,
  orderId: "ord-velho",
  numero: "555001",
  tinyAccount: "FM" as const,
  canal: "ecommerce" as const,
  shippedAt: new Date().toISOString(),
  shippedBy: "Duda",
  shippedByEmail: null,
};
const SEM_PEDIDO = (epcs: string[]) => ({ matches: [], unmatchedEpcs: epcs, jaExpedidos: [] });

async function mesa(cur: string[]) {
  await act(async () => {
    presence?.(cur);
  });
}
const esperar = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

async function abrirJaExpedido() {
  render(<Expedicao onBack={() => {}} />);
  await waitFor(() => expect(presence).toBeTruthy());
  await mesa([TAG]);
  expect(await screen.findByText("↻ Reimprimir etiqueta", {}, { timeout: 3000 })).toBeTruthy();
  expect(epcMatch).toHaveBeenCalledTimes(1);
}

describe("Expedição — tela 'já foi expedido' segura até a operadora agir", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("berzerk_expedicao_modo_v1", "oficial");
    localStorage.setItem("berzerk_expedicao_canal_v1", "ecommerce");
    presence = null;
    epcMatch.mockReset().mockImplementation(async (epcs: string[]) =>
      epcs.includes(TAG) ? { matches: [], unmatchedEpcs: epcs.filter((e) => e !== TAG), jaExpedidos: [JA] } : SEM_PEDIDO(epcs),
    );
    imprimirDocumentoDoPedido.mockReset().mockResolvedValue({ ok: true, mensagem: "Etiqueta de #555001 reimpressa (2a via)." });
  });
  afterEach(() => cleanup());

  it("pacote sai do campo do leitor: a tela fica e não há retry automático", async () => {
    await abrirJaExpedido();
    await mesa([]);
    await esperar(1500); // > RESOLVE_RETRY_CURTO_MS: um retry agendado já teria disparado
    expect(screen.getByText("↻ Reimprimir etiqueta")).toBeTruthy();
    expect(epcMatch).toHaveBeenCalledTimes(1);
    // A mesma tag oscilando de volta não re-pergunta ao servidor nem pisca.
    await mesa([TAG]);
    await esperar(300);
    expect(screen.getByText("↻ Reimprimir etiqueta")).toBeTruthy();
    expect(epcMatch).toHaveBeenCalledTimes(1);
  }, 10000);

  it("Reimprimir imprime a 2ª via e a mesa volta pra PRONTO sem re-identificar o pacote", async () => {
    await abrirJaExpedido();
    fireEvent.click(screen.getByText("↻ Reimprimir etiqueta"));
    await waitFor(() => expect(imprimirDocumentoDoPedido).toHaveBeenCalledTimes(1));
    expect(imprimirDocumentoDoPedido.mock.calls[0][0]).toMatchObject({ id: "ord-velho", numero: "555001" });
    expect(imprimirDocumentoDoPedido.mock.calls[0][1]).toBe("ja_expedido");
    await waitFor(() => expect(screen.queryByText("↻ Reimprimir etiqueta")).toBeNull());
    await mesa([TAG]);
    await esperar(300);
    expect(screen.queryByText("↻ Reimprimir etiqueta")).toBeNull();
    expect(epcMatch).toHaveBeenCalledTimes(1);
  }, 10000);

  it("tag diferente na mesa substitui a tela pelo fluxo normal", async () => {
    await abrirJaExpedido();
    // Pacote velho sai (TTL de presença ~3,4 s) e entra um pacote novo.
    await mesa([]);
    await esperar(3600);
    expect(screen.getByText("↻ Reimprimir etiqueta")).toBeTruthy();
    await mesa([OUTRA]);
    await waitFor(() => expect(epcMatch).toHaveBeenCalledTimes(2));
    expect(epcMatch.mock.calls[1][0]).toEqual([OUTRA]);
    await waitFor(() => expect(screen.queryByText("↻ Reimprimir etiqueta")).toBeNull());
  }, 10000);

  it("'Nova leitura' fecha a tela", async () => {
    await abrirJaExpedido();
    fireEvent.click(screen.getAllByText("Nova leitura")[0]);
    await waitFor(() => expect(screen.queryByText("↻ Reimprimir etiqueta")).toBeNull());
  }, 10000);
});

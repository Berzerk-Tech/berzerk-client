// Tela de Devolução: abrir/retomar lote, leitura acumulativa, bloqueio por
// `epc_em_outro_lote`, fechamento e remoção.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Lote, LoteDetalhe, LoteItem, LoteResumo } from "../src/services/devolucoes";

const abrirLote = vi.fn();
const getLote = vi.fn();
const adicionarEpcs = vi.fn();
const removerEpc = vi.fn();
const fecharLote = vi.fn();
const reintegrarLote = vi.fn();
const listarLotes = vi.fn();
const getMe = vi.fn();
const invoke = vi.fn();

let presencaCb: ((epcs: string[]) => void) | null = null;
const stopPresenca = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

vi.mock("../src/services/devolucoes", async () => {
  const real = await vi.importActual<typeof import("../src/services/devolucoes")>("../src/services/devolucoes");
  return {
    ...real,
    abrirLote: (...a: unknown[]) => abrirLote(...a),
    getLote: (...a: unknown[]) => getLote(...a),
    adicionarEpcs: (...a: unknown[]) => adicionarEpcs(...a),
    removerEpc: (...a: unknown[]) => removerEpc(...a),
    fecharLote: (...a: unknown[]) => fecharLote(...a),
    reintegrarLote: (...a: unknown[]) => reintegrarLote(...a),
    listarLotes: (...a: unknown[]) => listarLotes(...a),
  };
});

// `reintegrarAteZerar` chama o `reintegrarLote` do próprio módulo (o mock acima
// não o alcança): intercepta na camada HTTP.
vi.mock("../src/lib/api", async () => {
  const real = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...real,
    apiRequest: async (path: string) => {
      if (path.endsWith("/reintegrar")) return reintegrarLote(path.split("/").at(-2));
      throw new Error(`apiRequest inesperado: ${path}`);
    },
  };
});

vi.mock("../src/services/orders", async () => {
  const real = await vi.importActual<typeof import("../src/services/orders")>("../src/services/orders");
  return { ...real, getMe: (...a: unknown[]) => getMe(...a) };
});

const rfidValue = {
  connected: true,
  host: "127.0.0.1",
  reconnect: vi.fn(),
  startPresenceSession: (cb: (epcs: string[]) => void) => {
    presencaCb = cb;
    return stopPresenca;
  },
};
vi.mock("../src/contexts/RfidContext", () => ({ useRfid: () => rfidValue }));

const { Devolucao } = await import("../src/components/Devolucao");
const { ApiError } = await import("../src/lib/api");

function resumo(over: Partial<LoteResumo> = {}): LoteResumo {
  return { total: 0, devolviveis: 0, naoEncontrados: 0, naoExpedidos: 0, jaDevolvidas: 0, ...over };
}
function lote(over: Partial<Lote> = {}): Lote {
  return {
    id: "lote-1",
    status: "aberto",
    abertoEm: "2026-10-07T13:05:00.000Z",
    abertoPorId: "u1",
    abertoPorNome: "ana@berzerk.com.br",
    fechadoEm: null,
    fechadoPorId: null,
    fechadoPorNome: null,
    motivo: null,
    destino: null,
    qtdItens: 0,
    qtdDevolvidas: 0,
    reintegracao: null,
    reintegradoEm: null,
    ...over,
  };
}
function item(epc: string, over: Partial<LoteItem> = {}): LoteItem {
  return {
    id: epc,
    epc,
    situacao: "devolvida",
    orderId: "o1",
    orderNumber: "854736",
    sku: "CAM-PRETA",
    tamanho: "M",
    ean13: null,
    varianteId: "v1",
    lidoEm: "2026-10-07T13:10:00.000Z",
    aplicadaEm: null,
    ...over,
  };
}
function detalhe(itens: LoteItem[], l: Lote = lote()): LoteDetalhe {
  return { lote: { ...l, qtdItens: itens.length }, resumo: resumo({ total: itens.length, devolviveis: itens.length }), itens, porVariante: [] };
}

/** EPC válido (24 hex) com sufixo legível. */
const E = (n: number) => `E280AAAAAAAAAAAAAAAA${n.toString(16).toUpperCase().padStart(4, "0")}`;

const flushTimers = () => act(async () => { await vi.advanceTimersByTimeAsync(300); });

describe("Devolução", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    presencaCb = null;
    stopPresenca.mockReset();
    for (const m of [abrirLote, getLote, adicionarEpcs, removerEpc, fecharLote, reintegrarLote, listarLotes, getMe]) m.mockReset();
    getMe.mockResolvedValue({ actorId: "u1", email: "ana@berzerk.com.br", permissions: ["expedicao:operate"] });
    abrirLote.mockResolvedValue({ lote: lote(), retomado: false });
    getLote.mockResolvedValue(detalhe([]));
    adicionarEpcs.mockImplementation(async (_id: string, epcs: string[]) => ({
      adicionados: epcs.map((e) => item(e)),
      repetidos: [],
      invalidos: [],
      resumo: resumo({ total: epcs.length, devolviveis: epcs.length }),
    }));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  async function abrirTela() {
    render(<Devolucao onBack={() => {}} />);
    await waitFor(() => expect(presencaCb).not.toBeNull());
  }

  it("abre o lote ao entrar e começa a ler", async () => {
    await abrirTela();
    expect(abrirLote).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Fechar lote")).toBeTruthy();
    expect((screen.getByText("Fechar lote") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/Retomando lote/)).toBeNull();
  });

  it("lote retomado mostra o banner e carrega os itens", async () => {
    abrirLote.mockResolvedValue({ lote: lote(), retomado: true });
    getLote.mockResolvedValue(detalhe([item("E280AAAAAA0001"), item("E280AAAAAA0002")]));
    await abrirTela();

    await screen.findByText(/Retomando lote aberto às \d{2}:\d{2} com 2 peças/);
    expect(getLote).toHaveBeenCalledWith("lote-1");
    expect(screen.getAllByText("…AA0001").length).toBe(1);
  });

  it("EPCs da presença viram adicionarEpcs, sem repetir EPC", async () => {
    await abrirTela();

    act(() => presencaCb!([E(1).toLowerCase(), E(2)]));
    // reemissão da presença com um EPC novo: só o novo vai
    act(() => presencaCb!([E(1), E(2), E(3)]));
    await flushTimers();

    await waitFor(() => expect(adicionarEpcs).toHaveBeenCalledTimes(1));
    expect(adicionarEpcs).toHaveBeenLastCalledWith("lote-1", [E(1), E(2), E(3)]);

    // peça tirada da mesa não some da lista e não é reenviada
    act(() => presencaCb!([E(3)]));
    await flushTimers();
    expect(adicionarEpcs).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("Devolver").length).toBe(3);
  });

  it("epc_em_outro_lote bloqueia o EPC, avisa e reenvia o resto", async () => {
    adicionarEpcs
      .mockRejectedValueOnce(new ApiError(409, "x", { error: "epc_em_outro_lote", epcs: [{ epc: E(0xbad), loteId: "outro" }] }))
      .mockImplementation(async (_id: string, epcs: string[]) => ({
        adicionados: epcs.map((e) => item(e)),
        repetidos: [],
        invalidos: [],
        resumo: resumo({ total: epcs.length, devolviveis: epcs.length }),
      }));
    await abrirTela();

    act(() => presencaCb!([E(0xbad), E(0x0c1)]));
    await flushTimers();

    await screen.findByText(/1 peça já está em outro lote aberto/);
    expect(adicionarEpcs).toHaveBeenCalledTimes(2);
    expect(adicionarEpcs).toHaveBeenLastCalledWith("lote-1", [E(0x0c1)]);

    // não reenvia o bloqueado
    act(() => presencaCb!([E(0xbad), E(0x0c1)]));
    await flushTimers();
    expect(adicionarEpcs).toHaveBeenCalledTimes(2);
  });

  it("falha de rede devolve à fila e tenta de novo em 4 s", async () => {
    adicionarEpcs.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await abrirTela();

    act(() => presencaCb!([E(0x4e1)]));
    await flushTimers();
    await waitFor(() => expect(adicionarEpcs).toHaveBeenCalledTimes(1));

    await act(async () => { await vi.advanceTimersByTimeAsync(4100); });
    await waitFor(() => expect(adicionarEpcs).toHaveBeenCalledTimes(2));
    expect(adicionarEpcs).toHaveBeenLastCalledWith("lote-1", [E(0x4e1)]);
  });

  it("fechar lote mostra o resultado com reintegração desligada", async () => {
    fecharLote.mockResolvedValue({
      lote: lote({ status: "fechado", destino: "estoque", qtdItens: 1, qtdDevolvidas: 1 }),
      resumo: resumo({ total: 1, devolviveis: 1 }),
      reintegracao: { status: "desligada", em: null, porVariante: [], resumo: { total: 0, ok: 0, erro: 0, semGid: 0, semVariante: 0, pendente: 0 } },
    });
    await abrirTela();
    act(() => presencaCb!([E(0xfec)]));
    await flushTimers();
    await waitFor(() => expect((screen.getByText("Fechar lote") as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByText("Fechar lote"));
    fireEvent.change(screen.getByLabelText("Motivo"), { target: { value: "  troca de tamanho " } });
    fireEvent.change(screen.getByLabelText("Destino"), { target: { value: "estoque" } });
    // botão do cabeçalho + botão de confirmar do diálogo: o do diálogo é o último
    const botoes = screen.getAllByRole("button", { name: /Fechar lote/ });
    fireEvent.click(botoes[botoes.length - 1]!);

    await screen.findByText("Lote fechado");
    expect(fecharLote).toHaveBeenCalledWith("lote-1", { destino: "estoque", motivo: "troca de tamanho" });
    expect(screen.getByText(/Reintegração ao estoque da Shopify está desligada no Nexus/)).toBeTruthy();
    expect(screen.getByText("Novo lote")).toBeTruthy();
    expect(screen.getByText("Voltar ao menu")).toBeTruthy();
  });

  it("remover item confirma e chama o DELETE", async () => {
    abrirLote.mockResolvedValue({ lote: lote(), retomado: true });
    getLote.mockResolvedValue(detalhe([item("E280AAAAAA0001")]));
    removerEpc.mockResolvedValue({ removido: true, resumo: resumo() });
    await abrirTela();
    await screen.findByText("…AA0001");

    fireEvent.click(screen.getByText("Remover"));
    const botoes = screen.getAllByRole("button", { name: /Remover/ });
    fireEvent.click(botoes[botoes.length - 1]!);

    await waitFor(() => expect(removerEpc).toHaveBeenCalledWith("lote-1", "E280AAAAAA0001"));
    await waitFor(() => expect(screen.queryByText("…AA0001")).toBeNull());
  });

  it("sem permissão não abre lote", async () => {
    getMe.mockResolvedValue({ actorId: "u1", email: null, permissions: [] });
    render(<Devolucao onBack={() => {}} />);
    await screen.findByText(/não tem permissão/);
    expect(abrirLote).not.toHaveBeenCalled();
  });

  it("fechar com reintegração pendente chama reintegrarLote até zerar e mostra ok", async () => {
    const reint = (status: string, pendente: number, ok: number) => ({
      status,
      em: null,
      porVariante: [],
      resumo: { total: 3, ok, erro: 0, semGid: 0, semVariante: 0, pendente },
    });
    const fechado = lote({ status: "fechado", destino: "estoque", qtdItens: 1, qtdDevolvidas: 1 });
    fecharLote.mockResolvedValue({ lote: fechado, resumo: resumo({ total: 1, devolviveis: 1 }), reintegracao: reint("pendente", 2, 1) });
    reintegrarLote
      .mockResolvedValueOnce({ lote: fechado, reintegracao: reint("pendente", 1, 2) })
      .mockResolvedValueOnce({ lote: fechado, reintegracao: reint("ok", 0, 3) });
    await abrirTela();
    act(() => presencaCb!([E(0x4e2)]));
    await flushTimers();
    await waitFor(() => expect((screen.getByText("Fechar lote") as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByText("Fechar lote"));
    const botoes = screen.getAllByRole("button", { name: /Fechar lote/ });
    fireEvent.click(botoes[botoes.length - 1]!);

    await screen.findByText(/3 peças reintegradas ao estoque da Shopify/);
    expect(reintegrarLote).toHaveBeenCalledTimes(2);
    expect(reintegrarLote).toHaveBeenCalledWith("lote-1");
  });

  // ---- review do client ----

  const reintSt = (status: string, pendente: number, ok: number, total = 3) => ({
    status,
    em: null,
    porVariante: [],
    resumo: { total, ok, erro: 0, semGid: 0, semVariante: 0, pendente },
  });

  async function lerEPedirFechar(n: number) {
    act(() => presencaCb!([E(n)]));
    await flushTimers();
    await waitFor(() => expect((screen.getByText("Fechar lote") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText("Fechar lote"));
  }
  function confirmarFechar() {
    const botoes = screen.getAllByRole("button", { name: /Fechar lote/ });
    fireEvent.click(botoes[botoes.length - 1]!);
  }

  it("409 lote_fechado no fechar vai pro resultado e retoma a reintegração", async () => {
    const fechado = lote({ status: "fechado", destino: "estoque", qtdItens: 1, qtdDevolvidas: 1, reintegracao: reintSt("pendente", 2, 1) as never });
    fecharLote.mockRejectedValue(new ApiError(409, "x", { error: "lote_fechado" }));
    reintegrarLote.mockResolvedValue({ lote: fechado, reintegracao: reintSt("ok", 0, 3) });
    await abrirTela();
    await lerEPedirFechar(1);
    getLote.mockResolvedValue({ lote: fechado, resumo: resumo({ total: 1, devolviveis: 1 }), itens: [], porVariante: [] });
    confirmarFechar();

    await screen.findByText("Lote fechado");
    await screen.findByText(/3 peças reintegradas ao estoque da Shopify/);
    expect(reintegrarLote).toHaveBeenCalled();
    expect(screen.queryByText("Pausar leitura")).toBeNull();
  });

  it("erro de rede no fechar com lote já fechado no Nexus vai pro resultado", async () => {
    const fechado = lote({ status: "fechado", destino: "estoque", qtdItens: 1, qtdDevolvidas: 1, reintegracao: reintSt("desligada", 0, 0, 0) as never });
    fecharLote.mockRejectedValue(new TypeError("Failed to fetch"));
    await abrirTela();
    await lerEPedirFechar(2);
    getLote.mockResolvedValue({ lote: fechado, resumo: resumo({ total: 1, devolviveis: 1 }), itens: [], porVariante: [] });
    confirmarFechar();

    await screen.findByText("Lote fechado");
    expect(screen.getByText(/está desligada no Nexus/)).toBeTruthy();
  });

  it("4xx no envio não vira retry: uma chamada só e aviso na tela", async () => {
    adicionarEpcs.mockRejectedValue(new ApiError(400, "bad", { error: "bad_request" }));
    await abrirTela();
    act(() => presencaCb!([E(1)]));
    await flushTimers();
    await screen.findByText(/1 leitura descartada/);

    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(adicionarEpcs).toHaveBeenCalledTimes(1);
  });

  it("EPC inválido nunca é enviado e conta como ignorado", async () => {
    await abrirTela();
    act(() => presencaCb!(["CURTO", E(1)]));
    await flushTimers();
    await waitFor(() => expect(adicionarEpcs).toHaveBeenCalledTimes(1));
    expect(adicionarEpcs).toHaveBeenLastCalledWith("lote-1", [E(1)]);
    await screen.findByText(/1 leitura ignorada/);
  });

  it("epc_em_outro_lote com EPC que não casa bloqueia a leva, sem segunda chamada", async () => {
    adicionarEpcs.mockRejectedValue(new ApiError(409, "x", { error: "epc_em_outro_lote", epcs: [{ epc: "ZZZ", loteId: "o" }] }));
    await abrirTela();
    act(() => presencaCb!([E(1), E(2)]));
    await flushTimers();

    await screen.findByText(/2 peças já estão em outro lote aberto/);
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(adicionarEpcs).toHaveBeenCalledTimes(1);
  });

  it("loop do lote A rodando enquanto o lote B fecha não vaza pro estado de B", async () => {
    const loteA = lote({ id: "lote-A", status: "fechado", destino: "estoque", qtdItens: 1, qtdDevolvidas: 1 });
    const loteB = lote({ id: "lote-B", status: "fechado", destino: "estoque", qtdItens: 1, qtdDevolvidas: 1 });
    fecharLote
      .mockResolvedValueOnce({ lote: loteA, resumo: resumo({ total: 1, devolviveis: 1 }), reintegracao: reintSt("pendente", 2, 1) })
      .mockResolvedValueOnce({ lote: loteB, resumo: resumo({ total: 1, devolviveis: 1 }), reintegracao: reintSt("desligada", 0, 0, 0) });
    let liberarA: (v: unknown) => void = () => {};
    reintegrarLote.mockImplementationOnce(() => new Promise((res) => { liberarA = res; }));
    abrirLote
      .mockResolvedValueOnce({ lote: lote({ id: "lote-A" }), retomado: false })
      .mockResolvedValueOnce({ lote: lote({ id: "lote-B" }), retomado: false });
    await abrirTela();
    await lerEPedirFechar(1);
    confirmarFechar();
    await screen.findByText("Lote fechado");
    await waitFor(() => expect(reintegrarLote).toHaveBeenCalledTimes(1)); // A em voo

    fireEvent.click(screen.getByText("Novo lote"));
    await screen.findByText("Pausar leitura");
    await lerEPedirFechar(2);
    confirmarFechar();
    await screen.findByText(/está desligada no Nexus/);

    // A termina tarde, ainda pendente: nada dela pode aparecer em B nem gerar nova passada
    await act(async () => { liberarA({ lote: loteA, reintegracao: reintSt("ok", 0, 3) }); });
    await flushTimers();
    expect(screen.getByText(/está desligada no Nexus/)).toBeTruthy();
    expect(screen.queryByText(/peças reintegradas/)).toBeNull();
    expect(reintegrarLote).toHaveBeenCalledTimes(1);
  });

  it("unmount durante o retry não faz nova chamada a adicionarEpcs", async () => {
    adicionarEpcs.mockRejectedValue(new TypeError("Failed to fetch"));
    const { unmount } = render(<Devolucao onBack={() => {}} />);
    await waitFor(() => expect(presencaCb).not.toBeNull());
    act(() => presencaCb!([E(1)]));
    await flushTimers();
    await waitFor(() => expect(adicionarEpcs).toHaveBeenCalledTimes(1));

    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(adicionarEpcs).toHaveBeenCalledTimes(1);
  });

  it("unmount durante o loop de reintegração não faz nova passada", async () => {
    const fechado = lote({ status: "fechado", destino: "estoque", qtdItens: 1, qtdDevolvidas: 1 });
    fecharLote.mockResolvedValue({ lote: fechado, resumo: resumo({ total: 1, devolviveis: 1 }), reintegracao: reintSt("pendente", 2, 1) });
    let liberar: (v: unknown) => void = () => {};
    reintegrarLote.mockImplementationOnce(() => new Promise((res) => { liberar = res; }));
    const { unmount } = render(<Devolucao onBack={() => {}} />);
    await waitFor(() => expect(presencaCb).not.toBeNull());
    await lerEPedirFechar(1);
    confirmarFechar();
    await waitFor(() => expect(reintegrarLote).toHaveBeenCalledTimes(1));

    unmount();
    await act(async () => { liberar({ lote: fechado, reintegracao: reintSt("pendente", 1, 2) }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(reintegrarLote).toHaveBeenCalledTimes(1);
  });
});


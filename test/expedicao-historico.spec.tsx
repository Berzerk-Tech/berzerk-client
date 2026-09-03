// Histórico da expedição + a regra que custa saco de embalagem.
//
// Dois assuntos, um arquivo, porque nascem do mesmo incidente de 27/08:
//
// 1. **Render do histórico do dia**: o que a mesa expediu, com hora, cliente,
//    quem expediu, e o botão de reimpressão certo pra CONTA do pedido.
// 2. **Um pedido = UMA página 100×150**: a máquina de embalagem solta um saco
//    por etiqueta impressa. A mesa mandava etiqueta J&T *e* DANFE como dois
//    jobs pra mesma térmica — dois sacos por pedido. E um PDF da
//    transportadora com duas páginas sairia como duas etiquetas.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExpedicaoHistoryResponse } from "../src/services/expedicao";

const getExpedicaoHistory = vi.fn();
const getDocumentos = vi.fn();
const registrarReimpressao = vi.fn(async () => {});
const invoke = vi.fn();

vi.mock("../src/services/expedicao", async () => {
  const real =
    await vi.importActual<typeof import("../src/services/expedicao")>("../src/services/expedicao");
  return {
    ...real,
    getExpedicaoHistory: (...a: unknown[]) => getExpedicaoHistory(...a),
    getDocumentos: (...a: unknown[]) => getDocumentos(...a),
    registrarReimpressao: (...a: unknown[]) => registrarReimpressao(...a),
  };
});

// A impressão silenciosa é um comando Rust — no jsdom só observamos o invoke.
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const { ExpedicaoHistoryModal } = await import("../src/components/ExpedicaoHistoryModal");
const { imprimirDocumentoDoPedido, documentoDaConta } = await import("../src/lib/reimpressao");
const { ETIQUETA_UNICA } = await import("../src/lib/printer");

function pedido(
  over: Partial<ExpedicaoHistoryResponse["items"][number]> = {},
): ExpedicaoHistoryResponse["items"][number] {
  return {
    id: "ord-1",
    numero: "854736",
    clienteNome: "Maria Souza",
    dataEmissao: "2026-08-27T10:00:00.000Z",
    shippedAt: "2026-08-27T13:25:00.000Z",
    shippedBy: "sub-luiz",
    shippedByNome: "luiz.fernando@berzerk.com.br",
    trackingNumber: "JT0001234567",
    tinyAccount: "JT",
    channel: "tiny",
    status: "shipped",
    itemCount: 2,
    temDanfe: true,
    temEtiqueta: true,
    labelPrintedAt: "2026-08-27T13:24:00.000Z",
    rfidTags: ["E28011AAAAAAAAAAAAAAAAAA"],
    items: [],
    ...over,
  };
}

function resposta(items: ExpedicaoHistoryResponse["items"]): ExpedicaoHistoryResponse {
  return {
    items,
    total: items.length,
    totals: { pedidos: items.length, itens: 2, tags: 1 },
  };
}

describe("Histórico da expedição", () => {
  beforeEach(() => {
    getExpedicaoHistory.mockReset().mockResolvedValue(resposta([pedido()]));
    invoke.mockReset().mockResolvedValue({ ok: true, printer: null, message: null, engine: "sumatra" });
  });
  afterEach(() => cleanup());

  it("mostra hora, pedido, cliente e quem expediu", async () => {
    render(<ExpedicaoHistoryModal onClose={() => {}} />);

    await screen.findByText("#854736");
    expect(screen.getByText("Maria Souza")).toBeTruthy();
    // Só o login, sem o domínio — a coluna é estreita.
    expect(screen.getByText("luiz.fernando")).toBeTruthy();
    expect(screen.getByText("JT0001234567")).toBeTruthy();
  });

  it("abre no DIA de hoje e só com o que o ator expediu", async () => {
    render(<ExpedicaoHistoryModal onClose={() => {}} />);
    await screen.findByText("#854736");

    const [args] = getExpedicaoHistory.mock.calls[0] as [
      { dateFrom?: string; dateTo?: string; todos?: boolean },
    ];
    expect(args.dateFrom).toBe(args.dateTo); // um único dia
    expect(args.todos).toBe(false);
  });

  it("pedido JT e pedido FM oferecem reimprimir a ETIQUETA — a DANFE não é mais documento de expedição", async () => {
    getExpedicaoHistory.mockResolvedValue(
      resposta([
        pedido({ id: "ord-jt", numero: "1", tinyAccount: "JT" }),
        pedido({ id: "ord-fm", numero: "2", tinyAccount: "FM" }),
      ]),
    );
    render(<ExpedicaoHistoryModal onClose={() => {}} />);

    await screen.findByText("#1");
    expect(screen.getAllByText("↻ Reimprimir etiqueta")).toHaveLength(2);
    expect(screen.queryByText("↻ Reimprimir DANFE")).toBeNull();
  });

  it("sem documento disponível, o botão fica desabilitado", async () => {
    getExpedicaoHistory.mockResolvedValue(resposta([pedido({ temEtiqueta: false })]));
    render(<ExpedicaoHistoryModal onClose={() => {}} />);

    const btn = (await screen.findByText("↻ Reimprimir etiqueta")) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("degrada com aviso quando o nexus ainda não tem o endpoint", async () => {
    const { ApiError } = await import("../src/lib/api");
    getExpedicaoHistory.mockRejectedValue(new ApiError(404, "not found", null));
    render(<ExpedicaoHistoryModal onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/aguardando atualização do nexus/i)).toBeTruthy();
    });
  });
});

describe("um pedido = UMA página 100×150", () => {
  beforeEach(() => {
    invoke.mockReset().mockResolvedValue({ ok: true, printer: null, message: null, engine: "sumatra" });
    registrarReimpressao.mockClear();
  });

  it("etiqueta J&T em qualquer conta — a FM também sai pela J&T (03/09)", () => {
    expect(documentoDaConta("JT")).toBe("etiqueta");
    expect(documentoDaConta("FM")).toBe("etiqueta");
  });

  it("PDF de DUAS páginas da transportadora sai como UMA etiqueta só", async () => {
    // O PDF é opaco pro app (base64 da J&T); quem garante a página única é o
    // `-print-settings "1,fit"` do SumatraPDF. O que este teste trava é que
    // esse ajuste SEMPRE vai junto — sem ele, um PDF de 2 páginas viraria duas
    // etiquetas e a máquina soltaria dois sacos.
    const pdfDuasPaginas = "JVBERi0xLjQKJUR1YXNQYWdpbmFz";
    getDocumentos.mockResolvedValue({
      danfe: null,
      etiqueta: { base64: pdfDuasPaginas, formato: "pdf" },
      trackingNumber: "JT0001234567",
    });

    const r = await imprimirDocumentoDoPedido(
      { id: "ord-1", numero: "854736", tinyAccount: "JT" },
      "historico",
    );

    expect(r.ok).toBe(true);
    // UM job só na impressora.
    expect(invoke).toHaveBeenCalledTimes(1);
    const [comando, args] = invoke.mock.calls[0] as [string, { printSettings: string }];
    expect(comando).toBe("print_pdf_silent");
    expect(args.printSettings).toBe(ETIQUETA_UNICA);
    expect(ETIQUETA_UNICA).toBe("1,fit");
  });

  it("pedido JT NÃO manda a DANFE junto, mesmo tendo NF", async () => {
    // Este era o bug: dois jobs pra mesma térmica = dois sacos por pedido.
    getDocumentos.mockResolvedValue({
      danfe: { chave_acesso: "3525", numero: "1", emitente: {}, cliente: {}, itens: [] },
      etiqueta: { base64: "QUJD", formato: "pdf" },
      trackingNumber: "JT0001234567",
    });

    await imprimirDocumentoDoPedido({ id: "ord-1", numero: "1", tinyAccount: "JT" }, "mesa");

    expect(invoke).toHaveBeenCalledTimes(1);
    expect((invoke.mock.calls[0] as [string, { base64: string }])[1].base64).toBe("QUJD");
  });

  it("reimpressão registra a trilha; a impressão da mesa não", async () => {
    getDocumentos.mockResolvedValue({
      danfe: null,
      etiqueta: { base64: "QUJD", formato: "pdf" },
      trackingNumber: "JT1",
    });

    await imprimirDocumentoDoPedido({ id: "ord-1", numero: "1", tinyAccount: "JT" }, "mesa");
    expect(registrarReimpressao).not.toHaveBeenCalled();

    await imprimirDocumentoDoPedido({ id: "ord-1", numero: "1", tinyAccount: "JT" }, "historico");
    expect(registrarReimpressao).toHaveBeenCalledWith("ord-1", "etiqueta", "historico");
  });

  it("sem documento, devolve aviso em vez de imprimir", async () => {
    getDocumentos.mockResolvedValue({ danfe: null, etiqueta: null, trackingNumber: null });

    const r = await imprimirDocumentoDoPedido(
      { id: "ord-1", numero: "1", tinyAccount: "JT" },
      "historico",
    );

    expect(r.ok).toBe(false);
    expect(r.mensagem).toContain("não tem etiqueta");
    expect(invoke).not.toHaveBeenCalled();
  });
});

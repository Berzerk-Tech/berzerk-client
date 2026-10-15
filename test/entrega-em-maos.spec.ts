// Entrega em mãos (15/10): pedido que a Luana entrega pessoalmente. O app pega
// um pelo `claimOrder`, lista a aba com `getEntregaEmMaos` (404 = nexus
// antigo, esconde) e a expedição recusa com `invalid_status` + `motivo`,
// mostrando a `message` do servidor sem cair no retry.
//
// `apiRequest` é um stub manual (não `vi.fn`): no vitest 5 um erro lançado de
// dentro de um `vi.fn` marca o teste como falho mesmo tratado pelo código.
import { beforeEach, describe, expect, it, vi } from "vitest";

type Chamada = [string, { method?: string; body?: Record<string, unknown> } | undefined];
const chamadas: Chamada[] = [];
let resposta: () => unknown = () => Promise.resolve(null);
vi.mock("../src/lib/api", async () => {
  const real = await vi.importActual<typeof import("../src/lib/api")>("../src/lib/api");
  return {
    ...real,
    apiRequest: (path: string, opts?: { method?: string; body?: Record<string, unknown> }) => {
      chamadas.push([path, opts]);
      return resposta();
    },
  };
});

const { ApiError } = await import("../src/lib/api");
const { claimOrder, getEntregaEmMaos, pedidoIndisponivel } = await import("../src/services/orders");
const { EXP_ERR, motivoRecusa, shipErrorMessage } = await import("../src/services/expedicao");
const { classificarCodigoShip, CODIGOS_DEFINITIVOS } = await import("../src/lib/shipRetry");

describe("entrega em mãos: serviço", () => {
  beforeEach(() => {
    chamadas.length = 0;
  });

  it("claimOrder manda o orderId no body e devolve o order", async () => {
    resposta = () => Promise.resolve({ order: { id: "ord-1", entregaEmMaos: true } });
    const r = await claimOrder("ord-1");
    expect(r.order?.entregaEmMaos).toBe(true);
    const [path, opts] = chamadas[0];
    expect(path).toBe("/separacao/claim-order");
    expect(opts?.method).toBe("POST");
    expect(opts?.body).toEqual({ orderId: "ord-1" });
  });

  it("getEntregaEmMaos devolve null no 404 (nexus antigo) e propaga outros erros", async () => {
    resposta = () => Promise.reject(new ApiError(404, "not found", { message: "Cannot GET" }));
    await expect(getEntregaEmMaos()).resolves.toBeNull();
    resposta = () => Promise.reject(new ApiError(500, "boom", null));
    await expect(getEntregaEmMaos()).rejects.toBeInstanceOf(ApiError);
    resposta = () => Promise.resolve({ pedidos: [], pendentes: [] });
    await expect(getEntregaEmMaos()).resolves.toEqual({ pedidos: [], pendentes: [] });
    expect(chamadas[0][0]).toBe("/separacao/entrega-em-maos");
  });

  it("pedidoIndisponivel lê o 409 e ignora outros erros", () => {
    const e = new ApiError(409, "x", { error: "pedido_indisponivel", status: "separating", motivo: null, message: "A mesa 2 já pegou esse pedido." });
    expect(pedidoIndisponivel(e)).toEqual({ message: "A mesa 2 já pegou esse pedido.", status: "separating", motivo: null });
    const semMsg = pedidoIndisponivel(new ApiError(409, "x", { error: "pedido_indisponivel" }));
    expect(semMsg?.message).toMatch(/não está mais disponível/);
    expect(pedidoIndisponivel(new ApiError(409, "x", { error: "limite_listas_abertas" }))).toBeNull();
    expect(pedidoIndisponivel(new Error("rede"))).toBeNull();
  });
});

describe("entrega em mãos: expedição recusa com invalid_status + motivo", () => {
  const CORPO = { error: "invalid_status", motivo: "entrega_em_maos", message: "Pedido 1234 é entrega em mãos: não sai pela expedição.", current: "separating" };

  it("motivoRecusa só reconhece corpo com motivo E message", () => {
    expect(motivoRecusa(new ApiError(409, "x", CORPO))).toEqual({ motivo: "entrega_em_maos", message: CORPO.message });
    expect(motivoRecusa(new ApiError(409, "x", { error: "invalid_status", message: "sem motivo" }))).toBeNull();
    expect(motivoRecusa(new ApiError(409, "x", { error: "invalid_status", motivo: "expedicao_manual" }))).toBeNull();
    expect(motivoRecusa(new Error("rede"))).toBeNull();
    // Só 409 invalid_status: um 422 com `motivo` ecoado (liberação) não sequestra a mensagem.
    expect(motivoRecusa(new ApiError(422, "x", CORPO))).toBeNull();
    expect(motivoRecusa(new ApiError(409, "x", { ...CORPO, error: "tags_incompletas" }))).toBeNull();
  });

  it("invalid_status continua definitivo (sem retry) e carrega a message do servidor", () => {
    expect(CODIGOS_DEFINITIVOS.has(EXP_ERR.INVALID_STATUS)).toBe(true);
    const r = classificarCodigoShip(EXP_ERR.INVALID_STATUS, null, null, CORPO.message);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.tipo).toBe("definitivo");
    expect(r.mensagem).toBe(CORPO.message);
    // Sem motivo (nexus de antes) o texto fica com o padrão do app.
    const semMsg = classificarCodigoShip(EXP_ERR.INVALID_STATUS, null, null, null);
    expect(semMsg.ok).toBe(false);
    if (semMsg.ok) return;
    expect(semMsg.mensagem).toBeUndefined();
    expect(shipErrorMessage(EXP_ERR.INVALID_STATUS)).toMatch(/status/);
  });

  it("a message nunca vaza pra tipos que não são definitivos", () => {
    const r = classificarCodigoShip("codigo_novo_qualquer", null, null, "msg");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.tipo).toBe("aguardar");
    expect(r.mensagem).toBeUndefined();
  });
});

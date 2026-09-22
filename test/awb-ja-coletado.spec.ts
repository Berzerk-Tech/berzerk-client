// AWB já coletado pela J&T (NEXUS_EXPEDICAO.md §8, 22/09) — pedido devolvido
// pra fila com o MESMO AWB de um pacote que a transportadora já buscou antes
// desta separação (duplicado). Dois assuntos, mesmo incidente:
//
// 1. **Classificação do 409 do `ship`**: antes deste release um código
//    desconhecido virava `tipo: "aguardar"` e o client retentava o mesmo
//    `ship` a cada 15s pra sempre, sem avisar ninguém — é o bug que a ação
//    obrigatória do §8 evita. `awb_ja_coletado` precisa de um tipo PRÓPRIO
//    (não é `conferencia`, que libera sem PIN; não é `definitivo`, que
//    desiste do job).
// 2. **Aviso antecipado no `complete` da Separação**: `avisos` é aditivo — só
//    testa que o parse acha (ou não acha) o aviso certo, sem side effect.
// 3. **Seleção do próximo job do loop de retry** (`proximoJobDaFila`) e o
//    round-trip de persistência (`saveShipRetry`/`loadShipRetry`): quem trava
//    um job é a FLAG `bloqueadoPorAwb`, nunca o detalhe `awbColetado` (que
//    pode faltar se o corpo do 409 vier incompleto).

import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/lib/api";
import {
  classificarCodigoShip,
  loadShipRetry,
  proximoJobDaFila,
  saveShipRetry,
  type ShipRetryJob,
} from "../src/lib/shipRetry";
import { EXP_ERR, awbJaColetadoDetails, type AwbJaColetadoDetails } from "../src/services/expedicao";
import { avisoAwbColetado, type Order } from "../src/services/orders";

function erroNegocio(body: Record<string, unknown>, status = 409): ApiError {
  return new ApiError(status, typeof body.message === "string" ? body.message : "erro", body);
}

const DETALHES: AwbJaColetadoDetails = {
  awb: "888030815319463",
  message:
    "Este AWB (888030815319463) já foi coletado pela J&T em 20/09/2026 09:00. Pacote duplicado — chame o supervisor pra liberar com PIN.",
  primeiroScanEm: "2026-09-20T12:00:00.000Z",
  ultimoEvento: "Coletado",
};

describe("classificarCodigoShip — política por código do ship", () => {
  it("awb_ja_coletado vira o tipo NOVO 'awb_coletado', carregando os detalhes do AWB", () => {
    expect(classificarCodigoShip(EXP_ERR.AWB_JA_COLETADO, DETALHES)).toEqual({
      ok: false,
      tipo: "awb_coletado",
      code: EXP_ERR.AWB_JA_COLETADO,
      awbColetado: DETALHES,
    });
  });

  it("awb_ja_coletado NUNCA vira 'aguardar' — era isso que fazia o client retentar pra sempre", () => {
    const r = classificarCodigoShip(EXP_ERR.AWB_JA_COLETADO, null);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.tipo).not.toBe("aguardar");
    expect(r.tipo).toBe("awb_coletado");
  });

  it("awb_ja_coletado NUNCA vira 'conferencia' (esse libera sem PIN) nem 'definitivo' (esse desiste do job)", () => {
    const r = classificarCodigoShip(EXP_ERR.AWB_JA_COLETADO, DETALHES);
    if (r.ok) throw new Error("unreachable");
    expect(r.tipo).not.toBe("conferencia");
    expect(r.tipo).not.toBe("definitivo");
  });

  it("códigos existentes continuam mapeando igual (regressão)", () => {
    expect(classificarCodigoShip("tags_incompletas", null)).toEqual({ ok: false, tipo: "conferencia", code: "tags_incompletas" });
    expect(classificarCodigoShip("pecas_insuficientes", null)).toEqual({ ok: false, tipo: "conferencia", code: "pecas_insuficientes" });
    expect(classificarCodigoShip("liberacao_necessaria", null)).toEqual({ ok: false, tipo: "conferencia", code: "liberacao_necessaria" });
    expect(classificarCodigoShip(EXP_ERR.INVALID_STATUS, null)).toEqual({ ok: false, tipo: "definitivo", code: EXP_ERR.INVALID_STATUS });
    expect(classificarCodigoShip(EXP_ERR.ORDER_NOT_FOUND, null)).toEqual({ ok: false, tipo: "definitivo", code: EXP_ERR.ORDER_NOT_FOUND });
  });

  it("código de negócio desconhecido continua 'aguardar' (retry automático, comportamento intacto)", () => {
    expect(classificarCodigoShip("algum_codigo_novo_do_nexus", null)).toEqual({
      ok: false,
      tipo: "aguardar",
      code: "algum_codigo_novo_do_nexus",
    });
  });
});

describe("awbJaColetadoDetails — parse do corpo do 409", () => {
  it("extrai awb/message/primeiroScanEm/ultimoEvento quando o corpo vem completo", () => {
    const e = erroNegocio({ error: "awb_ja_coletado", ...DETALHES });
    expect(awbJaColetadoDetails(e)).toEqual(DETALHES);
  });

  it("ultimoEvento ausente vira null (campo opcional no contrato)", () => {
    const e = erroNegocio({
      error: "awb_ja_coletado",
      message: "m",
      awb: "A",
      primeiroScanEm: "2026-09-20T12:00:00.000Z",
    });
    expect(awbJaColetadoDetails(e)?.ultimoEvento).toBeNull();
  });

  it("null pra outro código de erro (não confunde com outro 409/422)", () => {
    const e = erroNegocio({ error: "tags_incompletas", message: "m" });
    expect(awbJaColetadoDetails(e)).toBeNull();
  });

  it("null se o corpo do awb_ja_coletado vier incompleto (defensivo)", () => {
    const e = erroNegocio({ error: "awb_ja_coletado", message: "m" }); // sem awb/primeiroScanEm
    expect(awbJaColetadoDetails(e)).toBeNull();
  });

  it("null pra erro que não é ApiError (falha de rede, por exemplo)", () => {
    expect(awbJaColetadoDetails(new Error("network"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// avisoAwbColetado — aviso antecipado no complete da Separação
// ---------------------------------------------------------------------------

function pedido(over: Partial<Order> = {}): Order {
  return {
    id: "ord-1",
    tinyOrderId: "700001",
    numero: "700001",
    channel: "tiny",
    status: "awaiting_pickup",
    predominantSize: "M",
    separationMode: "normal",
    claimedBy: "op-1",
    claimedAt: "2026-09-22T12:00:00.000Z",
    separatedBy: "op-1",
    separatedAt: "2026-09-22T12:05:00.000Z",
    rfidTags: ["E28011AAAAAAAAAAAAAA0001"],
    items: [],
    createdAt: "2026-09-22T12:00:00.000Z",
    updatedAt: "2026-09-22T12:05:00.000Z",
    ...over,
  };
}

describe("avisoAwbColetado — parse de Order.avisos (aditivo/opcional)", () => {
  it("acha o aviso de awb_ja_coletado quando presente", () => {
    const aviso = {
      tipo: "awb_ja_coletado" as const,
      awb: DETALHES.awb,
      primeiroScanEm: DETALHES.primeiroScanEm,
      ultimoEvento: DETALHES.ultimoEvento,
    };
    expect(avisoAwbColetado(pedido({ avisos: [aviso] }))).toEqual(aviso);
  });

  it("null quando avisos está ausente (nexus antigo / caso comum)", () => {
    expect(avisoAwbColetado(pedido())).toBeNull();
  });

  it("null quando avisos vem vazio", () => {
    expect(avisoAwbColetado(pedido({ avisos: [] }))).toBeNull();
  });

  it("null pra order null/undefined (chamado antes da resposta chegar)", () => {
    expect(avisoAwbColetado(null)).toBeNull();
    expect(avisoAwbColetado(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// proximoJobDaFila + persistência da fila — quem trava é a FLAG, não o detalhe
// ---------------------------------------------------------------------------

function job(over: Partial<ShipRetryJob> = {}): ShipRetryJob {
  return { orderId: "ord-1", numero: "700001", lidas: ["E28011AAAAAAAAAAAAAA0001"], ...over };
}

describe("proximoJobDaFila — seleção do loop de retry (15s)", () => {
  it("escolhe o job comum normalmente (regressão)", () => {
    expect(proximoJobDaFila([job()])).toEqual(job());
  });

  it("NUNCA escolhe um job bloqueadoPorAwb, mesmo sem precisaMotivo", () => {
    const bloqueado = job({ bloqueadoPorAwb: true, awbColetado: DETALHES });
    expect(proximoJobDaFila([bloqueado])).toBeNull();
  });

  it("job bloqueadoPorAwb SEM awbColetado (corpo do 409 incompleto) continua bloqueado — é a flag que decide", () => {
    const bloqueadoSemDetalhe = job({ orderId: "ord-2", bloqueadoPorAwb: true });
    expect(proximoJobDaFila([bloqueadoSemDetalhe])).toBeNull();
  });

  it("pula o bloqueadoPorAwb e escolhe o próximo job elegível da fila", () => {
    const bloqueado = job({ orderId: "ord-bloqueado", bloqueadoPorAwb: true, awbColetado: DETALHES });
    const elegivel = job({ orderId: "ord-elegivel" });
    expect(proximoJobDaFila([bloqueado, elegivel])?.orderId).toBe("ord-elegivel");
  });

  it("continua ignorando o job com modal (motivo/PIN) aberto pra pessoa (emAberto)", () => {
    const aberto = job({ orderId: "ord-aberto" });
    expect(proximoJobDaFila([aberto], "ord-aberto")).toBeNull();
  });

  it("continua preferindo job sem precisaMotivo a um que precisa (regressão)", () => {
    const comMotivo = job({ orderId: "ord-motivo", precisaMotivo: true });
    const semMotivo = job({ orderId: "ord-comum" });
    expect(proximoJobDaFila([comMotivo, semMotivo])?.orderId).toBe("ord-comum");
  });
});

describe("saveShipRetry/loadShipRetry — round-trip preserva bloqueadoPorAwb", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("job bloqueadoPorAwb com detalhes sobrevive ao save/load", () => {
    const bloqueado = job({ bloqueadoPorAwb: true, awbColetado: DETALHES });
    saveShipRetry([bloqueado]);
    expect(loadShipRetry()).toEqual([bloqueado]);
  });

  it("job bloqueadoPorAwb SEM awbColetado sobrevive ao save/load com a flag intacta", () => {
    const bloqueadoSemDetalhe = job({ bloqueadoPorAwb: true });
    saveShipRetry([bloqueadoSemDetalhe]);
    const [carregado] = loadShipRetry();
    expect(carregado.bloqueadoPorAwb).toBe(true);
    expect(carregado.awbColetado).toBeUndefined();
  });

  it("job comum (sem a flag) sobrevive ao save/load igual antes (regressão)", () => {
    saveShipRetry([job()]);
    expect(loadShipRetry()).toEqual([job()]);
  });
});

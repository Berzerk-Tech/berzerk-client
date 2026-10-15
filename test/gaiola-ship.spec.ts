// Gaiola da embalagem (15/10): o 409 `gaiola_cheia` do `ship` NÃO pode cair no
// `aguardar` genérico (retry a cada 15 s pra sempre, batendo no mesmo 409).
// Ele trava o job na fila (`bloqueadoPorGaiola`) até a gaiola ser fechada, e
// o fechamento destrava a fila inteira de uma vez.

import { describe, expect, it } from "vitest";
import { ApiError } from "../src/lib/api";
import { classificarCodigoShip, destravarGaiola, proximoJobDaFila, type ShipRetryJob } from "../src/lib/shipRetry";
import { EXP_ERR, gaiolaCheiaDetails, shipErrorMessage } from "../src/services/expedicao";

const CORPO = { error: "gaiola_cheia", message: "Gaiola 12 está cheia (300/300). Feche a gaiola pra continuar.", gaiolaNumero: 12, contagem: 300, limite: 300 };

function job(id: string, extra: Partial<ShipRetryJob> = {}): ShipRetryJob {
  return { orderId: id, numero: id, lidas: ["E1"], ...extra };
}

describe("409 gaiola_cheia", () => {
  it("gaiolaCheiaDetails lê o corpo e tolera corpo incompleto", () => {
    const d = gaiolaCheiaDetails(new ApiError(409, CORPO.message, CORPO));
    expect(d).toEqual({ message: CORPO.message, gaiolaNumero: 12, contagem: 300, limite: 300 });
    const parcial = gaiolaCheiaDetails(new ApiError(409, "x", { error: "gaiola_cheia" }));
    expect(parcial?.gaiolaNumero).toBeNull();
    expect(parcial?.message).toMatch(/gaiola/i);
    expect(gaiolaCheiaDetails(new ApiError(409, "x", { error: "awb_ja_coletado" }))).toBeNull();
    expect(gaiolaCheiaDetails(new Error("rede"))).toBeNull();
  });

  it("classifica como tipo próprio (nem aguardar, nem conferência, nem definitivo)", () => {
    const r = classificarCodigoShip(EXP_ERR.GAIOLA_CHEIA, null, gaiolaCheiaDetails(new ApiError(409, "x", CORPO)));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.tipo).toBe("gaiola_cheia");
    expect(r.gaiolaCheia?.limite).toBe(300);
    // Sem detalhes o código ainda basta pra travar.
    const semDetalhe = classificarCodigoShip(EXP_ERR.GAIOLA_CHEIA, null, null);
    expect(semDetalhe.ok === false && semDetalhe.tipo).toBe("gaiola_cheia");
    // Os outros continuam como eram.
    expect(classificarCodigoShip("tracking_required_qualquer", null).ok === false && classificarCodigoShip("x", null)).toMatchObject({ tipo: "aguardar" });
    expect(shipErrorMessage(EXP_ERR.GAIOLA_CHEIA)).toMatch(/gaiola/);
  });

  it("o loop de 15 s pula job preso por gaiola; fechar a gaiola destrava todos", () => {
    const fila = [job("a", { bloqueadoPorGaiola: true }), job("b", { bloqueadoPorGaiola: true }), job("c", { bloqueadoPorAwb: true })];
    expect(proximoJobDaFila(fila)).toBeNull();
    const livre = destravarGaiola(fila);
    expect(livre.map((j) => j.bloqueadoPorGaiola)).toEqual([false, false, undefined]);
    expect(livre[2].bloqueadoPorAwb).toBe(true); // AWB continua preso
    // Reaperta NA ORDEM: o primeiro que levou o 409 sai primeiro.
    expect(proximoJobDaFila(livre)?.orderId).toBe("a");
    // Sem job preso devolve o mesmo array (sem re-render à toa).
    const semPreso = [job("x")];
    expect(destravarGaiola(semPreso)).toBe(semPreso);
  });
});

// Fila de retry do `ship` da Expedição — estado (persistência em localStorage)
// + classificação pura dos códigos de erro, separados de `Expedicao.tsx` pra
// poder testar sem montar a mesa toda (mocks de leitor/RFID, contextos etc.).
//
// Fora daqui (em `expedirEmbalado`, Expedicao.tsx) ficam os dois casos que
// dependem de I/O: código ausente (falha de rede, sem corpo JSON) e o retry
// especial de `JT_LABEL_REQUIRED` (reaperta `markLabelPrinted` e tenta nesse
// mesmo código uma segunda vez).

import type { LeituraResolvida } from "../services/orders";
import { EXP_ERR, type AwbJaColetadoDetails, type GaiolaCheiaDetails, type GaiolaDoShip } from "../services/expedicao";

/**
 * Fila de `ship` pendente (falha de rede ao fechar o pacote) — PERSISTIDA por
 * estação. Sem isso, fechar o app com reenvio pendente deixava o pedido
 * `awaiting_pickup` no nexus e o Tiny sem `enviado`, com a peça já ensacada.
 */
const SHIP_RETRY_KEY = "berzerk_expedicao_ship_retry_v1";

export type ShipRetryJob = {
  orderId: string;
  numero: string | null;
  lidas: string[];
  override?: string;
  /** Conta Tiny — pra reapertar `markLabelPrinted` quando o ship devolve JT_LABEL_REQUIRED. */
  conta?: "FM" | "JT";
  /** O servidor apontou peça faltando e a trava de supervisor está ligada: só sai com motivo humano. */
  precisaMotivo?: boolean;
  /** Resolução EPC→peça das tags lidas (nuvem iTAG) — o nexus casa as peças por ela. */
  leituras?: LeituraResolvida[];
  /** Job preso no modal já foi reapertado UMA vez com leituras (e ainda assim caiu na conferência). */
  reapertadoComLeituras?: boolean;
  /**
   * 409 `awb_ja_coletado` (NEXUS_EXPEDICAO.md §8): o AWB deste pedido já foi
   * coletado pela J&T ANTES desta separação — pacote duplicado. É esta FLAG
   * — não `awbColetado` — que trava o job (nunca reaperta sozinho); o corpo
   * do 409 pode vir sem `awb`/`primeiroScanEm` e o job tem que travar do
   * mesmo jeito.
   */
  bloqueadoPorAwb?: boolean;
  /** Detalhes do 409 só pra montar a mensagem da barra — opcional mesmo com `bloqueadoPorAwb`. */
  awbColetado?: AwbJaColetadoDetails;
  /**
   * 409 `gaiola_cheia` (15/10): a gaiola aberta está no teto. O job fica na
   * fila SEM reenvio automático até alguém fechar a gaiola (modal/widget), e
   * aí a fila inteira é destravada de uma vez e reaperta na ordem. Repetir a
   * cada 15 s só bateria no mesmo 409.
   */
  bloqueadoPorGaiola?: boolean;
};

export function loadShipRetry(): ShipRetryJob[] {
  try {
    const raw = localStorage.getItem(SHIP_RETRY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (j): j is ShipRetryJob =>
        !!j && typeof j === "object" && typeof (j as ShipRetryJob).orderId === "string" && Array.isArray((j as ShipRetryJob).lidas),
    );
  } catch {
    return [];
  }
}

export function saveShipRetry(jobs: ShipRetryJob[]): void {
  try {
    if (jobs.length === 0) localStorage.removeItem(SHIP_RETRY_KEY);
    else localStorage.setItem(SHIP_RETRY_KEY, JSON.stringify(jobs));
  } catch {
    /* ignore */
  }
}

/**
 * Próximo job a reapertar no loop de 15s do retry automático (pura — só
 * decide QUAL, quem chama é quem faz I/O). Política:
 * - nunca um `bloqueadoPorAwb` (§8) — só sai pelo "Liberar com PIN" ou por
 *   uma recusa definitiva, nunca sozinho;
 * - nunca o job com um modal aberto pra pessoa (motivo OU PIN) — `emAberto`;
 * - quem precisa de motivo humano só reaperta UMA vez, com leituras
 *   preenchidas (`!reapertadoComLeituras`) — job que caiu no modal só por
 *   falta de leituras (nuvem iTAG fora) passa sozinho quando elas voltarem.
 */
export function proximoJobDaFila(queue: ShipRetryJob[], emAberto?: string | null): ShipRetryJob | null {
  const livre = (j: ShipRetryJob) => !j.bloqueadoPorAwb && !j.bloqueadoPorGaiola && j.orderId !== emAberto;
  return (
    queue.find((j) => !j.precisaMotivo && livre(j)) ??
    queue.find((j) => j.precisaMotivo && !j.reapertadoComLeituras && livre(j)) ??
    null
  );
}

/** Depois que a gaiola foi fechada: solta todos os jobs presos por `gaiola_cheia` (a fila reaperta na ordem). */
export function destravarGaiola(queue: ShipRetryJob[]): ShipRetryJob[] {
  if (!queue.some((j) => j.bloqueadoPorGaiola)) return queue;
  return queue.map((j) => (j.bloqueadoPorGaiola ? { ...j, bloqueadoPorGaiola: false } : j));
}

/** Códigos em que o servidor discorda da conferência da mesa — precisam de motivo HUMANO (trava de supervisor). */
export const CODIGOS_CONFERENCIA = new Set<string>(["tags_incompletas", "pecas_insuficientes", "liberacao_necessaria"]);
/** Códigos em que repetir não resolve: alguém mexeu no pedido no Nexus. */
export const CODIGOS_DEFINITIVOS = new Set<string>([EXP_ERR.INVALID_STATUS, EXP_ERR.ORDER_NOT_FOUND]);

export type ShipTentativa =
  | {
      ok: true;
      /** Gaiola em que o pedido entrou, com a contagem já incluindo ele (ausente no nexus anterior). */
      gaiola?: GaiolaDoShip;
    }
  | {
      ok: false;
      tipo: "rede" | "aguardar" | "conferencia" | "definitivo" | "awb_coletado" | "gaiola_cheia";
      code: string | null;
      /** Só em `tipo: "awb_coletado"` — o AWB/data pra mostrar na barra vermelha; pode faltar (ver `bloqueadoPorAwb`). */
      awbColetado?: AwbJaColetadoDetails;
      /** Só em `tipo: "gaiola_cheia"` — mensagem do servidor e números pro modal. */
      gaiolaCheia?: GaiolaCheiaDetails;
      /** Só em `tipo: "definitivo"` — `message` do servidor quando o 409 trouxe
       *  `motivo` (entrega em mãos, Mercado Livre); senão o texto fica com `shipErrorMessage`. */
      mensagem?: string;
    };

/**
 * Decide o que fazer com um código de negócio devolvido pelo `ship` (409/422).
 * Política por código:
 * - `awb_ja_coletado`        → SEMPRE `tipo: "awb_coletado"`, com ou sem
 *                              detalhes (corpo do 409 pode vir incompleto) —
 *                              NUNCA reenviar sozinho: fica na fila persistente
 *                              e mostra a barra vermelha com "Liberar com PIN"
 *                              (não é `conferencia` — aquele modal libera sem
 *                              PIN — nem `definitivo` — aquele desiste do job);
 * - `tags_incompletas` & cia → NUNCA override automático: a trava de supervisor
 *                              existe pra um humano decidir — abre o modal de motivo;
 * - `invalid_status` / `order_not_found` → desiste e avisa (alguém mexeu no Nexus);
 * - `gaiola_cheia`           → `tipo: "gaiola_cheia"`: fica na fila TRAVADO
 *                              (`bloqueadoPorGaiola`) até a gaiola ser fechada;
 * - qualquer outro código    → fila, tenta de novo sozinho (rastreio/etiqueta chegam).
 */
export function classificarCodigoShip(
  code: string,
  awbColetado: AwbJaColetadoDetails | null,
  gaiolaCheia?: GaiolaCheiaDetails | null,
  mensagem?: string | null,
): ShipTentativa {
  if (code === EXP_ERR.AWB_JA_COLETADO) {
    return { ok: false, tipo: "awb_coletado", code, awbColetado: awbColetado ?? undefined };
  }
  // Gaiola no teto: nada foi gravado, e repetir só bate no mesmo 409. Fica na
  // fila travado até fechar a gaiola; o reenvio é disparado pelo fechamento.
  if (code === EXP_ERR.GAIOLA_CHEIA) {
    return { ok: false, tipo: "gaiola_cheia", code, gaiolaCheia: gaiolaCheia ?? undefined };
  }
  if (CODIGOS_CONFERENCIA.has(code)) return { ok: false, tipo: "conferencia", code };
  if (CODIGOS_DEFINITIVOS.has(code)) return { ok: false, tipo: "definitivo", code, ...(mensagem ? { mensagem } : {}) };
  return { ok: false, tipo: "aguardar", code };
}

/** "#1234" ou "o pedido" — rótulo padrão pras mensagens da fila de retry. */
export function rotuloPedido(numero: string | null): string {
  return numero ? `#${numero}` : "o pedido";
}

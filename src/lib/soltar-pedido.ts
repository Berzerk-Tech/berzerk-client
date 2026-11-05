// Soltar UM pedido de lista impressa sem PIN (falta de peça) — regras puras.
import { ApiError } from "./api";
import type { MotivoSoltar, Order, ReleaseBody, ReleaseResponse } from "../services/orders";

export const OBSERVACAO_MAX = 200;

/** Body do `POST /separacao/:id/release` com motivo; observação aparada e limitada. */
export function montarBodySoltar(motivo: MotivoSoltar, observacao?: string): ReleaseBody {
  const obs = (observacao ?? "").trim().slice(0, OBSERVACAO_MAX);
  return obs ? { motivo, observacao: obs } : { motivo };
}

/** Mostra "soltar" sem PIN: pedido de lista impressa que é dela (`claimedBy` = sub). */
export function podeSoltarSemPin(order: Pick<Order, "listaEm" | "claimedBy">, sub: string | null | undefined): boolean {
  return !!order.listaEm && !!sub && order.claimedBy === sub;
}

/** 409 `lista_impressa`: Nexus sem suporte ao motivo — cai no modal de PIN. */
export function ehListaImpressaSemSuporte(e: unknown): boolean {
  if (!(e instanceof ApiError) || e.status !== 409) return false;
  const b = e.body;
  if (b && typeof b === "object") {
    const o = b as { error?: unknown; code?: unknown };
    if (o.error === "lista_impressa" || o.code === "lista_impressa") return true;
  }
  return /lista_impressa/.test(e.message);
}

export const MSG_SERVIDOR_EXIGE_SUPERVISOR = "Esta versão do servidor ainda exige supervisor.";

export function textoPedidoSolto(numero: string | null, r: Pick<ReleaseResponse, "restantesNaLista">): string {
  const n = numero ? ` ${numero}` : "";
  const resto =
    typeof r.restantesNaLista === "number"
      ? ` (${r.restantesNaLista === 0 ? "a lista acabou" : `restam ${r.restantesNaLista} na lista`})`
      : "";
  return `Pedido${n} solto da lista${resto}.`;
}

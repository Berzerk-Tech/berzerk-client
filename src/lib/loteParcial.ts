// Resposta PARCIAL do `POST /separacao/lote` (nexus com `conhecidos`): o servidor
// só manda os pedidos novos ou que mudaram e a lista completa e ordenada dos ids
// do lote. Aqui o app monta o lote inteiro a partir do que já tem em memória.
import type { LoteResponse, Order } from "../services/orders";

/** O que o app já tem em memória, no formato do body (`v` = `updatedAt`). Pula pedido sem `updatedAt`. */
export function conhecidosDoLote(orders: Order[]): { id: string; v: string }[] {
  const out: { id: string; v: string }[] = [];
  for (const o of orders) if (o.updatedAt) out.push({ id: o.id, v: o.updatedAt });
  return out;
}

/**
 * Lote completo a partir da resposta. Resposta completa (nexus antigo, sem
 * `parcial`/`ids`): devolve `orders` como veio. Parcial: segue a ordem de `ids`,
 * usando o pedido da resposta quando veio e o de `atual` quando não; pedido fora
 * de `ids` sai do lote. `null` = algum id não existe em lugar nenhum (quem chama
 * refaz a chamada SEM `conhecidos`).
 */
export function mesclarLote(atual: Order[], resp: Pick<LoteResponse, "orders" | "ids" | "parcial">): Order[] | null {
  if (resp.parcial !== true || !resp.ids) return resp.orders;
  const novos = new Map(resp.orders.map((o) => [o.id, o]));
  const antigos = new Map(atual.map((o) => [o.id, o]));
  const out: Order[] = [];
  for (const id of resp.ids) {
    const o = novos.get(id) ?? antigos.get(id);
    if (!o) return null;
    out.push(o);
  }
  return out;
}

/**
 * De tempos em tempos o lote vem COMPLETO de novo. O servidor decide o que reenviar pelo `updatedAt` do pedido,
 * mas parte do que a mesa mostra vem de outras tabelas (foto do item, equivalências, Surpresa): uma correção
 * feita lá não muda o pedido e a mesa ficaria com o dado antigo até sair da fila.
 */
export const LOTE_COMPLETO_A_CADA_MS = 5 * 60_000;

/** Pode mandar `conhecidos` (resposta parcial) ou está na hora do lote completo? */
export function podeSerParcial(agora: number, ultimoCompletoEm: number): boolean {
  return ultimoCompletoEm > 0 && agora - ultimoCompletoEm < LOTE_COMPLETO_A_CADA_MS;
}

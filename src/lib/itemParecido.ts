import type { OrderItem } from "../services/orders";

/** Tamanhos conhecidos pra extrair do nome quando o item vem sem `tamanho`. */
const KNOWN_SIZES = new Set([
  "PP", "P", "M", "G", "GG", "XG", "XXG", "G1", "G2", "G3", "XGG",
]);

/**
 * Tamanho efetivo do item: o campo `tamanho` (normalizado), ou extraído do nome
 * ("Oversized - Leg Day - XG") — pedidos espelhados do legado chegam com
 * `tamanho` null e sem isso o agrupamento do misto quebra. Varre os segmentos
 * de trás pra frente porque o tamanho costuma ser o último ("… - M - Rosa" é a
 * exceção coberta).
 */
export function itemSize(it: OrderItem): string | null {
  const direct = it.tamanho?.trim().toUpperCase();
  if (direct) return direct;
  if (!it.nome) return null;
  const tokens = it.nome.split(/\s+[-–]\s+/).map((t) => t.trim().toUpperCase());
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (KNOWN_SIZES.has(tokens[i])) return tokens[i];
  }
  return null;
}

/** Palavras "significativas" de um nome de produto, em minúsculo. */
function palavras(nome: string | null | undefined): Set<string> {
  if (!nome) return new Set();
  return new Set(
    nome
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
}

/**
 * Item do pedido mais PARECIDO com uma tag lida que não pertence a nenhum
 * item dele (`kind === "alheia"` no SeparacaoRunner) — ajuda a operadora a
 * perceber "peguei o produto errado" em vez de achar que é bug de vínculo
 * entre pedidos (caso real do pedido 869033: leu "Oversized - Angel - XG" no
 * lugar de "Oversized - Forget Angel - XG", produto DIFERENTE mas com nome
 * parecido). Critério: entre os itens passados (já filtrados pelo chamador
 * pros que ainda faltam), o de MESMO TAMANHO cujo nome compartilha mais
 * palavras com o nome lido (case-insensitive); sem tamanho lido, sem nome
 * lido, ou sem nenhuma palavra em comum, não há "parecido" (retorna null).
 */
export function itemParecidoDoPedido(
  itens: OrderItem[],
  look: { name?: string | null; size?: string | null },
): OrderItem | null {
  const tamanhoLido = look.size?.trim().toUpperCase();
  if (!tamanhoLido) return null;
  const palavrasLidas = palavras(look.name);
  if (palavrasLidas.size === 0) return null;

  let melhor: OrderItem | null = null;
  let melhorScore = 0;
  for (const it of itens) {
    if (itemSize(it) !== tamanhoLido) continue;
    let score = 0;
    for (const p of palavras(it.nome)) {
      if (palavrasLidas.has(p)) score += 1;
    }
    if (score > melhorScore) {
      melhorScore = score;
      melhor = it;
    }
  }
  return melhor;
}

import type { OrderItem } from "../services/orders";

/** Tamanhos conhecidos pra extrair do nome quando o item vem sem `tamanho`. */
const KNOWN_SIZES = new Set([
  "PP", "P", "M", "G", "GG", "XG", "XXG", "G1", "G2", "G3", "XGG", "U",
]);

/**
 * Apelidos de tamanho — a MESMA régua do nexus (`canonicalizeTamanho` /
 * `SIZE_ALIASES` da ingestão Tiny): `EG`≡`XG`, `EGG`≡`XGG`, `UN`/`UNI`/
 * `UNICO`≡`U`. O servidor compara pelo canônico; sem isto um "EG" aqui era
 * "de outro tamanho" numa fila XG e o Filtro Mistos escondia o que o nexus
 * reservou (revisão 04/11).
 */
const SIZE_ALIASES: Readonly<Record<string, string>> = {
  EG: "XG",
  EGG: "XGG",
  UN: "U",
  UNI: "U",
  UNICO: "U",
  "ÚNICO": "U",
};

/** Tamanho canônico de um token (trim, caixa alta, sem espaço interno, apelidos). */
export function canonicalizeTamanho(value: string | null | undefined): string | null {
  const n = value?.trim().toUpperCase().replace(/\s+/g, "");
  if (!n) return null;
  return SIZE_ALIASES[n] ?? n;
}

/**
 * Tamanho efetivo do item: o campo `tamanho` (normalizado), ou extraído do nome
 * ("Oversized - Leg Day - XG") — pedidos espelhados do legado chegam com
 * `tamanho` null e sem isso o agrupamento do misto quebra. Varre os segmentos
 * de trás pra frente porque o tamanho costuma ser o último ("… - M - Rosa" é a
 * exceção coberta). `sufixoSemHifen` aceita também o token final sem hífen
 * ("Symbol GG") — só pra exibição, nunca pro Filtro Mistos.
 */
export function itemSize(it: OrderItem, opts?: { sufixoSemHifen?: boolean }): string | null {
  const direct = canonicalizeTamanho(it.tamanho);
  if (direct) return direct;
  if (!it.nome) return null;
  const tokens = it.nome.split(/\s+[-–]\s+/).map((t) => canonicalizeTamanho(t) ?? "");
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (KNOWN_SIZES.has(tokens[i])) return tokens[i];
  }
  // Nome sem hífen antes do tamanho ("Symbol GG"): token final do nome. Opt-in:
  // o Filtro Mistos (`tamanhoDaLinha`) segue a régua do nexus e NÃO conta isto;
  // só a exibição do card/ordem na mesa usa.
  if (!opts?.sufixoSemHifen) return null;
  const ultimo = canonicalizeTamanho(it.nome.trim().split(/\s+/).pop());
  if (ultimo && KNOWN_SIZES.has(ultimo)) return ultimo;
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

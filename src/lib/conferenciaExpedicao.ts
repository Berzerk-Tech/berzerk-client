// Conferência da mesa de Expedição — QUANTAS peças do pedido estão na mesa.
//
// A expedição não re-casa produto pra DECIDIR se o pedido fecha: quem decidiu
// o que sai foi a separação. Só que a verdade da separação chega em dois
// formatos, e nenhum dos dois basta sozinho:
//
//  - `orders.rfid_tags` — as tags que a separação gravou. É a lista de peças
//    que TÊM de estar na mesa quando o pedido foi separado NO NEXUS. Pedido
//    separado no LEGADO chega pelo espelho com o que o legado gravou, e lá isso
//    pode ser MENOS de uma tag por peça (#862169, 28/08: 10 itens
//    "Oversized - Surpresa - <tam>", UMA tag em `rfid_tags`).
//  - a grade do pedido — `sum(quantidade)` é quantas peças TÊM de sair.
//
// Por isso a régua é a interseção das duas: o pedido fecha quando (a) todas as
// `rfid_tags` gravadas foram lidas E (b) o número de peças lidas (EPCs
// distintos, cada um contado uma vez) alcança a grade.
//
// O casamento tag×item continua existindo, mas só pra DESENHAR a grade e pra
// dizer se uma peça é "deste pedido": primeiro o produto real (GTIN/SKU, como
// na separação), depois QUALQUER peça real cobre um slot "Surpresa" — é o que
// a separação faz em `surpresaAceita`. A falta dessa segunda etapa era o bug:
// uma Kagehime M nunca casa por GTIN com o item "Oversized - Surpresa - M", e
// a mesa contava 1 peça num pedido de 10.

import type { EpcLookupItem, OrderItem } from "../services/orders";

/** EAN pra comparação como GTIN: só dígitos, sem zeros à esquerda. */
export function normGtin(v: string | null | undefined): string | null {
  const d = v?.replace(/\D/g, "").replace(/^0+/, "");
  return d || null;
}

/**
 * Candidatos GTIN de um lado do casamento: qualquer valor que seja código de
 * barras puro (8–14 dígitos) — o Tiny às vezes manda o EAN no campo SKU.
 */
export function gtinCandidates(...vals: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const v of vals) {
    const t = v?.trim();
    if (t && /^\d{8,14}$/.test(t)) {
      const n = normGtin(t);
      if (n) out.add(n);
    }
  }
  return Array.from(out);
}

/** SKU pra comparação: trim + uppercase. */
export function normSku(v: string | null | undefined): string | null {
  const s = v?.trim().toUpperCase();
  return s || null;
}

/**
 * Slot "Surpresa": o item do pedido é um placeholder que QUALQUER peça real
 * curada preenche. `surpresaPermitidos` vem do nexus na separação; o DTO da
 * expedição não manda esse campo, então o nome do item (do Tiny, literal
 * "Oversized - Surpresa - M") é o reconhecimento que sobra.
 */
export function isSurpresaSlot(it: OrderItem): boolean {
  if (it.surpresaPermitidos && it.surpresaPermitidos.length > 0) return true;
  return /surpresa/i.test(`${it.nome ?? ""} ${it.sku ?? ""}`);
}

export type Conferencia = {
  /** Peças contadas por item (`item.id` → n) — só pra desenhar a grade. */
  porItem: Map<string, number>;
  /** EPCs da mesa que contaram como peça DESTE pedido (o que vai no `ship`). */
  contadas: string[];
  /** EPCs na mesa que não são deste pedido (aviso, igual ao sobressalente). */
  fora: string[];
  /** Tags gravadas pela separação que ainda não apareceram na mesa. */
  faltantes: string[];
  /** Peças lidas = `contadas.length`. */
  lidas: number;
  /** Peças esperadas = soma das quantidades da grade. */
  total: number;
  /** (a) toda `rfid_tags` lida E (b) peças lidas ≥ grade. */
  completo: boolean;
};

/** Produto REAL do pedido que a tag referencia (GTIN, depois SKU textual). */
function casaProdutoReal(
  items: OrderItem[],
  look: EpcLookupItem,
  restante: (it: OrderItem) => number,
): OrderItem | null {
  const tagGtins = gtinCandidates(look.ean13, look.sku);
  const byGtin = items.find(
    (it) =>
      !isSurpresaSlot(it) &&
      restante(it) > 0 &&
      gtinCandidates(it.ean, it.sku).some((g) => tagGtins.includes(g)),
  );
  if (byGtin) return byGtin;
  const lookSku = normSku(look.sku);
  if (!lookSku) return null;
  return (
    items.find((it) => !isSurpresaSlot(it) && normSku(it.sku) === lookSku && restante(it) > 0) ??
    null
  );
}

/**
 * Confere a mesa contra o pedido. Passadas, nesta ordem (a mesma da separação):
 *  1. produto REAL do pedido, por GTIN/SKU;
 *  2. slot "Surpresa" — qualquer peça REAL (resolvida no inventário) ou tag da
 *     própria separação cobre um slot com saldo;
 *  3. tag gravada pela separação que não casou com item nenhum ainda conta como
 *     peça do pedido: a separação já disse que ela é daqui.
 * O que sobra é peça de outro pedido (ou lixo na mesa) → `fora`.
 *
 * `alheias` são EPCs que OUTRO pedido `awaiting_pickup` da mesa reivindica —
 * nunca contam aqui, senão um slot "Surpresa" engoliria a peça do vizinho.
 */
export function conferir(params: {
  items: OrderItem[];
  /** EPCs presentes na mesa (não precisam vir normalizados nem únicos). */
  naMesa: string[];
  /** `orders.rfid_tags` do pedido. */
  rfidTags: string[] | null;
  /** EPC → peça (`rfid.resolveEpcs`). Vazio = lookup indisponível. */
  resolved: Map<string, EpcLookupItem>;
  alheias?: ReadonlySet<string>;
}): Conferencia {
  const { items, rfidTags, resolved, alheias } = params;
  const tags = new Set(
    (rfidTags ?? []).map((t) => t.trim().toUpperCase()).filter(Boolean),
  );

  const naMesa: string[] = [];
  const vistos = new Set<string>();
  for (const raw of params.naMesa) {
    const e = raw.trim().toUpperCase();
    if (!e || vistos.has(e)) continue;
    vistos.add(e);
    naMesa.push(e);
  }

  const porItem = new Map<string, number>();
  const contadas: string[] = [];
  const fora: string[] = [];
  const restante = (it: OrderItem) => it.quantidade - (porItem.get(it.id) ?? 0);
  const conta = (epc: string, it: OrderItem | null) => {
    if (it) porItem.set(it.id, (porItem.get(it.id) ?? 0) + 1);
    contadas.push(epc);
  };

  const sobra: string[] = [];
  for (const epc of naMesa) {
    if (alheias?.has(epc) && !tags.has(epc)) {
      fora.push(epc);
      continue;
    }
    const look = resolved.get(epc);
    const it = look ? casaProdutoReal(items, look, restante) : null;
    if (it) conta(epc, it);
    else sobra.push(epc);
  }

  const semSlot: string[] = [];
  for (const epc of sobra) {
    // Peça que o inventário não reconhece E que a separação não gravou não é
    // "peça real": não pode preencher um slot Surpresa (senão qualquer tag
    // perdida na mesa fecharia o pedido).
    const real = resolved.has(epc) || tags.has(epc);
    const slot = real ? items.find((it) => isSurpresaSlot(it) && restante(it) > 0) : undefined;
    if (slot) conta(epc, slot);
    else semSlot.push(epc);
  }

  for (const epc of semSlot) {
    if (!tags.has(epc)) {
      fora.push(epc);
      continue;
    }
    conta(epc, items.find((it) => restante(it) > 0) ?? null);
  }

  const faltantes = Array.from(tags).filter((t) => !vistos.has(t));
  const total = items.reduce((a, it) => a + it.quantidade, 0);
  const lidas = contadas.length;
  return {
    porItem,
    contadas,
    fora,
    faltantes,
    lidas,
    total,
    completo: faltantes.length === 0 && lidas >= total,
  };
}

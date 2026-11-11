// Listas impressas em aberto no lote de uma operadora (Mistos: até 2), pra
// devolver UMA só com a chave do supervisor (11/11: acabava a peça da Lista 1,
// o supervisor devolvia e a Lista 2 ia junto).
//
// Mesma chave (`listaId ?? listaEm`) e mesma ordem (menor `listaEm` primeiro)
// do chip "Lista N" do card da mesa — o número aqui é o que ela lê na folha.

type PedidoDeLista = { id: string; listaEm?: string | null; listaId?: string | null };

export type ListaDoLote = {
  /** `listaId` quando o servidor manda; senão o carimbo `listaEm`. */
  chave: string;
  /** 1 = a mais antiga. */
  numero: number;
  /** Pedidos da lista que AINDA estão com ela. */
  ids: string[];
};

/** Escolha do diálogo: uma lista (pela chave) ou tudo o que está com ela. */
export const TODAS_AS_LISTAS = "todas";

export function listasDoLote(lote: PedidoDeLista[]): ListaDoLote[] {
  const porChave = new Map<string, { desde: number; ids: string[] }>();
  for (const o of lote) {
    if (!o.listaEm) continue;
    const chave = o.listaId ?? o.listaEm;
    const t = Date.parse(o.listaEm) || 0;
    const atual = porChave.get(chave);
    if (atual) {
      atual.ids.push(o.id);
      if (t < atual.desde) atual.desde = t;
    } else porChave.set(chave, { desde: t, ids: [o.id] });
  }
  return [...porChave.entries()]
    .sort((a, b) => a[1].desde - b[1].desde)
    .map(([chave, v], i) => ({ chave, numero: i + 1, ids: v.ids }));
}

/** Chave da lista de um pedido do lote (null = sem lista impressa). */
export function chaveDaLista(o: PedidoDeLista | null | undefined): string | null {
  if (!o?.listaEm) return null;
  return o.listaId ?? o.listaEm;
}

/**
 * Ids que a devolução leva. `TODAS_AS_LISTAS` (ou chave que não existe mais)
 * = o lote inteiro, como sempre foi; uma chave = só os pedidos daquela lista.
 */
export function idsDaDevolucao(lote: PedidoDeLista[], escolha: string): string[] {
  if (escolha !== TODAS_AS_LISTAS) {
    const lista = listasDoLote(lote).find((l) => l.chave === escolha);
    if (lista) return lista.ids;
  }
  return lote.map((o) => o.id);
}

// "Imprimir e reservar" do Filtro Mistos (10/11/2026, reclamação do chão: duas
// separadoras no mesmo setor mandavam buscar as mesmas peças porque a folha de
// mistos era só de consulta e os pedidos seguiam livres na fila).
//
// Partes PURAS do fluxo — o modal orquestra (aplicar filtro → puxar lista nova →
// carimbar → imprimir) e a tela do runner puxa o lote; aqui ficam só a folha
// calculada em cima do que o servidor REALMENTE reivindicou, os textos de status
// e a tradução dos erros do `lote` com `novaLista` em motivo legível.

import type { Order, QueueFilters } from "../services/orders";
import { limiteListasAbertas, mistosProdutoReservado } from "../services/orders";
import { pedidoMistoDoLote, pickingMistos, type PickingMisto } from "./mistos";

/** Resultado que o runner devolve ao modal depois de aplicar o filtro e puxar a lista nova. */
export type ReservaMistosResultado =
  | {
      ok: true;
      /** Tudo que o servidor reivindicou (mesmo conjunto que o "Tirar nova lista" carimba). */
      novos: Order[];
      /** Ids que já estavam na mão dela (em conferência na mesa / já iniciados): carimbam, mas NÃO entram na folha. */
      foraDaFolha?: string[];
      filtros: QueueFilters;
    }
  | { ok: false; motivo: string };

/** Separa o que vai pra folha do que já estava na mesa (peça já buscada ou em conferência). */
export function separarFolha(novos: Order[], jaNaMesa: (o: Order) => boolean): { paraFolha: Order[]; fora: Order[] } {
  const paraFolha: Order[] = [];
  const fora: Order[] = [];
  for (const o of novos) (jaNaMesa(o) ? fora : paraFolha).push(o);
  return { paraFolha, fora };
}

/** "N pedidos já estavam na sua mesa e não entraram na folha." ("" quando zero). */
export function textoForaDaFolha(n: number): string {
  if (n <= 0) return "";
  return n === 1
    ? "1 pedido já estava na sua mesa e não entrou na folha."
    : `${n} pedidos já estavam na sua mesa e não entraram na folha.`;
}

/** "X de Y carimbados" quando o servidor prendeu menos do que o pedido. */
export function textoCarimbo(presos: number, total: number): string {
  return presos >= total ? "" : `${presos} de ${total} pedidos carimbados.`;
}

export type ReservaDeps = {
  /** Filtros da estação ANTES da reserva (voltam se a reserva falhar). */
  filtrosAnteriores: QueueFilters;
  /** Aplica o filtro na estação SEM puxar o lote (grava também o filtro salvo). */
  aplicarFiltro: (f: QueueFilters) => void;
  /** Puxa a lista nova (`lote` com `novaLista`); `undefined` = a mesa estava ocupada. */
  puxar: () => Promise<Order[] | undefined>;
  /** Ids que já estão na mesa dela (pedido atual + já iniciados), lidos ANTES do puxar. */
  idsNaMesa: () => Iterable<string>;
  /** Erro do `lote` → motivo legível. */
  traduzirErro: (e: unknown) => string;
};

/**
 * Orquestra a reserva: aplica o filtro → puxa a lista nova → em QUALQUER falha
 * restaura os filtros anteriores (a estação não fica presa num filtro que só dá
 * 409). A exclusão do galpão já gravada no servidor não é desfeita aqui.
 */
export async function reservarComRollback(deps: ReservaDeps, f: QueueFilters): Promise<ReservaMistosResultado> {
  deps.aplicarFiltro(f);
  const restaurar = () => deps.aplicarFiltro(deps.filtrosAnteriores);
  try {
    const naMesa = new Set(deps.idsNaMesa());
    const novos = await deps.puxar();
    if (novos === undefined) {
      restaurar();
      return { ok: false, motivo: "A mesa estava sendo atualizada. Tente de novo. Nada foi reservado." };
    }
    if (novos.length === 0) {
      restaurar();
      return { ok: false, motivo: "Fila sem pedidos novos pra esse filtro. Nada foi reservado nem impresso." };
    }
    const { fora } = separarFolha(novos, (o) => naMesa.has(o.id) || !!o.iniciadoEm);
    return { ok: true, novos, foraDaFolha: fora.map((o) => o.id), filtros: f };
  } catch (e) {
    restaurar();
    return { ok: false, motivo: deps.traduzirErro(e) };
  }
}

/** Folha de picking dos pedidos que o servidor entregou (não da promessa do quadro). */
export function folhaDosReservados(
  pedidos: Order[],
  sizeFila: string,
): { pedidos: number; linhas: PickingMisto[] } {
  const linhas = pickingMistos(
    pedidos.map((o) => pedidoMistoDoLote(o, sizeFila)),
    sizeFila,
  );
  return { pedidos: pedidos.length, linhas };
}

/** "Reservados N de M…" — diz o número real quando difere do que o quadro prometia. */
export function textoReservados(reservados: number, prometidos: number): string {
  const p = (n: number) => `${n} pedido${n === 1 ? "" : "s"}`;
  if (reservados === prometidos) return `${p(reservados)} reservado${reservados === 1 ? "" : "s"} pra você.`;
  if (reservados < prometidos) {
    return `Reservados ${reservados} de ${prometidos} pedidos (o servidor entregou menos que o quadro previa: teto do lote ou outra estação pegou antes).`;
  }
  return `Reservados ${reservados} pedidos (o quadro previa ${prometidos}; entraram também pedidos que já estavam na sua mesa sem lista).`;
}

/** Erro do `lote` com `novaLista` → motivo pra mostrar (null = não reconhecido). */
export function motivoDaFalhaDoLote(e: unknown): string | null {
  const limite = limiteListasAbertas(e);
  if (limite) return `${limite.message} Nada foi impresso.`;
  const res = mistosProdutoReservado(e);
  if (res) {
    const quem = res.operadora ? ` por ${res.operadora}` : "";
    return `O produto "${res.termo ?? "?"}" já está reservado${quem}. Nada foi reservado nem impresso — escolha outros produtos.`;
  }
  return null;
}

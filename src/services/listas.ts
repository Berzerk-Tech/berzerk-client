// Listas de picking IMPRESSAS (mistos) — tela "Minhas listas impressas".
//
// Existe por causa do incidente de 02/09: a operadora imprime a lista de
// mistos, o pedido some da mesa (filtro, virada do dia, devolução) e ela fica
// com o papel sem conseguir recuperar os pedidos. `POST /separacao/lote/lista`
// agora guarda um snapshot em `separacao_listas` (ver `marcarListaImpressa` em
// `orders.ts`); os serviços abaixo consultam e recuperam por ele.
//
// Tipos espelham @berzerk/contracts (`packages/contracts/src/separacao-listas.ts`
// no nexus) — o app é repo separado, então duplicamos os shapes.

import { apiRequest } from "../lib/api";
import type { OrderStatus } from "./orders";

/** `escopo` da lista: o recorte que a operadora estava vendo ao imprimir. */
export type ListaEscopo = "lote" | "secao";

/** Item de `GET /separacao/listas`. */
export type ListaResumo = {
  id: string;
  criadoEm: string;
  escopo: ListaEscopo;
  totalPedidos: number;
  totalPecas: number;
  /** Quantos dos pedidos desta lista estão HOJE `ready` e sem claim. */
  pedidosRecuperaveis: number;
  /** `separating` com OUTRA mesa, sem iniciado_em e sem lista — o recuperar retoma (nexus #220; ausente antes). */
  pedidosRetomaveis?: number;
  recuperacoes: number;
  recuperadaEm: string | null;
};

/** Listas da PRÓPRIA operadora (14 dias) — não aceita ver a de outra estação
 *  (o `operadorId` do contrato só vale pra quem tem `separacao:manage`). */
export function getListas(): Promise<{ listas: ListaResumo[] }> {
  return apiRequest<{ listas: ListaResumo[] }>("/separacao/listas");
}

/** Item impresso na lista — recorte mínimo (não é o `OrderItem` completo). */
export type ListaItemSnapshot = {
  nome: string | null;
  tamanho: string | null;
  ean: string | null;
  sku: string | null;
  quantidade: number;
};

/** Pedido no detalhe de `GET /separacao/listas/:id` — snapshot + estado atual. */
export type ListaDetalhePedido = {
  orderId: string;
  numero: string | null;
  tinyAccount: string;
  clienteNome: string | null;
  itens: ListaItemSnapshot[];
  /** `null` quando o pedido não existe mais (não deveria acontecer). */
  statusAtual: OrderStatus | null;
  claimedByAtual: string | null;
  claimedPorMim: boolean;
  separadoEm: string | null;
  /** `true` quando `statusAtual === 'ready'` e sem claim — candidato a recuperar. */
  recuperavel: boolean;
};

export type ListaDetalheResponse = {
  id: string;
  criadoEm: string;
  escopo: ListaEscopo;
  operadorId: string;
  operadorNome: string | null;
  recuperacoes: number;
  recuperadaEm: string | null;
  recuperadaPor: string | null;
  pedidos: ListaDetalhePedido[];
};

export function getListaDetalhe(id: string): Promise<ListaDetalheResponse> {
  return apiRequest<ListaDetalheResponse>(`/separacao/listas/${id}`);
}

/** Motivo de um pedido não ter sido recuperado. */
export type ListaIgnoradoMotivo = "separado" | "com_outra_operadora" | "cancelado" | "expedido" | "outro";

export type ListaIgnorado = {
  numero: string | null;
  motivo: ListaIgnoradoMotivo;
};

/**
 * Resposta de `POST /separacao/listas/:id/recuperar`: reclama pra MESA de
 * quem chama todo `orderId` que ainda está `ready` sem claim, ignorando
 * quarentena e filtros de propósito — recuperar uma lista impressa é decisão
 * de gente, não da fila automática.
 */
export type RecuperarListaResponse = {
  recuperados: number;
  /** Já estavam `separating` com o próprio ator que chamou. */
  jaComigo: number;
  /** Retomados de OUTRA mesa que ainda não tinha começado (nexus #218; ausente em nexus anterior). */
  retomados?: number;
  ignorados: ListaIgnorado[];
};

export function recuperarLista(id: string): Promise<RecuperarListaResponse> {
  return apiRequest<RecuperarListaResponse>(`/separacao/listas/${id}/recuperar`, {
    method: "POST",
    body: {},
  });
}

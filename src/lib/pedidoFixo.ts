/**
 * Qual pedido fica na mesa depois de um REFRESH do lote (WS `queue.changed`,
 * vigia, retorno de foco, troca de filtro...).
 *
 * Regra (10/11, relato das operadoras: "clico no pedido, vou pegar a peça,
 * quando volto está outro"): refresh automático NUNCA troca o pedido. Só ação
 * explícita da operadora muda (clicar num card, concluir, pular, soltar,
 * "Tirar nova lista", recuperar lista) — e essas ações não passam por aqui.
 *
 * - `escolher`: não havia pedido na mesa (ou a ação explícita pede nova
 *   escolha): quem chamou escolhe o próximo pela lista visível.
 * - `manter`: o pedido atual ainda vem na resposta (por id) — fica, com o
 *   objeto atualizado, independente de filtro ou de ter leitura.
 * - `saiu`: o pedido atual não vem mais (devolvido por supervisor, expirado,
 *   redistribuído). A mesa fica sem pedido e avisa; não seleciona outro.
 */
export type DecisaoPedido<T> =
  | { tipo: "escolher" }
  | { tipo: "manter"; pedido: T }
  | { tipo: "saiu" }
  /** Mesa vazia porque o pedido saiu e o refresh é de fundo: segue vazia (aviso fica até ela clicar). */
  | { tipo: "vazio" };

export function proximoPedidoAposRefresh<T extends { id: string }>(args: {
  atual: T | null | undefined;
  orders: readonly T[];
  /** Troca de filtro pela operadora: o pedido que o filtro escondeu cede a vez (quem chama decide). */
  acaoExplicita?: boolean;
  /** Só com `acaoExplicita`: o pedido atual passou a ficar fora do filtro e sem leitura. */
  foraDoFiltroSemLeitura?: boolean;
  /** O pedido saiu antes e a mesa está vazia com o aviso ligado. */
  pedidoSaiu?: boolean;
}): DecisaoPedido<T> {
  const { atual, orders, acaoExplicita, foraDoFiltroSemLeitura } = args;
  if (!atual) return !acaoExplicita && args.pedidoSaiu ? { tipo: "vazio" } : { tipo: "escolher" };
  const aindaMeu = orders.find((o) => o.id === atual.id);
  if (!aindaMeu) return { tipo: "saiu" };
  if (acaoExplicita && foraDoFiltroSemLeitura) return { tipo: "escolher" };
  return { tipo: "manter", pedido: aindaMeu };
}

export const AVISO_PEDIDO_SAIU = "Este pedido saiu da sua mesa. Escolha outro na lista.";

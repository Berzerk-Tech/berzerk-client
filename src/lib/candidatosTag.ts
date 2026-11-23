// Peça lida que não está em nenhum pedido (Expedição, 23/11): o Nexus devolve no
// epc-match os pedidos separados com o mesmo produto e tamanho, e a operadora
// escolhe em qual deles a peça passa a valer (troca de tag). Aqui mora a lógica
// pura: mescla entre chunks, decisão do estado da tela e mensagens por motivo.
// Tudo é opcional no contrato: Nexus antigo não manda `candidatos` e o
// comportamento segue o de sempre.
import type { CandidatoTag, EpcMatchResponse, TrocaTagMotivo } from "../services/expedicao";

/**
 * Junta os candidatos de vários chunks do epc-match: dedupe por EPC, pedidos por
 * id do pedido, `maisPedidos` pelo maior valor. Descarta o candidato cuja peça
 * casou com um pedido noutro chunk (`epcsCasados`) ou já foi expedida e o que
 * ficou sem nenhum pedido.
 */
export function mesclarCandidatos(
  listas: Array<CandidatoTag[] | undefined>,
  excluir: Set<string> = new Set(),
): CandidatoTag[] {
  const porEpc = new Map<string, CandidatoTag>();
  for (const lista of listas) {
    for (const c of lista ?? []) {
      const epc = c.epc.toUpperCase();
      if (excluir.has(epc)) continue;
      const atual = porEpc.get(epc);
      if (!atual) {
        porEpc.set(epc, { ...c, epc, pedidos: [...(c.pedidos ?? [])], maisPedidos: c.maisPedidos ?? 0 });
        continue;
      }
      const ids = new Set(atual.pedidos.map((p) => p.order.id));
      for (const p of c.pedidos ?? []) if (!ids.has(p.order.id)) atual.pedidos.push(p);
      atual.maisPedidos = Math.max(atual.maisPedidos, c.maisPedidos ?? 0);
      atual.nome = atual.nome ?? c.nome;
      atual.tamanho = atual.tamanho ?? c.tamanho;
    }
  }
  return Array.from(porEpc.values()).filter((c) => c.pedidos.length > 0);
}

/**
 * Pedidos do candidato na ordem do servidor (do separado MAIS RECENTEMENTE pro
 * mais antigo: a peça na mão acabou de ser separada). O primeiro é o "Sugerido";
 * não reordenar. Devolve cópia.
 */
export function ordenarPedidosCandidato(c: CandidatoTag): CandidatoTag["pedidos"] {
  return [...c.pedidos];
}

export type SemMatch =
  | { tipo: "ja_expedido" }
  | { tipo: "candidatos"; candidatos: CandidatoTag[]; exigePin: boolean }
  | { tipo: "aviso" };

/**
 * Decide o que a mesa mostra quando o epc-match volta SEM pedido. Já expedido é
 * definitivo e vence; depois candidatos (se há ao menos um pedido); senão o
 * aviso antigo com retry (também o caminho do Nexus que não manda o campo).
 */
export function decidirSemMatch(res: Pick<EpcMatchResponse, "jaExpedidos" | "candidatos" | "trocaTagExigePin">): SemMatch {
  if (res.jaExpedidos?.length) return { tipo: "ja_expedido" };
  const candidatos = (res.candidatos ?? []).filter((c) => (c.pedidos ?? []).length > 0);
  if (candidatos.length > 0) return { tipo: "candidatos", candidatos, exigePin: res.trocaTagExigePin === true };
  return { tipo: "aviso" };
}

const MENSAGENS: Record<TrocaTagMotivo, string> = {
  status_mudou: "Esse pedido já saiu da embalagem.",
  tag_ja_vinculada: "Essa peça já está em outro pedido.",
  tag_atual_mudou: "O pedido mudou, leia de novo.",
  produto_diferente: "Essa peça não é do mesmo produto e tamanho.",
};

/** Mensagem da recusa 409 `troca_tag_recusada` por motivo (motivo desconhecido = genérica). */
export function mensagemTrocaTag(motivo: string | null | undefined): string {
  return (motivo && (MENSAGENS as Record<string, string>)[motivo]) || "Não foi possível usar esta peça neste pedido. Leia de novo.";
}

/** Interpreta o corpo de erro da troca: recusa (409), exige PIN (422) ou outro. */
export function classificarErroTrocaTag(
  body: unknown,
): { tipo: "recusada"; motivo: string | null } | { tipo: "exige_pin" } | { tipo: "outro" } {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (b.error === "troca_tag_exige_pin") return { tipo: "exige_pin" };
  if (b.error === "troca_tag_recusada") {
    return { tipo: "recusada", motivo: typeof b.motivo === "string" ? b.motivo : null };
  }
  return { tipo: "outro" };
}

/** "Nome - Tamanho" da peça lida, pro subtítulo. */
export function rotuloPecaLida(c: Pick<CandidatoTag, "nome" | "tamanho">): string {
  return [c.nome, c.tamanho].filter((x): x is string => !!x && x.trim() !== "").join(" · ") || "Peça sem cadastro";
}

/** Resumo dos itens do pedido: "2x Nome (M), Nome 2 (G)" cortado em `max` itens. */
export function resumoItens(
  items: Array<{ nome: string | null; tamanho?: string | null; quantidade: number }>,
  max = 3,
): string {
  const partes = items.slice(0, max).map((i) => `${i.quantidade > 1 ? `${i.quantidade}x ` : ""}${i.nome ?? "Item"}${i.tamanho ? ` (${i.tamanho})` : ""}`);
  const resto = items.length - max;
  return partes.join(", ") + (resto > 0 ? ` e mais ${resto}` : "");
}

/**
 * Prepara os candidatos da resposta antes de abrir a tela: tira as peças que a
 * operadora já cancelou (enquanto seguem na mesa) e os pedidos que não são do
 * canal da mesa. Candidato sem pedido restante não abre a tela.
 */
export function prepararCandidatos(
  candidatos: CandidatoTag[] | undefined,
  opcoes: { ignorar?: Set<string>; pedidoDoCanal: (order: CandidatoTag["pedidos"][number]["order"]) => boolean },
): CandidatoTag[] {
  return (candidatos ?? [])
    .filter((c) => !opcoes.ignorar?.has(c.epc.toUpperCase()))
    .map((c) => ({ ...c, pedidos: (c.pedidos ?? []).filter((p) => opcoes.pedidoDoCanal(p.order)) }))
    .filter((c) => c.pedidos.length > 0);
}

/**
 * Depois de uma troca com sucesso no pedido `pedidoId`: o que sobra da lista
 * original para continuar na tela. Fica só quem ainda está na mesa e tem esse
 * mesmo pedido entre os candidatos, já restrito a ele. Descarta quem dependia da
 * tag que acabou de ser trocada (`epcAtual` fora das tags atuais do pedido):
 * essa fica pro próximo ciclo.
 */
export function restantesAposTroca(
  restantes: CandidatoTag[],
  pedidoId: string,
  naMesa: Set<string>,
  tagsAtuaisDoPedido: string[],
): CandidatoTag[] {
  const atuais = new Set(tagsAtuaisDoPedido.map((t) => t.toUpperCase()));
  const out: CandidatoTag[] = [];
  for (const c of restantes) {
    if (!naMesa.has(c.epc.toUpperCase())) continue;
    const p = c.pedidos.find((x) => x.order.id === pedidoId);
    if (!p) continue;
    if (p.epcAtual && !atuais.has(p.epcAtual.toUpperCase())) continue;
    out.push({ ...c, pedidos: [p], maisPedidos: 0 });
  }
  return out;
}

/**
 * Pedido identificado com peça faltando (`tagsFaltantes`) e peça lida fora de
 * pedido que é candidata a ELE: oferece a troca restrita a esse pedido. Sem
 * faltante, ou sem candidato pra ele, devolve vazio (fluxo normal).
 */
export function candidatosParaFaltante(
  candidatos: CandidatoTag[] | undefined,
  match: { order: { id: string }; tagsFaltantes: string[] },
): CandidatoTag[] {
  if (!match.tagsFaltantes || match.tagsFaltantes.length === 0) return [];
  const out: CandidatoTag[] = [];
  for (const c of candidatos ?? []) {
    const p = c.pedidos.find((x) => x.order.id === match.order.id);
    if (p) out.push({ ...c, pedidos: [p], maisPedidos: 0 });
  }
  return out;
}

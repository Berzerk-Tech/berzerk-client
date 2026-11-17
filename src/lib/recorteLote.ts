// Recorte de EXIBIÇÃO do lote da mesa de separação: que pedido o filtro local
// (data, produto, só únicos, Filtro Mistos) e as exclusões do galpão escondem da
// sidebar, e POR QUÊ. O filtro governa o que é PUXADO da fila; pedido de LISTA
// IMPRESSA (`listaEm`) já está na folha dela e nunca é escondido por filtro —
// senão 87 pedidos sumiam por causa de um chip de data de ontem (16/11).
//
// DEVOLUÇÃO NA TROCA DE FILTRO (16/11): o claim do servidor (`lote()`) devolve
// a posse fora do recorte (sem `iniciado_em`, lista ou entrega em mãos), mas
// quando NÃO há claim (mesa presa em lista → `getMeusPedidos`) ou o servidor não
// enxerga o filtro (só "só únicos"), o client devolve ANTES de puxar
// (`pedidosDevolviveisPorFiltro`). `devolverLote` não protege `iniciado_em`:
// o client é a única proteção, por isso o pedido da mesa nunca vai na lista.
import type { Order, QueueFilters } from "../services/orders";
import { visivelNoFiltroMistos } from "./mistos";

/** Dia de emissão do pedido em `YYYY-MM-DD` **no fuso de São Paulo** — o mesmo
 *  `at time zone 'America/Sao_Paulo'` que o servidor usa. A estação pode estar
 *  em outro fuso; o dia da operação é sempre o de SP. */
export function diaDeEmissao(o: Order): string | null {
  if (!o.dataEmissao) return null;
  const d = new Date(o.dataEmissao);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

/** Algum item do pedido cujo nome contém algum dos termos (mesmo `ilike %t%`). */
export function pedidoTemProduto(o: Order, termos: string[]): boolean {
  const alvos = termos.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0);
  if (alvos.length === 0) return false;
  return o.items.some((it) => {
    const nome = (it.nome ?? "").toLowerCase();
    return alvos.some((t) => nome.includes(t));
  });
}

/** Só o recorte de PRODUTO — usado onde a DATA é o que está sendo enumerado. */
export function passaNosProdutos(o: Order, f: QueueFilters, sizeFila = ""): boolean {
  if (f.includeProducts?.length && !pedidoTemProduto(o, f.includeProducts)) return false;
  if (f.excludeProducts?.length && pedidoTemProduto(o, f.excludeProducts)) return false;
  // Só únicos: esconde só quem o servidor disse que NÃO é único (campo ausente = não filtra aqui).
  if (f.soUnicos && o.unico === false && !o.listaEm) return false;
  // Filtro Mistos: só o misto cujas peças de outro tamanho são todas dos
  // produtos marcados. Pedido sem `predominantSize` usa o tamanho da FILA —
  // com "" toda peça virava "de outro tamanho" e o pedido sumia da sidebar
  // enquanto o servidor o mantinha reservado pra ela (revisão 04/11).
  if (f.mistosProdutos?.length && o.separationMode === "total") {
    // Pedido de lista impressa nunca some da mesa (ver `visivelNoFiltroMistos`).
    return visivelNoFiltroMistos(o, f.mistosProdutos, o.predominantSize?.trim() || sizeFila);
  }
  return true;
}

export type MotivoOculto = "data" | "galpao" | "produto" | "unicos" | "mistos";

/**
 * Por que o pedido fica fora do recorte (`null` = visível). Precedência: data →
 * produto em falta do galpão → filtro de produto dela → só únicos → Filtro
 * Mistos. `f` são os filtros EFETIVOS (local ∪ galpão); `termosGalpao` os
 * termos globais, já dentro de `f.excludeProducts`, só pra separar o motivo.
 */
export function motivoOculto(
  o: Order,
  f: QueueFilters,
  sizeFila = "",
  termosGalpao: string[] = [],
): MotivoOculto | null {
  // Lista impressa é dela até concluir ou devolver: o filtro não a esconde.
  if (o.listaEm) return null;
  if (f.dateFrom || f.dateTo) {
    // Pedido sem data de emissão não passa em filtro de data — é o que o SQL
    // faz (`null::date >= x` é NULL, e NULL não entra no WHERE).
    const dia = diaDeEmissao(o);
    if (!dia) return "data";
    if (f.dateFrom && dia < f.dateFrom) return "data";
    if (f.dateTo && dia > f.dateTo) return "data";
  }
  if (termosGalpao.length > 0 && pedidoTemProduto(o, termosGalpao)) return "galpao";
  if (f.includeProducts?.length && !pedidoTemProduto(o, f.includeProducts)) return "produto";
  if (f.excludeProducts?.length && pedidoTemProduto(o, f.excludeProducts)) return "produto";
  if (f.soUnicos && o.unico === false) return "unicos";
  if (f.mistosProdutos?.length && o.separationMode === "total") {
    if (!visivelNoFiltroMistos(o, f.mistosProdutos, o.predominantSize?.trim() || sizeFila)) return "mistos";
  }
  return null;
}

/** O pedido passa pelos filtros ATIVOS (data de emissão + inclui/exclui produto…). */
export function passaNosFiltros(o: Order, f: QueueFilters, sizeFila = ""): boolean {
  return motivoOculto(o, f, sizeFila) === null;
}

export type OcultosPorMotivo = Record<MotivoOculto, number> & { total: number };

/** Conta os pedidos do lote fora do recorte, por motivo (cada pedido num só). */
export function contarOcultos(
  lote: Order[],
  f: QueueFilters,
  sizeFila = "",
  termosGalpao: string[] = [],
): OcultosPorMotivo {
  const out: OcultosPorMotivo = { data: 0, galpao: 0, produto: 0, unicos: 0, mistos: 0, total: 0 };
  for (const o of lote) {
    const m = motivoOculto(o, f, sizeFila, termosGalpao);
    if (!m) continue;
    out[m] += 1;
    out.total += 1;
  }
  return out;
}

/** Texto de um motivo, já com singular/plural. */
function textoDoMotivo(m: MotivoOculto, n: number): string {
  switch (m) {
    case "data":
      return `${n} ${n === 1 ? "de outra data" : "de outras datas"}`;
    case "galpao":
      return `${n} com produto em falta`;
    case "produto":
      return `${n} pelo filtro de produto`;
    case "unicos":
      return `${n} não são únicos`;
    case "mistos":
      return `${n} pelo Filtro Mistos`;
  }
}

export const ORDEM_MOTIVOS: readonly MotivoOculto[] = ["data", "galpao", "produto", "unicos", "mistos"];

/** Só os motivos > 0, na ordem de precedência: `[["data", "74 de outras datas"], …]`. */
export function partesDosOcultos(c: OcultosPorMotivo): { motivo: MotivoOculto; texto: string }[] {
  return ORDEM_MOTIVOS.filter((m) => c[m] > 0).map((m) => ({ motivo: m, texto: textoDoMotivo(m, c[m]) }));
}

/** "87 ocultos: 74 de outras datas · 13 com produto em falta". */
export function resumoDosOcultos(c: OcultosPorMotivo): string {
  if (c.total === 0) return "";
  const partes = partesDosOcultos(c).map((p) => p.texto).join(" · ");
  return `${c.total} ${c.total === 1 ? "oculto" : "ocultos"}${partes ? `: ${partes}` : ""}`;
}

// ---------------------------------------------------------------------------
// Devolução por troca de filtro (16/11, supervisor Matheus)
// ---------------------------------------------------------------------------

export type DevolviveisPorFiltro = {
  /** Ids a devolver à fila, na ordem do lote. */
  ids: string[];
  /** Quantos de cada motivo (o `galpao` nunca entra). */
  porMotivo: OcultosPorMotivo;
};

/**
 * Quais pedidos do lote a TROCA EXPLÍCITA de filtro devolve à fila: os que
 * ficaram fora do filtro novo e que a operadora ainda não tocou. Na dúvida,
 * fica com ela — só é devolvido o que é seguro soltar:
 *  - lista impressa (`listaEm`): já está na folha, nunca é devolvida por filtro
 *    (o servidor também recusaria com 409 `lista_impressa`);
 *  - entrega em mãos, prioritário (na troca com claim é o servidor que decide) e
 *    pedido fixado/escolhido à mão;
 *  - pedido já aberto pra conferir (`iniciadoEm` ou `protegidos`: o da mesa,
 *    os que ela abriu nesta sessão);
 *  - pedido escondido pela exclusão do GALPÃO: isso não é escolha dela e o
 *    servidor já o trata à parte.
 */
export function pedidosDevolviveisPorFiltro(
  lote: Order[],
  f: QueueFilters,
  opts: { sizeFila?: string; termosGalpao?: string[]; protegidos?: ReadonlySet<string> } = {},
): DevolviveisPorFiltro {
  const protegidos = opts.protegidos ?? new Set<string>();
  const porMotivo: OcultosPorMotivo = { data: 0, galpao: 0, produto: 0, unicos: 0, mistos: 0, total: 0 };
  const ids: string[] = [];
  for (const o of lote) {
    if (o.listaEm || o.entregaEmMaos || o.prioritario || o.iniciadoEm || protegidos.has(o.id)) continue;
    const m = motivoOculto(o, f, opts.sizeFila ?? "", opts.termosGalpao ?? []);
    if (!m || m === "galpao") continue;
    ids.push(o.id);
    porMotivo[m] += 1;
    porMotivo.total += 1;
  }
  return { ids, porMotivo };
}

/** "34 pedidos de outras datas voltaram pra fila." (motivo único) ou, misturado, "… fora do filtro …". */
export function avisoDevolvidosPorFiltro(c: OcultosPorMotivo): string {
  const n = c.total;
  if (n === 0) return "";
  const volt = n === 1 ? "voltou" : "voltaram";
  const ped = n === 1 ? "pedido" : "pedidos";
  const unico = ORDEM_MOTIVOS.filter((m) => c[m] > 0);
  const motivo = unico.length === 1 ? unico[0] : null;
  const de =
    motivo === "data"
      ? n === 1 ? "de outra data" : "de outras datas"
      : motivo === "produto"
        ? "pelo filtro de produto"
        : motivo === "unicos"
          ? n === 1 ? "que não é único" : "que não são únicos"
          : motivo === "mistos"
            ? "pelo Filtro Mistos"
            : "fora do filtro";
  return `${n} ${ped} ${de} ${volt} pra fila.`;
}

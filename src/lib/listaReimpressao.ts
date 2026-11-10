// Reimpressão de uma lista pelo SNAPSHOT do servidor (`GET /separacao/listas/:id`).
//
// A folha sai com o que foi impresso: TODOS os pedidos e itens do snapshot,
// inclusive os que já foram concluídos/soltos (nada é removido — a folha é a
// lista como foi impressa). Usa os MESMOS geradores da impressão original
// (`gerarMistosPdf` / `gerarPickingPdf`), que são agregados por produto e não
// listam pedido a pedido; por isso "já concluído" vira contagem no cabeçalho,
// não risco por pedido. NÃO carimba nem cria snapshot novo.

import type { ListaDetalhePedido, ListaDetalheResponse, ListaItemSnapshot } from "../services/listas";
import type { MistosDoc } from "./mistosPdf";
import type { PickingDoc, PickingSecao } from "./pickingPdf";
import { canonicalizeTamanho, itemSize } from "./itemParecido";
import { pickingMistos, produtoDe, type PecaMisto, type PedidoMisto } from "./mistos";
import { ordenarPorTamanho } from "./tamanhos";
import type { OrderItem } from "../services/orders";

const SEM_TAMANHO = "SEM TAMANHO";

/** Pedido já concluído/solto (saiu da separação): separado, expedido ou cancelado. */
export function pedidoConcluido(p: ListaDetalhePedido): boolean {
  return !!p.separadoEm || p.statusAtual === "awaiting_pickup" || p.statusAtual === "shipped" || p.statusAtual === "cancelled";
}

function tamanhoDoItem(it: ListaItemSnapshot): string {
  return itemSize({ nome: it.nome, tamanho: it.tamanho } as OrderItem) ?? "";
}

/** Tamanho predominante do pedido: o de mais peças; empate vai pro 1º item. */
function predominanteDoPedido(p: ListaDetalhePedido): string {
  const soma = new Map<string, number>();
  for (const it of p.itens) {
    const t = tamanhoDoItem(it);
    if (t) soma.set(t, (soma.get(t) ?? 0) + it.quantidade);
  }
  let melhor = "";
  let max = 0;
  for (const [t, q] of soma) {
    if (q > max) {
      melhor = t;
      max = q;
    }
  }
  return melhor;
}

/** Lista de mistos só quando o servidor disser (`modo`). */
export function listaEhMistos(d: ListaDetalheResponse): boolean {
  if (d.modo === "mistos") return true;
  if (d.modo === "picking") return false;
  // Sem `modo` do servidor: picking (lista tudo). A impressão original só usa a
  // folha de mistos com o Filtro Mistos ativo, e isso o snapshot não diz.
  return false;
}

function pecas(p: ListaDetalhePedido): PecaMisto[] {
  return p.itens
    .filter((it) => it.nome?.trim())
    .map((it) => {
      const nome = it.nome!.trim();
      const tamanho = tamanhoDoItem(it);
      return {
        produto: produtoDe(nome, tamanho || null),
        nome,
        tamanho,
        quantidade: it.quantidade,
        imagemUrl: it.imagemUrl ?? null,
        ean: it.ean,
      };
    });
}

function dataHora(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // Mesmo fuso do resto do client: o dia da operação é o de SP.
  const f = d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "America/Sao_Paulo" });
  return f.replace(",", "");
}

export function textoReimpressao(d: ListaDetalheResponse): string {
  const concl = d.pedidos.filter(pedidoConcluido).length;
  return `REIMPRESSÃO — lista de ${dataHora(d.criadoEm)}` + (concl > 0 ? ` · ${concl}/${d.pedidos.length} concluídos` : "");
}

export type Reimpressao =
  | { tipo: "mistos"; doc: MistosDoc }
  | { tipo: "picking"; doc: PickingDoc };

/** Monta o documento a imprimir a partir do snapshot. Puro. */
export function montarReimpressao(d: ListaDetalheResponse, operadora: string): Reimpressao {
  const reimpressao = textoReimpressao(d);
  if (listaEhMistos(d)) {
    // Fila = tamanho predominante mais comum entre os pedidos.
    const contagem = new Map<string, number>();
    for (const p of d.pedidos) {
      const pr = predominanteDoPedido(p);
      if (pr) contagem.set(pr, (contagem.get(pr) ?? 0) + 1);
    }
    const fila = [...contagem.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "M";
    const pedidos: PedidoMisto[] = d.pedidos.map((p) => {
      const todas = pecas(p);
      const pred = predominanteDoPedido(p) || fila;
      return {
        id: p.orderId,
        numero: p.numero,
        dataEmissao: null,
        pred,
        fora: todas.filter((x) => x.tamanho !== pred),
        dele: todas.filter((x) => x.tamanho === pred),
        noLote: true,
      };
    });
    const linhas = pickingMistos(
      pedidos.filter((p) => p.fora.length > 0),
      fila,
    );
    return {
      tipo: "mistos",
      doc: { fila, pedidos: pedidos.filter((p) => p.fora.length > 0).length, linhas, reimpressao },
    };
  }

  // Picking Geral: uma seção por tamanho, produtos somados.
  const porTamanho = new Map<string, Map<string, { produto: string; qtd: number; ids: Set<string> }>>();
  for (const p of d.pedidos) {
    for (const x of pecas(p)) {
      const t = x.tamanho || SEM_TAMANHO;
      let prods = porTamanho.get(t);
      if (!prods) porTamanho.set(t, (prods = new Map()));
      const chave = x.produto.trim().toLowerCase();
      const g = prods.get(chave) ?? { produto: x.produto, qtd: 0, ids: new Set<string>() };
      g.qtd += x.quantidade;
      g.ids.add(p.orderId);
      prods.set(chave, g);
    }
  }
  const secoes = ordenarPorTamanho(
    [...porTamanho.entries()].map(([tamanho, prods]) => {
      const linhas = [...prods.values()].sort((a, b) => b.qtd - a.qtd || a.produto.localeCompare(b.produto, "pt-BR"));
      const ids = new Set(linhas.flatMap((l) => [...l.ids]));
      return {
        tamanho,
        produtos: linhas.length,
        itens: linhas.reduce((a, l) => a + l.qtd, 0),
        pedidos: ids.size,
        linhas: linhas.map((l) => ({ produto: l.produto, qtd: l.qtd })),
      } satisfies PickingSecao;
    }),
    (s) => canonicalizeTamanho(s.tamanho),
  );
  return {
    tipo: "picking",
    doc: {
      operadora,
      fila: "Reimpressão",
      escopo: `${d.pedidos.length} pedidos · lista de ${dataHora(d.criadoEm)}`,
      observacao: reimpressao,
      secoes,
    },
  };
}

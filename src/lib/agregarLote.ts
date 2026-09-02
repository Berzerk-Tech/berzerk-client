import type { Order, QueueProduct, SeparationMode } from "../services/orders";

/**
 * Agrega os itens do LOTE (já em memória — nenhuma ida à rede) na mesma forma
 * que `GET /separacao/queue-products` devolve: uma linha por (nome, tamanho,
 * ean) nos mistos, por nome nos puros.
 *
 * É este o agregado que a operadora precisa: o Picking Geral vinha somando a
 * FILA INTEIRA (637 pedidos) quando a folha que ela leva pra prateleira é a
 * dos 10 (ou 50) que estão na mesa dela. O Filtro Inteligente usa o mesmo
 * agregado pra listar o que está NO LOTE — o `queue-products` do nexus só
 * enxerga a fila (pedidos sem `claimedBy`), então o que ela já puxou não
 * aparecia lá (relato de 02/09: "a calça XG do meu pedido não está no filtro").
 */
export function agregarLote(lote: Order[], mode: SeparationMode): QueueProduct[] {
  const acc = new Map<
    string,
    { nome: string; tamanho: string | null; ean: string | null; imagemUrl: string | null; quantidade: number; orderIds: Set<string> }
  >();
  for (const pedido of lote) {
    for (const it of pedido.items) {
      const nome = it.nome?.trim();
      if (!nome) continue;
      const tamanho = it.tamanho?.trim().toUpperCase() || null;
      const chave = chaveProduto(mode, nome, tamanho, it.ean);
      const linha = acc.get(chave);
      if (linha) {
        linha.quantidade += it.quantidade;
        linha.orderIds.add(pedido.id);
        if (!linha.ean && it.ean) linha.ean = it.ean;
        if (!linha.imagemUrl && it.imagemUrl) linha.imagemUrl = it.imagemUrl;
      } else {
        acc.set(chave, {
          nome,
          tamanho,
          ean: it.ean,
          imagemUrl: it.imagemUrl,
          quantidade: it.quantidade,
          orderIds: new Set([pedido.id]),
        });
      }
    }
  }
  return [...acc.values()]
    .map((a) => ({
      nome: a.nome,
      tamanho: a.tamanho,
      ean: a.ean,
      imagemUrl: a.imagemUrl,
      quantidade: a.quantidade,
      pedidos: a.orderIds.size,
      orderIds: [...a.orderIds],
    }))
    .sort(ordemProduto);
}

/** Chave de agregação — a mesma do nexus (`queueProducts`): mistos por
 *  nome+tamanho+ean, puros só por nome. */
export function chaveProduto(
  mode: SeparationMode,
  nome: string,
  tamanho: string | null | undefined,
  ean: string | null | undefined,
): string {
  const n = nome.trim().toUpperCase();
  return mode === "total" ? `${n}|${(tamanho ?? "").trim().toUpperCase()}|${ean ?? ""}` : n;
}

export function ordemProduto(a: QueueProduct, b: QueueProduct): number {
  return a.nome.localeCompare(b.nome, "pt-BR") || (a.tamanho ?? "").localeCompare(b.tamanho ?? "");
}

/**
 * Fila (servidor) ∪ lote (memória), pro Filtro Inteligente. Os `orderIds` são
 * disjuntos por construção — o servidor só devolve pedidos sem dono, o lote é
 * o que tem dono — então somar quantidade e unir ids não conta em dobro.
 */
export function mesclarProdutos(
  mode: SeparationMode,
  daFila: QueueProduct[],
  doLote: QueueProduct[],
): (QueueProduct & { noLote: boolean })[] {
  const acc = new Map<string, QueueProduct & { noLote: boolean }>();
  for (const p of daFila) {
    acc.set(chaveProduto(mode, p.nome, p.tamanho, p.ean), { ...p, orderIds: [...p.orderIds], noLote: false });
  }
  for (const p of doLote) {
    const k = chaveProduto(mode, p.nome, p.tamanho, p.ean);
    const atual = acc.get(k);
    if (atual) {
      const ids = new Set([...atual.orderIds, ...p.orderIds]);
      acc.set(k, {
        ...atual,
        quantidade: atual.quantidade + p.quantidade,
        orderIds: [...ids],
        pedidos: ids.size,
        ean: atual.ean ?? p.ean,
        imagemUrl: atual.imagemUrl ?? p.imagemUrl,
        noLote: true,
      });
    } else {
      acc.set(k, { ...p, orderIds: [...p.orderIds], noLote: true });
    }
  }
  return [...acc.values()].sort(ordemProduto);
}

// Filtro Mistos — a regra, num lugar só (protótipo do Lucas, 04/11/2026,
// `separacao-dev.html` + `filtro-mistos-prompts.md`).
//
// Cada pedido misto pertence à fila do seu tamanho predominante: 1 Leg Day M +
// 1 Zeus M + 1 Myth G é um "misto do M". As peças do M saem da própria fila do
// M; só as peças de OUTRO tamanho (o Myth G) precisam vir de um picking. O
// Filtro Mistos marca PRODUTOS (produto inteiro, todos os tamanhos de P a XG)
// e deixa na fila só os mistos cujas peças de outro tamanho são TODAS desses
// produtos — assim uma separação pega poucos produtos da prateleira e fecha
// muitos mistos de uma vez (vazão da Black).
//
// Tudo aqui é puro: o modal, a sidebar, o painel do pedido, o Picking Geral e
// a etiqueta Zebra calculam em cima destas funções. O nexus aplica a MESMA
// regra no claim (`mistosProdutos` no body — ver NEXUS_FILTRO_MISTOS.md); o
// client reaplica em memória, como já faz com Exclusão/Adição.

import type { Order, OrderItem, QueueProduct } from "../services/orders";
import { itemSize } from "./itemParecido";

/** Tamanhos que entram no Filtro Mistos. Peça em PP/G3/XXG etc. deixa o pedido de fora. */
export const TAMANHOS_MISTOS: readonly string[] = ["P", "M", "G", "GG", "XG"];

/**
 * Sufixo de tamanho no FIM do nome. A MESMA regra do nexus (`produto-de.ts`,
 * contrato em NEXUS_FILTRO_MISTOS.md): exige separador antes (hífen ou
 * espaço) — sem isso "Regata Gym" com tamanho M virava "Regata Gy". Número
 * solto só depois de hífen ("… - 42"), senão "Short Dry Fit 2 em 1" perdia o 1.
 */
const TAMANHOS_SUFIXO = "PP|P|M|G|GG|XG|XXG|XGG|EG|G\\d";
const SUFIXO_GENERICO = new RegExp(`(?:\\s*-\\s*(?:${TAMANHOS_SUFIXO}|\\d+)|\\s+(?:${TAMANHOS_SUFIXO}))\\s*$`, "i");

function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Regex "termina com este(s) tamanho(s)", em cache — roda por item a cada leitura RFID. */
const cacheSufixo = new Map<string, RegExp>();
function regexDosTamanhos(tamanhos: string[]): RegExp {
  const chave = tamanhos.join("|");
  let re = cacheSufixo.get(chave);
  if (!re) {
    re = new RegExp(`(?:\\s*-\\s*|\\s+)(?:${tamanhos.map(escRe).join("|")})\\s*$`, "i");
    cacheSufixo.set(chave, re);
  }
  return re;
}

/**
 * Nome do PRODUTO: o nome da peça sem o tamanho do fim ("Oversized - Baki - G"
 * → "Oversized - Baki"). Tira primeiro o tamanho conhecido (canônico do campo
 * ou do nome, e o cru do campo), depois o sufixo genérico; se sobrou vazio,
 * devolve o nome original. Prefira sempre o campo `produto` quando o nexus
 * mandar — isto é o fallback, e tem que bater com o servidor.
 */
export function produtoDe(nome: string, tamanho?: string | null): string {
  const original = nome.trim();
  const candidatos = new Set<string>();
  const canonico = itemSize({ nome: original, tamanho: tamanho ?? null } as OrderItem);
  if (canonico) candidatos.add(canonico);
  const cru = tamanho?.trim();
  if (cru) candidatos.add(cru);
  let r = original;
  if (candidatos.size > 0) r = r.replace(regexDosTamanhos([...candidatos]), "");
  r = r.replace(SUFIXO_GENERICO, "").trim();
  return r === "" ? original : r;
}

/** Chave de comparação do produto (o filtro guarda o nome de exibição). */
export function chaveMisto(produto: string): string {
  return produto.trim().toLowerCase();
}

/**
 * Tamanho efetivo de uma linha do `queue-products` — a MESMA regra dos itens
 * do lote (`itemSize`: campo, senão último segmento " - " do nome). Linha com
 * tamanho só por espaço ("… Symbol GG") fica sem tamanho aqui E no nexus, e
 * por isso nunca fecha: não pode "fechar" no modal e sumir no runner.
 */
export function tamanhoDaLinha(p: Pick<QueueProduct, "nome" | "tamanho">): string {
  return itemSize({ nome: p.nome, tamanho: p.tamanho } as OrderItem) ?? "";
}

export type PecaMisto = {
  produto: string;
  nome: string;
  tamanho: string;
  quantidade: number;
  imagemUrl: string | null;
  ean: string | null;
};

export type PedidoMisto = {
  id: string;
  numero: string | null;
  dataEmissao: string | null;
  /** Tamanho predominante — a fila a que o pedido pertence. */
  pred: string;
  /** Peças de OUTRO tamanho — o que precisa vir de um picking. */
  fora: PecaMisto[];
  /** Peças do tamanho da fila — saem da própria bancada. */
  dele: PecaMisto[];
  /** Já está no lote da operadora (itens exatos) ou ainda está na fila (reconstruído). */
  noLote: boolean;
};

function pecaDoItem(it: OrderItem): PecaMisto | null {
  const nome = it.nome?.trim();
  if (!nome) return null;
  const tamanho = itemSize(it) ?? "";
  return {
    produto: it.produto?.trim() || produtoDe(nome, tamanho || null),
    nome,
    tamanho,
    quantidade: it.quantidade,
    imagemUrl: it.imagemUrl,
    ean: it.ean,
  };
}

/** Pedido do LOTE (itens exatos) na forma do Filtro Mistos. */
export function pedidoMistoDoLote(o: Order, sizeFila: string): PedidoMisto {
  const pred = (o.predominantSize?.trim().toUpperCase() || sizeFila).toUpperCase();
  const pecas = o.items.map(pecaDoItem).filter((p): p is PecaMisto => p !== null);
  return {
    id: o.id,
    numero: o.numero ?? o.tinyOrderId ?? null,
    dataEmissao: o.dataEmissao ?? null,
    pred,
    fora: pecas.filter((p) => p.tamanho !== pred),
    dele: pecas.filter((p) => p.tamanho === pred),
    noLote: true,
  };
}

/**
 * Pedidos mistos da FILA, reconstruídos do `GET /separacao/queue-products`
 * (uma linha por produto+tamanho com os `orderIds`). O nexus não devolve a
 * quantidade POR PEDIDO: quando o cliente levou 2 iguais, a sobra vai pros
 * primeiros pedidos da lista — a CONTAGEM de pedidos e o ranking ficam
 * exatos, só a soma de peças pode variar em ±1 nesses casos raros (o lote em
 * memória, que é o que vai pra etiqueta, tem os itens exatos).
 *
 * `pred` de um pedido da fila é o tamanho da fila (`sizeFila`); se o pedido
 * não tem nenhuma peça desse tamanho mas tem de outro tamanho do mesmo bucket
 * (`sizesBucket`: XG cobre XXG/G1…), esse outro é o predominante.
 */
export function pedidosMistosDaFila(
  fila: QueueProduct[],
  sizeFila: string,
  sizesBucket: readonly string[] = [sizeFila],
): PedidoMisto[] {
  const size = sizeFila.trim().toUpperCase();
  const bucket = new Set(sizesBucket.map((s) => s.trim().toUpperCase()));
  const porPedido = new Map<string, PecaMisto[]>();
  for (const linha of fila) {
    const ids = linha.orderIds ?? [];
    if (ids.length === 0) continue;
    const tamanho = tamanhoDaLinha(linha);
    const produto = linha.produto?.trim() || produtoDe(linha.nome, tamanho || null);
    const base = Math.floor(linha.quantidade / ids.length);
    const resto = linha.quantidade % ids.length;
    ids.forEach((id, k) => {
      const arr = porPedido.get(id) ?? [];
      arr.push({
        produto,
        nome: linha.nome,
        tamanho,
        quantidade: Math.max(1, base + (k < resto ? 1 : 0)),
        imagemUrl: linha.imagemUrl,
        ean: linha.ean,
      });
      porPedido.set(id, arr);
    });
  }
  const out: PedidoMisto[] = [];
  for (const [id, pecas] of porPedido) {
    let pred = size;
    if (!pecas.some((p) => p.tamanho === size)) {
      const outro = pecas.find((p) => bucket.has(p.tamanho));
      if (outro) pred = outro.tamanho;
    }
    out.push({
      id,
      numero: null,
      dataEmissao: null,
      pred,
      fora: pecas.filter((p) => p.tamanho !== pred),
      dele: pecas.filter((p) => p.tamanho === pred),
      noLote: false,
    });
  }
  return out;
}

/**
 * Fila (servidor) ∪ lote (memória) — os ids são disjuntos por construção (o
 * servidor só devolve pedidos sem dono); se um id aparecer nos dois, vale o
 * lote, que tem os itens exatos.
 */
export function pedidosMistos(params: {
  fila: QueueProduct[];
  lote: Order[];
  size: string;
  sizes?: readonly string[];
}): PedidoMisto[] {
  const doLote = params.lote.map((o) => pedidoMistoDoLote(o, params.size));
  const ids = new Set(doLote.map((p) => p.id));
  const daFila = pedidosMistosDaFila(params.fila, params.size, params.sizes).filter((p) => !ids.has(p.id));
  return [...doLote, ...daFila].filter((p) => p.fora.length > 0);
}

/** Produto de outro tamanho nos mistos da fila, com quantos ele fecha sozinho. */
export type ProdutoMisto = {
  produto: string;
  imagemUrl: string | null;
  /** Em quantos mistos ele aparece como peça de outro tamanho. */
  aparece: number;
  /** Quantos mistos ele fecha SOZINHO (é o único produto de outro tamanho, e em P–XG). */
  sozinho: number;
};

/** Lista do Filtro Mistos: do que mais fecha sozinho pro que menos. */
export function rankingMistos(pedidos: PedidoMisto[]): ProdutoMisto[] {
  const info = new Map<string, ProdutoMisto>();
  for (const p of pedidos) {
    const chaves = new Set(p.fora.map((i) => chaveMisto(i.produto)));
    for (const chave of chaves) {
      const peca = p.fora.find((i) => chaveMisto(i.produto) === chave)!;
      const x = info.get(chave) ?? { produto: peca.produto, imagemUrl: peca.imagemUrl, aparece: 0, sozinho: 0 };
      if (!x.imagemUrl && peca.imagemUrl) x.imagemUrl = peca.imagemUrl;
      x.aparece += 1;
      info.set(chave, x);
    }
    if (chaves.size === 1 && p.fora.every((i) => TAMANHOS_MISTOS.includes(i.tamanho))) {
      info.get([...chaves][0])!.sozinho += 1;
    }
  }
  return [...info.values()].sort(
    (a, b) => b.sozinho - a.sozinho || b.aparece - a.aparece || a.produto.localeCompare(b.produto, "pt-BR"),
  );
}

/** A regra: fica o pedido cujas peças de outro tamanho são TODAS dos produtos marcados, e em P–XG. */
export function fechaCom(pedido: PedidoMisto, marcados: ReadonlySet<string>): boolean {
  if (pedido.fora.length === 0) return false;
  return pedido.fora.every((i) => marcados.has(chaveMisto(i.produto)) && TAMANHOS_MISTOS.includes(i.tamanho));
}

export function fechamCom(pedidos: PedidoMisto[], produtos: readonly string[]): PedidoMisto[] {
  const marcados = new Set(produtos.map(chaveMisto));
  return pedidos.filter((p) => fechaCom(p, marcados));
}

/** Mesma regra, direto num `Order` do lote (o `passaNosFiltros` do runner). */
export function passaNoFiltroMistos(o: Order, produtos: readonly string[] | undefined, sizeFila: string): boolean {
  if (!produtos || produtos.length === 0) return true;
  return fechaCom(pedidoMistoDoLote(o, sizeFila), new Set(produtos.map(chaveMisto)));
}

/** Linha do picking dos mistos: um produto, a grade dos OUTROS tamanhos e o total. */
export type PickingMisto = {
  produto: string;
  imagemUrl: string | null;
  /** Quantidade por tamanho, só os tamanhos fora da fila (ordem de `tamanhos`). */
  grade: Record<string, number>;
  total: number;
  pedidos: number;
};

/** Tamanhos da grade do picking: P–XG sem o da fila. */
export function tamanhosForaDaFila(sizeFila: string): string[] {
  const s = sizeFila.trim().toUpperCase();
  return TAMANHOS_MISTOS.filter((t) => t !== s);
}

/**
 * Picking das peças de OUTRO tamanho dos pedidos dados, por produto, do maior
 * pro menor. Peça fora de P–XG (G3…) entra no total mas não tem caixa na grade.
 */
export function pickingMistos(pedidos: PedidoMisto[], sizeFila: string): PickingMisto[] {
  const tamanhos = tamanhosForaDaFila(sizeFila);
  const acc = new Map<string, PickingMisto & { ids: Set<string> }>();
  for (const p of pedidos) {
    for (const i of p.fora) {
      const chave = chaveMisto(i.produto);
      let g = acc.get(chave);
      if (!g) {
        g = {
          produto: i.produto,
          imagemUrl: i.imagemUrl,
          grade: Object.fromEntries(tamanhos.map((t) => [t, 0])),
          total: 0,
          pedidos: 0,
          ids: new Set(),
        };
        acc.set(chave, g);
      }
      if (!g.imagemUrl && i.imagemUrl) g.imagemUrl = i.imagemUrl;
      if (i.tamanho in g.grade) g.grade[i.tamanho] += i.quantidade;
      g.total += i.quantidade;
      g.ids.add(p.id);
    }
  }
  return [...acc.values()]
    .map(({ ids, ...g }) => ({ ...g, pedidos: ids.size }))
    .sort((a, b) => b.total - a.total || a.produto.localeCompare(b.produto, "pt-BR"));
}

/** Soma das peças de outro tamanho (o "picking de Z peças"). */
export function totalFora(pedidos: PedidoMisto[]): number {
  return pedidos.reduce((a, p) => a + p.fora.reduce((b, i) => b + i.quantidade, 0), 0);
}

/** Soma das peças do tamanho da fila (o contador "Peças da fila do M"). */
export function totalDele(pedidos: PedidoMisto[]): number {
  return pedidos.reduce((a, p) => a + p.dele.reduce((b, i) => b + i.quantidade, 0), 0);
}

/** Rodapé da aba Mistos: produtos em uso por outra operadora (campo opcional do Nexus). */
export function textoReservadosPorOutras(
  reservados: Array<{ termo: string; operadora: { nome: string | null } }> | undefined,
): string | null {
  if (!reservados || reservados.length === 0) return null;
  const itens = reservados.map((r) => (r.operadora.nome ? `${r.termo} (${r.operadora.nome})` : r.termo));
  return `Em uso por outra operadora: ${itens.join(", ")}`;
}

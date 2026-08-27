// Imagem de catálogo pedida no TAMANHO DE TELA, não a original.
//
// Incidente de 27/08: a bancada do CD entrava na fila de puros e o WebView2
// morria com a página "Out of Memory" do Chromium. As `imagemUrl` que o Nexus
// manda no `POST /separacao/lote` são o arquivo ORIGINAL do CDN da Shopify —
// medido em campo: 2083×2706 px, ~23 MB DECODIFICADA (o peso do .jpg não
// importa, o que ocupa memória é o bitmap w×h×4). Um lote de 10 pedidos ×3
// itens rende dezenas dessas entre os cards do pedido e as miniaturas da
// sidebar; o renderer estoura antes de a operadora ver a primeira peça.
//
// A Shopify serve o mesmo arquivo redimensionado com `width=<px>` na query —
// é a mesma convenção do Nexus (`packages/contracts/src/shopify-thumb.ts`);
// duplicamos aqui porque o app é repo separado, e porque o cliente não pode
// depender de o servidor lembrar de reduzir. O legado (minhacontaberzerk) NÃO
// reduzia — ele carregava a original de propósito ("nitidez"), que é
// exatamente como o problema chegou até aqui.
//
// Só a Shopify entende o parâmetro. Host desconhecido (Tiny/S3, que já vem em
// 770×1000) passa INTACTO — inventar query em CDN alheio quebraria a imagem.

/** Miniatura de lista: sidebar do lote, histórico, chips. */
export const LARGURA_MINIATURA = 400;
/** Card do pedido ABERTO na mesa — é a foto que a operadora usa pra
 *  reconhecer a peça de longe, então continua grande (card ~330 px CSS em
 *  HiDPI). 1000 px de largura = ~5 MB decodificada, contra ~23 MB da original. */
export const LARGURA_CARD = 1000;
/** Picking Geral (tela): meio-termo entre a lista e o card. */
export const LARGURA_PICKING = 800;

const HOSTS_SHOPIFY = [
  /^cdn\.shopify\.com$/i,
  /\.cdn\.shopify\.com$/i,
  /\.shopifycdn\.(com|net)$/i,
  /\.myshopify\.com$/i,
];

/** `..._1024x1024.jpg`, `..._800x_crop_center@2x.png` — a URL já pede um
 *  tamanho pelo nome do arquivo; não sobrepor. */
const SUFIXO_TAMANHO = /_\d+x\d*(?:_crop_[a-z]+)?(?:@\dx)?\.[a-z0-9]+$/i;

function ehShopify(hostname: string): boolean {
  return HOSTS_SHOPIFY.some((re) => re.test(hostname));
}

/**
 * URL da mesma imagem servida em `largura` px pelo CDN da Shopify.
 *
 * Idempotente de propósito (mesma regra do `shopifyThumb` do Nexus): URL que
 * JÁ pede um tamanho — por `width=` na query ou por sufixo `_NxN` no arquivo —
 * volta inalterada. Se o servidor já reduziu, quem manda é ele; subir o número
 * aqui só desfaria a economia.
 */
export function imagemRedimensionada(
  url: string | null | undefined,
  largura: number,
): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url; // caminho relativo/data URI: não é do CDN, segue como está
  }
  if (!ehShopify(u.hostname)) return url;
  if (u.searchParams.has("width")) return url;
  if (SUFIXO_TAMANHO.test(u.pathname)) return url;
  // `set` preserva o `?v=` do cache-busting e usa `&` sozinho.
  u.searchParams.set("width", String(Math.max(1, Math.round(largura))));
  return u.toString();
}

/** Atalho pras miniaturas (sidebar, histórico, chips). */
export function miniatura(url: string | null | undefined): string | null {
  return imagemRedimensionada(url, LARGURA_MINIATURA);
}

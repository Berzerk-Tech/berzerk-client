// Impressão manual do tamanho inteiro (Únicos): a SEQUÊNCIA de folhas da pilha, pura.
// Capa do grupo → etiquetas sem bump → para cada bloco consecutivo de pedidos com o mesmo
// order bump (produto × tamanho): capa de bump → etiquetas do bloco. Usada pela impressão
// direta (capa de bump antes da 1ª etiqueta do bloco) e pela montagem do PDF.

import type { ImpressaoManualPedido } from "../services/expedicao";

export type FolhaPilha =
  | { tipo: "capa" }
  | { tipo: "capaBump"; produtoNome: string | null; tamanho: string | null; pedidos: number; numeros: string[] }
  | { tipo: "etiqueta"; pedido: ImpressaoManualPedido };

/** Chave do bloco de bump; null = pedido sem bump. Servidor antigo (comBump sem `bump`) = bloco único "". */
function chaveBump(p: ImpressaoManualPedido): string | null {
  if (!p.comBump) return null;
  return p.bump ? `${p.bump.produtoNome}\u0000${p.bump.tamanho ?? ""}` : "";
}

export function sequenciaDaPilha(pedidos: ImpressaoManualPedido[]): FolhaPilha[] {
  const folhas: FolhaPilha[] = [{ tipo: "capa" }];
  let i = 0;
  while (i < pedidos.length) {
    const chave = chaveBump(pedidos[i]);
    if (chave === null) {
      folhas.push({ tipo: "etiqueta", pedido: pedidos[i] });
      i += 1;
      continue;
    }
    let j = i;
    while (j < pedidos.length && chaveBump(pedidos[j]) === chave) j += 1;
    const b = pedidos[i].bump;
    folhas.push({ tipo: "capaBump", produtoNome: b?.produtoNome ?? null, tamanho: b?.tamanho ?? null, pedidos: j - i, numeros: pedidos.slice(i, j).map((x) => x.numero ?? "").filter(Boolean) });
    for (let k = i; k < j; k += 1) folhas.push({ tipo: "etiqueta", pedido: pedidos[k] });
    i = j;
  }
  return folhas;
}

/** orderId da 1ª etiqueta de cada bloco → a capa de bump que vem antes dela (impressão direta). */
export function capasDeBumpPorPedido(pedidos: ImpressaoManualPedido[]): Map<string, Extract<FolhaPilha, { tipo: "capaBump" }>> {
  const m = new Map<string, Extract<FolhaPilha, { tipo: "capaBump" }>>();
  const folhas = sequenciaDaPilha(pedidos);
  folhas.forEach((f, i) => {
    const prox = folhas[i + 1];
    if (f.tipo === "capaBump" && prox?.tipo === "etiqueta") m.set(prox.pedido.orderId, f);
  });
  return m;
}

function slug(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

/** `unicos-<estampa>-<tamanho>-<yyyyMMdd-HHmm>.pdf` */
export function nomeArquivoPilha(estampa: string, tamanho: string, quando: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const d = `${quando.getFullYear()}${p(quando.getMonth() + 1)}${p(quando.getDate())}-${p(quando.getHours())}${p(quando.getMinutes())}`;
  return `unicos-${slug(estampa)}-${slug(tamanho)}-${d}.pdf`;
}

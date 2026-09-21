// Etiquetagem AVULSA: catálogo sem lote — produto comprado pronto (touca,
// boné) que nasce sem SKU de produção e por isso não aparece na fila de lotes
// do `BatchBrowser`. Ver NEXUS_ETIQUETAGEM_AVULSA.md (spec do incidente
// 18–21/09) pro contrato completo.

import { apiRequest } from "../lib/api";
import type { EansDto } from "./batches";

export type ProdutoBusca = {
  produtoId: string;
  nome: string;
  imagemUrl: string | null;
  variantes: number;
  /** false = nenhuma variante com EAN cadastrado — item aparece desabilitado. */
  imprimivel: boolean;
  /** EAN da 1ª variante com EAN do produto. Desambigua produto duplicado no
   *  catálogo (mesmo nome, dois cadastros) direto na lista, sem abrir a grade. */
  ean: string | null;
};

type ProdutosBuscaDto = { itens: ProdutoBusca[] };

/**
 * Busca no catálogo por nome (parcial, sem acento) ou EAN/SKU (exato).
 *
 * Chamar a cada tecla do debounce sem tratar erro: `busca` com menos de 2
 * caracteres devolve `{ itens: [] }` com 200, não 400.
 */
export async function buscarProdutosAvulso(
  busca: string,
  limite = 20,
  signal?: AbortSignal,
): Promise<ProdutoBusca[]> {
  const dto = await apiRequest<ProdutosBuscaDto>("/etiquetagem/produtos", {
    query: { busca, limite: String(limite) },
    signal,
  });
  return dto.itens;
}

/**
 * EAN/SKU por tamanho do produto — mesmo shape de `GET /etiquetagem/lotes/:id/eans`
 * (`EansDto`, ver `src/services/batches.ts`). Produto sem tamanho (peça única)
 * devolve uma entrada só, `{ tamanho: "U", … }`.
 */
export async function fetchProdutoEans(
  produtoId: string,
  signal?: AbortSignal,
): Promise<EansDto> {
  return apiRequest<EansDto>(`/etiquetagem/produtos/${produtoId}/eans`, { signal });
}

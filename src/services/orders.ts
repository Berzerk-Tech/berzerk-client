// Wrappers da separacao-api (fila de separação). Os tipos espelham
// @berzerk/contracts (o app é repo separado, então duplicamos os shapes).

import { ApiError, apiRequest } from "../lib/api";

export type OrderStatus =
  | "received"
  | "processing"
  | "invoiced"
  | "ready"
  | "separating"
  | "awaiting_pickup"
  | "shipped"
  | "cancelled";

export type SeparationMode = "normal" | "total";
export type OrderChannel = "shopify" | "yampi" | "manual" | "tiny";

export type OrderItem = {
  id: string;
  ean: string | null;
  sku: string | null;
  nome: string | null;
  tamanho: string | null;
  quantidade: number;
  /** URL da imagem do produto (catálogo do nexus, via Shopify). null = sem match. */
  imagemUrl: string | null;
  /** Slot "Surpresa": SKUs (já normalizados) das peças reais curadas que
   *  preenchem este item (`surpresa_mappings` do nexus). Ausente = item comum. */
  surpresaPermitidos?: string[];
};

export type Order = {
  id: string;
  tinyOrderId: string | null;
  numero: string | null;
  channel: OrderChannel | null;
  status: OrderStatus;
  predominantSize: string | null;
  separationMode: SeparationMode;
  claimedBy: string | null;
  claimedAt: string | null;
  separatedBy: string | null;
  separatedAt: string | null;
  rfidTags: string[] | null;
  items: OrderItem[];
  createdAt: string;
  updatedAt: string;
  /** Campos enriquecidos (nexus mais novo). Opcionais: API antiga não manda. */
  clienteNome?: string | null;
  dataEmissao?: string | null;
  prioritario?: boolean;
};

export type ClaimResponse = { order: Order | null };

export type EpcLookupItem = {
  epc: string;
  ean13: string;
  sku: string | null;
  size: string | null;
  batchCode: string | null;
  /** Nome do produto — só vem quando resolvido pela nuvem da iTAG (o endpoint
   *  do nexus não manda; opcional pra manter o shape do contrato). */
  name?: string | null;
};

export type Me = {
  actorId: string;
  email: string | null;
  permissions: string[];
  /** Minutos de inatividade até derrubar a sessão — o MENOR limite entre os
   *  papéis do ator (Admin → Configurações → "Sessão por papel" no nexus,
   *  PR #79). null/ausente = sem limite. Quem mede a inatividade é o app —
   *  ver `lib/idleSession.ts`. */
  sessaoInatividadeMinutos?: number | null;
};

export type QueueCounts = {
  /** Pedidos puros (grade normal) por tamanho. */
  sizes: Record<string, number>;
  /** Total de mistos (soma do mixedBySize). */
  mixed: number;
  /** Mistos por tamanho predominante — aba "Mistos" de cada fila. */
  mixedBySize: Record<string, number>;
};

/** Entrada da fila (resumo pro card da sidebar; itens completos só no claim). */
export type QueueListItem = {
  /** Posição na fila (1-based). */
  position: number;
  id: string;
  numero: string | null;
  clienteNome: string | null;
  dataEmissao: string | null;
  prioritario: boolean;
  predominantSize: string | null;
  separationMode: SeparationMode;
  /** Soma das quantidades dos itens do pedido. */
  itemCount: number;
  /** Até 4 URLs de imagem de itens (thumbnails do card). */
  imagens: string[];
  createdAt: string;
};

/**
 * Filtros opcionais da fila (espelham o picking do posvenda): janela de data
 * de emissão (YYYY-MM-DD) e Filtro Adição/Exclusão por nome de produto. Valem
 * no claim E na listagem — o "próximo" respeita o que a operadora está vendo.
 * Nexus antigo simplesmente ignora os campos extras (zod strip) — degrada
 * pra fila sem filtro, sem erro.
 */
export type QueueFilters = {
  dateFrom?: string;
  dateTo?: string;
  includeProducts?: string[];
  excludeProducts?: string[];
};

/** Filtros → campos do body do claim (arrays vão como estão). */
function filtersBody(f?: QueueFilters): Record<string, unknown> {
  if (!f) return {};
  const out: Record<string, unknown> = {};
  if (f.dateFrom) out.dateFrom = f.dateFrom;
  if (f.dateTo) out.dateTo = f.dateTo;
  if (f.includeProducts?.length) out.includeProducts = f.includeProducts;
  if (f.excludeProducts?.length) out.excludeProducts = f.excludeProducts;
  return out;
}

export function getQueueCounts(): Promise<QueueCounts> {
  return apiRequest<QueueCounts>("/separacao/queues");
}

export function getMe(): Promise<Me> {
  return apiRequest<Me>("/separacao/me");
}

/** Claim de UM pedido — desde a 0.9.0 só o caminho degradado do lote. */
export function claimNext(sizes: string[], filters?: QueueFilters): Promise<ClaimResponse> {
  return apiRequest<ClaimResponse>("/separacao/claim", {
    method: "POST",
    body: { sizes, ...filtersBody(filters) },
  });
}

/** Claim de UM misto — desde a 0.9.0 só o caminho degradado do lote. */
export function claimNextMixed(sizes?: string[], filters?: QueueFilters): Promise<ClaimResponse> {
  return apiRequest<ClaimResponse>("/separacao/claim-mixed", {
    method: "POST",
    body: { ...(sizes && sizes.length > 0 ? { sizes } : {}), ...filtersBody(filters) },
  });
}

// ---------------------------------------------------------------------------
// Produtos da fila (Filtro Inteligente — checkbox por produto, como o posvenda)
// ---------------------------------------------------------------------------

export type QueueProduct = {
  /** Nome do item como aparece nos pedidos — é o termo usado nos filtros. */
  nome: string;
  tamanho: string | null;
  ean: string | null;
  imagemUrl: string | null;
  quantidade: number;
  pedidos: number;
  /** Pedidos que o contêm — base do "X pedidos serão ocultados". */
  orderIds: string[];
};

/**
 * Totais da fila consultada (cabeçalho do Picking Geral). Opcional: nexus
 * antigo devolve só `products` e o app recalcula pela lista.
 */
export type QueueProductsResumo = { pedidos: number; itens: number; produtos: number };

export type QueueProductsResponse = {
  products: QueueProduct[];
  resumo?: QueueProductsResumo;
};

/** Produtos distintos da fila consultada (404 = nexus antigo → degradar). */
export function getQueueProducts(params: {
  mode: SeparationMode;
  size?: string;
  dateFrom?: string;
  dateTo?: string;
}): Promise<QueueProductsResponse> {
  return comModo(params.mode, (mode) =>
    apiRequest<QueueProductsResponse>("/separacao/queue-products", {
      query: {
        mode,
        size: params.size,
        dateFrom: params.dateFrom || undefined,
        dateTo: params.dateTo || undefined,
      },
    }),
  );
}

// ---------------------------------------------------------------------------
// Datas de emissão da fila (seletor "Data" do posvenda) + LOTE da operadora
// ---------------------------------------------------------------------------

/**
 * O contrato dos endpoints novos (lote/datas) foi escrito com
 * `mode=normal|mixed`; o resto da separação usa o `separationModeSchema` do
 * nexus, que é `normal|total`. Enquanto os dois nomes convivem no cutover,
 * mandamos o nome canônico e, se o servidor recusar o VALOR (400/422 do zod),
 * repetimos uma vez com `mixed`. Cai fora sozinho quando o nexus fechar o nome.
 */
function comModo<T>(mode: SeparationMode, chamar: (m: string) => Promise<T>): Promise<T> {
  return chamar(mode).catch((e: unknown) => {
    const recusaDeValor = e instanceof ApiError && (e.status === 400 || e.status === 422);
    if (mode === "total" && recusaDeValor) return chamar("mixed");
    throw e;
  });
}

export type QueueDate = {
  /** YYYY-MM-DD (emissão, America/Sao_Paulo). */
  date: string;
  count: number;
};

export type QueueDatesResponse = {
  dates: QueueDate[];
  /** Pedidos da fila inteira (o "Todos (637)" do seletor). */
  total: number;
  /** Pedidos sem data de emissão — não cabem em nenhuma linha do seletor. */
  semData: number;
};

/**
 * Datas de emissão presentes na fila, com contagem por dia — é o dropdown
 * "Data" do posvenda. Escolher uma data vira `dateFrom = dateTo` nos demais
 * endpoints. 404 = nexus antigo (o seletor some, a fila segue completa).
 */
export function getQueueDates(params: {
  mode: SeparationMode;
  size?: string;
  filters?: QueueFilters;
}): Promise<QueueDatesResponse> {
  const f = params.filters;
  return comModo(params.mode, (mode) =>
    apiRequest<QueueDatesResponse>("/separacao/queue-dates", {
      query: {
        mode,
        size: params.size,
        includeProducts: f?.includeProducts?.length ? f.includeProducts.join(",") : undefined,
        excludeProducts: f?.excludeProducts?.length ? f.excludeProducts.join(",") : undefined,
      },
    }),
  );
}

/** Lote da operadora + quantos ainda estão na fila sem dono. */
export type LoteResponse = {
  orders: Order[];
  /** Ausente no modo degradado (nexus sem `/separacao/lote`). */
  fila?: { restantes: number };
};

/** Quantos pedidos a operadora leva por vez (pedido das separadoras). */
export const LOTE_PADRAO = 10;

/**
 * Puxa/repõe o LOTE da operadora: IDEMPOTENTE — devolve TODOS os pedidos em
 * aberto dela nessa fila e completa com o que faltar até `quantidade`. É o que
 * divide a fila entre as estações: cada uma enxerga só o próprio lote. Chamar
 * ao entrar na fila e depois de cada complete/release.
 */
export function claimLote(params: {
  mode: SeparationMode;
  sizes: string[];
  quantidade?: number;
  filters?: QueueFilters;
}): Promise<LoteResponse> {
  return comModo(params.mode, (mode) =>
    apiRequest<LoteResponse>("/separacao/lote", {
      method: "POST",
      body: {
        mode,
        sizes: params.sizes,
        quantidade: params.quantidade ?? LOTE_PADRAO,
        ...filtersBody(params.filters),
      },
    }),
  ).catch((e: unknown) => {
    if (e instanceof ApiError && e.status === 404) return loteDegradado(params);
    throw e;
  });
}

/**
 * Nexus AINDA sem `/separacao/lote` (app atualizou antes da API): cai no claim
 * de um pedido só. A operadora continua separando — lote de um, sem "faltam X"
 * — em vez de olhar pra uma tela de erro. O app se atualiza sozinho em todas
 * as estações, então as duas ordens de deploy têm que funcionar.
 */
async function loteDegradado(params: {
  mode: SeparationMode;
  sizes: string[];
  filters?: QueueFilters;
}): Promise<LoteResponse> {
  const { order } =
    params.mode === "total"
      ? await claimNextMixed(params.sizes, params.filters)
      : await claimNext(params.sizes, params.filters);
  return { orders: order ? [order] : [] };
}

/**
 * Todos os pedidos em aberto da operadora, de qualquer fila — usado ao abrir o
 * módulo pra oferecer "retomar" (troca de estação, app fechado no meio).
 */
export function getMeusPedidos(): Promise<{ orders: Order[] }> {
  return apiRequest<{ orders: Order[] }>("/separacao/meus-pedidos");
}

/**
 * Devolve pedidos do lote pra fila. Sem `orderIds` = todos os em aberto — é o
 * que roda ao sair da fila (voltar ao menu, trocar de fila, logout).
 */
export function devolverLote(orderIds?: string[]): Promise<{ devolvidos: number }> {
  return apiRequest<{ devolvidos: number }>("/separacao/lote/devolver", {
    method: "POST",
    body: orderIds && orderIds.length > 0 ? { orderIds } : {},
  }).catch(async (e: unknown) => {
    // Degradação (nexus sem o endpoint): devolve um a um os ids que o caller
    // conhece. Sem ids não há o que fazer aqui — o janitor recupera.
    if (!(e instanceof ApiError) || e.status !== 404) throw e;
    if (!orderIds || orderIds.length === 0) return { devolvidos: 0 };
    const rs = await Promise.allSettled(orderIds.map((id) => releaseSeparacao(id)));
    return { devolvidos: rs.filter((r) => r.status === "fulfilled").length };
  });
}

// ---------------------------------------------------------------------------
// Histórico da operadora (paridade com o "Histórico" do posvenda)
// ---------------------------------------------------------------------------

export type HistoryOrder = {
  id: string;
  numero: string | null;
  clienteNome: string | null;
  dataEmissao: string | null;
  separatedAt: string;
  prioritario: boolean;
  predominantSize: string | null;
  separationMode: SeparationMode;
  channel: OrderChannel | null;
  status: OrderStatus;
  itemCount: number;
  rfidTags: string[];
  items: OrderItem[];
};

export type HistoryResponse = {
  items: HistoryOrder[];
  total: number;
  /** Totais do período filtrado INTEIRO (não só da página). */
  totals: { pedidos: number; itens: number; tags: number };
};

/** Pedidos separados PELO ATOR logado (busca + período sobre `separated_at`). */
export function getHistory(params: {
  q?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  offset?: number;
}): Promise<HistoryResponse> {
  return apiRequest<HistoryResponse>("/separacao/history", {
    query: {
      q: params.q || undefined,
      dateFrom: params.dateFrom || undefined,
      dateTo: params.dateTo || undefined,
      limit: params.limit?.toString(),
      offset: params.offset?.toString(),
    },
  });
}

/** Item que faltou no RFID quando o supervisor liberou (auditoria). */
export type LiberacaoFaltante = {
  itemId: string;
  nome: string | null;
  tamanho: string | null;
  faltam: number;
};

/** Credencial de liberação de supervisor (validada server-side no nexus). */
export type LiberacaoSupervisor = {
  supervisorId: string;
  pin: string;
  motivo: string;
  faltantes: LiberacaoFaltante[];
};

export type SupervisorInfo = { id: string; nome: string; temPin: boolean };

/** Resolução EPC→peça que o APP fez (nuvem iTAG → nexus → SGTIN), enviada no
 *  complete. O nexus resolve só pelo `rfid_epc_inventory` dele; quando o EPC
 *  não está na réplica (peça surpresa recém-etiquetada, sync atrasado) ele não
 *  enxerga a leitura e recusa com `liberacao_necessaria` mesmo com a peça certa
 *  na mesa (go-live XG, 21/08/2026). Com isto o servidor tem como usar a
 *  resolução do app de fallback (e alimentar o inventário). Campo extra é
 *  ignorado por nexus antigo (zod não-strict). */
export type LeituraResolvida = {
  epc: string;
  ean13: string;
  sku: string | null;
  size: string | null;
  name: string | null;
};

export function completeSeparacao(
  orderId: string,
  rfidTags: string[],
  liberacao?: LiberacaoSupervisor,
  leituras?: LeituraResolvida[],
): Promise<Order> {
  return apiRequest<Order>(`/separacao/${orderId}/complete`, {
    method: "POST",
    body: {
      rfidTags,
      ...(liberacao ? { liberacao } : {}),
      ...(leituras && leituras.length > 0 ? { leituras } : {}),
    },
  });
}

/** Supervisores disponíveis pro fluxo de liberação (picker da estação). */
export function getSupervisores(): Promise<{ supervisores: SupervisorInfo[] }> {
  return apiRequest<{ supervisores: SupervisorInfo[] }>("/separacao/supervisores");
}

/** Define/troca o PIN do supervisor — server-side, vale em toda estação na hora. */
export function alterarPinSupervisor(req: {
  supervisorId: string;
  pinAtual?: string;
  pinNovo: string;
}): Promise<{ ok: true }> {
  return apiRequest<{ ok: true }>("/separacao/supervisor-pin", { method: "POST", body: req });
}

export function releaseSeparacao(orderId: string): Promise<Order> {
  return apiRequest<Order>(`/separacao/${orderId}/release`, { method: "POST", body: {} });
}

export function epcLookup(epcs: string[]): Promise<{ items: EpcLookupItem[] }> {
  return apiRequest<{ items: EpcLookupItem[] }>("/separacao/epc-lookup", {
    query: { epcs: epcs.join(",") },
  });
}

/** Permissão exigida pra operar a fila (o ator dev com `*` passa). */
export function canOperateSeparacao(me: Me): boolean {
  return me.permissions.includes("*") || me.permissions.includes("separacao:operate");
}

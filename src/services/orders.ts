// Wrappers da separacao-api (fila de separação). Os tipos espelham
// @berzerk/contracts (o app é repo separado, então duplicamos os shapes).

import { apiRequest } from "../lib/api";

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

export type QueueListResponse = { items: QueueListItem[]; total: number };

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

/** Listagem read-only da fila (sidebar) — mesma ordem do claim. */
export function getQueueList(params: {
  mode: SeparationMode;
  size?: string;
  /** Busca server-side (numero, cliente, item/EAN/SKU) — indexada no nexus. */
  q?: string;
  filters?: QueueFilters;
  limit?: number;
  offset?: number;
}): Promise<QueueListResponse> {
  const f = params.filters;
  return apiRequest<QueueListResponse>("/separacao/queue", {
    query: {
      mode: params.mode,
      size: params.size,
      q: params.q || undefined,
      dateFrom: f?.dateFrom || undefined,
      dateTo: f?.dateTo || undefined,
      includeProducts: f?.includeProducts?.length ? f.includeProducts.join(",") : undefined,
      excludeProducts: f?.excludeProducts?.length ? f.excludeProducts.join(",") : undefined,
      limit: params.limit?.toString(),
      offset: params.offset?.toString(),
    },
  });
}

export function getQueueCounts(): Promise<QueueCounts> {
  return apiRequest<QueueCounts>("/separacao/queues");
}

export function getMe(): Promise<Me> {
  return apiRequest<Me>("/separacao/me");
}

export function claimNext(sizes: string[], filters?: QueueFilters): Promise<ClaimResponse> {
  return apiRequest<ClaimResponse>("/separacao/claim", {
    method: "POST",
    body: { sizes, ...filtersBody(filters) },
  });
}

export function claimNextMixed(sizes?: string[], filters?: QueueFilters): Promise<ClaimResponse> {
  return apiRequest<ClaimResponse>("/separacao/claim-mixed", {
    method: "POST",
    body: { ...(sizes && sizes.length > 0 ? { sizes } : {}), ...filtersBody(filters) },
  });
}

/**
 * Claim de um pedido ESPECÍFICO (clique no card da fila pra avançar). Atômico
 * no nexus; 409 `{error:'pedido_indisponivel'}` se outra estação levou; replay
 * idempotente quando o pedido já é da própria operadora. 404 = nexus antigo
 * (sem o endpoint) — o caller degrada com aviso.
 */
export function claimOrder(orderId: string): Promise<ClaimResponse> {
  return apiRequest<ClaimResponse>("/separacao/claim-order", {
    method: "POST",
    body: { orderId },
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

export function completeSeparacao(
  orderId: string,
  rfidTags: string[],
  liberacao?: LiberacaoSupervisor,
): Promise<Order> {
  return apiRequest<Order>(`/separacao/${orderId}/complete`, {
    method: "POST",
    body: liberacao ? { rfidTags, liberacao } : { rfidTags },
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

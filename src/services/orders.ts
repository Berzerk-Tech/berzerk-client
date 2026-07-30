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

/** Listagem read-only da fila (sidebar) — mesma ordem do claim. */
export function getQueueList(params: {
  mode: SeparationMode;
  size?: string;
  /** Busca server-side (numero, cliente, item/EAN/SKU) — indexada no nexus. */
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<QueueListResponse> {
  return apiRequest<QueueListResponse>("/separacao/queue", {
    query: {
      mode: params.mode,
      size: params.size,
      q: params.q || undefined,
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

export function claimNext(sizes: string[]): Promise<ClaimResponse> {
  return apiRequest<ClaimResponse>("/separacao/claim", { method: "POST", body: { sizes } });
}

export function claimNextMixed(sizes?: string[]): Promise<ClaimResponse> {
  return apiRequest<ClaimResponse>("/separacao/claim-mixed", {
    method: "POST",
    body: sizes && sizes.length > 0 ? { sizes } : {},
  });
}

export function completeSeparacao(orderId: string, rfidTags: string[]): Promise<Order> {
  return apiRequest<Order>(`/separacao/${orderId}/complete`, {
    method: "POST",
    body: { rfidTags },
  });
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

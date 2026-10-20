// Wrappers da API de Expedição (nexus) — contrato REAL, já em produção.
// (prod: https://api-nexus.cloud.berzerk.com.br/api, mesma auth/bridge da
// Separação). Difere do PROMPT.md original em paths, nomes de campo e códigos
// de erro — este arquivo é a fonte da verdade do lado do app.
//
// Fluxo da mesa: bipar EPCs → epc-match → conferir completude → imprimir J&T →
// marcar labels/printed → (DANFE) → ship (shipped).
//
// Erros de negócio vêm como `{ error: 'CODIGO' }` (4xx). Trate por CÓDIGO
// (ver `expedicaoErrorCode`). 404 dos endpoints = degradar com aviso.

import type { LeituraResolvida } from "./orders";
import { apiRequest, ApiError } from "../lib/api";
import { getStationId } from "../lib/station";
import { isExpedicaoSimulacao } from "./expedicaoMode";
import type { Me, OrderChannel, OrderItem, OrderStatus } from "./orders";

/** Máx. de EPCs por chamada do epc-match (o servidor aceita 200; mesclamos no cliente). */
export const MATCH_CHUNK = 200;

// ---------------------------------------------------------------------------
// Pedido da Expedição (ExpedicaoOrderDto — NÃO reusa o Order da separação)
// ---------------------------------------------------------------------------

export type ExpedicaoOrder = {
  id: string;
  tinyOrderId: string | null;
  numero: string | null;
  tinyAccount: "FM" | "JT";
  status: OrderStatus;
  channel: OrderChannel | null;
  clienteNome: string | null;
  dataEmissao: string | null;
  prioritario: boolean;
  /** Canal do pedido (nexus 19/10). Ausente = e-commerce. */
  canal?: "ecommerce" | "mercado_livre";
  /** Nome real do rastreio (não "trackingCode"). */
  trackingNumber: string | null;
  rfidTags: string[] | null;
  separatedBy: string | null;
  /** Nome de quem separou, resolvido pelo nexus (`separatedBy` pode ser só o id). */
  separatedByNome?: string | null;
  separatedAt: string | null;
  shippedBy: string | null;
  shippedAt: string | null;
  shippedWithoutLabel: boolean;
  /** Join com jt_shipping_labels — quando a etiqueta foi impressa. */
  labelPrintedAt: string | null;
  hasDanfeCached: boolean;
  items: OrderItem[];
  createdAt: string;
  updatedAt: string;
  /**
   * Só na resposta do `ship` pela MESA (nexus 15/10): a gaiola em que o
   * pedido acabou de entrar, com a contagem JÁ incluindo ele. Ausente nas
   * listagens, no ship sem tags e no nexus anterior.
   */
  /** `null` no pedido do Mercado Livre (a API não o põe em gaiola J&T). */
  gaiola?: GaiolaDoShip | null;
};

// ---------------------------------------------------------------------------
// epc-match (EPCs → pedidos awaiting_pickup)
// ---------------------------------------------------------------------------

export type EpcMatch = {
  order: ExpedicaoOrder;
  tagsMatched: number;
  tagsTotal: number;
  tagsLidas: string[];
  tagsFaltantes: string[];
};

export type JaExpedido = {
  epc: string;
  orderId: string;
  numero: string | null;
  tinyAccount: "FM" | "JT";
  /** Decide QUAL documento reimprimir: Mercado Livre → DANFE; ausente/e-commerce → etiqueta J&T. */
  canal?: "ecommerce" | "mercado_livre";
  shippedAt: string | null;
  shippedBy: string | null;
  shippedByEmail: string | null;
};

export type EpcMatchResponse = {
  matches: EpcMatch[];
  /** EPCs lidos sem pedido awaiting_pickup (os "intrusos"). */
  unmatchedEpcs: string[];
  /** EPCs de pedidos JÁ expedidos — avisar na tela. */
  jaExpedidos: JaExpedido[];
};

// ---------------------------------------------------------------------------
// Documentos — DANFE em SNAKE_CASE (mesmo shape do posvenda/printDanfe.ts).
// Valores numéricos vêm como STRING (parse na hora de formatar).
// ---------------------------------------------------------------------------

export type DanfePessoa = {
  nome: string | null;
  cnpj?: string | null;
  cpf_cnpj?: string | null;
  ie?: string | null;
  endereco?: string | null;
  numero?: string | null;
  complemento?: string | null;
  bairro?: string | null;
  cidade?: string | null;
  uf?: string | null;
  cep?: string | null;
  tipo_pessoa?: string | null;
};

export type DanfeItem = {
  codigo: string | null;
  descricao: string | null;
  ncm: string | null;
  cfop: string | null;
  unidade: string | null;
  quantidade: string | number | null;
  valor_unitario: string | number | null;
  valor_total: string | number | null;
};

export type DanfeVolumes = {
  quantidade: string | number | null;
  especie: string | null;
  peso_liquido: string | number | null;
  peso_bruto: string | number | null;
};

export type DanfeData = {
  numero: string | null;
  serie: string | null;
  data_emissao: string | null;
  natureza_operacao: string | null;
  chave_acesso: string | null;
  protocolo: string | null;
  data_protocolo: string | null;
  emitente: DanfePessoa;
  cliente: DanfePessoa;
  itens: DanfeItem[];
  valor_produtos: string | number | null;
  valor_frete: string | number | null;
  valor_desconto: string | number | null;
  valor_nota: string | number | null;
  valor_icms?: string | number | null;
  valor_pis?: string | number | null;
  valor_cofins?: string | number | null;
  transportador: DanfePessoa | null;
  volumes: DanfeVolumes | null;
  informacoes_adicionais: string | null;
};

export type Documentos = {
  danfe: DanfeData | null;
  etiqueta: { base64: string; formato: "pdf" | "png" } | null;
  trackingNumber: string | null;
};

// ---------------------------------------------------------------------------
// Ship + histórico
// ---------------------------------------------------------------------------

export type ShipOverride = { motivo: string };

export type ExpedicaoHistoryOrder = {
  id: string;
  numero: string | null;
  clienteNome: string | null;
  dataEmissao: string | null;
  shippedAt: string;
  /** `shipped_by` cru (sub do Cognito) — chave, não rótulo. */
  shippedBy: string | null;
  /** E-mail (staff) ou nome (operador) de quem expediu; null se não casou. */
  shippedByNome: string | null;
  trackingNumber: string | null;
  tinyAccount: "FM" | "JT";
  /** Mercado Livre reimprime a DANFE; ausente/e-commerce, a etiqueta J&T. */
  canal?: "ecommerce" | "mercado_livre";
  channel: OrderChannel | null;
  status: OrderStatus;
  itemCount: number;
  /** Dá pra reimprimir a DANFE (tem NF em cache no servidor). */
  temDanfe: boolean;
  /** Dá pra reimprimir a etiqueta (base64 em banco ou rastreio pra rebuscar). */
  temEtiqueta: boolean;
  /** Última impressão registrada da etiqueta — inclui reimpressões. */
  labelPrintedAt: string | null;
  rfidTags: string[];
  items: OrderItem[];
};

/** Documento reimprimível a partir do histórico / da tela "já foi expedido". */
export type DocumentoReimpressao = "danfe" | "etiqueta";

export type ExpedicaoHistoryResponse = {
  items: ExpedicaoHistoryOrder[];
  total: number;
  totals: { pedidos: number; itens: number; tags: number };
};

// ---------------------------------------------------------------------------
// Códigos de erro (contrato REAL — alguns herdados do warehouse em produção)
// ---------------------------------------------------------------------------

export const EXP_ERR = {
  TRACKING_REQUIRED: "TRACKING_REQUIRED",
  JT_LABEL_REQUIRED: "JT_LABEL_REQUIRED",
  TAGS_INCOMPLETAS: "tags_incompletas",
  INVALID_STATUS: "invalid_status",
  ORDER_NOT_FOUND: "order_not_found",
  LABEL_NOT_FOUND: "label_not_found",
  TINY_RATE_LIMITED: "tiny_rate_limited",
  MISSING_PERMISSION: "missing_permission",
  VALIDATION_ERROR: "validation_error",
  /** Ver NEXUS_EXPEDICAO.md §8 — pedido devolvido pra fila com o MESMO AWB de
   *  um pacote que a J&T já coletou antes desta separação (duplicado). */
  AWB_JA_COLETADO: "awb_ja_coletado",
  /** 409 do ship: a gaiola aberta está no teto (`expedicao_gaiola_limite_pedidos`). Nada foi gravado. */
  GAIOLA_CHEIA: "gaiola_cheia",
  /** 409 do `fecharGaiola`: sem gaiola aberta ou com zero pedidos. */
  GAIOLA_VAZIA: "gaiola_vazia",
} as const;

/** Extrai o `{ error: 'CODIGO' }` de um ApiError (ou null se não for de negócio). */
export function expedicaoErrorCode(e: unknown): string | null {
  if (e instanceof ApiError && e.body && typeof e.body === "object" && "error" in e.body) {
    const code = (e.body as { error: unknown }).error;
    return typeof code === "string" ? code : null;
  }
  return null;
}

/**
 * Recusa com MOTIVO do nexus (15/10): `409 { error: 'invalid_status', motivo,
 * message }` — `motivo` é `entrega_em_maos` (pedido que a Luana entrega
 * pessoalmente; nunca sai pela expedição) ou `expedicao_manual` (Mercado
 * Livre). O `error` fica `invalid_status` de propósito: o app anterior já o
 * trata como definitivo (sem retry); este lê o `motivo` só pra mostrar a
 * `message` do servidor em vez do texto genérico. Null = outro erro.
 */
export function motivoRecusa(e: unknown): { motivo: string; message: string } | null {
  if (!(e instanceof ApiError) || e.status !== 409 || !e.body || typeof e.body !== "object") return null;
  const b = e.body as Record<string, unknown>;
  if (b.error !== EXP_ERR.INVALID_STATUS) return null;
  if (typeof b.motivo !== "string" || !b.motivo || typeof b.message !== "string" || !b.message.trim()) return null;
  return { motivo: b.motivo, message: b.message };
}

/** 404 = endpoint/pedido ausente (degradar com aviso). */
export function isEndpointMissing(e: unknown): boolean {
  return e instanceof ApiError && e.status === 404;
}

/** Mensagem amigável (pt-BR) pros códigos de erro do ship. */
export function shipErrorMessage(code: string | null): string {
  switch (code) {
    case EXP_ERR.TRACKING_REQUIRED:
      return "o pedido está sem código de rastreio (a etiqueta ainda não chegou).";
    case EXP_ERR.JT_LABEL_REQUIRED:
      return "a etiqueta J&T não consta como impressa.";
    case EXP_ERR.TAGS_INCOMPLETAS:
      return "faltam peças (tags) do pedido.";
    case "pecas_insuficientes":
    case "liberacao_necessaria":
      return "o servidor apontou peça faltando (trava de supervisor ligada).";
    case EXP_ERR.INVALID_STATUS:
      return "o pedido não está num status que permita expedir.";
    case EXP_ERR.ORDER_NOT_FOUND:
      return "o pedido não foi encontrado.";
    case EXP_ERR.AWB_JA_COLETADO:
      return "esse AWB já foi coletado pela J&T antes desta separação (pacote duplicado).";
    case EXP_ERR.GAIOLA_CHEIA:
      return "a gaiola está cheia. Feche a gaiola pra continuar.";
    case EXP_ERR.GAIOLA_VAZIA:
      return "não há gaiola aberta com pedidos pra fechar.";
    default:
      return "erro no servidor de expedição.";
  }
}

// ---------------------------------------------------------------------------
// AWB já coletado (409 `awb_ja_coletado`) — ver NEXUS_EXPEDICAO.md §8
// ---------------------------------------------------------------------------

/** Corpo extra do 409 `awb_ja_coletado` (além do `error`). */
export type AwbJaColetadoDetails = {
  awb: string;
  /** Já formatada em pt-BR/horário de Brasília, pronta pra mostrar. */
  message: string;
  primeiroScanEm: string;
  ultimoEvento: string | null;
};

/** Credencial de liberação (mesmo modelo do supervisor da Separação) pra reenviar
 *  o `ship` depois de um `awb_ja_coletado` — ver `shipOrder`. */
export type LiberacaoAwbColetado = { supervisorId: string; pin: string; motivo: string };

/** Extrai `{ awb, message, primeiroScanEm, ultimoEvento }` de um 409 `awb_ja_coletado` (null se não for esse erro/corpo incompleto). */
export function awbJaColetadoDetails(e: unknown): AwbJaColetadoDetails | null {
  if (expedicaoErrorCode(e) !== EXP_ERR.AWB_JA_COLETADO) return null;
  if (!(e instanceof ApiError) || !e.body || typeof e.body !== "object") return null;
  const b = e.body as Record<string, unknown>;
  if (typeof b.awb !== "string" || typeof b.message !== "string" || typeof b.primeiroScanEm !== "string") return null;
  return {
    awb: b.awb,
    message: b.message,
    primeiroScanEm: b.primeiroScanEm,
    ultimoEvento: typeof b.ultimoEvento === "string" ? b.ultimoEvento : null,
  };
}

// ---------------------------------------------------------------------------
// Gaiola da embalagem (nexus 15/10, `docs/expedicao-gaiola.md` no nexus)
//
// A gaiola é o contêiner que a J&T leva (~300 a 400 pedidos). Cada ship pela
// mesa entra na gaiola aberta e o contador sobe no SERVIDOR (a embaladora
// contava, mas duplicava). No teto o ship responde 409 `gaiola_cheia` até
// alguém fechar a gaiola; o fechamento congela o romaneio dela.
// ---------------------------------------------------------------------------

/** Resumo que vem dentro do DTO do ship. */
export type GaiolaDoShip = { id: string; numero: number; contagem: number; limite: number };

export type Gaiola = {
  id: string;
  /** Número humano sequencial ("Gaiola 12"). */
  numero: number;
  abertaEm: string;
  fechadaEm: string | null;
  /** Pedidos na gaiola (ao vivo enquanto aberta; congelado no fechamento). */
  contagem: number;
  /** Romaneio congelado no fechamento (`getManifest`); nulo enquanto aberta. */
  romaneioId: string | null;
};

/** `GET /expedicao/gaiola`: o contador da mesa. */
export type GaiolaStatus = {
  /** Gaiola aberta agora; `null` logo depois de um fechamento (a próxima nasce no próximo ship). */
  aberta: Gaiola | null;
  /** `expedicao_gaiola_limite_pedidos` vigente (0 = só conta, nunca trava). */
  limite: number;
  /** `limite > 0` e a aberta já está no teto: o próximo ship leva 409 `gaiola_cheia`. */
  travada: boolean;
  /** A última fechada, pra reimprimir o romaneio. */
  ultimaFechada: Gaiola | null;
};

export type ManifestOrder = {
  orderId: string;
  tinyOrderNumber: string | null;
  tinyAccount: string | null;
  cliente: string | null;
  trackingCode: string | null;
  /** No romaneio da gaiola: a hora em que o pedido passou pela mesa. */
  printedAt: string | null;
};

/** `ManifestDto` do nexus (romaneio diário e romaneio da gaiola, mesmo shape). */
export type Manifest = {
  id: string;
  manifestNumber: string | number | null;
  manifestDate: string | null;
  orderCount: number;
  closedAt: string | null;
  closedByName: string | null;
  notes: string | null;
  orders: ManifestOrder[];
};

/** Corpo extra do 409 `gaiola_cheia` (além do `error`). */
export type GaiolaCheiaDetails = {
  message: string;
  gaiolaNumero: number | null;
  contagem: number | null;
  limite: number | null;
};

/** Extrai os detalhes de um 409 `gaiola_cheia` (null se é outro erro). Corpo incompleto ainda conta: o código basta pra travar. */
export function gaiolaCheiaDetails(e: unknown): GaiolaCheiaDetails | null {
  if (expedicaoErrorCode(e) !== EXP_ERR.GAIOLA_CHEIA) return null;
  const b = (e as ApiError).body as Record<string, unknown>;
  return {
    message: typeof b.message === "string" && b.message.trim() ? b.message : "A gaiola está cheia. Feche a gaiola pra continuar expedindo.",
    gaiolaNumero: typeof b.gaiolaNumero === "number" ? b.gaiolaNumero : null,
    contagem: typeof b.contagem === "number" ? b.contagem : null,
    limite: typeof b.limite === "number" ? b.limite : null,
  };
}

/** Contador da gaiola aberta. 404 = nexus anterior (esconder o widget; nunca bloquear o ship por isso). */
/**
 * Id da ESTAÇÃO (instalação, `berzerk_station_id` de Configurações). Gaiola é
 * POR MÁQUINA (15/10): vai no body do ship/fechar e na query do GET; o nexus
 * escopa a gaiola aberta por ele. Vai como campo, não header: o CORS do API
 * Gateway só libera os headers listados no berzerk-infra. Nexus antigo ignora.
 */
function estacaoId(): string | null {
  try {
    return getStationId();
  } catch {
    return null;
  }
}

export function getGaiola(): Promise<GaiolaStatus> {
  if (isExpedicaoSimulacao()) return Promise.resolve(mockGaiolaStatus());
  const estacao = estacaoId();
  return apiRequest<GaiolaStatus>("/expedicao/gaiola", estacao ? { query: { estacaoId: estacao } } : undefined);
}

/** Fecha a gaiola aberta e congela o romaneio dela. 409 `gaiola_vazia` sem pedido. Não abre a próxima. */
export function fecharGaiola(notes?: string | null): Promise<{ gaiola: Gaiola; romaneio: Manifest }> {
  if (isExpedicaoSimulacao()) return Promise.resolve(mockFecharGaiola(notes ?? null));
  const estacao = estacaoId();
  return apiRequest<{ gaiola: Gaiola; romaneio: Manifest }>("/expedicao/gaiola/fechar", {
    method: "POST",
    body: {
      ...(notes && notes.trim() ? { notes: notes.trim() } : {}),
      ...(estacao ? { estacaoId: estacao } : {}),
    },
  });
}

/** Romaneio já fechado (reimpressão). */
export function getManifest(id: string): Promise<Manifest> {
  if (isExpedicaoSimulacao()) return Promise.resolve(mockManifest(id));
  return apiRequest<Manifest>(`/expedicao/manifests/${id}`);
}

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

/**
 * Cruza os EPCs lidos na mesa com pedidos `awaiting_pickup`. Manda em chunks de
 * ≤200 e MESCLA por pedido (uma leva grande pode partir as tags entre chunks).
 * `matches` ordenado por `createdAt` asc (mais antigo primeiro).
 */
export async function epcMatch(epcs: string[]): Promise<EpcMatchResponse> {
  const norm = Array.from(new Set(epcs.map((e) => e.trim().toUpperCase()).filter(Boolean)));
  if (norm.length === 0) return { matches: [], unmatchedEpcs: [], jaExpedidos: [] };

  if (isExpedicaoSimulacao()) return mockMatch(norm);

  const chunks: string[][] = [];
  for (let i = 0; i < norm.length; i += MATCH_CHUNK) chunks.push(norm.slice(i, i + MATCH_CHUNK));

  const orderById = new Map<string, ExpedicaoOrder>();
  const lidasByOrder = new Map<string, Set<string>>();
  const unmatched = new Set<string>();
  const jaExpedidos = new Map<string, JaExpedido>();

  for (const chunk of chunks) {
    const res = await apiRequest<EpcMatchResponse>("/expedicao/epc-match", {
      method: "POST",
      body: { epcs: chunk },
    });
    for (const m of res.matches ?? []) {
      orderById.set(m.order.id, m.order);
      const set = lidasByOrder.get(m.order.id) ?? new Set<string>();
      for (const t of m.tagsLidas) set.add(t.toUpperCase());
      lidasByOrder.set(m.order.id, set);
    }
    for (const e of res.unmatchedEpcs ?? []) unmatched.add(e.toUpperCase());
    for (const j of res.jaExpedidos ?? []) jaExpedidos.set(j.epc.toUpperCase(), j);
  }

  // Uma tag "unmatched" num chunk pode ter casado noutro — remove da lista final.
  const casadas = new Set<string>();
  for (const set of lidasByOrder.values()) for (const t of set) casadas.add(t);

  const matches: EpcMatch[] = Array.from(orderById.values()).map((order) => {
    const lidas = Array.from(lidasByOrder.get(order.id) ?? []);
    const todas = (order.rfidTags ?? []).map((t) => t.toUpperCase());
    const faltantes = todas.filter((t) => !lidas.includes(t));
    return {
      order,
      tagsLidas: lidas,
      tagsFaltantes: faltantes,
      tagsMatched: lidas.length,
      tagsTotal: todas.length || lidas.length + faltantes.length,
    };
  });
  matches.sort((a, b) => a.order.createdAt.localeCompare(b.order.createdAt));

  return {
    matches,
    unmatchedEpcs: Array.from(unmatched).filter((t) => !casadas.has(t) && !jaExpedidos.has(t)),
    jaExpedidos: Array.from(jaExpedidos.values()),
  };
}

/** Documentos do pedido (etiqueta J&T + DANFE + rastreio). */
export function getDocumentos(orderId: string): Promise<Documentos> {
  if (isExpedicaoSimulacao()) return Promise.resolve(mockDocumentos(orderId));
  return apiRequest<Documentos>(`/expedicao/orders/${orderId}/documentos`);
}

/**
 * Marca a etiqueta J&T como impressa (passo OBRIGATÓRIO antes do ship — o ship
 * valida `printed_at` no servidor). Chamar após imprimir a etiqueta com sucesso.
 */
export function markLabelPrinted(tinyOrderNumber: string, tinyAccount: "FM" | "JT"): Promise<void> {
  if (isExpedicaoSimulacao()) return Promise.resolve();
  return apiRequest<void>("/expedicao/labels/printed", {
    method: "POST",
    body: { tinyOrderNumber, tinyAccount },
  });
}

/**
 * Marca o pedido como `shipped` (grava ator+timestamp, replica pro Tiny).
 * Idempotente: já-shipped devolve 200 com o pedido como está (retry seguro).
 * Erros: TRACKING_REQUIRED, JT_LABEL_REQUIRED, tags_incompletas, invalid_status,
 * order_not_found, awb_ja_coletado (ver `liberacaoAwbColetado`).
 */
export function shipOrder(
  orderId: string,
  rfidTags: string[],
  override?: ShipOverride,
  leituras?: LeituraResolvida[],
  /** Reenvio depois de um 409 `awb_ja_coletado` liberado por um supervisor (PIN validado
   *  server-side). Aditivo — sem ela o corpo do `ship` fica como sempre foi. */
  liberacaoAwbColetado?: LiberacaoAwbColetado,
): Promise<ExpedicaoOrder> {
  // `new Promise`: o 409 `gaiola_cheia` simulado vira rejeição, como na rede.
  if (isExpedicaoSimulacao()) return new Promise((resolve) => resolve(mockShip(orderId)));
  // `leituras` = resolução EPC→peça que a mesa fez pela nuvem iTAG (mesmo
  // shape do `complete` da separação). Sem ela o nexus casa as peças SÓ pela
  // réplica rfid_epc_inventory e todo EPC fora da réplica vira "peça
  // faltando" → `pecas_insuficientes` com a trava de supervisor ligada
  // (04/09: modal de motivo em todo pedido da mesa, mesmo completo).
  return apiRequest<ExpedicaoOrder>(`/expedicao/orders/${orderId}/ship`, {
    method: "POST",
    body: {
      rfidTags,
      ...(override ? { override } : {}),
      ...(leituras && leituras.length > 0 ? { leituras } : {}),
      ...(liberacaoAwbColetado ? { liberacaoAwbColetado } : {}),
      // Gaiola por máquina (15/10) — ver `estacaoId`.
      ...(estacaoId() ? { estacaoId: estacaoId() } : {}),
    },
  });
}

/**
 * Pedidos expedidos (busca + período sobre `shipped_at`). Por padrão só os do
 * ATOR logado; `todos: true` traz a ESTAÇÃO INTEIRA — o turno troca no meio do
 * dia e quem está na mesa precisa reimprimir o que o colega expediu.
 */
export function getExpedicaoHistory(params: {
  q?: string;
  dateFrom?: string;
  dateTo?: string;
  todos?: boolean;
  limit?: number;
  offset?: number;
}): Promise<ExpedicaoHistoryResponse> {
  if (isExpedicaoSimulacao()) {
    return Promise.resolve({ items: [], total: 0, totals: { pedidos: 0, itens: 0, tags: 0 } });
  }
  return apiRequest<ExpedicaoHistoryResponse>("/expedicao/history", {
    query: {
      q: params.q || undefined,
      dateFrom: params.dateFrom || undefined,
      dateTo: params.dateTo || undefined,
      todos: params.todos ? "true" : undefined,
      limit: params.limit?.toString(),
      offset: params.offset?.toString(),
    },
  });
}

/**
 * Avisa o servidor que o documento foi mandado PRA IMPRESSORA de novo — só
 * trilha (auditoria + `printed_at` da etiqueta). NÃO muda o status do pedido.
 *
 * Best-effort de propósito: o papel já saiu quando isto roda, então falhar
 * aqui não pode virar erro na cara do embalador. Nunca rejeita.
 */
export async function registrarReimpressao(
  orderId: string,
  documento: DocumentoReimpressao,
  origem: "historico" | "ja_expedido" | "mesa",
): Promise<void> {
  if (isExpedicaoSimulacao()) return;
  try {
    await apiRequest<{ ok: true }>(`/expedicao/orders/${orderId}/reimpressao`, {
      method: "POST",
      body: { documento, origem },
    });
  } catch {
    /* trilha não trava a mesa */
  }
}

/** Permissão exigida pra operar a Expedição (o ator dev com `*` passa). */
export function canOperateExpedicao(me: Me): boolean {
  return me.permissions.includes("*") || me.permissions.includes("expedicao:operate");
}

// ---------------------------------------------------------------------------
// Mocks (só quando a Simulação está ligada) — ensaia a mesa sem o nexus
// ---------------------------------------------------------------------------

function mockOrderFor(epcs: string[]): ExpedicaoOrder {
  const seed = epcs[0] ?? "MOCK";
  const numero = `BRZ-${(parseInt(seed.slice(-4), 16) % 9000) + 1000}`;
  const now = new Date().toISOString();
  return {
    id: `mock-${seed}`,
    tinyOrderId: numero,
    numero,
    tinyAccount: "JT",
    status: "awaiting_pickup",
    channel: "shopify",
    clienteNome: "Cliente Demonstração",
    dataEmissao: now,
    prioritario: false,
    trackingNumber: `JT${seed.slice(-8).toUpperCase()}`,
    rfidTags: epcs.slice(0, 3),
    separatedBy: "mock",
    separatedAt: now,
    shippedBy: null,
    shippedAt: null,
    shippedWithoutLabel: false,
    labelPrintedAt: null,
    hasDanfeCached: true,
    items: epcs.slice(0, 3).map((_, i) => ({
      id: `it-${i}`,
      ean: `789${(i + 1).toString().padStart(10, "0")}`,
      sku: `SKU-${i + 1}`,
      nome: `Peça demonstração ${i + 1}`,
      tamanho: "M",
      quantidade: 1,
      imagemUrl: null,
    })),
    createdAt: now,
    updatedAt: now,
  };
}

function mockMatch(epcs: string[]): EpcMatchResponse {
  const order = mockOrderFor(epcs);
  const todas = (order.rfidTags ?? []).map((t) => t.toUpperCase());
  const lidas = epcs.filter((e) => todas.includes(e));
  const faltantes = todas.filter((t) => !lidas.includes(t));
  return {
    matches: [
      {
        order,
        tagsLidas: lidas,
        tagsFaltantes: faltantes,
        tagsMatched: lidas.length,
        tagsTotal: todas.length,
      },
    ],
    unmatchedEpcs: epcs.filter((e) => !todas.includes(e)),
    jaExpedidos: [],
  };
}

function mockDocumentos(orderId: string): Documentos {
  const emitente: DanfePessoa = {
    nome: "BERZERK COMERCIO DE ROUPAS LTDA",
    cnpj: "00.000.000/0001-00",
    ie: "000.000.000.000",
    endereco: "Rua Industrial",
    numero: "1000",
    bairro: "Distrito",
    cidade: "São Paulo",
    uf: "SP",
    cep: "00000-000",
  };
  const cliente: DanfePessoa = {
    nome: "Cliente Demonstração",
    cpf_cnpj: "111.111.111-11",
    tipo_pessoa: "F",
    endereco: "Rua das Flores",
    numero: "42",
    complemento: "Apto 3",
    bairro: "Centro",
    cidade: "Rio de Janeiro",
    uf: "RJ",
    cep: "20000-000",
  };
  return {
    danfe: {
      numero: "123456",
      serie: "1",
      data_emissao: new Date().toISOString(),
      natureza_operacao: "Venda de mercadoria",
      chave_acesso: "35250100000000000100550010001234561000000019",
      protocolo: "135250000000000",
      data_protocolo: new Date().toISOString(),
      emitente,
      cliente,
      itens: [
        { codigo: "SKU-1", descricao: "Peça demonstração 1 - M", ncm: "61091000", cfop: "6108", unidade: "UN", quantidade: "1", valor_unitario: "99.90", valor_total: "99.90" },
        { codigo: "SKU-2", descricao: "Peça demonstração 2 - M", ncm: "61091000", cfop: "6108", unidade: "UN", quantidade: "1", valor_unitario: "99.90", valor_total: "99.90" },
      ],
      valor_produtos: "199.80",
      valor_frete: "0.00",
      valor_desconto: "0.00",
      valor_nota: "199.80",
      transportador: { nome: "J&T EXPRESS" },
      volumes: { quantidade: "1", especie: "Volume", peso_liquido: "0.40", peso_bruto: "0.50" },
      informacoes_adicionais: "Documento de demonstração (modo simulação).",
    },
    etiqueta: null, // sem PDF real no mock; o fluxo trata etiqueta ausente
    trackingNumber: `JT${orderId.slice(-8).toUpperCase()}`,
  };
}

function mockShip(orderId: string): ExpedicaoOrder {
  const o = mockOrderFor([orderId]);
  const gaiola = mockGaiolaShip(); // lança o 409 `gaiola_cheia` no teto da simulação
  return { ...o, status: "shipped", shippedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), gaiola };
}

// ---- simulação da gaiola (sem servidor) ----
let mockGaiola: { numero: number; contagem: number; abertaEm: string } | null = null;
let mockUltima: Gaiola | null = null;
const MOCK_GAIOLA_LIMITE = 5;

function mockGaiolaStatus(): GaiolaStatus {
  const aberta: Gaiola | null = mockGaiola
    ? { id: `gaiola-${mockGaiola.numero}`, numero: mockGaiola.numero, abertaEm: mockGaiola.abertaEm, fechadaEm: null, contagem: mockGaiola.contagem, romaneioId: null }
    : null;
  return { aberta, limite: MOCK_GAIOLA_LIMITE, travada: !!aberta && aberta.contagem >= MOCK_GAIOLA_LIMITE, ultimaFechada: mockUltima };
}

/** Sobe o contador da simulação; devolve o resumo do ship ou lança o 409 `gaiola_cheia`. */
function mockGaiolaShip(): GaiolaDoShip {
  if (mockGaiola && mockGaiola.contagem >= MOCK_GAIOLA_LIMITE) {
    throw new ApiError(409, "A gaiola está cheia (simulação).", {
      error: EXP_ERR.GAIOLA_CHEIA,
      message: `Gaiola ${mockGaiola.numero} está cheia (${mockGaiola.contagem}/${MOCK_GAIOLA_LIMITE}). Feche a gaiola pra continuar.`,
      gaiolaNumero: mockGaiola.numero,
      contagem: mockGaiola.contagem,
      limite: MOCK_GAIOLA_LIMITE,
    });
  }
  if (!mockGaiola) mockGaiola = { numero: (mockUltima?.numero ?? 0) + 1, contagem: 0, abertaEm: new Date().toISOString() };
  mockGaiola.contagem += 1;
  return { id: `gaiola-${mockGaiola.numero}`, numero: mockGaiola.numero, contagem: mockGaiola.contagem, limite: MOCK_GAIOLA_LIMITE };
}

function mockFecharGaiola(notes: string | null): { gaiola: Gaiola; romaneio: Manifest } {
  if (!mockGaiola || mockGaiola.contagem === 0) {
    throw new ApiError(409, "Sem gaiola aberta.", { error: EXP_ERR.GAIOLA_VAZIA, message: "Não há gaiola aberta com pedidos pra fechar." });
  }
  const agora = new Date().toISOString();
  const romaneioId = `romaneio-${mockGaiola.numero}`;
  const gaiola: Gaiola = { id: `gaiola-${mockGaiola.numero}`, numero: mockGaiola.numero, abertaEm: mockGaiola.abertaEm, fechadaEm: agora, contagem: mockGaiola.contagem, romaneioId };
  const romaneio: Manifest = {
    ...mockManifest(romaneioId),
    manifestNumber: mockGaiola.numero,
    orderCount: mockGaiola.contagem,
    closedAt: agora,
    notes: `Gaiola ${mockGaiola.numero}${notes ? ` · ${notes}` : ""}`,
    orders: Array.from({ length: mockGaiola.contagem }, (_, i) => ({
      orderId: `sim-${i + 1}`,
      tinyOrderNumber: `${900000 + i + 1}`,
      tinyAccount: i % 2 ? "FM" : "JT",
      cliente: `Cliente simulado ${i + 1}`,
      trackingCode: `BR${String(100000 + i).padStart(9, "0")}JT`,
      printedAt: agora,
    })),
  };
  mockUltima = gaiola;
  mockGaiola = null;
  return { gaiola, romaneio };
}

function mockManifest(id: string): Manifest {
  return {
    id,
    manifestNumber: mockUltima?.numero ?? 1,
    manifestDate: new Date().toISOString().slice(0, 10),
    orderCount: mockUltima?.contagem ?? 0,
    closedAt: mockUltima?.fechadaEm ?? new Date().toISOString(),
    closedByName: "Simulação",
    notes: mockUltima ? `Gaiola ${mockUltima.numero}` : null,
    orders: [],
  };
}

// Wrappers da separacao-api (fila de separação). Os tipos espelham
// @berzerk/contracts (o app é repo separado, então duplicamos os shapes).

import { ApiError, apiRequest } from "../lib/api";

export type OrderStatus =
  | "received"
  | "processing"
  | "invoiced"
  | "ready"
  | "separating"
  /** EM ESPERA por ruptura: a operadora marcou itens faltantes e o pedido saiu da fila. */
  | "on_hold"
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
  /** Quando ELA abriu o card pra conferir (`POST /separacao/:id/iniciar`).
   *  null/ausente = o servidor ainda pode realocar este pedido pra outra
   *  estação quando a fila acabar — ver `iniciarSeparacao`. */
  iniciadoEm?: string | null;
  /**
   * Quando a LISTA de picking deste pedido foi impressa. Com carimbo, o pedido
   * fica preso na mesa dela: o janitor não devolve e o rebalanceamento não
   * realoca — a coleta dos mistos leva o dia. Ausente = nexus antigo.
   */
  listaEm?: string | null;
  /** A lista é de um dia ANTERIOR — o app oferece Retomar/Devolver. */
  listaDeOutroDia?: boolean;
  /** Id de `separacao_listas` gerado na última impressão que carimbou este
   *  pedido. `null`/ausente = pedido preso sem lista associada (nexus antigo,
   *  ou `marcarListaImpressa` que não devolveu `listaId`). */
  listaId?: string | null;
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
  /**
   * Trava `separacao_liberacao_supervisor_ativa` do nexus (Configurações →
   * Separação): `false` deixa a operadora concluir com peças faltando SEM o PIN
   * do supervisor (a conclusão vira auditoria sem supervisor do lado de lá).
   * AUSENTE = `true`: nexus anterior a 27/08 não conhece o campo e lá a
   * exigência é incondicional — assumir o contrário afrouxaria uma trava por
   * causa da versão do servidor.
   */
  liberacaoSupervisorAtiva?: boolean;
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

/**
 * Contagem das filas. Aceita os MESMOS filtros da listagem: sem eles o tile
 * dizia "637 pedidos" e a fila filtrada entregava 55. Nexus antigo ignora os
 * campos extras (zod strip) e devolve a fila inteira, como antes.
 */
export function getQueueCounts(filters?: QueueFilters): Promise<QueueCounts> {
  return apiRequest<QueueCounts>("/separacao/queues", {
    query: {
      dateFrom: filters?.dateFrom || undefined,
      dateTo: filters?.dateTo || undefined,
      includeProducts: filters?.includeProducts?.length
        ? filters.includeProducts.join(",")
        : undefined,
      excludeProducts: filters?.excludeProducts?.length
        ? filters.excludeProducts.join(",")
        : undefined,
    },
  });
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
  /** BUCKET da fila (XG cobre XXG/G1/G2/G3, P cobre PP) — é o que o lote usa. */
  sizes?: string[];
  dateFrom?: string;
  dateTo?: string;
  filters?: QueueFilters;
}): Promise<QueueProductsResponse> {
  const f = params.filters;
  return comModo(params.mode, (mode) =>
    apiRequest<QueueProductsResponse>("/separacao/queue-products", {
      query: {
        mode,
        // `size` continua indo pra nexus antigo entender o recorte; `sizes`
        // (plural) é o que o nexus novo usa, e vence quando os dois chegam.
        size: params.size,
        sizes: params.sizes?.length ? params.sizes.join(",") : undefined,
        dateFrom: params.dateFrom || undefined,
        dateTo: params.dateTo || undefined,
        includeProducts: f?.includeProducts?.length ? f.includeProducts.join(",") : undefined,
        excludeProducts: f?.excludeProducts?.length ? f.excludeProducts.join(",") : undefined,
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
  /** BUCKET da fila — mesma semântica do lote. */
  sizes?: string[];
  filters?: QueueFilters;
}): Promise<QueueDatesResponse> {
  const f = params.filters;
  return comModo(params.mode, (mode) =>
    apiRequest<QueueDatesResponse>("/separacao/queue-dates", {
      query: {
        mode,
        size: params.size,
        sizes: params.sizes?.length ? params.sizes.join(",") : undefined,
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

/**
 * Puxa/repõe o LOTE da operadora: IDEMPOTENTE — devolve TODOS os pedidos em
 * aberto dela nessa fila e completa o que faltar até o alvo. Chamar ao entrar
 * na fila, depois de cada complete/release e no `queue.changed`.
 *
 * **Quem decide o tamanho é o SERVIDOR** desde a 0.9.3: a configuração
 * `separacao_lote_tamanho` (Configurações do Nexus → Separação), que é POR
 * MODO — 10 nos puros, 50 nos mistos. O app não manda mais `quantidade`:
 * mandar seria um teto a mais (o `10` fixo das 0.9.0–0.9.3 travava o lote de
 * mistos em 10) e a coordenação perderia o controle do número sem publicar uma
 * versão nova do desktop.
 *
 * A resposta é o RETRATO ATUAL do lote dela nessa fila, e pode vir MENOR do
 * que o que ela tinha: quando a fila esgota, o servidor redistribui os pedidos
 * NÃO INICIADOS entre quem está separando (ver `iniciarSeparacao`). Por isso a
 * tela substitui a sidebar inteira pela resposta, nunca faz merge.
 */
export function claimLote(params: {
  mode: SeparationMode;
  sizes: string[];
  filters?: QueueFilters;
}): Promise<LoteResponse> {
  return comModo(params.mode, (mode) =>
    apiRequest<LoteResponse>("/separacao/lote", {
      method: "POST",
      body: {
        // Sem `quantidade`: o alvo é a configuração do nexus, por modo.
        mode,
        sizes: params.sizes,
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
 * Marca no servidor que ELA ABRIU o pedido pra conferir
 * (`orders.iniciado_em`). É o que trava a redistribuição: quando a fila acaba
 * e outra estação entra, o servidor só pode tirar dela os pedidos que ainda
 * NÃO foram iniciados — as peças de um pedido iniciado já estão na bancada.
 *
 * Idempotente no servidor (o primeiro carimbo vale) e best-effort aqui: falha
 * de rede não pode travar a conferência, e a tela repete a chamada quando o
 * pedido volta pra mesa. 404 = nexus anterior a 26/08 (sem a rota) — o app
 * segue funcionando, só sem a proteção.
 */
export function iniciarSeparacao(orderId: string): Promise<{ id: string; iniciadoEm: string } | null> {
  return apiRequest<{ id: string; iniciadoEm: string }>(`/separacao/${orderId}/iniciar`, {
    method: "POST",
    body: {},
  }).catch((e: unknown) => {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  });
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
/**
 * Devolve pedidos da mesa pra fila. Pedido com LISTA IMPRESSA só volta se
 * `incluirLista: true` (ação explícita da operadora) — a API ignora os
 * outros (nexus #218): logout, bloqueio e "sair da fila" mandam os ids e a
 * lista fica presa com quem imprimiu, até a virada do dia.
 */
export function devolverLote(orderIds?: string[], opts?: { incluirLista?: boolean }): Promise<{ devolvidos: number }> {
  return apiRequest<{ devolvidos: number }>("/separacao/lote/devolver", {
    method: "POST",
    body: {
      ...(orderIds && orderIds.length > 0 ? { orderIds } : {}),
      ...(opts?.incluirLista ? { incluirLista: true } : {}),
    },
  }).catch(async (e: unknown) => {
    // Degradação (nexus sem o endpoint): devolve um a um os ids que o caller
    // conhece. Sem ids não há o que fazer aqui — o janitor recupera.
    if (!(e instanceof ApiError) || e.status !== 404) throw e;
    if (!orderIds || orderIds.length === 0) return { devolvidos: 0 };
    const rs = await Promise.allSettled(orderIds.map((id) => releaseSeparacao(id)));
    return { devolvidos: rs.filter((r) => r.status === "fulfilled").length };
  });
}

/**
 * LISTA IMPRESSA: avisa o nexus que a folha de picking destes pedidos saiu na
 * impressora. A partir daí eles ficam PRESOS na mesa da operadora — o janitor
 * de 15 min não devolve e o rebalanceamento não realoca —, porque a coleta dos
 * mistos leva o dia e a lista já está circulando no galpão.
 *
 * `escopo`/`filtros`/`secoes` são ADITIVOS (02/09, incidente da lista sem
 * volta): viram o snapshot em `separacao_listas`, pro pedido que sumir da mesa
 * antes de embalar poder voltar pela lista impressa (`services/listas.ts`).
 * Sem eles (ou em nexus antigo) o carimbo continua funcionando — só não fica
 * lista pra recuperar depois.
 *
 * Best-effort: nexus antigo (404) simplesmente não tem o carimbo, e o pior caso
 * é o comportamento de antes. Nunca vira erro na cara de quem já imprimiu.
 */
export function marcarListaImpressa(params: {
  orderIds: string[];
  /** O recorte que a operadora estava vendo ao imprimir. */
  escopo?: "lote" | "secao";
  /** Filtros ativos no app no momento da impressão. */
  filtros?: unknown;
  /** Documento agregado como impresso (picking geral), sem o base64 do PDF. */
  secoes?: unknown;
}): Promise<{ presos: number; listaId: string | null }> {
  if (params.orderIds.length === 0) return Promise.resolve({ presos: 0, listaId: null });
  return apiRequest<{ presos: number; listaId: string | null }>("/separacao/lote/lista", {
    method: "POST",
    body: params,
  }).catch((e: unknown) => {
    if (e instanceof ApiError && e.status === 404) return { presos: 0, listaId: null };
    throw e;
  });
}

// ---------------------------------------------------------------------------
// Rupturas — "Itens faltantes" (o botão do posvenda legado)
// ---------------------------------------------------------------------------

/** Um item que faltou na prateleira, com a quantidade que faltou. */
export type ItemFaltante = {
  orderItemId: string;
  quantidade: number;
};

export type CriarRupturaResponse = {
  /** `true` quando o pedido saiu da fila (virou `on_hold` e soltou o claim). */
  pedidoEmEspera?: boolean;
  pedidoStatus?: OrderStatus;
  webhookStatus?: number | string;
};

/**
 * Marca itens FALTANTES de um pedido — o "ITENS FALTANTES" do pós-venda
 * legado. O servidor registra a ruptura, TIRA o pedido da fila (`on_hold`),
 * solta o claim e avisa o cliente pelo webhook do chat; o app repõe o lote em
 * seguida. Quem resolve é a supervisão, na tela de Rupturas do Nexus.
 */
export function criarRuptura(params: {
  orderId: string;
  itens: ItemFaltante[];
  observacao?: string;
}): Promise<CriarRupturaResponse> {
  return apiRequest<CriarRupturaResponse>("/separacao/rupturas", {
    method: "POST",
    body: {
      orderId: params.orderId,
      itens: params.itens.map((i) => ({ orderItemId: i.orderItemId, quantidade: i.quantidade })),
      ...(params.observacao?.trim() ? { observacao: params.observacao.trim() } : {}),
    },
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

/** GET com query string: acima de ~100 EPCs (25 chars cada) a URL passa dos
 *  limites do API Gateway e volta 4xx genérico — chunka e junta. */
const EPC_LOOKUP_CHUNK = 100;
export async function epcLookup(epcs: string[]): Promise<{ items: EpcLookupItem[] }> {
  const items: EpcLookupItem[] = [];
  for (let i = 0; i < epcs.length; i += EPC_LOOKUP_CHUNK) {
    const chunk = epcs.slice(i, i + EPC_LOOKUP_CHUNK);
    const r = await apiRequest<{ items: EpcLookupItem[] }>("/separacao/epc-lookup", {
      query: { epcs: chunk.join(",") },
    });
    items.push(...r.items);
  }
  return { items };
}

/** Permissão exigida pra operar a fila (o ator dev com `*` passa). */
export function canOperateSeparacao(me: Me): boolean {
  return me.permissions.includes("*") || me.permissions.includes("separacao:operate");
}

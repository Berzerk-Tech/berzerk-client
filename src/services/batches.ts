// Fila de lotes a etiquetar — agora contra a API do NEXUS.
//
// Até a v0.7.0 este arquivo lia o Supabase industrial direto (`silk_records` +
// `production_batches`) e carimbava `rfid_impresso_at` lá. A fase 3 do
// `docs/plano-corte-supabase.md` do nexus levou tudo isso para o RDS:
//
//   silk_records.status='enviado_recebimento'  → GET /etiquetagem/lotes
//   production_batches.grade / deleted_at      → idem
//   production_batches.rfid_impresso_at        → POST/DELETE /etiquetagem/lotes/:id/impresso
//   design_templates + unified_products +
//     edge shopify-analytics (EAN por tamanho) → GET /etiquetagem/lotes/:id/eans
//
// Os TIPOS exportados mantêm os nomes que o `BatchBrowser` já usava
// (snake_case herdado do Supabase) de propósito: a troca é de FONTE, não de
// tela, e um rename global aqui misturaria dois riscos numa mudança só.

import { apiRequest } from "../lib/api";
import { compareSizes, type GradeEntry } from "../lib/grade";
import type { PrintJobItem } from "../lib/itag/iprint";
import { formatLabelDescription } from "../lib/labelFormatter";

/** De onde veio o EAN. Hoje só há uma fonte: o catálogo canônico do nexus. */
export type EanSource = "catalogo";

export type ProductionBatch = {
  id: string;
  batch_code: string;
  design_name: string | null;
  /** Tipo/modelo do produto (ex: "Oversized"). Parte do nome impresso. */
  product_name: string | null;
  /**
   * Referência Tiny do lote. Continua `null`: o industrial nunca publicou a
   * coluna, e o nexus não tem de onde tirá-la. Quando existir, entra no DTO da
   * fila e some este comentário. Enquanto null, a etiqueta usa o nome do
   * catálogo (ver labelFormatter).
   */
  tiny_reference: string | null;
  shirt_color: string | null;
  sizes: GradeEntry[];
  total_pieces: number;
  created_at: string;
  thumbnail_url: string | null;
  /** Etapa de recebimento (`enviado_recebimento`, `aguardando_retirada`, …). */
  receiptStatus: string;
};

/** Rótulos amigáveis dos status de recebimento (UI). */
export const RECEIPT_STATUS_LABEL: Record<string, string> = {
  recebimento_confirmado: "Confirmado",
  aguardando_retirada: "Aguardando retirada",
  enviado_recebimento: "Enviado p/ recebimento",
  aguardando_autorizacao: "Aguardando autorização",
};

/** Por que o lote não imprime — o nexus distingue as duas causas. */
export type MotivoBloqueio = "sem_vinculo" | "sem_ean";

/** Texto para a operadora: cada motivo tem um conserto e um dono diferentes. */
export const MOTIVO_BLOQUEIO_LABEL: Record<MotivoBloqueio, string> = {
  sem_vinculo:
    "Lote sem produto vinculado no catálogo do Nexus — a coordenação precisa vincular para o EAN aparecer.",
  sem_ean: "Faltam EAN13 no catálogo para alguns tamanhos deste lote.",
};

export type ResolvedBatch = {
  batch: ProductionBatch;
  eans: Record<string, string>;
  skus: Record<string, string>;
  sources: Record<string, EanSource>;
  missingSizes: string[];
  isPrintable: boolean;
  /** Nome do produto no catálogo do nexus — a fonte do nome impresso. */
  catalogTitle: string | null;
  catalogColor: string | null;
  /** `null` quando imprime. */
  motivo: MotivoBloqueio | null;
  /** A consulta ao Nexus falhou (rede, 5xx, 426): não é falta de EAN, é
   *  falta de resposta — a mensagem pra operadora precisa dizer isso. */
  erro?: string | null;
};

/**
 * Por que este lote não imprime, em texto pra operadora — com o conserto e o
 * dono certos (relato de 02/09: a caixa dizia "sem cobertura de EAN13" até
 * quando o problema era vínculo, ou a API fora do ar).
 */
export function mensagemBloqueio(r: ResolvedBatch): { titulo: string; mensagem: string } {
  const codigo = r.batch.batch_code;
  if (r.erro) {
    return {
      titulo: `Não deu pra consultar o catálogo do lote ${codigo}`,
      mensagem: `${r.erro}. Tente de novo em instantes; se persistir, avise a tecnologia.`,
    };
  }
  const faltam = r.missingSizes.length ? r.missingSizes.join(", ") : "todos os tamanhos";
  if (r.motivo === "sem_vinculo") {
    return {
      titulo: `Lote ${codigo} sem produto vinculado`,
      mensagem:
        "O lote não está ligado a nenhum produto do catálogo do Nexus, então não há EAN pra etiqueta. " +
        "A coordenação precisa abrir o lote no Nexus e usar \"Vincular produto\".",
    };
  }
  return {
    titulo: `Lote ${codigo} sem EAN13 (${faltam})`,
    mensagem:
      `${r.catalogTitle ? `O produto "${r.catalogTitle}" está vinculado, mas` : "O produto vinculado"} ` +
      `não tem EAN cadastrado pros tamanhos ${faltam}. ` +
      "A coordenação precisa cadastrar os EANs no Catálogo do Nexus.",
  };
}

export type PrintedBatchEntry = {
  id: string;
  batch_code: string;
  design_name: string | null;
  total_pieces: number;
  rfid_impresso_at: string;
  thumbnail_url: string | null;
};

// ────────────────────────────────────────────────────────────
// DTOs da API (espelho de `packages/contracts/src/etiquetagem.ts`)
// ────────────────────────────────────────────────────────────

type LoteDto = {
  id: string;
  codigo: string;
  estampa: string | null;
  produto: string | null;
  cor: string | null;
  tamanhos: { tamanho: string; quantidade: number }[];
  totalPecas: number;
  criadoEm: string;
  rfidImpressoEm: string | null;
  estagio: string | null;
  deletado: boolean;
  produtoId: string | null;
  corId: string | null;
  thumbnailUrl: string | null;
};

type LotesDto = { lotes: LoteDto[]; total: number; limite: number };

type EansDto = {
  produtoId: string | null;
  produtoNome: string | null;
  corNome: string | null;
  vinculoOrigem: "vinculo" | "nome_exato" | "nome_normalizado" | "nenhum";
  thumbnailUrl: string | null;
  eans: { tamanho: string; ean: string | null; sku: string | null }[];
  tamanhosFaltando: string[];
  imprimivel: boolean;
  motivo: MotivoBloqueio | null;
};

type ImpressoDto = {
  loteId: string;
  codigo: string;
  rfidImpressoEm: string | null;
  mudou: boolean;
};

function toBatch(dto: LoteDto): ProductionBatch {
  return {
    id: dto.id,
    batch_code: dto.codigo,
    design_name: dto.estampa,
    product_name: dto.produto,
    tiny_reference: null,
    shirt_color: dto.cor,
    sizes: dto.tamanhos.map((t) => ({ size: t.tamanho, quantity: t.quantidade })),
    total_pieces: dto.totalPecas,
    created_at: dto.criadoEm,
    thumbnail_url: dto.thumbnailUrl,
    receiptStatus: dto.estagio ?? "",
  };
}

// ────────────────────────────────────────────────────────────
// Fila e histórico
// ────────────────────────────────────────────────────────────

const LIMITE = "200";

/** Fila de lotes pendentes + o total real no servidor (pode passar do que veio). */
export type PendingBatchesResult = {
  batches: ProductionBatch[];
  /** Total no servidor pro recorte pedido — pode ser maior que `batches.length`. */
  total: number;
};

/**
 * Lotes prontos pra aparecer na Produção (não impressos ainda).
 *
 * Aparecem os lotes na etapa **"Env. Recebimento"** — o estágio em que a
 * etiqueta RFID deve ser impressa. O recorte agora é do servidor, que aceita
 * TANTO o status do motor de workflow quanto o espelho do legado: é o que faz
 * a fila continuar cheia no dia em que o lote passar a nascer só no nexus.
 *
 * Dedup por `id` como rede de segurança: já houve duplicidade por JOIN no
 * backend, e um lote duplicado aqui renderiza em dobro e pode disparar dois
 * `createPrintJob` pro mesmo lote.
 */
export async function fetchPendingBatches(): Promise<PendingBatchesResult> {
  const dto = await apiRequest<LotesDto>("/etiquetagem/lotes", {
    query: { status: "pendente", escopo: "fila", limite: LIMITE },
  });
  const batches = Array.from(
    new Map(dto.lotes.map((l) => [l.id, toBatch(l)])).values(),
  );
  return { batches, total: dto.total };
}

/** Lotes carimbados como impressos HOJE (o Histórico da tela). */
export async function fetchTodayHistory(): Promise<PrintedBatchEntry[]> {
  const inicioDoDia = new Date();
  inicioDoDia.setHours(0, 0, 0, 0);
  const dto = await apiRequest<LotesDto>("/etiquetagem/lotes", {
    query: {
      status: "impresso",
      escopo: "fila",
      desde: inicioDoDia.toISOString(),
      limite: "50",
    },
  });
  const entries = dto.lotes.map((l) => ({
    id: l.id,
    batch_code: l.codigo,
    design_name: l.estampa,
    total_pieces: l.totalPecas,
    // O DTO só traz `impresso` com carimbo — o `?? ''` é só pro tipo.
    rfid_impresso_at: l.rfidImpressoEm ?? "",
    thumbnail_url: l.thumbnailUrl,
  }));
  // Mesma rede de segurança de fetchPendingBatches — dedup por id.
  return Array.from(new Map(entries.map((e) => [e.id, e])).values());
}

/** Resultado da busca na base toda (sem filtro de etapa/carimbo). */
export type GlobalSearchEntry = {
  batch: ProductionBatch;
  /** null = ainda não impresso. */
  rfid_impresso_at: string | null;
  deleted: boolean;
};

/**
 * Busca GERAL: procura o lote na base toda, ignorando etapa de recebimento e
 * carimbo de impresso. Pra consulta, reimpressão ou voltar um lote pra fila
 * quando ele não aparece na listagem normal.
 */
export async function searchBatchesGlobal(query: string): Promise<GlobalSearchEntry[]> {
  const q = query.trim();
  if (!q) return [];
  const dto = await apiRequest<LotesDto>("/etiquetagem/lotes", {
    query: { status: "todos", escopo: "todos", q, limite: "30" },
  });
  return dto.lotes.map((l) => ({
    batch: toBatch(l),
    rfid_impresso_at: l.rfidImpressoEm,
    deleted: l.deletado,
  }));
}

// ────────────────────────────────────────────────────────────
// Carimbo de impresso
// ────────────────────────────────────────────────────────────

/**
 * Carimba o lote como impresso APÓS impressão REAL concluída. É esse carimbo
 * que tira o lote da fila e o põe no Histórico. Jobs de teste NÃO carimbam, e
 * impressão parcial também não — o lote fica na fila pra completar.
 *
 * Devolve 1 se carimbou agora, 0 se já estava carimbado (outra estação chegou
 * antes). Mesma semântica do `count` que o Supabase devolvia, pra não mudar o
 * tratamento em quem chama.
 */
export async function markBatchRfidPrinted(batchId: string): Promise<number> {
  const dto = await apiRequest<ImpressoDto>(`/etiquetagem/lotes/${batchId}/impresso`, {
    method: "POST",
    body: {},
  });
  return dto.mudou ? 1 : 0;
}

/**
 * Caminho de REIMPRESSÃO: limpa o carimbo e o lote volta pra fila da Produção.
 * Pra quando o job saiu `concluido` mas a impressão física falhou (a iTAG gera
 * os EPCs na hora; a impressora pode atolar/cancelar sem o app saber). Os EPCs
 * do job antigo ficam no inventário — a movimentação reconcilia com a iTAG e só
 * move o que ela confirma impresso.
 */
export async function unmarkBatchRfidPrinted(batchId: string): Promise<void> {
  await apiRequest<ImpressoDto>(`/etiquetagem/lotes/${batchId}/impresso`, {
    method: "DELETE",
  });
}

// ────────────────────────────────────────────────────────────
// EAN por tamanho
// ────────────────────────────────────────────────────────────

/**
 * Resolve os EAN13/SKU do lote no catálogo do nexus.
 *
 * UMA chamada por lote, contra as três do Supabase (`design_templates` →
 * `unified_products` → edge `shopify-analytics`). Some com o cache em memória e
 * em localStorage que existia só para amortizar aquelas chamadas — o servidor
 * responde por lote e não há o que amortizar.
 *
 * Nunca lança: falha vira lote não-imprimível, que é como a tela já tratava.
 */
export async function resolveBatch(batch: ProductionBatch): Promise<ResolvedBatch> {
  const sizes = batch.sizes.map((s) => s.size);
  const vazio = (motivo: MotivoBloqueio | null): ResolvedBatch => ({
    batch,
    eans: {},
    skus: {},
    sources: {},
    missingSizes: sizes,
    isPrintable: false,
    catalogTitle: batch.design_name,
    catalogColor: batch.shirt_color,
    motivo,
  });
  if (sizes.length === 0) return vazio("sem_ean");

  try {
    const dto = await apiRequest<EansDto>(`/etiquetagem/lotes/${batch.id}/eans`);
    const eans: Record<string, string> = {};
    const skus: Record<string, string> = {};
    const sources: Record<string, EanSource> = {};
    for (const e of dto.eans) {
      if (!e.ean) continue;
      eans[e.tamanho] = e.ean;
      skus[e.tamanho] = e.sku ?? e.ean;
      sources[e.tamanho] = "catalogo";
    }
    return {
      batch,
      eans,
      skus,
      sources,
      missingSizes: dto.tamanhosFaltando,
      isPrintable: dto.imprimivel,
      catalogTitle: dto.produtoNome ?? batch.design_name,
      catalogColor: dto.corNome ?? batch.shirt_color,
      motivo: dto.motivo,
    };
  } catch (e) {
    console.warn("[batches] resolveBatch falhou para", batch.batch_code, e);
    return { ...vazio(null), erro: e instanceof Error ? e.message : String(e) };
  }
}

export function buildPrintItems(resolved: ResolvedBatch): PrintJobItem[] {
  // Nome impresso = padrão Berzerk/Tiny replicado do industrial:
  //   "{product_name} — {design_name} — {SIZE}" (Title Case, size UPPER).
  // NÃO usar catalogTitle/cor aqui — tem que bater 100% com o preview do
  // industrial. Ver src/lib/labelFormatter.ts.
  const lote = {
    tinyReference: resolved.batch.tiny_reference,
    shopifyReference: resolved.catalogTitle,
    product_name: resolved.batch.product_name,
    design_name: resolved.batch.design_name ?? "",
  };
  return resolved.batch.sizes
    .filter((g) => resolved.eans[g.size])
    // Ordem canônica de tamanho (PP→P→M→G→GG→XG→XXG). A iTAG imprime na ordem
    // do payload, então ordenamos aqui pra etiqueta sair em sequência — e é
    // esse mesmo alinhamento que o servidor usa pra casar EPC↔tamanho.
    .slice()
    .sort((a, b) => compareSizes(a.size, b.size))
    .map((g) => ({
      size: g.size,
      quantity: g.quantity,
      ean13: resolved.eans[g.size],
      sku: resolved.skus[g.size] ?? resolved.eans[g.size],
      description: formatLabelDescription(lote, g.size),
    }));
}

import { supabase } from "../lib/supabase";
import { parseGrade, compareSizes, type GradeEntry } from "../lib/grade";
import {
  ensureDesignTemplatesLoaded,
  getDesignThumbnail,
  getEansForBatch,
  type EanSource,
} from "./ean13Lookup";
import type { PrintJobItem } from "../lib/itag/iprint";
import { formatLabelDescription } from "../lib/labelFormatter";

export type ProductionBatch = {
  id: string;
  batch_code: string;
  design_name: string | null;
  /** Tipo/modelo do produto (ex: "Oversized"). Vem de silk_records. Parte do
   *  nome Shopify (fallback) impresso na etiqueta. */
  product_name: string | null;
  /** Referência Tiny do lote (ex: "Oversized - hello kitty"). Quando presente,
   *  é a FONTE DA VERDADE do nome impresso (ver labelFormatter). null = lote
   *  não vinculado ao Tiny → cai no nome Shopify. */
  tiny_reference: string | null;
  shirt_color: string | null;
  sizes: GradeEntry[];
  total_pieces: number;
  created_at: string;
  thumbnail_url: string | null;
  /** Status de recebimento do lote. Hoje sempre `enviado_recebimento` (a
   *  Produção só lista essa etapa). Rótulo amigável via RECEIPT_STATUS_LABEL. */
  receiptStatus: string;
};

/** Rótulos amigáveis dos status de recebimento (UI). */
export const RECEIPT_STATUS_LABEL: Record<string, string> = {
  recebimento_confirmado: "Confirmado",
  aguardando_retirada: "Aguardando retirada",
  enviado_recebimento: "Enviado p/ recebimento",
  aguardando_autorizacao: "Aguardando autorização",
};

export type ResolvedBatch = {
  batch: ProductionBatch;
  eans: Record<string, string>;
  skus: Record<string, string>;
  sources: Record<string, EanSource>;
  missingSizes: string[];
  isPrintable: boolean;
  shopifyTitle: string | null;
  shopifyColor: string | null;
  /** Referência Shopify (`unified_products.shopify_product_name`). Nome único
   *  combinado, fonte do nome impresso quando não há Tiny. Ver labelFormatter. */
  shopifyReference: string | null;
  /**
   * True quando o resolve foi feito com `skipShopifyFallback` e ainda tem
   * tamanhos faltando. UI pode oferecer "Buscar no Shopify" pra resolver
   * sob demanda.
   */
  shopifyFallbackAvailable: boolean;
};

export type PrintedBatchEntry = {
  id: string;
  batch_code: string;
  design_name: string | null;
  total_pieces: number;
  rfid_impresso_at: string;
  thumbnail_url: string | null;
};

/**
 * Lista lotes prontos pra aparecer na Produção (não impressos ainda).
 *
 * Aparecem exatamente os lotes na etapa **"Env. Recebimento"** do industrial
 * (`silk_records.status = 'enviado_recebimento'`) — o estágio em que a etiqueta
 * RFID deve ser impressa. Lotes já `recebimento_confirmado` (recebidos no
 * galpão, etapa posterior) e `aguardando_retirada`/`aguardando_autorizacao`
 * (anteriores) NÃO aparecem. A grade exibida é a PLANEJADA do corte.
 *
 * Fonte da verdade do total/grade: `production_batches.grade`. silk_records dão
 * o status e a metadata (batch_code, shirt_color, product_name).
 * Thumbnails vêm de `design_templates.images.frente[0]`.
 */
export async function fetchPendingBatches(): Promise<ProductionBatch[]> {
  // 1. silk_records → metadata + descoberta de batch_ids da etapa Env. Recebimento
  const { data: silks, error: silksErr } = await supabase
    .from("silk_records")
    .select(
      "batch_id, batch_code, shirt_color, product_name, design_name, created_at, status",
    )
    .eq("status", "enviado_recebimento")
    .order("created_at", { ascending: false })
    .limit(3000);
  if (silksErr) throw silksErr;
  if (!silks || silks.length === 0) return [];

  type Meta = {
    batch_code: string | null;
    shirt_color: string | null;
    product_name: string | null;
    // Estampa do lote. FONTE DA VERDADE = silk_records.design_name (é o que o
    // industrial usa — ex: "Lisa"). production_batches.design_name vem muito
    // null, então NÃO dá pra confiar nele. Ver fallback no passo 3.
    design_name: string | null;
    created_at: string;
  };
  const metaByBatch = new Map<string, Meta>();
  for (const s of silks) {
    if (!s.batch_id) continue;
    const existing = metaByBatch.get(s.batch_id);
    if (!existing) {
      metaByBatch.set(s.batch_id, {
        batch_code: s.batch_code,
        shirt_color: s.shirt_color,
        product_name: s.product_name,
        design_name: s.design_name,
        created_at: s.created_at,
      });
    } else {
      if (!existing.batch_code && s.batch_code) existing.batch_code = s.batch_code;
      if (!existing.shirt_color && s.shirt_color)
        existing.shirt_color = s.shirt_color;
      if (!existing.product_name && s.product_name)
        existing.product_name = s.product_name;
      if (!existing.design_name && s.design_name)
        existing.design_name = s.design_name;
    }
  }

  const batchIds = Array.from(metaByBatch.keys());
  if (batchIds.length === 0) return [];

  // 2. production_batches → grade canônica + design_name + cor via fabric_records
  // 2b. design_templates.images em paralelo
  type Pb = {
    id: string;
    design_name: string | null;
    grade: string | null;
    fabric_records?: { cor: string | null } | null;
  };
  const printable: Pb[] = [];
  const CHUNK = 100;
  const pbPromises: Promise<void>[] = [];
  for (let i = 0; i < batchIds.length; i += CHUNK) {
    const chunk = batchIds.slice(i, i + CHUNK);
    pbPromises.push(
      (async () => {
        const { data: pbs, error: pbErr } = await supabase
          .from("production_batches")
          .select(
            "id, design_name, grade, fabric_records!production_batches_fabric_record_id_fkey(cor)",
          )
          .in("id", chunk)
          .is("rfid_impresso_at", null)
          .is("deleted_at", null);
        if (pbErr) throw pbErr;
        for (const pb of (pbs ?? []) as unknown as Pb[]) printable.push(pb);
      })(),
    );
  }
  await Promise.all([
    Promise.all(pbPromises),
    ensureDesignTemplatesLoaded(),
  ]);

  // 3. Monta ProductionBatch[] usando grade canônica + thumbnail (cache compartilhado)
  const result: ProductionBatch[] = [];
  for (const pb of printable) {
    const meta = metaByBatch.get(pb.id);
    if (!meta) continue;
    const sizes = parseGrade(pb.grade);
    const total_pieces = sizes.reduce((sum, s) => sum + s.quantity, 0);
    if (sizes.length === 0 || total_pieces === 0) continue;
    const fabricColor = pb.fabric_records?.cor ?? null;
    // Estampa: silk_records.design_name (igual ao industrial) com fallback pro
    // production_batches.design_name. silk vem populado, pb costuma ser null.
    const designName = meta.design_name ?? pb.design_name;
    const thumbnail = getDesignThumbnail(designName);
    result.push({
      id: pb.id,
      batch_code: meta.batch_code ?? `LOTE ${pb.id.slice(0, 8)}`,
      design_name: designName,
      product_name: meta.product_name,
      // TODO(tiny): ligar quando o industrial publicar a coluna da Referência
      // Tiny. Trocar por `meta.tiny_reference` (e adicionar ao select/Meta do
      // silk_records). Enquanto null, etiqueta usa o nome Shopify.
      tiny_reference: null,
      shirt_color: meta.shirt_color ?? fabricColor,
      sizes,
      total_pieces,
      created_at: meta.created_at,
      thumbnail_url: thumbnail,
      receiptStatus: "enviado_recebimento",
    });
  }

  // NOTA: fonte da verdade de "já impresso" é SÓ rfid_impresso_at (estampado
  // pelo app após impressão real — ver markBatchRfidPrinted). NÃO filtrar por
  // "tem job done": job `done` significa que a iTAG GEROU os EPCs, não que as
  // etiquetas saíram fisicamente (lote 2094: 1676 etiquetas "done" em 13s,
  // impressão física nunca aconteceu). Filtrar por job esconderia o lote sem
  // caminho de volta — limpar a estampa é o caminho de reimpressão.

  return result.sort(
    (a, b) => +new Date(b.created_at) - +new Date(a.created_at),
  );
}

/**
 * Estampa `production_batches.rfid_impresso_at` após impressão REAL concluída.
 * É esse timestamp que tira o lote da fila da Produção (fetchPendingBatches
 * filtra `rfid_impresso_at IS NULL`) e o põe no Histórico — antes ninguém
 * gravava e o lote impresso continuava listado. Jobs de teste NÃO estampam.
 * Retorna quantas rows mudaram: 0 = já estampado OU RLS barrou (caller loga;
 * a defesa em fetchPendingBatches cobre esse caso).
 */
export async function markBatchRfidPrinted(batchId: string): Promise<number> {
  const { error, count } = await supabase
    .from("production_batches")
    .update(
      { rfid_impresso_at: new Date().toISOString() },
      { count: "exact" },
    )
    .eq("id", batchId)
    .is("rfid_impresso_at", null);
  if (error) throw error;
  return count ?? 0;
}

/**
 * Caminho de REIMPRESSÃO: limpa rfid_impresso_at e o lote volta pra fila da
 * Produção. Pra quando o job saiu `done` mas a impressão física falhou (a iTAG
 * gera os EPCs na hora; a impressora pode atolar/cancelar sem o app saber).
 * Os EPCs do job antigo ficam no inventário — a movimentação já reconcilia com
 * a iTAG e só move o que ela confirma impresso.
 */
export async function unmarkBatchRfidPrinted(batchId: string): Promise<void> {
  const { error } = await supabase
    .from("production_batches")
    .update({ rfid_impresso_at: null })
    .eq("id", batchId);
  if (error) throw error;
}

export async function resolveBatch(
  batch: ProductionBatch,
  opts?: { skipShopifyFallback?: boolean },
): Promise<ResolvedBatch> {
  const sizes = batch.sizes.map((s) => s.size);
  const empty: ResolvedBatch = {
    batch,
    eans: {},
    skus: {},
    sources: {},
    missingSizes: sizes,
    isPrintable: false,
    shopifyTitle: batch.design_name,
    shopifyColor: batch.shirt_color,
    shopifyReference: null,
    shopifyFallbackAvailable: false,
  };
  if (sizes.length === 0 || !batch.design_name) return empty;
  try {
    const lookup = await getEansForBatch({
      designName: batch.design_name,
      shirtColor: batch.shirt_color,
      sizes,
      skipShopifyFallback: opts?.skipShopifyFallback,
    });
    return {
      batch,
      eans: lookup.eans,
      skus: lookup.skus,
      sources: lookup.sources,
      missingSizes: lookup.missingSizes,
      isPrintable: lookup.missingSizes.length === 0 && sizes.length > 0,
      shopifyTitle: lookup.shopifyProduct?.title ?? batch.design_name,
      shopifyColor: lookup.shopifyProduct?.color ?? batch.shirt_color,
      shopifyReference: lookup.shopifyReference,
      shopifyFallbackAvailable: lookup.shopifyFallbackAvailable,
    };
  } catch (e) {
    console.warn("[batches] resolveBatch threw for", batch.batch_code, e);
    return empty;
  }
}

export function buildPrintItems(resolved: ResolvedBatch): PrintJobItem[] {
  // Nome impresso = padrão Berzerk/Tiny replicado do industrial:
  //   "{product_name} — {design_name} — {SIZE}" (Title Case, size UPPER).
  // NÃO usar shopifyTitle/cor aqui — tem que bater 100% com o preview do
  // industrial. Ver src/lib/labelFormatter.ts.
  const lote = {
    tinyReference: resolved.batch.tiny_reference,
    shopifyReference: resolved.shopifyReference,
    product_name: resolved.batch.product_name,
    design_name: resolved.batch.design_name ?? "",
  };
  return resolved.batch.sizes
    .filter((g) => resolved.eans[g.size])
    // Ordem canônica de tamanho (PP→P→M→G→GG→XG→XXG). A iTAG imprime na
    // ordem do payload, então ordenamos aqui pra etiqueta sair em sequência.
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

/** Resultado da busca na base toda (sem filtro de status/estampa). */
export type GlobalSearchEntry = {
  batch: ProductionBatch;
  /** null = ainda não impresso. */
  rfid_impresso_at: string | null;
  deleted: boolean;
};

// Pra escolher o status "mais avançado" quando o lote tem múltiplas linhas de
// silk_records em etapas diferentes.
const GLOBAL_STATUS_PRIORITY = [
  "aguardando_autorizacao",
  "aguardando_retirada",
  "enviado_recebimento",
  "recebimento_confirmado",
];

/**
 * Busca GERAL: procura o lote na base toda do industrial, ignorando status de
 * recebimento e estampa de impresso. Pra consulta, reimpressão ou voltar um
 * lote pra fila quando ele não aparece na listagem normal (que só mostra
 * `enviado_recebimento` não impresso).
 */
export async function searchBatchesGlobal(
  query: string,
): Promise<GlobalSearchEntry[]> {
  // PostgREST usa , e () como sintaxe do .or — tira do termo pra não quebrar.
  const q = query.trim().replace(/[,()]/g, " ").replace(/\s+/g, " ");
  if (!q) return [];
  const pattern = `*${q}*`;
  const { data: silks, error: silksErr } = await supabase
    .from("silk_records")
    .select(
      "batch_id, batch_code, shirt_color, product_name, design_name, created_at, status",
    )
    .or(
      `batch_code.ilike.${pattern},design_name.ilike.${pattern},product_name.ilike.${pattern}`,
    )
    .order("created_at", { ascending: false })
    .limit(200);
  if (silksErr) throw silksErr;
  if (!silks || silks.length === 0) return [];

  type SilkRow = (typeof silks)[number];
  const rowByBatch = new Map<string, SilkRow>();
  const statusByBatch = new Map<string, string>();
  for (const s of silks) {
    if (!s.batch_id) continue;
    if (!rowByBatch.has(s.batch_id)) rowByBatch.set(s.batch_id, s);
    const cur = statusByBatch.get(s.batch_id);
    if (
      !cur ||
      GLOBAL_STATUS_PRIORITY.indexOf(s.status) >
        GLOBAL_STATUS_PRIORITY.indexOf(cur)
    ) {
      statusByBatch.set(s.batch_id, s.status);
    }
  }
  const batchIds = Array.from(rowByBatch.keys()).slice(0, 30);
  if (batchIds.length === 0) return [];

  const [{ data: pbs, error: pbErr }] = await Promise.all([
    supabase
      .from("production_batches")
      .select("id, design_name, grade, rfid_impresso_at, deleted_at")
      .in("id", batchIds),
    ensureDesignTemplatesLoaded(),
  ]);
  if (pbErr) throw pbErr;

  const result: GlobalSearchEntry[] = [];
  for (const pb of pbs ?? []) {
    const meta = rowByBatch.get(pb.id as string);
    if (!meta) continue;
    const sizes = parseGrade(pb.grade as string | null);
    const designName = meta.design_name ?? (pb.design_name as string | null);
    result.push({
      batch: {
        id: pb.id as string,
        batch_code: meta.batch_code ?? `LOTE ${(pb.id as string).slice(0, 8)}`,
        design_name: designName,
        product_name: meta.product_name,
        tiny_reference: null,
        shirt_color: meta.shirt_color,
        sizes,
        total_pieces: sizes.reduce((sum, s) => sum + s.quantity, 0),
        created_at: meta.created_at,
        thumbnail_url: getDesignThumbnail(designName),
        receiptStatus: statusByBatch.get(pb.id as string) ?? "",
      },
      rfid_impresso_at: (pb.rfid_impresso_at as string | null) ?? null,
      deleted: pb.deleted_at != null,
    });
  }
  return result.sort(
    (a, b) => +new Date(b.batch.created_at) - +new Date(a.batch.created_at),
  );
}

export async function fetchTodayHistory(): Promise<PrintedBatchEntry[]> {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  const [historyResp] = await Promise.all([
    supabase
      .from("production_batches")
      .select("id, design_name, grade, rfid_impresso_at")
      .not("rfid_impresso_at", "is", null)
      .is("deleted_at", null)
      .gte("rfid_impresso_at", startOfDay.toISOString())
      .order("rfid_impresso_at", { ascending: false })
      .limit(50),
    ensureDesignTemplatesLoaded(),
  ]);
  if (historyResp.error) throw historyResp.error;
  const data = historyResp.data ?? [];

  const ids = data.map((b) => b.id as string);
  const codesByBatch = new Map<string, string>();
  if (ids.length > 0) {
    const { data: silks } = await supabase
      .from("silk_records")
      .select("batch_id, batch_code")
      .in("batch_id", ids);
    for (const s of silks ?? []) {
      if (s.batch_id && s.batch_code && !codesByBatch.has(s.batch_id)) {
        codesByBatch.set(s.batch_id, s.batch_code);
      }
    }
  }

  return data.map((b) => {
    const sizes = parseGrade(b.grade);
    const total = sizes.reduce((sum, s) => sum + s.quantity, 0);
    return {
      id: b.id as string,
      batch_code:
        codesByBatch.get(b.id as string) ?? `LOTE ${(b.id as string).slice(0, 8)}`,
      design_name: b.design_name,
      total_pieces: total,
      rfid_impresso_at: b.rfid_impresso_at as string,
      thumbnail_url: getDesignThumbnail(b.design_name),
    };
  });
}

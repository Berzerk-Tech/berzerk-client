import { supabase } from "../lib/supabase";
import type { PrintJobItem } from "../lib/itag/iprint";

export type RfidPrintJobStatus =
  | "queued"
  | "printing"
  | "done"
  | "failed"
  | "cancelled";

export type RfidPrintJob = {
  id: string;
  batch_id: string;
  batch_code: string;
  items: PrintJobItem[];
  shirt_color: string | null;
  design_name: string | null;
  total_etiquetas: number;
  /** Etiquetas REALMENTE queimadas (EPCs retornados pela iTAG). null até o job
   *  concluir. Pode ser < total_etiquetas (impressão parcial). */
  printed_count: number | null;
  /** True = impressão de teste (Modo teste). Os EPCs de jobs de teste são os
   *  únicos que o "Descartar teste" remove. */
  is_test: boolean;
  /** True = operador escolheu tamanhos/quantidades à mão no modal. */
  is_manual: boolean;
  status: RfidPrintJobStatus;
  station_id: string | null;
  requested_by: string | null;
  printed_by: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  audit_payload: unknown;
};

export type EpcInventoryRow = {
  epc: string;
  batch_id: string;
  batch_code: string;
  size: string;
  ean13: string;
  sku: string | null;
  codigo_inventario_itag: number | null;
  job_id: string | null;
  situacao_atual: number;
  printed_at: string;
  moved_at: string | null;
  moved_to_situacao: number | null;
  moved_by: string | null;
};

export type JobAwaitingMovimentacao = {
  job: RfidPrintJob;
  pendingCount: number;
  totalCount: number;
};

/**
 * Cria um job já em `printing`. Usado quando o operador clica Imprimir
 * direto no card de lote (sem passar por fila do coordenador).
 */
const ACTIVE_COLUMNS =
  "id,batch_id,batch_code,design_name,shirt_color,total_etiquetas,printed_count,is_test,is_manual,status,station_id,printed_by,created_at,started_at,completed_at,error_message";

/**
 * Lista jobs ainda em movimento (queued, printing, failed). Done jobs ficam
 * no Histórico, cancelled por enquanto não usamos.
 */
export async function fetchActivePrintJobs(): Promise<RfidPrintJob[]> {
  const { data, error } = await supabase
    .from("rfid_print_jobs")
    .select(ACTIVE_COLUMNS)
    .in("status", ["queued", "printing", "failed"])
    .order("created_at", { ascending: false })
    .limit(30);
  if (error) throw error;
  return (data ?? []) as RfidPrintJob[];
}

export async function createPrintJob(params: {
  batchId: string;
  batchCode: string;
  items: PrintJobItem[];
  shirtColor: string | null;
  designName: string | null;
  totalEtiquetas: number;
  operatorId: string;
  operatorEmail: string;
  stationId: string;
  isTest?: boolean;
  isManual?: boolean;
}): Promise<string> {
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from("rfid_print_jobs")
    .insert({
      batch_id: params.batchId,
      batch_code: params.batchCode,
      items: params.items,
      shirt_color: params.shirtColor,
      design_name: params.designName,
      total_etiquetas: params.totalEtiquetas,
      is_test: params.isTest ?? false,
      is_manual: params.isManual ?? false,
      status: "printing",
      station_id: params.stationId,
      requested_by: params.operatorId,
      printed_by: params.operatorId,
      started_at: now,
      audit_payload: { operatorEmail: params.operatorEmail },
    })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as string;
}

/**
 * Conclui o job gravando a contagem REAL de etiquetas queimadas (EPCs que a
 * iTAG devolveu). Se `printedCount < total_etiquetas`, foi impressão parcial —
 * a UI mostra "X de Y" em vez de assumir que tudo saiu.
 */
export async function markDone(jobId: string, printedCount?: number) {
  const patch: Record<string, unknown> = {
    status: "done",
    completed_at: new Date().toISOString(),
  };
  if (typeof printedCount === "number") patch.printed_count = printedCount;
  const { error } = await supabase
    .from("rfid_print_jobs")
    .update(patch)
    .eq("id", jobId);
  if (error) throw error;
}

export async function cancelPrintJob(jobId: string) {
  const { error } = await supabase
    .from("rfid_print_jobs")
    .update({
      status: "cancelled",
      completed_at: new Date().toISOString(),
    })
    .eq("id", jobId);
  if (error) throw error;
}

export async function markFailed(jobId: string, errorMessage: string) {
  const { error } = await supabase
    .from("rfid_print_jobs")
    .update({
      status: "failed",
      completed_at: new Date().toISOString(),
      error_message: errorMessage,
    })
    .eq("id", jobId);
  if (error) throw error;
}

/**
 * Persiste o mapping EPC → lote depois que a iTAG retornou os EPCs queimados.
 * Distribui os EPCs entre os items na ordem em que foram enviados (a iTAG
 * preserva ordem do payload). Usa `upsert` em `epc` pra ser idempotente —
 * caso a função seja chamada 2x pro mesmo job (retry), não duplica row.
 */
export async function saveEpcInventory(params: {
  jobId: string;
  batchId: string;
  batchCode: string;
  items: PrintJobItem[];
  epcs: string[];
  codigoInventarioItag: number | null;
}): Promise<{ inserted: number; skipped: number }> {
  if (params.epcs.length === 0) return { inserted: 0, skipped: 0 };

  // Expande items pra EPCs individuais respeitando quantidade
  type Row = {
    epc: string;
    batch_id: string;
    batch_code: string;
    size: string;
    ean13: string;
    sku: string | null;
    codigo_inventario_itag: number | null;
    job_id: string;
    situacao_atual: number;
  };
  const rows: Row[] = [];
  let epcIdx = 0;
  for (const item of params.items) {
    for (let k = 0; k < item.quantity && epcIdx < params.epcs.length; k++) {
      rows.push({
        epc: params.epcs[epcIdx++],
        batch_id: params.batchId,
        batch_code: params.batchCode,
        size: item.size,
        ean13: item.ean13,
        sku: item.sku ?? null,
        codigo_inventario_itag: params.codigoInventarioItag,
        job_id: params.jobId,
        situacao_atual: 2, // default — "impresso"; situação real vem do iTAG
      });
    }
  }
  const skipped = params.epcs.length - rows.length;

  if (rows.length === 0) return { inserted: 0, skipped };

  // Upsert por epc (PK). Em conflito mantém a row existente — não sobrescreve
  // job_id/batch_id que possam ter sido populados em outra estação.
  const { error } = await supabase
    .from("rfid_epc_inventory")
    .upsert(rows, { onConflict: "epc", ignoreDuplicates: true });
  if (error) throw error;
  return { inserted: rows.length, skipped };
}

/**
 * Conjunto de batch_ids que têm impressão de TESTE pendente (job is_test=true
 * e não cancelado). Usado pra mostrar o botão "Descartar teste" só nos cards
 * de lote que de fato têm etiquetas de teste pra limpar.
 */
export async function fetchBatchesWithTestJobs(
  batchIds: string[],
): Promise<Set<string>> {
  if (batchIds.length === 0) return new Set();
  const { data, error } = await supabase
    .from("rfid_print_jobs")
    .select("batch_id")
    .eq("is_test", true)
    .neq("status", "cancelled")
    .in("batch_id", batchIds);
  if (error) throw error;
  return new Set((data ?? []).map((r) => r.batch_id as string));
}

/**
 * Descarta as impressões de TESTE de um lote: apaga só os EPCs gravados por
 * jobs `is_test=true` e cancela esses jobs. O LOTE permanece na Produção pra
 * impressão real — diferente do antigo "descartar lote", que soft-deletava o
 * lote inteiro. Requer policy de DELETE em rfid_epc_inventory (migration
 * 20260527_descartar_lote.sql).
 */
export async function discardTestForBatch(batchId: string): Promise<void> {
  const { data: jobs, error: jobsErr } = await supabase
    .from("rfid_print_jobs")
    .select("id")
    .eq("is_test", true)
    .neq("status", "cancelled")
    .eq("batch_id", batchId);
  if (jobsErr) throw jobsErr;
  const jobIds = (jobs ?? []).map((j) => j.id as string);
  if (jobIds.length === 0) return;

  // Apaga os EPCs de teste ANTES de cancelar os jobs (a FK aponta job_id).
  const { error: epcErr } = await supabase
    .from("rfid_epc_inventory")
    .delete()
    .in("job_id", jobIds);
  if (epcErr) throw epcErr;

  const { error: cancelErr } = await supabase
    .from("rfid_print_jobs")
    .update({ status: "cancelled", completed_at: new Date().toISOString() })
    .in("id", jobIds);
  if (cancelErr) throw cancelErr;
}

/**
 * Reconcilia a situação local dos EPCs com a verdade da iTAG. Recebe o que a
 * iTAG devolveu (`itag_iprint_query_inventory`) — epc → situação — e atualiza
 * `rfid_epc_inventory.situacao_atual`. Só toca nas rows cuja situação divergiu,
 * pra não escrever à toa. Retorna quantas rows foram atualizadas.
 */
export async function reconcileSituacaoFromItag(
  pairs: Array<{ epc: string; situacao: number }>,
): Promise<number> {
  let updated = 0;
  // Agrupa por situação pra fazer 1 UPDATE por valor distinto (poucos valores).
  const bySituacao = new Map<number, string[]>();
  for (const { epc, situacao } of pairs) {
    const e = epc.trim().toUpperCase();
    if (!e) continue;
    const arr = bySituacao.get(situacao) ?? [];
    arr.push(e);
    bySituacao.set(situacao, arr);
  }
  for (const [situacao, epcs] of bySituacao) {
    for (const chunk of chunkEpcs(epcs)) {
      const { error, count } = await supabase
        .from("rfid_epc_inventory")
        .update({ situacao_atual: situacao }, { count: "exact" })
        .in("epc", chunk)
        .neq("situacao_atual", situacao);
      if (error) throw error;
      updated += count ?? 0;
    }
  }
  return updated;
}

// O filtro `.in("epc", ...)` do PostgREST vai na URL; acima de ~14KB o edge do
// Supabase devolve 400 "Bad Request" (lote 1146: 1000 EPCs ≈ 27KB estourava a
// movimentação). 300 EPCs ≈ 9KB, com folga.
const EPC_IN_CHUNK = 300;
function chunkEpcs(epcs: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < epcs.length; i += EPC_IN_CHUNK) {
    out.push(epcs.slice(i, i + EPC_IN_CHUNK));
  }
  return out;
}

/**
 * Lista EPCs de um job específico. Usado pelo handler de movimentação.
 */
export async function fetchEpcsByJob(jobId: string): Promise<EpcInventoryRow[]> {
  const { data, error } = await supabase
    .from("rfid_epc_inventory")
    .select(
      "epc,batch_id,batch_code,size,ean13,sku,codigo_inventario_itag,job_id,situacao_atual,printed_at,moved_at,moved_to_situacao,moved_by",
    )
    .eq("job_id", jobId);
  if (error) throw error;
  return (data ?? []) as EpcInventoryRow[];
}

/**
 * Rastreio: dado um ou mais EPCs (etiquetas RFID lidas/digitadas), retorna as
 * rows de inventário — o vínculo EPC → lote/SKU/tamanho. Normaliza pra
 * UPPERCASE/trim (o leitor iTAG devolve hex maiúsculo). EPCs sem match não
 * aparecem no resultado.
 */
export async function fetchEpcInventoryByEpcs(
  epcs: string[],
): Promise<EpcInventoryRow[]> {
  const norm = Array.from(
    new Set(epcs.map((e) => e.trim().toUpperCase()).filter(Boolean)),
  );
  if (norm.length === 0) return [];
  const rows: EpcInventoryRow[] = [];
  for (const chunk of chunkEpcs(norm)) {
    const { data, error } = await supabase
      .from("rfid_epc_inventory")
      .select(
        "epc,batch_id,batch_code,size,ean13,sku,codigo_inventario_itag,job_id,situacao_atual,printed_at,moved_at,moved_to_situacao,moved_by",
      )
      .in("epc", chunk);
    if (error) throw error;
    rows.push(...(data ?? []) as EpcInventoryRow[]);
  }
  return rows;
}

/**
 * Marca uma lista de EPCs como movimentados localmente. Chamar SÓ depois
 * que o `itag_iprint_movimentar` Rust devolveu OK — senão o estado local
 * fica fora de sincronia com o iTAG.
 */
export async function markMoved(params: {
  epcs: string[];
  situacaoDestino: number;
  operatorId: string;
}): Promise<void> {
  if (params.epcs.length === 0) return;
  const movedAt = new Date().toISOString();
  for (const chunk of chunkEpcs(params.epcs)) {
    const { error } = await supabase
      .from("rfid_epc_inventory")
      .update({
        situacao_atual: params.situacaoDestino,
        moved_at: movedAt,
        moved_to_situacao: params.situacaoDestino,
        moved_by: params.operatorId,
      })
      .in("epc", chunk);
    if (error) throw error;
  }
}

/**
 * Lista jobs `done` que ainda têm EPCs com moved_at IS NULL. Pra UI mostrar
 * "Aguardando movimentação" — o operador clica e a gente move pro estoque.
 *
 * Dirigido pelos EPCs pendentes, SEM janela de tempo. A versão anterior
 * partia de "jobs done das últimas 48h": lote impresso na sexta sumia da
 * lista na segunda sem nunca ter sido movimentado, e não havia como mover
 * depois. Jobs de teste ficam fora — EPC de teste sai pelo "Descartar teste",
 * não por movimentação.
 */
export async function fetchJobsAwaitingMovimentacao(): Promise<
  JobAwaitingMovimentacao[]
> {
  // 1. EPCs pendentes → pendingCount por job (fonte da verdade do que falta).
  const { data: pendRows, error: pendErr } = await supabase
    .from("rfid_epc_inventory")
    .select("job_id")
    .is("moved_at", null)
    .not("job_id", "is", null)
    .limit(10000);
  if (pendErr) throw pendErr;
  const pendingByJob = new Map<string, number>();
  for (const r of pendRows ?? []) {
    const id = r.job_id as string;
    pendingByJob.set(id, (pendingByJob.get(id) ?? 0) + 1);
  }
  if (pendingByJob.size === 0) return [];

  // 2. Desses jobs, quais são done e reais (não-teste), mais recentes primeiro.
  const { data: jobs, error: jobsErr } = await supabase
    .from("rfid_print_jobs")
    .select(ACTIVE_COLUMNS)
    .eq("status", "done")
    .eq("is_test", false)
    .in("id", Array.from(pendingByJob.keys()))
    .order("completed_at", { ascending: false })
    .limit(100);
  if (jobsErr) throw jobsErr;
  if (!jobs || jobs.length === 0) return [];

  // 3. Total de EPCs por job num query só (pendente + já movido).
  const jobIds = jobs.map((j) => j.id as string);
  const totalByJob = new Map<string, number>();
  const { data: allRows, error: totErr } = await supabase
    .from("rfid_epc_inventory")
    .select("job_id")
    .in("job_id", jobIds)
    .limit(10000);
  if (totErr) throw totErr;
  for (const r of allRows ?? []) {
    const id = r.job_id as string;
    totalByJob.set(id, (totalByJob.get(id) ?? 0) + 1);
  }

  return (jobs as RfidPrintJob[]).map((j) => {
    const pendingCount = pendingByJob.get(j.id) ?? 0;
    return {
      job: j,
      pendingCount,
      totalCount: totalByJob.get(j.id) ?? pendingCount,
    };
  });
}

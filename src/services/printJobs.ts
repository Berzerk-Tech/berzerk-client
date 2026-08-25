// Jobs de impressão e inventário de EPC — agora contra a API do NEXUS.
//
// Até a v0.7.0 este arquivo falava direto com `rfid_print_jobs` e
// `rfid_epc_inventory` no Supabase industrial, e assinava o Realtime daquela
// tabela. A fase 3 do `docs/plano-corte-supabase.md` do nexus levou as duas
// para o RDS:
//
//   rfid_print_jobs (+ Realtime) → /etiquetagem/print-jobs/* + WS print-jobs.changed
//   rfid_epc_inventory (escrita) → /etiquetagem/epcs/*
//
// Duas mudanças de responsabilidade que valem a leitura:
//
// 1. QUEM DISTRIBUI EPC → TAMANHO É O SERVIDOR. `saveEpcInventory` mandava as
//    linhas prontas; agora manda só a lista de EPCs na ordem em que a iTAG a
//    devolveu, e o nexus expande os itens do job. O job é a cópia confiável do
//    payload — refazer a expansão aqui era duplicar a regra que decide qual EPC
//    é de qual tamanho, e errar nela grava o EAN errado na etiqueta.
// 2. `discardTestForBatch` virou UMA chamada transacional no servidor, em vez
//    de três passos daqui (buscar jobs → apagar EPCs → cancelar jobs), que
//    podiam parar no meio e deixar EPC de teste vivo com job cancelado.

import { apiRequest } from "../lib/api";
import type { PrintJobItem } from "../lib/itag/iprint";

/** Vocabulário do nexus (o Supabase usava queued/printing/done/failed/cancelled). */
export type RfidPrintJobStatus =
  | "na_fila"
  | "imprimindo"
  | "concluido"
  | "falhou"
  | "cancelado";

type PrintJobItemDto = {
  tamanho: string;
  quantidade: number;
  ean13: string;
  sku: string;
  descricao: string;
};

/** DTO cru do nexus. A UI consome o `RfidPrintJob` traduzido logo abaixo. */
type PrintJobDto = {
  id: string;
  loteId: string;
  loteCodigo: string;
  estampa: string | null;
  cor: string | null;
  itens: PrintJobItemDto[];
  totalEtiquetas: number;
  impressas: number | null;
  ehTeste: boolean;
  ehManual: boolean;
  status: RfidPrintJobStatus;
  estacaoId: string | null;
  solicitadoPor: string | null;
  impressoPor: string | null;
  erro: string | null;
  criadoEm: string;
  iniciadoEm: string | null;
  concluidoEm: string | null;
};

/**
 * O job como a tela usa. Nomes em snake_case herdados do Supabase — mantidos
 * de propósito: a troca é de FONTE, não de tela.
 */
export type RfidPrintJob = {
  id: string;
  batch_id: string;
  batch_code: string;
  items: PrintJobItem[];
  shirt_color: string | null;
  design_name: string | null;
  total_etiquetas: number;
  /** Etiquetas REALMENTE queimadas (EPCs da iTAG). null até concluir. */
  printed_count: number | null;
  is_test: boolean;
  is_manual: boolean;
  status: RfidPrintJobStatus;
  station_id: string | null;
  requested_by: string | null;
  printed_by: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
};

export type EpcInventoryRow = {
  epc: string;
  batch_id: string | null;
  batch_code: string | null;
  size: string | null;
  ean13: string;
  sku: string | null;
  codigo_inventario_itag: number | null;
  job_id: string | null;
  situacao_atual: number;
  printed_at: string | null;
  moved_at: string | null;
  moved_to_situacao: number | null;
};

export type JobAwaitingMovimentacao = {
  job: RfidPrintJob;
  pendingCount: number;
  totalCount: number;
};

type EpcDto = {
  epc: string;
  ean13: string;
  sku: string | null;
  tamanho: string | null;
  loteId: string | null;
  loteCodigo: string | null;
  jobId: string | null;
  codigoInventarioItag: number | null;
  situacaoAtual: number;
  impressoEm: string | null;
  movidoEm: string | null;
  movidoParaSituacao: number | null;
  origem: string;
};

function toJob(dto: PrintJobDto): RfidPrintJob {
  return {
    id: dto.id,
    batch_id: dto.loteId,
    batch_code: dto.loteCodigo,
    items: dto.itens.map((i) => ({
      size: i.tamanho,
      quantity: i.quantidade,
      ean13: i.ean13,
      sku: i.sku,
      description: i.descricao,
    })),
    shirt_color: dto.cor,
    design_name: dto.estampa,
    total_etiquetas: dto.totalEtiquetas,
    printed_count: dto.impressas,
    is_test: dto.ehTeste,
    is_manual: dto.ehManual,
    status: dto.status,
    station_id: dto.estacaoId,
    requested_by: dto.solicitadoPor,
    printed_by: dto.impressoPor,
    created_at: dto.criadoEm,
    started_at: dto.iniciadoEm,
    completed_at: dto.concluidoEm,
    error_message: dto.erro,
  };
}

function toEpcRow(dto: EpcDto): EpcInventoryRow {
  return {
    epc: dto.epc,
    batch_id: dto.loteId,
    batch_code: dto.loteCodigo,
    size: dto.tamanho,
    ean13: dto.ean13,
    sku: dto.sku,
    codigo_inventario_itag: dto.codigoInventarioItag,
    job_id: dto.jobId,
    situacao_atual: dto.situacaoAtual,
    printed_at: dto.impressoEm,
    moved_at: dto.movidoEm,
    moved_to_situacao: dto.movidoParaSituacao,
  };
}

// ────────────────────────────────────────────────────────────
// Jobs
// ────────────────────────────────────────────────────────────

/** Jobs ainda em movimento (`na_fila`, `imprimindo`, `falhou`). */
export async function fetchActivePrintJobs(): Promise<RfidPrintJob[]> {
  const dto = await apiRequest<{ jobs: PrintJobDto[]; total: number }>(
    "/etiquetagem/print-jobs",
    { query: { escopo: "ativos", limite: "30" } },
  );
  return dto.jobs.map(toJob);
}

/**
 * Cria o job já em `imprimindo`, logo antes de chamar a iTAG.
 *
 * `totalEtiquetas` NÃO vai no corpo: o servidor soma as quantidades dos itens.
 * Estampa e cor também não — são retrato do lote, lidos lá.
 */
export async function createPrintJob(params: {
  batchId: string;
  items: PrintJobItem[];
  stationId: string;
  isTest?: boolean;
  isManual?: boolean;
}): Promise<string> {
  const dto = await apiRequest<PrintJobDto>("/etiquetagem/print-jobs", {
    method: "POST",
    body: {
      loteId: params.batchId,
      itens: params.items.map((i) => ({
        tamanho: i.size,
        quantidade: i.quantity,
        ean13: i.ean13,
        sku: i.sku,
        descricao: i.description,
      })),
      ehTeste: params.isTest ?? false,
      ehManual: params.isManual ?? false,
      estacaoId: params.stationId,
    },
  });
  return dto.id;
}

/**
 * Conclui o job com a contagem REAL de etiquetas queimadas. Se
 * `printedCount < total_etiquetas`, foi impressão parcial — a UI mostra
 * "X de Y" em vez de assumir que tudo saiu.
 *
 * O servidor recusa (422) se o job já foi fechado: o primeiro desfecho vale.
 */
export async function markDone(jobId: string, printedCount?: number): Promise<void> {
  await apiRequest(`/etiquetagem/print-jobs/${jobId}/concluir`, {
    method: "POST",
    body: typeof printedCount === "number" ? { impressas: printedCount } : {},
  });
}

export async function cancelPrintJob(jobId: string): Promise<void> {
  await apiRequest(`/etiquetagem/print-jobs/${jobId}/cancelar`, { method: "POST", body: {} });
}

export async function markFailed(jobId: string, errorMessage: string): Promise<void> {
  await apiRequest(`/etiquetagem/print-jobs/${jobId}/falhar`, {
    method: "POST",
    body: { erro: errorMessage.slice(0, 2000) },
  });
}

/**
 * Conjunto de lotes com impressão de TESTE pendente. Usado pra mostrar o botão
 * "Descartar teste" só nos cards que de fato têm etiquetas de teste pra limpar.
 */
export async function fetchBatchesWithTestJobs(batchIds: string[]): Promise<Set<string>> {
  if (batchIds.length === 0) return new Set();
  const dto = await apiRequest<{ loteIds: string[] }>(
    "/etiquetagem/print-jobs/lotes-com-teste",
    { query: { loteIds: batchIds.join(",") } },
  );
  return new Set(dto.loteIds);
}

/**
 * Descarta as impressões de TESTE de um lote: apaga só os EPCs gravados por
 * jobs de teste e cancela esses jobs. O LOTE permanece na fila pra impressão
 * real.
 *
 * Era uma sequência de três passos daqui (buscar jobs → apagar EPCs → cancelar
 * jobs) que podia parar no meio e deixar EPC de teste vivo com o job já
 * cancelado — etiqueta de teste lida na separação como peça de verdade. Agora
 * é UMA chamada, e o servidor faz tudo numa transação.
 */
export async function discardTestForBatch(batchId: string): Promise<void> {
  await apiRequest(`/etiquetagem/lotes/${batchId}/descartar-teste`, {
    method: "POST",
    body: {},
  });
}

// ────────────────────────────────────────────────────────────
// Inventário de EPC
// ────────────────────────────────────────────────────────────

/**
 * Persiste o mapping EPC → lote depois que a iTAG retornou os EPCs queimados.
 *
 * Manda SÓ a lista, na ordem em que a iTAG a devolveu. Quem distribui EPC →
 * tamanho é o servidor, expandindo os itens do job: a iTAG imprime na ordem do
 * payload e devolve na mesma ordem, e o job é a única cópia confiável daquele
 * payload. Refazer a expansão aqui duplicaria a regra — e um erro nela grava o
 * EPC com o EAN do tamanho errado, o que só aparece meses depois, na separação.
 *
 * Idempotente por EPC: reenviar o mesmo job (retry) não duplica.
 */
export async function saveEpcInventory(params: {
  jobId: string;
  epcs: string[];
  codigoInventarioItag: number | null;
}): Promise<{ inserted: number; skipped: number }> {
  if (params.epcs.length === 0) return { inserted: 0, skipped: 0 };
  const dto = await apiRequest<{ gravados: number; sobraram: number }>("/etiquetagem/epcs", {
    method: "POST",
    body: {
      jobId: params.jobId,
      epcs: params.epcs.map((e) => e.trim().toUpperCase()).filter(Boolean),
      codigoInventarioItag: params.codigoInventarioItag,
    },
  });
  return { inserted: dto.gravados, skipped: dto.sobraram };
}

/**
 * Reconcilia a situação local dos EPCs com a verdade da iTAG
 * (`itag_iprint_query_inventory`). O servidor só toca nas linhas cuja situação
 * divergiu. Retorna quantas mudaram.
 */
export async function reconcileSituacaoFromItag(
  pairs: Array<{ epc: string; situacao: number }>,
): Promise<number> {
  const situacoes = pairs
    .map(({ epc, situacao }) => ({ epc: epc.trim().toUpperCase(), situacao }))
    .filter((p) => p.epc);
  if (situacoes.length === 0) return 0;
  const dto = await apiRequest<{ atualizados: number }>("/etiquetagem/epcs/situacao", {
    method: "PATCH",
    body: { situacoes },
  });
  return dto.atualizados;
}

/** EPCs de um job — o handler de movimentação percorre esta lista. */
export async function fetchEpcsByJob(jobId: string): Promise<EpcInventoryRow[]> {
  const dto = await apiRequest<{ epcs: EpcDto[]; total: number }>("/etiquetagem/epcs", {
    query: { jobId },
  });
  return dto.epcs.map(toEpcRow);
}

/**
 * Rastreio: dado um ou mais EPCs (lidos/digitados), retorna o vínculo EPC →
 * lote/SKU/tamanho. EPCs sem match não aparecem no resultado.
 *
 * POST e não GET porque a lista vem de uma leitura de antena e pode ter
 * centenas de EPCs — o `?epcs=` correspondente estourava a URL (era esse o
 * limite de ~14 KB que obrigava o chunk de 300 no PostgREST).
 */
export async function fetchEpcInventoryByEpcs(epcs: string[]): Promise<EpcInventoryRow[]> {
  const norm = Array.from(new Set(epcs.map((e) => e.trim().toUpperCase()).filter(Boolean)));
  if (norm.length === 0) return [];
  const dto = await apiRequest<{ epcs: EpcDto[]; total: number }>("/etiquetagem/epcs/consulta", {
    method: "POST",
    body: { epcs: norm },
  });
  return dto.epcs.map(toEpcRow);
}

/**
 * Marca EPCs como movimentados. Chamar SÓ depois que o `itag_iprint_movimentar`
 * devolveu OK — senão o estado local fica fora de sincronia com o iTAG.
 */
export async function markMoved(params: {
  epcs: string[];
  situacaoDestino: number;
}): Promise<void> {
  const epcs = params.epcs.map((e) => e.trim().toUpperCase()).filter(Boolean);
  if (epcs.length === 0) return;
  await apiRequest("/etiquetagem/epcs/movimentacao", {
    method: "PATCH",
    body: { epcs, situacaoDestino: params.situacaoDestino },
  });
}

/**
 * Jobs `concluido` que ainda têm EPCs com movimentação pendente. Pra UI mostrar
 * "Aguardando movimentação".
 *
 * Dirigido pelos EPCs pendentes, SEM janela de tempo — a versão anterior partia
 * de "jobs done das últimas 48h" e o lote impresso na sexta sumia da lista na
 * segunda sem nunca ter sido movimentado. Jobs de teste ficam fora: EPC de
 * teste sai pelo "Descartar teste", não por movimentação.
 */
export async function fetchJobsAwaitingMovimentacao(): Promise<JobAwaitingMovimentacao[]> {
  const dto = await apiRequest<{
    jobs: { job: PrintJobDto; pendentes: number; total: number }[];
  }>("/etiquetagem/epcs/aguardando-movimentacao");
  return dto.jobs.map((j) => ({
    job: toJob(j.job),
    pendingCount: j.pendentes,
    totalCount: j.total,
  }));
}

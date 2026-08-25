// Wrapper TS que substitui a edge function `itag-print-rfid`.
//
// Em vez de invocar a função Supabase, chama o cliente Rust nativo
// (`itag_iprint_*`) que bate direto na iTAG REST API com Basic auth.
// O resto do fluxo (criação do job em `rfid_print_jobs`, mark done/failed)
// continua em BatchBrowser/printJobs.ts — esse arquivo só cobre a etapa
// de gerar EPCs e persistir o mapping no inventário (hoje no nexus, via
// `POST /etiquetagem/epcs`).

import { invoke } from "@tauri-apps/api/core";
import {
  getIprintConfig,
  toRustConfig,
} from "../../services/iprintConfig";
import { saveEpcInventory } from "../../services/printJobs";

export type PrintJobItem = {
  size: string;
  quantity: number;
  ean13: string;
  sku: string;
  description: string;
};

export type PrintJobInput = {
  /** ID do job criado em `rfid_print_jobs` (createPrintJob retorna isso). */
  jobId: string;
  batchId: string;
  batchCode: string;
  items: PrintJobItem[];
  shirtColor?: string | null;
  designName?: string | null;
  operatorId: string;
  audit: {
    operatorName?: string;
    operatorRole?: string;
  };
};

export type PrintJobSuccess = {
  success: true;
  epcs: string[];
  count: number;
  requestedCount: number;
  partial: boolean;
  codigoInventario: number | null;
  polled: boolean;
};

export type PrintJobFailure = {
  success: false;
  error: string;
  stage?:
    | "validation"
    | "lookup"
    | "idempotency"
    | "iprint_call"
    | "epc_extraction"
    | "persist";
};

export type PrintJobResult = PrintJobSuccess | PrintJobFailure;

type GerarRfidResponse = {
  codigoInventario: number | null;
  epcs: string[];
  polled: boolean;
  rawPreview: string;
};

type IprintRustItem = {
  cor: string | null;
  dataExtra1: string;
  dataExtra2: string;
  ean13: string;
  extra20: string;
  grupo: string;
  nome: string;
  preco: number;
  quantidade: number;
  referencia: string;
  tamanho: string;
  unidade: string;
};

function buildRustItems(input: PrintJobInput): IprintRustItem[] {
  const now = new Date().toISOString();
  const cor = input.shirtColor ?? "";
  return input.items.map((it) => ({
    cor,
    dataExtra1: now,
    dataExtra2: now,
    ean13: it.ean13,
    // extra20 = OP/pedido/NF segundo o PDF. Usamos o batch_code Berzerk
    // pra rastreio bidirecional.
    extra20: input.batchCode,
    grupo: "",
    nome: it.description,
    preco: 0,
    quantidade: it.quantity,
    referencia: it.sku,
    tamanho: it.size,
    unidade: "PC",
  }));
}

function stageFromError(msg: string): PrintJobFailure["stage"] {
  if (msg.startsWith("validation")) return "validation";
  if (msg.startsWith("iprint_call")) return "iprint_call";
  if (msg.startsWith("epc_extraction") || msg.startsWith("query_inventory"))
    return "epc_extraction";
  return undefined;
}

export async function printJob(input: PrintJobInput): Promise<PrintJobResult> {
  if (input.items.length === 0) {
    return { success: false, error: "validation: items vazio", stage: "validation" };
  }

  const config = getIprintConfig();
  if (!config.basicUser || !config.basicPass) {
    return {
      success: false,
      error: "validation: credenciais iTAG não configuradas em Settings",
      stage: "validation",
    };
  }

  const requestedCount = input.items.reduce((s, it) => s + it.quantity, 0);
  const rustItems = buildRustItems(input);

  let resp: GerarRfidResponse;
  try {
    resp = await invoke<GerarRfidResponse>("itag_iprint_gerar_rfid", {
      config: toRustConfig(config),
      codigoEmpresa: config.codigoEmpresa,
      filial: config.filial,
      items: rustItems,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, error: msg, stage: stageFromError(msg) };
  }

  if (resp.epcs.length === 0) {
    return {
      success: false,
      error: "epc_extraction: iTAG não retornou nenhum EPC após poll",
      stage: "epc_extraction",
    };
  }

  // Persiste o mapping EPC → batch/job. Não falha o print inteiro se isso
  // der erro — a impressão física já aconteceu; logamos pra tratar depois.
  try {
    // Manda SÓ a lista, na ordem em que a iTAG a devolveu — quem casa EPC ↔
    // tamanho é o servidor, expandindo os itens do job. Ver a nota grande em
    // `services/printJobs.ts`.
    await saveEpcInventory({
      jobId: input.jobId,
      epcs: resp.epcs,
      codigoInventarioItag: resp.codigoInventario,
    });
  } catch (e) {
    console.error("[iprint] saveEpcInventory falhou:", e);
    // Continua marcando o print como sucesso — EPCs foram queimados, só
    // perdemos a indexação local. UI deveria mostrar aviso.
  }

  return {
    success: true,
    epcs: resp.epcs,
    count: resp.epcs.length,
    requestedCount,
    partial: resp.epcs.length < requestedCount,
    codigoInventario: resp.codigoInventario,
    polled: resp.polled,
  };
}

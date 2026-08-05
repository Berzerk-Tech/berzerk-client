// Impressão SILENCIOSA no Windows via backend Rust (Tauri invoke).
//
// O operador NUNCA vê um diálogo de impressão — a etiqueta J&T (PDF/PNG) e a
// DANFE simplificada (PDF gerado no app) saem direto na impressora padrão (ou
// na configurada) pelo comando Rust `print_pdf_silent`/`print_image_silent`,
// que usa o SumatraPDF (`-print-to-default -silent`). Ver src-tauri/src/printing.rs.

import { invoke } from "@tauri-apps/api/core";

export type PrintOutcome = {
  ok: boolean;
  /** Impressora usada (nome), ou null quando foi a padrão. */
  printer: string | null;
  /** Mensagem de erro (quando ok=false) ou detalhe. */
  message: string | null;
  /** Motor usado ("sumatra", etc.) — debug. */
  engine: string;
};

export type PrintEngineStatus = {
  ok: boolean;
  /** Caminho do SumatraPDF resolvido, ou null se não achou. */
  path: string | null;
  message: string | null;
};

type PrintOpts = {
  /** Nome da impressora. Omitido = impressora padrão do Windows. */
  printer?: string | null;
  /** Nome do job (aparece na fila de impressão) — só cosmético. */
  jobName?: string | null;
};

/** Imprime um PDF (base64, sem prefixo data:) silenciosamente. */
export function printPdfBase64(base64: string, opts: PrintOpts = {}): Promise<PrintOutcome> {
  return invoke<PrintOutcome>("print_pdf_silent", {
    base64: stripDataUrl(base64),
    printer: opts.printer ?? null,
    jobName: opts.jobName ?? null,
  });
}

/** Imprime uma imagem (PNG base64) silenciosamente. */
export function printImageBase64(base64: string, opts: PrintOpts = {}): Promise<PrintOutcome> {
  return invoke<PrintOutcome>("print_image_silent", {
    base64: stripDataUrl(base64),
    printer: opts.printer ?? null,
    jobName: opts.jobName ?? null,
  });
}

/** Imprime uma etiqueta em base64 conforme o formato (pdf|png). */
export function printEtiqueta(
  base64: string,
  formato: "pdf" | "png",
  opts: PrintOpts = {},
): Promise<PrintOutcome> {
  return formato === "png"
    ? printImageBase64(base64, opts)
    : printPdfBase64(base64, opts);
}

/** Lista as impressoras instaladas no Windows (best-effort; [] se falhar). */
export async function listPrinters(): Promise<string[]> {
  try {
    return await invoke<string[]>("list_windows_printers");
  } catch {
    return [];
  }
}

/** Verifica se o motor de impressão silenciosa está disponível (SumatraPDF). */
export function printEngineStatus(): Promise<PrintEngineStatus> {
  return invoke<PrintEngineStatus>("print_engine_status");
}

function stripDataUrl(b64: string): string {
  const comma = b64.indexOf(",");
  return b64.startsWith("data:") && comma >= 0 ? b64.slice(comma + 1) : b64;
}

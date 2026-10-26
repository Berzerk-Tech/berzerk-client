// Cliente do iTAG Monitor — chama o backend Rust via Tauri invoke().
// Substitui o rfid-proxy.exe HTTPS sidecar que webapps browser precisavam.

import { invoke } from "@tauri-apps/api/core";
import { getIprintConfig, toRustConfig } from "../services/iprintConfig";

export type ConnectionStatus = {
  ok: boolean;
  host: string;
  message: string | null;
};

export type PollResult = {
  tags: string[];
  raw_preview: string;
};

export type ItagCommand = "iniciar" | "parar" | "limparLeitura";

/**
 * Verifica se o iTAG Monitor está acessível.
 * `host` opcional — default é `http://127.0.0.1:9093`.
 */
export async function pingItag(host?: string): Promise<ConnectionStatus> {
  return invoke<ConnectionStatus>("itag_ping", { host });
}

/**
 * Envia um comando individual pro iTAG Monitor.
 */
export async function sendItagCommand(comando: ItagCommand, host?: string): Promise<void> {
  return invoke("itag_send_command", { comando, host });
}

/**
 * Lê as tags acumuladas no buffer do iTAG Monitor.
 * Retorna EPCs em hex (uppercase) + um preview do corpo bruto pra debug.
 */
export async function pollItagTags(host?: string): Promise<PollResult> {
  return invoke<PollResult>("itag_poll_tags", { host });
}

/**
 * Re-inventário: para → limpa buffer → reinicia. Usado pra detectar
 * tags REMOVIDAS (o iTAG só acumula, não dá diff).
 */
export async function reInventory(host?: string): Promise<void> {
  return invoke("itag_reinventory", { host });
}

export type EpcDetail = {
  epc: string;
  ean13: string | null;
  nome: string | null;
  tamanho: string | null;
  cor: string | null;
  found: boolean;
  /** Base que resolveu; `"erro"` quando algum ambiente não respondeu (não é
   *  "não existe" — o RfidContext não entra em backoff nesse caso). */
  fonte: string | null;
};

/** Ambiente da iTAG onde vive TODA etiqueta real — as da era posvenda e as
 *  que este app imprime (2,85 M linhas em 26/10, tag gerada no mesmo dia). O
 *  ambiente configurado pra impressão (`itagalert_integracao`, 51 mil linhas
 *  de teste) fica como ÚLTIMO recurso: até 0.9.54 ele era consultado primeiro
 *  e, quando travou (26/10), cada peça esperava 8 s à toa antes de cair no
 *  fallback do nexus com tamanho errado. */
const ITAG_LOOKUP_BASE_PRINCIPAL = "https://itag2.itagalert.com.br/itagalert_berzerk";

/**
 * Resolve EPC → produto (ean13/nome/tamanho/cor) na nuvem da iTAG — o caminho
 * que o posvenda usa em produção. Fonte da verdade: tags em campo nem sempre
 * são SGTIN padrão GS1, então decodificar localmente não basta.
 */
export async function lookupEpcDetails(epcs: string[]): Promise<EpcDetail[]> {
  if (epcs.length === 0) return [];
  const cfg = getIprintConfig();
  return invoke<EpcDetail[]>("itag_epc_details", {
    config: toRustConfig(cfg),
    epcs,
    bases: basesDeLookup(cfg.baseUrl),
    codigoEmpresa: cfg.codigoEmpresa,
  });
}

/** Ordem de consulta: berzerk primeiro; o ambiente configurado só se for outro
 *  (compara pelo path final, o protocolo varia). Pura — testada. */
export function basesDeLookup(baseConfigurada: string): string[] {
  const envOf = (u: string) => u.trim().replace(/\/+$/, "").split("/").pop();
  const bases = [ITAG_LOOKUP_BASE_PRINCIPAL];
  if (baseConfigurada.trim() && envOf(baseConfigurada) !== envOf(ITAG_LOOKUP_BASE_PRINCIPAL)) {
    bases.push(baseConfigurada.trim());
  }
  return bases;
}

export async function startReading(host?: string): Promise<void> {
  return sendItagCommand("iniciar", host);
}

export async function stopReading(host?: string): Promise<void> {
  return sendItagCommand("parar", host);
}

export async function clearBuffer(host?: string): Promise<void> {
  return sendItagCommand("limparLeitura", host);
}

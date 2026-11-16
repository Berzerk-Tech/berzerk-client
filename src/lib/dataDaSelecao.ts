// Data de emissão escolhida na TELA DE SELEÇÃO das filas (antes de entrar na
// mesa): conta os tiles só desse dia/intervalo — pra bater com o número do
// Tiny — e entra na mesa já como filtro de data. Dia sempre no fuso de SP.
import type { QueueFilters } from "../services/orders";

export type DataDaSelecao = { de?: string; ate?: string };

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Soma `dias` a um `YYYY-MM-DD` (calendário puro, sem fuso). */
export function somarDias(dia: string, dias: number): string {
  const [a, m, d] = dia.split("-").map(Number);
  return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10);
}

/** Normaliza: descarta lixo e inverte se `de` > `ate`. Vazio = sem data. */
export function normalizarData(d: DataDaSelecao | null | undefined): DataDaSelecao | null {
  let de = d?.de && ISO.test(d.de) ? d.de : undefined;
  let ate = d?.ate && ISO.test(d.ate) ? d.ate : undefined;
  if (!de && !ate) return null;
  // Só um dos lados = dia único.
  if (!de) de = ate;
  if (!ate) ate = de;
  if (de! > ate!) [de, ate] = [ate, de];
  return { de, ate };
}

/** Filtros de data pra contagem/claim (`undefined` = sem data, chamada idêntica à de antes). */
export function filtrosDaData(d: DataDaSelecao | null | undefined): QueueFilters | undefined {
  const n = normalizarData(d);
  return n ? { dateFrom: n.de, dateTo: n.ate } : undefined;
}

/** `YYYY-MM-DD` → `DD/MM`. */
function dm(dia: string): string {
  const [, m, d] = dia.split("-");
  return `${d}/${m}`;
}

/** "15/11" ou "10/11 a 15/11". */
export function rotuloDaData(d: DataDaSelecao | null | undefined): string {
  const n = normalizarData(d);
  if (!n) return "";
  return n.de === n.ate ? dm(n.de!) : `${dm(n.de!)} a ${dm(n.ate!)}`;
}

/**
 * Filtros iniciais da mesa: os salvos da fila, com a data da seleção POR CIMA
 * (se houve). Sem data na seleção devolve os salvos intactos.
 */
export function mesclarFiltrosIniciais(
  salvos: QueueFilters,
  data: DataDaSelecao | null | undefined,
): QueueFilters {
  const n = normalizarData(data);
  return n ? { ...salvos, dateFrom: n.de, dateTo: n.ate } : salvos;
}

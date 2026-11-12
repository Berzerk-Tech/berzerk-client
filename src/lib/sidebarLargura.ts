// Largura da sidebar da fila (Separação), redimensionável pela operadora.
//
// Antes era um número fixo no código (300, depois 350 a pedido das
// separadoras em 01/09). Cada pedido de "um pouco maior" virava release; agora
// ela arrasta a borda e o tamanho fica gravado na estação (localStorage), como
// os filtros do picking.

export const LARGURA_PADRAO = 350;
/** Abaixo disso o card da fila não cabe (número + miniaturas + tamanho). */
export const LARGURA_MIN = 240;
/** Acima disso, em 1366 px, a área dos cards de itens perde a 2ª coluna. */
export const LARGURA_MAX = 600;

const STORAGE_KEY = "berzerk_separacao_sidebar_largura_v1";

export function limitarLargura(px: number): number {
  if (!Number.isFinite(px)) return LARGURA_PADRAO;
  return Math.min(LARGURA_MAX, Math.max(LARGURA_MIN, Math.round(px)));
}

export function lerLarguraSidebar(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw == null) return LARGURA_PADRAO;
    return limitarLargura(Number(raw));
  } catch {
    return LARGURA_PADRAO;
  }
}

export function gravarLarguraSidebar(px: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(limitarLargura(px)));
  } catch {
    /* localStorage indisponível: a largura vale só na sessão */
  }
}

// Painel do Filtro Mistos na sidebar: recolhido por padrão (a grade de
// miniaturas empurrava a lista de pedidos pra baixo).
const MISTOS_PAINEL_KEY = "berzerk-mistos-painel-aberto";

export function lerMistosPainelAberto(): boolean {
  try {
    return localStorage.getItem(MISTOS_PAINEL_KEY) === "1";
  } catch {
    return false;
  }
}

export function gravarMistosPainelAberto(aberto: boolean): void {
  try {
    localStorage.setItem(MISTOS_PAINEL_KEY, aberto ? "1" : "0");
  } catch {
    /* localStorage indisponível: vale só na sessão */
  }
}

// Histórico ("Repostos nas últimas horas") do Pedir reposição: recolhido por padrão.
const REPOSICAO_HISTORICO_KEY = "berzerk-reposicao-historico-aberto";

export function lerReposicaoHistoricoAberto(): boolean {
  try {
    return localStorage.getItem(REPOSICAO_HISTORICO_KEY) === "1";
  } catch {
    return false;
  }
}

export function gravarReposicaoHistoricoAberto(aberto: boolean): void {
  try {
    localStorage.setItem(REPOSICAO_HISTORICO_KEY, aberto ? "1" : "0");
  } catch {
    /* localStorage indisponível: vale só na sessão */
  }
}

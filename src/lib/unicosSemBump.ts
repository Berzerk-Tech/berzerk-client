// Chave "Sem order bump" da aba Únicos (Lucas, 14/11): com ela ligada a contagem dos chips,
// a lista do tamanho e a impressão manual ignoram os pedidos com order bump. Fica na máquina.

const CHAVE = "berzerk-unicos-sem-order-bump";

export function lerSemOrderBump(): boolean {
  try {
    return localStorage.getItem(CHAVE) === "1";
  } catch {
    return false;
  }
}

export function salvarSemOrderBump(ligado: boolean): void {
  try {
    if (ligado) localStorage.setItem(CHAVE, "1");
    else localStorage.removeItem(CHAVE);
  } catch {
    /* sem localStorage: vale só nesta sessão */
  }
}

/** Pedidos que contam com a chave ligada: o total menos os com bump (nunca negativo). */
export function pedidosSemBump(pedidos: number, comOrderBump: number | null | undefined): number {
  return Math.max(0, pedidos - (comOrderBump ?? 0));
}

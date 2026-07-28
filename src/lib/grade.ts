export type GradeEntry = {
  size: string;
  quantity: number;
};

/**
 * Parseia texto de grade tipo "0PP|66P|134M|200G|133GG|63XG|0XXG"
 * em [{size, quantity}]. Ignora entradas com quantidade 0.
 *
 * O tamanho aceita dígitos DEPOIS da primeira letra ("10G1" → 10× G1): nem toda
 * grade segue P|M|G|GG|XG — plus sizes G1/G2/G3 existem e eram descartados
 * silenciosamente pelo regex antigo (só letras), sumindo da contagem e da
 * impressão.
 */
export function parseGrade(grade: string | null | undefined): GradeEntry[] {
  if (!grade) return [];
  const parts = grade
    .split(/[|,;\-\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const result: GradeEntry[] = [];
  for (const part of parts) {
    const match = part.match(/^(\d+)\s*([A-Za-zÀ-ÿ][A-Za-z0-9À-ÿ]*)$/);
    if (!match) continue;
    const qty = parseInt(match[1], 10);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    result.push({ size: match[2].toUpperCase(), quantity: qty });
  }
  return result;
}

/**
 * Agrega lista de items por size somando quantities.
 * Útil quando vem de silk_records (1 row por size, mas pode ter duplicatas).
 */
export function aggregateBySize(
  items: Array<{ size: string; quantity: number }>,
): GradeEntry[] {
  const map = new Map<string, number>();
  for (const item of items) {
    const sz = item.size.toUpperCase();
    map.set(sz, (map.get(sz) ?? 0) + item.quantity);
  }
  return Array.from(map.entries())
    .map(([size, quantity]) => ({ size, quantity }))
    .sort((a, b) => compareSizes(a.size, b.size));
}

/**
 * Ordem canônica dos tamanhos (do menor pro maior). Usada pra ordenar o que
 * vai pro iPrint — a iTAG imprime na ordem do payload, e a fábrica espera
 * PP → P → M → G → GG → XG → XXG (e não P, depois XG, fora de ordem).
 * Tamanhos desconhecidos caem no fim (rank = comprimento da lista).
 */
export const SIZE_ORDER = [
  "PP",
  "P",
  "M",
  "G",
  "GG",
  "XG",
  "G1",
  "G2",
  "G3",
  "XGG",
  "XXG",
  "XXXG",
  "EXG",
  "U",
];

/** Posição do tamanho na ordem canônica. Desconhecido vai pro fim. */
export function sizeRank(size: string | null | undefined): number {
  if (!size) return SIZE_ORDER.length;
  const i = SIZE_ORDER.indexOf(size.toUpperCase());
  return i === -1 ? SIZE_ORDER.length : i;
}

/** Comparador pra `sort` por ordem de tamanho (desempate alfabético). */
export function compareSizes(
  a: string | null | undefined,
  b: string | null | undefined,
): number {
  const d = sizeRank(a) - sizeRank(b);
  return d !== 0 ? d : (a ?? "").localeCompare(b ?? "");
}

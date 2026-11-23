import { KNOWN_SIZES, canonicalizeTamanho } from "./itemParecido";

/**
 * Selo de variante numerada — SÓ EXIBIÇÃO. Produtos quase homônimos
 * ("Oversized Freaky Season - Ganley 1" × "… Ganley 2", ambos pretos) são
 * confundidos na separação/embalagem; o número do fim da estampa vira um selo
 * grande de cor fixa. Não participa de chave/agrupamento nenhum (as chaves
 * espelham o Nexus).
 */

function ehTamanho(token: string | null | undefined): boolean {
  const c = canonicalizeTamanho(token);
  return !!c && (KNOWN_SIZES.has(c) || c === "TU");
}

/** Número (1–9) no fim da estampa do nome, ou null quando não há variante. */
export function varianteNumerada(nome: string | null | undefined): number | null {
  const bruto = nome?.trim();
  if (!bruto) return null;
  const segmentos = bruto.split(/\s+[-–—]\s+/).map((s) => s.trim()).filter(Boolean);
  if (segmentos.length === 0) return null;

  // Último segmento é o tamanho ("… - Ganley 1 - P"): descarta.
  if (segmentos.length > 1 && ehTamanho(segmentos[segmentos.length - 1])) segmentos.pop();

  let estampa = segmentos[segmentos.length - 1];
  // Tamanho colado sem hífen ("Ganley 2 GG").
  const tokens = estampa.split(/\s+/);
  if (tokens.length > 1 && ehTamanho(tokens[tokens.length - 1])) {
    estampa = tokens.slice(0, -1).join(" ");
  }

  // "Short Dry Fit 2 em 1": não é variante.
  if (/\d\s+em\s+\d$/i.test(estampa)) return null;
  const m = /\p{L}.*\s(\d)$/u.exec(estampa);
  if (!m) return null;
  return Number(m[1]);
}

/** Paleta fixa por número (1–5 distintas; 6–9 repetem o ciclo com cores extras). */
const PALETA: ReadonlyArray<{ fundo: string; texto: string }> = [
  { fundo: "#2563eb", texto: "#ffffff" }, // 1 azul
  { fundo: "#ea580c", texto: "#ffffff" }, // 2 laranja
  { fundo: "#7c3aed", texto: "#ffffff" }, // 3 roxo
  { fundo: "#16a34a", texto: "#ffffff" }, // 4 verde
  { fundo: "#db2777", texto: "#ffffff" }, // 5 rosa
  { fundo: "#0891b2", texto: "#ffffff" }, // 6 ciano
  { fundo: "#4d7c0f", texto: "#ffffff" }, // 7 oliva
  { fundo: "#a21caf", texto: "#ffffff" }, // 8 magenta
  { fundo: "#475569", texto: "#ffffff" }, // 9 ardósia
];

export function corDaVariante(n: number): { fundo: string; texto: string } {
  const i = (((Math.trunc(n) - 1) % PALETA.length) + PALETA.length) % PALETA.length;
  return PALETA[i];
}

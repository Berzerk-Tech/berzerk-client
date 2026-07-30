// Decodificador SGTIN-96 → EAN-13/GTIN-14, em paridade EXATA com o
// `rfidDecoder` do posvenda (engenharia reversa do bundle). As tags da Berzerk
// carregam o GTIN codificado no próprio EPC — dá pra identificar a peça sem
// consultar inventário nenhum.

/** partição → [bits do prefixo da empresa, dígitos, bits do item, dígitos]. */
const PARTITIONS: Record<number, [number, number, number, number]> = {
  0: [40, 12, 4, 1],
  1: [37, 11, 7, 2],
  2: [34, 10, 10, 3],
  3: [30, 9, 14, 4],
  4: [27, 8, 17, 5],
  5: [24, 7, 20, 6],
  6: [20, 6, 24, 7],
};

/**
 * Dígito verificador — soma SEMPRE os 12 primeiros dígitos (paridade exata com
 * o decoder do posvenda, inclusive no ramo GTIN-14).
 */
function checkDigit(digits: string): string {
  let sum = 0;
  for (let i = 0; i < 12; i++) {
    const d = parseInt(digits[i], 10);
    sum += i % 2 === 0 ? d : d * 3;
  }
  const mod = sum % 10;
  return mod === 0 ? "0" : String(10 - mod);
}

function hexToBits(hex: string): string {
  return hex
    .split("")
    .map((c) => parseInt(c, 16).toString(2).padStart(4, "0"))
    .join("");
}

function bits(bin: string, start: number, len: number): number {
  return parseInt(bin.slice(start, start + len), 2);
}

/**
 * Decodifica um EPC SGTIN-96 (24 hex começando com 0x30) pro EAN-13 (indicador
 * 0) ou GTIN-14. Retorna null se não for SGTIN-96 válido.
 */
export function decodeSgtin96(epc: string): string | null {
  const t = epc.trim().toUpperCase();
  if (!/^[0-9A-F]{24}$/.test(t) || t.slice(0, 2) !== "30") return null;
  const bin = hexToBits(t);
  const partition = bits(bin, 11, 3);
  const layout = PARTITIONS[partition];
  if (!layout) return null;
  const [cpBits, cpDigits, irBits, irDigits] = layout;
  const company = bits(bin, 14, cpBits).toString().padStart(cpDigits, "0");
  const itemRef = bits(bin, 14 + cpBits, irBits).toString().padStart(irDigits, "0");
  const indicator = itemRef[0];
  const rest = itemRef.slice(1);
  if (indicator === "0") {
    const body = company + rest; // 12 dígitos
    return body + checkDigit(body); // EAN-13
  }
  const body = (indicator + company + rest).slice(0, 13);
  return body + checkDigit(body); // GTIN-14
}

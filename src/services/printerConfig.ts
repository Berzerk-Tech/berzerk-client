// Impressora (do Windows) usada pra imprimir a etiqueta J&T e a DANFE na
// Expedição. Guarda o NOME da impressora do spooler do Windows (o que o
// SumatraPDF usa no -print-to). Vazio = usa a impressora PADRÃO do Windows.
// Persiste por estação (localStorage).

const KEY = "berzerk_label_printer_v1";

export function getLabelPrinter(): string | null {
  try {
    return localStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
}

export function setLabelPrinter(name: string | null): void {
  try {
    if (name && name.trim()) localStorage.setItem(KEY, name);
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

// Impressora do ROMANEIO da gaiola (Expedição, 15/10): folha A4 com uma linha
// por pedido (300+ linhas). NÃO pode cair na térmica de etiquetas: cada página
// ali é um saco a mais no chão da embalagem. Vazio = padrão do Windows; a
// operadora escolhe na hora de imprimir e a escolha fica por estação.
const KEY_ROMANEIO = "berzerk_romaneio_printer_v1";

export function getRomaneioPrinter(): string | null {
  try {
    return localStorage.getItem(KEY_ROMANEIO) || null;
  } catch {
    return null;
  }
}

export function setRomaneioPrinter(name: string | null): void {
  try {
    if (name && name.trim()) localStorage.setItem(KEY_ROMANEIO, name);
    else localStorage.removeItem(KEY_ROMANEIO);
  } catch {
    /* ignore */
  }
}

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

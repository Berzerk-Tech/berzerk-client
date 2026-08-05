// Página de teste da impressão (Expedição) — gera um PDF 100×150 mm simples e
// manda pra impressora escolhida (ou a padrão), pra isolar "a impressora
// funciona?" de "o pedido tem etiqueta?".

import { jsPDF } from "jspdf";
import { printPdfBase64, type PrintOutcome } from "./printer";

export async function imprimirTeste(printer?: string | null): Promise<PrintOutcome> {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: [100, 150] });
  doc.rect(4, 4, 92, 142);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(20);
  doc.text("BERZERK", 50, 30, { align: "center" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(11);
  doc.text("Teste de impressão", 50, 44, { align: "center" });
  doc.text("Expedição", 50, 52, { align: "center" });
  doc.setFontSize(9);
  doc.text(new Date().toLocaleString("pt-BR"), 50, 70, { align: "center" });
  doc.text(printer ? `Impressora: ${printer}` : "Impressora: padrão do Windows", 50, 80, {
    align: "center",
    maxWidth: 88,
  });
  const b64 = doc.output("datauristring").split(",")[1] ?? "";
  return printPdfBase64(b64, { printer: printer ?? null, jobName: "Teste Berzerk" });
}

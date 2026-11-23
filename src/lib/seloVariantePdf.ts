import type { jsPDF } from "jspdf";

/**
 * Selo de variante nas etiquetas térmicas (só preto): caixa PRETA cheia com o
 * número em branco e negrito. Só exibição; o chamador reserva `lado + respiro`
 * à esquerda do nome quando `varianteNumerada(nome)` não é null.
 */
export const RESPIRO_SELO_PDF = 1.5;

export function desenharSeloPdf(pdf: jsPDF, n: number, x: number, yTopo: number, lado: number): void {
  pdf.setFillColor(0, 0, 0);
  pdf.rect(x, yTopo, lado, lado, "F");
  pdf.setTextColor(255);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(lado * 2.6);
  // Baseline ~ 78% da altura da caixa deixa o dígito visualmente centrado.
  pdf.text(String(n), x + lado / 2, yTopo + lado * 0.79, { align: "center" });
  pdf.setTextColor(0);
}

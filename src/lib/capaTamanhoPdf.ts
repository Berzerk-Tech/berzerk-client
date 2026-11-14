// Capa da impressão manual do tamanho inteiro (Únicos): UMA página no tamanho da
// etiqueta J&T (76 × 130 mm), impressa antes das etiquetas pra quem embala saber
// de que caixa (estampa × cor × tamanho) é a pilha. Só preto (térmica).
// Função pura jsPDF → base64.

import { jsPDF } from "jspdf";

export type CapaTamanhoDoc = {
  estampa: string;
  cor?: string | null;
  tamanho: string;
  pedidos: number;
  /** Pedidos com order bump (saem no fim da pilha). */
  comBump: number;
  /** Quem imprime (e-mail/nome do operador). */
  operador?: string | null;
  /** Injetável nos testes. */
  quando?: Date;
};

/** 76 × 130 mm em pontos. */
export const CAPA_LARGURA_PT = 215.43;
export const CAPA_ALTURA_PT = 368.5;
const MARGEM = 12;

function fmtDataHora(d: Date): string {
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function gerarCapaTamanhoPdf(doc: CapaTamanhoDoc): string {
  const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: [CAPA_LARGURA_PT, CAPA_ALTURA_PT] });
  const util = CAPA_LARGURA_PT - 2 * MARGEM;
  const centro = CAPA_LARGURA_PT / 2;
  let y = MARGEM + 6;

  const bloco = (texto: string, pt: number, estilo: "bold" | "normal", maxLinhas: number): void => {
    pdf.setFont("helvetica", estilo);
    pdf.setFontSize(pt);
    const linhas = (pdf.splitTextToSize(texto || "—", util) as string[]).slice(0, maxLinhas);
    for (const l of linhas) {
      y += pt * 1.05;
      pdf.text(l, centro, y, { align: "center" });
    }
    y += 4;
  };

  bloco("CAPA · TAMANHO INTEIRO", 8, "bold", 1);
  bloco(doc.estampa, 18, "bold", 2);
  if (doc.cor) bloco(doc.cor, 14, "normal", 1);

  // Tamanho em letra enorme: o corpo cabe na largura útil e ocupa boa parte da página.
  const tam = (doc.tamanho || "—").toUpperCase();
  pdf.setFont("helvetica", "bold");
  let pt = 190;
  pdf.setFontSize(pt);
  while (pt > 40 && pdf.getTextWidth(tam) > util) {
    pt -= 6;
    pdf.setFontSize(pt);
  }
  y += pt * 0.78;
  pdf.text(tam, centro, y, { align: "center" });
  y += 14;

  pdf.setLineWidth(1);
  pdf.line(MARGEM, y, CAPA_LARGURA_PT - MARGEM, y);
  y += 4;
  bloco(`${doc.pedidos} pedido${doc.pedidos === 1 ? "" : "s"}`, 20, "bold", 1);
  if (doc.comBump > 0) bloco(`${doc.comBump} com order bump (no fim)`, 11, "bold", 1);

  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(8);
  const rodape = [fmtDataHora(doc.quando ?? new Date()), doc.operador ?? ""].filter(Boolean).join(" · ");
  pdf.text(rodape, centro, CAPA_ALTURA_PT - MARGEM, { align: "center", maxWidth: util });

  return pdf.output("datauristring").split(",")[1] ?? "";
}

// Folha do Picking Geral (A4) — a lista que a separadora leva pra prateleira:
// uma seção por tamanho, tabela SKU | Produto | Qtd. Sai em base64 pra
// impressão SILENCIOSA (src/lib/printer.ts), o mesmo caminho da etiqueta J&T e
// da DANFE — window.print() dentro do WebView abriria diálogo do Windows, que
// é justamente o que a mesa não tem como responder.

import { jsPDF } from "jspdf";

export type PickingLinha = {
  sku: string;
  produto: string;
  qtd: number;
};

export type PickingSecao = {
  /** Tamanho da seção ("P", "M"… ou "SEM TAMANHO"). */
  tamanho: string;
  produtos: number;
  itens: number;
  pedidos: number;
  linhas: PickingLinha[];
};

export type PickingDoc = {
  /** "Picking Geral — Ana". */
  titulo: string;
  /** "Todos os pedidos · 14/08/2026 · 49 produtos • 153 itens • 637 pedidos". */
  subtitulo: string;
  secoes: PickingSecao[];
};

const M = 12;
const W = 210;
const H = 297;
const LIMITE_Y = H - 14;

/** Gera o PDF do picking e devolve o base64 (sem prefixo data:). */
export function gerarPickingPdf(doc: PickingDoc): string {
  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  let y = M + 4;
  let pagina = 1;

  const texto = (
    s: string,
    x: number,
    yy: number,
    size = 9,
    style: "normal" | "bold" = "normal",
  ) => {
    pdf.setFont("helvetica", style);
    pdf.setFontSize(size);
    pdf.text(s, x, yy);
  };
  const direita = (s: string, yy: number, size = 9, style: "normal" | "bold" = "normal") => {
    pdf.setFont("helvetica", style);
    pdf.setFontSize(size);
    pdf.text(s, W - M, yy, { align: "right" });
  };
  const linha = (yy: number, forte = false) => {
    pdf.setLineWidth(forte ? 0.4 : 0.15);
    pdf.line(M, yy, W - M, yy);
  };

  const rodape = () => {
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(7);
    pdf.text(`Página ${pagina}`, W - M, H - 7, { align: "right" });
    pdf.text(new Date().toLocaleString("pt-BR"), M, H - 7);
  };

  const novaPagina = () => {
    rodape();
    pdf.addPage();
    pagina += 1;
    y = M + 4;
  };

  /** Quebra a página se a próxima faixa de `altura` mm não couber. */
  const garantirEspaco = (altura: number) => {
    if (y + altura > LIMITE_Y) novaPagina();
  };

  texto(doc.titulo, M, y, 15, "bold");
  y += 6;
  texto(doc.subtitulo, M, y, 8.5);
  y += 3;
  linha(y, true);
  y += 7;

  for (const secao of doc.secoes) {
    // Cabeçalho da seção + cabeçalho da tabela + 1ª linha: se não couber tudo,
    // a seção começa na página seguinte (evita título órfão no pé da folha).
    garantirEspaco(20);
    texto(secao.tamanho, M, y, 12, "bold");
    direita(
      `${secao.produtos} produtos • ${secao.itens} itens • ${secao.pedidos} pedidos`,
      y,
      8.5,
    );
    y += 2.5;
    linha(y);
    y += 5;

    cabecalhoTabela();
    for (const l of secao.linhas) {
      if (y + 6 > LIMITE_Y) {
        novaPagina();
        texto(`${secao.tamanho} (continuação)`, M, y, 11, "bold");
        y += 5;
        cabecalhoTabela();
      }
      texto(l.sku || "—", M, y, 8.5);
      texto(corta(pdf, l.produto, 118), M + 34, y, 8.5);
      direita(String(l.qtd), y, 9.5, "bold");
      y += 4.4;
      pdf.setDrawColor(215);
      linha(y - 1.6);
      pdf.setDrawColor(0);
    }
    y += 6;
  }

  rodape();
  return pdf.output("datauristring").split(",")[1] ?? "";

  function cabecalhoTabela() {
    texto("SKU", M, y, 7.5, "bold");
    texto("PRODUTO", M + 34, y, 7.5, "bold");
    direita("QTD.", y, 7.5, "bold");
    y += 1.8;
    linha(y);
    y += 4.2;
  }
}

/** Corta o texto no limite de largura em mm (com reticências). */
function corta(pdf: jsPDF, s: string, larguraMm: number): string {
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(8.5);
  if (pdf.getTextWidth(s) <= larguraMm) return s;
  let out = s;
  while (out.length > 4 && pdf.getTextWidth(`${out}…`) > larguraMm) out = out.slice(0, -1);
  return `${out}…`;
}

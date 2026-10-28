// Romaneio da GAIOLA — a folha que vai com a gaiola pra J&T (15/10).
//
// Sai em A4 retrato, uma linha por pedido (300 a 400 por gaiola) em DUAS
// COLUNAS por página (esquerda de cima a baixo, depois a direita): uma coluna
// só dava 8 a 10 folhas por gaiola, e o chão pediu economia de papel. A coluna
// dupla fica em ~4 folhas; a zebra (linhas alternadas em cinza claro) mantém a
// leitura boa em lista longa. Espaço pra assinatura do motorista no fim. Mesmo caminho dos outros impressos do
// app: jsPDF → base64 → impressão silenciosa (src/lib/printer.ts). Nada de
// HTML/`window.print()`: no WebView2 isso abre o diálogo do Windows, que a
// mesa não tem como responder.
//
// NÃO mandar pra térmica de etiquetas: cada página impressa ali é um saco a
// mais no chão da embalagem (ver `ETIQUETA_UNICA` em printer.ts). A escolha
// da impressora fica em `printerConfig.getRomaneioPrinter`.

import { jsPDF } from "jspdf";
import type { Manifest, ManifestOrder } from "../services/expedicao";

export type RomaneioDoc = {
  /** Número da gaiola ("Gaiola 12"); null = romaneio sem gaiola (diário). */
  gaiolaNumero: number | null;
  romaneio: Manifest;
};

/** A4 retrato (mm), margem de 12 mm. */
const W = 210;
const H = 297;
const M = 12;
const ALTURA_LINHA = 4.4;
/** Abaixo disto é rodapé. */
const LIMITE_Y = H - 14;

/** Duas colunas de 90 mm com calha de 6 mm (soma 186 = área útil). */
const LARGURA_COL = 90;
const CALHA = 6;
const X_COL = [M, M + LARGURA_COL + CALHA] as const;

/** Campos dentro de uma coluna (offset x e largura, mm). Soma = 90. */
const CAMPOS = {
  seq: { x: 0, w: 7 },
  pedido: { x: 7, w: 23 },
  cliente: { x: 30, w: 36 },
  rastreio: { x: 66, w: 24 },
} as const;

/** Altura reservada pro cabeçalho (título + metadados + cabeçalho da tabela). */
const ALTURA_CABECALHO = 40;
/** A assinatura precisa de ~28 mm no fim da última página. */
const ALTURA_ASSINATURA = 28;

const LINHAS_POR_COLUNA = Math.floor((LIMITE_Y - ALTURA_CABECALHO) / ALTURA_LINHA);
/** Pedidos por página (duas colunas). */
export const LINHAS_POR_PAGINA = 2 * LINHAS_POR_COLUNA;

/** Gera o PDF do romaneio e devolve o base64 (sem prefixo data:). */
export function gerarRomaneioPdf(doc: RomaneioDoc): string {
  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const linhas = doc.romaneio.orders;
  const paginas = paginar(linhas);
  let yFim = ALTURA_CABECALHO;

  paginas.forEach((pagina, i) => {
    if (i > 0) pdf.addPage("a4", "portrait");
    cabecalho(pdf, doc, i + 1, paginas.length);
    tabela(pdf, pagina.linhas, pagina.inicio, pagina.esq, ALTURA_CABECALHO);
    rodape(pdf, i + 1, paginas.length);
    yFim = ALTURA_CABECALHO + pagina.esq * ALTURA_LINHA;
  });
  if (linhas.length === 0) {
    pdf.setFontSize(10);
    pdf.text("Nenhum pedido neste romaneio.", M, ALTURA_CABECALHO);
    yFim += ALTURA_LINHA;
  }
  assinatura(pdf, yFim + 6);

  return pdf.output("datauristring").split(",")[1] ?? "";
}

/** `esq` = quantas linhas vão na coluna esquerda (o resto vai pra direita). */
type Pagina = { linhas: ManifestOrder[]; inicio: number; esq: number };

/**
 * Sempre ao menos uma página. Páginas cheias enchem a esquerda primeiro; a
 * ÚLTIMA divide as linhas ao meio entre as colunas pra sobrar lugar pra
 * assinatura (até 96 pedidos cabem numa folha só). Se mesmo assim não couber,
 * entra uma página só com a assinatura.
 */
function paginar(linhas: ManifestOrder[]): Pagina[] {
  const paginas: Pagina[] = [];
  for (let i = 0; i < linhas.length; i += LINHAS_POR_PAGINA) {
    const fatia = linhas.slice(i, i + LINHAS_POR_PAGINA);
    paginas.push({ linhas: fatia, inicio: i, esq: Math.min(fatia.length, LINHAS_POR_COLUNA) });
  }
  if (paginas.length === 0) paginas.push({ linhas: [], inicio: 0, esq: 0 });
  const ultima = paginas[paginas.length - 1];
  ultima.esq = Math.ceil(ultima.linhas.length / 2);
  if (ALTURA_CABECALHO + ultima.esq * ALTURA_LINHA + ALTURA_ASSINATURA > LIMITE_Y) {
    paginas.push({ linhas: [], inicio: linhas.length, esq: 0 });
  }
  return paginas;
}

function cabecalho(pdf: jsPDF, doc: RomaneioDoc, pagina: number, total: number): void {
  const r = doc.romaneio;
  const titulo = doc.gaiolaNumero != null ? `Romaneio J&T · Gaiola ${doc.gaiolaNumero}` : "Romaneio J&T";
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(16);
  pdf.text(titulo, M, M + 4);
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(9);
  pdf.text(`Página ${pagina}/${total}`, W - M, M + 4, { align: "right" });

  const meta = [
    `Romaneio nº ${texto(r.manifestNumber)}`,
    `Fechado em ${dataHora(r.closedAt)}`,
    `Responsável: ${texto(r.closedByName)}`,
    `Total de pedidos: ${r.orderCount}`,
  ];
  pdf.setFontSize(10);
  pdf.text(meta.join("   ·   "), M, M + 11);
  if (r.notes) {
    pdf.setFontSize(8.5);
    pdf.text(pdf.splitTextToSize(`Obs.: ${r.notes}`, W - 2 * M)[0] ?? "", M, M + 16);
  }

  // Cabeçalho da tabela
  const y = M + 23;
  pdf.setDrawColor(0);
  pdf.setLineWidth(0.3);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(8.5);
  for (const x0 of X_COL) {
    pdf.line(x0, y + 1.5, x0 + LARGURA_COL, y + 1.5);
    pdf.text("#", x0 + CAMPOS.seq.x, y);
    pdf.text("Pedido", x0 + CAMPOS.pedido.x, y);
    pdf.text("Cliente", x0 + CAMPOS.cliente.x, y);
    pdf.text("Rastreio", x0 + CAMPOS.rastreio.x, y);
  }
  pdf.setFont("helvetica", "normal");
}

function tabela(pdf: jsPDF, linhas: ManifestOrder[], inicio: number, nEsq: number, y0: number): void {
  for (let i = 0; i < linhas.length; i++) {
    const col = i < nEsq ? 0 : 1;
    const x0 = X_COL[col];
    // Linha DENTRO da coluna: a zebra alterna igual nas duas (senão vira xadrez).
    const linha = col === 0 ? i : i - nEsq;
    const y = y0 + linha * ALTURA_LINHA;
    const o = linhas[i];
    // Zebra: fundo ANTES do texto.
    if (linha % 2 === 1) {
      pdf.setFillColor(243, 243, 243);
      pdf.rect(x0, y - 3.2, LARGURA_COL, ALTURA_LINHA, "F");
    }
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(8);
    pdf.text(String(inicio + i + 1), x0 + CAMPOS.seq.x, y);
    pdf.text(cortar(pdf, texto(o.cliente), CAMPOS.cliente.w), x0 + CAMPOS.cliente.x, y);
    pdf.text(cortar(pdf, texto(o.trackingCode), CAMPOS.rastreio.w), x0 + CAMPOS.rastreio.x, y);
    // Pedido em negrito + conta Tiny pequena logo depois.
    const xPedido = x0 + CAMPOS.pedido.x;
    pdf.setFont("helvetica", "bold");
    const num = texto(o.tinyOrderNumber);
    pdf.text(num, xPedido, y);
    const conta = texto(o.tinyAccount);
    if (conta) {
      const wNum = pdf.getTextWidth(num);
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(6.5);
      pdf.text(conta, xPedido + wNum + 1, y);
    }
  }
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(8);
  // Linha vertical fina no meio da calha, do cabeçalho da tabela à última linha.
  if (linhas.length > 0) {
    const xMeio = M + LARGURA_COL + CALHA / 2;
    pdf.setDrawColor(180);
    pdf.setLineWidth(0.2);
    pdf.line(xMeio, y0 - 4, xMeio, y0 - 3.2 + nEsq * ALTURA_LINHA);
    pdf.setDrawColor(0);
  }
}

function assinatura(pdf: jsPDF, y: number): void {
  const yLinha = Math.min(y + 16, LIMITE_Y - 6);
  pdf.setFontSize(9);
  pdf.setDrawColor(0);
  pdf.setLineWidth(0.3);
  pdf.line(M, yLinha, M + 90, yLinha);
  pdf.text("Assinatura do motorista (J&T)", M, yLinha + 4.5);
  pdf.line(M + 110, yLinha, W - M, yLinha);
  pdf.text("Data e hora da coleta", M + 110, yLinha + 4.5);
}

function rodape(pdf: jsPDF, pagina: number, total: number): void {
  pdf.setFontSize(7.5);
  pdf.setTextColor(110);
  pdf.text(`Berzerk Client · impresso em ${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })} · ${pagina}/${total}`, W / 2, H - 7, { align: "center" });
  pdf.setTextColor(0);
}

function texto(v: string | number | null | undefined): string {
  if (v == null) return "";
  return String(v).replace(/[\r\n\t]+/g, " ").trim();
}

function cortar(pdf: jsPDF, s: string, largura: number): string {
  if (!s) return "";
  if (pdf.getTextWidth(s) <= largura - 1.5) return s;
  let t = s;
  while (t.length > 1 && pdf.getTextWidth(`${t}…`) > largura - 1.5) t = t.slice(0, -1);
  return `${t}…`;
}

function dataHora(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

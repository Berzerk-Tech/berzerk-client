// Romaneio da GAIOLA — a folha que vai com a gaiola pra J&T (15/10).
//
// Sai em A4 retrato, UMA LINHA POR PEDIDO (300 a 400 por gaiola), com espaço
// pra assinatura do motorista no fim. Mesmo caminho dos outros impressos do
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
const ALTURA_LINHA = 5.2;
/** Abaixo disto é rodapé. */
const LIMITE_Y = H - 14;

/** Colunas: x inicial e largura (mm). Soma = 186 (área útil). */
const COLUNAS = {
  seq: { x: M, w: 10 },
  pedido: { x: M + 10, w: 24 },
  conta: { x: M + 34, w: 14 },
  cliente: { x: M + 48, w: 78 },
  rastreio: { x: M + 126, w: 44 },
  hora: { x: M + 170, w: 16 },
} as const;

/** Gera o PDF do romaneio e devolve o base64 (sem prefixo data:). */
export function gerarRomaneioPdf(doc: RomaneioDoc): string {
  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const linhas = doc.romaneio.orders;
  const paginas = paginar(linhas);
  let yFim = ALTURA_CABECALHO;

  paginas.forEach((pagina, i) => {
    if (i > 0) pdf.addPage("a4", "portrait");
    cabecalho(pdf, doc, i + 1, paginas.length);
    tabela(pdf, pagina.linhas, pagina.inicio, ALTURA_CABECALHO);
    rodape(pdf, i + 1, paginas.length);
    yFim = ALTURA_CABECALHO + pagina.linhas.length * ALTURA_LINHA;
  });
  if (linhas.length === 0) {
    pdf.setFontSize(10);
    pdf.text("Nenhum pedido neste romaneio.", M, ALTURA_CABECALHO);
    yFim += ALTURA_LINHA;
  }
  assinatura(pdf, yFim + 6);

  return pdf.output("datauristring").split(",")[1] ?? "";
}

type Pagina = { linhas: ManifestOrder[]; inicio: number };

/** Altura reservada pro cabeçalho (título + metadados + cabeçalho da tabela). */
const ALTURA_CABECALHO = 40;
/** A assinatura precisa de ~28 mm no fim da última página. */
const ALTURA_ASSINATURA = 28;

/** Sempre ao menos uma página; a assinatura tem que caber depois da última linha. */
function paginar(linhas: ManifestOrder[]): Pagina[] {
  const paginas: Pagina[] = [];
  const porPagina = Math.floor((LIMITE_Y - ALTURA_CABECALHO) / ALTURA_LINHA);
  for (let i = 0; i < linhas.length; i += porPagina) {
    paginas.push({ linhas: linhas.slice(i, i + porPagina), inicio: i });
  }
  if (paginas.length === 0) paginas.push({ linhas: [], inicio: 0 });
  const ultima = paginas[paginas.length - 1];
  if (ALTURA_CABECALHO + ultima.linhas.length * ALTURA_LINHA + ALTURA_ASSINATURA > LIMITE_Y) {
    paginas.push({ linhas: [], inicio: linhas.length });
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
  pdf.line(M, y + 1.5, W - M, y + 1.5);
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(8.5);
  pdf.text("#", COLUNAS.seq.x, y);
  pdf.text("Pedido", COLUNAS.pedido.x, y);
  pdf.text("Conta", COLUNAS.conta.x, y);
  pdf.text("Cliente", COLUNAS.cliente.x, y);
  pdf.text("Rastreio", COLUNAS.rastreio.x, y);
  pdf.text("Hora", COLUNAS.hora.x, y);
  pdf.setFont("helvetica", "normal");
}

function tabela(pdf: jsPDF, linhas: ManifestOrder[], inicio: number, y0: number): void {
  pdf.setFontSize(8.5);
  let y = y0;
  linhas.forEach((o, i) => {
    pdf.text(String(inicio + i + 1), COLUNAS.seq.x, y);
    pdf.text(cortar(pdf, texto(o.tinyOrderNumber), COLUNAS.pedido.w), COLUNAS.pedido.x, y);
    pdf.text(cortar(pdf, texto(o.tinyAccount), COLUNAS.conta.w), COLUNAS.conta.x, y);
    pdf.text(cortar(pdf, texto(o.cliente), COLUNAS.cliente.w), COLUNAS.cliente.x, y);
    pdf.text(cortar(pdf, texto(o.trackingCode), COLUNAS.rastreio.w), COLUNAS.rastreio.x, y);
    pdf.text(hora(o.printedAt), COLUNAS.hora.x, y);
    y += ALTURA_LINHA;
  });
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

function hora(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" });
}

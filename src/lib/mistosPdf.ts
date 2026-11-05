// Etiqueta do Filtro Mistos — o picking das peças de OUTRO tamanho, na Zebra.
//
// Réplica do `@media print` do protótipo do Lucas (04/11/2026): etiqueta
// 100×150 mm, SÓ PRETO (térmica), sem foto. Cabeçalho "MISTOS · FILA M", o
// resumo "N pedidos · Z peças fora do M", e por produto o nome, o total e a
// grade dos 4 tamanhos fora da fila. Vai em base64 pra impressão silenciosa
// (mesmo caminho do `pickingPdf.ts`). Produto nunca quebra no meio da página;
// as seguintes repetem o cabeçalho com "(2/3)".

import { jsPDF } from "jspdf";
import { tamanhosForaDaFila, type PickingMisto } from "./mistos";

export type MistosDoc = {
  /** Tamanho da fila ("M"). */
  fila: string;
  pedidos: number;
  linhas: PickingMisto[];
  /** Folha de consulta (impressa do Filtro Inteligente, sem reservar pedidos). */
  consulta?: boolean;
};

const W = 100;
const H = 150;
const M = 3;
const LARGURA_UTIL = W - 2 * M;
const PT_NOME = 14;
const PT_TOTAL = 22;
const PT_TAM = 11;
const PT_NUM = 18;
/** Coluna do total (mm) e do quadradinho + respiro, à esquerda do nome. */
const LARGURA_TOTAL = 17;
const LADO_QUADRADO = 5;
const LARGURA_NOME = LARGURA_UTIL - LADO_QUADRADO - 2 - LARGURA_TOTAL - 2;
/** mm por linha de nome (14pt ≈ 4.9 mm + folga). */
const LINHA_NOME = 5.6;
const ALTURA_CAIXA = 10;
const PAD_PRODUTO = 2.2;
/** Folga do rodapé "TOTAL Z peças" na última página. */
const ALTURA_RODAPE = 12;

const fmt = (n: number) => Number(n || 0).toLocaleString("pt-BR");

type Bloco = { linha: PickingMisto; nome: string[]; altura: number };

function alturaDoCabecalho(consulta: boolean): number {
  // título (M+6) + linha + resumo (6) + consulta (4)
  return M + 6 + 3 + 6 + (consulta ? 4 : 0) + 1;
}

function quebrarNome(pdf: jsPDF, nome: string): string[] {
  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(PT_NOME);
  const partes = pdf.splitTextToSize(nome || "—", LARGURA_NOME) as string[];
  if (partes.length <= 2) return partes.length > 0 ? partes : ["—"];
  let segunda = partes.slice(1).join(" ");
  while (segunda.length > 1 && pdf.getTextWidth(`${segunda}…`) > LARGURA_NOME) segunda = segunda.slice(0, -1);
  return [partes[0] ?? "", `${segunda}…`];
}

/** Quebra os produtos em etiquetas, medindo antes de desenhar. */
function paginar(pdf: jsPDF, doc: MistosDoc): Bloco[][] {
  const topo = alturaDoCabecalho(!!doc.consulta);
  const limite = H - M;
  const paginas: Bloco[][] = [];
  let atual: Bloco[] = [];
  let y = topo;
  for (const linha of doc.linhas) {
    const nome = quebrarNome(pdf, linha.produto);
    const altura = PAD_PRODUTO + nome.length * LINHA_NOME + 1.5 + ALTURA_CAIXA + PAD_PRODUTO;
    if (atual.length > 0 && y + altura > limite) {
      paginas.push(atual);
      atual = [];
      y = topo;
    }
    atual.push({ linha, nome, altura });
    y += altura;
  }
  // O rodapé "TOTAL" precisa caber na última: se não cabe, o último produto vai pra outra.
  if (atual.length > 1 && y + ALTURA_RODAPE > limite) {
    const ultimo = atual.pop()!;
    paginas.push(atual);
    atual = [ultimo];
  }
  paginas.push(atual);
  return paginas;
}

/** Gera o PDF da etiqueta e devolve o base64 (sem prefixo data:). */
export function gerarMistosPdf(doc: MistosDoc): string {
  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: [W, H] });
  const paginas = paginar(pdf, doc);
  const tamanhos = tamanhosForaDaFila(doc.fila);
  const totalFora = doc.linhas.reduce((a, l) => a + l.total, 0);
  const agora = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const dataHora = `${p2(agora.getDate())}/${p2(agora.getMonth() + 1)}, ${p2(agora.getHours())}:${p2(agora.getMinutes())}`;

  const texto = (s: string, x: number, y: number, size: number, style: "normal" | "bold" = "normal", align: "left" | "right" = "left") => {
    pdf.setFont("helvetica", style);
    pdf.setFontSize(size);
    pdf.text(s, x, y, { align });
  };
  pdf.setTextColor(0);
  pdf.setDrawColor(0);

  paginas.forEach((blocos, i) => {
    if (i > 0) pdf.addPage([W, H], "portrait");
    const sufixo = paginas.length > 1 ? ` (${i + 1}/${paginas.length})` : "";
    let y = M + 5;
    texto(`MISTOS · FILA ${doc.fila}${sufixo}`, M, y, 16, "bold");
    texto(dataHora, W - M, y, 10, "normal", "right");
    y += 2.5;
    pdf.setLineWidth(0.9);
    pdf.line(M, y, W - M, y);
    y += 5;
    texto(`${fmt(doc.pedidos)} pedidos · ${fmt(totalFora)} peças fora do ${doc.fila}`, M, y, 11, "bold");
    if (doc.consulta) {
      y += 4;
      texto("CONSULTA — não reserva pedidos", M, y, 9);
    }
    y += 1;

    for (const b of blocos) {
      y += PAD_PRODUTO;
      const topoBloco = y;
      pdf.setLineWidth(0.7);
      pdf.setLineDashPattern([], 0);
      pdf.rect(M, y + 0.6, LADO_QUADRADO, LADO_QUADRADO, "S");
      b.nome.forEach((n, k) => texto(n, M + LADO_QUADRADO + 2, y + 4 + k * LINHA_NOME, PT_NOME, "bold"));
      texto(fmt(b.linha.total), W - M, y + 5.5, PT_TOTAL, "bold", "right");
      y = topoBloco + b.nome.length * LINHA_NOME + 1.5;

      // Grade: 4 caixas ocupando 85% da largura útil, gap 2 mm.
      const gap = 2;
      const largura = (LARGURA_UTIL * 0.85 - gap * (tamanhos.length - 1)) / tamanhos.length;
      tamanhos.forEach((t, k) => {
        const x = M + k * (largura + gap);
        const n = b.linha.grade[t] ?? 0;
        pdf.setLineWidth(0.7);
        pdf.setLineDashPattern(n ? [] : [0.8, 0.8], 0);
        pdf.rect(x, y, largura, ALTURA_CAIXA, "S");
        pdf.setLineDashPattern([], 0);
        texto(t, x + 1.6, y + 6.6, PT_TAM, "normal");
        texto(fmt(n), x + largura - 1.4, y + 7, PT_NUM, "bold", "right");
      });
      y += ALTURA_CAIXA + PAD_PRODUTO;
      pdf.setLineWidth(0.5);
      pdf.line(M, y - 0.6, W - M, y - 0.6);
    }

    if (i === paginas.length - 1) {
      const yr = H - M - 2;
      pdf.setLineWidth(0.9);
      pdf.line(M, yr - 7, W - M, yr - 7);
      texto("TOTAL", M, yr, 13, "bold");
      texto(`${fmt(totalFora)} peças`, W - M, yr, PT_NUM, "bold", "right");
    }
  });

  return pdf.output("datauristring").split(",")[1] ?? "";
}

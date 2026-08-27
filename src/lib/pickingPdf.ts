// Folha do Picking Geral — a lista que a separadora leva pra prateleira.
//
// Sai em ETIQUETA 100×150 mm (retrato), NÃO em A4: as bancadas só têm a
// impressora térmica de etiquetas, e o A4 chegava lá encolhido dentro de uma
// etiqueta de 10×15 cm, ilegível (campo, 27/08). Uma seção de tamanho por
// etiqueta; quando não cabe, continua na próxima ("P (2/3)").
//
// Vai em base64 pra impressão SILENCIOSA (src/lib/printer.ts), o mesmo caminho
// da etiqueta J&T, da DANFE e do teste de impressão — window.print() dentro do
// WebView abriria diálogo do Windows, que é justamente o que a mesa não tem
// como responder.
//
// O EAN não entra na etiqueta: a operadora pega pelo NOME na prateleira e o
// espaço de 10 cm vale mais em corpo de fonte (produto 11pt, quantidade 14pt)
// do que em 13 dígitos. O SKU continua na tela do Picking Geral.

import { jsPDF } from "jspdf";

export type PickingLinha = {
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
  /** Primeiro nome de quem está operando. */
  operadora: string;
  /** "Fila XG · Mistos". */
  fila: string;
  /** "Meu lote (12) · 14/08/2026". */
  escopo: string;
  /** Aviso curto no cabeçalho — hoje só "sem GG (bancada)". */
  observacao?: string | null;
  secoes: PickingSecao[];
};

/** Etiqueta 100×150 mm, margem de 4 mm (área útil 92 mm). */
const W = 100;
const H = 150;
const M = 4;
/** Abaixo disto é rodapé — nenhuma linha de produto passa daqui. */
const LIMITE_Y = H - 7.5;
const LARGURA_QTD = 14;
const LARGURA_NOME = W - 2 * M - LARGURA_QTD - 3;

/** Corpo das fontes (pt) — o mínimo pra ler de pé, na bancada. */
const PT_TAMANHO = 22;
const PT_PRODUTO = 11;
const PT_QTD = 14;

/** Alturas de linha (mm) — nome de uma linha e nome quebrado em duas. */
const ALTURA_1 = 6.8;
const ALTURA_2 = 11.4;

type Linha = {
  /** Nome já quebrado (no máximo 2 linhas, a 2ª com reticências se sobrar). */
  nome: string[];
  qtd: number;
  altura: number;
};

type Pagina = {
  secao: PickingSecao;
  /** 1-based dentro da seção, e quantas etiquetas a seção ocupa. */
  indice: number;
  total: number;
  linhas: Linha[];
};

/** Gera o PDF do picking e devolve o base64 (sem prefixo data:). */
export function gerarPickingPdf(doc: PickingDoc): string {
  const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: [W, H] });
  const dataHora = new Date().toLocaleString("pt-BR");
  const paginas = paginar(pdf, doc);

  paginas.forEach((pagina, i) => {
    if (i > 0) pdf.addPage([W, H], "portrait");
    desenhar(pdf, doc, pagina, i + 1, paginas.length, dataHora);
  });

  return pdf.output("datauristring").split(",")[1] ?? "";
}

/**
 * Quebra as seções em etiquetas. Mede antes de desenhar (a mesma instância do
 * jsPDF serve pra medir — `splitTextToSize` não escreve nada) porque o rodapé
 * precisa do total de páginas e o título da seção do "(2/3)".
 */
function paginar(pdf: jsPDF, doc: PickingDoc): Pagina[] {
  const paginas: Pagina[] = [];
  const alturaCabecalho = alturaDoCabecalho(!!doc.observacao);

  for (const secao of doc.secoes) {
    const linhas = secao.linhas.map<Linha>((l) => {
      const nome = quebrarNome(pdf, l.produto);
      return { nome, qtd: l.qtd, altura: nome.length > 1 ? ALTURA_2 : ALTURA_1 };
    });

    const daSecao: Linha[][] = [];
    let atual: Linha[] = [];
    let y = alturaCabecalho;
    for (const linha of linhas) {
      if (atual.length > 0 && y + linha.altura > LIMITE_Y) {
        daSecao.push(atual);
        atual = [];
        y = alturaCabecalho;
      }
      atual.push(linha);
      y += linha.altura;
    }
    // Seção vazia ainda rende uma etiqueta: a operadora precisa ver o zero.
    daSecao.push(atual);

    daSecao.forEach((doPedaco, i) =>
      paginas.push({ secao, indice: i + 1, total: daSecao.length, linhas: doPedaco }),
    );
  }

  return paginas;
}

function desenhar(
  pdf: jsPDF,
  doc: PickingDoc,
  pagina: Pagina,
  numero: number,
  totalPaginas: number,
  dataHora: string,
): void {
  const texto = (
    s: string,
    x: number,
    y: number,
    size: number,
    style: "normal" | "bold" = "normal",
  ) => {
    pdf.setFont("helvetica", style);
    pdf.setFontSize(size);
    pdf.text(s, x, y);
  };
  const direita = (s: string, y: number, size: number, style: "normal" | "bold" = "normal") => {
    pdf.setFont("helvetica", style);
    pdf.setFontSize(size);
    pdf.text(s, W - M, y, { align: "right" });
  };
  const regua = (y: number, forte = false) => {
    pdf.setLineWidth(forte ? 0.4 : 0.15);
    pdf.line(M, y, W - M, y);
  };

  // Cabeçalho — repetido em TODA etiqueta: elas são destacadas da bobina e
  // andam separadas pela fábrica, então nenhuma pode chegar anônima.
  let y = M + 4;
  texto(`Picking · ${doc.operadora}`, M, y, 9.5, "bold");
  direita(doc.fila, y, 7.5);
  y += 3.8;
  texto(`${doc.escopo} · ${dataHora}`, M, y, 7);
  y += 3.4;
  if (doc.observacao) {
    texto(doc.observacao, M, y, 7, "bold");
    y += 3.4;
  }
  regua(y - 1.2, true);

  // Título da seção: o TAMANHO é o que ela procura de longe.
  y += 8.5;
  const sufixo = pagina.total > 1 ? ` (${pagina.indice}/${pagina.total})` : "";
  texto(`${pagina.secao.tamanho}${sufixo}`, M, y, PT_TAMANHO, "bold");
  direita(`${pagina.secao.itens} itens`, y - 3.4, 8.5, "bold");
  direita(`${pagina.secao.produtos} produtos · ${pagina.secao.pedidos} pedidos`, y, 6.5);
  y += 3;
  regua(y, true);

  y += 4.2;
  texto("PRODUTO", M, y, 6.5, "bold");
  direita("QTD", y, 6.5, "bold");
  y += 1.5;
  regua(y);
  y += 5;

  for (const linha of pagina.linhas) {
    texto(linha.nome[0] ?? "", M, y, PT_PRODUTO);
    if (linha.nome[1]) texto(linha.nome[1], M, y + 4.6, PT_PRODUTO);
    direita(String(linha.qtd), y + (linha.nome.length > 1 ? 2.3 : 0), PT_QTD, "bold");
    y += linha.altura;
    pdf.setDrawColor(205);
    regua(y - 2.2);
    pdf.setDrawColor(0);
  }

  if (pagina.linhas.length === 0) {
    texto("Nada nesta seção.", M, y, 9);
  }

  texto(pagina.secao.tamanho, M, H - 3.5, 6.5);
  direita(`Página ${numero}/${totalPaginas}`, H - 3.5, 6.5);
}

/** Altura (mm) até a baseline da 1ª linha de produto — igual em toda etiqueta. */
function alturaDoCabecalho(temObservacao: boolean): number {
  return M + 4 + 3.8 + 3.4 + (temObservacao ? 3.4 : 0) + 8.5 + 3 + 4.2 + 1.5 + 5;
}

/** Quebra o nome em no máximo 2 linhas na largura da coluna PRODUTO. */
function quebrarNome(pdf: jsPDF, nome: string): string[] {
  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(PT_PRODUTO);
  const partes = pdf.splitTextToSize(nome || "—", LARGURA_NOME) as string[];
  if (partes.length <= 2) return partes.length > 0 ? partes : ["—"];
  let segunda = partes.slice(1).join(" ");
  while (segunda.length > 1 && pdf.getTextWidth(`${segunda}…`) > LARGURA_NOME) {
    segunda = segunda.slice(0, -1);
  }
  return [partes[0] ?? "", `${segunda}…`];
}

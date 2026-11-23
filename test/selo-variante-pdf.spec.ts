// Selo de variante nas etiquetas térmicas: caixa preta cheia só quando há variante.
import { describe, expect, it } from "vitest";
import { gerarMistosPdf } from "../src/lib/mistosPdf";
import { gerarPickingPdf } from "../src/lib/pickingPdf";

const conteudo = (b64: string) => Buffer.from(b64, "base64").toString("latin1");
// jsPDF emite o preenchimento de retângulo como "re\nf" (stroke seria "re\nS").
const preenchidos = (b64: string) => (conteudo(b64).match(/re\nf/g) ?? []).length;

const mistos = (produto: string) =>
  gerarMistosPdf({
    fila: "M",
    pedidos: 1,
    linhas: [{ produto, imagemUrl: null, grade: { P: 1 }, total: 1, pedidos: 1 }],
  });
const picking = (produto: string) =>
  gerarPickingPdf({
    operadora: "Ana",
    fila: "Fila M",
    escopo: "Meu lote",
    secoes: [{ tamanho: "P", produtos: 1, itens: 1, pedidos: 1, linhas: [{ produto, qtd: 1 }] }],
  });

describe("selo de variante nos PDFs", () => {
  it("mistos: com variante há uma caixa preenchida a mais", () => {
    expect(preenchidos(mistos("Oversized Freaky Season - Ganley 2"))).toBeGreaterThan(
      preenchidos(mistos("Oversized Freaky Season - Rux")),
    );
  });
  it("picking: com variante há uma caixa preenchida a mais", () => {
    expect(preenchidos(picking("Oversized Freaky Season - Ganley 1"))).toBeGreaterThan(
      preenchidos(picking("Oversized Freaky Season - Rux")),
    );
  });
});

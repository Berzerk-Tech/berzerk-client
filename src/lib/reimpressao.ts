// Impressão e REIMPRESSÃO do documento de expedição de um pedido.
//
// Regra dura da mesa, portada do legado (`minhacontaberzerk`,
// `pages/ImpressaoNF.tsx` + `utils/printJtLabel.ts`/`utils/printDanfe.ts`):
//
//   **UM pedido = UM documento = UMA página 100×150.**
//
// Qual documento sai depende da CONTA TINY, nunca os dois:
//   - `JT` → etiqueta da transportadora (o PDF que a J&T manda);
//   - `FM` → DANFE simplificada, que É a etiqueta desses pedidos.
//
// Isso não é preferência estética: a máquina de embalagem solta UM SACO POR
// ETIQUETA IMPRESSA. Duas páginas = dois sacos. Era exatamente o que estava
// acontecendo em produção — a mesa mandava etiqueta J&T *e* DANFE como dois
// jobs pra mesma impressora térmica, e todo pedido JT saía com um saco a mais.
//
// A reimpressão pelo histórico usa o MESMO caminho e a MESMA escolha por
// conta, e NUNCA muda status: só busca o documento (`documentos`, que não olha
// status) e manda pra impressora. O `registrarReimpressao` é trilha, não
// transição de negócio.

import { gerarDanfeSimplificadaPdf } from "./danfe";
import { printEtiquetaUnica } from "./printer";
import { getLabelPrinter } from "../services/printerConfig";
import {
  getDocumentos,
  registrarReimpressao,
  type DocumentoReimpressao,
  type Documentos,
} from "../services/expedicao";

export type ReimpressaoResultado = {
  ok: boolean;
  /** Mensagem pronta pro banner — sempre preenchida. */
  mensagem: string;
};

/**
 * Documento de expedição: SEMPRE a etiqueta da J&T, em qualquer conta.
 *
 * A regra antiga (JT → etiqueta, FM → DANFE) vinha do legado, de quando a
 * conta FM despachava pela FM Transportes e a DANFE simplificada era a
 * etiqueta desses pacotes. Hoje a conta FM também sai pela J&T (Frenet) e
 * a etiqueta existe pra ela — em 03/09, 1.030 dos 1.032 pedidos FM do dia
 * tinham etiqueta no Nexus e a mesa imprimia DANFE em todos. Decisão do
 * Leonardo (03/09): etiqueta J&T sempre; sem etiqueta, a mesa não expede
 * (`etiqueta_ausente`), não cai pra DANFE. O parâmetro fica só pra não
 * mexer nas chamadas.
 */
export function documentoDaConta(_tinyAccount: string): DocumentoReimpressao {
  return "etiqueta";
}

/** Rótulo do botão/aviso — segue a escolha por conta. */
export function rotuloDocumento(documento: DocumentoReimpressao): string {
  return documento === "etiqueta" ? "etiqueta J&T" : "DANFE";
}

/**
 * Manda o documento de expedição do pedido pra impressora de etiquetas —
 * UMA página, escalada pro papel. Não busca nada duas vezes: quem já tem os
 * `documentos` em mãos (a mesa) passa em `docs`.
 *
 * Devolve `ok: false` com mensagem pronta quando o documento não existe — o
 * chamador decide se isso trava o fluxo (mesa em modo oficial) ou só avisa
 * (reimpressão).
 */
export async function imprimirDocumentoDoPedido(
  order: { id: string; numero: string | null; tinyAccount: string },
  origem: "historico" | "ja_expedido" | "mesa",
  docs?: Documentos,
): Promise<ReimpressaoResultado> {
  const documento = documentoDaConta(order.tinyAccount);
  const rotulo = rotuloDocumento(documento);
  const alvo = `#${order.numero ?? order.id.slice(0, 8)}`;
  const segundaVia = origem !== "mesa";
  const sufixo = segundaVia ? " (2a via)" : "";

  try {
    const d = docs ?? (await getDocumentos(order.id));

    let base64: string;
    let formato: "pdf" | "png";
    if (documento === "etiqueta") {
      if (!d.etiqueta) {
        return { ok: false, mensagem: `${alvo} não tem etiqueta J&T disponível.` };
      }
      base64 = d.etiqueta.base64;
      formato = d.etiqueta.formato;
    } else {
      if (!d.danfe) return { ok: false, mensagem: `${alvo} não tem nota fiscal.` };
      const pdf = gerarDanfeSimplificadaPdf(d.danfe);
      if (!pdf) return { ok: false, mensagem: `Não foi possível gerar a DANFE de ${alvo}.` };
      base64 = pdf;
      formato = "pdf";
    }

    const out = await printEtiquetaUnica(base64, formato, {
      jobName: `${documento === "etiqueta" ? "JT" : "DANFE"} ${order.numero ?? order.id}${sufixo}`,
      printer: getLabelPrinter(),
    });
    if (!out.ok) throw new Error(out.message ?? "impressão falhou");

    // Trilha só DEPOIS do papel sair, e sem poder derrubar o resultado.
    if (segundaVia) await registrarReimpressao(order.id, documento, origem);
    return {
      ok: true,
      mensagem: segundaVia
        ? `2a via da ${rotulo} de ${alvo} enviada pra impressora.`
        : `${rotulo} de ${alvo} enviada pra impressora.`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, mensagem: `Falha ao imprimir a ${rotulo} de ${alvo}: ${msg}` };
  }
}

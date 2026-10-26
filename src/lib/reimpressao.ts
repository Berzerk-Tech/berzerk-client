// Impressão e REIMPRESSÃO do documento de expedição de um pedido.
//
// Regra dura da mesa, portada do legado (`minhacontaberzerk`,
// `pages/ImpressaoNF.tsx` + `utils/printJtLabel.ts`/`utils/printDanfe.ts`):
//
//   **UM pedido = UM documento = UMA página 100×150.**
//
// Qual documento sai depende do CANAL do pedido (`documentoDoPedido`), nunca
// os dois: e-commerce → etiqueta da J&T; Mercado Livre → etiqueta do
// Mercado Envios (PDF pronto da API) ou, sem ela e com a trava do servidor
// desligada, DANFE simplificada.
//
// Isso não é preferência estética: a máquina de embalagem solta UM SACO POR
// ETIQUETA IMPRESSA. Duas páginas = dois sacos. Era exatamente o que estava
// acontecendo em produção — a mesa mandava etiqueta J&T *e* DANFE como dois
// jobs pra mesma impressora térmica, e todo pedido JT saía com um saco a mais.
//
// A reimpressão pelo histórico usa o MESMO caminho e a MESMA escolha por
// canal, e NUNCA muda status: só busca o documento (`documentos`, que não olha
// status) e manda pra impressora. O `registrarReimpressao` é trilha, não
// transição de negócio.

import { gerarDanfeSimplificadaPdf } from "./danfe";
import { printEtiquetaUnica } from "./printer";
import { getLabelPrinter } from "../services/printerConfig";
import {
  getDocumentos,
  obterEtiquetaMl,
  type EtiquetaMlResultado,
  registrarReimpressao,
  type DocumentoReimpressao,
  type Documentos,
} from "../services/expedicao";

export type ReimpressaoResultado = {
  ok: boolean;
  /** Mensagem pronta pro banner — sempre preenchida. */
  mensagem: string;
  /** `etiqueta_ml_indisponivel`: pedido ML sem etiqueta do Mercado Envios com a trava do servidor ligada. */
  codigo?: "etiqueta_ml_indisponivel";
  /** Aviso não bloqueante (ex.: ML saiu com a DANFE porque a etiqueta não veio e a trava está desligada). */
  aviso?: string;
};

const MSG_TINY_DEMOROU = "Tiny demorou, bipe de novo.";

/** Um POST por pedido por vez: bip repetido reaproveita a busca em voo. */
const buscasMlEmVoo = new Map<string, Promise<EtiquetaMlResultado>>();
function buscarEtiquetaMl(orderId: string): Promise<EtiquetaMlResultado> {
  let p = buscasMlEmVoo.get(orderId);
  if (!p) {
    p = obterEtiquetaMl(orderId)
      .catch((): EtiquetaMlResultado => ({ ok: false, erro: { codigo: "tiny_demorou", mensagem: MSG_TINY_DEMOROU } }))
      .finally(() => buscasMlEmVoo.delete(orderId));
    buscasMlEmVoo.set(orderId, p);
  }
  return p;
}

const MSG_ETIQUETA_ML_INDISPONIVEL =
  "Etiqueta do Mercado Livre ainda não disponível no Tiny. Avise o supervisor para enviar o pedido para expedição no Tiny e bipe de novo.";

/** Pedido com canal (nexus 19/10). Ausente = e-commerce. */
export type PedidoComCanal = { canal?: "ecommerce" | "mercado_livre" };

/**
 * Documento de expedição, pelo CANAL do pedido (nunca pela conta Tiny):
 *   - e-commerce → etiqueta da J&T, em qualquer conta. A regra antiga
 *     (JT → etiqueta, FM → DANFE) vinha do legado, de quando a conta FM
 *     despachava pela FM Transportes; hoje a FM também sai pela J&T e, sem
 *     etiqueta, a mesa não expede (`etiqueta_ausente`) — decisão de 03/09;
 *   - Mercado Livre → etiqueta do Mercado Envios quando a API a entrega
 *     (`docs.etiquetaMl`, emitida pelo Tiny); sem ela e com a trava do
 *     servidor desligada, DANFE simplificada (20/10, como o legado fazia pra
 *     pedido sem etiqueta J&T). `documentoDoPedido` devolve "danfe" pro canal
 *     e `imprimirDocumentoDoPedido` troca pela etiqueta ML quando existe.
 */
export function documentoDoPedido(pedido: PedidoComCanal): DocumentoReimpressao {
  return pedido.canal === "mercado_livre" ? "danfe" : "etiqueta";
}

/** Rótulo do botão/aviso — segue a escolha por canal. */
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
  order: { id: string; numero: string | null } & PedidoComCanal,
  origem: "historico" | "ja_expedido" | "mesa",
  docs?: Documentos,
  /** Chamado antes do POST que busca a etiqueta ML no Tiny (pode levar ~25 s) — a mesa mostra "buscando". */
  aoBuscarEtiquetaMl?: () => void,
): Promise<ReimpressaoResultado> {
  const documento = documentoDoPedido(order);
  const rotulo = rotuloDocumento(documento);
  const alvo = `#${order.numero ?? order.id.slice(0, 8)}`;
  const segundaVia = origem !== "mesa";
  const sufixo = segundaVia ? " (2a via)" : "";

  try {
    const d = { ...(docs ?? (await getDocumentos(order.id))) };

    // `GET documentos` só lê o cache: sem etiqueta nele, quem busca no Tiny é o POST.
    // API velha (sem o campo `etiquetaMl`) segue direto pra DANFE.
    if (documento === "danfe" && "etiquetaMl" in d && !d.etiquetaMl?.base64) {
      aoBuscarEtiquetaMl?.();
      const res = await buscarEtiquetaMl(order.id);
      if (res.ok && res.etiqueta?.base64) {
        d.etiquetaMl = res.etiqueta;
        d.etiquetaMlErro = null;
      } else if (!res.ok) {
        d.etiquetaMl = null;
        d.etiquetaMlErro = res.erro;
      }
    }

    let base64: string;
    let formato: "pdf" | "png";
    let aviso: string | undefined;
    let etiquetaMl = false;
    if (documento === "danfe" && d.etiquetaMl?.base64) {
      // Mercado Livre com etiqueta do Mercado Envios: é ela o documento oficial.
      base64 = d.etiquetaMl.base64;
      formato = d.etiquetaMl.formato;
      etiquetaMl = true;
    } else if (documento === "danfe" && d.etiquetaMlObrigatoria === true) {
      return {
        ok: false,
        codigo: "etiqueta_ml_indisponivel",
        mensagem: `${alvo}: ${d.etiquetaMlErro?.mensagem?.trim() || MSG_ETIQUETA_ML_INDISPONIVEL}`,
      };
    } else if (documento === "etiqueta") {
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
      // Sem etiqueta e sem trava: segue com a DANFE, mas avisa (o campo só existe em API nova).
      if (!d.etiquetaMl?.base64 && ("etiquetaMl" in d || d.etiquetaMlErro)) {
        aviso = `Etiqueta do Mercado Envios não veio${d.etiquetaMlErro?.mensagem ? ` (${d.etiquetaMlErro.mensagem})` : ""}. Saiu a DANFE simplificada.`;
      }
    }

    const out = await printEtiquetaUnica(base64, formato, {
      jobName: `${etiquetaMl ? "ML" : documento === "etiqueta" ? "JT" : "DANFE"} ${order.numero ?? order.id}${sufixo}`,
      printer: getLabelPrinter(),
    });
    if (!out.ok) throw new Error(out.message ?? "impressão falhou");

    // Trilha só DEPOIS do papel sair, e sem poder derrubar o resultado.
    if (segundaVia) await registrarReimpressao(order.id, etiquetaMl ? "etiqueta_ml" : documento, origem);
    const rot = etiquetaMl ? "etiqueta do Mercado Livre" : rotulo;
    const base = segundaVia
      ? `2a via da ${rot} de ${alvo} enviada pra impressora.`
      : `${rot} de ${alvo} enviada pra impressora.`;
    // Fora da mesa não há notice próprio: o aviso vai junto da mensagem.
    return {
      ok: true,
      mensagem: aviso && segundaVia ? `${base} ${aviso}` : base,
      ...(aviso && !segundaVia ? { aviso } : {}),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, mensagem: `Falha ao imprimir a ${rotulo} de ${alvo}: ${msg}` };
  }
}

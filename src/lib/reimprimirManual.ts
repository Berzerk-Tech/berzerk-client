// Reimpressão das etiquetas da impressão manual (Únicos): puro (a sequência de folhas) + a execução.
// Reimprimir = buscar os documentos de novo e mandar pra impressora. NUNCA chama concluir/reservar/liberar
// nem muda status (`getDocumentos` é GET de leitura; `imprimirDocumentoDoPedido` com origem "historico"
// só registra trilha de 2ª via).

import { gerarCapaBumpPdf } from "./capaTamanhoPdf";
import { printEtiquetaUnica } from "./printer";
import { sequenciaDaPilha, type FolhaPilha } from "./pilhaManual";
import { imprimirDocumentoDoPedido } from "./reimpressao";
import { isExpedicaoSimulacao } from "../services/expedicaoMode";
import { getLabelPrinter } from "../services/printerConfig";
import type { ImpressaoManualPedido } from "../services/expedicao";

export type ItemReimpressao = {
  orderId: string;
  numero: string | null;
  cliente: string | null;
  tracking: string | null;
  comBump: boolean;
  bump?: { produtoNome: string; tamanho: string | null } | null;
  /** Tamanho do grupo (usado só na capa de bump). */
  tamanho?: string;
  estampa?: string;
  canal?: "ecommerce" | "mercado_livre";
};

export type EstadoLinha = { estado: "imprimindo" } | { estado: "ok" } | { estado: "erro"; mensagem: string };

/** Sequência de folhas a reimprimir: capa de bump (se o pedido tinha) antes do 1º do bloco e a etiqueta; sem capa do tamanho. */
export function folhasDaReimpressao(itens: readonly ItemReimpressao[]): Exclude<FolhaPilha, { tipo: "capa" }>[] {
  const pedidos: ImpressaoManualPedido[] = itens.map((i) => ({
    orderId: i.orderId,
    numero: i.numero,
    cliente: i.cliente,
    tracking: i.tracking,
    emitidoEm: null,
    comBump: i.comBump,
    bump: i.bump ?? null,
  }));
  return sequenciaDaPilha(pedidos).filter((f): f is Exclude<FolhaPilha, { tipo: "capa" }> => f.tipo !== "capa");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Reimprime os itens em sequência. `aoMudar` recebe o estado de cada pedido. Um pedido com erro não
 * derruba os outros; devolve quantos saíram.
 */
export async function reimprimirItens(itens: readonly ItemReimpressao[], aoMudar: (orderId: string, e: EstadoLinha) => void): Promise<number> {
  const porId = new Map(itens.map((i) => [i.orderId, i]));
  const sim = isExpedicaoSimulacao();
  let ok = 0;
  const falhou = new Set<string>();
  for (const f of folhasDaReimpressao(itens)) {
    if (f.tipo === "capaBump") {
      // Capa do bloco: falhar aqui não segura as etiquetas.
      const primeiro = itens.find((i) => i.numero && f.numeros.includes(i.numero));
      if (!sim) {
        try {
          const folha = gerarCapaBumpPdf({ produtoNome: f.produtoNome, tamanho: f.tamanho, pedidos: f.pedidos, numeros: f.numeros, estampa: primeiro?.estampa ?? "", tamanhoGrupo: primeiro?.tamanho ?? "" });
          await printEtiquetaUnica(folha, "pdf", { jobName: `ORDER BUMP ${f.tamanho ?? ""} (2a via)`, printer: getLabelPrinter() });
        } catch {
          /* segue sem a capa do bloco */
        }
      }
      continue;
    }
    const item = porId.get(f.pedido.orderId);
    if (!item || falhou.has(item.orderId)) continue;
    aoMudar(item.orderId, { estado: "imprimindo" });
    if (sim) {
      await sleep(400);
      aoMudar(item.orderId, { estado: "ok" });
      ok += 1;
      continue;
    }
    try {
      const r = await imprimirDocumentoDoPedido({ id: item.orderId, numero: item.numero, canal: item.canal }, "historico");
      if (r.ok) {
        aoMudar(item.orderId, { estado: "ok" });
        ok += 1;
      } else {
        falhou.add(item.orderId);
        aoMudar(item.orderId, { estado: "erro", mensagem: r.mensagem });
      }
    } catch (e) {
      falhou.add(item.orderId);
      aoMudar(item.orderId, { estado: "erro", mensagem: e instanceof Error ? e.message : String(e) });
    }
  }
  return ok;
}

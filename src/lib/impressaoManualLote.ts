// Impressão manual do tamanho inteiro (Únicos): máquina de estados PURA do lote
// (sem tela, sem rede) + a rede de segurança em localStorage. A tela só chama
// `proximoPedido`/`registrar*` e decide o que fazer com o resultado.

import type { ImpressaoManualPedido } from "../services/expedicao";

export type MotivoPulo = "documento" | "impressao" | "etiqueta_ausente";

export type Pulado = { orderId: string; numero: string | null; motivo: string };
export type ErroConclusao = { orderId: string; numero: string | null; codigo: string | null; mensagem: string };

export type LoteManual = {
  loteId: string;
  pedidos: ImpressaoManualPedido[];
  /** orderIds concluídos (expedidos). */
  concluidos: string[];
  pulados: Pulado[];
  /** Falha no `concluir` que não foi etiqueta_ausente: o papel saiu, o pedido segue reservado e vai pra `liberar`. */
  errosConclusao: ErroConclusao[];
  pausaPedida: boolean;
  pausado: boolean;
  /** Pausa forçada por 403/erros de rede repetidos (mensagem pro operador). */
  interrompido: string | null;
  encerrado: boolean;
  falhasRedeSeguidas: number;
};

export const LIMITE_FALHAS_REDE = 3;

export function novoLote(loteId: string, pedidos: ImpressaoManualPedido[]): LoteManual {
  return {
    loteId,
    pedidos,
    concluidos: [],
    pulados: [],
    errosConclusao: [],
    pausaPedida: false,
    pausado: false,
    interrompido: null,
    encerrado: false,
    falhasRedeSeguidas: 0,
  };
}

function processados(l: LoteManual): Set<string> {
  return new Set([...l.concluidos, ...l.pulados.map((p) => p.orderId), ...l.errosConclusao.map((p) => p.orderId)]);
}

/** Próximo pedido a imprimir, ou null se acabou/pausado/interrompido. */
export function proximoPedido(l: LoteManual): ImpressaoManualPedido | null {
  if (l.pausado || l.interrompido || l.encerrado) return null;
  const feitos = processados(l);
  return l.pedidos.find((p) => !feitos.has(p.orderId)) ?? null;
}

/** Posição (1-based) do pedido em curso, pra "i/N". */
export function indiceAtual(l: LoteManual): number {
  return Math.min(processados(l).size + 1, l.pedidos.length);
}

export function terminou(l: LoteManual): boolean {
  return processados(l).size >= l.pedidos.length;
}

export function registrarConcluido(l: LoteManual, orderId: string): LoteManual {
  return { ...l, concluidos: [...l.concluidos, orderId], falhasRedeSeguidas: 0 };
}

export function registrarPulo(l: LoteManual, p: ImpressaoManualPedido, motivo: string): LoteManual {
  return { ...l, pulados: [...l.pulados, { orderId: p.orderId, numero: p.numero, motivo }] };
}

/** Erro do `concluir`. 403 e rede repetida pausam o lote; `etiqueta_ausente` conta como pulado. */
export function registrarErroConclusao(
  l: LoteManual,
  p: ImpressaoManualPedido,
  erro: { status?: number; codigo?: string | null; mensagem: string; rede?: boolean },
): LoteManual {
  if (erro.codigo === "etiqueta_ausente") return registrarPulo({ ...l, falhasRedeSeguidas: 0 }, p, "etiqueta ausente (devolvido à fila)");
  const falhas = erro.rede ? l.falhasRedeSeguidas + 1 : 0;
  const base: LoteManual = {
    ...l,
    falhasRedeSeguidas: falhas,
    errosConclusao: [...l.errosConclusao, { orderId: p.orderId, numero: p.numero, codigo: erro.codigo ?? null, mensagem: erro.mensagem }],
  };
  if (erro.status === 403) return { ...base, interrompido: "Sem permissão para a impressão manual (403). Lote pausado." };
  if (falhas >= LIMITE_FALHAS_REDE) return { ...base, interrompido: "Sem conexão com o Nexus (3 falhas seguidas). Lote pausado." };
  return base;
}

export function pedirPausa(l: LoteManual): LoteManual {
  return { ...l, pausaPedida: true };
}

/** Chamado ENTRE etiquetas: a pausa pedida passa a valer depois da etiqueta em curso. */
export function aplicarPausa(l: LoteManual): LoteManual {
  return l.pausaPedida && !l.pausado ? { ...l, pausado: true } : l;
}

export function continuar(l: LoteManual): LoteManual {
  return { ...l, pausaPedida: false, pausado: false, interrompido: null, falhasRedeSeguidas: 0 };
}

export function encerrar(l: LoteManual): LoteManual {
  return { ...l, encerrado: true };
}

/** Reservados que não foram expedidos: vão pro `liberar`. */
export function paraLiberar(l: LoteManual): string[] {
  const feitos = new Set(l.concluidos);
  return l.pedidos.map((p) => p.orderId).filter((id) => !feitos.has(id));
}

export type ResumoLote = {
  total: number;
  expedidos: number;
  pulados: Pulado[];
  errosConclusao: ErroConclusao[];
  naoImpressos: number;
};

export function resumo(l: LoteManual): ResumoLote {
  const feitos = processados(l);
  return {
    total: l.pedidos.length,
    expedidos: l.concluidos.length,
    pulados: l.pulados,
    errosConclusao: l.errosConclusao,
    naoImpressos: l.pedidos.filter((p) => !feitos.has(p.orderId)).length,
  };
}

export function comBump(l: LoteManual): number {
  return l.pedidos.filter((p) => p.comBump).length;
}

// --- Rede de segurança (app fechado no meio) --------------------------------

const KEY = "berzerk_unicos_impressao_manual_lote_v1";

export type LotePersistido = { loteId: string; orderIds: string[] };

export function salvarLoteEmCurso(l: LoteManual): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ loteId: l.loteId, orderIds: paraLiberar(l) } satisfies LotePersistido));
  } catch {
    /* ignore */
  }
}

export function lerLoteEmCurso(): LotePersistido | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<LotePersistido>;
    if (typeof v.loteId !== "string" || !Array.isArray(v.orderIds)) return null;
    return { loteId: v.loteId, orderIds: v.orderIds.filter((x): x is string => typeof x === "string") };
  } catch {
    return null;
  }
}

export function limparLoteEmCurso(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

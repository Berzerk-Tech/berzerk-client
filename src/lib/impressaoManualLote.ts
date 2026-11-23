// Impressão manual do tamanho inteiro (Únicos): máquina de estados PURA do lote
// (sem tela, sem rede) + a rede de segurança em localStorage. A tela só chama
// `proximoPedido`/`registrar*` e decide o que fazer com o resultado.

import type { ImpressaoManualPedido } from "../services/expedicao";
import { compararTamanhos } from "./tamanhos";

export type MotivoPulo = "documento" | "impressao" | "etiqueta_ausente";

/** Pedido do lote: o da reserva + de qual reserva (`loteId`) e de qual tamanho veio (modo grade toda). */
export type PedidoDoLote = ImpressaoManualPedido & { loteId?: string; tamanho?: string };

export type Pulado = { orderId: string; numero: string | null; motivo: string };
export type ErroConclusao = { orderId: string; numero: string | null; codigo: string | null; mensagem: string };

export type LoteManual = {
  /** Id da 1ª reserva. Na grade toda há uma reserva por tamanho (ver `loteIds` e `PedidoDoLote.loteId`). */
  loteId: string;
  /** Todas as reservas do lote lógico (uma por tamanho/rodada). */
  loteIds: string[];
  pedidos: PedidoDoLote[];
  /** Grade toda: tamanhos que voltaram vazios do `reservar` (alguém pegou antes). */
  tamanhosVazios: string[];
  /** Grade toda: pedidos que o servidor não entregou numa rodada (voltou vazia com `restantesNaFila` > 0). */
  sobrasNaFila: { tamanho: string; pedidos: number }[];
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

export function novoLote(loteId: string, pedidos: ImpressaoManualPedido[], tamanho?: string): LoteManual {
  return {
    loteId,
    loteIds: loteId ? [loteId] : [],
    pedidos: marcar(pedidos, loteId, tamanho),
    tamanhosVazios: [],
    sobrasNaFila: [],
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

function marcar(pedidos: ImpressaoManualPedido[], loteId: string, tamanho?: string): PedidoDoLote[] {
  return pedidos.map((p) => ({ ...p, ...(loteId ? { loteId } : {}), ...(tamanho ? { tamanho } : {}) }));
}

/** Lote lógico ainda sem reserva (grade toda: as reservas entram tamanho a tamanho). */
export function novoLoteVazio(): LoteManual {
  return novoLote("", []);
}

/** Junta uma reserva (um tamanho, ou outra rodada do mesmo tamanho) ao lote, no fim da fila de impressão. */
export function adicionarReserva(l: LoteManual, loteId: string, tamanho: string, pedidos: ImpressaoManualPedido[]): LoteManual {
  return {
    ...l,
    loteId: l.loteId || loteId,
    loteIds: l.loteIds.includes(loteId) ? l.loteIds : [...l.loteIds, loteId],
    pedidos: [...l.pedidos, ...marcar(pedidos, loteId, tamanho)],
  };
}

export function registrarSobraNaFila(l: LoteManual, tamanho: string, pedidos: number): LoteManual {
  return { ...l, sobrasNaFila: [...l.sobrasNaFila.filter((s) => s.tamanho !== tamanho), { tamanho, pedidos }] };
}

export function registrarTamanhoVazio(l: LoteManual, tamanho: string): LoteManual {
  return l.tamanhosVazios.includes(tamanho) ? l : { ...l, tamanhosVazios: [...l.tamanhosVazios, tamanho] };
}

function processados(l: LoteManual): Set<string> {
  return new Set([...l.concluidos, ...l.pulados.map((p) => p.orderId), ...l.errosConclusao.map((p) => p.orderId)]);
}

/** Próximo pedido a imprimir, ou null se acabou/pausado/interrompido. */
export function proximoPedido(l: LoteManual): PedidoDoLote | null {
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

export type ResumoTamanho = { tamanho: string; total: number; expedidos: number; pulados: number; erros: number; naoImpressos: number };

/** Resumo por tamanho, na ordem canônica (grade toda). Pedido sem tamanho marcado entra em "—". */
export function resumoPorTamanho(l: LoteManual): ResumoTamanho[] {
  const feitos = new Set(l.concluidos);
  const pulados = new Set(l.pulados.map((x) => x.orderId));
  const erros = new Set(l.errosConclusao.map((x) => x.orderId));
  const mapa = new Map<string, ResumoTamanho>();
  for (const p of l.pedidos) {
    const t = p.tamanho ?? "—";
    const r = mapa.get(t) ?? { tamanho: t, total: 0, expedidos: 0, pulados: 0, erros: 0, naoImpressos: 0 };
    r.total += 1;
    if (feitos.has(p.orderId)) r.expedidos += 1;
    else if (pulados.has(p.orderId)) r.pulados += 1;
    else if (erros.has(p.orderId)) r.erros += 1;
    else r.naoImpressos += 1;
    mapa.set(t, r);
  }
  return Array.from(mapa.values()).sort((a, b) => compararTamanhos(a.tamanho, b.tamanho));
}

/** Quantos pedidos do tamanho já foram processados (expedidos, pulados ou com erro). */
export function feitosDoTamanho(l: LoteManual, tamanho: string): number {
  const feitos = processados(l);
  return l.pedidos.filter((p) => p.tamanho === tamanho && feitos.has(p.orderId)).length;
}

export function comBump(l: LoteManual): number {
  return l.pedidos.filter((p) => p.comBump).length;
}

// --- Rede de segurança (app fechado no meio) --------------------------------

const KEY = "berzerk_unicos_impressao_manual_lote_v1";

/** `loteIds` é novo (grade toda); lote salvo no formato antigo não o tem e continua valendo. */
export type LotePersistido = { loteId: string; loteIds?: string[]; orderIds: string[] };

export function salvarLoteEmCurso(l: LoteManual): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ loteId: l.loteId, ...(l.loteIds.length > 1 ? { loteIds: l.loteIds } : {}), orderIds: paraLiberar(l) } satisfies LotePersistido));
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
    const loteIds = Array.isArray(v.loteIds) ? v.loteIds.filter((x): x is string => typeof x === "string") : undefined;
    return { loteId: v.loteId, ...(loteIds ? { loteIds } : {}), orderIds: v.orderIds.filter((x): x is string => typeof x === "string") };
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

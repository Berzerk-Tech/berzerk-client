// Histórico LOCAL das impressões manuais (Únicos): serve pra reimprimir quando a impressora
// falha no meio (o `concluir` já deu baixa). Funções puras + um par de leitura/gravação em
// localStorage. Só os últimos 3 dias e no máximo ~2.000 pedidos.

import { compararTamanhos } from "./tamanhos";

export const HISTORICO_KEY = "berzerk_unicos_impressao_manual_historico_v1";
export const HISTORICO_DIAS = 3;
export const HISTORICO_MAX_PEDIDOS = 2000;

export type HistoricoPedido = {
  orderId: string;
  numero: string | null;
  cliente: string | null;
  tracking: string | null;
  comBump: boolean;
  bump?: { produtoNome: string; tamanho: string | null } | null;
  tamanho: string;
};

export type HistoricoLote = {
  /** Id da 1ª reserva do lote lógico. */
  id: string;
  /** Epoch ms de quando o 1º pedido do lote foi concluído. */
  em: number;
  estampa: string;
  cor: string | null;
  /** Tamanhos impressos, na ordem canônica. */
  tamanhos: string[];
  pedidos: HistoricoPedido[];
};

export type Historico = HistoricoLote[];

const DIA_MS = 24 * 60 * 60 * 1000;

export function totalDePedidos(h: Historico): number {
  return h.reduce((n, l) => n + l.pedidos.length, 0);
}

/** Tira o que passou de 3 dias e, se ainda passar do teto, os pedidos mais antigos. Mais recente primeiro. */
export function podarHistorico(h: Historico, agora: number = Date.now()): Historico {
  const validos = h.filter((l) => l.pedidos.length > 0 && agora - l.em <= HISTORICO_DIAS * DIA_MS).sort((a, b) => b.em - a.em);
  const out: Historico = [];
  let restante = HISTORICO_MAX_PEDIDOS;
  for (const l of validos) {
    if (restante <= 0) break;
    if (l.pedidos.length <= restante) {
      out.push(l);
      restante -= l.pedidos.length;
    } else {
      // Lote maior que o espaço que sobra: fica com os pedidos mais recentes (fim da lista).
      out.push({ ...l, pedidos: l.pedidos.slice(l.pedidos.length - restante) });
      restante = 0;
    }
  }
  return out;
}

/** Registra um pedido concluído (cria o lote na 1ª vez; mesmo pedido de novo não duplica). Poda no fim. */
export function registrarConclusao(
  h: Historico,
  meta: { loteId: string; estampa: string; cor: string | null },
  pedido: HistoricoPedido,
  agora: number = Date.now(),
): Historico {
  const existente = h.find((l) => l.id === meta.loteId);
  let prox: Historico;
  if (!existente) {
    prox = [{ id: meta.loteId, em: agora, estampa: meta.estampa, cor: meta.cor, tamanhos: [pedido.tamanho], pedidos: [pedido] }, ...h];
  } else if (existente.pedidos.some((p) => p.orderId === pedido.orderId)) {
    prox = h;
  } else {
    const tamanhos = existente.tamanhos.includes(pedido.tamanho) ? existente.tamanhos : [...existente.tamanhos, pedido.tamanho].sort(compararTamanhos);
    prox = h.map((l) => (l === existente ? { ...l, tamanhos, pedidos: [...l.pedidos, pedido] } : l));
  }
  return podarHistorico(prox, agora);
}

function norm(s: string | null | undefined): string {
  return (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Busca por número do pedido, estampa, cor ou tamanho (cada palavra precisa casar). Lote que casa só por pedido traz só esses pedidos. */
export function buscarNoHistorico(h: Historico, termo: string): Historico {
  const palavras = norm(termo).split(/\s+/).filter(Boolean);
  if (palavras.length === 0) return h;
  const out: Historico = [];
  for (const l of h) {
    const alvoLote = norm([l.estampa, l.cor ?? "", ...l.tamanhos].join(" "));
    const casaLote = palavras.every((p) => alvoLote.includes(p));
    if (casaLote) {
      out.push(l);
      continue;
    }
    const pedidos = l.pedidos.filter((p) => {
      const alvo = `${alvoLote} ${norm(p.numero)} ${norm(p.tracking)} ${norm(p.cliente)}`;
      return palavras.every((w) => alvo.includes(w));
    });
    if (pedidos.length > 0) out.push({ ...l, pedidos });
  }
  return out;
}

export function lerHistorico(agora: number = Date.now()): Historico {
  try {
    const raw = localStorage.getItem(HISTORICO_KEY);
    if (!raw) return [];
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    const ok = v.filter(
      (l): l is HistoricoLote =>
        !!l && typeof l === "object" && typeof (l as HistoricoLote).id === "string" && typeof (l as HistoricoLote).em === "number" && Array.isArray((l as HistoricoLote).pedidos),
    );
    return podarHistorico(ok, agora);
  } catch {
    return [];
  }
}

export function salvarHistorico(h: Historico): void {
  try {
    localStorage.setItem(HISTORICO_KEY, JSON.stringify(h));
  } catch {
    /* ignore: cheio ou bloqueado; o histórico é só conveniência */
  }
}

/** Lê, registra, poda e grava. Nunca lança. */
export function gravarConclusao(meta: { loteId: string; estampa: string; cor: string | null }, pedido: HistoricoPedido, agora: number = Date.now()): void {
  salvarHistorico(registrarConclusao(lerHistorico(agora), meta, pedido, agora));
}

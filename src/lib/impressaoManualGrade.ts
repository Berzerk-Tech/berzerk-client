// Impressão manual da GRADE TODA (Únicos): vários tamanhos de um card (estampa × cor) num lote
// lógico só. Aqui só o que é puro: o plano (ordem canônica dos tamanhos) e os textos.

import type { UnicoTipo } from "../services/expedicao";
import { compararTamanhos } from "./tamanhos";

export type GradeTamanho = { tamanho: string; pedidos: number; /** Tipos de peça DESTE tamanho (pra capa). */ tipos?: UnicoTipo[] };

/** Tamanhos com pedido, na ordem canônica do app (PP, P, M, G, GG, XG…). Tamanho repetido soma. */
export function planoDaGrade(tamanhos: readonly GradeTamanho[]): GradeTamanho[] {
  const mapa = new Map<string, { pedidos: number; tipos: UnicoTipo[] }>();
  for (const t of tamanhos) {
    if (!(t.pedidos > 0)) continue;
    const k = t.tamanho.trim();
    const a = mapa.get(k) ?? { pedidos: 0, tipos: [] };
    a.pedidos += t.pedidos;
    if (t.tipos?.length) a.tipos.push(...t.tipos);
    mapa.set(k, a);
  }
  return Array.from(mapa, ([tamanho, v]): GradeTamanho => ({ tamanho, pedidos: v.pedidos, ...(v.tipos.length ? { tipos: v.tipos } : null) })).sort((a, b) => compararTamanhos(a.tamanho, b.tamanho));
}

export function totalDaGrade(plano: readonly GradeTamanho[]): number {
  return plano.reduce((n, t) => n + t.pedidos, 0);
}

const plural = (n: number) => `${n} pedido${n === 1 ? "" : "s"}`;

/** "P 92 · M 90 · G 38 — 250 pedidos" */
export function rotuloDaGrade(plano: readonly GradeTamanho[]): string {
  return `${plano.map((t) => `${t.tamanho} ${t.pedidos}`).join(" · ")} — ${plural(totalDaGrade(plano))}`;
}

export function rotuloPedidos(n: number): string {
  return plural(n);
}

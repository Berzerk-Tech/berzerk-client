// Impressão manual da GRADE TODA (Únicos): vários tamanhos de um card (estampa × cor) num lote
// lógico só. Aqui só o que é puro: o plano (ordem canônica dos tamanhos) e os textos.

import { compararTamanhos } from "./tamanhos";

export type GradeTamanho = { tamanho: string; pedidos: number };

/** Tamanhos com pedido, na ordem canônica do app (PP, P, M, G, GG, XG…). Tamanho repetido soma. */
export function planoDaGrade(tamanhos: readonly GradeTamanho[]): GradeTamanho[] {
  const mapa = new Map<string, number>();
  for (const t of tamanhos) {
    if (!(t.pedidos > 0)) continue;
    const k = t.tamanho.trim();
    mapa.set(k, (mapa.get(k) ?? 0) + t.pedidos);
  }
  return Array.from(mapa, ([tamanho, pedidos]) => ({ tamanho, pedidos })).sort((a, b) => compararTamanhos(a.tamanho, b.tamanho));
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

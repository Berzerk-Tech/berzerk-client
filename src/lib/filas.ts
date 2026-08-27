// Filas da Separação — a regra de BUCKET, num lugar só.
//
// Ela decide duas coisas que precisam concordar: em que fila cada tamanho real
// cai (o claim manda a lista de tamanhos do bucket) e, no Picking Geral dos
// mistos, qual seção NÃO entra na folha porque já está na bancada. Enquanto a
// regra morava dentro de `Separacao.tsx`, a folha da fila XG listava XG mas
// não XXG/G1/G2/G3 — o mesmo bucket, visto de outro jeito.

/**
 * Filas FIXAS da Separação (regra do Victor): só os 5 tamanhos que existem de
 * verdade na operação. Tamanhos raros são agrupados — o claim manda a lista de
 * tamanhos reais do bucket, então nenhum pedido fica órfão:
 *   PP → fila P;  XXG/G1/G2/G3/qualquer outro → fila XG.
 * "SEM TAMANHO" fica FORA (pedidos antigos, pré-junho — o corte por data é
 * feito no nexus).
 */
export const QUEUES = ["P", "M", "G", "GG", "XG"] as const;

/**
 * Sentinela da fila "sem tamanho" — o MESMO valor que o nexus define em
 * `@berzerk/contracts` (`SEM_TAMANHO`) e aceita em `sizes`. São os pedidos
 * cujo tamanho a ingestão não reconheceu: no banco, `predominant_size IS NULL`.
 */
export const SEM_TAMANHO = "SEM TAMANHO";

/**
 * Filas selecionáveis: as 5 fixas + "Sem tamanho". A sexta fica FORA das 5
 * bancadas (não tem bancada própria) e o tile só aparece quando tem pedido —
 * mas ela precisa existir: sem ela, pedido com tamanho não reconhecido ficava
 * invisível E inclaimável pra sempre, e a fila nunca esvaziava.
 */
export type Queue = (typeof QUEUES)[number] | typeof SEM_TAMANHO;

/** Fila (bancada) em que um tamanho real cai. */
export function queueFor(sizeKey: string): Queue {
  const s = sizeKey.trim().toUpperCase();
  if ((QUEUES as readonly string[]).includes(s)) return s as Queue;
  if (s === "PP") return "P";
  if (s === SEM_TAMANHO) return SEM_TAMANHO;
  return "XG";
}

// "Conta com o Tiny" da tela de filas: da fila aos faturados do Tiny, por período
// de emissão. O Tiny só tira o pedido de "faturado" quando ele é expedido, então o
// "N pedidos" da fila sozinho parece faltar pedido. Funções puras; o Nexus manda o
// campo `balanco` em `GET /separacao/queues` quando há data.
import type { BalancoFilas } from "../services/orders";

export type LinhaBalanco = { chave: string; rotulo: string; valor: number };

const PARCELAS: Array<[keyof BalancoFilas, string]> = [
  ["naFila", "Na fila"],
  ["semEtiqueta", "Sem etiqueta J&T"],
  ["faturadoNaoLiberado", "Faturado, não liberado"],
  ["emSeparacao", "Em separação"],
  ["emEspera", "Em espera"],
  ["aguardandoEmbalar", "Separados, aguardando embalar"],
  ["mercadoLivre", "Mercado Livre"],
  ["entregaEmMaos", "Entrega em mãos"],
  ["duplicatas", "Duplicatas"],
];

/** Número com separador de milhar pt-BR (sem depender de ICU do runtime). */
export function milhar(n: number): string {
  const s = String(Math.round(n));
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** Só as parcelas > 0, na ordem fixa. */
export function linhasDoBalanco(b: BalancoFilas): LinhaBalanco[] {
  const out: LinhaBalanco[] = [];
  for (const [chave, rotulo] of PARCELAS) {
    const v = b[chave];
    if (typeof v === "number" && v > 0) out.push({ chave, rotulo, valor: v });
  }
  return out;
}

/** "medido agora" / "medido há N min" / "medido há N h". */
export function medidoHa(medidoEm: string, agora: number = Date.now()): string {
  const t = Date.parse(medidoEm);
  if (Number.isNaN(t)) return "";
  const min = Math.max(0, Math.floor((agora - t) / 60000));
  if (min < 1) return "medido agora";
  if (min < 60) return `medido há ${min} min`;
  return `medido há ${Math.floor(min / 60)} h`;
}

export type DiferencaTiny = { texto: string; alerta: boolean };

/** Nexus × Tiny: 0 "bate"; Nexus maior "Nexus tem K a mais"; Tiny maior "faltam K no Nexus" (alerta). */
export function diferencaComTiny(abertos: number, tinyTotal: number): DiferencaTiny {
  const d = abertos - tinyTotal;
  if (d === 0) return { texto: "bate", alerta: false };
  if (d > 0) return { texto: `Nexus tem ${milhar(d)} a mais`, alerta: false };
  return { texto: `faltam ${milhar(-d)} no Nexus`, alerta: true };
}

// Canal da mesa de expedição (20/10): a embalagem tem uma "fila" por canal,
// como a Separação tem a aba E-commerce / Mercado Livre. A mesa fica num canal
// e só aceita pedido daquele canal — pedido do outro canal é recusado na
// identificação (`canal_errado`), pra ninguém embalar um Mercado Livre
// (DANFE, etiqueta do Mercado Envios no Tiny) como J&T, ou o contrário.
//
// A lista é um array de propósito: canais novos (outra transportadora, outro
// marketplace) entram aqui e na API, sem mexer na tela.

export type CanalExpedicao = "ecommerce" | "mercado_livre";

export const CANAIS_EXPEDICAO: ReadonlyArray<{ id: CanalExpedicao; rotulo: string }> = [
  { id: "ecommerce", rotulo: "J&T" },
  { id: "mercado_livre", rotulo: "Mercado Livre" },
];

const CANAL_KEY = "berzerk_expedicao_canal_v1";

export function rotuloCanal(canal: CanalExpedicao | undefined): string {
  return CANAIS_EXPEDICAO.find((c) => c.id === (canal ?? "ecommerce"))?.rotulo ?? "J&T";
}

/** Canal escolhido na mesa; sobrevive a fechar o app (localStorage). Padrão: J&T. */
export function getCanalExpedicao(): CanalExpedicao {
  try {
    const raw = localStorage.getItem(CANAL_KEY);
    if (CANAIS_EXPEDICAO.some((c) => c.id === raw)) return raw as CanalExpedicao;
  } catch {
    /* ignore */
  }
  return "ecommerce";
}

export function setCanalExpedicao(canal: CanalExpedicao): void {
  try {
    localStorage.setItem(CANAL_KEY, canal);
  } catch {
    /* ignore */
  }
}

/** O pedido pertence ao canal da mesa? Pedido sem `canal` (nexus antigo) é e-commerce. */
export function pedidoDoCanal(pedido: { canal?: CanalExpedicao }, canalMesa: CanalExpedicao): boolean {
  return (pedido.canal ?? "ecommerce") === canalMesa;
}

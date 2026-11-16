// Listas impressas em aberto no lote de uma operadora (Mistos: até 2), pra
// devolver UMA só com a chave do supervisor (11/11: acabava a peça da Lista 1,
// o supervisor devolvia e a Lista 2 ia junto).
//
// Mesma chave (`listaId ?? listaEm`) e mesma ordem (menor `listaEm` primeiro)
// do chip "Lista N" do card da mesa — o número aqui é o que ela lê na folha.

type PedidoDeLista = { id: string; listaEm?: string | null; listaId?: string | null };

export type ListaDoLote = {
  /** `listaId` quando o servidor manda; senão o carimbo `listaEm`. */
  chave: string;
  /** 1 = a mais antiga. */
  numero: number;
  /** Pedidos da lista que AINDA estão com ela. */
  ids: string[];
};

/** Escolha do diálogo: uma lista (pela chave) ou tudo o que está com ela. */
export const TODAS_AS_LISTAS = "todas";

export function listasDoLote(lote: PedidoDeLista[]): ListaDoLote[] {
  const porChave = new Map<string, { desde: number; ids: string[] }>();
  for (const o of lote) {
    if (!o.listaEm) continue;
    const chave = o.listaId ?? o.listaEm;
    const t = Date.parse(o.listaEm) || 0;
    const atual = porChave.get(chave);
    if (atual) {
      atual.ids.push(o.id);
      if (t < atual.desde) atual.desde = t;
    } else porChave.set(chave, { desde: t, ids: [o.id] });
  }
  return [...porChave.entries()]
    .sort((a, b) => a[1].desde - b[1].desde)
    .map(([chave, v], i) => ({ chave, numero: i + 1, ids: v.ids }));
}

/** Chave da lista de um pedido do lote (null = sem lista impressa). */
export function chaveDaLista(o: PedidoDeLista | null | undefined): string | null {
  if (!o?.listaEm) return null;
  return o.listaId ?? o.listaEm;
}

/**
 * Ids que a devolução leva. `TODAS_AS_LISTAS` (ou chave que não existe mais)
 * = o lote inteiro, como sempre foi; uma chave = só os pedidos daquela lista.
 */
export function idsDaDevolucao(lote: PedidoDeLista[], escolha: string): string[] {
  if (escolha !== TODAS_AS_LISTAS) {
    const lista = listasDoLote(lote).find((l) => l.chave === escolha);
    if (lista) return lista.ids;
  }
  return lote.map((o) => o.id);
}

// ---------------------------------------------------------------------------
// Resumo por lista (0.9.92): a tela de filas e a barra da mesa mostram "Lista 1
// · impressa hoje 14:19 · 37 de 50 separados" a partir daqui — uma conta só.

/** Recorte de `ListaResumo` (`GET /separacao/listas`) que o resumo usa. */
export type ListaDoServidor = {
  id: string;
  criadoEm: string;
  totalPedidos: number;
  pedidosRecuperaveis?: number;
  pedidosRetomaveis?: number;
  devolvidaEm?: string | null;
};

export type ResumoLista = {
  chave: string;
  numero: number;
  /** "Lista 1". */
  rotulo: string;
  /** Pedidos da lista que continuam com a operadora (a mesa). */
  pendentes: number;
  /** Pedidos da lista fora da mesa dela (na fila ou com outra mesa) — o servidor informa. */
  fora: number;
  /** Total impresso na folha; null quando o servidor não informou. */
  total: number | null;
  /** Separados (total − pendentes − fora); null sem total. */
  feitos: number | null;
  /** Carimbo da lista (o menor `listaEm` dos pedidos, ou o `criadoEm` do servidor). */
  impressaEm: string | null;
  /** Dia SP da impressão ≠ hoje. */
  deOutroDia: boolean;
  /** "hoje", "ontem" ou "dd/mm". */
  dia: string;
  /** "14:19" (SP). */
  hora: string;
};

const FUSO = "America/Sao_Paulo";

/** YYYY-MM-DD no fuso de SP. */
function diaSP(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: FUSO });
}

export function rotuloDoDia(iso: string, agora: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const dia = diaSP(d);
  if (dia === diaSP(agora)) return "hoje";
  if (dia === diaSP(new Date(agora.getTime() - 24 * 3600 * 1000))) return "ontem";
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", timeZone: FUSO });
}

function horaSP(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: FUSO });
}

/**
 * Uma linha por lista impressa do lote (mais antiga primeiro). `servidor` é o
 * que o app já recebe de `GET /separacao/listas`; casa pela chave (`listaId`).
 * Lista devolvida pelo servidor não entra com total (ela já não vale).
 */
export function resumirListas(
  lote: PedidoDeLista[],
  servidor: ListaDoServidor[] = [],
  agora: Date = new Date(),
): ResumoLista[] {
  const porId = new Map(servidor.map((s) => [s.id, s]));
  return listasDoLote(lote).map((l) => {
    const s = porId.get(l.chave);
    const menor = lote
      .filter((o) => chaveDaLista(o) === l.chave && o.listaEm)
      .map((o) => o.listaEm as string)
      .sort((a, b) => (Date.parse(a) || 0) - (Date.parse(b) || 0))[0];
    const impressaEm = s?.criadoEm ?? menor ?? null;
    const pendentes = l.ids.length;
    const fora = s ? (s.pedidosRecuperaveis ?? 0) + (s.pedidosRetomaveis ?? 0) : 0;
    const total = s && s.totalPedidos > 0 ? s.totalPedidos : null;
    const dia = impressaEm ? rotuloDoDia(impressaEm, agora) : "hoje";
    return {
      chave: l.chave,
      numero: l.numero,
      rotulo: `Lista ${l.numero}`,
      pendentes,
      fora,
      total,
      feitos: total === null ? null : Math.max(0, total - pendentes - fora),
      impressaEm,
      deOutroDia: dia !== "hoje",
      dia,
      hora: impressaEm ? horaSP(impressaEm) : "",
    };
  });
}

/** "37 de 50 separados" ou, sem total, "13 pendentes". */
export function textoProgresso(r: ResumoLista): string {
  if (r.total !== null && r.feitos !== null) return `${r.feitos} de ${r.total} separados`;
  return `${r.pendentes} ${r.pendentes === 1 ? "pendente" : "pendentes"}`;
}

/** "Lista 1 · impressa hoje 14:19 · 37 de 50 separados". */
export function textoLinhaDaLista(r: ResumoLista): string {
  const quando = r.impressaEm ? `impressa ${r.dia}${r.hora ? ` ${r.hora}` : ""}` : "impressa";
  return `${r.rotulo} · ${quando} · ${textoProgresso(r)}`;
}

/** Pedidos que ainda faltam separar somando as listas (pendentes + fora da mesa). */
export function faltamNasListas(rs: ResumoLista[]): number {
  return rs.reduce((n, r) => n + r.pendentes + r.fora, 0);
}

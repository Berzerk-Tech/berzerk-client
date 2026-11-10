// Modo "Únicos" da Expedição (27/10): fila de pedidos e-commerce de UMA peça,
// agrupada por estampa × cor × tamanho. Aqui só o que é puro (testável sem tela):
// persistência do modo/grupo, busca, mensagens de erro e a montagem do match.

import { ApiError } from "./api";
import type { EpcMatch, ExpedicaoOrder, OrderBumpConfig, UnicoGrupo, UnicoSepararResponse, UnicoTipo } from "../services/expedicao";
import { UNICOS_ERR } from "../services/expedicao";
import { ORDEM_TAMANHOS, compararTamanhos } from "./tamanhos";

export type ModoFila = "pedidos" | "unicos";

/** Máximo de EPCs que o `separar` aceita; acima disso é mais de uma peça na mesa. */
export const UNICOS_MAX_TAGS = 10;

// Chave própria: `berzerk_expedicao_modo_v1` já é o modo oficial/teste (services/expedicaoMode).
const MODO_KEY = "berzerk_expedicao_fila_v1";
// v2 (0.9.67): grupo passou a ter cor; o registro v1 é ignorado e a mesa escolhe a fila de novo uma vez.
const GRUPO_KEY = "berzerk_expedicao_unicos_grupo_v2";

/**
 * `cor`: undefined = veio de API velha (não manda nada); null = API nova, grupo SEM cor
 * (manda `cor: ""`); string = a cor do grupo.
 */
export type GrupoEscolhido = { estampa: string; tamanho: string; cor?: string | null };

function normCor(cor?: string | null): string {
  return (cor ?? "").trim().toLowerCase();
}

/** Identidade de um card de estampa: a mesma estampa em cores diferentes são cards diferentes. */
export function chaveEstampa(estampa: string, cor?: string | null): string {
  return `${estampa}|${normCor(cor)}`;
}

export function getModoFila(): ModoFila {
  try {
    return localStorage.getItem(MODO_KEY) === "unicos" ? "unicos" : "pedidos";
  } catch {
    return "pedidos";
  }
}

export function setModoFila(modo: ModoFila): void {
  try {
    localStorage.setItem(MODO_KEY, modo);
  } catch {
    /* ignore */
  }
}

export function getGrupoEscolhido(): GrupoEscolhido | null {
  try {
    const raw = localStorage.getItem(GRUPO_KEY);
    if (!raw) return null;
    const g = JSON.parse(raw) as Partial<GrupoEscolhido>;
    if (typeof g.estampa === "string" && g.estampa && typeof g.tamanho === "string" && g.tamanho) {
      if (typeof g.cor === "string" && g.cor) return { estampa: g.estampa, tamanho: g.tamanho, cor: g.cor };
      if (g.cor === null) return { estampa: g.estampa, tamanho: g.tamanho, cor: null };
      return { estampa: g.estampa, tamanho: g.tamanho };
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function setGrupoEscolhido(g: GrupoEscolhido | null): void {
  try {
    if (g) localStorage.setItem(GRUPO_KEY, JSON.stringify(g));
    else localStorage.removeItem(GRUPO_KEY);
  } catch {
    /* ignore */
  }
}

/** Minúsculo e sem acento — a busca da tela não pode depender de como se digita. */
export function normalizarBusca(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/** "LEG DAY · PRETO · G" (sem cor: "LEG DAY · G") — o título grande do cabeçalho. */
export function rotuloGrupo(g: GrupoEscolhido): string {
  const cor = g.cor?.trim();
  return (cor ? `${g.estampa} · ${cor} · ${g.tamanho}` : `${g.estampa} · ${g.tamanho}`).toUpperCase();
}

export function mesmoGrupo(a: GrupoEscolhido | null | undefined, b: GrupoEscolhido | null | undefined): boolean {
  return !!a && !!b && a.estampa === b.estampa && a.tamanho === b.tamanho && normCor(a.cor) === normCor(b.cor);
}

/** Filtra os grupos por estampa, cor, tamanho ou tipo de peça (cada palavra da busca precisa casar). */
export function filtrarGrupos(grupos: UnicoGrupo[], busca: string): UnicoGrupo[] {
  const palavras = normalizarBusca(busca).split(/\s+/).filter(Boolean);
  if (palavras.length === 0) return grupos;
  return grupos.filter((g) => {
    const alvo = normalizarBusca([g.estampa, g.cor ?? "", g.tamanho, ...(g.tipos ?? []).map((t) => t.produtoNome)].join(" "));
    return palavras.every((p) => alvo.includes(p));
  });
}

export type ErroUnicos = {
  code: string;
  message: string;
  /** Erro que só muda com a mesa: não adianta o retry automático. */
  definitivo: boolean;
  /** Mostra o botão "Trocar estampa" no painel de erro. */
  trocarFila?: boolean;
  /** order_bump_necessario: item que falta ler junto (nome + foto). */
  orderBump?: { produtoNome: string; imagemUrl: string | null; tamanho?: string | null };
  /** order_bump_necessario: peças lidas / total, ex. "1/2". */
  progresso?: string;
};

/** Mantém a seleção só se o id ainda está na lista; senão null (o servidor puxa o primeiro). Nunca seleciona sozinho. */
export function selecaoAposRecarga(selecionadoId: string | null, pedidos: { id: string }[]): string | null {
  if (selecionadoId && pedidos.some((p) => p.id === selecionadoId)) return selecionadoId;
  return null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * 404 do Nest sem rota ("Cannot GET /expedicao/unicos"): a API ainda não tem a fila.
 * Um 404 de gateway/proxy (sem esse corpo) é passageiro e NÃO desliga o modo.
 */
export function unicosRotaAusente(e: unknown): boolean {
  if (!(e instanceof ApiError) || e.status !== 404) return false;
  const b = e.body;
  if (!b || typeof b !== "object") return false;
  const m = (b as Record<string, unknown>).message;
  return typeof m === "string" && m.startsWith("Cannot ");
}

/** Erro do `separar` (ou de rede) → texto pt-BR pro painel da mesa. */
export function erroSepararUnico(e: unknown, grupo: GrupoEscolhido | null): ErroUnicos {
  if (e instanceof ApiError && e.body && typeof e.body === "object") {
    const b = e.body as Record<string, unknown>;
    const code = str(b.error);
    const peca = `${str(b.produtoNome)} ${str(b.tamanho)}`.trim();
    switch (code) {
      case UNICOS_ERR.PECA_DE_OUTRA_FILA:
        return {
          code,
          message: `Esta peça é ${[str(b.estampa), str(b.cor), str(b.tamanho)].filter(Boolean).join(" ")}. A fila escolhida é ${grupo ? rotuloGrupo(grupo) : "outra"}.`,
          definitivo: true,
          trocarFila: true,
        };
      case UNICOS_ERR.SEM_PEDIDO_UNICO:
        return { code, message: `Nenhum pedido único aguardando ${peca || "esta peça"}.`, definitivo: false };
      case UNICOS_ERR.VARIAS_PECAS:
        return { code, message: "Deixe só uma peça na mesa.", definitivo: true };
      case UNICOS_ERR.EPC_NAO_RESOLVIDO:
        return { code, message: "Peça não reconhecida (etiqueta sem cadastro).", definitivo: true };
      case UNICOS_ERR.PEDIDO_INDISPONIVEL:
        return { code, message: "Bipe a peça de novo.", definitivo: false };
      case UNICOS_ERR.ORDER_BUMP_NECESSARIO: {
        const ob = b.orderBump && typeof b.orderBump === "object" ? (b.orderBump as Record<string, unknown>) : {};
        const nome = str(ob.produtoNome) || "o item do order bump";
        return {
          code,
          message: `Este pedido tem order bump: leia a peça junto com ${nome}.`,
          definitivo: false,
          orderBump: { produtoNome: nome, imagemUrl: str(ob.imagemUrl) || null },
          progresso: "1/2",
        };
      }
      case UNICOS_ERR.PEDIDO_ESCOLHIDO_INDISPONIVEL:
        return {
          code,
          message: "O pedido escolhido já saiu da fila. Bipe a peça de novo.",
          definitivo: false,
        };
      case UNICOS_ERR.PECA_NAO_E_DO_PEDIDO: {
        const pd = b.pedido && typeof b.pedido === "object" ? (b.pedido as Record<string, unknown>) : {};
        const lido = str(b.produtoNome) || "outra";
        return {
          code,
          message: `A peça lida é ${lido}; o pedido #${str(pd.numero)} é ${str(pd.produtoNome) || "outra peça"}. Troque a peça ou selecione outro pedido.`,
          definitivo: true,
        };
      }
      case UNICOS_ERR.BUMP_SEM_PEDIDO: {
        const ob = b.orderBump && typeof b.orderBump === "object" ? (b.orderBump as Record<string, unknown>) : {};
        const nome = str(ob.produtoNome) || "o item do order bump";
        return {
          code,
          message: `Nenhum pedido de ${peca || "esta peça"} leva ${nome}. Se o item não é desta caixa, tire-o da mesa e leia só a peça.`,
          definitivo: false,
        };
      }
      case UNICOS_ERR.BUMP_TAMANHO_ERRADO: {
        const ob = b.orderBump && typeof b.orderBump === "object" ? (b.orderBump as Record<string, unknown>) : {};
        const ld = b.lido && typeof b.lido === "object" ? (b.lido as Record<string, unknown>) : {};
        const pd = b.pedido && typeof b.pedido === "object" ? (b.pedido as Record<string, unknown>) : {};
        const juntar = (...p: string[]) => p.filter(Boolean).join(" ");
        const esperado = juntar(str(ob.produtoNome), str(ob.tamanho));
        const lidoTxt = juntar(str(ld.produtoNome), str(ld.tamanho));
        return {
          code,
          message: `O order bump do pedido${str(pd.numero) ? ` #${str(pd.numero)}` : ""} é ${esperado || "outro item"}; o item lido é ${lidoTxt || "outro"}. Troque o item.`,
          definitivo: true,
          orderBump: { produtoNome: str(ob.produtoNome) || "o item do order bump", imagemUrl: str(ob.imagemUrl) || null, tamanho: str(ob.tamanho) || null },
        };
      }
      case UNICOS_ERR.SO_ORDER_BUMP_LIDO: {
        const ob = b.orderBump && typeof b.orderBump === "object" ? (b.orderBump as Record<string, unknown>) : {};
        const item = [str(ob.produtoNome), str(ob.tamanho)].filter(Boolean).join(" ") || "o item do order bump";
        return {
          code,
          message: `Li só o item do order bump (${item}). Coloque a peça junto e leia de novo.`,
          definitivo: false,
          orderBump: { produtoNome: str(ob.produtoNome) || "o item do order bump", imagemUrl: str(ob.imagemUrl) || null, tamanho: str(ob.tamanho) || null },
        };
      }
      case "missing_permission":
        return {
          code,
          message: "Seu usuário não tem a permissão de Expedição (expedicao:operate). Peça o papel de expedidor no admin do nexus.",
          definitivo: true,
        };
    }
  }
  if (unicosRotaAusente(e)) {
    return { code: "nexus_pendente", message: "Atualize a API: a fila de únicos ainda não existe no servidor.", definitivo: true };
  }
  // 4xx desconhecido (409 do complete, 422, 400 do zod…): refazer o POST não muda nada.
  if (e instanceof ApiError && e.status >= 400 && e.status < 500) {
    const b = e.body && typeof e.body === "object" ? (e.body as Record<string, unknown>) : {};
    return { code: str(b.error) || "erro_servidor", message: str(b.message) || "Recusado pelo servidor.", definitivo: true };
  }
  // Só falha de rede e 5xx chegam aqui.
  return { code: "sem_conexao", message: "Sem conexão, bipe de novo.", definitivo: false };
}

/** O `order` do `separar` entra no fluxo existente como um match de 1 peça. */
export function matchDoSeparar(order: ExpedicaoOrder, lidas: string[]): EpcMatch {
  const l = Array.from(new Set(lidas.map((t) => t.toUpperCase())));
  const todas = (order.rfidTags ?? []).map((t) => t.toUpperCase());
  const matched = l.filter((t) => todas.includes(t));
  return {
    order,
    tagsLidas: l,
    tagsFaltantes: todas.filter((t) => !l.includes(t)),
    tagsMatched: matched.length || l.length,
    tagsTotal: todas.length || l.length,
  };
}

/** Replay de pedido que já saiu: não reimprime, só avisa. */
export function replayJaExpedido(r: UnicoSepararResponse): boolean {
  return r.replay === true && r.order.status === "shipped";
}

// Régua única em `lib/tamanhos` (re-exportada: outros módulos/testes importam daqui).
export { ORDEM_TAMANHOS };
export const ordenarTamanhos = compararTamanhos;

/** Texto do botão Order bump: "Order bump: A, B" ou "desligado". */
export function rotuloOrderBump(ob: OrderBumpConfig | null | undefined): string {
  if (!ob || !ob.ativo) return "Order bump: desligado";
  const nomes = ob.produtos.map((p) => p.nome).join(", ");
  return nomes ? `Order bump: ${nomes}` : "Order bump: ativo";
}

const SEPARADORES = /^[\s\-–—·|/:,]+|[\s\-–—·|/:,]+$/g;

/** Caractere a caractere, pra o índice do texto normalizado bater com o original. */
function normalizarPorChar(s: string): string {
  let out = "";
  for (const c of s) {
    const n = c.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    out += n.length === 1 ? n : c.toLowerCase().slice(0, 1) || c;
  }
  return out;
}

/**
 * Tipo da peça sem a estampa e sem separadores soltos:
 * "Oversized - Legends" (estampa "Legends") → "Oversized". Sobrou nada → o nome inteiro.
 */
export function tipoBaseDoProduto(produtoNome: string, estampa: string): string {
  const nome = produtoNome.trim();
  const alvo = normalizarPorChar(estampa).trim();
  let base = nome;
  if (alvo) {
    const i = normalizarPorChar(nome).indexOf(alvo);
    if (i >= 0) base = nome.slice(0, i) + " " + nome.slice(i + alvo.length);
  }
  base = base.replace(/\s+/g, " ").replace(SEPARADORES, "").trim();
  return base || nome;
}

/** "Oversized · Preto" (sem cor: só "Oversized"). */
export function rotuloTipo(tipo: Pick<UnicoTipo, "produtoNome" | "cor">, estampa: string): string {
  const base = tipoBaseDoProduto(tipo.produtoNome, estampa);
  const cor = tipo.cor?.trim();
  return cor ? `${base} · ${cor}` : base;
}

/** Um tipo só → "Oversized · Preto"; vários → "Oversized · Preto 8 · Poliamida · Azul 2". */
export function rotuloTipos(tipos: UnicoTipo[], estampa: string): string {
  if (tipos.length === 0) return "";
  if (tipos.length === 1) return rotuloTipo(tipos[0], estampa);
  return tipos.map((t) => `${rotuloTipo(t, estampa)} ${t.pedidos}`).join(" · ");
}

/** Soma os tipos de vários grupos por produto + cor, mais pedidos primeiro. */
export function somarTipos(grupos: UnicoGrupo[]): UnicoTipo[] {
  const mapa = new Map<string, UnicoTipo>();
  for (const g of grupos) {
    for (const t of g.tipos ?? []) {
      const chave = `${t.produtoId}|${(t.cor ?? "").trim().toLowerCase()}`;
      const atual = mapa.get(chave);
      if (atual) {
        atual.pedidos += t.pedidos;
        if (!atual.imagemUrl && t.imagemUrl) atual.imagemUrl = t.imagemUrl;
      } else {
        mapa.set(chave, { ...t });
      }
    }
  }
  return Array.from(mapa.values()).sort((a, b) => b.pedidos - a.pedidos);
}

/** Tipos de uma estampa (todos os tamanhos) e a foto do dominante (senão a do grupo). */
export function tiposDaEstampa(grupos: UnicoGrupo[]): { tipos: UnicoTipo[]; imagemUrl: string | null } {
  const tipos = somarTipos(grupos);
  const imagemUrl = tipos.find((t) => t.imagemUrl)?.imagemUrl ?? grupos.find((g) => g.imagemUrl)?.imagemUrl ?? null;
  return { tipos, imagemUrl };
}

export type EstampaAgrupada = {
  /** `chaveEstampa(estampa, cor)`: identidade do card. */
  chave: string;
  estampa: string;
  /** undefined = API velha; null = sem cor. */
  cor: string | null | undefined;
  imagemUrl: string | null;
  /** Tipos de peça da estampa (todos os tamanhos), mais pedidos primeiro. */
  tipos: UnicoTipo[];
  pedidos: number;
  prioritarios: number;
  comOrderBump: number;
  /** Os grupos originais da estampa, na ordem PP…U. */
  tamanhos: UnicoGrupo[];
};

/** Agrupa os grupos estampa × cor × tamanho por estampa + cor, ordenadas por pedidos (desc), prioritários (desc), nome e cor (sem cor por último). */
export function agruparPorEstampa(grupos: UnicoGrupo[]): EstampaAgrupada[] {
  const mapa = new Map<string, EstampaAgrupada>();
  for (const g of grupos) {
    const chave = chaveEstampa(g.estampa, g.cor);
    let e = mapa.get(chave);
    if (!e) {
      e = { chave, estampa: g.estampa, cor: g.cor === undefined ? undefined : g.cor?.trim() ? g.cor : null, imagemUrl: null, tipos: [], pedidos: 0, prioritarios: 0, comOrderBump: 0, tamanhos: [] };
      mapa.set(chave, e);
    }
    e.pedidos += g.pedidos;
    e.prioritarios += g.prioritarios ?? 0;
    e.comOrderBump += g.comOrderBump ?? 0;
    e.tamanhos.push(g);
  }
  const lista = Array.from(mapa.values());
  lista.sort(
    (a, b) =>
      b.pedidos - a.pedidos ||
      b.prioritarios - a.prioritarios ||
      a.estampa.localeCompare(b.estampa, "pt-BR") ||
      (!a.cor ? (!b.cor ? 0 : 1) : !b.cor ? -1 : a.cor.localeCompare(b.cor, "pt-BR")),
  );
  for (const e of lista) {
    e.tamanhos.sort((a, b) => ordenarTamanhos(a.tamanho, b.tamanho));
    const t = tiposDaEstampa(e.tamanhos);
    e.tipos = t.tipos;
    e.imagemUrl = t.imagemUrl;
  }
  return lista;
}

const FMT_DIA = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });

/**
 * Dia (YYYY-MM-DD) de um instante ISO no fuso America/Sao_Paulo — a MESMA
 * regra do nexus no filtro `dia` (NEXUS_UNICOS_DIA.md). Null se vazio/inválido.
 */
export function diaDe(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return FMT_DIA.format(new Date(t));
}

/**
 * Filtro por dia de emissão (Victor, 06/11/2026). `dia` vazio devolve tudo.
 * Cobre o nexus antigo, que ignora o parâmetro; com o novo é idempotente.
 * Pedido sem `emitidoEm` não dá pra provar que é do dia: fica de fora.
 */
export function filtrarPorDia<T extends { emitidoEm?: string | null }>(pedidos: T[], dia: string | null | undefined): T[] {
  if (!dia) return pedidos;
  return pedidos.filter((p) => diaDe(p.emitidoEm) === dia);
}

/** "2026-11-04" → "04/11" (só formatação, sem fuso). */
export function rotuloDia(dia: string): string {
  const [, m, d] = dia.split("-");
  return m && d ? `${d}/${m}` : dia;
}

/** Intervalo de dias de emissão (YYYY-MM-DD, SP, inclusivo). Os dois nulos = todos os dias. */
export type PeriodoUnicos = { de: string | null; ate: string | null };

export const PERIODO_VAZIO: PeriodoUnicos = { de: null, ate: null };

export function periodoVazio(p: PeriodoUnicos): boolean {
  return !p.de && !p.ate;
}

/**
 * Aplica a escolha de um dos campos sem nunca deixar o intervalo invertido:
 * `de` maior que `ate` (ou o contrário) arrasta o outro pra ficar igual.
 */
export function ajustarPeriodo(p: PeriodoUnicos, campo: "de" | "ate", valor: string | null): PeriodoUnicos {
  const v = valor || null;
  const novo: PeriodoUnicos = { ...p, [campo]: v };
  if (novo.de && novo.ate && novo.de > novo.ate) {
    return campo === "de" ? { de: novo.de, ate: novo.de } : { de: novo.ate, ate: novo.ate };
  }
  return novo;
}

/**
 * Recorte que o servidor está de fato aplicando. Só `suportado === true`
 * (resposta com `periodo`) prova que a API entende `de`/`ate`. Sem prova
 * (`false` = API antiga, `null` = ainda sem resposta) só vale UM dia: qualquer
 * intervalo maior colapsa no primeiro dia informado — a API antiga ignora o
 * recorte e devolveria pedido de qualquer dia.
 */
export function periodoEfetivo(p: PeriodoUnicos, suportado: boolean | null): PeriodoUnicos {
  if (suportado === true) return p;
  if (p.de && p.ate && p.de === p.ate) return p;
  const dia = p.de ?? p.ate;
  return dia ? { de: dia, ate: dia } : PERIODO_VAZIO;
}

/**
 * Aplica a escolha de um campo no estado. Sem suporte provado, "De" grava um
 * dia FECHADO (`{de: X, ate: X}`): se a API nova subir no meio do turno, a
 * estação segue filtrando aquele dia em vez de virar "a partir de X".
 */
export function escolherPeriodo(p: PeriodoUnicos, campo: "de" | "ate", valor: string | null, suportado: boolean | null): PeriodoUnicos {
  const v = valor || null;
  if (suportado !== true) {
    if (campo === "ate") return p;
    return v ? { de: v, ate: v } : PERIODO_VAZIO;
  }
  return ajustarPeriodo(p, campo, v);
}

/** Filtro local por intervalo (cobre API antiga e é idempotente com a nova). Sem `emitidoEm` fica de fora quando há recorte. */
export function filtrarPorPeriodo<T extends { emitidoEm?: string | null }>(pedidos: T[], p: PeriodoUnicos): T[] {
  if (periodoVazio(p)) return pedidos;
  return pedidos.filter((x) => {
    const d = diaDe(x.emitidoEm);
    if (!d) return false;
    return (!p.de || d >= p.de) && (!p.ate || d <= p.ate);
  });
}

/** "31/10 a 05/11", "a partir de 31/10", "até 05/11" ou o dia único; "" sem recorte. */
export function rotuloPeriodo(p: PeriodoUnicos): string {
  if (p.de && p.ate) return p.de === p.ate ? rotuloDia(p.de) : `${rotuloDia(p.de)} a ${rotuloDia(p.ate)}`;
  if (p.de) return `a partir de ${rotuloDia(p.de)}`;
  if (p.ate) return `até ${rotuloDia(p.ate)}`;
  return "";
}

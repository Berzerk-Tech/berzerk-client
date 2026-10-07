// Wrappers da API de Devoluções (nexus). Contrato em NEXUS_DEVOLUCOES.md.
//
// Fluxo: abrir (ou retomar) o lote → bipar EPCs (o nexus só PRÉ-CLASSIFICA) →
// fechar (aplica: desvincula as peças dos pedidos e, com a trava ligada,
// reintegra ao estoque da Shopify).
//
// Erros de negócio vêm como `{ error: 'codigo' }` (4xx) — trate por CÓDIGO
// (`expedicaoErrorCode`, mesma extração da Expedição). Todas as rotas exigem
// `expedicao:operate` (`canOperateExpedicao`).

import { apiRequest } from "../lib/api";

/** Máx. de EPCs por chamada de `adicionarEpcs` (o servidor aceita 1..200). */
export const EPCS_CHUNK = 200;

export type DevolucaoDestino = "estoque" | "descarte" | "troca";
export type LoteStatus = "aberto" | "fechado";

export type ItemSituacao =
  | "pendente"
  | "devolvida"
  | "nao_encontrado"
  | "nao_expedido"
  | "ja_devolvida";

export type ReintegracaoStatus =
  | "ok"
  | "parcial"
  | "erro"
  | "pendente"
  | "desligada"
  | "em_andamento";
/** `incerto` = timeout/rede: pode ter aplicado; o Nexus reenvia com chave idempotente. */
export type ReintegracaoVarianteStatus = "ok" | "erro" | "incerto" | "sem_gid" | "sem_variante" | "pendente";

export type ReintegracaoVariante = {
  varianteId: string | null;
  sku: string | null;
  tamanho: string | null;
  ean13: string | null;
  delta: number;
  status: ReintegracaoVarianteStatus;
  erro?: string | null;
  tentativas?: number;
  ultimaTentativaEm?: string | null;
  adjustmentGroupId?: string;
};

export type Reintegracao = {
  status: ReintegracaoStatus;
  em: string | null;
  porVariante: ReintegracaoVariante[];
  resumo: {
    total: number;
    ok: number;
    erro: number;
    semGid: number;
    semVariante: number;
    pendente: number;
  };
};

export type Lote = {
  id: string;
  status: LoteStatus;
  abertoEm: string;
  abertoPorId: string | null;
  abertoPorNome: string | null;
  fechadoEm: string | null;
  fechadoPorId: string | null;
  fechadoPorNome: string | null;
  motivo: string | null;
  /** Default `estoque` no contrato. */
  destino: DevolucaoDestino;
  qtdItens: number;
  qtdDevolvidas: number;
  reintegracao: Reintegracao | null;
  reintegradoEm: string | null;
};

export type LoteItem = {
  id: string;
  epc: string;
  situacao: ItemSituacao;
  orderId: string | null;
  orderNumber: string | null;
  sku: string | null;
  tamanho: string | null;
  ean13: string | null;
  varianteId: string | null;
  lidoEm: string;
  aplicadaEm: string | null;
};

export type LoteResumo = {
  total: number;
  devolviveis: number;
  naoEncontrados: number;
  naoExpedidos: number;
  jaDevolvidas: number;
};

export type PorVariante = {
  varianteId: string | null;
  sku: string | null;
  tamanho: string | null;
  ean13: string | null;
  qtd: number;
};

export type LoteDetalhe = {
  lote: Lote;
  resumo: LoteResumo;
  itens: LoteItem[];
  porVariante: PorVariante[];
};

export type AdicionarEpcsResponse = {
  adicionados: LoteItem[];
  repetidos: string[];
  invalidos: string[];
  resumo: LoteResumo;
};

export type FecharLoteResponse = {
  lote: Lote;
  resumo: LoteResumo;
  reintegracao: Reintegracao | null;
};

/** Códigos de erro de negócio (campo `error` do body). */
export const DEV_ERR = {
  LOTE_FECHADO: "lote_fechado",
  LOTE_ABERTO: "lote_aberto",
  EPC_EM_OUTRO_LOTE: "epc_em_outro_lote",
  TRAVA_DESLIGADA: "trava_desligada",
  DESTINO_NAO_ESTOQUE: "destino_nao_estoque",
  REINTEGRACAO_EM_ANDAMENTO: "reintegracao_em_andamento",
  LOTE_NAO_ENCONTRADO: "lote_nao_encontrado",
  EPC_NAO_ENCONTRADO_NO_LOTE: "epc_nao_encontrado_no_lote",
  EPCS_INVALIDOS: "epcs_invalidos",
  LOTE_VAZIO: "lote_vazio",
  JANELA_INVALIDA: "janela_invalida",
  LOTE_ABERTO_INDISPONIVEL: "lote_aberto_indisponivel",
} as const;

export const DESTINO_LABEL: Record<DevolucaoDestino, string> = {
  estoque: "Estoque",
  descarte: "Descarte",
  troca: "Troca",
};

/**
 * Mesma normalização do Nexus (`epc-normalize.ts`): trim, uppercase, só hex,
 * exatamente 24 chars (SGTIN-96). `null` = EPC inválido (não vai pro lote).
 */
export function normalizarEpc(bruto: unknown): string | null {
  const e = String(bruto ?? "").trim().toUpperCase().replace(/[^0-9A-F]/g, "");
  return e.length === 24 ? e : null;
}

const BASE = "/expedicao/devolucoes/lotes";

export function abrirLote(
  body: { motivo?: string; destino?: DevolucaoDestino } = {},
): Promise<{ lote: Lote; retomado: boolean }> {
  return apiRequest(BASE, { method: "POST", body });
}

export async function listarLotes(
  q: { status?: LoteStatus; de?: string; ate?: string; limit?: number } = {},
): Promise<{ itens: Lote[] }> {
  return apiRequest(BASE, {
    query: {
      status: q.status,
      de: q.de,
      ate: q.ate,
      limit: q.limit != null ? String(q.limit) : undefined,
    },
  });
}

export function getLote(id: string): Promise<LoteDetalhe> {
  return apiRequest(`${BASE}/${encodeURIComponent(id)}`);
}

/**
 * Adiciona EPCs ao lote. Manda em chunks de ≤200 e MESCLA `adicionados`,
 * `repetidos` e `invalidos`; devolve o `resumo` do último chunk (o mais novo).
 * Se um chunk falhar (ex.: `epc_em_outro_lote` recusa a chamada INTEIRA), o
 * erro sobe — os chunks anteriores já foram aplicados.
 */
export async function adicionarEpcs(loteId: string, epcs: string[]): Promise<AdicionarEpcsResponse> {
  const out: AdicionarEpcsResponse = {
    adicionados: [],
    repetidos: [],
    invalidos: [],
    resumo: { total: 0, devolviveis: 0, naoEncontrados: 0, naoExpedidos: 0, jaDevolvidas: 0 },
  };
  for (let i = 0; i < epcs.length; i += EPCS_CHUNK) {
    const r = await apiRequest<AdicionarEpcsResponse>(`${BASE}/${encodeURIComponent(loteId)}/epcs`, {
      method: "POST",
      body: { epcs: epcs.slice(i, i + EPCS_CHUNK) },
    });
    out.adicionados.push(...r.adicionados);
    out.repetidos.push(...r.repetidos);
    out.invalidos.push(...r.invalidos);
    out.resumo = r.resumo;
  }
  return out;
}

export function removerEpc(
  loteId: string,
  epc: string,
): Promise<{ removido: boolean; resumo: LoteResumo }> {
  return apiRequest(`${BASE}/${encodeURIComponent(loteId)}/epcs/${encodeURIComponent(epc)}`, {
    method: "DELETE",
  });
}

export function fecharLote(
  loteId: string,
  body: { motivo?: string; destino?: DevolucaoDestino } = {},
): Promise<FecharLoteResponse> {
  return apiRequest(`${BASE}/${encodeURIComponent(loteId)}/fechar`, { method: "POST", body });
}

export function reintegrarLote(
  loteId: string,
): Promise<{ lote: Lote; reintegracao: Reintegracao | null }> {
  return apiRequest(`${BASE}/${encodeURIComponent(loteId)}/reintegrar`, { method: "POST" });
}

/** Outra estação segue reintegrando o lote depois de todas as esperas. */
export class ReintegracaoOcupadaError extends Error {
  constructor() {
    super("Outra estação está reintegrando este lote.");
    this.name = "ReintegracaoOcupadaError";
  }
}

/** O chamador desistiu do loop (lote trocado / tela desmontada). */
export class ReintegracaoCanceladaError extends Error {
  constructor() {
    super("Reintegração cancelada.");
    this.name = "ReintegracaoCanceladaError";
  }
}

/** Reintegração ainda tem o que fazer? (nova passada via `reintegrarLote`) */
export function reintegracaoPendente(r: Reintegracao | null | undefined): boolean {
  return !!r && r.status === "pendente" && r.resumo.pendente > 0;
}

/** Progresso "N de M variantes" a partir do resumo. */
export function progressoReintegracao(r: Reintegracao): { feitas: number; total: number } {
  return { feitas: Math.max(0, r.resumo.total - r.resumo.pendente), total: r.resumo.total };
}

const ESPERA_MS = 3000;
const ESPERAS_MAX = 10;
const PASSADAS_MAX = 60;

/**
 * Reintegra em PASSADAS (o Nexus tem orçamento de ~12 s por chamada): chama
 * `reintegrarLote` em sequência até `resumo.pendente === 0`. 409
 * `reintegracao_em_andamento` espera 3 s e tenta de novo (máx. 10 vezes seguidas,
 * depois `ReintegracaoOcupadaError`). Qualquer outro erro sobe; o chamador mantém
 * o último estado conhecido (`onProgresso`) e oferece "Tentar de novo".
 */
export async function reintegrarAteZerar(
  loteId: string,
  onProgresso?: (r: { lote: Lote; reintegracao: Reintegracao | null }) => void,
  espera: (ms: number) => Promise<void> = (ms) => new Promise((res) => setTimeout(res, ms)),
  cancelado: () => boolean = () => false,
): Promise<{ lote: Lote; reintegracao: Reintegracao | null }> {
  let esperas = 0;
  for (let passadas = 0; passadas < PASSADAS_MAX; ) {
    if (cancelado()) throw new ReintegracaoCanceladaError();
    let r: { lote: Lote; reintegracao: Reintegracao | null };
    try {
      r = await reintegrarLote(loteId);
    } catch (e) {
      const b = (e as { status?: number; body?: unknown } | null) ?? null;
      if (e instanceof ReintegracaoCanceladaError) throw e;
      const code =
        b?.body && typeof b.body === "object" ? (b.body as { error?: unknown }).error : undefined;
      if (b?.status === 409 && code === DEV_ERR.REINTEGRACAO_EM_ANDAMENTO) {
        if (++esperas > ESPERAS_MAX) throw new ReintegracaoOcupadaError();
        await espera(ESPERA_MS);
        if (cancelado()) throw new ReintegracaoCanceladaError();
        continue;
      }
      throw e;
    }
    esperas = 0;
    passadas++;
    if (cancelado()) throw new ReintegracaoCanceladaError();
    onProgresso?.(r);
    if (!reintegracaoPendente(r.reintegracao)) return r;
  }
  throw new Error("A reintegração não terminou depois de várias passadas. Tente de novo.");
}

/** EPCs recusados por `epc_em_outro_lote` (body: `epcs: [{ epc, loteId }]`). */
export function epcsEmOutroLote(e: unknown): string[] {
  const body = (e as { body?: unknown } | null)?.body;
  if (!body || typeof body !== "object") return [];
  const lista = (body as { epcs?: unknown }).epcs;
  if (!Array.isArray(lista)) return [];
  return lista
    .map((x) => (x && typeof x === "object" ? (x as { epc?: unknown }).epc : x))
    .filter((x): x is string => typeof x === "string");
}

/** Mensagem amigável (pt-BR) pra qualquer código de erro de Devolução. */
export function devolucaoErrorMessage(code: string | null, fallback: string): string {
  if (fallback === new ReintegracaoOcupadaError().message) return fallback;
  switch (code) {
    case DEV_ERR.LOTE_FECHADO:
      return "Este lote já foi fechado.";
    case DEV_ERR.LOTE_ABERTO:
      return "O lote ainda está aberto — feche-o antes de reintegrar.";
    case DEV_ERR.EPC_EM_OUTRO_LOTE:
      return "Há peças que já estão em outro lote aberto.";
    case DEV_ERR.TRAVA_DESLIGADA:
      return "A reintegração ao estoque da Shopify está desligada no Nexus.";
    case DEV_ERR.DESTINO_NAO_ESTOQUE:
      return "Este lote não tem destino Estoque, então não há o que reintegrar.";
    case DEV_ERR.REINTEGRACAO_EM_ANDAMENTO:
      return "Já existe uma reintegração em andamento para este lote. Aguarde e confira de novo em instantes.";
    case DEV_ERR.LOTE_NAO_ENCONTRADO:
      return "Lote não encontrado.";
    case DEV_ERR.EPC_NAO_ENCONTRADO_NO_LOTE:
      return "Essa peça não está mais no lote.";
    case DEV_ERR.EPCS_INVALIDOS:
      return "Leitura recusada: EPC inválido.";
    case DEV_ERR.LOTE_VAZIO:
      return "O lote está vazio — leia ao menos uma peça antes de fechar.";
    case DEV_ERR.JANELA_INVALIDA:
      return "Período inválido para a listagem de lotes.";
    case DEV_ERR.LOTE_ABERTO_INDISPONIVEL:
      return "Não foi possível abrir ou retomar o lote agora. Tente de novo em instantes.";
    default:
      return fallback;
  }
}

/** Compat: erros do reintegrar. */
export const reintegrarErrorMessage = devolucaoErrorMessage;

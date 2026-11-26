// Exclusão GLOBAL de produtos — "falta no galpão" (pedido da Stefhany, 04/11/2026).
//
// O Filtro Exclusão era só desta estação (localStorage por fila). Quando falta
// uma peça, falta pro galpão inteiro, e ela tinha que ir máquina por máquina
// marcando. A lista agora mora no nexus (contrato em NEXUS_FILTRO_MISTOS.md,
// Parte 2): o servidor aplica sempre, em todas as estações e filas, como união
// com a lista local; qualquer estação edita; um evento WS avisa as outras.
//
// Nexus antigo (sem a rota) → 404 → `null`: a aba mostra só a lista local, como
// antes. Nunca deixar a tela quebrar por causa disso.

import { ApiError, apiRequest } from "../lib/api";

/** `bancada` = a separadora não achou na bancada (cai quando a reposição atende ou na virada do dia); `fabrica` = acabou na fábrica, confirmado pela supervisão. */
export type NivelExclusao = "bancada" | "fabrica";

export type ExclusaoGlobal = {
  id: string;
  /** Texto legado de exibição (produto + " - " + tamanho, quando há). Não serve de chave. */
  termo: string;
  /** Nome base do produto, SEM tamanho. Chave do item = `produto` + `tamanho`. */
  produto: string;
  /** Nome de quem adicionou (`criadoPorNome` do nexus); cai no `sub` se o cadastro não tem nome. */
  criadoPor: string | null;
  criadoEm: string | null;
  /** Tamanho da exclusão. `null` = todos os tamanhos (nexus antigo sempre `null`). */
  tamanho: string | null;
  /** Pedidos que este termo prende na fila agora (quando o nexus manda). */
  pedidosPresos?: { total: number; puros: number; mistos: number };
  /** `false` = só quem tirou ou a supervisão devolve. Ausente = pode. */
  podeRemover?: boolean;
  /** Nexus com níveis (`aceitaNivel`). Ausente = nexus antigo. */
  nivel?: NivelExclusao;
  /** Quando o repositor respondeu "não tem" (ISO) e quem respondeu. */
  semPecaEm?: string | null;
  semPecaPorNome?: string | null;
  /** O usuário pode promover/rebaixar este termo. */
  podeMudarNivel?: boolean;
};

export type ExclusoesGlobais = {
  termos: ExclusaoGlobal[];
  atualizadoEm: string | null;
  /** `false` = só a supervisão edita a lista do galpão. Ausente (nexus antigo) ou `true` = qualquer estação edita. */
  podeEditar?: boolean;
  /** `true` = o nexus entende `tamanho` no POST (detector de suporte). Ausente = API velha, só termo. */
  aceitaTamanho?: boolean;
  /** `true` = o nexus entende `nivel` (detector de suporte). Ausente = API velha, tudo como antes. */
  aceitaNivel?: boolean;
  /** O usuário é supervisor e pode marcar "acabou na fábrica". */
  podeMarcarFabrica?: boolean;
};

/** Texto do 403 `exclusao_global_nao_permitida` ao marcar/mudar pra "fábrica" sem ser supervisor. */
export const MSG_SO_SUPERVISAO_FABRICA = "Só a supervisão marca falta na fábrica.";

/** Texto mostrado quando a estação não pode editar a lista do galpão (campo `podeEditar` ou 403 na escrita). */
export const MSG_SO_SUPERVISAO_EXCLUSAO = "Só a supervisão altera os produtos em falta.";

/** Texto do item travado e do 403 `exclusao_global_nao_permitida` na remoção. */
export const MSG_SO_QUEM_TIROU_DEVOLVE = "Só quem tirou ou a supervisão devolve.";

/** 403 de remoção recusada pelo nexus (`exclusao_global_nao_permitida` em `error`/`code`). */
export function ehExclusaoNaoPermitida(e: unknown): boolean {
  if (!(e instanceof ApiError) || e.status !== 403) return false;
  const b = e.body as { error?: unknown; code?: unknown } | null | undefined;
  return (
    b?.error === "exclusao_global_nao_permitida" ||
    b?.code === "exclusao_global_nao_permitida" ||
    e.message.includes("exclusao_global_nao_permitida")
  );
}

function normalizar(raw: unknown): ExclusoesGlobais {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const termos = Array.isArray(b.termos) ? b.termos : [];
  return {
    termos: termos
      .filter((t): t is Record<string, unknown> => !!t && typeof t === "object" && typeof t.termo === "string")
      .map<ExclusaoGlobal>((t) => ({
        id: String(t.id ?? t.termo),
        termo: String(t.termo).trim(),
        produto: typeof t.produto === "string" && t.produto.trim() ? t.produto.trim() : String(t.termo).trim(),
        criadoPor:
          typeof t.criadoPorNome === "string" && t.criadoPorNome.trim()
            ? t.criadoPorNome.trim()
            : typeof t.criadoPor === "string"
              ? t.criadoPor
              : null,
        criadoEm: typeof t.criadoEm === "string" ? t.criadoEm : null,
        tamanho: typeof t.tamanho === "string" && t.tamanho.trim() ? t.tamanho.trim().toUpperCase() : null,
        ...pedidosPresos(t.pedidosPresos),
        ...(typeof t.podeRemover === "boolean" ? { podeRemover: t.podeRemover } : null),
        ...(t.nivel === "bancada" || t.nivel === "fabrica" ? { nivel: t.nivel } : null),
        ...(typeof t.semPecaEm === "string" && t.semPecaEm ? { semPecaEm: t.semPecaEm } : null),
        ...(typeof t.semPecaPorNome === "string" && t.semPecaPorNome.trim() ? { semPecaPorNome: t.semPecaPorNome.trim() } : null),
        ...(typeof t.podeMudarNivel === "boolean" ? { podeMudarNivel: t.podeMudarNivel } : null),
      }))
      .filter((t) => t.termo.length > 0),
    atualizadoEm: typeof b.atualizadoEm === "string" ? b.atualizadoEm : null,
    ...(typeof b.podeEditar === "boolean" ? { podeEditar: b.podeEditar } : null),
    ...(typeof b.aceitaTamanho === "boolean" ? { aceitaTamanho: b.aceitaTamanho } : null),
    ...(typeof b.aceitaNivel === "boolean" ? { aceitaNivel: b.aceitaNivel } : null),
    ...(typeof b.podeMarcarFabrica === "boolean" ? { podeMarcarFabrica: b.podeMarcarFabrica } : null),
  };
}

function pedidosPresos(raw: unknown): { pedidosPresos?: ExclusaoGlobal["pedidosPresos"] } {
  const p = raw as Record<string, unknown> | null | undefined;
  if (!p || typeof p !== "object" || typeof p.total !== "number") return {};
  return {
    pedidosPresos: {
      total: p.total,
      puros: typeof p.puros === "number" ? p.puros : 0,
      mistos: typeof p.mistos === "number" ? p.mistos : 0,
    },
  };
}

/** Lista atual. `null` = nexus sem a rota (degrada pra lista local). */
export async function getExclusoesGlobais(): Promise<ExclusoesGlobais | null> {
  try {
    return normalizar(await apiRequest<unknown>("/separacao/exclusoes-globais"));
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/**
 * Adiciona UM termo (ou revive um removido). É por termo, nunca "substitui a
 * lista": duas estações editando ao mesmo tempo não apagam o que a outra
 * acabou de pôr (revisão 04/11). 404 → null (nexus sem a rota).
 */
export async function adicionarExclusaoGlobal(
  termo: string,
  tamanho?: string | null,
  nivel?: NivelExclusao,
): Promise<ExclusoesGlobais | null> {
  try {
    return normalizar(
      await apiRequest<unknown>("/separacao/exclusoes-globais", {
        method: "POST",
        // `tamanho` só vai quando escolhido: sem ele o corpo é o de sempre (API velha não vê campo novo).
        // `nivel` só vai com nexus que o aceita (quem chama decide): sem ele o corpo é o de sempre.
        body: { termo: termo.trim(), ...(tamanho ? { tamanho } : null), ...(nivel ? { nivel } : null) },
      }),
    );
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** Remove UM termo pelo id (soft delete no nexus). 404 da ROTA → null; termo já removido → ok. */
export async function removerExclusaoGlobal(id: string): Promise<ExclusoesGlobais | null> {
  try {
    return normalizar(
      await apiRequest<unknown>(`/separacao/exclusoes-globais/${encodeURIComponent(id)}`, { method: "DELETE" }),
    );
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** 404 do TERMO (já removido no Nexus novo): `exclusao_global_nao_encontrada`. Não é rota ausente. */
export function ehExclusaoNaoEncontrada(e: unknown): boolean {
  if (!(e instanceof ApiError) || e.status !== 404) return false;
  const b = e.body as { error?: unknown; code?: unknown } | null | undefined;
  return b?.error === "exclusao_global_nao_encontrada" || b?.code === "exclusao_global_nao_encontrada" || e.message.includes("exclusao_global_nao_encontrada");
}

/** Texto quando o termo a mudar de nível já saiu do galpão. */
export const MSG_ITEM_JA_SAIU = "Esse item já saiu do galpão.";

/** Promove (`fabrica`) ou rebaixa (`bancada`) um termo. 404 da ROTA → null (nexus sem níveis); 404 do termo lança. */
export async function mudarNivel(id: string, nivel: NivelExclusao): Promise<ExclusoesGlobais | null> {
  try {
    return normalizar(
      await apiRequest<unknown>(`/separacao/exclusoes-globais/${encodeURIComponent(id)}/nivel`, {
        method: "POST",
        body: { nivel },
      }),
    );
  } catch (e) {
    if (e instanceof ApiError && e.status === 404 && !ehExclusaoNaoEncontrada(e)) return null;
    throw e;
  }
}

/**
 * Termos globais. A lista é do GALPÃO, sem canal: peça que falta pro
 * e-commerce falta pro Mercado Livre também — e um PUT que substitui a lista
 * inteira só é seguro se não existe recorte que a tela não enxerga.
 */
export function termosGlobais(g: ExclusoesGlobais | null): string[] {
  // Só os de TODOS os tamanhos: o filtro local por nome esconderia o produto em todo tamanho.
  // Os por tamanho o servidor aplica sozinho (une a lista dele a todo claim).
  return g ? g.termos.filter((t) => !t.tamanho).map((t) => t.produto ?? t.termo) : [];
}

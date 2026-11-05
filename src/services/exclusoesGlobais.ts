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

export type ExclusaoGlobal = {
  id: string;
  termo: string;
  /** Nome de quem adicionou (`criadoPorNome` do nexus); cai no `sub` se o cadastro não tem nome. */
  criadoPor: string | null;
  criadoEm: string | null;
};

export type ExclusoesGlobais = {
  termos: ExclusaoGlobal[];
  atualizadoEm: string | null;
};

function normalizar(raw: unknown): ExclusoesGlobais {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const termos = Array.isArray(b.termos) ? b.termos : [];
  return {
    termos: termos
      .filter((t): t is Record<string, unknown> => !!t && typeof t === "object" && typeof t.termo === "string")
      .map<ExclusaoGlobal>((t) => ({
        id: String(t.id ?? t.termo),
        termo: String(t.termo).trim(),
        criadoPor:
          typeof t.criadoPorNome === "string" && t.criadoPorNome.trim()
            ? t.criadoPorNome.trim()
            : typeof t.criadoPor === "string"
              ? t.criadoPor
              : null,
        criadoEm: typeof t.criadoEm === "string" ? t.criadoEm : null,
      }))
      .filter((t) => t.termo.length > 0),
    atualizadoEm: typeof b.atualizadoEm === "string" ? b.atualizadoEm : null,
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
export async function adicionarExclusaoGlobal(termo: string): Promise<ExclusoesGlobais | null> {
  try {
    return normalizar(
      await apiRequest<unknown>("/separacao/exclusoes-globais", { method: "POST", body: { termo: termo.trim() } }),
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

/**
 * Termos globais. A lista é do GALPÃO, sem canal: peça que falta pro
 * e-commerce falta pro Mercado Livre também — e um PUT que substitui a lista
 * inteira só é seguro se não existe recorte que a tela não enxerga.
 */
export function termosGlobais(g: ExclusoesGlobais | null): string[] {
  return g ? g.termos.map((t) => t.termo) : [];
}

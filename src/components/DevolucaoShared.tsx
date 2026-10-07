// Peças compartilhadas da tela de Devolução e do modal "Lotes anteriores":
// badge de situação, tabela "Por produto" e o bloco de reintegração.

import type { CSSProperties, ReactNode } from "react";
import {
  DESTINO_LABEL,
  type ItemSituacao,
  type Lote,
  type LoteItem,
  type PorVariante,
  type Reintegracao,
  type ReintegracaoVarianteStatus,
} from "../services/devolucoes";

export function hora(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

export function diaHora(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} ${hora(iso)}`;
}

/** Últimos 6 caracteres do EPC (o resto é prefixo da empresa, igual em todas). */
export function epcCurto(epc: string): string {
  return epc.length > 6 ? `…${epc.slice(-6)}` : epc;
}

/** "luiz.fernando@berzerk.com.br" → "luiz.fernando". */
export function nomeCurto(nome: string | null | undefined): string {
  if (!nome) return "—";
  return nome.includes("@") ? nome.split("@")[0]! : nome;
}

export const SITUACAO_LABEL: Record<ItemSituacao, string> = {
  pendente: "Pendente",
  devolvida: "Devolver",
  nao_encontrado: "Não encontrada",
  nao_expedido: "Pedido não expedido",
  ja_devolvida: "Já devolvida",
};

const SITUACAO_TOM: Record<ItemSituacao, "ok" | "warn" | "danger" | "info" | "neutro"> = {
  pendente: "neutro",
  devolvida: "ok",
  nao_encontrado: "danger",
  nao_expedido: "warn",
  ja_devolvida: "info",
};

const TONS = {
  ok: { background: "var(--success-bg)", color: "var(--success-text)", borderColor: "var(--success-border)" },
  warn: { background: "var(--warning-bg)", color: "var(--warning-text)", borderColor: "var(--warning-border)" },
  danger: { background: "var(--danger-bg)", color: "var(--danger-text)", borderColor: "var(--danger-border)" },
  info: { background: "var(--info-bg)", color: "var(--info-text)", borderColor: "var(--info-border)" },
  neutro: { background: "var(--bg-input)", color: "var(--text-muted)", borderColor: "var(--border)" },
} as const;

export function SituacaoBadge({ situacao }: { situacao: ItemSituacao }) {
  return <span style={{ ...badge, ...TONS[SITUACAO_TOM[situacao]] }}>{SITUACAO_LABEL[situacao]}</span>;
}

export function Badge({ tom, children }: { tom: keyof typeof TONS; children: ReactNode }) {
  return <span style={{ ...badge, ...TONS[tom] }}>{children}</span>;
}

/** Linha de item (lista da tela e do detalhe do lote anterior). */
export function ItemLinha({ item, acao }: { item: LoteItem; acao?: ReactNode }) {
  return (
    <li style={linha}>
      <SituacaoBadge situacao={item.situacao} />
      <span style={linhaPedido}>{item.orderNumber ? `#${item.orderNumber}` : "—"}</span>
      <span style={linhaSku}>{item.sku ?? "—"}</span>
      <span style={linhaTam}>{item.tamanho ?? "—"}</span>
      <span style={linhaHora}>{hora(item.lidoEm)}</span>
      <span style={linhaEpc} title={item.epc}>
        {epcCurto(item.epc)}
      </span>
      {acao}
    </li>
  );
}

export function TabelaPorVariante({ linhas }: { linhas: PorVariante[] }) {
  if (linhas.length === 0) return <div style={vazio}>Nenhuma peça devolvível ainda.</div>;
  return (
    <table style={tabela}>
      <thead>
        <tr>
          <th style={th}>SKU</th>
          <th style={th}>Tamanho</th>
          <th style={{ ...th, textAlign: "right" }}>Qtd</th>
        </tr>
      </thead>
      <tbody>
        {linhas.map((v, i) => (
          <tr key={`${v.varianteId ?? v.ean13 ?? v.sku ?? "x"}-${i}`}>
            <td style={td}>{v.sku ?? "—"}</td>
            <td style={td}>{v.tamanho ?? "—"}</td>
            <td style={{ ...td, textAlign: "right", fontWeight: 800 }}>{v.qtd}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const REINT_VAR_LABEL: Record<ReintegracaoVarianteStatus, string> = {
  ok: "Reintegrada",
  erro: "Erro",
  sem_gid: "Sem vínculo com a Shopify",
  sem_variante: "Produto não identificado",
  incerto: "Sem confirmação da Shopify, será reenviado",
  pendente: "Pendente",
};

/**
 * Situação da reintegração ao estoque da Shopify de um lote FECHADO.
 * `onReintegrar` só aparece com `parcial`/`erro` (e destino estoque).
 */
export function ReintegracaoBloco({
  lote,
  reintegracao,
  onReintegrar,
  onAtualizar,
  ocupado,
  mensagem,
  progresso,
}: {
  lote: Pick<Lote, "destino">;
  reintegracao: Reintegracao | null;
  onReintegrar?: () => void;
  onAtualizar?: () => void;
  ocupado?: boolean;
  mensagem?: string | null;
  /** Reintegração em curso (loop de passadas): "N de M variantes". */
  progresso?: { feitas: number; total: number } | null;
}) {
  const destino = lote.destino ?? "estoque";
  if (destino !== "estoque") {
    return (
      <div style={blocoNeutro}>
        Peças não reintegradas (destino: {DESTINO_LABEL[destino]}).
      </div>
    );
  }
  if (!reintegracao) {
    return <div style={blocoNeutro}>Sem informação de reintegração para este lote.</div>;
  }
  const r = reintegracao;
  if (r.status === "desligada") {
    return (
      <div style={blocoNeutro}>
        Reintegração ao estoque da Shopify está desligada no Nexus. Os ajustes ficaram registrados.
      </div>
    );
  }
  if (r.status === "ok") {
    return (
      <div style={blocoOk}>
        {r.resumo.ok} {r.resumo.ok === 1 ? "peça reintegrada" : "peças reintegradas"} ao estoque da Shopify.
      </div>
    );
  }
  if (progresso) {
    return (
      <div style={blocoWarn}>
        Reintegrando ao estoque… {progresso.feitas} de {progresso.total} variantes
      </div>
    );
  }
  if (r.status === "em_andamento" && emAndamentoTravado(r)) {
    return (
      <div style={blocoWarn}>
        Reintegração parou no meio.{" "}
        {onReintegrar && (
          <button type="button" style={btnLink} onClick={onReintegrar} disabled={ocupado}>
            Tentar de novo
          </button>
        )}
      </div>
    );
  }
  if (r.status === "em_andamento") {
    return (
      <div style={blocoWarn}>
        Reintegração em andamento…{" "}
        {onAtualizar && (
          <button type="button" style={btnLink} onClick={onAtualizar} disabled={ocupado}>
            atualizar
          </button>
        )}
      </div>
    );
  }
  // parcial | erro | pendente (loop interrompido)
  return (
    <div style={blocoErro}>
      <strong>
        {r.status === "parcial" || r.status === "pendente"
          ? "Reintegração incompleta: algumas variantes não foram ajustadas."
          : "A reintegração ao estoque da Shopify falhou."}
      </strong>
      <table style={{ ...tabela, marginTop: 8 }}>
        <thead>
          <tr>
            <th style={th}>SKU</th>
            <th style={th}>Tamanho</th>
            <th style={{ ...th, textAlign: "right" }}>Qtd</th>
            <th style={th}>Status</th>
            <th style={th}>Erro</th>
          </tr>
        </thead>
        <tbody>
          {r.porVariante.map((v, i) => (
            <tr key={`${v.varianteId ?? v.sku ?? "x"}-${i}`}>
              <td style={td}>{v.sku ?? "—"}</td>
              <td style={td}>{v.tamanho ?? "—"}</td>
              <td style={{ ...td, textAlign: "right" }}>{v.delta}</td>
              <td style={td}>{REINT_VAR_LABEL[v.status]}</td>
              <td style={td}>{v.erro ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {mensagem && <div style={{ marginTop: 8 }}>{mensagem}</div>}
      {onReintegrar && (
        <button type="button" style={{ ...btn, marginTop: 10 }} onClick={onReintegrar} disabled={ocupado}>
          {ocupado ? "Reintegrando…" : "Tentar reintegrar de novo"}
        </button>
      )}
    </div>
  );
}

const EM_ANDAMENTO_TRAVADO_MS = 2 * 60 * 1000;

/** `em_andamento` há mais de 2 min: a estação que reintegrava provavelmente caiu. */
export function emAndamentoTravado(r: Reintegracao | null | undefined): boolean {
  if (!r || r.status !== "em_andamento" || !r.em) return false;
  const t = Date.parse(r.em);
  return Number.isFinite(t) && Date.now() - t > EM_ANDAMENTO_TRAVADO_MS;
}

/** Reintegração pode ser reaplicada? (lote fechado, destino estoque, erro/parcial) */
export function podeReintegrar(lote: Lote): boolean {
  return (
    lote.status === "fechado" &&
    (lote.destino ?? "estoque") === "estoque" &&
    (lote.reintegracao?.status === "erro" ||
      lote.reintegracao?.status === "parcial" ||
      lote.reintegracao?.status === "pendente" ||
      emAndamentoTravado(lote.reintegracao) ||
      !!lote.reintegracao?.porVariante.some((v) => v.status === "incerto"))
  );
}

export const REINT_STATUS_LABEL: Record<string, string> = {
  ok: "Reintegrado",
  parcial: "Parcial",
  pendente: "Pendente",
  erro: "Erro",
  desligada: "Desligada",
  em_andamento: "Em andamento",
};

// ---------------------------------------------------------------------------

const badge: CSSProperties = {
  display: "inline-block",
  padding: "2px 9px",
  borderRadius: 999,
  border: "1px solid",
  fontSize: 11,
  fontWeight: 800,
  whiteSpace: "nowrap",
};

const linha: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "150px 90px minmax(0, 1fr) 70px 54px 80px auto",
  alignItems: "center",
  gap: 10,
  padding: "8px 12px",
  border: "1px solid var(--border)",
  borderRadius: 10,
  background: "var(--bg-card)",
  fontSize: 13,
  color: "var(--text)",
};
const linhaPedido: CSSProperties = { fontWeight: 800 };
const linhaSku: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-secondary)" };
const linhaTam: CSSProperties = { fontWeight: 700 };
const linhaHora: CSSProperties = { fontVariantNumeric: "tabular-nums", color: "var(--text-muted)", fontSize: 12 };
const linhaEpc: CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-muted)" };

const tabela: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 13 };
const th: CSSProperties = { textAlign: "left", padding: "6px 10px", borderBottom: "1px solid var(--border-strong)", color: "var(--text-muted)", fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: 0.5 };
const td: CSSProperties = { padding: "6px 10px", borderBottom: "1px solid var(--border)", color: "var(--text)" };
const vazio: CSSProperties = { color: "var(--text-muted)", fontSize: 13, padding: 12, textAlign: "center" };

const bloco: CSSProperties = { padding: "12px 14px", borderRadius: 10, border: "1px solid", fontSize: 13 };
const blocoNeutro: CSSProperties = { ...bloco, ...TONS.neutro, color: "var(--text-secondary)" };
const blocoOk: CSSProperties = { ...bloco, ...TONS.ok };
const blocoWarn: CSSProperties = { ...bloco, ...TONS.warn };
const blocoErro: CSSProperties = { ...bloco, ...TONS.danger, color: "var(--text)" };

const btn: CSSProperties = { padding: "8px 14px", borderRadius: 8, border: "1px solid var(--border-strong)", background: "var(--bg-input)", color: "var(--text)", fontSize: 13, fontWeight: 700, cursor: "pointer" };
const btnLink: CSSProperties = { background: "transparent", border: 0, color: "inherit", textDecoration: "underline", cursor: "pointer", fontSize: 13, fontWeight: 700 };

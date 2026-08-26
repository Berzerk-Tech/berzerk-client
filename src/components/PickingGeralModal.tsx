// Picking Geral — a visão agregada da fila que o posvenda tinha atrás do
// contador de pedidos: TODOS os produtos que a fila precisa, agrupados por
// tamanho, com SKU/Produto/Qtd. É a folha que a separadora leva pra prateleira
// e traz tudo de uma vez, em vez de ir e voltar pedido a pedido.
//
// Mesma tela pra fila de puros e de mistos — muda só o agregado (no misto os
// itens vêm de tamanhos variados e as seções aparecem todas). Impressão em
// papel pelo caminho silencioso do app (lib/printer.ts + lib/pickingPdf.ts).

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { ApiError } from "../lib/api";
import { gerarPickingPdf, type PickingSecao } from "../lib/pickingPdf";
import { printPdfBase64 } from "../lib/printer";
import {
  getQueueProducts,
  type QueueFilters,
  type QueueProduct,
  type SeparationMode,
} from "../services/orders";

const SEM_TAMANHO = "SEM TAMANHO";

/** Ordem das seções: as filas reais primeiro, o resto em ordem alfabética. */
const ORDEM_TAMANHOS = ["PP", "P", "M", "G", "GG", "XG", "XXG", "G1", "G2", "G3"];

function ordemDe(t: string): number {
  const i = ORDEM_TAMANHOS.indexOf(t);
  if (i >= 0) return i;
  return t === SEM_TAMANHO ? 999 : 500;
}

type Secao = {
  tamanho: string;
  produtos: QueueProduct[];
  itens: number;
  pedidos: number;
};

type Props = {
  queue: { mode: SeparationMode; size: string };
  /** Data de emissão escolhida (YYYY-MM-DD) ou null = todas as datas. */
  data: string | null;
  /** Filtros de produto ativos — o picking mostra o que a fila mostra. */
  filters: QueueFilters;
  /** Primeiro nome de quem está operando (título da folha). */
  operadora: string;
  onClose: () => void;
};

export function PickingGeralModal({ queue, data, filters, operadora, onClose }: Props) {
  const [products, setProducts] = useState<QueueProduct[] | null>(null);
  const [resumoApi, setResumoApi] = useState<{ pedidos: number; itens: number; produtos: number } | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [imprimindo, setImprimindo] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    setProducts(null);
    setErro(null);
    getQueueProducts({
      mode: queue.mode,
      size: queue.size,
      dateFrom: data ?? undefined,
      dateTo: data ?? undefined,
    })
      .then((d) => {
        if (!alive) return;
        setProducts(d.products);
        setResumoApi(d.resumo ?? null);
      })
      .catch((e) => {
        if (!alive) return;
        setProducts([]);
        setErro(
          e instanceof ApiError && e.status === 404
            ? "O servidor ainda não lista os produtos da fila (aguardando atualização do nexus)."
            : e instanceof Error
              ? e.message
              : String(e),
        );
      });
    return () => {
      alive = false;
    };
  }, [queue.mode, queue.size, data]);

  // Filtro de produto ativo (Adição/Exclusão) vale só na fila; a lista já vem
  // da mesma consulta, então aplicamos aqui o mesmo recorte por NOME pra folha
  // não mandar buscar peça que a operadora tirou da fila.
  const visiveis = useMemo(() => {
    if (!products) return [];
    const inc = (filters.includeProducts ?? []).map((t) => t.toLowerCase());
    const exc = (filters.excludeProducts ?? []).map((t) => t.toLowerCase());
    return products.filter((p) => {
      const nome = p.nome.toLowerCase();
      if (exc.some((t) => nome.includes(t))) return false;
      if (inc.length > 0 && !inc.some((t) => nome.includes(t))) return false;
      return true;
    });
  }, [products, filters]);

  const secoes = useMemo<Secao[]>(() => {
    const mapa = new Map<string, QueueProduct[]>();
    for (const p of visiveis) {
      const t = (p.tamanho?.trim().toUpperCase() || SEM_TAMANHO) as string;
      const arr = mapa.get(t);
      if (arr) arr.push(p);
      else mapa.set(t, [p]);
    }
    return Array.from(mapa.entries())
      .map(([tamanho, produtos]) => {
        const ids = new Set<string>();
        let itens = 0;
        for (const p of produtos) {
          itens += p.quantidade;
          for (const id of p.orderIds) ids.add(id);
        }
        return {
          tamanho,
          produtos: [...produtos].sort((a, b) => b.quantidade - a.quantidade),
          itens,
          pedidos: ids.size,
        };
      })
      .sort((a, b) => ordemDe(a.tamanho) - ordemDe(b.tamanho) || a.tamanho.localeCompare(b.tamanho));
  }, [visiveis]);

  // Totais: os da API quando vierem (fila inteira), senão recalculados aqui.
  const filtrando = (filters.includeProducts?.length ?? 0) + (filters.excludeProducts?.length ?? 0) > 0;
  const total = useMemo(() => {
    if (resumoApi && !filtrando) return resumoApi;
    const ids = new Set<string>();
    let itens = 0;
    for (const p of visiveis) {
      itens += p.quantidade;
      for (const id of p.orderIds) ids.add(id);
    }
    return { produtos: visiveis.length, itens, pedidos: ids.size };
  }, [resumoApi, filtrando, visiveis]);

  const dataLabel = data ? fmtData(data) : "todas as datas";
  const subtitulo = `Todos os pedidos · ${dataLabel} · ${total.produtos} produtos • ${total.itens} itens • ${total.pedidos} pedidos`;

  const imprimir = async (apenas?: Secao) => {
    if (imprimindo) return;
    const alvo = apenas ? [apenas] : secoes;
    if (alvo.length === 0) {
      setStatus("Nada pra imprimir nesta fila.");
      return;
    }
    setImprimindo(true);
    setStatus("Enviando pra impressora…");
    try {
      const base64 = gerarPickingPdf({
        titulo: `Picking Geral — ${operadora}`,
        subtitulo: apenas
          ? `Tamanho ${apenas.tamanho} · ${dataLabel} · ${apenas.produtos.length} produtos • ${apenas.itens} itens • ${apenas.pedidos} pedidos`
          : subtitulo,
        secoes: alvo.map<PickingSecao>((s) => ({
          tamanho: s.tamanho,
          produtos: s.produtos.length,
          itens: s.itens,
          pedidos: s.pedidos,
          linhas: s.produtos.map((p) => ({
            sku: p.ean ?? "",
            produto: p.nome,
            qtd: p.quantidade,
          })),
        })),
      });
      const out = await printPdfBase64(base64, {
        jobName: apenas ? `Picking ${apenas.tamanho}` : `Picking Geral ${queue.size}`,
      });
      setStatus(
        out.ok
          ? `Enviado${out.printer ? ` pra ${out.printer}` : " pra impressora padrão"}.`
          : `Falha ao imprimir: ${out.message ?? "motivo desconhecido"}`,
      );
    } catch (e) {
      setStatus(`Falha ao imprimir: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImprimindo(false);
    }
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={box} onClick={(e) => e.stopPropagation()}>
        <div style={headerRow}>
          <div style={headerText}>
            <h2 style={titulo}>Picking Geral — {operadora}</h2>
            <span style={sub}>{products === null ? "Carregando a fila…" : subtitulo}</span>
          </div>
          <button
            style={imprimindo ? imprimirBtnOff : imprimirBtn}
            onClick={() => void imprimir()}
            disabled={imprimindo || products === null}
          >
            🖨 Imprimir Tudo
          </button>
          <button style={fecharBtn} onClick={onClose} title="Fechar (Esc)">
            ×
          </button>
        </div>

        {erro && <div style={avisoBox}>{erro}</div>}
        {status && <div style={statusBox}>{status}</div>}

        <div className="thin-scroll" style={corpo}>
          {products === null && !erro && <span style={vazio}>Carregando produtos da fila…</span>}
          {products !== null && secoes.length === 0 && !erro && (
            <span style={vazio}>Nenhum produto nesta fila com os filtros atuais.</span>
          )}
          {secoes.map((s) => (
            <section key={s.tamanho} style={secaoWrap}>
              <div style={secaoHeader}>
                <span style={tamChip}>{s.tamanho}</span>
                <span style={secaoResumo}>
                  {s.produtos.length} produtos • {s.itens} itens • {s.pedidos} pedidos
                </span>
                <div style={{ flex: 1 }} />
                <button
                  style={imprimindo ? secaoBtnOff : secaoBtn}
                  onClick={() => void imprimir(s)}
                  disabled={imprimindo}
                >
                  Imprimir {s.tamanho}
                </button>
              </div>
              <div style={tabela}>
                <div style={thRow}>
                  <span style={thSku}>SKU</span>
                  <span style={thNome}>Produto</span>
                  <span style={thQtd}>Qtd.</span>
                </div>
                {s.produtos.map((p) => (
                  <div key={`${p.nome}-${p.ean ?? ""}`} style={tdRow}>
                    <span style={tdSku}>{p.ean ?? "—"}</span>
                    <span style={tdNome}>{p.nome}</span>
                    <span style={tdQtd}>{p.quantidade}</span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function fmtData(iso: string): string {
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 60,
};

const box: CSSProperties = {
  width: 900,
  maxWidth: "96vw",
  height: "min(820px, 92vh)",
  background: "var(--bg-elevated)",
  border: "1px solid var(--border-strong)",
  borderRadius: 16,
  padding: "20px 22px",
  display: "flex",
  flexDirection: "column",
  gap: 12,
  boxSizing: "border-box",
};

const headerRow: CSSProperties = { display: "flex", alignItems: "flex-start", gap: 12 };

const headerText: CSSProperties = { display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 };

const titulo: CSSProperties = { margin: 0, fontSize: 19, fontWeight: 800, color: "var(--text)" };

const sub: CSSProperties = { fontSize: 12, color: "var(--text-secondary)" };

const imprimirBtn: CSSProperties = {
  padding: "9px 16px",
  background: "var(--success-dot)",
  border: "1px solid var(--success-dot)",
  borderRadius: 9,
  color: "#04150c",
  fontSize: 13,
  fontWeight: 800,
  cursor: "pointer",
  flexShrink: 0,
};

const imprimirBtnOff: CSSProperties = {
  ...imprimirBtn,
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  color: "var(--text-muted)",
  cursor: "wait",
};

const fecharBtn: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "var(--text-muted)",
  fontSize: 24,
  fontWeight: 700,
  cursor: "pointer",
  lineHeight: 1,
  flexShrink: 0,
};

const avisoBox: CSSProperties = {
  padding: "10px 14px",
  background: "var(--warning-bg)",
  border: "1px solid var(--warning-border)",
  borderRadius: 10,
  color: "var(--warning-text)",
  fontSize: 12,
  lineHeight: 1.4,
};

const statusBox: CSSProperties = {
  padding: "8px 14px",
  background: "var(--info-bg)",
  border: "1px solid var(--info-border)",
  borderRadius: 10,
  color: "var(--info-text)",
  fontSize: 12,
};

const corpo: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 20,
};

const vazio: CSSProperties = { fontSize: 13, color: "var(--text-muted)", padding: "12px 4px" };

const secaoWrap: CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };

const secaoHeader: CSSProperties = { display: "flex", alignItems: "center", gap: 10 };

const tamChip: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  fontWeight: 800,
  padding: "3px 14px",
  borderRadius: 999,
  background: "var(--info-bg)",
  color: "var(--info-text)",
  border: "1px solid var(--info-border)",
};

const secaoResumo: CSSProperties = { fontSize: 12, color: "var(--text-secondary)" };

const secaoBtn: CSSProperties = {
  padding: "6px 14px",
  background: "var(--bg-card)",
  border: "1px solid var(--border-strong)",
  borderRadius: 8,
  color: "var(--text)",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
};

const secaoBtnOff: CSSProperties = { ...secaoBtn, color: "var(--text-muted)", cursor: "wait" };

const tabela: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  border: "1px solid var(--border)",
  borderRadius: 10,
  overflow: "hidden",
};

const thRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "7px 12px",
  background: "var(--bg-card)",
  borderBottom: "1px solid var(--border)",
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: 1,
  textTransform: "uppercase",
  color: "var(--text-muted)",
};

const thSku: CSSProperties = { width: 130, flexShrink: 0 };
const thNome: CSSProperties = { flex: 1, minWidth: 0 };
const thQtd: CSSProperties = { width: 54, textAlign: "right", flexShrink: 0 };

const tdRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "7px 12px",
  borderBottom: "1px solid var(--border)",
  fontSize: 13,
};

const tdSku: CSSProperties = {
  ...thSku,
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--text-muted)",
};

const tdNome: CSSProperties = {
  flex: 1,
  minWidth: 0,
  color: "var(--text)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const tdQtd: CSSProperties = {
  width: 54,
  textAlign: "right",
  fontFamily: "var(--font-mono)",
  fontWeight: 800,
  color: "var(--text)",
  flexShrink: 0,
};

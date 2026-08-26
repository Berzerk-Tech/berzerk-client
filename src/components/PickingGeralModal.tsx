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
  marcarListaImpressa,
  type Order,
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

/** De onde sai o agregado: o LOTE dela (padrão) ou a fila inteira. */
type Escopo = "lote" | "fila";

type Props = {
  queue: { mode: SeparationMode; size: string; sizes: string[] };
  /** Data de emissão escolhida (YYYY-MM-DD) ou null = todas as datas. */
  data: string | null;
  /** Filtros de produto ativos — o picking mostra o que a fila mostra. */
  filters: QueueFilters;
  /** O LOTE da operadora — a folha que ela leva pra prateleira sai DAQUI. */
  lote: Order[];
  /** Primeiro nome de quem está operando (título da folha). */
  operadora: string;
  /** Avisa o runner que a lista do lote foi impressa (prende os pedidos). */
  onListaImpressa?: (orderIds: string[]) => void;
  onClose: () => void;
};

/**
 * Agrega os itens do LOTE (já em memória — nenhuma ida à rede) na mesma forma
 * que `GET /separacao/queue-products` devolve: uma linha por (nome, tamanho,
 * ean) nos mistos, por nome nos puros.
 *
 * É este o agregado que a operadora precisa: o Picking Geral vinha somando a
 * FILA INTEIRA (637 pedidos) quando a folha que ela leva pra prateleira é a
 * dos 10 (ou 50) que estão na mesa dela.
 */
function agregarLote(lote: Order[], mode: SeparationMode): QueueProduct[] {
  const acc = new Map<
    string,
    { nome: string; tamanho: string | null; ean: string | null; imagemUrl: string | null; quantidade: number; orderIds: Set<string> }
  >();
  for (const pedido of lote) {
    for (const it of pedido.items) {
      const nome = it.nome?.trim();
      if (!nome) continue;
      const tamanho = it.tamanho?.trim().toUpperCase() || null;
      const chave =
        mode === "total" ? `${nome.toUpperCase()}|${tamanho ?? ""}|${it.ean ?? ""}` : nome.toUpperCase();
      const linha = acc.get(chave);
      if (linha) {
        linha.quantidade += it.quantidade;
        linha.orderIds.add(pedido.id);
        if (!linha.ean && it.ean) linha.ean = it.ean;
        if (!linha.imagemUrl && it.imagemUrl) linha.imagemUrl = it.imagemUrl;
      } else {
        acc.set(chave, {
          nome,
          tamanho,
          ean: it.ean,
          imagemUrl: it.imagemUrl,
          quantidade: it.quantidade,
          orderIds: new Set([pedido.id]),
        });
      }
    }
  }
  return [...acc.values()]
    .map((a) => ({
      nome: a.nome,
      tamanho: a.tamanho,
      ean: a.ean,
      imagemUrl: a.imagemUrl,
      quantidade: a.quantidade,
      pedidos: a.orderIds.size,
      orderIds: [...a.orderIds],
    }))
    .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR") || (a.tamanho ?? "").localeCompare(b.tamanho ?? ""));
}

export function PickingGeralModal({
  queue,
  data,
  filters,
  lote,
  operadora,
  onListaImpressa,
  onClose,
}: Props) {
  // O LOTE é o padrão: é a folha que a operadora leva pra prateleira. "Fila
  // inteira" continua a um clique, pra quem quer ver o que ainda vem.
  const [escopo, setEscopo] = useState<Escopo>("lote");
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

  const produtosDoLote = useMemo(() => agregarLote(lote, queue.mode), [lote, queue.mode]);

  useEffect(() => {
    // Lote: agregado local, sem rede — os pedidos já estão em memória.
    if (escopo === "lote") {
      setErro(null);
      setProducts(produtosDoLote);
      setResumoApi({
        pedidos: lote.length,
        itens: produtosDoLote.reduce((a, p) => a + p.quantidade, 0),
        produtos: produtosDoLote.length,
      });
      return;
    }
    let alive = true;
    setProducts(null);
    setErro(null);
    getQueueProducts({
      mode: queue.mode,
      size: queue.size,
      // BUCKET da fila: `XG` cobre XXG/G1/G2/G3 — sem o plural a folha da fila
      // mostrava só o tamanho-rótulo, uma fila diferente da que ela separa.
      sizes: queue.sizes,
      dateFrom: data ?? undefined,
      dateTo: data ?? undefined,
      filters,
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
    // `filters` entra por referência estável do runner (state) — o efeito só
    // roda de novo quando a operadora troca o filtro, que é o que se quer.
  }, [escopo, produtosDoLote, lote.length, queue.mode, queue.size, queue.sizes, data, filters]);

  // Recorte por NOME, defensivo: desde 26/08 o nexus aplica os filtros de
  // produto no próprio `queue-products`, e o LOTE já nasceu filtrado. Isto
  // sobra pra nexus antigo, que ignora os campos e devolveria a fila inteira.
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
  const escopoLabel = escopo === "lote" ? "Meu lote" : "Fila inteira";
  const subtitulo = `${escopoLabel} · ${dataLabel} · ${total.produtos} produtos • ${total.itens} itens • ${total.pedidos} pedidos`;

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
      // Lista do LOTE impressa ⇒ os pedidos ficam PRESOS na mesa dela: a coleta
      // dos mistos leva o dia e o janitor de 15 min devolveria tudo pra fila no
      // meio do caminho. Best-effort: falhar aqui não desfaz a impressão.
      let presos = 0;
      if (out.ok && escopo === "lote") {
        const ids = lote.map((o) => o.id);
        presos = (await marcarListaImpressa(ids).catch(() => ({ presos: 0 }))).presos;
        if (presos > 0) onListaImpressa?.(ids);
      }
      setStatus(
        out.ok
          ? `Enviado${out.printer ? ` pra ${out.printer}` : " pra impressora padrão"}.` +
            (presos > 0 ? ` ${presos} pedidos ficam reservados até você concluir ou devolver.` : "")
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
          <div style={escopoTabs}>
            {(["lote", "fila"] as const).map((e) => (
              <button
                key={e}
                style={escopo === e ? escopoTabOn : escopoTab}
                onClick={() => setEscopo(e)}
                disabled={imprimindo}
              >
                {e === "lote" ? `Meu lote (${lote.length})` : "Fila inteira"}
              </button>
            ))}
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

const escopoTabs: CSSProperties = {
  display: "inline-flex",
  gap: 3,
  padding: 3,
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  flexShrink: 0,
};

const escopoTab: CSSProperties = {
  padding: "7px 14px",
  background: "transparent",
  border: 0,
  borderRadius: 8,
  color: "var(--text-secondary)",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
  fontFamily: "inherit",
};

const escopoTabOn: CSSProperties = {
  ...escopoTab,
  background: "var(--info-bg)",
  color: "var(--info-text)",
};

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

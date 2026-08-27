// Histórico do DIA da mesa de expedição — o que saiu, a que horas, por quem,
// e o botão de reimpressão.
//
// Existe por causa do 27/08 em produção: quando a impressora trava, o papel
// não sai e o embalador não tem saída. Bipar as peças de novo só responde "o
// pedido já foi expedido, tire da mesa" — e reimprimir passava por mandar o
// pedido de volta pra separação. Daqui ele reimprime direto.
//
// Duas diferenças de propósito em relação ao Histórico da Separação:
//
// 1. **Começa no DIA (não em 7 dias).** Reimpressão é sempre sobre o pedido
//    que acabou de sair; o período mais largo existe pro caso raro.
// 2. **Tem o toggle "toda a estação".** O turno troca no meio do dia e quem
//    está na mesa precisa reimprimir o que o colega expediu — por isso a lista
//    mostra QUEM expediu, e não só a hora.
//
// A reimpressão é de UM documento só, escolhido pela CONTA do pedido (JT →
// etiqueta J&T, FM → DANFE simplificada), igual à mesa e igual ao legado: a
// máquina de embalagem solta um saco por etiqueta impressa.

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { ApiError } from "../lib/api";
import { documentoDaConta, imprimirDocumentoDoPedido } from "../lib/reimpressao";
import { getExpedicaoHistory, type ExpedicaoHistoryResponse } from "../services/expedicao";

const PAGE_SIZE = 20;

type Periodo = "hoje" | "ontem" | "7d" | "manual";

function isoDia(diasAtras: number): string {
  const d = new Date();
  d.setDate(d.getDate() - diasAtras);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function rangeDoPeriodo(p: Periodo): { dateFrom?: string; dateTo?: string } {
  switch (p) {
    case "hoje":
      return { dateFrom: isoDia(0), dateTo: isoDia(0) };
    case "ontem":
      return { dateFrom: isoDia(1), dateTo: isoDia(1) };
    case "7d":
      return { dateFrom: isoDia(7) };
    case "manual":
      return {};
  }
}

function hora(iso: string): string {
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function dia(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

/** "luiz.fernando@berzerk.com.br" → "luiz.fernando" (a coluna é estreita). */
function curto(nome: string | null): string {
  if (!nome) return "—";
  return nome.includes("@") ? nome.split("@")[0]! : nome;
}

export function ExpedicaoHistoryModal({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<ExpedicaoHistoryResponse | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [periodo, setPeriodo] = useState<Periodo>("hoje");
  const [manualFrom, setManualFrom] = useState("");
  const [manualTo, setManualTo] = useState("");
  const [todos, setTodos] = useState(false);
  const [page, setPage] = useState(0);
  /** Id do pedido com job em voo — trava só aquele botão. */
  const [imprimindo, setImprimindo] = useState<string | null>(null);
  const [aviso, setAviso] = useState<{ ok: boolean; texto: string } | null>(null);

  // ESC fecha (mesmo padrão do histórico da separação).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Debounce da busca (quem filtra é o servidor).
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(search.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const range =
      periodo === "manual"
        ? { dateFrom: manualFrom || undefined, dateTo: manualTo || undefined }
        : rangeDoPeriodo(periodo);
    getExpedicaoHistory({
      q: q.length >= 2 ? q : undefined,
      ...range,
      todos,
      limit: PAGE_SIZE,
      offset: page * PAGE_SIZE,
    })
      .then((d) => {
        if (!alive) return;
        setData(d);
        setErro(null);
      })
      .catch((e) => {
        if (!alive) return;
        if (e instanceof ApiError && e.status === 404) {
          setErro("O servidor ainda não tem o Histórico da expedição (aguardando atualização do nexus).");
        } else {
          setErro(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [q, periodo, manualFrom, manualTo, todos, page]);

  const reimprimir = useCallback(
    async (order: { id: string; numero: string | null; tinyAccount: string }) => {
      setImprimindo(order.id);
      setAviso(null);
      const r = await imprimirDocumentoDoPedido(order, "historico");
      setImprimindo((atual) => (atual === order.id ? null : atual));
      setAviso({ ok: r.ok, texto: r.mensagem });
    },
    [],
  );

  const totalPaginas = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div style={overlay} onClick={onClose}>
      <div style={box} onClick={(e) => e.stopPropagation()}>
        <div style={headerRow}>
          <h2 style={titulo}>🕐 Histórico da expedição</h2>
          <button style={fecharBtn} onClick={onClose} title="Fechar">
            ×
          </button>
        </div>

        {data && (
          <div style={totaisRow}>
            <span>📦 {data.totals.pedidos} pedidos</span>
            <span>·</span>
            <span>{data.totals.itens} itens</span>
            <span>·</span>
            <span>🏷 {data.totals.tags} tags</span>
          </div>
        )}

        {aviso && <div style={aviso.ok ? avisoOk : avisoErro}>{aviso.texto}</div>}

        <input
          style={buscaInput}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por pedido, cliente, SKU ou tag RFID…"
          spellCheck={false}
        />

        <div style={chipsRow}>
          {(
            [
              ["hoje", "Hoje"],
              ["ontem", "Ontem"],
              ["7d", "7 dias"],
              ["manual", "Manual"],
            ] as [Periodo, string][]
          ).map(([p, label]) => (
            <button
              key={p}
              style={periodo === p ? chipOn : chip}
              onClick={() => {
                setPeriodo(p);
                setPage(0);
              }}
            >
              {label}
            </button>
          ))}
          {periodo === "manual" && (
            <>
              <input
                type="date"
                style={dataInput}
                value={manualFrom}
                onChange={(e) => {
                  setManualFrom(e.target.value);
                  setPage(0);
                }}
              />
              <span style={{ color: "var(--text-muted)", fontSize: 12 }}>—</span>
              <input
                type="date"
                style={dataInput}
                value={manualTo}
                onChange={(e) => {
                  setManualTo(e.target.value);
                  setPage(0);
                }}
              />
            </>
          )}
          <div style={{ flex: 1 }} />
          <button
            style={todos ? chipOn : chip}
            onClick={() => {
              setTodos((v) => !v);
              setPage(0);
            }}
            title="Mostrar o que a estação inteira expediu, não só o que eu expedi"
          >
            {todos ? "👥 Toda a estação" : "👤 Só o meu"}
          </button>
        </div>

        <div style={lista}>
          {erro && <div style={erroBox}>{erro}</div>}
          {!erro && loading && !data && <span style={vazio}>Carregando…</span>}
          {!erro && data && data.items.length === 0 && (
            <span style={vazio}>Nenhum pedido expedido no período.</span>
          )}
          {!erro &&
            data?.items.map((o) => {
              // JT imprime a etiqueta da transportadora; FM imprime a DANFE
              // simplificada — que É a etiqueta desses pedidos.
              const documento = documentoDaConta(o.tinyAccount);
              const disponivel = documento === "etiqueta" ? o.temEtiqueta : o.temDanfe;
              return (
                <div key={o.id} style={pedidoCard}>
                  <div style={pedidoHeader}>
                    <span style={horaBadge} title={new Date(o.shippedAt).toLocaleString("pt-BR")}>
                      {hora(o.shippedAt)}
                    </span>
                    <span style={pedidoNumero}>#{o.numero ?? o.id.slice(0, 8)}</span>
                    {o.clienteNome && <span style={cliente}>{o.clienteNome}</span>}
                    <div style={{ flex: 1 }} />
                    <span style={quem} title={o.shippedByNome ?? o.shippedBy ?? ""}>
                      {curto(o.shippedByNome)}
                    </span>
                  </div>

                  <div style={metaRow}>
                    <span>{dia(o.shippedAt)}</span>
                    <span>·</span>
                    <span>
                      {o.itemCount} {o.itemCount === 1 ? "item" : "itens"}
                    </span>
                    {o.trackingNumber && (
                      <>
                        <span>·</span>
                        <code style={rastreio}>{o.trackingNumber}</code>
                      </>
                    )}
                  </div>

                  <div style={acoesRow}>
                    <button
                      style={disponivel ? reimprimirBtn : reimprimirBtnOff}
                      disabled={!disponivel || imprimindo === o.id}
                      onClick={() => void reimprimir(o)}
                      title={
                        disponivel
                          ? "Manda o documento pra impressora de etiquetas de novo"
                          : documento === "etiqueta"
                            ? "Este pedido não tem etiqueta J&T disponível"
                            : "Este pedido não tem nota fiscal"
                      }
                    >
                      {imprimindo === o.id
                        ? "Imprimindo…"
                        : documento === "etiqueta"
                          ? "↻ Reimprimir etiqueta"
                          : "↻ Reimprimir DANFE"}
                    </button>
                    <span style={contaBadge}>{o.tinyAccount}</span>
                  </div>
                </div>
              );
            })}
        </div>

        <div style={footerRow}>
          <span style={paginacao}>
            {data ? `Página ${page + 1} de ${totalPaginas} · ${data.total} pedidos` : ""}
          </span>
          <div style={{ flex: 1 }} />
          <button
            style={page > 0 ? navBtn : navBtnOff}
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            ‹
          </button>
          <button
            style={page + 1 < totalPaginas ? navBtn : navBtnOff}
            disabled={page + 1 >= totalPaginas}
            onClick={() => setPage((p) => p + 1)}
          >
            ›
          </button>
        </div>
      </div>
    </div>
  );
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
  width: 720,
  maxWidth: "94vw",
  height: "min(760px, 90vh)",
  background: "var(--bg-elevated)",
  border: "1px solid var(--border-strong)",
  borderRadius: 16,
  padding: "20px 22px",
  display: "flex",
  flexDirection: "column",
  gap: 12,
  boxSizing: "border-box",
};

const headerRow: CSSProperties = { display: "flex", alignItems: "center", gap: 10 };

const titulo: CSSProperties = {
  margin: 0,
  fontSize: 18,
  fontWeight: 800,
  color: "var(--text)",
  flex: 1,
};

const fecharBtn: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "var(--text-muted)",
  fontSize: 24,
  fontWeight: 700,
  cursor: "pointer",
  lineHeight: 1,
};

const totaisRow: CSSProperties = {
  display: "flex",
  gap: 8,
  fontSize: 13,
  color: "var(--text-secondary)",
  fontWeight: 600,
};

const avisoBase: CSSProperties = {
  padding: "8px 12px",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
};

const avisoOk: CSSProperties = {
  ...avisoBase,
  background: "var(--success-bg)",
  border: "1px solid var(--success-border)",
  color: "var(--success-text)",
};

const avisoErro: CSSProperties = {
  ...avisoBase,
  background: "var(--danger-bg)",
  border: "1px solid var(--danger-border)",
  color: "var(--danger-text)",
};

const buscaInput: CSSProperties = {
  padding: "10px 14px",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  color: "var(--text)",
  fontSize: 14,
  outline: "none",
};

const chipsRow: CSSProperties = { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" };

const chip: CSSProperties = {
  padding: "5px 11px",
  borderRadius: 999,
  border: "1px solid var(--border)",
  background: "var(--bg-card)",
  color: "var(--text-muted)",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
};

const chipOn: CSSProperties = {
  ...chip,
  background: "var(--info-bg)",
  borderColor: "var(--info-border)",
  color: "var(--info-text)",
};

const dataInput: CSSProperties = {
  padding: "4px 8px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--bg-input)",
  color: "var(--text)",
  fontSize: 12,
};

const lista: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const erroBox: CSSProperties = {
  padding: 12,
  borderRadius: 10,
  background: "var(--warning-bg)",
  border: "1px solid var(--warning-border)",
  color: "var(--warning-text)",
  fontSize: 13,
};

const vazio: CSSProperties = {
  color: "var(--text-muted)",
  fontSize: 13,
  padding: 16,
  textAlign: "center",
};

const pedidoCard: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: "10px 12px",
  background: "var(--bg-card)",
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const pedidoHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
};

const horaBadge: CSSProperties = {
  fontVariantNumeric: "tabular-nums",
  fontSize: 15,
  fontWeight: 800,
  color: "var(--info-text)",
};

const pedidoNumero: CSSProperties = { fontSize: 14, fontWeight: 800, color: "var(--text)" };

const cliente: CSSProperties = {
  fontSize: 12,
  color: "var(--text-secondary)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  maxWidth: 220,
};

const quem: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "var(--text-muted)",
  padding: "2px 8px",
  borderRadius: 999,
  border: "1px solid var(--border)",
};

const metaRow: CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "center",
  fontSize: 11,
  color: "var(--text-muted)",
  flexWrap: "wrap",
};

const rastreio: CSSProperties = { fontSize: 11, color: "var(--text-secondary)" };

const acoesRow: CSSProperties = { display: "flex", gap: 8, flexWrap: "wrap" };

const reimprimirBtn: CSSProperties = {
  padding: "6px 12px",
  borderRadius: 8,
  border: "1px solid var(--border-strong)",
  background: "var(--bg-input)",
  color: "var(--text)",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
};

const reimprimirBtnOff: CSSProperties = {
  ...reimprimirBtn,
  opacity: 0.4,
  cursor: "not-allowed",
};

const contaBadge: CSSProperties = {
  alignSelf: "center",
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: 0.5,
  color: "var(--text-muted)",
};

const footerRow: CSSProperties = { display: "flex", alignItems: "center", gap: 8 };

const paginacao: CSSProperties = { fontSize: 12, color: "var(--text-muted)" };

const navBtn: CSSProperties = {
  padding: "4px 12px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "var(--bg-card)",
  color: "var(--text)",
  fontSize: 16,
  fontWeight: 800,
  cursor: "pointer",
};

const navBtnOff: CSSProperties = { ...navBtn, opacity: 0.35, cursor: "not-allowed" };

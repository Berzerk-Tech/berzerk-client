// Histórico da operadora (paridade com o "Histórico" do posvenda): pedidos
// separados POR ELA, com busca (pedido, SKU, produto ou tag RFID), chips de
// período e as tags vinculadas de cada pedido. Dados do nexus
// (GET /separacao/history — totais do período inteiro, lista paginada).
// Degrada com aviso amigável enquanto o nexus não tiver o endpoint.

import { useEffect, useState, type CSSProperties } from "react";
import { ApiError } from "../lib/api";
import { miniatura } from "../lib/imagens";
import { getHistory, type HistoryResponse } from "../services/orders";

const PAGE_SIZE = 20;

type Periodo = "hoje" | "ontem" | "7d" | "15d" | "30d" | "manual";

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
    case "15d":
      return { dateFrom: isoDia(15) };
    case "30d":
      return { dateFrom: isoDia(30) };
    case "manual":
      return {};
  }
}

export function SeparacaoHistoryModal({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [periodo, setPeriodo] = useState<Periodo>("7d");
  const [manualFrom, setManualFrom] = useState("");
  const [manualTo, setManualTo] = useState("");
  const [page, setPage] = useState(0);

  // ESC fecha (padrão do posvenda que as atendentes esperam).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Debounce da busca (o servidor é quem filtra).
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
    getHistory({
      q: q.length >= 2 ? q : undefined,
      ...range,
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
          setErro(
            "O servidor ainda não tem o Histórico habilitado (aguardando atualização do nexus).",
          );
        } else {
          setErro(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [q, periodo, manualFrom, manualTo, page]);

  const totalPaginas = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  return (
    <div style={overlay} onClick={onClose}>
      <div style={box} onClick={(e) => e.stopPropagation()}>
        <div style={headerRow}>
          <h2 style={titulo}>🕐 Histórico</h2>
          <button style={fecharBtn} onClick={onClose} title="Fechar">
            ×
          </button>
        </div>
        {data && (
          <div style={totaisRow}>
            <span>📦 {data.totals.pedidos} pedidos</span>
            <span>·</span>
            <span>{data.totals.itens} itens separados</span>
            <span>·</span>
            <span>🏷 {data.totals.tags} tags vinculadas</span>
          </div>
        )}

        <input
          style={buscaInput}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por pedido, SKU, produto ou tag RFID…"
          spellCheck={false}
        />

        <div style={chipsRow}>
          {(
            [
              ["hoje", "Hoje"],
              ["ontem", "Ontem"],
              ["7d", "7 dias"],
              ["15d", "15 dias"],
              ["30d", "30 dias"],
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
        </div>

        <div style={lista}>
          {erro && <div style={erroBox}>{erro}</div>}
          {!erro && loading && !data && <span style={vazio}>Carregando…</span>}
          {!erro && data && data.items.length === 0 && (
            <span style={vazio}>Nenhum pedido separado no período.</span>
          )}
          {!erro &&
            data?.items.map((o) => (
              <div key={o.id} style={pedidoCard}>
                <div style={pedidoHeader}>
                  <span style={pedidoNumero}>#{o.numero ?? o.id.slice(0, 8)}</span>
                  {o.prioritario && <span style={badgePrio}>Prio</span>}
                  {o.separationMode === "total" && <span style={badgeMisto}>Misto</span>}
                  {o.predominantSize && <span style={badgeTam}>{o.predominantSize}</span>}
                  {o.clienteNome && <span style={cliente}>{o.clienteNome}</span>}
                  <span style={pedidoData}>
                    {o.itemCount} {o.itemCount === 1 ? "item" : "itens"} ·{" "}
                    {new Date(o.separatedAt).toLocaleString("pt-BR", {
                      day: "2-digit",
                      month: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
                {o.rfidTags.length > 0 && (
                  <div style={tagsWrap}>
                    <span style={tagsLabel}>TAGS VINCULADAS ({o.rfidTags.length})</span>
                    <div style={tagsRow}>
                      {o.rfidTags.map((t, i) => (
                        <span key={`${t}-${i}`} style={tagChip}>
                          {t}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
                <div style={itensRow}>
                  {o.items.map((it) => (
                    <div key={it.id} style={itemRow}>
                      {it.imagemUrl ? (
                        <img
                          src={miniatura(it.imagemUrl) ?? undefined}
                          alt=""
                          style={itemThumb}
                          loading="lazy"
                          decoding="async"
                        />
                      ) : (
                        <div style={itemThumbEmpty}>?</div>
                      )}
                      <div style={itemInfo}>
                        <span style={itemNome}>
                          {it.nome ?? it.sku ?? "Item"}
                          {it.quantidade > 1 ? `  ×${it.quantidade}` : ""}
                        </span>
                        <span style={itemEan}>{it.ean ?? it.sku ?? "—"}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
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
  width: 680,
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

const titulo: CSSProperties = { margin: 0, fontSize: 18, fontWeight: 800, color: "var(--text)", flex: 1 };

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

const buscaInput: CSSProperties = {
  padding: "10px 14px",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  color: "var(--text)",
  fontSize: 13,
  outline: "none",
};

const chipsRow: CSSProperties = { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6 };

const chip: CSSProperties = {
  padding: "4px 12px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 999,
  color: "var(--text-secondary)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const chipOn: CSSProperties = {
  ...chip,
  background: "var(--info-bg)",
  border: "1px solid var(--info-border)",
  color: "var(--info-text)",
};

const dataInput: CSSProperties = {
  padding: "4px 8px",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
  colorScheme: "dark",
};

const lista: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const vazio: CSSProperties = { fontSize: 13, color: "var(--text-muted)", padding: "16px 4px" };

const erroBox: CSSProperties = {
  padding: "12px 16px",
  background: "var(--warning-bg)",
  border: "1px solid var(--warning-border)",
  borderRadius: 10,
  color: "var(--warning-text)",
  fontSize: 13,
};

const pedidoCard: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: "12px 14px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
};

const pedidoHeader: CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" };

const pedidoNumero: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 15,
  fontWeight: 800,
  color: "var(--text)",
};

const badgePrio: CSSProperties = {
  fontSize: 9,
  fontWeight: 800,
  letterSpacing: 1,
  textTransform: "uppercase",
  padding: "1px 8px",
  borderRadius: 999,
  background: "var(--danger-bg)",
  color: "var(--danger-text)",
  border: "1px solid var(--danger-border)",
};

const badgeMisto: CSSProperties = {
  ...badgePrio,
  background: "var(--warning-bg)",
  color: "var(--warning-text)",
  border: "1px solid var(--warning-border)",
};

const badgeTam: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  fontWeight: 700,
  padding: "1px 8px",
  borderRadius: 999,
  background: "var(--bg-input)",
  color: "var(--text)",
  border: "1px solid var(--border-strong)",
};

const cliente: CSSProperties = {
  fontSize: 12,
  color: "var(--text-secondary)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const pedidoData: CSSProperties = {
  marginLeft: "auto",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--text-muted)",
  flexShrink: 0,
};

const tagsWrap: CSSProperties = { display: "flex", flexDirection: "column", gap: 5 };

const tagsLabel: CSSProperties = {
  fontSize: 9,
  fontWeight: 800,
  letterSpacing: 1,
  color: "var(--text-faint)",
};

const tagsRow: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 5 };

const tagChip: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  padding: "2px 8px",
  borderRadius: 6,
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  color: "var(--text-secondary)",
};

const itensRow: CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };

const itemRow: CSSProperties = { display: "flex", alignItems: "center", gap: 10 };

const itemThumb: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 6,
  objectFit: "cover",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  flexShrink: 0,
};

const itemThumbEmpty: CSSProperties = {
  ...itemThumb,
  display: "grid",
  placeItems: "center",
  color: "var(--text-faint)",
  fontSize: 14,
  fontWeight: 700,
};

const itemInfo: CSSProperties = { display: "flex", flexDirection: "column", minWidth: 0 };

const itemNome: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const itemEan: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  color: "var(--text-muted)",
};

const footerRow: CSSProperties = { display: "flex", alignItems: "center", gap: 8 };

const paginacao: CSSProperties = { fontSize: 12, color: "var(--text-muted)" };

const navBtn: CSSProperties = {
  width: 32,
  height: 32,
  display: "grid",
  placeItems: "center",
  background: "var(--bg-card)",
  border: "1px solid var(--border-strong)",
  borderRadius: 8,
  color: "var(--text)",
  fontSize: 16,
  fontWeight: 700,
  cursor: "pointer",
};

const navBtnOff: CSSProperties = {
  ...navBtn,
  color: "var(--text-faint)",
  cursor: "not-allowed",
  border: "1px solid var(--border)",
};

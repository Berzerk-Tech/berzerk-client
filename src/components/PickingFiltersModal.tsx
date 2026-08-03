// Filtro Inteligente de picking — MESMO formato do SmartFilter do posvenda:
// lista dos PRODUTOS presentes na fila com checkbox (foto, tamanho, quantidade,
// nº de pedidos), busca, e o rodapé dizendo quantos pedidos serão ocultados.
// Duas abas: Exclusão ("marque o que você NÃO tem" — pedidos com eles somem)
// e Adição (só pedidos com os marcados aparecem). Janela de data de emissão
// no topo. Tudo vale pra FILA e pro CLAIM (o nexus aplica as mesmas condições)
// e persiste por estação. ESC fecha. Nexus antigo (sem /queue-products)
// degrada pra entrada manual de termos.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { ApiError } from "../lib/api";
import {
  getQueueProducts,
  type QueueFilters,
  type QueueProduct,
  type SeparationMode,
} from "../services/orders";

const STORAGE_KEY = "berzerk_picking_filters_v1";

export function emptyFilters(): QueueFilters {
  return {};
}

export function loadFilters(): QueueFilters {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const f = JSON.parse(raw) as QueueFilters;
    return {
      dateFrom: typeof f.dateFrom === "string" ? f.dateFrom : undefined,
      dateTo: typeof f.dateTo === "string" ? f.dateTo : undefined,
      includeProducts: Array.isArray(f.includeProducts) ? f.includeProducts : undefined,
      excludeProducts: Array.isArray(f.excludeProducts) ? f.excludeProducts : undefined,
    };
  } catch {
    return {};
  }
}

export function saveFilters(f: QueueFilters): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(f));
  } catch {
    /* localStorage indisponível: filtros valem só na sessão */
  }
}

function hojeISO(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function diasAtrasISO(dias: number): string {
  const d = new Date();
  d.setDate(d.getDate() - dias);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

type Aba = "exclusao" | "adicao";

type Props = {
  filters: QueueFilters;
  /** Fila ativa — busca os produtos DELA (mesma visão da sidebar). */
  queue?: { mode: SeparationMode; size: string };
  onApply: (f: QueueFilters) => void;
  onClear: () => void;
  onClose: () => void;
};

export function PickingFiltersModal({ filters, queue, onApply, onClear, onClose }: Props) {
  const [dateFrom, setDateFrom] = useState(filters.dateFrom ?? "");
  const [dateTo, setDateTo] = useState(filters.dateTo ?? "");
  const [exclude, setExclude] = useState<string[]>(filters.excludeProducts ?? []);
  const [include, setInclude] = useState<string[]>(filters.includeProducts ?? []);
  const [aba, setAba] = useState<Aba>("exclusao");
  const [search, setSearch] = useState("");
  const [manual, setManual] = useState("");
  const [products, setProducts] = useState<QueueProduct[] | null>(null);
  const [prodErro, setProdErro] = useState<string | null>(null);

  // ESC fecha (as atendentes esperam isso do posvenda).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Produtos da fila (refaz quando a janela de data muda — a lista deve
  // refletir exatamente o que a operadora está vendo).
  useEffect(() => {
    if (!queue) return;
    let alive = true;
    setProdErro(null);
    getQueueProducts({
      mode: queue.mode,
      size: queue.size,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
    })
      .then((d) => alive && setProducts(d.products))
      .catch((e) => {
        if (!alive) return;
        setProducts([]);
        setProdErro(
          e instanceof ApiError && e.status === 404
            ? "O servidor ainda não lista os produtos da fila (aguardando atualização do nexus) — dá pra filtrar digitando o nome abaixo."
            : e instanceof Error
              ? e.message
              : String(e),
        );
      });
    return () => {
      alive = false;
    };
  }, [queue, dateFrom, dateTo]);

  const selected = aba === "exclusao" ? exclude : include;
  const setSelected = aba === "exclusao" ? setExclude : setInclude;
  const selectedLower = useMemo(() => new Set(selected.map((t) => t.toLowerCase())), [selected]);

  const filtered = useMemo(() => {
    if (!products) return [];
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) => p.nome.toLowerCase().includes(q) || (p.ean ?? "").toLowerCase().includes(q),
    );
  }, [products, search]);

  const toggle = (nome: string) => {
    setSelected((prev) =>
      prev.some((t) => t.toLowerCase() === nome.toLowerCase())
        ? prev.filter((t) => t.toLowerCase() !== nome.toLowerCase())
        : [...prev, nome],
    );
  };

  // Termos marcados que NÃO estão na lista atual (persistidos de outra fila,
  // ou digitados à mão) — chips removíveis, senão ficam invisíveis.
  const orfaos = useMemo(() => {
    const nomes = new Set((products ?? []).map((p) => p.nome.toLowerCase()));
    return selected.filter((t) => !nomes.has(t.toLowerCase()));
  }, [selected, products]);

  /** Pedidos afetados pela seleção da aba ativa (união dos orderIds). */
  const pedidosAfetados = useMemo(() => {
    if (!products || selected.length === 0) return 0;
    const ids = new Set<string>();
    for (const p of products) {
      if (selectedLower.has(p.nome.toLowerCase())) for (const id of p.orderIds) ids.add(id);
    }
    return ids.size;
  }, [products, selected, selectedLower]);

  const addManual = () => {
    const t = manual.trim();
    if (t.length < 2) return;
    toggle(t);
    setManual("");
  };

  const aplicar = () => {
    onApply({
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      excludeProducts: exclude.length ? exclude : undefined,
      includeProducts: include.length ? include : undefined,
    });
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={box} onClick={(e) => e.stopPropagation()}>
        <div style={headerRow}>
          <h2 style={titulo}>Filtro Inteligente</h2>
          {queue && <span style={filaChip}>Fila {queue.size}</span>}
          <div style={{ flex: 1 }} />
          <button style={fecharBtn} onClick={onClose} title="Fechar (Esc)">
            ×
          </button>
        </div>

        <div style={datasRow}>
          <span style={secaoTitulo}>Emissão</span>
          <button
            style={chip}
            onClick={() => {
              setDateFrom(hojeISO());
              setDateTo(hojeISO());
            }}
          >
            Hoje
          </button>
          <button
            style={chip}
            onClick={() => {
              setDateFrom(diasAtrasISO(7));
              setDateTo("");
            }}
          >
            7 dias
          </button>
          <button
            style={chip}
            onClick={() => {
              setDateFrom("");
              setDateTo("");
            }}
          >
            Tudo
          </button>
          <input
            type="date"
            style={dataInput}
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
          />
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>—</span>
          <input
            type="date"
            style={dataInput}
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
          />
        </div>

        <div style={abasRow}>
          <button style={aba === "exclusao" ? abaOn : abaOff} onClick={() => setAba("exclusao")}>
            Filtro Exclusão{exclude.length > 0 ? ` (${exclude.length})` : ""}
          </button>
          <button style={aba === "adicao" ? abaOn : abaOff} onClick={() => setAba("adicao")}>
            Filtro Adição{include.length > 0 ? ` (${include.length})` : ""}
          </button>
        </div>
        <p style={abaHint}>
          {aba === "exclusao" ? (
            <>
              Marque os itens que você <strong>não tem</strong> — pedidos que os contêm{" "}
              <strong>somem</strong> da fila e do claim.
            </>
          ) : (
            <>
              Marque produtos pra ver <strong>só</strong> pedidos que os contêm.
            </>
          )}
        </p>

        <input
          style={buscaInput}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar produto ou EAN…"
          spellCheck={false}
        />

        <div style={lista}>
          {prodErro && <div style={avisoBox}>{prodErro}</div>}
          {!prodErro && products === null && <span style={vazio}>Carregando produtos da fila…</span>}
          {!prodErro && products !== null && filtered.length === 0 && (
            <span style={vazio}>Nenhum produto encontrado nesta fila.</span>
          )}
          {filtered.map((p) => {
            const marcado = selectedLower.has(p.nome.toLowerCase());
            return (
              <button key={p.nome} style={marcado ? rowOn : row} onClick={() => toggle(p.nome)}>
                <span style={marcado ? checkOn : checkOff}>{marcado ? "✓" : ""}</span>
                {p.imagemUrl ? (
                  <img
                    src={p.imagemUrl}
                    alt=""
                    style={{ ...thumb, ...(marcado ? thumbOff : null) }}
                    loading="lazy"
                  />
                ) : (
                  <span style={thumbEmpty}>?</span>
                )}
                <span style={{ ...rowNome, ...(marcado && aba === "exclusao" ? rowNomeOff : null) }}>
                  {p.nome}
                </span>
                {p.tamanho && <span style={tamChip}>{p.tamanho}</span>}
                <span style={qtdChip}>{p.quantidade}x</span>
                <span style={pedChip}>
                  {p.pedidos} ped{p.pedidos === 1 ? "" : "s"}
                </span>
              </button>
            );
          })}
          {orfaos.length > 0 && (
            <div style={orfaosWrap}>
              <span style={secaoTitulo}>Marcados fora desta lista</span>
              <div style={orfaosRow}>
                {orfaos.map((t) => (
                  <span key={t} style={orfaoChip}>
                    {t}
                    <button style={orfaoRemove} onClick={() => toggle(t)} title="Remover">
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        <div style={manualRow}>
          <input
            style={manualInput}
            value={manual}
            placeholder="Adicionar termo manual (ex.: Moletom)…"
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addManual();
              }
            }}
            spellCheck={false}
          />
          <button style={addBtn} onClick={addManual}>
            Adicionar
          </button>
        </div>

        <div style={acoesRow}>
          <span style={rodapeInfo}>
            {selected.length > 0 ? (
              aba === "exclusao" ? (
                <>
                  <strong style={{ color: "var(--danger-text)" }}>{selected.length}</strong>{" "}
                  marcado{selected.length === 1 ? "" : "s"} ·{" "}
                  <strong>{pedidosAfetados}</strong> pedido{pedidosAfetados === 1 ? "" : "s"}{" "}
                  ser{pedidosAfetados === 1 ? "á" : "ão"} ocultado{pedidosAfetados === 1 ? "" : "s"}
                </>
              ) : (
                <>
                  <strong>{pedidosAfetados}</strong> pedido{pedidosAfetados === 1 ? "" : "s"}{" "}
                  fica{pedidosAfetados === 1 ? "" : "m"} visív{pedidosAfetados === 1 ? "el" : "eis"}
                </>
              )
            ) : (
              "Nenhum item marcado"
            )}
          </span>
          <div style={{ flex: 1 }} />
          <button style={limparBtn} onClick={onClear}>
            Limpar tudo
          </button>
          <button style={cancelarBtn} onClick={onClose}>
            Cancelar
          </button>
          <button style={aplicarBtn} onClick={aplicar}>
            Aplicar filtros
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
  width: 620,
  maxWidth: "94vw",
  height: "min(720px, 90vh)",
  background: "var(--bg-elevated)",
  border: "1px solid var(--border-strong)",
  borderRadius: 16,
  padding: "20px 22px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  boxSizing: "border-box",
};

const headerRow: CSSProperties = { display: "flex", alignItems: "center", gap: 10 };

const titulo: CSSProperties = { margin: 0, fontSize: 18, fontWeight: 800, color: "var(--text)" };

const filaChip: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  fontWeight: 700,
  padding: "2px 10px",
  borderRadius: 999,
  background: "var(--info-bg)",
  color: "var(--info-text)",
  border: "1px solid var(--info-border)",
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

const secaoTitulo: CSSProperties = {
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: 1,
  textTransform: "uppercase",
  color: "var(--text-muted)",
};

const datasRow: CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" };

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

const abasRow: CSSProperties = {
  display: "flex",
  gap: 4,
  padding: 4,
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  alignSelf: "flex-start",
};

const abaOff: CSSProperties = {
  padding: "7px 16px",
  background: "transparent",
  border: 0,
  borderRadius: 7,
  color: "var(--text-secondary)",
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
};

const abaOn: CSSProperties = {
  ...abaOff,
  background: "var(--bg-input)",
  color: "var(--text)",
  boxShadow: "inset 0 0 0 1px var(--border-strong)",
};

const abaHint: CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: "var(--text-secondary)",
  lineHeight: 1.4,
};

const buscaInput: CSSProperties = {
  padding: "9px 12px",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: 9,
  color: "var(--text)",
  fontSize: 13,
  outline: "none",
};

const lista: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const vazio: CSSProperties = { fontSize: 13, color: "var(--text-muted)", padding: "12px 4px" };

const avisoBox: CSSProperties = {
  padding: "10px 14px",
  background: "var(--warning-bg)",
  border: "1px solid var(--warning-border)",
  borderRadius: 10,
  color: "var(--warning-text)",
  fontSize: 12,
  lineHeight: 1.4,
};

const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 10px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  cursor: "pointer",
  textAlign: "left",
  width: "100%",
  boxSizing: "border-box",
};

const rowOn: CSSProperties = {
  ...row,
  border: "1px solid var(--danger-border)",
  background: "var(--danger-bg)",
};

const checkOff: CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: 6,
  border: "2px solid var(--border-strong)",
  display: "grid",
  placeItems: "center",
  flexShrink: 0,
  fontSize: 13,
  fontWeight: 800,
  color: "transparent",
};

const checkOn: CSSProperties = {
  ...checkOff,
  border: "2px solid var(--danger-text)",
  background: "var(--danger-text)",
  color: "#fff",
};

const thumb: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 6,
  objectFit: "cover",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  flexShrink: 0,
};

const thumbOff: CSSProperties = { opacity: 0.5, filter: "grayscale(1)" };

const thumbEmpty: CSSProperties = {
  ...thumb,
  display: "grid",
  placeItems: "center",
  color: "var(--text-faint)",
  fontSize: 14,
  fontWeight: 700,
};

const rowNome: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 13,
  fontWeight: 600,
  color: "var(--text)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const rowNomeOff: CSSProperties = {
  textDecoration: "line-through",
  color: "var(--text-muted)",
};

const tamChip: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  fontWeight: 700,
  padding: "1px 8px",
  borderRadius: 999,
  background: "var(--bg-input)",
  color: "var(--text)",
  border: "1px solid var(--border-strong)",
  flexShrink: 0,
};

const qtdChip: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  fontWeight: 700,
  color: "var(--text-secondary)",
  flexShrink: 0,
};

const pedChip: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  color: "var(--text-muted)",
  flexShrink: 0,
};

const orfaosWrap: CSSProperties = { display: "flex", flexDirection: "column", gap: 6, paddingTop: 6 };

const orfaosRow: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 6 };

const orfaoChip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 6px 3px 10px",
  background: "var(--info-bg)",
  border: "1px solid var(--info-border)",
  borderRadius: 999,
  color: "var(--info-text)",
  fontSize: 12,
  fontWeight: 600,
};

const orfaoRemove: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "inherit",
  fontSize: 14,
  fontWeight: 800,
  cursor: "pointer",
  lineHeight: 1,
  padding: "0 2px",
};

const manualRow: CSSProperties = { display: "flex", gap: 8 };

const manualInput: CSSProperties = {
  flex: 1,
  padding: "8px 12px",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: 9,
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
};

const addBtn: CSSProperties = {
  padding: "8px 14px",
  background: "var(--bg-card)",
  border: "1px solid var(--border-strong)",
  borderRadius: 9,
  color: "var(--text)",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
};

const acoesRow: CSSProperties = { display: "flex", alignItems: "center", gap: 8, marginTop: 2 };

const rodapeInfo: CSSProperties = { fontSize: 12, color: "var(--text-secondary)" };

const limparBtn: CSSProperties = {
  padding: "9px 12px",
  background: "transparent",
  border: "1px dashed var(--border-strong)",
  borderRadius: 9,
  color: "var(--text-muted)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const cancelarBtn: CSSProperties = {
  padding: "9px 14px",
  background: "transparent",
  border: "1px solid var(--border-strong)",
  borderRadius: 9,
  color: "var(--text-secondary)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const aplicarBtn: CSSProperties = {
  padding: "9px 18px",
  background: "var(--success-dot)",
  border: "1px solid var(--success-dot)",
  borderRadius: 9,
  color: "#04150c",
  fontSize: 12,
  fontWeight: 800,
  cursor: "pointer",
};

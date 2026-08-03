// Filtros de picking (paridade com o posvenda): Filtro Adição (só pedidos que
// contêm certos produtos), Filtro Exclusão (pula pedidos que contêm) e janela
// de data de emissão. Valem pra LISTA e pro CLAIM (o nexus aplica as mesmas
// condições — o "próximo" é sempre um pedido que a operadora está vendo).
// Persistem por estação (localStorage); nexus antigo ignora os campos extras.

import { useState, type CSSProperties } from "react";
import type { QueueFilters } from "../services/orders";

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

type Props = {
  filters: QueueFilters;
  onApply: (f: QueueFilters) => void;
  onClear: () => void;
  onClose: () => void;
};

export function PickingFiltersModal({ filters, onApply, onClear, onClose }: Props) {
  const [dateFrom, setDateFrom] = useState(filters.dateFrom ?? "");
  const [dateTo, setDateTo] = useState(filters.dateTo ?? "");
  const [include, setInclude] = useState<string[]>(filters.includeProducts ?? []);
  const [exclude, setExclude] = useState<string[]>(filters.excludeProducts ?? []);
  const [includeInput, setIncludeInput] = useState("");
  const [excludeInput, setExcludeInput] = useState("");

  const addTerm = (
    raw: string,
    list: string[],
    setList: (v: string[]) => void,
    clear: () => void,
  ) => {
    const t = raw.trim();
    if (t.length < 2 || list.some((x) => x.toLowerCase() === t.toLowerCase())) return;
    setList([...list, t]);
    clear();
  };

  const aplicar = () => {
    onApply({
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
      includeProducts: include.length ? include : undefined,
      excludeProducts: exclude.length ? exclude : undefined,
    });
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={box} onClick={(e) => e.stopPropagation()}>
        <h2 style={titulo}>Filtros de picking</h2>
        <p style={subtitulo}>
          Valem pra fila E pro claim — o próximo pedido sempre respeita o que você está
          vendo. Ficam salvos nesta estação.
        </p>

        <div style={secao}>
          <span style={secaoTitulo}>Data de emissão</span>
          <div style={chipsRow}>
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
              Últimos 7 dias
            </button>
            <button
              style={chip}
              onClick={() => {
                setDateFrom("");
                setDateTo("");
              }}
            >
              Qualquer data
            </button>
          </div>
          <div style={datasRow}>
            <label style={dataLabel}>
              De
              <input
                type="date"
                style={dataInput}
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
              />
            </label>
            <label style={dataLabel}>
              Até
              <input
                type="date"
                style={dataInput}
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
              />
            </label>
          </div>
        </div>

        <TermosSecao
          titulo="Filtro Adição — SÓ pedidos com estes produtos"
          placeholder="ex.: Zeus, Cueca Tech…"
          termos={include}
          input={includeInput}
          onInput={setIncludeInput}
          onAdd={() => addTerm(includeInput, include, setInclude, () => setIncludeInput(""))}
          onRemove={(t) => setInclude(include.filter((x) => x !== t))}
        />
        <TermosSecao
          titulo="Filtro Exclusão — PULA pedidos com estes produtos"
          placeholder="ex.: Moletom…"
          termos={exclude}
          input={excludeInput}
          onInput={setExcludeInput}
          onAdd={() => addTerm(excludeInput, exclude, setExclude, () => setExcludeInput(""))}
          onRemove={(t) => setExclude(exclude.filter((x) => x !== t))}
        />

        <div style={acoesRow}>
          <button style={limparBtn} onClick={onClear}>
            Limpar tudo
          </button>
          <div style={{ flex: 1 }} />
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

function TermosSecao({
  titulo: tituloSecao,
  placeholder,
  termos,
  input,
  onInput,
  onAdd,
  onRemove,
}: {
  titulo: string;
  placeholder: string;
  termos: string[];
  input: string;
  onInput: (v: string) => void;
  onAdd: () => void;
  onRemove: (t: string) => void;
}) {
  return (
    <div style={secao}>
      <span style={secaoTitulo}>{tituloSecao}</span>
      <div style={termoInputRow}>
        <input
          style={termoInput}
          value={input}
          placeholder={placeholder}
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onAdd();
            }
          }}
          spellCheck={false}
        />
        <button style={addBtn} onClick={onAdd}>
          Adicionar
        </button>
      </div>
      {termos.length > 0 && (
        <div style={chipsRow}>
          {termos.map((t) => (
            <span key={t} style={termoChip}>
              {t}
              <button style={termoRemove} onClick={() => onRemove(t)} title="Remover">
                ×
              </button>
            </span>
          ))}
        </div>
      )}
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
  width: 520,
  maxWidth: "92vw",
  maxHeight: "88vh",
  overflowY: "auto",
  background: "var(--bg-elevated)",
  border: "1px solid var(--border-strong)",
  borderRadius: 16,
  padding: "22px 24px",
  display: "flex",
  flexDirection: "column",
  gap: 14,
  boxSizing: "border-box",
};

const titulo: CSSProperties = { margin: 0, fontSize: 18, fontWeight: 800, color: "var(--text)" };

const subtitulo: CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: "var(--text-secondary)",
  lineHeight: 1.5,
};

const secao: CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };

const secaoTitulo: CSSProperties = {
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: 1,
  textTransform: "uppercase",
  color: "var(--text-muted)",
};

const chipsRow: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 6 };

const chip: CSSProperties = {
  padding: "5px 12px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 999,
  color: "var(--text-secondary)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const datasRow: CSSProperties = { display: "flex", gap: 12 };

const dataLabel: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 11,
  fontWeight: 700,
  color: "var(--text-muted)",
  flex: 1,
};

const dataInput: CSSProperties = {
  padding: "8px 10px",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text)",
  fontSize: 13,
  outline: "none",
  colorScheme: "dark",
};

const termoInputRow: CSSProperties = { display: "flex", gap: 8 };

const termoInput: CSSProperties = {
  flex: 1,
  padding: "9px 12px",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: 9,
  color: "var(--text)",
  fontSize: 13,
  outline: "none",
};

const addBtn: CSSProperties = {
  padding: "9px 16px",
  background: "var(--bg-card)",
  border: "1px solid var(--border-strong)",
  borderRadius: 9,
  color: "var(--text)",
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
};

const termoChip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 6px 4px 12px",
  background: "var(--info-bg)",
  border: "1px solid var(--info-border)",
  borderRadius: 999,
  color: "var(--info-text)",
  fontSize: 12,
  fontWeight: 600,
};

const termoRemove: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "inherit",
  fontSize: 15,
  fontWeight: 800,
  cursor: "pointer",
  lineHeight: 1,
  padding: "0 4px",
};

const acoesRow: CSSProperties = { display: "flex", alignItems: "center", gap: 10, marginTop: 4 };

const limparBtn: CSSProperties = {
  padding: "10px 14px",
  background: "transparent",
  border: "1px dashed var(--border-strong)",
  borderRadius: 9,
  color: "var(--text-muted)",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const cancelarBtn: CSSProperties = {
  padding: "10px 16px",
  background: "transparent",
  border: "1px solid var(--border-strong)",
  borderRadius: 9,
  color: "var(--text-secondary)",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const aplicarBtn: CSSProperties = {
  padding: "10px 20px",
  background: "var(--success-dot)",
  border: "1px solid var(--success-dot)",
  borderRadius: 9,
  color: "#04150c",
  fontSize: 13,
  fontWeight: 800,
  cursor: "pointer",
};

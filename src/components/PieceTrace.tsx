import {
  useState,
  type CSSProperties,
  type FormEvent,
  type SVGProps,
} from "react";
import { BackButton } from "./BackButton";
import { AmbientBackground } from "./AmbientBackground";
import { getDeviceConfig } from "../lib/devices";
import {
  clearBuffer,
  pollItagTags,
  startReading,
  stopReading,
} from "../lib/rfid";
import {
  fetchEpcInventoryByEpcs,
  type EpcInventoryRow,
} from "../services/printJobs";

type Props = { onBack: () => void };

type LookupResult = {
  queried: string[];
  rows: EpcInventoryRow[];
};

// Janela de leitura do leitor: limpa buffer, lê por READ_MS, para.
const READ_MS = 900;

/**
 * Formato do EPC — o MESMO que a API cobra (hex, 16 a 64 caracteres).
 *
 * Validar aqui não é redundância: o campo aceita digitação, e sem isto um
 * caractere trocado voltava do servidor como um `validation_error` cru do zod,
 * ilegível na tela. A checagem local troca isso por uma frase e economiza a
 * ida à rede.
 */
const EPC_RE = /^[0-9A-F]{16,64}$/;

const SITUACAO_LABEL: Record<number, string> = {
  2: "Impresso",
};

export function PieceTrace({ onBack }: Props) {
  const [manualEpc, setManualEpc] = useState("");
  const [reading, setReading] = useState(false);
  const [looking, setLooking] = useState(false);
  const [result, setResult] = useState<LookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function lookup(epcs: string[]) {
    const queried = Array.from(
      new Set(epcs.map((e) => e.trim().toUpperCase()).filter(Boolean)),
    );
    if (queried.length === 0) {
      setError("Nenhum EPC pra consultar.");
      return;
    }
    const invalidos = queried.filter((e) => !EPC_RE.test(e));
    if (invalidos.length > 0) {
      setError(
        `EPC inválido: ${invalidos.join(", ")}. O EPC é hexadecimal (0-9, A-F), com 16 a 64 caracteres.`,
      );
      setResult(null);
      return;
    }
    setError(null);
    setLooking(true);
    try {
      const rows = await fetchEpcInventoryByEpcs(queried);
      setResult({ queried, rows });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setLooking(false);
    }
  }

  async function onReadTag() {
    if (reading || looking) return;
    setError(null);
    setReading(true);
    const host = getDeviceConfig().reader.itagHost;
    try {
      await clearBuffer(host);
      await startReading(host);
      await new Promise((r) => setTimeout(r, READ_MS));
      const poll = await pollItagTags(host);
      await stopReading(host).catch(() => {
        /* best-effort */
      });
      if (poll.tags.length === 0) {
        setResult({ queried: [], rows: [] });
        setError("Nenhuma etiqueta lida. Aproxime a peça do leitor e tente de novo.");
        return;
      }
      await lookup(poll.tags);
    } catch (e) {
      setError(
        `Falha ao ler do leitor: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setReading(false);
    }
  }

  function onManualSubmit(e: FormEvent) {
    e.preventDefault();
    lookup([manualEpc]);
  }

  const busy = reading || looking;

  return (
    <div style={page}>
      <AmbientBackground />

      <header style={topBar}>
        <BackButton onClick={onBack} />
        <div style={titleWrap}>
          <span style={kicker}>― Rastreio ―</span>
          <h1 style={title}>Consulta de peça</h1>
        </div>
      </header>

      <main style={main}>
        <p style={lead}>
          Leia a etiqueta RFID de uma peça (ou informe o EPC) pra descobrir de
          qual lote ela saiu.
        </p>

        <div style={inputsRow}>
          <button
            onClick={onReadTag}
            disabled={busy}
            style={busy ? readBtnBusy : readBtn}
          >
            <IconAntenna style={{ width: 18, height: 18 }} />
            {reading ? "Lendo…" : "Ler etiqueta no leitor"}
          </button>

          <span style={orPill}>ou</span>

          <form onSubmit={onManualSubmit} style={manualForm}>
            <input
              value={manualEpc}
              onChange={(e) => setManualEpc(e.target.value)}
              placeholder="Cole/digite o EPC (hex)"
              spellCheck={false}
              autoCapitalize="characters"
              style={manualInput}
            />
            <button
              type="submit"
              disabled={busy || !manualEpc.trim()}
              style={busy || !manualEpc.trim() ? consultaBtnDisabled : consultaBtn}
            >
              {looking ? "Consultando…" : "Consultar"}
            </button>
          </form>
        </div>

        {error && <div style={errorBox}>{error}</div>}

        {result && <Results result={result} />}
      </main>
    </div>
  );
}

function Results({ result }: { result: LookupResult }) {
  const byEpc = new Map<string, EpcInventoryRow>();
  for (const r of result.rows) byEpc.set(r.epc.toUpperCase(), r);
  const notFound = result.queried.filter((e) => !byEpc.has(e));

  if (result.queried.length === 0) {
    return null;
  }

  return (
    <div style={resultsWrap}>
      <div style={resultsHeader}>
        {result.rows.length > 0
          ? `${result.rows.length} peça(s) encontrada(s)`
          : "Nenhuma peça encontrada no inventário"}
      </div>

      {result.rows.map((r) => (
        <article key={r.epc} style={pieceCard}>
          <div style={pieceTopRow}>
            <span style={loteCode}>{r.batch_code ?? "—"}</span>
            <span style={sizeBadge}>{r.size ?? "—"}</span>
            {r.moved_at && <span style={movedBadge}>Movimentado</span>}
          </div>
          <div style={pieceGrid}>
            <Field label="EAN13" value={r.ean13} mono />
            <Field label="SKU" value={r.sku ?? "—"} mono />
            <Field
              label="Situação"
              value={SITUACAO_LABEL[r.situacao_atual] ?? `cód ${r.situacao_atual}`}
            />
            {/* `printed_at` pode ser null nas linhas antigas replicadas do
                Supabase, que não traziam a data. */}
            <Field
              label="Impresso em"
              value={r.printed_at ? formatDateTime(r.printed_at) : "—"}
            />
            {r.codigo_inventario_itag != null && (
              <Field label="Inventário iTAG" value={String(r.codigo_inventario_itag)} mono />
            )}
          </div>
          <div style={epcLine}>
            <span style={epcLabel}>EPC</span>
            <code style={epcValue}>{r.epc}</code>
          </div>
        </article>
      ))}

      {notFound.length > 0 && (
        <div style={notFoundBox}>
          <strong style={{ color: "var(--warning-text)" }}>
            Sem registro no inventário:
          </strong>
          <div style={notFoundList}>
            {notFound.map((e) => (
              <code key={e} style={epcValue}>
                {e}
              </code>
            ))}
          </div>
          <span style={notFoundHint}>
            A etiqueta pode ter sido gravada antes do rastreio existir, ou em
            outro sistema.
          </span>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div style={fieldBox}>
      <span style={fieldLabel}>{label}</span>
      <span style={mono ? fieldValueMono : fieldValue}>{value}</span>
    </div>
  );
}

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function IconAntenna(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M5 12a7 7 0 0 1 14 0" />
      <path d="M8.5 12a3.5 3.5 0 0 1 7 0" />
      <circle cx="12" cy="12" r="1" />
      <line x1="12" y1="13" x2="12" y2="21" />
    </svg>
  );
}

// ============================================================
// Styles
// ============================================================
const page: CSSProperties = {
  minHeight: "100vh",
  background: "var(--bg)",
  color: "var(--text)",
  display: "flex",
  flexDirection: "column",
  position: "relative",
  overflow: "hidden",
};

const topBar: CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
  gap: 18,
  padding: "16px 32px",
  borderBottom: "1px solid var(--border)",
};

const titleWrap: CSSProperties = { display: "flex", flexDirection: "column", gap: 2 };

const kicker: CSSProperties = {
  fontSize: 10,
  letterSpacing: 3,
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontWeight: 700,
};

const title: CSSProperties = {
  margin: 0,
  fontSize: 20,
  fontWeight: 700,
  letterSpacing: -0.3,
  color: "var(--text)",
};

const main: CSSProperties = {
  position: "relative",
  flex: 1,
  display: "flex",
  flexDirection: "column",
  gap: 20,
  padding: "32px",
  maxWidth: 880,
  width: "100%",
  margin: "0 auto",
  boxSizing: "border-box",
};

const lead: CSSProperties = {
  margin: 0,
  fontSize: 14,
  color: "var(--text-secondary)",
  lineHeight: 1.5,
};

const inputsRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
  flexWrap: "wrap",
};

const readBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 9,
  padding: "12px 20px",
  background: "var(--info-bg)",
  color: "var(--info-text)",
  border: "1px solid var(--info-border)",
  borderRadius: 10,
  cursor: "pointer",
  fontSize: 14,
  fontWeight: 600,
};

const readBtnBusy: CSSProperties = {
  ...readBtn,
  opacity: 0.6,
  cursor: "wait",
};

const orPill: CSSProperties = {
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 1.5,
  color: "var(--text-muted)",
  fontWeight: 700,
};

const manualForm: CSSProperties = {
  display: "flex",
  gap: 8,
  flex: 1,
  minWidth: 280,
};

const manualInput: CSSProperties = {
  flex: 1,
  padding: "11px 14px",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  color: "var(--text)",
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  letterSpacing: 0.5,
};

const consultaBtn: CSSProperties = {
  padding: "11px 18px",
  background: "var(--bg-card)",
  border: "1px solid var(--border-strong)",
  borderRadius: 10,
  color: "var(--text)",
  cursor: "pointer",
  fontSize: 14,
  fontWeight: 600,
};

const consultaBtnDisabled: CSSProperties = {
  ...consultaBtn,
  opacity: 0.5,
  cursor: "not-allowed",
};

const errorBox: CSSProperties = {
  padding: "12px 16px",
  background: "var(--warning-bg)",
  border: "1px solid var(--warning-border)",
  borderRadius: 10,
  color: "var(--warning-text)",
  fontSize: 13,
};

const resultsWrap: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 14,
};

const resultsHeader: CSSProperties = {
  fontSize: 11,
  letterSpacing: 1.5,
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontWeight: 700,
};

const pieceCard: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 14,
  padding: 20,
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 14,
};

const pieceTopRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
};

const loteCode: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 22,
  fontWeight: 700,
  color: "var(--text)",
};

const sizeBadge: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  padding: "3px 10px",
  borderRadius: 6,
  background: "var(--bg-elevated)",
  border: "1px solid var(--border)",
  color: "var(--text)",
};

const movedBadge: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 1,
  textTransform: "uppercase",
  padding: "3px 9px",
  borderRadius: 6,
  background: "var(--success-bg)",
  border: "1px solid var(--success-border)",
  color: "var(--success-text)",
};

const pieceGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
  gap: 12,
};

const fieldBox: CSSProperties = { display: "flex", flexDirection: "column", gap: 3 };

const fieldLabel: CSSProperties = {
  fontSize: 9,
  letterSpacing: 1.2,
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontWeight: 700,
};

const fieldValue: CSSProperties = { fontSize: 14, color: "var(--text)", fontWeight: 500 };

const fieldValueMono: CSSProperties = {
  ...fieldValue,
  fontFamily: "var(--font-mono)",
  fontSize: 13,
};

const epcLine: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  paddingTop: 12,
  borderTop: "1px solid var(--border)",
};

const epcLabel: CSSProperties = {
  fontSize: 9,
  letterSpacing: 1.2,
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontWeight: 700,
};

const epcValue: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  color: "var(--text-secondary)",
  wordBreak: "break-all",
};

const notFoundBox: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 16,
  background: "var(--bg-elevated)",
  border: "1px dashed var(--border-strong)",
  borderRadius: 12,
};

const notFoundList: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
};

const notFoundHint: CSSProperties = {
  fontSize: 12,
  color: "var(--text-muted)",
};

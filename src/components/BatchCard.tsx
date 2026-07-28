import { useState, type CSSProperties } from "react";
import type { RfidPrintJobStatus } from "../services/printJobs";
import type { ResolvedBatch } from "../services/batches";
import type { EanSource } from "../services/ean13Lookup";

export type CardState =
  | { kind: "idle" }
  | { kind: "printing"; elapsedSec: number }
  | { kind: "failed"; error: string };

type Props = {
  resolved: ResolvedBatch;
  state: CardState;
  onPrint: (resolved: ResolvedBatch) => void;
  /** Descarta SÓ as etiquetas de teste deste lote (apaga EPCs de jobs is_test
   *  e cancela esses jobs). O lote continua na Produção. Só aparece quando
   *  `hasTest` é true. */
  onDiscardTest?: () => void;
  /** True quando o lote tem impressão de teste pendente pra limpar. */
  hasTest?: boolean;
  /**
   * Dispara um re-resolve do lote forçando o fallback do Shopify. Disponível
   * quando o load inicial pulou a edge function por performance e ainda tem
   * tamanhos sem EAN local (`resolved.shopifyFallbackAvailable === true`).
   */
  onSearchShopify?: (resolved: ResolvedBatch) => void;
  /** True enquanto o re-resolve via Shopify tá em voo pra esse lote. */
  searchingShopify?: boolean;
};

const STATUS_LABEL: Record<RfidPrintJobStatus, string> = {
  queued: "Pronto",
  printing: "Imprimindo…",
  done: "Concluído",
  failed: "Falhou",
  cancelled: "Cancelado",
};

const STATUS_STYLE: Record<RfidPrintJobStatus, CSSProperties> = {
  queued: { background: "var(--success-bg)", color: "var(--success-text)", borderColor: "var(--success-border)" },
  printing: { background: "var(--info-bg)", color: "var(--info-text)", borderColor: "var(--info-border)" },
  done: { background: "var(--bg-input)", color: "var(--text-secondary)", borderColor: "var(--border)" },
  failed: { background: "var(--danger-bg)", color: "var(--danger-text)", borderColor: "var(--danger-border)" },
  cancelled: { background: "var(--bg-input)", color: "var(--text-muted)", borderColor: "var(--border)" },
};

function aggregateGrade(items: Array<{ size: string; quantity: number }>) {
  const map = new Map<string, number>();
  for (const item of items) {
    map.set(item.size, (map.get(item.size) ?? 0) + item.quantity);
  }
  return Array.from(map.entries());
}

export function BatchCard({
  resolved,
  state,
  onPrint,
  onDiscardTest,
  hasTest,
  onSearchShopify,
  searchingShopify,
}: Props) {
  const {
    batch,
    sources,
    missingSizes,
    isPrintable,
    shopifyTitle,
    shopifyColor,
    shopifyFallbackAvailable,
  } = resolved;
  const title = shopifyTitle ?? batch.design_name ?? batch.batch_code;
  const color = shopifyColor ?? batch.shirt_color;

  const isPrinting = state.kind === "printing";
  const isFailed = state.kind === "failed";

  let badge: { label: string; style: CSSProperties };
  if (isPrinting) {
    badge = { label: "IMPRIMINDO", style: STATUS_STYLE.printing };
  } else if (isFailed) {
    badge = { label: "FALHOU", style: STATUS_STYLE.failed };
  } else if (isPrintable) {
    badge = { label: STATUS_LABEL.queued.toUpperCase(), style: STATUS_STYLE.queued };
  } else {
    badge = {
      label: `FALTAM ${missingSizes.length}`,
      style: { background: "var(--warning-bg)", color: "var(--warning-text)", borderColor: "var(--warning-border)" },
    };
  }

  let buttonLabel: string;
  let buttonDisabled: boolean;
  if (isPrinting) {
    const min = Math.floor(state.elapsedSec / 60);
    const sec = state.elapsedSec % 60;
    const timeStr =
      min > 0 ? `${min}m ${sec.toString().padStart(2, "0")}s` : `${sec}s`;
    buttonLabel = `Imprimindo… ${timeStr}`;
    buttonDisabled = true;
  } else if (isFailed) {
    buttonLabel = `Tentar de novo (${batch.total_pieces})`;
    buttonDisabled = !isPrintable;
  } else if (!isPrintable) {
    buttonLabel = "Falta cadastrar EAN13";
    buttonDisabled = true;
  } else {
    buttonLabel = `Imprimir ${batch.total_pieces} etiquetas`;
    buttonDisabled = false;
  }

  return (
    <article style={isPrinting ? cardPrinting : card}>
      <Thumbnail src={batch.thumbnail_url} alt={title ?? ""} />

      <div style={content}>
        <header style={topRow}>
          <span style={batchCode}>{batch.batch_code}</span>
          <span style={{ ...badgeBase, ...badge.style }}>{badge.label}</span>
        </header>

        <p style={subtitle}>
          <span style={titleStyle}>{title}</span>
          {color && (
            <>
              <span style={dot}>·</span>
              <span style={colorStyle}>{color}</span>
            </>
          )}
        </p>

        <div style={pillsRow}>
          {aggregateGrade(batch.sizes).map(([size, qty]) => {
            const src = sources[size];
            return (
              <span key={size} style={pillStyleFor(src)}>
                <strong style={pillSize}>{size}</strong>
                <span style={pillQty}>·{qty}</span>
              </span>
            );
          })}
        </div>

        {isFailed && (
          <div style={errorBox}>
            <strong style={errorTitle}>Falhou:</strong> {state.error}
          </div>
        )}

        {!isPrintable && !isFailed && missingSizes.length > 0 && (
          <div style={hintBox}>
            <span>
              Faltando EAN13 nos tamanhos:{" "}
              <strong style={{ color: "var(--warning-text)" }}>
                {missingSizes.join(", ")}
              </strong>
            </span>
            {shopifyFallbackAvailable && onSearchShopify && (
              <button
                onClick={() =>
                  !searchingShopify && onSearchShopify(resolved)
                }
                disabled={searchingShopify}
                style={searchingShopify ? shopifyBtnBusy : shopifyBtn}
                title="Consultar variants do Shopify pra preencher EANs faltantes"
              >
                {searchingShopify ? "Buscando…" : "Buscar no Shopify"}
              </button>
            )}
          </div>
        )}

        <footer style={footer}>
          <div style={totalCol}>
            <span style={totalNum}>{batch.total_pieces}</span>
            <span style={totalLabel}>etiquetas</span>
          </div>
          <div style={footerActions}>
            {hasTest && onDiscardTest && !isPrinting && (
              <button
                onClick={onDiscardTest}
                style={discardBtn}
                title="Apaga só as etiquetas de teste deste lote. O lote continua na Produção."
              >
                Descartar teste
              </button>
            )}
            <button
              onClick={() => !buttonDisabled && onPrint(resolved)}
              disabled={buttonDisabled}
              style={buttonDisabled ? printBtnDisabled : printBtn}
            >
              {buttonLabel}
            </button>
          </div>
        </footer>
      </div>
    </article>
  );
}

function Thumbnail({ src, alt }: { src: string | null; alt: string }) {
  const [errored, setErrored] = useState(false);
  if (!src || errored) {
    return (
      <div style={thumbPlaceholder} aria-hidden="true">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ width: 22, height: 22, color: "var(--text-faint)" }}
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="9" cy="9" r="2" />
          <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
        </svg>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      onError={() => setErrored(true)}
      style={thumbImg}
    />
  );
}

function pillStyleFor(src: EanSource | undefined): CSSProperties {
  if (src === "local") {
    return {
      ...pillBase,
      background: "var(--pill-local-bg)",
      color: "var(--pill-local-text)",
    };
  }
  if (src === "shopify") {
    return {
      ...pillBase,
      background: "var(--pill-shopify-bg)",
      color: "var(--pill-shopify-text)",
    };
  }
  return {
    ...pillBase,
    background: "var(--pill-missing-bg)",
    color: "var(--pill-missing-text)",
  };
}

const card: CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: 16,
  marginBottom: 10,
  display: "flex",
  gap: 16,
  alignItems: "stretch",
  transition: "background 120ms, border-color 120ms",
};

const cardPrinting: CSSProperties = {
  ...card,
  background: "var(--bg-card-hover)",
  borderColor: "var(--info-border)",
};

const thumbImg: CSSProperties = {
  width: 88,
  height: 88,
  borderRadius: 8,
  objectFit: "cover",
  background: "var(--bg-input)",
  flexShrink: 0,
};

const thumbPlaceholder: CSSProperties = {
  width: 88,
  height: 88,
  borderRadius: 8,
  background: "var(--bg-input)",
  display: "grid",
  placeItems: "center",
  flexShrink: 0,
};

const content: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const topRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

const batchCode: CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  color: "var(--text)",
  fontFamily: "var(--font-mono)",
  letterSpacing: 0.3,
};

const badgeBase: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  padding: "3px 8px",
  borderRadius: 999,
  letterSpacing: 0.7,
  border: "1px solid",
};

const subtitle: CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: "var(--text-secondary)",
};

const titleStyle: CSSProperties = {
  color: "var(--text)",
  fontWeight: 500,
};

const colorStyle: CSSProperties = {
  color: "var(--text-secondary)",
  textTransform: "lowercase",
};

const dot: CSSProperties = {
  margin: "0 6px",
  color: "var(--text-faint)",
};

const pillsRow: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 5,
};

const pillBase: CSSProperties = {
  borderRadius: 6,
  padding: "3px 8px",
  fontSize: 12,
  display: "inline-flex",
  alignItems: "center",
  gap: 2,
  fontFamily: "var(--font-mono)",
};

const pillSize: CSSProperties = {
  fontWeight: 700,
};

const pillQty: CSSProperties = {
  opacity: 0.85,
};

const errorBox: CSSProperties = {
  background: "var(--danger-bg)",
  color: "var(--danger-text)",
  border: "1px solid var(--danger-border)",
  padding: "7px 10px",
  borderRadius: 6,
  fontSize: 12,
  lineHeight: 1.5,
};

const errorTitle: CSSProperties = {
  fontWeight: 600,
  marginRight: 4,
};

const hintBox: CSSProperties = {
  background: "var(--warning-bg)",
  color: "var(--warning-text)",
  border: "1px solid var(--warning-border)",
  padding: "7px 10px",
  borderRadius: 6,
  fontSize: 12,
  lineHeight: 1.5,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 10,
  flexWrap: "wrap",
};

const shopifyBtn: CSSProperties = {
  background: "var(--bg-card)",
  color: "var(--text)",
  border: "1px solid var(--border-strong)",
  borderRadius: 6,
  padding: "4px 10px",
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: 0.2,
  cursor: "pointer",
  whiteSpace: "nowrap",
  flexShrink: 0,
};

const shopifyBtnBusy: CSSProperties = {
  ...shopifyBtn,
  opacity: 0.6,
  cursor: "wait",
};

const footer: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-end",
  marginTop: 4,
};

const totalCol: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  lineHeight: 1,
};

const totalNum: CSSProperties = {
  fontSize: 26,
  fontWeight: 700,
  color: "var(--text)",
  letterSpacing: -1,
};

const totalLabel: CSSProperties = {
  fontSize: 10,
  color: "var(--text-muted)",
  marginTop: 3,
  textTransform: "uppercase",
  letterSpacing: 0.7,
  fontWeight: 600,
};

const footerActions: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const discardBtn: CSSProperties = {
  padding: "9px 14px",
  fontSize: 12,
  fontWeight: 600,
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "transparent",
  color: "var(--text-muted)",
  cursor: "pointer",
};

/** Outline em vez de branco sólido: com um botão por linha, o branco roubava a
    tela inteira — o destaque fica pras ações globais e pro estado do lote. */
const printBtn: CSSProperties = {
  padding: "9px 16px",
  fontSize: 13,
  fontWeight: 600,
  border: "1px solid var(--border-strong)",
  borderRadius: 8,
  background: "transparent",
  color: "var(--text)",
  cursor: "pointer",
};

const printBtnDisabled: CSSProperties = {
  ...printBtn,
  border: "1px solid var(--border)",
  background: "var(--bg-input)",
  color: "var(--text-muted)",
  cursor: "not-allowed",
};

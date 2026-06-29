import { useEffect, useState, type CSSProperties } from "react";
import {
  COMMON_BAUDS,
  describePort,
  listSerialPorts,
  serialSniff,
  type SerialPortInfo,
  type SniffResult,
} from "../lib/usb";

/**
 * Captura o sinal cru da mesa RFID por USB serial — pra descobrir o protocolo
 * do leitor (auto-stream de EPC? frame binário? precisa de comando?) e escrever
 * o parser. Pluga a mesa, escolhe porta + baud, captura, e manda o resultado.
 */
export function SerialSniffer() {
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [port, setPort] = useState("");
  const [baud, setBaud] = useState(115200);
  const [ms, setMs] = useState(3000);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SniffResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    listSerialPorts()
      .then((p) => {
        setPorts(p);
        if (p.length && !port) setPort(p[0].name);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  useEffect(refresh, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function capture() {
    if (!port || busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      setResult(await serialSniff(port, baud, ms));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={card}>
      <div style={headerRow}>
        <span style={kicker}>Capturar sinal da mesa (USB)</span>
        <button onClick={refresh} style={linkBtn}>
          atualizar portas
        </button>
      </div>
      <p style={hint}>
        Pluga a mesa no USB, escolhe a porta e o baud, e captura. Se não vier nada,
        tenta outro baud — alguns leitores só respondem a um comando (aí me avisa).
      </p>

      <div style={row}>
        <label style={field}>
          <span style={label}>Porta</span>
          <select value={port} onChange={(e) => setPort(e.target.value)} style={input}>
            {ports.length === 0 && <option value="">(nenhuma porta USB)</option>}
            {ports.map((p) => (
              <option key={p.name} value={p.name}>
                {describePort(p)}
              </option>
            ))}
          </select>
        </label>

        <label style={fieldNarrow}>
          <span style={label}>Baud</span>
          <select value={baud} onChange={(e) => setBaud(Number(e.target.value))} style={input}>
            {COMMON_BAUDS.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>

        <label style={fieldNarrow}>
          <span style={label}>Janela</span>
          <select value={ms} onChange={(e) => setMs(Number(e.target.value))} style={input}>
            <option value={2000}>2s</option>
            <option value={3000}>3s</option>
            <option value={5000}>5s</option>
            <option value={10000}>10s</option>
          </select>
        </label>

        <button onClick={capture} disabled={busy || !port} style={busy || !port ? captureBtnOff : captureBtn}>
          {busy ? "Capturando…" : "Capturar"}
        </button>
      </div>

      {error && <div style={errorBox}>{error}</div>}

      {result && (
        <div style={resultWrap}>
          <div style={resultMeta}>
            {result.byte_count} bytes @ {result.baud} baud · {result.lines.length} linha(s)
          </div>
          {result.byte_count === 0 ? (
            <div style={emptyBox}>
              Nada recebido. Tenta outro baud, confirma a porta, ou o leitor precisa
              de um comando pra começar a ler.
            </div>
          ) : (
            <>
              {result.lines.length > 0 && (
                <pre style={pre}>{result.lines.slice(0, 40).join("\n")}</pre>
              )}
              <div style={subLabel}>HEX</div>
              <pre style={preHex}>{result.hex.slice(0, 2400)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const card: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: 18,
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
};

const headerRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};

const kicker: CSSProperties = {
  fontSize: 11,
  letterSpacing: 1.5,
  textTransform: "uppercase",
  color: "var(--text)",
  fontWeight: 700,
};

const linkBtn: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: 1,
  fontWeight: 700,
};

const hint: CSSProperties = { margin: 0, fontSize: 12, color: "var(--text-secondary)", lineHeight: 1.5 };

const row: CSSProperties = { display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" };

const field: CSSProperties = { display: "flex", flexDirection: "column", gap: 5, flex: 1, minWidth: 200 };
const fieldNarrow: CSSProperties = { display: "flex", flexDirection: "column", gap: 5 };

const label: CSSProperties = {
  fontSize: 9,
  letterSpacing: 1.2,
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontWeight: 700,
};

const input: CSSProperties = {
  padding: "9px 12px",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text)",
  fontSize: 13,
};

const captureBtn: CSSProperties = {
  padding: "10px 18px",
  background: "var(--info-bg)",
  color: "var(--info-text)",
  border: "1px solid var(--info-border)",
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 700,
};

const captureBtnOff: CSSProperties = { ...captureBtn, opacity: 0.5, cursor: "not-allowed" };

const errorBox: CSSProperties = {
  padding: "10px 14px",
  background: "var(--warning-bg)",
  border: "1px solid var(--warning-border)",
  borderRadius: 8,
  color: "var(--warning-text)",
  fontSize: 12,
};

const resultWrap: CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };

const resultMeta: CSSProperties = {
  fontSize: 12,
  color: "var(--text-secondary)",
  fontWeight: 600,
};

const emptyBox: CSSProperties = {
  padding: "10px 14px",
  background: "var(--bg-elevated)",
  border: "1px dashed var(--border-strong)",
  borderRadius: 8,
  color: "var(--text-muted)",
  fontSize: 12,
};

const pre: CSSProperties = {
  margin: 0,
  padding: 12,
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text)",
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  maxHeight: 220,
  overflow: "auto",
};

const preHex: CSSProperties = { ...pre, color: "var(--text-secondary)", fontSize: 11, maxHeight: 160 };

const subLabel: CSSProperties = { ...label, marginTop: 2 };

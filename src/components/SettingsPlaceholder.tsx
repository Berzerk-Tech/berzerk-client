import { useEffect, useState, type CSSProperties } from "react";
import { BackButton } from "./BackButton";
import { UpdateChecker } from "./UpdateChecker";
import { AmbientBackground } from "./AmbientBackground";
import { getStationId } from "../lib/station";
import {
  getDeviceConfig,
  setPrinter,
  setReader,
  PRINTER_MODELS,
  READER_MODES,
  type ThermalPrinter,
  type RfidReader,
} from "../lib/devices";
import { pingItag, type ConnectionStatus } from "../lib/rfid";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { supabase } from "../lib/supabase";
import { signInWithGoogle } from "../lib/auth";
import { listSerialPorts, describePort, type SerialPortInfo } from "../lib/usb";
import { SerialSniffer } from "./SerialSniffer";
import {
  getIprintConfig,
  setIprintConfig,
  toRustConfig,
  type IprintConfig,
} from "../services/iprintConfig";
import { invoke } from "@tauri-apps/api/core";

type Props = { onBack: () => void };

export function SettingsPlaceholder({ onBack }: Props) {
  const stationId = getStationId();
  const [config, setConfig] = useState(() => getDeviceConfig());

  const refresh = () => setConfig(getDeviceConfig());

  return (
    <div style={page}>
      <AmbientBackground variant="flat" />

      <header style={subHeader}>
        <div style={subHeaderLeft}>
          <BackButton onClick={onBack} />
        </div>
        <h2 style={title}>Configurações</h2>
        <div style={subHeaderRight} />
      </header>

      <main style={body}>
        <div style={section}>
          <SectionHeader kicker="Sessão" label="Operador" />
          <SessionCard />
        </div>

        <div style={section}>
          <SectionHeader kicker="Dispositivos" label="Impressora térmica" />
          <PrinterCard
            printer={config.printer}
            onSave={(p) => { setPrinter(p); refresh(); }}
            onClear={() => { setPrinter(null); refresh(); }}
          />
        </div>

        <div style={section}>
          <SectionHeader kicker="Dispositivos" label="Leitor RFID" />
          <ReaderCard
            reader={config.reader}
            onSave={(r) => { setReader(r); refresh(); }}
          />
        </div>

        <div style={section}>
          <SectionHeader kicker="Integração" label="iTAG iPrint" />
          <IprintCard />
        </div>

        <div style={section}>
          <SectionHeader kicker="Sistema" label="Atualizações" />
          <UpdateChecker />
        </div>

        <div style={section}>
          <SectionHeader kicker="Identificação" label="Estação" />
          <div style={infoCard}>
            <div style={infoRow}>
              <span style={infoLabel}>ID completo</span>
              <code style={infoValueMono}>{stationId}</code>
            </div>
            <p style={infoHelp}>
              Identificador único deste PC. Gerado no primeiro boot e persistido localmente.
              Trocar invalida o histórico de impressões desta estação.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}

// === Session Card ===

/**
 * Sessão do operador — saiu do header da home (que ficou só com tema/engrenagem):
 * e-mail logado, troca de conta Google (máquina compartilhada) e tela cheia.
 */
function SessionCard() {
  const [email, setEmail] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    let alive = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (alive) setEmail(data.session?.user?.email ?? null);
    });
    void (async () => {
      try {
        const fs = await getCurrentWindow().isFullscreen();
        if (alive) setIsFullscreen(fs);
      } catch {
        /* não-Tauri */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // signOut + prompt=select_account: um clique pra trocar de conta.
  const switchUser = async () => {
    await supabase.auth.signOut();
    await signInWithGoogle();
  };

  const toggleFullscreen = async () => {
    try {
      const win = getCurrentWindow();
      const fs = await win.isFullscreen();
      await win.setFullscreen(!fs);
      setIsFullscreen(!fs);
    } catch {
      /* ignore */
    }
  };

  return (
    <div style={infoCard}>
      <div style={infoRow}>
        <span style={infoLabel}>Conta Google</span>
        <code style={infoValueMono}>{email ?? "…"}</code>
      </div>
      <div style={cardActions}>
        <button type="button" style={btnGhost} className="berzerk-btn-ghost" onClick={toggleFullscreen}>
          {isFullscreen ? "Sair de tela cheia" : "Tela cheia"}
        </button>
        <button type="button" style={btnGhost} className="berzerk-btn-ghost" onClick={switchUser}>
          Trocar usuário
        </button>
      </div>
    </div>
  );
}

// === Printer Card ===

function PrinterCard({
  printer,
  onSave,
  onClear,
}: {
  printer: ThermalPrinter | null;
  onSave: (p: ThermalPrinter) => void;
  onClear: () => void;
}) {
  const [editing, setEditing] = useState(!printer);
  const [draft, setDraft] = useState<ThermalPrinter>(() =>
    printer ?? { name: "", deviceId: "", model: "unknown" },
  );
  const [ports, setPorts] = useState<SerialPortInfo[]>([]);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);

  useEffect(() => {
    if (printer) setDraft(printer);
  }, [printer]);

  useEffect(() => {
    if (editing) {
      void rescanPorts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  async function rescanPorts() {
    setScanning(true);
    setScanError(null);
    try {
      const found = await listSerialPorts();
      setPorts(found);
      // Se draft.deviceId ainda vazio e tem só 1 porta, sugere ela
      if (!draft.deviceId && found.length === 1) {
        setDraft((d) => ({
          ...d,
          deviceId: found[0].name,
          name: d.name || found[0].product || found[0].name,
        }));
      }
    } catch (err) {
      setScanError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  }

  function selectPort(port: SerialPortInfo) {
    setDraft((d) => ({
      ...d,
      deviceId: port.name,
      // Auto-preenche nome se vazio, baseado no product/manufacturer
      name: d.name || port.product || port.manufacturer || port.name,
    }));
  }

  if (!editing && printer) {
    return (
      <div style={configCard}>
        <div style={configRow}>
          <div style={configMeta}>
            <span style={configLabel}>Modelo</span>
            <code style={configValueMono}>
              {PRINTER_MODELS.find((m) => m.value === printer.model)?.label ?? printer.model}
            </code>
          </div>
          <span style={pillReady}>
            <span style={pillDotReady} /> Configurada
          </span>
        </div>
        <div style={configRow}>
          <div style={configMeta}>
            <span style={configLabel}>Nome</span>
            <span style={configValue}>{printer.name}</span>
          </div>
        </div>
        <div style={configRow}>
          <div style={configMeta}>
            <span style={configLabel}>Identificador</span>
            <code style={configValueMono}>{printer.deviceId}</code>
          </div>
        </div>
        <div style={cardActions}>
          <button type="button" style={btnGhost} className="berzerk-btn-ghost" onClick={() => setEditing(true)}>
            Editar
          </button>
          <button type="button" style={btnDanger} className="berzerk-btn-danger" onClick={onClear}>
            Remover
          </button>
        </div>
      </div>
    );
  }

  const canSave = draft.name.trim() && draft.deviceId.trim();

  return (
    <div style={configCard}>
      <Field
        label="Dispositivo USB"
        hint={`${ports.length} ${ports.length === 1 ? "dispositivo detectado" : "dispositivos detectados"}`}
      >
        <div style={portList}>
          {scanning && ports.length === 0 ? (
            <div style={portEmpty}>Procurando portas seriais…</div>
          ) : ports.length === 0 ? (
            <div style={portEmpty}>
              Nenhum dispositivo serial detectado. Conecte a impressora via USB e
              clique em "Atualizar lista".
            </div>
          ) : (
            ports.map((port) => {
              const selected = draft.deviceId === port.name;
              return (
                <button
                  type="button"
                  key={port.name}
                  onClick={() => selectPort(port)}
                  style={{
                    ...portOption,
                    background: selected ? "var(--bg-card-hover)" : "var(--bg-input)",
                    borderColor: selected ? "var(--border-strong)" : "var(--border)",
                  }}
                  className="berzerk-port-option"
                >
                  <div style={portInfo}>
                    <span style={portName}>{describePort(port)}</span>
                    {port.vid && port.pid && (
                      <span style={portVidPid}>
                        VID:PID {port.vid}:{port.pid}
                        {port.serial_number ? ` · SN ${port.serial_number}` : ""}
                      </span>
                    )}
                  </div>
                  {selected && <span style={portCheck}>✓</span>}
                </button>
              );
            })
          )}
          {scanError && <div style={portError}>{scanError}</div>}
          <button
            type="button"
            onClick={rescanPorts}
            disabled={scanning}
            style={btnGhost}
            className="berzerk-btn-ghost"
          >
            {scanning ? "Procurando…" : "↻ Atualizar lista"}
          </button>
        </div>
      </Field>

      <Field label="Apelido" hint="Como esse dispositivo vai aparecer pra você">
        <input
          style={input}
          className="berzerk-input"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          placeholder="Bobina 01 / Esquerda"
        />
      </Field>

      <Field label="Modelo / Protocolo" hint="ESC/POS funciona pra maioria das impressoras térmicas">
        <select
          style={input}
          className="berzerk-input"
          value={draft.model}
          onChange={(e) =>
            setDraft({ ...draft, model: e.target.value as ThermalPrinter["model"] })
          }
        >
          {PRINTER_MODELS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>

      <div style={cardActions}>
        {printer && (
          <button
            type="button"
            style={btnGhost}
            className="berzerk-btn-ghost"
            onClick={() => {
              setDraft(printer);
              setEditing(false);
            }}
          >
            Cancelar
          </button>
        )}
        <button
          type="button"
          style={canSave ? btnPrimary : btnDisabled}
          className={canSave ? "berzerk-btn-primary" : ""}
          disabled={!canSave}
          onClick={() => {
            onSave(draft);
            setEditing(false);
          }}
        >
          Salvar
        </button>
      </div>
    </div>
  );
}

// === Reader Card ===

function ReaderCard({
  reader,
  onSave,
}: {
  reader: RfidReader;
  onSave: (r: RfidReader) => void;
}) {
  const [draft, setDraft] = useState(reader);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionStatus | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(reader);

  // Atualiza o draft quando os defaults externos mudam (Salvar reseta)
  useEffect(() => { setDraft(reader); }, [reader]);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const status = await pingItag(draft.itagHost);
      setTestResult(status);
    } catch (err) {
      setTestResult({
        ok: false,
        host: draft.itagHost,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div style={configCard}>
      <Field label="Modo de conexão" hint="Como o app fala com o leitor RFID">
        <div style={radioGroup}>
          {READER_MODES.map((mode) => (
            <label
              key={mode.value}
              style={{
                ...radioOption,
                opacity: mode.available ? 1 : 0.5,
                cursor: mode.available ? "pointer" : "not-allowed",
              }}
            >
              <input
                type="radio"
                name="reader-mode"
                checked={draft.mode === mode.value}
                disabled={!mode.available}
                onChange={() => setDraft({ ...draft, mode: mode.value })}
                style={radio}
              />
              <span style={radioBody}>
                <span style={radioLabel}>{mode.label}</span>
                <span style={radioDesc}>{mode.description}</span>
              </span>
            </label>
          ))}
        </div>
      </Field>

      {draft.mode === "direct-usb" && <SerialSniffer />}

      {draft.mode === "direct-itag" && (
        <Field
          label="Endereço do iTAG Monitor"
          hint="App fala HTTP direto — sem proxy"
        >
          <div style={inputWithButton}>
            <input
              style={{ ...input, flex: 1 }}
              className="berzerk-input"
              value={draft.itagHost}
              onChange={(e) => setDraft({ ...draft, itagHost: e.target.value })}
            />
            <button
              type="button"
              style={btnGhost}
              className="berzerk-btn-ghost"
              onClick={handleTest}
              disabled={testing}
            >
              {testing ? "Testando…" : "Testar conexão"}
            </button>
          </div>
        </Field>
      )}

      {testResult && (
        <div
          style={{
            ...testBox,
            background: testResult.ok ? "var(--success-bg)" : "var(--danger-bg)",
            color: testResult.ok ? "var(--success-text)" : "var(--danger-text)",
            borderColor: testResult.ok ? "var(--success-border)" : "var(--danger-border)",
          }}
        >
          <span style={testIcon}>{testResult.ok ? "●" : "○"}</span>
          <div style={testCopy}>
            <strong style={testTitle}>
              {testResult.ok ? "iTAG Monitor respondeu" : "Não consegui conectar"}
            </strong>
            {testResult.message && (
              <code style={testDetail}>{testResult.message}</code>
            )}
          </div>
        </div>
      )}

      {dirty && (
        <div style={cardActions}>
          <button
            type="button"
            style={btnGhost}
            className="berzerk-btn-ghost"
            onClick={() => setDraft(reader)}
          >
            Descartar
          </button>
          <button
            type="button"
            style={btnPrimary}
            className="berzerk-btn-primary"
            onClick={() => onSave(draft)}
          >
            Salvar alterações
          </button>
        </div>
      )}
    </div>
  );
}

// === iTAG iPrint Card ===

function IprintCard() {
  const [draft, setDraft] = useState<IprintConfig>(() => getIprintConfig());
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionStatus | null>(null);
  const initial = useState(() => getIprintConfig())[0];
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const status = await invoke<ConnectionStatus>("itag_iprint_ping", {
        config: toRustConfig(draft),
      });
      setTestResult(status);
    } catch (err) {
      setTestResult({
        ok: false,
        host: draft.baseUrl,
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTesting(false);
    }
  }

  function save() {
    setIprintConfig(draft);
  }

  return (
    <div style={configCard}>
      <Field label="URL base" hint="Endpoint REST do iTAG (sem barra no final)">
        <input
          style={input}
          className="berzerk-input"
          value={draft.baseUrl}
          onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
          placeholder="http://itag2.itagalert.com.br/itagalert_integracao"
        />
      </Field>

      <Field label="Usuário" hint="Basic auth">
        <input
          style={input}
          className="berzerk-input"
          value={draft.basicUser}
          onChange={(e) => setDraft({ ...draft, basicUser: e.target.value })}
        />
      </Field>

      <Field label="Senha" hint="Basic auth · armazenada localmente">
        <input
          type="password"
          style={input}
          className="berzerk-input"
          value={draft.basicPass}
          onChange={(e) => setDraft({ ...draft, basicPass: e.target.value })}
        />
      </Field>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 22 }}>
        <Field label="Código Empresa" hint="Path /gerarRFID/{empresa}/{filial}">
          <input
            type="number"
            min={0}
            style={input}
            className="berzerk-input"
            value={draft.codigoEmpresa}
            onChange={(e) =>
              setDraft({
                ...draft,
                codigoEmpresa: parseInt(e.target.value, 10) || 0,
              })
            }
          />
        </Field>
        <Field label="Filial" hint="Idem">
          <input
            type="number"
            min={0}
            style={input}
            className="berzerk-input"
            value={draft.filial}
            onChange={(e) =>
              setDraft({ ...draft, filial: parseInt(e.target.value, 10) || 0 })
            }
          />
        </Field>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 22 }}>
        <Field label="Empresa origem" hint="Movimentação">
          <input
            type="number"
            min={0}
            style={input}
            className="berzerk-input"
            value={draft.empresaOrigem}
            onChange={(e) =>
              setDraft({
                ...draft,
                empresaOrigem: parseInt(e.target.value, 10) || 0,
              })
            }
          />
        </Field>
        <Field label="Empresa destino" hint="Movimentação">
          <input
            type="number"
            min={0}
            style={input}
            className="berzerk-input"
            value={draft.empresaDestino}
            onChange={(e) =>
              setDraft({
                ...draft,
                empresaDestino: parseInt(e.target.value, 10) || 0,
              })
            }
          />
        </Field>
        <Field label="Situação destino" hint="Ex.: 4 = estoque">
          <input
            type="number"
            min={0}
            style={input}
            className="berzerk-input"
            value={draft.situacaoDestino}
            onChange={(e) =>
              setDraft({
                ...draft,
                situacaoDestino: parseInt(e.target.value, 10) || 0,
              })
            }
          />
        </Field>
      </div>

      <div style={cardActions}>
        <button
          type="button"
          style={btnGhost}
          className="berzerk-btn-ghost"
          onClick={handleTest}
          disabled={testing}
        >
          {testing ? "Testando…" : "Testar conexão"}
        </button>
        {dirty && (
          <>
            <button
              type="button"
              style={btnGhost}
              className="berzerk-btn-ghost"
              onClick={() => setDraft(initial)}
            >
              Descartar
            </button>
            <button
              type="button"
              style={btnPrimary}
              className="berzerk-btn-primary"
              onClick={save}
            >
              Salvar
            </button>
          </>
        )}
      </div>

      {testResult && (
        <div
          style={{
            ...testBox,
            background: testResult.ok ? "var(--success-bg)" : "var(--danger-bg)",
            color: testResult.ok ? "var(--success-text)" : "var(--danger-text)",
            borderColor: testResult.ok
              ? "var(--success-border)"
              : "var(--danger-border)",
          }}
        >
          <span style={testIcon}>{testResult.ok ? "●" : "○"}</span>
          <div style={testCopy}>
            <strong style={testTitle}>
              {testResult.ok ? "iTAG respondeu" : "Não consegui conectar"}
            </strong>
            {testResult.message && (
              <code style={testDetail}>{testResult.message}</code>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// === Helpers ===

function SectionHeader({ kicker, label }: { kicker: string; label: string }) {
  return (
    <div style={sectionHeader}>
      <span style={sectionKicker}>― {kicker} ―</span>
      <h3 style={sectionLabel}>{label}</h3>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div style={field}>
      <div style={fieldHead}>
        <span style={fieldLabel}>{label}</span>
        {hint && <span style={fieldHint}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

// === Hover CSS ===

if (typeof document !== "undefined" && !document.getElementById("berzerk-settings-styles")) {
  const style = document.createElement("style");
  style.id = "berzerk-settings-styles";
  style.textContent = `
    .berzerk-input:focus {
      outline: none;
      border-color: var(--border-focus) !important;
    }
    .berzerk-btn-primary:hover { background: var(--accent-hover) !important; }
    .berzerk-btn-ghost:hover {
      background: var(--bg-card-hover) !important;
      border-color: var(--border-strong) !important;
    }
    .berzerk-btn-danger:hover {
      background: var(--danger-bg) !important;
      color: var(--danger-text) !important;
      border-color: var(--danger-border) !important;
    }
  `;
  document.head.appendChild(style);
}

// === Styles ===

const page: CSSProperties = {
  minHeight: "100vh",
  background: "var(--bg)",
  color: "var(--text)",
  display: "flex",
  flexDirection: "column",
  position: "relative",
  overflow: "hidden",
};

const subHeader: CSSProperties = {
  position: "relative",
  display: "grid",
  gridTemplateColumns: "1fr auto 1fr",
  alignItems: "center",
  gap: 18,
  padding: "20px 40px",
  borderBottom: "1px solid var(--border)",
  background: "var(--bg)",
};

const subHeaderLeft: CSSProperties = { gridColumn: "1", justifySelf: "start" };
const subHeaderRight: CSSProperties = { gridColumn: "3" };

const title: CSSProperties = {
  margin: 0,
  fontSize: 17,
  fontWeight: 600,
  color: "var(--text)",
  letterSpacing: -0.1,
};

const body: CSSProperties = {
  position: "relative",
  flex: 1,
  padding: "40px 32px 80px",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 48,
};

const section: CSSProperties = {
  width: "100%",
  maxWidth: 620,
  display: "flex",
  flexDirection: "column",
  gap: 14,
};

const sectionHeader: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const sectionKicker: CSSProperties = {
  fontSize: 10,
  letterSpacing: 3,
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontWeight: 700,
};

const sectionLabel: CSSProperties = {
  margin: 0,
  fontSize: 18,
  fontWeight: 700,
  color: "var(--text)",
  letterSpacing: -0.2,
  lineHeight: 1.2,
};

const configCard: CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: 22,
  display: "flex",
  flexDirection: "column",
  gap: 16,
};

const configRow: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 16,
};

const configMeta: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const configLabel: CSSProperties = {
  fontSize: 10,
  letterSpacing: 2,
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontWeight: 700,
};

const configValue: CSSProperties = {
  fontSize: 14,
  color: "var(--text)",
};

const configValueMono: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  color: "var(--text)",
};

const pillReady: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  padding: "4px 10px",
  background: "var(--success-bg)",
  color: "var(--success-text)",
  border: "1px solid var(--success-border)",
  borderRadius: 999,
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 1.2,
  alignSelf: "flex-start",
};

const pillDotReady: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "var(--success-dot)",
};

const field: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const fieldHead: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 10,
};

const fieldLabel: CSSProperties = {
  fontSize: 11,
  letterSpacing: 1.5,
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontWeight: 700,
};

const fieldHint: CSSProperties = {
  fontSize: 11,
  color: "var(--text-faint)",
  fontStyle: "italic",
};

const input: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  fontSize: 13,
  fontFamily: "var(--font-mono)",
  background: "var(--bg-input)",
  color: "var(--text)",
  // border-strong de propósito: o fundo do input é quase igual ao do card,
  // sem uma borda visível o operador não acha onde digitar.
  border: "1px solid var(--border-strong)",
  borderRadius: 8,
  boxSizing: "border-box",
  transition: "border-color 120ms",
};

const inputWithButton: CSSProperties = {
  display: "flex",
  gap: 8,
  alignItems: "stretch",
};

const portList: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const portEmpty: CSSProperties = {
  padding: "14px 16px",
  background: "var(--bg-input)",
  border: "1px dashed var(--border)",
  borderRadius: 8,
  fontSize: 12,
  color: "var(--text-muted)",
  textAlign: "center",
};

const portOption: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "10px 14px",
  border: "1px solid",
  borderRadius: 8,
  cursor: "pointer",
  textAlign: "left",
  fontFamily: "inherit",
  transition: "background 120ms, border-color 120ms",
};

const portInfo: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const portName: CSSProperties = {
  fontSize: 13,
  color: "var(--text)",
  fontWeight: 600,
};

const portVidPid: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--text-muted)",
};

const portCheck: CSSProperties = {
  color: "var(--text)",
  fontSize: 16,
  fontWeight: 700,
};

const portError: CSSProperties = {
  padding: "10px 14px",
  background: "var(--danger-bg)",
  color: "var(--danger-text)",
  border: "1px solid var(--danger-border)",
  borderRadius: 8,
  fontSize: 12,
};

const testBox: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  padding: "10px 14px",
  border: "1px solid",
  borderRadius: 10,
  fontSize: 12,
};

const testIcon: CSSProperties = {
  fontSize: 16,
  lineHeight: 1,
  marginTop: 1,
};

const testCopy: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  flex: 1,
};

const testTitle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
};

const testDetail: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  opacity: 0.85,
};

const radioGroup: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
};

const radioOption: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  padding: "10px 12px",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: 8,
};

const radio: CSSProperties = {
  marginTop: 3,
  accentColor: "var(--text)",
};

const radioBody: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  flex: 1,
};

const radioLabel: CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--text)",
};

const radioDesc: CSSProperties = {
  fontSize: 11,
  color: "var(--text-muted)",
};

const cardActions: CSSProperties = {
  display: "flex",
  gap: 10,
  justifyContent: "flex-end",
};

const btnPrimary: CSSProperties = {
  padding: "9px 16px",
  fontSize: 12,
  fontWeight: 700,
  border: 0,
  borderRadius: 8,
  background: "var(--accent)",
  color: "var(--accent-text)",
  cursor: "pointer",
  textTransform: "uppercase",
  letterSpacing: 1,
  transition: "background 120ms",
};

const btnDisabled: CSSProperties = {
  ...btnPrimary,
  background: "var(--bg-input)",
  color: "var(--text-muted)",
  cursor: "not-allowed",
};

const btnGhost: CSSProperties = {
  padding: "9px 14px",
  fontSize: 12,
  fontWeight: 600,
  border: "1px solid var(--border)",
  borderRadius: 8,
  background: "transparent",
  color: "var(--text-secondary)",
  cursor: "pointer",
  textTransform: "uppercase",
  letterSpacing: 1,
  transition: "background 120ms, color 120ms, border-color 120ms",
};

const btnDanger: CSSProperties = {
  ...btnGhost,
  color: "var(--text-muted)",
};


const infoCard: CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: 20,
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const infoRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 14,
  padding: "10px 14px",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: 8,
};

const infoLabel: CSSProperties = {
  fontSize: 10,
  letterSpacing: 2,
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontWeight: 700,
};

const infoValueMono: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  color: "var(--text)",
};

const infoHelp: CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: "var(--text-secondary)",
  lineHeight: 1.55,
};

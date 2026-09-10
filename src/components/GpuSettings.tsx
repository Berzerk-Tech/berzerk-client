import { useEffect, useState, type CSSProperties } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { ToggleRow } from "./SettingsPlaceholder";
import { Toast } from "./Toast";
import { getGpuDisabled, setGpuDisabled } from "../lib/gpu";

/**
 * Card de Configurações pra desligar a aceleração de hardware do WebView2 —
 * mitigação pra estações com GPU integrada antiga que tremem/cintilam.
 *
 * A preferência mora num arquivo lido pelo Rust ANTES do WebView2 subir
 * (ver `src/lib/gpu.ts` / `src-tauri/src/gpu_prefs.rs`), então uma troca só
 * faz efeito depois de reiniciar o app — daí o toast + botão "Reiniciar agora".
 */
export function GpuSettings() {
  const [disabled, setDisabled] = useState(false);
  const [pendingRestart, setPendingRestart] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setDisabled(await getGpuDisabled());
    })();
  }, []);

  const onToggle = async (on: boolean) => {
    setError(null);
    try {
      await setGpuDisabled(on);
      setDisabled(on);
      setPendingRestart(true);
      setToast("Reinicie o Berzerk Client para aplicar a alteração.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div style={configCard}>
      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}

      <ToggleRow
        label="Desativar Aceleração de Hardware (GPU)"
        hint="Recomendado ativar caso a tela apresente tremores ou cintilações de renderização em placas de vídeo integradas/antigas."
        checked={disabled}
        onChange={(on) => void onToggle(on)}
      />

      {pendingRestart && (
        <button type="button" style={btnGhost} className="berzerk-btn-ghost" onClick={() => void relaunch()}>
          Reiniciar agora
        </button>
      )}

      {error && <p style={errorText}>{error}</p>}
    </div>
  );
}

const configCard: CSSProperties = {
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  padding: 22,
  display: "flex",
  flexDirection: "column",
  gap: 16,
};

const btnGhost: CSSProperties = {
  alignSelf: "flex-start",
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

const errorText: CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: "var(--danger-text, var(--warning-text))",
  lineHeight: 1.5,
};

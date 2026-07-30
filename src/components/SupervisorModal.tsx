// Modal de liberação por supervisor — modelo "chave de supermercado".
// A operadora chama o supervisor; ele escolhe o nome, digita o PIN e um motivo
// e o pedido conclui SEM todas as peças no RFID (auditado no nexus). O PIN é
// validado server-side, então vale em qualquer estação. Aqui também mora o
// fluxo de definir/alterar PIN (primeiro uso define direto; depois exige o atual).

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { ApiError } from "../lib/api";
import {
  alterarPinSupervisor,
  getSupervisores,
  type LiberacaoFaltante,
  type LiberacaoSupervisor,
  type SupervisorInfo,
} from "../services/orders";

const MOTIVOS_RAPIDOS = [
  "Peça sem etiqueta RFID",
  "Etiqueta danificada",
  "Leitor com problema",
];

type Props = {
  faltantes: LiberacaoFaltante[];
  onCancel: () => void;
  /** Conclui o pedido com a liberação — deve LANÇAR em erro (o modal mostra). */
  onConfirm: (liberacao: LiberacaoSupervisor) => Promise<void>;
};

function apiErrorCode(e: unknown): string | null {
  if (e instanceof ApiError && e.body && typeof e.body === "object" && "error" in e.body) {
    return String((e.body as { error: unknown }).error);
  }
  return null;
}

function friendlyError(e: unknown): string {
  const code = apiErrorCode(e);
  if (code === "pin_invalido") return "PIN incorreto — confere e tenta de novo.";
  if (code === "nao_supervisor")
    return "Este usuário não tem permissão de supervisor (o acesso é liberado no nexus).";
  if (code === "pin_nao_definido")
    return "Este supervisor ainda não definiu um PIN — usa o link “Definir ou alterar PIN” aqui embaixo.";
  if (e instanceof ApiError && e.status === 404)
    return "O servidor ainda não tem a liberação de supervisor habilitada (aguardando atualização do nexus).";
  return e instanceof Error ? e.message : String(e);
}

export function SupervisorModal({ faltantes, onCancel, onConfirm }: Props) {
  const [supervisores, setSupervisores] = useState<SupervisorInfo[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [motivoChip, setMotivoChip] = useState<string | null>(null);
  const [motivoLivre, setMotivoLivre] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fluxo secundário: definir/alterar PIN.
  const [pinMode, setPinMode] = useState(false);
  const [pinAtual, setPinAtual] = useState("");
  const [pinNovo, setPinNovo] = useState("");
  const [pinNovo2, setPinNovo2] = useState("");
  const [pinOk, setPinOk] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    getSupervisores()
      .then(({ supervisores }) => {
        if (!alive) return;
        setSupervisores(supervisores);
        if (supervisores.length === 1) setSelected(supervisores[0].id);
      })
      .catch((e) => alive && setLoadError(friendlyError(e)));
    return () => {
      alive = false;
    };
  }, []);

  const supervisorSel = useMemo(
    () => supervisores?.find((s) => s.id === selected) ?? null,
    [supervisores, selected],
  );

  const motivo = motivoChip === "outro" ? motivoLivre.trim() : (motivoChip ?? "");
  const totalFaltam = faltantes.reduce((a, f) => a + f.faltam, 0);
  const podeLiberar = !!selected && motivo.length >= 3 && pin.length >= 4 && !busy;

  const liberar = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm({ supervisorId: selected, pin, motivo, faltantes });
    } catch (e) {
      setError(friendlyError(e));
      setBusy(false);
    }
  };

  const salvarPin = async () => {
    if (!selected || busy) return;
    if (pinNovo.length < 4) {
      setError("O PIN novo precisa de pelo menos 4 dígitos.");
      return;
    }
    if (pinNovo !== pinNovo2) {
      setError("A confirmação do PIN novo não confere.");
      return;
    }
    setBusy(true);
    setError(null);
    setPinOk(null);
    try {
      await alterarPinSupervisor({
        supervisorId: selected,
        pinAtual: supervisorSel?.temPin ? pinAtual : undefined,
        pinNovo,
      });
      setPinOk("PIN salvo! Já vale em todas as estações.");
      setPinMode(false);
      setPinAtual("");
      setPinNovo("");
      setPinNovo2("");
      setSupervisores(
        (prev) => prev?.map((s) => (s.id === selected ? { ...s, temPin: true } : s)) ?? prev,
      );
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={overlay} onClick={onCancel}>
      <div style={sheet} onClick={(e) => e.stopPropagation()}>
        <h2 style={title}>🔓 Liberação de supervisor</h2>
        <p style={subtitle}>
          {totalFaltam === 1
            ? "1 peça não foi identificada pelo RFID."
            : `${totalFaltam} peças não foram identificadas pelo RFID.`}{" "}
          Só um supervisor pode concluir este pedido assim.
        </p>

        {faltantes.length > 0 && (
          <div style={faltantesBox}>
            {faltantes.map((f) => (
              <div key={f.itemId} style={faltanteRow}>
                <span style={faltanteNome}>
                  {f.nome ?? "Item"}
                  {f.tamanho ? ` · ${f.tamanho}` : ""}
                </span>
                <span style={faltanteQtd}>
                  falta{f.faltam > 1 ? "m" : ""} {f.faltam}
                </span>
              </div>
            ))}
          </div>
        )}

        {loadError && <div style={errorBox}>{loadError}</div>}
        {supervisores && supervisores.length === 0 && (
          <div style={errorBox}>
            Nenhum supervisor cadastrado — o acesso é liberado no nexus (papel
            supervisor-separacao).
          </div>
        )}

        {supervisores && supervisores.length > 0 && (
          <>
            <span style={fieldLabel}>Quem está liberando?</span>
            <div style={chipsRow}>
              {supervisores.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  style={selected === s.id ? chipActive : chip}
                  onClick={() => {
                    setSelected(s.id);
                    setError(null);
                  }}
                >
                  {s.nome}
                  {!s.temPin && <span style={chipHint}> · sem PIN</span>}
                </button>
              ))}
            </div>

            {!pinMode && (
              <>
                <span style={fieldLabel}>Motivo</span>
                <div style={chipsRow}>
                  {MOTIVOS_RAPIDOS.map((m) => (
                    <button
                      key={m}
                      type="button"
                      style={motivoChip === m ? chipActive : chip}
                      onClick={() => setMotivoChip(m)}
                    >
                      {m}
                    </button>
                  ))}
                  <button
                    type="button"
                    style={motivoChip === "outro" ? chipActive : chip}
                    onClick={() => setMotivoChip("outro")}
                  >
                    Outro…
                  </button>
                </div>
                {motivoChip === "outro" && (
                  <input
                    style={input}
                    className="berzerk-input"
                    placeholder="Descreve o motivo…"
                    value={motivoLivre}
                    onChange={(e) => setMotivoLivre(e.target.value)}
                    maxLength={200}
                  />
                )}

                <span style={fieldLabel}>PIN do supervisor</span>
                <input
                  style={pinInput}
                  className="berzerk-input"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder="••••"
                  value={pin}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 12))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && podeLiberar) void liberar();
                  }}
                />
              </>
            )}

            {pinMode && (
              <>
                {supervisorSel?.temPin && (
                  <>
                    <span style={fieldLabel}>PIN atual</span>
                    <input
                      style={pinInput}
                      className="berzerk-input"
                      type="password"
                      inputMode="numeric"
                      autoComplete="off"
                      value={pinAtual}
                      onChange={(e) => setPinAtual(e.target.value.replace(/\D/g, "").slice(0, 12))}
                    />
                  </>
                )}
                <span style={fieldLabel}>PIN novo (4–12 dígitos)</span>
                <input
                  style={pinInput}
                  className="berzerk-input"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  value={pinNovo}
                  onChange={(e) => setPinNovo(e.target.value.replace(/\D/g, "").slice(0, 12))}
                />
                <span style={fieldLabel}>Confirma o PIN novo</span>
                <input
                  style={pinInput}
                  className="berzerk-input"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  value={pinNovo2}
                  onChange={(e) => setPinNovo2(e.target.value.replace(/\D/g, "").slice(0, 12))}
                />
              </>
            )}
          </>
        )}

        {error && <div style={errorBox}>{error}</div>}
        {pinOk && <div style={okBox}>{pinOk}</div>}

        <div style={actions}>
          <button type="button" style={ghostBtn} className="berzerk-btn-ghost" onClick={onCancel}>
            Cancelar
          </button>
          {pinMode ? (
            <button
              type="button"
              style={primaryBtn}
              className="berzerk-btn-primary"
              disabled={!selected || busy}
              onClick={() => void salvarPin()}
            >
              {busy ? "Salvando…" : "Salvar PIN"}
            </button>
          ) : (
            <button
              type="button"
              style={podeLiberar ? primaryBtn : primaryBtnDisabled}
              className="berzerk-btn-primary"
              disabled={!podeLiberar}
              onClick={() => void liberar()}
            >
              {busy ? "Liberando…" : "Liberar pedido"}
            </button>
          )}
        </div>

        {supervisores && supervisores.length > 0 && (
          <button
            type="button"
            style={pinLink}
            onClick={() => {
              setPinMode((v) => !v);
              setError(null);
              setPinOk(null);
            }}
          >
            {pinMode ? "← Voltar pra liberação" : "Definir ou alterar PIN do supervisor"}
          </button>
        )}
      </div>
    </div>
  );
}

// === styles ===

const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.55)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 200,
  padding: 24,
};

const sheet: CSSProperties = {
  width: "min(560px, 100%)",
  maxHeight: "90vh",
  overflowY: "auto",
  background: "var(--bg-elevated, var(--bg, #1e1e2e))",
  border: "1px solid var(--border, #313244)",
  borderRadius: 16,
  padding: "24px 28px",
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const title: CSSProperties = { margin: 0, fontSize: 20, fontWeight: 700 };
const subtitle: CSSProperties = { margin: 0, fontSize: 14, opacity: 0.8 };

const faltantesBox: CSSProperties = {
  border: "1px solid var(--border, #313244)",
  borderRadius: 10,
  padding: "10px 14px",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const faltanteRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  fontSize: 13,
};
const faltanteNome: CSSProperties = { fontWeight: 600 };
const faltanteQtd: CSSProperties = { color: "var(--warning-text, #f9e2af)", whiteSpace: "nowrap" };

const fieldLabel: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  opacity: 0.7,
  marginTop: 4,
};

const chipsRow: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 8 };

const chip: CSSProperties = {
  padding: "10px 16px",
  borderRadius: 999,
  border: "1px solid var(--border, #45475a)",
  background: "transparent",
  color: "inherit",
  fontSize: 14,
  cursor: "pointer",
};

const chipActive: CSSProperties = {
  ...chip,
  border: "1px solid var(--accent, #cba6f7)",
  background: "var(--accent-bg, rgba(203,166,247,0.15))",
  fontWeight: 700,
};

const chipHint: CSSProperties = { opacity: 0.6, fontSize: 12 };

const input: CSSProperties = {
  padding: "12px 14px",
  borderRadius: 10,
  border: "1px solid var(--border, #45475a)",
  background: "transparent",
  color: "inherit",
  fontSize: 15,
};

const pinInput: CSSProperties = {
  ...input,
  fontSize: 24,
  letterSpacing: "0.4em",
  textAlign: "center",
  maxWidth: 240,
};

const errorBox: CSSProperties = {
  padding: "10px 14px",
  borderRadius: 10,
  background: "var(--danger-bg, rgba(243,139,168,0.12))",
  color: "var(--danger-text, #f38ba8)",
  fontSize: 13,
};

const okBox: CSSProperties = {
  padding: "10px 14px",
  borderRadius: 10,
  background: "var(--success-bg, rgba(166,227,161,0.12))",
  color: "var(--success-text, #a6e3a1)",
  fontSize: 13,
};

const actions: CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 6 };

const ghostBtn: CSSProperties = {
  padding: "12px 20px",
  borderRadius: 10,
  border: "1px solid var(--border, #45475a)",
  background: "transparent",
  color: "inherit",
  fontSize: 14,
  cursor: "pointer",
};

const primaryBtn: CSSProperties = {
  padding: "12px 24px",
  borderRadius: 10,
  border: 0,
  background: "var(--accent, #cba6f7)",
  color: "var(--accent-contrast, #11111b)",
  fontSize: 14,
  fontWeight: 700,
  cursor: "pointer",
};

const primaryBtnDisabled: CSSProperties = {
  ...primaryBtn,
  opacity: 0.4,
  cursor: "not-allowed",
};

const pinLink: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "inherit",
  opacity: 0.65,
  textDecoration: "underline",
  fontSize: 13,
  cursor: "pointer",
  alignSelf: "center",
  marginTop: 2,
};

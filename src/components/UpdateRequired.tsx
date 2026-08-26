import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { checkForUpdate, type AvailableUpdate, type DownloadProgress } from "../lib/updater";
import type { Bloqueio } from "../lib/updateGate";
import { BerzerkLogo } from "./BerzerkLogo";
import { AmbientBackground } from "./AmbientBackground";

/**
 * Tela cheia de bloqueio: esta máquina não opera até atualizar.
 *
 * O que ela NÃO tem, de propósito: botão de fechar, "mais tarde", "continuar
 * assim mesmo" e caminho de volta pro menu. Um botão de escape aqui devolveria
 * exatamente o problema que a trava existe pra resolver — quem estivesse com
 * pressa clicaria nele todo dia.
 *
 * Duas origens, o mesmo desenho (ver `lib/updateGate.ts`): a recusa do nexus
 * (426) e o aviso do updater. A diferença aparece só no texto de apoio.
 */

const RELEASES_URL = "https://github.com/Berzerk-Tech/berzerk-client/releases/latest";

type Estado =
  | { kind: "procurando" }
  | { kind: "pronto"; update: AvailableUpdate }
  | { kind: "baixando"; update: AvailableUpdate; progresso: DownloadProgress | null }
  | { kind: "instalando" }
  /** O servidor exige, mas o updater não achou instalador (GitHub fora, release atrasada). */
  | { kind: "sem-instalador"; motivo: string | null };

export function UpdateRequired({ bloqueio }: { bloqueio: Bloqueio }) {
  const [versaoInstalada, setVersaoInstalada] = useState<string | null>(null);
  const [estado, setEstado] = useState<Estado>(() =>
    bloqueio.kind === "updater"
      ? { kind: "pronto", update: bloqueio.update }
      : { kind: "procurando" },
  );

  useEffect(() => {
    getVersion()
      .then(setVersaoInstalada)
      .catch(() => setVersaoInstalada(null));
  }, []);

  const procurar = useCallback(async () => {
    setEstado({ kind: "procurando" });
    try {
      const update = await checkForUpdate();
      setEstado(
        update ? { kind: "pronto", update } : { kind: "sem-instalador", motivo: null },
      );
    } catch (err) {
      setEstado({
        kind: "sem-instalador",
        motivo: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  // Bloqueio vindo do 426: o servidor sabe que estamos velhos, mas quem tem o
  // instalador é o updater — busca aqui, uma vez, ao abrir a tela.
  useEffect(() => {
    if (bloqueio.kind === "servidor") void procurar();
  }, [bloqueio.kind, procurar]);

  async function instalar(update: AvailableUpdate) {
    setEstado({ kind: "baixando", update, progresso: null });
    try {
      await update.install((progresso) => {
        setEstado((anterior) => {
          if (anterior.kind !== "baixando") return anterior;
          if (progresso.total != null && progresso.downloaded >= progresso.total) {
            return { kind: "instalando" };
          }
          return { ...anterior, progresso };
        });
      });
      // `install` reinicia o app — não devíamos voltar daqui.
    } catch (err) {
      setEstado({
        kind: "sem-instalador",
        motivo: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const versaoNova = estado.kind === "pronto" || estado.kind === "baixando"
    ? estado.update.version
    : bloqueio.kind === "servidor"
      ? bloqueio.versaoMinima
      : null;
  const versaoAtual =
    versaoInstalada ?? (bloqueio.kind === "servidor" ? bloqueio.versaoAtual : null);

  return (
    <div style={page}>
      <AmbientBackground />
      <div style={card}>
        <BerzerkLogo style={logo} />
        <span style={kicker}>― Atualização obrigatória ―</span>
        <h1 style={titulo}>Atualize o Berzerk Client</h1>
        <p style={texto}>
          {bloqueio.kind === "servidor"
            ? bloqueio.mensagem
            : "Saiu uma versão nova. Atualize para continuar operando nesta mesa."}
        </p>

        <div style={versoes}>
          <Versao rotulo="Instalada" valor={versaoAtual ? `v${versaoAtual}` : "—"} />
          <span style={seta}>→</span>
          <Versao rotulo="Necessária" valor={versaoNova ? `v${versaoNova}` : "—"} destaque />
        </div>

        {estado.kind === "procurando" && (
          <div style={linhaStatus}>
            <Spinner />
            <span>Procurando a atualização…</span>
          </div>
        )}

        {estado.kind === "pronto" && (
          <>
            {estado.update.body && <p style={notas}>{estado.update.body}</p>}
            <button type="button" style={botao} onClick={() => void instalar(estado.update)}>
              Atualizar agora →
            </button>
            <span style={rodape}>O app baixa, instala e reinicia sozinho.</span>
          </>
        )}

        {estado.kind === "baixando" && (
          <>
            <Barra progresso={estado.progresso} />
            <span style={rodape}>
              {estado.progresso?.total != null
                ? `Baixando ${Math.round((estado.progresso.downloaded / estado.progresso.total) * 100)}%`
                : "Baixando…"}
            </span>
          </>
        )}

        {estado.kind === "instalando" && (
          <div style={linhaStatus}>
            <Spinner />
            <span>Instalando e reiniciando…</span>
          </div>
        )}

        {estado.kind === "sem-instalador" && (
          <>
            <p style={aviso}>
              Não foi possível baixar a atualização automaticamente
              {estado.motivo ? ` (${estado.motivo})` : ""}. Baixe o instalador pela página de
              versões e chame a coordenação se continuar assim.
            </p>
            <div style={linhaBotoes}>
              <button type="button" style={botao} onClick={() => void procurar()}>
                Tentar de novo
              </button>
              <button
                type="button"
                style={botaoSecundario}
                onClick={() => void openUrl(RELEASES_URL)}
              >
                Abrir página de versões
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Versao({ rotulo, valor, destaque }: { rotulo: string; valor: string; destaque?: boolean }) {
  return (
    <div style={versaoBloco}>
      <span style={versaoRotulo}>{rotulo}</span>
      <code style={{ ...versaoValor, color: destaque ? "var(--accent)" : "var(--text)" }}>
        {valor}
      </code>
    </div>
  );
}

function Barra({ progresso }: { progresso: DownloadProgress | null }) {
  const pct =
    progresso && progresso.total
      ? Math.min(100, Math.round((progresso.downloaded / progresso.total) * 100))
      : null;
  return (
    <div style={barraFundo}>
      <div style={{ ...barraPreenchida, width: pct != null ? `${pct}%` : "30%" }} />
    </div>
  );
}

function Spinner() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 20 20"
      style={{ animation: "berzerk-spin 0.9s linear infinite", flexShrink: 0 }}
    >
      <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2" />
      <path d="M10 2 a8 8 0 0 1 8 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

// O `berzerk-spin` nasce no Login, que nem sempre está montado quando esta
// tela aparece (bloqueio no meio da separação) — garante o keyframe aqui.
if (typeof document !== "undefined" && !document.getElementById("berzerk-update-required-keyframes")) {
  const style = document.createElement("style");
  style.id = "berzerk-update-required-keyframes";
  style.textContent = `
    @keyframes berzerk-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
  `;
  document.head.appendChild(style);
}

const page: CSSProperties = {
  position: "relative",
  overflow: "hidden",
  minHeight: "100vh",
  display: "grid",
  placeItems: "center",
  background: "var(--bg)",
  padding: 24,
};

const card: CSSProperties = {
  position: "relative",
  zIndex: 1,
  width: "100%",
  maxWidth: 520,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  textAlign: "center",
  gap: 12,
  padding: 32,
  background: "var(--bg-card)",
  border: "1px solid var(--border-strong)",
  borderRadius: 14,
};

const logo: CSSProperties = { height: 26, marginBottom: 6, color: "var(--text)" };

const kicker: CSSProperties = {
  fontSize: 10,
  letterSpacing: 2.5,
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontWeight: 700,
};

const titulo: CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-display)",
  fontSize: 32,
  letterSpacing: 0.4,
  lineHeight: 1.1,
  color: "var(--text)",
};

const texto: CSSProperties = {
  margin: 0,
  fontSize: 13,
  lineHeight: 1.6,
  color: "var(--text-secondary)",
};

const versoes: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 18,
  margin: "8px 0 4px",
};

const versaoBloco: CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };

const versaoRotulo: CSSProperties = {
  fontSize: 10,
  letterSpacing: 2,
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontWeight: 700,
};

const versaoValor: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 18,
  fontWeight: 500,
};

const seta: CSSProperties = { color: "var(--text-muted)", fontSize: 16 };

const notas: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.55,
  color: "var(--text-secondary)",
  whiteSpace: "pre-wrap",
};

const aviso: CSSProperties = {
  margin: 0,
  fontSize: 12,
  lineHeight: 1.55,
  color: "var(--danger-text)",
};

const linhaStatus: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 10,
  fontSize: 12,
  color: "var(--text-secondary)",
  marginTop: 8,
};

const linhaBotoes: CSSProperties = {
  display: "flex",
  gap: 10,
  flexWrap: "wrap",
  justifyContent: "center",
  marginTop: 8,
};

const botao: CSSProperties = {
  marginTop: 8,
  padding: "12px 22px",
  fontSize: 13,
  fontWeight: 700,
  border: 0,
  borderRadius: 8,
  background: "var(--accent)",
  color: "var(--accent-text)",
  cursor: "pointer",
  textTransform: "uppercase",
  letterSpacing: 1,
};

const botaoSecundario: CSSProperties = {
  ...botao,
  background: "var(--bg-input)",
  color: "var(--text-secondary)",
  border: "1px solid var(--border)",
};

const barraFundo: CSSProperties = {
  width: "100%",
  height: 8,
  marginTop: 12,
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: 999,
  overflow: "hidden",
};

const barraPreenchida: CSSProperties = {
  height: "100%",
  background: "var(--accent)",
  transition: "width 200ms ease-out",
};

const rodape: CSSProperties = { fontSize: 11, color: "var(--text-muted)" };

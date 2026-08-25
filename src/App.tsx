import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { getSessao, getSessaoSync, onSessaoChange, type SessaoCognito } from "./lib/cognito";
import { handleOAuthCallback, listenForOAuthCallback } from "./lib/auth";
import {
  ETIQUETAGEM_INDISPONIVEL_MSG,
  estadoSupabase,
  garantirSessaoSupabase,
  onEstadoSupabase,
  type EstadoSupabase,
} from "./lib/supabase-derivada";
import { initDeepLinks, type DeepLinkAuthResult } from "./lib/deep-link";
import { checkForUpdate, type AvailableUpdate } from "./lib/updater";
import { getStationShortId } from "./lib/station";
import { Login } from "./components/Login";
import { BatchBrowser } from "./components/BatchBrowser";
import { HomeMenu, type Screen } from "./components/HomeMenu";
import { Expedicao } from "./components/Expedicao";
import { PieceTrace } from "./components/PieceTrace";
import { Separacao } from "./components/Separacao";
import { SettingsPlaceholder } from "./components/SettingsPlaceholder";
import { UpdateBanner } from "./components/UpdateBanner";
import { Toast } from "./components/Toast";
import { IdleSessionGuard } from "./components/IdleSessionGuard";
import { BackButton } from "./components/BackButton";
import { RfidProvider } from "./contexts/RfidContext";

export default function App() {
  // Sessão do NEXUS (Cognito): é ela que diz se o app está logado.
  const [sessao, setSessao] = useState<SessaoCognito | null>(() => getSessaoSync());
  // Sessão SUPABASE derivada: só a Etiquetagem e o Rastreio dependem dela.
  const [sessaoSupabase, setSessaoSupabase] = useState<Session | null>(null);
  const [estadoSb, setEstadoSb] = useState<EstadoSupabase>(() => estadoSupabase());
  const [loading, setLoading] = useState(true);
  const [screen, setScreen] = useState<Screen>("home");
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // Mensagem de um deep link berzerk://auth que falhou — repassada pro Login.
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);
  // Login disparado por deep link: a tela de login mostra o "aguardando navegador".
  const [loginEmVoo, setLoginEmVoo] = useState(false);

  useEffect(() => {
    // Boot: renova a sessão do Cognito se estiver perto de expirar e só então
    // decide entre Login e app (evita piscar a tela de login em quem já logou).
    void getSessao()
      .then((s) => setSessao(s))
      .finally(() => setLoading(false));

    const pararSessao = onSessaoChange((s) => {
      setSessao(s);
      if (!s) setScreen("home");
    });

    const pararEstadoSb = onEstadoSupabase(setEstadoSb);

    supabase.auth.getSession().then(({ data }) => setSessaoSupabase(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, sess) => {
      setSessaoSupabase(sess);
    });

    const stopDeepLink = listenForOAuthCallback(async (url) => {
      const { error } = await handleOAuthCallback(url);
      setLoginEmVoo(false);
      if (error) {
        console.error("OAuth callback falhou:", error);
        setDeepLinkError(error.message);
      } else {
        setDeepLinkError(null);
      }
    });

    // Deep links do Nexus: berzerk://auth (compat), berzerk://login, berzerk://open.
    const stopNexusHandoff = initDeepLinks({
      onLoginIniciado: () => setLoginEmVoo(true),
      onAuthResult: (result: DeepLinkAuthResult) => {
        if (result.kind === "success") {
          setDeepLinkError(null);
          setScreen("home");
          setToast(`Conectado como ${result.email}`);
        } else if (getSessaoSync()) {
          // Já logado no Nexus: o link só falhou pra Etiquetagem — avisa e segue.
          setToast(ETIQUETAGEM_INDISPONIVEL_MSG);
        } else {
          setDeepLinkError(result.message);
        }
      },
    });

    // Check de atualização 5s após o boot pra não competir com auth/sessão
    const updateTimer = setTimeout(async () => {
      try {
        const found = await checkForUpdate();
        if (found) setUpdate(found);
      } catch (err) {
        console.warn("update check falhou:", err);
      }
    }, 5000);

    return () => {
      pararSessao();
      pararEstadoSb();
      sub.subscription.unsubscribe();
      stopDeepLink();
      stopNexusHandoff();
      clearTimeout(updateTimer);
    };
  }, []);

  // Com sessão do Nexus e sem sessão Supabase, deriva uma em silêncio
  // (`POST /desktop/handoff`). Vale pro boot e pro login recém-concluído.
  useEffect(() => {
    if (!sessao || sessaoSupabase) return;
    void garantirSessaoSupabase();
  }, [sessao, sessaoSupabase]);

  const tentarDeNovoSupabase = useCallback(() => {
    void garantirSessaoSupabase({ forcar: true });
  }, []);

  const banner =
    update && !updateDismissed ? (
      <UpdateBanner update={update} onDismiss={() => setUpdateDismissed(true)} />
    ) : null;

  const withBanner = (node: ReactNode) => (
    <div style={shell}>
      {banner}
      <div style={shellMain}>{node}</div>
    </div>
  );

  const back = () => setScreen("home");

  let content: ReactNode;
  if (loading) {
    content = (
      <div style={loadingPage}>
        <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Carregando…</div>
      </div>
    );
  } else if (!sessao) {
    content = withBanner(<Login deepLinkError={deepLinkError} aguardandoNavegador={loginEmVoo} />);
  } else {
    const email = sessao.email ?? "(sem email)";
    const stationShortId = getStationShortId();
    const semSupabase = (
      <SupabaseIndisponivel estado={estadoSb} onBack={back} onRetry={tentarDeNovoSupabase} />
    );
    if (screen === "rfid")
      content = withBanner(
        sessaoSupabase ? <BatchBrowser session={sessaoSupabase} onBack={back} /> : semSupabase,
      );
    else if (screen === "nf") content = withBanner(<Expedicao onBack={back} />);
    else if (screen === "rastreio")
      content = withBanner(sessaoSupabase ? <PieceTrace onBack={back} /> : semSupabase);
    else if (screen === "separacao") content = withBanner(<Separacao onBack={back} />);
    else if (screen === "settings") content = withBanner(<SettingsPlaceholder onBack={back} />);
    else
      content = withBanner(
        <HomeMenu email={email} stationShortId={stationShortId} onEnter={setScreen} />,
      );
  }

  // RfidProvider acima da sessão: a conexão da mesa sobrevive a logout/troca de operadora.
  return (
    <RfidProvider>
      {sessao && <IdleSessionGuard />}
      {toast && <Toast message={toast} onDismiss={() => setToast(null)} />}
      {content}
    </RfidProvider>
  );
}

/**
 * Etiquetagem/Rastreio sem a sessão Supabase derivada. Não é logout: Separação
 * e Expedição (100% Nexus) continuam funcionando — some quando a fase 3 do
 * corte levar a Etiquetagem pro Nexus.
 */
function SupabaseIndisponivel({
  estado,
  onBack,
  onRetry,
}: {
  estado: EstadoSupabase;
  onBack: () => void;
  onRetry: () => void;
}) {
  const derivando = estado.estado === "derivando";
  return (
    <div style={avisoPage}>
      <div style={avisoTopo}>
        <BackButton onClick={onBack} />
      </div>
      <div style={avisoCard}>
        <h2 style={avisoTitulo}>{ETIQUETAGEM_INDISPONIVEL_MSG}</h2>
        {estado.estado === "falhou" && <p style={avisoMotivo}>{estado.motivo}</p>}
        <p style={avisoNota}>Separação e Expedição seguem funcionando.</p>
        <button type="button" onClick={onRetry} disabled={derivando} style={avisoBtn}>
          {derivando ? "Tentando…" : "Tentar de novo"}
        </button>
      </div>
    </div>
  );
}

const loadingPage: CSSProperties = {
  minHeight: "100vh",
  display: "grid",
  placeItems: "center",
  background: "var(--bg)",
};

const shell: CSSProperties = {
  minHeight: "100vh",
  display: "flex",
  flexDirection: "column",
  background: "var(--bg)",
};

const shellMain: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
};

const avisoPage: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  background: "var(--bg)",
};

const avisoTopo: CSSProperties = {
  padding: "20px 24px 0",
};

const avisoCard: CSSProperties = {
  margin: "auto",
  maxWidth: 460,
  padding: 28,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  textAlign: "center",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
};

const avisoTitulo: CSSProperties = {
  margin: 0,
  fontSize: 15,
  fontWeight: 600,
  color: "var(--text)",
};

const avisoMotivo: CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: "var(--danger-text)",
};

const avisoNota: CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: "var(--text-muted)",
};

const avisoBtn: CSSProperties = {
  marginTop: 6,
  padding: "10px 16px",
  fontSize: 13,
  fontWeight: 600,
  alignSelf: "center",
  background: "var(--bg-input)",
  color: "var(--text)",
  border: "1px solid var(--border-strong)",
  borderRadius: 8,
  cursor: "pointer",
};

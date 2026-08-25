import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { getSessao, getSessaoSync, onSessaoChange, type SessaoCognito } from "./lib/cognito";
import { handleOAuthCallback, listenForOAuthCallback } from "./lib/auth";
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
import { RfidProvider } from "./contexts/RfidContext";

/**
 * Desde a 0.8.0 há UMA sessão só: a do Nexus (Cognito).
 *
 * A 0.7.0 mantinha uma segunda sessão, derivada do Supabase, porque a
 * Etiquetagem e o Rastreio ainda falavam com as tabelas legadas e precisavam
 * satisfazer a RLS delas. Com a fase 3 do corte, tudo passou a ser API do
 * Nexus com o mesmo Bearer — e com a sessão foram embora o handoff, a tela de
 * "Etiquetagem indisponível" e o retry que ela oferecia.
 */
export default function App() {
  // Sessão do NEXUS (Cognito): é ela que diz se o app está logado.
  const [sessao, setSessao] = useState<SessaoCognito | null>(() => getSessaoSync());
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
      stopDeepLink();
      stopNexusHandoff();
      clearTimeout(updateTimer);
    };
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
    if (screen === "rfid")
      content = withBanner(
        <BatchBrowser operatorId={sessao.sub} operatorEmail={email} onBack={back} />,
      );
    else if (screen === "nf") content = withBanner(<Expedicao onBack={back} />);
    else if (screen === "rastreio") content = withBanner(<PieceTrace onBack={back} />);
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








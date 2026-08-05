import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "./lib/supabase";
import { handleOAuthCallback, listenForOAuthCallback } from "./lib/auth";
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
import { RfidProvider } from "./contexts/RfidContext";

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [screen, setScreen] = useState<Screen>("home");
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_evt, sess) => {
      setSession(sess);
      if (!sess) setScreen("home");
    });

    const stopDeepLink = listenForOAuthCallback(async (url) => {
      const { error } = await handleOAuthCallback(url);
      if (error) console.error("OAuth callback falhou:", error);
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
      sub.subscription.unsubscribe();
      stopDeepLink();
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
  } else if (!session) {
    content = withBanner(<Login />);
  } else {
    const email = session.user.email ?? "(sem email)";
    const stationShortId = getStationShortId();
    if (screen === "rfid") content = withBanner(<BatchBrowser session={session} onBack={back} />);
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
  return <RfidProvider>{content}</RfidProvider>;
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

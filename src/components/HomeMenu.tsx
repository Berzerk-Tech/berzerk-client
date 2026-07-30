import {
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
  type SVGProps,
} from "react";
import { supabase } from "../lib/supabase";
import { getStoredTheme, setTheme, type Theme } from "../lib/theme";
import { getDeviceConfig } from "../lib/devices";
import { getMe, canOperateSeparacao } from "../services/orders";
import { BerzerkLogo } from "./BerzerkLogo";
import { AmbientBackground } from "./AmbientBackground";

export type Screen =
  | "home"
  | "rfid"
  | "nf"
  | "rastreio"
  | "separacao"
  | "settings";

type Props = {
  email: string;
  stationShortId: string;
  onEnter: (screen: Screen) => void;
};

export function HomeMenu({ email, onEnter }: Props) {
  const [theme, setThemeLocal] = useState<Theme>(getStoredTheme());
  // Gating da Separação: mostra o card a menos que o backend negue explicitamente
  // a permissão. Falha de rede (API fora) NÃO esconde — segue mostrando (dev).
  const [separacaoAllowed, setSeparacaoAllowed] = useState(true);
  const devices = getDeviceConfig();

  useEffect(() => {
    let alive = true;
    getMe()
      .then((me) => {
        if (alive) setSeparacaoAllowed(canOperateSeparacao(me));
      })
      .catch(() => {
        /* API indisponível: mantém visível pra não travar o operador */
      });
    return () => {
      alive = false;
    };
  }, []);

  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setThemeLocal(next);
  };

  return (
    <div style={page}>
      <AmbientBackground />

      <header style={topBar}>
        {/* Status dos periféricos saiu do meio da tela pra cá (faxina visual):
            informa sem poluir; clique abre as Configurações. */}
        <div style={topLeft}>
          <HwChip
            label="Impressora"
            tone={devices.printer ? "ok" : "warn"}
            title={devices.printer ? "Impressora configurada" : "Impressora não configurada"}
            onClick={() => onEnter("settings")}
          />
          <HwChip
            label="Leitor"
            tone={
              devices.reader.mode === "direct-usb" ||
              devices.reader.mode === "keyboard-wedge" ||
              devices.reader.mode === "itag-ws"
                ? "ok"
                : "neutral"
            }
            title={
              devices.reader.mode === "keyboard-wedge"
                ? "Leitor RFID em modo teclado (plug and play)"
                : devices.reader.mode === "itag-ws"
                  ? "Leitor via WebSocket do iTAG (porta 9098)"
                  : devices.reader.mode === "via-proxy"
                    ? "Leitor RFID via proxy HTTPS"
                    : "Leitor RFID direto"
            }
            onClick={() => onEnter("settings")}
          />
        </div>

        <BerzerkLogo style={topLogoCenter} />

        <div style={topRight}>
          <button
            onClick={toggleTheme}
            style={iconBtn}
            className="berzerk-icon-btn"
            title={theme === "dark" ? "Tema claro" : "Tema escuro"}
            aria-label="Alternar tema"
          >
            {theme === "dark" ? <IconSun style={btnIcon} /> : <IconMoon style={btnIcon} />}
          </button>
          <button
            onClick={() => onEnter("settings")}
            style={iconBtn}
            className="berzerk-icon-btn"
            title="Configurações"
            aria-label="Configurações"
          >
            <IconGear style={btnIcon} />
          </button>
        </div>
      </header>

      <main style={mainCol}>
        <div style={heroBlock}>
          <span style={heroKicker}>― Bem-vindo de volta ―</span>
          <h1 style={heroGreeting}>{firstName(email)}</h1>
        </div>

        <div style={cardsGrid}>
          <ModuleCard
            label="Impressão"
            description="Pra cada lote em produção, lê os EANs e imprime as etiquetas identificadoras (RFID)"
            icon={<IconPrinter />}
            iconBg="var(--info-bg)"
            iconColor="var(--info-text)"
            onClick={() => onEnter("rfid")}
            status="ready"
          />
          <ModuleCard
            label="Separação"
            description="Escolhe a fila (tamanho ou mistos), puxa o próximo pedido e confere as peças pelo leitor RFID"
            icon={<IconBox />}
            iconBg="var(--info-bg)"
            iconColor="var(--info-text)"
            onClick={() => onEnter("separacao")}
            status={separacaoAllowed ? "ready" : "offline"}
          />
          <ModuleCard
            label="Expedição"
            description="Bipa etiqueta, identifica pedido, imprime DANFE automática"
            icon={<IconReceipt />}
            iconBg="var(--warning-bg)"
            iconColor="var(--warning-text)"
            onClick={() => onEnter("nf")}
            status="preview"
          />
        </div>
      </main>

      <footer style={footer}>
        <button onClick={() => supabase.auth.signOut()} style={signOutBtn} className="berzerk-text-btn">
          encerrar sessão
        </button>
      </footer>
    </div>
  );
}

function firstName(email: string): string {
  // leonardo.flores@berzerk.com.br → Leonardo
  const local = email.split("@")[0] ?? email;
  const first = local.split(".")[0] ?? local;
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

// ============================================================
// HwChip — status compacto de periférico na barra superior
// ============================================================
function HwChip({
  label,
  tone,
  title,
  onClick,
}: {
  label: string;
  tone: "ok" | "warn" | "neutral";
  title: string;
  onClick: () => void;
}) {
  const dotColor =
    tone === "ok"
      ? "var(--success-dot)"
      : tone === "warn"
        ? "var(--warning-dot)"
        : "var(--text-muted)";
  return (
    <button type="button" onClick={onClick} style={hwChip} className="berzerk-icon-btn" title={title}>
      <span style={{ ...hwDot, background: dotColor }} />
      {label}
    </button>
  );
}

// ============================================================
// ModuleCard — card de módulo (grade horizontal, texto enxuto)
// ============================================================
function ModuleCard({
  label,
  description,
  icon,
  iconBg,
  iconColor,
  onClick,
  status,
}: {
  label: string;
  description: string;
  icon: ReactNode;
  iconBg: string;
  iconColor: string;
  onClick: () => void;
  status: "ready" | "preview" | "coming-soon" | "offline";
}) {
  const statusInfo =
    status === "ready"
      ? { label: "Operacional", dot: "var(--success-dot)" }
      : status === "preview"
        ? { label: "Preview", dot: "var(--info-text)" }
        : status === "offline"
          ? { label: "Offline", dot: "var(--danger-text)" }
          : { label: "Em breve", dot: "var(--warning-dot)" };

  return (
    <button onClick={onClick} style={moduleCard} className="berzerk-module-card">
      {/* Status virou só a bolinha no canto — hover mostra o nome. */}
      <span
        style={{ ...statusDotCorner, background: statusInfo.dot }}
        title={statusInfo.label}
      />

      <div style={{ ...cardIconWrap, background: iconBg, color: iconColor }}>
        <div style={cardIconInner}>{icon}</div>
      </div>

      <div style={cardBody}>
        <h3 style={cardLabel}>{label}</h3>
        <p style={cardDesc}>{description}</p>
      </div>

      <div style={cardFooter}>
        <span style={cardCta} className="berzerk-arrow">
          Abrir →
        </span>
      </div>
    </button>
  );
}

// ============================================================
// Hover/style injection
// ============================================================
if (typeof document !== "undefined" && !document.getElementById("berzerk-home-keyframes")) {
  const style = document.createElement("style");
  style.id = "berzerk-home-keyframes";
  style.textContent = `
    .berzerk-module-card { position: relative; overflow: hidden; }
    .berzerk-module-card::after {
      content: "";
      position: absolute;
      inset: 0;
      background: linear-gradient(135deg, transparent 60%, var(--bg-card-hover) 100%);
      opacity: 0;
      transition: opacity 200ms;
      pointer-events: none;
    }
    .berzerk-module-card:hover {
      border-color: var(--border-strong) !important;
      transform: translateY(-3px);
    }
    .berzerk-module-card:hover::after { opacity: 0.6; }
    .berzerk-module-card:hover .berzerk-arrow {
      color: var(--text) !important;
      transform: translateX(3px);
    }
    .berzerk-module-card:active { transform: translateY(-1px); }
    .berzerk-icon-btn:hover {
      background: var(--bg-card-hover) !important;
      color: var(--text) !important;
      border-color: var(--border-strong) !important;
    }
    .berzerk-text-btn:hover { color: var(--text) !important; }
  `;
  document.head.appendChild(style);
}

// ============================================================
// Icons
// ============================================================
function IconPrinter(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <polyline points="6 9 6 2 18 2 18 9" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="8" />
    </svg>
  );
}

function IconBox(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  );
}

function IconReceipt(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <line x1="10" y1="9" x2="8" y2="9" />
    </svg>
  );
}

function IconSun(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />
    </svg>
  );
}

function IconMoon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}

function IconGear(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
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
  justifyContent: "space-between",
  padding: "18px 32px",
  borderBottom: "1px solid var(--border)",
  gap: 16,
};

const topLeft: CSSProperties = { display: "flex", alignItems: "center", gap: 8 };

/** Só o lumberjack, centralizado — sem wordmark. */
const topLogoCenter: CSSProperties = {
  position: "absolute",
  left: "50%",
  transform: "translateX(-50%)",
  width: 46,
  height: 48,
  color: "var(--text)",
};

const topRight: CSSProperties = { display: "flex", alignItems: "center", gap: 10 };

const hwChip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 7,
  padding: "6px 12px",
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 999,
  color: "var(--text-secondary)",
  cursor: "pointer",
  fontSize: 11,
  fontWeight: 600,
  transition: "background 120ms, color 120ms, border-color 120ms",
};

const hwDot: CSSProperties = { width: 7, height: 7, borderRadius: "50%" };

const iconBtn: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 32,
  height: 32,
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text-secondary)",
  cursor: "pointer",
  transition: "background 120ms, color 120ms, border-color 120ms",
};

const btnIcon: CSSProperties = { width: 15, height: 15 };

const mainCol: CSSProperties = {
  position: "relative",
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  padding: "48px 32px",
  gap: 36,
  maxWidth: 1280,
  width: "100%",
  margin: "0 auto",
  boxSizing: "border-box",
};

// --- Hero ---

const heroBlock: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 6,
  textAlign: "center",
};

const heroKicker: CSSProperties = {
  fontSize: 11,
  letterSpacing: 4,
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontWeight: 600,
};

const heroGreeting: CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-display)",
  fontSize: 56,
  fontWeight: 400,
  color: "var(--text)",
  letterSpacing: 1,
  lineHeight: 1,
};

// --- Cards ---

const cardsGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(3, 1fr)",
  gap: 20,
  width: "100%",
};

const moduleCard: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "stretch",
  gap: 20,
  padding: 26,
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 16,
  cursor: "pointer",
  textAlign: "left",
  color: "var(--text)",
  transition: "background 160ms, border-color 160ms, transform 160ms",
  minHeight: 230,
  fontFamily: "inherit",
};

/** Status do módulo: só a bolinha no canto superior direito do card. */
const statusDotCorner: CSSProperties = {
  position: "absolute",
  top: 16,
  right: 16,
  width: 8,
  height: 8,
  borderRadius: "50%",
};

const cardIconWrap: CSSProperties = {
  width: 60,
  height: 60,
  borderRadius: 15,
  display: "grid",
  placeItems: "center",
  border: "1px solid",
  borderColor: "transparent",
};

const cardIconInner: CSSProperties = {
  width: 28,
  height: 28,
};

const cardBody: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  flex: 1,
};

const cardLabel: CSSProperties = {
  margin: 0,
  fontSize: 24,
  fontWeight: 700,
  letterSpacing: -0.4,
  color: "var(--text)",
  lineHeight: 1.1,
};

/** Descrição apagadinha de propósito — o operador diário não precisa reler. */
const cardDesc: CSSProperties = {
  margin: 0,
  fontSize: 12.5,
  color: "var(--text-muted)",
  lineHeight: 1.55,
};

const cardFooter: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "flex-end",
  paddingTop: 14,
  borderTop: "1px solid var(--border)",
  marginTop: "auto",
};

const cardCta: CSSProperties = {
  fontSize: 12,
  letterSpacing: 1.5,
  textTransform: "uppercase",
  fontWeight: 700,
  color: "var(--text-muted)",
  transition: "color 160ms, transform 160ms",
};

const footer: CSSProperties = {
  position: "relative",
  display: "flex",
  justifyContent: "center",
  padding: "18px 32px",
  borderTop: "1px solid var(--border)",
};

const signOutBtn: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 10,
  padding: "4px 8px",
  textTransform: "uppercase",
  letterSpacing: 2,
  fontWeight: 600,
  transition: "color 160ms",
};

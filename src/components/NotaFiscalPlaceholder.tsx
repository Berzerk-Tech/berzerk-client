import { useEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { BackButton } from "./BackButton";
import { AmbientBackground } from "./AmbientBackground";

type Props = { onBack: () => void };

// Fluxo físico da mesa de expedição:
//   1. LER       — RFID da mesa identifica o pedido
//   2. IMPRIMIR  — DANFE sai automática
//   3. EMBALAR   — saco desce, ar sopra, operador coloca pedido dentro
//   4. FECHAR    — operador aperta botão vermelho, pacote rola pro chão
//
// Limitação: o botão vermelho é hardware da própria mesa — não emite
// evento capturável pelo Windows. Não dá pra travar leitor até ele.
//
// Solução: estado `packing` é PURAMENTE visual — não bloqueia leituras.
//   - Auto-timeout de PACKING_MS volta pra idle automaticamente
//   - Se outra leitura chegar durante packing, auto-confirma o atual e
//     inicia o próximo (não perde o EPC novo)
//   - Botão "Pacote fechado" é opcional — adianta o timer
//
// O ganho real é UX: o operador vê de longe em qual etapa a mesa está,
// e o stepper deixa visível mesmo sem entender o sistema.

type Step = "ler" | "imprimir" | "embalar" | "fechar";

type FlowState =
  | { kind: "idle" }
  | { kind: "reading"; epc: string }
  | { kind: "found"; order: MockOrder }
  | { kind: "printing"; order: MockOrder }
  | { kind: "packing"; order: MockOrder; epc: string }
  | { kind: "sealed"; order: MockOrder }
  | { kind: "error"; message: string };

type Prefetch =
  | { status: "loading"; epc: string }
  | { status: "ready"; epc: string; order: MockOrder };

type MockOrder = {
  number: string;
  customer: string;
  city: string;
  uf: string;
  itemCount: number;
  total: string;
  channel: string;
};

type StepStatus = "active" | "done" | "pending";

const PACKING_MS = 5000; // auto-volta pra idle após 5s embalando

function statusOfStep(state: FlowState, step: Step): StepStatus {
  const order: Record<Step, number> = { ler: 0, imprimir: 1, embalar: 2, fechar: 3 };
  const current: Record<FlowState["kind"], Step | null> = {
    idle: "ler",
    reading: "ler",
    found: "imprimir",
    printing: "imprimir",
    packing: "embalar",
    sealed: "fechar",
    error: null,
  };
  const cur = current[state.kind];
  if (!cur) return "pending";
  if (cur === step) return "active";
  if (order[cur] > order[step]) return "done";
  return "pending";
}

export function NotaFiscalPlaceholder({ onBack }: Props) {
  const [state, setState] = useState<FlowState>({ kind: "idle" });
  // Último pedido despachado — o "PRONTO" mostra o resumo como feedback visual
  // de que o despacho anterior fechou de verdade.
  const [lastSealed, setLastSealed] = useState<MockOrder | null>(null);
  const [scan, setScan] = useState("");
  const [packingProgress, setPackingProgress] = useState(0);
  const [prefetch, setPrefetch] = useState<Prefetch | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const recent = useRef<Array<{ order: string; at: Date }>>([]);
  // EPCs já vistos nesta sessão — evita re-disparar fluxo se a mesa relê
  // o mesmo pedido (que ainda tá fisicamente em cima dela)
  const processedEpcs = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (state.kind === "sealed") setLastSealed(state.order);
  }, [state]);

  // Foco automático — input fica vivo em quase tudo (exceto processamento ativo)
  useEffect(() => {
    if (state.kind === "idle" || state.kind === "packing" || state.kind === "sealed") {
      inputRef.current?.focus();
    }
  }, [state.kind]);

  // Timer do `packing` — countdown visual + transição automática
  useEffect(() => {
    if (state.kind !== "packing") {
      setPackingProgress(0);
      return;
    }
    const start = Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - start;
      const ratio = Math.min(1, elapsed / PACKING_MS);
      setPackingProgress(ratio);
      if (ratio >= 1) {
        clearInterval(interval);
        finishPacking();
      }
    }, 80);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind]);

  function finishPacking() {
    setState((s) => {
      if (s.kind !== "packing") return s;
      recent.current.unshift({ order: s.order.number, at: new Date() });
      recent.current = recent.current.slice(0, 5);

      // Se há um prefetch já resolvido, pula idle e vai direto pro próximo
      // pedido (zero latência entre pedidos)
      if (prefetch && prefetch.status === "ready") {
        const next = prefetch;
        setPrefetch(null);
        // Inicia o ciclo do próximo já em "printing" (achou rápido por prefetch)
        setTimeout(() => {
          setState({ kind: "printing", order: next.order });
          setTimeout(() => {
            setState((cur) =>
              cur.kind === "printing"
                ? { kind: "packing", order: cur.order, epc: next.epc }
                : cur,
            );
          }, 1500);
        }, 600);
        return { kind: "found", order: next.order };
      }

      // Se há prefetch em andamento, mostra "lendo" enquanto resolve
      if (prefetch && prefetch.status === "loading") {
        return { kind: "reading", epc: prefetch.epc };
      }

      return { kind: "sealed", order: s.order };
    });
    // Quando virou sealed, dá fade pra idle
    setTimeout(() => {
      setState((s) => (s.kind === "sealed" ? { kind: "idle" } : s));
    }, 1100);
  }

  function mockLookupOrder(): MockOrder {
    const orderNumber = `BRZ-${10000 + Math.floor(Math.random() * 9000)}`;
    return {
      number: orderNumber,
      customer: "Cliente Demonstração",
      city: "São Paulo",
      uf: "SP",
      itemCount: 3,
      total: "R$ 287,90",
      channel: "Shopify",
    };
  }

  function startNewRead(epc: string) {
    processedEpcs.current.add(epc);
    setState({ kind: "reading", epc });

    setTimeout(() => {
      const order = mockLookupOrder();
      setState({ kind: "found", order });

      setTimeout(() => {
        setState((s) => (s.kind === "found" ? { kind: "printing", order: s.order } : s));
        setTimeout(() => {
          setState((s) =>
            s.kind === "printing" ? { kind: "packing", order: s.order, epc } : s,
          );
        }, 1500);
      }, 800);
    }, 500);
  }

  function startPrefetch(epc: string) {
    processedEpcs.current.add(epc);
    setPrefetch({ status: "loading", epc });

    // Mock lookup (mesma duração da leitura real)
    setTimeout(() => {
      const order = mockLookupOrder();
      // Só seta se ainda estamos em packing E o prefetch ainda é desse EPC
      setPrefetch((cur) => (cur && cur.epc === epc ? { status: "ready", epc, order } : cur));
    }, 500);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const epc = scan.trim();
    if (!epc) return;
    setScan("");

    // Mesa relê o EPC que ainda tá nela — ignora silenciosamente
    if (processedEpcs.current.has(epc)) return;

    // Se já está processando ativamente (reading/found/printing), ignora
    if (state.kind === "reading" || state.kind === "found" || state.kind === "printing") {
      return;
    }

    // Durante packing: dispara prefetch em background. Quando packing
    // terminar, o próximo pedido vai estar pronto pra mostrar imediato.
    if (state.kind === "packing") {
      // Se já tem prefetch ativo desse EPC, ignora
      if (prefetch && prefetch.epc === epc) return;
      startPrefetch(epc);
      return;
    }

    startNewRead(epc);
  }

  function handleSeal() {
    if (state.kind !== "packing") return;
    finishPacking();
  }

  function handleAbort() {
    setPrefetch(null);
    setState({ kind: "idle" });
  }

  return (
    <div style={page}>
      <AmbientBackground variant="flat" />

      <header style={subHeader}>
        <div style={subHeaderLeft}>
          <BackButton onClick={onBack} />
        </div>
        <h2 style={title}>Expedição</h2>
        <div style={subHeaderRight}>
          <span style={badge}>preview</span>
        </div>
      </header>

      <StepIndicator state={state} />

      <main style={stage}>
        <StageHero
          state={state}
          packingProgress={packingProgress}
          prefetch={prefetch}
          lastSealed={lastSealed}
          onSeal={handleSeal}
          onAbort={handleAbort}
        />
      </main>

      <footer style={footer}>
        <ScanInput
          inputRef={inputRef}
          scan={scan}
          setScan={setScan}
          onSubmit={handleSubmit}
          state={state}
        />
        <RecentList items={recent.current} />
      </footer>
    </div>
  );
}

// ============================================================
// Stepper visual no topo — 4 etapas com nome e dot
// ============================================================
function StepIndicator({ state }: { state: FlowState }) {
  const steps: Array<{ id: Step; label: string }> = [
    { id: "ler", label: "Ler" },
    { id: "imprimir", label: "Imprimir" },
    { id: "embalar", label: "Embalar" },
    { id: "fechar", label: "Fechar" },
  ];

  return (
    <div style={stepperWrap}>
      {steps.map((step, i) => {
        const status = statusOfStep(state, step.id);
        return (
          <div key={step.id} style={stepCell}>
            <div style={stepRow}>
              <span
                style={{
                  ...stepDot,
                  ...(status === "active" ? stepDotActive : {}),
                  ...(status === "done" ? stepDotDone : {}),
                }}
              >
                {status === "done" ? "✓" : String(i + 1)}
              </span>
              <span
                style={{
                  ...stepLabel,
                  color: status === "pending" ? "var(--text-faint)" : "var(--text)",
                  fontWeight: status === "active" ? 700 : 500,
                }}
              >
                {step.label}
              </span>
            </div>
            {i < steps.length - 1 && (
              <span
                style={{
                  ...stepBar,
                  background: status === "done" ? "var(--text)" : "var(--border)",
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ============================================================
// Centro da tela — estado dominante em fonte massiva
// ============================================================
function StageHero({
  state,
  packingProgress,
  prefetch,
  lastSealed,
  onSeal,
  onAbort,
}: {
  state: FlowState;
  packingProgress: number;
  prefetch: Prefetch | null;
  lastSealed: MockOrder | null;
  onSeal: () => void;
  onAbort: () => void;
}) {
  if (state.kind === "idle") {
    return (
      <div style={hero}>
        <div style={{ ...heroAccent, background: "var(--success-dot)" }} />
        <h1 style={heroDisplay}>PRONTO</h1>
        <p style={heroHint}>Coloque o próximo pedido na mesa</p>
        {lastSealed && (
          <p style={heroLastSealed}>
            Último despacho: <strong>{lastSealed.number}</strong> ·{" "}
            {lastSealed.itemCount} {lastSealed.itemCount === 1 ? "item" : "itens"} ·{" "}
            {lastSealed.customer}
          </p>
        )}
      </div>
    );
  }

  if (state.kind === "reading") {
    return (
      <div style={hero}>
        <PulsingDot tone="info" />
        <h1 style={{ ...heroDisplay, color: "var(--info-text)" }}>LENDO</h1>
        <p style={heroHint}>Identificando etiqueta RFID…</p>
        <code style={heroEpc}>{state.epc}</code>
      </div>
    );
  }

  if (state.kind === "found" || state.kind === "printing") {
    const printing = state.kind === "printing";
    return (
      <div style={hero}>
        <PulsingDot tone={printing ? "info" : "info"} />
        <h1 style={{ ...heroDisplay, color: "var(--info-text)" }}>
          {printing ? "IMPRIMINDO" : "IDENTIFICADO"}
        </h1>
        <div style={heroOrderCard}>
          <div style={heroOrderRow}>
            <span style={heroOrderKey}>Pedido</span>
            <code style={heroOrderValue}>{state.order.number}</code>
          </div>
          <div style={heroOrderRow}>
            <span style={heroOrderKey}>{state.order.customer}</span>
            <span style={heroOrderValueDim}>
              {state.order.city} / {state.order.uf}
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (state.kind === "packing") {
    const remainingSec = Math.max(0, Math.ceil(5 * (1 - packingProgress)));
    return (
      <div style={{ ...hero, ...heroPacking }}>
        <div style={packingFrame}>
          <span style={packingKicker}>― Embalando ―</span>
          <h1 style={{ ...heroDisplay, color: "var(--warning-text)" }}>
            EMBALE O PEDIDO
          </h1>
          <code style={packingOrder}>{state.order.number}</code>
          <div style={packingProgressBar}>
            <div
              style={{
                ...packingProgressFill,
                width: `${packingProgress * 100}%`,
              }}
            />
          </div>
          <p style={packingHint}>
            Libera em <strong>{remainingSec}s</strong> · pode já passar o próximo
            pedido na mesa que adiantamos a consulta.
          </p>
        </div>

        <PrefetchBadge prefetch={prefetch} />

        <div style={packingActions}>
          <button type="button" onClick={onAbort} style={btnSecondary} className="berzerk-btn-ghost">
            Cancelar
          </button>
          <button
            type="button"
            onClick={onSeal}
            style={btnRed}
            className="berzerk-btn-red"
          >
            <SealIcon />
            Próximo pedido
          </button>
        </div>
      </div>
    );
  }

  if (state.kind === "sealed") {
    return (
      <div style={hero}>
        <div style={{ ...heroAccent, background: "var(--success-dot)" }} />
        <h1 style={{ ...heroDisplay, color: "var(--success-text)" }}>✓ ENVIADO</h1>
        <p style={heroHint}>Pacote {state.order.number} despachado.</p>
      </div>
    );
  }

  return (
    <div style={hero}>
      <h1 style={{ ...heroDisplay, color: "var(--danger-text)" }}>ERRO</h1>
      <p style={heroHint}>{state.message}</p>
      <button type="button" onClick={onAbort} style={btnSecondary}>
        Voltar
      </button>
    </div>
  );
}

// ============================================================
// Rodapé — input (locked durante non-idle) + histórico
// ============================================================
function PrefetchBadge({ prefetch }: { prefetch: Prefetch | null }) {
  if (!prefetch) return null;
  if (prefetch.status === "loading") {
    return (
      <div style={{ ...prefetchBox, color: "var(--text-secondary)", borderColor: "var(--border)" }}>
        <PulsingDot tone="info" />
        <div style={prefetchCol}>
          <span style={prefetchKicker}>― Próximo na mesa ―</span>
          <span style={prefetchStatus}>Adiantando consulta…</span>
        </div>
      </div>
    );
  }
  return (
    <div style={{ ...prefetchBox, color: "var(--success-text)", borderColor: "var(--success-border)" }}>
      <span style={{ ...heroAccent, background: "var(--success-dot)" }} />
      <div style={prefetchCol}>
        <span style={prefetchKicker}>― Próximo pronto ―</span>
        <code style={prefetchOrder}>{prefetch.order.number}</code>
      </div>
    </div>
  );
}

function ScanInput({
  inputRef,
  scan,
  setScan,
  onSubmit,
  state,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  scan: string;
  setScan: (s: string) => void;
  onSubmit: (e: FormEvent) => void;
  state: FlowState;
}) {
  // Aceita bipada em: idle (normal), packing (auto-confirma anterior), sealed (logo vira idle)
  // Recusa em: reading/found/printing (já tem processamento ativo)
  const busy = state.kind === "reading" || state.kind === "found" || state.kind === "printing";
  const placeholder =
    busy
      ? "Processando bipada anterior…"
      : state.kind === "packing"
        ? "Pode bipar o próximo — confirmamos o atual sozinho"
        : "Aguardando bipada — ou digite o EPC e tecle Enter";

  return (
    <form onSubmit={onSubmit} style={scanForm}>
      <span style={{ ...scanIconBox, opacity: busy ? 0.4 : 1 }}>
        <ScanIcon />
      </span>
      <input
        ref={inputRef}
        autoFocus
        disabled={busy}
        value={scan}
        onChange={(e) => setScan(e.target.value)}
        placeholder={placeholder}
        style={{ ...scanInput, opacity: busy ? 0.5 : 1 }}
        className="berzerk-scan-input"
      />
    </form>
  );
}

function RecentList({ items }: { items: Array<{ order: string; at: Date }> }) {
  if (items.length === 0) {
    return <div style={recentEmpty}>Nenhum pedido despachado nesta sessão</div>;
  }
  return (
    <div style={recentBar}>
      <span style={recentKicker}>Sessão</span>
      <div style={recentItems}>
        {items.map((it, i) => (
          <div key={i} style={recentChip}>
            <span style={recentDot} />
            <code style={recentOrder}>{it.order}</code>
            <span style={recentTime}>
              {it.at.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Componentes visuais auxiliares
// ============================================================
function PulsingDot({ tone }: { tone: "info" | "warning" | "success" }) {
  const color =
    tone === "info"
      ? "var(--info-text)"
      : tone === "warning"
        ? "var(--warning-text)"
        : "var(--success-text)";
  return (
    <div style={{ ...heroAccent, background: color, animation: "berzerk-pulse-dot 1.2s ease-in-out infinite" }} />
  );
}

function ScanIcon() {
  return (
    <svg width={32} height={32} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="6" width="2" height="12" />
      <rect x="7" y="6" width="1" height="12" />
      <rect x="10" y="6" width="3" height="12" />
      <rect x="15" y="6" width="1" height="12" />
      <rect x="18" y="6" width="2" height="12" />
    </svg>
  );
}

function SealIcon() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

// ============================================================
// Animations + hover injection
// ============================================================
if (typeof document !== "undefined" && !document.getElementById("berzerk-nf-styles")) {
  const style = document.createElement("style");
  style.id = "berzerk-nf-styles";
  style.textContent = `
    @keyframes berzerk-pulse-dot {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.6); opacity: 0.6; }
    }
    .berzerk-scan-input:focus {
      outline: none;
      border-color: var(--text) !important;
      background: var(--bg-elevated) !important;
    }
    .berzerk-btn-red:hover { background: #b91c1c !important; }
    .berzerk-btn-ghost:hover {
      background: var(--bg-card-hover) !important;
      border-color: var(--border-strong) !important;
    }
  `;
  document.head.appendChild(style);
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
const subHeaderRight: CSSProperties = { gridColumn: "3", justifySelf: "end" };

const title: CSSProperties = {
  margin: 0,
  fontSize: 17,
  fontWeight: 600,
  color: "var(--text)",
  letterSpacing: -0.1,
};

const badge: CSSProperties = {
  fontSize: 10,
  letterSpacing: 1.5,
  textTransform: "uppercase",
  color: "var(--warning-text)",
  background: "var(--warning-bg)",
  border: "1px solid var(--warning-border)",
  padding: "3px 9px",
  borderRadius: 999,
  fontWeight: 700,
};

// ---- Stepper ----
const stepperWrap: CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 0,
  padding: "24px 40px",
  borderBottom: "1px solid var(--border)",
};

const stepCell: CSSProperties = {
  display: "flex",
  alignItems: "center",
  flex: "0 0 auto",
};

const stepRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
};

const stepDot: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: "50%",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  color: "var(--text-muted)",
  display: "grid",
  placeItems: "center",
  fontSize: 12,
  fontFamily: "var(--font-mono)",
  fontWeight: 700,
  transition: "all 200ms",
};

const stepDotActive: CSSProperties = {
  background: "var(--text)",
  color: "var(--accent-text)",
  borderColor: "var(--text)",
  transform: "scale(1.1)",
  boxShadow: "0 0 0 4px var(--bg)",
};

const stepDotDone: CSSProperties = {
  background: "var(--success-dot)",
  color: "white",
  borderColor: "var(--success-dot)",
};

const stepLabel: CSSProperties = {
  fontSize: 12,
  letterSpacing: 1.5,
  textTransform: "uppercase",
  transition: "color 200ms, font-weight 200ms",
};

const stepBar: CSSProperties = {
  width: 60,
  height: 1,
  margin: "0 16px",
  transition: "background 200ms",
};

// ---- Stage (centro) ----
const stage: CSSProperties = {
  position: "relative",
  flex: 1,
  display: "grid",
  placeItems: "center",
  padding: "40px 24px",
};

const hero: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 18,
  textAlign: "center",
  maxWidth: 720,
};

const heroPacking: CSSProperties = {
  gap: 32,
};

const heroAccent: CSSProperties = {
  width: 14,
  height: 14,
  borderRadius: "50%",
  marginBottom: 4,
};

const heroDisplay: CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-display)",
  fontSize: 96,
  fontWeight: 400,
  letterSpacing: 2,
  lineHeight: 1,
  color: "var(--text)",
};

const heroHint: CSSProperties = {
  margin: 0,
  fontSize: 14,
  color: "var(--text-secondary)",
};

const heroLastSealed: CSSProperties = {
  margin: 0,
  marginTop: 10,
  fontSize: 13,
  color: "var(--text-muted)",
  padding: "8px 16px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 999,
};

const heroEpc: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  color: "var(--text)",
  background: "var(--bg-input)",
  padding: "6px 12px",
  borderRadius: 6,
  border: "1px solid var(--border)",
};

const heroOrderCard: CSSProperties = {
  marginTop: 16,
  padding: "16px 24px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  minWidth: 340,
};

const heroOrderRow: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 16,
};

const heroOrderKey: CSSProperties = {
  fontSize: 11,
  letterSpacing: 1.5,
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontWeight: 700,
};

const heroOrderValue: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 18,
  color: "var(--text)",
  fontWeight: 600,
};

const heroOrderValueDim: CSSProperties = {
  fontSize: 13,
  color: "var(--text-secondary)",
};

// ---- Packing state (lock) ----
const packingFrame: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 12,
  padding: "32px 40px",
  background: "var(--warning-bg)",
  border: "2px solid var(--warning-border)",
  borderRadius: 18,
};

const packingKicker: CSSProperties = {
  fontSize: 11,
  letterSpacing: 4,
  textTransform: "uppercase",
  color: "var(--warning-text)",
  fontWeight: 700,
};

const packingOrder: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 22,
  color: "var(--warning-text)",
  fontWeight: 600,
  marginTop: 4,
};

const packingHint: CSSProperties = {
  margin: 0,
  fontSize: 13,
  color: "var(--text-secondary)",
  marginTop: 8,
  maxWidth: 460,
  lineHeight: 1.5,
};

const packingProgressBar: CSSProperties = {
  width: 280,
  height: 4,
  background: "rgba(0, 0, 0, 0.18)",
  borderRadius: 999,
  overflow: "hidden",
  marginTop: 14,
};

const packingProgressFill: CSSProperties = {
  height: "100%",
  background: "var(--warning-text)",
  transition: "width 80ms linear",
};

const packingActions: CSSProperties = {
  display: "flex",
  gap: 12,
  alignItems: "center",
};

const prefetchBox: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
  padding: "12px 18px",
  background: "var(--bg-card)",
  border: "1px solid",
  borderRadius: 12,
  minWidth: 280,
};

const prefetchCol: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const prefetchKicker: CSSProperties = {
  fontSize: 9,
  letterSpacing: 2,
  textTransform: "uppercase",
  fontWeight: 700,
  opacity: 0.8,
};

const prefetchStatus: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
};

const prefetchOrder: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 16,
  fontWeight: 600,
};

const btnRed: CSSProperties = {
  padding: "16px 32px",
  fontSize: 16,
  fontWeight: 700,
  border: 0,
  borderRadius: 12,
  background: "#dc2626",
  color: "white",
  cursor: "pointer",
  textTransform: "uppercase",
  letterSpacing: 1.2,
  display: "flex",
  alignItems: "center",
  gap: 10,
  transition: "background 120ms",
  boxShadow: "0 4px 12px -4px rgba(220, 38, 38, 0.4)",
};

const btnSecondary: CSSProperties = {
  padding: "14px 20px",
  fontSize: 13,
  fontWeight: 600,
  border: "1px solid var(--border)",
  borderRadius: 10,
  background: "transparent",
  color: "var(--text-secondary)",
  cursor: "pointer",
  textTransform: "uppercase",
  letterSpacing: 1,
};

// ---- Footer (scan input + recent) ----
const footer: CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: "20px 40px 28px",
  borderTop: "1px solid var(--border)",
  background: "var(--bg)",
};

const scanForm: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 16,
};

const scanIconBox: CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: 56,
  height: 56,
  borderRadius: 12,
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  color: "var(--text)",
  flexShrink: 0,
  transition: "opacity 200ms",
};

const scanInput: CSSProperties = {
  flex: 1,
  padding: "16px 20px",
  fontSize: 16,
  fontFamily: "var(--font-mono)",
  background: "var(--bg-input)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  boxSizing: "border-box",
  transition: "border-color 120ms, background 120ms, opacity 200ms",
};

const recentEmpty: CSSProperties = {
  fontSize: 11,
  color: "var(--text-faint)",
  fontStyle: "italic",
  textAlign: "center",
};

const recentBar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
  overflowX: "auto",
};

const recentKicker: CSSProperties = {
  fontSize: 10,
  letterSpacing: 2,
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontWeight: 700,
  flexShrink: 0,
};

const recentItems: CSSProperties = {
  display: "flex",
  gap: 8,
};

const recentChip: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 12px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 999,
  fontSize: 12,
};

const recentDot: CSSProperties = {
  width: 6,
  height: 6,
  borderRadius: "50%",
  background: "var(--success-dot)",
};

const recentOrder: CSSProperties = {
  fontFamily: "var(--font-mono)",
  color: "var(--text)",
};

const recentTime: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--text-muted)",
};

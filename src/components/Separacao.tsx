import { useEffect, useState, type CSSProperties } from "react";
import { BackButton } from "./BackButton";
import { AmbientBackground } from "./AmbientBackground";
import { OperatorChip } from "./OperatorChip";
import { SeparacaoRunner } from "./SeparacaoRunner";
import { useRfid } from "../contexts/RfidContext";
import { ApiError } from "../lib/api";
import { QUEUES, SEM_TAMANHO, queueFor, type Queue } from "../lib/filas";
import { subscribeQueueChanged } from "../lib/realtime";
import {
  devolverLote,
  getMeusPedidos,
  getQueueCounts,
  type Order,
  type QueueCounts,
} from "../services/orders";

type Props = { onBack: () => void };

/** Cada tamanho tem duas abas: Puro (grade normal) e Mistos (grade mista). */
type QueueMode = "puro" | "mistos";

/** Fila escolhida: um tamanho por vez, na aba ativa. */
type Selected = string | null;

export function Separacao({ onBack }: Props) {
  const rfid = useRfid();
  const [mode, setMode] = useState<QueueMode>("puro");
  const [selected, setSelected] = useState<Selected>(null);
  const [confirmed, setConfirmed] = useState<{
    size: Queue;
    mode: QueueMode;
    /** Tamanhos REAIS do bucket no momento do confirm (o claim usa esta lista). */
    sizes: string[];
    /** Entrou por "Retomar" com uma lista de picking já impressa na mão. */
    retomandoLista?: boolean;
  } | null>(null);
  const [counts, setCounts] = useState<QueueCounts | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  /** Pedidos que já são da operadora (lote de outra sessão/estação). */
  const [emAberto, setEmAberto] = useState<Order[]>([]);
  const [devolvendo, setDevolvendo] = useState(false);

  // Contagem das filas: o WS do nexus empurra `queue.changed` (tiny-sync,
  // claim, complete, release) e cada evento refaz o fetch; o intervalo de 60s
  // é só rede de segurança pro WS cair. Erro de auth/permissão é a API dizendo
  // quem pode operar — mostra, não engole. Falha de rede segue silenciosa.
  useEffect(() => {
    let alive = true;
    const load = () => {
      getQueueCounts()
        .then((c) => {
          if (!alive) return;
          setCounts(c);
          setAuthError(null);
        })
        .catch((err) => {
          if (!alive || !(err instanceof ApiError)) return;
          if (err.status === 403) {
            setAuthError(
              "Seu usuário não tem a permissão de Separação (separacao:operate). Peça pra liberar no Nexus (Operadores).",
            );
          } else if (err.status === 401) {
            setAuthError(
              "A API não reconheceu sua sessão. Troque de usuário e entre de novo; se persistir, avise o suporte.",
            );
          }
        });
    };
    load();
    const unsubscribe = subscribeQueueChanged(load);
    const id = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(id);
      unsubscribe();
    };
  }, []);

  // Lote em aberto de antes: app fechado no meio do turno, troca de estação,
  // sessão derrubada. Sem isto os pedidos ficariam reservados e invisíveis pra
  // ela e pras outras até o janitor expirar o claim. 404 = nexus antigo.
  useEffect(() => {
    if (confirmed) return;
    let alive = true;
    getMeusPedidos()
      .then((r) => alive && setEmAberto(r.orders))
      .catch(() => {
        /* sem retomada: o fluxo normal segue */
      });
    return () => {
      alive = false;
    };
  }, [confirmed]);

  if (confirmed) {
    const isMixed = confirmed.mode === "mistos";
    return (
      <SeparacaoRunner
        title={isMixed ? "Separação — Mistos" : "Separação"}
        kicker={`Fila ${confirmed.size} — ${isMixed ? "Mistos" : "Puro"}`}
        emptyHint={
          isMixed
            ? "Nenhum pedido misto pronto nesse tamanho. Tente outra aba ou aguarde a sincronização."
            : "Nenhum pedido pronto nessa fila. Tente outra ou aguarde a sincronização."
        }
        queue={{
          mode: isMixed ? "total" : "normal",
          size: confirmed.size,
          sizes: confirmed.sizes,
        }}
        retomandoLista={confirmed.retomandoLista}
        onBack={() => setConfirmed(null)}
      />
    );
  }

  const recordFor = (m: QueueMode): Record<string, number> =>
    (m === "mistos" ? counts?.mixedBySize : counts?.sizes) ?? {};

  // Contadores agrupados nas filas (as 5 fixas + "Sem tamanho").
  const bucketed = (m: QueueMode): Record<Queue, number> => {
    const out: Record<Queue, number> = { P: 0, M: 0, G: 0, GG: 0, XG: 0, [SEM_TAMANHO]: 0 };
    for (const [k, v] of Object.entries(recordFor(m))) out[queueFor(k)] += v;
    return out;
  };
  const countFor = (q: Queue, m: QueueMode): number => bucketed(m)[q];
  const totalFor = (m: QueueMode): number =>
    Object.values(bucketed(m)).reduce((acc, n) => acc + n, 0);

  /** Tamanhos reais que caem no bucket (pro claim cobrir XXG/G1/G2/G3 etc.). */
  const sizesForQueue = (q: Queue, m: QueueMode): string[] => {
    const keys = Object.keys(recordFor(m))
      .map((k) => k.trim().toUpperCase())
      .filter((k) => queueFor(k) === q);
    return Array.from(new Set([q, ...keys]));
  };

  const effectiveSelected = selected as Queue | null;
  // O tile "Sem tamanho" só aparece quando existe pedido órfão — do contrário
  // é uma sexta caixa vazia disputando espaço com as 5 bancadas reais.
  const semTamanho = countFor(SEM_TAMANHO, mode);

  /** Fila de onde veio o lote em aberto (pelo 1º pedido) + tamanhos reais. */
  const filaEmAberto = (() => {
    const primeiro = emAberto[0];
    if (!primeiro) return null;
    const m: QueueMode = primeiro.separationMode === "total" ? "mistos" : "puro";
    const q = queueFor(primeiro.predominantSize ?? "") ?? "XG";
    // Junta os tamanhos reais dos pedidos em aberto: o bucket vem dos counts,
    // que podem não listar um tamanho que só existe nos pedidos JÁ reservados
    // (eles saíram da fila e por isso não contam mais).
    const sizes = Array.from(
      new Set([
        ...sizesForQueue(q, m),
        ...emAberto
          .map((o) => (o.predominantSize ?? "").trim().toUpperCase())
          .filter((t) => t.length > 0),
      ]),
    );
    return { size: q, mode: m, sizes };
  })();

  /**
   * Pedidos com LISTA de picking impressa. Eles são imunes ao janitor, então
   * uma lista que ficou de ontem só sai daqui se alguém agir — este banner é
   * essa saída (e o motivo de `meus-pedidos` marcar `listaDeOutroDia`).
   */
  const comLista = emAberto.filter((o) => !!o.listaEm);
  const listaDeOutroDia = comLista.find((o) => o.listaDeOutroDia);

  // Banner "em aberto": devolve só o que NÃO tem lista impressa. A lista fica
  // presa com quem imprimiu (04/09: 73 pedidos da Nicole voltaram pra fila por
  // um devolver e outra mesa levou) — pra soltar a lista é de dentro da fila,
  // pelo "Devolver tudo" explícito.
  const [avisoLista, setAvisoLista] = useState<string | null>(null);
  const devolverEmAberto = async () => {
    setDevolvendo(true);
    try {
      const semLista = emAberto.filter((o) => !o.listaEm);
      if (semLista.length > 0) await devolverLote(semLista.map((o) => o.id));
      const ficam = emAberto.filter((o) => !!o.listaEm);
      setEmAberto(ficam);
      setAvisoLista(
        ficam.length > 0
          ? `${ficam.length} ${ficam.length === 1 ? "pedido é" : "pedidos são"} de lista impressa e ${ficam.length === 1 ? "fica" : "ficam"} com você até o fim do dia — só o supervisor devolve, pelo Nexus.`
          : null,
      );
    } catch {
      /* fica o banner: ela pode retomar e devolver de dentro da fila */
    } finally {
      setDevolvendo(false);
    }
  };

  return (
    <div style={page}>
      <AmbientBackground />
      <header style={topBar}>
        <BackButton onClick={onBack} />
        <div style={titleWrap}>
          <span style={kicker}>― Separação ―</span>
          <h1 style={title}>Escolha a fila</h1>
        </div>
        <OperatorChip />
        <button style={mesaChip} onClick={() => void rfid.reconnect()} title={rfid.host}>
          <span
            style={{
              ...mesaDot,
              background: rfid.connected ? "var(--success-dot)" : "var(--danger-text)",
            }}
          />
          <span style={mesaText}>{rfid.connected ? "Mesa conectada" : "Mesa offline"}</span>
        </button>
      </header>

      {!rfid.connected && (
        <div style={mesaDownBanner}>
          Mesa RFID desconectada ({rfid.host}). Configure/ligue a mesa antes de começar.{" "}
          <button style={inlineReconnect} onClick={() => void rfid.reconnect()}>
            tentar agora
          </button>
        </div>
      )}

      {authError && <div style={mesaDownBanner}>{authError}</div>}

      {filaEmAberto && (
        <div style={listaDeOutroDia ? retomarBannerAlerta : retomarBanner}>
          {comLista.length > 0 ? (
            <>
              🖨 Você tem uma <strong>lista de {filaEmAberto.mode === "mistos" ? "mistos" : "pedidos"}</strong>{" "}
              {listaDeOutroDia ? (
                <>
                  de <strong>{fmtDia(listaDeOutroDia.listaEm!)}</strong>
                </>
              ) : (
                "de hoje"
              )}{" "}
              com <strong>{comLista.length}</strong>{" "}
              {comLista.length === 1 ? "pedido" : "pedidos"} reservados.{" "}
            </>
          ) : (
            <>
              Você tem <strong>{emAberto.length}</strong>{" "}
              {emAberto.length === 1 ? "pedido em aberto" : "pedidos em aberto"} na fila{" "}
              <strong>
                {filaEmAberto.size} {filaEmAberto.mode === "mistos" ? "Mistos" : "Puro"}
              </strong>
              .{" "}
            </>
          )}
          <button
            style={retomarBtn}
            onClick={() =>
              setConfirmed({ ...filaEmAberto, retomandoLista: comLista.length > 0 })
            }
          >
            Retomar
          </button>
          <button style={devolverBtn} onClick={() => void devolverEmAberto()} disabled={devolvendo}>
            {devolvendo ? "devolvendo…" : "devolver pra fila"}
          </button>
          {avisoLista && <div style={{ marginTop: 8, fontSize: 13 }}>{avisoLista}</div>}
        </div>
      )}

      <main style={main}>
        <p style={lead}>
          Você entra em <strong>uma fila por vez</strong>. Cada tamanho tem duas abas —{" "}
          <strong>Puro</strong> (grade única) e <strong>Mistos</strong> (grade mista) — o
          número é quantos pedidos estão prontos agora.
        </p>

        <div style={tabsRow}>
          <div style={modeTabs}>
            {(["puro", "mistos"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                style={mode === m ? modeTabOn : modeTab}
              >
                {m === "puro" ? "Puro" : "Mistos"}
                <span style={mode === m ? modeTabCountOn : modeTabCount}>{totalFor(m)}</span>
              </button>
            ))}
          </div>
          {counts !== null && (
            <span style={totalHint}>
              {totalFor("puro") + totalFor("mistos")} pedidos no total
            </span>
          )}
        </div>

        <div style={grid}>
          {QUEUES.map((q) => (
            <QueueTile
              key={q}
              label={q}
              count={countFor(q, mode)}
              selected={effectiveSelected === q}
              onClick={() => setSelected((p) => (p === q ? null : q))}
            />
          ))}
        </div>

        {semTamanho > 0 && (
          <div style={semTamanhoWrap}>
            <QueueTile
              label="Sem tamanho"
              count={semTamanho}
              selected={effectiveSelected === SEM_TAMANHO}
              onClick={() => setSelected((p) => (p === SEM_TAMANHO ? null : SEM_TAMANHO))}
            />
            <span style={semTamanhoHint}>
              Pedidos cujo tamanho o sistema não reconheceu. Sem esta fila eles nunca sairiam.
            </span>
          </div>
        )}

        <button
          onClick={() =>
            effectiveSelected &&
            setConfirmed({
              size: effectiveSelected,
              mode,
              sizes: sizesForQueue(effectiveSelected, mode),
            })
          }
          disabled={!effectiveSelected}
          style={!effectiveSelected ? startBtnDisabled : startBtn}
        >
          Começar a separar
          {effectiveSelected
            ? ` — ${effectiveSelected} ${mode === "mistos" ? "Mistos" : "Puro"}`
            : ""}
        </button>
      </main>
    </div>
  );
}

/** ISO → `DD/MM` no fuso de SP (o dia da operação é sempre o de SP — mesmo
 *  fuso de `diaDeEmissao` em SeparacaoRunner.tsx, que usa o MESMO campo pra
 *  filtrar/agrupar; sem isso a data exibida podia divergir do dia do filtro). */
function fmtDia(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        timeZone: "America/Sao_Paulo",
      });
}

function QueueTile({
  label,
  count,
  selected,
  onClick,
  wide,
}: {
  label: string;
  count: number;
  selected: boolean;
  onClick: () => void;
  wide?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="berzerk-module-card"
      style={{
        ...(selected ? tileOn : tile),
        ...(wide ? { gridColumn: "span 2" } : null),
      }}
    >
      <span style={{ ...tileLabel, ...(label.length > 4 ? { fontSize: 20 } : null) }}>
        {label}
      </span>
      <span style={count > 0 ? countBadge : countBadgeZero}>
        {count} {count === 1 ? "pedido" : "pedidos"}
      </span>
    </button>
  );
}

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
  gap: 18,
  padding: "16px 32px",
  borderBottom: "1px solid var(--border)",
};

const titleWrap: CSSProperties = { display: "flex", flexDirection: "column", gap: 2, flex: 1 };

const mesaChip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "7px 12px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 999,
  cursor: "pointer",
  color: "var(--text-secondary)",
};

const mesaDot: CSSProperties = { width: 8, height: 8, borderRadius: "50%" };

const mesaText: CSSProperties = { fontSize: 12, fontWeight: 600 };

const mesaDownBanner: CSSProperties = {
  padding: "10px 32px",
  background: "var(--danger-bg, var(--warning-bg))",
  color: "var(--danger-text, var(--warning-text))",
  fontSize: 13,
  textAlign: "center",
};

const retomarBanner: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexWrap: "wrap",
  gap: 8,
  padding: "10px 32px",
  background: "var(--info-bg)",
  color: "var(--info-text)",
  fontSize: 13,
};

/** Lista que atravessou a virada do dia: pede decisão, não só informa. */
const retomarBannerAlerta: CSSProperties = {
  ...retomarBanner,
  background: "var(--warning-bg)",
  color: "var(--warning-text)",
};

const retomarBtn: CSSProperties = {
  padding: "5px 14px",
  background: "var(--info-text)",
  border: "1px solid var(--info-text)",
  borderRadius: 8,
  color: "var(--bg)",
  fontSize: 12,
  fontWeight: 800,
  cursor: "pointer",
};

const devolverBtn: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "inherit",
  textDecoration: "underline",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 600,
};

const inlineReconnect: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "inherit",
  textDecoration: "underline",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 700,
};

const kicker: CSSProperties = {
  fontSize: 10,
  letterSpacing: 3,
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontWeight: 700,
};

const title: CSSProperties = {
  margin: 0,
  fontSize: 20,
  fontWeight: 700,
  letterSpacing: -0.3,
  color: "var(--text)",
};

const main: CSSProperties = {
  position: "relative",
  flex: 1,
  display: "flex",
  flexDirection: "column",
  gap: 28,
  padding: "48px 32px",
  maxWidth: 1100,
  width: "100%",
  margin: "0 auto",
  boxSizing: "border-box",
  alignItems: "center",
  justifyContent: "center",
};

const lead: CSSProperties = {
  margin: 0,
  fontSize: 14,
  color: "var(--text-secondary)",
  lineHeight: 1.5,
  textAlign: "center",
  maxWidth: 640,
};

/** 5 filas, SEMPRE numa linha só (pedido do Victor) — as colunas encolhem
    juntas em tela menor em vez de quebrar. */
/** A sexta fila fica fora da fileira das 5 bancadas, e menor. */
const semTamanhoWrap: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 8,
  width: 260,
};

const semTamanhoHint: CSSProperties = {
  fontSize: 11,
  color: "var(--text-faint)",
  textAlign: "center",
  lineHeight: 1.4,
};

const grid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(5, minmax(0, 210px))",
  gap: 18,
  width: "100%",
  justifyContent: "center",
};

/** Toggle centralizado; total logo abaixo, bem discreto (pedido do Victor/Leo —
    do lado ele brigava com o layout). */
const tabsRow: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 8,
};

const totalHint: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--text-faint)",
};

const modeTabs: CSSProperties = {
  display: "inline-flex",
  gap: 4,
  padding: 4,
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
};

const modeTab: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "10px 22px",
  background: "transparent",
  border: 0,
  borderRadius: 9,
  color: "var(--text-secondary)",
  fontSize: 14,
  fontWeight: 700,
  cursor: "pointer",
  transition: "background 140ms, color 140ms",
};

const modeTabOn: CSSProperties = {
  ...modeTab,
  background: "var(--bg-input)",
  color: "var(--text)",
  boxShadow: "inset 0 0 0 1px var(--border-strong)",
};

const modeTabCount: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  padding: "1px 8px",
  borderRadius: 999,
  background: "var(--bg-input)",
  color: "var(--text-muted)",
};

const modeTabCountOn: CSSProperties = {
  ...modeTabCount,
  background: "var(--info-bg)",
  color: "var(--info-text)",
};

/** Mesmo look dos cards da home (radius 16, hover com lift via
    .berzerk-module-card) — pedido do Victor: replicar o estilo aqui. */
const tile: CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 14,
  padding: "40px 0 34px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 16,
  color: "var(--text-secondary)",
  cursor: "pointer",
  transition: "background 160ms, border-color 160ms, transform 160ms",
  fontFamily: "inherit",
};

const tileOn: CSSProperties = {
  ...tile,
  background: "var(--info-bg)",
  color: "var(--info-text)",
  border: "1px solid var(--info-border)",
};

const tileLabel: CSSProperties = {
  fontFamily: "var(--font-display)",
  fontSize: 46,
  fontWeight: 400,
  letterSpacing: 1,
  lineHeight: 1,
  color: "var(--text)",
};

const countBadge: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  padding: "2px 10px",
  borderRadius: 999,
  background: "var(--success-bg)",
  color: "var(--success-text)",
  border: "1px solid var(--success-border)",
};

const countBadgeZero: CSSProperties = {
  ...countBadge,
  background: "var(--bg-elevated)",
  color: "var(--text-muted)",
  border: "1px solid var(--border)",
};

/** Ação principal: verde sólido de alto contraste (galpão tem monitor com brilho baixo). */
const startBtn: CSSProperties = {
  padding: "14px 28px",
  background: "var(--success-dot)",
  color: "#04150c",
  border: "1px solid var(--success-dot)",
  borderRadius: 10,
  cursor: "pointer",
  fontSize: 15,
  fontWeight: 800,
};

const startBtnDisabled: CSSProperties = {
  ...startBtn,
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  color: "var(--text-muted)",
  cursor: "not-allowed",
  fontWeight: 700,
};

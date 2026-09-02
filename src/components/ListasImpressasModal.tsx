// "Minhas listas impressas" — cada folha de picking que ela mandou pra
// impressora vira uma linha aqui (GET /separacao/listas). Existe pro pedido
// que sumiu da mesa antes de embalar (filtro, virada do dia, devolução)
// voltar pela lista impressa em vez de ficar perdido com o papel na mão
// (incidente de 02/09). Expandir uma lista mostra os pedidos do snapshot com
// o estado ATUAL de cada um; "Recuperar" reclama pra mesa dela todo pedido
// ainda `ready` sem dono. Degrada com aviso amigável em nexus antigo (404).

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { ApiError } from "../lib/api";
import {
  getListaDetalhe,
  getListas,
  recuperarLista,
  type ListaDetalheResponse,
  type ListaDetalhePedido,
  type ListaIgnoradoMotivo,
  type ListaResumo,
  type RecuperarListaResponse,
} from "../services/listas";

const MOTIVO_LABEL: Record<ListaIgnoradoMotivo, string> = {
  separado: "já separado",
  com_outra_operadora: "com outra operadora",
  cancelado: "cancelado",
  expedido: "expedido",
  outro: "outro motivo",
};

function plural(n: number, singular: string, pluralForm: string): string {
  return n === 1 ? singular : pluralForm;
}

function fmtDataHora(iso: string): string {
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function resumoTexto(r: RecuperarListaResponse): string {
  const base =
    `${r.recuperados} ${plural(r.recuperados, "pedido voltou", "pedidos voltaram")} pra sua mesa` +
    ` · ${r.jaComigo} já ${plural(r.jaComigo, "estava", "estavam")} com você` +
    ` · ${r.ignorados.length} ${plural(r.ignorados.length, "ignorado", "ignorados")}`;
  if (r.ignorados.length === 0) return base;
  const motivos = r.ignorados
    .map((i) => `#${i.numero ?? "?"} ${MOTIVO_LABEL[i.motivo]}`)
    .join(", ");
  return `${base} (${motivos})`;
}

type Tom = "warn" | "ok" | "info" | "muted";

function badgeDoPedido(p: ListaDetalhePedido): { texto: string; tom: Tom } {
  if (p.recuperavel) return { texto: "Recuperável", tom: "warn" };
  if (p.claimedPorMim) return { texto: "Comigo", tom: "ok" };
  if (p.claimedByAtual) return { texto: "Com outra operadora", tom: "info" };
  if (p.statusAtual === "shipped") return { texto: "Expedido", tom: "muted" };
  if (p.statusAtual === "cancelled") return { texto: "Cancelado", tom: "muted" };
  if (p.separadoEm || p.statusAtual === "awaiting_pickup") return { texto: "Separado", tom: "muted" };
  if (p.statusAtual === null) return { texto: "Pedido não encontrado", tom: "muted" };
  return { texto: p.statusAtual, tom: "muted" };
}

type DetalheState =
  | { status: "loading" }
  | { status: "ok"; data: ListaDetalheResponse }
  | { status: "erro"; msg: string };

export function ListasImpressasModal({
  onClose,
  onRecuperado,
}: {
  onClose: () => void;
  /** A mesa mudou (pedidos recuperados) — o runner recarrega o lote. */
  onRecuperado?: () => void;
}) {
  const [listas, setListas] = useState<ListaResumo[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detalhes, setDetalhes] = useState<Record<string, DetalheState>>({});
  const [recuperando, setRecuperando] = useState<string | null>(null);
  const [resultados, setResultados] = useState<Record<string, RecuperarListaResponse>>({});
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const carregarListas = useCallback(async () => {
    setLoading(true);
    try {
      const d = await getListas();
      setListas(d.listas);
      setErro(null);
    } catch (e) {
      setErro(
        e instanceof ApiError && e.status === 404
          ? "O servidor ainda não tem as listas impressas (aguardando atualização do nexus)."
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void carregarListas();
  }, [carregarListas, retry]);

  const carregarDetalhe = useCallback(async (id: string) => {
    setDetalhes((atual) => ({ ...atual, [id]: { status: "loading" } }));
    try {
      const data = await getListaDetalhe(id);
      setDetalhes((atual) => ({ ...atual, [id]: { status: "ok", data } }));
    } catch (e) {
      setDetalhes((atual) => ({
        ...atual,
        [id]: { status: "erro", msg: e instanceof Error ? e.message : String(e) },
      }));
    }
  }, []);

  const alternarExpandir = (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(id);
    if (!detalhes[id]) void carregarDetalhe(id);
  };

  const recuperar = async (id: string) => {
    if (recuperando) return;
    setRecuperando(id);
    try {
      const r = await recuperarLista(id);
      setResultados((atual) => ({ ...atual, [id]: r }));
      await Promise.all([
        carregarListas(),
        expandedId === id ? carregarDetalhe(id) : Promise.resolve(),
      ]);
      onRecuperado?.();
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      setRecuperando(null);
    }
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={box} onClick={(e) => e.stopPropagation()}>
        <div style={headerRow}>
          <h2 style={titulo}>📋 Listas impressas</h2>
          <button style={fecharBtn} onClick={onClose} title="Fechar (Esc)">
            ×
          </button>
        </div>
        <span style={subTitulo}>Últimos 14 dias — folhas de picking que você mandou imprimir.</span>

        <div style={lista}>
          {erro && (
            <div style={erroBox}>
              <div>{erro}</div>
              <button style={retryBtn} onClick={() => setRetry((r) => r + 1)}>
                Tentar de novo
              </button>
            </div>
          )}
          {!erro && loading && !listas && <span style={vazio}>Carregando…</span>}
          {!erro && listas && listas.length === 0 && (
            <span style={vazio}>Nenhuma lista impressa nos últimos 14 dias.</span>
          )}
          {!erro &&
            listas?.map((l) => {
              const expandido = expandedId === l.id;
              const detalhe = detalhes[l.id];
              const resultado = resultados[l.id];
              const recuperavel = l.pedidosRecuperaveis > 0;
              return (
                <div key={l.id} style={card}>
                  <div style={cardHeader} onClick={() => alternarExpandir(l.id)}>
                    <span style={expandArrow}>{expandido ? "▾" : "▸"}</span>
                    <div style={cardInfo}>
                      <div style={cardLinha1}>
                        <span style={dataHora}>{fmtDataHora(l.criadoEm)}</span>
                        <span style={l.escopo === "lote" ? escopoChipLote : escopoChipSecao}>
                          {l.escopo === "lote" ? "Lote inteiro" : "Seção"}
                        </span>
                        {l.recuperadaEm && (
                          <span style={recuperadaChip}>
                            recuperada {l.recuperacoes > 1 ? `${l.recuperacoes}× ` : ""}
                            em {fmtDataHora(l.recuperadaEm)}
                          </span>
                        )}
                      </div>
                      <span style={cardResumo}>
                        {l.totalPedidos} {plural(l.totalPedidos, "pedido", "pedidos")} ·{" "}
                        {l.totalPecas} {plural(l.totalPecas, "peça", "peças")} ·{" "}
                        <span style={recuperavel ? recuperaveisOn : recuperaveisOff}>
                          {l.pedidosRecuperaveis} {plural(l.pedidosRecuperaveis, "recuperável", "recuperáveis")}
                        </span>
                      </span>
                    </div>
                    <button
                      style={recuperavel && recuperando === null ? recuperarBtn : recuperarBtnOff}
                      disabled={!recuperavel || recuperando !== null}
                      onClick={(e) => {
                        e.stopPropagation();
                        void recuperar(l.id);
                      }}
                    >
                      {recuperando === l.id
                        ? "Recuperando…"
                        : `Recuperar pedidos (${l.pedidosRecuperaveis})`}
                    </button>
                  </div>

                  {resultado && <div style={resultadoBox}>{resumoTexto(resultado)}</div>}

                  {expandido && (
                    <div style={detalheWrap}>
                      {(!detalhe || detalhe.status === "loading") && (
                        <span style={vazio}>Carregando pedidos…</span>
                      )}
                      {detalhe?.status === "erro" && (
                        <div style={erroBox}>
                          <div>{detalhe.msg}</div>
                          <button style={retryBtn} onClick={() => void carregarDetalhe(l.id)}>
                            Tentar de novo
                          </button>
                        </div>
                      )}
                      {detalhe?.status === "ok" &&
                        detalhe.data.pedidos.map((p) => {
                          const badge = badgeDoPedido(p);
                          const itens = p.itens.reduce((a, it) => a + it.quantidade, 0);
                          return (
                            <div key={p.orderId} style={pedidoRow}>
                              <span style={pedidoNumero}>#{p.numero ?? p.orderId.slice(0, 8)}</span>
                              {p.clienteNome && <span style={pedidoCliente}>{p.clienteNome}</span>}
                              <span style={pedidoItens}>
                                {itens} {plural(itens, "item", "itens")}
                              </span>
                              <div style={{ flex: 1 }} />
                              <span style={badgeStyle(badge.tom)}>{badge.texto}</span>
                            </div>
                          );
                        })}
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}

function badgeStyle(tom: Tom): CSSProperties {
  switch (tom) {
    case "warn":
      return pedidoBadgeWarn;
    case "ok":
      return pedidoBadgeOk;
    case "info":
      return pedidoBadgeInfo;
    default:
      return pedidoBadgeMuted;
  }
}

const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 60,
};

const box: CSSProperties = {
  width: 720,
  maxWidth: "94vw",
  height: "min(760px, 90vh)",
  background: "var(--bg-elevated)",
  border: "1px solid var(--border-strong)",
  borderRadius: 16,
  padding: "20px 22px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  boxSizing: "border-box",
};

const headerRow: CSSProperties = { display: "flex", alignItems: "center", gap: 10 };

const titulo: CSSProperties = { margin: 0, fontSize: 18, fontWeight: 800, color: "var(--text)", flex: 1 };

const subTitulo: CSSProperties = { fontSize: 12, color: "var(--text-secondary)" };

const fecharBtn: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "var(--text-muted)",
  fontSize: 24,
  fontWeight: 700,
  cursor: "pointer",
  lineHeight: 1,
};

const lista: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};

const vazio: CSSProperties = { fontSize: 13, color: "var(--text-muted)", padding: "16px 4px" };

const erroBox: CSSProperties = {
  padding: "12px 16px",
  background: "var(--warning-bg)",
  border: "1px solid var(--warning-border)",
  borderRadius: 10,
  color: "var(--warning-text)",
  fontSize: 13,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  alignItems: "flex-start",
};

const retryBtn: CSSProperties = {
  padding: "6px 14px",
  background: "var(--bg-card)",
  border: "1px solid var(--border-strong)",
  borderRadius: 8,
  color: "var(--text)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const card: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "12px 14px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
};

const cardHeader: CSSProperties = { display: "flex", alignItems: "center", gap: 10, cursor: "pointer" };

const expandArrow: CSSProperties = { color: "var(--text-muted)", fontSize: 12, flexShrink: 0 };

const cardInfo: CSSProperties = { display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 };

const cardLinha1: CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" };

const dataHora: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  fontWeight: 700,
  color: "var(--text)",
};

const escopoChip: CSSProperties = {
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: 0.5,
  textTransform: "uppercase",
  padding: "1px 8px",
  borderRadius: 999,
};

const escopoChipLote: CSSProperties = {
  ...escopoChip,
  background: "var(--info-bg)",
  color: "var(--info-text)",
  border: "1px solid var(--info-border)",
};

const escopoChipSecao: CSSProperties = {
  ...escopoChip,
  background: "var(--bg-input)",
  color: "var(--text-secondary)",
  border: "1px solid var(--border-strong)",
};

const recuperadaChip: CSSProperties = {
  fontSize: 11,
  color: "var(--text-muted)",
};

const cardResumo: CSSProperties = { fontSize: 12, color: "var(--text-secondary)" };

const recuperaveisOn: CSSProperties = { color: "var(--warning-text)", fontWeight: 700 };

const recuperaveisOff: CSSProperties = { color: "var(--text-muted)" };

const recuperarBtn: CSSProperties = {
  flexShrink: 0,
  padding: "8px 14px",
  background: "var(--success-dot)",
  border: "1px solid var(--success-dot)",
  borderRadius: 9,
  color: "#04150c",
  fontSize: 12,
  fontWeight: 800,
  cursor: "pointer",
};

const recuperarBtnOff: CSSProperties = {
  ...recuperarBtn,
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  color: "var(--text-faint)",
  cursor: "not-allowed",
};

const resultadoBox: CSSProperties = {
  padding: "8px 12px",
  background: "var(--info-bg)",
  border: "1px solid var(--info-border)",
  borderRadius: 8,
  color: "var(--info-text)",
  fontSize: 12,
};

const detalheWrap: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  paddingTop: 6,
  borderTop: "1px solid var(--border)",
};

const pedidoRow: CSSProperties = { display: "flex", alignItems: "center", gap: 10, fontSize: 12 };

const pedidoNumero: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontWeight: 700,
  color: "var(--text)",
  flexShrink: 0,
};

const pedidoCliente: CSSProperties = {
  color: "var(--text-secondary)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  minWidth: 0,
};

const pedidoItens: CSSProperties = { color: "var(--text-muted)", flexShrink: 0 };

const pedidoBadge: CSSProperties = {
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: 0.3,
  padding: "2px 9px",
  borderRadius: 999,
  flexShrink: 0,
};

const pedidoBadgeWarn: CSSProperties = {
  ...pedidoBadge,
  background: "var(--warning-bg)",
  color: "var(--warning-text)",
  border: "1px solid var(--warning-border)",
};

const pedidoBadgeOk: CSSProperties = {
  ...pedidoBadge,
  background: "var(--success-bg)",
  color: "var(--success-text)",
  border: "1px solid var(--success-border)",
};

const pedidoBadgeInfo: CSSProperties = {
  ...pedidoBadge,
  background: "var(--info-bg)",
  color: "var(--info-text)",
  border: "1px solid var(--info-border)",
};

const pedidoBadgeMuted: CSSProperties = {
  ...pedidoBadge,
  background: "var(--bg-input)",
  color: "var(--text-muted)",
  border: "1px solid var(--border)",
};

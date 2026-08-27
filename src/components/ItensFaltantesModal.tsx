// "Itens faltantes" — o botão que o pós-venda legado tinha na tela do pedido
// (`ITENS FALTANTES` → MarkOutOfStockModal → `mark-out-of-stock`) e que ficou
// pra trás quando a separação migrou pro Nexus.
//
// A operadora marca o que NÃO estava na prateleira e confirma. O servidor
// registra a ruptura, TIRA o pedido da fila (`on_hold`), solta o claim e avisa
// o cliente pelo webhook do chat. Quem decide o desfecho (reembolso, cupom,
// troca) é a supervisão, na tela de Rupturas do Nexus — aqui só se registra a
// falta, que é o que a operadora sabe.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { miniatura } from "../lib/imagens";
import { criarRuptura, type Order, type OrderItem } from "../services/orders";

type Props = {
  order: Order;
  /** Quantas unidades de cada item JÁ foram lidas (o que faltou é o resto). */
  lidos: Map<string, number>;
  /** Chamado depois que o servidor confirma — o runner repõe o lote. */
  onMarcado: (info: { pedidoEmEspera: boolean }) => void;
  onClose: () => void;
};

export function ItensFaltantesModal({ order, lidos, onMarcado, onClose }: Props) {
  // Pré-seleção pela LEITURA: o que a mesa não viu é, quase sempre, exatamente
  // o que faltou na prateleira. A operadora ajusta se quiser.
  const faltaPorItem = useMemo(() => {
    const m = new Map<string, number>();
    for (const it of order.items) {
      m.set(it.id, Math.max(0, it.quantidade - (lidos.get(it.id) ?? 0)));
    }
    return m;
  }, [order.items, lidos]);

  const [selecao, setSelecao] = useState<Map<string, number>>(() => {
    const m = new Map<string, number>();
    for (const [id, falta] of faltaPorItem) if (falta > 0) m.set(id, falta);
    return m;
  });
  const [observacao, setObservacao] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !enviando) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, enviando]);

  const alternar = (it: OrderItem) => {
    setSelecao((prev) => {
      const m = new Map(prev);
      if (m.has(it.id)) m.delete(it.id);
      else m.set(it.id, faltaPorItem.get(it.id) || it.quantidade);
      return m;
    });
  };

  const mudarQtd = (it: OrderItem, delta: number) => {
    setSelecao((prev) => {
      const m = new Map(prev);
      const atual = m.get(it.id) ?? 0;
      const proximo = Math.min(it.quantidade, Math.max(1, atual + delta));
      m.set(it.id, proximo);
      return m;
    });
  };

  const total = [...selecao.values()].reduce((a, n) => a + n, 0);

  const confirmar = async () => {
    if (enviando || selecao.size === 0) return;
    setEnviando(true);
    setErro(null);
    try {
      const res = await criarRuptura({
        orderId: order.id,
        itens: [...selecao.entries()].map(([orderItemId, quantidade]) => ({
          orderItemId,
          quantidade,
        })),
        observacao,
      });
      onMarcado({ pedidoEmEspera: res.pedidoEmEspera !== false });
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
      setEnviando(false);
    }
  };

  return (
    <div style={overlay} onClick={() => !enviando && onClose()}>
      <div style={box} onClick={(e) => e.stopPropagation()}>
        <div style={headerRow}>
          <div style={headerText}>
            <h2 style={titulo}>Itens faltantes</h2>
            <span style={sub}>
              Pedido #{order.numero ?? order.id.slice(0, 8)}
              {order.clienteNome ? ` · ${order.clienteNome}` : ""}
            </span>
          </div>
          <button style={fecharBtn} onClick={onClose} disabled={enviando} title="Fechar (Esc)">
            ×
          </button>
        </div>

        <p style={explicacao}>
          Marque o que não estava na prateleira. O pedido sai da fila e o cliente é avisado; a
          supervisão resolve pelo Nexus.
        </p>

        {erro && <div style={erroBox}>{erro}</div>}

        <div className="thin-scroll" style={lista}>
          {order.items.map((it) => {
            const marcado = selecao.has(it.id);
            const qtd = selecao.get(it.id) ?? 0;
            const lido = lidos.get(it.id) ?? 0;
            return (
              <div key={it.id} style={marcado ? linhaOn : linha}>
                <button style={checkBtn} onClick={() => alternar(it)} disabled={enviando}>
                  <span style={marcado ? checkOn : check}>{marcado ? "✓" : ""}</span>
                </button>
                {it.imagemUrl ? (
                  <img
                    src={miniatura(it.imagemUrl) ?? undefined}
                    alt=""
                    style={thumb}
                    loading="lazy"
                    decoding="async"
                  />
                ) : (
                  <div style={{ ...thumb, ...thumbVazia }} />
                )}
                <div style={infoWrap}>
                  <span style={nomeItem}>{it.nome ?? it.ean ?? "item sem nome"}</span>
                  <span style={metaItem}>
                    {it.tamanho ? `${it.tamanho} · ` : ""}
                    {it.quantidade} no pedido · {lido} lido{lido === 1 ? "" : "s"}
                  </span>
                </div>
                {marcado ? (
                  <div style={qtdWrap}>
                    <button style={qtdBtn} onClick={() => mudarQtd(it, -1)} disabled={enviando}>
                      −
                    </button>
                    <span style={qtdValor}>{qtd}</span>
                    <button style={qtdBtn} onClick={() => mudarQtd(it, +1)} disabled={enviando}>
                      +
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <input
          style={obsInput}
          placeholder="Observação (opcional)"
          value={observacao}
          maxLength={500}
          disabled={enviando}
          onChange={(e) => setObservacao(e.target.value)}
        />

        <div style={acoes}>
          <button style={ghostBtn} onClick={onClose} disabled={enviando}>
            Cancelar
          </button>
          <button
            style={selecao.size > 0 && !enviando ? confirmarBtn : confirmarBtnOff}
            onClick={() => void confirmar()}
            disabled={selecao.size === 0 || enviando}
          >
            {enviando
              ? "Marcando…"
              : selecao.size === 0
                ? "Selecione o que faltou"
                : `Marcar ${total} ${total === 1 ? "peça" : "peças"} e tirar da fila`}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 70,
};

const box: CSSProperties = {
  width: 720,
  maxWidth: "94vw",
  maxHeight: "90vh",
  background: "var(--bg-elevated)",
  border: "1px solid var(--border-strong)",
  borderRadius: 16,
  padding: "20px 22px",
  display: "flex",
  flexDirection: "column",
  gap: 12,
  boxSizing: "border-box",
};

const headerRow: CSSProperties = { display: "flex", alignItems: "flex-start", gap: 12 };
const headerText: CSSProperties = { display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 };
const titulo: CSSProperties = { margin: 0, fontSize: 19, fontWeight: 800, color: "var(--text)" };
const sub: CSSProperties = { fontSize: 12, color: "var(--text-secondary)" };

const fecharBtn: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "var(--text-muted)",
  fontSize: 24,
  fontWeight: 700,
  cursor: "pointer",
  lineHeight: 1,
};

const explicacao: CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: "var(--text-secondary)",
  lineHeight: 1.5,
};

const erroBox: CSSProperties = {
  padding: "10px 14px",
  background: "var(--danger-bg, var(--warning-bg))",
  border: "1px solid var(--danger-border, var(--warning-border))",
  borderRadius: 10,
  color: "var(--danger-text, var(--warning-text))",
  fontSize: 12,
};

const lista: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const linha: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "8px 10px",
  border: "1px solid var(--border)",
  borderRadius: 10,
};

const linhaOn: CSSProperties = {
  ...linha,
  background: "var(--warning-bg)",
  border: "1px solid var(--warning-border)",
};

const checkBtn: CSSProperties = { background: "transparent", border: 0, cursor: "pointer", padding: 0 };

const check: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 22,
  height: 22,
  borderRadius: 6,
  border: "2px solid var(--border-strong)",
  color: "transparent",
  fontSize: 14,
  fontWeight: 900,
};

const checkOn: CSSProperties = {
  ...check,
  background: "var(--warning-text)",
  border: "2px solid var(--warning-text)",
  color: "var(--bg)",
};

const thumb: CSSProperties = {
  width: 46,
  height: 46,
  borderRadius: 8,
  objectFit: "cover",
  flexShrink: 0,
  background: "var(--bg-card)",
};

const thumbVazia: CSSProperties = { border: "1px solid var(--border)" };

const infoWrap: CSSProperties = { display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0 };

const nomeItem: CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: "var(--text)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const metaItem: CSSProperties = { fontSize: 11, color: "var(--text-muted)" };

const qtdWrap: CSSProperties = { display: "flex", alignItems: "center", gap: 6, flexShrink: 0 };

const qtdBtn: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 8,
  border: "1px solid var(--border-strong)",
  background: "var(--bg-card)",
  color: "var(--text)",
  fontSize: 16,
  fontWeight: 800,
  cursor: "pointer",
};

const qtdValor: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 14,
  fontWeight: 800,
  minWidth: 22,
  textAlign: "center",
  color: "var(--text)",
};

const obsInput: CSSProperties = {
  padding: "9px 12px",
  borderRadius: 9,
  border: "1px solid var(--border)",
  background: "var(--bg-input)",
  color: "var(--text)",
  fontSize: 13,
  fontFamily: "inherit",
};

const acoes: CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 10 };

const ghostBtn: CSSProperties = {
  padding: "10px 18px",
  background: "transparent",
  border: "1px solid var(--border-strong)",
  borderRadius: 9,
  color: "var(--text-secondary)",
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
};

const confirmarBtn: CSSProperties = {
  padding: "10px 20px",
  background: "var(--warning-text)",
  border: "1px solid var(--warning-text)",
  borderRadius: 9,
  color: "var(--bg)",
  fontSize: 13,
  fontWeight: 800,
  cursor: "pointer",
};

const confirmarBtnOff: CSSProperties = {
  ...confirmarBtn,
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  color: "var(--text-muted)",
  cursor: "not-allowed",
};

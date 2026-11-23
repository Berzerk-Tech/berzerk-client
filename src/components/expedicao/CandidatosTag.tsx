// Tela "Esta peça não está em nenhum pedido" (Expedição, 23/11): a peça lida não
// bate com pedido nenhum e o Nexus sugere os pedidos separados com o mesmo
// produto e tamanho. A operadora escolhe em qual deles usar a peça.
import type { CSSProperties } from "react";
import { fmtDataHora } from "../../lib/datas";
import { ordenarPedidosCandidato, resumoItens, rotuloPecaLida } from "../../lib/candidatosTag";
import type { CandidatoPedido, CandidatoTag } from "../../services/expedicao";

type Props = {
  candidato: CandidatoTag;
  /** Posição desta peça entre as que têm candidatos (1 de N). */
  posicao: number;
  total: number;
  /** `faltante`: o pedido já foi identificado e falta peça; `sem_pedido`: a peça não casou com nenhum. */
  modo?: "sem_pedido" | "faltante";
  /** Troca em andamento: trava os botões. */
  ocupado: boolean;
  onEscolher: (pedido: CandidatoPedido) => void;
  onCancelar: () => void;
};

export function CandidatosTag({ candidato, posicao, total, modo = "sem_pedido", ocupado, onEscolher, onCancelar }: Props) {
  const pedidos = ordenarPedidosCandidato(candidato);
  return (
    <div style={bloco}>
      <h1 style={titulo}>{modo === "faltante" ? "Peça fora do pedido" : "Esta peça não está em nenhum pedido"}</h1>
      <p style={subtitulo}>
        {rotuloPecaLida(candidato)}
        {total > 1 ? ` (${posicao} de ${total})` : ""}
      </p>
      <p style={texto}>
        {modo === "faltante"
          ? "Esta peça não está no pedido, mas é do mesmo produto e tamanho da que falta. Usar esta peça neste pedido?"
          : "Pedidos separados com este produto e tamanho. Escolha um para usar esta peça nele."}
      </p>

      <div style={lista}>
        {pedidos.map((p, i) => (
          <div key={p.order.id} style={i === 0 ? { ...linha, ...linhaSugerida } : linha}>
            <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, flex: 1, textAlign: "left" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <code style={{ fontSize: 20, fontWeight: 700 }}>#{p.order.numero ?? p.order.id.slice(0, 8)}</code>
                {i === 0 && <span style={selo}>Sugerido</span>}
              </div>
              <span style={{ fontSize: 14 }}>{p.order.clienteNome ?? "Cliente não informado"}</span>
              <span style={miudo}>
                Separado por {p.order.separatedByNome ?? p.order.separatedBy ?? "?"}
                {p.order.separatedAt ? ` em ${fmtDataHora(p.order.separatedAt)}` : ""}
              </span>
              <span style={miudo}>{resumoItens(p.order.items)}</span>
            </div>
            <button type="button" style={botao} disabled={ocupado} onClick={() => onEscolher(p)}>
              {ocupado ? "Aguarde…" : "Usar esta peça neste pedido"}
            </button>
          </div>
        ))}
      </div>

      {candidato.maisPedidos > 0 && (
        <p style={miudo}>e mais {candidato.maisPedidos} {candidato.maisPedidos === 1 ? "pedido" : "pedidos"}</p>
      )}

      <button type="button" style={cancelar} disabled={ocupado} onClick={onCancelar}>
        Cancelar
      </button>
    </div>
  );
}

const bloco: CSSProperties = { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, textAlign: "center", padding: "0 24px", overflowY: "auto" };
const titulo: CSSProperties = { margin: 0, fontFamily: "var(--font-display)", fontSize: 40, fontWeight: 400, letterSpacing: 1, color: "var(--warning-text)" };
const subtitulo: CSSProperties = { margin: 0, fontSize: 18, fontWeight: 700, color: "var(--text)" };
const texto: CSSProperties = { margin: 0, fontSize: 15, color: "var(--text-secondary)" };
const miudo: CSSProperties = { fontSize: 12, color: "var(--text-muted)" };
const lista: CSSProperties = { display: "flex", flexDirection: "column", gap: 10, width: "100%", maxWidth: 760, marginTop: 6 };
const linha: CSSProperties = { display: "flex", alignItems: "center", gap: 16, padding: "14px 18px", background: "var(--bg-card)", border: "1px solid var(--border-strong)", borderRadius: 12, color: "var(--text)" };
const linhaSugerida: CSSProperties = { border: "2px solid var(--warning-text)" };
const selo: CSSProperties = { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, padding: "2px 8px", borderRadius: 999, background: "var(--warning-text)", color: "var(--bg)" };
const botao: CSSProperties = { padding: "16px 20px", minHeight: 56, fontSize: 14, fontWeight: 700, border: 0, borderRadius: 10, background: "#16a34a", color: "white", cursor: "pointer", flexShrink: 0, maxWidth: 200 };
const cancelar: CSSProperties = { padding: "14px 28px", minHeight: 52, fontSize: 14, fontWeight: 600, border: "1px solid var(--border)", borderRadius: 10, background: "transparent", color: "var(--text-secondary)", cursor: "pointer", textTransform: "uppercase", letterSpacing: 1 };

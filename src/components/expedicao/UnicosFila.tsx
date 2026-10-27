// Modo Únicos, passo 2: cabeçalho grande com o grupo escolhido e a lista dos
// pedidos dele, na ordem da fila. `versao` muda a cada ciclo concluído e força
// o refetch (a contagem cai um pedido). Poll de 30 s.

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { rotuloGrupo, type GrupoEscolhido } from "../../lib/unicosExpedicao";
import { getUnicosPedidos, type UnicoPedido } from "../../services/expedicao";

const POLL_MS = 30000;

export function UnicosFila({ grupo, versao, onTrocar, trocarDesabilitado }: { grupo: GrupoEscolhido; versao: number; onTrocar: () => void; trocarDesabilitado?: boolean }) {
  const [pedidos, setPedidos] = useState<UnicoPedido[] | null>(null);
  const [erro, setErro] = useState(false);

  const carregar = useCallback(async () => {
    try {
      setPedidos(await getUnicosPedidos(grupo.estampa, grupo.tamanho));
      setErro(false);
    } catch {
      setErro(true);
    }
  }, [grupo.estampa, grupo.tamanho]);

  useEffect(() => {
    void carregar();
    const id = window.setInterval(() => void carregar(), POLL_MS);
    return () => window.clearInterval(id);
  }, [carregar, versao]);

  return (
    <div style={wrap}>
      <div style={cabecalho}>
        <div>
          <div style={titulo}>{rotuloGrupo(grupo)}</div>
          <div style={sub}>
            {pedidos ? `${pedidos.length} pedido${pedidos.length === 1 ? "" : "s"} na fila` : "Carregando…"}
            {erro && " · não consegui atualizar"}
          </div>
        </div>
        <button
          type="button"
          style={{ ...trocarBtn, ...(trocarDesabilitado ? { opacity: 0.45, cursor: "not-allowed" } : {}) }}
          onClick={onTrocar}
          disabled={trocarDesabilitado}
          title={trocarDesabilitado ? "Termine o pedido na mesa antes de trocar a fila" : undefined}
        >
          Trocar fila
        </button>
      </div>
      <div style={lista} className="thin-scroll">
        {pedidos && pedidos.length === 0 && <div style={vazio}>Nenhum pedido único aguardando esta fila.</div>}
        {(pedidos ?? []).map((p, i) => (
          <div key={p.id} style={linha}>
            <span style={pos}>{i + 1}</span>
            <code style={num}>#{p.numero ?? p.id.slice(0, 8)}</code>
            <span style={cli}>{p.cliente ?? ""}</span>
            <span style={tipo}>{p.produtoNome}</span>
            {p.prioritario && <span style={prio}>PRIORITÁRIO</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

const wrap: CSSProperties = { display: "flex", flexDirection: "column", gap: 8, maxHeight: 210, flexShrink: 0 };
const cabecalho: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "8px 16px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 14 };
const titulo: CSSProperties = { fontSize: 44, fontWeight: 900, lineHeight: 1.05, letterSpacing: 0.5 };
const sub: CSSProperties = { fontSize: 14, color: "var(--text-secondary)", fontWeight: 700 };
const trocarBtn: CSSProperties = { padding: "12px 20px", background: "var(--bg-input)", border: "1px solid var(--border-strong)", borderRadius: 10, color: "var(--text)", fontWeight: 800, fontSize: 15, cursor: "pointer" };
const lista: CSSProperties = { overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, minHeight: 0 };
const vazio: CSSProperties = { padding: 10, color: "var(--text-secondary)", fontSize: 14 };
const linha: CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "5px 12px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 13 };
const pos: CSSProperties = { width: 22, color: "var(--text-muted)", fontWeight: 700 };
const num: CSSProperties = { fontWeight: 800, fontSize: 14 };
const cli: CSSProperties = { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-secondary)" };
const tipo: CSSProperties = { color: "var(--text)" };
const prio: CSSProperties = { padding: "1px 8px", borderRadius: 999, background: "var(--danger-bg, #fee2e2)", color: "var(--danger-text, #b91c1c)", fontSize: 11, fontWeight: 800 };

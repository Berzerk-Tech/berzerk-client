// Modo Únicos, passo 2: cabeçalho grande com o grupo escolhido e a lista dos
// pedidos dele, na ordem da fila. `versao` muda a cada ciclo concluído e força
// o refetch (a contagem cai um pedido). Poll de 30 s.

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { miniaturaLeve } from "../../lib/imagens";
import { rotuloGrupo, selecaoAposRecarga, tipoBaseDoProduto, type GrupoEscolhido } from "../../lib/unicosExpedicao";
import { getUnicosPedidos, type UnicoPedido } from "../../services/expedicao";

const POLL_MS = 30000;

export function UnicosFila({
  grupo,
  versao,
  onTrocar,
  trocarDesabilitado,
  onEsgotou,
  mesaLivre,
  selecionadoId,
  onSelecionar,
}: {
  grupo: GrupoEscolhido;
  versao: number;
  onTrocar: () => void;
  trocarDesabilitado?: boolean;
  /** A fila do grupo acabou e a mesa está livre: o pai volta pra escolha de tamanho/estampa. */
  onEsgotou: () => void;
  mesaLivre: boolean;
  /** Pedido que o bip vai separar (null = ainda sem lista). */
  selecionadoId?: string | null;
  onSelecionar?: (id: string | null) => void;
}) {
  const [pedidos, setPedidos] = useState<UnicoPedido[] | null>(null);
  const [erro, setErro] = useState(false);
  const esgotouAvisado = useRef(false);
  const onEsgotouRef = useRef(onEsgotou);
  onEsgotouRef.current = onEsgotou;
  const selRef = useRef<string | null>(selecionadoId ?? null);
  selRef.current = selecionadoId ?? null;
  const onSelecionarRef = useRef(onSelecionar);
  onSelecionarRef.current = onSelecionar;

  // Grupo novo: descarta a lista do grupo anterior e rearma o aviso.
  useEffect(() => {
    setPedidos(null);
    esgotouAvisado.current = false;
  }, [grupo.estampa, grupo.tamanho]);

  // Lista vazia com a mesa livre: avisa UMA vez; se a mesa estiver ocupada, tenta quando liberar.
  useEffect(() => {
    if (!pedidos) return;
    if (pedidos.length > 0) {
      esgotouAvisado.current = false;
      return;
    }
    if (mesaLivre && !esgotouAvisado.current) {
      esgotouAvisado.current = true;
      onEsgotouRef.current();
    }
  }, [pedidos, mesaLivre]);

  const carregar = useCallback(async () => {
    try {
      const lista = await getUnicosPedidos(grupo.estampa, grupo.tamanho);
      setPedidos(lista);
      const nova = selecaoAposRecarga(selRef.current, lista);
      if (nova !== selRef.current) {
        selRef.current = nova;
        onSelecionarRef.current?.(nova);
      }
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

  const selEfetivo = selecaoAposRecarga(selecionadoId ?? null, pedidos ?? []);
  const pedidoSel = (pedidos ?? []).find((p) => p.id === selEfetivo) ?? null;
  const tituloGrupo = pedidoSel
    ? `${tipoBaseDoProduto(pedidoSel.produtoNome, grupo.estampa)} · ${grupo.estampa} · ${grupo.tamanho}`
    : rotuloGrupo(grupo);
  const comBump = (pedidos ?? []).filter((p) => p.orderBump).length;

  return (
    <div style={wrap}>
      <div style={cabecalho}>
        <div>
          <div style={titulo}>{tituloGrupo}</div>
          <div style={sub}>
            {pedidos ? `${pedidos.length} pedido${pedidos.length === 1 ? "" : "s"} na fila${comBump > 0 ? ` · ${comBump} com bump` : ""}` : "Carregando…"}
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
      <div style={lista} className="thin-scroll" role="listbox">
        {pedidos && pedidos.length === 0 && <div style={vazio}>Nenhum pedido único aguardando esta fila · voltando…</div>}
        {(pedidos ?? []).map((p, i) => (
          <div
            key={p.id}
            role="option"
            aria-selected={p.id === selEfetivo}
            onClick={() => {
              if (p.id === selEfetivo) return;
              selRef.current = p.id;
              onSelecionarRef.current?.(p.id);
            }}
            style={{ ...linha, ...(p.orderBump ? linhaBump : {}), cursor: "pointer", ...(p.id === selEfetivo ? linhaSel : {}) }}
          >
            <span style={pos}>{i + 1}</span>
            <code style={num}>#{p.numero ?? p.id.slice(0, 8)}</code>
            <span style={cli}>{p.cliente ?? ""}</span>
            <span style={tipo}>{p.produtoNome}</span>
            {p.orderBump && (
              <span style={bumpPill} title="Order bump: leia esta peça junto com o item">
                + {p.orderBump.produtoNome}
              </span>
            )}
            {p.orderBump && miniaturaLeve(p.orderBump.imagemUrl) && (
              <img src={miniaturaLeve(p.orderBump.imagemUrl) ?? undefined} alt="" style={bumpThumb} loading="lazy" decoding="async" />
            )}
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
const linhaSel: CSSProperties = { border: "2px solid var(--accent, #22c55e)", background: "var(--bg-input)", padding: "4px 11px" };
const bumpThumb: CSSProperties = { width: 20, height: 20, borderRadius: 4, objectFit: "cover" };
const linhaBump: CSSProperties = { borderLeft: "3px solid var(--info-text, #1d4ed8)" };
const bumpPill: CSSProperties = { padding: "1px 8px", borderRadius: 999, background: "var(--info-bg, #dbeafe)", color: "var(--info-text, #1d4ed8)", fontSize: 12, fontWeight: 800 };

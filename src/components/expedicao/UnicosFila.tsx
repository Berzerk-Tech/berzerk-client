// Modo Únicos, passo 2: cabeçalho grande com o grupo escolhido e a lista dos
// pedidos dele, na ordem da fila. `versao` muda a cada ciclo concluído e força
// o refetch (a contagem cai um pedido). Poll de 30 s.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { miniaturaLeve } from "../../lib/imagens";
import { rotuloGrupo, rotuloTipo, selecaoAposRecarga, tipoBaseDoProduto, type GrupoEscolhido } from "../../lib/unicosExpedicao";
import { getUnicosPedidos, type UnicoPedido } from "../../services/expedicao";

const POLL_MS = 30000;

export function UnicosFila({
  grupo,
  versao,
  onTrocar,
  onVoltar,
  trocarDesabilitado,
  onEsgotou,
  mesaLivre,
  selecionadoId,
  onSelecionar,
  ocultarIds,
}: {
  grupo: GrupoEscolhido;
  versao: number;
  /** "Trocar estampa": volta pra grade de estampas. */
  onTrocar: () => void;
  /** "Voltar": volta pro painel de tamanhos da mesma estampa. */
  onVoltar?: () => void;
  trocarDesabilitado?: boolean;
  /** A fila do grupo acabou e a mesa está livre: o pai volta pra escolha de tamanho/estampa. */
  onEsgotou: () => void;
  mesaLivre: boolean;
  /** Pedido que o bip vai separar (null = ainda sem lista). */
  selecionadoId?: string | null;
  onSelecionar?: (id: string | null) => void;
  /** Pedidos já expedidos nesta sessão: saem da lista na hora, sem esperar o GET. */
  ocultarIds?: string[];
}) {
  const [pedidosBrutos, setPedidos] = useState<UnicoPedido[] | null>(null);
  const ocultos = ocultarIds && ocultarIds.length > 0 ? new Set(ocultarIds) : null;
  const pedidos = useMemo(
    () => (pedidosBrutos && ocultos ? pedidosBrutos.filter((p) => !ocultos.has(p.id)) : pedidosBrutos),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pedidosBrutos, ocultarIds?.join(",")],
  );
  const [erro, setErro] = useState(false);
  const esgotouAvisado = useRef(false);
  const onEsgotouRef = useRef(onEsgotou);
  onEsgotouRef.current = onEsgotou;
  const selRef = useRef<string | null>(selecionadoId ?? null);
  selRef.current = selecionadoId ?? null;
  const ocultosRef = useRef<Set<string>>(new Set());
  ocultosRef.current = new Set(ocultarIds ?? []);
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
      const visiveis = lista.filter((p) => !ocultosRef.current.has(p.id));
      const nova = selecaoAposRecarga(selRef.current, visiveis);
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

  const tituloDesab = trocarDesabilitado ? "Termine o pedido na mesa antes de trocar a fila" : undefined;
  const btn = (extra?: CSSProperties): CSSProperties => ({ ...trocarBtn, ...extra, ...(trocarDesabilitado ? { opacity: 0.45, cursor: "not-allowed" } : {}) });

  return (
    <div style={wrap}>
      <div style={cabecalho}>
        <div style={titulo}>{tituloGrupo}</div>
        <div style={sub}>
          {pedidos ? `${pedidos.length} pedido${pedidos.length === 1 ? "" : "s"} na fila${comBump > 0 ? ` · ${comBump} com bump` : ""}` : "Carregando…"}
          {erro && " · não consegui atualizar"}
        </div>
        <div style={dica}>Toque num pedido pra escolher · sem escolha sai o primeiro</div>
        <div style={botoes}>
          {onVoltar && (
            <button type="button" style={btn()} onClick={onVoltar} disabled={trocarDesabilitado} title={tituloDesab}>
              Voltar
            </button>
          )}
          <button type="button" style={btn()} onClick={onTrocar} disabled={trocarDesabilitado} title={tituloDesab}>
            Trocar estampa
          </button>
        </div>
      </div>
      <div style={lista} className="thin-scroll" role="listbox">
        {pedidos && pedidos.length === 0 && <div style={vazio}>Nenhum pedido único aguardando esta fila · voltando…</div>}
        {(pedidos ?? []).map((p, i) => {
          const foto = miniaturaLeve(p.imagemUrl);
          const bumpFoto = p.orderBump ? miniaturaLeve(p.orderBump.imagemUrl) : null;
          const tipoTxt = [rotuloTipo(p, grupo.estampa), p.tamanho].filter(Boolean).join(" · ");
          const bumpTxt = p.orderBump ? [p.orderBump.produtoNome, p.orderBump.tamanho].filter(Boolean).join(" · ") : "";
          return (
            <div
              key={p.id}
              role="option"
              aria-selected={p.id === selEfetivo}
              onClick={() => {
                const novo = p.id === selEfetivo ? null : p.id;
                selRef.current = novo;
                onSelecionarRef.current?.(novo);
              }}
              style={{ ...linha, ...(p.orderBump ? linhaBump : {}), cursor: "pointer", ...(p.id === selEfetivo ? linhaSel : {}) }}
            >
              {foto ? <img src={foto} alt="" style={thumb} loading="lazy" decoding="async" /> : <div style={thumbVazio} />}
              <div style={corpo}>
                <div style={linhaTopo}>
                  <span style={pos}>{i + 1}</span>
                  <code style={num}>#{p.numero ?? p.id.slice(0, 8)}</code>
                  {p.prioritario && <span style={prio}>PRIORITÁRIO</span>}
                  {i === 0 && !selEfetivo && <span style={proximo}>PRÓXIMO</span>}
                </div>
                <span style={cli}>{p.cliente ?? ""}</span>
                <span style={tipo}>{tipoTxt}</span>
                {p.orderBump && (
                  <span style={bumpLinha} title="Order bump: leia esta peça junto com o item">
                    {bumpFoto && <img src={bumpFoto} alt="" style={bumpThumb} loading="lazy" decoding="async" />}
                    <span style={bumpPill}>+ {bumpTxt}</span>
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const wrap: CSSProperties = { display: "flex", flexDirection: "column", gap: 8, flex: 1, minHeight: 0 };
const cabecalho: CSSProperties = { display: "flex", flexDirection: "column", gap: 6, padding: "10px 12px", flexShrink: 0, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 14 };
const titulo: CSSProperties = { fontSize: 26, fontWeight: 900, lineHeight: 1.05, letterSpacing: 0.5 };
const sub: CSSProperties = { fontSize: 14, color: "var(--text-secondary)", fontWeight: 700 };
const botoes: CSSProperties = { display: "flex", gap: 8 };
const trocarBtn: CSSProperties = { flex: 1, padding: "10px 12px", background: "var(--bg-input)", border: "1px solid var(--border-strong)", borderRadius: 10, color: "var(--text)", fontWeight: 800, fontSize: 15, cursor: "pointer" };
const lista: CSSProperties = { overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, minHeight: 0, flex: 1 };
const vazio: CSSProperties = { padding: 10, color: "var(--text-secondary)", fontSize: 14 };
const linha: CSSProperties = { display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 10px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 13 };
const pos: CSSProperties = { width: 22, color: "var(--text-muted)", fontWeight: 700 };
const num: CSSProperties = { fontWeight: 800, fontSize: 14 };
const cli: CSSProperties = { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text-secondary)" };
const tipo: CSSProperties = { color: "var(--text)" };
const prio: CSSProperties = { padding: "1px 8px", borderRadius: 999, background: "var(--danger-bg, #fee2e2)", color: "var(--danger-text, #b91c1c)", fontSize: 11, fontWeight: 800 };
const proximo: CSSProperties = { padding: "1px 8px", borderRadius: 999, background: "var(--bg-input)", border: "1px solid var(--border-strong)", color: "var(--text-secondary)", fontSize: 11, fontWeight: 800 };
const dica: CSSProperties = { fontSize: 12, color: "var(--text-muted)" };
const linhaSel: CSSProperties = { border: "2px solid var(--accent, #22c55e)", background: "var(--bg-input)", padding: "7px 9px" };
const bumpThumb: CSSProperties = { width: 20, height: 20, borderRadius: 4, objectFit: "cover" };
const linhaBump: CSSProperties = { borderLeft: "3px solid var(--info-text, #1d4ed8)" };
const bumpPill: CSSProperties = { padding: "1px 8px", borderRadius: 999, background: "var(--info-bg, #dbeafe)", color: "var(--info-text, #1d4ed8)", fontSize: 12, fontWeight: 800 };
const thumb: CSSProperties = { width: 56, height: 56, borderRadius: 6, objectFit: "cover", flexShrink: 0 };
const thumbVazio: CSSProperties = { width: 56, height: 56, borderRadius: 6, background: "var(--bg-input)", flexShrink: 0 };
const corpo: CSSProperties = { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 };
const linhaTopo: CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const bumpLinha: CSSProperties = { display: "flex", alignItems: "center", gap: 6, minWidth: 0 };

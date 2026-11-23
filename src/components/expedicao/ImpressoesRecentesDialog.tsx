// "Impressões recentes" (Únicos): histórico LOCAL dos últimos 3 dias da impressão manual, pra reimprimir
// quando a impressora falhou no meio (o `concluir` já deu baixa e não há como "desfazer").
// Também reimprime por número de pedido (outra máquina): usa o histórico de expedição do servidor.
// Reimprimir nunca dá baixa nem muda status.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { buscarNoHistorico, lerHistorico, type HistoricoLote } from "../../lib/impressaoManualHistorico";
import type { ItemReimpressao } from "../../lib/reimprimirManual";
import { getExpedicaoHistory, type ExpedicaoHistoryOrder } from "../../services/expedicao";
import { ReimprimirLista } from "./ReimprimirLista";

function quando(em: number): string {
  return new Date(em).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function itensDoLote(l: HistoricoLote): ItemReimpressao[] {
  return l.pedidos.map((p) => ({ orderId: p.orderId, numero: p.numero, cliente: p.cliente, tracking: p.tracking, comBump: p.comBump, bump: p.bump ?? null, tamanho: p.tamanho, estampa: l.estampa }));
}

export function ImpressoesRecentesDialog({ onFechar }: { onFechar: () => void }) {
  const [busca, setBusca] = useState("");
  const [historico] = useState(() => lerHistorico());
  const lotes = useMemo(() => buscarNoHistorico(historico, busca), [historico, busca]);

  const [numero, setNumero] = useState("");
  const [buscando, setBuscando] = useState(false);
  const [achados, setAchados] = useState<ExpedicaoHistoryOrder[] | null>(null);
  const [erroNumero, setErroNumero] = useState<string | null>(null);

  useEffect(() => {
    const h = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onFechar();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onFechar]);

  const buscarPedido = async () => {
    const q = numero.trim();
    if (!q || buscando) return;
    setBuscando(true);
    setErroNumero(null);
    try {
      const r = await getExpedicaoHistory({ q, todos: true, limit: 10 });
      setAchados(r.items);
    } catch (e) {
      setAchados(null);
      setErroNumero(`Não consegui buscar o pedido: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBuscando(false);
    }
  };

  const itensAchados: ItemReimpressao[] = (achados ?? []).map((o) => ({ orderId: o.id, numero: o.numero, cliente: o.clienteNome, tracking: o.trackingNumber, comBump: false, canal: o.canal }));

  return (
    <div style={fundo} onClick={onFechar} role="presentation">
      <div style={caixa} role="dialog" aria-modal="true" aria-label="Impressões recentes" onClick={(e) => e.stopPropagation()}>
        <div style={titulo}>Impressões recentes</div>
        <div style={texto}>Últimos 3 dias nesta máquina. Reimprimir manda uma 2ª via pra impressora e não muda o status dos pedidos.</div>
        <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar por número do pedido, estampa, cor ou tamanho…" style={campo} aria-label="Buscar nas impressões recentes" />
        <div style={rolagem} className="thin-scroll">
          {lotes.length === 0 && <div style={vazio}>{historico.length === 0 ? "Nenhuma impressão manual nos últimos 3 dias." : "Nada combina com a busca."}</div>}
          {lotes.map((l) => (
            <details key={l.id} style={blocoLote}>
              <summary style={resumoLote}>
                <b>{quando(l.em)}</b> · {l.estampa}
                {l.cor ? ` ${l.cor}` : ""} · {l.tamanhos.join(", ")} · {l.pedidos.length} pedido{l.pedidos.length === 1 ? "" : "s"}
              </summary>
              <ReimprimirLista itens={itensDoLote(l)} rotuloTodas="Reimprimir lote" maxAltura="26vh" />
            </details>
          ))}
        </div>
        <div style={blocoNumero}>
          <b>Reimprimir por número do pedido</b>
          <div style={texto}>Para um pedido que não está na lista acima (por exemplo, impresso em outra máquina).</div>
          <div style={linha}>
            <input
              value={numero}
              onChange={(e) => setNumero(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void buscarPedido();
              }}
              placeholder="Número do pedido"
              style={campo}
              aria-label="Número do pedido"
            />
            <button type="button" style={botao} onClick={() => void buscarPedido()} disabled={buscando || !numero.trim()}>
              {buscando ? "Buscando…" : "Buscar"}
            </button>
          </div>
          {erroNumero && <div style={avisoErro}>{erroNumero}</div>}
          {achados && achados.length === 0 && <div style={texto}>Nenhum pedido expedido com esse número.</div>}
          {achados && achados.length > 0 && <ReimprimirLista itens={itensAchados} rotuloTodas="Reimprimir todos" maxAltura="18vh" />}
        </div>
        <div style={rodape}>
          <button type="button" style={botao} onClick={onFechar}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}

const fundo: CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 24 };
const caixa: CSSProperties = { width: "min(860px, 100%)", maxHeight: "100%", display: "flex", flexDirection: "column", gap: 12, padding: 20, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 14, color: "var(--text)", overflow: "hidden" };
const titulo: CSSProperties = { fontSize: 20, fontWeight: 800 };
const texto: CSSProperties = { fontSize: 13, color: "var(--text-secondary)" };
const campo: CSSProperties = { flex: 1, padding: "10px 14px", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text)", fontSize: 14 };
const rolagem: CSSProperties = { flex: 1, minHeight: 80, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 };
const blocoLote: CSSProperties = { padding: 10, border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-input)" };
const resumoLote: CSSProperties = { cursor: "pointer", fontSize: 14, padding: "4px 0" };
const blocoNumero: CSSProperties = { display: "flex", flexDirection: "column", gap: 6, padding: 12, border: "1px solid var(--border)", borderRadius: 10 };
const linha: CSSProperties = { display: "flex", gap: 8 };
const botao: CSSProperties = { padding: "10px 16px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text)", fontWeight: 700, cursor: "pointer" };
const rodape: CSSProperties = { display: "flex", justifyContent: "flex-end" };
const vazio: CSSProperties = { padding: 12, color: "var(--text-secondary)", textAlign: "center" };
const avisoErro: CSSProperties = { padding: "6px 12px", borderRadius: 8, background: "var(--warning-bg)", border: "1px solid var(--warning-border)", color: "var(--warning-text)", fontSize: 13 };

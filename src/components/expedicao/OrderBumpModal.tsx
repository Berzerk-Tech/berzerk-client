// Configuração do order bump da fila de Únicos: liga/desliga e escolhe o(s)
// produto(s) que a embaladora lê junto com a peça principal.

import { useEffect, useState, type CSSProperties } from "react";
import { miniaturaLeve } from "../../lib/imagens";
import {
  buscarProdutosOrderBump,
  putOrderBump,
  type OrderBumpConfig,
  type OrderBumpProduto,
} from "../../services/expedicao";

const MAX_PRODUTOS = 10;

export function OrderBumpModal({
  atual,
  onFechar,
  onSalvo,
}: {
  atual: OrderBumpConfig;
  onFechar: () => void;
  onSalvo: (c: OrderBumpConfig) => void;
}) {
  const [ativo, setAtivo] = useState(atual.ativo);
  const [selecionados, setSelecionados] = useState<OrderBumpProduto[]>(atual.produtos);
  const [busca, setBusca] = useState("");
  const [achados, setAchados] = useState<OrderBumpProduto[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    const termo = busca.trim();
    if (termo.length < 2) {
      setAchados([]);
      return;
    }
    let vivo = true;
    const t = window.setTimeout(() => {
      setBuscando(true);
      buscarProdutosOrderBump(termo, 20)
        .then((r) => vivo && setAchados(r))
        .catch(() => vivo && setMsg("Não consegui buscar produtos."))
        .finally(() => vivo && setBuscando(false));
    }, 300);
    return () => {
      vivo = false;
      window.clearTimeout(t);
    };
  }, [busca]);

  const adicionar = (p: OrderBumpProduto) => {
    setMsg(null);
    setSelecionados((l) => {
      if (l.some((x) => x.id === p.id)) return l;
      if (l.length >= MAX_PRODUTOS) {
        setMsg(`No máximo ${MAX_PRODUTOS} produtos.`);
        return l;
      }
      return [...l, p];
    });
  };

  const salvar = async () => {
    if (ativo && selecionados.length === 0) {
      setMsg("Escolha ao menos um produto de order bump ou desligue a opção.");
      return;
    }
    setSalvando(true);
    setMsg(null);
    try {
      const r = await putOrderBump({ ativo, produtoIds: selecionados.map((p) => p.id) });
      onSalvo(r);
    } catch {
      setMsg("Não consegui salvar. Tente de novo.");
    } finally {
      setSalvando(false);
    }
  };

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label="Order bump" onClick={onFechar}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <h2 style={titulo}>Order bump</h2>
        <label style={linha}>
          <input type="checkbox" checked={ativo} onChange={(e) => setAtivo(e.target.checked)} />
          <span>Order bump ativo</span>
        </label>
        <p style={dica}>
          Pedido de 2 itens (peça principal + order bump) cai na fila da peça principal. Leia as duas etiquetas juntas na mesa.
        </p>
        <input
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar produto do order bump…"
          style={input}
          aria-label="Buscar produto do order bump"
        />
        {buscando && <div style={dica}>Buscando…</div>}
        {achados.length > 0 && (
          <div style={resultados} className="thin-scroll">
            {achados.map((p) => (
              <button key={p.id} type="button" style={resultado} onClick={() => adicionar(p)}>
                <Mini url={p.imagemUrl} />
                <span>{p.nome}</span>
              </button>
            ))}
          </div>
        )}
        <div style={chips}>
          {selecionados.length === 0 && <span style={dica}>Nenhum produto escolhido.</span>}
          {selecionados.map((p) => (
            <span key={p.id} style={chip}>
              <Mini url={p.imagemUrl} />
              {p.nome}
              <button
                type="button"
                style={remover}
                aria-label={`Remover ${p.nome}`}
                onClick={() => setSelecionados((l) => l.filter((x) => x.id !== p.id))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        {msg && <div style={aviso}>{msg}</div>}
        <div style={acoes}>
          <button type="button" style={ghost} onClick={onFechar}>
            Cancelar
          </button>
          <button type="button" style={primario} onClick={() => void salvar()} disabled={salvando}>
            {salvando ? "Salvando…" : "Salvar"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Mini({ url }: { url: string | null }) {
  const img = miniaturaLeve(url);
  return <span style={mini}>{img ? <img src={img} alt="" style={miniImg} loading="lazy" /> : null}</span>;
}

const overlay: CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 };
const modal: CSSProperties = { width: 480, maxWidth: "92vw", maxHeight: "88vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, padding: 20, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 14, color: "var(--text)" };
const titulo: CSSProperties = { margin: 0, fontSize: 20, fontWeight: 800 };
const linha: CSSProperties = { display: "flex", alignItems: "center", gap: 8, fontWeight: 700 };
const dica: CSSProperties = { margin: 0, fontSize: 12, color: "var(--text-secondary)" };
const input: CSSProperties = { padding: "10px 14px", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text)", fontSize: 14 };
const resultados: CSSProperties = { maxHeight: 200, overflowY: "auto", display: "flex", flexDirection: "column", gap: 4 };
const resultado: CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: 6, textAlign: "left", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)", cursor: "pointer" };
const chips: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 6 };
const chip: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 8px", borderRadius: 999, background: "var(--bg-input)", border: "1px solid var(--border)", fontSize: 13 };
const remover: CSSProperties = { background: "transparent", border: "none", color: "var(--text-secondary)", fontSize: 16, cursor: "pointer", lineHeight: 1 };
const mini: CSSProperties = { width: 28, height: 36, flexShrink: 0, borderRadius: 4, overflow: "hidden", background: "var(--bg-card)", display: "inline-block" };
const miniImg: CSSProperties = { width: "100%", height: "100%", objectFit: "cover" };
const aviso: CSSProperties = { padding: "6px 12px", borderRadius: 8, background: "var(--warning-bg)", border: "1px solid var(--warning-border)", color: "var(--warning-text)", fontSize: 12 };
const acoes: CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4 };
const ghost: CSSProperties = { padding: "9px 14px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text)", fontWeight: 700, cursor: "pointer" };
const primario: CSSProperties = { ...ghost, background: "var(--accent, #dc2626)", borderColor: "transparent", color: "#fff" };

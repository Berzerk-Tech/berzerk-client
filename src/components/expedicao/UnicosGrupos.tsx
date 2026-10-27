// Modo Únicos, passo 1: a embaladora escolhe a caixa (estampa × tamanho) que
// chegou na mesa. Poll de 30 s (o servidor guarda 30 s de cache).

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { miniaturaLeve } from "../../lib/imagens";
import { filtrarGrupos, unicosRotaAusente, type GrupoEscolhido } from "../../lib/unicosExpedicao";
import { getUnicos, type UnicoGrupo, type UnicosResponse } from "../../services/expedicao";

const POLL_MS = 30000;

export function UnicosGrupos({
  onEscolher,
  onIndisponivel,
}: {
  onEscolher: (g: GrupoEscolhido) => void;
  /** API ainda sem a fila (404): a tela desabilita o modo. */
  onIndisponivel: () => void;
}) {
  const [dados, setDados] = useState<UnicosResponse | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [busca, setBusca] = useState("");

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      setDados(await getUnicos());
      setErro(null);
    } catch (e) {
      if (unicosRotaAusente(e)) onIndisponivel();
      setErro("Não consegui carregar a fila de únicos. Tentando de novo…");
    } finally {
      setCarregando(false);
    }
  }, [onIndisponivel]);

  useEffect(() => {
    void carregar();
    const id = window.setInterval(() => void carregar(), POLL_MS);
    return () => window.clearInterval(id);
  }, [carregar]);

  const grupos = useMemo(() => filtrarGrupos(dados?.grupos ?? [], busca), [dados, busca]);

  return (
    <div style={wrap}>
      <div style={topo}>
        <input
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          placeholder="Buscar estampa ou tipo de peça…"
          style={buscaInput}
          aria-label="Buscar fila de únicos"
        />
        <span style={total}>{dados ? `${dados.totalPedidos ?? 0} pedidos` : ""}</span>
        <button type="button" style={atualizarBtn} onClick={() => void carregar()} disabled={carregando}>
          {carregando ? "Atualizando…" : "↻ Atualizar"}
        </button>
      </div>
      {dados && dados.filaUnicosAtiva === false && (
        <div style={aviso}>Trava desligada: estes pedidos ainda aparecem na fila de separação.</div>
      )}
      {erro && <div style={avisoErro}>{erro}</div>}
      {dados && grupos.length === 0 && (
        <div style={vazio}>{busca.trim() ? "Nenhuma fila combina com a busca." : "Nenhum pedido único aguardando."}</div>
      )}
      <div style={grade} className="thin-scroll">
        {grupos.map((g) => (
          <CardGrupo key={`${g.estampa}|${g.tamanho}`} g={g} onEscolher={() => onEscolher({ estampa: g.estampa, tamanho: g.tamanho })} />
        ))}
      </div>
    </div>
  );
}

function CardGrupo({ g, onEscolher }: { g: UnicoGrupo; onEscolher: () => void }) {
  const img = miniaturaLeve(g.imagemUrl);
  const tipos = g.tipos ?? [];
  return (
    <button type="button" style={card} onClick={onEscolher} title={`Escolher a fila ${g.estampa} ${g.tamanho}`}>
      <div style={fotoBox}>{img ? <img src={img} alt="" style={foto} loading="lazy" /> : <span style={semFoto}>sem foto</span>}</div>
      <div style={cardCorpo}>
        <div style={estampaTxt}>{g.estampa}</div>
        <div style={tamanhoTxt}>{g.tamanho}</div>
        <div style={contagem}>
          {g.pedidos} pedido{g.pedidos === 1 ? "" : "s"}
          {(g.prioritarios ?? 0) > 0 && <span style={prioBadge}>{g.prioritarios} prioritário{g.prioritarios === 1 ? "" : "s"}</span>}
        </div>
        {tipos.length > 0 && (
          <div style={tiposTxt}>
            {tipos
              .slice(0, 3)
              .map((t) => `${t.produtoNome} (${t.pedidos})`)
              .join(" · ")}
            {tipos.length > 3 ? ` · +${tipos.length - 3}` : ""}
          </div>
        )}
      </div>
    </button>
  );
}

const wrap: CSSProperties = { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 12, padding: "4px 0" };
const topo: CSSProperties = { display: "flex", alignItems: "center", gap: 12 };
const buscaInput: CSSProperties = { flex: 1, padding: "10px 14px", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text)", fontSize: 15 };
const total: CSSProperties = { color: "var(--text-secondary)", fontSize: 13, fontWeight: 700 };
const atualizarBtn: CSSProperties = { padding: "9px 14px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text)", fontWeight: 700, cursor: "pointer" };
const aviso: CSSProperties = { padding: "6px 12px", borderRadius: 8, background: "var(--warning-bg)", border: "1px solid var(--warning-border)", color: "var(--warning-text)", fontSize: 12 };
const avisoErro: CSSProperties = { ...aviso };
const vazio: CSSProperties = { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-secondary)", fontSize: 18 };
const grade: CSSProperties = { flex: 1, minHeight: 0, overflowY: "auto", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 12, alignContent: "start" };
const card: CSSProperties = { display: "flex", gap: 12, padding: 10, textAlign: "left", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 14, color: "var(--text)", cursor: "pointer" };
const fotoBox: CSSProperties = { width: 84, height: 112, flexShrink: 0, borderRadius: 10, overflow: "hidden", background: "var(--bg-input)", display: "flex", alignItems: "center", justifyContent: "center" };
const foto: CSSProperties = { width: "100%", height: "100%", objectFit: "cover" };
const semFoto: CSSProperties = { fontSize: 11, color: "var(--text-muted)" };
const cardCorpo: CSSProperties = { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 };
const estampaTxt: CSSProperties = { fontSize: 17, fontWeight: 800, lineHeight: 1.15, overflowWrap: "anywhere" };
const tamanhoTxt: CSSProperties = { fontSize: 40, fontWeight: 900, lineHeight: 1 };
const contagem: CSSProperties = { fontSize: 13, color: "var(--text-secondary)", fontWeight: 700, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" };
const prioBadge: CSSProperties = { padding: "1px 7px", borderRadius: 999, background: "var(--danger-bg, #fee2e2)", color: "var(--danger-text, #b91c1c)", fontSize: 11 };
const tiposTxt: CSSProperties = { fontSize: 11, color: "var(--text-muted)" };

// Modo Únicos, passo 1: a embaladora escolhe a caixa (estampa × tamanho) que
// chegou na mesa. A grade tem UM card por estampa (com os tamanhos como chips);
// estampa com mais de um tamanho abre um painel de botões grandes de tamanho.
// Poll de 30 s (o servidor guarda 30 s de cache).

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { miniaturaLeve } from "../../lib/imagens";
import {
  agruparPorEstampa,
  filtrarGrupos,
  rotuloOrderBump,
  unicosRotaAusente,
  type EstampaAgrupada,
  type GrupoEscolhido,
} from "../../lib/unicosExpedicao";
import { getUnicos, type UnicosResponse } from "../../services/expedicao";
import { getMe } from "../../services/orders";
import { OrderBumpModal } from "./OrderBumpModal";

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
  const [estampaAberta, setEstampaAberta] = useState<string | null>(null);
  const [bumpAberto, setBumpAberto] = useState(false);
  // O PUT da config exige `separacao:manage` (coordenação do CD): a operadora não vê o botão.
  const [podeConfigurarBump, setPodeConfigurarBump] = useState(false);

  useEffect(() => {
    let vivo = true;
    getMe()
      .then((me) => {
        if (vivo) setPodeConfigurarBump(me.permissions.includes("*") || me.permissions.includes("separacao:manage"));
      })
      .catch(() => {});
    return () => {
      vivo = false;
    };
  }, []);

  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const r = await getUnicos();
      setDados(r);
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
  const estampas = useMemo(() => agruparPorEstampa(grupos), [grupos]);
  const aberta = estampaAberta ? (estampas.find((e) => e.estampa === estampaAberta) ?? null) : null;

  // Estampa aberta sumiu (acabaram os pedidos no poll) ou deixou de casar com a busca: volta pra grade.
  useEffect(() => {
    if (estampaAberta && !aberta) setEstampaAberta(null);
  }, [estampaAberta, aberta]);

  const clicarEstampa = (e: EstampaAgrupada) => {
    if (e.tamanhos.length === 1) onEscolher({ estampa: e.estampa, tamanho: e.tamanhos[0].tamanho });
    else setEstampaAberta(e.estampa);
  };

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
        {dados?.orderBump && podeConfigurarBump && (
          <button type="button" style={bumpBtn} onClick={() => setBumpAberto(true)} title="Configurar order bump">
            {rotuloOrderBump(dados.orderBump)}
          </button>
        )}
        <button type="button" style={atualizarBtn} onClick={() => void carregar()} disabled={carregando}>
          {carregando ? "Atualizando…" : "↻ Atualizar"}
        </button>
      </div>
      {bumpAberto && dados?.orderBump && (
        <OrderBumpModal
          atual={dados.orderBump}
          onFechar={() => setBumpAberto(false)}
          onSalvo={(c) => {
            setDados((d) => (d ? { ...d, orderBump: c } : d));
            setBumpAberto(false);
            void carregar();
          }}
        />
      )}
      {dados && dados.filaUnicosAtiva === false && (
        <div style={aviso}>Trava desligada: estes pedidos ainda aparecem na fila de separação.</div>
      )}
      {erro && <div style={avisoErro}>{erro}</div>}
      {dados && grupos.length === 0 && (
        <div style={vazio}>{busca.trim() ? "Nenhuma fila combina com a busca." : "Nenhum pedido único aguardando."}</div>
      )}
      {aberta ? (
        <EscolherTamanho e={aberta} onVoltar={() => setEstampaAberta(null)} onEscolher={onEscolher} />
      ) : (
        <div style={grade} className="thin-scroll">
          {estampas.map((e) => (
            <CardEstampa key={e.estampa} e={e} onClick={() => clicarEstampa(e)} />
          ))}
        </div>
      )}
    </div>
  );
}

function Prioritarios({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span style={prioBadge}>
      {n} prioritário{n === 1 ? "" : "s"}
    </span>
  );
}

function ComBump({ n }: { n: number }) {
  if (n <= 0) return null;
  return <span style={bumpBadge}>{n} com bump</span>;
}

function CardEstampa({ e, onClick }: { e: EstampaAgrupada; onClick: () => void }) {
  const img = miniaturaLeve(e.imagemUrl);
  const unico = e.tamanhos.length === 1 ? e.tamanhos[0].tamanho : null;
  return (
    <button
      type="button"
      style={card}
      onClick={onClick}
      title={unico ? `Escolher a fila ${e.estampa} ${unico}` : `Abrir ${e.estampa}`}
    >
      <div style={fotoBox}>{img ? <img src={img} alt="" style={foto} loading="lazy" /> : <span style={semFoto}>sem foto</span>}</div>
      <div style={cardCorpo}>
        <div style={estampaTxt}>{e.estampa}</div>
        <div style={contagem}>
          {e.pedidos} pedido{e.pedidos === 1 ? "" : "s"}
          <Prioritarios n={e.prioritarios} />
          <ComBump n={e.comOrderBump} />
        </div>
        <div style={chips}>
          {e.tamanhos.map((t) => (
            <span key={t.tamanho} style={chip}>
              <b>{t.tamanho}</b> {t.pedidos}
            </span>
          ))}
        </div>
      </div>
    </button>
  );
}

function EscolherTamanho({
  e,
  onVoltar,
  onEscolher,
}: {
  e: EstampaAgrupada;
  onVoltar: () => void;
  onEscolher: (g: GrupoEscolhido) => void;
}) {
  useEffect(() => {
    const h = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onVoltar();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onVoltar]);

  const img = miniaturaLeve(e.imagemUrl);
  return (
    <div style={painel} className="thin-scroll">
      <button type="button" style={voltarBtn} onClick={onVoltar}>
        ← Voltar
      </button>
      <div style={painelTopo}>
        <div style={fotoGrande}>{img ? <img src={img} alt="" style={foto} /> : <span style={semFoto}>sem foto</span>}</div>
        <div style={cardCorpo}>
          <div style={estampaGrande}>{e.estampa}</div>
          <div style={contagem}>
            {e.pedidos} pedido{e.pedidos === 1 ? "" : "s"}
            <Prioritarios n={e.prioritarios} />
            <ComBump n={e.comOrderBump} />
          </div>
        </div>
      </div>
      <div style={botoes}>
        {e.tamanhos.map((g) => {
          const tipos = g.tipos ?? [];
          return (
            <button
              key={g.tamanho}
              type="button"
              style={tamanhoBtn}
              onClick={() => onEscolher({ estampa: e.estampa, tamanho: g.tamanho })}
              title={`Escolher a fila ${e.estampa} ${g.tamanho}`}
            >
              <div style={tamanhoGrande}>{g.tamanho}</div>
              <div style={contagem}>
                {g.pedidos} pedido{g.pedidos === 1 ? "" : "s"}
                <Prioritarios n={g.prioritarios ?? 0} />
                <ComBump n={g.comOrderBump ?? 0} />
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
            </button>
          );
        })}
      </div>
    </div>
  );
}

const wrap: CSSProperties = { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 12, padding: "4px 0" };
const topo: CSSProperties = { display: "flex", alignItems: "center", gap: 12 };
const buscaInput: CSSProperties = { flex: 1, padding: "10px 14px", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text)", fontSize: 15 };
const total: CSSProperties = { color: "var(--text-secondary)", fontSize: 13, fontWeight: 700 };
const atualizarBtn: CSSProperties = { padding: "9px 14px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text)", fontWeight: 700, cursor: "pointer" };
const bumpBtn: CSSProperties = { padding: "9px 14px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text)", fontWeight: 700, cursor: "pointer", maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const bumpBadge: CSSProperties = { padding: "1px 7px", borderRadius: 999, background: "var(--info-bg, #dbeafe)", color: "var(--info-text, #1d4ed8)", fontSize: 11 };
const aviso: CSSProperties = { padding: "6px 12px", borderRadius: 8, background: "var(--warning-bg)", border: "1px solid var(--warning-border)", color: "var(--warning-text)", fontSize: 12 };
const avisoErro: CSSProperties = { ...aviso };
const vazio: CSSProperties = { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-secondary)", fontSize: 18 };
const grade: CSSProperties = { flex: 1, minHeight: 0, overflowY: "auto", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 12, alignContent: "start" };
const card: CSSProperties = { display: "flex", gap: 12, padding: 10, textAlign: "left", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 14, color: "var(--text)", cursor: "pointer" };
const fotoBox: CSSProperties = { width: 84, height: 112, flexShrink: 0, borderRadius: 10, overflow: "hidden", background: "var(--bg-input)", display: "flex", alignItems: "center", justifyContent: "center" };
const foto: CSSProperties = { width: "100%", height: "100%", objectFit: "cover" };
const semFoto: CSSProperties = { fontSize: 11, color: "var(--text-muted)" };
const cardCorpo: CSSProperties = { display: "flex", flexDirection: "column", gap: 4, minWidth: 0 };
const estampaTxt: CSSProperties = { fontSize: 19, fontWeight: 800, lineHeight: 1.15, overflowWrap: "anywhere" };
const contagem: CSSProperties = { fontSize: 13, color: "var(--text-secondary)", fontWeight: 700, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" };
const prioBadge: CSSProperties = { padding: "1px 7px", borderRadius: 999, background: "var(--danger-bg, #fee2e2)", color: "var(--danger-text, #b91c1c)", fontSize: 11 };
const tiposTxt: CSSProperties = { fontSize: 11, color: "var(--text-muted)" };
const chips: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 4 };
const chip: CSSProperties = { padding: "1px 7px", borderRadius: 6, background: "var(--bg-input)", border: "1px solid var(--border)", fontSize: 12, color: "var(--text-secondary)" };
const painel: CSSProperties = { flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 16 };
const voltarBtn: CSSProperties = { alignSelf: "flex-start", padding: "9px 14px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text)", fontWeight: 700, cursor: "pointer" };
const painelTopo: CSSProperties = { display: "flex", gap: 16, alignItems: "center" };
const fotoGrande: CSSProperties = { ...fotoBox, width: 140, height: 186 };
const estampaGrande: CSSProperties = { fontSize: 32, fontWeight: 900, lineHeight: 1.1, overflowWrap: "anywhere" };
const botoes: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 12 };
const tamanhoBtn: CSSProperties = { minWidth: 150, minHeight: 150, padding: 12, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, textAlign: "center", background: "var(--bg-card)", border: "2px solid var(--border-strong)", borderRadius: 14, color: "var(--text)", cursor: "pointer" };
const tamanhoGrande: CSSProperties = { fontSize: 44, fontWeight: 900, lineHeight: 1 };

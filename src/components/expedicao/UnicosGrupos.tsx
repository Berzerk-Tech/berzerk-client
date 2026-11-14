// Modo Únicos, passo 1: a embaladora escolhe a caixa (estampa × tamanho) que
// chegou na mesa. A grade tem UM card por estampa (com os tamanhos como chips);
// estampa com mais de um tamanho abre um painel de botões grandes de tamanho.
// Poll de 30 s (o servidor guarda 30 s de cache).

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { miniaturaLeve } from "../../lib/imagens";
import {
  agruparPorEstampa,
  filtrarGrupos,
  escolherPeriodo,
  periodoEfetivo,
  periodoVazio,
  rotuloDia,
  rotuloOrderBump,
  rotuloTipos,
  unicosRotaAusente,
  PERIODO_VAZIO,
  type EstampaAgrupada,
  type PeriodoUnicos,
  type GrupoEscolhido,
} from "../../lib/unicosExpedicao";
import { devolverUnicosGrupos, getUnicos, liberarImpressaoManual, type UnicosResponse } from "../../services/expedicao";
import { isExpedicaoSimulacao } from "../../services/expedicaoMode";
import { getMe } from "../../services/orders";
import { limparLoteEmCurso, lerLoteEmCurso } from "../../lib/impressaoManualLote";
import { ImpressaoManualDialog } from "./ImpressaoManualDialog";
import { OrderBumpModal } from "./OrderBumpModal";
import { lerSemOrderBump, pedidosSemBump, salvarSemOrderBump } from "../../lib/unicosSemBump";

const POLL_MS = 30000;

export function UnicosGrupos({
  onEscolher,
  onIndisponivel,
  estampaInicial = null,
  periodo = PERIODO_VAZIO,
  onPeriodo,
  suportado = null,
  onSuporte,
}: {
  onEscolher: (g: GrupoEscolhido) => void;
  /** API ainda sem a fila (404): a tela desabilita o modo. */
  onIndisponivel: () => void;
  /** Chave (`chaveEstampa`: estampa + cor) cujo painel de tamanhos abre direto (a fila do tamanho acabou). */
  estampaInicial?: string | null;
  /** Intervalo de dias (YYYY-MM-DD) filtrado, controlado pelo pai pra sobreviver a grade ↔ lateral. */
  periodo?: PeriodoUnicos;
  onPeriodo?: (p: PeriodoUnicos) => void;
  /** Servidor aplica `de`/`ate`? null = ainda sem resposta; false = API antiga (só um dia). */
  suportado?: boolean | null;
  onSuporte?: (suportado: boolean) => void;
}) {
  const [dados, setDados] = useState<UnicosResponse | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [busca, setBusca] = useState("");
  const [estampaAberta, setEstampaAberta] = useState<string | null>(estampaInicial);
  const [bumpAberto, setBumpAberto] = useState(false);
  // O PUT da config exige `separacao:manage` (coordenação do CD): a operadora não vê o botão.
  const [podeConfigurarBump, setPodeConfigurarBump] = useState(false);
  // Impressão manual do tamanho inteiro: só com `me.unicosImpressaoManual === true` (ausente = servidor antigo).
  const [impressaoManual, setImpressaoManual] = useState(() => isExpedicaoSimulacao());
  const [chipAberto, setChipAberto] = useState<{ grupo: GrupoEscolhido; pedidos: number } | null>(null);
  // "Sem order bump" (14/11): contagem, lista e impressão manual ignoram os pedidos com bump. Só pra quem imprime.
  const [semBumpPref, setSemBumpPref] = useState(() => lerSemOrderBump());
  const semBump = impressaoManual && semBumpPref;
  const alternarSemBump = () => {
    setSemBumpPref((v) => {
      salvarSemOrderBump(!v);
      return !v;
    });
  };

  useEffect(() => {
    let vivo = true;
    // Rede de segurança: sobra de um lote interrompido (app fechou no meio) volta pra fila.
    const sobra = lerLoteEmCurso();
    if (sobra) {
      void liberarImpressaoManual(sobra.orderIds)
        .then(() => limparLoteEmCurso())
        .catch(() => {});
    }
    getMe()
      .then((me) => {
        if (!vivo) return;
        setPodeConfigurarBump(me.permissions.includes("*") || me.permissions.includes("separacao:manage"));
        if (me.unicosImpressaoManual === true) setImpressaoManual(true);
      })
      .catch(() => {});
    return () => {
      vivo = false;
    };
  }, []);

  // Deps primitivas: `periodo` pode chegar como objeto novo a cada render do pai.
  const periodoDe = periodo.de;
  const periodoAte = periodo.ate;
  const carregar = useCallback(async () => {
    setCarregando(true);
    try {
      const r = await getUnicos(periodoEfetivo({ de: periodoDe, ate: periodoAte }, suportado));
      onSuporte?.(r.periodo !== undefined);
      setDados(r);
      setErro(null);
    } catch (e) {
      if (unicosRotaAusente(e)) onIndisponivel();
      setErro("Não consegui carregar a fila de únicos. Tentando de novo…");
    } finally {
      setCarregando(false);
    }
  }, [onIndisponivel, periodoDe, periodoAte, suportado, onSuporte]);

  useEffect(() => {
    void carregar();
    const id = window.setInterval(() => void carregar(), POLL_MS);
    return () => window.clearInterval(id);
  }, [carregar]);

  const grupos = useMemo(() => filtrarGrupos(dados?.grupos ?? [], busca), [dados, busca]);
  const estampas = useMemo(() => agruparPorEstampa(grupos), [grupos]);
  const aberta = estampaAberta ? (estampas.find((e) => e.chave === estampaAberta) ?? null) : null;

  // Estampa aberta sumiu (acabaram os pedidos no poll) ou deixou de casar com a busca: volta pra grade.
  useEffect(() => {
    // Só depois do primeiro carregamento: antes disso `aberta` é null por falta de dados.
    if (dados !== null && estampaAberta && !aberta) setEstampaAberta(null);
  }, [dados, estampaAberta, aberta]);

  // "Devolver várias" (14/11, mutirão): os cards viram seleção e as estampas marcadas voltam inteiras pra separação.
  const [modoDevolver, setModoDevolver] = useState(false);
  const [marcadas, setMarcadas] = useState<Set<string>>(new Set());
  const [confirmando, setConfirmando] = useState(false);
  const [devolvendo, setDevolvendo] = useState(false);
  const [msgDevolver, setMsgDevolver] = useState<string | null>(null);
  const escolhidas = useMemo(() => estampas.filter((e) => marcadas.has(e.chave)), [estampas, marcadas]);
  const pedidosEscolhidos = escolhidas.reduce((n, e) => n + e.pedidos, 0);
  const sairDoModo = () => {
    setModoDevolver(false);
    setMarcadas(new Set());
    setConfirmando(false);
  };
  const alternarMarcada = (chave: string) => {
    setConfirmando(false);
    setMarcadas((atual) => {
      const prox = new Set(atual);
      if (prox.has(chave)) prox.delete(chave);
      else prox.add(chave);
      return prox;
    });
  };
  const devolverMarcadas = async () => {
    if (escolhidas.length === 0 || devolvendo) return;
    setDevolvendo(true);
    setMsgDevolver(null);
    try {
      const r = await devolverUnicosGrupos(
        escolhidas.map((e) => ({ estampa: e.estampa, cor: e.cor })),
        periodoEfetivo({ de: periodoDe, ate: periodoAte }, suportado),
      );
      setMsgDevolver(`${r.devolvidos} pedido(s) de ${escolhidas.length} estampa(s) voltaram para a separação.${r.restantes > 0 ? ` Sobraram ${r.restantes}: repita.` : ""}`);
      sairDoModo();
    } catch (e) {
      const status = (e as { status?: number } | null)?.status;
      setMsgDevolver(
        status === 403
          ? "Seu cadastro não pode devolver pedidos à separação."
          : status === 404
            ? "O servidor ainda não tem a devolução por estampa. Tente de novo em alguns minutos."
            : `Não consegui devolver: ${e instanceof Error ? e.message : String(e)}`,
      );
      setConfirmando(false);
    } finally {
      setDevolvendo(false);
      void carregar();
    }
  };

  const clicarEstampa = (e: EstampaAgrupada) => {
    if (modoDevolver) {
      alternarMarcada(e.chave);
      return;
    }
    if (e.tamanhos.length === 1) onEscolher({ estampa: e.estampa, tamanho: e.tamanhos[0].tamanho, cor: e.cor });
    else setEstampaAberta(e.chave);
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
        {onPeriodo && (
          <SeletorPeriodo dias={dados?.dias} periodo={periodoEfetivo(periodo, suportado)} suportado={suportado === true} onPeriodo={onPeriodo} />
        )}
        <span style={total}>{dados ? `${dados.totalPedidos ?? 0} pedidos` : ""}</span>
        {impressaoManual && (
          <button
            type="button"
            style={semBump ? bumpBtnLigado : bumpBtn}
            onClick={alternarSemBump}
            aria-pressed={semBump}
            title="Ligado: os pedidos com order bump ficam fora da contagem e da impressão manual"
          >
            {semBump ? "Sem order bump: ligado" : "Sem order bump: desligado"}
          </button>
        )}
        {podeConfigurarBump && !modoDevolver && (
          <button type="button" style={bumpBtn} onClick={() => { setMsgDevolver(null); setEstampaAberta(null); setModoDevolver(true); }} title="Marcar várias estampas e mandar os pedidos delas de volta pra separação">
            ↩ Devolver à separação
          </button>
        )}
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
      {modoDevolver && (
        <div style={barraDevolver}>
          <span style={{ flex: 1, minWidth: 220 }}>
            <b>Devolver à separação:</b> clique nas estampas que voltam para as separadoras e depois em Devolver.{" "}
            <b>
              {escolhidas.length} estampa(s) marcada(s) · {pedidosEscolhidos} pedido(s)
            </b>
          </span>
          <button type="button" style={bumpBtn} onClick={() => { setConfirmando(false); setMarcadas(new Set(estampas.map((e) => e.chave))); }} disabled={devolvendo}>
            Marcar todas as {estampas.length} da tela
          </button>
          <button type="button" style={bumpBtn} onClick={() => { setConfirmando(false); setMarcadas(new Set()); }} disabled={devolvendo || marcadas.size === 0}>
            Limpar
          </button>
          {confirmando ? (
            <button type="button" style={devolverBtn} onClick={() => void devolverMarcadas()} disabled={devolvendo}>
              {devolvendo ? "Devolvendo…" : `Tem certeza? Sim, devolver ${pedidosEscolhidos}`}
            </button>
          ) : (
            <button type="button" style={devolverBtn} onClick={() => setConfirmando(true)} disabled={escolhidas.length === 0}>
              {escolhidas.length === 0 ? "Devolver" : `Devolver ${pedidosEscolhidos} pedidos`}
            </button>
          )}
          <button type="button" style={bumpBtn} onClick={sairDoModo} disabled={devolvendo}>
            Cancelar
          </button>
        </div>
      )}
      {msgDevolver && <div style={aviso}>{msgDevolver}</div>}
      {erro && <div style={avisoErro}>{erro}</div>}
      {dados && grupos.length === 0 && (
        <div style={vazio}>{busca.trim() ? "Nenhuma fila combina com a busca." : "Nenhum pedido único aguardando."}</div>
      )}
      {aberta ? (
        <EscolherTamanho e={aberta} onVoltar={() => setEstampaAberta(null)} onEscolher={onEscolher} />
      ) : (
        <div style={grade} className="thin-scroll">
          {estampas.map((e) => (
            <CardEstampa
              key={e.chave}
              e={e}
              onClick={() => clicarEstampa(e)}
              semBump={semBump}
              marcada={modoDevolver ? marcadas.has(e.chave) : undefined}
              onChip={!modoDevolver && (impressaoManual || podeConfigurarBump) ? (t) => setChipAberto({ grupo: { estampa: e.estampa, tamanho: t.tamanho, cor: e.cor }, pedidos: t.pedidos }) : undefined}
            />
          ))}
        </div>
      )}
      {chipAberto && (
        <ImpressaoManualDialog
          grupo={chipAberto.grupo}
          periodo={periodoEfetivo(periodo, suportado)}
          totalNaFila={chipAberto.pedidos}
          podeImprimir={impressaoManual}
          podeDevolver={podeConfigurarBump}
          semOrderBump={semBump}
          onFechar={() => setChipAberto(null)}
          onAtualizar={() => void carregar()}
        />
      )}
    </div>
  );
}

/**
 * Filtro por intervalo de dias de emissão (Victor 06/11/2026; intervalo em 10/11).
 * Nexus novo manda `dias` (com contagem): selects. Nexus antigo não manda: `input date`
 * e a lateral filtra localmente. Sem `periodo` na resposta (`suportado` false) o servidor
 * só entende um dia: "Até" fica desabilitado.
 */
function SeletorPeriodo({
  dias,
  periodo,
  suportado,
  onPeriodo,
}: {
  dias?: { dia: string; pedidos: number }[];
  periodo: PeriodoUnicos;
  suportado: boolean;
  onPeriodo: (p: PeriodoUnicos) => void;
}) {
  const campo = (c: "de" | "ate", rotulo: string, vazio: string, desabilitado: boolean) => {
    const valor = periodo[c];
    const aria = `Dia de emissão: ${rotulo}`;
    const muda = (v: string) => onPeriodo(escolherPeriodo(periodo, c, v || null, suportado));
    if (!dias) {
      return (
        <label style={diaRotulo}>
          {rotulo}
          <input type="date" value={valor ?? ""} onChange={(e) => muda(e.target.value)} disabled={desabilitado} style={diaInput} aria-label={aria} title={aria} />
        </label>
      );
    }
    const lista = valor && !dias.some((d) => d.dia === valor) ? [...dias, { dia: valor, pedidos: 0 }] : dias;
    return (
      <label style={diaRotulo}>
        {rotulo}
        <select value={valor ?? ""} onChange={(e) => muda(e.target.value)} disabled={desabilitado} style={diaInput} aria-label={aria} title={aria}>
          <option value="">{vazio}</option>
          {lista.map((d) => (
            <option key={d.dia} value={d.dia}>
              {rotuloDia(d.dia)} · {d.pedidos}
            </option>
          ))}
        </select>
      </label>
    );
  };
  return (
    <>
      {campo("de", "De", "Início", false)}
      {suportado && campo("ate", "Até", "Fim", false)}
      {!periodoVazio(periodo) && (
        <button type="button" style={atualizarBtn} onClick={() => onPeriodo(PERIODO_VAZIO)}>
          Todos os dias
        </button>
      )}
    </>
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

function TiposLinha({ e }: { e: EstampaAgrupada }) {
  const txt = rotuloTipos(e.tipos, e.estampa);
  if (!txt) return null;
  return (
    <div style={tiposCard} title={txt}>
      {txt}
    </div>
  );
}

function CardEstampa({ e, onClick, onChip, semBump, marcada }: { e: EstampaAgrupada; onClick: () => void; onChip?: (t: EstampaAgrupada["tamanhos"][number]) => void; semBump?: boolean; /** Modo "Devolver várias": definido = card é seleção. */ marcada?: boolean }) {
  // Com "Sem order bump" os números mostram só os pedidos sem bump (o selo "N com bump" segue, fora da conta).
  const n = (pedidos: number, comBump: number | null | undefined) => (semBump && marcada === undefined ? pedidosSemBump(pedidos, comBump) : pedidos);
  const totalCard = n(e.pedidos, e.comOrderBump);
  const img = miniaturaLeve(e.imagemUrl);
  const unico = e.tamanhos.length === 1 ? e.tamanhos[0].tamanho : null;
  const nome = e.cor ? `${e.estampa} ${e.cor}` : e.estampa;
  return (
    <button
      type="button"
      style={marcada ? { ...card, outline: "3px solid var(--warning-border, #f59e0b)", background: "var(--warning-bg)" } : card}
      onClick={onClick}
      aria-pressed={marcada}
      title={marcada !== undefined ? `Marcar ${nome} para devolver` : unico ? `Escolher a fila ${nome} ${unico}` : `Abrir ${nome}`}
    >
      {marcada !== undefined && (
        <span style={marcada ? caixaMarcada : caixaVazia} aria-hidden>
          {marcada ? "✓" : ""}
        </span>
      )}
      <div style={fotoBox}>{img ? <img src={img} alt="" style={foto} loading="lazy" /> : <span style={semFoto}>sem foto</span>}</div>
      <div style={cardCorpo}>
        <TiposLinha e={e} />
        <div style={estampaTxt}>{e.estampa}</div>
        {e.cor && <div style={corTxt}>{e.cor}</div>}
        <div style={contagem}>
          {totalCard} pedido{totalCard === 1 ? "" : "s"}
          <Prioritarios n={e.prioritarios} />
          <ComBump n={e.comOrderBump} />
        </div>
        <div style={chips}>
          {e.tamanhos.map((t) =>
            onChip ? (
              // Dentro do card (um <button>): span clicável, sem disparar o clique do card.
              <span
                key={t.tamanho}
                role="button"
                tabIndex={0}
                style={chipBotao}
                title={`Abrir os pedidos do tamanho ${t.tamanho}`}
                onClick={(ev) => {
                  ev.stopPropagation();
                  onChip(t);
                }}
                onKeyDown={(ev) => {
                  if (ev.key === "Enter" || ev.key === " ") {
                    ev.preventDefault();
                    ev.stopPropagation();
                    onChip(t);
                  }
                }}
              >
                <b>{t.tamanho}</b> {n(t.pedidos, t.comOrderBump)}
              </span>
            ) : (
              <span key={t.tamanho} style={chip}>
                <b>{t.tamanho}</b> {n(t.pedidos, t.comOrderBump)}
              </span>
            ),
          )}
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
          <TiposLinha e={e} />
          <div style={estampaGrande}>{e.estampa}</div>
          {e.cor && <div style={corGrande}>{e.cor}</div>}
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
              onClick={() => onEscolher({ estampa: e.estampa, tamanho: g.tamanho, cor: e.cor })}
              title={`Escolher a fila ${e.cor ? `${e.estampa} ${e.cor}` : e.estampa} ${g.tamanho}`}
            >
              <div style={tamanhoGrande}>{g.tamanho}</div>
              <div style={contagem}>
                {g.pedidos} pedido{g.pedidos === 1 ? "" : "s"}
                <Prioritarios n={g.prioritarios ?? 0} />
                <ComBump n={g.comOrderBump ?? 0} />
              </div>
              {tipos.length > 0 && (
                <div style={tiposTxt} title={rotuloTipos(tipos, e.estampa)}>
                  {rotuloTipos(tipos, e.estampa)}
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
const diaInput: CSSProperties = { padding: "9px 10px", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text)", fontSize: 14, fontWeight: 700 };
const diaRotulo: CSSProperties = { display: "flex", alignItems: "center", gap: 6, color: "var(--text-secondary)", fontSize: 13, fontWeight: 700 };
const total: CSSProperties = { color: "var(--text-secondary)", fontSize: 13, fontWeight: 700 };
const atualizarBtn: CSSProperties = { padding: "9px 14px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text)", fontWeight: 700, cursor: "pointer" };
const bumpBtn: CSSProperties = { padding: "9px 14px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text)", fontWeight: 700, cursor: "pointer", maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const bumpBtnLigado: CSSProperties = { ...bumpBtn, background: "var(--info-bg, #dbeafe)", color: "var(--info-text, #1d4ed8)", border: "1px solid var(--info-text, #1d4ed8)" };
const barraDevolver: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 10, border: "1px solid var(--warning-border)", background: "var(--warning-bg)", color: "var(--warning-text)", fontSize: 13 };
const caixaVazia: CSSProperties = { flex: "0 0 auto", alignSelf: "center", width: 26, height: 26, borderRadius: 6, border: "2px solid var(--border-strong, #94a3b8)", background: "var(--bg-card)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 900 };
const caixaMarcada: CSSProperties = { ...caixaVazia, border: "2px solid var(--accent, #2563eb)", background: "var(--accent, #2563eb)", color: "#fff" };
const devolverBtn: CSSProperties = { ...bumpBtn, background: "var(--accent, #2563eb)", color: "#fff", border: "1px solid transparent" };
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
const corTxt: CSSProperties = { fontSize: 15, fontWeight: 700, color: "var(--text-secondary)", overflowWrap: "anywhere" };
const corGrande: CSSProperties = { fontSize: 22, fontWeight: 700, color: "var(--text-secondary)", overflowWrap: "anywhere" };
const contagem: CSSProperties = { fontSize: 13, color: "var(--text-secondary)", fontWeight: 700, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" };
const prioBadge: CSSProperties = { padding: "1px 7px", borderRadius: 999, background: "var(--danger-bg, #fee2e2)", color: "var(--danger-text, #b91c1c)", fontSize: 11 };
const tiposTxt: CSSProperties = { fontSize: 12, color: "var(--text-secondary)", maxWidth: 190, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const tiposCard: CSSProperties = { fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const chips: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 4 };
const chip: CSSProperties = { padding: "1px 7px", borderRadius: 6, background: "var(--bg-input)", border: "1px solid var(--border)", fontSize: 12, color: "var(--text-secondary)" };
const chipBotao: CSSProperties = { ...chip, cursor: "pointer", border: "1px solid var(--border-strong)" };
const painel: CSSProperties = { flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 16 };
const voltarBtn: CSSProperties = { alignSelf: "flex-start", padding: "9px 14px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text)", fontWeight: 700, cursor: "pointer" };
const painelTopo: CSSProperties = { display: "flex", gap: 16, alignItems: "center" };
const fotoGrande: CSSProperties = { ...fotoBox, width: 140, height: 186 };
const estampaGrande: CSSProperties = { fontSize: 32, fontWeight: 900, lineHeight: 1.1, overflowWrap: "anywhere" };
const botoes: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 12 };
const tamanhoBtn: CSSProperties = { minWidth: 150, minHeight: 150, padding: 12, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 6, textAlign: "center", background: "var(--bg-card)", border: "2px solid var(--border-strong)", borderRadius: 14, color: "var(--text)", cursor: "pointer" };
const tamanhoGrande: CSSProperties = { fontSize: 44, fontWeight: 900, lineHeight: 1 };

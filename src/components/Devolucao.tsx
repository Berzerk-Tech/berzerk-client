// Devolução — a operadora passa as peças devolvidas na mesa RFID e o app as
// acumula num LOTE aberto no Nexus (que só pré-classifica). "Fechar lote"
// aplica: desvincula as peças dos pedidos originais (pra poderem ser lidas de
// novo na Separação) e, com a trava do Nexus ligada, reintegra ao estoque da
// Shopify. Contrato em NEXUS_DEVOLUCOES.md.
//
// Diferença pra Expedição: a leitura aqui é ACUMULATIVA, não de presença.
// Todo EPC visto uma vez entra no lote; tirar a peça da mesa não a remove.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ApiError } from "../lib/api";
import { useRfid } from "../contexts/RfidContext";
import { getMe } from "../services/orders";
import { canOperateExpedicao, expedicaoErrorCode } from "../services/expedicao";
import {
  DEV_ERR,
  DESTINO_LABEL,
  abrirLote,
  adicionarEpcs,
  epcsEmOutroLote,
  fecharLote,
  getLote,
  devolucaoErrorMessage,
  normalizarEpc,
  ReintegracaoCanceladaError,
  progressoReintegracao,
  reintegrarAteZerar,
  reintegracaoPendente,
  removerEpc,
  type DevolucaoDestino,
  type Lote,
  type LoteItem,
  type LoteResumo,
  type PorVariante,
  type Reintegracao,
} from "../services/devolucoes";
import { AmbientBackground } from "./AmbientBackground";
import { BackButton } from "./BackButton";
import { ConfirmDialog } from "./ConfirmDialog";
import { DevolucaoLotesModal } from "./DevolucaoLotesModal";
import { OperatorChip } from "./OperatorChip";
import {
  ItemLinha,
  ReintegracaoBloco,
  TabelaPorVariante,
  podeReintegrar,
  epcCurto,
  hora,
} from "./DevolucaoShared";

type Props = { onBack: () => void };

/** Junta leituras que chegam em rajada num único POST (igual `RESOLVE_DEBOUNCE_MS` da Expedição). */
export const ENVIO_DEBOUNCE_MS = 250;
/** Retry em falha de rede. */
export const RETRY_MS = 4000;
/** Recarrega o "Por produto" depois de adições (evita um GET por bipada). */
export const RECARGA_DEBOUNCE_MS = 800;

const RESUMO_ZERO: LoteResumo = { total: 0, devolviveis: 0, naoEncontrados: 0, naoExpedidos: 0, jaDevolvidas: 0 };

type Fase = "carregando" | "sem_permissao" | "erro" | "lendo" | "fechando" | "resultado";

type Resultado = { lote: Lote; resumo: LoteResumo; reintegracao: Reintegracao | null };

/** Mescla itens por EPC (o mais novo vence) mantendo ordem de leitura. */
function mesclar(prev: LoteItem[], novos: LoteItem[]): LoteItem[] {
  const porEpc = new Map(prev.map((i) => [i.epc, i]));
  for (const n of novos) porEpc.set(n.epc, n);
  return [...porEpc.values()];
}

export function Devolucao({ onBack }: Props) {
  const rfid = useRfid();
  const [fase, setFase] = useState<Fase>("carregando");
  const [erroFatal, setErroFatal] = useState<string | null>(null);
  const [lote, setLote] = useState<Lote | null>(null);
  const [itens, setItens] = useState<LoteItem[]>([]);
  const [resumo, setResumo] = useState<LoteResumo>(RESUMO_ZERO);
  const [porVariante, setPorVariante] = useState<PorVariante[]>([]);
  const [retomada, setRetomada] = useState<{ em: string; qtd: number } | null>(null);
  const [pausado, setPausado] = useState(false);
  const [bloqueados, setBloqueados] = useState(0);
  const [ignorados, setIgnorados] = useState(0);
  const [aviso, setAviso] = useState<string | null>(null);
  const [rede, setRede] = useState<string | null>(null);
  const [historicoAberto, setHistoricoAberto] = useState(false);
  const [removendo, setRemovendo] = useState<LoteItem | null>(null);
  const [fechandoDialogo, setFechandoDialogo] = useState(false);
  const [destino, setDestino] = useState<DevolucaoDestino>("estoque");
  const [motivo, setMotivo] = useState("");
  const [resultado, setResultado] = useState<Resultado | null>(null);
  const [reintegrando, setReintegrando] = useState(false);
  const [msgReint, setMsgReint] = useState<string | null>(null);
  const [progresso, setProgresso] = useState<{ feitas: number; total: number } | null>(null);

  // --- estado do loop de leitura (fora do render) ---
  const loteIdRef = useRef<string | null>(null);
  /** EPCs já enfileirados/enviados/aceitos: nunca reenviar. */
  const vistosRef = useRef<Set<string>>(new Set());
  /** EPCs recusados por `epc_em_outro_lote`: não reenviar. */
  const bloqueadosRef = useRef<Set<string>>(new Set());
  const filaRef = useRef<string[]>([]);
  const envioTimer = useRef<number | null>(null);
  const retryTimer = useRef<number | null>(null);
  const recargaTimer = useRef<number | null>(null);
  const cadeiaRef = useRef<Promise<unknown>>(Promise.resolve());
  const abrirRef = useRef<Promise<{ lote: Lote; retomado: boolean }> | null>(null);
  const vivoRef = useRef(true);
  /** Lote cujo resultado/loop de reintegração está na tela; o loop de outro lote é ignorado. */
  const loteResultadoRef = useRef<string | null>(null);
  const ignoradosRef = useRef<Set<string>>(new Set());
  const tratarFechadoRef = useRef<(id: string) => Promise<"fechado" | "aberto" | "desconhecido">>(async () => "desconhecido");

  const limparTimers = () => {
    for (const t of [envioTimer, retryTimer, recargaTimer]) {
      if (t.current != null) clearTimeout(t.current);
      t.current = null;
    }
  };

  const recarregar = useCallback(async () => {
    const id = loteIdRef.current;
    if (!id) return;
    try {
      const d = await getLote(id);
      if (!vivoRef.current || loteIdRef.current !== id) return;
      setItens(d.itens);
      setResumo(d.resumo);
      setPorVariante(d.porVariante);
      for (const i of d.itens) vistosRef.current.add(i.epc);
    } catch {
      /* só atualiza a tabela "Por produto"; a próxima adição tenta de novo */
    }
  }, []);

  const agendarRecarga = useCallback(() => {
    if (recargaTimer.current != null) clearTimeout(recargaTimer.current);
    recargaTimer.current = window.setTimeout(() => void recarregar(), RECARGA_DEBOUNCE_MS);
  }, [recarregar]);

  /** Envia o que está na fila. Serializado; devolve true se a fila esvaziou. */
  const doFlush = useCallback(async (): Promise<boolean> => {
    const id = loteIdRef.current;
    if (!id) return false;
    // Laço: uma recusa por `epc_em_outro_lote` reenvia o restante na hora.
    while (filaRef.current.length > 0) {
      const envio = filaRef.current.splice(0, filaRef.current.length);
      try {
        const r = await adicionarEpcs(id, envio);
        if (!vivoRef.current || loteIdRef.current !== id) return true;
        setRede(null);
        setItens((prev) => mesclar(prev, r.adicionados));
        setResumo(r.resumo);
        // `repetidos`/`invalidos` ficam em `vistos`: não adianta reenviar.
        if (r.adicionados.length > 0 || r.repetidos.length > 0) agendarRecarga();
      } catch (e) {
        if (!vivoRef.current || loteIdRef.current !== id) return true;
        const code = expedicaoErrorCode(e);
        const status = e instanceof ApiError ? e.status : null;
        if (code === DEV_ERR.EPC_EM_OUTRO_LOTE) {
          const recusados = new Set(
            epcsEmOutroLote(e)
              .map(normalizarEpc)
              .filter((x): x is string => x != null),
          );
          const resto = envio.filter((x) => !recusados.has(x));
          if (resto.length === envio.length) {
            // Nada casou com a lista do servidor: bloqueia a leva inteira
            // (nunca reenviar na hora — seria um laço apertado).
            for (const x of envio) bloqueadosRef.current.add(x);
          } else {
            for (const x of recusados) bloqueadosRef.current.add(x);
            filaRef.current.unshift(...resto);
          }
          setBloqueados(bloqueadosRef.current.size);
          continue;
        }
        if (code === DEV_ERR.LOTE_FECHADO) {
          // O fechar pode ter commitado em outra estação/chamada: vai pro resultado.
          const r = await tratarFechadoRef.current(id);
          if (r !== "fechado") {
            setErroFatal(devolucaoErrorMessage(code, "Este lote já foi fechado."));
            setFase("erro");
          }
          return false;
        }
        if (code === DEV_ERR.LOTE_NAO_ENCONTRADO || status === 403) {
          filaRef.current.unshift(...envio); // não perde os EPCs em voo
          setErroFatal(devolucaoErrorMessage(code, e instanceof Error ? e.message : String(e)));
          setFase("erro");
          return false;
        }
        // Rede, 5xx e 401 (transitório: sessão expirada de verdade o api.ts trata):
        // devolve à fila e tenta de novo em 4 s.
        if (status == null || status >= 500 || status === 401) {
          filaRef.current.unshift(...envio);
          setRede("Sem conexão com o Nexus — tentando de novo…");
          if (retryTimer.current == null) {
            retryTimer.current = window.setTimeout(() => {
              retryTimer.current = null;
              void flush();
            }, RETRY_MS);
          }
          return false;
        }
        // Demais 4xx: não adianta repetir. Descarta a leva e avisa.
        setAviso(
          `${envio.length} ${envio.length === 1 ? "leitura descartada" : "leituras descartadas"}: ${devolucaoErrorMessage(code, e instanceof Error ? e.message : String(e))}`,
        );
        continue;
      }
    }
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agendarRecarga]);

  const flush = useCallback((): Promise<boolean> => {
    const p = cadeiaRef.current.then(doFlush, doFlush) as Promise<boolean>;
    cadeiaRef.current = p;
    return p;
  }, [doFlush]);

  /** Chamado a cada poll da mesa: o que for novo entra na fila (acumulativo). */
  const onPresenca = useCallback(
    (atuais: string[]) => {
      if (!loteIdRef.current) return;
      let novos = false;
      for (const bruto of atuais) {
        const epc = normalizarEpc(bruto);
        if (!epc) {
          // EPC inválido (≠ 24 hex): nunca vai pro lote; só conta como ignorado.
          const k = String(bruto);
          if (k && !ignoradosRef.current.has(k)) {
            ignoradosRef.current.add(k);
            setIgnorados(ignoradosRef.current.size);
          }
          continue;
        }
        if (vistosRef.current.has(epc) || bloqueadosRef.current.has(epc)) continue;
        vistosRef.current.add(epc);
        filaRef.current.push(epc);
        novos = true;
      }
      if (novos) {
        if (envioTimer.current != null) clearTimeout(envioTimer.current);
        envioTimer.current = window.setTimeout(() => {
          envioTimer.current = null;
          void flush();
        }, ENVIO_DEBOUNCE_MS);
      }
    },
    [flush],
  );
  const onPresencaRef = useRef(onPresenca);
  onPresencaRef.current = onPresenca;

  // --- abrir/retomar lote ---
  const abrir = useCallback(async (opts: { novo?: boolean } = {}) => {
    setFase("carregando");
    setErroFatal(null);
    setResultado(null);
    setMsgReint(null);
    setAviso(null);
    setRede(null);
    setRetomada(null);
    setPausado(false);
    setItens([]);
    setResumo(RESUMO_ZERO);
    setPorVariante([]);
    setBloqueados(0);
    setIgnorados(0);
    setProgresso(null);
    setReintegrando(false);
    setDestino("estoque");
    setMotivo("");
    loteResultadoRef.current = null;
    ignoradosRef.current = new Set();
    vistosRef.current = new Set();
    bloqueadosRef.current = new Set();
    filaRef.current = [];
    limparTimers();
    loteIdRef.current = null;
    try {
      // Dedupe do StrictMode (efeito roda 2x em dev): reaproveita a promessa.
      if (opts.novo || !abrirRef.current) abrirRef.current = abrirLote();
      const { lote: l, retomado } = await abrirRef.current;
      if (!vivoRef.current) return;
      loteIdRef.current = l.id;
      setLote(l);
      if (retomado) {
        const d = await getLote(l.id);
        if (!vivoRef.current) return;
        setItens(d.itens);
        setResumo(d.resumo);
        setPorVariante(d.porVariante);
        for (const i of d.itens) vistosRef.current.add(i.epc);
        setRetomada({ em: l.abertoEm, qtd: d.lote.qtdItens ?? d.itens.length });
      }
      setFase("lendo");
    } catch (e) {
      if (!vivoRef.current) return;
      abrirRef.current = null;
      setErroFatal(devolucaoErrorMessage(expedicaoErrorCode(e), e instanceof Error ? e.message : String(e)));
      setFase("erro");
    }
  }, []);

  useEffect(() => {
    vivoRef.current = true;
    let alive = true;
    (async () => {
      try {
        const me = await getMe();
        if (!canOperateExpedicao(me)) {
          if (alive) setFase("sem_permissao");
          return;
        }
      } catch {
        /* API fora: tenta abrir assim mesmo (a rota responde 403 se for o caso) */
      }
      if (alive) await abrir();
    })();
    return () => {
      alive = false;
      vivoRef.current = false;
      limparTimers();
    };
  }, [abrir]);

  // Leitura contínua só enquanto está em modo leitura e não pausado.
  const startPresenceSession = rfid.startPresenceSession;
  const lendo = fase === "lendo" && !pausado;
  useEffect(() => {
    if (!lendo) return;
    const stop = startPresenceSession((cur) => onPresencaRef.current(cur));
    return stop;
  }, [lendo, startPresenceSession]);

  // --- remover ---
  const confirmarRemocao = async () => {
    const item = removendo;
    const id = loteIdRef.current;
    setRemovendo(null);
    if (!item || !id) return;
    try {
      const r = await removerEpc(id, item.epc);
      // Fica em `vistos`: se a peça ainda estiver na mesa, não volta sozinha.
      setItens((prev) => prev.filter((i) => i.epc !== item.epc));
      setResumo(r.resumo);
      agendarRecarga();
    } catch (e) {
      const code = expedicaoErrorCode(e);
      if (code === DEV_ERR.EPC_NAO_ENCONTRADO_NO_LOTE) {
        setItens((prev) => prev.filter((i) => i.epc !== item.epc));
        agendarRecarga();
      } else {
        setAviso(`Não foi possível remover a peça: ${devolucaoErrorMessage(code, e instanceof Error ? e.message : String(e))}`);
      }
    }
  };

  // --- fechar ---
  const confirmarFechamento = async () => {
    const id = loteIdRef.current;
    setFechandoDialogo(false);
    if (!id) return;
    setFase("fechando");
    if (envioTimer.current != null) clearTimeout(envioTimer.current);
    envioTimer.current = null;
    if (retryTimer.current != null) clearTimeout(retryTimer.current);
    retryTimer.current = null;
    if (recargaTimer.current != null) clearTimeout(recargaTimer.current);
    recargaTimer.current = null;
    // Manda o que ainda está na fila antes de aplicar.
    const ok = await flush();
    if (!vivoRef.current) return;
    if (!ok || filaRef.current.length > 0) {
      setAviso("Não foi possível enviar as últimas leituras ao Nexus. Confira a conexão e tente fechar de novo.");
      setFase((f) => (f === "fechando" ? "lendo" : f));
      return;
    }
    try {
      const r = await fecharLote(id, {
        destino,
        motivo: motivo.trim() || undefined,
      });
      if (!vivoRef.current) return;
      setResultado(r);
      setLote(r.lote);
      setFase("resultado");
      if (reintegracaoPendente(r.reintegracao)) void rodarReintegracao(r.lote.id);
    } catch (e) {
      if (!vivoRef.current) return;
      const code = expedicaoErrorCode(e);
      const status = e instanceof ApiError ? e.status : null;
      // O fechar pode ter commitado e a resposta se perdido (rede/5xx), ou o lote
      // já estar fechado (409): confere no Nexus. Lote fechado nunca volta a "lendo".
      if (code === DEV_ERR.LOTE_FECHADO || status == null || status >= 500) {
        const estado = await tratarFechadoRef.current(id);
        if (!vivoRef.current || estado === "fechado") return;
        setAviso(
          estado === "desconhecido"
            ? "Não foi possível confirmar se o lote foi fechado. Confira em \"Lotes anteriores\" antes de tentar de novo."
            : `Não foi possível fechar o lote: ${devolucaoErrorMessage(code, e instanceof Error ? e.message : String(e))}`,
        );
        setFase("lendo");
        return;
      }
      setAviso(`Não foi possível fechar o lote: ${devolucaoErrorMessage(code, e instanceof Error ? e.message : String(e))}`);
      setFase("lendo");
    }
  };

  /**
   * Confere o estado real do lote. Se já estiver FECHADO, vai pra tela de
   * resultado (e retoma a reintegração, se houver pendente).
   */
  const tratarLoteFechado = async (id: string): Promise<"fechado" | "aberto" | "desconhecido"> => {
    try {
      const d = await getLote(id);
      if (!vivoRef.current || loteIdRef.current !== id) return "desconhecido";
      if (d.lote.status !== "fechado") return "aberto";
      limparTimers();
      filaRef.current = [];
      setResultado({ lote: d.lote, resumo: d.resumo, reintegracao: d.lote.reintegracao });
      setLote(d.lote);
      setFase("resultado");
      if (reintegracaoPendente(d.lote.reintegracao)) void rodarReintegracao(d.lote.id);
      return "fechado";
    } catch {
      return "desconhecido";
    }
  };
  tratarFechadoRef.current = tratarLoteFechado;

  /** Loop de passadas (o Nexus reintegra com orçamento de ~12 s por chamada). */
  const rodarReintegracao = async (loteId: string) => {
    loteResultadoRef.current = loteId;
    // Só vale enquanto este lote for o do resultado e a tela estiver viva.
    const meu = () => vivoRef.current && loteResultadoRef.current === loteId;
    setReintegrando(true);
    setMsgReint(null);
    try {
      const r = await reintegrarAteZerar(
        loteId,
        (p) => {
          if (!meu()) return;
          setResultado((atual) => (atual && atual.lote.id === loteId ? { ...atual, lote: p.lote, reintegracao: p.reintegracao } : atual));
          setProgresso(reintegracaoPendente(p.reintegracao) ? progressoReintegracao(p.reintegracao!) : null);
        },
        undefined,
        () => !meu(),
      );
      if (!meu()) return;
      setResultado((atual) => (atual && atual.lote.id === loteId ? { ...atual, lote: r.lote, reintegracao: r.reintegracao } : atual));
    } catch (e) {
      if (meu() && !(e instanceof ReintegracaoCanceladaError)) {
        setMsgReint(devolucaoErrorMessage(expedicaoErrorCode(e), e instanceof Error ? e.message : String(e)));
      }
    } finally {
      if (meu()) {
        setProgresso(null);
        setReintegrando(false);
      }
    }
  };

  const reintegrar = async () => {
    if (resultado) await rodarReintegracao(resultado.lote.id);
  };

  const atualizarResultado = async () => {
    if (!resultado) return;
    try {
      const d = await getLote(resultado.lote.id);
      setResultado({ ...resultado, lote: d.lote, reintegracao: d.lote.reintegracao, resumo: d.resumo });
    } catch {
      /* mantém o que já está na tela */
    }
  };

  const ordenados = useMemo(
    () => itens.map((it, i) => ({ it, i })).sort((a, b) => b.it.lidoEm.localeCompare(a.it.lidoEm) || b.i - a.i).map((x) => x.it),
    [itens],
  );

  const mesaOk = rfid.connected;

  return (
    <div style={page}>
      <AmbientBackground variant="flat" />

      <header style={subHeader}>
        <div style={hLeft}>
          <BackButton onClick={onBack} />
          <OperatorChip />
        </div>
        <h2 style={title}>Devolução</h2>
        <div style={hRight}>
          <span style={mesaOk ? chipOk : chipOff} title={rfid.host}>
            {mesaOk ? "Mesa conectada" : "Mesa desconectada"}
          </span>
        </div>
      </header>

      {fase === "carregando" && <div style={centro}>Abrindo lote…</div>}

      {fase === "sem_permissao" && (
        <div style={centro}>Seu usuário não tem permissão para operar a Devolução (expedicao:operate).</div>
      )}

      {fase === "erro" && (
        <div style={centro}>
          <div style={{ marginBottom: 12 }}>{erroFatal ?? "Erro inesperado."}</div>
          <button style={btn} onClick={() => void abrir({ novo: true })}>
            Tentar de novo
          </button>
        </div>
      )}

      {(fase === "lendo" || fase === "fechando") && lote && (
        <>
          {retomada && (
            <div style={noticeBanner}>
              Retomando lote aberto às {hora(retomada.em)} com {retomada.qtd} {retomada.qtd === 1 ? "peça" : "peças"}.
            </div>
          )}
          {!mesaOk && (
            <div style={warnBanner}>
              Mesa RFID desconectada ({rfid.host}). A leitura volta sozinha ao reconectar.{" "}
              <button style={inlineBtn} onClick={() => void rfid.reconnect()}>
                tentar agora
              </button>
            </div>
          )}
          {rede && <div style={warnBanner}>{rede}</div>}
          {bloqueados > 0 && (
            <div style={warnBanner}>
              {bloqueados} {bloqueados === 1 ? "peça já está" : "peças já estão"} em outro lote aberto.
            </div>
          )}
          {ignorados > 0 && (
            <div style={noticeBanner}>
              {ignorados} {ignorados === 1 ? "leitura ignorada" : "leituras ignoradas"} (EPC inválido).
            </div>
          )}
          {aviso && (
            <div style={warnBanner}>
              {aviso}{" "}
              <button style={inlineBtn} onClick={() => setAviso(null)}>
                ok
              </button>
            </div>
          )}

          <div style={contadoresRow}>
            <Contador label="Total lidas" valor={resumo.total} />
            <Contador label="Vão ser devolvidas" valor={resumo.devolviveis} tom="ok" />
            <Contador label="Não encontradas" valor={resumo.naoEncontrados} tom="danger" />
            <Contador label="Em pedido não expedido" valor={resumo.naoExpedidos} tom="warn" />
            <Contador label="Já devolvidas" valor={resumo.jaDevolvidas} tom="info" />
            <div style={acoes}>
              <button style={btn} onClick={() => setPausado((p) => !p)} disabled={fase === "fechando"}>
                {pausado ? "Retomar leitura" : "Pausar leitura"}
              </button>
              <button style={btn} onClick={() => setHistoricoAberto(true)}>
                Lotes anteriores
              </button>
              <button
                style={resumo.total === 0 || fase === "fechando" ? btnPrimarioOff : btnPrimario}
                disabled={resumo.total === 0 || fase === "fechando"}
                onClick={() => setFechandoDialogo(true)}
              >
                {fase === "fechando" ? "Fechando…" : "Fechar lote"}
              </button>
            </div>
          </div>

          {pausado && <div style={noticeBanner}>Leitura pausada — as peças na mesa não estão sendo adicionadas.</div>}

          <div style={corpo}>
            <section style={colLista}>
              {ordenados.length === 0 ? (
                <div style={vazio}>Passe as peças devolvidas na mesa. Elas aparecem aqui conforme são lidas.</div>
              ) : (
                <ul style={ul}>
                  {ordenados.map((it) => (
                    <ItemLinha
                      key={it.epc}
                      item={it}
                      acao={
                        <button
                          style={btnRemover}
                          onClick={() => setRemovendo(it)}
                          disabled={fase === "fechando"}
                          aria-label={`Remover ${it.epc}`}
                        >
                          Remover
                        </button>
                      }
                    />
                  ))}
                </ul>
              )}
              <p style={nota}>Peça em pedido não expedido não é devolvida: ela está em separação/aguardando coleta.</p>
            </section>

            <aside style={colProduto}>
              <h3 style={subTitulo}>Por produto</h3>
              <TabelaPorVariante linhas={porVariante} />
            </aside>
          </div>
        </>
      )}

      {fase === "resultado" && resultado && (
        <div style={resultadoWrap}>
          <h3 style={resultadoTitulo}>Lote fechado</h3>
          <div style={contadoresRow}>
            <Contador label="Total lidas" valor={resultado.resumo.total} />
            <Contador label="Devolvidas" valor={resultado.lote.qtdDevolvidas ?? resultado.resumo.devolviveis} tom="ok" />
            <Contador label="Não encontradas" valor={resultado.resumo.naoEncontrados} tom="danger" />
            <Contador label="Em pedido não expedido" valor={resultado.resumo.naoExpedidos} tom="warn" />
            <Contador label="Já devolvidas" valor={resultado.resumo.jaDevolvidas} tom="info" />
          </div>
          <ReintegracaoBloco
            lote={resultado.lote}
            reintegracao={resultado.reintegracao}
            onReintegrar={() => void reintegrar()}
            onAtualizar={() => void atualizarResultado()}
            ocupado={reintegrando}
            progresso={progresso}
            mensagem={msgReint}
          />
          {msgReint && !podeReintegrar(resultado.lote) && (
            <div style={warnBanner}>{msgReint}</div>
          )}
          <div style={acoes}>
            <button style={btnPrimario} onClick={() => void abrir({ novo: true })}>
              Novo lote
            </button>
            <button style={btn} onClick={onBack}>
              Voltar ao menu
            </button>
          </div>
        </div>
      )}

      {removendo && (
        <ConfirmDialog
          titulo="Remover peça do lote?"
          mensagem={`A peça ${epcCurto(removendo.epc)}${removendo.orderNumber ? ` (pedido #${removendo.orderNumber})` : ""} sai do lote e não será devolvida.`}
          confirmarLabel="Remover"
          tom="warning"
          onConfirm={() => void confirmarRemocao()}
          onCancel={() => setRemovendo(null)}
        />
      )}

      {fechandoDialogo && (
        <ConfirmDialog
          titulo="Fechar lote?"
          confirmarLabel="Fechar lote"
          mensagem={
            <span style={{ display: "flex", flexDirection: "column", gap: 10, textAlign: "left" }}>
              <span>
                {resumo.devolviveis} {resumo.devolviveis === 1 ? "peça será devolvida" : "peças serão devolvidas"} e
                desvinculadas dos pedidos originais.
              </span>
              <label style={campoLabel}>
                Destino
                <select
                  style={campo}
                  value={destino}
                  onChange={(e) => setDestino(e.target.value as DevolucaoDestino)}
                  aria-label="Destino"
                >
                  {(Object.keys(DESTINO_LABEL) as DevolucaoDestino[]).map((d) => (
                    <option key={d} value={d}>
                      {DESTINO_LABEL[d]}
                    </option>
                  ))}
                </select>
              </label>
              <label style={campoLabel}>
                Motivo (opcional)
                <input
                  style={campo}
                  value={motivo}
                  onChange={(e) => setMotivo(e.target.value)}
                  placeholder="Ex.: devolução de cliente"
                  aria-label="Motivo"
                  maxLength={200}
                />
              </label>
            </span>
          }
          onConfirm={() => void confirmarFechamento()}
          onCancel={() => setFechandoDialogo(false)}
        />
      )}

      {historicoAberto && (
        <DevolucaoLotesModal loteAtualId={lote?.status === "aberto" ? lote.id : null} onClose={() => setHistoricoAberto(false)} />
      )}
    </div>
  );
}

function Contador({ label, valor, tom }: { label: string; valor: number; tom?: "ok" | "danger" | "warn" | "info" }) {
  const cor = tom ? `var(--${tom === "ok" ? "success" : tom}-text)` : "var(--text)";
  return (
    <div style={contador}>
      <span style={{ ...contadorValor, color: cor }}>{valor}</span>
      <span style={contadorLabel}>{label}</span>
    </div>
  );
}

const page: CSSProperties = { height: "100vh", background: "var(--bg)", color: "var(--text)", display: "flex", flexDirection: "column", position: "relative", overflow: "hidden" };
const subHeader: CSSProperties = { position: "relative", display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", gap: 18, padding: "14px 28px", borderBottom: "1px solid var(--border)", background: "var(--bg)" };
const hLeft: CSSProperties = { gridColumn: "1", justifySelf: "start", display: "flex", alignItems: "center", gap: 12 };
const hRight: CSSProperties = { gridColumn: "3", justifySelf: "end", display: "flex", alignItems: "center", gap: 10 };
const title: CSSProperties = { margin: 0, fontSize: 17, fontWeight: 600, color: "var(--text)", gridColumn: "2" };

const chipBase: CSSProperties = { padding: "4px 10px", borderRadius: 999, border: "1px solid", fontSize: 12, fontWeight: 700 };
const chipOk: CSSProperties = { ...chipBase, background: "var(--success-bg)", color: "var(--success-text)", borderColor: "var(--success-border)" };
const chipOff: CSSProperties = { ...chipBase, background: "var(--danger-bg)", color: "var(--danger-text)", borderColor: "var(--danger-border)" };

const warnBanner: CSSProperties = { position: "relative", padding: "7px 28px", background: "var(--danger-bg, var(--warning-bg))", color: "var(--danger-text, var(--warning-text))", fontSize: 13, textAlign: "center" };
const noticeBanner: CSSProperties = { position: "relative", padding: "7px 28px", background: "var(--info-bg)", color: "var(--info-text)", fontSize: 13, textAlign: "center" };
const inlineBtn: CSSProperties = { background: "transparent", border: 0, color: "inherit", textDecoration: "underline", cursor: "pointer", fontSize: 13, fontWeight: 700 };

const centro: CSSProperties = { position: "relative", flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", color: "var(--text-secondary)", fontSize: 15, padding: 28, textAlign: "center" };

const contadoresRow: CSSProperties = { position: "relative", display: "flex", alignItems: "stretch", gap: 12, padding: "14px 28px", flexWrap: "wrap" };
const contador: CSSProperties = { display: "flex", flexDirection: "column", gap: 2, padding: "8px 14px", border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg-card)", minWidth: 110 };
const contadorValor: CSSProperties = { fontSize: 24, fontWeight: 800, fontVariantNumeric: "tabular-nums" };
const contadorLabel: CSSProperties = { fontSize: 11, fontWeight: 700, color: "var(--text-muted)" };
const acoes: CSSProperties = { marginLeft: "auto", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" };

const btn: CSSProperties = { padding: "9px 16px", borderRadius: 10, border: "1px solid var(--border-strong)", background: "var(--bg-input)", color: "var(--text)", fontSize: 13, fontWeight: 700, cursor: "pointer" };
const btnPrimario: CSSProperties = { ...btn, background: "var(--accent)", color: "var(--accent-text)", borderColor: "var(--accent)" };
const btnPrimarioOff: CSSProperties = { ...btnPrimario, opacity: 0.4, cursor: "not-allowed" };
const btnRemover: CSSProperties = { padding: "4px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "var(--text-muted)", fontSize: 12, fontWeight: 700, cursor: "pointer" };

const corpo: CSSProperties = { position: "relative", flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr) 320px", gap: 20, padding: "0 28px 20px" };
const colLista: CSSProperties = { minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 };
const colProduto: CSSProperties = { minHeight: 0, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg-card)", padding: 14 };
const ul: CSSProperties = { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 };
const vazio: CSSProperties = { color: "var(--text-muted)", fontSize: 14, padding: 32, textAlign: "center", border: "1px dashed var(--border)", borderRadius: 12 };
const nota: CSSProperties = { margin: "4px 0 0", fontSize: 12, color: "var(--text-muted)" };
const subTitulo: CSSProperties = { margin: "0 0 8px", fontSize: 12, fontWeight: 800, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5 };

const resultadoWrap: CSSProperties = { position: "relative", flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 14, padding: "20px 28px", maxWidth: 900, width: "100%", margin: "0 auto", boxSizing: "border-box" };
const resultadoTitulo: CSSProperties = { margin: 0, fontSize: 20, fontWeight: 800 };

const campoLabel: CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontSize: 12, fontWeight: 700, color: "var(--text-muted)" };
const campo: CSSProperties = { padding: "8px 10px", background: "var(--bg-input)", border: "1px solid var(--border)", borderRadius: 8, color: "var(--text)", fontSize: 14, outline: "none" };

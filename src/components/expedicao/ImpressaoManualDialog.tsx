// Impressão manual do tamanho inteiro (Únicos, Nexus 12/11): o chip de tamanho do
// card abre este diálogo. Reserva os pedidos do grupo, imprime a CAPA e depois
// cada etiqueta J&T na ordem da fila, concluindo (separado + expedido) um a um.
// A máquina de estados é pura (`lib/impressaoManualLote.ts`); aqui só a tela e a
// orquestração. Enquanto imprime, a janela só fecha pelos botões (sem Esc/clique fora).

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ApiError } from "../../lib/api";
import { gerarCapaBumpPdf, gerarCapaTamanhoPdf, gerarEtiquetaSimuladaPdf } from "../../lib/capaTamanhoPdf";
import { baixarArquivoPdf, montarPdfPilha, type FolhaResolvida } from "../../lib/montarPdfPilha";
import { capasDeBumpPorPedido, nomeArquivoPilha, sequenciaDaPilha } from "../../lib/pilhaManual";
import {
  aplicarPausa,
  comBump,
  continuar,
  encerrar,
  limparLoteEmCurso,
  novoLote,
  paraLiberar,
  pedirPausa,
  proximoPedido,
  registrarConcluido,
  registrarErroConclusao,
  registrarPulo,
  resumo,
  salvarLoteEmCurso,
  terminou,
  type LoteManual,
} from "../../lib/impressaoManualLote";
import { etiquetaEcommerceDoPedido, imprimirDocumentoDoPedido } from "../../lib/reimpressao";
import { printEtiquetaUnica } from "../../lib/printer";
import { rotuloDia, type GrupoEscolhido, type PeriodoUnicos } from "../../lib/unicosExpedicao";
import {
  concluirImpressaoManual,
  getDocumentos,
  getUnicosPedidos,
  IMPRESSAO_MANUAL_ERR,
  liberarImpressaoManual,
  reservarImpressaoManual,
  type ImpressaoManualPedido,
  type ImpressaoManualReserva,
  type UnicoPedido,
} from "../../services/expedicao";
import { isExpedicaoSimulacao } from "../../services/expedicaoMode";
import { getMe } from "../../services/orders";
import { getLabelPrinter } from "../../services/printerConfig";

const NOME_PADRAO = "Impressora de etiquetas";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function codigoDoErro(e: unknown): string | null {
  if (e instanceof ApiError) {
    const b = e.body as { error?: unknown; code?: unknown } | undefined;
    if (b && typeof b.error === "string") return b.error;
    if (b && typeof b.code === "string") return b.code;
  }
  return null;
}

function mensagemDoErro(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type Fase = "lista" | "reservando" | "baixando" | "confirmarPdf" | "imprimindo" | "resumo";

export function ImpressaoManualDialog({
  grupo,
  periodo,
  totalNaFila,
  onFechar,
  onAtualizar,
}: {
  grupo: GrupoEscolhido;
  periodo?: PeriodoUnicos | null;
  totalNaFila: number;
  onFechar: () => void;
  /** Lote mexeu na fila: o pai recarrega a grade. */
  onAtualizar: () => void;
}) {
  const [fase, setFase] = useState<Fase>("lista");
  const [pedidos, setPedidos] = useState<UnicoPedido[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [lote, setLote] = useState<LoteManual | null>(null);
  const [reserva, setReserva] = useState<ImpressaoManualReserva | null>(null);
  const [saindo, setSaindo] = useState<ImpressaoManualPedido | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [liberarFalhou, setLiberarFalhou] = useState(false);
  const [operador, setOperador] = useState<string | null>(null);

  const loteRef = useRef<LoteManual | null>(null);
  const rodandoRef = useRef(false);
  const capasBumpRef = useRef<Set<string>>(new Set());
  const modoPdfRef = useRef(false);
  const [progressoPdf, setProgressoPdf] = useState<{ i: number; n: number } | null>(null);
  const [arquivoPdf, setArquivoPdf] = useState<{ nome: string; bytes: Uint8Array; caminho: string | null } | null>(null);
  const fecharRef = useRef(false);
  const periodoDe = periodo?.de ?? null;
  const periodoAte = periodo?.ate ?? null;
  const impressora = getLabelPrinter() || NOME_PADRAO;
  const nomeGrupo = `${grupo.estampa}${grupo.cor ? ` ${grupo.cor}` : ""}`;

  useEffect(() => {
    let vivo = true;
    getMe()
      .then((m) => vivo && setOperador(m.email))
      .catch(() => {});
    getUnicosPedidos(grupo.estampa, grupo.tamanho, grupo.cor, { de: periodoDe, ate: periodoAte })
      .then((p) => vivo && setPedidos(p))
      .catch(() => vivo && setErro("Não consegui carregar os pedidos da fila."));
    return () => {
      vivo = false;
    };
  }, [grupo.estampa, grupo.tamanho, grupo.cor, periodoDe, periodoAte]);

  const atualizar = (l: LoteManual) => {
    loteRef.current = l;
    setLote(l);
    salvarLoteEmCurso(l);
  };

  const finalizar = useCallback(async () => {
    const l = loteRef.current;
    if (!l) return;
    const ids = paraLiberar(l);
    try {
      await liberarImpressaoManual(ids);
      limparLoteEmCurso();
      setLiberarFalhou(false);
    } catch {
      // Mantém o localStorage: a próxima abertura da aba Únicos tenta liberar de novo.
      setLiberarFalhou(true);
    }
    setSaindo(null);
    setFase("resumo");
    onAtualizar();
  }, [onAtualizar]);

  const rodar = useCallback(async () => {
    if (rodandoRef.current) return;
    rodandoRef.current = true;
    try {
      const sim = isExpedicaoSimulacao();
      for (;;) {
        let l = loteRef.current;
        if (!l) break;
        if (fecharRef.current) {
          atualizar(encerrar(l));
          break;
        }
        l = aplicarPausa(l);
        if (l.pausado) {
          atualizar(l);
          return;
        }
        const p = proximoPedido(l);
        if (!p) {
          if (terminou(l)) atualizar(encerrar(l));
          else atualizar(l);
          break;
        }
        setSaindo(p);
        // Capa do bloco de order bump antes da 1ª etiqueta do bloco: sem ela, no papel não dá pra saber onde
        // começam. Falhar aqui não segura o lote; `capasBumpRef` evita reimprimir ao continuar depois de pausa.
        const capaBump = modoPdfRef.current ? undefined : capasDeBumpPorPedido(l.pedidos).get(p.orderId);
        if (capaBump && !capasBumpRef.current.has(p.orderId)) {
          capasBumpRef.current.add(p.orderId);
          if (!sim) {
            try {
              const folha = gerarCapaBumpPdf({ produtoNome: capaBump.produtoNome, tamanho: capaBump.tamanho, pedidos: capaBump.pedidos, estampa: grupo.estampa, tamanhoGrupo: grupo.tamanho });
              await printEtiquetaUnica(folha, "pdf", { jobName: `ORDER BUMP ${capaBump.tamanho ?? ""} ${grupo.tamanho}`, printer: getLabelPrinter() });
            } catch {
              /* segue sem a capa do bloco */
            }
          } else {
            await sleep(300);
          }
        }
        let imprimiu = false;
        try {
          if (modoPdfRef.current) {
            imprimiu = true; // a etiqueta já está no PDF; aqui só conclui
          } else if (sim) {
            await getDocumentos(p.orderId);
            await sleep(700);
            imprimiu = true;
          } else {
            const docs = await getDocumentos(p.orderId);
            const r = await imprimirDocumentoDoPedido({ id: p.orderId, numero: p.numero }, "mesa", docs);
            if (r.ok) imprimiu = true;
            else l = registrarPulo(l, p, r.mensagem);
          }
        } catch (e) {
          l = registrarPulo(l, p, `falha ao buscar/imprimir a etiqueta: ${mensagemDoErro(e)}`);
        }
        if (imprimiu) {
          try {
            // Falha de rede ou 5xx: a etiqueta já saiu, então insiste (o servidor é idempotente e retoma de onde parou).
            for (let tentativa = 0; ; tentativa += 1) {
              try {
                await concluirImpressaoManual({ orderId: p.orderId, loteId: l.loteId });
                break;
              } catch (e) {
                const transitorio = !(e instanceof ApiError) || e.status >= 500;
                if (!transitorio || tentativa >= 2) throw e;
                await sleep(1500);
              }
            }
            l = registrarConcluido(l, p.orderId);
          } catch (e) {
            l = registrarErroConclusao(l, p, {
              status: e instanceof ApiError ? e.status : undefined,
              codigo: codigoDoErro(e),
              mensagem: mensagemDoErro(e),
              rede: !(e instanceof ApiError),
            });
          }
        }
        atualizar(l);
        if (l.interrompido) {
          setAviso(l.interrompido);
          atualizar({ ...l, pausado: true });
          return;
        }
      }
      await finalizar();
    } finally {
      rodandoRef.current = false;
    }
  }, [finalizar, grupo.estampa, grupo.tamanho]);

  const reservar = async (): Promise<ImpressaoManualReserva | null> => {
    setErro(null);
    setAviso(null);
    setFase("reservando");
    fecharRef.current = false;
    let r: ImpressaoManualReserva;
    try {
      r = await reservarImpressaoManual({ estampa: grupo.estampa, tamanho: grupo.tamanho, cor: grupo.cor ?? "", periodo: { de: periodoDe, ate: periodoAte } });
    } catch (e) {
      const cod = codigoDoErro(e);
      setErro(cod === IMPRESSAO_MANUAL_ERR.NAO_LIBERADA ? "Impressão manual não liberada para o seu cadastro." : `Não consegui reservar os pedidos: ${mensagemDoErro(e)}`);
      setFase("lista");
      return null;
    }
    if (r.pedidos.length === 0) {
      setErro("Nenhum pedido disponível para reservar neste tamanho.");
      setFase("lista");
      return null;
    }
    setReserva(r);
    capasBumpRef.current = new Set();
    return r;
  };

  const iniciar = async () => {
    modoPdfRef.current = false;
    const r = await reservar();
    if (!r) return;
    const l0 = novoLote(r.loteId, r.pedidos);
    atualizar(l0);
    setFase("imprimindo");
    setSaindo(null);
    try {
      if (!isExpedicaoSimulacao()) {
        const capa = gerarCapaTamanhoPdf({
          estampa: grupo.estampa,
          cor: grupo.cor,
          tamanho: grupo.tamanho,
          pedidos: r.pedidos.length,
          comBump: comBump(l0),
          operador,
        });
        const out = await printEtiquetaUnica(capa, "pdf", { jobName: `CAPA ${nomeGrupo} ${grupo.tamanho}`, printer: getLabelPrinter() });
        if (!out.ok) throw new Error(out.message ?? "impressão falhou");
      } else {
        await sleep(500);
      }
    } catch (e) {
      // Sem capa não há como identificar a pilha: devolve tudo à fila.
      setAviso(`Falha ao imprimir a capa: ${mensagemDoErro(e)}. Nenhum pedido foi expedido.`);
      atualizar(encerrar(l0));
      await finalizar();
      return;
    }
    void rodar();
  };

  // "Baixar PDF": reserva, busca as etiquetas, monta UM PDF e entrega o arquivo; o operador imprime fora
  // do app e confirma. Pedido sem etiqueta/falha na busca fica fora do PDF (pulado, será liberado).
  const baixarPdf = async () => {
    modoPdfRef.current = true;
    const r = await reservar();
    if (!r) return;
    let l = novoLote(r.loteId, r.pedidos);
    atualizar(l);
    setFase("baixando");
    setProgressoPdf({ i: 0, n: r.pedidos.length });
    try {
      const sim = isExpedicaoSimulacao();
      const etiquetas = new Map<string, FolhaResolvida>();
      let feitosBusca = 0;
      let cursor = 0;
      const motivos = new Map<string, string>();
      const worker = async () => {
        while (cursor < r.pedidos.length) {
          const p = r.pedidos[cursor++];
          try {
            if (sim) {
              etiquetas.set(p.orderId, { tipo: "pdf", base64: gerarEtiquetaSimuladaPdf(p.numero ?? p.orderId.slice(0, 8), p.tracking) });
            } else {
              const et = etiquetaEcommerceDoPedido(await getDocumentos(p.orderId));
              if (et) etiquetas.set(p.orderId, et.formato === "pdf" ? { tipo: "pdf", base64: et.base64 } : { tipo: "imagem", base64: et.base64, formato: et.formato });
              else motivos.set(p.orderId, "sem etiqueta J&T disponível");
            }
          } catch (e) {
            motivos.set(p.orderId, `falha ao buscar a etiqueta: ${mensagemDoErro(e)}`);
          }
          feitosBusca += 1;
          setProgressoPdf({ i: feitosBusca, n: r.pedidos.length });
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      for (const p of r.pedidos) if (!etiquetas.has(p.orderId)) l = registrarPulo(l, p, motivos.get(p.orderId) ?? "sem etiqueta");
      atualizar(l);
      const incluidos = r.pedidos.filter((p) => etiquetas.has(p.orderId));
      if (incluidos.length === 0) throw new Error("nenhum pedido com etiqueta disponível");
      const folhas: FolhaResolvida[] = sequenciaDaPilha(incluidos).map((f): FolhaResolvida => {
        if (f.tipo === "capa") {
          return { tipo: "pdf", base64: gerarCapaTamanhoPdf({ estampa: grupo.estampa, cor: grupo.cor, tamanho: grupo.tamanho, pedidos: incluidos.length, comBump: incluidos.filter((x) => x.comBump).length, operador }) };
        }
        if (f.tipo === "capaBump") {
          return { tipo: "pdf", base64: gerarCapaBumpPdf({ produtoNome: f.produtoNome, tamanho: f.tamanho, pedidos: f.pedidos, estampa: grupo.estampa, tamanhoGrupo: grupo.tamanho }) };
        }
        return etiquetas.get(f.pedido.orderId)!;
      });
      const bytes = await montarPdfPilha(folhas);
      const nome = nomeArquivoPilha(grupo.estampa, grupo.tamanho);
      const caminho = await baixarArquivoPdf(bytes, nome);
      setArquivoPdf({ nome, bytes, caminho });
      setFase("confirmarPdf");
    } catch (e) {
      setAviso(`Falha ao montar o PDF: ${mensagemDoErro(e)}. Nenhum pedido foi expedido.`);
      atualizar(encerrar(l));
      await finalizar();
    }
  };

  const confirmarPdf = () => {
    if (!loteRef.current) return;
    setFase("imprimindo");
    setSaindo(null);
    void rodar();
  };
  const cancelarPdf = async () => {
    if (loteRef.current) atualizar(encerrar(loteRef.current));
    await finalizar();
  };

  const pausar = () => {
    if (loteRef.current) atualizar(pedirPausa(loteRef.current));
  };
  const retomar = () => {
    if (!loteRef.current) return;
    setAviso(null);
    atualizar(continuar(loteRef.current));
    void rodar();
  };
  const fechar = async () => {
    if (fase !== "imprimindo") {
      onFechar();
      return;
    }
    fecharRef.current = true;
    if (!rodandoRef.current) {
      // Pausado: ninguém está no loop, finaliza aqui.
      if (loteRef.current) atualizar(encerrar(loteRef.current));
      await finalizar();
    }
    // Em curso: o loop vê `fecharRef` depois da etiqueta atual e finaliza.
  };

  const proximasRodadas = reserva ? reserva.parcial || reserva.restantesNaFila > 0 : false;
  const res = lote ? resumo(lote) : null;
  const bloqueado = fase === "imprimindo" || fase === "reservando" || fase === "baixando" || fase === "confirmarPdf";

  useEffect(() => {
    if (bloqueado) return;
    const h = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") onFechar();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [bloqueado, onFechar]);

  const totalLote = lote?.pedidos.length ?? 0;
  const feitos = lote ? lote.concluidos.length + lote.pulados.length + lote.errosConclusao.length : 0;
  const itens = useMemo(() => pedidos ?? [], [pedidos]);

  return (
    <div style={fundo} onClick={bloqueado ? undefined : onFechar} role="presentation">
      <div style={caixa} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {(fase === "lista" || fase === "reservando") && (
          <>
            <div style={titulo}>
              {nomeGrupo} · {grupo.tamanho} — {itens.length || totalNaFila} pedidos na fila
            </div>
            <div style={blocoImprimir}>
              <div style={blocoTopo}>
                <b>Imprimir o tamanho inteiro</b>
                <span style={badge}>liberado pro seu cadastro</span>
              </div>
              <div style={texto}>
                Gera a capa e uma etiqueta J&amp;T por pedido, na ordem da fila (pedidos com order bump no fim, cada bloco depois da sua capa). Os pedidos ficam separados e expedidos sem bipar.
              </div>
              <button type="button" style={botaoPrimario} onClick={() => void iniciar()} disabled={fase === "reservando" || (pedidos !== null && itens.length === 0)}>
                {fase === "reservando" ? "Reservando…" : `Imprimir ${itens.length || totalNaFila} etiquetas + capa`}
              </button>
              <button type="button" style={botaoSecundario} onClick={() => void baixarPdf()} disabled={fase === "reservando" || (pedidos !== null && itens.length === 0)}>
                {`Baixar PDF (${itens.length || totalNaFila} etiquetas + capas)`}
              </button>
            </div>
            {erro && <div style={avisoErro}>{erro}</div>}
            <div style={tabelaBox} className="thin-scroll">
              <table style={tabela}>
                <thead>
                  <tr>
                    <th style={th}>#</th>
                    <th style={th}>Pedido</th>
                    <th style={th}>Cliente</th>
                    <th style={th}>Emitido</th>
                    <th style={th}>Rastreio</th>
                  </tr>
                </thead>
                <tbody>
                  {itens.map((p, i) => (
                    <tr key={p.id}>
                      <td style={td}>{i + 1}</td>
                      <td style={td}>{p.numero ?? "—"}</td>
                      <td style={td}>{p.cliente ?? "—"}</td>
                      <td style={td}>{p.emitidoEm ? rotuloDia(p.emitidoEm.slice(0, 10)) : "—"}</td>
                      <td style={td}>{p.trackingNumber ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {pedidos === null && !erro && <div style={vazio}>Carregando…</div>}
            </div>
            <div style={rodape}>
              <button type="button" style={botao} onClick={onFechar} disabled={fase === "reservando"}>
                Fechar
              </button>
            </div>
          </>
        )}

        {fase === "baixando" && (
          <>
            <div style={titulo}>
              {nomeGrupo} · {grupo.tamanho}
            </div>
            <div style={barraBox}>
              <div style={{ ...barra, width: `${progressoPdf?.n ? (progressoPdf.i / progressoPdf.n) * 100 : 0}%` }} />
            </div>
            <div style={progressoTxt}>
              buscando etiquetas {progressoPdf?.i ?? 0}/{progressoPdf?.n ?? 0}
            </div>
          </>
        )}

        {fase === "confirmarPdf" && lote && (
          <>
            <div style={titulo}>
              {nomeGrupo} · {grupo.tamanho}
            </div>
            <div style={grande}>PDF salvo com {lote.pedidos.length - lote.pulados.length} etiquetas.</div>
            <div style={texto}>Imprima e confirme para marcar os pedidos como separados e expedidos. ({arquivoPdf?.nome})</div>
            {lote.pulados.length > 0 && <div style={avisoErro}>{lote.pulados.length} pedido(s) ficaram fora do PDF (sem etiqueta) e serão devolvidos à fila.</div>}
            <div style={texto}>Arquivo: {arquivoPdf?.caminho ?? `${arquivoPdf?.nome ?? ""} (pasta de downloads)`}</div>
            <div style={texto}>As reservas expiram em ~15 min sem confirmação.</div>
            <div style={rodape}>
              {arquivoPdf && (
                <button type="button" style={botao} onClick={() => void baixarArquivoPdf(arquivoPdf.bytes, arquivoPdf.nome)}>
                  Baixar de novo
                </button>
              )}
              <button type="button" style={botao} onClick={() => void cancelarPdf()}>
                Cancelar e devolver à fila
              </button>
              <button type="button" style={botaoPrimario} onClick={confirmarPdf}>
                Já imprimi — marcar {lote.pedidos.length - lote.pulados.length} como expedidos
              </button>
            </div>
          </>
        )}

        {fase === "imprimindo" && lote && (
          <>
            <div style={titulo}>
              {impressora} · {grupo.estampa} {grupo.tamanho}
            </div>
            <div style={barraBox} aria-label={`Progresso ${feitos} de ${totalLote}`}>
              <div style={{ ...barra, width: `${totalLote ? (feitos / totalLote) * 100 : 0}%` }} />
            </div>
            <div style={progressoTxt}>
              {feitos}/{totalLote}
            </div>
            <div style={grid2}>
              <div style={painel}>
                <div style={rotuloPainel}>Saindo agora</div>
                {saindo && !lote.pausado ? (
                  <>
                    <div style={grande}>#{saindo.numero ?? saindo.orderId.slice(0, 8)}</div>
                    <div style={medio}>{saindo.tracking ?? "sem rastreio"}</div>
                    <div style={texto}>{saindo.cliente ?? ""}</div>
                  </>
                ) : (
                  <div style={texto}>{lote.pausado ? "Pausado." : modoPdfRef.current ? "Marcando como expedidos…" : "Imprimindo a capa…"}</div>
                )}
              </div>
              <div style={painel}>
                <div style={rotuloPainel}>Pilha</div>
                <div style={grande}>{lote.concluidos.length} saíram</div>
                {comBump(lote) > 0 && <div style={texto}>{comBump(lote)} com order bump, no fim, cada bloco depois da sua capa</div>}
                {lote.pulados.length > 0 && <div style={texto}>{lote.pulados.length} pulados (serão liberados)</div>}
                {lote.pausaPedida && !lote.pausado && <div style={texto}>Vai pausar depois desta etiqueta…</div>}
              </div>
            </div>
            {aviso && <div style={avisoErro}>{aviso}</div>}
            <div style={rodape}>
              {lote.pausado ? (
                <button type="button" style={botaoPrimario} onClick={retomar}>
                  Continuar
                </button>
              ) : (
                <button type="button" style={botao} onClick={pausar} disabled={lote.pausaPedida}>
                  Pausar
                </button>
              )}
              <button type="button" style={botao} onClick={() => void fechar()}>
                Fechar
              </button>
            </div>
          </>
        )}

        {fase === "resumo" && res && (
          <>
            <div style={titulo}>
              {nomeGrupo} · {grupo.tamanho} — resumo
            </div>
            <div style={grande}>
              {res.expedidos} de {res.total} expedidos
            </div>
            {aviso && <div style={avisoErro}>{aviso}</div>}
            {liberarFalhou && <div style={avisoErro}>Não consegui devolver os reservados à fila agora; vou tentar de novo ao abrir a aba Únicos.</div>}
            {res.naoImpressos > 0 && <div style={texto}>{res.naoImpressos} não chegaram a ser impressos e voltaram à fila.</div>}
            {(res.pulados.length > 0 || res.errosConclusao.length > 0) && (
              <div style={tabelaBox} className="thin-scroll">
                <table style={tabela}>
                  <tbody>
                    {res.pulados.map((p) => (
                      <tr key={p.orderId}>
                        <td style={td}>#{p.numero ?? p.orderId.slice(0, 8)}</td>
                        <td style={td}>pulado: {p.motivo}</td>
                      </tr>
                    ))}
                    {res.errosConclusao.map((p) => (
                      <tr key={p.orderId}>
                        <td style={td}>#{p.numero ?? p.orderId.slice(0, 8)}</td>
                        <td style={td}>
                          erro ao concluir{p.codigo ? ` (${p.codigo})` : ""}: {p.mensagem}. A etiqueta saiu, mas o pedido NÃO foi expedido — separe o pacote e avise a supervisão.
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div style={rodape}>
              {proximasRodadas && (
                <button type="button" style={botaoPrimario} onClick={() => void iniciar()}>
                  Imprimir os próximos
                </button>
              )}
              <button type="button" style={botao} onClick={onFechar}>
                Fechar
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const fundo: CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 24 };
const caixa: CSSProperties = { width: "min(860px, 100%)", maxHeight: "100%", display: "flex", flexDirection: "column", gap: 12, padding: 20, background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 14, color: "var(--text)", overflow: "hidden" };
const titulo: CSSProperties = { fontSize: 20, fontWeight: 800, overflowWrap: "anywhere" };
const blocoImprimir: CSSProperties = { display: "flex", flexDirection: "column", gap: 8, padding: 12, border: "1px solid var(--border-strong)", borderRadius: 10, background: "var(--bg-input)" };
const blocoTopo: CSSProperties = { display: "flex", alignItems: "center", gap: 10 };
const badge: CSSProperties = { padding: "1px 8px", borderRadius: 999, background: "var(--info-bg, #dbeafe)", color: "var(--info-text, #1d4ed8)", fontSize: 11, fontWeight: 700 };
const texto: CSSProperties = { fontSize: 13, color: "var(--text-secondary)" };
const botao: CSSProperties = { padding: "10px 16px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text)", fontWeight: 700, cursor: "pointer" };
const botaoPrimario: CSSProperties = { ...botao, alignSelf: "flex-start", background: "var(--accent, #2563eb)", color: "#fff", border: "1px solid transparent" };
const botaoSecundario: CSSProperties = { ...botao, alignSelf: "flex-start" };
const avisoErro: CSSProperties = { padding: "6px 12px", borderRadius: 8, background: "var(--warning-bg)", border: "1px solid var(--warning-border)", color: "var(--warning-text)", fontSize: 13 };
const tabelaBox: CSSProperties = { flex: 1, minHeight: 80, maxHeight: "40vh", overflowY: "auto" };
const tabela: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 13 };
const th: CSSProperties = { textAlign: "left", padding: "4px 8px", color: "var(--text-secondary)", borderBottom: "1px solid var(--border)" };
const td: CSSProperties = { padding: "4px 8px", borderBottom: "1px solid var(--border)" };
const vazio: CSSProperties = { padding: 12, color: "var(--text-secondary)", textAlign: "center" };
const rodape: CSSProperties = { display: "flex", gap: 10, justifyContent: "flex-end" };
const barraBox: CSSProperties = { height: 14, borderRadius: 999, background: "var(--bg-input)", border: "1px solid var(--border)", overflow: "hidden" };
const barra: CSSProperties = { height: "100%", background: "var(--accent, #2563eb)", transition: "width 0.3s" };
const progressoTxt: CSSProperties = { fontSize: 14, fontWeight: 700, color: "var(--text-secondary)" };
const grid2: CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 };
const painel: CSSProperties = { display: "flex", flexDirection: "column", gap: 6, padding: 16, minHeight: 150, border: "1px solid var(--border)", borderRadius: 12, background: "var(--bg-input)" };
const rotuloPainel: CSSProperties = { fontSize: 12, fontWeight: 700, color: "var(--text-secondary)", textTransform: "uppercase" };
const grande: CSSProperties = { fontSize: 32, fontWeight: 900, lineHeight: 1.1 };
const medio: CSSProperties = { fontSize: 20, fontWeight: 700 };

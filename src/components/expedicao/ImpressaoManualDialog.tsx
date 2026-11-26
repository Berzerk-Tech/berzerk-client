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
  adicionarReserva,
  aplicarPausa,
  comBump,
  continuar,
  encerrar,
  feitosDoTamanho,
  limparLoteEmCurso,
  novoLote,
  novoLoteVazio,
  paraLiberar,
  pedirPausa,
  proximoPedido,
  registrarConcluido,
  registrarErroConclusao,
  registrarPulo,
  registrarSobraNaFila,
  registrarTamanhoVazio,
  resumo,
  resumoPorTamanho,
  salvarLoteEmCurso,
  terminou,
  type LoteManual,
} from "../../lib/impressaoManualLote";
import { gravarConclusao } from "../../lib/impressaoManualHistorico";
import { planoDaGrade, rotuloDaGrade, totalDaGrade, type GradeTamanho } from "../../lib/impressaoManualGrade";
import type { ItemReimpressao } from "../../lib/reimprimirManual";
import { ReimprimirLista } from "./ReimprimirLista";
import { etiquetaEcommerceDoPedido, imprimirDocumentoDoPedido } from "../../lib/reimpressao";
import { printEtiquetaUnica } from "../../lib/printer";
import { rotuloDia, rotuloTiposCapa, type GrupoEscolhido, type PeriodoUnicos } from "../../lib/unicosExpedicao";
import {
  concluirImpressaoManual,
  devolverUnicosASeparacao,
  getDocumentos,
  getUnicosPedidos,
  IMPRESSAO_MANUAL_ERR,
  liberarImpressaoManual,
  reservarImpressaoManual,
  type ImpressaoManualPedido,
  type ImpressaoManualReserva,
  type UnicoPedido,
  type UnicoTipo,
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
  grade,
  tipos,
  periodo,
  totalNaFila,
  podeImprimir = true,
  podeDevolver = false,
  semOrderBump = false,
  onFechar,
  onAtualizar,
}: {
  /** Em modo grade, `grupo.tamanho` é ignorado (só estampa e cor valem). */
  grupo: GrupoEscolhido;
  /** Grade toda: os tamanhos do card (e quantos pedidos cada um). Sem isso, é o tamanho único de `grupo`. */
  grade?: GradeTamanho[];
  /** Tipos de peça do tamanho único (modo grade usa os de cada item da grade); ausente = capa sem a linha. */
  tipos?: UnicoTipo[];
  periodo?: PeriodoUnicos | null;
  totalNaFila: number;
  /** Flag da impressão manual (`me.unicosImpressaoManual`); sem ela o diálogo só lista e devolve. */
  podeImprimir?: boolean;
  /** `separacao:manage`: checkbox por pedido + "Devolver à separação". */
  podeDevolver?: boolean;
  /** Chave "Sem order bump": a impressão manual só pega os pedidos sem bump. */
  semOrderBump?: boolean;
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
  const [selecionados, setSelecionados] = useState<Set<string>>(new Set());
  const [devolvendo, setDevolvendo] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  // Grade toda: plano (ordem canônica), fila de tamanhos ainda sem reserva e o tamanho em curso.
  const modoGrade = grade !== undefined;
  const plano = useMemo(() => planoDaGrade(grade ?? []), [grade]);
  const totalGrade = totalDaGrade(plano);
  const [tamanhoAtual, setTamanhoAtual] = useState<{ tamanho: string; esperado: number; indice: number } | null>(null);
  const filaRef = useRef<GradeTamanho[]>([]);
  const correnteRef = useRef<{ tamanho: string; esperado: number; parcial: boolean; restantes: number } | null>(null);
  /** Linha de tipo da capa do tamanho: contagem só quando bate com o "N pedidos" da capa; `bump` nunca conta. */
  const tipoDaCapa = (tam: string, pedidosN: number, bump = false): string => {
    const fonte = modoGrade ? plano.find((x) => x.tamanho === tam)?.tipos : tipos;
    if (!fonte?.length) return "";
    const soma = fonte.reduce((n, t) => n + t.pedidos, 0);
    return rotuloTiposCapa(fonte, grupo.estampa, bump || soma !== pedidosN);
  };
  const rotuloTam = modoGrade ? "grade toda" : grupo.tamanho;

  const loteRef = useRef<LoteManual | null>(null);
  const rodandoRef = useRef(false);
  const capasBumpRef = useRef<Set<string>>(new Set());
  const modoPdfRef = useRef(false);
  const [progressoPdf, setProgressoPdf] = useState<{ i: number; n: number } | null>(null);
  const [arquivoPdf, setArquivoPdf] = useState<{ nome: string; bytes: Uint8Array; caminho: string | null } | null>(null);
  const fecharRef = useRef(false);
  // "Pausar" mora num ref: o loop guarda cópias do lote durante awaits e gravaria por cima do `pausaPedida`.
  const pausaRef = useRef(false);
  const periodoDe = periodo?.de ?? null;
  const periodoAte = periodo?.ate ?? null;
  const impressora = getLabelPrinter() || NOME_PADRAO;
  const nomeGrupo = `${grupo.estampa}${grupo.cor ? ` ${grupo.cor}` : ""}`;

  useEffect(() => {
    let vivo = true;
    getMe()
      .then((m) => vivo && setOperador(m.email))
      .catch(() => {});
    // Grade toda não lista pedido a pedido: mostra os tamanhos e as contagens do card.
    if (!modoGrade) {
      getUnicosPedidos(grupo.estampa, grupo.tamanho, grupo.cor, { de: periodoDe, ate: periodoAte })
        .then((p) => vivo && setPedidos(p))
        .catch(() => vivo && setErro("Não consegui carregar os pedidos da fila."));
    }
    return () => {
      vivo = false;
    };
  }, [grupo.estampa, grupo.tamanho, grupo.cor, periodoDe, periodoAte, modoGrade]);

  // Tela fechada/desmontada: o loop não reserva, imprime nem conclui mais nada.
  useEffect(
    () => () => {
      fecharRef.current = true;
    },
    [],
  );

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

  const chamarReservar = (tamanho: string) =>
    reservarImpressaoManual({ estampa: grupo.estampa, tamanho, cor: grupo.cor ?? "", periodo: { de: periodoDe, ate: periodoAte }, semOrderBump });

  /** Capa do tamanho (mesmo layout de sempre; na grade ganha "GRADE TODA · tamanho i de n"). Lança se a impressão falhar. */
  const imprimirCapa = async (tamanho: string, pedidosN: number, comBumpN: number, gradeToda?: { indice: number; total: number }) => {
    if (isExpedicaoSimulacao()) {
      await sleep(500);
      return;
    }
    const capa = gerarCapaTamanhoPdf({ estampa: grupo.estampa, cor: grupo.cor, tipo: tipoDaCapa(tamanho, pedidosN), tamanho, pedidos: pedidosN, comBump: comBumpN, operador, ...(gradeToda ? { gradeToda } : {}) });
    const out = await printEtiquetaUnica(capa, "pdf", { jobName: `CAPA ${nomeGrupo} ${tamanho}`, printer: getLabelPrinter() });
    if (!out.ok) throw new Error(out.message ?? "impressão falhou");
  };

  /**
   * Grade toda: reserva a próxima rodada (mais uma do mesmo tamanho se o servidor devolveu `parcial`; senão o
   * próximo tamanho da fila), junta ao lote e, no tamanho novo, imprime a capa (`semCapa` no modo PDF).
   * `mais` = há o que imprimir; `fim` = nada mais a reservar (ou abortou); `parar` = erro, lote pausado.
   */
  const avancarGrade = async (semCapa: boolean): Promise<"mais" | "fim" | "parar"> => {
    let l = loteRef.current;
    if (!l || fecharRef.current) return "fim";
    const cur = correnteRef.current;
    const continuaTamanho = !!cur && cur.parcial && cur.restantes > 0;
    const alvo = continuaTamanho ? { tamanho: cur.tamanho, pedidos: cur.esperado } : filaRef.current[0];
    if (!alvo) return "fim";
    let r: ImpressaoManualReserva;
    try {
      r = await chamarReservar(alvo.tamanho);
    } catch (e) {
      if (codigoDoErro(e) === IMPRESSAO_MANUAL_ERR.NAO_LIBERADA) {
        setAviso("Impressão manual não liberada para o seu cadastro.");
        filaRef.current = [];
        correnteRef.current = null;
        atualizar(encerrar(l));
        return "fim";
      }
      const msg = `Não consegui reservar o tamanho ${alvo.tamanho}: ${mensagemDoErro(e)}. Toque em Continuar para tentar de novo.`;
      setAviso(msg);
      atualizar({ ...l, pausado: true, interrompido: msg });
      return "parar";
    }
    if (!continuaTamanho) filaRef.current = filaRef.current.slice(1);
    if (r.pedidos.length === 0) {
      // Rodada vazia, sem abortar a grade. Com `restantesNaFila` > 0 o servidor não entregou (ocupado): vira
      // "ficaram na fila"; sem sobra, na 1ª rodada é "alguém pegou antes" e na extra não há mais nada.
      const sobra = r.restantesNaFila > 0;
      if (continuaTamanho) correnteRef.current = { ...cur, parcial: false };
      else correnteRef.current = null;
      if (sobra) atualizar(registrarSobraNaFila(loteRef.current ?? l, alvo.tamanho, r.restantesNaFila));
      else if (!continuaTamanho) atualizar(registrarTamanhoVazio(loteRef.current ?? l, alvo.tamanho));
      return "mais";
    }
    l = loteRef.current ?? l;
    l = adicionarReserva(l, r.loteId, alvo.tamanho, r.pedidos);
    const esperado = continuaTamanho ? cur.esperado : r.pedidos.length + (r.parcial ? r.restantesNaFila : 0);
    correnteRef.current = { tamanho: alvo.tamanho, esperado, parcial: r.parcial, restantes: r.restantesNaFila };
    atualizar(l);
    const indice = plano.findIndex((t) => t.tamanho === alvo.tamanho) + 1;
    setTamanhoAtual({ tamanho: alvo.tamanho, esperado, indice });
    if (!continuaTamanho && !semCapa) {
      try {
        await imprimirCapa(alvo.tamanho, esperado, r.pedidos.filter((x) => x.comBump).length, { indice, total: plano.length });
      } catch (e) {
        // Sem capa não há como identificar a pilha: devolve tudo à fila (o que já saiu fica como está).
        setAviso(`Falha ao imprimir a capa do tamanho ${alvo.tamanho}: ${mensagemDoErro(e)}. Os pedidos ainda não impressos voltam à fila.`);
        filaRef.current = [];
        correnteRef.current = null;
        atualizar(encerrar(l));
        return "fim";
      }
    }
    return "mais";
  };

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
        if (pausaRef.current && !l.pausaPedida) l = pedirPausa(l);
        l = aplicarPausa(l);
        if (l.pausado) {
          atualizar(l);
          return;
        }
        const p = proximoPedido(l);
        if (!p) {
          if (modoGrade && !modoPdfRef.current && !l.encerrado && !l.interrompido) {
            // Acabou o que estava reservado: reserva a próxima rodada/tamanho (só agora, pra não prender pedidos à toa).
            const prox = await avancarGrade(false);
            if (prox === "mais") continue;
            if (prox === "parar") return;
            l = loteRef.current ?? l;
          }
          if (terminou(l)) atualizar(encerrar(l));
          else atualizar(l);
          break;
        }
        setSaindo(p);
        // Capa do bloco de order bump antes da 1ª etiqueta do bloco: sem ela, no papel não dá pra saber onde
        // começam. Falhar aqui não segura o lote; `capasBumpRef` evita reimprimir ao continuar depois de pausa.
        const tamanhoDoPedido = p.tamanho ?? grupo.tamanho;
        // Por tamanho: um bloco de bump nunca atravessa a fronteira entre dois tamanhos da grade.
        const capaBump = modoPdfRef.current ? undefined : capasDeBumpPorPedido(l.pedidos.filter((x) => (x.tamanho ?? grupo.tamanho) === tamanhoDoPedido)).get(p.orderId);
        if (capaBump && !capasBumpRef.current.has(p.orderId)) {
          capasBumpRef.current.add(p.orderId);
          if (!sim) {
            try {
              const folha = gerarCapaBumpPdf({ produtoNome: capaBump.produtoNome, tamanho: capaBump.tamanho, pedidos: capaBump.pedidos, numeros: capaBump.numeros, estampa: grupo.estampa, tipo: tipoDaCapa(tamanhoDoPedido, Number.NaN, true), tamanhoGrupo: tamanhoDoPedido });
              await printEtiquetaUnica(folha, "pdf", { jobName: `ORDER BUMP ${capaBump.tamanho ?? ""} ${tamanhoDoPedido}`, printer: getLabelPrinter() });
            } catch {
              /* segue sem a capa do bloco */
            }
          } else {
            await sleep(300);
          }
        }
        if (fecharRef.current) {
          atualizar(encerrar(loteRef.current ?? l));
          break;
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
                await concluirImpressaoManual({ orderId: p.orderId, loteId: p.loteId ?? l.loteId });
                break;
              } catch (e) {
                const transitorio = !(e instanceof ApiError) || e.status >= 500;
                if (!transitorio || tentativa >= 2) throw e;
                await sleep(1500);
              }
            }
            l = registrarConcluido(l, p.orderId);
            gravarConclusao(
              { loteId: l.loteId, estampa: grupo.estampa, cor: grupo.cor ?? null },
              { orderId: p.orderId, numero: p.numero, cliente: p.cliente, tracking: p.tracking, comBump: p.comBump, bump: p.bump ?? null, tamanho: tamanhoDoPedido },
            );
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
  }, [finalizar, grupo.estampa, grupo.tamanho, grupo.cor, modoGrade, tipos, plano]);

  const reservar = async (): Promise<ImpressaoManualReserva | null> => {
    setErro(null);
    setAviso(null);
    setFase("reservando");
    fecharRef.current = false;
    let r: ImpressaoManualReserva;
    try {
      r = await chamarReservar(grupo.tamanho);
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
    pausaRef.current = false;
    const r = await reservar();
    if (!r) return;
    const l0 = novoLote(r.loteId, r.pedidos, grupo.tamanho);
    atualizar(l0);
    setFase("imprimindo");
    setSaindo(null);
    try {
      await imprimirCapa(grupo.tamanho, r.pedidos.length, comBump(l0));
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
    let l: LoteManual;
    {
      const r0 = await reservar();
      if (!r0) return;
      l = novoLote(r0.loteId, r0.pedidos, grupo.tamanho);
      atualizar(l);
    }
    const r = { pedidos: l.pedidos };
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
      // Uma "pilha" por tamanho (capa do tamanho + etiquetas), na ordem em que foram reservados (canônica).
      const tamanhosDoPdf: string[] = [];
      for (const x of incluidos) {
        const t = x.tamanho ?? grupo.tamanho;
        if (!tamanhosDoPdf.includes(t)) tamanhosDoPdf.push(t);
      }
      const folhas: FolhaResolvida[] = tamanhosDoPdf.flatMap((tam) => {
        const doTamanho = incluidos.filter((x) => (x.tamanho ?? grupo.tamanho) === tam);
        return sequenciaDaPilha(doTamanho).map((f): FolhaResolvida => {
          if (f.tipo === "capa") {
            return { tipo: "pdf", base64: gerarCapaTamanhoPdf({ estampa: grupo.estampa, cor: grupo.cor, tipo: tipoDaCapa(tam, doTamanho.length), tamanho: tam, pedidos: doTamanho.length, comBump: doTamanho.filter((x) => x.comBump).length, operador }) };
          }
          if (f.tipo === "capaBump") {
            return { tipo: "pdf", base64: gerarCapaBumpPdf({ produtoNome: f.produtoNome, tamanho: f.tamanho, pedidos: f.pedidos, numeros: f.numeros, estampa: grupo.estampa, tipo: tipoDaCapa(tam, Number.NaN, true), tamanhoGrupo: tam }) };
          }
          return etiquetas.get(f.pedido.orderId)!;
        });
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

  // Grade toda, impressão direta: nada é reservado de antemão; `rodar` reserva tamanho a tamanho.
  const iniciarGrade = () => {
    modoPdfRef.current = false;
    pausaRef.current = false;
    setErro(null);
    setAviso(null);
    fecharRef.current = false;
    filaRef.current = plano.slice();
    correnteRef.current = null;
    capasBumpRef.current = new Set();
    setTamanhoAtual(null);
    atualizar(novoLoteVazio());
    setFase("imprimindo");
    setSaindo(null);
    void rodar();
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
    pausaRef.current = true;
    if (loteRef.current) atualizar(pedirPausa(loteRef.current));
  };
  const retomar = () => {
    if (!loteRef.current) return;
    pausaRef.current = false;
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

  const itensReimpressao: ItemReimpressao[] = lote
    ? lote.pedidos
        .filter((p) => lote.concluidos.includes(p.orderId))
        .map((p) => ({ orderId: p.orderId, numero: p.numero, cliente: p.cliente, tracking: p.tracking, comBump: p.comBump, bump: p.bump ?? null, tamanho: p.tamanho ?? grupo.tamanho, estampa: grupo.estampa }))
    : [];
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
  const idsComBump = useMemo(() => itens.filter((p) => p.orderBump).map((p) => p.id), [itens]);
  // O que a impressão manual vai pegar: com "Sem order bump", só os sem bump.
  const aImprimir = modoGrade ? totalGrade : pedidos === null ? totalNaFila : semOrderBump ? itens.length - idsComBump.length : itens.length;
  const todosMarcados = itens.length > 0 && itens.every((p) => selecionados.has(p.id));

  const alternar = (id: string) =>
    setSelecionados((atual) => {
      const prox = new Set(atual);
      if (prox.has(id)) prox.delete(id);
      else prox.add(id);
      return prox;
    });

  const devolver = async () => {
    const ids = itens.filter((p) => selecionados.has(p.id)).map((p) => p.id);
    if (ids.length === 0 || devolvendo) return;
    setDevolvendo(true);
    setErro(null);
    setInfo(null);
    try {
      const r = await devolverUnicosASeparacao(ids);
      setInfo(`${r.devolvidos} pedido(s) voltaram para a separação.${r.ignorados > 0 ? ` ${r.ignorados} já tinham saído da fila.` : ""}`);
      const fora = new Set(ids);
      setPedidos((atual) => (atual ? atual.filter((p) => !fora.has(p.id)) : atual));
      setSelecionados(new Set());
      onAtualizar();
    } catch (e) {
      const semPermissao = e instanceof ApiError && e.status === 403;
      setErro(semPermissao ? "Seu cadastro não pode devolver pedidos à separação." : `Não consegui devolver: ${mensagemDoErro(e)}`);
    } finally {
      setDevolvendo(false);
    }
  };

  return (
    <div style={fundo} onClick={bloqueado ? undefined : onFechar} role="presentation">
      <div style={caixa} role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        {(fase === "lista" || fase === "reservando") && (
          <>
            <div style={titulo}>
              {nomeGrupo} · {rotuloTam} — {modoGrade ? totalGrade : itens.length || totalNaFila} pedidos na fila
            </div>
            {podeImprimir && (
            <div style={blocoImprimir}>
              <div style={blocoTopo}>
                <b>{modoGrade ? "Imprimir a grade toda" : "Imprimir o tamanho inteiro"}</b>
                <span style={badge}>liberado pro seu cadastro</span>
              </div>
              {modoGrade && (
                <div style={grandeGrade} aria-label="Tamanhos da grade">
                  {rotuloDaGrade(plano)}
                </div>
              )}
              <div style={texto}>
                {modoGrade
                  ? `Imprime um tamanho por vez, na ordem da grade: a capa do tamanho e uma etiqueta J&T por pedido. Os pedidos de cada tamanho só são reservados quando chega a vez dele.${semOrderBump ? ' "Sem order bump" ligado: os pedidos com bump ficam na fila.' : ""} Os pedidos ficam separados e expedidos sem bipar.`
                  : semOrderBump
                  ? `Gera a capa e uma etiqueta J&T por pedido, na ordem da fila. "Sem order bump" ligado: os ${idsComBump.length} pedido(s) com bump ficam na fila. Os pedidos ficam separados e expedidos sem bipar.`
                  : "Gera a capa e uma etiqueta J&T por pedido, na ordem da fila (pedidos com order bump no fim, cada bloco depois da sua capa). Os pedidos ficam separados e expedidos sem bipar."}
              </div>
              <button type="button" style={botaoPrimario} onClick={() => (modoGrade ? iniciarGrade() : void iniciar())} disabled={fase === "reservando" || devolvendo || aImprimir === 0}>
                {fase === "reservando" ? "Reservando…" : modoGrade ? `Imprimir grade toda (${aImprimir} etiquetas + ${plano.length} capas)` : `Imprimir ${aImprimir} etiquetas + capa`}
              </button>
              {modoGrade ? (
                <div style={texto}>Para PDF, imprima um tamanho por vez.</div>
              ) : (
                <button type="button" style={botaoSecundario} onClick={() => void baixarPdf()} disabled={fase === "reservando" || devolvendo || aImprimir === 0}>
                  {`Baixar PDF (${aImprimir} etiquetas + capas)`}
                </button>
              )}
            </div>
            )}
            {podeDevolver && !modoGrade && (
              <div style={barraDevolver}>
                <button type="button" style={botao} onClick={() => setSelecionados(new Set(todosMarcados ? [] : itens.map((p) => p.id)))} disabled={itens.length === 0 || devolvendo}>
                  {todosMarcados ? "Desmarcar todos" : "Selecionar todos"}
                </button>
                {idsComBump.length > 0 && (
                  <button type="button" style={botao} onClick={() => setSelecionados(new Set(idsComBump))} disabled={devolvendo}>
                    Selecionar os {idsComBump.length} com bump
                  </button>
                )}
                <button type="button" style={botaoDevolver} onClick={() => void devolver()} disabled={selecionados.size === 0 || devolvendo || fase === "reservando"}>
                  {devolvendo ? "Devolvendo…" : `Devolver à separação (${selecionados.size})`}
                </button>
              </div>
            )}
            {info && <div style={avisoOk}>{info}</div>}
            {erro && <div style={avisoErro}>{erro}</div>}
            {modoGrade ? (
              <div style={tabelaBox} className="thin-scroll">
                <table style={tabela}>
                  <thead>
                    <tr>
                      <th style={th}>Tamanho</th>
                      <th style={th}>Pedidos</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plano.map((t) => (
                      <tr key={t.tamanho}>
                        <td style={td}>{t.tamanho}</td>
                        <td style={td}>{t.pedidos}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
            <div style={tabelaBox} className="thin-scroll">
              <table style={tabela}>
                <thead>
                  <tr>
                    {podeDevolver && <th style={th} />}
                    <th style={th}>#</th>
                    <th style={th}>Pedido</th>
                    <th style={th}>Cliente</th>
                    <th style={th}>Emitido</th>
                    <th style={th}>Rastreio</th>
                    <th style={th}>Order bump</th>
                  </tr>
                </thead>
                <tbody>
                  {itens.map((p, i) => (
                    <tr key={p.id} style={podeDevolver ? { cursor: "pointer" } : undefined} onClick={podeDevolver ? () => alternar(p.id) : undefined}>
                      {podeDevolver && (
                        <td style={td}>
                          <input type="checkbox" checked={selecionados.has(p.id)} onChange={() => alternar(p.id)} onClick={(ev) => ev.stopPropagation()} aria-label={`Selecionar pedido ${p.numero ?? ""}`} />
                        </td>
                      )}
                      <td style={td}>{i + 1}</td>
                      <td style={td}>{p.numero ?? "—"}</td>
                      <td style={td}>{p.cliente ?? "—"}</td>
                      <td style={td}>{p.emitidoEm ? rotuloDia(p.emitidoEm.slice(0, 10)) : "—"}</td>
                      <td style={td}>{p.trackingNumber ?? "—"}</td>
                      <td style={td}>{p.orderBump ? `+ ${[p.orderBump.produtoNome, p.orderBump.tamanho].filter(Boolean).join(" · ")}` : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {pedidos === null && !erro && <div style={vazio}>Carregando…</div>}
            </div>
            )}
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
              {nomeGrupo} · {rotuloTam}
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
              {nomeGrupo} · {rotuloTam}
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
              {impressora} · {grupo.estampa} {rotuloTam}
            </div>
            <div style={barraBox} aria-label={`Progresso ${feitos} de ${modoGrade ? Math.max(totalGrade, totalLote) : totalLote}`}>
              <div style={{ ...barra, width: `${(modoGrade ? Math.max(totalGrade, totalLote) : totalLote) ? (feitos / (modoGrade ? Math.max(totalGrade, totalLote) : totalLote)) * 100 : 0}%` }} />
            </div>
            <div style={progressoTxt}>
              {modoGrade ? (
                <>
                  {tamanhoAtual ? `${tamanhoAtual.tamanho} · ${feitosDoTamanho(lote, tamanhoAtual.tamanho)} de ${tamanhoAtual.esperado} · tamanho ${tamanhoAtual.indice} de ${plano.length} · ` : ""}
                  {feitos} de {Math.max(totalGrade, totalLote)} no total
                </>
              ) : (
                <>
                  {feitos}/{totalLote}
                </>
              )}
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
                  <div style={texto}>{lote.pausado ? "Pausado." : modoPdfRef.current ? "Marcando como expedidos…" : modoGrade ? "Reservando o próximo tamanho…" : "Imprimindo a capa…"}</div>
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
              {nomeGrupo} · {rotuloTam} — resumo
            </div>
            <div style={grande}>
              {res.expedidos} de {res.total} expedidos
            </div>
            {aviso && <div style={avisoErro}>{aviso}</div>}
            {liberarFalhou && <div style={avisoErro}>Não consegui devolver os reservados à fila agora; vou tentar de novo ao abrir a aba Únicos.</div>}
            {res.naoImpressos > 0 && <div style={texto}>{res.naoImpressos} não chegaram a ser impressos e voltaram à fila.</div>}
            {lote && lote.tamanhosVazios.length > 0 && (
              <div style={avisoErro}>
                Sem pedidos disponíveis (alguém pegou antes): {lote.tamanhosVazios.join(", ")}. Esses tamanhos foram pulados.
              </div>
            )}
            {lote && lote.sobrasNaFila.length > 0 && (
              <div style={avisoErro}>
                {lote.sobrasNaFila.map((x) => `${x.tamanho}: ${x.pedidos} pedido${x.pedidos === 1 ? "" : "s"} ficaram na fila (servidor ocupado), tente de novo`).join(". ")}.
              </div>
            )}
            {lote && modoGrade && (
              <div style={tabelaBox} className="thin-scroll">
                <table style={tabela}>
                  <thead>
                    <tr>
                      <th style={th}>Tamanho</th>
                      <th style={th}>Impressos</th>
                      <th style={th}>Pulados (sem etiqueta)</th>
                      <th style={th}>Erros</th>
                      <th style={th}>Voltaram à fila</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resumoPorTamanho(lote).map((t) => (
                      <tr key={t.tamanho}>
                        <td style={td}>{t.tamanho}</td>
                        <td style={td}>{t.expedidos}</td>
                        <td style={td}>{t.pulados}</td>
                        <td style={td}>{t.erros}</td>
                        <td style={td}>{t.naoImpressos}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
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
            {lote && itensReimpressao.length > 0 && (
              <div style={blocoReimprimir}>
                <b>Saiu errado? Reimprimir</b>
                <div style={texto}>Reimprimir manda uma 2ª via pra impressora e não muda o status dos pedidos.</div>
                <ReimprimirLista itens={itensReimpressao} />
              </div>
            )}
            <div style={rodape}>
              {!modoGrade && proximasRodadas && (
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
const blocoReimprimir: CSSProperties = { display: "flex", flexDirection: "column", gap: 6, padding: 12, border: "1px solid var(--border)", borderRadius: 10, background: "var(--bg-input)" };
const grandeGrade: CSSProperties = { fontSize: 18, fontWeight: 800, overflowWrap: "anywhere" };
const blocoTopo: CSSProperties = { display: "flex", alignItems: "center", gap: 10 };
const badge: CSSProperties = { padding: "1px 8px", borderRadius: 999, background: "var(--info-bg, #dbeafe)", color: "var(--info-text, #1d4ed8)", fontSize: 11, fontWeight: 700 };
const texto: CSSProperties = { fontSize: 13, color: "var(--text-secondary)" };
const botao: CSSProperties = { padding: "10px 16px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text)", fontWeight: 700, cursor: "pointer" };
const botaoPrimario: CSSProperties = { ...botao, alignSelf: "flex-start", background: "var(--accent, #2563eb)", color: "#fff", border: "1px solid transparent" };
const botaoSecundario: CSSProperties = { ...botao, alignSelf: "flex-start" };
const avisoErro: CSSProperties = { padding: "6px 12px", borderRadius: 8, background: "var(--warning-bg)", border: "1px solid var(--warning-border)", color: "var(--warning-text)", fontSize: 13 };
const avisoOk: CSSProperties = { padding: "6px 12px", borderRadius: 8, background: "var(--info-bg, #dbeafe)", color: "var(--info-text, #1d4ed8)", fontSize: 13 };
const barraDevolver: CSSProperties = { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 };
const botaoDevolver: CSSProperties = { ...botao, marginLeft: "auto", background: "var(--warning-bg)", border: "1px solid var(--warning-border)", color: "var(--warning-text)" };
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

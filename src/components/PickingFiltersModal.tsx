// Filtro Inteligente de picking — MESMO formato do SmartFilter do posvenda:
// lista dos PRODUTOS presentes na fila com checkbox (foto, tamanho, quantidade,
// nº de pedidos), busca, e o rodapé dizendo quantos pedidos serão ocultados.
// Duas abas: Exclusão ("marque o que você NÃO tem" — pedidos com eles somem)
// e Adição (só pedidos com os marcados aparecem). Tudo vale pra FILA e pro
// LOTE (o nexus aplica as mesmas condições) e persiste por estação. ESC fecha.
// Nexus antigo (sem /queue-products) degrada pra entrada manual de termos.
//
// A DATA saiu daqui (0.9.0): virou o seletor "Data" da sidebar, com contagem
// por dia de emissão — do jeito que as separadoras usavam no posvenda. Os
// campos `dateFrom`/`dateTo` continuam sendo o transporte dela nos filtros
// (dia único: `dateFrom === dateTo`), e este modal só os repassa intactos.
//
// A aba Exclusão tem duas listas: a do GALPÃO (servidor, vale pra todas as
// estações — "falta a peça, falta pra todo mundo") e a LOCAL (esta estação).
// O switch "Em todas as estações" decide pra onde vai uma marcação nova. Nexus
// antigo (GET → null) = só a local, sem switch, como antes.
//
// Terceira aba, só nas filas de MISTOS: "Filtro Mistos" (protótipo do Lucas,
// 04/11/2026). Em vez de itens, marca-se PRODUTOS inteiros (todos os
// tamanhos); ficam na fila só os mistos cujas peças de outro tamanho são
// todas desses produtos. A regra e os cálculos vivem em `lib/mistos.ts`.

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { ApiError } from "../lib/api";
import { miniatura } from "../lib/imagens";
import { agregarLote, mesclarProdutos } from "../lib/agregarLote";
import {
  chaveMisto,
  fechamCom,
  pedidosMistos,
  pedidosMistosNosFiltros,
  pickingMistos,
  rankingMistos,
  tamanhosDaLinha,
  textoReservadosPorOutras,
  totalFora,
} from "../lib/mistos";
import { gerarMistosPdf } from "../lib/mistosPdf";
import { printPdfBase64 } from "../lib/printer";
import { folhaDosReservados, separarFolha, textoCarimbo, textoForaDaFolha, textoReservados, type ReservaMistosResultado } from "../lib/reservaMistos";
import {
  adicionarExclusaoGlobal,
  MSG_SO_SUPERVISAO_EXCLUSAO,
  getExclusoesGlobais,
  removerExclusaoGlobal,
  termosGlobais,
  type ExclusoesGlobais,
} from "../services/exclusoesGlobais";
import { getLabelPrinter } from "../services/printerConfig";
import {
  getQueueProducts,
  marcarListaImpressa,
  type ProdutoReservado,
  type CanalSeparacao,
  type Order,
  type QueueFilters,
  type QueueProduct,
  type SeparationMode,
} from "../services/orders";

// v1 era uma chave ÚNICA e GLOBAL — o filtro escolhido na fila "Único M"
// continuava ativo ao entrar em "Misto XG", recortando o lote sem a
// operadora perceber (filtro fantasma). v2 guarda um objeto por fila
// (mode+size, que já identifica uma das 5 filas fixas) dentro da MESMA
// chave do localStorage. A v1 antiga fica pra trás sem migração: não dá
// pra saber de qual fila era aquele filtro salvo, então herdar ele pra
// qualquer fila nova erraria do mesmo jeito — cada fila começa limpa, e o
// pior caso é a operadora reaplicar um filtro que já tinha marcado.
const STORAGE_KEY = "berzerk_picking_filters_v2";
/** Preferência do switch "Em todas as estações" ("1"/"0"). */
const GLOBAL_KEY = "berzerk_exclusao_global_v1";

function fmtQuando(iso: string): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function queueKey(mode: SeparationMode, size: string, canal?: CanalSeparacao): string {
  // Fila do Mercado Livre tem chave própria (`ml:mode:size`): não mistura com o e-commerce.
  return canal === "mercado_livre" ? `ml:${mode}:${size}` : `${mode}:${size}`;
}

export function emptyFilters(): QueueFilters {
  return {};
}

export function loadFilters(mode: SeparationMode, size: string, canal?: CanalSeparacao): QueueFilters {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const all = JSON.parse(raw) as Record<string, QueueFilters | undefined>;
    const f = all[queueKey(mode, size, canal)];
    if (!f) return {};
    // Janela de data salva por uma versão anterior (dateFrom ≠ dateTo) é
    // DESCARTADA: o seletor novo é de dia único e não teria como mostrar a
    // janela — ela ficaria filtrando a fila sem aparecer em lugar nenhum.
    const diaUnico =
      typeof f.dateFrom === "string" && f.dateFrom === f.dateTo ? f.dateFrom : undefined;
    return {
      dateFrom: diaUnico,
      dateTo: diaUnico,
      includeProducts: Array.isArray(f.includeProducts) ? f.includeProducts : undefined,
      excludeProducts: Array.isArray(f.excludeProducts) ? f.excludeProducts : undefined,
      mistosProdutos: Array.isArray(f.mistosProdutos) ? f.mistosProdutos : undefined,
      soUnicos: f.soUnicos === true ? true : undefined,
    };
  } catch {
    return {};
  }
}

export function saveFilters(mode: SeparationMode, size: string, f: QueueFilters, canal?: CanalSeparacao): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, QueueFilters | undefined>) : {};
    all[queueKey(mode, size, canal)] = f;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* localStorage indisponível ou corrompido: filtros valem só na sessão */
  }
}

export type Aba = "exclusao" | "adicao" | "mistos";

type Props = {
  filters: QueueFilters;
  /** Fila ativa — busca os produtos DELA (mesma visão da sidebar).
   *  `sizes` é o BUCKET real (XG cobre XXG/G1/G2/G3; P cobre PP — ver
   *  `src/lib/filas.ts` e o comentário em `src/services/orders.ts`); sem ele
   *  a lista de produtos do filtro fica incompleta em filas P/XG. */
  queue?: { mode: SeparationMode; size: string; sizes?: string[]; canal?: CanalSeparacao };
  /** Lote da operadora (memória). O `queue-products` do nexus só enxerga a
   *  FILA (pedidos sem dono); o que ela já puxou só aparece por aqui. */
  lote?: Order[];
  /** Aba que abre primeiro (o indicador da sidebar abre em "mistos"). */
  abaInicial?: Aba;
  /** `extra.imagens`: produto → imagem dos marcados no Filtro Mistos (miniaturas do indicador da sidebar). */
  onApply: (
    f: QueueFilters,
    extra?: { imagens: Record<string, string | null>; exclusoesGlobais?: ExclusoesGlobais },
  ) => void;
  /** "Imprimir e reservar" (aba Mistos): aplica o filtro e puxa a lista nova no servidor (quem tem a mesa). Ausente = só a folha de consulta. */
  onReservarMistos?: (
    f: QueueFilters,
    extra?: { imagens: Record<string, string | null>; exclusoesGlobais?: ExclusoesGlobais },
  ) => Promise<ReservaMistosResultado>;
  /** Estampas (chave `chaveMisto`) que já estão numa lista impressa em aberto → nº da lista. Ficam desabilitadas ("na Lista N") e fora da seleção. Ausente/vazio = modal como sempre. */
  jaTirados?: ReadonlyMap<string, number>;
  /** Pedidos carimbados no servidor (lista impressa) — a tela marca o lote em memória. */
  onListaImpressa?: (ids: string[], listaId: string | null) => void;
  /** Carimbo + impressão em andamento: a tela segura o `lote()` de fundo (como no Picking Geral). */
  onImprimindo?: (imprimindo: boolean) => void;
  /** Pedidos que ela tem agora no servidor (pra saber quais o carimbo parcial prendeu). */
  onRecarregarPedidos?: () => Promise<Order[]>;
  /** Desfecho do "Imprimir e reservar" no canal de aviso da tela (vale mesmo com o modal fechado/desmontado). */
  onAviso?: (msg: string) => void;
  onClear: () => void;
  onClose: () => void;
};

export function PickingFiltersModal({ filters, queue, lote, abaInicial = "exclusao", onApply, onReservarMistos, jaTirados, onListaImpressa, onImprimindo, onRecarregarPedidos, onAviso, onClear, onClose: onCloseProp }: Props) {
  const [exclude, setExclude] = useState<string[]>(filters.excludeProducts ?? []);
  const [include, setInclude] = useState<string[]>(filters.includeProducts ?? []);
  const [mistos, setMistos] = useState<string[]>(filters.mistosProdutos ?? []);
  const [abaSel, setAba] = useState<Aba>(abaInicial);
  // Exclusão do galpão (servidor). `globais === null` = nexus antigo / ainda carregando.
  const [globais, setGlobais] = useState<ExclusoesGlobais | null>(null);
  const [globalSel, setGlobalSel] = useState<string[]>([]);
  const [globalBase, setGlobalBase] = useState<string[]>([]);
  const [modoGlobal, setModoGlobal] = useState<boolean>(() => {
    try {
      return localStorage.getItem(GLOBAL_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const [salvando, setSalvando] = useState(false);
  const [erroSalvar, setErroSalvar] = useState<string | null>(null);
  const [statusMistos, setStatusMistos] = useState<string | null>(null);
  const [imprimindoMistos, setImprimindoMistos] = useState(false);
  const [search, setSearch] = useState("");
  const [manual, setManual] = useState("");
  const [daFila, setDaFila] = useState<QueueProduct[] | null>(null);
  const [prodErro, setProdErro] = useState<string | null>(null);
  // Filtro Mistos reservado por operadora (Nexus ≥ 05/11; ausente = nexus antigo).
  const [reservados, setReservados] = useState<ProdutoReservado[] | undefined>(undefined);
  const [meusReservados, setMeusReservados] = useState<string[] | undefined>(undefined);
  // A aba Filtro Mistos só existe se o nexus entende `produto` (nexus antigo
  // descarta `mistosProdutos` no claim e reservaria pedidos que a tela esconde).
  const temMistos =
    queue?.mode === "total" &&
    (!!daFila?.some((p) => p.produto != null) || !!lote?.some((o) => o.items.some((i) => i.produto != null)));
  const aba: Aba = abaSel === "mistos" && !temMistos ? "exclusao" : abaSel;

  // Reservando/imprimindo o modal não fecha: o desfecho (carimbo, folha) precisa chegar na tela.
  const onClose = useCallback(() => {
    if (imprimindoMistos) return;
    onCloseProp();
  }, [imprimindoMistos, onCloseProp]);

  // ESC fecha (as atendentes esperam isso do posvenda).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    getExclusoesGlobais()
      .then((g) => {
        if (!alive || !g) return;
        const termos = termosGlobais(g);
        setGlobais(g);
        setGlobalSel(termos);
        setGlobalBase(termos);
        // O local fica intacto (o nexus une); o dedupe é só de exibição.
      })
      .catch(() => {
        /* sem a global a aba segue só com a lista local */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Produtos da fila (refaz quando a data escolhida muda — a lista deve
  // refletir exatamente o que a operadora está vendo).
  const dataSel = filters.dateFrom ?? undefined;
  useEffect(() => {
    if (!queue) return;
    let alive = true;
    setProdErro(null);
    getQueueProducts({
      mode: queue.mode,
      size: queue.size,
      sizes: queue.sizes,
      dateFrom: dataSel,
      dateTo: dataSel,
      canal: queue.canal,
    })
      .then((d) => {
        if (!alive) return;
        setDaFila(d.products);
        setReservados(d.reservados);
        setMeusReservados(d.meusReservados);
      })
      .catch((e) => {
        if (!alive) return;
        setDaFila([]);
        setProdErro(
          e instanceof ApiError && e.status === 404
            ? "O servidor ainda não lista os produtos da fila (aguardando atualização do nexus) — dá pra filtrar digitando o nome abaixo."
            : e instanceof Error
              ? e.message
              : String(e),
        );
      });
    return () => {
      alive = false;
    };
  }, [queue, dataSel]);

  // Fila (servidor) ∪ lote (memória). Enquanto a fila carrega, o lote já
  // aparece — é o que está na mesa dela, e não depende de rede.
  const doLote = useMemo(
    () => (queue && lote?.length ? agregarLote(lote, queue.mode) : []),
    [queue, lote],
  );
  const carregandoFila = !!queue && daFila === null && !prodErro;
  const products = useMemo(() => {
    if (!queue) return null;
    if (daFila === null && doLote.length === 0) return null;
    return mesclarProdutos(queue.mode, daFila ?? [], doLote);
  }, [queue, daFila, doLote]);

  const comGlobal = globais !== null;
  // Só a supervisão edita a lista do galpão (`podeEditar === false`): a lista segue visível, sem controles.
  const globalSoLeitura = globais?.podeEditar === false;
  const modoGlobalEfetivo = modoGlobal && !globalSoLeitura;
  const globalLower = useMemo(() => new Set(globalSel.map((t) => t.toLowerCase())), [globalSel]);
  const selected = useMemo(
    () =>
      aba === "exclusao"
        ? [...globalSel, ...exclude.filter((t) => !globalLower.has(t.toLowerCase()))]
        : include,
    [aba, globalSel, exclude, include, globalLower],
  );
  const selectedLower = useMemo(() => new Set(selected.map((t) => t.toLowerCase())), [selected]);

  const filtered = useMemo(() => {
    if (!products) return [];
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) => p.nome.toLowerCase().includes(q) || (p.ean ?? "").toLowerCase().includes(q),
    );
  }, [products, search]);

  const toggle = (nome: string) => {
    const k = nome.toLowerCase();
    const sem = (l: string[]) => l.filter((t) => t.toLowerCase() !== k);
    const tem = (l: string[]) => l.some((t) => t.toLowerCase() === k);
    if (aba === "adicao") {
      setInclude((prev) => (tem(prev) ? sem(prev) : [...prev, nome]));
      return;
    }
    // Exclusão: desmarcar tira da lista em que o item estiver; marcação nova vai pra do switch.
    if (tem(globalSel) || tem(exclude)) {
      // Desmarcar tira das duas (o item pode estar na global e na local); sem permissão, a global fica.
      if (!globalSoLeitura) setGlobalSel(sem(globalSel));
      setExclude(sem(exclude));
    } else if (comGlobal && modoGlobalEfetivo) setGlobalSel([...globalSel, nome]);
    else setExclude([...exclude, nome]);
  };

  const nExcluidos = globalSel.length + exclude.filter((t) => !globalLower.has(t.toLowerCase())).length;

  const mudarModoGlobal = () => {
    const v = !modoGlobal;
    setModoGlobal(v);
    try {
      localStorage.setItem(GLOBAL_KEY, v ? "1" : "0");
    } catch {
      /* preferência só da sessão */
    }
  };

  /** Origem de um termo marcado na aba Exclusão (null fora dela / sem global). */
  const origemDe = (nome: string): { chave: "galpao" | "local"; title: string } | null => {
    if (aba !== "exclusao" || !comGlobal) return null;
    const k = nome.toLowerCase();
    if (globalLower.has(k)) {
      const g = globais?.termos.find((t) => t.termo.toLowerCase() === k);
      const quando = g?.criadoEm ? fmtQuando(g.criadoEm) : null;
      return {
        chave: "galpao",
        title: g?.criadoPor
          ? `Excluído no galpão por ${g.criadoPor}${quando ? ` em ${quando}` : ""}`
          : "Excluído no galpão",
      };
    }
    return { chave: "local", title: "Só nesta estação" };
  };
  const chipOrigem = (nome: string) => {
    const o = origemDe(nome);
    if (!o) return null;
    return (
      <span style={o.chave === "galpao" ? galpaoChip : localChip} title={o.title}>
        {o.chave === "galpao" ? "galpão" : "só aqui"}
      </span>
    );
  };

  const globalMudou = useMemo(() => {
    const a = [...globalSel.map((t) => t.toLowerCase())].sort().join("\n");
    const b = [...globalBase.map((t) => t.toLowerCase())].sort().join("\n");
    return a !== b;
  }, [globalSel, globalBase]);

  // Termos marcados que NÃO estão na lista atual (persistidos de outra fila,
  // ou digitados à mão) — chips removíveis, senão ficam invisíveis.
  const orfaos = useMemo(() => {
    const nomes = new Set((products ?? []).map((p) => p.nome.toLowerCase()));
    return selected.filter((t) => !nomes.has(t.toLowerCase()));
  }, [selected, products]);

  /** Pedidos afetados pela seleção da aba ativa (união dos orderIds). */
  const pedidosAfetados = useMemo(() => {
    if (!products || selected.length === 0) return 0;
    const ids = new Set<string>();
    for (const p of products) {
      if (selectedLower.has(p.nome.toLowerCase())) for (const id of p.orderIds) ids.add(id);
    }
    return ids.size;
  }, [products, selected, selectedLower]);

  // ---- Filtro Mistos ----
  const pedidosMTodos = useMemo(
    () =>
      temMistos && queue
        ? pedidosMistos({ fila: daFila ?? [], lote: lote ?? [], size: queue.size, sizes: queue.sizes })
        : [],
    [temMistos, queue, daFila, lote],
  );
  // Exclusão que vai valer no claim: a do galpão (como ficar depois do Aplicar,
  // ou a atual se o switch "Em todas as estações" está desligado) ∪ a local.
  // Sem isso o quadro prometia 58 e o servidor entregava 2 (Victor, 07/11).
  const exclusaoAtiva = useMemo(
    () => [...(comGlobal ? (modoGlobalEfetivo ? globalSel : globalBase) : []), ...exclude],
    [comGlobal, modoGlobalEfetivo, globalSel, globalBase, exclude],
  );
  const pedidosM = useMemo(
    () => pedidosMistosNosFiltros(pedidosMTodos, exclusaoAtiva, include),
    [pedidosMTodos, exclusaoAtiva, include],
  );
  const mistosForaPorFiltro = pedidosMTodos.length - pedidosM.length;
  const ranking = useMemo(() => rankingMistos(pedidosM), [pedidosM]);
  const fechados = useMemo(() => (mistos.length ? fechamCom(pedidosM, mistos) : []), [pedidosM, mistos]);
  const pick = useMemo(() => (queue ? pickingMistos(fechados, queue.size) : []), [fechados, queue]);
  const pickPorProduto = useMemo(() => new Map(pick.map((x) => [chaveMisto(x.produto), x])), [pick]);
  const mistosSet = useMemo(() => new Set(mistos.map(chaveMisto)), [mistos]);
  const rankingFiltrado = useMemo(() => {
    const q = semAcento(search.trim());
    return q ? ranking.filter((x) => semAcento(x.produto).includes(q)) : ranking;
  }, [ranking, search]);
  const orfaosMistos = useMemo(() => {
    const noRanking = new Set(ranking.map((x) => chaveMisto(x.produto)));
    return mistos.filter((t) => !noRanking.has(chaveMisto(t)));
  }, [ranking, mistos]);
  const emMistos = aba === "mistos" && temMistos;
  const meusReservadosSet = useMemo(() => new Set((meusReservados ?? []).map(chaveMisto)), [meusReservados]);

  // Estampa já tirada numa lista em aberto sai da seleção (também a que veio do filtro salvo).
  useEffect(() => {
    if (!jaTirados || jaTirados.size === 0) return;
    setMistos((prev) => (prev.some((t) => jaTirados.has(chaveMisto(t))) ? prev.filter((t) => !jaTirados.has(chaveMisto(t))) : prev));
  }, [jaTirados]);

  const toggleMisto = (produto: string) => {
    const k = chaveMisto(produto);
    if (jaTirados?.has(k)) return;
    setMistos((prev) => (prev.some((t) => chaveMisto(t) === k) ? prev.filter((t) => chaveMisto(t) !== k) : [...prev, produto]));
  };

  /** Folha de CONSULTA: não aplica filtro, não carimba, não reserva (a supervisão olha a demanda). */
  const imprimirMistos = async () => {
    if (!queue || imprimindoMistos || fechados.length === 0) return;
    setImprimindoMistos(true);
    setStatusMistos("Enviando pra impressora…");
    try {
      const base64 = gerarMistosPdf({ fila: queue.size, pedidos: fechados.length, linhas: pick, consulta: true });
      const out = await printPdfBase64(base64, {
        printer: getLabelPrinter(),
        jobName: `Mistos ${queue.size} (consulta)`,
      });
      setStatusMistos(
        out.ok
          ? `Enviado${out.printer ? ` pra ${out.printer}` : " pra impressora padrão"}. Folha de CONSULTA — não reserva pedidos.`
          : `Falha ao imprimir: ${out.message ?? "motivo desconhecido"}`,
      );
    } catch (e) {
      setStatusMistos(`Falha ao imprimir: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImprimindoMistos(false);
    }
  };

  /**
   * "Imprimir e reservar": (1) aplica o filtro como o "Aplicar", (2) puxa a lista
   * nova no servidor, (3) CARIMBA os pedidos que ficaram com ela, (4) só então
   * imprime a folha dos pedidos reservados. Carimbo primeiro, papel depois (a
   * mesma ordem do Picking Geral): folha sem carimbo é o "mistos sumiram".
   */
  const imprimirEReservar = async () => {
    if (!queue || !onReservarMistos || imprimindoMistos || mistos.length === 0 || fechados.length === 0) return;
    const prometidos = fechados.length;
    setImprimindoMistos(true);
    setStatusMistos("Aplicando o filtro e reservando os pedidos…");
    // Segura o `lote()` de fundo do começo ao fim (o runner puxa a lista nova por baixo disto).
    onImprimindo?.(true);
    const finalizar = (msg: string) => {
      setStatusMistos(msg);
      onAviso?.(msg);
    };
    try {
      const prep = await prepararFiltros();
      if (!prep) {
        setStatusMistos("O filtro não foi aplicado. Nada foi reservado nem impresso.");
        return;
      }
      const r = await onReservarMistos(prep.f, prep.extra);
      if (!r.ok) {
        finalizar(r.motivo);
        return;
      }
      const novos = r.novos;
      if (novos.length === 0) {
        finalizar("Nenhum pedido novo com essas estampas. Nada foi reservado nem impresso.");
        return;
      }
      // Quem já estava na mão dela (pedido da mesa, já iniciado) é carimbado como no
      // "Tirar nova lista", mas não manda buscar a peça de novo na folha.
      const foraSet = new Set(r.foraDaFolha ?? []);
      const ids = novos.map((o) => o.id);
      const folhaPrevia = folhaDosReservados(novos.filter((o) => !foraSet.has(o.id)), queue.size);
      let listaId: string | null = null;
      let presos = 0;
      try {
        const resultado = await marcarListaImpressa({
          orderIds: ids,
          escopo: "lote",
          filtros: r.filtros,
          secoes: [{ tamanho: "MISTOS", linhas: folhaPrevia.linhas.map((l) => ({ produto: l.produto, qtd: l.total })) }],
        });
        if (resultado.presos <= 0) throw new Error("o servidor não confirmou a lista");
        listaId = resultado.listaId;
        presos = resultado.presos;
      } catch (e) {
        finalizar(
          `Os ${novos.length} pedidos saíram da fila e estão na SUA mesa, mas a lista NÃO foi carimbada (${e instanceof Error ? e.message : String(e)}) ` +
            "e a folha não foi impressa. Sem o carimbo eles podem voltar pra fila se ficarem parados — " +
            "tire a folha agora pelo Picking Geral (Meu lote).",
        );
        return;
      }
      // Carimbo parcial: só entram na folha (e no carimbo local) os que ficaram presos de fato.
      let presosIds = ids;
      const parcial = textoCarimbo(presos, ids.length);
      if (parcial) {
        let meus: Order[] | null = null;
        try {
          meus = onRecarregarPedidos ? await onRecarregarPedidos() : null;
        } catch {
          meus = null;
        }
        if (!meus) {
          finalizar(
            `${parcial} Não consegui conferir quais ficaram presos, então a folha NÃO foi impressa. ` +
              "Tire a folha pelo Picking Geral (Meu lote).",
          );
          return;
        }
        const presosNoServidor = new Set(meus.filter((o) => !!o.listaEm).map((o) => o.id));
        presosIds = ids.filter((id) => presosNoServidor.has(id));
      }
      if (presosIds.length > 0) onListaImpressa?.(presosIds, listaId);
      const presosSet = new Set(presosIds);
      const { paraFolha, fora } = separarFolha(
        novos.filter((o) => presosSet.has(o.id)),
        (o) => foraSet.has(o.id),
      );
      const avisoFora = textoForaDaFolha(fora.length);
      const quantos = [textoReservados(novos.length, prometidos), parcial, avisoFora].filter(Boolean).join(" ");
      if (paraFolha.length === 0) {
        finalizar(
          `${quantos} Nenhum pedido sobrou pra folha (as peças deles já estão com você), então nada foi impresso.`,
        );
        return;
      }
      setStatusMistos("Enviando pra impressora…");
      const folha = folhaDosReservados(paraFolha, queue.size);
      try {
        const base64 = gerarMistosPdf({ fila: queue.size, pedidos: folha.pedidos, linhas: folha.linhas });
        const out = await printPdfBase64(base64, { printer: getLabelPrinter(), jobName: `Mistos ${queue.size}` });
        finalizar(
          out.ok
            ? `${quantos} Folha enviada${out.printer ? ` pra ${out.printer}` : " pra impressora padrão"}; eles ficam com você até o fim do dia.`
            : `${quantos} Falha ao imprimir: ${out.message ?? "motivo desconhecido"}. Os pedidos JÁ estão reservados com você — reimprima pelo Picking Geral (Meu lote).`,
        );
      } catch (e) {
        finalizar(
          `${quantos} Falha ao imprimir: ${e instanceof Error ? e.message : String(e)}. Os pedidos JÁ estão reservados com você — reimprima pelo Picking Geral (Meu lote).`,
        );
      }
    } catch (e) {
      finalizar(`Não deu pra reservar: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      onImprimindo?.(false);
      setImprimindoMistos(false);
    }
  };

  const addManual = () => {
    const t = manual.trim();
    if (t.length < 2) return;
    toggle(t);
    setManual("");
  };

  /**
   * O que o "Aplicar" faz antes de entregar o filtro: grava o diff da exclusão do
   * galpão (termo a termo) e monta o filtro + extras. `null` = não deu pra salvar
   * a exclusão (o erro já está em `erroSalvar`).
   */
  const prepararFiltros = async (): Promise<{
    f: QueueFilters;
    extra: { imagens: Record<string, string | null>; exclusoesGlobais?: ExclusoesGlobais };
  } | null> => {
    let salvas: ExclusoesGlobais | undefined;
    if (comGlobal && globalMudou) {
      setSalvando(true);
      setErroSalvar(null);
      // Diff contra o que a tela carregou: só o que ESTA estação mudou vai pro
      // servidor, termo a termo — nunca "substitui a lista" (apagaria o que
      // outra estação pôs enquanto o modal estava aberto).
      const baseK = new Set(globalBase.map((t) => t.toLowerCase()));
      const selK = new Set(globalSel.map((t) => t.toLowerCase()));
      const entraram = globalSel.filter((t) => !baseK.has(t.toLowerCase()));
      const sairam = globalBase.filter((t) => !selK.has(t.toLowerCase()));
      try {
        for (const t of entraram) {
          const r = await adicionarExclusaoGlobal(t);
          if (!r) throw new Error("o servidor ainda não aceita a exclusão do galpão");
          salvas = r;
        }
        for (const t of sairam) {
          const id = globais?.termos.find((g) => g.termo.toLowerCase() === t.toLowerCase())?.id;
          if (!id) continue;
          const r = await removerExclusaoGlobal(id);
          if (!r) throw new Error("o servidor ainda não aceita a exclusão do galpão");
          salvas = r;
        }
      } catch (e) {
        // O que já salvou fica salvo: o rascunho passa a refletir o servidor.
        try {
          const g = await getExclusoesGlobais();
          if (g) {
            setGlobais(g);
            setGlobalBase(termosGlobais(g));
            setGlobalSel(termosGlobais(g));
          }
        } catch {
          /* mantém o rascunho */
        }
        setErroSalvar(
          e instanceof ApiError && e.status === 403
            ? MSG_SO_SUPERVISAO_EXCLUSAO
            : `Não consegui salvar a exclusão do galpão: ${e instanceof Error ? e.message : String(e)}`,
        );
        setSalvando(false);
        return null;
      }
      if (salvas) {
        // O modal pode seguir aberto (Imprimir e reservar): a base passa a ser o que o servidor tem.
        setGlobais(salvas);
        setGlobalBase(termosGlobais(salvas));
        setGlobalSel(termosGlobais(salvas));
      }
      setSalvando(false);
    }
    const f: QueueFilters = {
      // A data é do seletor da sidebar — passa intacta.
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      excludeProducts: exclude.length ? exclude : undefined,
      includeProducts: include.length ? include : undefined,
      // Sem a aba (fila carregando / nexus antigo) o filtro salvo passa INTACTO —
      // mexer só numa exclusão não pode apagar o Filtro Mistos de ontem.
      mistosProdutos: temMistos ? (mistos.length ? mistos : undefined) : filters.mistosProdutos,
      // "Só únicos" é o botão da sidebar — passa intacto.
      soUnicos: filters.soUnicos,
    };
    const extra = {
      imagens: Object.fromEntries(
        ranking.filter((x) => mistosSet.has(chaveMisto(x.produto))).map((x) => [x.produto, x.imagemUrl]),
      ),
      ...(salvas ? { exclusoesGlobais: salvas } : null),
    };
    return { f, extra };
  };

  const aplicar = async () => {
    if (salvando || imprimindoMistos) return;
    const prep = await prepararFiltros();
    if (prep) onApply(prep.f, prep.extra);
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={box} onClick={(e) => e.stopPropagation()}>
        <div style={headerRow}>
          <h2 style={titulo}>Filtro Inteligente</h2>
          {queue && <span style={filaChip}>Fila {queue.size}</span>}
          <div style={{ flex: 1 }} />
          <button style={fecharBtn} onClick={onClose} title="Fechar (Esc)">
            ×
          </button>
        </div>

        <div style={abasRow}>
          <button style={aba === "exclusao" ? abaOn : abaOff} onClick={() => setAba("exclusao")}>
            Filtro Exclusão{nExcluidos > 0 ? ` (${nExcluidos})` : ""}
          </button>
          <button style={aba === "adicao" ? abaOn : abaOff} onClick={() => setAba("adicao")}>
            Filtro Adição{include.length > 0 ? ` (${include.length})` : ""}
          </button>
          {temMistos && (
            <button style={aba === "mistos" ? abaMistosOn : abaOff} onClick={() => setAba("mistos")}>
              Filtro Mistos{mistos.length > 0 ? ` (${mistos.length})` : ""}
            </button>
          )}
        </div>
        <p style={abaHint}>
          {aba === "mistos" ? (
            <>
              Marque os produtos que ficam nesta separação (em todos os tamanhos) — só ficam na fila os{" "}
              <strong>mistos do {queue?.size}</strong> cujas peças de outro tamanho são <strong>todas</strong>{" "}
              desses produtos.
            </>
          ) : aba === "exclusao" ? (
            <>
              Marque os itens que você <strong>não tem</strong> — pedidos que os contêm{" "}
              <strong>somem</strong> da fila e do claim.
            </>
          ) : (
            <>
              Marque produtos pra ver <strong>só</strong> pedidos que os contêm.
            </>
          )}
        </p>

        {aba === "exclusao" && comGlobal && globalSoLeitura && (
          <div style={globalRow}>
            <small style={mistosSmall} data-testid="global-so-leitura">
              {MSG_SO_SUPERVISAO_EXCLUSAO}
            </small>
          </div>
        )}
        {aba === "exclusao" && comGlobal && !globalSoLeitura && (
          <div style={globalRow}>
            <button style={globalSw} onClick={mudarModoGlobal} role="switch" aria-checked={modoGlobal} title="Em todas as estações">
              <span style={modoGlobal ? swTrackOn : swTrackOff} aria-hidden="true">
                <span style={modoGlobal ? swKnobOn : swKnobOff} />
              </span>
              Em todas as estações
            </button>
            <small style={mistosSmall}>o que você marcar vale pro galpão inteiro</small>
          </div>
        )}

        {emMistos && (
          <div style={quadroMistos} data-testid="quadro-mistos">
            {mistos.length > 0 ? (
              <>
                Com {mistos.length === 1 ? "esse produto" : `esses ${mistos.length} produtos`}{" "}
                <b style={quadroNum}>{fechados.length}</b> mistos do {queue?.size} fecham (de {pedidosM.length}) ·
                picking de <b style={quadroDestaque}>{totalFora(fechados)} peças</b>
                {mistosForaPorFiltro > 0 && (
                  <small style={mistosSmall}>
                    {" "}
                    · {mistosForaPorFiltro} misto{mistosForaPorFiltro === 1 ? "" : "s"} já fora pelo filtro de exclusão/adição
                  </small>
                )}
              </>
            ) : (
              <>
                Do que mais fecha mistos do {queue?.size} sozinho pro que menos. Marque pra ver a grade que
                precisa ser pega.
                {mistosForaPorFiltro > 0 && (
                  <small style={mistosSmall}>
                    {" "}
                    · {mistosForaPorFiltro} misto{mistosForaPorFiltro === 1 ? "" : "s"} já fora pelo filtro de exclusão/adição
                  </small>
                )}
              </>
            )}
          </div>
        )}

        <input
          style={buscaInput}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={emMistos ? "Buscar produto…" : "Buscar produto ou EAN…"}
          spellCheck={false}
        />

        <div style={lista}>
          {prodErro && <div style={avisoBox}>{prodErro}</div>}
          {carregandoFila && <span style={vazio}>Carregando produtos da fila…</span>}
          {!carregandoFila && !emMistos && products !== null && filtered.length === 0 && (
            <span style={vazio}>Nenhum produto encontrado nesta fila nem no seu lote.</span>
          )}
          {!carregandoFila && emMistos && rankingFiltrado.length === 0 && (
            <span style={vazio}>Nenhum misto com peça de outro tamanho nesta fila.</span>
          )}
          {emMistos &&
            rankingFiltrado.slice(0, 300).map((x) => {
              const listaN = jaTirados?.get(chaveMisto(x.produto));
              const marcado = listaN === undefined && mistosSet.has(chaveMisto(x.produto));
              const g = pickPorProduto.get(chaveMisto(x.produto));
              return (
                <button
                  key={chaveMisto(x.produto)}
                  style={listaN !== undefined ? { ...row, opacity: 0.5, cursor: "not-allowed" } : marcado ? rowMistosOn : row}
                  onClick={() => toggleMisto(x.produto)}
                  disabled={listaN !== undefined}
                  title={listaN !== undefined ? `Já está na Lista ${listaN}` : undefined}
                >
                  <span style={marcado ? checkMistosOn : checkOff}>{marcado ? "✓" : ""}</span>
                  {x.imagemUrl ? (
                    <img
                      src={miniatura(x.imagemUrl) ?? undefined}
                      alt=""
                      style={thumbMistos}
                      loading="lazy"
                      decoding="async"
                    />
                  ) : (
                    <span style={{ ...thumbMistos, display: "grid", placeItems: "center", color: "var(--text-faint)", fontWeight: 700 }}>
                      ?
                    </span>
                  )}
                  <span style={mistosNomeCol}>
                    <span style={mistosNome}>{x.produto}</span>
                    {listaN !== undefined && <small style={mistosSmall}>na Lista {listaN}</small>}
                    {marcado && meusReservadosSet.has(chaveMisto(x.produto)) && (
                      <small style={mistosSmall}>reservado pra você</small>
                    )}
                    <small style={mistosSmall}>
                      de outro tamanho em {x.aparece} mistos do {queue?.size}
                    </small>
                    {marcado && queue && (
                      <span style={gradeRow}>
                        {tamanhosDaLinha(g ?? { grade: {} }, queue.size).map((t) => {
                          const n = g?.grade[t] ?? 0;
                          return (
                            <span key={t} style={n ? gradeChip : gradeChipZero}>
                              <b>{t}</b> {n}
                            </span>
                          );
                        })}
                        <span style={pegarChip}>
                          <b>pegar</b> {g?.total ?? 0}
                        </span>
                      </span>
                    )}
                  </span>
                  <span style={sozinhoCol}>
                    <b style={marcado ? sozinhoNumOn : sozinhoNum}>{x.sozinho}</b>
                    <small style={mistosSmall}>fecha sozinho</small>
                  </span>
                </button>
              );
            })}
          {!emMistos && filtered.map((p) => {
            const marcado = selectedLower.has(p.nome.toLowerCase());
            return (
              <button
                key={`${p.nome}|${p.tamanho ?? ""}|${p.ean ?? ""}`}
                style={marcado ? rowOn : row}
                onClick={() => toggle(p.nome)}
              >
                <span style={marcado ? checkOn : checkOff}>{marcado ? "✓" : ""}</span>
                {p.imagemUrl ? (
                  <img
                    src={miniatura(p.imagemUrl) ?? undefined}
                    alt=""
                    style={{ ...thumb, ...(marcado ? thumbOff : null) }}
                    loading="lazy"
                    decoding="async"
                  />
                ) : (
                  <span style={thumbEmpty}>?</span>
                )}
                <span style={{ ...rowNome, ...(marcado && aba === "exclusao" ? rowNomeOff : null) }}>
                  {p.nome}
                </span>
                {p.tamanho && <span style={tamChip}>{p.tamanho}</span>}
                {marcado && chipOrigem(p.nome)}
                {p.noLote && (
                  <span style={loteChip} title="Está num pedido do seu lote">
                    no lote
                  </span>
                )}
                <span style={qtdChip}>{p.quantidade}x</span>
                <span style={pedChip}>
                  {p.pedidos} ped{p.pedidos === 1 ? "" : "s"}
                </span>
              </button>
            );
          })}
          {(emMistos ? orfaosMistos : orfaos).length > 0 && (
            <div style={orfaosWrap}>
              <span style={secaoTitulo}>Marcados fora desta lista</span>
              <div style={orfaosRow}>
                {(emMistos ? orfaosMistos : orfaos).map((t) => (
                  <span key={t} style={orfaoChip}>
                    {t}
                    {!emMistos && chipOrigem(t)}
                    <button style={orfaoRemove} onClick={() => (emMistos ? toggleMisto(t) : toggle(t))} title="Remover">
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {!emMistos && (
        <div style={manualRow}>
          <input
            style={manualInput}
            value={manual}
            placeholder="Adicionar termo manual (ex.: Moletom)…"
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addManual();
              }
            }}
            spellCheck={false}
          />
          <button style={addBtn} onClick={addManual}>
            Adicionar
          </button>
        </div>
        )}

        {erroSalvar && <div style={avisoBox}>{erroSalvar}</div>}
        {emMistos && statusMistos && <div style={statusMistosBox}>{statusMistos}</div>}
        {emMistos && textoReservadosPorOutras(reservados) && (
          <div style={reservadosBox}>{textoReservadosPorOutras(reservados)}</div>
        )}

        <div style={acoesRow}>
          <span style={rodapeInfo}>
            {emMistos ? (
              mistos.length > 0 ? (
                <>
                  <strong>{mistos.length}</strong> produto{mistos.length === 1 ? "" : "s"} marcado
                  {mistos.length === 1 ? "" : "s"}
                </>
              ) : (
                "Nenhum produto marcado"
              )
            ) : selected.length > 0 ? (
              aba === "exclusao" ? (
                <>
                  <strong style={{ color: "var(--danger-text)" }}>{selected.length}</strong>{" "}
                  marcado{selected.length === 1 ? "" : "s"}
                  {comGlobal ? ` · ${globalSel.length} no galpão · ${selected.length - globalSel.length} só aqui` : ""} ·{" "}
                  <strong>{pedidosAfetados}</strong> pedido{pedidosAfetados === 1 ? "" : "s"}{" "}
                  ser{pedidosAfetados === 1 ? "á" : "ão"} ocultado{pedidosAfetados === 1 ? "" : "s"}
                </>
              ) : (
                <>
                  <strong>{pedidosAfetados}</strong> pedido{pedidosAfetados === 1 ? "" : "s"}{" "}
                  fica{pedidosAfetados === 1 ? "" : "m"} visív{pedidosAfetados === 1 ? "el" : "eis"}
                </>
              )
            ) : (
              "Nenhum item marcado"
            )}
          </span>
          <div style={{ flex: 1 }} />
          <button style={limparBtn} onClick={emMistos ? () => setMistos([]) : onClear} disabled={imprimindoMistos}>
            {emMistos ? "Limpar" : "Limpar tudo"}
          </button>
          {aba === "exclusao" && comGlobal && !globalSoLeitura && (
            <button style={limparBtn} onClick={() => setGlobalSel([])} disabled={globalSel.length === 0}>
              Limpar do galpão
            </button>
          )}
          <button style={cancelarBtn} onClick={onClose}>
            Cancelar
          </button>
          {emMistos && mistos.length > 0 && (
            <button
              style={imprimindoMistos ? consultaBtnOff : consultaBtn}
              onClick={() => void imprimirMistos()}
              disabled={imprimindoMistos || fechados.length === 0}
              title="Imprime a folha pra olhar a demanda — NÃO reserva os pedidos"
            >
              Só consultar (não reserva)
            </button>
          )}
          {emMistos && mistos.length > 0 && onReservarMistos && (
            <button
              style={imprimindoMistos ? imprimirMistosBtnOff : imprimirMistosBtn}
              onClick={() => void imprimirEReservar()}
              disabled={imprimindoMistos || salvando || fechados.length === 0}
              title="Tira os pedidos da fila pra todo mundo, deixa só com você e imprime a folha"
            >
              🖨 Imprimir e reservar
            </button>
          )}
          <button style={salvando ? { ...aplicarBtn, opacity: 0.6, cursor: "wait" } : aplicarBtn} onClick={() => void aplicar()} disabled={salvando || imprimindoMistos}>
            {salvando ? "Salvando…" : "Aplicar filtros"}
          </button>
        </div>
      </div>
    </div>
  );
}

function semAcento(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 60,
};

const box: CSSProperties = {
  width: 620,
  maxWidth: "94vw",
  height: "min(720px, 90vh)",
  background: "var(--bg-elevated)",
  border: "1px solid var(--border-strong)",
  borderRadius: 16,
  padding: "20px 22px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  boxSizing: "border-box",
};

const headerRow: CSSProperties = { display: "flex", alignItems: "center", gap: 10 };

const titulo: CSSProperties = { margin: 0, fontSize: 18, fontWeight: 800, color: "var(--text)" };

const filaChip: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  fontWeight: 700,
  padding: "2px 10px",
  borderRadius: 999,
  background: "var(--info-bg)",
  color: "var(--info-text)",
  border: "1px solid var(--info-border)",
};

const fecharBtn: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "var(--text-muted)",
  fontSize: 24,
  fontWeight: 700,
  cursor: "pointer",
  lineHeight: 1,
};

const secaoTitulo: CSSProperties = {
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: 1,
  textTransform: "uppercase",
  color: "var(--text-muted)",
};

const abasRow: CSSProperties = {
  display: "flex",
  gap: 4,
  padding: 4,
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  alignSelf: "flex-start",
};

const abaOff: CSSProperties = {
  padding: "7px 16px",
  background: "transparent",
  border: 0,
  borderRadius: 7,
  color: "var(--text-secondary)",
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
};

const abaOn: CSSProperties = {
  ...abaOff,
  background: "var(--bg-input)",
  color: "var(--text)",
  boxShadow: "inset 0 0 0 1px var(--border-strong)",
};

const abaHint: CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: "var(--text-secondary)",
  lineHeight: 1.4,
};

const buscaInput: CSSProperties = {
  padding: "9px 12px",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: 9,
  color: "var(--text)",
  fontSize: 13,
  outline: "none",
};

const lista: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};

const vazio: CSSProperties = { fontSize: 13, color: "var(--text-muted)", padding: "12px 4px" };

const avisoBox: CSSProperties = {
  padding: "10px 14px",
  background: "var(--warning-bg)",
  border: "1px solid var(--warning-border)",
  borderRadius: 10,
  color: "var(--warning-text)",
  fontSize: 12,
  lineHeight: 1.4,
};

const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 10px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  cursor: "pointer",
  textAlign: "left",
  width: "100%",
  boxSizing: "border-box",
};

const rowOn: CSSProperties = {
  ...row,
  border: "1px solid var(--danger-border)",
  background: "var(--danger-bg)",
};

const checkOff: CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: 6,
  border: "2px solid var(--border-strong)",
  display: "grid",
  placeItems: "center",
  flexShrink: 0,
  fontSize: 13,
  fontWeight: 800,
  color: "transparent",
};

const checkOn: CSSProperties = {
  ...checkOff,
  border: "2px solid var(--danger-text)",
  background: "var(--danger-text)",
  color: "#fff",
};

const thumb: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 6,
  objectFit: "cover",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  flexShrink: 0,
};

const thumbOff: CSSProperties = { opacity: 0.5, filter: "grayscale(1)" };

const thumbEmpty: CSSProperties = {
  ...thumb,
  display: "grid",
  placeItems: "center",
  color: "var(--text-faint)",
  fontSize: 14,
  fontWeight: 700,
};

const rowNome: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 13,
  fontWeight: 600,
  color: "var(--text)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const rowNomeOff: CSSProperties = {
  textDecoration: "line-through",
  color: "var(--text-muted)",
};

const tamChip: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  fontWeight: 700,
  padding: "1px 8px",
  borderRadius: 999,
  background: "var(--bg-input)",
  color: "var(--text)",
  border: "1px solid var(--border-strong)",
  flexShrink: 0,
};

const qtdChip: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  fontWeight: 700,
  color: "var(--text-secondary)",
  flexShrink: 0,
};

const loteChip: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  fontWeight: 700,
  padding: "1px 8px",
  borderRadius: 999,
  background: "var(--success-bg)",
  color: "var(--success-text)",
  border: "1px solid var(--success-border)",
  flexShrink: 0,
};

const pedChip: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  color: "var(--text-muted)",
  flexShrink: 0,
};

const orfaosWrap: CSSProperties = { display: "flex", flexDirection: "column", gap: 6, paddingTop: 6 };

const orfaosRow: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 6 };

const orfaoChip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 6px 3px 10px",
  background: "var(--info-bg)",
  border: "1px solid var(--info-border)",
  borderRadius: 999,
  color: "var(--info-text)",
  fontSize: 12,
  fontWeight: 600,
};

const orfaoRemove: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "inherit",
  fontSize: 14,
  fontWeight: 800,
  cursor: "pointer",
  lineHeight: 1,
  padding: "0 2px",
};

const manualRow: CSSProperties = { display: "flex", gap: 8 };

const manualInput: CSSProperties = {
  flex: 1,
  padding: "8px 12px",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: 9,
  color: "var(--text)",
  fontSize: 12,
  outline: "none",
};

const addBtn: CSSProperties = {
  padding: "8px 14px",
  background: "var(--bg-card)",
  border: "1px solid var(--border-strong)",
  borderRadius: 9,
  color: "var(--text)",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
};

const acoesRow: CSSProperties = { display: "flex", alignItems: "center", gap: 8, marginTop: 2 };

const rodapeInfo: CSSProperties = { fontSize: 12, color: "var(--text-secondary)" };

const limparBtn: CSSProperties = {
  padding: "9px 12px",
  background: "transparent",
  border: "1px dashed var(--border-strong)",
  borderRadius: 9,
  color: "var(--text-muted)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const cancelarBtn: CSSProperties = {
  padding: "9px 14px",
  background: "transparent",
  border: "1px solid var(--border-strong)",
  borderRadius: 9,
  color: "var(--text-secondary)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
};

const aplicarBtn: CSSProperties = {
  padding: "9px 18px",
  background: "var(--success-dot)",
  border: "1px solid var(--success-dot)",
  borderRadius: 9,
  color: "#04150c",
  fontSize: 12,
  fontWeight: 800,
  cursor: "pointer",
};

// ---- Filtro Mistos (âmbar) ----

const abaMistosOn: CSSProperties = {
  ...abaOff,
  background: "var(--warning-bg)",
  color: "var(--warning-text)",
  boxShadow: "inset 0 0 0 1px var(--warning-border)",
};

const quadroMistos: CSSProperties = {
  padding: "10px 14px",
  background: "var(--warning-bg)",
  border: "1px solid var(--warning-border)",
  borderRadius: 10,
  color: "var(--text)",
  fontSize: 13,
  lineHeight: 1.5,
};

const quadroNum: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 28,
  fontWeight: 700,
  color: "var(--warning-text)",
  margin: "0 6px",
  verticalAlign: "middle",
};

const quadroDestaque: CSSProperties = { color: "var(--warning-text)", fontWeight: 800 };

const rowMistosOn: CSSProperties = {
  ...row,
  border: "1px solid var(--warning-border)",
  background: "var(--warning-bg)",
};

const checkMistosOn: CSSProperties = {
  ...checkOff,
  border: "2px solid var(--warning-dot)",
  background: "var(--warning-dot)",
  color: "#1a1405",
};

const thumbMistos: CSSProperties = { ...thumb, width: 42, height: 42 };

const mistosNomeCol: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: 3,
};

const mistosNome: CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: "var(--text)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const mistosSmall: CSSProperties = { fontSize: 11, color: "var(--text-muted)" };

const gradeRow: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 5, marginTop: 3 };

const gradeChip: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  padding: "1px 8px",
  borderRadius: 6,
  background: "var(--bg-input)",
  border: "1px solid var(--border-strong)",
  color: "var(--text)",
};

const gradeChipZero: CSSProperties = {
  ...gradeChip,
  opacity: 0.35,
  border: "1px dashed var(--border-strong)",
};

const pegarChip: CSSProperties = {
  ...gradeChip,
  border: "1px solid var(--warning-border)",
  color: "var(--warning-text)",
};

const sozinhoCol: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  flexShrink: 0,
  minWidth: 78,
};

const sozinhoNum: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 24,
  fontWeight: 700,
  color: "var(--text-secondary)",
  lineHeight: 1.1,
};

const sozinhoNumOn: CSSProperties = { ...sozinhoNum, color: "var(--warning-text)" };

const reservadosBox: CSSProperties = {
  padding: "6px 12px",
  color: "var(--text-faint)",
  fontSize: 12,
  opacity: 0.8,
};

const statusMistosBox: CSSProperties = {
  padding: "8px 12px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 9,
  color: "var(--text-secondary)",
  fontSize: 12,
};

const imprimirMistosBtn: CSSProperties = {
  boxShadow: "0 0 0 1px var(--warning-border)",
  padding: "9px 14px",
  background: "transparent",
  border: "1px solid var(--warning-border)",
  borderRadius: 9,
  color: "var(--warning-text)",
  fontSize: 12,
  fontWeight: 800,
  cursor: "pointer",
};

const imprimirMistosBtnOff: CSSProperties = { ...imprimirMistosBtn, opacity: 0.6, cursor: "wait" };

// ---- Exclusão do galpão ----

const globalRow: CSSProperties = { display: "flex", alignItems: "center", gap: 12 };

const globalSw: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 10,
  padding: "6px 10px",
  background: "var(--bg-card)",
  border: "1px solid var(--border-strong)",
  borderRadius: 9,
  color: "var(--text)",
  fontSize: 12,
  fontWeight: 800,
  cursor: "pointer",
};

const swTrack: CSSProperties = { position: "relative", width: 34, height: 20, borderRadius: 999, flexShrink: 0 };
const swTrackOn: CSSProperties = { ...swTrack, background: "var(--danger-text)" };
const swTrackOff: CSSProperties = { ...swTrack, background: "var(--border-strong)" };
const swKnob: CSSProperties = { position: "absolute", top: 2, width: 16, height: 16, borderRadius: "50%" };
const swKnobOn: CSSProperties = { ...swKnob, right: 2, background: "#fff" };
const swKnobOff: CSSProperties = { ...swKnob, left: 2, background: "var(--text-muted)" };

const galpaoChip: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  fontWeight: 700,
  padding: "1px 8px",
  borderRadius: 999,
  background: "var(--danger-bg)",
  color: "var(--danger-text)",
  border: "1px solid var(--danger-border)",
  flexShrink: 0,
};

const localChip: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  fontWeight: 700,
  padding: "1px 8px",
  borderRadius: 999,
  background: "var(--bg-input)",
  color: "var(--text-secondary)",
  border: "1px solid var(--border-strong)",
  flexShrink: 0,
};
// Ação secundária e discreta: a folha de consulta (não reserva).
const consultaBtn: CSSProperties = { ...limparBtn, border: "1px solid var(--border-strong)" };
const consultaBtnOff: CSSProperties = { ...consultaBtn, opacity: 0.6, cursor: "wait" };

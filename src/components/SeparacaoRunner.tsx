import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type SVGProps,
} from "react";
import { BackButton } from "./BackButton";
import { AmbientBackground } from "./AmbientBackground";
import { OperatorChip } from "./OperatorChip";
import { useRfid, type ReadingSession } from "../contexts/RfidContext";
import { beepError, beepOk } from "../lib/beep";
import { LARGURA_CARD, imagemRedimensionada, miniatura } from "../lib/imagens";
import { subscribeQueueChanged } from "../lib/realtime";
import { onBeforeForcedLogout } from "../lib/idleSession";
import { onAntesDeBloquear } from "../lib/updateGate";
import { SupervisorModal } from "./SupervisorModal";
import { PickingGeralModal } from "./PickingGeralModal";
import { ItensFaltantesModal } from "./ItensFaltantesModal";
import { nomeDaOperadora } from "./OperatorChip";
import { getSessaoSync } from "../lib/cognito";
import { SeparacaoHistoryModal } from "./SeparacaoHistoryModal";
import { PickingFiltersModal, emptyFilters, loadFilters, saveFilters } from "./PickingFiltersModal";
import { ApiError } from "../lib/api";
import {
  claimLote,
  completeSeparacao,
  devolverLote,
  getMe,
  getMeusPedidos,
  getQueueDates,
  iniciarSeparacao,
  releaseSeparacao,
  type EpcLookupItem,
  type LiberacaoFaltante,
  type LeituraResolvida,
  type LiberacaoSupervisor,
  type Order,
  type OrderItem,
  type QueueDatesResponse,
  type QueueFilters,
  type QueueListItem,
  type SeparationMode,
} from "../services/orders";

const SHADOW = import.meta.env.VITE_SEPARACAO_SHADOW === "true";

/** Tamanhos conhecidos pra extrair do nome quando o item vem sem `tamanho`. */
const KNOWN_SIZES = new Set([
  "PP", "P", "M", "G", "GG", "XG", "XXG", "G1", "G2", "G3", "XGG",
]);

/**
 * Tamanho efetivo do item: o campo `tamanho` (normalizado), ou extraído do nome
 * ("Oversized - Leg Day - XG") — pedidos espelhados do legado chegam com
 * `tamanho` null e sem isso o agrupamento do misto quebra. Varre os segmentos
 * de trás pra frente porque o tamanho costuma ser o último ("… - M - Rosa" é a
 * exceção coberta).
 */
function itemSize(it: OrderItem): string | null {
  const direct = it.tamanho?.trim().toUpperCase();
  if (direct) return direct;
  if (!it.nome) return null;
  const tokens = it.nome.split(/\s+[-–]\s+/).map((t) => t.trim().toUpperCase());
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (KNOWN_SIZES.has(tokens[i])) return tokens[i];
  }
  return null;
}

/** Mesma normalização de GTIN do nexus: só dígitos, sem zeros à esquerda. */
function normGtin(v: string | null | undefined): string | null {
  const d = v?.replace(/\D/g, "").replace(/^0+/, "");
  return d || null;
}

function normSku(v: string | null | undefined): string | null {
  const s = v?.trim().toUpperCase();
  return s || null;
}

/**
 * Identificadores GTIN de um item/tag: o EAN e TAMBÉM o SKU quando ele é um
 * código de barras puro (8–14 dígitos) — o Tiny às vezes manda o EAN no campo
 * SKU com `ean` null, e o card até MOSTRA esse número (ean ?? sku), mas o
 * casamento só por `ean` rejeitava a peça (bug real de campo, pedido #793823).
 */
/**
 * Slot "Surpresa": a tag é de uma peça REAL curada pra este slot
 * (`surpresaPermitidos` vem do nexus, já normalizado). Compara por SKU
 * textual e por GTIN (o allowed pode ser EAN). Só se usa por ÚLTIMO no
 * casamento — produto real do pedido primeiro.
 */
function surpresaAceita(it: OrderItem, look: EpcLookupItem): boolean {
  const allowed = it.surpresaPermitidos;
  if (!allowed || allowed.length === 0) return false;
  const keys = new Set<string>(gtinCandidates(look.ean13, look.sku));
  const lookSku = normSku(look.sku);
  if (lookSku) keys.add(lookSku);
  const lookEan = normSku(look.ean13);
  if (lookEan) keys.add(lookEan);
  return allowed.some((a) => {
    const n = normSku(a);
    if (!n) return false;
    return keys.has(n) || gtinCandidates(a).some((g) => keys.has(g));
  });
}

function gtinCandidates(...vals: Array<string | null | undefined>): string[] {
  const out = new Set<string>();
  for (const v of vals) {
    const t = v?.trim();
    if (t && /^\d{8,14}$/.test(t)) {
      const n = normGtin(t);
      if (n) out.add(n);
    }
  }
  return Array.from(out);
}

type Phase = "loading" | "separating" | "empty" | "error";

// ---------------------------------------------------------------------------
// Ordem local do lote e filtro DE EXIBIÇÃO
// ---------------------------------------------------------------------------
//
// Desde 27/08 (nexus #164) o `POST /separacao/lote` devolve TUDO o que já é
// dela no modo+tamanho, IGNORANDO os filtros de data/produto — os filtros
// decidem só o que ENTRA de novo. A mudança consertou um bug feio (a conta de
// posse zerava a cada troca de data e uma operadora acumulou 81 pedidos), mas
// levou junto o efeito que a operação usava: excluir "calça" no filtro e ver a
// sidebar sem calça. Então o RECORTE DE EXIBIÇÃO passa a ser do app: a resposta
// do servidor continua sendo a posse (ninguém devolve pedido por causa de
// filtro), e o que ela VÊ e o que o "próximo" percorre é o subconjunto que bate
// com o filtro. O rodapé conta quantos ficaram ocultos, pra não parecer que
// sumiram.
//
// A regra de casamento é a MESMA do servidor (`produtosNoPedido` em
// `apps/api/src/modules/separacao/separacao.service.ts`): `ilike %termo%` sobre
// o NOME do item — case-insensitive, substring, qualquer item do pedido basta.
// `includes` sobre minúsculas é exatamente isso; `%`/`_` do termo são literais
// dos dois lados (o servidor escapa antes de montar o LIKE).

/** Dia de emissão do pedido em `YYYY-MM-DD` **no fuso de São Paulo** — o mesmo
 *  `at time zone 'America/Sao_Paulo'` que o servidor usa. A estação pode estar
 *  em outro fuso; o dia da operação é sempre o de SP. */
function diaDeEmissao(o: Order): string | null {
  if (!o.dataEmissao) return null;
  const d = new Date(o.dataEmissao);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

/** Algum item do pedido cujo nome contém algum dos termos (mesmo `ilike %t%`). */
function pedidoTemProduto(o: Order, termos: string[]): boolean {
  const alvos = termos.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0);
  if (alvos.length === 0) return false;
  return o.items.some((it) => {
    const nome = (it.nome ?? "").toLowerCase();
    return alvos.some((t) => nome.includes(t));
  });
}

/** O pedido passa pelos filtros ATIVOS (data de emissão + inclui/exclui produto). */
function passaNosFiltros(o: Order, f: QueueFilters): boolean {
  if (f.dateFrom || f.dateTo) {
    // Pedido sem data de emissão não passa em filtro de data — é o que o SQL
    // faz (`null::date >= x` é NULL, e NULL não entra no WHERE).
    const dia = diaDeEmissao(o);
    if (!dia) return false;
    if (f.dateFrom && dia < f.dateFrom) return false;
    if (f.dateTo && dia > f.dateTo) return false;
  }
  if (f.includeProducts?.length && !pedidoTemProduto(o, f.includeProducts)) return false;
  if (f.excludeProducts?.length && pedidoTemProduto(o, f.excludeProducts)) return false;
  return true;
}

/**
 * O lote na ORDEM em que ela ataca: a ordem do servidor (prioritário, depois
 * FIFO), com os PULADOS no fim — "a peça ainda não chegou da dobra" tira o
 * pedido da vez sem tirar do lote dela. Pular não fala com o servidor: o pedido
 * continua reservado, só muda de lugar na fila local.
 */
function ordenarLote(lote: Order[], pulados: Set<string>): Order[] {
  if (pulados.size === 0) return lote;
  return [...lote.filter((o) => !pulados.has(o.id)), ...lote.filter((o) => pulados.has(o.id))];
}

/** A lista que a sidebar mostra e que o "próximo" percorre. */
function loteVisivel(lote: Order[], pulados: Set<string>, filters: QueueFilters): Order[] {
  return ordenarLote(lote, pulados).filter((o) => passaNosFiltros(o, filters));
}

/** 422 `{ error: "liberacao_necessaria", faltantes }` do complete → lista de
 *  faltantes do servidor (vazia se o body não trouxe); null se é outro erro. */
function liberacaoNecessaria(e: unknown): LiberacaoFaltante[] | null {
  if (!(e instanceof ApiError) || !e.body || typeof e.body !== "object") return null;
  const body = e.body as { error?: unknown; faltantes?: unknown };
  if (body.error !== "liberacao_necessaria") return null;
  if (!Array.isArray(body.faltantes)) return [];
  return body.faltantes
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .map((f) => ({
      itemId: String(f.itemId ?? ""),
      nome: typeof f.nome === "string" ? f.nome : null,
      tamanho: typeof f.tamanho === "string" ? f.tamanho : null,
      faltam: typeof f.faltam === "number" ? f.faltam : 1,
    }));
}

/** Progresso de conferência de um item. */
type ItemProgress = { count: number; epcs: string[] };

/**
 * Sobressalente: tag lida que NÃO cabe no pedido. `excedente` = unidade a mais
 * de um produto do pedido; `alheia` = peça de outro pedido; `desconhecida` =
 * EPC que nenhuma fonte resolveu. Enquanto houver sobressalente o pedido NÃO
 * conclui (paridade com o legado: ele garantia só o faltante; aqui garantimos
 * também que não vai peça a mais) — a operadora tira a peça da mesa e
 * reinicia a leitura (R).
 */
type ExtraTag = {
  epc: string;
  label: string;
  kind: "excedente" | "alheia" | "desconhecida";
  /** Item do pedido excedido (pinta o card de vermelho). */
  itemId?: string;
  /** Foto da peça (quando é excedente de item do pedido) — ajuda a achar na mesa. */
  imagemUrl?: string | null;
};

/** Entrada do console de leitura (o que o leitor viu e como resolvemos). */
type LogEntry = {
  ts: number;
  epc: string;
  desc: string;
  status: "ok" | "extra" | "unknown";
};

const LOG_MAX = 50;

type Props = {
  title: string;
  kicker: string;
  /** Texto quando a fila esvazia. */
  emptyHint: string;
  /**
   * Fila ativa. `size` é o rótulo (uma das 5 filas fixas) e `sizes` são os
   * tamanhos REAIS do bucket — é a lista que vai no lote, pra XG cobrir
   * XXG/G1/G2/G3 e nenhum pedido ficar órfão.
   */
  queue: { mode: SeparationMode; size: string; sizes: string[] };
  /**
   * Entrou RETOMANDO uma lista de picking já impressa. Nesse caso o app NÃO
   * puxa pedido novo: a folha na mão da coleta tem exatamente estes números, e
   * completar o lote até o alvo colocaria na mesa pedido que não está nela.
   */
  retomandoLista?: boolean;
  onBack: () => void;
};

export function SeparacaoRunner({
  title,
  kicker,
  emptyHint,
  queue,
  retomandoLista,
  onBack,
}: Props) {
  const rfid = useRfid();
  const [phase, setPhase] = useState<Phase>("loading");
  const [order, setOrder] = useState<Order | null>(null);
  // LOTE da operadora (0.9.0): ela entra na fila e leva um punhado de pedidos
  // que aparecem SÓ pra ela — a sidebar é o lote, não a fila inteira. Puxar 1
  // por vez era o que as separadoras reclamavam no cutover.
  //
  // Desde a 0.9.3 quem decide o TAMANHO é o servidor (configuração
  // `separacao_lote_tamanho`), e quando a fila esgota ele REDISTRIBUI: uma
  // estação que entra numa fila vazia recebe metade do lote de quem já estava.
  // Por isso a resposta do `claimLote` SUBSTITUI a sidebar inteira — ela pode
  // vir menor. O que ela já abriu pra conferir está protegido pelo
  // `iniciarSeparacao` (ver o efeito mais abaixo).
  const [lote, setLote] = useState<Order[]>([]);
  /** Pedidos ainda SEM DONO na fila (o "faltam X"). null = servidor não disse. */
  const [restantes, setRestantes] = useState<number | null>(null);
  const loteRef = useRef<Order[]>([]);
  /** Ids na ordem que a sidebar mostra (ordem local + filtros) — a base do
   *  "próximo". Preenchido no corpo do render, lido dentro dos callbacks. */
  const sequenciaRef = useRef<string[]>([]);
  /**
   * Ela entrou RETOMANDO uma lista de picking impressa: o lote não se completa
   * sozinho, porque a folha na mão da coleta tem exatamente aqueles números.
   * Ref, e não o prop direto, porque a trava CAI quando ela devolve a lista
   * pelo banner — sem isso a mesa ficaria presa ao `meus-pedidos` até fechar a
   * tela, sem puxar pedido novo nenhum.
   */
  const presaNaListaRef = useRef(retomandoLista === true);
  const [error, setError] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const completingRef = useRef(false);
  /** Uma reposição por vez — o push do WS não pode atropelar a do complete. */
  const puxandoRef = useRef(false);
  // progresso por item (ref pra ler dentro do closure de leitura; state pra render)
  const progressRef = useRef<Map<string, ItemProgress>>(new Map());
  // Sobressalentes por EPC (bloqueiam o Concluir até reiniciar a leitura).
  const extrasRef = useRef<Map<string, ExtraTag>>(new Map());
  // Console de leitura (mais novo primeiro, cap LOG_MAX).
  const logRef = useRef<LogEntry[]>([]);
  const [, forceRender] = useState(0);
  const tick = () => forceRender((n) => n + 1);
  const orderRef = useRef<Order | null>(null);
  orderRef.current = order;
  loteRef.current = lote;
  // Época da leitura: bump = reset da sessão (zera dedupe + limpa o buffer da
  // mesa, sem desarmar o leitor) — é o "Reiniciar (R)".
  const [sessionEpoch, setSessionEpoch] = useState(0);
  // Filtros de picking (data + produtos) — por estação, sobrevivem a reload.
  const [filters, setFilters] = useState<QueueFilters>(() => loadFilters());
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  /**
   * Pedidos PULADOS: a peça ainda não chegou da dobra, então o pedido vai pro
   * FIM da ordem local e ela segue. Continua reservado pra ela (nenhuma
   * chamada ao servidor) — pular é decisão de ordem, não de posse.
   */
  const [pulados, setPulados] = useState<Set<string>>(() => new Set<string>());
  const puladosRef = useRef(pulados);
  puladosRef.current = pulados;
  /**
   * Trava `separacao_liberacao_supervisor_ativa` do nexus, lida do `/me` ao
   * entrar na fila. `true` (exigir PIN) é o padrão e o que vale enquanto a
   * resposta não chega, com nexus antigo ou se o `/me` falhar: afrouxar uma
   * trava por causa de rede seria o erro caro.
   */
  const [exigirSupervisor, setExigirSupervisor] = useState(true);
  const exigirSupervisorRef = useRef(true);
  exigirSupervisorRef.current = exigirSupervisor;
  // Aviso não-bloqueante (claim por clique falhou, degradação de endpoint…).
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = useCallback((msg: string) => {
    setNotice(msg);
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = setTimeout(() => setNotice(null), 8000);
  }, []);

  const resetLeitura = useCallback(() => {
    progressRef.current = new Map();
    extrasRef.current = new Map();
    logRef.current = [];
    setServerFaltantes(null);
  }, []);

  /**
   * Ids na ordem de tentativa a PARTIR do pedido que acabou de sair da mesa:
   * primeiro os que vinham depois dele, depois (dando a volta) os anteriores.
   * É o que faz "concluí o 3º" abrir o 4º, e não o 1º de novo.
   */
  /** Pedidos que já receberam o `POST /separacao/:id/iniciar` nesta sessão —
   *  podado a cada `puxarLote` pro Set não virar o histórico do turno. */
  const iniciadosRef = useRef<Set<string>>(new Set());

  const candidatosDepoisDe = useCallback((id: string): string[] => {
    const seq = sequenciaRef.current;
    const i = seq.indexOf(id);
    if (i < 0) return seq;
    return [...seq.slice(i + 1), ...seq.slice(0, i)];
  }, []);

  /**
   * (Re)carrega o lote e coloca um pedido na mesa. É o MESMO caminho pra
   * entrar na fila e pra repor depois de concluir/devolver: o endpoint é
   * idempotente (devolve tudo o que já é dela e completa até o alvo do
   * servidor), então chamar de novo nunca duplica nem perde pedido.
   *
   * `preservarAtual` mantém na mesa o pedido que a operadora está conferindo
   * (troca de filtro/data no meio do pedido não pode zerar a leitura dela).
   *
   * `depoisDe` é o pedido que ACABOU de sair (concluído/devolvido): a mesa
   * segue SEQUENCIAL a partir dele, e só volta pro começo quando não sobrou
   * nenhum dos que vinham depois — que é exatamente o caso "a lista acabou, o
   * servidor repôs, continue do primeiro NOVO". Sem isso a mesa voltava pro
   * primeiro card a cada conclusão, e as separadoras reconferiam o que já
   * tinham feito (relato do 1º dia na 0.9.4).
   */
  const puxarLote = useCallback(
    async (opts?: { preservarAtual?: boolean; depoisDe?: string }) => {
      // Reposição em background (push do WS, troca de filtro) cede a vez: o
      // caminho do complete já vai repor, e duas chamadas em voo trocariam o
      // pedido da mesa no meio da conferência.
      if (opts?.preservarAtual && (puxandoRef.current || completingRef.current)) return;
      const atual = opts?.preservarAtual ? orderRef.current : null;
      const filtrosDaVez = filtersRef.current;
      if (!atual) {
        setPhase("loading");
        resetLeitura();
      }
      setError(null);
      puxandoRef.current = true;
      try {
        // LISTA IMPRESSA na mesa: não puxa pedido novo, só recarrega o que já é
        // dela. A folha que a coleta está usando lista exatamente estes
        // números; completar o lote até o alvo colocaria peça na mesa sem
        // ninguém ter ido buscar. Volta ao normal sozinho quando o último
        // pedido da lista sair (concluído ou devolvido).
        const presaEmLista = presaNaListaRef.current || loteRef.current.some((o) => !!o.listaEm);
        const { orders, fila } = presaEmLista
          ? { ...(await getMeusPedidos()), fila: undefined }
          : await claimLote({
              mode: queue.mode,
              sizes: queue.sizes,
              filters: filtersRef.current,
            });
        // Ordem de tentativa capturada ANTES de o lote ser substituído — a
        // sequência nova já não sabe onde o pedido concluído estava.
        const candidatos = opts?.depoisDe ? candidatosDepoisDe(opts.depoisDe) : [];
        setLote(orders);
        loteRef.current = orders;
        // Pulado que saiu do lote (concluído por ela, devolvido, redistribuído)
        // não pode continuar marcado: se o pedido voltar, volta do zero.
        const idsAgora = new Set(orders.map((o) => o.id));
        // A marca de "já avisei o servidor que abri este pedido" só interessa
        // enquanto o pedido é dela. Sem podar, o Set acumulava um id por
        // pedido separado — o turno inteiro de conclusões nunca saía da
        // memória, e a informação já não servia pra nada.
        for (const id of iniciadosRef.current) if (!idsAgora.has(id)) iniciadosRef.current.delete(id);
        setPulados((atuais) => {
          const restantes = new Set([...atuais].filter((id) => idsAgora.has(id)));
          return restantes.size === atuais.size ? atuais : restantes;
        });
        setRestantes(fila?.restantes ?? null);
        const aindaMeu = atual ? orders.find((o) => o.id === atual.id) : undefined;
        // O pedido da mesa SUMIU da resposta: o servidor o redistribuiu pra
        // outra estação (só acontece com pedido não iniciado — o
        // `iniciarSeparacao` trava isso — ou se um supervisor destravou).
        // Nunca deixar ela concluir o que já não é dela: volta pro lote com o
        // aviso, em vez de mandar um complete que o servidor recusa com 409.
        if (atual && !aindaMeu) {
          showNotice("Este pedido foi redistribuído para outra estação. Continue pelo lote.");
        }
        // O "próximo" percorre a lista VISÍVEL (ordem local + filtros), nunca a
        // resposta crua: o que está oculto pelo filtro não pode cair na mesa.
        const visiveisAgora = loteVisivel(orders, puladosRef.current, filtrosDaVez);
        const proximo =
          aindaMeu ??
          candidatos.map((id) => visiveisAgora.find((o) => o.id === id)).find(Boolean) ??
          visiveisAgora[0] ??
          null;
        if (proximo?.id !== atual?.id) resetLeitura();
        setOrder(proximo);
        setPhase(proximo ? "separating" : "empty");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Com pedido na mesa a falha é só aviso: o lote dela continua válido.
        if (atual) {
          showNotice(`Não deu pra atualizar o lote: ${msg}`);
          return;
        }
        setError(msg);
        setPhase("error");
      } finally {
        puxandoRef.current = false;
      }
    },
    [queue.mode, queue.sizes, resetLeitura, showNotice, candidatosDepoisDe],
  );

  // Entrar na fila = puxar o lote.
  useEffect(() => {
    void puxarLote();
  }, [puxarLote]);

  // A trava da liberação por supervisor vem do `/me` ao entrar na fila. Falhou
  // (rede, nexus antigo sem o campo)? Fica no padrão: EXIGIR.
  useEffect(() => {
    let alive = true;
    getMe()
      .then((me) => {
        if (alive) setExigirSupervisor(me.liberacaoSupervisorAtiva ?? true);
      })
      .catch(() => {
        /* padrão seguro já está no state */
      });
    return () => {
      alive = false;
    };
  }, []);

  // Reposição por push: `queue.changed` (pedido novo do tiny-sync, pedido
  // devolvido por outra estação) completa o lote sem a operadora fazer nada —
  // é o que tira o "Procurar de novo" do caminho quando a fila estava vazia.
  // Debounce porque o evento vem em rajada num sync; `preservarAtual` garante
  // que o pedido em conferência não sai da mesa.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = subscribeQueueChanged(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void puxarLote({ preservarAtual: true }), 3000);
    });
    return () => {
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [puxarLote]);

  /**
   * Avisa o servidor que ela ABRIU o pedido pra conferir. É o que impede a
   * redistribuição de tirar da mesa dela um pedido cujas peças já estão na
   * bancada: o `POST /separacao/lote` de outra estação só pode levar pedido
   * SEM `iniciado_em`.
   *
   * Uma vez por pedido (o `Set` evita repetir a cada render), best-effort —
   * falha de rede não trava a conferência, e o id sai do `Set` pra tentativa
   * acontecer de novo quando a janela voltar ao foco.
   */
  const marcarIniciado = useCallback((orderId: string) => {
    if (iniciadosRef.current.has(orderId)) return;
    iniciadosRef.current.add(orderId);
    void iniciarSeparacao(orderId).catch(() => {
      iniciadosRef.current.delete(orderId);
    });
  }, []);

  useEffect(() => {
    if (!order) return;
    marcarIniciado(order.id);
  }, [order, marcarIniciado]);

  // Retentativa no foco: se a marca não subiu (rede caiu), o pedido da mesa
  // fica exposto à redistribuição até a próxima chance.
  useEffect(() => {
    const aoFocar = () => {
      const ord = orderRef.current;
      if (ord) marcarIniciado(ord.id);
    };
    window.addEventListener("focus", aoFocar);
    return () => window.removeEventListener("focus", aoFocar);
  }, [marcarIniciado]);

  const allDone = useCallback((ord: Order): boolean => {
    const prog = progressRef.current;
    return ord.items.every((it) => (prog.get(it.id)?.count ?? 0) >= it.quantidade);
  }, []);

  const collectedTags = useCallback((): string[] => {
    const tags: string[] = [];
    for (const p of progressRef.current.values()) tags.push(...p.epcs);
    return tags;
  }, []);

  /** Resolução que o app fez de cada EPC lido (cache — sem ida à rede na
   *  prática), pro nexus usar de fallback quando o EPC não está na réplica. */
  const resolveEpcs = rfid.resolveEpcs;
  const leiturasPayload = useCallback(
    async (tags: string[]): Promise<LeituraResolvida[]> => {
      try {
        const map = await resolveEpcs(tags);
        return tags.flatMap((t) => {
          const epc = t.toUpperCase();
          const l = map.get(epc);
          return l ? [{ epc, ean13: l.ean13, sku: l.sku, size: l.size, name: l.name ?? null }] : [];
        });
      } catch {
        return [];
      }
    },
    [resolveEpcs],
  );

  const finish = useCallback(async () => {
    const ord = orderRef.current;
    // Sobressalente na mesa TRAVA o complete — senão iria peça a mais.
    if (!ord || completing || extrasRef.current.size > 0) return;
    setCompleting(true);
    completingRef.current = true;
    try {
      const tags = collectedTags();
      await completeSeparacao(ord.id, tags, undefined, await leiturasPayload(tags));
      // Reposição: o lote volta a ter 10 (ou o que a fila ainda tiver) e a mesa
      // abre o pedido SEGUINTE a este, não o primeiro card.
      await puxarLote({ depoisDe: ord.id });
    } catch (e) {
      // 422 `liberacao_necessaria`: a contagem local fechou mas o servidor NÃO
      // reconheceu todas as peças (EPC fora do inventário do nexus, surpresa
      // sem mapping…). Contrato da liberação: abre o modal do supervisor com
      // os faltantes DO SERVIDOR e diz QUAL peça — antes virava "HTTP 422" mudo
      // e o pedido não saía de jeito nenhum (go-live XG, 21/08).
      const srv = liberacaoNecessaria(e);
      if (srv) {
        setServerFaltantes(srv.length > 0 ? srv : null);
        setSupervisorOpen(true);
        const quais = srv
          .map((f) => `${f.nome ?? "item"}${f.tamanho ? ` ${f.tamanho}` : ""} (faltam ${f.faltam})`)
          .slice(0, 4)
          .join(", ");
        showNotice(
          srv.length > 0
            ? `O servidor não reconheceu a leitura de: ${quais}. Confira a peça na mesa (releia com R) ou libere com supervisor.`
            : "O servidor exige liberação de supervisor pra concluir este pedido.",
        );
        return;
      }
      // Banner (não setError): a fase segue "separating" e o setError só
      // renderiza na fase de erro — sem isso a falha do complete ficava muda.
      // Recusa de negócio do nexus (`{ error, message }` — ex.: JT_TRACKING_REQUIRED:
      // pedido J&T cuja etiqueta ainda não chegou) já vem com mensagem pro
      // operador; "tenta de novo" só confunde nesses casos.
      const negocio = e instanceof ApiError && !!e.body && typeof e.body === "object" && "error" in e.body;
      const msg = e instanceof Error ? e.message : String(e);
      showNotice(negocio ? `Não dá pra concluir: ${msg}` : `Falha ao concluir: ${msg} — tenta de novo ou chama o suporte.`);
    } finally {
      completingRef.current = false;
      setCompleting(false);
    }
  }, [completing, collectedTags, puxarLote, showNotice, leiturasPayload]);

  /**
   * Reinicia a conferência do pedido atual: a operadora tirou a peça errada da
   * mesa e relê tudo do zero (as peças certas continuam lá e voltam no próximo
   * inventário). Zera progresso/sobressalentes/console e reseta a sessão de
   * leitura — limpa o buffer físico da mesa sem desarmar o leitor.
   */
  const restartLeitura = useCallback(() => {
    if (completing) return;
    resetLeitura();
    setSessionEpoch((n) => n + 1);
    tick();
  }, [completing, resetLeitura]);

  /**
   * Troca o pedido da mesa por outro DO PRÓPRIO LOTE (clique no card). Sem
   * release nem claim: os dez já estão reservados pra ela — decidir a ordem de
   * atacar é escolha local, não ida ao servidor.
   */
  const selecionarPedido = useCallback(
    (alvo: Order) => {
      if (completing || orderRef.current?.id === alvo.id) return;
      resetLeitura();
      setOrder(alvo);
      setPhase("separating");
    },
    [completing, resetLeitura],
  );

  /** Devolve SÓ o pedido da mesa e repõe o lote (o resto continua dela). */
  const devolverAtual = useCallback(async () => {
    const ord = orderRef.current;
    if (!ord || completing) return;
    setPhase("loading");
    orderRef.current = null;
    setOrder(null);
    await releaseSeparacao(ord.id).catch(() => {
      /* best-effort: o janitor recupera */
    });
    await puxarLote({ depoisDe: ord.id });
  }, [completing, puxarLote]);

  /**
   * PULAR (27/08): a peça ainda não chegou da dobra. O pedido CONTINUA dela —
   * nenhuma chamada ao servidor além do `iniciar` que o próximo disparar — só
   * vai pro fim da ordem local e a mesa segue pro seguinte. Os pulados voltam
   * depois do último, e a marca cai sozinha quando o pedido sai do lote.
   */
  const pularAtual = useCallback(() => {
    const ord = orderRef.current;
    if (!ord || completing) return;
    const candidatos = candidatosDepoisDe(ord.id);
    const puladosNovos = new Set(puladosRef.current).add(ord.id);
    const visiveisAgora = loteVisivel(loteRef.current, puladosNovos, filtersRef.current);
    const proximo =
      candidatos.map((id) => visiveisAgora.find((o) => o.id === id)).find(Boolean) ??
      visiveisAgora.find((o) => o.id !== ord.id) ??
      null;
    // Sobrou só ele: nem marca como pulado (a marca sem efeito só confundiria).
    if (!proximo) {
      showNotice("Este é o único pedido do seu lote agora — não há pra onde pular.");
      return;
    }
    puladosRef.current = puladosNovos;
    setPulados(puladosNovos);
    resetLeitura();
    setOrder(proximo);
    setPhase("separating");
  }, [completing, candidatosDepoisDe, resetLeitura, showNotice]);

  /**
   * Sair da fila devolve o LOTE INTEIRO. Sem isto os pedidos reservados
   * ficariam invisíveis pras outras estações até o janitor expirar o claim —
   * que é justamente o que o lote não pode causar.
   */
  const saindoRef = useRef(false);
  const devolverTudo = useCallback(async (opts?: { incluirLista?: boolean }) => {
    if (saindoRef.current) return;
    // Devolve SÓ os ids que ela tem de fato. Sem lista o servidor devolveria
    // "todos os em aberto" — e o remonte do StrictMode (dev) chegaria aqui com
    // o lote ainda em voo, jogando fora o que acabou de ser reservado.
    //
    // Pedido com LISTA impressa fica FORA das devoluções automáticas (sair da
    // tela, logout por inatividade, bloqueio de atualização): o `devolver` do
    // nexus limpa o `lista_em` junto, e a folha que a coleta está carregando
    // viraria papel de pedido que já é de outra estação. Ela é dela até o fim
    // do dia — a tela de filas oferece Retomar/Devolver. Só a ação EXPLÍCITA
    // do banner ("devolver à fila") leva a lista junto.
    const ids = loteRef.current
      .filter((o) => opts?.incluirLista === true || !o.listaEm)
      .map((o) => o.id);
    if (ids.length === 0) return;
    saindoRef.current = true;
    orderRef.current = null;
    await devolverLote(ids).catch(() => {
      /* best-effort: o janitor recupera */
    });
  }, []);

  // === Liberação por supervisor (concluir SEM todas as peças no RFID) ===
  const [supervisorOpen, setSupervisorOpen] = useState(false);
  /** Faltantes segundo o SERVIDOR (422 `liberacao_necessaria`). Prevalecem
   *  sobre a contagem local no modal: o nexus resolve EPC→peça pelo inventário
   *  dele (rfid_epc_inventory), o app pela nuvem iTAG — quando divergem, o que
   *  vale pro complete é o que o servidor enxerga. */
  const [serverFaltantes, setServerFaltantes] = useState<LiberacaoFaltante[] | null>(null);

  /** Itens com saldo não lido — contexto do modal + auditoria no nexus. */
  const faltantes = useCallback((): LiberacaoFaltante[] => {
    const ord = orderRef.current;
    if (!ord) return [];
    return ord.items
      .map((it) => ({
        itemId: it.id,
        nome: it.nome,
        tamanho: itemSize(it),
        faltam: it.quantidade - (progressRef.current.get(it.id)?.count ?? 0),
      }))
      .filter((f) => f.faltam > 0);
  }, []);

  /**
   * O que **K** (e o botão ao lado do Concluir) faz, agora que a exigência do
   * supervisor é uma configuração:
   *
   *  - trava LIGADA → abre o diálogo do PIN, como sempre;
   *  - trava DESLIGADA → conclui direto, com um confirm dizendo quantas peças
   *    faltam. Se o servidor ainda assim recusar (a trava mudou depois do
   *    `/me`, ou o nexus é anterior à flag), o 422 `liberacao_necessaria` do
   *    `finish` abre o diálogo do PIN — o caminho antigo continua inteiro.
   */
  const liberarOuConcluir = useCallback(() => {
    const ord = orderRef.current;
    if (!ord || completing) return;
    if (exigirSupervisorRef.current) {
      setSupervisorOpen(true);
      return;
    }
    if (extrasRef.current.size > 0) {
      showNotice("Tire a peça sobressalente da mesa e reinicie a leitura (R) antes de concluir.");
      return;
    }
    const faltam = faltantes().reduce((a, f) => a + f.faltam, 0);
    if (
      faltam > 0 &&
      !window.confirm(`Faltam ${faltam} ${faltam === 1 ? "peça" : "peças"} — concluir mesmo assim?`)
    ) {
      return;
    }
    void finish();
  }, [completing, faltantes, finish, showNotice]);

  const supervisorConfirm = useCallback(
    async (liberacao: LiberacaoSupervisor) => {
      const ord = orderRef.current;
      if (!ord) return;
      // Erros sobem pro modal (PIN errado etc.) — só fecha quando concluir.
      const tags = collectedTags();
      await completeSeparacao(ord.id, tags, liberacao, await leiturasPayload(tags));
      setSupervisorOpen(false);
      setServerFaltantes(null);
      await puxarLote({ depoisDe: ord.id });
    },
    [collectedTags, puxarLote, leiturasPayload],
  );

  // Acha o item esperado que casa com a tag lida. Casa por QUALQUER
  // identificador GTIN dos dois lados (ean OU sku-que-é-código-de-barras,
  // normalizados — Tiny mistura os campos), com fallback de SKU textual.
  const matchItem = useCallback((ord: Order, look: EpcLookupItem): OrderItem | null => {
    const prog = progressRef.current;
    const remaining = (it: OrderItem) => it.quantidade - (prog.get(it.id)?.count ?? 0);
    const tagGtins = gtinCandidates(look.ean13, look.sku);
    // 1) GTIN cruzado (ean↔ean, ean↔sku-numérico, etc.)
    const byGtin = ord.items.find((it) => {
      if (remaining(it) <= 0) return false;
      const itemGtins = gtinCandidates(it.ean, it.sku);
      return tagGtins.some((g) => itemGtins.includes(g));
    });
    if (byGtin) return byGtin;
    // 2) skuEquivalence: mesmo SKU textual (EAN legado do mesmo produto/tamanho)
    const lookSku = normSku(look.sku);
    const bySku = ord.items.find(
      (it) => lookSku && normSku(it.sku) === lookSku && remaining(it) > 0,
    );
    if (bySku) return bySku;
    // 3) Slot "Surpresa": peça real curada pro slot (mesma etapa do nexus).
    const bySurpresa = ord.items.find((it) => remaining(it) > 0 && surpresaAceita(it, look));
    if (bySurpresa) return bySurpresa;
    return null;
  }, []);

  /**
   * Item do pedido que a tag referencia IGNORANDO o saldo — usado pra
   * classificar sobressalente: se casa aqui mas não no matchItem, é unidade a
   * MAIS de um produto do pedido (excedente), não peça alheia.
   */
  const itemDoPedido = useCallback((ord: Order, look: EpcLookupItem): OrderItem | null => {
    const tagGtins = gtinCandidates(look.ean13, look.sku);
    const byGtin = ord.items.find((it) => {
      const itemGtins = gtinCandidates(it.ean, it.sku);
      return tagGtins.some((g) => itemGtins.includes(g));
    });
    if (byGtin) return byGtin;
    const lookSku = normSku(look.sku);
    const bySku = ord.items.find((it) => lookSku && normSku(it.sku) === lookSku);
    if (bySku) return bySku;
    return ord.items.find((it) => surpresaAceita(it, look)) ?? null;
  }, []);

  // Última tag lida que NÃO pertence ao pedido — mostrada num banner pra
  // operadora (e pra debug em campo: diz o que a tag É, não só que falhou).
  const [reject, setReject] = useState<string | null>(null);
  const rejectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showReject = useCallback((msg: string) => {
    setReject(msg);
    if (rejectTimerRef.current) clearTimeout(rejectTimerRef.current);
    rejectTimerRef.current = setTimeout(() => setReject(null), 8000);
  }, []);

  /** Registra uma entrada no console de leitura (mais novo primeiro). */
  const pushLog = useCallback((entry: Omit<LogEntry, "ts">) => {
    logRef.current = [{ ...entry, ts: Date.now() }, ...logRef.current].slice(0, LOG_MAX);
  }, []);

  // Handler de tags lido sempre fresco via ref — assim a sessão de leitura NÃO
  // reinicia a cada render (só quando muda o pedido).
  const onTagsRef = useRef<(newEpcs: string[]) => void>(() => {});
  onTagsRef.current = (newEpcs: string[]) => {
    void (async () => {
      const ord = orderRef.current;
      if (!ord) return;
      const resolved = await rfid.resolveEpcs(newEpcs);
      let changed = false;
      for (const epc of newEpcs) {
        const epcU = epc.toUpperCase();
        const look = resolved.get(epcU);
        const item = look ? matchItem(ord, look) : null;
        if (item) {
          const prog = progressRef.current.get(item.id) ?? { count: 0, epcs: [] };
          prog.count += 1;
          // Uma tag por unidade lida (o nexus valida rfidTags.length vs grade).
          prog.epcs.push(epcU);
          progressRef.current.set(item.id, prog);
          pushLog({
            epc: epcU,
            desc: [look!.name ?? item.nome, look!.size, look!.ean13].filter(Boolean).join(" · "),
            status: "ok",
          });
          changed = true;
          beepOk();
        } else {
          beepError();
          if (look) {
            const desc = [look.name, look.size, look.ean13].filter(Boolean).join(" · ");
            // Excedente do próprio pedido (produto certo, unidade a mais) ou
            // peça de outro pedido? Muda a mensagem E o card que fica vermelho.
            const excedido = itemDoPedido(ord, look);
            extrasRef.current.set(epcU, {
              epc: epcU,
              label: desc || epcU,
              kind: excedido ? "excedente" : "alheia",
              itemId: excedido?.id,
              imagemUrl: excedido?.imagemUrl ?? null,
            });
            pushLog({ epc: epcU, desc: desc || "(sem descrição)", status: "extra" });
            if (excedido) {
              showReject(
                `Peça SOBRESSALENTE: ${desc} — o pedido já tem as unidades desse produto. Tire a peça da mesa e reinicie (R).`,
              );
            } else {
              // Diagnóstico de campo: mostra os códigos que o pedido ainda espera
              // (ean/sku dos itens com saldo) pra divergência aparecer na hora.
              const esperados = ord.items
                .filter((it) => it.quantidade - (progressRef.current.get(it.id)?.count ?? 0) > 0)
                .map((it) => it.ean ?? it.sku ?? "?")
                .slice(0, 5)
                .join(", ");
              showReject(
                `Peça lida não pertence a este pedido: ${desc} — pedido espera: ${esperados}. Tire a peça da mesa e reinicie (R).`,
              );
            }
          } else {
            extrasRef.current.set(epcU, { epc: epcU, label: epcU, kind: "desconhecida" });
            pushLog({ epc: epcU, desc: "não identificada em nenhuma fonte", status: "unknown" });
            showReject(`Tag não identificada em nenhuma fonte: ${epcU}`);
          }
          tick();
        }
      }
      if (changed) {
        tick();
        if (allDone(ord) && extrasRef.current.size === 0) {
          setReject(null);
          void finish();
        }
      }
    })();
  };

  // Sessão de leitura contínua pela vida INTEIRA da fila (montar → desmontar):
  // o leitor arma ao entrar na fila e só desarma ao sair dela. Trocar de pedido
  // NÃO fecha a sessão — antes fechava/abria por pedido e, como o claim do
  // próximo demora mais que o linger do provider, virava `parar`+`iniciar` no
  // iTAG Monitor, que mostra um aviso a cada comando (o tempo todo no turno).
  // Depende só de startReadingSession (estável) — NUNCA do objeto `rfid` inteiro,
  // que é recriado a cada render do provider e reiniciava a leitura à toa.
  const startReadingSession = rfid.startReadingSession;
  const sessionRef = useRef<ReadingSession | null>(null);
  useEffect(() => {
    const session = startReadingSession((newEpcs) => onTagsRef.current(newEpcs));
    sessionRef.current = session;
    return () => {
      sessionRef.current = null;
      session.stop();
    };
  }, [startReadingSession]);

  // Novo pedido na mesa ou "Reiniciar (R)" (sessionEpoch): só RESET — zera o
  // dedupe e limpa o buffer físico (`limparLeitura`, sem aviso no Monitor) pra
  // recontar as peças que estão na mesa. Tags lidas durante o `loading` caem
  // no dedupe (o handler ignora sem pedido) e o reset as devolve.
  useEffect(() => {
    if (phase !== "separating" || !order) return;
    void sessionRef.current?.reset().catch(() => {
      /* leitor fora: o poll já reporta desconexão */
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, order?.id, sessionEpoch]);

  // Atalhos migrados do posvenda (as atendentes já têm decorado):
  //   K = concluir sem todas as peças lidas — pelo PIN do supervisor quando a
  //       trava está ligada, direto (com confirm) quando está desligada;
  //   P = pular o pedido (peça ainda não chegou da dobra) — vai pro fim do lote;
  //   R = reiniciar a leitura (sobressalente/divergência na mesa).
  // Ignorados digitando em input/textarea/select (e modificadores).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable)
          return;
      }
      const key = e.key.toLowerCase();
      if (key === "k") {
        if (phase !== "separating" || !orderRef.current || completing || supervisorOpen) return;
        e.preventDefault();
        liberarOuConcluir();
        return;
      }
      if (key === "p") {
        if (phase !== "separating" || !orderRef.current || completing || supervisorOpen) return;
        e.preventDefault();
        pularAtual();
        return;
      }
      if (key === "r") {
        if (phase !== "separating" || !orderRef.current || completing || supervisorOpen) return;
        const temLeitura =
          extrasRef.current.size > 0 ||
          Array.from(progressRef.current.values()).some((p) => p.count > 0);
        if (!temLeitura) return;
        e.preventDefault();
        restartLeitura();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, completing, supervisorOpen, restartLeitura, liberarOuConcluir, pularAtual]);

  // Devolve o lote se a tela sair de cena por qualquer caminho.
  useEffect(() => {
    return () => {
      void devolverTudo();
    };
  }, [devolverTudo]);

  // Os avisos (banner de notice/reject) agendam um setTimeout que só era
  // cancelado pelo aviso SEGUINTE. Sair da tela deixava o timer vivo pra
  // chamar setState numa árvore que já não existe.
  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
      if (rejectTimerRef.current) clearTimeout(rejectTimerRef.current);
    };
  }, []);

  // Logout forçado (inatividade/nexus): devolve o lote ANTES de perder o
  // token — no desmontar acima já seria tarde (a chamada iria sem Authorization).
  useEffect(() => onBeforeForcedLogout(() => devolverTudo()), [devolverTudo]);

  // Trava de atualização (426 do nexus ou versão nova no updater): devolve o
  // lote ANTES de a tela de bloqueio entrar. O desmontar acima também
  // devolveria, mas depois — e a mesa bloqueada teria segurado os pedidos das
  // outras estações nesse meio-tempo. O `devolver` pode voltar 426 também;
  // `devolverTudo` já engole a falha (o janitor recupera).
  useEffect(() => onAntesDeBloquear(() => devolverTudo()), [devolverTudo]);

  /**
   * "devolver à fila" do banner de lista impressa — a ação EXPLÍCITA. Ao
   * contrário do `devolverTudo` automático, leva os pedidos com `listaEm`
   * junto e NÃO é uma saída de tela: destrava o `saindoRef` e volta a puxar
   * lote normalmente (a lista deixou de existir).
   */
  const devolverListaImpressa = useCallback(async () => {
    await devolverTudo({ incluirLista: true });
    saindoRef.current = false;
    presaNaListaRef.current = false;
    loteRef.current = [];
    setLote([]);
    await puxarLote();
  }, [devolverTudo, puxarLote]);

  const handleBack = () => {
    // Espera devolver antes de sair: a tela de filas consulta os pedidos em
    // aberto assim que aparece e mostraria o banner de retomada do lote que
    // acabou de ser devolvido.
    setPhase("loading");
    void devolverTudo().finally(() => onBack());
  };

  const [historyOpen, setHistoryOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [pickingOpen, setPickingOpen] = useState(false);
  const [faltantesOpen, setFaltantesOpen] = useState(false);
  const extras = Array.from(extrasRef.current.values());
  /**
   * O lote como ela VÊ: ordem local (pulados no fim) + filtros de exibição. É
   * esta lista que a sidebar mostra, que o Picking Geral agrega e que o
   * "próximo" percorre — o servidor devolve a posse inteira (ver `loteVisivel`).
   */
  const visiveis = loteVisivel(lote, pulados, filters);
  const ocultos = lote.length - visiveis.length;
  sequenciaRef.current = visiveis.map((o) => o.id);
  // A DATA conta como filtro (27/08): ela sobrevive à troca de fila (fica no
  // localStorage da estação) e, quando ficava fora desta conta, a operadora
  // entrava numa fila nova com um recorte de outro dia ativo e sem nenhum
  // sinal no topo — a fila e o Picking Geral vinham vazios "sem motivo".
  const filtrosAtivos =
    (filters.includeProducts?.length ?? 0) +
    (filters.excludeProducts?.length ?? 0) +
    (filters.dateFrom || filters.dateTo ? 1 : 0);

  const aplicarFiltros = (f: QueueFilters) => {
    setFilters(f);
    filtersRef.current = f;
    saveFilters(f);
    // O pedido da mesa saiu do filtro? Se ela ainda não leu nada, a mesa segue
    // pro primeiro VISÍVEL (era isso que ela pediu ao filtrar). Se já tem
    // leitura, o pedido FICA — jogar fora a conferência dela seria pior — e o
    // aviso explica por que ele não está mais na lista.
    const atual = orderRef.current;
    if (atual && !passaNosFiltros(atual, f)) {
      const temLeitura = Array.from(progressRef.current.values()).some((pr) => pr.count > 0);
      const proximo = loteVisivel(loteRef.current, puladosRef.current, f)[0];
      if (!temLeitura && proximo) {
        resetLeitura();
        setOrder(proximo);
        setPhase("separating");
      } else if (temLeitura) {
        showNotice("O pedido da mesa ficou fora do filtro. Conclua ou devolva antes de seguir.");
      }
    }
    void puxarLote({ preservarAtual: true });
  };

  /** Data de emissão escolhida no seletor (dia único) — null = todas. */
  const dataSel = filters.dateFrom && filters.dateFrom === filters.dateTo ? filters.dateFrom : null;
  const escolherData = (d: string | null) =>
    aplicarFiltros({ ...filters, dateFrom: d ?? undefined, dateTo: d ?? undefined });

  /**
   * Carimba `listaEm` no lote EM MEMÓRIA depois que a folha foi impressa. O
   * servidor já gravou; isto é só pra sidebar mostrar "lista impressa" na hora,
   * sem esperar o próximo `puxarLote`.
   */
  const marcarLotePresoLocalmente = useCallback((ids: string[]) => {
    const alvo = new Set(ids);
    const agora = new Date().toISOString();
    setLote((atual) =>
      atual.map((o) => (alvo.has(o.id) && !o.listaEm ? { ...o, listaEm: agora } : o)),
    );
  }, []);

  /** Pedidos do lote com lista impressa — o banner e o chip da sidebar. */
  const comLista = lote.filter((o) => !!o.listaEm);
  const listaDeOutroDia = comLista.find((o) => o.listaDeOutroDia);

  const operadora = nomeDaOperadora(getSessaoSync()?.email ?? null);

  return (
    <div style={page}>
      <AmbientBackground />
      <header style={topBar}>
        <BackButton onClick={handleBack} />
        <div style={titleWrap}>
          <span style={kickerStyle}>― {kicker} ―</span>
          <h1 style={titleStyle}>{title}</h1>
        </div>
        {/* Segunda porta pro Picking Geral, no lugar em que a operadora já
            procura (ao lado de Filtros/Histórico). O chip da sidebar continua
            lá — este existe porque "não achei o Picking" foi relato de campo, e
            uma porta no topo não depende de largura de sidebar nem de a coluna
            do lote estar visível. */}
        <button style={topBarBtn} onClick={() => setPickingOpen(true)}>
          🖨 Picking Geral
        </button>
        <button style={topBarBtn} onClick={() => setFiltersOpen(true)}>
          Filtros{filtrosAtivos > 0 ? ` (${filtrosAtivos})` : ""}
        </button>
        <button style={topBarBtn} onClick={() => setHistoryOpen(true)}>
          🕐 Histórico
        </button>
        <OperatorChip />
        <MesaStatus
          connected={rfid.connected}
          host={rfid.host}
          onReconnect={() => void rfid.reconnect()}
        />
      </header>

      {SHADOW && (
        <div style={shadowBanner}>
          MODO SHADOW — rodando em paralelo ao pós-venda; não é sistema-de-registro.
        </div>
      )}
      {!rfid.connected && (
        <div style={mesaDownBanner}>
          Mesa RFID desconectada ({rfid.host}). A leitura volta sozinha ao reconectar.{" "}
          <button style={inlineReconnect} onClick={() => void rfid.reconnect()}>
            tentar agora
          </button>
        </div>
      )}
      {extras.length > 0 && (
        <div style={extrasBanner}>
          ⛔{" "}
          {extras.length === 1
            ? "1 peça sobressalente na mesa"
            : `${extras.length} peças sobressalentes na mesa`}{" "}
          — tire da mesa e aperte <strong>R</strong> pra reiniciar a leitura. O pedido não
          conclui com peça a mais.
        </div>
      )}
      {reject && extras.length === 0 && <div style={rejectBanner}>⚠ {reject}</div>}
      {notice && <div style={noticeBanner}>ℹ {notice}</div>}
      {comLista.length > 0 && (
        <div style={listaDeOutroDia ? listaBannerAlerta : listaBanner}>
          🖨 Lista impressa {listaDeOutroDia ? `de ${fmtDataISO(diaDe(listaDeOutroDia.listaEm!))}` : "de hoje"} —{" "}
          <strong>{comLista.length}</strong>{" "}
          {comLista.length === 1 ? "pedido reservado" : "pedidos reservados"} pra você até concluir
          ou devolver.{" "}
          <button style={inlineReconnect} onClick={() => void devolverListaImpressa()}>
            devolver à fila
          </button>
        </div>
      )}

      <div style={layoutRow}>
        <LoteSidebar
          queue={queue}
          lote={visiveis}
          pulados={pulados}
          ocultos={ocultos}
          restantes={restantes}
          atualId={order?.id ?? null}
          filters={filters}
          data={dataSel}
          onSelecionar={selecionarPedido}
          onEscolherData={escolherData}
          onPickingGeral={() => setPickingOpen(true)}
        />
        <main style={main}>
          {phase === "loading" && <Centered>Puxando próximo pedido…</Centered>}
          {phase === "error" && (
            <Centered>
              <div style={errorBox}>{error}</div>
              <button style={primaryBtn} onClick={() => void puxarLote()}>
                Tentar de novo
              </button>
            </Centered>
          )}
          {phase === "empty" && (
            <Centered>
              <div style={emptyTitle}>{ocultos > 0 ? "Nada visível no filtro" : "Fila vazia"}</div>
              <p style={emptyText}>
                {ocultos > 0
                  ? `Você tem ${lote.length} ${lote.length === 1 ? "pedido" : "pedidos"} no lote, ${ocultos === lote.length ? "todos" : `${ocultos}`} fora do filtro atual.`
                  : restantes && restantes > 0
                    ? `Seu lote acabou, mas ainda há ${restantes} na fila — procure de novo.`
                    : emptyHint}
              </p>
              {filtrosAtivos > 0 && (
                <p style={emptyText}>
                  Filtro ativo (data e/ou produto) — ele recorta o que entra no lote e o que
                  aparece aqui.{" "}
                  <button style={inlineReconnect} onClick={() => setFiltersOpen(true)}>
                    revisar filtros
                  </button>
                </p>
              )}
              <button style={primaryBtn} onClick={() => void puxarLote()}>
                Procurar de novo
              </button>
            </Centered>
          )}
          {phase === "separating" && order && (
            <OrderView
              order={order}
              progress={progressRef.current}
              extras={extras}
              completing={completing}
              exigirSupervisor={exigirSupervisor}
              podePular={visiveis.length > 1}
              onComplete={() => void finish()}
              onRestart={restartLeitura}
              onSkip={() => void devolverAtual()}
              onPular={pularAtual}
              onSupervisor={liberarOuConcluir}
              onFaltantes={() => setFaltantesOpen(true)}
            />
          )}
        </main>
        {phase === "separating" && order && (
          <ReadLogPanel entries={logRef.current} extras={extras} reading={rfid.connected} />
        )}
      </div>

      {supervisorOpen && (
        <SupervisorModal
          faltantes={serverFaltantes ?? faltantes()}
          onCancel={() => {
            setSupervisorOpen(false);
            setServerFaltantes(null);
          }}
          onConfirm={supervisorConfirm}
        />
      )}
      {historyOpen && <SeparacaoHistoryModal onClose={() => setHistoryOpen(false)} />}
      {pickingOpen && (
        <PickingGeralModal
          queue={queue}
          data={dataSel}
          filters={filters}
          lote={visiveis}
          operadora={operadora}
          onListaImpressa={marcarLotePresoLocalmente}
          onClose={() => setPickingOpen(false)}
        />
      )}
      {faltantesOpen && order && (
        <ItensFaltantesModal
          order={order}
          lidos={new Map([...progressRef.current].map(([id, p]) => [id, p.count]))}
          onMarcado={() => {
            setFaltantesOpen(false);
            showNotice(
              "Itens faltantes marcados. O pedido saiu da fila e o cliente foi avisado; a supervisão resolve pelo Nexus.",
            );
            // O pedido saiu da fila ⇒ repõe o lote (ele não volta na resposta).
            void puxarLote();
          }}
          onClose={() => setFaltantesOpen(false)}
        />
      )}
      {filtersOpen && (
        <PickingFiltersModal
          filters={filters}
          queue={queue}
          onApply={(f) => {
            aplicarFiltros(f);
            setFiltersOpen(false);
          }}
          onClear={() => {
            aplicarFiltros(emptyFilters());
            setFiltersOpen(false);
          }}
          onClose={() => setFiltersOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * Console de leitura ao vivo (coluna direita — o espaço que sobrava): cada tag
 * que o leitor viu e COMO foi resolvida (peça do pedido, sobressalente, não
 * identificada). É o feedback visual que a operadora tinha no posvenda.
 */
function ReadLogPanel({
  entries,
  extras,
  reading,
}: {
  entries: LogEntry[];
  extras: ExtraTag[];
  reading: boolean;
}) {
  return (
    <aside style={logPanel}>
      <div style={logHeader}>
        <span style={{ ...logDot, background: reading ? "var(--success-dot)" : "var(--danger-text)" }} />
        <span style={logTitle}>Leitura ao vivo</span>
        <span style={logCount}>{entries.length > 0 ? `${entries.length}` : ""}</span>
      </div>
      {/* Sobressalentes PINADOS fora do scroll: num pedido grande a entrada ⛔
          afunda no console conforme chegam leituras — a dor do legado era caçar
          item a item qual peça sobrou. Aqui a peça errada fica cravada no topo,
          com foto quando dá, até a operadora tirar da mesa e reiniciar (R). */}
      {extras.length > 0 && (
        <div style={extrasPinned}>
          <div style={extrasPinnedTitle}>
            ⛔ Tire da mesa ({extras.length})
          </div>
          {extras.map((x) => (
            <div key={x.epc} style={extrasPinnedItem}>
              {x.imagemUrl && (
                <img
                  src={miniatura(x.imagemUrl) ?? undefined}
                  alt=""
                  style={extrasPinnedThumb}
                  loading="lazy"
                  decoding="async"
                />
              )}
              <div style={extrasPinnedBody}>
                <span style={extrasPinnedLabel}>{x.label}</span>
                <span style={extrasPinnedKind}>
                  {x.kind === "excedente"
                    ? "unidade a MAIS deste pedido"
                    : x.kind === "alheia"
                      ? "peça de OUTRO pedido"
                      : "tag não identificada"}
                </span>
                <span style={logEpc}>{x.epc}</span>
              </div>
            </div>
          ))}
          <span style={extrasPinnedHint}>Depois de tirar, aperte R pra reler.</span>
        </div>
      )}
      <div className="thin-scroll" style={logList}>
        {entries.length === 0 && (
          <span style={logEmpty}>
            Aproxime as peças da mesa — cada tag lida aparece aqui com o que ela é.
          </span>
        )}
        {entries.map((e) => (
          <div key={`${e.epc}-${e.ts}`} style={logEntryStyle(e.status)}>
            <div style={logEntryTop}>
              <span style={logStatusIcon}>
                {e.status === "ok" ? "✓" : e.status === "extra" ? "⛔" : "?"}
              </span>
              <span style={logDesc}>{e.desc}</span>
            </div>
            <div style={logMetaRow}>
              <span style={logEpc}>{e.epc}</span>
              <span style={logTime}>
                {new Date(e.ts).toLocaleTimeString("pt-BR", {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </span>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

/**
 * Sidebar do LOTE (0.9.0): os pedidos QUE JÁ SÃO DELA, na ordem da fila. Antes
 * esta coluna mostrava a fila inteira e cada pedido exigia um claim; agora a
 * operadora entra na fila, recebe o lote e a coluna é a lista dela — clicar num
 * card só decide qual vem agora (nada de ida ao servidor, nada de disputa com
 * outra estação). O contador da fila (o que ainda não tem dono) abre o
 * Picking Geral, e o seletor "Data" recorta tudo por dia de emissão.
 */
function LoteSidebar({
  queue,
  lote,
  pulados,
  ocultos,
  restantes,
  atualId,
  filters,
  data,
  onSelecionar,
  onEscolherData,
  onPickingGeral,
}: {
  queue: { mode: SeparationMode; size: string; sizes: string[] };
  /** JÁ na ordem local e JÁ filtrado — a sidebar não recorta nada por conta. */
  lote: Order[];
  /** Ids pulados (mostrados no fim, com marca). */
  pulados: Set<string>;
  /** Pedidos do lote escondidos pelo filtro — contados no rodapé. */
  ocultos: number;
  restantes: number | null;
  atualId: string | null;
  filters: QueueFilters;
  data: string | null;
  onSelecionar: (o: Order) => void;
  onEscolherData: (d: string | null) => void;
  onPickingGeral: () => void;
}) {
  const [busca, setBusca] = useState("");
  const termo = busca.trim().toLowerCase();
  // Busca LOCAL: o lote inteiro já está em memória com os itens (até 50 nos
  // mistos) — ir ao servidor pra filtrar essa lista seria latência à toa.
  const visiveis = termo.length === 0 ? lote : lote.filter((o) => casaBusca(o, termo));
  const comLista = lote.filter((o) => !!o.listaEm).length;

  return (
    <aside style={sidebar}>
      <div style={sidebarHeader}>
        <div style={sidebarHeaderTop}>
          <span style={sidebarTitle}>
            Fila {queue.size} — {queue.mode === "total" ? "Mistos" : "Puro"}
          </span>
          <span style={sidebarCount}>
            {lote.length} {lote.length === 1 ? "pedido" : "pedidos"}
          </span>
          {comLista > 0 && (
            <span style={listaChip} title="Lista de picking impressa — estes pedidos ficam reservados">
              🖨 {comLista}
            </span>
          )}
        </div>
        <div style={sidebarHeaderRow}>
          <button
            style={pickingChip}
            onClick={onPickingGeral}
            title="Ver e imprimir o Picking Geral desta fila"
          >
            🖨 Picking Geral
          </button>
          <DataMenu queue={queue} filters={filters} valor={data} onEscolher={onEscolherData} />
        </div>
      </div>
      <input
        style={sidebarSearch}
        value={busca}
        onChange={(e) => setBusca(e.target.value)}
        placeholder="Buscar item…"
        spellCheck={false}
      />
      <span style={sidebarHint}>
        {termo
          ? "Buscando dentro do seu lote."
          : "Estes pedidos são só seus. Clique pra escolher qual vem agora, ou aperte P pra pular o da mesa."}
      </span>
      <div className="thin-scroll" style={sidebarList}>
        {/* `cardSlot` liga `content-visibility: auto`: com 50 mistos na coluna
            (Black Friday), o navegador pula a renderização do que está fora da
            viewport em vez de montar 50 cards com 150 thumbnails. Sem cálculo
            de janela — a rolagem continua nativa e a busca continua vendo a
            lista inteira. Onde a propriedade não existe, tudo renderiza como
            antes. As fotos já sobem com `loading="lazy"`. */}
        {visiveis.map((o, i) => (
          <div key={o.id} style={cardSlot}>
            {pulados.has(o.id) && <span style={puladoChip}>pulado</span>}
            <QueueCard
              item={queueItemFromOrder(o, i + 1)}
              pinned={o.id === atualId}
              onClick={o.id === atualId ? undefined : () => onSelecionar(o)}
            />
          </div>
        ))}
        {visiveis.length === 0 && (
          <span style={sidebarEmpty}>
            {termo ? "Nada encontrado no seu lote." : "Lote vazio."}
          </span>
        )}
      </div>
      {(restantes !== null || ocultos > 0) && (
        <div style={sidebarFooter}>
          {/* Os OCULTOS são pedidos que continuam reservados pra ela — o filtro
              só some com eles da vista. Sem esta linha o lote "encolhia" sem
              explicação e ela achava que tinha perdido pedido. */}
          {ocultos > 0 && (
            <div>
              {ocultos} {ocultos === 1 ? "oculto" : "ocultos"} pelo filtro
            </div>
          )}
          {restantes !== null && (
            <div>
              {restantes > 0
                ? `faltam ${restantes} na fila`
                : "fila vazia — só o que está no seu lote"}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

/** Casa o termo com número, cliente ou item (nome/EAN/SKU) do pedido. */
function casaBusca(o: Order, termo: string): boolean {
  if ((o.numero ?? "").toLowerCase().includes(termo)) return true;
  if ((o.clienteNome ?? "").toLowerCase().includes(termo)) return true;
  return o.items.some(
    (it) =>
      (it.nome ?? "").toLowerCase().includes(termo) ||
      (it.ean ?? "").toLowerCase().includes(termo) ||
      (it.sku ?? "").toLowerCase().includes(termo),
  );
}

/**
 * Seletor "Data" do posvenda: uma linha por data de EMISSÃO presente na fila,
 * com quantos pedidos ela tem ("14/08/2026 (168)"), mais "Todos". Escolher uma
 * data manda `dateFrom = dateTo` em tudo — lote, produtos e picking. Era o
 * controle que as separadoras mais usavam pra atacar o atraso por dia.
 */
function DataMenu({
  queue,
  filters,
  valor,
  onEscolher,
}: {
  queue: { mode: SeparationMode; size: string; sizes: string[] };
  filters: QueueFilters;
  valor: string | null;
  onEscolher: (d: string | null) => void;
}) {
  const [aberto, setAberto] = useState(false);
  const [dados, setDados] = useState<QueueDatesResponse | null>(null);
  const [indisponivel, setIndisponivel] = useState(false);

  // Troca de fila/filtro invalida a contagem — recarrega na próxima abertura.
  useEffect(() => setDados(null), [queue.mode, queue.size, filters]);

  useEffect(() => {
    if (!aberto) return;
    let alive = true;
    // `sizes` é o BUCKET da fila (XG cobre XXG/G1/G2/G3): sem ele o seletor
    // contava só o tamanho-rótulo e mostrava menos pedidos do que a fila tem.
    getQueueDates({ mode: queue.mode, size: queue.size, sizes: queue.sizes, filters })
      .then((d) => {
        if (!alive) return;
        setDados(d);
        setIndisponivel(false);
      })
      .catch((e) => {
        if (!alive) return;
        setDados({ dates: [], total: 0, semData: 0 });
        setIndisponivel(e instanceof ApiError && e.status === 404);
      });
    return () => {
      alive = false;
    };
  }, [aberto, queue.mode, queue.size, filters]);

  useEffect(() => {
    if (!aberto) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setAberto(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [aberto]);

  const escolher = (d: string | null) => {
    onEscolher(d);
    setAberto(false);
  };

  return (
    <div style={dataWrap}>
      <button style={valor ? dataBtnOn : dataBtn} onClick={() => setAberto((v) => !v)}>
        {valor ? fmtDataISO(valor) : "Data"} ▾
      </button>
      {aberto && (
        <>
          <div style={dataBackdrop} onClick={() => setAberto(false)} />
          <div className="thin-scroll" style={dataMenu}>
            <button style={valor === null ? dataItemOn : dataItem} onClick={() => escolher(null)}>
              <span style={dataItemLabel}>Todos</span>
              <span style={dataItemCount}>{dados ? `(${dados.total})` : ""}</span>
            </button>
            {dados === null && <span style={dataAviso}>Carregando datas…</span>}
            {indisponivel && (
              <span style={dataAviso}>
                O servidor ainda não separa a fila por data (aguardando atualização do nexus).
              </span>
            )}
            {dados?.dates.map((d) => (
              <button
                key={d.date}
                style={valor === d.date ? dataItemOn : dataItem}
                onClick={() => escolher(d.date)}
              >
                <span style={dataItemLabel}>{fmtDataISO(d.date)}</span>
                <span style={dataItemCount}>({d.count})</span>
              </button>
            ))}
            {dados !== null && dados.semData > 0 && (
              <span style={dataAviso}>
                {dados.semData} sem data de emissão — só aparecem em "Todos".
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** YYYY-MM-DD → dd/mm/aaaa (o seletor mostra a data como o posvenda mostrava). */
/** ISO completo → `YYYY-MM-DD` no fuso local (o dia que a operadora enxerga). */
function diaDe(iso: string): string {
  return new Date(iso).toLocaleDateString("en-CA");
}

function fmtDataISO(iso: string): string {
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

/** Card da sidebar a partir do pedido do lote (o resumo da fila não serve: os
 *  pedidos do lote já vêm completos no `POST /separacao/lote`). */
function queueItemFromOrder(order: Order, position: number): QueueListItem {
  return {
    position,
    id: order.id,
    numero: order.numero ?? order.tinyOrderId,
    clienteNome: order.clienteNome ?? null,
    dataEmissao: order.dataEmissao ?? null,
    prioritario: order.prioritario ?? false,
    predominantSize: order.predominantSize,
    separationMode: order.separationMode,
    itemCount: order.items.reduce((a, it) => a + it.quantidade, 0),
    imagens: order.items
      .map((it) => it.imagemUrl)
      .filter((u): u is string => !!u)
      .slice(0, 4),
    createdAt: order.createdAt,
  };
}

function QueueCard({
  item,
  pinned,
  onClick,
}: {
  item: QueueListItem;
  pinned?: boolean;
  onClick?: () => void;
}) {
  const shownThumbs = item.imagens.slice(0, 3);
  const extra = item.itemCount - shownThumbs.length;
  return (
    <div
      onClick={onClick}
      title={onClick ? "Avançar pra este pedido" : undefined}
      style={{
        ...qCard,
        ...(item.prioritario ? qCardPrio : null),
        ...(pinned ? qCardActive : null),
        ...(onClick ? { cursor: "pointer" } : null),
      }}
    >
      <span style={qPos}>{pinned ? "▶" : String(item.position).padStart(2, "0")}</span>
      <div style={qBody}>
        <div style={qTopRow}>
          <span style={qNumero}>#{item.numero ?? "—"}</span>
          {item.prioritario && <span style={qPrioBadge}>Prio</span>}
        </div>
        {item.clienteNome && <span style={qCliente}>{item.clienteNome}</span>}
        <div style={qThumbRow}>
          {shownThumbs.map((u, i) => (
            <img
              key={i}
              src={miniatura(u) ?? undefined}
              alt=""
              style={qThumb}
              loading="lazy"
              decoding="async"
            />
          ))}
          {shownThumbs.length === 0 && <span style={qThumbEmpty}>{item.itemCount} itens</span>}
          {shownThumbs.length > 0 && extra > 0 && <span style={qThumbMore}>+{extra}</span>}
        </div>
      </div>
      <div style={qRight}>
        {item.predominantSize && <span style={qSizeChip}>{item.predominantSize}</span>}
        {item.dataEmissao && <span style={qDate}>{fmtData(item.dataEmissao)}</span>}
      </div>
    </div>
  );
}

/** Corpo do card: paddings + nome + rodapé (compacto quando o card estreita).
    Estimativa CONSERVADORA — subestimar corta fileira no overflow. */
function cardBodyHeight(cardW: number): number {
  return cardW < 200 ? 74 : 96;
}

/**
 * Tamanho dos cards — regra do Leonardo (21/08/2026, go-live XG):
 * - cards GRANDES, sempre LADO A LADO, no máximo `MAX_COLS` por linha;
 * - até 2 linhas o pedido inteiro cabe SEM scroll (o card encolhe pra caber
 *   na altura, nunca abaixo de MINW);
 * - da 3ª linha em diante a área ROLA, com o card do MESMO tamanho de um
 *   pedido de 2 linhas (não espreme pra caber).
 * O fit antigo testava todas as contagens de coluna e ficava com a que dava o
 * card maior — num pedido de 2 itens, com a área estreitada pela sidebar da
 * fila, vencia 1 COLUNA + scroll: cards empilhados e barra no meio da tela.
 */

/**
 * Quantos cards de item cabem numa fileira. Era 5; virou 4 a pedido das
 * separadoras (26/08) — a foto do card é o que elas usam pra reconhecer a
 * peça, e a 5 colunas ela ficava pequena demais no monitor do galpão.
 */
const MAX_COLS = 4;

function useFitCards(nMain: number, nOff: number) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState<{ cardW: number; cols: number; fits: boolean }>({
    cardW: 310,
    cols: MAX_COLS,
    fits: true,
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const GAP = 14;
    // Teto de 5 → 4 colunas (26/08): as separadoras acharam a foto pequena
    // demais pra reconhecer a peça de longe. Com 4 colunas o card ganha ~25%
    // de largura e a imagem cresce junto, sem estourar a altura: os limites de
    // 1366×768 continuam valendo (MINW), e em 1920×1080 o MAXW é o que segura
    // o card num tamanho legível em vez de gigante.
    const MAXW = 330;
    const MINW = 140;
    const ROWS_SEM_SCROLL = 2;
    // Folga: se a estimativa do corpo errar por poucos px pro lado otimista,
    // o overflow decepa uma fileira (visto em campo no misto de 14 itens).
    const SLACK = 8;
    const BANNER = nOff > 0 ? 46 + GAP : 0;
    const total = nMain + nOff;
    const compute = () => {
      const W = el.clientWidth;
      const H = el.clientHeight;
      if (!W || !H || total === 0) return;
      const cols = Math.min(total, MAX_COLS);
      const rows = Math.ceil(nMain / cols) + (nOff > 0 ? Math.ceil(nOff / cols) : 0);
      // Altura dimensiona pra no máximo 2 linhas; com mais linhas o card fica
      // do tamanho de "2 linhas" e o viewport rola.
      const rowsFit = Math.min(rows, ROWS_SEM_SCROLL);
      const wByWidth = Math.min((W - (cols - 1) * GAP) / cols, MAXW);
      const rowH = (H - SLACK - BANNER - (rowsFit - 1) * GAP) / rowsFit;
      const w = Math.floor(Math.min(wByWidth, rowH - cardBodyHeight(wByWidth)));
      const next = {
        cardW: Math.max(MINW, w),
        cols,
        fits: rows <= ROWS_SEM_SCROLL && w >= MINW,
      };
      setFit((prev) =>
        prev.cardW === next.cardW && prev.cols === next.cols && prev.fits === next.fits ? prev : next,
      );
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [nMain, nOff]);

  return { ref, ...fit };
}

function OrderView({
  order,
  progress,
  extras,
  completing,
  exigirSupervisor,
  podePular,
  onComplete,
  onRestart,
  onSkip,
  onPular,
  onSupervisor,
  onFaltantes,
}: {
  order: Order;
  progress: Map<string, ItemProgress>;
  extras: ExtraTag[];
  completing: boolean;
  /** Trava do nexus: `false` deixa concluir com faltantes sem PIN. */
  exigirSupervisor: boolean;
  /** Há outro pedido visível pra onde pular. */
  podePular: boolean;
  onComplete: () => void;
  onRestart: () => void;
  onSkip: () => void;
  onPular: () => void;
  onSupervisor: () => void;
  onFaltantes: () => void;
}) {
  const totalExpected = order.items.reduce((a, it) => a + it.quantidade, 0);
  const totalDone = order.items.reduce(
    (a, it) => a + Math.min(progress.get(it.id)?.count ?? 0, it.quantidade),
    0,
  );
  const temExtras = extras.length > 0;
  const done = totalExpected > 0 && totalDone >= totalExpected && !temExtras;
  // Itens do pedido com unidade excedente lida — o card fica vermelho.
  const excedidos = new Set(extras.map((e) => e.itemId).filter(Boolean) as string[]);

  // Mesma leitura do posvenda: itens do tamanho da fila em cima; os de tamanho
  // diferente (pedido misto) ficam numa seção própria, com divisor de alerta.
  // Compara pelo tamanho EFETIVO (campo ou nome, normalizado); item sem tamanho
  // resolvível fica em cima — não dá pra afirmar que difere.
  const predominant = order.predominantSize?.trim().toUpperCase() ?? null;
  const isMixed = order.separationMode === "total" && !!predominant;
  const differs = (it: OrderItem) => {
    const s = itemSize(it);
    return s !== null && s !== predominant;
  };
  const mainItems = isMixed ? order.items.filter((it) => !differs(it)) : order.items;
  const offSizeItems = isMixed ? order.items.filter(differs) : [];

  const { ref: fitRef, cardW, cols } = useFitCards(mainItems.length, offSizeItems.length);
  const grid: CSSProperties = {
    ...cardsGrid,
    gridTemplateColumns: `repeat(auto-fit, ${cardW}px)`,
    // Trava física do teto de colunas: com largura ≤ cols faixas, o auto-fit
    // não tem onde criar a coluna extra.
    maxWidth: cols * cardW + (cols - 1) * 14,
    margin: "0 auto",
    width: "100%",
  };

  return (
    <div style={orderWrap}>
      <div style={orderHeader}>
        <div>
          <span style={orderLabel}>Pedido</span>
          <div style={orderNumber}>
            #{order.numero ?? order.tinyOrderId ?? order.id.slice(0, 8)}
          </div>
        </div>
        <div style={orderMeta}>
          {order.prioritario && <span style={badgePrio}>Prioritário</span>}
          {order.channel && <span style={badge}>{order.channel}</span>}
          {order.dataEmissao && <span style={badge}>{fmtData(order.dataEmissao)}</span>}
          {order.predominantSize && <span style={badgeStrong}>{order.predominantSize}</span>}
          {order.separationMode === "total" && <span style={badgeWarn}>MISTO</span>}
        </div>
        {order.clienteNome && <span style={clienteNomeStyle}>{order.clienteNome}</span>}
        <div style={progressBadge}>
          {totalDone}/{totalExpected} itens
        </div>
      </div>

      {order.items.length === 0 && <div style={emptyText}>Pedido sem itens cadastrados.</div>}

      {/* Viewport SEMPRE rolável (roda do mouse; barra fininha .thin-scroll) —
          centralização via margin:auto do conteúdo, que ao contrário do
          justify-content:center NÃO decepa o topo quando estoura. */}
      <div ref={fitRef} className="thin-scroll" style={cardsViewport}>
        <div style={cardsContent}>
        <div style={grid}>
          {mainItems.map((it) => (
            <ItemCard
              key={it.id}
              item={it}
              count={progress.get(it.id)?.count ?? 0}
              cardW={cardW}
              excedido={excedidos.has(it.id)}
            />
          ))}
        </div>

        {offSizeItems.length > 0 && (
          <>
            <div style={sizeBanner}>
              ⚠{" "}
              {offSizeItems.length === 1
                ? "1 item de tamanho diferente neste pedido"
                : `${offSizeItems.length} itens de tamanho diferente neste pedido`}{" "}
              — confira antes de concluir
            </div>
            <div style={grid}>
              {offSizeItems.map((it) => (
                <ItemCard
                  key={it.id}
                  item={it}
                  count={progress.get(it.id)?.count ?? 0}
                  cardW={cardW}
                  excedido={excedidos.has(it.id)}
                  offSize
                />
              ))}
            </div>
          </>
        )}
        </div>
      </div>

      <div style={actionsRow}>
        <button style={ghostBtn} onClick={onSkip} disabled={completing}>
          Devolver à fila
        </button>
        {/* PULAR ≠ devolver: a peça ainda não chegou da dobra, o pedido
            continua reservado pra ela e só vai pro fim do lote. */}
        <button
          style={ghostBtn}
          onClick={onPular}
          disabled={completing || !podePular}
          title={
            podePular
              ? "Pedido vai pro fim do seu lote — você volta nele depois (P)"
              : "É o único pedido visível no seu lote"
          }
        >
          Pular (P)
        </button>
        {/* "ITENS FALTANTES" do pós-venda legado: a peça não está na
            prateleira. Sai da fila e o cliente é avisado — diferente de
            "devolver", que devolve o pedido inteiro pra outra estação pegar e
            bater na mesma falta. */}
        <button style={faltantesBtn} onClick={onFaltantes} disabled={completing}>
          Itens faltantes
        </button>
        {temExtras && (
          <button style={restartBtn} onClick={onRestart} disabled={completing}>
            ↺ Reiniciar leitura (R)
          </button>
        )}
        {!done && (
          <button style={supervisorBtn} onClick={onSupervisor} disabled={completing}>
            {exigirSupervisor ? "🔓 Liberar com supervisor (K)" : "✅ Concluir com faltantes (K)"}
          </button>
        )}
        <button
          style={done && !completing ? primaryBtn : temExtras ? primaryBtnBlocked : primaryBtnDisabled}
          onClick={onComplete}
          disabled={!done || completing}
        >
          {completing
            ? "Concluindo…"
            : done
              ? "Concluir separação"
              : temExtras
                ? "Sobressalente na mesa — reinicie (R)"
                : "Aguardando leitura…"}
        </button>
      </div>
    </div>
  );
}

/** Card de item no estilo do posvenda: foto grande, xN, nome, EAN e chip do tamanho. */
function ItemCard({
  item,
  count,
  offSize,
  cardW,
  excedido,
}: {
  item: OrderItem;
  count: number;
  offSize?: boolean;
  /** Largura calculada pelo fit — abaixo de 200px o corpo compacta. */
  cardW: number;
  /** Unidade sobressalente lida deste produto — card fica vermelho. */
  excedido?: boolean;
}) {
  const dense = cardW < 200;
  const ok = count >= item.quantidade && !excedido;
  const size = itemSize(item);
  return (
    <div
      style={{
        ...card,
        ...(offSize ? cardOffSize : null),
        ...(ok ? cardDone : null),
        ...(excedido ? cardExcedido : null),
      }}
    >
      <div style={cardImageWrap}>
        {item.imagemUrl ? (
          <img
            src={imagemRedimensionada(item.imagemUrl, LARGURA_CARD) ?? undefined}
            alt=""
            style={cardImage}
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div style={cardImageEmpty}>
            <IconShirt style={dense ? emptyShirtIconDense : emptyShirtIcon} />
            sem imagem
          </div>
        )}
        <span style={item.quantidade > 1 ? qtyBadgeMulti : qtyBadge}>x{item.quantidade}</span>
        <span style={checkRing(ok)}>{ok ? "✓" : excedido ? "!" : ""}</span>
      </div>
      <div style={dense ? cardBodyDense : cardBody}>
        <span style={dense ? cardNameDense : cardName}>
          {item.nome ?? item.sku ?? item.ean ?? "Item"}
        </span>
        <div style={cardFooter}>
          <span style={cardEan}>{item.ean ?? item.sku ?? "—"}</span>
          <span style={cardFooterRight}>
            <span style={excedido ? cardCountExcedido : cardCount}>
              {excedido ? `${count}/${item.quantidade}!` : `${Math.min(count, item.quantidade)}/${item.quantidade}`}
            </span>
            {size && (
              <span style={offSize ? sizeChipOff : sizeChip}>
                {offSize ? `↔ ${size}` : size}
              </span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Camiseta em contorno pro placeholder de imagem — "sem imagem" deixa de
    parecer erro de carregamento. */
function IconShirt(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z" />
    </svg>
  );
}

function fmtData(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

function MesaStatus({
  connected,
  host,
  onReconnect,
}: {
  connected: boolean;
  host: string;
  onReconnect: () => void;
}) {
  return (
    <button style={mesaChip} onClick={onReconnect} title={host}>
      <span style={{ ...mesaDot, background: connected ? "var(--success-dot)" : "var(--danger-text)" }} />
      <span style={mesaText}>{connected ? "Mesa conectada" : "Mesa offline"}</span>
    </button>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div style={centered}>{children}</div>;
}

// ============================================================
// Styles
// ============================================================
const page: CSSProperties = {
  height: "100vh",
  background: "var(--bg)",
  color: "var(--text)",
  display: "flex",
  flexDirection: "column",
  position: "relative",
  overflow: "hidden",
};

const topBar: CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
  gap: 18,
  padding: "16px 32px",
  borderBottom: "1px solid var(--border)",
};

const titleWrap: CSSProperties = { display: "flex", flexDirection: "column", gap: 2, flex: 1 };

const kickerStyle: CSSProperties = {
  fontSize: 10,
  letterSpacing: 3,
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontWeight: 700,
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: 20,
  fontWeight: 700,
  letterSpacing: -0.3,
  color: "var(--text)",
};

const layoutRow: CSSProperties = {
  position: "relative",
  flex: 1,
  minHeight: 0,
  display: "flex",
};

/** Sem overflow aqui: quem decide rolar (só no pedido gigante) é a área de
    cards — o scrollbar no meio da tela parecia um divisor entre o pedido e a
    Leitura ao vivo. */
const main: CSSProperties = {
  position: "relative",
  flex: 1,
  display: "flex",
  flexDirection: "column",
  padding: "24px 32px",
  maxWidth: 1100,
  width: "100%",
  margin: "0 auto",
  boxSizing: "border-box",
  overflow: "hidden",
  minHeight: 0,
};

// --- Sidebar da fila (réplica do painel esquerdo do posvenda) ---

const sidebar: CSSProperties = {
  width: 300,
  flexShrink: 0,
  display: "flex",
  flexDirection: "column",
  borderRight: "1px solid var(--border)",
  background: "var(--bg-elevated)",
  minHeight: 0,
};

const sidebarHeader: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  padding: "14px 16px",
  borderBottom: "1px solid var(--border)",
};

const sidebarHeaderTop: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 8,
};

const sidebarHeaderRow: CSSProperties = { display: "flex", alignItems: "center", gap: 8 };

const pickingChip: CSSProperties = {
  flex: 1,
  padding: "7px 10px",
  background: "var(--bg-card)",
  border: "1px solid var(--border-strong)",
  borderRadius: 8,
  color: "var(--text)",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

/** "faltam X na fila" — o que ainda está sem dono, fora do lote dela. */
const sidebarFooter: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  padding: "9px 16px",
  borderTop: "1px solid var(--border)",
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--text-muted)",
  textAlign: "center",
};

// --- Seletor "Data" (dropdown com contagem por dia de emissão) ---

const dataWrap: CSSProperties = { position: "relative", flexShrink: 0 };

const dataBtn: CSSProperties = {
  padding: "7px 12px",
  background: "var(--bg-card)",
  border: "1px solid var(--border-strong)",
  borderRadius: 8,
  color: "var(--text-secondary)",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

const dataBtnOn: CSSProperties = {
  ...dataBtn,
  background: "var(--info-bg)",
  border: "1px solid var(--info-border)",
  color: "var(--info-text)",
};

/** Captura o clique fora sem depender de listener global. */
const dataBackdrop: CSSProperties = { position: "fixed", inset: 0, zIndex: 40 };

const dataMenu: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 6px)",
  right: 0,
  zIndex: 41,
  width: 210,
  maxHeight: 320,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 2,
  padding: 6,
  background: "var(--bg-elevated)",
  border: "1px solid var(--border-strong)",
  borderRadius: 10,
  boxShadow: "0 12px 32px rgba(0, 0, 0, 0.45)",
};

const dataItem: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: "7px 10px",
  background: "transparent",
  border: 0,
  borderRadius: 7,
  color: "var(--text-secondary)",
  fontSize: 12,
  fontWeight: 600,
  cursor: "pointer",
  textAlign: "left",
  width: "100%",
};

const dataItemOn: CSSProperties = {
  ...dataItem,
  background: "var(--info-bg)",
  color: "var(--info-text)",
};

const dataItemLabel: CSSProperties = { fontFamily: "var(--font-mono)" };

const dataItemCount: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--text-muted)",
};

const dataAviso: CSSProperties = {
  padding: "6px 10px",
  fontSize: 11,
  color: "var(--text-muted)",
  lineHeight: 1.4,
};

const sidebarTitle: CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  color: "var(--text)",
};

const sidebarCount: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--text-muted)",
};

const sidebarSearch: CSSProperties = {
  margin: "10px 12px 0",
  padding: "8px 12px",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: 9,
  color: "var(--text)",
  fontSize: 13,
  outline: "none",
};

const sidebarList: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 12,
};

const sidebarEmpty: CSSProperties = {
  fontSize: 13,
  color: "var(--text-muted)",
  padding: "12px 4px",
};

/**
 * Slot de um card na sidebar. `contentVisibility: auto` deixa o navegador
 * pular a renderização do que está fora da viewport; `containIntrinsicSize`
 * dá a altura estimada pro scrollbar não pular enquanto isso. É o que segura
 * a coluna de 50 mistos sem virtualização manual.
 */
const cardSlot: CSSProperties = {
  contentVisibility: "auto",
  containIntrinsicSize: "auto 92px",
  position: "relative",
};

/** Marca do pedido PULADO (fim do lote) — o card em si não muda de forma. */
const puladoChip: CSSProperties = {
  position: "absolute",
  top: 4,
  right: 6,
  zIndex: 1,
  fontFamily: "var(--font-mono)",
  fontSize: 9,
  fontWeight: 800,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  padding: "1px 6px",
  borderRadius: 999,
  background: "var(--warning-bg)",
  color: "var(--warning-text)",
  pointerEvents: "none",
};

const listaChip: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  fontWeight: 800,
  padding: "2px 7px",
  borderRadius: 999,
  background: "var(--info-bg)",
  color: "var(--info-text)",
  border: "1px solid var(--info-border)",
};

const qCard: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 10,
  padding: "10px 12px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 12,
};

const qCardPrio: CSSProperties = {
  border: "1px solid var(--danger-border)",
};

const qCardActive: CSSProperties = {
  border: "1px solid var(--info-border)",
  background: "var(--info-bg)",
};

const qPos: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  fontWeight: 700,
  color: "var(--text-faint)",
  paddingTop: 2,
  flexShrink: 0,
  width: 18,
};

const qBody: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  flex: 1,
  minWidth: 0,
};

const qTopRow: CSSProperties = { display: "flex", alignItems: "center", gap: 8 };

const qNumero: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 14,
  fontWeight: 700,
  color: "var(--text)",
};

const qPrioBadge: CSSProperties = {
  fontSize: 9,
  fontWeight: 800,
  letterSpacing: 1,
  textTransform: "uppercase",
  padding: "1px 7px",
  borderRadius: 999,
  background: "var(--danger-bg)",
  color: "var(--danger-text)",
  border: "1px solid var(--danger-border)",
};

const qCliente: CSSProperties = {
  fontSize: 12,
  color: "var(--text-secondary)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const qThumbRow: CSSProperties = { display: "flex", alignItems: "center", gap: 6 };

const qThumb: CSSProperties = {
  width: 34,
  height: 34,
  borderRadius: 6,
  objectFit: "cover",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
};

const qThumbEmpty: CSSProperties = {
  fontSize: 11,
  color: "var(--text-muted)",
  fontFamily: "var(--font-mono)",
};

const qThumbMore: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  fontWeight: 700,
  color: "var(--text-secondary)",
  padding: "0 6px",
};

const qRight: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-end",
  gap: 4,
  flexShrink: 0,
};

const qSizeChip: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  fontWeight: 700,
  padding: "1px 8px",
  borderRadius: 999,
  background: "var(--bg-input)",
  color: "var(--text)",
  border: "1px solid var(--border-strong)",
};

const qDate: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  color: "var(--text-muted)",
};

const centered: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 16,
  color: "var(--text-secondary)",
  textAlign: "center",
};

const shadowBanner: CSSProperties = {
  padding: "8px 32px",
  background: "var(--warning-bg)",
  color: "var(--warning-text)",
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 1,
  textTransform: "uppercase",
  textAlign: "center",
};

const mesaDownBanner: CSSProperties = {
  padding: "10px 32px",
  background: "var(--danger-bg, var(--warning-bg))",
  color: "var(--danger-text, var(--warning-text))",
  fontSize: 13,
  textAlign: "center",
};

/** Lista de picking impressa: informa que o lote está reservado pra ela. */
const listaBanner: CSSProperties = {
  padding: "9px 32px",
  background: "var(--info-bg)",
  color: "var(--info-text)",
  fontSize: 13,
  textAlign: "center",
};

/** Lista que atravessou a virada do dia — pede decisão. */
const listaBannerAlerta: CSSProperties = {
  ...listaBanner,
  background: "var(--warning-bg)",
  color: "var(--warning-text)",
};

/** "Itens faltantes": ação destrutiva-ish (tira o pedido da fila) mas comum. */
const faltantesBtn: CSSProperties = {
  padding: "12px 20px",
  background: "var(--warning-bg)",
  border: "1px solid var(--warning-border)",
  borderRadius: 10,
  color: "var(--warning-text)",
  fontSize: 14,
  fontWeight: 700,
  cursor: "pointer",
};

const rejectBanner: CSSProperties = {
  padding: "10px 32px",
  background: "var(--warning-bg)",
  color: "var(--warning-text)",
  fontSize: 13,
  fontWeight: 600,
  textAlign: "center",
};

const inlineReconnect: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "inherit",
  textDecoration: "underline",
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 700,
};

/** Preenche o main inteiro — a área de cards (flex 1) é quem dita o fit. */
const orderWrap: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 16,
  width: "100%",
  flex: 1,
  minHeight: 0,
};

/**
 * Viewport dos cards: SEMPRE aceita rolagem (no caso normal o useFitCards faz
 * tudo caber e a barra nem aparece; no pedido gigante rola com barra fininha).
 */
const cardsViewport: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  overflowX: "hidden",
  display: "flex",
  flexDirection: "column",
};

/** margin:auto centraliza quando sobra espaço SEM decepar o topo no overflow
    (justify-content:center cortava — o começo ficava inalcançável). */
const cardsContent: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 14,
  margin: "auto 0",
  paddingBottom: 2,
};

const orderHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 16,
  flexWrap: "wrap",
};

const orderLabel: CSSProperties = {
  fontSize: 10,
  letterSpacing: 2,
  textTransform: "uppercase",
  color: "var(--text-muted)",
  fontWeight: 700,
};

const orderNumber: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 28,
  fontWeight: 700,
  color: "var(--text)",
};

const orderMeta: CSSProperties = { display: "flex", gap: 8, alignItems: "center" };

const badge: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  padding: "3px 10px",
  borderRadius: 6,
  background: "var(--bg-elevated)",
  border: "1px solid var(--border)",
  color: "var(--text-secondary)",
  textTransform: "uppercase",
  letterSpacing: 1,
};

const badgeStrong: CSSProperties = { ...badge, color: "var(--text)", background: "var(--bg-card)" };
const badgeWarn: CSSProperties = {
  ...badge,
  color: "var(--warning-text)",
  background: "var(--warning-bg)",
  border: "1px solid var(--warning-border)",
};
const badgePrio: CSSProperties = {
  ...badge,
  color: "var(--danger-text)",
  background: "var(--danger-bg)",
  border: "1px solid var(--danger-border)",
};

const clienteNomeStyle: CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: "var(--text-secondary)",
};

const progressBadge: CSSProperties = {
  marginLeft: "auto",
  fontFamily: "var(--font-mono)",
  fontSize: 16,
  fontWeight: 700,
  color: "var(--text)",
  padding: "6px 14px",
  borderRadius: 10,
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
};

/** auto-fit + largura máxima + centralizado: pedido de 2 itens não deixa a
    direita da tela morta (cards ficam no meio, tamanho estável). */
const cardsGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 250px))",
  gap: 14,
  justifyContent: "center",
};

const card: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 14,
  overflow: "hidden",
};

const cardDone: CSSProperties = {
  border: "1px solid var(--success-border)",
  boxShadow: "0 0 0 1px var(--success-border)",
};

const cardOffSize: CSSProperties = {
  border: "1px solid var(--info-border)",
};

const cardImageWrap: CSSProperties = {
  position: "relative",
  aspectRatio: "1",
  background: "var(--bg-elevated)",
};

const cardImage: CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
  display: "block",
};

const cardImageEmpty: CSSProperties = {
  width: "100%",
  height: "100%",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  fontSize: 11,
  letterSpacing: 1,
  textTransform: "uppercase",
  color: "var(--text-faint)",
};

const emptyShirtIcon: CSSProperties = { width: 38, height: 38, opacity: 0.6 };

const qtyBadge: CSSProperties = {
  position: "absolute",
  top: 8,
  right: 8,
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  fontWeight: 700,
  padding: "3px 8px",
  borderRadius: 8,
  background: "rgba(0, 0, 0, 0.65)",
  color: "#fafafa",
};

const qtyBadgeMulti: CSSProperties = {
  ...qtyBadge,
  background: "var(--warning-dot)",
  color: "#0a0a0a",
  fontSize: 14,
};

const checkRing = (ok: boolean): CSSProperties => ({
  position: "absolute",
  top: 8,
  left: 8,
  width: 26,
  height: 26,
  borderRadius: "50%",
  display: "grid",
  placeItems: "center",
  fontSize: 14,
  fontWeight: 800,
  color: ok ? "#0a0a0a" : "transparent",
  background: ok ? "var(--success-dot)" : "rgba(0, 0, 0, 0.4)",
  border: `2px solid ${ok ? "var(--success-dot)" : "rgba(255, 255, 255, 0.35)"}`,
});

const cardBody: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "10px 12px 12px",
};

const cardName: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  color: "var(--text)",
  lineHeight: 1.3,
  minHeight: 36,
};

const cardFooter: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};

const cardFooterRight: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
};

const cardEan: CSSProperties = {
  fontSize: 11,
  color: "var(--text-muted)",
  fontFamily: "var(--font-mono)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const cardCount: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  fontWeight: 700,
  color: "var(--text)",
};

const sizeChip: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  fontWeight: 700,
  padding: "2px 9px",
  borderRadius: 999,
  background: "var(--success-bg)",
  color: "var(--success-text)",
  border: "1px solid var(--success-border)",
};

const sizeChipOff: CSSProperties = {
  ...sizeChip,
  background: "var(--info-bg)",
  color: "var(--info-text)",
  border: "1px solid var(--info-border)",
};

/** Alerta de grade mista: banner de verdade, não texto solto — o operador
    precisa bater o olho e ver que tem tamanho diferente no pedido. */
const sizeBanner: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "11px 16px",
  background: "var(--info-bg)",
  border: "1px solid var(--info-border)",
  borderRadius: 10,
  color: "var(--info-text)",
  fontSize: 14,
  fontWeight: 700,
  textAlign: "center",
};

const actionsRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 12,
  marginTop: 8,
};

/** Ação principal: verde sólido de alto contraste. */
const primaryBtn: CSSProperties = {
  padding: "13px 24px",
  background: "var(--success-dot)",
  color: "#04150c",
  border: "1px solid var(--success-dot)",
  borderRadius: 10,
  cursor: "pointer",
  fontSize: 15,
  fontWeight: 800,
};

/** Estado de espera ("Aguardando leitura…"): verde suave, mas legível — não some. */
const primaryBtnDisabled: CSSProperties = {
  ...primaryBtn,
  background: "var(--success-bg)",
  border: "1px solid var(--success-border)",
  color: "var(--success-text)",
  cursor: "not-allowed",
  fontWeight: 700,
};

const ghostBtn: CSSProperties = {
  padding: "13px 20px",
  background: "transparent",
  color: "var(--text-secondary)",
  border: "1px solid var(--border-strong)",
  borderRadius: 10,
  cursor: "pointer",
  fontSize: 14,
  fontWeight: 600,
};

const supervisorBtn: CSSProperties = {
  ...ghostBtn,
  color: "var(--warning-text)",
  border: "1px dashed var(--border-strong)",
};

const errorBox: CSSProperties = {
  padding: "12px 16px",
  background: "var(--warning-bg)",
  border: "1px solid var(--warning-border)",
  borderRadius: 10,
  color: "var(--warning-text)",
  fontSize: 13,
  maxWidth: 460,
};

const emptyTitle: CSSProperties = {
  fontFamily: "var(--font-display)",
  fontSize: 44,
  color: "var(--text)",
};

const emptyText: CSSProperties = { fontSize: 14, color: "var(--text-secondary)", maxWidth: 420 };

const mesaChip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 8,
  padding: "7px 12px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 999,
  cursor: "pointer",
  color: "var(--text-secondary)",
};

const mesaDot: CSSProperties = { width: 8, height: 8, borderRadius: "50%" };

const mesaText: CSSProperties = { fontSize: 12, fontWeight: 600 };

// --- Novidades v0.5: sobressalentes, console de leitura, filtros, histórico ---

const topBarBtn: CSSProperties = {
  padding: "8px 14px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 999,
  color: "var(--text-secondary)",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
  whiteSpace: "nowrap",
};

/** Sobressalente é BLOQUEIO, não aviso — vermelho de verdade, como no legado. */
const extrasBanner: CSSProperties = {
  padding: "12px 32px",
  background: "var(--danger-bg)",
  color: "var(--danger-text)",
  border: "1px solid var(--danger-border)",
  fontSize: 14,
  fontWeight: 700,
  textAlign: "center",
};

const noticeBanner: CSSProperties = {
  padding: "9px 32px",
  background: "var(--info-bg)",
  color: "var(--info-text)",
  fontSize: 13,
  fontWeight: 600,
  textAlign: "center",
};

const sidebarHint: CSSProperties = {
  margin: "6px 14px 0",
  fontSize: 11,
  color: "var(--text-faint)",
};

const cardExcedido: CSSProperties = {
  border: "1px solid var(--danger-border)",
  boxShadow: "0 0 0 2px var(--danger-border)",
};

const cardBodyDense: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: "8px 10px 10px",
};

const cardNameDense: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text)",
  lineHeight: 1.25,
  minHeight: 0,
  overflow: "hidden",
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
};

const cardCountExcedido: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  fontWeight: 800,
  color: "var(--danger-text)",
};

const emptyShirtIconDense: CSSProperties = { width: 26, height: 26, opacity: 0.6 };

const restartBtn: CSSProperties = {
  padding: "13px 20px",
  background: "var(--danger-bg)",
  color: "var(--danger-text)",
  border: "1px solid var(--danger-border)",
  borderRadius: 10,
  cursor: "pointer",
  fontSize: 14,
  fontWeight: 800,
};

/** Concluir travado por sobressalente: vermelho apagado, mensagem no botão. */
const primaryBtnBlocked: CSSProperties = {
  padding: "13px 24px",
  background: "var(--danger-bg)",
  border: "1px solid var(--danger-border)",
  color: "var(--danger-text)",
  borderRadius: 10,
  cursor: "not-allowed",
  fontSize: 15,
  fontWeight: 700,
};

// --- Console de leitura (coluna direita) ---

const logPanel: CSSProperties = {
  width: 300,
  flexShrink: 0,
  display: "flex",
  flexDirection: "column",
  borderLeft: "1px solid var(--border)",
  background: "var(--bg-elevated)",
  minHeight: 0,
};

const logHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "14px 16px",
  borderBottom: "1px solid var(--border)",
};

const logDot: CSSProperties = { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 };

const logTitle: CSSProperties = { fontSize: 14, fontWeight: 700, color: "var(--text)", flex: 1 };

const logCount: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--text-muted)",
};

/** Sobressalentes pinados no topo do console — fora do scroll, não afundam. */
const extrasPinned: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: 12,
  background: "var(--danger-bg)",
  borderBottom: "2px solid var(--danger-border)",
  animation: "extra-pulse 1.6s ease-in-out infinite",
};

const extrasPinnedTitle: CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: "var(--danger-text)",
  letterSpacing: 0.3,
};

const extrasPinnedItem: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 10px",
  borderRadius: 10,
  background: "var(--bg-card)",
  border: "1px solid var(--danger-border)",
};

const extrasPinnedThumb: CSSProperties = {
  width: 44,
  height: 44,
  objectFit: "cover",
  borderRadius: 8,
  flexShrink: 0,
  border: "1px solid var(--danger-border)",
};

const extrasPinnedBody: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  minWidth: 0,
};

const extrasPinnedLabel: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "var(--text)",
  lineHeight: 1.3,
};

const extrasPinnedKind: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "var(--danger-text)",
};

const extrasPinnedHint: CSSProperties = {
  fontSize: 11,
  color: "var(--danger-text)",
  opacity: 0.85,
};

const logList: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: 12,
};

const logEmpty: CSSProperties = {
  fontSize: 12,
  color: "var(--text-muted)",
  lineHeight: 1.5,
  padding: "8px 4px",
};

const logEntryStyle = (status: LogEntry["status"]): CSSProperties => ({
  display: "flex",
  flexDirection: "column",
  gap: 3,
  padding: "8px 10px",
  borderRadius: 10,
  background:
    status === "ok" ? "var(--success-bg)" : status === "extra" ? "var(--danger-bg)" : "var(--warning-bg)",
  border: `1px solid ${
    status === "ok"
      ? "var(--success-border)"
      : status === "extra"
        ? "var(--danger-border)"
        : "var(--warning-border)"
  }`,
});

const logEntryTop: CSSProperties = { display: "flex", alignItems: "baseline", gap: 7 };

const logStatusIcon: CSSProperties = { fontSize: 12, fontWeight: 800, flexShrink: 0 };

const logDesc: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text)",
  lineHeight: 1.3,
  minWidth: 0,
};

const logMetaRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
};

const logEpc: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  color: "var(--text-muted)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const logTime: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  color: "var(--text-faint)",
  flexShrink: 0,
};

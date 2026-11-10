// Picking Geral — a visão agregada da fila que o posvenda tinha atrás do
// contador de pedidos: TODOS os produtos que a fila precisa, agrupados por
// tamanho, com SKU/Produto/Qtd. É a folha que a separadora leva pra prateleira
// e traz tudo de uma vez, em vez de ir e voltar pedido a pedido.
//
// Mesma tela pra fila de puros e de mistos — muda o agregado (no misto os itens
// vêm de tamanhos variados e as seções aparecem todas) e o RECORTE: nos mistos
// o tamanho da própria bancada fica de fora, porque aquelas peças já estão ali.
//
// Com o Filtro Mistos ativo (só filas de mistos) a folha muda de forma: em vez
// de seções por tamanho, uma linha por PRODUTO com a grade das peças de OUTRO
// tamanho dos pedidos da lista (`lib/mistos.ts`) e a etiqueta sai por
// `lib/mistosPdf.ts`.
//
// Impressão pelo caminho silencioso do app (lib/printer.ts + lib/pickingPdf.ts),
// em ETIQUETA 100×150 mm e na impressora de etiquetas configurada — é a única
// que as bancadas têm.

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { ApiError } from "../lib/api";
import { SEM_TAMANHO, queueFor } from "../lib/filas";
import { agregarLote } from "../lib/agregarLote";
import { gerarPickingPdf, type PickingSecao } from "../lib/pickingPdf";
import {
  TAMANHOS_MISTOS,
  fechamCom,
  pedidosMistosNosFiltros,
  pedidoMistoDoLote,
  pedidosMistos,
  pickingMistos,
  totalDele,
  totalFora,
} from "../lib/mistos";
import { gerarMistosPdf } from "../lib/mistosPdf";
import { miniatura } from "../lib/imagens";
import { printPdfBase64 } from "../lib/printer";
import { getLabelPrinter } from "../services/printerConfig";
import {
  getQueueProducts,
  marcarListaImpressa,
  type CanalSeparacao,
  type Order,
  type QueueFilters,
  type QueueProduct,
  type SeparationMode,
} from "../services/orders";

/** Ordem das seções: as filas reais primeiro, o resto em ordem alfabética. */
const ORDEM_TAMANHOS = ["PP", "P", "M", "G", "GG", "XG", "XXG", "G1", "G2", "G3"];

function ordemDe(t: string): number {
  const i = ORDEM_TAMANHOS.indexOf(t);
  if (i >= 0) return i;
  return t === SEM_TAMANHO ? 999 : 500;
}

type Secao = {
  tamanho: string;
  produtos: QueueProduct[];
  itens: number;
  pedidos: number;
  /** Rótulo quando a seção não é um tamanho (ex.: o pedido em conferência). */
  rotulo?: string;
  /** Pedidos que contribuem pra esta seção — o que `marcarListaImpressa`
   *  carimba quando ela imprime só ESTA seção (`escopo: 'secao'`). */
  orderIds: string[];
};

/** Seção do pedido que continua na mesa mesmo fora do recorte (ver `Props`). */
const FORA_DO_FILTRO = "Em conferência (fora do filtro)";

/** De onde sai o agregado: o LOTE dela (padrão) ou a fila inteira. */
type Escopo = "lote" | "fila";

type Props = {
  queue: { mode: SeparationMode; size: string; sizes: string[]; canal?: CanalSeparacao };
  /** Filtros ativos — data de emissão (recorte De/Até, pontas opcionais) e
   *  produto. O picking mostra exatamente o que a fila/sidebar mostram. */
  filters: QueueFilters;
  /** O LOTE da operadora — a folha que ela leva pra prateleira sai DAQUI.
   *  JÁ recortado por produto E por data, igual à sidebar. */
  loteBruto: Order[];
  /** Listas impressas em aberto do lote (só com 2+ aparece o seletor de qual reimprimir). */
  listas?: { chave: string; numero: number; qtd: number }[];
  /**
   * Pedido que ela está conferindo e que ficou FORA do recorte (tem leitura,
   * então não sai da mesa nem do lote no servidor). Sai numa seção própria da
   * folha: some dela seria esconder peça que está na bancada, e misturá-la com
   * o recorte faria "Meu lote" contar o que o filtro dizia ter tirado.
   */
  emConferencia?: Order | null;
  /** Primeiro nome de quem está operando (título da folha). */
  operadora: string;
  /** Termos da exclusão global do galpão (o claim une com `filters.excludeProducts`). */
  exclusoesGlobais?: string[];
  /** Avisa o runner que a lista do lote foi impressa (prende os pedidos).
   *  `listaId` é o id de `separacao_listas` criado (`null` = nexus antigo,
   *  sem o carimbo, ou nenhum pedido válido pra carimbar). */
  onListaImpressa?: (orderIds: string[], listaId: string | null) => void;
  /** Liga/desliga enquanto carimba+imprime: o runner congela o `puxarLote` nesse meio. */
  onImprimindo?: (v: boolean) => void;
  /** Zera data + filtros de produto da estação (o banner "recorte ativo"). */
  onLimparFiltros?: () => void;
  /**
   * NOVA LISTA de mistos (15/10): o runner passa em `lote` SÓ os pedidos da
   * lista em montagem (sem `listaEm`) e este rótulo no lugar de "Meu lote".
   * "Imprimir Tudo" carimba e imprime só eles; a lista anterior, que ainda
   * está na coleta, nunca é reimpressa nem carimbada de novo.
   */
  rotuloLote?: string;
  onClose: () => void;
};

export function PickingGeralModal({
  queue,
  filters,
  loteBruto,
  listas = [],
  emConferencia,
  operadora,
  exclusoesGlobais,
  onListaImpressa,
  onImprimindo,
  onLimparFiltros,
  rotuloLote,
  onClose,
}: Props) {
  // null = todas as listas; senão só a escolhida (reimpressão e carimbo).
  const [listaSel, setListaSel] = useState<string | null>(null);
  // Seleção EFETIVA: se a lista escolhida sumiu do lote (concluída/devolvida com o
  // modal aberto, ou a chave trocou de `listaId` pra `listaEm` num recarregamento),
  // volta pra "todas" — senão a folha e o carimbo saíam com só parte do lote
  // rotulados como "Meu lote", e o seletor já teria sumido pra desfazer.
  const sel = listaSel && listas.some((l) => l.chave === listaSel) ? listaSel : null;
  const lote = useMemo(
    () => (sel ? loteBruto.filter((o) => (o.listaId ?? o.listaEm) === sel) : loteBruto),
    [loteBruto, sel],
  );
  const listaEscolhida = sel ? listas.find((l) => l.chave === sel) : undefined;
  const nomeDoLote =
    rotuloLote ?? (listaEscolhida ? `Lista ${listaEscolhida.numero} (${lote.length})` : `Meu lote (${lote.length})`);
  // O LOTE é o padrão: é a folha que a operadora leva pra prateleira. "Fila
  // inteira" continua a um clique, pra quem quer ver o que ainda vem.
  const [escopo, setEscopo] = useState<Escopo>("lote");
  const [products, setProducts] = useState<QueueProduct[] | null>(null);
  const [resumoApi, setResumoApi] = useState<{ pedidos: number; itens: number; produtos: number } | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [imprimindo, setImprimindo] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const produtosDoLote = useMemo(() => agregarLote(lote, queue.mode), [lote, queue.mode]);

  useEffect(() => {
    // Lote: agregado local, sem rede — os pedidos já estão em memória.
    if (escopo === "lote") {
      setErro(null);
      setProducts(produtosDoLote);
      setResumoApi({
        pedidos: lote.length,
        itens: produtosDoLote.reduce((a, p) => a + p.quantidade, 0),
        produtos: produtosDoLote.length,
      });
      return;
    }
    let alive = true;
    setProducts(null);
    setErro(null);
    getQueueProducts({
      mode: queue.mode,
      size: queue.size,
      // BUCKET da fila: `XG` cobre XXG/G1/G2/G3 — sem o plural a folha da fila
      // mostrava só o tamanho-rótulo, uma fila diferente da que ela separa.
      sizes: queue.sizes,
      dateFrom: filters.dateFrom,
      dateTo: filters.dateTo,
      filters,
      canal: queue.canal,
    })
      .then((d) => {
        if (!alive) return;
        setProducts(d.products);
        setResumoApi(d.resumo ?? null);
      })
      .catch((e) => {
        if (!alive) return;
        setProducts([]);
        setErro(
          e instanceof ApiError && e.status === 404
            ? "O servidor ainda não lista os produtos da fila (aguardando atualização do nexus)."
            : e instanceof Error
              ? e.message
              : String(e),
        );
      });
    return () => {
      alive = false;
    };
    // `filters` entra por referência estável do runner (state) — o efeito só
    // roda de novo quando a operadora troca o filtro, que é o que se quer.
  }, [escopo, produtosDoLote, lote.length, queue.mode, queue.size, queue.sizes, filters]);

  // MISTOS: o tamanho da própria bancada não entra na folha. Na fila de mistos
  // GG as peças GG já estão com ela na bancada — o que ela precisa buscar na
  // prateleira são os OUTROS tamanhos do pedido. Vale pro lote e pra fila
  // inteira. Nos PUROS nada é tirado: ali a lista é a própria bancada.
  const bancada = queue.mode === "total" ? queue.size : null;

  // Recorte por NOME, defensivo: desde 26/08 o nexus aplica os filtros de
  // produto no próprio `queue-products`, e o LOTE já nasceu filtrado. Isto
  // sobra pra nexus antigo, que ignora os campos e devolveria a fila inteira.
  const visiveis = useMemo(() => {
    if (!products) return [];
    const inc = (filters.includeProducts ?? []).map((t) => t.toLowerCase());
    const exc = (filters.excludeProducts ?? []).map((t) => t.toLowerCase());
    // BUCKET, o mesmo do claim (lib/filas.ts): a fila XG tira também
    // XXG/G1/G2/G3, a fila P tira PP. `queue.sizes` entra junto porque é a
    // lista de tamanhos reais que o claim usou pra montar este lote.
    const naBancada = (tamanho: string) =>
      bancada !== null && (queueFor(tamanho) === bancada || queue.sizes.includes(tamanho));
    return products.filter((p) => {
      const tamanho = p.tamanho?.trim().toUpperCase() || SEM_TAMANHO;
      if (naBancada(tamanho)) return false;
      const nome = p.nome.toLowerCase();
      if (exc.some((t) => nome.includes(t))) return false;
      if (inc.length > 0 && !inc.some((t) => nome.includes(t))) return false;
      return true;
    });
  }, [products, filters, bancada, queue.sizes]);

  // Seção à parte do pedido em conferência fora do recorte: só no escopo
  // LOTE (na fila inteira ele nem é dela) e sem passar pelo filtro de produto
  // — é justamente o que o filtro tirou que precisa aparecer aqui.
  const secaoEmConferencia = useMemo<Secao | null>(() => {
    if (escopo !== "lote" || !emConferencia) return null;
    const produtos = agregarLote([emConferencia], queue.mode);
    if (produtos.length === 0) return null;
    return {
      tamanho: FORA_DO_FILTRO,
      rotulo: FORA_DO_FILTRO,
      produtos: [...produtos].sort((a, b) => b.quantidade - a.quantidade),
      itens: produtos.reduce((a, p) => a + p.quantidade, 0),
      pedidos: 1,
      orderIds: [emConferencia.id],
    };
  }, [escopo, emConferencia, queue.mode]);

  const secoes = useMemo<Secao[]>(() => {
    const mapa = new Map<string, QueueProduct[]>();
    for (const p of visiveis) {
      const t = (p.tamanho?.trim().toUpperCase() || SEM_TAMANHO) as string;
      const arr = mapa.get(t);
      if (arr) arr.push(p);
      else mapa.set(t, [p]);
    }
    return Array.from(mapa.entries())
      .map(([tamanho, produtos]) => {
        const ids = new Set<string>();
        let itens = 0;
        for (const p of produtos) {
          itens += p.quantidade;
          for (const id of p.orderIds) ids.add(id);
        }
        return {
          tamanho,
          produtos: [...produtos].sort((a, b) => b.quantidade - a.quantidade),
          itens,
          pedidos: ids.size,
          orderIds: [...ids],
        };
      })
      .sort((a, b) => ordemDe(a.tamanho) - ordemDe(b.tamanho) || a.tamanho.localeCompare(b.tamanho));
  }, [visiveis]);

  /** O que a tela lista e o que a impressão manda: recorte + fora do filtro. */
  const secoesVisiveis = useMemo<Secao[]>(
    () => (secaoEmConferencia ? [...secoes, secaoEmConferencia] : secoes),
    [secoes, secaoEmConferencia],
  );

  // ---- Filtro Mistos: visão por produto ----
  const mistosAtivos = queue.mode === "total" && (filters.mistosProdutos?.length ?? 0) > 0;
  const pedidosM = useMemo(() => {
    if (!mistosAtivos) return [];
    if (escopo === "lote") {
      // O pedido em conferência (fora do recorte) NÃO entra: não está no carimbo
      // da folha, e o recorte nunca se mistura com ele.
      return lote.map((o) => pedidoMistoDoLote(o, queue.size));
    }
    // Fila inteira: tira o que a exclusão (galpão ∪ estação) e a adição barram
    // no claim — senão a folha lista misto que nunca vem (Victor, 07/11).
    return fechamCom(
      pedidosMistosNosFiltros(
        // `loteBruto`: a consulta da fila inteira não é recortada pela lista escolhida.
        pedidosMistos({ fila: products ?? [], lote: loteBruto, size: queue.size, sizes: queue.sizes }),
        [...(exclusoesGlobais ?? []), ...(filters.excludeProducts ?? [])],
        filters.includeProducts,
      ),
      filters.mistosProdutos ?? [],
    );
  }, [mistosAtivos, escopo, lote, products, queue.size, queue.sizes, filters.mistosProdutos, filters.excludeProducts, filters.includeProducts, exclusoesGlobais]);
  const linhasMistos = useMemo(() => pickingMistos(pedidosM, queue.size), [pedidosM, queue.size]);

  // Totais: os da API quando vierem (fila inteira), senão recalculados aqui.
  // Filtro de produto ou recorte da bancada ⇒ o resumo da API conta demais.
  const filtrando = (filters.includeProducts?.length ?? 0) + (filters.excludeProducts?.length ?? 0) > 0;
  const recortando = filtrando || bancada !== null || secaoEmConferencia !== null;
  const total = useMemo(() => {
    if (resumoApi && !recortando) return resumoApi;
    const ids = new Set<string>();
    let itens = 0;
    for (const p of visiveis) {
      itens += p.quantidade;
      for (const id of p.orderIds) ids.add(id);
    }
    if (secaoEmConferencia) {
      itens += secaoEmConferencia.itens;
      ids.add("em-conferencia");
    }
    return {
      produtos: visiveis.length + (secaoEmConferencia?.produtos.length ?? 0),
      itens,
      pedidos: ids.size,
    };
  }, [resumoApi, recortando, visiveis, secaoEmConferencia]);

  const dataLabel = labelRecorte(filters.dateFrom, filters.dateTo) ?? "todas as datas";
  const escopoLabel = escopo === "lote" ? (rotuloLote ?? "Meu lote") : "Fila inteira";
  const semBancada = bancada ? `sem ${bancada} (bancada)` : null;
  const filaLabel = `Fila ${queue.size} · ${queue.mode === "total" ? "Mistos" : "Puros"}${queue.canal === "mercado_livre" ? " · Mercado Livre" : ""}`;
  const subtitulo =
    `${escopoLabel} · ${dataLabel} · ${total.produtos} produtos • ${total.itens} itens • ${total.pedidos} pedidos` +
    (semBancada ? ` · ${semBancada}` : "");

  const imprimir = async (apenas?: Secao) => {
    if (imprimindo) return;
    const alvo = apenas ? [apenas] : secoesVisiveis;
    if (mistosAtivos ? linhasMistos.length === 0 : alvo.length === 0) {
      setStatus("Nada pra imprimir nesta fila.");
      return;
    }
    setImprimindo(true);
    onImprimindo?.(true);
    setStatus("Reservando os pedidos…");
    try {
      // CARIMBO PRIMEIRO, papel depois (04/09): é o carimbo em `separacao_listas`
      // que prende os pedidos na mesa dela e permite recuperar; uma folha sem
      // carimbo é o "mistos sumiram". Se o nexus não carimbar, NÃO imprime.
      let presos = 0;
      let listaIdCarimbo: string | null = null;
      let idsCarimbados: string[] = [];
      if (escopo === "lote") {
        idsCarimbados = apenas ? apenas.orderIds : lote.map((o) => o.id);
        if (idsCarimbados.length > 0) {
          try {
            const resultado = await marcarListaImpressa({
              orderIds: idsCarimbados,
              escopo: apenas ? "secao" : "lote",
              filtros: filters,
              secoes: mistosAtivos
                ? [{ tamanho: "MISTOS", linhas: linhasMistos.map((l) => ({ produto: l.produto, qtd: l.total })) }]
                : alvo.map((s) => ({
                    tamanho: s.rotulo ?? s.tamanho,
                    linhas: s.produtos.map((p) => ({ produto: p.nome, qtd: p.quantidade })),
                  })),
            });
            presos = resultado.presos;
            listaIdCarimbo = resultado.listaId;
          } catch (e) {
            setStatus(
              `Os pedidos NÃO ficaram reservados (${e instanceof Error ? e.message : String(e)}). ` +
                "A folha não foi impressa — tente de novo.",
            );
            return;
          }
          if (presos > 0) onListaImpressa?.(idsCarimbados, listaIdCarimbo);
        }
      }
      setStatus("Enviando pra impressora…");
      const base64 = mistosAtivos
        ? gerarMistosPdf({
            fila: queue.size,
            pedidos: pedidosM.length,
            linhas: linhasMistos,
            consulta: escopo === "fila",
          })
        : gerarPickingPdf({
            operadora,
            fila: filaLabel,
            escopo: `${escopo === "lote" ? nomeDoLote : "Fila inteira"} · ${dataLabel}`,
            observacao: semBancada,
            secoes: alvo.map<PickingSecao>((s) => ({
              tamanho: s.tamanho,
              produtos: s.produtos.length,
              itens: s.itens,
              pedidos: s.pedidos,
              linhas: s.produtos.map((p) => ({ produto: p.nome, qtd: p.quantidade })),
            })),
          });
      // A impressora de ETIQUETAS configurada em Configurações — a mesma da
      // etiqueta J&T e da DANFE. Cair na "padrão do Windows" foi o que mandou
      // a folha A4 pra térmica de 100×150 e a deixou ilegível.
      const out = await printPdfBase64(base64, {
        printer: getLabelPrinter(),
        jobName: mistosAtivos
          ? `Mistos ${queue.size}${escopo === "fila" ? " (consulta)" : ""}`
          : apenas
            ? `Picking ${apenas.tamanho}`
            : `Picking Geral ${queue.size}`,
      });
      setStatus(
        out.ok
          ? `Enviado${out.printer ? ` pra ${out.printer}` : " pra impressora padrão"}.` +
            (escopo === "lote"
              ? presos > 0
                ? ` ${presos} pedidos ficam reservados com você até o fim do dia.`
                : ""
              : " Folha de CONSULTA da fila inteira — NÃO reserva pedidos.")
          : `Falha ao imprimir: ${out.message ?? "motivo desconhecido"}` +
            (presos > 0 ? ` (os ${presos} pedidos continuam reservados — imprima de novo)` : ""),
      );
    } catch (e) {
      setStatus(`Falha ao imprimir: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      onImprimindo?.(false);
      setImprimindo(false);
    }
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={box} onClick={(e) => e.stopPropagation()}>
        <div style={headerRow}>
          <div style={headerText}>
            <h2 style={titulo}>Picking Geral — {operadora}</h2>
            <span style={sub}>
              {products === null
                ? "Carregando a fila…"
                : mistosAtivos
                  ? `${filaLabel} · ${escopoLabel} · ${dataLabel}`
                  : subtitulo}
            </span>
            {mistosAtivos && products !== null && (
              <span style={sub}>
                Peças de outro tamanho dos {pedidosM.length} pedidos da lista, do maior pro menor.
              </span>
            )}
          </div>
          <div style={escopoTabs}>
            {(["lote", "fila"] as const).map((e) => (
              <button
                key={e}
                style={escopo === e ? escopoTabOn : escopoTab}
                onClick={() => setEscopo(e)}
                disabled={imprimindo}
              >
                {e === "lote" ? nomeDoLote : "Fila inteira"}
              </button>
            ))}
          </div>
          {listas.length >= 2 && escopo === "lote" && !rotuloLote && (
            <div style={escopoTabs}>
              <button
                type="button"
                style={sel === null ? escopoTabOn : escopoTab}
                aria-pressed={sel === null}
                title="Imprimir o lote inteiro"
                onClick={() => setListaSel(null)}
                disabled={imprimindo}
              >
                Todas ({loteBruto.length})
              </button>
              {listas.map((l) => (
                <button
                  key={l.chave}
                  type="button"
                  style={sel === l.chave ? escopoTabOn : escopoTab}
                  aria-pressed={sel === l.chave}
                  title={`Imprimir só a lista ${l.numero}`}
                  onClick={() => setListaSel(l.chave)}
                  disabled={imprimindo}
                >
                  Lista {l.numero} ({l.qtd})
                </button>
              ))}
            </div>
          )}
          <button
            style={imprimindo ? imprimirBtnOff : imprimirBtn}
            onClick={() => void imprimir()}
            disabled={imprimindo || products === null}
          >
            🖨 Imprimir Tudo
          </button>
          <button style={fecharBtn} onClick={onClose} title="Fechar (Esc)">
            ×
          </button>
        </div>

        {erro && <div style={avisoBox}>{erro}</div>}
        {status && <div style={statusBox}>{status}</div>}
        {(filters.dateFrom || filters.dateTo || filtrando) && (
          // Filtro herdado da estação (localStorage) é o motivo nº 1 de "o
          // Picking não aparece / não tem botão de imprimir" (relatos de
          // 28/08 e 02/09): a folha vem vazia e a mensagem lá embaixo não
          // era vista. O recorte agora grita no topo, com o botão de limpar.
          <div style={filtrosBanner} role="status">
            <span style={filtrosBannerIcon} aria-hidden="true">
              !
            </span>
            <span style={filtrosBannerTexto}>
              <strong>Filtros ativos nesta estação:</strong>{" "}
              {[
                labelRecorte(filters.dateFrom, filters.dateTo),
                (filters.excludeProducts?.length ?? 0) > 0
                  ? `${filters.excludeProducts!.length} produto${filters.excludeProducts!.length === 1 ? "" : "s"} excluído${filters.excludeProducts!.length === 1 ? "" : "s"}`
                  : null,
                (filters.includeProducts?.length ?? 0) > 0
                  ? `só ${filters.includeProducts!.length} produto${filters.includeProducts!.length === 1 ? "" : "s"}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              . Produtos fora do recorte não aparecem nem saem na folha.
            </span>
            {onLimparFiltros && (
              <button style={filtrosBannerBtn} onClick={onLimparFiltros}>
                Limpar filtros
              </button>
            )}
          </div>
        )}

        <div className="thin-scroll" style={corpo}>
          {products === null && !erro && <span style={vazio}>Carregando produtos da fila…</span>}
          {mistosAtivos && products !== null && (
            <>
              <div style={numsRow}>
                <div style={numCardAmbar}>
                  <small style={numLabel}>PEÇAS DO FILTRO MISTOS</small>
                  <b style={numGrandeAmbar}>{totalFora(pedidosM)}</b>
                </div>
                <div style={numCard}>
                  <small style={numLabel}>PEÇAS DA FILA DO {queue.size}</small>
                  <b style={numGrande}>{totalDele(pedidosM)}</b>
                </div>
              </div>
              {escopo === "lote" && emConferencia && (
                <span style={mistoSub}>
                  Pedido #{emConferencia.numero ?? emConferencia.tinyOrderId ?? emConferencia.id.slice(0, 8)} em
                  conferência está fora do filtro e não entra nesta folha.
                </span>
              )}
              {linhasMistos.length === 0 && !erro && <span style={vazio}>Nenhuma peça de outro tamanho nesta lista.</span>}
              {linhasMistos.map((l) => (
                <div key={l.produto} style={mistoLinha}>
                  {l.imagemUrl ? (
                    <img src={miniatura(l.imagemUrl) ?? undefined} alt="" style={mistoFoto} loading="lazy" decoding="async" />
                  ) : (
                    <span style={{ ...mistoFoto, display: "grid", placeItems: "center", color: "var(--text-faint)", fontWeight: 700 }}>?</span>
                  )}
                  <div style={mistoMeio}>
                    <span style={mistoNome}>{l.produto}</span>
                    <small style={mistoSub}>
                      em {l.pedidos} {l.pedidos === 1 ? "pedido" : "pedidos"}
                    </small>
                    <div style={mistoGrade}>
                      {TAMANHOS_MISTOS.map((t) => {
                        const daFila = t === queue.size.toUpperCase();
                        const n = daFila ? 0 : (l.grade[t] ?? 0);
                        return (
                          <span key={t} style={n ? mistoCaixa : mistoCaixaZero}>
                            <b>{t}</b> {n}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                  <div style={mistoTot}>
                    <b style={mistoTotNum}>{l.total}</b>
                    <small style={mistoSub}>peças</small>
                  </div>
                </div>
              ))}
            </>
          )}
          {!mistosAtivos && products !== null && secoesVisiveis.length === 0 && !erro && (
            // "Vazio" quase nunca é a fila estar vazia: é filtro herdado. Os
            // filtros ficam no localStorage da ESTAÇÃO e sobrevivem à troca de
            // fila, então dá pra entrar na fila M com a data de ontem ainda
            // selecionada e ver esta tela sem entender por quê — as
            // separadoras relataram isso como "o Picking Geral não aparece".
            // Por isso a mensagem DIZ qual recorte está ativo.
            <span style={vazio}>
              {recortando
                ? `Nenhum produto com o recorte atual (${[
                    labelRecorte(filters.dateFrom, filters.dateTo),
                    filtrando ? "filtro de produto" : null,
                    semBancada,
                  ]
                    .filter(Boolean)
                    .join(" · ")}). Revise os filtros na tela da fila.`
                : escopo === "lote"
                  ? "Seu lote está vazio — puxe pedidos na fila ou veja a fila inteira."
                  : "Nenhum produto nesta fila."}
            </span>
          )}
          {!mistosAtivos && secoesVisiveis.map((s) => (
            <section key={s.tamanho} style={secaoWrap}>
              <div style={secaoHeader}>
                <span style={s.rotulo ? foraChip : tamChip}>{s.rotulo ?? s.tamanho}</span>
                <span style={secaoResumo}>
                  {s.produtos.length} produtos • {s.itens} itens • {s.pedidos} pedidos
                </span>
                <div style={{ flex: 1 }} />
                <button
                  style={imprimindo ? secaoBtnOff : secaoBtn}
                  onClick={() => void imprimir(s)}
                  disabled={imprimindo}
                >
                  Imprimir {s.rotulo ? "esta seção" : s.tamanho}
                </button>
              </div>
              <div style={tabela}>
                <div style={thRow}>
                  <span style={thSku}>SKU</span>
                  <span style={thNome}>Produto</span>
                  <span style={thQtd}>Qtd.</span>
                </div>
                {s.produtos.map((p) => (
                  <div key={`${p.nome}-${p.ean ?? ""}`} style={tdRow}>
                    <span style={tdSku}>{p.ean ?? "—"}</span>
                    <span style={tdNome}>{p.nome}</span>
                    <span style={tdQtd}>{p.quantidade}</span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function fmtData(iso: string): string {
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

/**
 * Frase do recorte de data de EMISSÃO pra `dataLabel` (cabeçalho/PDF), o
 * banner de filtros ativos e a mensagem de "nenhum produto" — as três
 * leituras do mesmo `filters.dateFrom`/`dateTo` (pedido de campo de 15/09: o
 * recorte deixou de ser um dia único, agora tem pontas independentes).
 * `null` = nenhuma ponta ativa (recorte vazio).
 */
function labelRecorte(dateFrom?: string, dateTo?: string): string | null {
  if (dateFrom && dateTo) {
    return dateFrom === dateTo
      ? `emissão ${fmtData(dateFrom)}`
      : `emissão de ${fmtData(dateFrom)} até ${fmtData(dateTo)}`;
  }
  if (dateTo) return `emissão até ${fmtData(dateTo)}`;
  if (dateFrom) return `emissão a partir de ${fmtData(dateFrom)}`;
  return null;
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
  width: 900,
  maxWidth: "96vw",
  height: "min(820px, 92vh)",
  background: "var(--bg-elevated)",
  border: "1px solid var(--border-strong)",
  borderRadius: 16,
  padding: "20px 22px",
  display: "flex",
  flexDirection: "column",
  gap: 12,
  boxSizing: "border-box",
};

const headerRow: CSSProperties = { display: "flex", alignItems: "flex-start", gap: 12 };

const headerText: CSSProperties = { display: "flex", flexDirection: "column", gap: 4, flex: 1, minWidth: 0 };

const titulo: CSSProperties = { margin: 0, fontSize: 19, fontWeight: 800, color: "var(--text)" };

const sub: CSSProperties = { fontSize: 12, color: "var(--text-secondary)" };

const escopoTabs: CSSProperties = {
  display: "inline-flex",
  gap: 3,
  padding: 3,
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  flexShrink: 0,
};

const escopoTab: CSSProperties = {
  padding: "7px 14px",
  background: "transparent",
  border: 0,
  borderRadius: 8,
  color: "var(--text-secondary)",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
  fontFamily: "inherit",
};

const escopoTabOn: CSSProperties = {
  ...escopoTab,
  background: "var(--info-bg)",
  color: "var(--info-text)",
};

const imprimirBtn: CSSProperties = {
  padding: "9px 16px",
  background: "var(--success-dot)",
  border: "1px solid var(--success-dot)",
  borderRadius: 9,
  color: "#04150c",
  fontSize: 13,
  fontWeight: 800,
  cursor: "pointer",
  flexShrink: 0,
};

const imprimirBtnOff: CSSProperties = {
  ...imprimirBtn,
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  color: "var(--text-muted)",
  cursor: "wait",
};

const fecharBtn: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "var(--text-muted)",
  fontSize: 24,
  fontWeight: 700,
  cursor: "pointer",
  lineHeight: 1,
  flexShrink: 0,
};

const avisoBox: CSSProperties = {
  padding: "10px 14px",
  background: "var(--warning-bg)",
  border: "1px solid var(--warning-border)",
  borderRadius: 10,
  color: "var(--warning-text)",
  fontSize: 12,
  lineHeight: 1.4,
};

const filtrosBanner: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "12px 14px",
  background: "var(--warning-bg)",
  border: "1px solid var(--warning-border)",
  boxShadow: "0 0 0 1px var(--warning-border)",
  borderRadius: 10,
  color: "var(--text)",
  fontSize: 14,
  lineHeight: 1.4,
};

const filtrosBannerIcon: CSSProperties = {
  flexShrink: 0,
  width: 30,
  height: 30,
  borderRadius: 9,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--warning-bg)",
  border: "1px solid var(--warning-border)",
  color: "var(--warning-text)",
  fontFamily: "var(--font-display)",
  fontSize: 18,
};

const filtrosBannerTexto: CSSProperties = { flex: 1, minWidth: 0 };

const filtrosBannerBtn: CSSProperties = {
  flexShrink: 0,
  padding: "10px 16px",
  borderRadius: 9,
  border: "1px solid transparent",
  background: "var(--warning-dot)",
  color: "#1a1206",
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
  fontFamily: "inherit",
};

const statusBox: CSSProperties = {
  padding: "8px 14px",
  background: "var(--info-bg)",
  border: "1px solid var(--info-border)",
  borderRadius: 10,
  color: "var(--info-text)",
  fontSize: 12,
};

const corpo: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: 20,
};

const vazio: CSSProperties = { fontSize: 13, color: "var(--text-muted)", padding: "12px 4px" };

const secaoWrap: CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };

const secaoHeader: CSSProperties = { display: "flex", alignItems: "center", gap: 10 };

const tamChip: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 13,
  fontWeight: 800,
  padding: "3px 14px",
  borderRadius: 999,
  background: "var(--info-bg)",
  color: "var(--info-text)",
  border: "1px solid var(--info-border)",
};

/** Mesma forma do `tamChip`, cor de aviso: a seção não é um tamanho. */
const foraChip: CSSProperties = {
  ...tamChip,
  fontFamily: "inherit",
  fontSize: 12,
  background: "var(--warning-bg)",
  color: "var(--warning-text)",
  border: "1px solid var(--warning-bg)",
};

const secaoResumo: CSSProperties = { fontSize: 12, color: "var(--text-secondary)" };

const secaoBtn: CSSProperties = {
  padding: "6px 14px",
  background: "var(--bg-card)",
  border: "1px solid var(--border-strong)",
  borderRadius: 8,
  color: "var(--text)",
  fontSize: 12,
  fontWeight: 700,
  cursor: "pointer",
};

const secaoBtnOff: CSSProperties = { ...secaoBtn, color: "var(--text-muted)", cursor: "wait" };

const tabela: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  border: "1px solid var(--border)",
  borderRadius: 10,
  overflow: "hidden",
};

const thRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "7px 12px",
  background: "var(--bg-card)",
  borderBottom: "1px solid var(--border)",
  fontSize: 10,
  fontWeight: 800,
  letterSpacing: 1,
  textTransform: "uppercase",
  color: "var(--text-muted)",
};

const thSku: CSSProperties = { width: 130, flexShrink: 0 };
const thNome: CSSProperties = { flex: 1, minWidth: 0 };
const thQtd: CSSProperties = { width: 54, textAlign: "right", flexShrink: 0 };

const tdRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "7px 12px",
  borderBottom: "1px solid var(--border)",
  fontSize: 13,
};

const tdSku: CSSProperties = {
  ...thSku,
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  color: "var(--text-muted)",
};

const tdNome: CSSProperties = {
  flex: 1,
  minWidth: 0,
  color: "var(--text)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const tdQtd: CSSProperties = {
  width: 54,
  textAlign: "right",
  fontFamily: "var(--font-mono)",
  fontWeight: 800,
  color: "var(--text)",
  flexShrink: 0,
};

// ---- Filtro Mistos: visão por produto ----

const numsRow: CSSProperties = { display: "flex", gap: 10 };

const numCard: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  gap: 2,
  padding: "10px 14px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 10,
};

const numCardAmbar: CSSProperties = {
  ...numCard,
  background: "var(--warning-bg)",
  border: "1px solid var(--warning-border)",
};

const numLabel: CSSProperties = { fontSize: 10, fontWeight: 800, letterSpacing: 1, color: "var(--text-muted)" };

const numGrande: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 32,
  fontWeight: 700,
  color: "var(--text)",
  lineHeight: 1.1,
};

const numGrandeAmbar: CSSProperties = { ...numGrande, color: "var(--warning-text)" };

const mistoLinha: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "8px 12px",
  background: "var(--bg-card)",
  border: "1px solid var(--border)",
  borderRadius: 10,
};

const mistoFoto: CSSProperties = {
  width: 56,
  height: 56,
  borderRadius: 8,
  objectFit: "cover",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  flexShrink: 0,
};

const mistoMeio: CSSProperties = { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 3 };

const mistoNome: CSSProperties = {
  fontSize: 13,
  fontWeight: 800,
  color: "var(--text)",
  textTransform: "uppercase",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const mistoSub: CSSProperties = { fontSize: 11, color: "var(--text-muted)" };

const mistoGrade: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 5, marginTop: 2 };

const mistoCaixa: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  padding: "2px 9px",
  borderRadius: 6,
  background: "var(--bg-input)",
  border: "1px solid var(--border-strong)",
  color: "var(--text)",
};

const mistoCaixaZero: CSSProperties = {
  ...mistoCaixa,
  opacity: 0.35,
  border: "1px dashed var(--border-strong)",
};

const mistoTot: CSSProperties = { display: "flex", flexDirection: "column", alignItems: "flex-end", flexShrink: 0, minWidth: 64 };

const mistoTotNum: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 28,
  fontWeight: 700,
  color: "var(--warning-text)",
  lineHeight: 1.1,
};

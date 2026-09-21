// Etiquetagem AVULSA: imprime etiqueta RFID de um produto do catálogo sem
// passar por lote de produção. Ver NEXUS_ETIQUETAGEM_AVULSA.md — nasceu do
// incidente 18–21/09 (touca/boné vendidos sem SKU, sem lote pra etiquetar).
//
// Dois passos dentro do mesmo modal: busca do produto → grade de tamanho com
// quantidade. SEM modo teste (a API recusa `ehTeste` em job avulso) e SEM
// margem/modo manual do PrintConfirmModal — aqui a operadora já digita a
// quantidade exata por tamanho.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { miniatura } from "../lib/imagens";
import { buildItemsFromEans } from "../lib/printItems";
import type { PrintJobItem } from "../lib/itag/iprint";
import {
  buscarProdutosAvulso,
  fetchProdutoEans,
  type ProdutoBusca,
} from "../services/produtosAvulso";

const DEBOUNCE_MS = 300;

/** `"U"` (tamanho único, o canônico que o nexus já usa) exibido como "Único". */
function tamanhoLabel(tamanho: string): string {
  return tamanho.toUpperCase() === "U" ? "Único" : tamanho;
}

/** Descrição impressa: nome do produto, sem sufixo de tamanho quando `U`. */
function descreverAvulso(nome: string, tamanho: string): string {
  const limpo = nome.trim();
  return tamanho.toUpperCase() === "U" ? limpo : `${limpo} - ${tamanho.toUpperCase()}`;
}

/** Quantidade digitada (string, pra permitir campo vazio) → inteiro 0–999. */
function parseQuantidade(v: string | undefined): number {
  const n = parseInt(v ?? "", 10);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(999, n));
}

function isAbortError(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { name?: string }).name === "AbortError";
}

export type AvulsoPrintResult = {
  produtoId: string;
  produtoNome: string;
  items: PrintJobItem[];
};

/** Estado coerente da grade carregada — produtoId/nome/eans SEMPRE do mesmo
 *  fetch, nunca misturados com o produto atualmente "selecionado" na tela
 *  (que pode já ter mudado por um clique seguinte). */
type GradeCarregada = {
  produtoId: string;
  nome: string;
  thumbnailUrl: string | null;
  eans: { tamanho: string; ean: string | null; sku: string | null }[];
};

type Props = {
  onCancel: () => void;
  onConfirm: (result: AvulsoPrintResult) => void;
  /** Mesmo diálogo de confirmação do resto do app (useDialogo, não `window.confirm`). */
  confirmar: (mensagem: string) => Promise<boolean>;
};

export function PrintAvulsoModal({ onCancel, onConfirm, confirmar }: Props) {
  // === Passo 1: busca ===
  const [query, setQuery] = useState("");
  const [resultados, setResultados] = useState<ProdutoBusca[]>([]);
  const [buscando, setBuscando] = useState(false);
  const [erroBusca, setErroBusca] = useState<string | null>(null);
  // Geração + AbortController: resposta de um termo antigo (rede lenta/fora
  // de ordem) não pode sobrescrever o resultado do termo atual (review 22/09).
  const buscaReqRef = useRef(0);
  const buscaAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const termo = query.trim();
    buscaAbortRef.current?.abort();
    if (!termo) {
      setResultados([]);
      setErroBusca(null);
      setBuscando(false);
      return;
    }
    setBuscando(true);
    const minhaReq = ++buscaReqRef.current;
    const timer = setTimeout(() => {
      const controller = new AbortController();
      buscaAbortRef.current = controller;
      buscarProdutosAvulso(termo, 20, controller.signal)
        .then((itens) => {
          if (buscaReqRef.current !== minhaReq) return; // resposta velha — descarta
          setResultados(itens);
          setErroBusca(null);
        })
        .catch((e) => {
          if (buscaReqRef.current !== minhaReq || isAbortError(e)) return;
          setErroBusca(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (buscaReqRef.current === minhaReq) setBuscando(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // === Passo 2: grade do produto escolhido ===
  // `selecionado` é só o placeholder pra UI reagir na hora do clique (nome/foto
  // da linha da busca); a fonte da verdade pro Imprimir é `grade`, que só
  // existe depois que o fetch daquele MESMO clique voltou.
  const [selecionado, setSelecionado] = useState<ProdutoBusca | null>(null);
  const [grade, setGrade] = useState<GradeCarregada | null>(null);
  const [carregandoGrade, setCarregandoGrade] = useState(false);
  const [erroGrade, setErroGrade] = useState<string | null>(null);
  const [quantidades, setQuantidades] = useState<Record<string, string>>({});
  const gradeReqRef = useRef(0);
  const gradeAbortRef = useRef<AbortController | null>(null);

  const escolherProduto = useCallback((produto: ProdutoBusca) => {
    if (!produto.imprimivel) return;
    gradeAbortRef.current?.abort();
    const controller = new AbortController();
    gradeAbortRef.current = controller;
    const minhaReq = ++gradeReqRef.current;

    setSelecionado(produto);
    setGrade(null);
    setQuantidades({});
    setErroGrade(null);
    setCarregandoGrade(true);

    fetchProdutoEans(produto.produtoId, controller.signal)
      .then((dto) => {
        if (gradeReqRef.current !== minhaReq) return; // troca de produto no meio do voo — descarta
        const nome = dto.produtoNome ?? produto.nome;
        setGrade({
          produtoId: produto.produtoId,
          nome,
          thumbnailUrl: dto.thumbnailUrl ?? produto.imagemUrl,
          eans: dto.eans,
        });
        const q: Record<string, string> = {};
        for (const e of dto.eans) q[e.tamanho] = "0";
        setQuantidades(q);
      })
      .catch((e) => {
        if (gradeReqRef.current !== minhaReq || isAbortError(e)) return;
        setErroGrade(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (gradeReqRef.current === minhaReq) setCarregandoGrade(false);
      });
  }, []);

  const voltarBusca = useCallback(() => {
    gradeAbortRef.current?.abort();
    gradeReqRef.current++; // invalida qualquer resposta ainda em voo
    setSelecionado(null);
    setGrade(null);
    setQuantidades({});
    setErroGrade(null);
    setCarregandoGrade(false);
  }, []);

  // Cancela requisições pendentes se o modal fechar no meio do voo.
  useEffect(() => {
    return () => {
      buscaAbortRef.current?.abort();
      gradeAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // Itens SEMPRE a partir de `grade` (objeto coerente de um único fetch) — nunca
  // de `selecionado`/`produtoNome` soltos, que podem já apontar pro próximo
  // clique da operadora enquanto este ainda calcula.
  const items = grade
    ? buildItemsFromEans(
        grade.eans.map((e) => ({
          size: e.tamanho,
          quantity: parseQuantidade(quantidades[e.tamanho]),
          ean13: e.ean,
          sku: e.sku,
        })),
        (tamanho) => descreverAvulso(grade.nome, tamanho),
        { descartarZeros: true },
      )
    : [];
  const total = items.reduce((sum, i) => sum + i.quantity, 0);

  // Trava de duplo clique — mesmo padrão do `PrintConfirmModal`: o REF muda na
  // hora (o state `enviando` só reflete no próximo render, tarde demais pra
  // barrar um segundo clique físico no mesmo tick). Liberada se a operadora
  // cancelar a confirmação — ela pode querer ajustar a quantidade e tentar de
  // novo.
  const enviandoRef = useRef(false);
  const [enviando, setEnviando] = useState(false);

  const imprimir = useCallback(async () => {
    if (enviandoRef.current) return;
    if (!grade || total <= 0) return;
    enviandoRef.current = true;
    setEnviando(true);
    try {
      const ok = await confirmar(`Imprimir ${total} etiquetas de ${grade.nome}?`);
      if (!ok) {
        enviandoRef.current = false;
        setEnviando(false);
        return;
      }
      onConfirm({ produtoId: grade.produtoId, produtoNome: grade.nome, items });
    } catch (e) {
      enviandoRef.current = false;
      setEnviando(false);
      throw e;
    }
  }, [grade, total, items, confirmar, onConfirm]);

  return (
    <div style={overlay} onClick={onCancel}>
      <div style={modal} onClick={(e) => e.stopPropagation()}>
        <header style={head}>
          <h2 style={headTitle}>
            {selecionado ? "Impressão avulsa" : "Impressão avulsa — buscar produto"}
          </h2>
          <button onClick={onCancel} style={closeBtn} aria-label="Fechar">
            ✕
          </button>
        </header>

        {!selecionado ? (
          <>
            <div style={searchWrap}>
              <input
                autoFocus
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Buscar por nome, EAN ou SKU…"
                style={searchInput}
              />
            </div>

            {erroBusca && <div style={errorBox}>{erroBusca}</div>}

            <div style={resultList}>
              {buscando ? (
                <div style={emptyState}>Buscando…</div>
              ) : !query.trim() ? (
                <div style={emptyState}>Digite pra buscar no catálogo.</div>
              ) : resultados.length === 0 ? (
                <div style={emptyState}>
                  Nada no catálogo pra "{query.trim()}".
                </div>
              ) : (
                resultados.map((p) => (
                  <ResultRow key={p.produtoId} produto={p} onSelect={escolherProduto} />
                ))
              )}
            </div>
          </>
        ) : (
          <>
            <div style={produtoInfo}>
              {(grade?.thumbnailUrl ?? selecionado.imagemUrl) ? (
                <img
                  src={miniatura(grade?.thumbnailUrl ?? selecionado.imagemUrl) ?? undefined}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  style={produtoThumb}
                />
              ) : (
                <span style={produtoThumbPlaceholder} />
              )}
              <span style={produtoNomeStyle}>{grade?.nome ?? selecionado.nome}</span>
              <button onClick={voltarBusca} style={voltarBtn}>
                ↩ Trocar produto
              </button>
            </div>

            {carregandoGrade ? (
              <div style={emptyState}>Carregando tamanhos…</div>
            ) : erroGrade ? (
              <div style={errorBox}>{erroGrade}</div>
            ) : grade ? (
              <div style={tableWrap}>
                <table style={table}>
                  <thead>
                    <tr>
                      <th style={th}>Tamanho</th>
                      <th style={th}>EAN</th>
                      <th style={{ ...th, textAlign: "right" }}>Quantidade</th>
                    </tr>
                  </thead>
                  <tbody>
                    {grade.eans.map((e) => {
                      const disabled = !e.ean;
                      return (
                        <tr key={e.tamanho}>
                          <td style={tdSize}>{tamanhoLabel(e.tamanho)}</td>
                          <td style={disabled ? tdEanMissing : tdEan}>
                            {disabled ? "sem EAN" : e.ean}
                          </td>
                          <td style={tdInputCell}>
                            <input
                              type="number"
                              min={0}
                              max={999}
                              disabled={disabled}
                              // Guarda a string digitada (permite campo vazio
                              // enquanto a operadora apaga pra redigitar); o
                              // clamp 0–999 inteiro só acontece na soma/montagem
                              // dos itens (parseQuantidade), não a cada tecla.
                              value={quantidades[e.tamanho] ?? "0"}
                              onChange={(ev) => {
                                setQuantidades({
                                  ...quantidades,
                                  [e.tamanho]: ev.target.value,
                                });
                              }}
                              style={{
                                ...qtyInput,
                                opacity: disabled ? 0.4 : 1,
                              }}
                            />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : null}

            <div style={summaryBox}>
              Vai imprimir <strong style={summaryNum}>{total}</strong> etiqueta
              {total === 1 ? "" : "s"} RFID
            </div>

            <footer style={foot}>
              <button onClick={onCancel} style={cancelBtn}>
                Cancelar
              </button>
              <button
                onClick={imprimir}
                disabled={enviando || !grade || total === 0}
                style={
                  enviando || !grade || total === 0 ? confirmBtnDisabled : confirmBtn
                }
              >
                Imprimir
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

function ResultRow({
  produto,
  onSelect,
}: {
  produto: ProdutoBusca;
  onSelect: (p: ProdutoBusca) => void;
}) {
  const disabled = !produto.imprimivel;
  return (
    <button
      type="button"
      onClick={() => !disabled && onSelect(produto)}
      disabled={disabled}
      style={disabled ? resultRowDisabled : resultRow}
      title={disabled ? "Sem EAN cadastrado — não dá pra imprimir" : undefined}
    >
      {produto.imagemUrl ? (
        <img
          src={miniatura(produto.imagemUrl) ?? undefined}
          alt=""
          loading="lazy"
          decoding="async"
          style={resultThumb}
        />
      ) : (
        <span style={resultThumbPlaceholder} />
      )}
      <span style={resultInfo}>
        <span style={resultName}>{produto.nome}</span>
        {produto.ean && <span style={resultEan}>{produto.ean}</span>}
      </span>
      {disabled && <span style={semEanBadge}>sem EAN</span>}
    </button>
  );
}

const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.55)",
  display: "grid",
  placeItems: "center",
  zIndex: 100,
  backdropFilter: "blur(2px)",
};

const modal: CSSProperties = {
  width: "min(560px, calc(100vw - 48px))",
  background: "var(--bg-card)",
  border: "1px solid var(--border-strong)",
  borderRadius: 14,
  padding: 24,
  boxShadow: "0 20px 60px rgba(0,0,0,0.4)",
  maxHeight: "calc(100vh - 48px)",
  overflowY: "auto",
};

const head: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: 14,
};

const headTitle: CSSProperties = {
  margin: 0,
  fontSize: 16,
  fontWeight: 600,
  color: "var(--text)",
};

const closeBtn: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "var(--text-muted)",
  cursor: "pointer",
  fontSize: 16,
  padding: "4px 8px",
};

const searchWrap: CSSProperties = {
  marginBottom: 12,
};

const searchInput: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  color: "var(--text)",
  fontSize: 13,
  padding: "10px 12px",
  outline: "none",
  fontFamily: "inherit",
};

const resultList: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  maxHeight: 360,
  overflowY: "auto",
};

const emptyState: CSSProperties = {
  padding: 24,
  textAlign: "center",
  color: "var(--text-muted)",
  fontSize: 13,
};

const errorBox: CSSProperties = {
  background: "var(--danger-bg)",
  color: "var(--danger-text)",
  border: "1px solid var(--danger-border)",
  padding: "10px 14px",
  borderRadius: 8,
  fontSize: 13,
  marginBottom: 12,
  lineHeight: 1.5,
};

const resultRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "8px 10px",
  background: "var(--bg-elevated)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  cursor: "pointer",
  textAlign: "left",
  width: "100%",
  boxSizing: "border-box",
};

const resultRowDisabled: CSSProperties = {
  ...resultRow,
  cursor: "not-allowed",
  opacity: 0.55,
};

const resultThumb: CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: 6,
  objectFit: "cover",
  background: "var(--bg-input)",
  flexShrink: 0,
};

const resultThumbPlaceholder: CSSProperties = {
  ...resultThumb,
  display: "inline-block",
};

const resultInfo: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const resultName: CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: "var(--text)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const resultEan: CSSProperties = {
  fontSize: 11,
  fontFamily: "var(--font-mono)",
  color: "var(--text-faint)",
};

const semEanBadge: CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.5,
  padding: "3px 8px",
  borderRadius: 999,
  background: "var(--warning-bg)",
  color: "var(--warning-text)",
  border: "1px solid var(--warning-border)",
  flexShrink: 0,
  textTransform: "uppercase",
};

const produtoInfo: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 14px",
  background: "var(--bg-elevated)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  marginBottom: 16,
};

const produtoThumb: CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: 6,
  objectFit: "cover",
  background: "var(--bg-input)",
  flexShrink: 0,
};

const produtoThumbPlaceholder: CSSProperties = {
  ...produtoThumb,
  display: "inline-block",
};

const produtoNomeStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 14,
  fontWeight: 600,
  color: "var(--text)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const voltarBtn: CSSProperties = {
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text-muted)",
  fontSize: 11,
  padding: "5px 10px",
  cursor: "pointer",
  whiteSpace: "nowrap",
  flexShrink: 0,
};

const tableWrap: CSSProperties = {
  background: "var(--bg-elevated)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  overflow: "hidden",
  marginBottom: 14,
};

const table: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 13,
};

const th: CSSProperties = {
  textAlign: "left",
  padding: "8px 12px",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: 0.7,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  borderBottom: "1px solid var(--border)",
  background: "var(--bg-card)",
};

const tdSize: CSSProperties = {
  padding: "8px 12px",
  fontFamily: "var(--font-mono)",
  fontWeight: 600,
  color: "var(--text)",
};

const tdEan: CSSProperties = {
  padding: "8px 12px",
  fontFamily: "var(--font-mono)",
  color: "var(--text-secondary)",
  fontSize: 12,
};

const tdEanMissing: CSSProperties = {
  ...tdEan,
  color: "var(--text-faint)",
  fontStyle: "italic",
};

const tdInputCell: CSSProperties = {
  padding: "5px 12px",
  textAlign: "right",
};

const qtyInput: CSSProperties = {
  width: 60,
  background: "var(--bg-input)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  color: "var(--text)",
  fontSize: 13,
  fontWeight: 600,
  textAlign: "right",
  outline: "none",
  fontFamily: "var(--font-mono)",
  padding: "5px 8px",
};

const summaryBox: CSSProperties = {
  background: "var(--info-bg)",
  color: "var(--info-text)",
  border: "1px solid var(--info-border)",
  padding: "10px 14px",
  borderRadius: 8,
  fontSize: 13,
  marginBottom: 14,
  textAlign: "center",
};

const summaryNum: CSSProperties = {
  fontSize: 16,
  fontWeight: 700,
  margin: "0 4px",
};

const foot: CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 10,
};

const cancelBtn: CSSProperties = {
  background: "transparent",
  color: "var(--text-secondary)",
  border: "1px solid var(--border)",
  padding: "10px 18px",
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 500,
};

const confirmBtn: CSSProperties = {
  background: "var(--accent)",
  color: "var(--accent-text)",
  border: 0,
  padding: "10px 18px",
  borderRadius: 8,
  cursor: "pointer",
  fontSize: 13,
  fontWeight: 600,
};

const confirmBtnDisabled: CSSProperties = {
  ...confirmBtn,
  background: "var(--bg-input)",
  color: "var(--text-muted)",
  cursor: "not-allowed",
};

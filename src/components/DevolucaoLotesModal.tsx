// "Lotes anteriores" da Devolução — últimos 30 dias de lotes (de qualquer
// operadora), com detalhe (itens + por produto) e, nos fechados com
// reintegração em erro/parcial, o botão de reintegrar.
//
// Lote ABERTO de outra operadora aparece, mas sem ações: só quem abriu fecha.

import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { ApiError } from "../lib/api";
import { expedicaoErrorCode } from "../services/expedicao";
import {
  DESTINO_LABEL,
  getLote,
  listarLotes,
  reintegrarErrorMessage,
  progressoReintegracao,
  reintegrarAteZerar,
  reintegracaoPendente,
  type Lote,
  type LoteDetalhe,
} from "../services/devolucoes";
import {
  Badge,
  ItemLinha,
  ReintegracaoBloco,
  REINT_STATUS_LABEL,
  TabelaPorVariante,
  diaHora,
  nomeCurto,
  podeReintegrar,
} from "./DevolucaoShared";

const JANELA_DIAS = 30;

function isoDia(diasAtras: number): string {
  const d = new Date();
  d.setDate(d.getDate() - diasAtras);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function DevolucaoLotesModal({
  loteAtualId,
  onClose,
}: {
  /** Lote aberto desta operadora (o que está na tela) — pra rotular. */
  loteAtualId: string | null;
  onClose: () => void;
}) {
  const [lotes, setLotes] = useState<Lote[] | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [detalhe, setDetalhe] = useState<LoteDetalhe | null>(null);
  const [abrindo, setAbrindo] = useState<string | null>(null);
  const [reintegrando, setReintegrando] = useState(false);
  const [msgReint, setMsgReint] = useState<string | null>(null);
  const [progresso, setProgresso] = useState<{ feitas: number; total: number } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    listarLotes({ de: isoDia(JANELA_DIAS), limit: 100 })
      .then((r) => alive && setLotes(r.itens))
      .catch((e) => alive && setErro(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, []);

  const abrir = useCallback(async (id: string) => {
    setAbrindo(id);
    setMsgReint(null);
    try {
      setDetalhe(await getLote(id));
    } catch (e) {
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      setAbrindo(null);
    }
  }, []);

  const reintegrar = useCallback(async () => {
    if (!detalhe) return;
    setReintegrando(true);
    setMsgReint(null);
    try {
      const aplicar = (r: { lote: Lote }) => {
        setDetalhe((d) => (d ? { ...d, lote: r.lote } : d));
        setLotes((ls) => ls?.map((l) => (l.id === r.lote.id ? r.lote : l)) ?? ls);
      };
      const r = await reintegrarAteZerar(detalhe.lote.id, (p) => {
        aplicar(p);
        setProgresso(
          reintegracaoPendente(p.reintegracao) ? progressoReintegracao(p.reintegracao!) : null,
        );
      });
      aplicar(r);
    } catch (e) {
      const code = expedicaoErrorCode(e);
      setMsgReint(
        reintegrarErrorMessage(code, e instanceof ApiError || e instanceof Error ? e.message : String(e)),
      );
    } finally {
      setProgresso(null);
      setReintegrando(false);
    }
  }, [detalhe]);

  const atualizarDetalhe = useCallback(async () => {
    if (detalhe) await abrir(detalhe.lote.id);
  }, [detalhe, abrir]);

  return (
    <div style={overlay} onClick={onClose}>
      <div style={box} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Lotes anteriores">
        <div style={headerRow}>
          {detalhe && (
            <button style={voltarBtn} onClick={() => setDetalhe(null)}>
              ← Lotes
            </button>
          )}
          <h2 style={titulo}>{detalhe ? `Lote de ${diaHora(detalhe.lote.abertoEm)}` : "Lotes anteriores"}</h2>
          <button style={fecharBtn} onClick={onClose} title="Fechar">
            ×
          </button>
        </div>

        {erro && <div style={erroBox}>{erro}</div>}

        {!detalhe && (
          <div style={lista}>
            {!lotes && !erro && <div style={vazio}>Carregando…</div>}
            {lotes && lotes.length === 0 && <div style={vazio}>Nenhum lote nos últimos {JANELA_DIAS} dias.</div>}
            {lotes?.map((l) => (
              <button key={l.id} style={card} onClick={() => void abrir(l.id)} disabled={abrindo === l.id}>
                <div style={cardTop}>
                  <Badge tom={l.status === "aberto" ? "warn" : "ok"}>
                    {l.status === "aberto" ? (l.id === loteAtualId ? "Aberto (atual)" : "Aberto") : "Fechado"}
                  </Badge>
                  <span style={cardData}>
                    {diaHora(l.abertoEm)}
                    {l.fechadoEm ? ` → ${diaHora(l.fechadoEm)}` : ""}
                  </span>
                  <span style={cardQuem}>{nomeCurto(l.fechadoPorNome ?? l.abertoPorNome)}</span>
                </div>
                <div style={cardMeta}>
                  <span>
                    {l.qtdItens} lidas · {l.qtdDevolvidas} devolvidas
                  </span>
                  {l.destino && <span>destino: {DESTINO_LABEL[l.destino]}</span>}
                  {l.reintegracao && (
                    <span>reintegração: {REINT_STATUS_LABEL[l.reintegracao.status] ?? l.reintegracao.status}</span>
                  )}
                  {l.status === "aberto" && l.id !== loteAtualId && <span>(de outra operadora, só leitura)</span>}
                </div>
              </button>
            ))}
          </div>
        )}

        {detalhe && (
          <div style={lista}>
            <div style={cardMeta}>
              <span>
                {detalhe.resumo.total} lidas · {detalhe.resumo.devolviveis} devolvidas
              </span>
              <span>aberto por {nomeCurto(detalhe.lote.abertoPorNome)}</span>
              {detalhe.lote.fechadoPorNome && <span>fechado por {nomeCurto(detalhe.lote.fechadoPorNome)}</span>}
              {detalhe.lote.destino && <span>destino: {DESTINO_LABEL[detalhe.lote.destino]}</span>}
              {detalhe.lote.motivo && <span>motivo: {detalhe.lote.motivo}</span>}
            </div>

            {detalhe.lote.status === "fechado" && (
              <ReintegracaoBloco
                lote={detalhe.lote}
                reintegracao={detalhe.lote.reintegracao}
                onReintegrar={podeReintegrar(detalhe.lote) ? () => void reintegrar() : undefined}
                onAtualizar={() => void atualizarDetalhe()}
                ocupado={reintegrando}
                progresso={progresso}
                mensagem={msgReint}
              />
            )}
            {detalhe.lote.status === "fechado" && msgReint && !podeReintegrar(detalhe.lote) && (
              <div style={erroBox}>{msgReint}</div>
            )}

            <h3 style={subTitulo}>Por produto</h3>
            <TabelaPorVariante linhas={detalhe.porVariante} />

            <h3 style={subTitulo}>Peças ({detalhe.itens.length})</h3>
            <ul style={itensUl}>
              {detalhe.itens.map((it) => (
                <ItemLinha key={it.id} item={it} />
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

const overlay: CSSProperties = { position: "fixed", inset: 0, background: "rgba(0, 0, 0, 0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 60 };
const box: CSSProperties = { width: 860, maxWidth: "94vw", height: "min(760px, 90vh)", background: "var(--bg-elevated)", border: "1px solid var(--border-strong)", borderRadius: 16, padding: "20px 22px", display: "flex", flexDirection: "column", gap: 12, boxSizing: "border-box" };
const headerRow: CSSProperties = { display: "flex", alignItems: "center", gap: 10 };
const titulo: CSSProperties = { margin: 0, fontSize: 18, fontWeight: 800, color: "var(--text)", flex: 1 };
const fecharBtn: CSSProperties = { background: "transparent", border: 0, color: "var(--text-muted)", fontSize: 24, fontWeight: 700, cursor: "pointer", lineHeight: 1 };
const voltarBtn: CSSProperties = { padding: "5px 11px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-card)", color: "var(--text)", fontSize: 12, fontWeight: 700, cursor: "pointer" };
const lista: CSSProperties = { flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 };
const erroBox: CSSProperties = { padding: 12, borderRadius: 10, background: "var(--warning-bg)", border: "1px solid var(--warning-border)", color: "var(--warning-text)", fontSize: 13 };
const vazio: CSSProperties = { color: "var(--text-muted)", fontSize: 13, padding: 16, textAlign: "center" };
const card: CSSProperties = { textAlign: "left", border: "1px solid var(--border)", borderRadius: 12, padding: "10px 12px", background: "var(--bg-card)", color: "var(--text)", display: "flex", flexDirection: "column", gap: 6, cursor: "pointer" };
const cardTop: CSSProperties = { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" };
const cardData: CSSProperties = { fontSize: 14, fontWeight: 800, fontVariantNumeric: "tabular-nums" };
const cardQuem: CSSProperties = { fontSize: 11, fontWeight: 700, color: "var(--text-muted)", padding: "2px 8px", borderRadius: 999, border: "1px solid var(--border)" };
const cardMeta: CSSProperties = { display: "flex", gap: 12, flexWrap: "wrap", fontSize: 12, color: "var(--text-secondary)" };
const subTitulo: CSSProperties = { margin: "8px 0 0", fontSize: 13, fontWeight: 800, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.5 };
const itensUl: CSSProperties = { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 };

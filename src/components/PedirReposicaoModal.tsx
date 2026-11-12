// "Pedir reposição" da mesa de separação (nexus `/reposicao/pedidos`, 10/11).
//
// A separadora pede peças pros repositores sem sair da tela, SÓ do tamanho da
// fila em que está (o servidor valida: `fora_da_fila`). Toque no card = +10
// peças no carrinho, nunca acima de `limite − pendente`. Nada aqui mexe na
// leitura RFID: o modal é só uma camada por cima, a conferência segue.
//
// Atualização: catálogo a cada 20 s com o painel aberto; "meus pedidos" vem do
// hook do runner (`useMeusPedidosReposicao`). Deps dos efeitos são primitivas.

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Order } from "../services/orders";
import { miniatura } from "../lib/imagens";
import { gravarReposicaoHistoricoAberto, lerReposicaoHistoricoAberto } from "../lib/sidebarLargura";
import {
  agoraDoServidor,
  ajustarCarrinho,
  assinaturaDoCarrinho,
  chavesDaMesa,
  estaNaMesa,
  itensPediveis,
  maximoDoCard,
  mensagemDoErro,
  ordenarItens,
  rotuloHa,
  situacaoDoTeto,
  somarPacote,
  tirarPacote,
  totaisDoCarrinho,
  type Carrinho,
} from "../lib/pedirReposicao";
import {
  PACOTE_REPOSICAO,
  cancelarPedidosReposicao,
  criarPedidosReposicao,
  getCatalogoReposicao,
  type CatalogoReposicao,
  type LinhaPedidoReposicao,
  type MeusPedidosReposicao,
  type TamanhoReposicao,
} from "../services/reposicaoPedidos";

export const INTERVALO_CATALOGO_MS = 20_000;
const DESFAZER_MS = 8_000;

type Props = {
  /** Tamanho da fila da mesa (`null` = fila fora dos cinco tamanhos de reposição). */
  tamanhoFila: TamanhoReposicao | null;
  /** Pedidos que ela tem na mesa/lote — só pra mostrar primeiro o que ela está separando. */
  pedidosMesa: readonly Order[];
  meus: MeusPedidosReposicao | null;
  onRecarregarMeus: () => Promise<void>;
  onClose: () => void;
};

type Aba = "pedir" | "meus";

export function PedirReposicaoModal({ tamanhoFila, pedidosMesa, meus, onRecarregarMeus, onClose }: Props) {
  const [aba, setAba] = useState<Aba>("pedir");
  const [tamanho, setTamanho] = useState<TamanhoReposicao | null>(tamanhoFila);
  const [permitidos, setPermitidos] = useState<TamanhoReposicao[] | null>(null);
  const [catalogo, setCatalogo] = useState<CatalogoReposicao | null>(null);
  const [carregando, setCarregando] = useState(tamanhoFila !== null);
  const [indisponivel, setIndisponivel] = useState(false);
  const [busca, setBusca] = useState("");
  const [carrinho, setCarrinho] = useState<Carrinho>({});
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [desfazer, setDesfazer] = useState<{ ids: string[]; pecas: number } | null>(null);
  const [agora, setAgora] = useState(() => Date.now());
  const desfazerTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vivo = useRef(true);
  // Chave de idempotência do envio: vale pro carrinho (assinatura) em que foi gerada.
  const chaveEnvio = useRef<{ chave: string; assinatura: string } | null>(null);
  // Envio NÃO confirmado (rede/timeout/5xx): o carrinho fica TRAVADO até "Tentar de
  // novo" (mesma chave) ou "Descartar". Ref pro `carregar`, state pra renderizar.
  const [envioPendente, setEnvioPendente] = useState(false);
  const envioPendenteRef = useRef(false);
  const [confirmandoFechar, setConfirmandoFechar] = useState(false);
  // Erro que veio de refresh (some quando um refresh seguinte dá certo).
  const erroDeRefresh = useRef(false);
  // Estado lido pelo handler de Esc sem recriar o listener.
  const fechamento = useRef({ itens: 0, enviando: false });

  const marcarEnvioPendente = (v: boolean) => {
    envioPendenteRef.current = v;
    setEnvioPendente(v);
  };

  const pedirFechar = useCallback(() => {
    if (fechamento.current.enviando) return;
    if (fechamento.current.itens > 0) {
      setConfirmandoFechar(true);
      return;
    }
    onClose();
  }, [onClose]);

  useEffect(() => {
    vivo.current = true;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") pedirFechar();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      vivo.current = false;
      window.removeEventListener("keydown", onKey);
      if (desfazerTimer.current) clearTimeout(desfazerTimer.current);
    };
  }, [pedirFechar]);

  const carregar = useCallback(async (t: TamanhoReposicao) => {
    try {
      const r = await getCatalogoReposicao(t);
      if (!vivo.current) return;
      if (r.kind === "sem_suporte") {
        setIndisponivel(true);
        return;
      }
      if (r.kind === "fora_da_fila") {
        setPermitidos(r.tamanhos);
        // Com envio não confirmado o carrinho/tamanho não mudam (a chave vale pra ele).
        if (envioPendenteRef.current) return;
        setCatalogo(null);
        setCarrinho({});
        // Só troca se o tamanho atual não é permitido (evita laço). Sem nenhum
        // permitido, MANTÉM o atual: o polling segue e a tela destrava sozinha.
        setTamanho((atual) => (atual && r.tamanhos.includes(atual) ? atual : (r.tamanhos[0] ?? atual)));
        return;
      }
      setIndisponivel(false);
      setCatalogo(r.catalogo);
      if (r.catalogo.minhaFila) setPermitidos(r.catalogo.minhaFila.tamanhos);
      // Carrinho travado por envio não confirmado: ajustar mudaria a assinatura e
      // geraria chave nova (reenvio duplicaria).
      if (!envioPendenteRef.current) setCarrinho((c) => ajustarCarrinho(c, r.catalogo));
      if (erroDeRefresh.current) {
        erroDeRefresh.current = false;
        setErro(null);
      }
    } catch (e) {
      if (!vivo.current) return;
      erroDeRefresh.current = true;
      setErro(e instanceof Error ? e.message : "Não deu pra carregar os produtos.");
    } finally {
      if (vivo.current) setCarregando(false);
    }
  }, []);

  useEffect(() => {
    if (!tamanho) {
      setCarregando(false);
      return;
    }
    setCarregando(true);
    void carregar(tamanho);
    const t = setInterval(() => {
      setAgora(Date.now());
      void carregar(tamanho);
    }, INTERVALO_CATALOGO_MS);
    return () => clearInterval(t);
  }, [tamanho, carregar]);

  const trocarTamanho = (t: TamanhoReposicao) => {
    if (t === tamanho || envioPendente || enviando) return;
    setCarrinho({});
    setCatalogo(null);
    setTamanho(t);
  };

  const pickingDisponivel = catalogo?.pickingDisponivel ?? true;
  const chavesMesa = useMemo(() => chavesDaMesa(pedidosMesa, tamanho ?? ""), [pedidosMesa, tamanho]);
  const pediveis = useMemo(() => (catalogo ? itensPediveis(catalogo) : []), [catalogo]);
  const itens = useMemo(
    () => ordenarItens(pediveis, { busca, chavesMesa, tamanho: tamanho ?? "" }),
    [pediveis, busca, chavesMesa, tamanho],
  );
  const totais = totaisDoCarrinho(carrinho);
  const teto = situacaoDoTeto(catalogo?.limites, totais.itens);
  const semFila = permitidos !== null && permitidos.length === 0;
  const resumoPendentes = meus?.pendentes.length ?? 0;
  const travado = enviando || envioPendente;
  fechamento.current = { itens: totais.itens, enviando };

  const enviar = async () => {
    if (!tamanho || enviando || totais.itens === 0 || teto.excede) return;
    setEnviando(true);
    setErro(null);
    erroDeRefresh.current = false;
    try {
      const carrinhoEnviado = { ...carrinho };
      const assinatura = assinaturaDoCarrinho(tamanho, carrinhoEnviado);
      if (chaveEnvio.current?.assinatura !== assinatura) {
        chaveEnvio.current = { chave: crypto.randomUUID(), assinatura };
      }
      const r = await criarPedidosReposicao(
        Object.entries(carrinhoEnviado).map(([produtoId, qtd]) => ({ produtoId, tamanho, qtd })),
        chaveEnvio.current.chave,
      );
      if (!vivo.current) return;
      if (r.kind === "sem_suporte") {
        setIndisponivel(true);
        return;
      }
      if (r.kind === "erro") {
        // Resposta definitiva do servidor: nada foi gravado, a chave não vale mais.
        chaveEnvio.current = null;
        marcarEnvioPendente(false);
        setErro(mensagemDoErro(r.erro));
        // `produto_inativo`: tira só aquele produto do carrinho.
        if (r.erro.error === "produto_inativo") {
          const id = r.erro.produtoId;
          setCarrinho((c) => {
            const { [id]: _, ...resto } = c;
            return resto;
          });
        }
        // `limite`/`fora_da_fila`/`chave_em_uso`: recarrega (o carrinho se ajusta sem perder o resto).
        await carregar(tamanho);
        void onRecarregarMeus();
        return;
      }
      chaveEnvio.current = null; // envio confirmado: o próximo carrinho ganha chave nova
      marcarEnvioPendente(false);
      // Limpa só o que foi enviado (o carrinho está travado durante o envio).
      const enviados = Object.keys(carrinhoEnviado);
      setCarrinho((c) => {
        const resto = { ...c };
        for (const id of enviados) delete resto[id];
        return resto;
      });
      setDesfazer({ ids: r.pedidos.map((p) => p.id), pecas: r.pedidos.reduce((a, p) => a + p.qtd, 0) });
      if (desfazerTimer.current) clearTimeout(desfazerTimer.current);
      desfazerTimer.current = setTimeout(() => setDesfazer(null), DESFAZER_MS);
      await Promise.all([carregar(tamanho), onRecarregarMeus()]);
    } catch {
      if (vivo.current) {
        // Pode ter gravado ou não: trava o carrinho até "Tentar de novo" ou "Descartar".
        marcarEnvioPendente(true);
        setErro("Não deu pra confirmar o envio. Pode tentar de novo sem medo de duplicar o pedido.");
      }
    } finally {
      if (vivo.current) setEnviando(false);
    }
  };

  const descartarEnvio = async () => {
    chaveEnvio.current = null;
    marcarEnvioPendente(false);
    setCarrinho({});
    setErro(null);
    // Meus pedidos e catálogo mostram o que de fato foi gravado.
    await Promise.all([tamanho ? carregar(tamanho) : Promise.resolve(), onRecarregarMeus()]);
  };

  const cancelar = async (ids: string[]) => {
    setErro(null);
    try {
      await cancelarPedidosReposicao(ids);
    } catch (e) {
      if (vivo.current) setErro(e instanceof Error ? e.message : "Não deu pra cancelar.");
    }
    if (!vivo.current) return;
    await Promise.all([tamanho ? carregar(tamanho) : Promise.resolve(), onRecarregarMeus()]);
  };

  const desfazerEnvio = async () => {
    if (!desfazer) return;
    const ids = desfazer.ids;
    setDesfazer(null);
    if (desfazerTimer.current) clearTimeout(desfazerTimer.current);
    await cancelar(ids);
  };

  return (
    <div style={overlay} onClick={pedirFechar}>
      <div style={box} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Pedir reposição">
        <div style={headerRow}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={titulo}>Pedir reposição</h2>
            <span style={sub}>Peças que estão faltando na sua bancada{tamanho ? ` · fila ${tamanho}` : ""}.</span>
          </div>
          <button style={fecharBtn} onClick={pedirFechar} title="Fechar (Esc)" aria-label="Fechar">
            ×
          </button>
        </div>

        <div style={abasRow}>
          <button style={aba === "pedir" ? abaOn : abaOff} onClick={() => setAba("pedir")}>
            Pedir
          </button>
          <button style={aba === "meus" ? abaOn : abaOff} onClick={() => setAba("meus")}>
            Meus pedidos{resumoPendentes > 0 ? ` (${resumoPendentes})` : ""}
          </button>
        </div>

        {erro && <div style={erroBox}>{erro}</div>}
        {confirmandoFechar && (
          <div style={erroBox}>
            <div style={{ marginBottom: 8 }}>Descartar o pedido que você estava montando?</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={desfazerBtn} onClick={onClose}>
                Descartar
              </button>
              <button style={desfazerBtn} onClick={() => setConfirmandoFechar(false)}>
                Continuar editando
              </button>
            </div>
          </div>
        )}
        {desfazer && (
          <div style={okBox}>
            <span style={{ flex: 1 }}>Pedido enviado pros repositores ({desfazer.pecas} pç).</span>
            <button style={desfazerBtn} onClick={() => void desfazerEnvio()}>
              Desfazer
            </button>
          </div>
        )}

        {aba === "pedir" ? (
          <>
            {indisponivel ? (
              <div style={vazio}>Pedir reposição não está disponível agora.</div>
            ) : tamanho === null && !semFila ? (
              <div style={vazio}>Pedir reposição não está disponível pra esta fila.</div>
            ) : semFila ? (
              <div style={vazio}>Você precisa estar com pedidos na mesa pra pedir reposição.</div>
            ) : (
              <>
                {permitidos && permitidos.length > 1 && (
                  <div style={chipsRow}>
                    {permitidos.map((t) => (
                      <button key={t} style={t === tamanho ? chipOn : chipOff} onClick={() => trocarTamanho(t)} disabled={travado}>
                        {t}
                      </button>
                    ))}
                  </div>
                )}
                <input
                  style={buscaInput}
                  placeholder="Buscar produto pelo nome"
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                />
                <div className="thin-scroll" style={lista}>
                  {carregando && !catalogo && <div style={vazio}>Carregando produtos…</div>}
                  {catalogo && itens.length === 0 && (
                    <div style={vazio}>{busca ? "Nenhum produto com esse nome." : "Nenhum produto pra pedir neste tamanho."}</div>
                  )}
                  {catalogo &&
                    itens.map((i) => {
                      const qtd = carrinho[i.produtoId] ?? 0;
                      const max = maximoDoCard(i, pickingDisponivel);
                      const noTeto = qtd + PACOTE_REPOSICAO > max;
                      const naMesa = estaNaMesa(i, chavesMesa, tamanho ?? "");
                      const foto = miniatura(i.imagemUrl);
                      return (
                        <div key={i.produtoId} style={qtd > 0 ? cardOn : card}>
                          <button
                            style={cardBtn}
                            onClick={() => setCarrinho((c) => somarPacote(c, i, pickingDisponivel))}
                            disabled={travado || max < PACOTE_REPOSICAO}
                            aria-label={`Adicionar ${PACOTE_REPOSICAO} peças de ${i.nomeCurto}`}
                          >
                            {foto ? <img src={foto} alt="" style={thumb} loading="lazy" /> : <div style={{ ...thumb, ...thumbVazia }} />}
                            <div style={cardInfo}>
                              <span style={cardNome}>
                                {i.nomeCurto}
                                {naMesa && <span style={tagMesa}>na sua mesa</span>}
                              </span>
                              <span style={cardMeta}>
                                {pickingDisponivel ? `precisa ${i.picking}` : "toque pra pedir"}
                                {i.pendenteQtd > 0 && <span style={tagPedido}> · já pedido {i.pendenteQtd} pç</span>}
                                {i.faltaQtd > 0 && <span style={tagFalta}> · não tem</span>}
                              </span>
                              {pickingDisponivel && max < PACOTE_REPOSICAO ? (
                                <span style={avisoMax}>Máximo pra este produto: 0 pç (já pedido {i.pendenteQtd})</span>
                              ) : (
                                qtd > 0 &&
                                noTeto &&
                                pickingDisponivel && (
                                  <span style={avisoMax}>
                                    Máximo pra este produto: {max} pç (já pedido {i.pendenteQtd})
                                  </span>
                                )
                              )}
                            </div>
                          </button>
                          {qtd > 0 && (
                            <div style={qtdWrap}>
                              <button style={qtdBtn} onClick={() => setCarrinho((c) => tirarPacote(c, i.produtoId))} disabled={travado} aria-label="Tirar 10 peças">
                                −
                              </button>
                              <span style={qtdValor}>{qtd}</span>
                              <button
                                style={qtdBtn}
                                onClick={() => setCarrinho((c) => somarPacote(c, i, pickingDisponivel))}
                                disabled={noTeto || travado}
                                aria-label="Colocar mais 10 peças"
                              >
                                +
                              </button>
                              <button
                                style={removerBtn}
                                disabled={travado}
                                onClick={() =>
                                  setCarrinho((c) => {
                                    const { [i.produtoId]: _, ...resto } = c;
                                    return resto;
                                  })
                                }
                              >
                                remover
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
                {envioPendente && (
                  <div style={erroBox}>
                    O pedido está travado até você tentar de novo ou descartar.
                  </div>
                )}
                <div style={rodape}>
                  <div style={rodapeInfo}>
                    <strong>
                      {totais.pecas} {totais.pecas === 1 ? "peça" : "peças"} · {totais.itens} {totais.itens === 1 ? "produto" : "produtos"}
                    </strong>
                    {teto.mostrar && <span style={teto.excede ? tetoExcede : tetoOk}>{teto.texto}</span>}
                  </div>
                  {envioPendente && (
                    <button style={desfazerBtn} disabled={enviando} onClick={() => void descartarEnvio()}>
                      Descartar
                    </button>
                  )}
                  <button
                    style={totais.itens > 0 && !teto.excede && !enviando ? enviarBtn : enviarBtnOff}
                    disabled={totais.itens === 0 || teto.excede || enviando}
                    onClick={() => void enviar()}
                  >
                    {enviando ? "Enviando…" : envioPendente ? "Tentar de novo" : "Enviar pedido"}
                  </button>
                </div>
              </>
            )}
          </>
        ) : (
          <ListaMeus meus={meus} agora={agoraDoServidor(meus, agora)} onCancelar={(id) => void cancelar([id])} />
        )}
      </div>
    </div>
  );
}

function ListaMeus({
  meus,
  agora,
  onCancelar,
}: {
  meus: MeusPedidosReposicao | null;
  agora: number;
  onCancelar: (id: string) => void;
}) {
  const [historicoAberto, setHistoricoAberto] = useState<boolean>(lerReposicaoHistoricoAberto);
  const alternarHistorico = () => {
    setHistoricoAberto((v) => {
      gravarReposicaoHistoricoAberto(!v);
      return !v;
    });
  };
  const daFila = meus?.daFila ?? [];
  if (!meus || (meus.pendentes.length === 0 && meus.atendidos24h.length === 0 && daFila.length === 0)) {
    return <div style={vazio}>Você não tem pedidos de reposição recentes.</div>;
  }
  const faltas = meus.pendentes.filter((p) => p.falta);
  const aguardando = meus.pendentes.filter((p) => !p.falta);
  const linha = (p: LinhaPedidoReposicao, extra: ReactNode, estilo: CSSProperties = card) => {
    const foto = miniatura(p.imagemUrl);
    return (
      <div key={p.id} style={estilo}>
        {foto ? <img src={foto} alt="" style={thumb} loading="lazy" /> : <div style={{ ...thumb, ...thumbVazia }} />}
        <div style={cardInfo}>
          <span style={cardNome}>{p.nome}</span>
          <span style={cardMeta}>
            {p.qtd} pç · {p.tamanho}
          </span>
          {extra}
        </div>
      </div>
    );
  };
  return (
    <div className="thin-scroll" style={lista}>
      {faltas.length > 0 && <div style={secaoTitulo}>Não tem</div>}
      {faltas.map((p) =>
        linha(
          p,
          <span style={tagFalta}>
            Não tem{p.faltaPorNome ? ` (marcado por ${p.faltaPorNome}` : ""}
            {p.faltaEm ? `${p.faltaPorNome ? " " : " ("}${rotuloHa(p.faltaEm, agora)}` : ""}
            {p.faltaPorNome || p.faltaEm ? ")" : ""}
          </span>,
          cardFalta,
        ),
      )}
      {aguardando.length > 0 && <div style={secaoTitulo}>Aguardando reposição</div>}
      {aguardando.map((p) =>
        linha(
          p,
          <div style={linhaAcao}>
            <span style={cardMeta}>pedido {rotuloHa(p.criadoEm, agora)}</span>
            <button style={removerBtn} onClick={() => onCancelar(p.id)}>
              cancelar
            </button>
          </div>,
        ),
      )}
      {daFila.length > 0 && <div style={secaoTitulo}>Pedidos de outras bancadas ({daFila.length})</div>}
      {daFila.map((p) =>
        linha(
          p,
          <span style={cardMeta}>
            pedido de {p.pedidoPorNome?.trim() || "outra operadora"} {rotuloHa(p.criadoEm, agora)}
          </span>,
        ),
      )}
      {meus.atendidos24h.length > 0 && (
        <button type="button" style={secaoToggle} onClick={alternarHistorico} aria-expanded={historicoAberto}>
          <span>Repostos nas últimas horas ({meus.atendidos24h.length})</span>
          <span aria-hidden="true">{historicoAberto ? "▾" : "▸"}</span>
        </button>
      )}
      {historicoAberto &&
        meus.atendidos24h.map((p) =>
          linha(
            p,
            <span style={cardMeta}>
              reposto{p.atendidoPorNome ? ` por ${p.atendidoPorNome}` : ""} {rotuloHa(p.atendidoEm, agora)}
            </span>,
          ),
        )}
    </div>
  );
}

const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0, 0, 0, 0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 70,
};
const box: CSSProperties = {
  width: 760,
  maxWidth: "96vw",
  height: "90vh",
  background: "var(--bg-elevated)",
  border: "1px solid var(--border-strong)",
  borderRadius: 16,
  padding: "18px 20px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  boxSizing: "border-box",
};
const headerRow: CSSProperties = { display: "flex", alignItems: "flex-start", gap: 12 };
const titulo: CSSProperties = { margin: 0, fontSize: 20, fontWeight: 800, color: "var(--text)" };
const sub: CSSProperties = { fontSize: 12, color: "var(--text-secondary)" };
const fecharBtn: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "var(--text-muted)",
  fontSize: 30,
  fontWeight: 700,
  cursor: "pointer",
  lineHeight: 1,
  padding: "0 8px",
};
const abasRow: CSSProperties = { display: "flex", gap: 8 };
const abaBase: CSSProperties = {
  flex: 1,
  padding: "12px 14px",
  borderRadius: 10,
  fontSize: 14,
  fontWeight: 800,
  cursor: "pointer",
  border: "1px solid var(--border)",
};
const abaOn: CSSProperties = { ...abaBase, background: "var(--accent, #7c3aed)", color: "#fff", border: "1px solid transparent" };
const abaOff: CSSProperties = { ...abaBase, background: "var(--bg-card)", color: "var(--text-secondary)" };
const erroBox: CSSProperties = {
  padding: "10px 14px",
  background: "var(--danger-bg, var(--warning-bg))",
  border: "1px solid var(--danger-border, var(--warning-border))",
  borderRadius: 10,
  color: "var(--danger-text, var(--warning-text))",
  fontSize: 13,
};
const okBox: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 14px",
  background: "var(--success-bg, var(--bg-card))",
  border: "1px solid var(--success-border, var(--border))",
  borderRadius: 10,
  color: "var(--success-text, var(--text))",
  fontSize: 13,
  fontWeight: 700,
};
const desfazerBtn: CSSProperties = {
  padding: "8px 16px",
  borderRadius: 8,
  border: "1px solid var(--border-strong)",
  background: "var(--bg-card)",
  color: "var(--text)",
  fontWeight: 800,
  cursor: "pointer",
};
const chipsRow: CSSProperties = { display: "flex", gap: 8 };
const chipBase: CSSProperties = {
  minWidth: 64,
  padding: "12px 18px",
  borderRadius: 999,
  fontSize: 16,
  fontWeight: 800,
  cursor: "pointer",
  border: "1px solid var(--border)",
};
const chipOn: CSSProperties = { ...chipBase, background: "var(--accent, #7c3aed)", color: "#fff" };
const chipOff: CSSProperties = { ...chipBase, background: "var(--bg-card)", color: "var(--text-secondary)" };
const buscaInput: CSSProperties = {
  padding: "12px 14px",
  borderRadius: 10,
  border: "1px solid var(--border-strong)",
  background: "var(--bg-card)",
  color: "var(--text)",
  fontSize: 15,
};
const lista: CSSProperties = { flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8 };
const vazio: CSSProperties = { padding: 24, textAlign: "center", color: "var(--text-secondary)", fontSize: 15 };
const card: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "8px 10px",
  border: "1px solid var(--border)",
  borderRadius: 12,
  background: "var(--bg-card)",
};
const cardOn: CSSProperties = { ...card, border: "2px solid var(--accent, #7c3aed)" };
const cardFalta: CSSProperties = {
  ...card,
  background: "var(--danger-bg, var(--warning-bg))",
  border: "1px solid var(--danger-border, var(--warning-border))",
};
const cardBtn: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  alignItems: "center",
  gap: 12,
  background: "transparent",
  border: 0,
  padding: 0,
  textAlign: "left",
  cursor: "pointer",
  color: "inherit",
};
const thumb: CSSProperties = { width: 64, height: 64, borderRadius: 10, objectFit: "cover", flexShrink: 0, background: "var(--bg-card)" };
const thumbVazia: CSSProperties = { border: "1px solid var(--border)" };
const cardInfo: CSSProperties = { display: "flex", flexDirection: "column", gap: 3, flex: 1, minWidth: 0 };
const cardNome: CSSProperties = { fontSize: 15, fontWeight: 800, color: "var(--text)" };
const cardMeta: CSSProperties = { fontSize: 13, color: "var(--text-secondary)" };
const tagMesa: CSSProperties = {
  marginLeft: 8,
  padding: "2px 8px",
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 800,
  background: "var(--accent, #7c3aed)",
  color: "#fff",
};
const tagPedido: CSSProperties = { color: "var(--warning-text)", fontWeight: 700 };
const tagFalta: CSSProperties = { color: "var(--danger-text, #b91c1c)", fontWeight: 800 };
const avisoMax: CSSProperties = { fontSize: 12, color: "var(--warning-text)", fontWeight: 700 };
const qtdWrap: CSSProperties = { display: "flex", alignItems: "center", gap: 8, flexShrink: 0 };
const qtdBtn: CSSProperties = {
  width: 48,
  height: 48,
  borderRadius: 10,
  border: "1px solid var(--border-strong)",
  background: "var(--bg-elevated)",
  color: "var(--text)",
  fontSize: 24,
  fontWeight: 800,
  cursor: "pointer",
};
const qtdValor: CSSProperties = { minWidth: 36, textAlign: "center", fontSize: 18, fontWeight: 800, color: "var(--text)" };
const removerBtn: CSSProperties = {
  background: "transparent",
  border: 0,
  color: "var(--text-muted)",
  textDecoration: "underline",
  fontSize: 13,
  cursor: "pointer",
  padding: "8px",
};
const rodape: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  paddingTop: 10,
  borderTop: "1px solid var(--border)",
};
const rodapeInfo: CSSProperties = { flex: 1, display: "flex", flexDirection: "column", gap: 3, fontSize: 14, color: "var(--text)" };
const tetoOk: CSSProperties = { fontSize: 12, color: "var(--text-secondary)" };
const tetoExcede: CSSProperties = { fontSize: 12, color: "var(--danger-text, #b91c1c)", fontWeight: 700 };
const enviarBtn: CSSProperties = {
  padding: "16px 28px",
  borderRadius: 12,
  border: 0,
  background: "var(--accent, #7c3aed)",
  color: "#fff",
  fontSize: 16,
  fontWeight: 800,
  cursor: "pointer",
};
const enviarBtnOff: CSSProperties = { ...enviarBtn, background: "var(--bg-card)", color: "var(--text-muted)", cursor: "not-allowed" };
const secaoTitulo: CSSProperties = { fontSize: 12, fontWeight: 800, textTransform: "uppercase", color: "var(--text-secondary)", marginTop: 4 };
const secaoToggle: CSSProperties = {
  ...secaoTitulo,
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  background: "transparent",
  border: "none",
  padding: 0,
  cursor: "pointer",
  textAlign: "left",
};
const linhaAcao: CSSProperties = { display: "flex", alignItems: "center", gap: 8 };

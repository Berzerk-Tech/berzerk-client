// Lista de pedidos já impressos com "Reimprimir" por linha e "Reimprimir todas" (com confirmação).
// Usada no resumo da impressão manual e no diálogo "Impressões recentes". Reimprimir não dá baixa
// nem mexe em status: só busca os documentos e manda pra impressora de novo.

import { useRef, useState, type CSSProperties } from "react";
import { reimprimirItens, type EstadoLinha, type ItemReimpressao } from "../../lib/reimprimirManual";
import { useDialogo } from "../../lib/useDialogo";

export function ReimprimirLista({ itens, rotuloTodas = "Reimprimir todas", maxAltura = "32vh" }: { itens: ItemReimpressao[]; rotuloTodas?: string; maxAltura?: string }) {
  const [estados, setEstados] = useState<Record<string, EstadoLinha>>({});
  const [ocupado, setOcupado] = useState(false);
  const ocupadoRef = useRef(false);
  const { confirmar, dialogo } = useDialogo();

  const rodar = async (alvo: ItemReimpressao[]) => {
    if (ocupadoRef.current || alvo.length === 0) return;
    ocupadoRef.current = true;
    setOcupado(true);
    try {
      await reimprimirItens(alvo, (id, e) => setEstados((atual) => ({ ...atual, [id]: e })));
    } finally {
      ocupadoRef.current = false;
      setOcupado(false);
    }
  };

  const todas = async () => {
    const ok = await confirmar({
      titulo: `Reimprimir ${itens.length} etiqueta${itens.length === 1 ? "" : "s"}?`,
      mensagem: "Sai uma 2ª via de cada uma. Os pedidos não mudam de status.",
      confirmarLabel: "Reimprimir",
    });
    if (ok) void rodar(itens);
  };

  if (itens.length === 0) return <div style={vazio}>Nenhum pedido impresso.</div>;
  return (
    <div style={caixa}>
      <div style={barra}>
        <span style={contagem}>{itens.length} pedido{itens.length === 1 ? "" : "s"} impresso{itens.length === 1 ? "" : "s"}</span>
        <button type="button" style={botao} onClick={() => void todas()} disabled={ocupado}>
          {rotuloTodas}
        </button>
      </div>
      <div style={{ ...rolagem, maxHeight: maxAltura }} className="thin-scroll">
        <table style={tabela}>
          <tbody>
            {itens.map((i) => {
              const e = estados[i.orderId];
              return (
                <tr key={i.orderId}>
                  <td style={td}>#{i.numero ?? i.orderId.slice(0, 8)}</td>
                  <td style={td}>{i.cliente ?? "—"}</td>
                  <td style={td}>{i.tracking ?? "sem rastreio"}</td>
                  <td style={td}>{i.tamanho ?? ""}</td>
                  <td style={{ ...td, textAlign: "right" }}>
                    {e?.estado === "imprimindo" && <span style={txtEstado}>imprimindo…</span>}
                    {e?.estado === "ok" && <span style={txtOk}>enviada</span>}
                    {e?.estado === "erro" && (
                      <span style={txtErro} title={e.mensagem}>
                        erro: {e.mensagem}
                      </span>
                    )}{" "}
                    <button type="button" style={botaoLinha} onClick={() => void rodar([i])} disabled={ocupado} aria-label={`Reimprimir pedido ${i.numero ?? i.orderId}`}>
                      Reimprimir
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {dialogo}
    </div>
  );
}

const caixa: CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };
const barra: CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 };
const contagem: CSSProperties = { fontSize: 13, fontWeight: 700, color: "var(--text-secondary)" };
const rolagem: CSSProperties = { overflowY: "auto" };
const tabela: CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 13 };
const td: CSSProperties = { padding: "4px 8px", borderBottom: "1px solid var(--border)", verticalAlign: "middle" };
const botao: CSSProperties = { padding: "8px 14px", background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text)", fontWeight: 700, cursor: "pointer" };
const botaoLinha: CSSProperties = { ...botao, padding: "4px 10px", fontSize: 12 };
const vazio: CSSProperties = { padding: 12, color: "var(--text-secondary)", textAlign: "center" };
const txtEstado: CSSProperties = { color: "var(--text-secondary)", fontSize: 12 };
const txtOk: CSSProperties = { color: "var(--info-text, #1d4ed8)", fontSize: 12, fontWeight: 700 };
const txtErro: CSSProperties = { color: "var(--warning-text)", fontSize: 12, maxWidth: 220, display: "inline-block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", verticalAlign: "middle" };

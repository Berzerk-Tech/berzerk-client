import { apiRequest } from "../lib/api";
import { getStationId } from "../lib/station";

/**
 * Log de auditoria das ações do desktop.
 *
 * Era `rfid_action_logs` no Supabase industrial; virou `POST /etiquetagem/log`
 * no nexus, que grava na tabela `auditoria` com `acao = 'etiquetagem.<x>'`
 * (fase 3 do `docs/plano-corte-supabase.md`).
 *
 * A maior parte dos desfechos JÁ é auditada pelo próprio endpoint que os
 * executa (criar job, concluir, carimbar o lote). O que só existe aqui são os
 * eventos que acontecem inteiramente NESTA MÁQUINA — a chamada à iTAG e à
 * impressora — e que, sem isto, não deixariam rastro nenhum:
 * `movimentar_falhou` é o caso principal.
 *
 * Fire-and-forget: log NUNCA derruba a ação que ele registra. Falha (rede,
 * permissão) vira console.warn e a vida segue.
 */
export type ActionLogInput = {
  action:
    | "impressao_concluida"
    | "impressao_parcial"
    | "impressao_falhou"
    | "impressao_teste"
    | "reimpressao_enfileirada"
    | "movimentar"
    | "movimentar_falhou"
    | "descartar_teste";
  batchId?: string | null;
  jobId?: string | null;
  details?: Record<string, unknown>;
};

export function logAction(input: ActionLogInput): void {
  void (async () => {
    try {
      await apiRequest<void>("/etiquetagem/log", {
        method: "POST",
        body: {
          acao: input.action,
          loteId: input.batchId ?? null,
          jobId: input.jobId ?? null,
          estacaoId: getStationId(),
          detalhes: input.details ?? null,
        },
      });
    } catch (e) {
      console.warn(`[actionLog] falha ao logar ${input.action}:`, e);
    }
  })();
}

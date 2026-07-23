import { supabase } from "../lib/supabase";
import { getStationId } from "../lib/station";

/**
 * Log de auditoria das ações do desktop em `rfid_action_logs` (Supabase
 * industrial — ver migrations/20260723_rfid_action_logs.sql). Na virada pro
 * nexus, só este arquivo muda de destino.
 *
 * Fire-and-forget: log NUNCA derruba a ação que ele registra. Falha (tabela
 * ainda não criada, RLS, rede) vira console.warn e a vida segue.
 */
export type ActionLogInput = {
  action:
    | "print_done"
    | "print_partial"
    | "print_failed"
    | "print_test"
    | "reprint_queue"
    | "movimentar"
    | "movimentar_failed"
    | "discard_test";
  batchId?: string | null;
  batchCode?: string | null;
  jobId?: string | null;
  operatorId: string;
  operatorEmail?: string | null;
  details?: Record<string, unknown>;
};

export function logAction(input: ActionLogInput): void {
  void (async () => {
    try {
      const { error } = await supabase.from("rfid_action_logs").insert({
        action: input.action,
        batch_id: input.batchId ?? null,
        batch_code: input.batchCode ?? null,
        job_id: input.jobId ?? null,
        operator_id: input.operatorId,
        operator_email: input.operatorEmail ?? null,
        station_id: getStationId(),
        details: input.details ?? null,
      });
      if (error) throw error;
    } catch (e) {
      console.warn(`[actionLog] falha ao logar ${input.action}:`, e);
    }
  })();
}

import { useEffect, useState, type CSSProperties } from "react";
import { getSessaoSync, onSessaoChange } from "../lib/cognito";

/**
 * Identificação discreta de quem está operando (pedido do Victor): primeiro
 * nome da conta Google logada no Nexus, no header das telas de operação. Hover
 * mostra o e-mail completo.
 */
export function OperatorChip() {
  const [email, setEmail] = useState<string | null>(() => getSessaoSync()?.email ?? null);

  useEffect(() => onSessaoChange((s) => setEmail(s?.email ?? null)), []);

  if (!email) return null;

  return (
    <span style={chip} title={email}>
      {nomeDaOperadora(email)}
    </span>
  );
}

/** Primeiro nome a partir do e-mail (`ana.silva@…` → "Ana"). Também é o nome
 *  que assina a folha do Picking Geral. */
export function nomeDaOperadora(email: string | null): string {
  if (!email) return "operadora";
  const local = email.split("@")[0] ?? email;
  const first = local.split(".")[0] ?? local;
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

const chip: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text-muted)",
};

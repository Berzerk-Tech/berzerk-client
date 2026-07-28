import { useEffect, useState, type CSSProperties } from "react";
import { supabase } from "../lib/supabase";

/**
 * Identificação discreta de quem está operando (pedido do Victor): primeiro
 * nome da conta Google logada, no header das telas de operação. Hover mostra
 * o e-mail completo.
 */
export function OperatorChip() {
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void supabase.auth.getSession().then(({ data }) => {
      if (alive) setEmail(data.session?.user?.email ?? null);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!email) return null;
  const local = email.split("@")[0] ?? email;
  const first = local.split(".")[0] ?? local;
  const name = first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();

  return (
    <span style={chip} title={email}>
      {name}
    </span>
  );
}

const chip: CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  color: "var(--text-muted)",
};

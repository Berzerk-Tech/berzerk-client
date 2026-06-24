import { useState, type ReactNode } from "react";
import { getOpsSession, isCognitoConfigured } from "../lib/cognito";
import { OpsLogin } from "./OpsLogin";

type Props = {
  onBack: () => void;
  children: ReactNode;
};

/**
 * Gate de autenticação dos módulos de Separação: exige sessão do pool ops
 * (username+senha). Se o Cognito não estiver configurado (dev sem env), deixa
 * passar — a API local roda com AUTH_DISABLED.
 */
export function RequireOpsAuth({ onBack, children }: Props) {
  const [authed, setAuthed] = useState(() => !isCognitoConfigured() || !!getOpsSession());

  if (!authed) {
    return <OpsLogin onAuthenticated={() => setAuthed(true)} onBack={onBack} />;
  }
  return <>{children}</>;
}

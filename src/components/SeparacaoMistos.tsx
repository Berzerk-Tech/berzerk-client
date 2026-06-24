import { SeparacaoRunner } from "./SeparacaoRunner";
import { claimNextMixed } from "../services/orders";

type Props = { onBack: () => void };

/** Fila de pedidos mistos (grade mista, separation_mode='total'). */
export function SeparacaoMistos({ onBack }: Props) {
  return (
    <SeparacaoRunner
      title="Separação — Mistos"
      kicker="Fila de mistos"
      emptyHint="Nenhum pedido misto pronto no momento."
      claim={claimNextMixed}
      onBack={onBack}
    />
  );
}

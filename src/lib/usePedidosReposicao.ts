// "Meus pedidos de reposição" da mesa: detecta suporte (404/403 = recurso some)
// e mantém o resumo vivo pro botão. Sem suporte, só tenta de novo a cada 5 min.
// Deps SEMPRE primitivas (`aberto`) — o pai re-renderiza à vontade sem
// disparar chamada nova.

import { useCallback, useEffect, useRef, useState } from "react";
import { getMeusPedidosReposicao, type MeusPedidosReposicao } from "../services/reposicaoPedidos";

export const INTERVALO_FECHADO_MS = 60_000;
export const INTERVALO_ABERTO_MS = 20_000;
export const INTERVALO_SEM_SUPORTE_MS = 5 * 60_000;

export function useMeusPedidosReposicao(aberto: boolean): {
  suporte: boolean;
  meus: MeusPedidosReposicao | null;
  recarregar: () => Promise<void>;
} {
  const [estado, setEstado] = useState<{ suporte: boolean; meus: MeusPedidosReposicao | null }>({
    suporte: false,
    meus: null,
  });
  const suporteRef = useRef(false);
  const vivoRef = useRef(true);

  const recarregar = useCallback(async () => {
    try {
      const m = await getMeusPedidosReposicao();
      if (!vivoRef.current) return;
      if (m === null) {
        suporteRef.current = false;
        setEstado((e) => (e.suporte || e.meus ? { suporte: false, meus: null } : e));
        return;
      }
      suporteRef.current = true;
      setEstado({ suporte: true, meus: m });
    } catch {
      // Falha de rede: mantém o último estado e tenta no próximo ciclo.
    }
  }, []);

  useEffect(() => {
    vivoRef.current = true;
    // Flag LOCAL por execução do efeito: um await antigo (de um `aberto` anterior)
    // nunca agenda timer órfão, mesmo que o efeito novo já tenha reativado o ref.
    let cancelado = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ciclo = async () => {
      await recarregar();
      if (cancelado) return;
      const ms = suporteRef.current ? (aberto ? INTERVALO_ABERTO_MS : INTERVALO_FECHADO_MS) : INTERVALO_SEM_SUPORTE_MS;
      timer = setTimeout(() => void ciclo(), ms);
    };
    void ciclo();
    return () => {
      cancelado = true;
      if (timer) clearTimeout(timer);
    };
  }, [aberto, recarregar]);

  // Desmontagem de verdade (e só ela) derruba o ref usado pelo setState.
  useEffect(
    () => () => {
      vivoRef.current = false;
    },
    [],
  );

  return { suporte: estado.suporte, meus: estado.meus, recarregar };
}

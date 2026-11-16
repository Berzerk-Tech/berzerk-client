// Jobs de impressão que a operadora dispensou no "✕" da fila (Etiquetagem).
//
// Antes o ✕ só chamava o cancelar no servidor e esperava o evento
// `print-jobs.changed` refazer a lista; se o servidor recusasse (job `falhou`
// já terminal) ou o WebSocket estivesse fora, o aviso de erro ficava lá pra
// sempre (Regiane, 16/11). Agora o ✕ é definitivo PARA AQUELE job: guardamos o
// id e a fila nunca mais o exibe, mesmo que o poll devolva o mesmo erro. Job
// novo tem id novo e aparece normalmente.

const CHAVE = "berzerk.jobsDispensados";
const LIMITE = 200;

export function filtrarJobsDispensados<T extends { id: string }>(
  jobs: T[],
  dispensados: ReadonlySet<string>,
): T[] {
  if (dispensados.size === 0) return jobs;
  return jobs.filter((j) => !dispensados.has(j.id));
}

export function carregarJobsDispensados(): Set<string> {
  try {
    const raw = localStorage.getItem(CHAVE);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function salvarJobsDispensados(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(CHAVE, JSON.stringify([...ids].slice(-LIMITE)));
  } catch {
    /* sem storage: vale só nesta sessão */
  }
}

import { useCallback, useMemo, useState } from "react";

/** Estado do "✕" da fila: `visiveis` já sem os dispensados; `dispensar`/`restaurar` por id. */
export function useJobsDispensados<T extends { id: string }>(jobs: T[]) {
  const [dispensados, setDispensados] = useState<Set<string>>(carregarJobsDispensados);
  const visiveis = useMemo(() => filtrarJobsDispensados(jobs, dispensados), [jobs, dispensados]);
  const dispensar = useCallback((id: string) => {
    setDispensados((cur) => {
      const next = new Set(cur).add(id);
      salvarJobsDispensados(next);
      return next;
    });
  }, []);
  const restaurar = useCallback((id: string) => {
    setDispensados((cur) => {
      const next = new Set(cur);
      next.delete(id);
      salvarJobsDispensados(next);
      return next;
    });
  }, []);
  return { visiveis, dispensar, restaurar };
}

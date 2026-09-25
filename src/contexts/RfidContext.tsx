// Contexto GLOBAL do leitor RFID (a "mesa"). Mantém UMA conexão e um ÚNICO
// controlador de leitura para toda a app.
//
// CONTROLE DETERMINÍSTICO (corrige o "pisca"/desarma):
// - O leitor é ARMADO uma vez (`iniciar`) quando a primeira sessão começa a ler
//   e DESARMADO uma vez (`parar`) quando a última para — com "linger" que
//   absorve o StrictMode (remonta o efeito em dev) e a troca de tela.
// - Todos os comandos pro iTAG (iniciar/parar/limpar/poll) são SERIALIZADOS.
//
// DOIS MODOS DE LEITURA (o iTAG só ACUMULA — não detecta remoção):
// - DELTA  (`startReadingSession`): recebe só EPCs NOVOS (dedupe por sessão).
//   Usado pela Separação, que conta cada peça uma vez.
// - PRESENÇA (`startPresenceSession`): recebe o CONJUNTO ATUAL na mesa a cada
//   poll; o buffer é limpo periodicamente (sem desarmar), então tirar/pôr peça
//   reflete na hora. Usado pela Expedição ("ler o tempo todo, refletir a mesa").

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getDeviceConfig } from "../lib/devices";
import { touchActivity } from "../lib/idleSession";
import {
  clearBuffer,
  lookupEpcDetails,
  pingItag,
  pollItagTags,
  startReading,
  stopReading,
} from "../lib/rfid";
import { decodeSgtin96 } from "../lib/sgtin";
import { epcLookup, type EpcLookupItem } from "../services/orders";

const EPC_CACHE_KEY = "berzerk_epc_resolve_cache_v2";
/** Resposta do nexus (`/separacao/epc-lookup`) vale por pouco tempo e só em
 *  memória: é cópia do inventário, que pode estar com o tamanho trocado
 *  (14/09/2026). Vencido o prazo, a próxima leitura tenta a nuvem iTAG de novo
 *  — senão uma resposta errada ficava fixa na estação pra sempre. */
const NEXUS_TTL_MS = 5 * 60 * 1000;
const EPC_CACHE_MAX = 5000;
/** Depois de quanto tempo um EPC que a nuvem iTAG disse NÃO EXISTIR pode ser
 *  consultado lá de novo. Só vale pra "não existe" — nuvem fora/estourada não
 *  entra em backoff nenhum: a próxima leitura (ou R) tenta de novo. */
const UNRESOLVED_RETRY_MS = 5 * 60 * 1000;
/** Teto da chamada à nuvem iTAG dentro de `resolveEpcs`. Era 8 s até 0.9.39 e
 *  o Rust consultava em lotes de 8 sequenciais: mesa com muitas peças estourava
 *  e TUDO caía no fallback do nexus (inventário com tamanho trocado). Agora o
 *  Rust consulta tudo em paralelo com 8 s por chamada; o teto aqui é só o
 *  guarda-chuva. Passou disso, segue com o que tem (fallback provisório). */
const RESOLVE_TIMEOUT_MS = 20000;
/** Teto do fallback `/separacao/epc-lookup` (nexus). */
const NEXUS_TIMEOUT_MS = 8000;
function comTimeout<T>(p: Promise<T>, ms: number, rotulo: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = window.setTimeout(() => reject(new Error(`${rotulo}: sem resposta em ${ms / 1000}s`)), ms);
    p.then(
      (v) => {
        window.clearTimeout(id);
        resolve(v);
      },
      (e) => {
        window.clearTimeout(id);
        reject(e);
      },
    );
  });
}

function loadEpcCache(): Map<string, EpcLookupItem> {
  try {
    let raw = localStorage.getItem(EPC_CACHE_KEY);
    if (!raw) {
      // Migração do cache v1 (até 0.9.38): só quem tem nome veio da nuvem
      // iTAG — o resto era fallback do nexus e fica de fora.
      const v1 = localStorage.getItem("berzerk_epc_resolve_cache_v1");
      if (v1) {
        const soItag = (JSON.parse(v1) as [string, EpcLookupItem][]).filter(([, v]) => !!v.name);
        raw = JSON.stringify(soItag);
        localStorage.setItem(EPC_CACHE_KEY, raw);
        localStorage.removeItem("berzerk_epc_resolve_cache_v1");
      }
    }
    if (!raw) return new Map();
    // Só a nuvem iTAG é persistida (v2) — quem veio sem `fonte` é dela.
    return new Map(
      (JSON.parse(raw) as [string, EpcLookupItem][]).map(([k, v]) => [k, { ...v, fonte: v.fonte ?? "itag" }]),
    );
  } catch {
    return new Map();
  }
}

/** Poda o cache EM MEMÓRIA também (Map preserva ordem de inserção → remove os
 *  mais antigos). Sem isto o teto só valia pra cópia do localStorage e o Map
 *  crescia sem limite num turno inteiro de leituras. */
function trimEpcCache(map: Map<string, EpcLookupItem>): void {
  if (map.size <= EPC_CACHE_MAX) return;
  const excess = map.size - EPC_CACHE_MAX;
  const oldest = Array.from(map.keys()).slice(0, excess);
  for (const k of oldest) map.delete(k);
}

function persistEpcCache(map: Map<string, EpcLookupItem>): void {
  try {
    localStorage.setItem(EPC_CACHE_KEY, JSON.stringify(Array.from(map.entries())));
  } catch {
    /* localStorage cheio/indisponível */
  }
}

const POLL_MS = 400;
/** Mesa fora do ar: em vez de martelar o iTAG a cada 400 ms (150 chamadas por
 *  minuto, cada uma com sua Promise, sua string de erro e seu `setLastError`),
 *  o intervalo dobra até este teto e volta pro normal na primeira leitura boa.
 *  A operadora não perde nada: assim que a mesa responde, o poll destrava. */
const POLL_MAX_MS = 5_000;
const PING_MS = 5000;
const LINGER_MS = 900;
/** De quanto em quanto limpa o buffer no modo presença (reflete remoção).
 *  Menos frequente = menos "janela cega" logo após limpar (menos "surdo");
 *  o TTL do lado da Expedição (maior que isto) segura a peça entre limpezas. */
const PRESENCE_CLEAR_MS = 1500;
/** Peça fora da mesa por mais que isto e recolocada = atividade de novo. */
const PRESENCE_ABSENT_MS = 60_000;

type DeltaListener = { cb: (newEpcs: string[]) => void; seen: Set<string> };

/** Sessão DELTA aberta. `reset` zera o dedupe e limpa o buffer da mesa SEM
 *  desarmar o leitor — é o que a Separação usa ao trocar de pedido e no
 *  "Reiniciar (R)". Antes cada troca fechava/abria a sessão e, como o claim
 *  do próximo pedido demora mais que o linger, virava `parar`+`iniciar` no
 *  iTAG Monitor (que mostra um aviso a cada comando desses — chato no turno). */
export type ReadingSession = { stop: () => void; reset: () => Promise<void> };
type PresenceListener = { cb: (currentEpcs: string[]) => void };

type RfidContextValue = {
  connected: boolean;
  host: string;
  lastError: string | null;
  reconnect: () => Promise<void>;
  /** Modo DELTA: recebe só EPCs novos (dedupe por sessão). Abra UMA vez por
   *  tela e use `reset` pra recomeçar a contagem (não fecha/abre por pedido). */
  startReadingSession: (onTags: (newEpcs: string[]) => void) => ReadingSession;
  /** Modo PRESENÇA: recebe o conjunto ATUAL na mesa a cada poll. Retorna o stop. */
  startPresenceSession: (onPresent: (currentEpcs: string[]) => void) => () => void;
  resolveEpcs: (epcs: string[]) => Promise<Map<string, EpcLookupItem>>;
};

const RfidContext = createContext<RfidContextValue | null>(null);

/** Leitor em modo TECLADO (keyboard wedge). Não tem armar/desarmar. */
function startWedgeSession(onTags: (newEpcs: string[]) => void): ReadingSession {
  let seen = new Set<string>();
  let buffer = "";
  let lastKeyAt = 0;
  const MAX_GAP_MS = 150;
  const MIN_LEN = 16;
  const onKeyDown = (ev: KeyboardEvent) => {
    const now = Date.now();
    if (now - lastKeyAt > MAX_GAP_MS) buffer = "";
    lastKeyAt = now;
    if (ev.key === "Enter") {
      const epc = buffer.toUpperCase();
      buffer = "";
      if (epc.length >= MIN_LEN && /^[0-9A-F]+$/.test(epc) && !seen.has(epc)) {
        seen.add(epc);
        touchActivity();
        onTags([epc]);
      }
      return;
    }
    if (ev.key.length === 1 && /^[0-9A-Fa-f]$/.test(ev.key)) buffer += ev.key;
    else buffer = "";
  };
  window.addEventListener("keydown", onKeyDown, true);
  return {
    stop: () => window.removeEventListener("keydown", onKeyDown, true),
    reset: async () => {
      seen = new Set();
      buffer = "";
    },
  };
}

export function RfidProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [host, setHost] = useState(() => getDeviceConfig().reader.itagHost);
  const [lastError, setLastError] = useState<string | null>(null);
  const cacheRef = useRef<Map<string, EpcLookupItem>>(loadEpcCache());
  /** EPCs que falharam na consulta → quando falharam. Com TTL: depois de
   *  UNRESOLVED_RETRY_MS a gente tenta de novo (peça pode ter sido cadastrada
   *  no nexus depois da primeira leitura — antes ficava "não identificada"
   *  até reiniciar o app). */
  const unresolvedRef = useRef<Map<string, number>>(new Map());
  /** Resoluções vindas do nexus — só memória, com TTL (`NEXUS_TTL_MS`). */
  const nexusRef = useRef<Map<string, { item: EpcLookupItem; em: number }>>(new Map());
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Persistência com debounce: serializar o cache inteiro (até 5000 entradas)
   *  a cada batch resolvido era churn constante no main thread — a Expedição
   *  resolve a mesa o tempo todo. O localStorage é só warm-start; 2s atrás
   *  do último write não perde nada relevante. */
  const schedulePersist = useCallback(() => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      persistEpcCache(cacheRef.current);
    }, 2000);
  }, []);

  // --- Controlador do leitor ---
  const armedRef = useRef(false);
  const deltaRef = useRef<Set<DeltaListener>>(new Set());
  const presenceRef = useRef<Set<PresenceListener>>(new Set());
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollActiveRef = useRef(false);
  /** Intervalo corrente do poll — cresce enquanto a mesa não responde. */
  const pollDelayRef = useRef(POLL_MS);
  const tearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** EPC → última vez visto na mesa (modo presença). Peça NOVA na mesa conta
   *  como atividade da operadora; peça parada lá não (senão uma peça esquecida
   *  segurava a sessão pra sempre). Some do mapa após PRESENCE_ABSENT_MS fora. */
  const presenceSeenRef = useRef<Map<string, number>>(new Map());
  const cmdChainRef = useRef<Promise<unknown>>(Promise.resolve());

  const anyListeners = () => deltaRef.current.size > 0 || presenceRef.current.size > 0;

  const runExclusive = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    const next = cmdChainRef.current.then(() => fn(), () => fn());
    cmdChainRef.current = next.then(() => undefined, () => undefined);
    return next as Promise<T>;
  }, []);

  const prepareSession = useCallback(
    async (h: string) => {
      await runExclusive(async () => {
        await clearBuffer(h);
        if (!armedRef.current) {
          await startReading(h);
          armedRef.current = true;
        }
      });
    },
    [runExclusive],
  );

  const teardownReader = useCallback(
    async (h: string) => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      pollActiveRef.current = false;
      if (presenceTimerRef.current) {
        clearTimeout(presenceTimerRef.current);
        presenceTimerRef.current = null;
      }
      if (armedRef.current) {
        armedRef.current = false;
        await runExclusive(() => stopReading(h));
      }
    },
    [runExclusive],
  );

  const startPollLoop = useCallback(
    (h: string) => {
      if (pollActiveRef.current) return;
      pollActiveRef.current = true;
      pollDelayRef.current = POLL_MS;
      const loop = async () => {
        pollTimerRef.current = null;
        if (!anyListeners()) {
          pollActiveRef.current = false;
          return;
        }
        try {
          const poll = await runExclusive(() => pollItagTags(h));
          setConnected(true);
          setLastError(null);
          // Dedupe: o iTAG devolve a MESMA tag mais de uma vez no mesmo poll
          // (duas antenas lendo a peça) — sem isso a tag entrava duas vezes em
          // `novos`, a 1ª contava e a 2ª virava "unidade a MAIS" (Duda, 25/09).
          const all = Array.from(new Set(poll.tags.map((t) => t.trim().toUpperCase()).filter(Boolean)));
          // DELTA: só novos, por sessão.
          let activity = false;
          for (const l of deltaRef.current) {
            const novos = all.filter((t) => !l.seen.has(t));
            for (const t of novos) l.seen.add(t);
            if (novos.length > 0) {
              activity = true;
              l.cb(novos);
            }
          }
          // PRESENÇA: conjunto atual (acumulado desde o último limpar).
          if (presenceRef.current.size > 0) {
            const now = Date.now();
            const seen = presenceSeenRef.current;
            for (const t of all) {
              if (!seen.has(t)) activity = true;
              seen.set(t, now);
            }
            for (const [t, at] of seen) if (now - at > PRESENCE_ABSENT_MS) seen.delete(t);
            for (const p of presenceRef.current) p.cb(all);
          }
          if (activity) touchActivity();
          pollDelayRef.current = POLL_MS;
        } catch (e) {
          setConnected(false);
          setLastError(e instanceof Error ? e.message : String(e));
          pollDelayRef.current = Math.min(pollDelayRef.current * 2, POLL_MAX_MS);
        } finally {
          if (anyListeners()) pollTimerRef.current = setTimeout(loop, pollDelayRef.current);
          else pollActiveRef.current = false;
        }
      };
      pollTimerRef.current = setTimeout(loop, 0);
    },
    [runExclusive],
  );

  // Limpa o buffer periodicamente enquanto há sessão de PRESENÇA — assim a
  // remoção de peça reflete (o iTAG só acumula; sem isto ela nunca "sai").
  const startPresenceRefresh = useCallback(
    (h: string) => {
      if (presenceTimerRef.current) return;
      const tick = async () => {
        presenceTimerRef.current = null;
        if (presenceRef.current.size === 0) return;
        try {
          await runExclusive(() => clearBuffer(h));
        } catch {
          /* segue no próximo tick */
        }
        if (presenceRef.current.size > 0) presenceTimerRef.current = setTimeout(tick, PRESENCE_CLEAR_MS);
      };
      presenceTimerRef.current = setTimeout(tick, PRESENCE_CLEAR_MS);
    },
    [runExclusive],
  );

  const scheduleTeardown = useCallback(
    (h: string) => {
      if (anyListeners()) return;
      if (tearTimerRef.current) clearTimeout(tearTimerRef.current);
      tearTimerRef.current = setTimeout(() => {
        tearTimerRef.current = null;
        if (!anyListeners()) void teardownReader(h);
      }, LINGER_MS);
    },
    [teardownReader],
  );

  const startReadingSession = useCallback(
    (onTags: (newEpcs: string[]) => void) => {
      const reader = getDeviceConfig().reader;
      if (reader.mode === "keyboard-wedge") return startWedgeSession(onTags);
      const h = reader.itagHost;
      const listener: DeltaListener = { cb: onTags, seen: new Set() };
      deltaRef.current.add(listener);
      if (tearTimerRef.current) {
        clearTimeout(tearTimerRef.current);
        tearTimerRef.current = null;
      }
      void prepareSession(h).then(() => startPollLoop(h)).catch((e) => {
        setConnected(false);
        setLastError(e instanceof Error ? e.message : String(e));
      });
      return {
        stop: () => {
          deltaRef.current.delete(listener);
          scheduleTeardown(h);
        },
        // Serializado com o poll: o `seen` só zera DEPOIS do limpar, senão um
        // poll em voo (tags de antes do limpar) recontava peça do pedido anterior.
        reset: () =>
          runExclusive(async () => {
            await clearBuffer(h);
            listener.seen = new Set();
          }),
      };
    },
    [prepareSession, startPollLoop, scheduleTeardown, runExclusive],
  );

  const startPresenceSession = useCallback(
    (onPresent: (currentEpcs: string[]) => void) => {
      const reader = getDeviceConfig().reader;
      if (reader.mode === "keyboard-wedge") {
        // Wedge não tem presença real: cada bipada chega UMA vez. A Expedição
        // precisa de reemissão contínua (TTL de presença), então acumula o
        // que foi bipado e reemite o conjunto a cada segundo até o stop.
        const acumulado = new Set<string>();
        const sess = startWedgeSession((epcs) => {
          for (const e of epcs) acumulado.add(e.trim().toUpperCase());
          onPresent([...acumulado]);
        });
        const id = window.setInterval(() => {
          if (acumulado.size > 0) onPresent([...acumulado]);
        }, 1000);
        return () => {
          window.clearInterval(id);
          sess.stop();
        };
      }
      const h = reader.itagHost;
      const listener: PresenceListener = { cb: onPresent };
      presenceRef.current.add(listener);
      if (tearTimerRef.current) {
        clearTimeout(tearTimerRef.current);
        tearTimerRef.current = null;
      }
      void prepareSession(h)
        .then(() => {
          startPollLoop(h);
          startPresenceRefresh(h);
        })
        .catch((e) => {
          setConnected(false);
          setLastError(e instanceof Error ? e.message : String(e));
        });
      return () => {
        presenceRef.current.delete(listener);
        if (presenceRef.current.size === 0 && presenceTimerRef.current) {
          clearTimeout(presenceTimerRef.current);
          presenceTimerRef.current = null;
        }
        scheduleTeardown(h);
      };
    },
    [prepareSession, startPollLoop, startPresenceRefresh, scheduleTeardown],
  );

  const ping = useCallback(async () => {
    const reader = getDeviceConfig().reader;
    if (reader.mode === "keyboard-wedge") {
      setHost("leitor-teclado");
      setConnected(true);
      setLastError(null);
      return;
    }
    if (anyListeners()) return; // leitura ativa gerencia o status
    const h = reader.itagHost;
    setHost(h);
    try {
      const status = await runExclusive(() => pingItag(h));
      setConnected(status.ok);
      setLastError(status.ok ? null : status.message ?? "mesa não respondeu");
    } catch (e) {
      setConnected(false);
      setLastError(e instanceof Error ? e.message : String(e));
    }
  }, [runExclusive]);

  useEffect(() => {
    let alive = true;
    void ping();
    const id = setInterval(() => {
      if (alive) void ping();
    }, PING_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [ping]);

  const resolveEpcs = useCallback(
    async (epcs: string[]): Promise<Map<string, EpcLookupItem>> => {
      const norm = Array.from(new Set(epcs.map((e) => e.trim().toUpperCase()).filter(Boolean)));
      const result = new Map<string, EpcLookupItem>();
      const agora = Date.now();
      let misses: string[] = [];
      const fallbackOnly: string[] = [];
      for (const e of norm) {
        if (/^\d{13}$/.test(e)) {
          result.set(e, { epc: e, ean13: e, sku: null, size: null, batchCode: null });
          continue;
        }
        const cached = cacheRef.current.get(e);
        if (cached) {
          result.set(e, cached);
          continue;
        }
        // Sem resposta da NUVEM em cache: vai consultá-la (de novo, se a última
        // vez foi fallback do nexus/SGTIN — esses são provisórios e é
        // justamente no R da operadora que a nuvem ganha a 2ª chance). A única
        // exceção é a nuvem ter dito que o EPC NÃO EXISTE há menos de 5 min.
        const naoExisteEm = unresolvedRef.current.get(e);
        if (naoExisteEm !== undefined && agora - naoExisteEm < UNRESOLVED_RETRY_MS) {
          fallbackOnly.push(e);
        } else {
          unresolvedRef.current.delete(e);
          misses.push(e);
        }
      }

      let touchedCache = false;
      // Só a nuvem iTAG entra no cache persistente: é a verdade da etiqueta.
      const commit = (item: EpcLookupItem) => {
        const key = item.epc.toUpperCase();
        cacheRef.current.set(key, item);
        result.set(key, item);
        touchedCache = true;
      };

      if (misses.length > 0) {
        try {
          const details = await comTimeout(lookupEpcDetails(misses), RESOLVE_TIMEOUT_MS, "nuvem iTAG");
          for (const d of details) {
            const key = d.epc.toUpperCase();
            if (d.found && d.ean13) {
              commit({
                epc: key,
                ean13: d.ean13,
                sku: null,
                size: d.tamanho,
                batchCode: null,
                name: d.nome,
                fonte: "itag",
              });
            } else if (!d.found && d.fonte !== "erro") {
              // A nuvem RESPONDEU que não conhece o EPC (nos dois ambientes):
              // só aí entra em backoff. `fonte: "erro"` = algum ambiente não
              // respondeu → sem backoff, a próxima leitura tenta de novo.
              if (unresolvedRef.current.size > EPC_CACHE_MAX) unresolvedRef.current.clear();
              unresolvedRef.current.set(key, agora);
            }
          }
        } catch (e) {
          setLastError(e instanceof Error ? e.message : String(e));
        }
        misses = misses.filter((e) => !result.has(e));
      }

      // Fallback PROVISÓRIO (nexus, depois SGTIN) pra quem a nuvem não resolveu
      // agora. Nunca persiste e nunca bloqueia nova consulta à nuvem.
      const pendentes = [...misses, ...fallbackOnly];
      const semNexus: string[] = [];
      for (const e of pendentes) {
        const doNexus = nexusRef.current.get(e);
        if (doNexus && agora - doNexus.em < NEXUS_TTL_MS) result.set(e, doNexus.item);
        else semNexus.push(e);
      }
      if (semNexus.length > 0) {
        try {
          const { items } = await comTimeout(epcLookup(semNexus), NEXUS_TIMEOUT_MS, "epc-lookup");
          for (const item of items) {
            const key = item.epc.toUpperCase();
            const it = { ...item, fonte: "nexus" as const };
            if (nexusRef.current.size > EPC_CACHE_MAX) nexusRef.current.clear();
            nexusRef.current.set(key, { item: it, em: agora });
            result.set(key, it);
          }
        } catch (e) {
          setLastError(e instanceof Error ? e.message : String(e));
        }
      }

      for (const e of pendentes) {
        if (result.has(e)) continue;
        const decoded = decodeSgtin96(e);
        if (decoded) result.set(e, { epc: e, ean13: decoded, sku: null, size: null, batchCode: null, fonte: "sgtin" });
      }

      if (touchedCache) {
        trimEpcCache(cacheRef.current);
        schedulePersist();
      }
      return result;
    },
    [schedulePersist],
  );

  const value: RfidContextValue = {
    connected,
    host,
    lastError,
    reconnect: () => ping(),
    startReadingSession,
    startPresenceSession,
    resolveEpcs,
  };

  return <RfidContext.Provider value={value}>{children}</RfidContext.Provider>;
}

export function useRfid(): RfidContextValue {
  const ctx = useContext(RfidContext);
  if (!ctx) throw new Error("useRfid precisa estar dentro de <RfidProvider>");
  return ctx;
}

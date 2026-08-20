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

const EPC_CACHE_KEY = "berzerk_epc_resolve_cache_v1";
const EPC_CACHE_MAX = 5000;
/** Depois de quanto tempo um EPC "não resolvido" pode ser consultado de novo. */
const UNRESOLVED_RETRY_MS = 5 * 60 * 1000;

function loadEpcCache(): Map<string, EpcLookupItem> {
  try {
    const raw = localStorage.getItem(EPC_CACHE_KEY);
    if (!raw) return new Map();
    return new Map(JSON.parse(raw) as [string, EpcLookupItem][]);
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
const PING_MS = 5000;
const LINGER_MS = 900;
/** De quanto em quanto limpa o buffer no modo presença (reflete remoção).
 *  Menos frequente = menos "janela cega" logo após limpar (menos "surdo");
 *  o TTL do lado da Expedição (maior que isto) segura a peça entre limpezas. */
const PRESENCE_CLEAR_MS = 1500;

type DeltaListener = { cb: (newEpcs: string[]) => void; seen: Set<string> };
type PresenceListener = { cb: (currentEpcs: string[]) => void };

type RfidContextValue = {
  connected: boolean;
  host: string;
  lastError: string | null;
  reconnect: () => Promise<void>;
  /** Modo DELTA: recebe só EPCs novos (dedupe por sessão). Retorna o stop. */
  startReadingSession: (onTags: (newEpcs: string[]) => void) => () => void;
  /** Modo PRESENÇA: recebe o conjunto ATUAL na mesa a cada poll. Retorna o stop. */
  startPresenceSession: (onPresent: (currentEpcs: string[]) => void) => () => void;
  resolveEpcs: (epcs: string[]) => Promise<Map<string, EpcLookupItem>>;
};

const RfidContext = createContext<RfidContextValue | null>(null);

/** Leitor em modo TECLADO (keyboard wedge). Não tem armar/desarmar. */
function startWedgeSession(onTags: (newEpcs: string[]) => void): () => void {
  const seen = new Set<string>();
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
        onTags([epc]);
      }
      return;
    }
    if (ev.key.length === 1 && /^[0-9A-Fa-f]$/.test(ev.key)) buffer += ev.key;
    else buffer = "";
  };
  window.addEventListener("keydown", onKeyDown, true);
  return () => window.removeEventListener("keydown", onKeyDown, true);
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
  const tearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const presenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
          const all = poll.tags.map((t) => t.trim().toUpperCase()).filter(Boolean);
          // DELTA: só novos, por sessão.
          for (const l of deltaRef.current) {
            const novos = all.filter((t) => !l.seen.has(t));
            for (const t of novos) l.seen.add(t);
            if (novos.length > 0) l.cb(novos);
          }
          // PRESENÇA: conjunto atual (acumulado desde o último limpar).
          for (const p of presenceRef.current) p.cb(all);
        } catch (e) {
          setConnected(false);
          setLastError(e instanceof Error ? e.message : String(e));
        } finally {
          if (anyListeners()) pollTimerRef.current = setTimeout(loop, POLL_MS);
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
      return () => {
        deltaRef.current.delete(listener);
        scheduleTeardown(h);
      };
    },
    [prepareSession, startPollLoop, scheduleTeardown],
  );

  const startPresenceSession = useCallback(
    (onPresent: (currentEpcs: string[]) => void) => {
      const reader = getDeviceConfig().reader;
      if (reader.mode === "keyboard-wedge") {
        // Wedge não tem presença real — emula tratando cada bipada como atual.
        return startWedgeSession((epcs) => onPresent(epcs));
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
      let misses: string[] = [];
      for (const e of norm) {
        if (/^\d{13}$/.test(e)) {
          result.set(e, { epc: e, ean13: e, sku: null, size: null, batchCode: null });
          continue;
        }
        const cached = cacheRef.current.get(e);
        const failedAt = unresolvedRef.current.get(e);
        if (cached) {
          result.set(e, cached);
        } else if (failedAt !== undefined && Date.now() - failedAt < UNRESOLVED_RETRY_MS) {
          const decoded = decodeSgtin96(e);
          if (decoded) result.set(e, { epc: e, ean13: decoded, sku: null, size: null, batchCode: null });
        } else {
          unresolvedRef.current.delete(e); // TTL vencido: tenta de novo
          misses.push(e);
        }
      }

      let touchedCache = false;
      const commit = (item: EpcLookupItem) => {
        const key = item.epc.toUpperCase();
        cacheRef.current.set(key, item);
        result.set(key, item);
        touchedCache = true;
      };

      if (misses.length > 0) {
        try {
          const details = await lookupEpcDetails(misses);
          for (const d of details) {
            if (d.found && d.ean13) {
              commit({ epc: d.epc, ean13: d.ean13, sku: null, size: d.tamanho, batchCode: null, name: d.nome });
            }
          }
        } catch (e) {
          setLastError(e instanceof Error ? e.message : String(e));
        }
        misses = misses.filter((e) => !result.has(e));
      }

      if (misses.length > 0) {
        try {
          const { items } = await epcLookup(misses);
          for (const item of items) commit(item);
        } catch (e) {
          setLastError(e instanceof Error ? e.message : String(e));
        }
        misses = misses.filter((e) => !result.has(e));
      }

      for (const e of misses) {
        unresolvedRef.current.set(e, Date.now());
        const decoded = decodeSgtin96(e);
        if (decoded) result.set(e, { epc: e, ean13: decoded, sku: null, size: null, batchCode: null });
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

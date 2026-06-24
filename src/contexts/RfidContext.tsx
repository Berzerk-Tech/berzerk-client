// Contexto GLOBAL do leitor RFID (a "mesa"). Substitui o uso por-página do
// src/lib/rfid.ts: mantém UMA conexão, faz poll contínuo sob demanda, compartilha
// o cache EPC→EAN entre telas e sinaliza "mesa caiu" sem deslogar.

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
import { clearBuffer, pingItag, pollItagTags, startReading, stopReading } from "../lib/rfid";
import { epcLookup, type EpcLookupItem } from "../services/orders";

/** Intervalo entre polls durante uma sessão de leitura contínua. */
const POLL_MS = 700;
/** Intervalo do healthcheck da mesa quando ociosa. */
const PING_MS = 5000;

type RfidContextValue = {
  connected: boolean;
  host: string;
  lastError: string | null;
  /** Refaz o ping imediatamente (botão "reconectar"). */
  reconnect: () => Promise<void>;
  /**
   * Inicia leitura contínua. `onTags` recebe apenas EPCs NOVOS (dedupe interno
   * por sessão). Retorna uma função pra parar a sessão.
   */
  startReadingSession: (onTags: (newEpcs: string[]) => void) => () => void;
  /** Resolve EPC→EAN/SKU com cache compartilhado (RDS via separacao-api). */
  resolveEpcs: (epcs: string[]) => Promise<Map<string, EpcLookupItem>>;
};

const RfidContext = createContext<RfidContextValue | null>(null);

export function RfidProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [host, setHost] = useState(() => getDeviceConfig().reader.itagHost);
  const [lastError, setLastError] = useState<string | null>(null);
  const cacheRef = useRef<Map<string, EpcLookupItem>>(new Map());

  const ping = useCallback(async () => {
    const h = getDeviceConfig().reader.itagHost;
    setHost(h);
    try {
      const status = await pingItag(h);
      setConnected(status.ok);
      setLastError(status.ok ? null : status.message ?? "mesa não respondeu");
    } catch (e) {
      setConnected(false);
      setLastError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Healthcheck periódico da mesa (não bloqueia operação).
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

  const startReadingSession = useCallback((onTags: (newEpcs: string[]) => void) => {
    const h = getDeviceConfig().reader.itagHost;
    const seen = new Set<string>();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const loop = async () => {
      if (stopped) return;
      try {
        const poll = await pollItagTags(h);
        if (!stopped) {
          setConnected(true);
          const fresh = poll.tags
            .map((t) => t.trim().toUpperCase())
            .filter((t) => t && !seen.has(t));
          for (const t of fresh) seen.add(t);
          if (fresh.length > 0) onTags(fresh);
        }
      } catch (e) {
        // Mesa caiu durante o uso → banner, sem derrubar a sessão; segue tentando.
        setConnected(false);
        setLastError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!stopped) timer = setTimeout(loop, POLL_MS);
      }
    };

    // Arranca: limpa buffer + inicia leitura, então entra no loop de poll.
    void (async () => {
      try {
        await clearBuffer(h);
        await startReading(h);
      } catch (e) {
        setConnected(false);
        setLastError(e instanceof Error ? e.message : String(e));
      }
      if (!stopped) timer = setTimeout(loop, POLL_MS);
    })();

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      void stopReading(h).catch(() => {
        /* best-effort */
      });
    };
  }, []);

  const resolveEpcs = useCallback(
    async (epcs: string[]): Promise<Map<string, EpcLookupItem>> => {
      const norm = Array.from(
        new Set(epcs.map((e) => e.trim().toUpperCase()).filter(Boolean)),
      );
      const result = new Map<string, EpcLookupItem>();
      const misses: string[] = [];
      for (const e of norm) {
        const cached = cacheRef.current.get(e);
        if (cached) result.set(e, cached);
        else misses.push(e);
      }
      if (misses.length > 0) {
        try {
          const { items } = await epcLookup(misses);
          for (const item of items) {
            const key = item.epc.toUpperCase();
            cacheRef.current.set(key, item);
            result.set(key, item);
          }
        } catch (e) {
          setLastError(e instanceof Error ? e.message : String(e));
        }
      }
      return result;
    },
    [],
  );

  const value: RfidContextValue = {
    connected,
    host,
    lastError,
    reconnect: ping,
    startReadingSession,
    resolveEpcs,
  };

  return <RfidContext.Provider value={value}>{children}</RfidContext.Provider>;
}

export function useRfid(): RfidContextValue {
  const ctx = useContext(RfidContext);
  if (!ctx) throw new Error("useRfid precisa estar dentro de <RfidProvider>");
  return ctx;
}

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
import { decodeSgtin96 } from "../lib/sgtin";
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

/**
 * Sessão de leitura pra leitor em modo TECLADO (keyboard wedge — ex.: ACURA
 * AC01v2, que digita o EPC como um teclado USB e finaliza com Enter).
 *
 * Heurística anti-falso-positivo: só aceita rajadas RÁPIDAS (gap < 150ms entre
 * teclas — humano digita mais devagar) de caracteres hex com 16+ dígitos,
 * finalizadas por Enter. Dedupe por sessão, igual ao modo iTAG.
 */
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
    if (ev.key.length === 1 && /^[0-9A-Fa-f]$/.test(ev.key)) {
      buffer += ev.key;
    } else {
      buffer = "";
    }
  };

  window.addEventListener("keydown", onKeyDown, true);
  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
  };
}

export function RfidProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [host, setHost] = useState(() => getDeviceConfig().reader.itagHost);
  const [lastError, setLastError] = useState<string | null>(null);
  const cacheRef = useRef<Map<string, EpcLookupItem>>(new Map());

  const ping = useCallback(async () => {
    const reader = getDeviceConfig().reader;
    // Keyboard wedge: não há o que pingar — o leitor é um teclado USB.
    if (reader.mode === "keyboard-wedge") {
      setHost("leitor-teclado");
      setConnected(true);
      setLastError(null);
      return;
    }
    // WCF REST: sonda GET /RetornaStatus — só consulta, não abre sessão nem
    // dispara o overlay "Aguarde!" do iTAG (que aparece a cada `iniciar`).
    const h = reader.itagHost;
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
    const reader = getDeviceConfig().reader;
    if (reader.mode === "keyboard-wedge") {
      return startWedgeSession(onTags);
    }
    // WCF REST (caminho documentado da iTAG): `limparLeitura` + `iniciar` UMA
    // vez no começo da sessão, depois só GET /RetornaTag em loop — o comando
    // `iniciar` dispara o overlay "Aguarde!" do iTAG Monitor, então NUNCA pode
    // rodar em ciclo (era o popup insuportável do modo WS aposentado).
    const h = reader.itagHost;
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
        // EAN-13 direto (iTAG WS já resolve EPC→EAN): não precisa de lookup.
        if (/^\d{13}$/.test(e)) {
          result.set(e, { epc: e, ean13: e, sku: null, size: null, batchCode: null });
          continue;
        }
        // DECODE-FIRST: EPC SGTIN-96 carrega o EAN nos próprios bits (mesmo
        // caminho do posvenda). Instantâneo, offline e imune a inventário
        // desatualizado/errado. API só pra EPC fora do padrão SGTIN.
        const decoded = decodeSgtin96(e);
        if (decoded) {
          result.set(e, { epc: e, ean13: decoded, sku: null, size: null, batchCode: null });
          continue;
        }
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
    reconnect: () => ping(),
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

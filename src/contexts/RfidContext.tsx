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

/** Healthcheck do WS: conecta, resolve true no open, false em erro/timeout. */
function pingWebSocket(url: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean, ws?: WebSocket) => {
      if (done) return;
      done = true;
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };
    try {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => finish(false, ws), timeoutMs);
      ws.onopen = () => {
        clearTimeout(timer);
        finish(true, ws);
      };
      ws.onerror = () => {
        clearTimeout(timer);
        finish(false, ws);
      };
    } catch {
      finish(false);
    }
  });
}

/**
 * Extrai identificadores de tag de uma mensagem do WS do iTAG. Formatos reais
 * (engenharia reversa do console RFID do posvenda): JSON `{tags:[...]}`, linhas
 * de EAN-13 (13 dígitos — o iTAG já resolve EPC→EAN internamente) ou EPC hex.
 */
export function extractEpcs(message: string): string[] {
  const out = new Set<string>();
  const push = (v: string) => {
    const s = v.trim().toUpperCase();
    if (/^\d{13}$/.test(s)) out.add(s); // EAN-13
    else if (/^[0-9A-F]{16,32}$/.test(s)) out.add(s); // EPC hex
  };
  try {
    const parsed = JSON.parse(message) as { tags?: unknown[] };
    if (Array.isArray(parsed.tags)) {
      for (const t of parsed.tags) push(String(t));
      return Array.from(out);
    }
  } catch {
    /* não é JSON — segue pro parse de texto */
  }
  for (const line of message.split(/[\r\n,;]+/)) push(line);
  // fallbacks: EPC hex ou EAN-13 embutidos em texto/lixo binário
  for (const hex of message.toUpperCase().match(/[0-9A-F]{16,32}/g) ?? []) out.add(hex);
  for (const run of message.match(/\d{13,}/g) ?? []) {
    if (run.length === 13) out.add(run);
  }
  return Array.from(out);
}

/**
 * Frame binário do WS do iTAG → texto: bytes imprimíveis ficam, o resto vira
 * quebra de linha (os EPC/EAN vêm em ASCII no meio de padding binário).
 */
export function bytesToPrintable(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (const b of bytes) {
    out += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : "\n";
  }
  return out;
}

/**
 * Sessão de leitura via WebSocket Server do iTAG Monitor (porta 9098) — o
 * caminho do pós-venda. O protocolo é COMANDO via WS (não streaming passivo):
 * `limparLeitura` → `iniciar` e colheita periódica com `retornaEAN`; `parar`
 * ao encerrar. Reconecta sozinha a cada 2s se cair.
 */
function startWsSession(
  url: string,
  onTags: (newEpcs: string[]) => void,
  onStatus: (up: boolean, err?: string) => void,
): () => void {
  const seen = new Set<string>();
  let stopped = false;
  let ws: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let harvest: ReturnType<typeof setInterval> | null = null;

  const send = (cmd: string) => {
    try {
      if (ws?.readyState === WebSocket.OPEN) ws.send(cmd);
    } catch {
      /* ignore */
    }
  };

  const handleText = (text: string) => {
    const fresh = extractEpcs(text).filter((e) => !seen.has(e));
    if (fresh.length > 0) {
      for (const e of fresh) seen.add(e);
      onTags(fresh);
    }
  };

  const connect = () => {
    if (stopped) return;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      onStatus(false, e instanceof Error ? e.message : String(e));
      retry = setTimeout(connect, 2000);
      return;
    }
    ws.onopen = () => {
      onStatus(true);
      send("limparLeitura");
      setTimeout(() => send("iniciar"), 300);
      if (harvest) clearInterval(harvest);
      harvest = setInterval(() => send("retornaEAN"), 1500);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") handleText(ev.data);
      else if (ev.data instanceof Blob)
        void ev.data.arrayBuffer().then((b) => handleText(bytesToPrintable(b)));
    };
    ws.onclose = () => {
      if (harvest) clearInterval(harvest);
      if (!stopped) {
        onStatus(false, "WebSocket do iTAG caiu — reconectando…");
        retry = setTimeout(connect, 2000);
      }
    };
    ws.onerror = () => {
      /* onclose cuida do retry */
    };
  };
  connect();

  return () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    if (harvest) clearInterval(harvest);
    send("parar");
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  };
}

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
  // Sessão WS ativa + última sondagem: o iTAG mostra um POPUP a cada conexão
  // nova no WS dele — então o healthcheck não pode abrir conexão a cada 5s.
  const wsSessionActiveRef = useRef(false);
  const lastWsProbeRef = useRef(0);

  const ping = useCallback(async (force = false) => {
    const reader = getDeviceConfig().reader;
    // Keyboard wedge: não há o que pingar — o leitor é um teclado USB.
    if (reader.mode === "keyboard-wedge") {
      setHost("leitor-teclado");
      setConnected(true);
      setLastError(null);
      return;
    }
    // iTAG WebSocket: com sessão ativa, quem informa o status é a sessão.
    // Ocioso, sonda no máximo 1x/min (cada conexão dispara popup no iTAG);
    // o botão "reconectar" força na hora.
    if (reader.mode === "itag-ws") {
      setHost(reader.wsUrl);
      if (wsSessionActiveRef.current) return;
      const now = Date.now();
      if (!force && now - lastWsProbeRef.current < 60_000) return;
      lastWsProbeRef.current = now;
      const ok = await pingWebSocket(reader.wsUrl, 3000);
      setConnected(ok);
      setLastError(ok ? null : "WebSocket do iTAG não respondeu");
      return;
    }
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
    if (reader.mode === "itag-ws") {
      wsSessionActiveRef.current = true;
      const stop = startWsSession(reader.wsUrl, onTags, (up, err) => {
        setConnected(up);
        setLastError(up ? null : err ?? null);
      });
      return () => {
        wsSessionActiveRef.current = false;
        stop();
      };
    }
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
    // Reconectar manual força a sondagem (ignora o rate-limit anti-popup).
    reconnect: () => ping(true),
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

// Configuração de dispositivos físicos por estação (impressora térmica, leitor RFID).
// Persistido em localStorage por enquanto — futuramente migra pra row em rfid_print_stations
// no Supabase pra config central por estação.
//
// USB autodetect ainda não implementado (próxima sessão) — campos são preenchidos
// manualmente por agora. Quando o autodetect entrar, ele apenas substitui o valor.

export type ThermalPrinter = {
  /** Nome amigável da impressora (ex: "Elgin L42DT - Bobina 01") */
  name: string;
  /** Identificador do dispositivo (vendorId:productId no USB, ou caminho COM/COMx no Windows) */
  deviceId: string;
  /** Modelo conhecido — afeta protocolo (ESC/POS, ZPL, etc) */
  model: "elgin-l42dt" | "generic-escpos" | "zpl" | "unknown";
};

export type RfidReader = {
  name: string;
  /** URL base do serviço WCF REST do iTAG Monitor (default http://localhost:9093). */
  itagHost: string;
  /** Modo de operação. WebSocket (9098) foi aposentado (2026-07-30): o iTAG
   *  Monitor da fábrica roda com "Método Execução: Monitor Web Service WCF",
   *  então quem controla o leitor é o serviço REST na 9093 — o WS aceitava os
   *  comandos mas devolvia `[]` sempre. Config antiga é coagida pra `itag-rest`. */
  mode: "keyboard-wedge" | "itag-rest";
};

export type DeviceConfig = {
  printer: ThermalPrinter | null;
  reader: RfidReader;
};

const STORAGE_KEY = "berzerk_devices_v1";

const DEFAULT_CONFIG: DeviceConfig = {
  printer: null,
  reader: {
    name: "Mesa RFID",
    itagHost: "http://localhost:9093",
    mode: "itag-rest",
  },
};

export function getDeviceConfig(): DeviceConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_CONFIG;
    const parsed = JSON.parse(raw) as Partial<DeviceConfig>;
    return {
      printer: parsePrinter(parsed.printer),
      reader: parseReader(parsed.reader),
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function setDeviceConfig(config: DeviceConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* ignore quota errors */
  }
}

export function setPrinter(printer: ThermalPrinter | null): void {
  setDeviceConfig({ ...getDeviceConfig(), printer });
}

export function setReader(reader: RfidReader): void {
  setDeviceConfig({ ...getDeviceConfig(), reader });
}

function parsePrinter(p: unknown): ThermalPrinter | null {
  if (!p || typeof p !== "object") return null;
  const obj = p as Partial<ThermalPrinter>;
  if (!obj.name || !obj.deviceId) return null;
  const model: ThermalPrinter["model"] =
    obj.model === "elgin-l42dt" ||
    obj.model === "generic-escpos" ||
    obj.model === "zpl"
      ? obj.model
      : "unknown";
  return { name: obj.name, deviceId: obj.deviceId, model };
}

function parseReader(r: unknown): RfidReader {
  if (!r || typeof r !== "object") return DEFAULT_CONFIG.reader;
  const obj = r as Partial<RfidReader>;
  // Qualquer config legada (ws/proxy/serial) cai pro WCF REST do iTAG Monitor.
  const mode: RfidReader["mode"] =
    obj.mode === "keyboard-wedge" ? "keyboard-wedge" : "itag-rest";
  return {
    name: obj.name || DEFAULT_CONFIG.reader.name,
    itagHost: obj.itagHost || DEFAULT_CONFIG.reader.itagHost,
    mode,
  };
}

export const PRINTER_MODELS: Array<{ value: ThermalPrinter["model"]; label: string }> = [
  { value: "elgin-l42dt", label: "Elgin L42DT" },
  { value: "generic-escpos", label: "Genérica ESC/POS" },
  { value: "zpl", label: "Genérica ZPL (Zebra)" },
  { value: "unknown", label: "Desconhecido / outra" },
];

export const READER_MODES: Array<{
  value: RfidReader["mode"];
  label: string;
  description: string;
  available: boolean;
}> = [
  {
    value: "itag-rest",
    label: "Via iTAG Monitor (WCF REST)",
    description:
      "Comanda o serviço WCF REST do iTAG Monitor (porta 9093) — o modo que o Monitor executa na fábrica (doc oficial iTAG)",
    available: true,
  },
  {
    value: "keyboard-wedge",
    label: "Teclado (keyboard wedge)",
    description:
      "O leitor digita o EPC como um teclado USB (ACURA AC01v2 e similares) — plug and play, sem driver",
    available: true,
  },
];

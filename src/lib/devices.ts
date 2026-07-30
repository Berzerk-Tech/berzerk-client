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
  /** Host do iTAG Monitor (default localhost:9093). Quando matarmos o proxy HTTPS,
   *  é aqui que apontamos direto. */
  itagHost: string;
  /** Modo de operação atual. HTTP/proxy e serial direto foram aposentados
   *  (2026-07-30): leitura é via WebSocket do iTAG (Cykeo) ou teclado (ACURA).
   *  Config antiga salva com outro modo é coagida pra `itag-ws` no parse. */
  mode: "keyboard-wedge" | "itag-ws";
  /** Host do proxy HTTPS (legado, default 127.0.0.1:3443). Só usado se mode = via-proxy. */
  proxyHost: string;
  /** URL do WebSocket Server do iTAG Monitor (porta 9098) — mesmo caminho que o
   *  pós-venda usa pra receber leituras em tempo real. Só usado se mode = itag-ws. */
  wsUrl: string;
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
    // Proxy aposentado. Default fala direto com o iTAG Monitor (HTTP local);
    // "direct-usb" é o alvo (serial USB sem middleware) — ver protocolo.
    mode: "itag-ws",
    proxyHost: "https://127.0.0.1:3443",
    wsUrl: "ws://localhost:9098",
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
  // Proxy aposentado: qualquer config legada cai pro iTAG Monitor direto.
  const mode: RfidReader["mode"] =
    obj.mode === "keyboard-wedge" ? "keyboard-wedge" : "itag-ws";
  return {
    name: obj.name || DEFAULT_CONFIG.reader.name,
    itagHost: obj.itagHost || DEFAULT_CONFIG.reader.itagHost,
    mode,
    proxyHost: obj.proxyHost || DEFAULT_CONFIG.reader.proxyHost,
    wsUrl: obj.wsUrl || DEFAULT_CONFIG.reader.wsUrl,
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
    value: "itag-ws",
    label: "Via iTAG WebSocket",
    description:
      "Escuta o WebSocket Server do iTAG Monitor (porta 9098) — o mesmo caminho de leitura do pós-venda",
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

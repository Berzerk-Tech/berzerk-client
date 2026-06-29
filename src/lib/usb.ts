// Listagem de dispositivos USB que aparecem como porta serial.
// Cobre impressoras térmicas modernas (Elgin, Bematech, Daruma, Epson, Zebra ZD…)
// e leitores RFID com saída serial. NÃO cobre HID-as-keyboard (que digita o
// EPC no input focado — esses não precisam de "porta" porque entram como teclado).

import { invoke } from "@tauri-apps/api/core";

export type SerialKind = "usb" | "bluetooth" | "pci" | "unknown";

export type SerialPortInfo = {
  name: string;
  kind: SerialKind;
  vid: string | null;
  pid: string | null;
  product: string | null;
  manufacturer: string | null;
  serial_number: string | null;
};

/**
 * Lista todas as portas seriais (COM no Windows, ttyUSB/ttyACM no Linux)
 * disponíveis. Inclui USB, Bluetooth e PCI. Pra impressoras térmicas modernas,
 * USB é o que importa.
 */
export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  return invoke<SerialPortInfo[]>("list_serial_ports");
}

export type SniffResult = {
  port: string;
  baud: number;
  byte_count: number;
  hex: string;
  text: string;
  lines: string[];
};

/** Abre a porta serial no baud dado e captura `ms` ms de bytes crus da mesa. */
export async function serialSniff(port: string, baud: number, ms: number): Promise<SniffResult> {
  return invoke<SniffResult>("serial_sniff", { port, baud, ms });
}

/** Bauds comuns em leitores RFID UHF seriais. */
export const COMMON_BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

/**
 * Constrói um label legível pro device baseado nos campos disponíveis.
 * "Elgin L42DT (COM3)" — manufacturer + product preenchidos
 * "USB 0483:5740 (COM3)" — só temos vid:pid
 * "Porta serial sem identificação USB (COM3)" — sem nenhuma info útil
 */
export function describePort(port: SerialPortInfo): string {
  const parts: string[] = [];
  if (port.manufacturer) parts.push(port.manufacturer);
  if (port.product) parts.push(port.product);
  if (parts.length === 0 && port.vid && port.pid) {
    parts.push(`USB ${port.vid}:${port.pid}`);
  }
  if (parts.length === 0) {
    if (port.kind === "bluetooth") parts.push("Porta Bluetooth");
    else if (port.kind === "pci") parts.push("Porta serial PCI");
    else parts.push("Porta serial sem identificação USB");
  }
  return `${parts.join(" ")} (${port.name})`;
}

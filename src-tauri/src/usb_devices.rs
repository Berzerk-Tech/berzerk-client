// Listagem de dispositivos USB que aparecem como porta serial (COM no Windows,
// /dev/ttyUSB* / /dev/ttyACM* no Linux). Impressoras térmicas USB modernas
// expõem CDC-ACM serial — Elgin L42DT, Bematech, Daruma, Epson, Zebra ZD…
// todas funcionam assim, idem leitores RFID que falam ESC/POS-ish.
//
// Limitação: dispositivos que aparecem como HID puro (alguns leitores RFID
// que emulam teclado) não vão aparecer aqui. Pra esses, o caminho é o
// próprio usuário deixar foco no input — o leitor "digita" o EPC.

use serde::Serialize;

#[derive(Serialize, Debug, Clone)]
pub struct SerialPortInfo {
    /// Nome do dispositivo (COM3 no Windows, /dev/ttyUSB0 no Linux)
    pub name: String,
    /// Categoria do dispositivo
    pub kind: SerialKind,
    /// Vendor ID em hex (4 chars) — só pra USB
    pub vid: Option<String>,
    /// Product ID em hex (4 chars) — só pra USB
    pub pid: Option<String>,
    /// Nome do produto reportado pelo USB descriptor (pode ser vazio)
    pub product: Option<String>,
    /// Nome do fabricante reportado pelo USB descriptor
    pub manufacturer: Option<String>,
    /// Serial number — útil pra distinguir 2 impressoras iguais
    pub serial_number: Option<String>,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum SerialKind {
    Usb,
    Bluetooth,
    Pci,
    Unknown,
}

/// `/dev/ttyS0`, `/dev/ttyS1`… são as UARTs legadas da placa-mãe (8250/16550),
/// não USB — a máquina expõe dezenas delas sempre. Não são impressora/leitor,
/// então não entram na lista. O dispositivo USB real é `ttyUSB*`/`ttyACM*` (ou
/// COM no Windows).
fn is_legacy_serial(name: &str) -> bool {
    match name.strip_prefix("/dev/ttyS") {
        Some(rest) => !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()),
        None => false,
    }
}

#[tauri::command]
pub fn list_serial_ports() -> Result<Vec<SerialPortInfo>, String> {
    let ports = serialport::available_ports().map_err(|e| e.to_string())?;
    let mapped: Vec<SerialPortInfo> = ports
        .into_iter()
        .filter(|p| !is_legacy_serial(&p.port_name))
        .map(|p| {
            use serialport::SerialPortType;
            match p.port_type {
                SerialPortType::UsbPort(info) => SerialPortInfo {
                    name: p.port_name,
                    kind: SerialKind::Usb,
                    vid: Some(format!("{:04x}", info.vid)),
                    pid: Some(format!("{:04x}", info.pid)),
                    product: info.product,
                    manufacturer: info.manufacturer,
                    serial_number: info.serial_number,
                },
                SerialPortType::BluetoothPort => SerialPortInfo {
                    name: p.port_name,
                    kind: SerialKind::Bluetooth,
                    vid: None,
                    pid: None,
                    product: None,
                    manufacturer: None,
                    serial_number: None,
                },
                SerialPortType::PciPort => SerialPortInfo {
                    name: p.port_name,
                    kind: SerialKind::Pci,
                    vid: None,
                    pid: None,
                    product: None,
                    manufacturer: None,
                    serial_number: None,
                },
                SerialPortType::Unknown => {
                    // Em Linux o serialport v4 não popula USB descriptor pra
                    // /dev/ttyUSB* nem /dev/ttyACM* — cai como Unknown sempre.
                    // Tenta enriquecer via sysfs antes de desistir.
                    if let Some(info) = enrich_linux_usb(&p.port_name) {
                        SerialPortInfo {
                            name: p.port_name,
                            kind: SerialKind::Usb,
                            vid: Some(info.vid),
                            pid: Some(info.pid),
                            product: info.product,
                            manufacturer: info.manufacturer,
                            serial_number: info.serial_number,
                        }
                    } else {
                        SerialPortInfo {
                            name: p.port_name,
                            kind: SerialKind::Unknown,
                            vid: None,
                            pid: None,
                            product: None,
                            manufacturer: None,
                            serial_number: None,
                        }
                    }
                }
            }
        })
        .collect();
    Ok(mapped)
}

struct LinuxUsbInfo {
    vid: String,
    pid: String,
    product: Option<String>,
    manufacturer: Option<String>,
    serial_number: Option<String>,
}

#[cfg(target_os = "linux")]
fn enrich_linux_usb(port_name: &str) -> Option<LinuxUsbInfo> {
    use std::fs;
    use std::path::{Path, PathBuf};

    // /dev/ttyUSB0 → "ttyUSB0"
    let basename = Path::new(port_name).file_name()?.to_str()?;
    let tty_path = PathBuf::from(format!("/sys/class/tty/{}/device", basename));

    // Resolve symlinks. O /device aponta pra interface USB; precisamos subir
    // até o nó pai que carrega idVendor/idProduct (o USB device em si).
    let resolved = fs::canonicalize(&tty_path).ok()?;
    let mut cur: &Path = resolved.as_path();
    for _ in 0..6 {
        if cur.join("idVendor").is_file() && cur.join("idProduct").is_file() {
            let vid = fs::read_to_string(cur.join("idVendor")).ok()?;
            let pid = fs::read_to_string(cur.join("idProduct")).ok()?;
            let product = fs::read_to_string(cur.join("product"))
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let manufacturer = fs::read_to_string(cur.join("manufacturer"))
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let serial_number = fs::read_to_string(cur.join("serial"))
                .ok()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            return Some(LinuxUsbInfo {
                vid: vid.trim().to_lowercase(),
                pid: pid.trim().to_lowercase(),
                product,
                manufacturer,
                serial_number,
            });
        }
        cur = cur.parent()?;
    }
    None
}

#[cfg(not(target_os = "linux"))]
fn enrich_linux_usb(_port_name: &str) -> Option<LinuxUsbInfo> {
    None
}

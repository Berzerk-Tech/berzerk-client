// Leitura direta da mesa RFID via porta serial USB (sem iTAG Monitor).
//
// Primeiro passo: um SNIFFER. A mesa fala um protocolo serial que ainda não
// conhecemos — então abrimos a porta no baud escolhido, capturamos os bytes
// crus por uma janela de tempo e devolvemos hex + texto + linhas. Com isso
// descobrimos o formato real (auto-stream de EPCs? frames binários? precisa de
// comando?) e escrevemos o parser certo.

use serde::Serialize;
use std::io::Read;
use std::time::{Duration, Instant};

#[derive(Serialize)]
pub struct SniffResult {
    pub port: String,
    pub baud: u32,
    pub byte_count: usize,
    /// Bytes em hex separados por espaço (ex.: "e2 00 17 ..").
    pub hex: String,
    /// Decodificação UTF-8 lossy (pra readers que mandam ASCII).
    pub text: String,
    /// `text` quebrado por \r\n / \n (linhas não vazias).
    pub lines: Vec<String>,
}

/// Captura `ms` milissegundos de dados crus da porta serial.
#[tauri::command]
pub fn serial_sniff(port: String, baud: u32, ms: u64) -> Result<SniffResult, String> {
    let mut sp = serialport::new(&port, baud)
        .timeout(Duration::from_millis(200))
        .open()
        .map_err(|e| format!("falha ao abrir {} @ {} baud: {}", port, baud, e))?;

    let window = Duration::from_millis(ms.clamp(200, 15_000));
    let deadline = Instant::now() + window;
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];

    while Instant::now() < deadline {
        match sp.read(&mut chunk) {
            Ok(0) => {}
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(e) => return Err(format!("erro de leitura em {}: {}", port, e)),
        }
        // trava de segurança: não estourar memória se a mesa despejar muito
        if buf.len() > 1_000_000 {
            break;
        }
    }

    let hex = buf
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect::<Vec<_>>()
        .join(" ");
    let text = String::from_utf8_lossy(&buf).to_string();
    let lines: Vec<String> = text
        .split(['\r', '\n'])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();

    Ok(SniffResult {
        port,
        baud,
        byte_count: buf.len(),
        hex,
        text,
        lines,
    })
}

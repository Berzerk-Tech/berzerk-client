// Cliente Rust pro iTAG Monitor — substitui o rfid-proxy.exe que os webapps
// (industrial/posvenda) precisavam por causa do mixed-content do browser.
//
// Em Tauri, como rodamos código nativo, podemos bater HTTP plain em
// http://127.0.0.1:9093 sem proxy HTTPS no meio. O frontend chama via
// `invoke(...)`, não direto com fetch().
//
// Endpoints expostos pelo iTAG Monitor (doc "Fluxo padrão de integração V1.2",
// modo "Monitor Web Service WCF" — o que roda na fábrica):
//   GET /ItagRFIDMonitor/CarregaComando?comando=iniciar       — start continuous
//   GET /ItagRFIDMonitor/CarregaComando?comando=parar          — stop
//   GET /ItagRFIDMonitor/CarregaComando?comando=limparLeitura  — clear buffer
//   GET /ItagRFIDMonitor/RetornaTag                            — read accumulated
//   GET /ItagRFIDMonitor/RetornaStatus                         — parado/iniciado
//   GET /ItagRFIDMonitor/RetornaTime                           — tempo de leitura

use reqwest::Client;
use serde::Serialize;
use std::time::Duration;

const DEFAULT_HOST: &str = "http://127.0.0.1:9093";
const REQUEST_TIMEOUT_SECS: u64 = 8;

#[derive(Serialize)]
pub struct ConnectionStatus {
    pub ok: bool,
    pub host: String,
    pub message: Option<String>,
}

#[derive(Serialize)]
pub struct PollResult {
    pub tags: Vec<String>,
    pub raw_preview: String,
}

fn build_client() -> reqwest::Result<Client> {
    Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        // iTAG Monitor é HTTP (não TLS) — não precisa de cert verify
        .build()
}

fn resolve_host(host: Option<String>) -> String {
    host.unwrap_or_else(|| DEFAULT_HOST.to_string())
}

#[tauri::command]
pub async fn itag_ping(host: Option<String>) -> ConnectionStatus {
    let h = resolve_host(host);
    // RetornaStatus: healthcheck sem efeito colateral (não toca a lista de tags
    // nem dispara o overlay "Aguarde!" do iTAG — esse só aparece no `iniciar`).
    let url = format!("{}/ItagRFIDMonitor/RetornaStatus", h);
    let client = match build_client() {
        Ok(c) => c,
        Err(e) => {
            return ConnectionStatus {
                ok: false,
                host: h,
                message: Some(format!("falha ao criar client HTTP: {}", e)),
            }
        }
    };

    match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => ConnectionStatus {
            ok: true,
            host: h,
            message: Some(format!("HTTP {}", resp.status().as_u16())),
        },
        Ok(resp) => ConnectionStatus {
            ok: false,
            host: h,
            message: Some(format!("HTTP {}", resp.status().as_u16())),
        },
        Err(e) => ConnectionStatus {
            ok: false,
            host: h,
            message: Some(format!("conexão falhou: {}", e)),
        },
    }
}

#[tauri::command]
pub async fn itag_send_command(comando: String, host: Option<String>) -> Result<(), String> {
    let h = resolve_host(host);
    let url = format!("{}/ItagRFIDMonitor/CarregaComando?comando={}", h, comando);
    let client = build_client().map_err(|e| e.to_string())?;
    client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("requisição falhou: {}", e))?;
    Ok(())
}

#[tauri::command]
pub async fn itag_poll_tags(host: Option<String>) -> Result<PollResult, String> {
    let h = resolve_host(host);
    let url = format!("{}/ItagRFIDMonitor/RetornaTag", h);
    let client = build_client().map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("requisição falhou: {}", e))?;
    let text = resp
        .text()
        .await
        .map_err(|e| format!("leitura corpo falhou: {}", e))?;

    let tags = parse_tags(&text);
    let raw_preview = if text.len() > 200 {
        format!("{}…", &text[..200])
    } else {
        text
    };
    Ok(PollResult { tags, raw_preview })
}

/// Re-inventory: para → limpa buffer → reinicia. Padrão pra detectar tags
/// removidas (o iTAG Monitor só acumula, não tem "diff").
#[tauri::command]
pub async fn itag_reinventory(host: Option<String>) -> Result<(), String> {
    itag_send_command("parar".to_string(), host.clone()).await?;
    // pequena pausa pra iTAG processar o stop
    tokio::time::sleep(Duration::from_millis(150)).await;
    itag_send_command("limparLeitura".to_string(), host.clone()).await?;
    tokio::time::sleep(Duration::from_millis(150)).await;
    itag_send_command("iniciar".to_string(), host).await?;
    Ok(())
}

fn parse_tags(text: &str) -> Vec<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return vec![];
    }

    // Tentativa 1: JSON array de strings
    if let Ok(arr) = serde_json::from_str::<Vec<String>>(trimmed) {
        return arr.into_iter().filter(|s| !s.is_empty()).collect();
    }

    // Tentativa 2: JSON objeto com campo "tags"
    if let Ok(obj) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if let Some(arr) = obj.get("tags").and_then(|v| v.as_array()) {
            return arr
                .iter()
                .filter_map(|v| v.as_str().map(String::from))
                .filter(|s| !s.is_empty())
                .collect();
        }
    }

    // Tentativa 3: texto plano separado por whitespace/vírgula, mantém só hex
    trimmed
        .split(|c: char| c.is_whitespace() || c == ',' || c == ';' || c == '\n' || c == '\r')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_hexdigit()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_json_array() {
        let tags = parse_tags(r#"["AABBCC", "112233"]"#);
        assert_eq!(tags, vec!["AABBCC", "112233"]);
    }

    #[test]
    fn parse_json_object() {
        let tags = parse_tags(r#"{"tags":["AABBCC"]}"#);
        assert_eq!(tags, vec!["AABBCC"]);
    }

    #[test]
    fn parse_plain_hex_lines() {
        let tags = parse_tags("AABBCC\n112233\nFFFFFF");
        assert_eq!(tags, vec!["AABBCC", "112233", "FFFFFF"]);
    }

    #[test]
    fn parse_empty() {
        assert!(parse_tags("").is_empty());
        assert!(parse_tags("   ").is_empty());
    }

    #[test]
    fn parse_ignores_non_hex_lines() {
        let tags = parse_tags("AABBCC\nfoo bar\n112233");
        assert_eq!(tags, vec!["AABBCC", "112233"]);
    }
}

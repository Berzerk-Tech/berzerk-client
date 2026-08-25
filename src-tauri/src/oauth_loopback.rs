// Loopback HTTP server pra capturar o callback OAuth do Cognito (Nexus).
//
// Por que existe: Chrome 120+ bloqueia silenciosamente redirects automáticos
// pra custom schemes (berzerk-print://...) sem user gesture imediato. O fluxo
// Google → Cognito → app é redirect, sem gesture, então o Chrome cancela.
//
// Loopback HTTP em 127.0.0.1:54321 é tratado como URL HTTP normal por Chrome,
// que entrega no servidor local sem bloquear. O servidor lê os query params
// (code, state) e emite o evento `oauth-callback-url` pra o front processar.
// A mesma rota é o pouso do `/logout` do Hosted UI (aí vem sem query).

use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tiny_http::{Header, Response, Server};

const PORT: u16 = 54321;
const TIMEOUT_SECS: u64 = 300;

// Mantém o server vivo enquanto a thread roda — guard impede starts duplicados.
static SERVER_RUNNING: Mutex<bool> = Mutex::new(false);

#[tauri::command]
pub fn start_oauth_listener(app: AppHandle) -> Result<String, String> {
    {
        let mut running = SERVER_RUNNING.lock().map_err(|e| e.to_string())?;
        if *running {
            // Já tem um listener ativo de uma tentativa anterior — apenas reusa a URL.
            return Ok(callback_url());
        }
        *running = true;
    }

    let server = Server::http(format!("127.0.0.1:{}", PORT))
        .map_err(|e| format!("não consegui bindar 127.0.0.1:{}: {}", PORT, e))?;

    let server = Arc::new(server);
    let app_for_thread = app.clone();

    thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(TIMEOUT_SECS);
        let result = loop {
            if Instant::now() > deadline {
                break Err("timeout aguardando callback OAuth".to_string());
            }
            match server.try_recv() {
                Ok(Some(req)) => break Ok(req),
                Ok(None) => thread::sleep(Duration::from_millis(50)),
                Err(e) => break Err(format!("server.try_recv falhou: {}", e)),
            }
        };

        match result {
            Ok(req) => {
                let url = req.url().to_string();
                eprintln!("[oauth-loopback] recebido: {}", url);

                let html = include_str!("./oauth_loopback_response.html");
                let response = Response::from_string(html).with_header(
                    "Content-Type: text/html; charset=utf-8"
                        .parse::<Header>()
                        .unwrap(),
                );
                let _ = req.respond(response);

                let _ = app_for_thread.emit("oauth-callback-url", url);
            }
            Err(err) => {
                eprintln!("[oauth-loopback] {}", err);
                let _ = app_for_thread.emit("oauth-callback-error", err);
            }
        }

        if let Ok(mut running) = SERVER_RUNNING.lock() {
            *running = false;
        }
    });

    Ok(callback_url())
}

fn callback_url() -> String {
    format!("http://127.0.0.1:{}/oauth-callback", PORT)
}

mod itag_client;
mod itag_iprint;
mod oauth_loopback;
mod printing;
mod rfid_usb;
mod usb_devices;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single-instance PRIMEIRO na cadeia (doc oficial do Tauri): se já tem uma
        // instância rodando, essa aqui precisa desistir o quanto antes, sem gastar
        // tempo inicializando os outros plugins. Com a feature `deep-link`, o
        // callback abaixo já repassa a URL da segunda instância pro plugin
        // deep-link (que reemite `deep-link://new-url` pro front ouvir via
        // `onOpenUrl`) — só falta focar a janela, que o plugin não faz sozinho.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            focus_main_window(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            // Registro em runtime cobre dois casos que o instalador não cobre
            // sozinho: AppImage não integrado ao desktop (Linux) e `tauri dev`
            // (Windows) — em produção Windows o instalador NSIS já registra o
            // protocolo, então chamar de novo aqui é redundante mas inofensivo.
            #[cfg(any(target_os = "linux", windows))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(err) = app.deep_link().register_all() {
                    eprintln!("[deep-link] falha ao registrar esquema: {err}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            oauth_loopback::start_oauth_listener,
            itag_client::itag_ping,
            itag_client::itag_send_command,
            itag_client::itag_poll_tags,
            itag_client::itag_reinventory,
            itag_iprint::itag_iprint_ping,
            itag_iprint::itag_iprint_gerar_rfid,
            itag_iprint::itag_iprint_query_inventory,
            itag_iprint::itag_iprint_movimentar,
            itag_iprint::itag_epc_details,
            usb_devices::list_serial_ports,
            rfid_usb::serial_sniff,
            printing::print_pdf_silent,
            printing::print_image_silent,
            printing::list_windows_printers,
            printing::print_engine_status,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Traz a janela principal pra frente — chamado quando uma segunda instância
/// é aberta (com ou sem deep link junto) via `berzerk://open` ou `berzerk://auth`.
fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

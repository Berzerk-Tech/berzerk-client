mod itag_client;
mod itag_iprint;
mod oauth_loopback;
mod rfid_usb;
mod usb_devices;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
            usb_devices::list_serial_ports,
            rfid_usb::serial_sniff,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

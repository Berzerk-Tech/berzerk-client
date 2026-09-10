// Preferência "desativar aceleração de hardware" (GPU) por estação.
//
// O WebView2 precisa receber `--disable-gpu` ANTES de subir, então essa
// preferência não pode viver em localStorage (front só carrega depois que o
// WebView2 já inicializou). A fonte da verdade é um arquivo JSON no diretório
// de config do app — lido no Rust, antes do `tauri::Builder`, e também
// exposto ao front via commands pra tela de Configurações.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
struct GpuPrefs {
    #[serde(rename = "disableHardwareAcceleration")]
    disable_hardware_acceleration: bool,
}

/// Caminho de `gpu.json` dentro do diretório de config do app
/// (`dirs::config_dir()/<identifier>`, que no Windows é `%APPDATA%\<identifier>`).
///
/// Função única usada tanto na leitura de boot (sem `AppHandle` disponível
/// ainda) quanto nos commands — garante que os dois lados apontam pro mesmo
/// arquivo.
pub fn config_path(identifier: &str) -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join(identifier).join("gpu.json"))
}

/// Lê a preferência do disco. `false` (aceleração de hardware ligada, o
/// padrão) se o arquivo não existe, não pode ser lido ou está inválido —
/// nunca panica.
pub fn read(identifier: &str) -> bool {
    let Some(path) = config_path(identifier) else {
        return false;
    };
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false;
    };
    serde_json::from_str::<GpuPrefs>(&raw)
        .map(|prefs| prefs.disable_hardware_acceleration)
        .unwrap_or(false)
}

/// Grava a preferência no disco, criando o diretório de config se preciso.
pub fn write(identifier: &str, disabled: bool) -> Result<(), String> {
    let path = config_path(identifier)
        .ok_or_else(|| "não foi possível resolver o diretório de config do app".to_string())?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let prefs = GpuPrefs {
        disable_hardware_acceleration: disabled,
    };
    let raw = serde_json::to_string_pretty(&prefs).map_err(|e| e.to_string())?;
    std::fs::write(path, raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn gpu_get_disabled(app: tauri::AppHandle) -> bool {
    read(&app.config().identifier)
}

#[tauri::command]
pub fn gpu_set_disabled(app: tauri::AppHandle, disabled: bool) -> Result<(), String> {
    write(&app.config().identifier, disabled)
}

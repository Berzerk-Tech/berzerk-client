// Impressão SILENCIOSA no Windows — o operador nunca vê diálogo.
//
// Usa o SumatraPDF (portátil, ~6 MB) em modo linha de comando:
//   SumatraPDF.exe -silent -print-to-default <arquivo>
//   SumatraPDF.exe -silent -print-to "<impressora>" <arquivo>
// Imprime PDF e PNG. É o caminho robusto e 100% silencioso pro chão de fábrica
// (mesma abordagem usada em setups de etiqueta/POS).
//
// Onde o binário é procurado (primeiro que existir):
//   1. variável de ambiente BERZERK_SUMATRA_PATH (dev)
//   2. resource_dir do bundle (produção — ver bundle.resources no tauri.conf.json)
//   3. pasta do próprio executável
// Se não achar, os comandos devolvem ok=false com mensagem — o app mostra o erro
// de impressora e NÃO expede (a etiqueta J&T é pré-requisito).

use std::path::PathBuf;
use std::process::Command;

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
pub struct PrintOutcome {
    ok: bool,
    printer: Option<String>,
    message: Option<String>,
    engine: String,
}

#[derive(Serialize)]
pub struct PrintEngineStatus {
    ok: bool,
    path: Option<String>,
    message: Option<String>,
}

/// Evita o flash de janela de console no Windows (app é kiosk).
#[cfg(windows)]
fn no_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}
#[cfg(not(windows))]
fn no_window(_cmd: &mut Command) {}

const SUMATRA_NAMES: &[&str] = &["SumatraPDF.exe", "SumatraPDF-3.5.2-64.exe", "SumatraPDF"];

fn resolve_sumatra(app: &AppHandle) -> Option<PathBuf> {
    // 1) env override (dev)
    if let Ok(p) = std::env::var("BERZERK_SUMATRA_PATH") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    // 1b) DEV: no `tauri dev` o cwd é a pasta src-tauri (ou a raiz do projeto),
    // então o SumatraPDF.exe colocado em src-tauri/resources/ é achado aqui —
    // no dev o resource_dir aponta pra target/debug e não pra src-tauri.
    if let Ok(cwd) = std::env::current_dir() {
        for rel in ["resources", "src-tauri/resources"] {
            for n in SUMATRA_NAMES {
                let pb = cwd.join(rel).join(n);
                if pb.is_file() {
                    return Some(pb);
                }
            }
        }
    }
    // 2) resource dir (bundle)
    if let Ok(res) = app.path().resource_dir() {
        for sub in ["", "resources", "bin"] {
            for n in SUMATRA_NAMES {
                let pb = if sub.is_empty() {
                    res.join(n)
                } else {
                    res.join(sub).join(n)
                };
                if pb.is_file() {
                    return Some(pb);
                }
            }
        }
    }
    // 3) ao lado do executável
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for n in SUMATRA_NAMES {
                let pb = dir.join(n);
                if pb.is_file() {
                    return Some(pb);
                }
            }
        }
    }
    None
}

fn decode_b64(s: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|e| format!("base64 inválido: {e}"))
}

fn write_temp(bytes: &[u8], ext: &str) -> Result<PathBuf, String> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    let mut path = std::env::temp_dir();
    path.push(format!("berzerk_print_{pid}_{nanos}.{ext}"));
    std::fs::write(&path, bytes).map_err(|e| format!("falha ao gravar temp: {e}"))?;
    Ok(path)
}

fn do_print(
    app: &AppHandle,
    bytes: Vec<u8>,
    ext: &str,
    printer: Option<String>,
    _job: Option<String>,
) -> PrintOutcome {
    let sumatra = match resolve_sumatra(app) {
        Some(p) => p,
        None => {
            return PrintOutcome {
                ok: false,
                printer,
                message: Some(
                    "SumatraPDF não encontrado. Coloque SumatraPDF.exe em \
                     src-tauri/resources/ (vai junto no bundle) ou defina a \
                     variável de ambiente BERZERK_SUMATRA_PATH."
                        .into(),
                ),
                engine: "sumatra".into(),
            }
        }
    };

    let file = match write_temp(&bytes, ext) {
        Ok(f) => f,
        Err(e) => {
            return PrintOutcome {
                ok: false,
                printer,
                message: Some(e),
                engine: "sumatra".into(),
            }
        }
    };

    let mut cmd = Command::new(&sumatra);
    cmd.arg("-silent");
    match printer.as_deref() {
        Some(name) if !name.trim().is_empty() => {
            cmd.arg("-print-to").arg(name);
        }
        _ => {
            cmd.arg("-print-to-default");
        }
    }
    cmd.arg(&file);
    no_window(&mut cmd);

    // status() espera o SumatraPDF terminar de enfileirar antes de retornar,
    // então é seguro apagar o temp logo em seguida.
    let res = cmd.status();
    let _ = std::fs::remove_file(&file);

    match res {
        Ok(st) if st.success() => PrintOutcome {
            ok: true,
            printer,
            message: None,
            engine: "sumatra".into(),
        },
        Ok(st) => PrintOutcome {
            ok: false,
            printer,
            message: Some(format!("SumatraPDF saiu com código {:?}", st.code())),
            engine: "sumatra".into(),
        },
        Err(e) => PrintOutcome {
            ok: false,
            printer,
            message: Some(format!("falha ao executar SumatraPDF: {e}")),
            engine: "sumatra".into(),
        },
    }
}

#[tauri::command]
pub async fn print_pdf_silent(
    app: AppHandle,
    base64: String,
    printer: Option<String>,
    job_name: Option<String>,
) -> Result<PrintOutcome, String> {
    let bytes = decode_b64(&base64)?;
    tokio::task::spawn_blocking(move || do_print(&app, bytes, "pdf", printer, job_name))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn print_image_silent(
    app: AppHandle,
    base64: String,
    printer: Option<String>,
    job_name: Option<String>,
) -> Result<PrintOutcome, String> {
    let bytes = decode_b64(&base64)?;
    tokio::task::spawn_blocking(move || do_print(&app, bytes, "png", printer, job_name))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_windows_printers() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(|| {
        #[cfg(windows)]
        {
            let mut cmd = Command::new("powershell");
            cmd.args([
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_Printer | Select-Object -ExpandProperty Name",
            ]);
            no_window(&mut cmd);
            match cmd.output() {
                Ok(o) => String::from_utf8_lossy(&o.stdout)
                    .lines()
                    .map(|l| l.trim().to_string())
                    .filter(|l| !l.is_empty())
                    .collect(),
                Err(_) => Vec::new(),
            }
        }
        #[cfg(not(windows))]
        {
            Vec::<String>::new()
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn print_engine_status(app: AppHandle) -> Result<PrintEngineStatus, String> {
    let path = tokio::task::spawn_blocking(move || resolve_sumatra(&app))
        .await
        .map_err(|e| e.to_string())?;
    Ok(match path {
        Some(p) => PrintEngineStatus {
            ok: true,
            path: Some(p.to_string_lossy().into_owned()),
            message: None,
        },
        None => PrintEngineStatus {
            ok: false,
            path: None,
            message: Some(
                "SumatraPDF não encontrado. Coloque SumatraPDF.exe em \
                 src-tauri/resources/ ou defina BERZERK_SUMATRA_PATH."
                    .into(),
            ),
        },
    })
}

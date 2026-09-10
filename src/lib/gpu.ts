// Preferência "desativar aceleração de hardware" (GPU) por estação.
//
// A fonte da verdade é um arquivo JSON lido pelo backend Rust (gpu.json no
// diretório de config do app) — não localStorage. O `--disable-gpu` só surte
// efeito depois de reiniciar o app, porque precisa ser aplicado antes do
// WebView2 subir. Ver src-tauri/src/gpu_prefs.rs.

import { invoke } from "@tauri-apps/api/core";

/** `false` se o invoke falhar (ex: `bun run dev` sem o shell Tauri). */
export async function getGpuDisabled(): Promise<boolean> {
  try {
    return await invoke<boolean>("gpu_get_disabled");
  } catch {
    return false;
  }
}

export async function setGpuDisabled(disabled: boolean): Promise<void> {
  await invoke("gpu_set_disabled", { disabled });
}

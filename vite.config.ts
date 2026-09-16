import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/**
 * Proxy de dev: o webview do `tauri dev` roda em `http://localhost:1420`, e o
 * API Gateway do nexus (prod) só libera `tauri.localhost` no CORS — por
 * decisão de auditoria (berzerk-infra, nexus/prod/api.tf). Sem proxy o
 * preflight volta sem Allow-Origin, o fetch morre com TypeError e a fila
 * aparece zerada. Em dev o app fala com o próprio Vite (`.env.development`
 * aponta `VITE_SEPARACAO_*` pra `localhost:1420/{api,ws}`) e o Vite repassa
 * pro alvo em `DEV_PROXY_API_TARGET` / `DEV_PROXY_WS_TARGET` — same-origin,
 * zero CORS. `Origin` sai do pedido repassado: o nexus só decide cabeçalho
 * CORS por ele, e o alvo não precisa saber de onde veio.
 */
function proxyTo(prefixo: string, alvo: string | undefined, ws = false): ProxyOptions | null {
  if (!alvo) return null;
  const url = new URL(alvo);
  const caminho = url.pathname.replace(/\/$/, "");
  return {
    target: url.origin,
    changeOrigin: true,
    ws,
    rewrite: (p) => p.replace(new RegExp(`^${prefixo}`), caminho),
    configure: (proxy) => {
      proxy.on("proxyReq", (req) => req.removeHeader("origin"));
      proxy.on("proxyReqWs", (req) => req.removeHeader("origin"));
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => {
  // @ts-expect-error process is a nodejs global
  const env = loadEnv(mode, process.cwd(), "");
  const proxy: Record<string, ProxyOptions> = {};
  const api = proxyTo("/api", env.DEV_PROXY_API_TARGET);
  const ws = proxyTo("/ws", env.DEV_PROXY_WS_TARGET, true);
  if (api) proxy["/api"] = api;
  if (ws) proxy["/ws"] = ws;

  return {
    plugins: [react()],

    // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
    //
    // 1. prevent Vite from obscuring rust errors
    clearScreen: false,
    // 2. tauri expects a fixed port, fail if that port is not available
    server: {
      port: 1420,
      strictPort: true,
      host: host || false,
      hmr: host
        ? {
            protocol: "ws",
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        // 3. tell Vite to ignore watching `src-tauri`
        ignored: ["**/src-tauri/**"],
      },
      proxy,
    },
  };
});

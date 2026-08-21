// Vigia de inatividade — montado só com sessão ativa (ver App). Lê o timeout
// do nexus (`/separacao/me → sessaoInatividadeMinutos`), conta tecla/mouse/leitura RFID
// como atividade e derruba a sessão quando estoura. Sem timeout configurado
// (ou API fora no boot) não faz nada — fail-open, igual ao gating da home.
import { useEffect } from "react";
import { forceLogout, lastActivityAt, touchActivity } from "../lib/idleSession";
import { getMe } from "../services/orders";

/** Relê a config de vez em quando — admin mudou o tempo, vale sem relogar. */
const CONFIG_REFRESH_MS = 5 * 60_000;
/** Intervalo curto + comparação por timestamp: aguenta sleep/atraso de timer. */
const CHECK_MS = 5_000;
const ACTIVITY_EVENTS: (keyof WindowEventMap)[] = [
  "pointerdown",
  "pointermove",
  "keydown",
  "wheel",
  "touchstart",
];

export function IdleSessionGuard() {
  useEffect(() => {
    let alive = true;
    let timeoutMs: number | null = null;

    const loadConfig = () =>
      getMe()
        .then((me) => {
          if (!alive) return;
          const min = me.sessaoInatividadeMinutos;
          timeoutMs = typeof min === "number" && min > 0 ? min * 60_000 : null;
        })
        .catch(() => {
          /* API indisponível: mantém o último valor conhecido */
        });

    // Login conta como atividade — senão um lastActivity velho derrubava na hora.
    touchActivity();
    void loadConfig();
    const cfgTimer = setInterval(loadConfig, CONFIG_REFRESH_MS);

    const onActivity = () => touchActivity();
    for (const ev of ACTIVITY_EVENTS)
      window.addEventListener(ev, onActivity, { capture: true, passive: true });

    const check = setInterval(() => {
      if (timeoutMs == null) return;
      if (Date.now() - lastActivityAt() < timeoutMs) return;
      void forceLogout({ kind: "idle", minutes: Math.max(1, Math.round(timeoutMs / 60_000)) });
    }, CHECK_MS);

    return () => {
      alive = false;
      clearInterval(cfgTimer);
      clearInterval(check);
      for (const ev of ACTIVITY_EVENTS)
        window.removeEventListener(ev, onActivity, { capture: true });
    };
  }, []);
  return null;
}

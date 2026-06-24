// Feedback sonoro da Separação via Web Audio API (sem dependência nativa).
// beepOk: agudo curto. beepError: dois tons graves.

let ctx: AudioContext | null = null;

function audioCtx(): AudioContext | null {
  try {
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
    }
    // Em alguns ambientes o contexto inicia suspenso até um gesto do usuário.
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freq: number, startAt: number, durationMs: number, gain = 0.08): void {
  const ac = audioCtx();
  if (!ac) return;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = "square";
  osc.frequency.value = freq;
  g.gain.value = gain;
  osc.connect(g);
  g.connect(ac.destination);
  const t0 = ac.currentTime + startAt;
  const t1 = t0 + durationMs / 1000;
  // pequeno fade pra não estalar
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t1);
  osc.start(t0);
  osc.stop(t1);
}

/** Bipe de sucesso — leitura bateu com o item esperado. */
export function beepOk(): void {
  tone(1320, 0, 90);
}

/** Bipe de erro — leitura não bateu / tag inesperada. */
export function beepError(): void {
  tone(220, 0, 140);
  tone(180, 0.16, 180);
}

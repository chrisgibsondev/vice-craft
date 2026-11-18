/**
 * Tiny procedural UI/foley sounds for combat feel (hit markers, dry fire, magazine
 * out/in, shell clinks, low-ammo ticks, hurt thumps). Rendered with Web Audio
 * nodes into the audio engine's own SFX bus so volume settings apply.
 * Never throws; silently does nothing until the audio context exists.
 */
import { audio } from '../audio';

interface EngineInternals { ctx: AudioContext | null; buses?: Record<string, GainNode> }

let noise: AudioBuffer | null = null;

function graph(): { ctx: AudioContext; out: AudioNode } | null {
  const e = audio as unknown as EngineInternals;
  const ctx = e.ctx;
  if (!ctx || ctx.state !== 'running' || !e.buses?.sfx) return null;
  return { ctx, out: e.buses.sfx };
}

function noiseBuf(ctx: AudioContext) {
  if (noise && noise.sampleRate === ctx.sampleRate) return noise;
  const n = Math.floor(ctx.sampleRate * 0.5);
  noise = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = noise.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return noise;
}

function tone(freq: number, freqEnd: number, dur: number, vol: number, type: OscillatorType = 'sine', delay = 0) {
  const g = graph(); if (!g) return;
  try {
    const t = g.ctx.currentTime + delay;
    const o = g.ctx.createOscillator(); const a = g.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t + dur);
    a.gain.setValueAtTime(0.0001, t); a.gain.exponentialRampToValueAtTime(vol, t + 0.004); a.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(a); a.connect(g.out); o.start(t); o.stop(t + dur + 0.02);
  } catch { /* audio unavailable */ }
}

function burst(freq: number, q: number, dur: number, vol: number, delay = 0, type: BiquadFilterType = 'bandpass') {
  const g = graph(); if (!g) return;
  try {
    const t = g.ctx.currentTime + delay;
    const s = g.ctx.createBufferSource(); s.buffer = noiseBuf(g.ctx);
    const f = g.ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const a = g.ctx.createGain();
    a.gain.setValueAtTime(0.0001, t); a.gain.exponentialRampToValueAtTime(vol, t + 0.003); a.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(f); f.connect(a); a.connect(g.out); s.start(t, Math.random() * 0.3); s.stop(t + dur + 0.02);
  } catch { /* audio unavailable */ }
}

export const synth = {
  hit(kill: boolean) {
    if (kill) { tone(900, 500, 0.12, 0.22, 'triangle'); tone(2400, 1900, 0.06, 0.16, 'sine', 0.01); burst(3000, 2, 0.05, 0.12); }
    else { tone(2600, 1800, 0.045, 0.16, 'sine'); burst(4200, 3, 0.03, 0.09); }
  },
  dry() { burst(3800, 6, 0.025, 0.25); tone(1200, 900, 0.02, 0.06, 'square'); },
  magOut(kind: string) {
    if (kind === 'shotgun') { burst(900, 3, 0.07, 0.25); burst(2400, 4, 0.04, 0.15, 0.05); return; }
    burst(1500, 4, 0.05, 0.22); tone(700, 500, 0.06, 0.06, 'triangle', 0.01);
  },
  magIn(kind: string) {
    if (kind === 'shotgun') { burst(700, 2, 0.09, 0.3); burst(1800, 3, 0.06, 0.2, 0.12); return; } // pump rack
    burst(1100, 5, 0.04, 0.28); burst(2600, 6, 0.03, 0.18, 0.09); tone(1600, 1300, 0.03, 0.05, 'square', 0.09); // seat + bolt
  },
  shell(delay: number) { tone(5200 + Math.random() * 900, 4200, 0.05, 0.035, 'sine', delay); tone(6100, 5400, 0.035, 0.02, 'sine', delay + 0.07); },
  lowAmmo() { tone(1500, 1450, 0.025, 0.05, 'sine'); },
  hurt(heavy: boolean) { tone(heavy ? 85 : 110, 50, heavy ? 0.22 : 0.14, heavy ? 0.4 : 0.25, 'sine'); burst(400, 1, 0.08, 0.12); },
  aimIn() { burst(2000, 2, 0.04, 0.05); },
  /** bullet impact foley, volume already distance-attenuated */
  impact(kind: string, v: number) {
    if (kind === 'metal' || kind === 'vehicle') { tone(3200 + Math.random() * 1500, 2200, 0.08, 0.09 * v, 'triangle'); burst(5000, 4, 0.03, 0.08 * v); }
    else if (kind === 'water') burst(900, 0.8, 0.18, 0.12 * v, 0, 'lowpass');
    else if (kind === 'glass') { burst(6000, 2, 0.08, 0.1 * v); tone(4800, 3900, 0.06, 0.04 * v, 'sine'); }
    else if (kind === 'wood') burst(700, 2.5, 0.06, 0.16 * v);
    else if (kind === 'stun') burst(3000, 1.5, 0.1, 0.06 * v);
    else burst(1300, 1.2, 0.05, 0.14 * v);
  },
};

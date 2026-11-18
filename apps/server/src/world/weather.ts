/**
 * Server-authoritative weather for one instance.
 *
 * The schedule is a pure function of (seed, wall-clock time), so it needs no stored state and a restart
 * resumes the same sky: time is cut into 5-minute slots, each slot picks a base state from a weighted
 * table (mostly sunny), and a "downpour" slot is overcast with a short, heavy tropical burst in the
 * middle. Every boundary blends over 30-60 s. Clients get one compact `wx` message whenever the
 * target changes (and on join); they interpolate with the shared server clock, so everyone sees the same sky.
 */
import type { WxMsg, WxTriple } from '@blockshore/shared';
import { WX_STATE_NAMES } from '@blockshore/shared';

export const SLOT_MS = 5 * 60_000;
const CLEAR = 0, PARTLY = 1, OVERCAST = 2, RAIN = 3, STORM = 4, DOWNPOUR = 5;

function mix32(a: number): number {
  a = Math.imul(a ^ (a >>> 16), 0x85ebca6b); a = Math.imul(a ^ (a >>> 13), 0xc2b2ae35); return (a ^ (a >>> 16)) >>> 0;
}
export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
/** deterministic float in [0,1) from (seed, slot, salt) */
const rnd = (seed: number, k: number, salt: number) => mix32(seed ^ mix32(k * 2654435761 + salt * 40503)) / 4294967296;

/** weights of the slot's base state; ~65% of slots are clear or partly cloudy */
const WEIGHTS: [number, number][] = [[CLEAR, 38], [PARTLY, 27], [OVERCAST, 11], [RAIN, 10], [STORM, 5], [DOWNPOUR, 9]];
const TOTAL = WEIGHTS.reduce((a, [, w]) => a + w, 0);

interface Seg { at: number; w: WxTriple }
interface SlotInfo { base: WxTriple; events: { off: number; w: WxTriple }[] }

function slotInfo(seed: number, k: number): SlotInfo {
  let r = rnd(seed, k, 1) * TOTAL, st = CLEAR;
  for (const [s, w] of WEIGHTS) { if ((r -= w) < 0) { st = s; break; } }
  const intensity = Math.round(70 + rnd(seed, k, 2) * 30);
  const wind = (s: number) => Math.round(Math.min(100, ([18, 32, 40, 55, 82, 62][s] + (rnd(seed, k, 3) - 0.5) * 20)));
  if (st === DOWNPOUR) {
    // a calm overcast slot with one short heavy burst
    const base: WxTriple = [OVERCAST, intensity, wind(OVERCAST)];
    const off = (55 + rnd(seed, k, 4) * 100) * 1000, len = (75 + rnd(seed, k, 5) * 55) * 1000;
    return { base, events: [{ off, w: [DOWNPOUR, intensity, wind(DOWNPOUR)] }, { off: off + len, w: base }] };
  }
  return { base: [st, intensity, wind(st)], events: [] };
}

/** the (state, intensity, wind) schedule in force at `t`, plus when it began and how it blends from the previous one */
export function scheduleAt(seed: number, t: number): { cur: WxTriple; prev: WxTriple; at: number; dur: number } {
  const k = Math.floor(t / SLOT_MS);
  const here = slotInfo(seed, k);
  const segs: Seg[] = [{ at: k * SLOT_MS, w: here.base }, ...here.events.map((e) => ({ at: k * SLOT_MS + e.off, w: e.w }))];
  let i = 0;
  while (i + 1 < segs.length && segs[i + 1].at <= t) i++;
  const cur = segs[i];
  let prevW: WxTriple;
  if (i > 0) prevW = segs[i - 1].w;
  else { const p = slotInfo(seed, k - 1); prevW = p.events.length ? p.events[p.events.length - 1].w : p.base; }
  const at = cur.at, prev = prevW;
  const dur = Math.round((30 + rnd(seed, Math.floor(at / 1000), 6) * 30) * 1000);
  return { cur: cur.w, prev, at, dur };
}

export class WeatherClock {
  private forced: { cur: WxTriple; prev: WxTriple; at: number; dur: number; release?: boolean } | null = null;
  private lastKey = '';
  readonly seed: number;
  /** `parent`: activity and interior instances show the sky of the world they were launched from */
  constructor(seedKey: string, private readonly parent: WeatherClock | null = null) { this.seed = hashStr(`wx:${seedKey}`); }

  /** current message (cheap: no allocation beyond the result) */
  message(now: number): WxMsg {
    if (this.parent) return this.parent.message(now);
    if (this.forced?.release && now >= this.forced.at + this.forced.dur) this.forced = null;
    const s = this.forced ?? scheduleAt(this.seed, now);
    return { t: 'wx', s: s.cur, p: s.prev, at: s.at, d: s.dur };
  }

  /** returns a message only when the schedule moved on since the last poll */
  poll(now: number): WxMsg | null {
    const m = this.message(now);
    const key = `${m.at}|${m.s[0]}|${m.s[1]}|${m.s[2]}`;
    if (key === this.lastKey) return null;
    this.lastKey = key;
    return m;
  }

  /** dev: force a state (name or index), or null to go back to the schedule; blends from what is showing now */
  force(state: string | number | null, now: number, intensity = 100, wind?: number): boolean {
    if (this.parent) return this.parent.force(state, now, intensity, wind);
    if (state === null || state === 'auto') {
      // back to the schedule: blend from what is showing now over 10 s, then drop the override
      const prev = this.blendTarget(this.message(now), now);
      this.forced = { cur: scheduleAt(this.seed, now).cur, prev, at: now, dur: 10_000, release: true };
      this.lastKey = '';
      return true;
    }
    const idx = typeof state === 'number' ? state : (WX_STATE_NAMES as readonly string[]).indexOf(String(state));
    if (!Number.isInteger(idx) || idx < 0 || idx >= WX_STATE_NAMES.length) return false;
    const pct = (v: number, d: number) => (Number.isFinite(v) ? Math.round(Math.min(100, Math.max(0, v))) : d);
    const cur = this.message(now);
    // where the blend is right now becomes the "previous" so a forced change never jumps
    const prev: WxTriple = this.blendTarget(cur, now);
    const defWind = [18, 32, 40, 55, 82, 62][idx];
    this.forced = { cur: [idx, pct(intensity, 100), wind === undefined ? defWind : pct(wind, defWind)], prev, at: now, dur: 8000 };
    this.lastKey = '';
    return true;
  }
  private blendTarget(m: WxMsg, now: number): WxTriple {
    const k = Math.min(1, Math.max(0, (now - m.at) / m.d));
    return k < 0.5 ? m.p : m.s;
  }
}

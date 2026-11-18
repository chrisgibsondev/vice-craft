/**
 * Gameplay-feel tables + per-frame values the HUD reads without React state:
 * crosshair spread, aim state, hit markers, damage indicators, reload progress.
 *
 * The game loop writes `liveFeel` every frame and then calls every registered
 * listener (so the HUD keeps up even when the page's own rAF is throttled).
 */
import type { WeaponDef } from '@blockshore/shared';

export interface HurtMark { at: number; /** world bearing of the attacker (radians, yaw convention) or NaN when unknown */ bearing: number; amt: number }

export const liveFeel = {
  /** crosshair half-gap in CSS px */
  spreadPx: 8,
  aiming: 0,
  /** 0 hidden, 1 shown */
  show: false,
  armed: false,
  stun: false,
  /** performance.now() of the last confirmed hit / kind */
  hitAt: -1e9, hitKill: false, hitVeh: false,
  /** reload progress 0..1, or -1 when not reloading */
  reload: -1,
  lowAmmo: false, empty: false,
  /** camera yaw for the damage indicator */
  camYaw: 0,
  hurts: [] as HurtMark[],
  /** last time a big flash should play (heavy hit) */
  flashAt: -1e9, flashAmt: 0,
  underwater: false,
  /** drive-by mode label */
  driveBy: false,
};

type Listener = () => void;
const listeners = new Set<Listener>();
export function onFeelFrame(fn: Listener): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function emitFeelFrame() { for (const l of listeners) l(); }

/**
 * Spread multiplier. MUST mirror Instance.fire() on the server
 * (apps/server/src/world/instance.ts) so the crosshair tells the truth.
 */
export function spreadMul(aim: boolean, moving01: number, air: boolean, heat: number, inVeh: boolean) {
  return (aim ? 0.55 : 1) * (1 + (inVeh ? 0.6 : moving01) * 0.6 + (!inVeh && air ? 0.5 : 0)) * (1 + Math.min(1, heat) * 0.6);
}
export function heatAdd(w: WeaponDef) { return w.auto ? 0.14 : 0.3; }
export const HEAT_DECAY = 2.5;

export interface RecoilDef {
  /** vertical kick per shot (radians) */ up: number;
  /** horizontal pattern per shot index (multiplied by `side`) */ pattern: number[];
  side: number;
  /** visual camera punch (radians) */ punch: number;
  /** recovery speed (1/s) and delay before recovering (s) */ recover: number; delay: number;
  /** ADS FOV multiplier and ADS sensitivity multiplier */ zoom: number;
  /** viewmodel-free camera roll kick */ roll: number;
  shake: number;
}

// Original per-weapon patterns: index = consecutive shot number (wraps on the last 6 entries).
export const RECOIL: Record<string, RecoilDef> = {
  stun: { up: 0.010, pattern: [0, 0.2, -0.2], side: 0.004, punch: 0.018, recover: 9, delay: 0.08, zoom: 0.85, roll: 0.004, shake: 0.05 },
  pistol: { up: 0.022, pattern: [0, 0.35, -0.25, 0.3, -0.4, 0.2], side: 0.006, punch: 0.03, recover: 8, delay: 0.09, zoom: 0.8, roll: 0.006, shake: 0.08 },
  smg: { up: 0.0105, pattern: [0, 0.4, 0.7, 0.5, -0.2, -0.6, -0.4, 0.3, 0.8, 0.5, -0.3, -0.7], side: 0.0055, punch: 0.012, recover: 7, delay: 0.12, zoom: 0.78, roll: 0.004, shake: 0.06 },
  shotgun: { up: 0.06, pattern: [0, 0.5, -0.5], side: 0.012, punch: 0.07, recover: 5.5, delay: 0.14, zoom: 0.85, roll: 0.018, shake: 0.32 },
  rifle: { up: 0.0125, pattern: [0, -0.3, -0.6, -0.4, 0.2, 0.6, 0.8, 0.4, -0.2, -0.5, -0.3, 0.3], side: 0.005, punch: 0.016, recover: 7.5, delay: 0.12, zoom: 0.6, roll: 0.005, shake: 0.08 },
};
export function recoilFor(id: string, kind?: string): RecoilDef { return RECOIL[id] ?? RECOIL[kind ?? ''] ?? RECOIL.pistol; }

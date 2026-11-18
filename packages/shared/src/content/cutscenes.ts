/**
 * Cinematics. The server owns timing (start time, skip votes, end); clients play the
 * camera track locally from this data. Positions are world coordinates.
 */
import type { V3 } from './activityTypes.ts';

export interface Shot {
  dur: number;
  cam: { from: V3; to: V3; lookFrom: V3; lookTo: V3; fov?: number };
  sub?: { speaker: string; text: string };
  sfx?: string;
}
export interface Actor { id: string; role: string; skin: number; pos: V3; yaw: number; anim: 'idle' | 'talk' | 'wave' | 'walk' | 'sit'; walkTo?: V3; name?: string }
export interface CutsceneDef {
  id: string;
  music?: string;
  shots: Shot[];
  actors: Actor[];
  /** where participants stand during the scene (they are re-positioned here at the end) */
  endSpots: V3[];
  endYaw: number;
}

const Y = 22;

export const CUTSCENES: Record<string, CutsceneDef> = {
  arrival: {
    id: 'arrival', music: 'cutscene',
    actors: [],
    shots: [
      { dur: 6, cam: { from: [2380, 90, 3330], to: [2440, 70, 3260], lookFrom: [2520, 30, 3160], lookTo: [2500, 26, 3170] }, sub: { speaker: '', text: 'PORT SOLANO — Solano County, Palmara' } },
      { dur: 5, cam: { from: [2470, 40, 3240], to: [2472, 28, 3218], lookFrom: [2472, 24, 3190], lookTo: [2472, 23, 3200] }, sub: { speaker: 'Marisol (phone)', text: 'You\'re the cousin? Good. You look like someone who can drive.' } },
      { dur: 5, cam: { from: [2478, 24.5, 3212], to: [2476, 24, 3209], lookFrom: [2472, 23.4, 3204], lookTo: [2472, 23.4, 3204] }, sub: { speaker: 'Marisol (phone)', text: 'Sunny Side Diner, two blocks east. Come hungry. Come alone — or bring your friends, I don\'t care.' } },
    ],
    endSpots: [[2470, Y, 3204], [2474, Y, 3204], [2470, Y, 3207], [2474, Y, 3207]], endYaw: 0,
  },
  diner_meet: {
    id: 'diner_meet', music: 'cutscene',
    actors: [{ id: 'marisol', role: 'contact', skin: 3, pos: [2517.5, Y, 3183.5], yaw: Math.PI, anim: 'talk', name: 'Marisol Reyes' }],
    shots: [
      { dur: 4.5, cam: { from: [2523.5, 24.2, 3182.5], to: [2521.5, 24, 3182.5], lookFrom: [2517.5, 23.5, 3183.5], lookTo: [2517.5, 23.6, 3183.5] }, sub: { speaker: 'Marisol', text: 'Sit. Coffee\'s terrible, the job isn\'t.' } },
      { dur: 5, cam: { from: [2514.5, 24, 3182.5], to: [2515.5, 24, 3182],  lookFrom: [2517.5, 23.6, 3183.5], lookTo: [2517.5, 23.6, 3183.5] }, sub: { speaker: 'Marisol', text: 'A few packages need moving across downtown before the afternoon rush. My Dart Hatch is out front.' } },
      { dur: 5, cam: { from: [2522, 25, 3176], to: [2520, 25.5, 3172], lookFrom: [2517.5, 23.6, 3183.5], lookTo: [2512, 22.5, 3166.5] }, sub: { speaker: 'Marisol', text: 'Bring them to Dez at Torque & Tide. Don\'t scratch my car. Don\'t open the boxes.' } },
    ],
    endSpots: [[2519.5, Y, 3176], [2521.5, Y, 3176], [2517.5, Y, 3176], [2523.5, Y, 3176]], endYaw: 0,
  },
  garage_dez: {
    id: 'garage_dez', music: 'cutscene',
    actors: [{ id: 'dez', role: 'mechanic', skin: 5, pos: [2418, Y, 3181], yaw: Math.PI, anim: 'wave', name: 'Dez Morales' }],
    shots: [
      { dur: 4.5, cam: { from: [2424, 25, 3172], to: [2421, 24.5, 3174], lookFrom: [2418, 23.6, 3181], lookTo: [2418, 23.6, 3181] }, sub: { speaker: 'Dez', text: 'Marisol\'s boxes. Right on time — that never happens.' } },
      { dur: 5, cam: { from: [2410, 26, 3176], to: [2412, 25, 3174], lookFrom: [2418, 23.6, 3181], lookTo: [2420, 23, 3186] }, sub: { speaker: 'Dez', text: 'Anything you drive, I can fix or repaint. Your own wheels live here too — just ask.' } },
      { dur: 4, cam: { from: [2440, 40, 3180], to: [2460, 45, 3150], lookFrom: [2440, 24, 3160], lookTo: [2471, 24, 3130] }, sub: { speaker: 'Marisol (phone)', text: 'Nice work. Your apartment is at The Coquina, just north. Get some rest.' } },
    ],
    endSpots: [[2416, Y, 3176], [2418, Y, 3176], [2420, Y, 3176], [2422, Y, 3176]], endYaw: 0,
  },
  sundial_intro: {
    id: 'sundial_intro', music: 'heist_plan',
    actors: [],
    shots: [
      { dur: 5, cam: { from: [2540, 40, 3100], to: [2530, 32, 3110], lookFrom: [2520, 24, 3134], lookTo: [2520, 23, 3134] }, sub: { speaker: 'Lena (radio)', text: 'Sundial Jewelers. Closed, lit, guarded. Exactly how we like it.' } },
      { dur: 5, cam: { from: [2534, 25, 3165], to: [2528, 24, 3162], lookFrom: [2522, 23, 3151], lookTo: [2522, 23, 3151] }, sub: { speaker: 'Lena (radio)', text: 'Getaway car is parked out back. Stick to the plan you chose — and if it goes wrong, improvise fast.' } },
    ],
    endSpots: [[2526, Y, 3162], [2529, Y, 3162], [2532, Y, 3162], [2535, Y, 3162]], endYaw: 0,
  },
  race_intro: {
    id: 'race_intro', music: 'race',
    actors: [{ id: 'kilo', role: 'contact', skin: 7, pos: [2452, Y, 3174], yaw: Math.PI / 2, anim: 'wave', name: 'DJ Kilo' }],
    shots: [
      { dur: 3.5, cam: { from: [2470, 26, 3180], to: [2462, 25, 3176], lookFrom: [2440, 23, 3168], lookTo: [2440, 23, 3168] }, sub: { speaker: 'DJ Kilo', text: 'Two laps. Checkpoints in order. Ghost rules — no bumping.' } },
      { dur: 3, cam: { from: [2452, 30, 3150], to: [2440, 28, 3156], lookFrom: [2470, 22, 3168], lookTo: [2500, 22, 3168] }, sub: { speaker: 'DJ Kilo', text: 'Lights go when everyone\'s on the grid.' } },
    ],
    endSpots: [[2440, Y, 3166], [2440, Y, 3170], [2430, Y, 3166], [2430, Y, 3170]], endYaw: -Math.PI / 2,
  },
};

import { EXTRA_CUTSCENES } from './cutscenes2.ts';
Object.assign(CUTSCENES, EXTRA_CUTSCENES);

export function cutsceneDuration(id: string): number {
  return CUTSCENES[id].shots.reduce((s, x) => s + x.dur, 0);
}

/**
 * Activity content. Positions are world coordinates (feet height y = 22 on street level).
 * Downtown Port Solano lots: lot (i,j) spans x 48i..48i+47, z 48j..48j+47.
 */
import type { ActivityDef } from './activityTypes.ts';
import { STORY_ACTIVITIES, EXTRA_CONTACTS } from './story.ts';
import { HEISTS_ACTIVITIES, SUNDIAL_ACTIVITIES } from './heists.ts';
import { MINIGAMES_ACTIVITIES } from './minigames.ts';

const Y = 22;

// ─────────────────────────────────────────────────────────────────── STORY 1
const m1: ActivityDef = {
  id: 'story_1', kind: 'mission', name: 'Welcome to Port Solano', giver: 'marisol',
  blurb: 'Fresh off the bus with a borrowed phone and a cousin\'s favour. Marisol Reyes has a job — and a key to an apartment.',
  start: [2472, Y, 3204], startSpots: [[2470, Y, 3204], [2474, Y, 3204], [2470, Y, 3207], [2474, Y, 3207]], startYaw: 0,
  unlock: {}, minPlayers: 1, maxPlayers: 4, lateJoin: 'roster_reconnect', replayable: true, music: 'roam_1',
  notes: [
    'Solo: two packages, more time. Party: one package per player, split up to go faster.',
    'Players who already finished this mission earn replay cash only.',
    'Disconnected crew members can rejoin until the mission ends; nobody new can join mid-mission.',
  ],
  stages: [
    {
      id: 'arrive', title: 'Arrival', cutscene: 'arrival',
      objectives: [{ type: 'reach', id: 'diner', label: 'Meet Marisol at the Sunny Side Diner', pos: [2519.5, Y, 3184], r: 4, who: 'any' }],
      lines: [{ speaker: 'Marisol', text: 'You made it. Sunny Side Diner, corner booth. Don\'t make me wait.' }],
    },
    {
      id: 'meet', title: 'The job', cutscene: 'diner_meet', checkpoint: true,
      respawn: [[2519.5, Y, 3176], [2521.5, Y, 3176], [2517.5, Y, 3176], [2523.5, Y, 3176]],
      spawn: [
        { id: 'car1', kind: 'vehicle', model: 'compact', pos: [2512, Y, 3166.5], yaw: Math.PI / 2, color: 0xf2c14e, label: 'Marisol\'s Dart Hatch' },
        { id: 'car2', kind: 'vehicle', model: 'compact', pos: [2528, Y, 3166.5], yaw: Math.PI / 2, color: 0x46b1c9, minParty: 3, label: 'Second car' },
      ],
      objectives: [{ type: 'enter_vehicle', id: 'enter', label: 'Get in the Dart Hatch', vehicles: ['car1', 'car2'], who: 'any' }],
      fail: [{ type: 'vehicle_destroyed', vehicle: 'car1' }],
    },
    {
      id: 'pickup', title: 'Collect the packages', checkpoint: true,
      respawn: [[2512, Y, 3170], [2514, Y, 3170], [2516, Y, 3170], [2518, Y, 3170]],
      timeLimit: [300, 270, 240, 240],
      spawn: [
        { id: 'pkg_a', kind: 'object', obj: 'package', pos: [2405.5, Y, 3246.5], label: 'Package', hold: 1.2 },
        { id: 'pkg_b', kind: 'object', obj: 'package', pos: [2549.5, Y, 3110.5], label: 'Package', hold: 1.2 },
        { id: 'pkg_c', kind: 'object', obj: 'package', pos: [2586.5, Y, 3236.5], label: 'Package', hold: 1.2, minParty: 3 },
        { id: 'pkg_d', kind: 'object', obj: 'package', pos: [2453.5, Y, 3290.5], label: 'Package', hold: 1.2, minParty: 4 },
      ],
      objectives: [{ type: 'interact', id: 'pkgs', label: 'Pick up the packages', targets: ['pkg_a', 'pkg_b', 'pkg_c', 'pkg_d'], count: [2, 2, 3, 4] }],
      fail: [{ type: 'timer' }, { type: 'vehicle_destroyed', vehicle: 'car1' }],
      lines: [{ speaker: 'Marisol', text: 'Packages are marked on your map. Don\'t open them. Don\'t shake them.' }],
    },
    {
      id: 'deliver', title: 'Drop-off',
      timeLimit: [240, 240, 240, 240],
      objectives: [{ type: 'reach', id: 'garage', label: 'Drive into the Torque & Tide garage', pos: [2416.5, Y, 3186], r: 6, who: 'any', vehicle: 'car1' }],
      fail: [{ type: 'timer' }, { type: 'vehicle_destroyed', vehicle: 'car1' }],
    },
    {
      id: 'home', title: 'Home', cutscene: 'garage_dez', checkpoint: true,
      respawn: [[2416, Y, 3176], [2418, Y, 3176], [2420, Y, 3176], [2422, Y, 3176]],
      objectives: [{ type: 'reach', id: 'coquina', label: 'Walk to your new apartment, The Coquina', pos: [2471.5, Y, 3127], r: 3.5, who: 'any' }],
      lines: [{ speaker: 'Marisol', text: 'Apartment 1B at The Coquina. Rent\'s paid for a month. After that, you work.' }],
    },
  ],
  rewards: { cash: [1500, 1500, 1500, 1500], rep: 100, replayCash: 400, unlocks: ['heist_sundial', 'race_downtown', 'prep_sundial_scout', 'prep_sundial_wheels'] },
};

// HEIST 1 (The Sundial Job) and its setups live in heists.ts with the other heists.

// ─────────────────────────────────────────────────────────────────── MINI-GAME: street race
const raceCps: [number, number, number][] = [
  [2544, Y, 3168], [2592, Y, 3168], [2592, Y, 3264], [2496, Y, 3264], [2400, Y, 3264], [2400, Y, 3168], [2400, Y, 3072], [2496, Y, 3072], [2496, Y, 3168],
];
const raceDowntown: ActivityDef = {
  id: 'race_downtown', kind: 'minigame', name: 'Downtown Sprint', giver: 'kilo',
  blurb: 'Two laps around the Port Solano grid. DJ Kilo times it from the club roof.',
  start: [2560, Y, 3160], startSpots: [[2440, Y, 3166], [2440, Y, 3170], [2430, Y, 3166], [2430, Y, 3170]], startYaw: -Math.PI / 2,
  unlock: { requires: ['story_1'] }, minPlayers: 1, maxPlayers: 4, lateJoin: 'never', replayable: true, music: 'race',
  notes: [
    'Solo: beat the par times (gold / silver / bronze) and your personal best.',
    'Party: head-to-head. Everyone gets an identical Vireo GT and a staggered grid slot; the grid is re-drawn randomly each race.',
    'Non-contact rules: racers pass through each other. Traffic still collides.',
    'Checkpoints must be crossed in order; times are measured by the server.',
  ],
  race: { competitive: true, parTimes: [62, 74, 90], vehicleModel: 'sports', startGrid: [[2440, Y, 3166], [2440, Y, 3170], [2430, Y, 3166], [2430, Y, 3170]] },
  stages: [{
    id: 'race', title: 'Race', cutscene: 'race_intro',
    spawn: [{ id: 'racecar', kind: 'vehicle', model: 'sports', pos: [2440, Y, 3166], yaw: -Math.PI / 2, perPlayer: true, ghost: true, label: 'Race car' }],
    objectives: [{ type: 'checkpoints', id: 'cps', label: 'Race', points: raceCps, laps: 2, r: 9 }],
    timeLimit: [240, 240, 240, 240],
    fail: [{ type: 'timer' }],
  }],
  rewards: { cash: [600, 900, 1000, 1100], rep: 40, replayCash: 600 },
};

export const ACTIVITIES: ActivityDef[] = [m1, ...SUNDIAL_ACTIVITIES, raceDowntown, ...STORY_ACTIVITIES, ...HEISTS_ACTIVITIES, ...MINIGAMES_ACTIVITIES];
export const ACTIVITY_BY_ID: Record<string, ActivityDef> = Object.fromEntries(ACTIVITIES.map((a) => [a.id, a]));

export const CONTACTS: Record<string, { name: string; role: string; blurb: string; color: number }> = {
  marisol: { name: 'Marisol Reyes', role: 'Fixer', blurb: 'Runs half the favours in Port Solano from a diner booth.', color: 0xf2c14e },
  lena: { name: 'Lena Voss', role: 'Heist planner', blurb: 'Ex-insurance investigator. Knows exactly how stores protect themselves.', color: 0x9b5de5 },
  kilo: { name: 'DJ Kilo', role: 'Street racing', blurb: 'Plays the Neon Lagoon on weekends, runs the street races every other night.', color: 0x00bbf9 },
  dez: { name: 'Dez Morales', role: 'Mechanic', blurb: 'Torque & Tide Garage. Fixes anything, asks nothing.', color: 0xf15bb5 },
};

// contacts introduced by the extended story
Object.assign(CONTACTS, EXTRA_CONTACTS);

// ─────────────────────────────────────────────────────────────────── world selection
// Content is authored in Palmara coordinates; on Leonia every position, heading, race route and
// re-timed limit comes from content/leonia/positions.gen.ts (scripts/leonia-content.ts).
import { WORLD } from '../constants.ts';
import { CUTSCENES } from './cutscenes.ts';
import { applyLeonia, leoniaRewrite } from './leonia/apply.ts';
/** content roots in walk order (shared with scripts/leonia-content.ts) */
export function contentRoots(): [string, unknown][] {
  return [...ACTIVITIES.map((a): [string, unknown] => [a.id, a]), ...Object.entries(CUTSCENES).map(([k, c]): [string, unknown] => [`cs:${k}`, c])];
}
const rawContent = (() => { try { return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.BLOCKSHORE_RAW_CONTENT === '1'; } catch { return false; } })();
if (WORLD === 'leonia' && !rawContent) { applyLeonia(contentRoots()); leoniaRewrite(CONTACTS); }

/**
 * Mini-games (the existing race "Downtown Sprint" lives in activities.ts):
 *   mini_trial     Palm Mile Time Trial   (race, non-competitive: par times, each racer's own time)
 *   mini_taxi      Sunline Cab fares      (pick-up / drop-off chains, scoring by total time)
 *   mini_delivery  Palm Parcel Rush       (load, then drop parcels across Port Solano, scoring by total time)
 *   mini_boatrace  Lagoon Cup             (competitive boat race on the Port Solano lagoon)
 *   mini_range     Bullseye Range         (timed target practice, three waves)
 * Unlocks: taxi / delivery / range after story_2, trial after story_3, boat race after story_6.
 */
import type { ActivityDef, StageDef, V3, SpawnDef } from './activityTypes.ts';
import { Y, row } from './story.ts';

// ═══════════════════════════════════════════════════════════════════ TIME TRIAL
const trialCps: V3[] = [
  [2592, Y, 3360], [2700, Y, 3360], [2800, Y, 3360], [2800, Y, 3250], [2800, Y, 3100], [2800, Y, 3000], [2700, Y, 3000],
  [2610, Y, 3000], [2544, Y, 3060], [2544, Y, 3120], [2544, Y, 3168], [2592, Y, 3168], [2592, Y, 3216],
];
const trial: ActivityDef = {
  id: 'mini_trial', kind: 'minigame', name: 'Palm Mile Time Trial', giver: 'kilo',
  blurb: 'One lap of the Port Solano ring: downtown, the Tarpon Causeway, Ocean Drive and the Flamingo Causeway home. You against the clock - nobody to hit, nowhere to hide.',
  start: [2597.5, Y, 3196.5], startSpots: row(2597.5, 3190.5, 0, -2), startYaw: Math.PI,
  unlock: { requires: ['story_3'] }, minPlayers: 1, maxPlayers: 4, lateJoin: 'never', replayable: true, music: 'race',
  notes: [
    'Solo: beat the par times (gold / silver / bronze) and your personal best. The clock only stops when you cross every checkpoint, in order.',
    'Party: everyone drives the same Vireo GT at the same time (racers are ghosts - no bumping), but nobody is racing anybody - each driver gets their own time and medal and the board compares them afterwards.',
    'One lap, about a kilometre and a quarter. Traffic still collides. The checkpoint after the last one is the finish line outside the start.',
    'Late join is not allowed once the lights are on.',
  ],
  race: { competitive: false, parTimes: [52, 62, 80], vehicleModel: 'sports', startGrid: [[2590.5, Y, 3190], [2593.5, Y, 3190], [2590.5, Y, 3182], [2593.5, Y, 3182]] },
  stages: [{
    id: 'race', title: 'Time trial', cutscene: 'trial_intro',
    spawn: [{ id: 'racecar', kind: 'vehicle', model: 'sports', pos: [2590.5, Y, 3190], yaw: Math.PI, perPlayer: true, ghost: true, label: 'Trial Vireo' }],
    objectives: [{ type: 'checkpoints', id: 'cps', label: 'Time trial', points: trialCps, laps: 1, r: 10 }],
    timeLimit: [200, 200, 200, 200],
    fail: [{ type: 'timer' }],
  }],
  rewards: { cash: [1200, 1200, 1200, 1200], rep: 50, replayCash: 800 },
};

// ═══════════════════════════════════════════════════════════════════ TAXI
type Fare = { pick: [V3, V3]; drop: [V3, V3]; time: number };
const P = (x: number, z: number): V3 => [x, Y, z];
const fares: Fare[] = [
  { pick: [P(2453.5, 3125.5), P(2453.5, 3221.5)], drop: [P(2597.5, 3077.5), P(2597.5, 3173.5)], time: 110 },
  { pick: [P(2597.5, 3221.5), P(2405.5, 3173.5)], drop: [P(2790.5, 3110.5), P(2790.5, 3200.5)], time: 130 },
  { pick: [P(2790.5, 3330.5), P(2790.5, 3290.5)], drop: [P(2693.5, 3230.5), P(2730.5, 3230.5)], time: 150 },
  { pick: [P(2693.5, 3250.5), P(2730.5, 3250.5)], drop: [P(2405.5, 3125.5), P(2501.5, 3173.5)], time: 150 },
];
function taxiStages(): StageDef[] {
  const out: StageDef[] = [];
  fares.forEach((f, i) => {
    const n = i + 1;
    const tl = (t: number): [number, number, number, number] => [t, t - 10, t - 20, t - 25];
    const pickSpawn: SpawnDef[] = [
      { id: `pk${n}a`, kind: 'object', obj: 'package', pos: f.pick[0], label: 'Pick up the fare', hold: 1.2 },
      { id: `pk${n}b`, kind: 'object', obj: 'package', pos: f.pick[1], label: 'Pick up the fare', hold: 1.2, minParty: 3 },
    ];
    out.push({
      id: `pick${n}`, title: `Fare ${n}: pick-up`, checkpoint: i % 2 === 0, respawn: i % 2 === 0 ? row(2448.5, 3172.5) : undefined,
      timeLimit: tl(f.time), spawn: pickSpawn,
      objectives: [{ type: 'interact', id: 'pick', label: `Pick up fare ${n}`, targets: [`pk${n}a`, `pk${n}b`], count: [1, 1, 2, 2] }],
      fail: [{ type: 'timer' }, { type: 'vehicle_destroyed', vehicle: 'cab' }],
      ...(i === 0 ? { lines: [{ speaker: 'Dispatch', text: 'Fares are waiting on the kerb. Pull up, hop out, tap the customer in. Tips for speed, tips for smooth.' }] } : {}),
    });
    out.push({
      id: `drop${n}`, title: `Fare ${n}: drop-off`,
      timeLimit: tl(f.time), despawn: [`pk${n}a`, `pk${n}b`],
      spawn: [
        { id: `dr${n}a`, kind: 'object', obj: 'package', pos: f.drop[0], label: 'Drop off the fare', hold: 1.2 },
        { id: `dr${n}b`, kind: 'object', obj: 'package', pos: f.drop[1], label: 'Drop off the fare', hold: 1.2, minParty: 3 },
      ],
      objectives: [{ type: 'interact', id: 'drop', label: `Drop off fare ${n}`, targets: [`dr${n}a`, `dr${n}b`], count: [1, 1, 2, 2] }],
      fail: [{ type: 'timer' }, { type: 'vehicle_destroyed', vehicle: 'cab' }],
    });
  });
  return out;
}
const taxi: ActivityDef = {
  id: 'mini_taxi', kind: 'minigame', name: 'Sunline Cab Co.', giver: 'marisol',
  blurb: 'Marisol\'s cousin runs a cab company with one rule: the meter is a suggestion, the tip is not. Four fares across downtown, Port Island and the beach - fast, smooth and without wrecking the cab.',
  start: [2448.5, Y, 3172.5], startSpots: row(2444.5, 3172.5), startYaw: 0,
  unlock: { requires: ['story_2'] }, minPlayers: 1, maxPlayers: 4, lateJoin: 'never', replayable: true, music: 'roam_1',
  notes: [
    'Solo: four fares, one passenger at a time. Park near the marker, step out and tap the customer in; do the same at the drop-off. Each leg has its own time limit - miss it and the fare walks.',
    'Party: from three players on, each fare is two passengers at two kerbs (split up to be quicker). A second cab joins crews of two or more; wreck the lead cab and the shift is over.',
    'Scoring is total shift time: gold / silver / bronze against the par times. Replay for a better personal best.',
  ],
  minigame: { scoring: 'time', parScores: [300, 380, 480] },
  stages: [
    {
      id: 'cab', title: 'The cab', cutscene: 'taxi_intro', checkpoint: true, respawn: row(2444.5, 3172.5),
      spawn: [
        { id: 'cab', kind: 'vehicle', model: 'sedan', pos: [2448, Y, 3166.5], yaw: Math.PI / 2, color: 0xffbe0b, label: 'Sunline cab' },
        { id: 'cab2', kind: 'vehicle', model: 'sedan', pos: [2464, Y, 3166.5], yaw: Math.PI / 2, color: 0xffd60a, minParty: 2, label: 'Second cab' },
      ],
      objectives: [{ type: 'enter_vehicle', id: 'enter', label: 'Get in the Sunline cab', vehicles: ['cab', 'cab2'], who: 'any' }],
      fail: [{ type: 'vehicle_destroyed', vehicle: 'cab' }],
    },
    ...taxiStages(),
  ],
  rewards: { cash: [1100, 1250, 1400, 1550], rep: 45, replayCash: 700 },
};

// ═══════════════════════════════════════════════════════════════════ DELIVERY
const drops: V3[] = [P(2405.5, 3077.5), P(2549.5, 3077.5), P(2597.5, 3173.5), P(2453.5, 3269.5), P(2501.5, 3269.5), P(2693.5, 3230.5)];
const delivery: ActivityDef = {
  id: 'mini_delivery', kind: 'minigame', name: 'Palm Parcel Rush', giver: 'dez',
  blurb: 'Quik Pelican has a stack of parcels, a depot door that closes at five, and a courier van with excellent brakes. Load up, then hit every address before the rush.',
  start: [2471.5, Y, 3221.5], startSpots: row(2467.5, 3221.5), startYaw: 0,
  unlock: { requires: ['story_2'] }, minPlayers: 1, maxPlayers: 4, lateJoin: 'never', replayable: true, music: 'roam_1',
  notes: [
    'Solo: load three parcels at the depot, then deliver all three - choose your own route. Party: one more parcel per extra player (up to six); anyone can take any address, so split the map between you.',
    'The van is shared. A second van joins crews of three or more. The challenge ends in failure if the lead van is wrecked or the clock runs out.',
    'Scoring is total time: gold / silver / bronze against the par times. A cleaner route is a better score.',
  ],
  minigame: { scoring: 'time', parScores: [150, 200, 260] },
  stages: [
    {
      id: 'wheels', title: 'The van', cutscene: 'delivery_intro', checkpoint: true, respawn: row(2467.5, 3221.5),
      spawn: [
        { id: 'van', kind: 'vehicle', model: 'van', pos: [2488, Y, 3214.5], yaw: Math.PI / 2, color: 0xf6f7f8, label: 'Courier van' },
        { id: 'van2', kind: 'vehicle', model: 'van', pos: [2504, Y, 3214.5], yaw: Math.PI / 2, color: 0xf2c14e, minParty: 3, label: 'Second van' },
      ],
      objectives: [{ type: 'enter_vehicle', id: 'enter', label: 'Get in the courier van', vehicles: ['van', 'van2'], who: 'any' }],
      fail: [{ type: 'vehicle_destroyed', vehicle: 'van' }],
    },
    {
      id: 'load', title: 'Load the parcels', checkpoint: true, respawn: row(2467.5, 3221.5),
      timeLimit: [140, 150, 160, 170],
      spawn: [0, 1, 2, 3, 4, 5].map((i): SpawnDef => ({ id: `pc${i}`, kind: 'object', obj: 'package', pos: P(2459.5 + i * 4, 3222.5), label: 'Parcel', hold: 1, ...(i === 3 ? { minParty: 2 } : i === 4 ? { minParty: 3 } : i === 5 ? { minParty: 4 } : {}) })),
      objectives: [{ type: 'interact', id: 'load', label: 'Grab the parcels from the depot', targets: ['pc0', 'pc1', 'pc2', 'pc3', 'pc4', 'pc5'], count: [3, 4, 5, 6] }],
      fail: [{ type: 'timer' }, { type: 'vehicle_destroyed', vehicle: 'van' }],
    },
    {
      id: 'deliver', title: 'Deliver everything',
      timeLimit: [300, 310, 320, 330],
      spawn: drops.map((p, i): SpawnDef => ({ id: `ad${i}`, kind: 'object', obj: 'package', pos: p, label: ['Hair salon', 'Print shop', 'Dentist', 'Tailor', 'Florist', 'Dock office'][i], hold: 1.2, ...(i === 3 ? { minParty: 2 } : i === 4 ? { minParty: 3 } : i === 5 ? { minParty: 4 } : {}) })),
      objectives: [{ type: 'interact', id: 'deliver', label: 'Deliver the parcels', targets: ['ad0', 'ad1', 'ad2', 'ad3', 'ad4', 'ad5'], count: [3, 4, 5, 6] }],
      fail: [{ type: 'timer' }, { type: 'vehicle_destroyed', vehicle: 'van' }],
    },
  ],
  rewards: { cash: [1000, 1200, 1400, 1600], rep: 45, replayCash: 650 },
};

// ═══════════════════════════════════════════════════════════════════ BOAT RACE
const cupCps: V3[] = [[2706, 21, 3036], [2745, 21, 3070], [2740, 21, 3130], [2690, 21, 3150], [2662, 21, 3110], [2665, 21, 3060]];
const boatRace: ActivityDef = {
  id: 'mini_boatrace', kind: 'minigame', name: 'Lagoon Cup', giver: 'barney',
  blurb: 'Three laps of the sheltered Port Solano lagoon in matching Reef Runners. Barney insists the buoys are watching you. Do not look at the buoys.',
  start: [2635.5, Y, 3103.5], startSpots: row(2635.5, 3098.5, 0, 2), startYaw: -Math.PI / 2,
  unlock: { requires: ['story_6'] }, minPlayers: 1, maxPlayers: 4, lateJoin: 'never', replayable: true, music: 'race',
  notes: [
    'Solo: beat the par times (gold / silver / bronze) and your personal best over three laps.',
    'Party: a head-to-head race in identical boats; the grid is re-drawn randomly each race. Racers pass through each other - boats are ghosts.',
    'Boats steer slowly and carry speed through turns - brake early at the island end. Checkpoints must be crossed in order and the course stays on water, clear of the Port Island coast.',
    'Late join is not allowed once the lights are on.',
  ],
  race: { competitive: true, parTimes: [72, 86, 108], vehicleModel: 'boat', startGrid: [[2692, 21, 3030], [2692, 21, 3038], [2684, 21, 3030], [2684, 21, 3038]] },
  stages: [{
    id: 'race', title: 'Lagoon Cup', cutscene: 'boatrace_intro',
    spawn: [{ id: 'racecar', kind: 'vehicle', model: 'boat', pos: [2692, 21, 3030], yaw: -Math.PI / 2, perPlayer: true, ghost: true, label: 'Cup runner' }],
    objectives: [{ type: 'checkpoints', id: 'cps', label: 'Lagoon Cup', points: cupCps, laps: 3, r: 12 }],
    timeLimit: [260, 260, 260, 260],
    fail: [{ type: 'timer' }],
  }],
  rewards: { cash: [900, 1300, 1500, 1700], rep: 55, replayCash: 800 },
};

// ═══════════════════════════════════════════════════════════════════ RANGE
const waveTargets = (prefix: string, pts: V3[], minParty: number[]): SpawnDef[] => pts.map((p, i) => ({
  id: `${prefix}${i}`, kind: 'object', obj: 'target', pos: p, label: 'Bullseye', hold: 0, ...(minParty[i] ? { minParty: minParty[i] } : {}),
}));
const w1: V3[] = [P(2700.5, 3200.5), P(2710.5, 3198.5), P(2720.5, 3200.5), P(2705.5, 3194.5), P(2716.5, 3194.5), P(2711.5, 3190.5)];
const w2: V3[] = [P(2699.5, 3192.5), P(2706.5, 3188.5), P(2714.5, 3186.5), P(2722.5, 3190.5), P(2712.5, 3196.5), P(2702.5, 3198.5), P(2719.5, 3198.5)];
const w3: V3[] = [P(2698.5, 3187.5), P(2723.5, 3187.5), P(2710.5, 3184.5), P(2702.5, 3190.5), P(2719.5, 3192.5), P(2708.5, 3192.5), P(2715.5, 3189.5), P(2724.5, 3196.5)];
const idsOf = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const range: ActivityDef = {
  id: 'mini_range', kind: 'minigame', name: 'Bullseye Range', giver: 'dez',
  blurb: 'Bullseye Arms rents the grass behind Pier 9 by the hour. Three waves of pop-up targets, a stun pistol and a stopwatch. Dez bets he can do it faster. Dez has not been in a while.',
  start: [2710.5, Y, 3209.5], startSpots: row(2704.5, 3209.5, 4), startYaw: 0,
  unlock: { requires: ['story_2'] }, minPlayers: 1, maxPlayers: 4, lateJoin: 'never', replayable: true, music: 'roam_1',
  notes: [
    'Everyone fires the stun pistol they already carry - no gear to buy. Hit each bullseye once; each wave starts as soon as the previous one is clear.',
    'Solo: four, five and six targets. Party: the targets scale with the crew (up to six, seven and eight) and every shooter counts - shared score, shared clock.',
    'Scoring is total time across the three waves: gold / silver / bronze. Missing costs nothing but seconds.',
    'Late join is not allowed once the first wave is up.',
  ],
  minigame: { scoring: 'time', parScores: [48, 62, 85] },
  stages: [
    {
      id: 'wave1', title: 'Wave 1', cutscene: 'range_intro', checkpoint: true, respawn: row(2704.5, 3209.5, 4),
      timeLimit: [60, 60, 60, 60],
      spawn: waveTargets('t', w1, [0, 0, 0, 0, 2, 3]),
      objectives: [{ type: 'shoot', id: 'w1', label: 'Hit the first wave of targets', targets: idsOf('t', 6), count: [4, 5, 6, 6] }],
      fail: [{ type: 'timer' }],
    },
    {
      id: 'wave2', title: 'Wave 2', checkpoint: true, respawn: row(2704.5, 3209.5, 4),
      timeLimit: [60, 60, 60, 60],
      spawn: waveTargets('u', w2, [0, 0, 0, 0, 0, 2, 3]),
      objectives: [{ type: 'shoot', id: 'w2', label: 'Hit the second wave', targets: idsOf('u', 7), count: [5, 6, 7, 7] }],
      fail: [{ type: 'timer' }],
    },
    {
      id: 'wave3', title: 'Wave 3',
      timeLimit: [60, 60, 60, 60],
      spawn: waveTargets('v', w3, [0, 0, 0, 0, 0, 0, 2, 3]),
      objectives: [{ type: 'shoot', id: 'w3', label: 'Clear the final wave', targets: idsOf('v', 8), count: [6, 7, 8, 8] }],
      fail: [{ type: 'timer' }],
    },
  ],
  rewards: { cash: [900, 1000, 1100, 1200], rep: 35, replayCash: 500 },
};

export const MINIGAMES_ACTIVITIES: ActivityDef[] = [trial, taxi, delivery, boatRace, range];

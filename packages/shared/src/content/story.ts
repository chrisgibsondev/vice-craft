/**
 * Story missions 2-8: "The Vega Ledger" arc. Merged into ACTIVITIES by activities.ts.
 *
 * UNLOCK CHAIN (requires = every listed id completed; rewards.unlocks = granted outright):
 *   story_1 (existing)  ->  story_2 "Cold Chain"      requires story_1      (heist_sundial also grants it)
 *   story_2             ->  story_3 "Repo Season"     requires story_2      (+ mini_taxi, mini_delivery, mini_range)
 *   story_3             ->  story_4 "Neon Warm-Up"    requires story_3      (+ mini_trial)
 *   story_4             ->  story_5 "Pier 9 After Dark" requires story_4
 *   story_5             ->  story_6 "Heat Index"      requires story_5      (+ prep_pier9_*)
 *   story_6             ->  story_7 "Dead Reckoning"  requires story_6      (+ mini_boatrace)
 *   story_7 + heist_sundial -> story_8 "Open Books"   requires both
 * Heists: heist_pier9 needs story_5 + heist_sundial; heist_tower needs heist_pier9 + story_7.
 *
 * Geography note: Port Solano's bay (Port Island, Pier 9) is a closed lagoon — the Flamingo and
 * Tarpon causeways are solid dams. Open-ocean boating starts on the Atlantic side of Solano Beach.
 */
import type { ActivityDef, BySize, V3 } from './activityTypes.ts';

export const Y = 22;
/** four spots in a row (party members are placed in order) */
export const row = (x: number, z: number, dx = 2, dz = 0): [V3, V3, V3, V3] => [0, 1, 2, 3].map((i) => [x + dx * i, Y, z + dz * i] as V3) as [V3, V3, V3, V3];
export const bs = <T,>(a: T, b: T = a, c: T = b, d: T = c): BySize<T> => [a, b, c, d];

export const EXTRA_CONTACTS: Record<string, { name: string; role: string; blurb: string; color: number }> = {
  nix: { name: 'Nix Valdrin', role: 'Hacker', blurb: 'Nineteen, sleeps in a laundromat, and has named every router in Solano County. Can open anything with a screen.', color: 0x39ff88 },
  barney: { name: 'Capt. Barney Quill', role: 'Boat captain', blurb: 'Paranoid ferryman of the Coral Keys. Believes the gulls are informants. Has never once been caught, which proves his point.', color: 0x4cc9f0 },
  grebe: { name: 'Hollis Grebe', role: 'Port inspector', blurb: 'Inspects Pier 9 for the city. Sees exactly what he is paid to see. Always has paperwork.', color: 0xb08968 },
};

const feetUp = (n: number) => n; void feetUp;

// ═══════════════════════════════════════════════════════════════════ STORY 2
const story2: ActivityDef = {
  id: 'story_2', kind: 'mission', name: 'Cold Chain', giver: 'marisol',
  blurb: 'Four crates of very expensive fish, three beachfront restaurants, and a van whose air-con died in 2019. The ice is already melting.',
  start: [2519.5, Y, 3175.5], startSpots: row(2516.5, 3172.5), startYaw: 0,
  unlock: { requires: ['story_1'] }, minPlayers: 1, maxPlayers: 4, lateJoin: 'roster_reconnect', replayable: true, music: 'roam_1',
  notes: [
    'Solo: load two crates at Pier 9, make two beach drop-offs. Party: one more crate and drop-off per extra player (up to four) - split up and the whole run gets faster.',
    'A second van appears for crews of three or more. Either van can be used; the run only fails if the lead van is wrecked or the clock runs out.',
    'Late join: nobody new can join mid-mission, but a disconnected crew member can rejoin for 90 seconds.',
    'Replays pay replay cash only. Checkpoints: the van pick-up, the dock load and the beach run.',
  ],
  stages: [
    {
      id: 'wheels', title: 'Wheels', cutscene: 'cold_intro', checkpoint: true, respawn: row(2538, 3173.5),
      spawn: [
        { id: 'van_a', kind: 'vehicle', model: 'van', pos: [2536, Y, 3166.5], yaw: Math.PI / 2, color: 0xf6f7f8, label: "Marisol's cooler van" },
        { id: 'van_b', kind: 'vehicle', model: 'van', pos: [2552, Y, 3166.5], yaw: Math.PI / 2, color: 0x46b1c9, minParty: 3, label: 'Second cooler van' },
      ],
      objectives: [{ type: 'enter_vehicle', id: 'enter', label: 'Get in the cooler van', vehicles: ['van_a', 'van_b'], who: 'any' }],
      fail: [{ type: 'vehicle_destroyed', vehicle: 'van_a' }],
    },
    {
      id: 'dock', title: 'Load the crates at Pier 9', checkpoint: true, respawn: row(2538, 3173.5),
      timeLimit: [170, 160, 150, 140],
      spawn: [
        { id: 'crate_a', kind: 'object', obj: 'package', pos: [2693.5, Y, 3230.5], label: 'Ice crate', hold: 1.4 },
        { id: 'crate_b', kind: 'object', obj: 'package', pos: [2693.5, Y, 3250.5], label: 'Ice crate', hold: 1.4 },
        { id: 'crate_c', kind: 'object', obj: 'package', pos: [2730.5, Y, 3230.5], label: 'Ice crate', hold: 1.4, minParty: 3 },
        { id: 'crate_d', kind: 'object', obj: 'package', pos: [2730.5, Y, 3250.5], label: 'Ice crate', hold: 1.4, minParty: 4 },
      ],
      objectives: [{ type: 'interact', id: 'load', label: 'Load the ice crates (Pier 9, Port Island)', targets: ['crate_a', 'crate_b', 'crate_c', 'crate_d'], count: [2, 2, 3, 4] }],
      fail: [{ type: 'timer' }, { type: 'vehicle_destroyed', vehicle: 'van_a' }],
      lines: [{ speaker: 'Marisol (phone)', text: 'Pier 9, Port Island, over the bridge. Crates are on the kerb. If anybody asks, they are "dockside produce".' }],
    },
    {
      id: 'beach', title: 'Beach drop-offs', checkpoint: true, respawn: row(2538, 3173.5),
      timeLimit: [210, 200, 190, 180],
      spawn: [
        { id: 'drop_a', kind: 'object', obj: 'package', pos: [2790.5, Y, 3110.5], label: 'Blue Heron kitchen door', hold: 1.4 },
        { id: 'drop_b', kind: 'object', obj: 'package', pos: [2790.5, Y, 3200.5], label: 'Mango Shack back step', hold: 1.4 },
        { id: 'drop_c', kind: 'object', obj: 'package', pos: [2790.5, Y, 3330.5], label: 'Pier Grill loading bay', hold: 1.4, minParty: 3 },
        { id: 'drop_d', kind: 'object', obj: 'package', pos: [2790.5, Y, 3290.5], label: 'Coral Cantina hatch', hold: 1.4, minParty: 4 },
      ],
      objectives: [{ type: 'interact', id: 'drops', label: 'Deliver the crates to the beachfront kitchens', targets: ['drop_a', 'drop_b', 'drop_c', 'drop_d'], count: [2, 2, 3, 4] }],
      fail: [{ type: 'timer' }, { type: 'vehicle_destroyed', vehicle: 'van_a' }],
      lines: [{ speaker: 'Marisol (phone)', text: 'Solano Beach, Ocean Drive. Chefs hate waiting and they hate melted fish more. Move.' }],
    },
    {
      id: 'return', title: 'Return the van',
      timeLimit: [120, 120, 120, 120],
      objectives: [{ type: 'reach', id: 'diner', label: 'Park the van outside the Sunny Side Diner', pos: [2530, Y, 3169.5], r: 7, who: 'any' }],
      fail: [{ type: 'timer' }, { type: 'vehicle_destroyed', vehicle: 'van_a' }],
    },
    {
      id: 'outro', title: 'Debrief', cutscene: 'cold_outro',
      objectives: [{ type: 'wait', id: 'beat', label: 'Marisol has something to show you', seconds: 0.5 }],
    },
  ],
  rewards: { cash: [1800, 1900, 2000, 2100], rep: 120, replayCash: 500, unlocks: ['story_3', 'mini_taxi', 'mini_delivery', 'mini_range'] },
};

// ═══════════════════════════════════════════════════════════════════ STORY 3
const AF = { z: 3302.5 }; // airfield apron row (runway blocks)
const story3: ActivityDef = {
  id: 'story_3', kind: 'mission', name: 'Repo Season', giver: 'dez',
  blurb: 'A customer\'s Vireo GT was "repossessed" by a tow outfit with no licence and a very nice hangar. Dez wants it back before the paint dries on the new plates.',
  start: [2430, Y, 3174], startSpots: row(2424.5, 3172.5), startYaw: 0,
  unlock: { requires: ['story_2'] }, minPlayers: 1, maxPlayers: 4, lateJoin: 'roster_reconnect', replayable: true, music: 'roam_1',
  notes: [
    'Solo: one guard on the apron; the two breaker panels must be thrown within 20 s of each other (sprint between them). Party: extra guards patrol in, but the panels become a real both-at-once job - 3 s window.',
    'Guards trip the alarm if they see you. A stun pistol drops a guard for 20 s. If the alarm goes, the police join in and you must lose them before the drop-off.',
    'Checkpoints: the apron arrival and the stolen car. Late join: disconnected players may rejoin for 90 s; nobody new joins mid-mission.',
  ],
  stages: [
    {
      id: 'wheels', title: 'Borrow the Hauler', cutscene: 'repo_intro', checkpoint: true, respawn: row(2424.5, 3172.5),
      spawn: [
        { id: 'hauler', kind: 'vehicle', model: 'pickup', pos: [2412, Y, 3166.5], yaw: Math.PI / 2, color: 0x2e4057, label: 'Bayou Hauler' },
        { id: 'ride2', kind: 'vehicle', model: 'compact', pos: [2428, Y, 3166.5], yaw: Math.PI / 2, color: 0xf2c14e, minParty: 2, label: "Dez's spare hatch" },
      ],
      objectives: [{ type: 'enter_vehicle', id: 'enter', label: 'Get in the Bayou Hauler', vehicles: ['hauler', 'ride2'], who: 'any' }],
      fail: [{ type: 'vehicle_destroyed', vehicle: 'hauler' }],
    },
    {
      id: 'approach', title: 'Solano Airfield',
      objectives: [{ type: 'reach', id: 'gate', label: 'Drive to the airfield service road', pos: [2236.5, Y, 3295.5], r: 14, who: 'any' }],
      fail: [{ type: 'vehicle_destroyed', vehicle: 'hauler' }],
      lines: [{ speaker: 'Dez', text: 'Hangar apron, south side of the field. The guards walk a loop. They are bored and they are armed. Be polite.' }],
    },
    {
      id: 'lights', title: 'Kill the floodlights', checkpoint: true, respawn: row(2236.5, 3295.5),
      spawn: [
        { id: 'repo', kind: 'vehicle', model: 'sports', pos: [2224, Y, AF.z + 5.5], yaw: 0, color: 0xd7263d, label: 'Customer Vireo GT' },
        { id: 'g1', kind: 'guard', patrol: [[2204.5, Y, AF.z], [2248.5, Y, AF.z]] },
        { id: 'g2', kind: 'guard', patrol: [[2200.5, Y, AF.z + 10], [2250.5, Y, AF.z + 10]], minParty: 2 },
        { id: 'g3', kind: 'guard', patrol: [[2262.5, Y, AF.z], [2262.5, Y, AF.z + 11]], minParty: 3 },
        { id: 'g4', kind: 'guard', patrol: [[2190.5, Y, AF.z], [2190.5, Y, AF.z + 11]], minParty: 4 },
        { id: 'kp_a', kind: 'object', obj: 'keypad', pos: [2202.5, Y, 3299.5], label: 'Floodlight breaker A', hold: 2 },
        { id: 'kp_b', kind: 'object', obj: 'keypad', pos: [2246.5, Y, 3299.5], label: 'Floodlight breaker B', hold: 2 },
      ],
      objectives: [{ type: 'interact', id: 'breakers', label: 'Throw both floodlight breakers together', targets: ['kp_a', 'kp_b'], simultaneous: { window: 3, soloWindow: 20 } }],
      fail: [{ type: 'all_down' }, { type: 'vehicle_destroyed', vehicle: 'hauler' }],
      lines: [{ speaker: 'Dez', text: 'Two breaker panels, one at each end of the apron. Kill the lights together or the backup kicks right back in.' }],
    },
    {
      id: 'wire', title: 'Hotwire the Vireo',
      spawn: [{ id: 'wire', kind: 'object', obj: 'lock', pos: [2222.5, Y, AF.z + 4], label: 'Hotwire the Vireo', hold: 6 }],
      objectives: [{ type: 'interact', id: 'wire', label: 'Hotwire the customer\'s Vireo GT', targets: ['wire'] }],
      fail: [{ type: 'all_down' }],
    },
    {
      id: 'take', title: 'Take the car', checkpoint: true, respawn: row(2236.5, 3295.5),
      objectives: [{ type: 'enter_vehicle', id: 'take', label: 'Drive the Vireo GT off the apron', vehicles: ['repo'], who: 'any' }],
      fail: [{ type: 'all_down' }, { type: 'vehicle_destroyed', vehicle: 'repo' }],
    },
    {
      id: 'heat', title: 'Lose the heat', when: { wanted: true },
      objectives: [{ type: 'lose_wanted', id: 'lose', label: 'Lose the police' }],
      fail: [{ type: 'all_down' }, { type: 'vehicle_destroyed', vehicle: 'repo' }],
    },
    {
      id: 'garage', title: 'Back to Torque & Tide',
      timeLimit: [150, 150, 150, 150],
      objectives: [{ type: 'reach', id: 'bay', label: 'Drive the Vireo into the Torque & Tide garage', pos: [2430.5, Y, 3186], r: 6, who: 'any', vehicle: 'repo' }],
      fail: [{ type: 'timer' }, { type: 'vehicle_destroyed', vehicle: 'repo' }],
    },
    {
      id: 'outro', title: 'Paint job', cutscene: 'repo_outro',
      objectives: [{ type: 'wait', id: 'beat', label: 'Dez has the car on the lift', seconds: 0.5 }],
    },
  ],
  rewards: { cash: [2200, 2300, 2400, 2500], rep: 140, replayCash: 600, unlocks: ['story_4', 'mini_trial'] },
};

// ═══════════════════════════════════════════════════════════════════ STORY 4
const warmup: V3[] = [[2496, Y, 3168], [2496, Y, 3120], [2544, Y, 3120], [2592, Y, 3120], [2592, Y, 3168], [2592, Y, 3216], [2544, Y, 3216], [2496, Y, 3216]];
const story4: ActivityDef = {
  id: 'story_4', kind: 'mission', name: 'Neon Warm-Up', giver: 'kilo',
  blurb: 'DJ Kilo runs the street scene from the Neon Lagoon booth. Before anybody lets you on the grid, you hang flyers, you sit in a Vireo, and you do not hit the fountain.',
  start: [2568, Y, 3174], startSpots: row(2562.5, 3172.5), startYaw: 0,
  unlock: { requires: ['story_3'] }, minPlayers: 1, maxPlayers: 4, lateJoin: 'roster_reconnect', replayable: true, music: 'race',
  notes: [
    'Solo: hang three flyers (the corner spots are marked), then run the two-lap warm-up against the clock. Party: four flyer spots, and everyone races at once in matching Vireo GTs.',
    'Racers are ghosts - no bumping. Checkpoints in order, two laps. The warm-up stage ends when everyone finishes or the 3-minute limit runs out; slow laps still count.',
    'Story pay does not depend on finishing first - the mission is the tutorial. Compete for medals in "Downtown Sprint" and the "Palm Mile Trial".',
    'Late join: disconnected racers can rejoin for 90 s but cannot restart their lap.',
  ],
  race: { competitive: false, parTimes: [34, 42, 54], vehicleModel: 'sports', startGrid: [[2536, Y, 3166], [2536, Y, 3170], [2526, Y, 3166], [2526, Y, 3170]] },
  stages: [
    {
      id: 'flyers', title: 'Flyers', cutscene: 'kilo_intro', checkpoint: true, respawn: row(2562.5, 3172.5),
      timeLimit: [130, 120, 110, 100],
      spawn: [
        { id: 'dart', kind: 'vehicle', model: 'compact', pos: [2576, Y, 3166.5], yaw: Math.PI / 2, color: 0x00bbf9, label: "Kilo's Dart" },
        { id: 'dart2', kind: 'vehicle', model: 'compact', pos: [2592, Y, 3166.5], yaw: Math.PI / 2, color: 0xf15bb5, minParty: 3, label: "Kilo's second Dart" },
        { id: 'fl_a', kind: 'object', obj: 'package', pos: [2453.5, Y, 3077.5], label: 'Hang a flyer', hold: 1.5 },
        { id: 'fl_b', kind: 'object', obj: 'package', pos: [2597.5, Y, 3125.5], label: 'Hang a flyer', hold: 1.5 },
        { id: 'fl_c', kind: 'object', obj: 'package', pos: [2549.5, Y, 3221.5], label: 'Hang a flyer', hold: 1.5 },
        { id: 'fl_d', kind: 'object', obj: 'package', pos: [2405.5, Y, 3221.5], label: 'Hang a flyer', hold: 1.5, minParty: 3 },
      ],
      objectives: [{ type: 'interact', id: 'flyers', label: 'Hang the Neon Lagoon flyers', targets: ['fl_a', 'fl_b', 'fl_c', 'fl_d'], count: [3, 3, 4, 4] }],
      fail: [{ type: 'timer' }],
      lines: [{ speaker: 'DJ Kilo', text: 'Flyers on the corners, then you earn a seat. Every street racer in Palmara reads those walls.' }],
    },
    {
      id: 'grid', title: 'The warm-up', checkpoint: true, respawn: row(2528, 3166.5, -2),
      spawn: [{ id: 'racecar', kind: 'vehicle', model: 'sports', pos: [2536, Y, 3166], yaw: Math.PI / 2, perPlayer: true, ghost: true, label: 'Warm-up Vireo' }],
      objectives: [{ type: 'checkpoints', id: 'cps', label: 'Warm-up: two laps', points: warmup, laps: 2, r: 9 }],
      timeLimit: [180, 180, 180, 180],
      fail: [{ type: 'timer' }],
      lines: [{ speaker: 'DJ Kilo', text: 'Lights on three. Hit every checkpoint, in order. The road is yours - the fountain is not.' }],
    },
    {
      id: 'park', title: 'Cool-down',
      objectives: [{ type: 'reach', id: 'club', label: 'Roll up to the Neon Lagoon', pos: [2568, Y, 3170], r: 9, who: 'any' }],
    },
    {
      id: 'outro', title: 'On the list', cutscene: 'kilo_outro',
      objectives: [{ type: 'wait', id: 'beat', label: 'Kilo adds you to the list', seconds: 0.5 }],
    },
  ],
  rewards: { cash: [1600, 1700, 1800, 1900], rep: 130, replayCash: 450, unlocks: ['story_5'] },
};

// ═══════════════════════════════════════════════════════════════════ STORY 5
const story5: ActivityDef = {
  id: 'story_5', kind: 'mission', name: 'Pier 9 After Dark', giver: 'nix',
  blurb: 'Every Vega crate that left the Sunny Side on a van came from the same Pier 9 warehouse. Nix wants the manifests, the ledger and a clean exit. You are the clean exit.',
  start: [2471.5, Y, 3221.5], startSpots: row(2467.5, 3221.5), startYaw: 0,
  unlock: { requires: ['story_4'] }, minPlayers: 1, maxPlayers: 4, lateJoin: 'roster_reconnect', replayable: true, music: 'heist_plan',
  notes: [
    'Stealth mission: guards trip the alarm if they see you. A stun pistol drops a guard for 20 s; other guards notice when they find a downed colleague. If the alarm goes you must lose the police on the way out.',
    'Solo: 2 guards, copy 2 manifests, and the two office terminals must be started within 25 s of each other (run from one to the other). Party: up to 4 guards, 3 manifests, and the terminals are a true both-at-once job.',
    'The side door lock takes 6 s. The shutter stays shut. Checkpoints: the side door and the manifests.',
    'Late join: disconnected crew can rejoin for 90 s; nobody new joins mid-mission.',
  ],
  stages: [
    {
      id: 'plan', title: 'Nix\'s plan', cutscene: 'pier9_intro', checkpoint: true, respawn: row(2467.5, 3221.5),
      spawn: [
        { id: 'ride', kind: 'vehicle', model: 'sedan', pos: [2490, Y, 3217.5], yaw: Math.PI / 2, color: 0x39ff88, label: "Nix's Meridian" },
        { id: 'ride2', kind: 'vehicle', model: 'sedan', pos: [2506, Y, 3217.5], yaw: Math.PI / 2, color: 0x2e4057, minParty: 3, label: 'Second Meridian' },
      ],
      objectives: [{ type: 'enter_vehicle', id: 'enter', label: "Get in Nix's Meridian", vehicles: ['ride', 'ride2'], who: 'any' }],
      fail: [{ type: 'vehicle_destroyed', vehicle: 'ride' }],
    },
    {
      id: 'bridge', title: 'Over the Port Bridge',
      objectives: [{ type: 'reach', id: 'island', label: 'Drive to the Pier 9 service road (Port Island)', pos: [2693.5, Y, 3222.5], r: 7, who: 'any' }],
      fail: [{ type: 'vehicle_destroyed', vehicle: 'ride' }],
      lines: [{ speaker: 'Nix (radio)', text: 'Side door on the east wall. Shutter is on a timer lock, ignore it. Guards loop the floor - count their steps.' }],
    },
    {
      id: 'sneak', title: 'Side door', checkpoint: true, respawn: row(2729.5, 3240.5, 0, 1),
      spawn: [
        { id: 'side', kind: 'door', door: 'warehouse.side_door', state: 'locked' },
        { id: 'shutter', kind: 'door', door: 'warehouse.shutter', state: 'locked' },
        { id: 'lock', kind: 'object', obj: 'lock', pos: [2729.5, Y, 3246.5], label: 'Pick the side-door lock', hold: 6 },
        { id: 'g1', kind: 'guard', patrol: [[2709.5, Y, 3228.5], [2722.5, Y, 3228.5]] },
        { id: 'g2', kind: 'guard', patrol: [[2714.5, Y, 3236.5], [2714.5, Y, 3243.5]] },
        { id: 'g3', kind: 'guard', patrol: [[2704.5, Y, 3250.5], [2712.5, Y, 3250.5]], minParty: 2 },
        { id: 'g4', kind: 'guard', patrol: [[2722.5, Y, 3236.5], [2722.5, Y, 3244.5]], minParty: 3 },
      ],
      objectives: [{ type: 'interact', id: 'pick', label: 'Pick the lock on the east side door', targets: ['lock'] }],
      fail: [{ type: 'all_down' }],
    },
    {
      id: 'manifests', title: 'Crate manifests', checkpoint: true, respawn: row(2729.5, 3240.5, 0, 1),
      onEnter: { doors: { side: 'open' } },
      spawn: [
        { id: 'ev_a', kind: 'object', obj: 'evidence', pos: [2708.5, Y, 3235.5], label: 'Crate manifest', hold: 2 },
        { id: 'ev_b', kind: 'object', obj: 'evidence', pos: [2713.5, Y, 3241.5], label: 'Crate manifest', hold: 2 },
        { id: 'ev_c', kind: 'object', obj: 'evidence', pos: [2703.5, Y, 3246.5], label: 'Crate manifest', hold: 2, minParty: 3 },
        { id: 'ev_d', kind: 'object', obj: 'evidence', pos: [2716.5, Y, 3247.5], label: 'Crate manifest', hold: 2, minParty: 4 },
      ],
      objectives: [{ type: 'interact', id: 'manifests', label: 'Photograph the crate manifests', targets: ['ev_a', 'ev_b', 'ev_c', 'ev_d'], count: [2, 2, 3, 4] }],
      fail: [{ type: 'all_down' }],
      lines: [{ speaker: 'Nix (radio)', text: 'Every manifest says "fresh produce" and weighs like a bank vault. Photograph three, I will do the rest from the office.' }],
    },
    {
      id: 'terminal', title: 'The office terminal',
      spawn: [
        { id: 'term_a', kind: 'object', obj: 'keypad', pos: [2722.5, Y, 3248.5], label: 'Office terminal: copy the ledger', hold: 4 },
        { id: 'term_b', kind: 'object', obj: 'keypad', pos: [2725.5, Y, 3248.5], label: 'Office terminal: wipe the access log', hold: 4 },
      ],
      objectives: [{ type: 'interact', id: 'terms', label: 'Run both terminals at the same time', targets: ['term_a', 'term_b'], simultaneous: { window: 3, soloWindow: 25 } }],
      fail: [{ type: 'all_down' }],
      lines: [{ speaker: 'Nix (radio)', text: 'Two sessions at once - one copies, one scrubs. If they overlap I own the box. If not, the logs scream.' }],
    },
    {
      id: 'out', title: 'Slip out', checkpoint: true, respawn: row(2729.5, 3240.5, 0, 1),
      objectives: [{ type: 'reach', id: 'out', label: 'Get back to the service road', pos: [2693.5, Y, 3222.5], r: 7, who: 'all' }],
      fail: [{ type: 'all_down' }],
    },
    {
      id: 'heat', title: 'Lose the heat', when: { alarm: true, wanted: true },
      objectives: [{ type: 'lose_wanted', id: 'lose', label: 'Lose the police' }],
      fail: [{ type: 'all_down' }],
    },
    {
      id: 'outro', title: 'What the ledger says', cutscene: 'pier9_outro',
      objectives: [{ type: 'wait', id: 'beat', label: 'Nix reads the ledger', seconds: 0.5 }],
    },
  ],
  rewards: { cash: [2600, 2700, 2800, 2900], rep: 150, replayCash: 700, unlocks: ['story_6', 'prep_pier9_recon', 'prep_pier9_keys', 'prep_pier9_skiff'] },
};

// ═══════════════════════════════════════════════════════════════════ STORY 6
const story6: ActivityDef = {
  id: 'story_6', kind: 'mission', name: 'Heat Index', giver: 'marisol',
  blurb: 'Someone at the port told the police exactly who walked out of Pier 9. Marisol needs the copied ledger scattered across downtown before the cars arrive.',
  start: [2519.5, Y, 3175.5], startSpots: row(2516.5, 3172.5), startYaw: 0,
  unlock: { requires: ['story_5'] }, minPlayers: 1, maxPlayers: 4, lateJoin: 'roster_reconnect', replayable: true, music: 'heist_action',
  notes: [
    'The police are on you the moment you leave the diner (three stars). Everyone in the crew shares the same wanted level.',
    'Solo: scatter two memory drives at the dead drops, then shake the heat. Party: one more drop per extra player - cover the corners in parallel, but each drop adds to the heat.',
    'Lose the police completely, then everyone has to be back inside the Torque & Tide garage. If the lead car is wrecked or time runs out the mission fails; checkpoints: the car, the drops.',
    'Late join: disconnected players can rejoin for 90 s. Nobody new joins mid-mission.',
  ],
  stages: [
    {
      id: 'wheels', title: 'The getaway car', cutscene: 'heat_intro', checkpoint: true, respawn: row(2538, 3173.5),
      spawn: [
        { id: 'gt', kind: 'vehicle', model: 'sports', pos: [2536, Y, 3166.5], yaw: Math.PI / 2, color: 0x222831, label: 'Black Vireo GT' },
        { id: 'ride2', kind: 'vehicle', model: 'sedan', pos: [2552, Y, 3166.5], yaw: Math.PI / 2, color: 0x2e4057, minParty: 2, label: 'Second car' },
      ],
      objectives: [{ type: 'enter_vehicle', id: 'enter', label: 'Get in the black Vireo GT', vehicles: ['gt', 'ride2'], who: 'any' }],
      fail: [{ type: 'vehicle_destroyed', vehicle: 'gt' }],
    },
    {
      id: 'drops', title: 'Scatter the drives', checkpoint: true, respawn: row(2538, 3173.5), onEnter: { wanted: 3 },
      timeLimit: [270, 250, 230, 210],
      spawn: [
        { id: 'dd_a', kind: 'object', obj: 'package', pos: [2597.5, Y, 3077.5], label: 'Dead drop: drain grate', hold: 1.6 },
        { id: 'dd_b', kind: 'object', obj: 'package', pos: [2405.5, Y, 3125.5], label: 'Dead drop: bus stop', hold: 1.6 },
        { id: 'dd_c', kind: 'object', obj: 'package', pos: [2597.5, Y, 3221.5], label: 'Dead drop: planter', hold: 1.6, minParty: 3 },
        { id: 'dd_d', kind: 'object', obj: 'package', pos: [2405.5, Y, 3221.5], label: 'Dead drop: newspaper box', hold: 1.6, minParty: 4 },
      ],
      objectives: [{ type: 'interact', id: 'drops', label: 'Leave the memory drives at the dead drops', targets: ['dd_a', 'dd_b', 'dd_c', 'dd_d'], count: [2, 2, 3, 4] }],
      fail: [{ type: 'timer' }, { type: 'all_down' }, { type: 'vehicle_destroyed', vehicle: 'gt' }],
      lines: [{ speaker: 'Marisol (phone)', text: 'Three stars and climbing. Drop the drives, shake them, then home. Do not stop to explain yourself to anyone in a uniform.' }],
    },
    {
      id: 'shake', title: 'Lose the police', checkpoint: true, respawn: row(2538, 3173.5),
      objectives: [{ type: 'lose_wanted', id: 'lose', label: 'Lose the police' }],
      fail: [{ type: 'all_down' }, { type: 'vehicle_destroyed', vehicle: 'gt' }],
    },
    {
      id: 'hide', title: 'Go to ground',
      timeLimit: [200, 200, 200, 200],
      objectives: [{ type: 'reach', id: 'garage', label: 'Everyone into the Torque & Tide garage', pos: [2430.5, Y, 3186], r: 8, who: 'all' }],
      fail: [{ type: 'timer' }, { type: 'all_down' }],
    },
    {
      id: 'outro', title: 'Cooling off', cutscene: 'heat_outro',
      objectives: [{ type: 'wait', id: 'beat', label: 'Dez pulls the shutter down', seconds: 0.5 }],
    },
  ],
  rewards: { cash: [2800, 2900, 3000, 3100], rep: 160, replayCash: 800, unlocks: ['story_7', 'mini_boatrace'] },
};

// ═══════════════════════════════════════════════════════════════════ STORY 7
const story7: ActivityDef = {
  id: 'story_7', kind: 'mission', name: 'Dead Reckoning', giver: 'barney',
  blurb: 'The last line in the ledger is an address on Last Key. Captain Quill will take you there - by boat, by night, avoiding the gulls.',
  start: [2827.5, Y, 3243.5], startSpots: row(2827.5, 3239.5, 0, 2), startYaw: -Math.PI / 2,
  unlock: { requires: ['story_6'] }, minPlayers: 1, maxPlayers: 4, lateJoin: 'roster_reconnect', replayable: true, music: 'roam_1',
  notes: [
    'The Port Solano lagoon is sealed by causeways - the open sea is on the Atlantic side of Solano Beach, which is where Barney keeps his boat.',
    'About 90 seconds of open water each way at full throttle. Keep clear of the Overseas Causeway piers; the course marks a safe lane.',
    'Solo: one boat, steer and shoot the breeze. Party: a second boat for crews of three or more - ride together or split up; a leg is complete as soon as any crew member reaches the marker. The mission fails only if the Quill herself is wrecked.',
    'On Conch Harbor: gather the Vega shipping receipts (two for solo/duo, three or four for bigger crews). Mission ends there - you are returned to where you started.',
    'Late join: disconnected players can rejoin for 90 s but must catch up by swimming - nobody new joins mid-mission.',
  ],
  stages: [
    {
      id: 'board', title: 'The Quill', cutscene: 'barney_intro', checkpoint: true, respawn: row(2827.5, 3239.5, 0, 2),
      spawn: [
        { id: 'tub', kind: 'vehicle', model: 'boat', pos: [2838, 21, 3243], yaw: -Math.PI / 2, color: 0x4cc9f0, label: 'The Quill' },
        { id: 'tub2', kind: 'vehicle', model: 'boat', pos: [2838, 21, 3251], yaw: -Math.PI / 2, color: 0xf2c14e, minParty: 3, label: 'Second boat' },
      ],
      objectives: [{ type: 'enter_vehicle', id: 'enter', label: 'Climb aboard the Quill', vehicles: ['tub', 'tub2'], who: 'any' }],
      fail: [{ type: 'vehicle_destroyed', vehicle: 'tub' }],
    },
    {
      id: 'leg1', title: 'Clear the breakwater',
      timeLimit: [90, 90, 90, 90],
      objectives: [{ type: 'reach', id: 'w_leg1', label: 'Head out past the breakwater', pos: [2868, 21, 3318], r: 16, who: 'any' }],
      fail: [{ type: 'timer' }, { type: 'vehicle_destroyed', vehicle: 'tub' }],
      lines: [{ speaker: 'Barney', text: 'Keep her low and quiet. The gulls on that buoy are not gulls.' }],
    },
    {
      id: 'leg2', title: 'Round the south tip',
      timeLimit: [90, 90, 90, 90],
      objectives: [{ type: 'reach', id: 'w_leg2', label: 'Round the south tip of Solano Beach', pos: [2810, 21, 3492], r: 18, who: 'any' }],
      fail: [{ type: 'timer' }, { type: 'vehicle_destroyed', vehicle: 'tub' }],
    },
    {
      id: 'leg3', title: 'Across Florida Bay',
      timeLimit: [150, 150, 150, 150],
      objectives: [{ type: 'reach', id: 'w_leg3', label: 'Open water: head for the Coral Keys', pos: [2162, 21, 4062], r: 22, who: 'any' }],
      fail: [{ type: 'timer' }, { type: 'vehicle_destroyed', vehicle: 'tub' }],
    },
    {
      id: 'leg4', title: 'Into the Keys',
      timeLimit: [70, 70, 70, 70],
      objectives: [{ type: 'reach', id: 'w_leg4', label: 'Follow the keys south-west', pos: [2006, 21, 4146], r: 22, who: 'any' }],
      fail: [{ type: 'timer' }, { type: 'vehicle_destroyed', vehicle: 'tub' }],
    },
    {
      id: 'leg5', title: 'Under the causeway',
      timeLimit: [70, 70, 70, 70],
      objectives: [{ type: 'reach', id: 'w_leg5', label: 'Keep clear of the causeway piers', pos: [1850, 21, 4206], r: 22, who: 'any' }],
      fail: [{ type: 'timer' }, { type: 'vehicle_destroyed', vehicle: 'tub' }],
    },
    {
      id: 'leg6', title: 'Last Key in sight',
      timeLimit: [90, 90, 90, 90],
      objectives: [{ type: 'reach', id: 'w_leg6', label: 'Make for the island lights', pos: [1496, 21, 4278], r: 22, who: 'any' }],
      fail: [{ type: 'timer' }, { type: 'vehicle_destroyed', vehicle: 'tub' }],
    },
    {
      id: 'dock', title: 'Conch Harbor',
      timeLimit: [70, 70, 70, 70],
      objectives: [{ type: 'reach', id: 'w_dock', label: 'Bring the Quill in to Conch Harbor', pos: [1388, 21, 4290], r: 10, who: 'any' }],
      fail: [{ type: 'timer' }, { type: 'vehicle_destroyed', vehicle: 'tub' }],
    },
    {
      id: 'ashore', title: 'Last Key', cutscene: 'conch_arrival', checkpoint: true, respawn: row(1360.5, 4286.5, 0, 2),
      timeLimit: [240, 220, 200, 200],
      spawn: [
        { id: 'rc_a', kind: 'object', obj: 'evidence', pos: [1356.5, Y, 4283.5], label: 'Shipping receipt', hold: 2 },
        { id: 'rc_b', kind: 'object', obj: 'evidence', pos: [1350.5, Y, 4296.5], label: 'Shipping receipt', hold: 2 },
        { id: 'rc_c', kind: 'object', obj: 'evidence', pos: [1362.5, Y, 4300.5], label: 'Shipping receipt', hold: 2, minParty: 3 },
        { id: 'rc_d', kind: 'object', obj: 'evidence', pos: [1346.5, Y, 4306.5], label: 'Shipping receipt', hold: 2, minParty: 4 },
      ],
      objectives: [{ type: 'interact', id: 'receipts', label: 'Collect the Vega shipping receipts', targets: ['rc_a', 'rc_b', 'rc_c', 'rc_d'], count: [2, 2, 3, 4] }],
      fail: [{ type: 'timer' }, { type: 'all_down' }],
    },
    {
      id: 'outro', title: 'Not alone', cutscene: 'conch_outro',
      objectives: [{ type: 'wait', id: 'beat', label: 'Barney spots something on the water', seconds: 0.5 }],
    },
  ],
  rewards: { cash: [3200, 3300, 3400, 3500], rep: 170, replayCash: 900, unlocks: ['story_8'] },
};

// ═══════════════════════════════════════════════════════════════════ STORY 8
const story8: ActivityDef = {
  id: 'story_8', kind: 'mission', name: 'Open Books', giver: 'marisol',
  blurb: 'Marisol, Lena, Nix and Dez: one night, three locations. Take the Vega ledger from its own office, outrun the cops, and hand it to the one honest sergeant in Solano County.',
  start: [2519.5, Y, 3175.5], startSpots: row(2516.5, 3172.5), startYaw: 0,
  unlock: { requires: ['story_7', 'heist_sundial'] }, minPlayers: 1, maxPlayers: 4, lateJoin: 'roster_reconnect', replayable: true, music: 'heist_action',
  notes: [
    'Four acts: Vega & Sons Imports (stealth), the escape, Pier 9 (Grebe\'s last cargo), and the drive to the police station.',
    'Solo: shoot out two lobby cameras, pick the private-office lock, throw both vault panels within 20 s of each other. Party: three cameras and a real 3 s both-at-once panel job; extra guards patrol in for 2+ players.',
    'The alarm trips if a guard sees you; the police join the chase anyway after the ledger is taken. Checkpoints: the lobby, the ledger, the dock.',
    'A story mission: crew members who already finished it earn replay cash. Late join: disconnected players can rejoin for 90 s.',
  ],
  stages: [
    {
      id: 'plan', title: 'The plan', cutscene: 'finale_intro', checkpoint: true, respawn: row(2538, 3173.5),
      spawn: [
        { id: 'van', kind: 'vehicle', model: 'van', pos: [2536, Y, 3166.5], yaw: Math.PI / 2, color: 0x39ff88, label: "Nix's van" },
        { id: 'van2', kind: 'vehicle', model: 'sedan', pos: [2552, Y, 3166.5], yaw: Math.PI / 2, color: 0x222831, minParty: 3, label: 'Second car' },
      ],
      objectives: [{ type: 'enter_vehicle', id: 'enter', label: "Get in Nix's van", vehicles: ['van', 'van2'], who: 'any' }],
      fail: [{ type: 'vehicle_destroyed', vehicle: 'van' }],
    },
    {
      id: 'arrive', title: 'Vega & Sons',
      objectives: [{ type: 'reach', id: 'front', label: 'Pull up outside Vega & Sons Imports', pos: [2519.5, Y, 3077.5], r: 7, who: 'any' }],
      fail: [{ type: 'vehicle_destroyed', vehicle: 'van' }],
    },
    {
      id: 'cameras', title: 'Blind the lobby', checkpoint: true, respawn: row(2517.5, 3077.5),
      spawn: [
        { id: 'g1', kind: 'guard', patrol: [[2507.5, Y, 3086.5], [2530.5, Y, 3086.5]] },
        { id: 'g2', kind: 'guard', patrol: [[2507.5, Y, 3094.5], [2514.5, Y, 3094.5]], minParty: 2 },
        { id: 'g3', kind: 'guard', patrol: [[2531.5, Y, 3092.5], [2531.5, Y, 3097.5]], minParty: 3 },
        { id: 'cam_a', kind: 'object', obj: 'target', pos: [2509.5, Y, 3084.5], label: 'Lobby camera', hold: 0 },
        { id: 'cam_b', kind: 'object', obj: 'target', pos: [2529.5, Y, 3084.5], label: 'Lobby camera', hold: 0 },
        { id: 'cam_c', kind: 'object', obj: 'target', pos: [2519.5, Y, 3088.5], label: 'Lobby camera', hold: 0, minParty: 2 },
        { id: 'office', kind: 'door', door: 'office.office_door', state: 'locked' },
      ],
      objectives: [{ type: 'shoot', id: 'cams', label: 'Shoot out the lobby cameras with the stun pistol', targets: ['cam_a', 'cam_b', 'cam_c'], count: [2, 3, 3, 3] }],
      fail: [{ type: 'all_down' }],
      lines: [{ speaker: 'Nix (radio)', text: 'Cameras first. I can loop the feed for about ninety seconds. You are on the clock.' }],
    },
    {
      id: 'lock', title: 'Private office',
      spawn: [{ id: 'lk', kind: 'object', obj: 'lock', pos: [2526.5, Y, 3097.5], label: 'Pick the private-office lock', hold: 5 }],
      objectives: [{ type: 'interact', id: 'lk', label: 'Pick the private-office lock', targets: ['lk'] }],
      fail: [{ type: 'all_down' }],
    },
    {
      id: 'panels', title: 'Vault panels', onEnter: { doors: { office: 'open' } },
      spawn: [
        { id: 'pn_a', kind: 'object', obj: 'keypad', pos: [2527.5, Y, 3101.5], label: 'Vault panel A', hold: 3 },
        { id: 'pn_b', kind: 'object', obj: 'keypad', pos: [2531.5, Y, 3101.5], label: 'Vault panel B', hold: 3 },
      ],
      objectives: [{ type: 'interact', id: 'panels', label: 'Open both vault panels together', targets: ['pn_a', 'pn_b'], simultaneous: { window: 3, soloWindow: 20 } }],
      fail: [{ type: 'all_down' }],
    },
    {
      id: 'ledger', title: 'The ledger', checkpoint: true, respawn: row(2517.5, 3077.5),
      spawn: [{ id: 'ledger', kind: 'object', obj: 'evidence', pos: [2531.5, Y, 3105.5], label: "Take Vega's ledger", hold: 4 }],
      objectives: [{ type: 'interact', id: 'ledger', label: "Take Vega's ledger", targets: ['ledger'] }],
      fail: [{ type: 'all_down' }],
    },
    {
      id: 'run', title: 'Outrun the cops', onEnter: { wanted: 3 },
      objectives: [{ type: 'lose_wanted', id: 'lose', label: 'Lose the police' }],
      fail: [{ type: 'all_down' }, { type: 'vehicle_destroyed', vehicle: 'van' }],
      lines: [{ speaker: 'Lena (radio)', text: 'Vega called it in the second you touched the safe. Three stars. Pier 9 next - Grebe is loading the second copy.' }],
    },
    {
      id: 'quay', title: 'Pier 9', checkpoint: true, respawn: row(2693.5, 3222.5, 0, 2),
      objectives: [{ type: 'reach', id: 'quay', label: 'Drive to the Pier 9 loading dock', pos: [2693.5, Y, 3226.5], r: 8, who: 'any' }],
      fail: [{ type: 'all_down' }],
    },
    {
      id: 'grebe', title: "Grebe's cargo", checkpoint: true, respawn: row(2693.5, 3222.5, 0, 2),
      timeLimit: [220, 210, 200, 190],
      spawn: [
        { id: 'inspector', kind: 'npc', role: 'inspector', pos: [2729.5, Y, 3238.5], yaw: Math.PI, name: 'H. Grebe' },
        { id: 'p1', kind: 'guard', patrol: [[2729.5, Y, 3226.5], [2729.5, Y, 3242.5]] },
        { id: 'p2', kind: 'guard', patrol: [[2711.5, Y, 3222.5], [2721.5, Y, 3222.5]], minParty: 2 },
        { id: 'p3', kind: 'guard', patrol: [[2693.5, Y, 3240.5], [2693.5, Y, 3254.5]], minParty: 3 },
        { id: 'brief', kind: 'object', obj: 'evidence', pos: [2731.5, Y, 3237.5], label: "Grebe's briefcase", hold: 3 },
      ],
      objectives: [{ type: 'interact', id: 'brief', label: "Take Grebe's briefcase", targets: ['brief'] }],
      fail: [{ type: 'timer' }, { type: 'all_down' }],
      lines: [{ speaker: 'Grebe', text: 'This is a restricted area. Do you have a permit? A form? A reason to be standing in my paperwork?' }],
    },
    {
      id: 'precinct', title: 'To the precinct',
      timeLimit: [200, 200, 200, 200],
      onEnter: { wanted: 2 },
      objectives: [{ type: 'reach', id: 'precinct', label: 'Get both ledgers to Sgt. Okafor at the Central Precinct', pos: [2423.5, Y, 3078.5], r: 6, who: 'all' }],
      fail: [{ type: 'timer' }, { type: 'all_down' }],
    },
    {
      id: 'outro', title: 'Open books', cutscene: 'finale_outro',
      objectives: [{ type: 'wait', id: 'beat', label: 'Okafor opens the ledger', seconds: 0.5 }],
    },
  ],
  rewards: { cash: [6000, 6500, 7000, 7500], rep: 300, replayCash: 1500, unlocks: [] },
};

export const STORY_ACTIVITIES: ActivityDef[] = [story2, story3, story4, story5, story6, story7, story8];

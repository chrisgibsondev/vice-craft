/**
 * The three flagship heists and their setup missions. Merged into ACTIVITIES by activities.ts.
 *
 *   heist_sundial  "The Sundial Job"      requires story_1                setups: scout, wheels*, uniforms (opt, con), rota (opt)
 *   heist_pier9    "The Pier 9 Shuffle"   requires heist_sundial+story_5  setups: recon, keys, exit*, lights (opt), overalls (opt, con)
 *   heist_tower    "The Vega Tower Job"   requires heist_pier9+story_7    setups: plans, convoy, boat, ledger kit*, armour (opt), badges (opt, con)
 *   (* = setup with a CHOICE that changes the finale)
 *
 * Lena Voss plans every job and talks the crew through every setup and finale; Nix is her tech.
 * Setups count for the crew leader who owns the heist (profile.preps[heist]); choices are stored there as
 * `choice:<key>=<option>` entries and frozen into the run at launch together with the approach, difficulty,
 * equipment, roles and cuts. The runner (apps/server/src/activities/runner.ts) does the rest.
 */
import type { ActivityDef, StageDef, DialogueLine, SpawnDef, V3, BySize, SetupDef } from './activityTypes.ts';
import { Y, row } from './story.ts';

type Prep = ActivityDef & { prepFor: string };
const L = (text: string): DialogueLine => ({ speaker: 'Lena (radio)', text });
const N = (text: string): DialogueLine => ({ speaker: 'Nix (radio)', text });
const say = (speaker: string, text: string): DialogueLine => ({ speaker, text });
const debrief = (cs: string, when?: StageDef['when'], id = 'debrief'): StageDef => ({ id, title: 'Debrief', cutscene: cs, when, objectives: [{ type: 'wait', id: 'wrap', label: 'Debrief with Lena', seconds: 0.1 }] });
const brief = (cs: string): StageDef => ({ id: 'brief', title: 'The plan', cutscene: cs, objectives: [{ type: 'wait', id: 'listen', label: 'Listen to Lena', seconds: 0.1 }] });
const heat = (fail: StageDef['fail'] = [{ type: 'all_down' }]): StageDef => ({ id: 'heat', title: 'Lose the heat', when: { wanted: true }, traffic: true, objectives: [{ type: 'lose_wanted', id: 'lose', label: 'Lose the police' }], fail, lines: [L('You have a tail. Lose it before you lead them to my lockup.')] });
const prepBase = (p: Omit<Prep, 'kind' | 'giver' | 'minPlayers' | 'maxPlayers' | 'lateJoin' | 'replayable'>): Prep => ({ kind: 'heist_prep', giver: 'lena', minPlayers: 1, maxPlayers: 4, lateJoin: 'roster_reconnect', replayable: true, ...p });
const enforcer = (id: string, at: V3, name: string, extra: Partial<SpawnDef> = {}): SpawnDef => ({ id, kind: 'guard', patrol: [at, [at[0] + 1, at[1], at[2]]], armed: true, enforcer: true, hp: 120, name, ...extra } as SpawnDef);
const LOCKUP: V3 = [2471.5, Y, 3221.5];

/** planner radio for events, shared by every heist and its setups */
const LENA_RADIO = {
  alarm: [L('That is the alarm. The policy just changed: grab what you can carry and go.'), L('Alarm. Do not panic, panic is not covered.')],
  loot: [L('First piece in the bag. Keep it on you, a bag on the floor is worth nothing.'), N('Ka-ching. Sorry. I promised Lena I would stop saying ka-ching.')],
  down: [L('Crew member down. Whoever is closest, pick up what they dropped.'), N('Someone is napping on the floor. Grab their bag!')],
  timeLow: [L('Thirty seconds. Finish the line you are on and move.'), N('Clock is nearly out. I am not panicking, my keyboard is.')],
  wave: [L('Response team inbound. Find cover, keep the bags.'), N('More guards. They brought friends. Rude.')],
};

// ═══════════════════════════════════════════════════════════════════ HEIST 1: THE SUNDIAL JOB
const J = { x: 2496, z: 3120 }; // Sundial Jewelers lot origin
const prepScout = prepBase({
  id: 'prep_sundial_scout', prepFor: 'heist_sundial', name: 'Sundial Setup: Case the Joint',
  blurb: 'Photograph the jewellery store\'s front cameras, the back door and the alarm-company sticker. Lena wants a site survey, not a selfie.',
  start: [2512, Y, 3112], startSpots: [[2510, Y, 3110], [2513, Y, 3110], [2516, Y, 3110], [2519, Y, 3110]], startYaw: Math.PI,
  unlock: { requires: ['story_1'] },
  notes: ['Required setup. Counts toward The Sundial Job for the crew leader who owns the heist.', 'Split up to photograph faster. Solo and co-op: the same three photos.'],
  stages: [
    {
      id: 'photos', title: 'Case the joint', cutscene: 'sd_scout_in', timeLimit: [180, 150, 150, 150],
      spawn: [
        { id: 'ph_front', kind: 'object', obj: 'photo', pos: [2512.5, Y, 3127.5], label: 'Photograph the cameras', hold: 1.5 },
        { id: 'ph_back', kind: 'object', obj: 'photo', pos: [2526.5, Y, 3157.5], label: 'Photograph the back door', hold: 1.5 },
        { id: 'ph_side', kind: 'object', obj: 'photo', pos: [2537.5, Y, 3140.5], label: 'Photograph the alarm sticker', hold: 1.5 },
      ],
      objectives: [{ type: 'interact', id: 'photos', label: 'Take the three photos', targets: ['ph_front', 'ph_back', 'ph_side'] }],
      fail: [{ type: 'timer' }],
      lines: [L('Three photos. Cameras out front, the back door, the alarm sticker on the east wall.')],
      events: { timeLow: [L('Thirty seconds. The night clerk is about to start his rounds.')] },
    },
    debrief('sd_scout_out'),
  ],
  rewards: { cash: [500, 500, 500, 500], rep: 30, replayCash: 250 },
});

const prepWheels = prepBase({
  id: 'prep_sundial_wheels', prepFor: 'heist_sundial', name: 'Sundial Setup: Getaway Wheels',
  blurb: 'Choose the getaway: a tourist\'s Vireo GT on Ocean Drive (fast, fragile, long run to Pier 9) or a Palm Armour training van on Port Island (slow, tough, short run to Dez). Steal it, lose the heat, park it at Torque & Tide.',
  start: [2470, Y, 3160], startSpots: [[2468, Y, 3160], [2471, Y, 3160], [2474, Y, 3160], [2477, Y, 3160]], startYaw: -Math.PI / 2,
  unlock: { requires: ['story_1'] },
  notes: ['Required setup with a CHOICE (picked by the leader in the lobby): the GT escapes fast to Pier 9; the van soaks damage and drives a short route to Dez\'s garage.', 'The car alarm brings a one-star response. Lose it before the drop-off. Party: a second ride for crews of 3+.'],
  stages: [
    brief('sd_wheels_in'),
    {
      id: 'go_gt', title: 'Find the GT', when: { choice: { getaway: 'gt' } },
      spawn: [
        { id: 'gt', kind: 'vehicle', model: 'sports', pos: [2797, Y, 3150], yaw: 0, color: 0xd7263d, label: 'Vireo GT' },
        { id: 'ride', kind: 'vehicle', model: 'sedan', pos: [2470, Y, 3166.5], yaw: -Math.PI / 2, color: 0x2e4057, label: 'Ride' },
        { id: 'ride2', kind: 'vehicle', model: 'sedan', pos: [2482, Y, 3166.5], yaw: -Math.PI / 2, color: 0x2e4057, minParty: 3, label: 'Ride' },
      ],
      objectives: [{ type: 'enter_vehicle', id: 'steal', label: 'Steal the Vireo GT on Ocean Drive', vehicles: ['gt'], who: 'any' }],
      fail: [{ type: 'vehicle_destroyed', vehicle: 'gt' }],
      lines: [L('Ocean Drive, red GT, owner on a sunset cruise. The alarm will chirp. Let it.')],
    },
    {
      id: 'heat_gt', title: 'Lose the heat', checkpoint: true, onEnter: { wanted: 1 }, when: { choice: { getaway: 'gt' } }, traffic: true,
      respawn: [[2797, Y, 3156], [2797, Y, 3160], [2797, Y, 3164], [2797, Y, 3168]],
      objectives: [{ type: 'lose_wanted', id: 'lose', label: 'Lose the police' }],
      fail: [{ type: 'vehicle_destroyed', vehicle: 'gt' }],
      lines: [L('One patrol car. Lose it on the back streets. Do not scratch the paint, Dez charges by the scratch.')],
    },
    {
      id: 'park_gt', title: 'Park it', when: { choice: { getaway: 'gt' } }, traffic: true,
      objectives: [{ type: 'reach', id: 'garage', label: 'Park the GT in the Torque & Tide garage', pos: [2430.5, Y, 3186], r: 6, who: 'any', vehicle: 'gt' }],
      fail: [{ type: 'vehicle_destroyed', vehicle: 'gt' }],
    },
    {
      id: 'go_van', title: 'Find the van', when: { choice: { getaway: 'van' } },
      spawn: [
        { id: 'van', kind: 'vehicle', model: 'van', pos: [2700, Y, 3214.5], yaw: Math.PI / 2, color: 0x6c757d, label: 'Palm Armour training van' },
        { id: 'ride_v', kind: 'vehicle', model: 'sedan', pos: [2470, Y, 3166.5], yaw: -Math.PI / 2, color: 0x2e4057, label: 'Ride' },
        { id: 'ride_v2', kind: 'vehicle', model: 'sedan', pos: [2482, Y, 3166.5], yaw: -Math.PI / 2, color: 0x2e4057, minParty: 3, label: 'Ride' },
        { id: 'yard_g', kind: 'guard', patrol: [[2711.5, Y, 3209.5], [2729.5, Y, 3209.5]], name: 'Yard watchman' },
      ],
      objectives: [{ type: 'enter_vehicle', id: 'steal', label: 'Take the training van from the Port Island yard', vehicles: ['van'], who: 'any' }],
      fail: [{ type: 'vehicle_destroyed', vehicle: 'van' }],
      lines: [L('Port Island yard. One watchman with a thermos and a grudge. The van is unlocked, which says a lot about Palm Armour.')],
    },
    {
      id: 'heat_van', title: 'Lose the heat', checkpoint: true, onEnter: { wanted: 1 }, when: { choice: { getaway: 'van' } }, traffic: true,
      respawn: [[2698, Y, 3209.5], [2700, Y, 3209.5], [2702, Y, 3209.5], [2704, Y, 3209.5]],
      objectives: [{ type: 'lose_wanted', id: 'lose', label: 'Lose the police' }],
      fail: [{ type: 'vehicle_destroyed', vehicle: 'van' }],
      lines: [L('The van has a tracker. Had. Nix says it now thinks it is in Ohio. Lose the patrol car.')],
    },
    {
      id: 'park_van', title: 'Park it', when: { choice: { getaway: 'van' } }, traffic: true,
      objectives: [{ type: 'reach', id: 'garage', label: 'Park the van in the Torque & Tide garage', pos: [2430.5, Y, 3186], r: 6, who: 'any', vehicle: 'van' }],
      fail: [{ type: 'vehicle_destroyed', vehicle: 'van' }],
    },
    debrief('sd_wheels_out'),
  ],
  rewards: { cash: [700, 700, 700, 700], rep: 30, replayCash: 300 },
});

const prepUniforms = prepBase({
  id: 'prep_sundial_uniforms', prepFor: 'heist_sundial', name: 'Sundial Setup: Alarm-Tech Uniforms',
  blurb: 'Brightwatch Alarms technicians get waved straight into Sundial. Lift two uniforms from their laundry car outside the Neon Lagoon, then have Threadline stitch new names on.',
  start: [2560, Y, 3160], startSpots: row(2556, 3160), startYaw: 0,
  unlock: { requires: ['story_1'] },
  notes: ['OPTIONAL setup. Unlocks the CON approach for The Sundial Job: walk in the front door as alarm technicians.', 'Stealth: the laundry driver trips a one-star alarm if he sees you. Party: a second driver walks the other side.'],
  stages: [
    {
      id: 'lift', title: 'Lift the uniforms', cutscene: 'sd_unif_in', timeLimit: [180, 170, 160, 150], skipOnAlarm: false,
      spawn: [
        { id: 'lcar', kind: 'vehicle', model: 'compact', pos: [2576, Y, 3214.5], yaw: Math.PI / 2, color: 0xf6f7f8, label: 'Brightwatch laundry car' },
        { id: 'drv', kind: 'guard', patrol: [[2569.5, Y, 3209.5], [2583.5, Y, 3209.5]], name: 'Laundry driver' },
        { id: 'drv2', kind: 'guard', patrol: [[2569.5, Y, 3221.5], [2583.5, Y, 3221.5]], minParty: 2, name: 'Second driver' },
        { id: 'u1', kind: 'object', obj: 'package', pos: [2573.5, Y, 3210.5], label: 'Brightwatch uniform', hold: 2 },
        { id: 'u2', kind: 'object', obj: 'package', pos: [2579.5, Y, 3210.5], label: 'Brightwatch uniform', hold: 2 },
      ],
      objectives: [{ type: 'interact', id: 'unif', label: 'Take two uniforms from the laundry car', targets: ['u1', 'u2'] }],
      fail: [{ type: 'timer' }, { type: 'all_down' }],
      lines: [L('He walks the car end to end. When his back is turned, take a uniform. When it is not, admire the club.')],
      events: { alarm: [say('Laundry driver', 'Hey! Those are company property! I am calling it in!'), L('Well. Now he is calling it in.')] },
    },
    { ...heat(), id: 'heat' },
    {
      id: 'tailor', title: 'Threadline', timeLimit: [160, 160, 150, 150],
      objectives: [{ type: 'reach', id: 'shop', label: 'Take the uniforms to Threadline', pos: [2567.5, Y, 3126.5], r: 4, who: 'any' }],
      fail: [{ type: 'timer' }],
      lines: [L('Threadline. Ask for Odette, say the word "hem". Do not say the word "heist".')],
    },
    debrief('sd_unif_out'),
  ],
  rewards: { cash: [600, 600, 600, 600], rep: 30, replayCash: 250 },
});

const prepRota = prepBase({
  id: 'prep_sundial_rota', prepFor: 'heist_sundial', name: 'Sundial Setup: The Guard Rota',
  blurb: 'Halvorsen Patrol\'s night supervisor eats at the Sunny Side every evening and leaves the guard rota on his car seat. Lift it, get it to Lena\'s lockup to be "amended".',
  start: [2519.5, Y, 3176], startSpots: [[2519.5, Y, 3176], [2521.5, Y, 3176], [2517.5, Y, 3176], [2523.5, Y, 3176]], startYaw: Math.PI,
  unlock: { requires: ['story_1'] },
  notes: ['OPTIONAL setup. On the night: one fewer guard inside Sundial and 20% more time on every finale timer.', 'Stealth: the supervisor (and his partner, for crews of 2+) walk the diner front. A spotted crew gets one star.'],
  stages: [
    {
      id: 'lift', title: 'Lift the rota', cutscene: 'sd_rota_in', timeLimit: [150, 140, 130, 120],
      spawn: [
        { id: 'scar', kind: 'vehicle', model: 'compact', pos: [2512, Y, 3166.5], yaw: Math.PI / 2, color: 0x1d3557, label: 'Halvorsen Patrol car' },
        { id: 'sup', kind: 'guard', patrol: [[2503.5, Y, 3174.5], [2514.5, Y, 3174.5]], name: 'Supervisor Halvorsen' },
        { id: 'partner', kind: 'guard', patrol: [[2526.5, Y, 3174.5], [2537.5, Y, 3174.5]], minParty: 2, name: 'Officer Lutz' },
        { id: 'rota', kind: 'object', obj: 'evidence', pos: [2512.5, Y, 3162.5], label: 'Lift the rota clipboard', hold: 2.5 },
      ],
      objectives: [{ type: 'interact', id: 'rota', label: 'Lift the guard rota from the patrol car', targets: ['rota'] }],
      fail: [{ type: 'timer' }, { type: 'all_down' }],
      lines: [L('He is walking off his pancakes. Car is on the street side. Approach from the road, not the window.')],
      events: { alarm: [say('Supervisor Halvorsen', 'Is that my clipboard? Put down my clipboard!'), L('He has seen you. He will also have to explain why his clipboard was on a car seat.')] },
    },
    { ...heat(), id: 'heat' },
    {
      id: 'copy', title: 'To the lockup', timeLimit: [150, 150, 150, 150],
      objectives: [{ type: 'reach', id: 'lock', label: 'Bring the rota to Lena\'s lockup', pos: LOCKUP, r: 3, who: 'any' }],
      fail: [{ type: 'timer' }],
      lines: [L('Bring it to the lockup. I have a pen that matches his handwriting. I have a lot of pens.')],
    },
    debrief('sd_rota_out'),
  ],
  rewards: { cash: [600, 600, 600, 600], rep: 30, replayCash: 250 },
});

const SUNDIAL_SETUPS: SetupDef[] = [
  { prep: 'prep_sundial_scout', category: 'scout', perk: 'Guard routes and the alarm keypads are marked on the night.' },
  { prep: 'prep_sundial_wheels', category: 'vehicle', perk: 'The getaway waits behind the store.', choice: { key: 'getaway', label: 'Getaway', options: [
    { id: 'gt', name: 'Vireo GT', desc: 'Fast and fragile. Long drive to the Pier 9 drop.' },
    { id: 'van', name: 'Palm Armour van', desc: 'Slow and tough (1600 hp). Short drive to Dez\'s garage.' },
  ] } },
  { prep: 'prep_sundial_uniforms', category: 'disguise', optional: true, perk: 'Unlocks the Con approach: walk in the front as Brightwatch alarm technicians.' },
  { prep: 'prep_sundial_rota', category: 'security', optional: true, perk: 'One fewer guard inside, +20% time on every timer.', bonus: { timeMult: 1.2 } },
];

const heistSundial: ActivityDef = {
  id: 'heist_sundial', kind: 'heist', name: 'The Sundial Job', giver: 'lena',
  blurb: 'Sundial Jewelers keeps its best stones in a time-locked back-room safe overnight. Two keypads, three guards, a night clerk who loves his inventory, and one window of opportunity.',
  start: [2464, Y, 3134], startSpots: [[2526, Y, 3162], [2529, Y, 3162], [2532, Y, 3162], [2535, Y, 3162]], startYaw: 0,
  unlock: { requires: ['story_1'] }, minPlayers: 1, maxPlayers: 4, lateJoin: 'roster_reconnect', replayable: true,
  preps: SUNDIAL_SETUPS.map((s) => s.prep), music: 'heist_action',
  heist: {
    baseTake: 9000,
    approaches: ['quiet', 'loud', 'con'],
    approachNeeds: { con: 'prep_sundial_uniforms' },
    equipment: [
      { id: 'lockpick', name: 'Pro lockpick set', desc: 'Back door opens in 3 s instead of 7 s.', approach: 'quiet', effects: [{ obj: 'lock', key: 'lock', hold: 3 }] },
      { id: 'jammer', name: 'Signal jammer', desc: 'Both-at-once sync windows double. Police respond slower.', windowMult: 2 },
      { id: 'drill', name: 'Thermal drill', desc: 'The time-lock drill needs 35% less time.', effects: [{ obj: 'defend', mult: 0.65 }] },
      { id: 'sledge', name: 'Sledgehammer', desc: 'Display cases smash instantly.', approach: 'loud', effects: [{ obj: 'loot', hold: 0.3 }] },
      { id: 'clipboard', name: 'Work order clipboard', desc: 'The alarm-panel "service" takes 40% less time.', approach: 'con', effects: [{ obj: 'keypad', mult: 0.6 }] },
    ],
    roles: ['driver', 'hacker', 'muscle', 'lookout'],
    loudPenalty: 0.8,
    setups: SUNDIAL_SETUPS,
    hardLives: [2, 3, 4, 5], carryLoss: 0.15, firstTimeBonus: 2000,
    elite: { label: 'Clean Cut: under 9:00 and nobody knocked out', bonus: 1500, maxSeconds: 540, noKnockouts: true },
    alarmDoors: ['front', 'inner', 'back'],
    radio: LENA_RADIO,
  },
  notes: [
    'Quiet: pick the back door, stay out of guard sight, disable both alarm keypads together, then drill the time-locked safe. Solo: the keypads can be done one after the other within 25 s.',
    'Con (needs the Alarm-Tech Uniforms setup): ring the front intercom as Brightwatch technicians; guards ignore you while you "service" the panel and the clerk signs your work order (two places at once in co-op).',
    'Loud: smash the front door. The alarm trips at once, armed responders arrive while the drill runs - grab what you can and outrun the police.',
    'Getaway follows your Getaway Wheels choice: the GT runs to Pier 9, the van to Dez\'s garage. Loot is carried in bags: a knocked-out carrier drops their bag (15% is damaged); pick it up again within 60 s on the getaway or the police bag it.',
    'Hard: an extra armed guard, timers 20% shorter, response teams always come, a limited pool of team lives (knockouts) - and +25% take. Payout split locks at launch. Disconnected crew can rejoin for 90 s.',
  ],
  stages: [
    {
      id: 'intro', title: 'Gear up', cutscene: 'sd_heist_intro',
      spawn: [
        { id: 'getaway', kind: 'vehicle', model: 'sports', pos: [J.x + 24, Y, J.z + 37], yaw: Math.PI, color: 0xd7263d, label: 'Getaway GT', if: { choice: { getaway: 'gt' } } },
        { id: 'getaway_van', kind: 'vehicle', model: 'van', pos: [J.x + 24, Y, J.z + 37], yaw: Math.PI, color: 0x6c757d, label: 'Getaway van', if: { choice: { getaway: 'van' } } },
        { id: 'getaway2', kind: 'vehicle', model: 'sedan', pos: [J.x + 32, Y, J.z + 37], yaw: Math.PI, color: 0x393e46, minParty: 3, label: 'Getaway car 2', driverUpgrade: 'muscle' },
        { id: 'g1', kind: 'guard', patrol: [[J.x + 16, Y, J.z + 14], [J.x + 31, Y, J.z + 14]], armed: true, name: 'Guard Okonkwo' },
        { id: 'g2', kind: 'guard', patrol: [[J.x + 15, Y, J.z + 27], [J.x + 28, Y, J.z + 27]], minParty: 2, if: { noSetup: 'prep_sundial_rota' }, name: 'Guard Pruitt' },
        { id: 'g3', kind: 'guard', patrol: [[J.x + 33, Y, J.z + 20], [J.x + 33, Y, J.z + 14]], minParty: 3, name: 'Guard Delacroix' },
        { id: 'g4', kind: 'guard', patrol: [[J.x + 18, Y, J.z + 21], [J.x + 28, Y, J.z + 21]], hard: true, armed: true, name: 'Guard Mbeki' },
        { id: 'clerk', kind: 'npc', role: 'shopkeeper', pos: [2520, Y, 3135], yaw: 0, name: 'Mr. Pemberton' },
        { id: 'front', kind: 'door', door: 'jewelers.front_door', state: 'locked' },
        { id: 'inner', kind: 'door', door: 'jewelers.inner_door', state: 'closed' },
        { id: 'back', kind: 'door', door: 'jewelers.back_door', state: 'locked' },
      ],
      objectives: [{ type: 'wait', id: 'gear', label: 'Gear up', seconds: 0.1 }],
    },
    {
      id: 'entry_quiet', title: 'Get inside', when: { approach: 'quiet' }, checkpoint: true, skipOnAlarm: true,
      respawn: [[J.x + 26, Y, J.z + 40], [J.x + 28, Y, J.z + 40], [J.x + 30, Y, J.z + 40], [J.x + 32, Y, J.z + 40]],
      spawn: [{ id: 'lock', kind: 'object', obj: 'lock', pos: [J.x + 26.5, Y, J.z + 32.6], label: 'Pick the lock', hold: 7 }],
      objectives: [{ type: 'interact', id: 'pick', label: 'Pick the back-door lock', targets: ['lock'] }],
      fail: [{ type: 'all_down' }],
      lines: [L('Back door. Quiet hands. The guards change direction every few seconds - watch their sight lines.')],
    },
    {
      id: 'con_door', title: 'Routine inspection', when: { approach: 'con' }, checkpoint: true, disguised: true,
      respawn: [[2521.5, Y, 3127.5], [2523.5, Y, 3127.5], [2525.5, Y, 3127.5], [2527.5, Y, 3127.5]],
      spawn: [{ id: 'intercom', kind: 'object', obj: 'keypad', pos: [2521.5, Y, 3130.5], label: 'Buzz the intercom: "Brightwatch, routine inspection"', hold: 4 }],
      objectives: [{ type: 'interact', id: 'buzz', label: 'Talk your way in at the front intercom', targets: ['intercom'] }],
      fail: [{ type: 'all_down' }],
      lines: [L('Technician 4417, routine inspection. Smile like you are paid hourly.'), say('Mr. Pemberton', 'Brightwatch? At this hour? Well... the panel has been beeping. Come in, wipe your feet.')],
    },
    {
      id: 'entry_loud', title: 'Smash and grab', when: { approach: 'loud' }, checkpoint: true,
      respawn: [[2521.5, Y, 3127.5], [2523.5, Y, 3127.5], [2525.5, Y, 3127.5], [2527.5, Y, 3127.5]],
      spawn: [{ id: 'smash', kind: 'object', obj: 'lock', pos: [J.x + 24, Y, J.z + 10.4], label: 'Smash the door', hold: 1 }],
      objectives: [{ type: 'interact', id: 'smash', label: 'Smash the front door', targets: ['smash'] }],
      fail: [{ type: 'all_down' }],
      lines: [L('Loud. The insurer in me is weeping. The rest of me says: front door, now.')],
    },
    {
      id: 'keypads', title: 'Kill the alarm', when: { approach: 'quiet', alarm: false },
      onEnter: { doors: { back: 'open', inner: 'open' } },
      spawn: [
        { id: 'kp_a', kind: 'object', obj: 'keypad', pos: [J.x + 14, Y, J.z + 25.5], label: 'Alarm keypad A', hold: 2 },
        { id: 'kp_b', kind: 'object', obj: 'keypad', pos: [J.x + 33, Y, J.z + 25.5], label: 'Alarm keypad B', hold: 2 },
      ],
      objectives: [{ type: 'interact', id: 'keys', label: 'Disable both keypads at the same time', targets: ['kp_a', 'kp_b'], simultaneous: { window: 2.5, soloWindow: 25 } }],
      fail: [{ type: 'all_down' }],
      lines: [N('Two keypads, opposite walls. Count down together. Three, two, one, press.')],
    },
    {
      id: 'con_panel', title: 'Service the panel', when: { approach: 'con', alarm: false }, disguised: true,
      onEnter: { doors: { front: 'open', inner: 'open' } },
      spawn: [
        { id: 'panel', kind: 'object', obj: 'keypad', pos: [J.x + 14, Y, J.z + 25.5], label: '"Service" the alarm panel', hold: 8 },
        { id: 'workorder', kind: 'object', obj: 'evidence', pos: [J.x + 33, Y, J.z + 25.5], label: 'Keep the clerk busy signing the work order', hold: 6 },
      ],
      objectives: [{ type: 'interact', id: 'svc', label: 'Disable the panel while the clerk signs the work order', targets: ['panel', 'workorder'], simultaneous: { window: 4, soloWindow: 30 } }],
      fail: [{ type: 'all_down' }],
      lines: [say('Mr. Pemberton', 'Do you need me to sign something? I love signing things.'), L('One of you keeps him signing, one of you kills the panel. Solo: be charming, then be fast.')],
    },
    {
      id: 'loot', title: 'The cases', checkpoint: true,
      respawn: [[J.x + 24.5, Y, J.z + 21.5], [J.x + 22.5, Y, J.z + 21.5], [J.x + 27.5, Y, J.z + 20.5], [J.x + 20.5, Y, J.z + 21.5]],
      onEnter: { doors: { front: 'open', inner: 'open', back: 'open' }, alarmIfLoud: true },
      timeLimit: [150, 140, 130, 120],
      spawn: [
        { id: 'c1', kind: 'object', obj: 'loot', pos: [J.x + 16, Y, J.z + 15], label: 'Display case: sapphires', hold: 1.5, value: 1800 },
        { id: 'c2', kind: 'object', obj: 'loot', pos: [J.x + 23, Y, J.z + 18], label: 'Display case: diamond rings', hold: 1.5, value: 2200 },
        { id: 'c3', kind: 'object', obj: 'loot', pos: [J.x + 31, Y, J.z + 15], label: 'Display case: watches', hold: 1.5, value: 1800 },
        { id: 'c4', kind: 'object', obj: 'loot', pos: [J.x + 16, Y, J.z + 20.6], label: 'Display case: pearls', hold: 1.5, value: 1500, minParty: 2 },
        { id: 'c5', kind: 'object', obj: 'loot', pos: [J.x + 32, Y, J.z + 20.6], label: 'Display case: emeralds', hold: 1.5, value: 1500, minParty: 3 },
        { id: 'c6', kind: 'object', obj: 'loot', pos: [J.x + 25, Y, J.z + 21.6], label: 'Display case: the Tuesday stones', hold: 1.5, value: 2500, minParty: 4 },
      ],
      objectives: [{ type: 'interact', id: 'cases', label: 'Empty the display cases', targets: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6'], count: [3, 4, 5, 6] }],
      fail: [{ type: 'all_down' }, { type: 'timer' }],
      lines: [L('Cases first. Each one goes in your bag, and your bag stays on you.')],
      events: { alarm: [say('Mr. Pemberton', 'Not the Tuesday stones! Those are sentimental!'), L('Alarm. Police in about a minute. Finish the cases and get to the safe.')] },
      waves: [{ after: 20, alarmOnly: true, spawn: [enforcer('r1', [J.x + 26.5, Y, J.z + 36.5], 'Halvorsen responder')], line: say('Halvorsen responder', 'Halvorsen Patrol! Nobody move!') }],
    },
    {
      id: 'vault', title: 'The time-lock safe', checkpoint: true,
      respawn: [[J.x + 24.5, Y, J.z + 21.5], [J.x + 22.5, Y, J.z + 21.5], [J.x + 27.5, Y, J.z + 20.5], [J.x + 20.5, Y, J.z + 21.5]],
      timeLimit: [120, 115, 110, 105],
      objectives: [{ type: 'defend', id: 'drill', label: 'Stay by the safe while the drill beats the time lock', pos: [J.x + 28, Y, J.z + 26.5], r: 3.5, seconds: [20, 24, 26, 28] }],
      fail: [{ type: 'all_down' }, { type: 'timer' }],
      lines: [N('Drill is on the safe. It only runs while someone stands next to it - it gets lonely.'), L('Co-op: one of you minds the drill, the rest of you mind the doors.')],
      waves: [
        { after: 8, alarmOnly: true, spawn: [enforcer('r2', [J.x + 26.5, Y, J.z + 36.5], 'Halvorsen responder'), enforcer('r3', [J.x + 30.5, Y, J.z + 36.5], 'Halvorsen responder', { minParty: 2 })], line: say('Halvorsen responder', 'Back room! They are in the back room!') },
        { after: 12, spawn: [enforcer('h1', [J.x + 26.5, Y, J.z + 36.5], 'Halvorsen sergeant', { hard: true })] },
      ],
      events: { done: [N('Time lock beaten. The safe is open, and so is my heart.')] },
    },
    {
      id: 'safe', title: 'Empty the safe', timeLimit: [60, 60, 60, 60],
      spawn: [{ id: 'safe', kind: 'object', obj: 'safe', pos: [J.x + 29, Y, J.z + 27.5], label: 'Empty the safe', hold: 2.5, value: 6000 }],
      objectives: [{ type: 'interact', id: 'safe', label: 'Empty the back-room safe', targets: ['safe'] }],
      fail: [{ type: 'all_down' }, { type: 'timer' }],
    },
    {
      id: 'escape', title: 'Get out', checkpoint: true, when: { choice: { getaway: 'gt' } }, traffic: true,
      respawn: [[J.x + 24, Y, J.z + 34], [J.x + 26, Y, J.z + 34], [J.x + 28, Y, J.z + 34], [J.x + 30, Y, J.z + 34]],
      objectives: [{ type: 'enter_vehicle', id: 'car', label: 'Everyone into a getaway car', vehicles: ['getaway', 'getaway2'], who: 'all' }],
      fail: [{ type: 'all_down' }, { type: 'vehicle_destroyed', vehicle: 'getaway' }, { type: 'loot_lost', seconds: 60 }],
      lines: [L('Out the back, into the GT. Do not stop for anything, including traffic law.')],
    },
    {
      id: 'escape_van', title: 'Get out', checkpoint: true, when: { choice: { getaway: 'van' } }, traffic: true,
      respawn: [[J.x + 24, Y, J.z + 34], [J.x + 26, Y, J.z + 34], [J.x + 28, Y, J.z + 34], [J.x + 30, Y, J.z + 34]],
      objectives: [{ type: 'enter_vehicle', id: 'car', label: 'Everyone into the van', vehicles: ['getaway_van', 'getaway2'], who: 'all' }],
      fail: [{ type: 'all_down' }, { type: 'vehicle_destroyed', vehicle: 'getaway_van' }, { type: 'loot_lost', seconds: 60 }],
      lines: [L('Into the van. It is slow, it is ugly, and it laughs at bullets.')],
    },
    heat([{ type: 'all_down' }]),
    {
      id: 'drop', title: 'The drop', checkpoint: true, when: { choice: { getaway: 'gt' } }, traffic: true,
      respawn: [[J.x + 24, Y, J.z + 34], [J.x + 26, Y, J.z + 34], [J.x + 28, Y, J.z + 34], [J.x + 30, Y, J.z + 34]],
      objectives: [{ type: 'reach', id: 'pier', label: 'Deliver the take to Pier 9', pos: [2712, Y, 3214], r: 9, who: 'any', vehicle: 'getaway' }],
      fail: [{ type: 'all_down' }, { type: 'vehicle_destroyed', vehicle: 'getaway' }],
      lines: [L('Pier 9, east side of the bridge. Thursday\'s boat does not wait for anyone.')],
    },
    {
      id: 'drop_van', title: 'The drop', checkpoint: true, when: { choice: { getaway: 'van' } }, traffic: true,
      respawn: [[J.x + 24, Y, J.z + 34], [J.x + 26, Y, J.z + 34], [J.x + 28, Y, J.z + 34], [J.x + 30, Y, J.z + 34]],
      objectives: [{ type: 'reach', id: 'garage', label: 'Deliver the take to Dez at Torque & Tide', pos: [2430.5, Y, 3186], r: 8, who: 'any', vehicle: 'getaway_van' }],
      fail: [{ type: 'all_down' }, { type: 'vehicle_destroyed', vehicle: 'getaway_van' }],
      lines: [say('Dez (radio)', 'Garage door is up. Drive in, do not hit the coffee machine.')],
    },
    debrief('sd_out_gt', { choice: { getaway: 'gt' } }, 'debrief'),
    debrief('sd_out_van', { choice: { getaway: 'van' } }, 'debrief_van'),
  ],
  rewards: { cash: [0, 0, 0, 0], rep: 250, replayCash: 0, unlocks: ['story_2'] },
};

// ═══════════════════════════════════════════════════════════════════ HEIST 2: THE PIER 9 SHUFFLE
const prepRecon = prepBase({
  id: 'prep_pier9_recon', prepFor: 'heist_pier9', name: 'Pier 9 Setup: Container Census',
  blurb: 'Nix needs eyes on every side of the Pier 9 warehouse: loading shutter, side door, camera pole and the guard shack. Four photos, no heroics.',
  start: [2693.5, Y, 3222.5], startSpots: row(2693.5, 3220.5, 0, 2), startYaw: 0,
  unlock: { requires: ['story_5'] },
  notes: ['Required setup. Counts toward The Pier 9 Shuffle for the crew leader who owns the heist.', 'Solo: three photos. Party: a fourth photo spot appears for crews of three or more - split up and go faster.'],
  stages: [
    {
      id: 'photos', title: 'Photograph the warehouse', cutscene: 'p9_recon_in', timeLimit: [200, 170, 150, 150],
      spawn: [
        { id: 'ph_n', kind: 'object', obj: 'photo', pos: [2712.5, Y, 3222.5], label: 'Photograph the loading shutter', hold: 1.5 },
        { id: 'ph_e', kind: 'object', obj: 'photo', pos: [2730.5, Y, 3238.5], label: 'Photograph the side door', hold: 1.5 },
        { id: 'ph_s', kind: 'object', obj: 'photo', pos: [2712.5, Y, 3257.5], label: 'Photograph the camera pole', hold: 1.5 },
        { id: 'ph_w', kind: 'object', obj: 'photo', pos: [2693.5, Y, 3238.5], label: 'Photograph the guard shack', hold: 1.5, minParty: 3 },
      ],
      objectives: [{ type: 'interact', id: 'photos', label: 'Take the photos', targets: ['ph_n', 'ph_e', 'ph_s', 'ph_w'], count: [3, 3, 4, 4] }],
      fail: [{ type: 'timer' }],
      lines: [N('Shutter, side door, camera pole. And the shack if there are enough of you. Go, go, go.')],
    },
    debrief('p9_recon_out'),
  ],
  rewards: { cash: [600, 600, 600, 600], rep: 30, replayCash: 250 },
});

const prepKeys = prepBase({
  id: 'prep_pier9_keys', prepFor: 'heist_pier9', name: "Pier 9 Setup: The Inspector's Keys",
  blurb: 'Hollis Grebe never lends his keys, but he does take a long lunch. Two key rings are on pegs by the guard shack; two guards walk past it.',
  start: [2693.5, Y, 3222.5], startSpots: row(2693.5, 3220.5, 0, 2), startYaw: 0,
  unlock: { requires: ['story_5'] },
  notes: ['Required setup. Stealth: guards trip the alarm if they see you. A stun pistol drops one for 20 s. If the alarm goes, lose the police before you finish.', 'Solo: one guard and one key ring needed. Party: a second guard and both key rings.'],
  stages: [
    {
      id: 'pegs', title: 'Lift the key rings', cutscene: 'p9_keys_in', timeLimit: [180, 170, 160, 150],
      spawn: [
        { id: 'g1', kind: 'guard', patrol: [[2730.5, Y, 3236.5], [2730.5, Y, 3256.5]], name: 'Dock guard' },
        { id: 'g2', kind: 'guard', patrol: [[2693.5, Y, 3236.5], [2693.5, Y, 3256.5]], minParty: 2, name: 'Dock guard' },
        { id: 'key_a', kind: 'object', obj: 'package', pos: [2731.5, Y, 3254.5], label: 'Gate key ring', hold: 2 },
        { id: 'key_b', kind: 'object', obj: 'package', pos: [2693.5, Y, 3254.5], label: 'Forklift key ring', hold: 2, minParty: 2 },
      ],
      objectives: [{ type: 'interact', id: 'keys', label: "Lift the inspector's key rings", targets: ['key_a', 'key_b'], count: [1, 2, 2, 2] }],
      fail: [{ type: 'timer' }, { type: 'all_down' }],
      lines: [L('Grebe is at lunch. Officially. The guards are not. Time your approach.')],
      events: { alarm: [say('Dock guard', 'Oi! Inspector\'s keys stay on the peg!'), L('Spotted. Take the keys anyway and lose the police.')] },
    },
    heat(),
    debrief('p9_keys_out'),
  ],
  rewards: { cash: [700, 700, 700, 700], rep: 30, replayCash: 300 },
});

const prepExit = prepBase({
  id: 'prep_pier9_skiff', prepFor: 'heist_pier9', name: 'Pier 9 Setup: Arrange the Exit',
  blurb: 'Pick the way out. Barney\'s skiff runs round Port Island to the east dock (quiet water, slow chase). Or lift a customs pickup from the island yard and get Dez to make it legal-looking (fast road, loud chase).',
  start: [2670.5, Y, 3202.5], startSpots: row(2670.5, 3200.5, 0, 2), startYaw: Math.PI / 2,
  unlock: { requires: ['story_5'] },
  notes: ['Required setup with a CHOICE: skiff (escape by water to Barney\'s cove) or pickup (escape by road to Dez\'s garage).', 'Skiff: the lagoon is closed by the causeways - a short run, but boats are slow to turn. Pickup: one star when you take it; lose it before Dez.'],
  stages: [
    brief('p9_exit_in'),
    {
      id: 'board', title: 'Find the skiff', when: { choice: { exit: 'skiff' } },
      spawn: [
        { id: 'skiff', kind: 'vehicle', model: 'boat', pos: [2657, 21, 3200], yaw: 0, color: 0xf6f7f8, label: "Barney's skiff" },
        { id: 'skiff2', kind: 'vehicle', model: 'boat', pos: [2657, 21, 3208], yaw: 0, color: 0x4cc9f0, minParty: 3, label: 'Second skiff' },
      ],
      objectives: [{ type: 'enter_vehicle', id: 'enter', label: "Climb into Barney's skiff", vehicles: ['skiff', 'skiff2'], who: 'any' }],
      fail: [{ type: 'vehicle_destroyed', vehicle: 'skiff' }],
      lines: [say('Capt. Barney (radio)', 'White hull, west dock. Do not make eye contact with the gulls.')],
    },
    {
      id: 'north', title: 'Round the island', when: { choice: { exit: 'skiff' } }, timeLimit: [150, 150, 150, 150],
      objectives: [{ type: 'reach', id: 'north', label: 'Run north along the island shore', pos: [2658, 21, 3150], r: 14, who: 'any' }],
      fail: [{ type: 'timer' }, { type: 'vehicle_destroyed', vehicle: 'skiff' }],
    },
    {
      id: 'across', title: 'Across the north side', when: { choice: { exit: 'skiff' } }, timeLimit: [150, 150, 150, 150],
      objectives: [{ type: 'reach', id: 'across', label: 'Cross to the east channel', pos: [2762, 21, 3150], r: 12, who: 'any' }],
      fail: [{ type: 'timer' }, { type: 'vehicle_destroyed', vehicle: 'skiff' }],
    },
    {
      id: 'dock', title: 'East dock', when: { choice: { exit: 'skiff' } }, timeLimit: [150, 150, 150, 150],
      objectives: [{ type: 'reach', id: 'dock', label: 'Tie up at the Pier 9 east dock', pos: [2760, 21, 3240], r: 8, who: 'any' }],
      fail: [{ type: 'timer' }, { type: 'vehicle_destroyed', vehicle: 'skiff' }],
      lines: [L('Tie it up facing out. On the night, nobody wants a three-point turn.')],
    },
    {
      id: 'truck', title: 'The customs pickup', when: { choice: { exit: 'truck' } },
      spawn: [
        { id: 'pickup', kind: 'vehicle', model: 'pickup', pos: [2700, Y, 3214.5], yaw: Math.PI / 2, color: 0xf6f7f8, label: 'Customs pickup' },
        { id: 'cust_g', kind: 'guard', patrol: [[2711.5, Y, 3209.5], [2729.5, Y, 3209.5]], name: 'Customs officer' },
      ],
      objectives: [{ type: 'enter_vehicle', id: 'enter', label: 'Take the customs pickup in the island yard', vehicles: ['pickup'], who: 'any' }],
      fail: [{ type: 'vehicle_destroyed', vehicle: 'pickup' }],
      lines: [L('White pickup, customs crest. The officer is doing his crossword. Seven letters for "stolen".')],
    },
    {
      id: 'truck_heat', title: 'Lose the heat', checkpoint: true, when: { choice: { exit: 'truck' } }, onEnter: { wanted: 1 }, traffic: true,
      respawn: [[2698, Y, 3209.5], [2700, Y, 3209.5], [2702, Y, 3209.5], [2704, Y, 3209.5]],
      objectives: [{ type: 'lose_wanted', id: 'lose', label: 'Lose the police' }],
      fail: [{ type: 'vehicle_destroyed', vehicle: 'pickup' }],
    },
    {
      id: 'truck_park', title: 'Dez', when: { choice: { exit: 'truck' } }, traffic: true,
      objectives: [{ type: 'reach', id: 'garage', label: 'Bring the pickup to Torque & Tide', pos: [2430.5, Y, 3186], r: 6, who: 'any', vehicle: 'pickup' }],
      fail: [{ type: 'vehicle_destroyed', vehicle: 'pickup' }],
    },
    debrief('p9_exit_out'),
  ],
  rewards: { cash: [800, 800, 800, 800], rep: 30, replayCash: 350 },
});

const prepLights = prepBase({
  id: 'prep_pier9_lights', prepFor: 'heist_pier9', name: 'Pier 9 Setup: Kill the Floodlights',
  blurb: 'The dock cameras and floodlights share one harbour substation on the island\'s north road. Pull both relay cabinets together and Nix owns the yard on the night.',
  start: [2693.5, Y, 3222.5], startSpots: row(2693.5, 3220.5, 0, 2), startYaw: Math.PI,
  unlock: { requires: ['story_5'] },
  notes: ['OPTIONAL setup. On the night: no camera relays to cut on a quiet run, and the yard guards see less.', 'Co-op: one player per cabinet, pulled within 2.5 s. Solo: both within 20 s. A substation guard walks between them.'],
  stages: [
    {
      id: 'relays', title: 'The substation', cutscene: 'p9_lights_in', timeLimit: [170, 160, 150, 150],
      spawn: [
        { id: 'relay_a', kind: 'object', obj: 'keypad', pos: [2703.5, Y, 3210.5], label: 'Relay cabinet A', hold: 2.5 },
        { id: 'relay_b', kind: 'object', obj: 'keypad', pos: [2731.5, Y, 3210.5], label: 'Relay cabinet B', hold: 2.5 },
        { id: 'sub_g', kind: 'guard', patrol: [[2709.5, Y, 3209.5], [2725.5, Y, 3209.5]], name: 'Substation guard' },
      ],
      objectives: [{ type: 'interact', id: 'pull', label: 'Pull both relay cabinets together', targets: ['relay_a', 'relay_b'], simultaneous: { window: 2.5, soloWindow: 20 } }],
      fail: [{ type: 'timer' }, { type: 'all_down' }],
      lines: [N('Two cabinets on the north road. The guard between them hums when he is bored. Hum is good.')],
      events: { alarm: [say('Substation guard', 'Step away from the cabinet! That is municipal property!'), L('He saw you. Finish the cabinets and lose the police.')] },
    },
    heat(),
    debrief('p9_lights_out'),
  ],
  rewards: { cash: [700, 700, 700, 700], rep: 30, replayCash: 300 },
});

const prepOveralls = prepBase({
  id: 'prep_pier9_overalls', prepFor: 'heist_pier9', name: 'Pier 9 Setup: Dockhand Overalls',
  blurb: 'Grebe has two temporary slots on the night roster. Collect the dockhand overalls and the union cards from the island yard and bring them to him at the gate shack.',
  start: [2693.5, Y, 3222.5], startSpots: row(2693.5, 3220.5, 0, 2), startYaw: Math.PI,
  unlock: { requires: ['story_5'] },
  notes: ['OPTIONAL setup. Unlocks the CON approach for The Pier 9 Shuffle: clock in at the gate as night dockhands.', 'Stealth: a yard foreman patrols. Both items are needed solo or co-op - split up to go faster.'],
  stages: [
    {
      id: 'collect', title: 'Overalls and cards', cutscene: 'p9_over_in', timeLimit: [170, 160, 150, 150],
      spawn: [
        { id: 'overalls', kind: 'object', obj: 'package', pos: [2700.5, Y, 3186.5], label: 'Dockhand overalls', hold: 2 },
        { id: 'cards', kind: 'object', obj: 'evidence', pos: [2719.5, Y, 3203.5], label: 'Union cards', hold: 2 },
        { id: 'foreman', kind: 'guard', patrol: [[2704.5, Y, 3195.5], [2718.5, Y, 3195.5]], name: 'Yard foreman' },
      ],
      objectives: [{ type: 'interact', id: 'items', label: 'Collect the overalls and the union cards', targets: ['overalls', 'cards'] }],
      fail: [{ type: 'timer' }, { type: 'all_down' }],
      lines: [L('Overalls on the north side of the yard, cards in the foreman\'s cubby. He counts forklifts, not people.')],
      events: { alarm: [say('Yard foreman', 'You are not on my roster! Security!')] },
    },
    heat(),
    {
      id: 'deliver', title: 'Grebe', timeLimit: [120, 120, 120, 120],
      objectives: [{ type: 'reach', id: 'grebe', label: 'Bring them to Grebe at the gate shack', pos: [2693.5, Y, 3224.5], r: 3, who: 'any' }],
      fail: [{ type: 'timer' }],
    },
    debrief('p9_over_out'),
  ],
  rewards: { cash: [700, 700, 700, 700], rep: 30, replayCash: 300 },
});

const PIER9_SETUPS: SetupDef[] = [
  { prep: 'prep_pier9_recon', category: 'scout', perk: 'Every guard loop and camera on the island is mapped.' },
  { prep: 'prep_pier9_keys', category: 'security', perk: 'Grebe\'s key rings: the side door and the loading shutter can be opened.' },
  { prep: 'prep_pier9_skiff', category: 'escape', perk: 'Your exit waits on the night.', choice: { key: 'exit', label: 'Exit', options: [
    { id: 'skiff', name: 'Barney\'s skiff', desc: 'Water route round the island to Barney\'s cove. Hard to chase.' },
    { id: 'truck', name: 'Customs pickup', desc: 'Road route across the bridge to Dez\'s garage. Fast, loud, tough.' },
  ] } },
  { prep: 'prep_pier9_lights', category: 'security', optional: true, perk: 'Floodlights and dock cameras down: no camera relays to cut on a quiet run, one fewer guard outside.' },
  { prep: 'prep_pier9_overalls', category: 'disguise', optional: true, perk: 'Unlocks the Con approach: clock in at the gate as Grebe\'s night dockhands.' },
];

const heistPier9: ActivityDef = {
  id: 'heist_pier9', kind: 'heist', name: 'The Pier 9 Shuffle', giver: 'lena',
  blurb: 'Vega & Sons stash their best "dockside produce" in the Pier 9 warehouse until the Thursday boat. One manifest safe, a stack of crates that are not produce, a container on a crane, and a boat that leaves with or without you.',
  start: [2693.5, Y, 3222.5], startSpots: row(2693.5, 3220.5, 0, 2), startYaw: 0,
  unlock: { requires: ['heist_sundial', 'story_5'] }, minPlayers: 1, maxPlayers: 4, lateJoin: 'roster_reconnect', replayable: true,
  preps: PIER9_SETUPS.map((s) => s.prep), music: 'heist_action',
  heist: {
    baseTake: 18000,
    approaches: ['quiet', 'loud', 'con'],
    approachNeeds: { con: 'prep_pier9_overalls' },
    equipment: [
      { id: 'lockpick', name: 'Pro lockpick set', desc: 'The side-door lock opens in 3 s instead of 7 s.', approach: 'quiet', effects: [{ obj: 'lock', key: 'lock', hold: 3 }] },
      { id: 'jammer', name: 'Signal jammer', desc: 'Both-at-once windows double (cameras, crane clamps).', windowMult: 2 },
      { id: 'drill', name: 'Thermal drill', desc: 'The manifest safe cracks in 7 s instead of 12 s.', effects: [{ obj: 'safe', hold: 7 }] },
      { id: 'sledge', name: 'Sledgehammer', desc: 'Cargo crates smash open instantly.', approach: 'loud', effects: [{ obj: 'loot', hold: 0.3 }] },
      { id: 'radio', name: 'Dock radio', desc: 'Waiting for the exit takes 30% less time.', effects: [{ obj: 'defend', mult: 0.7 }] },
    ],
    roles: ['driver', 'hacker', 'muscle', 'lookout'],
    loudPenalty: 0.75,
    setups: PIER9_SETUPS,
    hardLives: [3, 4, 5, 6], carryLoss: 0.2, firstTimeBonus: 4000,
    elite: { label: 'Light Fingers: under 12:00, less than 10% of the loot lost', bonus: 3000, maxSeconds: 720, maxLootLossPct: 10 },
    radio: LENA_RADIO,
  },
  notes: [
    'Quiet: pick the east side door, stay out of sight lines, kill the two dock cameras together (skipped with the Floodlights setup). Con (Overalls setup): clock in at the gate shack - guards ignore dockhands.',
    'Loud: smash the loading shutter. The alarm trips at once and armed Vega night crew arrive in waves.',
    'Every approach: unclamp the Thursday container from two crane consoles at once (solo: within 25 s), crack the manifest safe and bag the crates, then hold the floor until your exit is ready.',
    'Exit follows your Arrange the Exit choice: skiff across the lagoon to Barney\'s cove, or the customs pickup over the bridge to Dez. Bags drop when a carrier is knocked out (20% damaged).',
    'Hard: extra armed guards, 20% shorter timers, waves always come, limited team lives, +25% take. Payout split locks at launch. Checkpoints: the way in, the take, the hold, the escape.',
  ],
  stages: [
    {
      id: 'intro', title: 'Gear up', cutscene: 'pier9_heist_intro',
      spawn: [
        { id: 'getaway', kind: 'vehicle', model: 'pickup', pos: [2700, Y, 3214.5], yaw: Math.PI / 2, color: 0xf6f7f8, label: 'Customs pickup', if: { choice: { exit: 'truck' } }, driverUpgrade: 'muscle' },
        { id: 'getaway2', kind: 'vehicle', model: 'van', pos: [2686, Y, 3217.5], yaw: Math.PI / 2, color: 0x393e46, minParty: 3, label: 'Getaway van 2', if: { choice: { exit: 'truck' } } },
        { id: 'skiff', kind: 'vehicle', model: 'boat', pos: [2757, 21, 3240], yaw: -Math.PI / 2, color: 0xf6f7f8, label: 'Escape skiff', if: { choice: { exit: 'skiff' } } },
        { id: 'g1', kind: 'guard', patrol: [[2709.5, Y, 3228.5], [2722.5, Y, 3228.5]], armed: true, name: 'Vega night crew' },
        { id: 'g2', kind: 'guard', patrol: [[2714.5, Y, 3236.5], [2714.5, Y, 3243.5]], name: 'Vega night crew' },
        { id: 'g3', kind: 'guard', patrol: [[2704.5, Y, 3250.5], [2712.5, Y, 3250.5]], minParty: 2, armed: true, name: 'Vega night crew' },
        { id: 'g4', kind: 'guard', patrol: [[2722.5, Y, 3236.5], [2722.5, Y, 3244.5]], minParty: 3, name: 'Vega night crew' },
        { id: 'g5', kind: 'guard', patrol: [[2693.5, Y, 3236.5], [2693.5, Y, 3254.5]], minParty: 4, if: { noSetup: 'prep_pier9_lights' }, name: 'Yard guard' },
        { id: 'g6', kind: 'guard', patrol: [[2705.5, Y, 3245.5], [2720.5, Y, 3244.5]], hard: true, armed: true, name: 'Vega enforcer' },
        { id: 'g7', kind: 'guard', patrol: [[2730.5, Y, 3236.5], [2730.5, Y, 3256.5]], hard: true, armed: true, name: 'Vega enforcer' },
        { id: 'shutter', kind: 'door', door: 'warehouse.shutter', state: 'locked' },
        { id: 'side', kind: 'door', door: 'warehouse.side_door', state: 'locked' },
      ],
      objectives: [{ type: 'wait', id: 'gear', label: 'Gear up', seconds: 0.1 }],
    },
    {
      id: 'entry_quiet', title: 'Side door', when: { approach: 'quiet' }, checkpoint: true, respawn: row(2729.5, 3240.5, 0, 1), skipOnAlarm: true,
      spawn: [{ id: 'lock', kind: 'object', obj: 'lock', pos: [2729.5, Y, 3246.5], label: 'Pick the side-door lock', hold: 7 }],
      objectives: [{ type: 'interact', id: 'pick', label: 'Pick the east side-door lock', targets: ['lock'] }],
      fail: [{ type: 'all_down' }],
      lines: [L('East door. The guards walk fixed loops - find the gap and slip in behind them.')],
    },
    {
      id: 'entry_con', title: 'Clock in', when: { approach: 'con' }, checkpoint: true, respawn: row(2693.5, 3220.5, 0, 2), disguised: true,
      spawn: [{ id: 'clock', kind: 'object', obj: 'keypad', pos: [2693.5, Y, 3230.5], label: 'Clock in on Grebe\'s night roster', hold: 4 }],
      objectives: [{ type: 'interact', id: 'clock', label: 'Clock in at the gate shack', targets: ['clock'] }],
      fail: [{ type: 'all_down' }],
      lines: [say('Hollis Grebe (radio)', 'You are on the roster. Look tired. Dockhands are always tired.'), say('Vega night crew', 'New faces. Great. Do not touch the blue crates, they are... produce.')],
    },
    {
      id: 'entry_loud', title: 'Smash the shutter', when: { approach: 'loud' }, checkpoint: true, respawn: row(2711.5, 3220.5, 2),
      spawn: [{ id: 'smash', kind: 'object', obj: 'lock', pos: [2711.5, Y, 3222.5], label: 'Smash the loading shutter', hold: 1.5 }],
      objectives: [{ type: 'interact', id: 'smash', label: 'Smash the loading shutter', targets: ['smash'] }],
      fail: [{ type: 'all_down' }],
      lines: [L('Loud it is. Shutter, safe, crates, and leave before the sirens tune up.')],
    },
    {
      id: 'cams', title: 'Blind the dock cameras', when: { approach: 'quiet', alarm: false, noSetup: 'prep_pier9_lights' },
      onEnter: { doors: { side: 'open' } },
      spawn: [
        { id: 'cam_a', kind: 'object', obj: 'keypad', pos: [2701.5, Y, 3248.5], label: 'Camera relay A', hold: 2 },
        { id: 'cam_b', kind: 'object', obj: 'keypad', pos: [2716.5, Y, 3226.5], label: 'Camera relay B', hold: 2 },
      ],
      objectives: [{ type: 'interact', id: 'cams', label: 'Cut both camera relays at the same time', targets: ['cam_a', 'cam_b'], simultaneous: { window: 2.5, soloWindow: 25 } }],
      fail: [{ type: 'all_down' }],
      lines: [N('Camera relays. Both at once or the cameras phone home.')],
    },
    {
      id: 'crane', title: 'The Thursday container', checkpoint: true, respawn: row(2727.5, 3240.5, 0, 1),
      onEnter: { doors: { shutter: 'open', side: 'open' }, alarmIfLoud: true },
      spawn: [
        { id: 'clamp_a', kind: 'object', obj: 'keypad', pos: [2705.5, Y, 3231.5], label: 'Crane clamp console A', hold: 3 },
        { id: 'clamp_b', kind: 'object', obj: 'keypad', pos: [2720.5, Y, 3243.5], label: 'Crane clamp console B', hold: 3 },
      ],
      objectives: [{ type: 'interact', id: 'clamps', label: 'Release both crane clamps together', targets: ['clamp_a', 'clamp_b'], simultaneous: { window: 2.5, soloWindow: 25 } }],
      fail: [{ type: 'all_down' }],
      lines: [N('The good container is on the crane. Two clamp consoles, opposite ends. Release together or it swings.')],
      events: { alarm: [say('Vega night crew', 'Someone is on the crane! Lights! Lights!')] },
      waves: [{ after: 10, alarmOnly: true, spawn: [enforcer('w1', [2711.5, Y, 3226.5], 'Vega enforcer'), enforcer('w2', [2727.5, Y, 3246.5], 'Vega enforcer', { minParty: 2 })] }],
    },
    {
      id: 'loot', title: 'The take', checkpoint: true, respawn: row(2727.5, 3240.5, 0, 1),
      timeLimit: [200, 190, 180, 170],
      spawn: [
        { id: 'safe', kind: 'object', obj: 'safe', pos: [2725.5, Y, 3252.5], label: 'Crack the manifest safe', hold: 12, value: 7500 },
        { id: 'c1', kind: 'object', obj: 'loot', pos: [2708.5, Y, 3235.5], label: 'Cargo crate: watches', hold: 2, value: 2600 },
        { id: 'c2', kind: 'object', obj: 'loot', pos: [2713.5, Y, 3241.5], label: 'Cargo crate: electronics', hold: 2, value: 2400 },
        { id: 'c3', kind: 'object', obj: 'loot', pos: [2703.5, Y, 3246.5], label: 'Cargo crate: perfume', hold: 2, value: 2000, minParty: 2 },
        { id: 'c4', kind: 'object', obj: 'loot', pos: [2716.5, Y, 3247.5], label: 'Cargo crate: art', hold: 2, value: 3000, minParty: 3 },
        { id: 'c5', kind: 'object', obj: 'loot', pos: [2700.5, Y, 3236.5], label: 'Container: bearer bonds', hold: 2, value: 3400, minParty: 4 },
      ],
      objectives: [
        { type: 'interact', id: 'safe', label: 'Crack the manifest safe in the office', targets: ['safe'] },
        { type: 'interact', id: 'crates', label: 'Empty the cargo crates', targets: ['c1', 'c2', 'c3', 'c4', 'c5'], count: [2, 3, 4, 5] },
      ],
      fail: [{ type: 'all_down' }, { type: 'timer' }],
      lines: [L('Safe and crates. The Thursday boat leaves at dawn - so does your window.')],
      waves: [{ after: 30, alarmOnly: true, spawn: [enforcer('w3', [2711.5, Y, 3226.5], 'Vega enforcer'), enforcer('w4', [2711.5, Y, 3228.5], 'Vega enforcer', { hard: true })] }],
    },
    {
      id: 'hold', title: 'Hold the floor', checkpoint: true, respawn: row(2727.5, 3240.5, 0, 1),
      timeLimit: [120, 120, 115, 110],
      objectives: [{ type: 'defend', id: 'hold', label: 'Hold the loading floor until the exit is in position', pos: [2711.5, Y, 3230.5], r: 5, seconds: [20, 25, 28, 30] }],
      fail: [{ type: 'all_down' }, { type: 'timer' }],
      lines: [L('Exit is three minutes out. Make it two. Stay on the loading floor, and stay alive on it.')],
      waves: [
        { after: 6, alarmOnly: true, spawn: [enforcer('w5', [2711.5, Y, 3220.5], 'Vega enforcer'), enforcer('w6', [2713.5, Y, 3220.5], 'Vega enforcer', { minParty: 2 })], line: say('Vega enforcer', 'They are on the loading floor! Box them in!') },
        { after: 10, spawn: [enforcer('w7', [2711.5, Y, 3220.5], 'Vega enforcer', { hard: true }), enforcer('w8', [2727.5, Y, 3246.5], 'Vega enforcer', { hard: true })] },
      ],
      events: { done: [L('Exit in position. Go.')] },
    },
    {
      id: 'escape_q', title: 'Get to the skiff', when: { choice: { exit: 'skiff' } }, checkpoint: true, respawn: row(2750.5, 3240.5, 0, 1),
      objectives: [{ type: 'enter_vehicle', id: 'skiff', label: 'Everyone into the skiff', vehicles: ['skiff'], who: 'all' }],
      fail: [{ type: 'all_down' }, { type: 'vehicle_destroyed', vehicle: 'skiff' }, { type: 'loot_lost', seconds: 60 }],
      lines: [say('Capt. Barney (radio)', 'Skiff at the east dock. Get in, sit down, do not wave.')],
    },
    {
      id: 'escape_l', title: 'Get to the pickup', when: { choice: { exit: 'truck' } }, checkpoint: true, respawn: row(2698, 3218.5, 2), traffic: true,
      objectives: [{ type: 'enter_vehicle', id: 'car', label: 'Everyone into the pickup', vehicles: ['getaway', 'getaway2'], who: 'all' }],
      fail: [{ type: 'all_down' }, { type: 'vehicle_destroyed', vehicle: 'getaway' }, { type: 'loot_lost', seconds: 60 }],
      lines: [say('Dez (radio)', 'Pickup is in the yard, keys in the visor. Bring it back with all four wheels.')],
    },
    heat([{ type: 'all_down' }]),
    {
      id: 'channel_q', title: 'The east channel', when: { choice: { exit: 'skiff' } },
      objectives: [{ type: 'reach', id: 'channel', label: 'Out through the east channel', pos: [2762, 21, 3170], r: 8, who: 'any', vehicle: 'skiff' }],
      fail: [{ type: 'all_down' }, { type: 'vehicle_destroyed', vehicle: 'skiff' }],
    },
    {
      id: 'drop_q', title: 'The cove', when: { choice: { exit: 'skiff' } },
      objectives: [{ type: 'reach', id: 'cove', label: "Bring the skiff to Barney's cove", pos: [2735, 21, 3100], r: 10, who: 'any', vehicle: 'skiff' }],
      fail: [{ type: 'all_down' }, { type: 'vehicle_destroyed', vehicle: 'skiff' }],
    },
    {
      id: 'drop_l', title: 'The drop', when: { choice: { exit: 'truck' } }, traffic: true,
      objectives: [{ type: 'reach', id: 'garage', label: "Deliver the take to Dez's garage", pos: [2430.5, Y, 3186], r: 10, who: 'any', vehicle: 'getaway' }],
      fail: [{ type: 'all_down' }, { type: 'vehicle_destroyed', vehicle: 'getaway' }],
    },
    debrief('p9_out_skiff', { choice: { exit: 'skiff' } }, 'debrief'),
    debrief('p9_out_truck', { choice: { exit: 'truck' } }, 'debrief_truck'),
  ],
  rewards: { cash: [0, 0, 0, 0], rep: 400, replayCash: 0, unlocks: [] },
};

// ═══════════════════════════════════════════════════════════════════ HEIST 3: THE VEGA TOWER JOB
const prepPlans = prepBase({
  id: 'prep_tower_plans', prepFor: 'heist_tower', name: 'Tower Setup: Floor Plans',
  blurb: 'Vega & Sons occupy a mid-sized tower with an enormous opinion of itself. Lena wants four photos of the vents, loading bay, fire stairs and lobby doors - from the street.',
  start: [2517.5, Y, 3077.5], startSpots: row(2517.5, 3076.5, 2), startYaw: 0,
  unlock: { requires: ['heist_pier9'] },
  notes: ['Required setup. Counts toward The Vega Tower Job for the crew leader who owns the heist.', 'Solo: three photos. Party: a fourth for crews of three or more.'],
  stages: [
    {
      id: 'photos', title: 'Photograph the tower', cutscene: 'tw_plans_in', timeLimit: [200, 170, 150, 150],
      spawn: [
        { id: 'ph_vent', kind: 'object', obj: 'photo', pos: [2497.5, Y, 3077.5], label: 'Photograph the roof vents', hold: 1.5 },
        { id: 'ph_bay', kind: 'object', obj: 'photo', pos: [2541.5, Y, 3077.5], label: 'Photograph the loading bay', hold: 1.5 },
        { id: 'ph_stairs', kind: 'object', obj: 'photo', pos: [2541.5, Y, 3113.5], label: 'Photograph the fire stairs', hold: 1.5 },
        { id: 'ph_doors', kind: 'object', obj: 'photo', pos: [2497.5, Y, 3113.5], label: 'Photograph the lobby doors', hold: 1.5, minParty: 3 },
      ],
      objectives: [{ type: 'interact', id: 'photos', label: 'Take the photos', targets: ['ph_vent', 'ph_bay', 'ph_stairs', 'ph_doors'], count: [3, 3, 4, 4] }],
      fail: [{ type: 'timer' }],
      lines: [L('Four corners of the block. Walk like you are lost, photograph like you are not.')],
    },
    debrief('tw_plans_out'),
  ],
  rewards: { cash: [900, 900, 900, 900], rep: 40, replayCash: 350 },
});

const prepConvoy = prepBase({
  id: 'prep_tower_convoy', prepFor: 'heist_tower', name: 'Tower Setup: Tail the Truck',
  blurb: 'Palm Armour runs a cash truck down the eastern edge of downtown every Friday. Sit on its route, note the timing and plant a tracker before it rolls on.',
  start: [2567.5, Y, 3223.5], startSpots: row(2562.5, 3223.5), startYaw: 0,
  unlock: { requires: ['heist_pier9'] },
  notes: ['Required setup. Drive the observation car to each spot and photograph the truck\'s stops. Solo: three stops; party: a fourth stop plus a second observation car for crews of three or more.', 'Counts toward The Vega Tower Job for the crew leader who owns the heist. If the observation car is wrecked the setup fails.'],
  stages: [
    {
      id: 'tail', title: 'Tail the truck', cutscene: 'tw_convoy_in', timeLimit: [260, 230, 210, 190],
      spawn: [
        { id: 'ride', kind: 'vehicle', model: 'compact', pos: [2576, Y, 3214.5], yaw: Math.PI / 2, color: 0x2e4057, label: 'Observation car' },
        { id: 'ride2', kind: 'vehicle', model: 'compact', pos: [2592, Y, 3214.5], yaw: Math.PI / 2, color: 0xf2c14e, minParty: 3, label: 'Second car' },
        { id: 's1', kind: 'object', obj: 'photo', pos: [2597.5, Y, 3125.5], label: 'Photograph the first stop', hold: 1.5 },
        { id: 's2', kind: 'object', obj: 'photo', pos: [2597.5, Y, 3173.5], label: 'Photograph the second stop', hold: 1.5 },
        { id: 's3', kind: 'object', obj: 'photo', pos: [2597.5, Y, 3221.5], label: 'Photograph the third stop', hold: 1.5 },
        { id: 's4', kind: 'object', obj: 'photo', pos: [2597.5, Y, 3269.5], label: 'Photograph the fourth stop', hold: 1.5, minParty: 3 },
      ],
      objectives: [{ type: 'interact', id: 'stops', label: 'Photograph the truck stops', targets: ['s1', 's2', 's3', 's4'], count: [3, 3, 4, 4] }],
      fail: [{ type: 'timer' }, { type: 'vehicle_destroyed', vehicle: 'ride' }],
      lines: [N('The truck stops are on your map. Park, photograph, move. Like a very boring tourist.')],
      events: { timeLow: [N('The truck is about to finish its route. Last photo, now!')] },
    },
    debrief('tw_convoy_out'),
  ],
  rewards: { cash: [900, 900, 900, 900], rep: 40, replayCash: 350 },
});

const prepBoat = prepBase({
  id: 'prep_tower_boat', prepFor: 'heist_tower', name: 'Tower Setup: Fast Boat',
  blurb: 'Barney has a Reef Runner he describes only as "available". Take it from the Port Island west dock and park it where the truck cash can reach water.',
  start: [2670.5, Y, 3202.5], startSpots: row(2670.5, 3200.5, 0, 2), startYaw: Math.PI / 2,
  unlock: { requires: ['heist_pier9'] },
  notes: ['Required setup. The harbour patrol takes an interest as soon as you cast off - expect one star. Lose it before you tie up.', 'Party: a second runner joins crews of three or more. The setup only needs one to arrive.'],
  stages: [
    {
      id: 'board', title: 'Take the Reef Runner', cutscene: 'tw_boat_in',
      spawn: [
        { id: 'runner', kind: 'vehicle', model: 'boat', pos: [2657, 21, 3200], yaw: 0, color: 0xd7263d, label: 'Reef Runner' },
        { id: 'runner2', kind: 'vehicle', model: 'boat', pos: [2657, 21, 3208], yaw: 0, color: 0x4cc9f0, minParty: 3, label: 'Second runner' },
      ],
      objectives: [{ type: 'enter_vehicle', id: 'enter', label: 'Take the Reef Runner', vehicles: ['runner', 'runner2'], who: 'any' }],
      fail: [{ type: 'vehicle_destroyed', vehicle: 'runner' }],
    },
    {
      id: 'heat', title: 'Shake the harbour patrol', onEnter: { wanted: 1 },
      objectives: [{ type: 'lose_wanted', id: 'lose', label: 'Lose the harbour patrol' }],
      fail: [{ type: 'vehicle_destroyed', vehicle: 'runner' }],
      lines: [say('Capt. Barney (radio)', 'Harbour patrol! Zigzag! No, the other zig!')],
    },
    {
      id: 'dock', title: 'Tie up at the Port Bridge', timeLimit: [200, 200, 200, 200],
      objectives: [{ type: 'reach', id: 'dock', label: 'Park off the downtown shore below the Port Bridge', pos: [2650, 21, 3226], r: 9, who: 'any', vehicle: 'runner' }],
      fail: [{ type: 'timer' }, { type: 'vehicle_destroyed', vehicle: 'runner' }],
    },
    debrief('tw_boat_out'),
  ],
  rewards: { cash: [900, 900, 900, 900], rep: 40, replayCash: 350 },
});

const prepLink = prepBase({
  id: 'prep_tower_link', prepFor: 'heist_tower', name: 'Tower Setup: The Ledger Kit',
  blurb: 'Nix can copy the Vega wire-transfer ledger two ways. Borrow the Channel 6 news van and its satellite uplink (slow, complete, worth double) or snatch a courier\'s encrypted drive downtown (fast, partial).',
  start: [2471.5, Y, 3221.5], startSpots: row(2467.5, 3221.5), startYaw: 0,
  unlock: { requires: ['heist_pier9'] },
  notes: ['Required setup with a CHOICE: uplink (finale: hold the executive office while Nix pulls the whole ledger, $9,000) or drive (finale: plug in and walk out, $4,500).', 'Uplink: take the news van, lose one star, park at Torque & Tide. Drive: lift the drive from the courier\'s bag, lose the heat, walk it to Dez.'],
  stages: [
    brief('tw_link_in'),
    {
      id: 'van', title: 'The news van', when: { choice: { ledger: 'uplink' } },
      spawn: [
        { id: 'news', kind: 'vehicle', model: 'van', pos: [2536, Y, 3166.5], yaw: Math.PI / 2, color: 0x3a86ff, label: 'Channel 6 news van' },
        { id: 'crew_g', kind: 'guard', patrol: [[2530.5, Y, 3161.5], [2542.5, Y, 3161.5]], name: 'Channel 6 cameraman' },
      ],
      objectives: [{ type: 'enter_vehicle', id: 'enter', label: 'Borrow the Channel 6 news van', vehicles: ['news'], who: 'any' }],
      fail: [{ type: 'vehicle_destroyed', vehicle: 'news' }],
      lines: [N('Blue van, giant dish. The cameraman is filming pigeons for a segment. Do not end up in the segment.')],
    },
    {
      id: 'van_heat', title: 'Lose the heat', checkpoint: true, when: { choice: { ledger: 'uplink' } }, onEnter: { wanted: 1 }, traffic: true,
      respawn: row(2538, 3173.5),
      objectives: [{ type: 'lose_wanted', id: 'lose', label: 'Lose the police' }],
      fail: [{ type: 'vehicle_destroyed', vehicle: 'news' }],
      lines: [say('Channel 6 cameraman (radio)', 'This is Channel 6, our van is being stolen, live, on air!'), L('Wonderful. Lose them.')],
    },
    {
      id: 'van_park', title: 'Dez', when: { choice: { ledger: 'uplink' } }, traffic: true,
      objectives: [{ type: 'reach', id: 'garage', label: 'Park the news van at Torque & Tide', pos: [2416.5, Y, 3186], r: 6, who: 'any', vehicle: 'news' }],
      fail: [{ type: 'vehicle_destroyed', vehicle: 'news' }],
    },
    {
      id: 'courier', title: 'The courier', when: { choice: { ledger: 'drive' } }, timeLimit: [150, 140, 130, 120],
      spawn: [
        { id: 'drive', kind: 'object', obj: 'package', pos: [2549.5, Y, 3110.5], label: 'Lift the encrypted drive from the courier bag', hold: 2.5 },
        { id: 'courier', kind: 'guard', patrol: [[2547.5, Y, 3112.5], [2547.5, Y, 3124.5]], name: 'Courier' },
        { id: 'courier2', kind: 'guard', patrol: [[2553.5, Y, 3112.5], [2553.5, Y, 3124.5]], minParty: 2, name: 'Courier\'s minder' },
      ],
      objectives: [{ type: 'interact', id: 'drive', label: 'Lift the courier\'s encrypted drive', targets: ['drive'] }],
      fail: [{ type: 'timer' }, { type: 'all_down' }],
      lines: [L('He sets the bag down when he checks his phone. He checks his phone constantly. Modern life is a gift.')],
      events: { alarm: [say('Courier', 'My bag! That is a signed-for delivery!')] },
    },
    { ...heat(), id: 'heat', when: { wanted: true, choice: { ledger: 'drive' } } },
    {
      id: 'walk', title: 'Dez', when: { choice: { ledger: 'drive' } }, timeLimit: [200, 200, 200, 200],
      objectives: [{ type: 'reach', id: 'garage', label: 'Bring the drive to Dez at Torque & Tide', pos: [2420, Y, 3176], r: 4, who: 'any' }],
      fail: [{ type: 'timer' }],
    },
    debrief('tw_link_out'),
  ],
  rewards: { cash: [900, 900, 900, 900], rep: 40, replayCash: 350 },
});

const prepArmour = prepBase({
  id: 'prep_tower_armour', prepFor: 'heist_tower', name: 'Tower Setup: Armoured Up',
  blurb: 'Bullseye Arms takes a delivery of body armour tonight. Two crates in the yard, one tired guard, one very loud dog. Get both crates across the road to Dez.',
  start: [2420, Y, 3176], startSpots: [[2416, Y, 3176], [2418, Y, 3176], [2420, Y, 3176], [2422, Y, 3176]], startYaw: Math.PI,
  unlock: { requires: ['heist_pier9'] },
  notes: ['OPTIONAL setup. On the night every crew member starts with +50 health.', 'Stealth: the yard guard patrols the crates. A spotted crew gets one star.'],
  stages: [
    {
      id: 'crates', title: 'The armour crates', cutscene: 'tw_armour_in', timeLimit: [170, 160, 150, 140],
      spawn: [
        { id: 'vest_a', kind: 'object', obj: 'package', pos: [2410.5, Y, 3162.5], label: 'Body-armour crate', hold: 2.5 },
        { id: 'vest_b', kind: 'object', obj: 'package', pos: [2438.5, Y, 3162.5], label: 'Body-armour crate', hold: 2.5 },
        { id: 'yard', kind: 'guard', patrol: [[2414.5, Y, 3160.5], [2434.5, Y, 3160.5]], armed: true, name: 'Bullseye night guard' },
      ],
      objectives: [{ type: 'interact', id: 'vests', label: 'Take both armour crates', targets: ['vest_a', 'vest_b'] }],
      fail: [{ type: 'timer' }, { type: 'all_down' }],
      lines: [L('Two crates, either end of the yard. The guard walks between them like a pendulum. Respect the pendulum.')],
      events: { alarm: [say('Bullseye night guard', 'Rico said nobody touches the vests! Freeze!')] },
    },
    heat(),
    {
      id: 'deliver', title: 'Dez', timeLimit: [120, 120, 120, 120],
      objectives: [{ type: 'reach', id: 'garage', label: 'Get the crates across the road to Dez', pos: [2430.5, Y, 3186], r: 5, who: 'any' }],
      fail: [{ type: 'timer' }],
    },
    debrief('tw_armour_out'),
  ],
  rewards: { cash: [800, 800, 800, 800], rep: 40, replayCash: 300 },
});

const prepBadges = prepBase({
  id: 'prep_tower_badges', prepFor: 'heist_tower', name: 'Tower Setup: Auditor Badges',
  blurb: 'Vega & Sons expect auditors next week. Ring the lobby phone to pull the receptionist away and lift two visitor badges from behind the desk.',
  start: [2517.5, Y, 3077.5], startSpots: row(2517.5, 3076.5, 2), startYaw: 0,
  unlock: { requires: ['heist_pier9'] },
  notes: ['OPTIONAL setup. Unlocks the CON approach for The Vega Tower Job: walk in as Hartwell & Crane auditors.', 'Co-op: one rings the phone, one lifts the badges, within 3 s. Solo: ring, then lift within 12 s. Office hours: nobody is suspicious, they are just busy.'],
  stages: [
    {
      id: 'badges', title: 'The front desk', cutscene: 'tw_badge_in', disguised: true, timeLimit: [150, 140, 130, 120],
      spawn: [
        { id: 'recep', kind: 'npc', role: 'receptionist', pos: [2519.5, Y, 3092], yaw: Math.PI, name: 'Marguerite (reception)' },
        { id: 'phone', kind: 'object', obj: 'keypad', pos: [2509.5, Y, 3084.5], label: 'Ring the lobby courtesy phone', hold: 1.5 },
        { id: 'badge', kind: 'object', obj: 'evidence', pos: [2526.5, Y, 3092.5], label: 'Lift the visitor badges', hold: 2 },
        { id: 'lobby_g', kind: 'guard', patrol: [[2509.5, Y, 3094.5], [2529.5, Y, 3094.5]], name: 'Lobby guard' },
      ],
      objectives: [{ type: 'interact', id: 'lift', label: 'Ring the phone and lift the badges together', targets: ['phone', 'badge'], simultaneous: { window: 3, soloWindow: 12 } }],
      fail: [{ type: 'timer' }, { type: 'all_down' }],
      lines: [say('Marguerite (reception)', 'Vega and Sons, how may I direct your... hold on, the courtesy phone again?'), L('Phone first, badges second. Smile at the guard. Guards love being smiled at, nobody does it.')],
    },
    {
      id: 'leave', title: 'Walk out', timeLimit: [60, 60, 60, 60],
      objectives: [{ type: 'reach', id: 'out', label: 'Walk out to the street', pos: [2519.5, Y, 3077.5], r: 6, who: 'any' }],
      fail: [{ type: 'timer' }],
    },
    debrief('tw_badge_out'),
  ],
  rewards: { cash: [800, 800, 800, 800], rep: 40, replayCash: 300 },
});

const TOWER_SETUPS: SetupDef[] = [
  { prep: 'prep_tower_plans', category: 'scout', perk: 'The lobby cameras and the executive office are mapped.' },
  { prep: 'prep_tower_convoy', category: 'scout', perk: 'The Palm Armour truck waits on the east edge of downtown.' },
  { prep: 'prep_tower_boat', category: 'escape', perk: 'The Reef Runner waits below the Port Bridge.' },
  { prep: 'prep_tower_link', category: 'equipment', perk: 'Nix can copy the wire-transfer ledger.', choice: { key: 'ledger', label: 'Ledger copy', options: [
    { id: 'uplink', name: 'Satellite uplink', desc: 'Hold the executive office while Nix pulls the whole ledger. Worth $9,000.' },
    { id: 'drive', name: 'Courier drive', desc: 'Plug in and walk out. Worth $4,500.' },
  ] } },
  { prep: 'prep_tower_armour', category: 'equipment', optional: true, perk: '+50 health for every crew member.', bonus: { hp: 50 } },
  { prep: 'prep_tower_badges', category: 'disguise', optional: true, perk: 'Unlocks the Con approach: walk in as Hartwell & Crane forensic auditors.' },
];

const heistTower: ActivityDef = {
  id: 'heist_tower', kind: 'heist', name: 'The Vega Tower Job', giver: 'lena',
  blurb: 'One night, three locations: the Vega & Sons executive office, the Palm Armour truck waiting on the east edge of downtown, and a fast boat out across the lagoon. Lena calls it her masterpiece. Nobody else has seen the budget.',
  start: [2517.5, Y, 3077.5], startSpots: row(2517.5, 3076.5, 2), startYaw: 0,
  unlock: { requires: ['heist_pier9', 'story_7'] }, minPlayers: 1, maxPlayers: 4, lateJoin: 'roster_reconnect', replayable: true,
  preps: TOWER_SETUPS.map((s) => s.prep), music: 'heist_action',
  heist: {
    baseTake: 32000,
    approaches: ['quiet', 'loud', 'con'],
    approachNeeds: { con: 'prep_tower_badges' },
    equipment: [
      { id: 'lockpick', name: 'Pro lockpick set', desc: 'The executive-office lock opens in 3 s instead of 6 s.', approach: 'quiet', effects: [{ obj: 'lock', key: 'lock', hold: 3 }] },
      { id: 'jammer', name: 'Signal jammer', desc: 'Both-at-once panels (cameras, truck GPS) get double the sync window.', windowMult: 2 },
      { id: 'drill', name: 'Thermal drill', desc: 'The executive safe cracks in 7 s instead of 12 s.', effects: [{ obj: 'safe', hold: 7 }] },
      { id: 'sledge', name: 'Sledgehammer', desc: 'Cash bags and display cases come open instantly.', approach: 'loud', effects: [{ obj: 'loot', hold: 0.3 }] },
      { id: 'booster', name: 'Signal booster', desc: 'The ledger uplink finishes 30% sooner.', effects: [{ obj: 'defend', mult: 0.7 }] },
    ],
    roles: ['driver', 'hacker', 'muscle', 'lookout'],
    loudPenalty: 0.7,
    setups: TOWER_SETUPS,
    hardLives: [3, 4, 6, 7], carryLoss: 0.2, firstTimeBonus: 6000,
    elite: { label: 'Masterpiece: under 15:00, no retries, nobody knocked out', bonus: 5000, maxSeconds: 900, noRetries: true, noKnockouts: true },
    radio: LENA_RADIO,
  },
  notes: [
    'Three locations, in order: (1) Vega & Sons Imports - lobby, private office, safe and the wire-transfer ledger. (2) The Palm Armour truck on the east edge of downtown. (3) The Reef Runner on the downtown shore, out across the lagoon.',
    'Quiet: loop the lobby cameras (both at once), pick the office lock, spoof the truck\'s GPS (both at once). Con (Badges setup): sign in as auditors and get buzzed into the office. Loud: smash in, ram the truck open, fight your way to the boat.',
    'The ledger follows your Ledger Kit choice: uplink = hold the office for up to 45 s against the response team; drive = a 6 s copy. Each extra player adds a guard, a cash bag and a luxury piece.',
    'Alarm escalation: tripping the alarm brings armed responders to the tower and police for the rest of the job. Bags drop when a carrier is knocked out (20% damaged).',
    'Hard: extra armed guards, 20% shorter timers, waves always come, limited team lives, +25% take. Payout split is locked when the heist launches. Checkpoints: the office, the vault, the cash, the boat.',
  ],
  stages: [
    {
      id: 'intro', title: 'Gear up', cutscene: 'tower_intro',
      spawn: [
        { id: 'getaway', kind: 'vehicle', model: 'sedan', pos: [2540, Y, 3070.5], yaw: -Math.PI / 2, color: 0x222831, label: 'Getaway car', driverUpgrade: 'sports' },
        { id: 'getaway2', kind: 'vehicle', model: 'sedan', pos: [2556, Y, 3070.5], yaw: -Math.PI / 2, color: 0x393e46, minParty: 3, label: 'Getaway car 2' },
        { id: 'g1', kind: 'guard', patrol: [[2507.5, Y, 3086.5], [2530.5, Y, 3086.5]], armed: true, name: 'Vega security' },
        { id: 'g2', kind: 'guard', patrol: [[2507.5, Y, 3094.5], [2514.5, Y, 3094.5]], minParty: 2, name: 'Vega security' },
        { id: 'g3', kind: 'guard', patrol: [[2530.5, Y, 3092.5], [2530.5, Y, 3097.5]], minParty: 3, armed: true, name: 'Vega security' },
        { id: 'g4', kind: 'guard', patrol: [[2507.5, Y, 3098.5], [2517.5, Y, 3098.5]], minParty: 4, name: 'Vega security' },
        { id: 'g5', kind: 'guard', patrol: [[2509.5, Y, 3090.5], [2529.5, Y, 3090.5]], hard: true, armed: true, name: 'Vega enforcer' },
        { id: 'recep', kind: 'npc', role: 'receptionist', pos: [2519.5, Y, 3092], yaw: Math.PI, name: 'Marguerite (reception)' },
        { id: 'office', kind: 'door', door: 'office.office_door', state: 'locked' },
      ],
      objectives: [{ type: 'wait', id: 'gear', label: 'Gear up', seconds: 0.1 }],
    },
    {
      id: 'cams', title: 'Loop the lobby cameras', when: { approach: 'quiet' }, checkpoint: true, respawn: row(2517.5, 3077.5, 2), skipOnAlarm: true,
      spawn: [
        { id: 'kc_a', kind: 'object', obj: 'keypad', pos: [2509.5, Y, 3084.5], label: 'Camera panel A', hold: 2 },
        { id: 'kc_b', kind: 'object', obj: 'keypad', pos: [2529.5, Y, 3084.5], label: 'Camera panel B', hold: 2 },
      ],
      objectives: [{ type: 'interact', id: 'cams', label: 'Loop both lobby camera panels together', targets: ['kc_a', 'kc_b'], simultaneous: { window: 2.5, soloWindow: 25 } }],
      fail: [{ type: 'all_down' }],
      lines: [L('Two panels, opposite corners. Loop them together and the lobby goes blind for exactly four minutes.')],
    },
    {
      id: 'lock_q', title: 'Executive office', when: { approach: 'quiet' }, skipOnAlarm: true,
      spawn: [{ id: 'lock', kind: 'object', obj: 'lock', pos: [2526.5, Y, 3097.5], label: 'Pick the office lock', hold: 6 }],
      objectives: [{ type: 'interact', id: 'pick', label: 'Pick the executive-office lock', targets: ['lock'] }],
      fail: [{ type: 'all_down' }],
    },
    {
      id: 'con_lobby', title: 'Sign in', when: { approach: 'con' }, checkpoint: true, respawn: row(2517.5, 3077.5, 2), disguised: true,
      spawn: [{ id: 'signin', kind: 'object', obj: 'evidence', pos: [2519.5, Y, 3088.5], label: 'Sign in as Hartwell & Crane auditors', hold: 4 }],
      objectives: [{ type: 'interact', id: 'sign', label: 'Sign in at reception', targets: ['signin'] }],
      fail: [{ type: 'all_down' }],
      lines: [say('Marguerite (reception)', 'Auditors? Tonight? Mr. Vega did not mention... no, of course, he never mentions anything.'), L('Frown at the carpet. Auditors always frown at the carpet.')],
    },
    {
      id: 'con_office', title: 'Buzzed through', when: { approach: 'con', alarm: false }, disguised: true,
      objectives: [{ type: 'wait', id: 'buzz', label: 'Wait while reception buzzes you into the executive office', seconds: 6 }],
      lines: [say('Marguerite (reception)', 'The executive office is through there. Please do not touch the bonsai, it is insured.')],
      events: { done: [L('Door is open. The bonsai is, in fact, insured. I checked.')] },
    },
    {
      id: 'lock_l', title: 'Smash the door', when: { approach: 'loud' }, checkpoint: true, respawn: row(2517.5, 3077.5, 2),
      spawn: [{ id: 'smash', kind: 'object', obj: 'lock', pos: [2526.5, Y, 3097.5], label: 'Smash the office door', hold: 1.5 }],
      objectives: [{ type: 'interact', id: 'smash', label: 'Smash the executive-office door', targets: ['smash'] }],
      fail: [{ type: 'all_down' }],
      lines: [L('Loud. Fine. Everyone moves, nobody stops, and the police will beat us to the end of the block.')],
      events: { alarm: [say('Marguerite (reception)', 'I am under the desk! I have always wanted an excuse to be under the desk!')] },
    },
    {
      id: 'ledger_up', title: 'The uplink', when: { choice: { ledger: 'uplink' } }, checkpoint: true, respawn: row(2523.5, 3095.5, 2),
      onEnter: { doors: { office: 'open' }, alarmIfLoud: true },
      timeLimit: [150, 150, 140, 140],
      objectives: [{ type: 'defend', id: 'uplink', label: 'Hold the executive office while Nix pulls the ledger', pos: [2528.5, Y, 3101.5], r: 4, seconds: [30, 35, 40, 45] }],
      fail: [{ type: 'all_down' }, { type: 'timer' }],
      lines: [N('Uplink is talking to the terminal. It is slow and it is complete. Stay with it - if nobody is in the room, it stalls.')],
      waves: [
        { after: 10, alarmOnly: true, spawn: [enforcer('u1', [2519.5, Y, 3084.5], 'Vega responder'), enforcer('u2', [2521.5, Y, 3084.5], 'Vega responder', { minParty: 2 })], line: say('Vega responder', 'Executive floor! Go, go!') },
        { after: 16, spawn: [enforcer('u3', [2519.5, Y, 3084.5], 'Vega enforcer', { hard: true }), enforcer('u4', [2509.5, Y, 3094.5], 'Vega enforcer', { hard: true })] },
      ],
      events: { done: [N('Ledger is ours. Every transfer, every alias, every embarrassing memo line.')] },
    },
    {
      id: 'vault', title: 'The vault', checkpoint: true, respawn: row(2523.5, 3095.5, 2),
      onEnter: { doors: { office: 'open' }, alarmIfLoud: true },
      timeLimit: [200, 190, 180, 170],
      spawn: [
        { id: 'safe', kind: 'object', obj: 'safe', pos: [2531.5, Y, 3105.5], label: 'Crack the executive safe', hold: 12, value: 9000 },
        { id: 'term', kind: 'object', obj: 'keypad', pos: [2528.5, Y, 3103.5], label: 'Copy the wire-transfer ledger to the courier drive', hold: 6, value: 4500, if: { choice: { ledger: 'drive' } } },
        { id: 'term_up', kind: 'object', obj: 'keypad', pos: [2528.5, Y, 3103.5], label: 'Pull the uplink drive (full ledger)', hold: 1, value: 9000, if: { choice: { ledger: 'uplink' } } },
        { id: 'w1', kind: 'object', obj: 'loot', pos: [2527.5, Y, 3101.5], label: 'Executive watch case', hold: 1.5, value: 2000 },
        { id: 'w2', kind: 'object', obj: 'loot', pos: [2531.5, Y, 3101.5], label: 'Cash drawer', hold: 1.5, value: 1800, minParty: 2 },
        { id: 'w3', kind: 'object', obj: 'loot', pos: [2529.5, Y, 3100.5], label: 'Vintage bottles', hold: 1.5, value: 2400, minParty: 3 },
      ],
      objectives: [
        { type: 'interact', id: 'safe', label: 'Crack the executive safe', targets: ['safe'] },
        { type: 'interact', id: 'term', label: 'Take the ledger', targets: ['term', 'term_up'], count: [1, 1, 1, 1] },
        { type: 'interact', id: 'extras', label: 'Grab the luxury pieces', targets: ['w1', 'w2', 'w3'], count: [1, 2, 3, 3] },
      ],
      fail: [{ type: 'all_down' }, { type: 'timer' }],
      lines: [L('Safe, ledger, and whatever Mr. Vega keeps to feel important. In that order.')],
      waves: [{ after: 25, alarmOnly: true, spawn: [enforcer('v1', [2519.5, Y, 3084.5], 'Vega responder')] }],
    },
    {
      id: 'out', title: 'Out of the tower', checkpoint: true, respawn: row(2523.5, 3095.5, 2),
      objectives: [{ type: 'reach', id: 'front', label: 'Everyone out to the street', pos: [2519.5, Y, 3077.5], r: 8, who: 'all' }],
      fail: [{ type: 'all_down' }],
      waves: [{ after: 3, alarmOnly: true, spawn: [enforcer('o1', [2509.5, Y, 3078.5], 'Solano PD tactical'), enforcer('o2', [2531.5, Y, 3078.5], 'Solano PD tactical', { minParty: 3 })], line: say('Solano PD tactical', 'Police! Drop the bags!') }],
    },
    {
      id: 'drive', title: 'To the armoured truck', traffic: true,
      objectives: [{ type: 'reach', id: 'truck', label: 'Head for the Palm Armour truck on the east edge of downtown', pos: [2593.5, Y, 3214], r: 16, who: 'any' }],
      fail: [{ type: 'all_down' }, { type: 'loot_lost', seconds: 60 }],
      lines: [L('Location two. The truck idles on the east edge for four minutes. You have three.')],
    },
    {
      id: 'truck_q', title: 'Spoof the GPS', when: { approach: ['quiet', 'con'] }, checkpoint: true, respawn: row(2588.5, 3212.5, 2),
      spawn: [
        { id: 'truck', kind: 'vehicle', model: 'van', pos: [2593.5, Y, 3228], yaw: 0, color: 0x6c757d, label: 'Palm Armour truck' },
        { id: 'tg1', kind: 'guard', patrol: [[2588.5, Y, 3222.5], [2588.5, Y, 3236.5]], name: 'Palm Armour driver' },
        { id: 'tg2', kind: 'guard', patrol: [[2598.5, Y, 3222.5], [2598.5, Y, 3236.5]], minParty: 2, armed: true, name: 'Palm Armour guard' },
        { id: 'gp_a', kind: 'object', obj: 'keypad', pos: [2589.5, Y, 3231.5], label: 'GPS tracker A', hold: 2 },
        { id: 'gp_b', kind: 'object', obj: 'keypad', pos: [2597.5, Y, 3231.5], label: 'GPS tracker B', hold: 2 },
      ],
      objectives: [{ type: 'interact', id: 'gps', label: 'Spoof both truck GPS trackers together', targets: ['gp_a', 'gp_b'], simultaneous: { window: 2.5, soloWindow: 25 } }],
      fail: [{ type: 'all_down' }],
      lines: [N('Two GPS units, one each side. Spoof both and the depot thinks the truck is parked at a car wash.')],
      events: { alarm: [say('Palm Armour driver', 'Code red, code red! Somebody get me a supervisor!')] },
    },
    {
      id: 'truck_l', title: 'Crack the truck', when: { approach: 'loud' }, checkpoint: true, respawn: row(2588.5, 3212.5, 2),
      spawn: [
        { id: 'truckL', kind: 'vehicle', model: 'van', pos: [2593.5, Y, 3228], yaw: 0, color: 0x6c757d, label: 'Palm Armour truck' },
        { id: 'tl1', kind: 'guard', patrol: [[2588.5, Y, 3222.5], [2588.5, Y, 3236.5]], armed: true, name: 'Palm Armour guard' },
        { id: 'tl2', kind: 'guard', patrol: [[2598.5, Y, 3222.5], [2598.5, Y, 3236.5]], minParty: 2, armed: true, name: 'Palm Armour guard' },
        { id: 'smash2', kind: 'object', obj: 'lock', pos: [2593.5, Y, 3232], label: 'Break the rear door', hold: 3 },
      ],
      objectives: [{ type: 'interact', id: 'smash2', label: 'Break the truck\'s rear door', targets: ['smash2'] }],
      onEnter: { alarmIfLoud: true },
      fail: [{ type: 'all_down' }],
    },
    {
      id: 'cash', title: 'The cash', checkpoint: true, respawn: row(2588.5, 3212.5, 2),
      timeLimit: [130, 125, 120, 115],
      spawn: [
        { id: 'b1', kind: 'object', obj: 'loot', pos: [2591.5, Y, 3234.5], label: 'Cash bag', hold: 1.5, value: 3500 },
        { id: 'b2', kind: 'object', obj: 'loot', pos: [2595.5, Y, 3234.5], label: 'Cash bag', hold: 1.5, value: 3500 },
        { id: 'b3', kind: 'object', obj: 'loot', pos: [2591.5, Y, 3237.5], label: 'Cash bag', hold: 1.5, value: 3500, minParty: 2 },
        { id: 'b4', kind: 'object', obj: 'loot', pos: [2595.5, Y, 3237.5], label: 'Cash bag', hold: 1.5, value: 3500, minParty: 3 },
        { id: 'b5', kind: 'object', obj: 'loot', pos: [2593.5, Y, 3240.5], label: 'Cash bag', hold: 1.5, value: 3500, minParty: 4 },
      ],
      objectives: [{ type: 'interact', id: 'bags', label: 'Load the cash bags', targets: ['b1', 'b2', 'b3', 'b4', 'b5'], count: [2, 3, 4, 5] }],
      fail: [{ type: 'all_down' }, { type: 'timer' }],
      waves: [{ after: 15, spawn: [enforcer('t1', [2588.5, Y, 3212.5], 'Palm Armour response', { hard: true })] }],
    },
    {
      id: 'escape', title: 'Down to the water', checkpoint: true, respawn: row(2632.5, 3226.5, 0, 2),
      spawn: [{ id: 'skiff', kind: 'vehicle', model: 'boat', pos: [2650, 21, 3226], yaw: 0, color: 0xd7263d, label: 'Reef Runner' }],
      objectives: [{ type: 'enter_vehicle', id: 'boat', label: 'Everyone into the Reef Runner', vehicles: ['skiff'], who: 'all' }],
      fail: [{ type: 'all_down' }, { type: 'vehicle_destroyed', vehicle: 'skiff' }, { type: 'loot_lost', seconds: 60 }],
      lines: [say('Capt. Barney (radio)', 'Engine is warm. The gulls are elsewhere. This is our moment.')],
    },
    heat([{ type: 'all_down' }, { type: 'vehicle_destroyed', vehicle: 'skiff' }]),
    {
      id: 'drop', title: 'The cove', checkpoint: true, respawn: row(2632.5, 3226.5, 0, 2),
      objectives: [{ type: 'reach', id: 'cove', label: "Run the lagoon to Barney's cove", pos: [2670, 21, 3065], r: 12, who: 'any', vehicle: 'skiff' }],
      fail: [{ type: 'all_down' }, { type: 'vehicle_destroyed', vehicle: 'skiff' }],
    },
    debrief('tw_outro'),
  ],
  rewards: { cash: [0, 0, 0, 0], rep: 600, replayCash: 0, unlocks: [] },
};

void (null as unknown as BySize<number>);
export const SUNDIAL_ACTIVITIES: ActivityDef[] = [prepScout, prepWheels, heistSundial, prepUniforms, prepRota];
export const HEISTS_ACTIVITIES: ActivityDef[] = [prepRecon, prepKeys, prepExit, prepLights, prepOveralls, heistPier9, prepPlans, prepConvoy, prepBoat, prepLink, prepArmour, prepBadges, heistTower];

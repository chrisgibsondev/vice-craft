/**
 * Additional cutscenes (story missions 2-8, heists 2-3, mini-games). Merged into CUTSCENES by cutscenes.ts.
 *
 * Every scene is authored with `scene()`: a focus point F, a "toward" direction pointing from F into open
 * space (where the camera lives), actors placed by offset from F, and one dialogue line per shot. The
 * helper cycles four camera set-ups (establishing high, medium, low close-up, slow pull-back) so every
 * scene is 2-4 shots with real camera movement. All positions are validated by scripts/validate-content.ts.
 */
import type { CutsceneDef, Actor, Shot } from './cutscenes.ts';
import type { V3 } from './activityTypes.ts';

const Y = 22;
/** a dialogue line; an optional third element turns the shot into an aerial look at that world point (the target) */
type Line = [speaker: string, text: string, look?: V3, dir?: [number, number]];
interface ActorSpec { id: string; skin: number; name: string; off?: [number, number]; face?: [number, number] | string; anim?: Actor['anim']; role?: string }

function scene(opts: {
  id: string; music?: string; F: [number, number]; toward: [number, number];
  actors: ActorSpec[]; lines: Line[]; endYaw?: number; end?: V3[]; heightBoost?: number;
  /** distance from F to the open space the camera may use (street centre, shore ...) */ R?: number;
}): CutsceneDef {
  const { F, toward } = opts;
  const len = Math.hypot(toward[0], toward[1]) || 1;
  const t: [number, number] = [toward[0] / len, toward[1] / len];
  const p: [number, number] = [-t[1], t[0]];
  const at = (a: number, b: number, y: number): V3 => [+(F[0] + t[0] * a + p[0] * b).toFixed(2), y, +(F[1] + t[1] * a + p[1] * b).toFixed(2)];
  const hb = opts.heightBoost ?? 0;
  const R = opts.R ?? 7.5;
  // actor placement and facing (default: face the camera side)
  const pos = new Map<string, V3>();
  for (const a of opts.actors) pos.set(a.id, [F[0] + (a.off?.[0] ?? 0), Y, F[1] + (a.off?.[1] ?? 0)]);
  const yawTo = (dx: number, dz: number) => Math.atan2(-dx, -dz);
  const actors: Actor[] = opts.actors.map((a) => {
    const me = pos.get(a.id)!;
    let d: [number, number] = t;
    if (Array.isArray(a.face)) d = a.face;
    else if (typeof a.face === 'string') { const o = pos.get(a.face)!; d = [o[0] - me[0], o[2] - me[2]]; }
    return { id: a.id, role: a.role ?? 'contact', skin: a.skin, pos: me, yaw: yawTo(d[0], d[1]), anim: a.anim ?? 'talk', name: a.name };
  });
  const speakerPos = (name: string): V3 => {
    const a = opts.actors.find((x) => name.toLowerCase().startsWith(x.name.split(' ')[0].toLowerCase()) || name.toLowerCase().startsWith(x.id)) ?? opts.actors[0];
    return pos.get(a.id)!;
  };
  const shots: Shot[] = opts.lines.map(([speaker, text, target, dir], i) => {
    if (target) {
      const dur = Math.max(4, Math.min(7.5, 1.6 + text.length / 16));
      const tl: V3 = [target[0], target[1] + 1, target[2]];
      const [dx, dz] = dir ?? [1, 1];
      return { dur, cam: { from: [target[0] + 18 * dx, 42, target[2] + 18 * dz], to: [target[0] + 12 * dx, 36, target[2] + 13 * dz], lookFrom: tl, lookTo: tl, fov: 55 }, sub: { speaker, text } };
    }
    const look = speakerPos(speaker);
    const lf: V3 = [look[0], 23.6, look[2]];
    const dur = Math.max(3.6, Math.min(7.5, 1.4 + text.length / 16));
    const k = i % 4;
    let cam: Shot['cam'];
    if (k === 0) cam = { from: at(R + 1, 8, 31 + hb), to: at(R, 3, 28 + hb), lookFrom: [F[0], 23.2, F[1]], lookTo: lf, fov: 62 };
    else if (k === 1) cam = { from: at(5, 3, 24.3), to: at(4, 1.5, 24.2), lookFrom: lf, lookTo: lf, fov: 52 };
    else if (k === 2) cam = { from: at(3.2, -1.6, 23.5), to: at(2.3, -0.8, 23.7), lookFrom: lf, lookTo: lf, fov: 48 };
    else cam = { from: at(R - 2, 0, 26), to: at(R, -8, 34 + hb), lookFrom: lf, lookTo: [F[0], 23.2, F[1]], fov: 58 };
    return { dur, cam, sub: { speaker, text } };
  });
  const end: V3[] = opts.end ?? [-3, -1, 1, 3].map((b) => [+(F[0] + p[0] * b).toFixed(2), Y, +(F[1] + p[1] * b).toFixed(2)] as V3);
  return { id: opts.id, music: opts.music ?? 'cutscene', actors, shots, endSpots: end, endYaw: opts.endYaw ?? Math.atan2(t[0], t[1]) };
}

const S = (c: CutsceneDef) => [c.id, c] as const;

export const EXTRA_CUTSCENES: Record<string, CutsceneDef> = Object.fromEntries([
  // ───────────────────────────────────────────── story_2 Cold Chain
  scene({
    id: 'cold_intro', F: [2519.5, 3174.5], toward: [0, -1],
    actors: [{ id: 'marisol', skin: 3, name: 'Marisol Reyes' }],
    lines: [
      ['Marisol', 'Cold Chain. It sounds fancy. It is four crates of snapper and a van with a dead compressor.'],
      ['Marisol', 'Pier 9 loads the fish, the beach kitchens pay on delivery - if the ice is still ice by then.'],
      ['Marisol', "Don't open the crates. Don't ask what the inspection stamp cost. Just drive."],
    ],
  }),
  scene({
    id: 'cold_outro', F: [2527.5, 3174.5], toward: [0, -1],
    actors: [{ id: 'marisol', skin: 3, name: 'Marisol Reyes' }],
    lines: [
      ['Marisol', "Perfect timing. The Mango Shack chef cried. Happy tears, I think."],
      ['Marisol', "Look at this stamp. 'Vega & Sons Imports. Inspected: H. Grebe.' Fish do not weigh that much."],
      ['Marisol', 'Somebody paid good money to make those crates boring. That makes me very, very curious.'],
    ],
  }),
  // ───────────────────────────────────────────── story_3 Repo Season
  scene({
    id: 'repo_intro', F: [2430, 3174], toward: [0, -1],
    actors: [{ id: 'dez', skin: 5, name: 'Dez Morales', off: [0, 0], face: 'bruna' }, { id: 'bruna', skin: 0, name: 'Bruna Okoye', off: [2.5, 0.4], face: 'dez', anim: 'idle' }],
    lines: [
      ['Dez', "Bruna's Vireo went missing Tuesday. Not stolen. 'Repossessed' - by a tow outfit with no licence and a very nice hangar."],
      ['Bruna', "I'm eleven payments ahead. Eleven! They towed it with a smile."],
      ['Dez', 'Solano Airfield, south apron. Two breakers, guards on a loop. Take the Hauler. Bring her car home with all four wheels.'],
    ],
  }),
  scene({
    id: 'repo_outro', F: [2424.5, 3174], toward: [0, -1],
    actors: [{ id: 'dez', skin: 5, name: 'Dez Morales', face: 'bruna' }, { id: 'bruna', skin: 0, name: 'Bruna Okoye', off: [2.5, 0.4], face: 'dez', anim: 'wave' }],
    lines: [
      ['Dez', "Not a scratch. You have a gift, or terrible instincts that happen to work."],
      ['Bruna', 'New plates, fresh paint, spare key. Dez, I love you.'],
      ['Dez', "Everybody does. Tell Marisol the tow outfit's invoices all point at a Vega & Sons yard."],
    ],
  }),
  // ───────────────────────────────────────────── story_4 Neon Warm-Up
  scene({
    id: 'kilo_intro', music: 'race', F: [2568, 3174], toward: [0, -1],
    actors: [{ id: 'kilo', skin: 5, name: 'DJ Kilo', anim: 'wave' }],
    lines: [
      ['DJ Kilo', 'Welcome to the Neon Lagoon, rookie. Nobody gets on my grid until they have earned a wall.'],
      ['DJ Kilo', 'Four flyers on four corners - the scene reads walls like scripture. Then you drive my warm-up.'],
      ['DJ Kilo', 'Two laps. No bumping. No fountains. Do it right and your name goes on the board.'],
    ],
  }),
  scene({
    id: 'kilo_outro', music: 'race', F: [2566, 3174], toward: [1, -1],
    actors: [{ id: 'kilo', skin: 5, name: 'DJ Kilo', anim: 'wave' }],
    lines: [
      ['DJ Kilo', "Tidy! That's a warm-up, not a record - but you're on the board and the board remembers."],
      ['DJ Kilo', 'Downtown Sprint, the Palm Mile Trial. Next calls come from me. Keep the phone on, keep the tyres warm.'],
    ],
  }),
  // ───────────────────────────────────────────── story_5 Pier 9 After Dark
  scene({
    id: 'pier9_intro', music: 'heist_plan', F: [2471.5, 3221.5], toward: [0, -1], end: [[2467.5, Y, 3221.5], [2469.5, Y, 3221.5], [2471.5, Y, 3219.5], [2473.5, Y, 3221.5]],
    actors: [{ id: 'nix', skin: 2, name: 'Nix Valdrin', anim: 'talk' }],
    lines: [
      ['Nix', 'Every Vega crate that left the diner came off Pier 9. I counted. Twice - once with a spreadsheet, once out of spite.'],
      ['Nix', 'East door, guards on a loop, one office terminal. I need two sessions open at once: one copies, one scrubs.'],
      ['Nix', "You're the legs, I'm the brain. Let's not swap."],
    ],
  }),
  scene({
    id: 'pier9_outro', music: 'heist_plan', F: [2693.5, 3222.5], toward: [-1, -0.3],
    actors: [{ id: 'nix', skin: 2, name: 'Nix Valdrin', anim: 'talk' }],
    lines: [
      ['Nix', 'Got it. Hollis Grebe signs every shipping sheet - and the same Last Key address shows up forty times.'],
      ['Nix', 'Which means Grebe is about to learn what a leaked ledger feels like. He will not enjoy it.'],
    ],
  }),
  // ───────────────────────────────────────────── story_6 Heat Index
  scene({
    id: 'heat_intro', music: 'heist_action', F: [2519.5, 3174.5], toward: [0, -1],
    actors: [{ id: 'marisol', skin: 3, name: 'Marisol Reyes' }],
    lines: [
      ['Marisol', 'Grebe sold your face to the cops. Wonderful man. Never trust anyone with a laminated badge.'],
      ['Marisol', 'Three stars the second you move. Scatter the drives - drain, bus stop, planter, news box - then shake the tail.'],
      ['Marisol', "Then home. Dez has the shutter ready. Go."],
    ],
  }),
  scene({
    id: 'heat_outro', F: [2424.5, 3174], toward: [0, -1],
    actors: [{ id: 'dez', skin: 5, name: 'Dez Morales', anim: 'talk' }],
    lines: [
      ['Dez', "Shutter's down. Nobody saw anything. Not seeing anything is a skill - ask Grebe."],
      ['Dez', "Marisol says the last page of the ledger is Conch Harbor on Last Key. Barney Quill is your ferry. Fair warning: he doesn't like gulls."],
    ],
  }),
  // ───────────────────────────────────────────── story_7 Dead Reckoning
  scene({
    id: 'barney_intro', F: [2827.5, 3243.5], toward: [1, 0],
    actors: [{ id: 'barney', skin: 6, name: 'Capt. Barney Quill', face: [1, 0.5], anim: 'talk' }],
    lines: [
      ['Barney', "Don't look at the gulls. ...You looked at the gulls. They know now."],
      ['Barney', "The lagoon's a bathtub - causeway dams at both ends. Real water is out here on the Atlantic side. That's why the Quill lives here."],
      ['Barney', "Conch Harbor, Last Key. A hundred seconds of open sea. Keep her low, keep her quiet, keep your voice down."],
    ],
  }),
  scene({
    id: 'conch_arrival', F: [1360.5, 4288.5], toward: [1, 0],
    actors: [{ id: 'barney', skin: 6, name: 'Capt. Barney Quill', face: [-1, 0], anim: 'talk' }],
    lines: [
      ['Barney', "We're in. Nobody followed us - which is exactly what somebody following us would want us to think."],
      ['Barney', 'Vega ships through the harbour office behind those shacks. Collect the receipts before the tide turns.'],
    ],
  }),
  scene({
    id: 'conch_outro', F: [1356.5, 4290.5], toward: [1, -0.2],
    actors: [{ id: 'barney', skin: 6, name: 'Capt. Barney Quill', face: [1, 0], anim: 'talk' }],
    lines: [
      ['Barney', "That's a boat on the horizon. That's the same boat as Solano. They're ahead of us. How do they -"],
      ['Barney', "Gulls. It's gulls. Back aboard. I'll sail you home. Don't wave."],
    ],
  }),
  // ───────────────────────────────────────────── story_8 Open Books
  scene({
    id: 'finale_intro', music: 'heist_plan', F: [2519.5, 3174.5], toward: [0, -1],
    actors: [
      { id: 'marisol', skin: 3, name: 'Marisol Reyes', off: [0, 0], face: [0, -1] },
      { id: 'lena', skin: 1, name: 'Lena Voss', off: [-2.2, 0.3], face: 'marisol', anim: 'idle' },
      { id: 'nix', skin: 2, name: 'Nix Valdrin', off: [2.2, 0.3], face: 'marisol', anim: 'idle' },
      { id: 'dez', skin: 5, name: 'Dez Morales', off: [4.4, 0.6], face: 'marisol', anim: 'idle' },
    ],
    lines: [
      ['Marisol', "Everyone's here. Good. I hate repeating myself and tonight I would have to do it four times."],
      ['Lena', "Three stops. Vega's tower for the ledger, Pier 9 for Grebe's copy, then the one honest cop in the county."],
      ['Nix', 'I can loop the lobby feed for about ninety seconds. After that I am a girl with a laptop, watching you.'],
      ['Dez', "Van's gassed, brakes are mine. Come back with all your fingers."],
    ],
  }),
  scene({
    id: 'finale_outro', music: 'heist_plan', F: [2423.5, 3078.5], toward: [1, -0.4],
    actors: [
      { id: 'okafor', skin: 6, name: 'Sgt. Okafor', off: [0, 0], face: 'marisol' },
      { id: 'marisol', skin: 3, name: 'Marisol Reyes', off: [2.2, 0.4], face: 'okafor', anim: 'idle' },
    ],
    lines: [
      ['Okafor', 'Two ledgers and a briefcase. Two in the morning. On my steps.'],
      ['Okafor', 'Do you know how long I have waited for somebody to be this inconvenient to Vega & Sons?'],
      ['Marisol', "Open the books, Sergeant. Slowly. He'll want to read his own name."],
    ],
  }),
  // ───────────────────────────────────────────── heists
  scene({
    id: 'pier9_heist_intro', music: 'heist_plan', F: [2693.5, 3224.5], toward: [-1, -0.3],
    actors: [{ id: 'lena', skin: 1, name: 'Lena Voss', face: 'nix' }, { id: 'nix', skin: 2, name: 'Nix Valdrin', off: [0, 2.4], face: 'lena', anim: 'idle' }],
    lines: [
      ['Lena', "Pier 9. Thursday's boat leaves at dawn, loaded with whatever Vega can't keep in a bank."],
      ['Nix', 'Two ways in: the side door and patience, or the shutter and bravery. I vote patience. I will be on the headset.'],
      ['Lena', 'Safe in the office, crates on the floor, a skiff on the east dock. Your move.'],
    ],
  }),
  scene({
    id: 'tower_intro', music: 'heist_plan', F: [2517.5, 3077.5], toward: [0, -1], end: [[2517.5, Y, 3076.5], [2519.5, Y, 3076.5], [2521.5, Y, 3076.5], [2523.5, Y, 3076.5]],
    actors: [{ id: 'lena', skin: 1, name: 'Lena Voss', face: 'nix' }, { id: 'nix', skin: 2, name: 'Nix Valdrin', off: [-2.4, 0], face: 'lena', anim: 'idle' }],
    lines: [
      ['Lena', 'Tonight is the tower. Executive safe, wire-transfer ledger, an armoured truck on its Friday route, and a boat to get away.'],
      ['Lena', 'Three stops. If anything feels easy, I want to know why.'],
      ['Nix', "Cameras are mine. The truck's GPS is also mine. Please stop making me do two things at once."],
    ],
  }),
  // ───────────────────────────────────────────── mini-games
  scene({
    id: 'trial_intro', music: 'race', F: [2597.5, 3196.5], toward: [-1, 0], R: 7,
    actors: [{ id: 'kilo', skin: 5, name: 'DJ Kilo', anim: 'wave' }],
    lines: [
      ['DJ Kilo', 'Palm Mile. The whole ring: downtown, causeway, beach, causeway, home. One lap, one clock, nobody to blame.'],
      ['DJ Kilo', "Gold, silver, bronze. Beat the board and I'll read your name out on the radio."],
    ],
  }),
  scene({
    id: 'taxi_intro', F: [2448.5, 3172.5], toward: [0, -1],
    actors: [{ id: 'ivo', skin: 4, name: 'Ivo Reyes', anim: 'talk' }],
    lines: [
      ['Ivo', "Sunline Cab Co. Four fares a shift. Smile if you like - the meter's a suggestion and the tip's a gift."],
      ['Ivo', 'Pull up, hop out, tap them in. And if anyone asks, I have never met you.'],
    ],
  }),
  scene({
    id: 'delivery_intro', F: [2471.5, 3221.5], toward: [0, -1], end: [[2467.5, Y, 3221.5], [2469.5, Y, 3221.5], [2471.5, Y, 3219.5], [2473.5, Y, 3221.5]],
    actors: [{ id: 'dez', skin: 5, name: 'Dez Morales', anim: 'talk' }],
    lines: [
      ['Dez', 'Quik Pelican parcel run. The depot shuts at five, the rush starts at four-thirty. Load, drive, repeat.'],
      ['Dez', "Every address is somewhere you've driven past. None of them are on your way."],
    ],
  }),
  scene({
    id: 'boatrace_intro', music: 'race', F: [2635.5, 3103.5], toward: [1, 0.2], end: [[2635.5, Y, 3098.5], [2635.5, Y, 3100.5], [2635.5, Y, 3102.5], [2635.5, Y, 3104.5]],
    actors: [{ id: 'barney', skin: 6, name: 'Capt. Barney Quill', face: [1, 0], anim: 'talk' }],
    lines: [
      ['Barney', "The Lagoon Cup. Three laps, identical boats. You'll pass through each other - they're ghosts - but the buoys will still judge you."],
      ['Barney', "Mind the buoys. They're not buoys."],
    ],
  }),
  scene({
    id: 'range_intro', F: [2710.5, 3209.5], toward: [0, -1],
    actors: [{ id: 'dez', skin: 5, name: 'Dez Morales', anim: 'talk' }],
    lines: [
      ['Dez', 'Bullseye range, Port Island. Three waves, one stun pistol, zero excuses.'],
      ['Dez', "Hit everything once. Missing costs seconds, not dignity - the dignity's already gone."],
    ],
  }),
].map(S));

// ═════════════════════════════════════════════════════════════════════ heist setups & finales
// Lena Voss plans every job: ex-insurance investigator, laminated checklists, talks in odds and claims
// ("policyholders"), hates the word "improvise". Nix is her tech on the headset. Lena's lockup is the
// old bait shop on the south side of Solano Plaza.
const LOCK = { F: [2471.5, 3221.5] as [number, number], toward: [0, -1] as [number, number], end: [[2467.5, Y, 3221.5], [2469.5, Y, 3221.5], [2471.5, Y, 3219.5], [2473.5, Y, 3221.5]] as V3[] };
const SHACK = { F: [2693.5, 3222.5] as [number, number], toward: [-1, -0.3] as [number, number] };
const TOWER = { F: [2517.5, 3077.5] as [number, number], toward: [0, -1] as [number, number], end: [[2517.5, Y, 3076.5], [2519.5, Y, 3076.5], [2521.5, Y, 3076.5], [2523.5, Y, 3076.5]] as V3[] };
const GARAGE = { F: [2424.5, 3174] as [number, number], toward: [0, -1] as [number, number] };
const LENA = (extra: Partial<ActorSpec> = {}): ActorSpec => ({ id: 'lena', skin: 1, name: 'Lena Voss', anim: 'talk', ...extra });
const NIX = (extra: Partial<ActorSpec> = {}): ActorSpec => ({ id: 'nix', skin: 2, name: 'Nix Valdrin', off: [2.4, 0.4], face: 'lena', anim: 'idle', ...extra });
const DEZ = (extra: Partial<ActorSpec> = {}): ActorSpec => ({ id: 'dez', skin: 5, name: 'Dez Morales', anim: 'talk', ...extra });
const GREBE = (extra: Partial<ActorSpec> = {}): ActorSpec => ({ id: 'grebe', skin: 7, name: 'Hollis Grebe', anim: 'talk', ...extra });
const BARNEY = (extra: Partial<ActorSpec> = {}): ActorSpec => ({ id: 'barney', skin: 6, name: 'Capt. Barney Quill', anim: 'talk', ...extra });
const TG = {
  jewelers: [2520, 22, 3141] as V3, ocean: [2797, 22, 3150] as V3, laundry: [2576, 22, 3210] as V3,
  diner: [2519, 22, 3178] as V3, warehouse: [2712, 22, 3240] as V3, westDock: [2657, 21, 3204] as V3, substation: [2716, 22, 3210] as V3,
  tower: [2519, 22, 3095] as V3, route: [2597, 22, 3173] as V3, gunstore: [2424, 22, 3143] as V3, lobby: [2519.5, 22, 3088] as V3, yard: [2700, 22, 3200] as V3,
};

const HEIST_SCENES: CutsceneDef[] = [
  // ─────────────────────────── The Sundial Job
  scene({ id: 'sd_heist_intro', music: 'heist_plan', ...LOCK, actors: [LENA({ face: 'nix' }), NIX()],
    lines: [
      ['Lena', 'Tonight we file a claim against Sundial Jewelers. They are fully insured. I checked. Twice.'],
      ['Lena', 'Night clerk, three guards, two alarm keypads and a time-locked safe that drills open if somebody stands next to it.', TG.jewelers],
      ['Nix', 'I will be in your ear the whole time. Please do not eat crisps on comms. It sounds like gunfire.'],
    ] }),
  scene({ id: 'sd_out_gt', music: 'heist_plan', ...SHACK, actors: [LENA({ face: [-1, 0] })],
    lines: [
      ['Lena', 'Stones in the crate, crate on the Thursday boat, boat out of the county. Claim settled.'],
      ['Lena', 'For the record, policyholders: that came in above my estimate. Do not let it go to your heads.'],
    ] }),
  scene({ id: 'sd_out_van', music: 'heist_plan', ...GARAGE, actors: [LENA({ face: 'dez' }), DEZ({ off: [2.5, 0.4], face: 'lena', anim: 'idle' })],
    lines: [
      ['Dez', 'You brought my van back with forty new holes in it. I am choosing to see that as ventilation.'],
      ['Lena', 'Stones are in the toolbox, the toolbox is in the wall. Pay day is tomorrow. Sleep with your phones on.'],
    ] }),
  scene({ id: 'sd_scout_in', ...LOCK, actors: [LENA({ face: [0, -1] })],
    lines: [
      ['Lena', 'Every job starts with paperwork. Ours starts with photographs. Sundial Jewelers: front, back and side.'],
      ['Lena', 'Front cameras, the back door, and the alarm company sticker. The sticker tells me which company I used to audit.', TG.jewelers],
      ['Lena', 'Walk, do not loiter. Tourists loiter. Tourists also get arrested.'],
    ] }),
  scene({ id: 'sd_scout_out', ...LOCK, actors: [LENA({ face: [0, -1], anim: 'idle' })],
    lines: [
      ['Lena', 'Brightwatch Alarms. Their keypads reset if you do them one at a time. So: two at once. Noted.'],
      ['Lena', 'Good photographs. Slightly crooked. I will live.'],
    ] }),
  scene({ id: 'sd_wheels_in', ...LOCK, actors: [LENA({ face: 'nix' }), NIX()],
    lines: [
      ['Lena', 'A getaway car is a liability you can drive. Pick the one that suits the risk profile.'],
      ['Nix', 'Option one: a tourist left a Vireo GT on Ocean Drive. Option two: a Palm Armour training van in the Port Island yard. Bulletproof-ish.', TG.ocean],
      ['Lena', 'Fast and fragile, or slow and stubborn. Either way it ends up in Dez\'s garage without a scratch.'],
    ] }),
  scene({ id: 'sd_wheels_out', ...GARAGE, actors: [DEZ()],
    lines: [
      ['Dez', 'New plates, new paint, same terrible owner. It will be out back of the jewellers when you need it.'],
      ['Lena (radio)', 'Getaway logged. Do not take it for a spin. I can see the odometer.'],
    ] }),
  scene({ id: 'sd_unif_in', ...LOCK, actors: [LENA({ face: [0, -1] })],
    lines: [
      ['Lena', 'Brightwatch technicians do a routine inspection at Sundial twice a year. The clerk lets them in and makes them tea.'],
      ['Lena', 'Their laundry car parks outside the Neon Lagoon. The driver naps. Take two uniforms, not the car.', TG.laundry],
      ['Lena', 'Then Threadline stitches our names on. Pick a name you can answer to under stress.'],
    ] }),
  scene({ id: 'sd_unif_out', ...LOCK, actors: [LENA({ face: [0, -1], anim: 'idle' })],
    lines: [
      ['Lena', 'Uniforms pressed. You are now Brightwatch field staff. The con approach is open on the board.'],
      ['Lena', 'If anyone asks for your technician number, it is 4417. It is always 4417.'],
    ] }),
  scene({ id: 'sd_rota_in', ...LOCK, actors: [LENA({ face: 'nix' }), NIX()],
    lines: [
      ['Lena', 'Halvorsen Patrol runs the guards at Sundial. Their night supervisor eats pancakes at the Sunny Side every evening at nine.'],
      ['Nix', 'He leaves the rota clipboard on his passenger seat. Window down. Like a man asking to be robbed.', TG.diner],
      ['Lena', 'Lift the rota and one guard gets reassigned on the night. Optional, but I recommend it. Strongly. In writing.'],
    ] }),
  scene({ id: 'sd_rota_out', ...LOCK, actors: [LENA({ face: [0, -1] })],
    lines: [
      ['Lena', 'Rota amended. Officer Pruitt is now guarding a car park in Bayside. He seems thrilled.'],
      ['Lena', 'One fewer guard and more time inside. Write that down. Actually, I already did.'],
    ] }),
  // ─────────────────────────── The Pier 9 Shuffle
  scene({ id: 'p9_out_skiff', music: 'heist_plan', ...SHACK, actors: [LENA({ face: [-1, 0] }), BARNEY({ off: [0, 2.4], face: 'lena', anim: 'idle' })],
    lines: [
      ['Capt. Barney', 'Not one gull followed us. Not one. Either they have retired or they have upgraded.'],
      ['Lena', 'Manifest safe, cargo crates, and Vega & Sons will spend a week blaming each other. That is called a clean shuffle.'],
    ] }),
  scene({ id: 'p9_out_truck', music: 'heist_plan', ...GARAGE, actors: [LENA({ face: 'dez' }), DEZ({ off: [2.5, 0.4], face: 'lena', anim: 'idle' })],
    lines: [
      ['Dez', 'Customs truck. Customs stickers. Customs bullet holes. I am peeling it all off tonight.'],
      ['Lena', 'The cargo is sold by Friday. Vega files a claim. I would love to see who they get to investigate it.'],
    ] }),
  scene({ id: 'p9_recon_in', ...LOCK, actors: [LENA({ face: 'nix' }), NIX()],
    lines: [
      ['Lena', 'Pier 9. Vega & Sons keep a warehouse of dockside produce on Port Island. Produce does not need four guards.'],
      ['Nix', 'I need eyes on all four sides: loading shutter, side door, camera pole and the guard shack. Photos, not selfies.', TG.warehouse],
      ['Lena', 'Treat it like a site survey. Clipboard energy. Nobody stops a clipboard.'],
    ] }),
  scene({ id: 'p9_recon_out', ...SHACK, actors: [NIX({ off: [0, 0], face: [-1, 0], anim: 'talk' })],
    lines: [
      ['Nix', 'Camera pole runs on one relay box. Side door is a 1998 lock. I want to frame these photos.'],
      ['Nix', 'Census complete. The warehouse has opinions and we now know all of them.'],
    ] }),
  scene({ id: 'p9_keys_in', ...SHACK, actors: [LENA({ face: 'grebe' }), GREBE({ off: [0, 2.4], face: 'lena' })],
    lines: [
      ['Hollis Grebe', 'I take a forty-minute lunch. Officially it is twenty. My keys stay on the pegs in the shack. I see nothing. I am at lunch.'],
      ['Lena', 'Two key rings, two guards walking past the shack. Stun them if you must, but nobody sees you lift them.', TG.warehouse],
      ['Hollis Grebe', 'And put them back crooked. If they are straight, people get suspicious of me.'],
    ] }),
  scene({ id: 'p9_keys_out', ...SHACK, actors: [GREBE({ face: [-1, 0] })],
    lines: [
      ['Hollis Grebe', 'Gate ring and forklift ring, copied. I will find my originals in the lost property box. Shocked. Delighted.'],
      ['Lena (radio)', 'Keys logged. The side door has no idea what is coming. Neither does its insurer.'],
    ] }),
  scene({ id: 'p9_exit_in', ...LOCK, actors: [LENA({ face: 'nix' }), NIX()],
    lines: [
      ['Lena', 'Exits. The most underpriced part of any plan. We have two quotes.'],
      ['Nix', 'Quote one: Barney\'s skiff round the island and out the east channel. Quote two: a customs pickup and the bridge, with Dez waiting.', TG.westDock],
      ['Lena', 'Water is quiet and slow to chase. The road is fast and loud. Your call. I will judge you either way.'],
    ] }),
  scene({ id: 'p9_exit_out', ...SHACK, actors: [BARNEY({ face: [-1, 0] })],
    lines: [
      ['Capt. Barney', 'Your exit is booked. Fuelled, facing the right way, and blessed by a man who distrusts birds.'],
      ['Lena (radio)', 'Exit logged. If a gull asks, you never met him.'],
    ] }),
  scene({ id: 'p9_lights_in', ...LOCK, actors: [LENA({ face: 'nix' }), NIX({ anim: 'talk' })],
    lines: [
      ['Nix', 'The dock cameras and the floodlights share one harbour substation. Two relay cabinets. Pull both together and the whole yard naps.'],
      ['Lena', 'Optional. On the night it means no camera relays to cut and a lot less light on you.', TG.substation],
      ['Nix', 'Solo is fine, just quick. The cabinets reboot if they think they are alone. Relatable.'],
    ] }),
  scene({ id: 'p9_lights_out', ...SHACK, actors: [NIX({ off: [0, 0], face: [-1, 0], anim: 'talk' })],
    lines: [
      ['Nix', 'Substation is on my timer now. On the night the yard goes dark for exactly as long as I say. Power.'],
      ['Lena (radio)', 'Floodlights dealt with. One fewer job inside the warehouse. I love a shorter checklist.'],
    ] }),
  scene({ id: 'p9_over_in', ...SHACK, actors: [LENA({ face: 'grebe' }), GREBE({ off: [0, 2.4], face: 'lena' })],
    lines: [
      ['Hollis Grebe', 'The night roster has room for two temporary dockhands. Temporary is my favourite kind of employee.'],
      ['Lena', 'Collect the overalls and the union cards on the island and bring them to Grebe at the shack. Then you walk in the front.', TG.yard],
      ['Hollis Grebe', 'Do not wear your own shoes. Dockhands can smell good shoes.'],
    ] }),
  scene({ id: 'p9_over_out', ...SHACK, actors: [GREBE({ face: [-1, 0] })],
    lines: [
      ['Hollis Grebe', 'Stamped, filed and back-dated. Congratulations: you have worked here for three years and nobody likes you.'],
      ['Lena (radio)', 'Con approach open for Pier 9. Clock in, look bored, steal everything.'],
    ] }),
  // ─────────────────────────── The Vega Tower Job
  scene({ id: 'tw_outro', music: 'heist_plan', ...LOCK, actors: [LENA({ face: 'nix' }), NIX()],
    lines: [
      ['Nix', 'Ledger copied, truck lighter, and Vega\'s tower is calling every number it has. Including mine. I did not answer.'],
      ['Lena', 'Three locations, one night, and an expense report I will frame. Masterpiece is a strong word. Tonight it is accurate.'],
    ] }),
  scene({ id: 'tw_plans_in', ...TOWER, actors: [LENA({ face: 'nix' }), NIX({ off: [-2.4, 0] })],
    lines: [
      ['Lena', 'The Vega & Sons tower. Mid-sized building, enormous opinion of itself. I want it photographed like a crime scene.'],
      ['Nix', 'Roof vents, loading bay, fire stairs, lobby doors. From the street. Do not wave at the receptionist.', TG.tower, [0.6, -1.6]],
      ['Lena', 'Four photographs and we know every way in and every way out. The rest is detail.'],
    ] }),
  scene({ id: 'tw_plans_out', ...TOWER, actors: [NIX({ off: [0, 0], face: [0, -1], anim: 'talk' })],
    lines: [
      ['Nix', 'Two camera panels in the lobby. Opposite corners. Of course. Everything is always opposite corners.'],
      ['Lena (radio)', 'Floor plans assembled. The executive office is on the ground floor behind the lobby. Vanity is so convenient.'],
    ] }),
  scene({ id: 'tw_convoy_in', ...LOCK, actors: [LENA({ face: 'nix' }), NIX()],
    lines: [
      ['Lena', 'Palm Armour runs a cash truck down the east edge of downtown every Friday. Same stops, same times. Bless them.'],
      ['Nix', 'Sit on the route, photograph each stop and plant my tracker. Use the observation car. Do not tail it like a movie.', TG.route],
      ['Lena', 'If the driver spots you, he radios it in, and I have to invent a whole new truck.'],
    ] }),
  scene({ id: 'tw_convoy_out', ...LOCK, actors: [LENA({ face: 'nix' }), NIX({ anim: 'talk' })],
    lines: [
      ['Nix', 'Tracker is live. The truck idles on the east edge for four minutes every Friday. Four minutes is a lifetime.'],
      ['Lena', 'Route logged. On the night the truck waits where we want it. Like a well-trained dog with money in it.'],
    ] }),
  scene({ id: 'tw_boat_in', ...SHACK, actors: [LENA({ face: 'barney' }), BARNEY({ off: [0, 2.4], face: 'lena' })],
    lines: [
      ['Capt. Barney', 'The Reef Runner is available. Do not ask from whom. Do not ask what available means.'],
      ['Lena', 'West dock. The harbour patrol takes an interest the second you cast off, so lose them before you tie up below the Port Bridge.', TG.westDock],
      ['Capt. Barney', 'And mind the gulls. They have radios now. I have seen the little antennae.'],
    ] }),
  scene({ id: 'tw_boat_out', ...SHACK, actors: [BARNEY({ face: [-1, 0] })],
    lines: [
      ['Capt. Barney', 'Runner is tied up below the bridge and facing open water. Like a horse that knows.'],
      ['Lena (radio)', 'Boat in position. Our last mile is sorted. I feel almost relaxed. It is unpleasant.'],
    ] }),
  scene({ id: 'tw_link_in', ...LOCK, actors: [LENA({ face: 'nix' }), NIX({ anim: 'talk' })],
    lines: [
      ['Nix', 'The wire-transfer ledger. I can copy it two ways. Fast and small, or slow and complete.'],
      ['Nix', 'Slow: we borrow the Channel 6 news van and its satellite uplink, and I pull the whole ledger while you hold the room. Worth double.', TG.laundry],
      ['Lena', 'Fast: a courier\'s encrypted drive from downtown. Grab it, plug it in, walk out. Pick your appetite.'],
    ] }),
  scene({ id: 'tw_link_out', ...GARAGE, actors: [DEZ()],
    lines: [
      ['Dez', 'Whatever this is, it beeps. I put it in the back next to the other thing that beeps.'],
      ['Lena (radio)', 'Ledger kit secured. Nix has stopped refreshing her inbox. That is how I know she is happy.'],
    ] }),
  scene({ id: 'tw_armour_in', ...LOCK, actors: [LENA({ face: [0, -1] })],
    lines: [
      ['Lena', 'Actuarially speaking, the tower is the job where somebody gets shot at. I would like that somebody to be wearing armour.'],
      ['Lena', 'Bullseye Arms takes a delivery of body armour tonight. Two crates in the yard, one tired guard, one very loud dog.', TG.gunstore],
      ['Lena', 'Optional. Every crew member starts the tower tougher. I would call it a premium.'],
    ] }),
  scene({ id: 'tw_armour_out', ...GARAGE, actors: [DEZ()],
    lines: [
      ['Dez', 'Vests are in the van. They smell like a gym bag, which is how you know they work.'],
      ['Lena (radio)', 'Armour logged. Do not test it on purpose.'],
    ] }),
  scene({ id: 'tw_badge_in', ...TOWER, actors: [LENA({ face: 'nix' }), NIX({ off: [-2.4, 0] })],
    lines: [
      ['Lena', 'Vega & Sons are expecting auditors next week. I would like them to arrive early. As us.'],
      ['Nix', 'Visitor badges live behind the reception desk. The receptionist leaves her desk for exactly one reason: the lobby phone.', TG.lobby, [0.6, -1.4]],
      ['Lena', 'One of you rings the phone, one of you lifts the badges. Solo: be quick and be polite.'],
    ] }),
  scene({ id: 'tw_badge_out', ...TOWER, actors: [LENA({ face: [0, -1], anim: 'idle' })],
    lines: [
      ['Lena', 'Badges printed. You are now Hartwell & Crane, forensic auditors. You hate everything you see.'],
      ['Lena', 'Con approach open on the board. Walk in the front door and frown at the carpet.'],
    ] }),
];
Object.assign(EXTRA_CUTSCENES, Object.fromEntries(HEIST_SCENES.map(S)));

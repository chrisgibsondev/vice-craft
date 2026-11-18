/**
 * Data model for missions, heists, heist setups and mini-games. The server runs one
 * generic state machine over these definitions (apps/server/src/activities/runner.ts).
 *
 * Party-size scaling: any `BySize<T>` is an array indexed by (party size - 1).
 */
export type V3 = [number, number, number];
export type BySize<T> = [T, T, T, T];
export type ActivityKind = 'mission' | 'heist' | 'heist_prep' | 'minigame';
export type Role = 'none' | 'driver' | 'hacker' | 'muscle' | 'lookout';
/** heist play styles: quiet (stealth), loud (smash and grab), con (disguises: walk in the front door) */
export type Approach = 'quiet' | 'loud' | 'con';
export type Difficulty = 'normal' | 'hard';
export type DialogueLine = { speaker: string; text: string };

/**
 * Conditions on the heist plan and the live run. Used by stages (`when`) and spawns (`if`).
 * `choice` matches the leader's setup choices (e.g. { getaway: 'van' }); `setup`/`noSetup`
 * test whether an (optional) setup was completed; `crew` splits solo/co-op variants.
 */
export interface Cond {
  approach?: Approach | Approach[];
  difficulty?: Difficulty;
  choice?: Record<string, string>;
  setup?: string;
  noSetup?: string;
  crew?: 'solo' | 'coop';
}
export interface StageWhen extends Cond { alarm?: boolean; wanted?: boolean }

interface SpawnBase { id: string; minParty?: number; /** only spawn when this holds */ if?: Cond; /** only on Hard */ hard?: boolean }
export interface SpawnVehicle extends SpawnBase { kind: 'vehicle'; model: string; pos: V3; yaw: number; color?: number; label?: string; /** per racer: one each */ perPlayer?: boolean; ghost?: boolean; /** model used when someone in the crew plays Driver */ driverUpgrade?: string }
export interface SpawnObject extends SpawnBase { kind: 'object'; obj: 'package' | 'loot' | 'keypad' | 'safe' | 'photo' | 'target' | 'evidence' | 'lock'; pos: V3; label: string; hold: number; value?: number; yaw?: number }
export interface SpawnGuard extends SpawnBase {
  kind: 'guard'; patrol: V3[];
  /** always returns fire once the alarm is up */ armed?: boolean;
  /** response-team member: hunts the crew once the alarm is up (apps/server/src/world/heistAi.ts) */ enforcer?: boolean;
  hp?: number; name?: string;
}
export interface SpawnDoor extends SpawnBase { kind: 'door'; door: string; state: 'open' | 'closed' | 'locked' }
export interface SpawnNpc extends SpawnBase { kind: 'npc'; role: string; pos: V3; yaw: number; name?: string }
export type SpawnDef = SpawnVehicle | SpawnObject | SpawnGuard | SpawnDoor | SpawnNpc;

export type ObjectiveDef =
  | { type: 'reach'; id: string; label: string; pos: V3; r: number; who: 'any' | 'all'; vehicle?: string }
  | { type: 'enter_vehicle'; id: string; label: string; vehicles: string[]; who: 'any' | 'all' }
  | { type: 'interact'; id: string; label: string; targets: string[]; count?: BySize<number>;
      /** cooperative: all targets must be held within `window` seconds of each other. Solo/insufficient players: sequential within `soloWindow`. */
      simultaneous?: { window: number; soloWindow: number } }
  | { type: 'lose_wanted'; id: string; label: string }
  | { type: 'checkpoints'; id: string; label: string; points: V3[]; laps: number; r: number }
  | { type: 'shoot'; id: string; label: string; targets: string[]; count: BySize<number> }
  | { type: 'wait'; id: string; label: string; seconds: number }
  /** hold a zone: progress runs while at least one standing crew member is inside (drill running, upload, crane).
   *  Co-op: one holds the zone while the others deal with the response; solo: shorter. */
  | { type: 'defend'; id: string; label: string; pos: V3; r: number; seconds: BySize<number> };

export type FailDef =
  | { type: 'vehicle_destroyed'; vehicle: string }
  | { type: 'all_down' }
  | { type: 'timer' }
  | { type: 'detected' }
  /** a dropped loot bag lay on the ground longer than `seconds` (the police bag it) */
  | { type: 'loot_lost'; seconds: number };

/** event-triggered radio / NPC lines (subtitles) */
export interface StageEvents {
  alarm?: DialogueLine[]; loot?: DialogueLine[]; down?: DialogueLine[]; timeLow?: DialogueLine[]; wave?: DialogueLine[]; done?: DialogueLine[];
}

export interface StageDef {
  id: string;
  title: string;
  checkpoint?: boolean;
  cutscene?: string;
  /** only run this stage when the plan / live state matches */
  when?: StageWhen;
  timeLimit?: BySize<number>;
  spawn?: SpawnDef[];
  despawn?: string[];
  objectives: ObjectiveDef[];
  fail?: FailDef[];
  /** dialogue lines shown when the stage starts */
  lines?: DialogueLine[];
  /** lines triggered by events during this stage (falls back to the heist's `radio`) */
  events?: StageEvents;
  onEnter?: { wanted?: number; alarm?: boolean; alarmIfLoud?: boolean; doors?: Record<string, 'open' | 'closed' | 'locked'> };
  /** where participants are placed when a retry resumes from this checkpoint */
  respawn?: V3[];
  /** reinforcements arriving `after` seconds into the stage (optionally only once the alarm is up) */
  waves?: { after: number; spawn: SpawnDef[]; alarmOnly?: boolean; line?: DialogueLine }[];
  /** con approach: guards see the crew but do not get suspicious */
  disguised?: boolean;
  /** if the alarm trips during this stage, move on to the next applicable stage */
  skipOnAlarm?: boolean;
  /** street traffic runs during this stage */
  traffic?: boolean;
}

export interface RewardDef {
  /** cash per participant by party size */
  cash: BySize<number>;
  rep: number;
  /** cash for replays / out-of-story participants */
  replayCash: number;
  unlocks?: string[];
}

export interface EquipmentDef {
  id: string; name: string; desc: string; approach?: Approach;
  /** hold-time changes: objects of kind `obj` (optionally only spawn key `key`) take `hold` s, or × `mult` */
  effects?: { obj?: string; key?: string; hold?: number; mult?: number }[];
  /** both-at-once windows × this */
  windowMult?: number;
}

/** one setup mission of a heist (the setup itself is an ActivityDef of kind 'heist_prep') */
export interface SetupDef {
  prep: string;
  category: 'scout' | 'vehicle' | 'equipment' | 'security' | 'disguise' | 'escape';
  optional?: boolean;
  /** what it does for the finale (shown on the planning board) */
  perk: string;
  /** a decision made in the setup's lobby that changes the finale */
  choice?: { key: string; label: string; options: { id: string; name: string; desc: string }[] };
  /** generic finale bonuses */
  bonus?: { hp?: number; lives?: number; timeMult?: number };
}

export interface EliteDef {
  label: string;
  bonus: number;
  maxSeconds?: number; noKnockouts?: boolean; noRetries?: boolean; noAlarm?: boolean; maxLootLossPct?: number;
}

export interface HeistDef {
  baseTake: number;
  approaches: Approach[];
  equipment: EquipmentDef[];
  roles: Role[];
  /** take multiplier once the alarm has gone off */
  loudPenalty: number;
  setups: SetupDef[];
  /** approaches that need a setup first (e.g. con needs the disguises) */
  approachNeeds?: Partial<Record<Approach, string>>;
  /** take multiplier on Hard (default 1.25) */
  hardMult?: number;
  /** shared knockouts the crew can absorb on Hard before the job is over */
  hardLives: BySize<number>;
  /** share of a bag lost when its carrier is knocked out */
  carryLoss: number;
  /** paid to each crew member who finishes this heist for the first time */
  firstTimeBonus: number;
  elite: EliteDef;
  /** door spawn keys that fly open when the alarm trips */
  alarmDoors?: string[];
  /** planner radio lines for events, used when a stage has none */
  radio?: StageEvents;
}

export interface ActivityDef {
  id: string;
  kind: ActivityKind;
  name: string;
  giver: string;
  blurb: string;
  /** world position of the start marker */
  start: V3;
  /** participants are teleported here (in order) when the activity begins */
  startSpots: V3[];
  startYaw: number;
  unlock: { requires?: string[]; rep?: number };
  minPlayers: 1;
  maxPlayers: 4;
  lateJoin: 'never' | 'roster_reconnect';
  replayable: boolean;
  music?: string;
  stages: StageDef[];
  rewards: RewardDef;
  /** heists: every setup activity id (required and optional; see heist.setups) */
  preps?: string[];
  /** heist setups: the heist this setup counts towards */
  prepFor?: string;
  heist?: HeistDef;
  race?: { competitive: boolean; parTimes: [number, number, number]; startGrid: V3[]; vehicleModel: string };
  minigame?: { scoring: 'time' | 'score'; parScores?: [number, number, number] };
  /** short notes shown on the briefing (solo/co-op differences, late join rules) */
  notes: string[];
}

/** profile.preps[heist] stores completed setup ids plus `choice:<key>=<option>` entries */
export function setupChoices(entries: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of entries ?? []) if (e.startsWith('choice:')) { const [k, v] = e.slice(7).split('='); if (k && v) out[k] = v; }
  return out;
}
export function setupsDone(entries: string[] | undefined): string[] { return (entries ?? []).filter((e) => !e.startsWith('choice:')); }

export function condHolds(c: Cond | undefined, ctx: { approach: Approach; difficulty: Difficulty; choices: Record<string, string>; setups: string[]; crew: number }): boolean {
  if (!c) return true;
  if (c.approach && !(Array.isArray(c.approach) ? c.approach.includes(ctx.approach) : c.approach === ctx.approach)) return false;
  if (c.difficulty && c.difficulty !== ctx.difficulty) return false;
  if (c.choice) for (const [k, v] of Object.entries(c.choice)) if (ctx.choices[k] !== v) return false;
  if (c.setup && !ctx.setups.includes(c.setup)) return false;
  if (c.noSetup && ctx.setups.includes(c.noSetup)) return false;
  if (c.crew === 'solo' && ctx.crew > 1) return false;
  if (c.crew === 'coop' && ctx.crew < 2) return false;
  return true;
}

/**
 * Network protocol. Every client→server message is validated with these schemas
 * on the server before it is touched. Server→client messages are typed only.
 */
import { z } from 'zod';

const num = z.number().finite();
const id = z.string().min(1).max(64);

export const C2S = z.discriminatedUnion('t', [
  z.object({ t: z.literal('hello'), v: z.number().int(), gv: z.string().max(32), token: z.string().min(10).max(200), resume: z.boolean().optional() }),
  z.object({
    t: z.literal('input'), seq: z.number().int().nonnegative(),
    mx: num.min(-1).max(1), mz: num.min(-1).max(1), yaw: num, pitch: num.min(-1.6).max(1.6),
    jump: z.boolean(), sprint: z.boolean(),
    th: num.min(-1).max(1), st: num.min(-1).max(1), hb: z.boolean(),
  }),
  z.object({ t: z.literal('world.join'), target: z.union([z.literal('auto'), z.literal('party'), z.literal('new'), z.object({ instance: id }), z.object({ code: z.string().min(4).max(8) }),
    z.object({ create: z.object({ name: z.string().min(1).max(32), access: z.enum(['public', 'friends', 'invite']), capacity: z.number().int().min(2).max(16) }) })]) }),
  z.object({ t: z.literal('world.leave') }),
  z.object({ t: z.literal('interact'), target: id }),
  z.object({ t: z.literal('veh.enter'), vehicle: id, seat: z.number().int().min(0).max(3).optional() }),
  z.object({ t: z.literal('veh.exit') }),
  z.object({ t: z.literal('veh.horn'), on: z.boolean() }),
  z.object({ t: z.literal('fire'), yaw: num, pitch: num.min(-1.6).max(1.6), aim: z.boolean().optional() }),
  z.object({ t: z.literal('weapon'), id: z.string().max(16) }),
  z.object({ t: z.literal('reload') }),
  z.object({ t: z.literal('interact.stop') }),
  z.object({ t: z.literal('chat'), ch: z.enum(['party', 'world', 'activity']), text: z.string().min(1).max(200) }),
  z.object({ t: z.literal('ping.mark'), x: num, y: num, z: num, kind: z.enum(['go', 'danger', 'loot', 'vehicle']) }),
  z.object({ t: z.literal('act.brief'), activity: id }),
  z.object({ t: z.literal('act.lobby'), activity: id }),
  z.object({ t: z.literal('act.ready'), ready: z.boolean() }),
  z.object({ t: z.literal('act.config'), approach: z.enum(['quiet', 'loud', 'con']).optional(), difficulty: z.enum(['normal', 'hard']).optional(), choice: id.optional(), equipment: z.array(id).max(3).optional(), split: z.record(z.string(), z.number().int().min(0).max(100)).optional() }),
  z.object({ t: z.literal('act.role'), role: z.enum(['none', 'driver', 'hacker', 'muscle', 'lookout']) }),
  z.object({ t: z.literal('act.launch') }),
  z.object({ t: z.literal('act.cancel') }),
  z.object({ t: z.literal('act.leave') }),
  z.object({ t: z.literal('act.retry') }),
  z.object({ t: z.literal('act.continue') }),
  z.object({ t: z.literal('cs.loaded'), cs: id }),
  z.object({ t: z.literal('cs.skip') }),
  z.object({ t: z.literal('shop.buy'), shop: id, item: id }),
  z.object({ t: z.literal('item.use'), item: id }),
  z.object({ t: z.literal('garage'), op: z.enum(['repair', 'paint', 'store', 'spawn', 'buy', 'deliver']), vehicle: id.optional(), model: id.optional(), color: z.number().int().min(0).max(0xffffff).optional() }),
  z.object({ t: z.literal('wanted.pay') }),
  z.object({ t: z.literal('ping'), c: num }),
  z.object({ t: z.literal('dev'), cmd: z.enum(['tp', 'cash', 'wanted', 'complete_stage', 'spawn_vehicle', 'heal', 'kill', 'stun_npcs', 'weather']), args: z.array(z.union([z.string().max(64), num])).max(6) }),
]);
export type C2SMsg = z.infer<typeof C2S>;
export type LobbyAccess = 'public' | 'friends' | 'invite';
export type WorldTarget = Extract<C2SMsg, { t: 'world.join' }>['target'];

// ───────────────────────── server → client
export interface PlayerEnt {
  id: string; k: 'p'; n: string; x: number; y: number; z: number; yaw: number; pitch: number;
  /** anim: 0 idle 1 walk 2 run 3 swim 4 air 5 drive 6 down */
  a: number; v?: string; s?: number; hp: number; c: number; /** hair colour 0xRRGGBB (absent = default look) */ hr?: number; party?: boolean; role?: string;
  /** equipped weapon id; fa = fired within the last ~1.2 s (third-person aim pose) */
  w?: string; fa?: boolean;
}
export interface VehicleEnt {
  id: string; k: 'v'; m: string; x: number; y: number; z: number; yaw: number; sp: number; st: number;
  hp: number; col: number; occ: (string | null)[]; siren?: boolean; horn?: boolean; ghost?: boolean; label?: string; mine?: boolean;
}
export interface NpcEnt {
  id: string; k: 'n'; r: string; x: number; y: number; z: number; yaw: number; a: number; sk: number; name?: string;
  /** guard alert 0..1 */ al?: number; stun?: boolean;
}
export interface ObjEnt {
  id: string; k: 'o'; m: string; x: number; y: number; z: number; st: number; label?: string; hold?: number; mine?: boolean; prog?: number; yaw?: number;
}
export interface DoorEnt { id: string; k: 'd'; x: number; y: number; z: number; axis: 'x' | 'z'; w: number; open: boolean; label?: string }
export type Ent = PlayerEnt | VehicleEnt | NpcEnt | ObjEnt | DoorEnt;

export interface SelfState {
  /** authoritative physics state for reconciliation */
  x: number; y: number; z: number; vx: number; vy: number; vz: number; og: boolean;
  hp: number; maxHp: number; wanted: number; wantedSeen: boolean;
  veh?: string; seat?: number;
  /** authoritative vehicle physics for the driver */
  vp?: { x: number; y: number; z: number; yaw: number; speed: number; vy: number; steer: number; og: boolean };
  down?: number;
  interior?: string;
  /** police search area (only while wanted and unseen) */
  search?: { x: number; z: number; r: number };
}

export interface Snapshot {
  t: 'snap'; tick: number; time: number; ack: number;
  me: SelfState;
  /** new entities arrive complete; known ones arrive as field deltas ({ id, …changed }, null = removed field) */
  ents: Ent[];
  gone: string[];
}

export interface ObjectiveView {
  id: string; text: string; done: boolean; progress?: string;
  /** world markers to show (blip + 3D marker) */
  markers: { x: number; y: number; z: number; kind: 'go' | 'interact' | 'vehicle' | 'deliver' | 'checkpoint' | 'danger'; label?: string; shape: 'circle' | 'diamond' | 'triangle' | 'square' }[];
}

export interface ActivityView {
  runId: string; activity: string; name: string; kind: string;
  phase: 'lobby' | 'cutscene' | 'playing' | 'failed' | 'complete' | 'starting';
  stage: string; stageTitle: string; stageIndex: number; stageCount: number;
  objectives: ObjectiveView[];
  timer?: { endsAt: number; label: string };
  roster: { userId: string; name: string; role: string; connected: boolean; down: boolean; score?: string; carry?: number }[];
  config?: { approach?: string; equipment?: string[]; split?: Record<string, number>; difficulty?: string; choices?: Record<string, string>; setups?: string[] };
  failReason?: string;
  /** heists: live crew state (lives on Hard, carried loot, elapsed) */
  heist?: HeistRunView;
  race?: { lap: number; laps: number; cp: number; cps: number; position: number; racers: number; startAt?: number };
  notes?: string[];
}

export interface LobbyView {
  activity: string; name: string; kind: string; leader: string;
  members: { userId: string; name: string; ready: boolean; role: string; eligible: string; connected: boolean }[];
  config: { approach: string; equipment: string[]; split: Record<string, number>; difficulty?: string; choice?: string };
  payout: string[];
  canLaunch: boolean; blockers: string[];
  /** heist finales: the planning board */
  heist?: HeistBoardView;
  /** heist setups: the setup's choice (picked by the leader in this lobby) */
  setup?: { heist: string; heistName: string; optional: boolean; perk: string; choice?: { key: string; label: string; picked: string; options: { id: string; name: string; desc: string }[] } };
}

export interface HeistRunView {
  difficulty: 'normal' | 'hard'; approach: string;
  lives: number | null; livesMax: number | null;
  carried: number; dropped: number; lost: number; take: number;
  startedAt: number; eliteLabel: string; eliteSeconds?: number;
  alarm: boolean; knockouts: number;
}

export interface HeistBoardView {
  difficulty: 'normal' | 'hard';
  setups: { id: string; name: string; category: string; optional: boolean; done: boolean; perk: string; choice?: { key: string; label: string; picked?: string; pickedName?: string } }[];
  approaches: { id: string; name: string; locked?: string }[];
  estimate: { base: number; loot: number; mult: number; total: number; perMember: Record<string, number> };
  bonuses: { firstTime: number; firstTimers: string[]; elite: { label: string; bonus: number } };
  lives: number | null;
  hardMult: number;
}

/** weather: [state, intensity 0..100, wind 0..100] */
export type WxTriple = [state: number, intensity: number, wind: number];
export const WX_STATE_NAMES = ['clear', 'partly', 'overcast', 'rain', 'storm', 'downpour'] as const;
/** server → client, on join and whenever the schedule moves on: blend p → s over d ms starting at server time at */
export interface WxMsg { t: 'wx'; s: WxTriple; p: WxTriple; at: number; d: number }

export interface CutsceneStart { t: 'cs.start'; cs: string; startAt: number; anchor?: [number, number, number]; skipRule: string; participants: number }

export type S2CMsg =
  /** world = the map this server simulates; a client built for another world reloads itself onto it */
  | { t: 'welcome'; userId: string; name: string; serverTime: number; tickRate: number; admin: boolean; dev: boolean; world?: 'palmara' | 'leonia' }
  | { t: 'error'; code: string; message: string; fatal?: boolean }
  | { t: 'world'; instance: string; kind: 'world' | 'activity' | 'interior'; label: string; entity: string; pos: [number, number, number]; yaw: number; players: number; capacity: number; access?: LobbyAccess; code?: string; host?: string }
  | { t: 'world.left'; reason: string }
  | Snapshot
  | { t: 'notify'; text: string; kind: 'info' | 'good' | 'bad' | 'mission'; sfx?: string }
  | { t: 'chat'; ch: string; from: string; text: string; at: number }
  | { t: 'profile'; profile: unknown }
  | { t: 'social'; event: string; data?: unknown }
  | { t: 'act'; view: ActivityView | null }
  | { t: 'lobby'; view: LobbyView | null }
  | { t: 'brief'; data: unknown }
  | CutsceneStart
  | WxMsg
  | { t: 'cs.waiting'; cs: string; loaded: number; total: number; deadline: number }
  | { t: 'cs.votes'; votes: number; needed: number }
  | { t: 'cs.end'; cs: string; skipped: boolean }
  | { t: 'results'; data: unknown }
  | { t: 'shop'; shop: string; data: unknown }
  | { t: 'pong'; c: number; s: number }
  | { t: 'ping.mark'; from: string; x: number; y: number; z: number; kind: string }
  | { t: 'sfx'; id: string; x?: number; y?: number; z?: number; vol?: number }
  | { t: 'dialogue'; speaker: string; text: string; ms: number }
  /** an NPC (or traffic car) says a street line; id = npc or vehicle entity id, line = bark id (content/barks.ts), text = the words */
  | { t: 'bark'; id: string; line: string; text?: string }
  | { t: 'weapon'; id: string; mag: number; reserve: number; reloading?: number }
  /** hit confirmation for the shooter only (hit markers) */
  | { t: 'hitc'; kill?: boolean; stun?: boolean; veh?: boolean }
  | { t: 'shot'; from: string; x: number; y: number; z: number; tx: number; ty: number; tz: number; w: string; hit?: boolean }
  | { t: 'hold'; target: string; seconds: number; label: string } | { t: 'hold.end'; ok: boolean }
  | { t: 'ui'; open: 'heistboard' | 'phone' | 'map' | 'social' }
  | { t: 'blips'; search: { x: number; z: number; r: number } | null };

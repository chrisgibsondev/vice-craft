/** Server-side entity records. Client-facing snapshots are produced from these. */
import type { PlayerPhys, VehiclePhys, VehicleDef, VehicleModel, Role, C2SMsg, PursuitState } from '@blockshore/shared';

export type InputMsg = Extract<C2SMsg, { t: 'input' }>;

export interface Wanted {
  level: number;
  lastKnown: { x: number; z: number };
  lastSeenAt: number;
  since: number;
}

export interface PlayerEnt {
  id: string;
  userId: string;
  name: string;
  partyId: string | null;
  phys: PlayerPhys;
  yaw: number; pitch: number;
  hp: number; maxHp: number;
  outfit: number;
  /** hair colour 0xRRGGBB (0 = default look) */
  hair: number;
  inputs: InputMsg[];
  lastSeq: number;
  lastInput: InputMsg | null;
  veh: string | null;
  seat: number;
  holding: { target: string; started: number; required: number } | null;
  /** epoch ms when a downed player respawns (0 = up) */
  downUntil: number;
  busted: boolean;
  wanted: Wanted | null;
  role: Role;
  /** set while the session is disconnected; entity is frozen and hidden */
  linkdeadAt: number;
  fireCooldown: number;
  /** delta-compression state per client */
  /** last full entity state sent to this client (field-level delta compression) */
  sent: Map<string, Record<string, unknown>>;
  /** cinematic: when set, snapshot focus is here and inputs are ignored */
  cutsceneFocus: [number, number, number] | null;
  frozen: boolean;
  lastSafePos: { x: number; y: number; z: number };
  pings: number[];
  invulnUntil: number;
  personalVehicle: string | null;
  inputCredit: number;
  weapon: string;
  ammo: Record<string, { mag: number; reserve: number }>;
  reloadUntil: number;
  ammoDirty: boolean;
}

export interface AiDriver {
  kind: 'traffic' | 'police' | 'parked';
  /** traffic lane state */
  waypoint?: { x: number; z: number };
  axis?: 'x' | 'z';
  dir?: 1 | -1;
  line?: number;
  speed?: number;
  waitUntil?: number;
  /** police */
  owner?: string;
  officerSpawned?: boolean;
  stuckFor?: number;
  lastPos?: { x: number; z: number };
  hornAt?: number;
  /** road-graph traffic (Leonia): current edge, travel direction, arc length from the travel start, lane index */
  edge?: number;
  edir?: 1 | -1;
  s?: number;
  lane?: number;
  /** chosen continuation at the end of the edge, lane on it, turn lengths (m before / after the node), turn angle */
  next?: { edge: number; dir: 1 | -1; lane: number; d1: number; d2: number; ang: number } | null;
  /** pulled over for a siren until this time; current sideways shift toward the kerb (m, signed like the lane offset) */
  yieldUntil?: number;
  shift?: number;
  /** police A* route state (Leonia) */
  nav?: PursuitState;
}

export interface VehicleEnt {
  id: string;
  model: VehicleModel;
  def: VehicleDef;
  phys: VehiclePhys;
  hp: number;
  color: number;
  occ: (string | null)[];
  owner: { userId: string; vehicleId: string } | null;
  ai: AiDriver | null;
  ghost: boolean;
  activityKey: string | null;
  /** only these users may enter (activity vehicles / personal vehicles) */
  allowed: Set<string> | null;
  label: string | null;
  destroyedAt: number;
  siren: boolean;
  horn: boolean;
  /** latest driver input (applied each tick) */
  input: { th: number; st: number; hb: boolean };
  /** remaining ticks during which a hit by this vehicle does not re-damage */
  lastHitAt: number;
  idleSince: number;
}

export type NpcRole = 'ped' | 'guard' | 'cop' | 'static' | 'actor';
export interface NpcEnt {
  id: string;
  role: NpcRole;
  /** display role for the client (shopkeeper, mechanic, contact, ...) */
  label: string;
  name?: string;
  x: number; y: number; z: number; yaw: number;
  phys?: PlayerPhys;
  anim: number;
  skin: number;
  stunnedUntil: number;
  downUntil: number;
  alert: number;
  brain: {
    path?: { x: number; z: number }[];
    pi?: number;
    pauseUntil?: number;
    lot?: { i: number; j: number };
    corner?: number;
    dir?: 1 | -1;
    fleeUntil?: number;
    target?: string;
    owner?: string;
    vehicle?: string;
  };
  activityKey: string | null;
  speed: number;
  hp?: number;
  shootAt?: number;
}

export interface ObjEnt {
  id: string;
  kind: string;
  x: number; y: number; z: number; yaw: number;
  label: string;
  hold: number;
  /** 0 active, 1 done, 2 hidden */
  state: number;
  activityKey: string | null;
  value: number;
  /** userId → hold progress 0..1 (for UI) */
  progress: number;
  doneBy: string | null;
  doneAt: number;
}

export interface DoorEnt {
  id: string;
  key: string;
  x: number; y: number; z: number;
  axis: 'x' | 'z';
  w: number;
  open: boolean;
  locked: boolean;
  rule: string;
  label: string;
  closeAt: number;
}

export function round2(v: number) { return Math.round(v * 100) / 100; }
export function dist2(a: { x: number; z: number }, b: { x: number; z: number }) { const dx = a.x - b.x, dz = a.z - b.z; return dx * dx + dz * dz; }

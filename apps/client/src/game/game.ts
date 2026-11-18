/**
 * Client game loop: fixed-step input + prediction (20 Hz, identical physics to the
 * server), reconciliation against authoritative snapshots, interpolation of remote
 * entities, first/third-person cameras, cutscene playback, interaction prompts,
 * weapons, audio and HUD feeds.
 *
 * Feel layer (all client-side, never changes the shared physics):
 * - ADS, crosshair bloom (mirrors the server spread), per-weapon recoil with recovery,
 *   hit markers (server `hitc`), impacts/decals/shells/tracers/muzzle light (render/effects)
 * - head-bob, sprint FOV kick, landing dip, strafe roll, footsteps synced to the bob,
 *   swim bob + underwater tint, jump/land/splash sounds
 * - smooth shoulder camera with collision, character facing (move dir vs. aim)
 * - vehicle enter/exit sequences animated around the server's instant state change,
 *   chase camera, engine rpm/gears, tyre screech, impact shake, horn, headlights, drive-by
 */
import * as THREE from 'three';
import {
  WORLD, DT, EYE_HEIGHT, INTERACT_RANGE, VEHICLES, CUTSCENES, WEAPONS, WEAPON_ORDER, BLOCKS, ACTIVITY_BY_ID, PALMARA, SOLID, B, SEA_LEVEL,
  barkText, stepPlayer, stepVehicle, seatOffset, raycastVoxels, worldAnchors, getRaster, angleDiff, waterAt,
  type Snapshot, type Ent, type S2CMsg, type PlayerPhys, type VehiclePhys, type AABB, type VehicleEnt, type PlayerEnt, type NpcEnt, type ObjEnt, type DoorEnt, type MoveInput, type VehInput, type VehicleDef,
} from '@blockshore/shared';
import { net } from '../net/connection';
import { getState, setState, subscribe } from '../state/store';
import type { Blip } from '../state/types';
import { tts } from '../audio/tts';
import { audio } from '../audio';
import { EntityRenderer, ViewModel, type LocalView } from '../render/entities';
import { occupantDrop } from '../render/entities/vehicles';
import { GameRenderer, QUALITY_PRESETS } from '../render/renderer';
import { WorldTour } from '../render/tour';
import { Input } from './input';
import { livePose } from './livePose';
import { getWaypoint } from '../ui/waypoint';
import { WHEEL_SLOTS } from '../ui/hud/WeaponWheel';
import { Cockpit } from '../render/cockpit';
import { Effects, type ImpactKind } from '../render/effects';
import { liveFeel, emitFeelFrame, spreadMul, heatAdd, HEAT_DECAY, recoilFor } from './feel';
import { synth } from './synth';

interface Pending { seq: number; foot: MoveInput; veh: VehInput }
interface Sample { t: number; e: Ent }
interface Trans {
  kind: 'enter' | 'exit'; veh: string; seat: number; t0: number;
  /** enter: walk-to-door time, then get-in time. exit: get-out time */
  walk: number; dur: number;
  from: THREE.Vector3; fromYaw: number; side: number;
  /** first-person camera start (exit) */
  camFrom: THREE.Vector3;
  carYaw: number;
}

const INTERP_DELAY = 110;
const DAY_LENGTH_S = 24 * 60;
const raster = getRaster(PALMARA);
/** metres to the nearest open water within 12 m (8 rays), 99 when none: drives the wave ambience on Leonia */
function probeCoast(w: { getBlock(x: number, y: number, z: number): number }, x: number, z: number): number {
  for (let d = 1; d <= 12; d += 1) for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    if (w.getBlock(Math.floor(x + Math.cos(a) * d), SEA_LEVEL, Math.floor(z + Math.sin(a) * d)) === B.WATER) return d;
  }
  return 99;
}
const tmpV = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _f = new THREE.Vector3();
const SURFACE = SEA_LEVEL + 1;
const _e = new THREE.Euler();
const _col = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);
const DRIVEBY_KINDS = new Set(['pistol', 'smg', 'stun']);

function mergeDelta(base: Ent, d: Ent): Ent {
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(d)) { if (v === null) delete out[k]; else out[k] = v; }
  return out as unknown as Ent;
}

function lerpAngle(a: number, b: number, t: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const ease = (k: number) => { k = clamp(k, 0, 1); return k * k * (3 - 2 * k); };
const damp = (a: number, b: number, rate: number, dt: number) => a + (b - a) * (1 - Math.exp(-rate * dt));

/** material class of a block for impact effects */
function impactKindFor(id: number): ImpactKind {
  const b = BLOCKS[id];
  if (!b) return 'concrete';
  const n = b.name;
  if (/glass|window/.test(n)) return 'glass';
  if (/metal|steel|iron|rail|lamp|sign|pipe|vent|fence|letter|car|truck|crate_metal|grate|ac_/.test(n)) return 'metal';
  if (/wood|plank|log|bark|leaves|crate|door|pallet|deck/.test(n) || b.step === 'wood') return 'wood';
  if (/sand/.test(n) || b.step === 'sand') return 'sand';
  if (/grass|dirt|mud|soil|leaf|hedge/.test(n) || b.step === 'grass') return 'grass';
  return 'concrete';
}

export class ClientGame {
  readonly input: Input;
  readonly ents: EntityRenderer;
  readonly vm: ViewModel;
  readonly tour: WorldTour;
  readonly fx: Effects;
  private buffers = new Map<string, Sample[]>();
  private latest = new Map<string, Ent>();
  private myId = '';
  private instanceKind: 'world' | 'activity' | 'interior' = 'world';
  // local prediction
  private local: PlayerPhys = { x: 2472, y: 22, z: 3204, vx: 0, vy: 0, vz: 0, onGround: true, inWater: false };
  private prevLocal = { x: 2472, y: 22, z: 3204 };
  private vphys: VehiclePhys | null = null;
  private prevV: { x: number; y: number; z: number; yaw: number } | null = null;
  private visualErr = new THREE.Vector3();
  private pending: Pending[] = [];
  private seq = 0;
  private acc = 0;
  private me: Snapshot['me'] | null = null;
  // camera
  yaw = 0; pitch = 0;
  private vehLook = 0;
  private camPos = new THREE.Vector3();
  private shake = 0;
  private camFov = 75;
  // gameplay
  private holding: { target: string; start: number; seconds: number; label: string } | null = null;
  private weapon = { id: 'stun', mag: 6, reserve: 999, reloadingUntil: 0, reloadDur: 1, lastFire: 0, firing: 0 };
  private pings: { x: number; y: number; z: number; kind: string; from: string; at: number }[] = [];
  private hudTimer = 0;
  private csLoadedSent = '';
  private lastDialogueShot = -1;
  private loadingSince = 0;
  private inGame = false;
  private frames = 0; private fpsAt = performance.now();
  private last = performance.now();
  private preloadDone = false;
  private wheelOpen = false;
  readonly cockpit: Cockpit;
  /** visual smoothing of server corrections to the vehicle you drive */
  private vehErr = new THREE.Vector3();
  private vehYawErr = 0;
  private hiddenVeh: string | null = null;
  private wheelVec = { x: 0, y: 0 };

  // ── feel state
  private aimK = 0;
  private aimHeld = false;
  private driveBy = false;
  private heat = 0;
  private shotIdx = 0;
  private recoilP = 0; private recoilY = 0;
  private punch = 0; private punchYaw = 0; private punchRoll = 0;
  private bobPhase = 0; private bobAmt = 0; private lastStep = 0;
  private sprintK = 0; private roll = 0;
  private dip = 0; private dipV = 0;
  private prevRender = new THREE.Vector3(); private prevRenderOk = false;
  private wasAir = false; private wasWater = false; private airVy = 0;
  private charYaw = 0;
  private tpPivot = new THREE.Vector3(); private tpLen = 4; private tpInit = false; private tpShoulder = 0.55;
  private camBlend: { from: THREE.Vector3; q: THREE.Quaternion; t0: number; dur: number } | null = null;
  private chaseYaw = 0; private chaseInit = false;
  private trans: Trans | null = null;
  private footRender = new THREE.Vector3(); private footYaw = 0;
  private seatRender = new THREE.Vector3(); private seatEye = new THREE.Vector3();
  private lastVeh: VehInput = { th: 0, st: 0, hb: false };
  private rpm = 0.2; private screech = 0; private hornOn = false;
  private muzzlePos = new THREE.Vector3();
  private lastHp = -1;
  private recentShots: { ox: number; oz: number; tx: number; tz: number; at: number }[] = [];
  private wasUnder = false;
  private skipTrans = false;
  private vRender = new THREE.Vector3(); private vAnim = new THREE.Vector3(); private vFocus = new THREE.Vector3();

  constructor(readonly r: GameRenderer, canvas: HTMLCanvasElement) {
    this.input = new Input(canvas);
    this.ents = new EntityRenderer(r);
    this.vm = new ViewModel(r);
    this.tour = new WorldTour(r);
    this.cockpit = new Cockpit(r.scene);
    this.fx = new Effects(r.scene, r.L);
    this.fx.setWorld(r.chunks, (id) => SOLID[id] === 1);
    this.tour.seek(Math.random() * 60);
    // weather runs on the shared server clock; thunder arrives late by the distance of the strike
    r.wx.clock = () => net.serverNow();
    r.wx.onThunder = (strength, delay) => audio.thunder(strength, delay);
    net.onSnapshot = (s) => this.onSnapshot(s);
    net.on((m) => this.onMessage(m));
    void this.ents.preload().then(() => { this.preloadDone = true; });
    // react to settings changes
    let lastSettings = getState().settings;
    this.applySettings();
    subscribe(() => {
      const s = getState().settings;
      if (s !== lastSettings) { lastSettings = s; this.applySettings(); }
    });
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); setState({ error: 'The graphics context was lost (GPU reset or driver issue). Reload the page to continue.' }); });
  }

  private applySettings() {
    const s = getState().settings;
    const preset = QUALITY_PRESETS[s.quality];
    this.r.applyQuality({ renderDistance: s.renderDistance, bloom: s.bloom, pixelRatio: preset.pixelRatio, fov: s.fov });
    this.camFov = s.fov;
    audio.setVolumes(s.volume);
    tts.configure({ enabled: s.voiceDialogue !== false, volume: s.volume.master * s.volume.voice });
    this.ents.speechEnabled = s.npcSpeech;
  }

  start() {
    const loop = () => { this.frame(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  // ───────────────────────────────────────────────────────── network
  private onMessage(m: S2CMsg) {
    switch (m.t) {
      case 'world': {
        const jump = Math.hypot(m.pos[0] - this.local.x, m.pos[2] - this.local.z);
        this.myId = m.entity;
        this.instanceKind = m.kind;
        this.local = { x: m.pos[0], y: m.pos[1], z: m.pos[2], vx: 0, vy: 0, vz: 0, onGround: true, inWater: false };
        this.prevLocal = { ...this.local };
        this.pending = []; this.vphys = null; this.visualErr.set(0, 0, 0);
        this.yaw = m.yaw; this.pitch = 0; this.charYaw = m.yaw;
        this.buffers.clear(); this.latest.clear();
        this.trans = null; this.camBlend = null; this.skipTrans = true; this.tpInit = false; this.prevRenderOk = false; this.lastHp = -1;
        const s = getState();
        if (s.screen !== 'game' || jump > 60) { setState({ screen: 'loading', loading: { progress: 0, label: `Entering ${m.label}…` } }); this.loadingSince = performance.now(); }
        break;
      }
      case 'wx': this.r.wx.setMsg(m); break;
      case 'world.left': this.inGame = false; this.buffers.clear(); this.latest.clear(); break;
      case 'sfx': {
        if (m.x !== undefined) audio.sfx(m.id, { x: m.x, y: m.y, z: m.z, volume: m.vol });
        else audio.sfx(m.id, { volume: m.vol });
        // your own crashes shake from the predicted impact; others' crashes nearby still rattle you
        if (m.id === 'crash' && !this.me?.veh && !getState().settings.reduceShake && m.x !== undefined && Math.hypot(m.x - this.local.x, m.z! - this.local.z) < 10) this.shake = Math.min(1, this.shake + (m.vol ?? 1) * 0.8);
        break;
      }
      case 'notify': if (m.sfx) audio.sfx(m.sfx, { volume: 0.7 }); break;
      case 'shot': this.onShot(m); break;
      case 'bark': { const st = getState().settings; const who = st.npcSpeech ? this.ents.say(m.id, m.line, m.text ?? barkText(m.line) ?? '') : '';
        { const e = this.latest.get(m.id); const d = e && this.me ? Math.hypot(e.x - this.me.x, e.z - this.me.z) : 10; const txt = m.text ?? barkText(m.line) ?? ''; if (txt && d < 28) tts.say(`${who} ${m.id}`.trim(), txt, 'bark', Math.max(0.25, 1 - d / 30)); } if (who && st.npcSubtitles) setState({ barkSub: { speaker: who, text: m.text ?? barkText(m.line) ?? '', until: Date.now() + 3200 } }); break; }
      case 'hitc': {
        liveFeel.hitAt = performance.now(); liveFeel.hitKill = !!m.kill && !m.stun; liveFeel.hitVeh = !!m.veh;
        synth.hit(!!m.kill);
        break;
      }
      case 'weapon': {
        const wasReloading = this.weapon.reloadingUntil > 0;
        const changed = m.id !== this.weapon.id;
        this.weapon.id = m.id; this.weapon.mag = m.mag; this.weapon.reserve = m.reserve;
        const kind = WEAPONS[m.id]?.kind ?? 'pistol';
        if (m.reloading) { this.weapon.reloadingUntil = performance.now() + m.reloading * 1000; this.weapon.reloadDur = m.reloading; synth.magOut(kind); }
        else { if (wasReloading && !changed && performance.now() > this.weapon.reloadingUntil - 250) synth.magIn(kind); this.weapon.reloadingUntil = 0; }
        if (changed) { this.shotIdx = 0; this.heat = 0; }
        break;
      }
      case 'hold': this.holding = { target: m.target, start: performance.now(), seconds: m.seconds, label: m.label }; break;
      case 'ping.mark': this.pings.push({ x: m.x, y: m.y, z: m.z, kind: m.kind, from: m.from, at: performance.now() }); audio.sfx('notify', { volume: 0.5 }); break;
      case 'cs.waiting': this.csLoadedSent = ''; break;
      case 'cs.end': this.lastDialogueShot = -1; setState({ dialogue: null }); tts.stop(); break;
      default: break;
    }
  }

  /** tracer + impact + muzzle light for any shot (yours, other players', NPCs') */
  private onShot(m: Extract<S2CMsg, { t: 'shot' }>) {
    const mine = m.from === this.myId;
    const w = WEAPONS[m.w];
    const stun = !!w?.stun;
    if (!mine) {
      audio.sfx(w?.sfx ?? 'pistol', { x: m.x, y: m.y, z: m.z, volume: 0.8 });
      this.fx.muzzle(m.x, m.y - 0.25, m.z, 0.8, stun);
      this.recentShots.push({ ox: m.x, oz: m.z, tx: m.tx, tz: m.tz, at: performance.now() });
      if (!stun) {
        // closest approach of the bullet line to my head
        const ax = m.tx - m.x, ay = m.ty - m.y, az = m.tz - m.z, L2 = ax * ax + ay * ay + az * az;
        if (L2 > 1) {
          const hx = this.local.x - m.x, hy = this.local.y + 1.6 - m.y, hz = this.local.z - m.z;
          const t = Math.max(0, Math.min(1, (hx * ax + hy * ay + hz * az) / L2));
          const d = Math.hypot(hx - ax * t, hy - ay * t, hz - az * t);
          if (d < 2.5 && t > 0.05 && t < 0.98) audio.sfx('bullet_whiz', { x: m.x + ax * t, y: m.y + ay * t, z: m.z + az * t, volume: 0.8 - d * 0.2, rate: 0.9 + Math.random() * 0.25 });
        }
      }
      if (this.recentShots.length > 12) this.recentShots.shift();
    }
    const sx = mine ? this.muzzlePos.x : m.x, sy = mine ? this.muzzlePos.y : m.y - 0.25, sz = mine ? this.muzzlePos.z : m.z;
    this.fx.tracer(sx, sy, sz, m.tx, m.ty, m.tz, mine, stun);
    // impact
    const dx = m.tx - m.x, dy = m.ty - m.y, dz = m.tz - m.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.2) return;
    const ux = dx / len, uy = dy / len, uz = dz / len;
    // bullets crossing the sea surface splash there
    if (uy < -0.02 && m.y > SURFACE && m.ty < SURFACE) {
      const t = (SURFACE - m.y) / uy;
      const wx = m.x + ux * t, wz = m.z + uz * t;
      if (t > 0 && t < len && this.r.chunks.getBlock(Math.floor(wx), SEA_LEVEL, Math.floor(wz)) === B.WATER) { this.fx.impact(wx, SURFACE, wz, 0, 1, 0, 'water'); this.impactSound('water', wx, SURFACE, wz); return; }
    }
    if (m.hit) {
      this.fx.impact(m.tx - ux * 0.05, m.ty - uy * 0.05, m.tz - uz * 0.05, -ux, -uy, -uz, stun ? 'stun' : 'hit', undefined, false);
      return;
    }
    const px = m.tx + ux * 0.03, py = m.ty + uy * 0.03, pz = m.tz + uz * 0.03;
    let id = this.r.chunks.getBlock(Math.floor(px), Math.floor(py), Math.floor(pz));
    if (SOLID[id] !== 1) {
      // vehicle hits come back as non-solid ends: check for a car right there
      for (const e of this.latest.values()) {
        if (e.k !== 'v') continue;
        const def = VEHICLES[e.m as keyof typeof VEHICLES];
        if (Math.hypot(e.x - m.tx, e.z - m.tz) < def.length * 0.6 && m.ty > e.y - 0.2 && m.ty < e.y + def.height + 0.3) {
          this.fx.impact(m.tx - ux * 0.05, m.ty - uy * 0.05, m.tz - uz * 0.05, -ux, -uy, -uz, 'vehicle'); this.impactSound('metal', m.tx, m.ty, m.tz); return;
        }
      }
      // ray ended in the air (out of range) — nothing to hit
      id = this.r.chunks.getBlock(Math.floor(m.tx + ux * 0.2), Math.floor(m.ty + uy * 0.2), Math.floor(m.tz + uz * 0.2));
      if (SOLID[id] !== 1) return;
    }
    // face normal: the coordinate closest to a block boundary is the face we hit
    const fx = m.tx - Math.round(m.tx), fy = m.ty - Math.round(m.ty), fz = m.tz - Math.round(m.tz);
    const ax = Math.abs(fx) / Math.max(1e-3, Math.abs(ux)), ay = Math.abs(fy) / Math.max(1e-3, Math.abs(uy)), az = Math.abs(fz) / Math.max(1e-3, Math.abs(uz));
    let nx = 0, ny = 0, nz = 0;
    if (ax <= ay && ax <= az) nx = -Math.sign(ux); else if (ay <= az) ny = -Math.sign(uy); else nz = -Math.sign(uz);
    const kind = stun ? 'stun' : impactKindFor(id);
    const bc = BLOCKS[id]?.color;
    if (bc !== undefined) _col.setHex(bc);
    else _col.setHex(kind === 'wood' ? 0x7a5230 : kind === 'grass' ? 0x5f8a3a : kind === 'sand' ? 0xd8c690 : kind === 'metal' ? 0x8a9098 : 0x9a968e);
    // snap the point onto the face plane so decals sit flush
    let hx = m.tx, hy = m.ty, hz = m.tz;
    if (nx) hx = Math.round(m.tx); else if (ny) hy = Math.round(m.ty); else hz = Math.round(m.tz);
    this.fx.impact(hx, hy, hz, nx, ny, nz, kind, _col, !stun);
    this.impactSound(kind, hx, hy, hz);
    if (kind === 'glass' && Math.random() < 0.35) audio.sfx('glass_break', { x: hx, y: hy, z: hz, volume: 0.35, rate: 1.3 });
  }

  private impactSound(kind: ImpactKind, x: number, y: number, z: number) {
    const c = this.r.camera.position;
    const d = Math.hypot(x - c.x, y - c.y, z - c.z);
    const v = Math.max(0, 1 - d / 45);
    if (v <= 0.02) return;
    synth.impact(kind, v);
    const sample = kind === 'metal' || kind === 'vehicle' ? 'bullet_impact_metal' : kind === 'hit' ? 'bullet_impact_flesh' : kind === 'water' || kind === 'stun' ? null : 'bullet_impact_concrete';
    if (sample) audio.sfx(sample, { x, y, z, volume: 0.55 * v + 0.15, rate: 0.92 + Math.random() * 0.16 });
    if ((kind === 'metal' || kind === 'concrete' || kind === 'vehicle') && Math.random() < 0.18) audio.sfx('ricochet', { x, y, z, volume: 0.45, rate: 0.9 + Math.random() * 0.25 });
  }

  /** occasional distant city sounds: dogs, planes, helicopters, sirens, gulls near the water */
  private ambientOneShots() {
    const now = performance.now();
    if (now < this.nextAmbAt) return;
    this.nextAmbAt = now + 9000 + Math.random() * 16000;
    const a = Math.random() * Math.PI * 2, d = 25 + Math.random() * 45;
    const x = this.local.x + Math.cos(a) * d, z = this.local.z + Math.sin(a) * d, y = this.local.y + 4;
    const r = Math.random();
    if (r < 0.22) audio.sfx('dog_bark', { x, y: this.local.y, z, volume: 0.35 });
    else if (r < 0.42) audio.sfx('plane_flyover', { volume: 0.22 });
    else if (r < 0.55) audio.sfx('police_radio', { x, y: this.local.y, z, volume: 0.25 });
    else if (r < 0.72) audio.sfx('seagulls', { x, y: y + 10, z, volume: 0.25 });
    else if (r < 0.85) audio.sfx('car_alarm', { x, y: this.local.y, z, volume: 0.15 });
    else audio.sfx('distant_sirens', { volume: 0.18 });
  }

  /** stings for mission start/objective/pass are driven from activity state */
  private activitySounds(s: ReturnType<typeof getState>) {
    const a = s.activity;
    const phase = a ? `${a.activity}:${a.phase}` : '';
    if (phase !== this.lastPhase) {
      if (a && a.phase === 'playing' && !this.lastPhase.endsWith(':playing')) audio.sfx('mission_start', { volume: 0.55 });
      this.lastPhase = phase;
    }
    const sig = a ? a.objectives.map((o) => `${o.text}|${o.done ? 1 : 0}`).join(';') : '';
    if (sig && this.lastObjSig && sig !== this.lastObjSig && a?.phase === 'playing') audio.sfx('objective', { volume: 0.5 });
    this.lastObjSig = sig;
  }

  private onSnapshot(s: Snapshot) {
    for (const raw of s.ents) {
      const base = this.latest.get(raw.id);
      if (!base && !(raw as { k?: string }).k) continue; // delta for an entity we never saw in full
      const e = (base ? mergeDelta(base, raw) : raw) as Ent;
      let b = this.buffers.get(e.id);
      if (!b) { b = []; this.buffers.set(e.id, b); }
      b.push({ t: s.time, e });
      if (b.length > 24) b.shift();
      this.latest.set(e.id, e);
    }
    for (const g of s.gone) { this.buffers.delete(g); this.latest.delete(g); }
    const me = s.me;
    const prevMe = this.me;
    this.me = me;
    // vehicle enter/exit sequences animate around the server's (instant) seat change
    if (this.skipTrans) { this.skipTrans = false; this.trans = null; }
    else if (me.veh && !prevMe?.veh) this.beginEnter(me.veh, me.seat ?? 0);
    else if (!me.veh && prevMe?.veh) this.beginExit(prevMe.veh, prevMe.seat ?? 0, !!me.down, me.x, me.z);
    else if (me.veh && prevMe?.veh && me.veh !== prevMe.veh) this.trans = null;
    this.trackHurt(me);
    if (!!me.down !== this.wasDown) { this.wasDown = !!me.down; if (me.down) audio.sfx('wasted', { volume: 0.8 }); }
    this.pending = this.pending.filter((p) => p.seq > s.ack);
    const colliders = this.doorColliders();
    if (me.veh && me.seat === 0 && me.vp) {
      const v = this.latest.get(me.veh) as VehicleEnt | undefined;
      const def = VEHICLES[(v?.m ?? 'sedan') as keyof typeof VEHICLES];
      const vp: VehiclePhys = { x: me.vp.x, y: me.vp.y, z: me.vp.z, yaw: me.vp.yaw, speed: me.vp.speed, vy: me.vp.vy, steer: me.vp.steer, onGround: me.vp.og, impact: 0, drowned: false };
      if (!this.frozen()) for (const p of this.pending) stepVehicle(vp, p.veh, DT, this.r.chunks, def, colliders);
      if (this.vphys) {
        const err = Math.hypot(vp.x - this.vphys.x, vp.z - this.vphys.z);
        if (err > 6) { this.prevV = null; this.vehErr.set(0, 0, 0); this.vehYawErr = 0; } // big correction: snap
        else {
          // small correction: keep what you see where it was and blend the error away over ~0.15 s
          this.vehErr.x += this.vphys.x - vp.x; this.vehErr.y += this.vphys.y - vp.y; this.vehErr.z += this.vphys.z - vp.z;
          let dy = this.vphys.yaw - vp.yaw; while (dy > Math.PI) dy -= Math.PI * 2; while (dy < -Math.PI) dy += Math.PI * 2;
          this.vehYawErr += dy;
        }
      }
      this.vphys = vp;
      if (!this.prevV) this.prevV = { x: vp.x, y: vp.y, z: vp.z, yaw: vp.yaw };
    } else {
      this.vphys = null; this.prevV = null;
      const ph: PlayerPhys = { x: me.x, y: me.y, z: me.z, vx: me.vx, vy: me.vy, vz: me.vz, onGround: me.og, inWater: false };
      if (!me.veh && !this.frozen()) for (const p of this.pending) stepPlayer(ph, p.foot, DT, this.r.chunks, colliders);
      const ex = this.local.x - ph.x, ey = this.local.y - ph.y, ez = this.local.z - ph.z;
      const err = Math.hypot(ex, ey, ez);
      if (err > 4 || me.veh || prevMe?.veh) { this.visualErr.set(0, 0, 0); this.prevLocal = { x: ph.x, y: ph.y, z: ph.z }; }
      else this.visualErr.add(tmpV.set(ex, ey, ez));
      ph.inWater = waterAt(this.r.chunks, ph.x, ph.y + 0.6, ph.z);
      this.local = ph;
    }
  }

  /** hp went down: work out where it came from for the damage indicator */
  private trackHurt(me: Snapshot['me']) {
    const hp = me.hp;
    if (this.lastHp >= 0 && hp < this.lastHp - 0.5) {
      const amt = this.lastHp - hp;
      const now = performance.now();
      let bearing = NaN;
      const mx = this.local.x, mz = this.local.z;
      for (let i = this.recentShots.length - 1; i >= 0; i--) {
        const sh = this.recentShots[i];
        if (now - sh.at > 450) break;
        if (Math.hypot(sh.tx - mx, sh.tz - mz) < 3.5) { bearing = Math.atan2(-(sh.ox - mx), -(sh.oz - mz)); break; }
      }
      if (Number.isNaN(bearing)) {
        // melee (police) or traffic: nearest threat close by
        let best = 6;
        for (const e of this.latest.values()) {
          if (e.k !== 'n' && e.k !== 'v') continue;
          if (e.k === 'n' && !/cop|guard|police/.test(e.r)) continue;
          const d = Math.hypot(e.x - mx, e.z - mz);
          if (d < best && d > 0.1) { best = d; bearing = Math.atan2(-(e.x - mx), -(e.z - mz)); }
        }
      }
      liveFeel.hurts.push({ at: now, bearing, amt });
      if (liveFeel.hurts.length > 6) liveFeel.hurts.shift();
      liveFeel.flashAt = now; liveFeel.flashAmt = clamp(0.3 + amt / 30, 0.3, 1);
      synth.hurt(amt > 18);
      if (amt > 8 && performance.now() - this.lastGruntAt > 900) { this.lastGruntAt = performance.now(); audio.sfx('hurt_grunt', { volume: 0.55, rate: 0.92 + Math.random() * 0.16 }); }
      if (!getState().settings.reduceShake) { this.shake = Math.min(1, this.shake + 0.15 + amt / 80); this.punch -= 0.01; }
    }
    this.lastHp = hp;
  }

  private lastGruntAt = 0;
  private wasDown = false;
  private wasSwimming = false;
  private lastSpeedSfx = 0;
  private prevGear = 0;
  private lastObjSig = '';
  private lastPhase = '';
  private nextAmbAt = 0;
  private frozen() { const s = getState(); return !!s.cutscene || !!this.me?.down; }

  private doorColliders(): AABB[] {
    const out: AABB[] = [];
    for (const e of this.latest.values()) {
      if (e.k !== 'd' || e.open) continue;
      const h = e.w >= 6 ? 5 : 2;
      if (e.axis === 'x') out.push({ minX: e.x, maxX: e.x + e.w, minY: e.y, maxY: e.y + h, minZ: e.z, maxZ: e.z + 1 });
      else out.push({ minX: e.x, maxX: e.x + 1, minY: e.y, maxY: e.y + h, minZ: e.z, maxZ: e.z + e.w });
    }
    return out;
  }

  // ───────────────────────────────────────────────────────── enter / exit sequences
  private beginEnter(vehId: string, seat: number) {
    const v = this.latest.get(vehId) as VehicleEnt | undefined;
    if (!v || this.me?.down) { this.trans = null; return; }
    const def = VEHICLES[v.m as keyof typeof VEHICLES];
    const from = this.footRender.clone();
    if (Math.hypot(from.x - v.x, from.z - v.z) > def.length / 2 + 6) { this.trans = null; return; } // teleported in: no animation
    const [sx] = seatOffset(def, seat);
    const side = sx >= 0 ? 1 : -1;
    this.doorPos(v, def, seat, side, _a);
    const walk = clamp(Math.hypot(_a.x - from.x, _a.z - from.z) / 4.6, 0, 0.55);
    const getIn = def.bike ? 0.42 : def.boat ? 0.5 : 0.62;
    this.trans = { kind: 'enter', veh: vehId, seat, t0: performance.now(), walk, dur: walk + getIn, from, fromYaw: this.charYaw, side, camFrom: this.r.camera.position.clone(), carYaw: v.yaw };
    if (!def.bike && !def.boat) {
      setTimeout(() => audio.sfx('car_door_open', { x: v.x, y: v.y + 1, z: v.z, volume: 0.7 }), walk * 1000);
      setTimeout(() => audio.sfx('car_door_close', { x: v.x, y: v.y + 1, z: v.z, volume: 0.75 }), (walk + getIn * 0.85) * 1000);
    }
    if (seat === 0) setTimeout(() => audio.sfx('engine_start', { x: v.x, y: v.y + 0.5, z: v.z, volume: 0.6 }), (walk + getIn) * 1000 + 120);
    this.vehLook = clamp(angleDiff(this.yaw, v.yaw), -2.4, 2.4);
    this.chaseYaw = v.yaw; this.chaseInit = true;
    this.startCamBlend(walk + getIn);
  }

  private beginExit(vehId: string, seat: number, down: boolean, outX: number, outZ: number) {
    const v = this.latest.get(vehId) as VehicleEnt | undefined;
    if (!v || down) { this.trans = null; return; }
    const def = VEHICLES[v.m as keyof typeof VEHICLES];
    const from = this.seatRender.clone();
    // (this.local is still the stale on-foot state here; the snapshot has where the server put us)
    if (Math.hypot(from.x - outX, from.z - outZ) > 6) { this.trans = null; return; }
    const [sx] = seatOffset(def, seat);
    const dur = def.bike ? 0.36 : def.boat ? 0.45 : 0.52;
    this.trans = { kind: 'exit', veh: vehId, seat, t0: performance.now(), walk: 0, dur, from, fromYaw: v.yaw, side: sx >= 0 ? 1 : -1, camFrom: this.seatEye.clone(), carYaw: v.yaw };
    this.charYaw = v.yaw + (sx >= 0 ? -1 : 1) * Math.PI / 2;
    if (!def.bike && !def.boat) { audio.sfx('car_door_open', { x: v.x, y: v.y + 1, z: v.z, volume: 0.65 }); setTimeout(() => audio.sfx('car_door_close', { x: v.x, y: v.y + 1, z: v.z, volume: 0.7 }), dur * 1000 + 150); }
    if (seat === 0 && !def.bike) audio.sfx('engine_stop', { x: v.x, y: v.y + 0.5, z: v.z, volume: 0.45 });
  }

  private startCamBlend(dur: number) {
    if (getState().settings.camera === 'first') { this.camBlend = null; return; }
    this.camBlend = { from: this.r.camera.position.clone(), q: this.r.camera.quaternion.clone(), t0: performance.now(), dur: dur + 0.15 };
  }

  /** world position just outside a seat's door (feet) */
  private doorPos(v: { x: number; y: number; z: number; yaw: number }, def: VehicleDef, seat: number, side: number, out: THREE.Vector3) {
    const [, , sz] = seatOffset(def, seat);
    const rx = Math.cos(v.yaw), rz = -Math.sin(v.yaw), fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
    const off = def.bike ? 0.75 : def.width / 2 + 0.45;
    return out.set(v.x + rx * side * off + fx * sz, v.y + (def.boat ? 0.2 : 0), v.z + rz * side * off + fz * sz);
  }

  /** feet/root position for a seated character (matches EntityRenderer.seat) */
  private seatRoot(v: { id?: string; x: number; y: number; z: number; yaw: number }, def: VehicleDef, seat: number, out: THREE.Vector3) {
    const [sx, sy, sz] = seatOffset(def, seat);
    const rx = Math.cos(v.yaw), rz = -Math.sin(v.yaw), fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
    const proto = v.id ? this.ents.vehicles.rigs.get(v.id)?.proto : undefined;
    return out.set(v.x + rx * sx + fx * sz, v.y + sy - (def.bike ? 0.5 : 0.45) + (def.boat ? 0.02 : 0) - (proto ? occupantDrop(proto, sy) : 0), v.z + rz * sx + fz * sz);
  }

  /** returns the animated pose of the local character while a sequence runs */
  private transPose(now: number, out: THREE.Vector3, veh: VehicleEnt | null): { yaw: number; anim: number; k: number; inSeat: boolean } | null {
    const t = this.trans;
    if (!t) return null;
    const el = (now - t.t0) / 1000;
    if (el >= t.dur || !veh) { this.trans = null; return null; }
    const def = VEHICLES[veh.m as keyof typeof VEHICLES];
    if (t.kind === 'enter') {
      this.doorPos(veh, def, t.seat, t.side, _b);
      const faceIn = veh.yaw + t.side * Math.PI / 2;
      if (el < t.walk) {
        const k = el / Math.max(0.01, t.walk);
        out.lerpVectors(t.from, _b, ease(k));
        const walkYaw = Math.atan2(-(_b.x - t.from.x), -(_b.z - t.from.z));
        const yaw = lerpAngle(lerpAngle(t.fromYaw, walkYaw, Math.min(1, k * 3)), faceIn, ease((k - 0.6) / 0.4));
        return { yaw, anim: 1, k: (el / t.dur), inSeat: false };
      }
      const k2 = (el - t.walk) / Math.max(0.01, t.dur - t.walk);
      this.seatRoot(veh, def, t.seat, _c);
      out.lerpVectors(_b, _c, ease(k2));
      out.y += Math.sin(clamp(k2, 0, 1) * Math.PI) * (def.bike ? 0.35 : 0.12); // step up / swing a leg over
      const yaw = lerpAngle(faceIn, veh.yaw, ease((k2 - 0.15) / 0.6));
      return { yaw, anim: k2 > 0.25 ? 5 : 0, k: el / t.dur, inSeat: k2 > 0.55 };
    }
    // exit: slide from the seat to where the server put us
    const k = el / t.dur;
    _b.set(this.local.x, this.local.y, this.local.z);
    this.seatRoot(veh, def, t.seat, _c);
    out.lerpVectors(_c, _b, ease(k));
    out.y += Math.sin(clamp(k, 0, 1) * Math.PI) * 0.12;
    const outYaw = veh.yaw - t.side * Math.PI / 2;
    return { yaw: lerpAngle(veh.yaw, outYaw, ease(k * 1.4)), anim: k < 0.45 ? 5 : 0, k, inSeat: k < 0.3 };
  }

  // ───────────────────────────────────────────────────────── fixed step
  private tick() {
    const s = getState();
    const live = s.screen === 'game' && !s.overlay && (this.input.locked || this.input.fallback);
    const k = (a: string) => live && this.input.held(a);
    const exiting = this.trans?.kind === 'exit';
    const entering = this.trans?.kind === 'enter';
    const foot: MoveInput = {
      mx: exiting ? 0 : (k('right') ? 1 : 0) - (k('left') ? 1 : 0),
      mz: exiting ? 0 : (k('forward') ? 1 : 0) - (k('back') ? 1 : 0),
      yaw: this.yaw, jump: !exiting && k('jump'), sprint: k('sprint') && !this.aimHeld,
    };
    const veh: VehInput = entering ? { th: 0, st: 0, hb: false } : { th: (k('forward') ? 1 : 0) - (k('back') ? 1 : 0), st: (k('left') ? -1 : 0) + (k('right') ? 1 : 0), hb: k('handbrake') };
    this.lastVeh = veh;
    const seq = this.seq++;
    net.send({ t: 'input', seq, mx: foot.mx, mz: foot.mz, yaw: this.yaw, pitch: Math.max(-1.55, Math.min(1.55, this.pitch)), jump: foot.jump, sprint: foot.sprint, th: veh.th, st: veh.st, hb: veh.hb });
    if (!this.me) return;
    const colliders = this.doorColliders();
    if (!this.frozen()) {
      if (this.vphys && this.me.veh) {
        const v = this.latest.get(this.me.veh) as VehicleEnt | undefined;
        const def = VEHICLES[(v?.m ?? 'sedan') as keyof typeof VEHICLES];
        this.prevV = { x: this.vphys.x, y: this.vphys.y, z: this.vphys.z, yaw: this.vphys.yaw };
        stepVehicle(this.vphys, veh, DT, this.r.chunks, def, colliders);
        // collision camera shake scaled by the predicted impact speed
        if (this.vphys.impact > 3 && !s.settings.reduceShake) this.shake = Math.min(1.3, this.shake + this.vphys.impact / 20);
      } else if (!this.me.veh) {
        this.prevLocal = { x: this.local.x, y: this.local.y, z: this.local.z };
        const wasGround = this.local.onGround, vyBefore = this.local.vy, wasWater = this.local.inWater;
        stepPlayer(this.local, foot, DT, this.r.chunks, colliders);
        if (wasGround && !this.local.onGround && this.local.vy > 2 && foot.jump && !this.local.inWater) audio.sfx('jump', { volume: 0.32 });
        if (!wasGround) this.airVy = Math.min(this.airVy, vyBefore);
        if (!wasGround && this.local.onGround && !this.local.inWater) {
          const impact = -this.airVy;
          if (impact > 3.5) {
            audio.sfx('land', { volume: clamp(impact / 16, 0.15, 1), rate: impact > 12 ? 0.85 : 1 });
            if (!s.settings.reduceShake) this.dipV -= clamp(impact * 0.09, 0.2, 1.6);
          }
          this.airVy = 0;
        }
        if (this.local.onGround) this.airVy = 0;
        if (!wasWater && this.local.inWater) audio.sfx(-vyBefore > 9 ? 'big_splash' : 'splash', { volume: clamp(0.3 + -vyBefore / 14, 0.3, 1), x: this.local.x, y: this.local.y + 1, z: this.local.z });
        if (wasWater && !this.local.inWater && this.local.onGround) audio.sfx('water_climb_out', { volume: 0.6 });
      }
    }
    this.pending.push({ seq, foot, veh });
    if (this.pending.length > 120) this.pending.shift();
  }

  /** footsteps synced to the head-bob phase (one step per half cycle) */
  private footstepNow() {
    const id = this.r.chunks.getBlock(Math.floor(this.local.x), Math.floor(this.local.y - 0.1), Math.floor(this.local.z));
    const mat = BLOCKS[id]?.step ?? 'concrete';
    audio.footstep(mat, this.local.x, this.local.y, this.local.z);
  }

  // ───────────────────────────────────────────────────────── per frame
  private frame() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.frames++;
    if (now - this.fpsAt > 1000) { setState({ fps: Math.round((this.frames * 1000) / (now - this.fpsAt)) }); this.frames = 0; this.fpsAt = now; }
    const s = getState();

    // time of day is shared: derived from server time
    this.r.timeOfDay = ((net.serverNow() / 1000 / DAY_LENGTH_S) + 0.35) % 1;
    this.r.wx.outdoor = this.instanceKind === 'interior' ? 0 : 1;

    const playing = (s.screen === 'game' || s.screen === 'loading') && !!this.me && !!s.world;
    if (!playing) {
      this.inGame = false;
      livePose.active = false;
      liveFeel.show = false; liveFeel.underwater = false;
      const p = this.tour.update(dt);
      this.r.update(dt, p);
      this.ents.update(dt, [], this.localView(false));
      this.fx.headlight(false);
      this.r.render();
      this.audioMenu(s.screen);
      emitFeelFrame();
      this.input.endFrame();
      return;
    }
    this.inGame = true;
    livePose.active = s.screen === 'game';
    const reduce = s.settings.reduceShake;
    const firstPerson = s.settings.camera === 'first';
    const cs = s.cutscene;
    const w = WEAPONS[this.weapon.id];
    const rec = recoilFor(this.weapon.id, w?.kind);
    const inVeh = !!this.me?.veh;
    const live = (this.input.locked || this.input.fallback) && !s.overlay && !cs && !this.wheelOpen && !this.me?.down && s.screen === 'game';

    // aim (ADS) / drive-by
    const wantAim = live && this.input.held('aim') && !!w && !this.trans;
    if (wantAim && inVeh && w && !DRIVEBY_KINDS.has(w.kind) && this.input.tapped('aim')) this.switchForDriveBy(s);
    this.driveBy = inVeh && wantAim && !!w && DRIVEBY_KINDS.has(w.kind);
    this.aimHeld = wantAim && (!inVeh || this.driveBy);
    if (this.aimHeld && this.input.tapped('aim')) synth.aimIn();
    this.aimK = damp(this.aimK, this.aimHeld ? 1 : 0, 14, dt);

    // mouse look (slower while aiming down sights)
    const zoomNow = 1 + (rec.zoom - 1) * this.aimK;
    const sens = 0.0022 * s.settings.mouseSensitivity * (firstPerson ? zoomNow : 1 - 0.3 * this.aimK);
    if ((this.input.locked || this.input.fallback) && !s.overlay && !cs && !this.wheelOpen) {
      const dy = this.input.mouseDY * (s.settings.invertY ? -1 : 1);
      const dYaw = -this.input.mouseDX * sens, dPitch = -dy * sens;
      if (this.me?.veh) { this.vehLook += dYaw; this.vehLook = Math.max(-2.4, Math.min(2.4, this.vehLook)); }
      else this.yaw += dYaw;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch + dPitch));
      // pulling against the recoil pays it off so recovery never over-corrects
      if (this.recoilP > 0 && dPitch < 0) this.recoilP = Math.max(0, this.recoilP + dPitch);
      if (this.recoilY !== 0 && Math.sign(dYaw) === Math.sign(this.recoilY)) this.recoilY = Math.abs(dYaw) > Math.abs(this.recoilY) ? 0 : this.recoilY - dYaw;
    }

    // fixed-step simulation
    this.acc += dt;
    let n = 0;
    while (this.acc >= DT && n < 5) { this.tick(); this.acc -= DT; n++; }
    if (n === 5) this.acc = 0;
    const alpha = this.acc / DT;

    this.handleActions(s);
    this.updateRecoil(dt, rec);
    this.heat = Math.max(0, this.heat - HEAT_DECAY * dt);

    // render positions
    const renderPos = this.vRender;
    let renderYawVeh = 0;
    let localVeh: VehicleEnt | null = null;
    const remote = this.interpolate();
    if (this.me?.veh) {
      localVeh = (remote.find((e) => e.id === this.me!.veh) as VehicleEnt | undefined) ?? null;
      if (this.vphys && this.prevV && localVeh) {
        const k = Math.exp(-dt * 14);
        this.vehErr.multiplyScalar(k); this.vehYawErr *= k;
        localVeh = { ...localVeh, x: this.prevV.x + (this.vphys.x - this.prevV.x) * alpha + this.vehErr.x, y: this.prevV.y + (this.vphys.y - this.prevV.y) * alpha + this.vehErr.y, z: this.prevV.z + (this.vphys.z - this.prevV.z) * alpha + this.vehErr.z, yaw: lerpAngle(this.prevV.yaw, this.vphys.yaw, alpha) + this.vehYawErr, sp: this.vphys.speed, st: this.vphys.steer };
        const i = remote.findIndex((e) => e.id === localVeh!.id);
        if (i >= 0) remote[i] = localVeh;
      }
      if (localVeh) {
        const def = VEHICLES[localVeh.m as keyof typeof VEHICLES];
        const [sx, sy, sz] = seatOffset(def, this.me.seat ?? 0);
        const rx = Math.cos(localVeh.yaw), rz = -Math.sin(localVeh.yaw), fx = -Math.sin(localVeh.yaw), fz = -Math.cos(localVeh.yaw);
        renderPos.set(localVeh.x + rx * sx + fx * sz, localVeh.y + sy, localVeh.z + rz * sx + fz * sz);
        renderYawVeh = localVeh.yaw;
        this.seatRoot(localVeh, def, this.me.seat ?? 0, this.seatRender);
      } else renderPos.set(this.me.x, this.me.y, this.me.z);
    } else {
      this.visualErr.multiplyScalar(Math.max(0, 1 - dt * 10));
      renderPos.set(
        this.prevLocal.x + (this.local.x - this.prevLocal.x) * alpha + this.visualErr.x,
        this.prevLocal.y + (this.local.y - this.prevLocal.y) * alpha + this.visualErr.y,
        this.prevLocal.z + (this.local.z - this.prevLocal.z) * alpha + this.visualErr.z,
      );
    }

    // enter/exit sequence pose
    const transVeh = this.trans ? ((localVeh && localVeh.id === this.trans.veh ? localVeh : (remote.find((e) => e.id === this.trans!.veh) as VehicleEnt | undefined)) ?? null) : null;
    const tp = this.transPose(now, this.vAnim, transVeh);
    const animPos = tp ? this.vAnim : renderPos;
    if (!this.me?.veh && !tp) { this.footRender.copy(renderPos); }

    // movement feel (on foot)
    const hs = this.me?.veh ? 0 : Math.hypot(this.local.vx, this.local.vz);
    const grounded = this.local.onGround && !this.local.inWater && !this.me?.veh && !tp;
    const sprinting = grounded && hs > 5.6 && !this.aimHeld;
    this.sprintK = damp(this.sprintK, sprinting ? 1 : 0, 5, dt);
    this.bobAmt = damp(this.bobAmt, grounded ? Math.min(1, hs / 7.2) : 0, 8, dt);
    if (this.prevRenderOk && !this.me?.veh && !tp) {
      const moved = Math.hypot(renderPos.x - this.prevRender.x, renderPos.z - this.prevRender.z);
      if (moved < 2) {
        const stride = 1.75 + hs * 0.06;
        this.bobPhase += (moved / stride) * Math.PI * (grounded ? 1 : 0);
        const stepN = Math.floor(this.bobPhase / Math.PI);
        if (stepN !== this.lastStep) { this.lastStep = stepN; if (grounded && hs > 0.8) this.footstepNow(); }
        if (this.local.inWater && moved > 0.01) { this.bobPhase += moved * 0.5; }
      }
    }
    this.prevRender.copy(renderPos); this.prevRenderOk = true;
    // landing dip spring (critically damped)
    this.dipV += (-this.dip * 170 - this.dipV * 26) * dt; this.dip += this.dipV * dt;
    // strafe roll: at most 1 degree
    const latV = this.me?.veh ? 0 : (this.local.vx * Math.cos(this.yaw) - this.local.vz * Math.sin(this.yaw));
    this.roll = damp(this.roll, reduce ? 0 : clamp(-latV / 7.2, -1, 1) * 0.01745, 8, dt);
    // character facing: aim/fire faces the camera, otherwise turn toward where you move
    const recentlyFired = now - this.weapon.lastFire < 900;
    if (!this.me?.veh && !tp) {
      let want = this.charYaw;
      if (firstPerson || this.aimK > 0.2 || recentlyFired) want = this.yaw;
      else if (hs > 0.7) want = Math.atan2(-this.local.vx, -this.local.vz);
      this.charYaw = lerpAngle(this.charYaw, want, 1 - Math.exp(-(firstPerson ? 30 : 11) * dt));
    }

    // camera
    let focus = this.vFocus.copy(renderPos);
    const baseFov = s.settings.fov;
    let wantFov = baseFov;
    const cockpitView = firstPerson && !cs && !this.me?.down && !!(
      (localVeh && (!tp || tp.inSeat)) || (tp && this.trans?.kind === 'exit' && tp.inSeat && transVeh));
    const camVeh = localVeh ?? (cockpitView ? transVeh : null);
    let rigPitch = 0, rigRoll = 0;
    if (camVeh) { const rig = this.ents.vehicles.rigs.get(camVeh.id); if (rig) { rigPitch = rig.pitch; rigRoll = rig.roll; } }
    if (cs) {
      focus = this.cutsceneCamera(cs);
    } else if (this.me?.down) {
      const t = Math.min(1, (Date.now() - (this.me.down - 7000)) / 3000);
      this.r.camera.position.set(renderPos.x + 2, renderPos.y + 2 + t * 4, renderPos.z + 2);
      this.r.camera.lookAt(renderPos.x, renderPos.y + 0.3, renderPos.z);
    } else if (firstPerson && tp && !cockpitView) {
      // first-person get-in/out: camera rides the animated body, then slides into/out of the seat
      const t = this.trans!;
      if (t.kind === 'enter' && localVeh) {
        const def = VEHICLES[localVeh.m as keyof typeof VEHICLES];
        _a.set(animPos.x, animPos.y + EYE_HEIGHT, animPos.z);
        const el = (now - t.t0) / 1000;
        if (el > t.walk) {
          const eye = this.cockpit.eyeOffset(localVeh.m as never, this.me?.seat ?? 0).applyAxisAngle(UP, localVeh.yaw);
          _b.set(localVeh.x + eye.x, localVeh.y + eye.y, localVeh.z + eye.z);
          this.doorPos(localVeh, def, t.seat, t.side, tmpV); tmpV.y += EYE_HEIGHT;
          _a.lerpVectors(tmpV, _b, ease((el - t.walk) / (t.dur - t.walk)));
        }
        this.vehLook = damp(this.vehLook, 0, el > t.walk ? 5 : 0.5, dt);
        this.r.camera.position.copy(_a);
        this.r.camera.rotation.set(this.pitch * 0.9, localVeh.yaw + this.vehLook, 0, 'YXZ');
        this.yaw = localVeh.yaw + this.vehLook;
      } else {
        _a.lerpVectors(t.camFrom, tmpV.set(renderPos.x, renderPos.y + EYE_HEIGHT, renderPos.z), ease(tp.k));
        this.r.camera.position.copy(_a);
        this.r.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
      }
    } else if (camVeh) {
      const def = VEHICLES[camVeh.m as keyof typeof VEHICLES];
      const sp = camVeh.sp, f = Math.min(1, Math.abs(sp) / def.maxSpeed);
      if (Math.abs(sp) > 2 && !this.input.mouseDX && !this.driveBy) this.vehLook *= Math.max(0, 1 - dt * 1.5);
      const seat = this.trans?.kind === 'exit' ? this.trans.seat : this.me?.seat ?? 0;
      if (firstPerson) {
        const eye = this.cockpit.eyeOffset(camVeh.m as never, seat);
        eye.y += Math.sin(now * 0.031) * 0.004 * f * (reduce ? 0 : 1); // engine/road vibration
        eye.applyEuler(_e.set(rigPitch, camVeh.yaw, rigRoll, 'YXZ'));
        this.r.camera.position.set(camVeh.x + eye.x, camVeh.y + eye.y, camVeh.z + eye.z);
        if (this.trans?.kind === 'exit' && tp) this.r.camera.position.lerpVectors(this.trans.camFrom, tmpV.set(renderPos.x, renderPos.y + EYE_HEIGHT, renderPos.z), ease(tp.k));
        if (!this.trans) this.seatEye.copy(this.r.camera.position);
        this.pitch = Math.max(-0.75, Math.min(0.55, this.pitch));
        const lookInto = this.driveBy ? 0 : -camVeh.st * 0.07 * f; // glance into the turn
        this.r.camera.rotation.set(this.pitch + rigPitch + this.punch, camVeh.yaw + this.vehLook + lookInto + this.punchYaw, rigRoll * 0.6 + this.punchRoll, 'YXZ');
        wantFov = baseFov + f * 5;
        if (this.trans?.kind === 'enter' && tp) this.vehLook = damp(this.vehLook, 0, 5, dt);
      } else {
        this.chaseCamera(dt, camVeh, def, f);
        wantFov = baseFov + f * 11 - this.aimK * 8;
      }
      if (localVeh) this.yaw = camVeh.yaw + this.vehLook;
    } else if (firstPerson) {
      // head-bob, landing dip, strafe roll, recoil punch
      const bobK = reduce ? 0 : this.bobAmt * (1 - 0.75 * this.aimK);
      const by = -Math.abs(Math.sin(this.bobPhase)) * 0.06 * bobK;
      const bx = Math.sin(this.bobPhase) * 0.032 * bobK;
      let swimY = 0, swimRoll = 0;
      if (this.local.inWater && !reduce) { swimY = Math.sin(now * 0.0024) * 0.07; swimRoll = Math.sin(now * 0.0013) * 0.012; }
      const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
      let cy = renderPos.y + EYE_HEIGHT + by + swimY + this.dip * (reduce ? 0 : 1);
      // never sit exactly on the water plane (ugly clipping): nudge just above/below
      const surf = SURFACE;
      if (Math.abs(cy - surf) < 0.09 && this.local.inWater) cy = cy > surf ? surf + 0.09 : surf - 0.09;
      this.r.camera.position.set(renderPos.x + rx * bx, cy, renderPos.z + rz * bx);
      this.r.camera.rotation.set(this.pitch + this.punch, this.yaw + this.punchYaw, this.roll + swimRoll + this.punchRoll + Math.sin(this.bobPhase) * 0.004 * bobK, 'YXZ');
      wantFov = baseFov * zoomNow + this.sprintK * 7 * (1 - this.aimK);
    } else {
      this.shoulderCamera(dt, animPos, now);
      wantFov = baseFov * (1 - 0.14 * this.aimK) + this.sprintK * 5;
    }
    // third-person blends between on-foot and vehicle cameras during enter/exit
    if (this.camBlend && !cs && !firstPerson) {
      const k = (now - this.camBlend.t0) / 1000 / this.camBlend.dur;
      if (k >= 1) this.camBlend = null;
      else {
        const e = ease(k);
        this.r.camera.position.lerpVectors(this.camBlend.from, _a.copy(this.r.camera.position), e);
        _q.copy(this.camBlend.q).slerp(this.r.camera.quaternion, e);
        this.r.camera.quaternion.copy(_q);
        // the straight blend path can cut through walls: keep it on the player's side
        this.collideCamera(_b.set(animPos.x, animPos.y + 1.6, animPos.z), this.r.camera.position);
      }
    } else if (firstPerson) this.camBlend = null;
    if (this.shake > 0.01 && !reduce) {
      this.r.camera.position.x += (Math.random() - 0.5) * this.shake * 0.25;
      this.r.camera.position.y += (Math.random() - 0.5) * this.shake * 0.25;
      this.r.camera.rotation.z += (Math.random() - 0.5) * this.shake * 0.02;
    }
    this.shake *= Math.max(0, 1 - dt * 6);
    if (cs) wantFov = baseFov;
    this.camFov = damp(this.camFov, wantFov, 10, dt);
    if (Math.abs(this.r.camera.fov - this.camFov) > 0.01) { this.r.camera.fov = this.camFov; this.r.camera.updateProjectionMatrix(); }

    // underwater check (camera inside a water block)
    const cp = this.r.camera.position;
    const under = this.r.chunks.getBlock(Math.floor(cp.x), Math.floor(cp.y), Math.floor(cp.z)) === B.WATER;
    if (under !== this.wasUnder) { this.wasUnder = under; if (!cs) audio.sfx('splash', { volume: 0.25, rate: under ? 0.8 : 1.15 }); }

    // loading screen gate
    if (s.screen === 'loading') {
      const rd = this.r.chunks.readiness(renderPos.x, renderPos.z, 3);
      setState({ loading: { progress: rd, label: s.loading?.label ?? 'Loading…' } });
      if ((rd > 0.97 && this.preloadDone) || performance.now() - this.loadingSince > 15000) setState({ screen: 'game', loading: null });
    }

    // live pose for UI
    livePose.x = renderPos.x; livePose.y = renderPos.y; livePose.z = renderPos.z;
    livePose.yaw = this.yaw;
    livePose.speedKmh = localVeh ? Math.abs(localVeh.sp) * 3.6 : 0;

    // muzzle world position (tracers start here, flash light, shells)
    this.updateMuzzle(firstPerson && !cs, animPos, !!localVeh);

    // entities
    const csActors = cs ? this.cutsceneActors(cs.id) : [];
    const local = this.localView(firstPerson && !cs && !this.me?.down, animPos, localVeh, tp);
    this.ents.update(dt, csActors.length ? [...remote, ...csActors] : remote, local);
    const fpCar = cockpitView && camVeh;
    if (this.hiddenVeh && (!fpCar || this.hiddenVeh !== camVeh?.id)) { const o = this.ents.vehicleObject(this.hiddenVeh); if (o) o.visible = true; this.hiddenVeh = null; }
    if (fpCar && camVeh) {
      const o = this.ents.vehicleObject(camVeh.id);
      if (o) { o.visible = false; this.hiddenVeh = camVeh.id; }
      const seat = this.trans?.kind === 'exit' ? this.trans.seat : this.me?.seat ?? 0;
      this.cockpit.update(dt, { model: camVeh.m as never, seat, x: camVeh.x, y: camVeh.y, z: camVeh.z, yaw: camVeh.yaw, steer: seat === 0 && localVeh ? camVeh.st : 0, speed: camVeh.sp, color: camVeh.col, outfit: s.profile?.outfit ?? 0xff6f59, rpm: localVeh && seat === 0 ? this.rpm : undefined, pitch: rigPitch, roll: rigRoll, mirror: this.r.L.fogColor.value });
    } else this.cockpit.update(dt, null);
    this.ents.setMarkers(cs ? [] : (s.activity?.objectives.flatMap((o) => o.markers) ?? []), s.settings.colorblindMarkers);
    this.pings = this.pings.filter((p) => performance.now() - p.at < 8000);
    this.ents.setPings(this.pings);

    // own headlights light the blocks ahead at night
    const night = this.r.L.night.value;
    if (localVeh && night > 0.12 && localVeh.hp > 0) {
      const def = VEHICLES[localVeh.m as keyof typeof VEHICLES];
      const fx = -Math.sin(localVeh.yaw), fz = -Math.cos(localVeh.yaw);
      this.fx.headlight(true, localVeh.x + fx * def.length * 0.5, localVeh.y + (def.bike ? 0.9 : 0.7), localVeh.z + fz * def.length * 0.5, fx, -0.13, fz, clamp((night - 0.12) * 2.2, 0, 1));
    } else this.fx.headlight(false);
    this.fx.update(dt);

    this.r.update(dt, focus);
    this.r.render();
    const vmVisible = firstPerson && (!this.me?.veh || (this.driveBy && this.aimK > 0.35)) && !tp && !cs && !this.me?.down && s.screen === 'game';
    const vmState = {
      weapon: this.weapon.id, firing: performance.now() - this.weapon.firing < 90, reloading: performance.now() < this.weapon.reloadingUntil,
      moving: this.me?.veh ? 0 : Math.min(1, hs / 5) * (1 - 0.8 * this.aimK), visible: vmVisible,
      // honoured by the ViewModel once it supports an ADS pose
      aiming: this.aimK > 0.5, aim: this.aimK,
    };
    this.vm.update(dt, vmState);
    this.vm.render();

    this.audioFrame(s, remote, localVeh, dt);
    this.feelHud(s, w, under, firstPerson, !!localVeh, hs);
    this.hudTimer += dt;
    if (this.hudTimer > 0.1) { this.hudTimer = 0; this.updateHud(s, localVeh, remote); }
    this.input.endFrame();
  }

  /** chase camera: speed-based distance/FOV, yaw lag, look-ahead into steering, reverse-safe */
  private chaseCamera(dt: number, v: VehicleEnt, def: VehicleDef, f: number) {
    if (!this.chaseInit) { this.chaseYaw = v.yaw; this.chaseInit = true; }
    const rev = v.sp < -1.5;
    this.chaseYaw = lerpAngle(this.chaseYaw, v.yaw, 1 - Math.exp(-(rev ? 5 : 2.4 + f * 3.5) * dt));
    const look = this.driveBy ? 0 : -v.st * 0.06 * f;
    const yaw = this.chaseYaw + this.vehLook + look;
    const dist = def.length * 0.9 + 2.4 + f * 1.8 - this.aimK * 1.2, height = def.height + 0.95 + f * 0.1;
    const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw);
    const ahead = clamp(v.sp / def.maxSpeed, -0.3, 1) * 2.4;
    const target = _a.set(v.x + fx * ahead, v.y + def.height * 0.7 + 0.35, v.z + fz * ahead);
    const want = _c.set(v.x + Math.sin(yaw) * dist, v.y + def.height * 0.7 + 0.35 + height - this.pitch * 3, v.z + Math.cos(yaw) * dist);
    if (this.camPos.distanceTo(want) > 25) this.camPos.copy(want);
    const kx = 1 - Math.exp(-12 * dt), ky = 1 - Math.exp(-7 * dt);
    this.camPos.x += (want.x - this.camPos.x) * kx; this.camPos.z += (want.z - this.camPos.z) * kx; this.camPos.y += (want.y - this.camPos.y) * ky;
    const pivot = tmpV.set(v.x, v.y + def.height * 0.7 + 0.35, v.z);
    _b.copy(this.camPos);
    this.collideCamera(pivot, _b);
    this.r.camera.position.copy(_b);
    this.r.camera.lookAt(target);
  }

  /** third-person on-foot camera: smoothed pivot, shoulder offset, collision with fast pull-in / slow ease-out */
  private shoulderCamera(dt: number, pos: THREE.Vector3, now: number) {
    void now;
    const piv = _a.set(pos.x, pos.y + 1.58 + this.dip * 0.5, pos.z);
    if (!this.tpInit || this.tpPivot.distanceTo(piv) > 6) { this.tpPivot.copy(piv); this.tpInit = true; this.tpLen = 4; }
    this.tpPivot.x = damp(this.tpPivot.x, piv.x, 22, dt); this.tpPivot.z = damp(this.tpPivot.z, piv.z, 22, dt); this.tpPivot.y = damp(this.tpPivot.y, piv.y, 11, dt);
    const fwd = _b.set(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    const rx = Math.cos(this.yaw), rz = -Math.sin(this.yaw);
    // shoulder: blocked by a wall to the right → slide toward the centre
    let shoulder = 0.55 + 0.3 * this.aimK;
    const sh = raycastVoxels(this.r.chunks, this.tpPivot.x, this.tpPivot.y, this.tpPivot.z, rx, 0, rz, shoulder + 0.3);
    if (sh < shoulder + 0.3) shoulder = Math.max(0, sh - 0.3);
    this.tpShoulder = damp(this.tpShoulder, shoulder, shoulder < this.tpShoulder ? 30 : 6, dt);
    const target = _c.set(this.tpPivot.x + rx * this.tpShoulder, this.tpPivot.y, this.tpPivot.z + rz * this.tpShoulder);
    const dist = 4.0 - 1.35 * this.aimK + 0.45 * this.sprintK;
    const hit = raycastVoxels(this.r.chunks, target.x, target.y, target.z, -fwd.x, -fwd.y, -fwd.z, dist + 0.3);
    const allowed = Math.max(0.35, Math.min(dist, hit - 0.3));
    this.tpLen = allowed < this.tpLen ? allowed : damp(this.tpLen, allowed, 4, dt);
    this.r.camera.position.set(target.x - fwd.x * this.tpLen, target.y - fwd.y * this.tpLen, target.z - fwd.z * this.tpLen);
    this.r.camera.rotation.set(this.pitch + this.punch, this.yaw + this.punchYaw, this.punchRoll * 0.5, 'YXZ');
    this.camPos.copy(this.r.camera.position);
  }

  private updateMuzzle(fp: boolean, pos: THREE.Vector3, inVeh: boolean) {
    const c = this.r.camera;
    if (fp) {
      c.getWorldDirection(_a);
      _b.set(1, 0, 0).applyQuaternion(c.quaternion);
      this.muzzlePos.copy(c.position).addScaledVector(_a, 0.75).addScaledVector(_b, 0.16 * (1 - 0.9 * this.aimK)).addScaledVector(UP, -0.13 + 0.06 * this.aimK);
    } else {
      const yaw = inVeh ? this.yaw : this.charYaw;
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
      const up = inVeh ? 1.0 : 1.38 + Math.sin(this.pitch) * 0.5;
      this.muzzlePos.set(pos.x + fx * 0.75 + rx * 0.3, pos.y + up, pos.z + fz * 0.75 + rz * 0.3);
    }
  }

  private updateRecoil(dt: number, rec: ReturnType<typeof recoilFor>) {
    const since = (performance.now() - this.weapon.lastFire) / 1000;
    if (since > rec.delay) {
      const k = Math.min(1, rec.recover * dt);
      const rp = this.recoilP * k, ry = this.recoilY * k;
      this.pitch -= rp; this.recoilP -= rp;
      if (this.me?.veh) this.vehLook += ry; else this.yaw += ry;
      this.recoilY -= ry;
    }
    this.punch = damp(this.punch, 0, 16, dt);
    this.punchYaw = damp(this.punchYaw, 0, 16, dt);
    this.punchRoll = damp(this.punchRoll, 0, 12, dt);
  }

  private switchForDriveBy(s: ReturnType<typeof getState>) {
    const owned = (s.profile?.weapons ?? [{ id: 'stun', ammo: 999 }]).map((x) => x.id);
    const pick = ['smg', 'pistol', 'stun'].find((id) => owned.includes(id));
    if (pick && pick !== this.weapon.id) { net.send({ t: 'weapon', id: pick }); audio.sfx('ui_click', { volume: 0.5 }); }
  }

  /** crosshair spread, aim state, reload/low-ammo cues for the HUD layer */
  private feelHud(s: ReturnType<typeof getState>, w: (typeof WEAPONS)[string] | undefined, under: boolean, fp: boolean, inVeh: boolean, hs: number) {
    const f = liveFeel;
    const now = performance.now();
    const playing = s.screen === 'game' && !s.cutscene && !this.me?.down && !this.wheelOpen && !this.trans;
    f.show = playing && !!w && (!inVeh || this.driveBy);
    void fp;
    f.armed = !!w && !w.stun;
    f.stun = !!w?.stun;
    f.aiming = this.aimK;
    if (w) {
      const mul = spreadMul(this.aimHeld, Math.min(1, hs / 7.2), !this.local.onGround && !this.local.inWater, this.heat, inVeh);
      const rad = w.spread * mul;
      const h = this.r.renderer.domElement.clientHeight || window.innerHeight;
      const px = Math.tan(rad) / Math.tan((this.r.camera.fov * Math.PI) / 360) * (h / 2);
      f.spreadPx = damp(f.spreadPx, 3 + px * (w.pellets > 1 ? 1 : 1.6), 18, 1 / 60);
      const low = Math.max(1, Math.ceil(w.mag * 0.25));
      f.empty = !w.stun && this.weapon.mag === 0;
      f.lowAmmo = !w.stun && this.weapon.mag > 0 && this.weapon.mag <= low;
    }
    f.reload = now < this.weapon.reloadingUntil ? clamp(1 - (this.weapon.reloadingUntil - now) / (this.weapon.reloadDur * 1000), 0, 1) : -1;
    f.camYaw = this.yaw;
    f.underwater = under && !s.cutscene;
    f.driveBy = this.driveBy;
    emitFeelFrame();
  }

  private localView(firstPerson: boolean, pos?: THREE.Vector3, veh?: VehicleEnt | null, tp?: { yaw: number; anim: number } | null): LocalView {
    const p = pos ?? tmpV.set(this.local.x, this.local.y, this.local.z);
    const sp = Math.hypot(this.local.vx, this.local.vz);
    if (tp) {
      // mid enter/exit: drawn in the world (not parented to the seat) so the body can walk/slide
      return {
        id: this.myId, x: p.x, y: p.y, z: p.z, yaw: tp.yaw, pitch: 0, anim: tp.anim, veh: undefined, seat: undefined,
        outfit: getState().profile?.outfit ?? 0xff6f59, hair: getState().profile?.hair, firstPerson, weapon: this.weapon.id, aiming: false, firing: false,
      };
    }
    const anim = this.me?.down ? 6 : this.me?.veh ? 5 : this.local.inWater ? 3 : !this.local.onGround ? 4 : sp > 5.5 ? 2 : sp > 0.4 ? 1 : 0;
    const firing = performance.now() - this.weapon.firing < 90;
    return {
      id: this.myId, x: p.x, y: p.y, z: p.z, yaw: veh ? veh.yaw : this.charYaw, pitch: this.pitch, anim, veh: this.me?.veh, seat: this.me?.seat,
      outfit: getState().profile?.outfit ?? 0xff6f59, hair: getState().profile?.hair, firstPerson, weapon: this.weapon.id,
      aiming: this.me?.veh ? this.driveBy : this.aimK > 0.3 || performance.now() - this.weapon.lastFire < 700, firing,
    };
  }

  private collideCamera(target: THREE.Vector3, cam: THREE.Vector3) {
    const d = _f.copy(cam).sub(target);
    const len = d.length();
    if (len < 0.01) return;
    d.divideScalar(len);
    const hit = raycastVoxels(this.r.chunks, target.x, target.y, target.z, d.x, d.y, d.z, len);
    if (hit < len) cam.copy(target).addScaledVector(d, Math.max(0.3, hit - 0.3));
  }

  /** remote entity interpolation at (server now − delay) */
  private interpolate(): Ent[] {
    const rt = net.serverNow() - INTERP_DELAY;
    const out: Ent[] = [];
    for (const [id, buf] of this.buffers) {
      if (id === this.myId) continue;
      const last = buf[buf.length - 1].e;
      if (last.k === 'd' || last.k === 'o' || buf.length < 2) { out.push(last); continue; }
      let i = buf.length - 1;
      while (i > 0 && buf[i - 1].t > rt) i--;
      const a = buf[Math.max(0, i - 1)], b = buf[i];
      if (rt >= buf[buf.length - 1].t || a === b) { out.push(last); continue; }
      const t = Math.max(0, Math.min(1, (rt - a.t) / Math.max(1, b.t - a.t)));
      const ea = a.e as PlayerEnt, eb = b.e as PlayerEnt;
      if (Math.hypot(eb.x - ea.x, eb.z - ea.z) > 25) { out.push(b.e); continue; }
      let yaw = lerpAngle(ea.yaw, eb.yaw, t);
      // remote players face where they run unless they are shooting (server yaw = their camera)
      if (eb.k === 'p' && !eb.v && !eb.fa) {
        const vx = eb.x - ea.x, vz = eb.z - ea.z, dtS = Math.max(0.001, (b.t - a.t) / 1000);
        if (Math.hypot(vx, vz) / dtS > 0.8) yaw = Math.atan2(-vx, -vz);
      }
      out.push({ ...b.e, x: ea.x + (eb.x - ea.x) * t, y: ea.y + (eb.y - ea.y) * t, z: ea.z + (eb.z - ea.z) * t, yaw } as Ent);
    }
    return out;
  }

  // ───────────────────────────────────────────────────────── actions & interaction
  private nearestInteract(): { kind: 'obj' | 'door' | 'npc' | 'anchor' | 'veh'; id: string; label: string; key: string; hold?: number; dist: number } | null {
    if (!this.me || this.me.down || getState().cutscene) return null;
    const px = this.local.x, py = this.local.y, pz = this.local.z;
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    let best: ReturnType<ClientGame['nearestInteract']> = null;
    const consider = (kind: NonNullable<typeof best>['kind'], id: string, x: number, y: number, z: number, range: number, label: string, key: string, hold?: number) => {
      const dx = x - px, dz = z - pz, d = Math.hypot(dx, dz);
      if (d > range || Math.abs(y - py) > 2.5) return;
      const facing = d < 0.8 ? 1 : (dx * fx + dz * fz) / d;
      const score = d - facing * 0.8;
      if (!best || score < best.dist) best = { kind, id, label, key, hold, dist: score };
    };
    if (this.me.veh) return { kind: 'veh', id: this.me.veh, label: 'Exit vehicle', key: 'F', dist: 0 };
    for (const e of this.latest.values()) {
      if (e.k === 'o' && e.st === 0 && e.m !== 'target') consider('obj', e.id, e.x, e.y, e.z, INTERACT_RANGE, e.label ?? 'Use', 'E', e.hold);
      else if (e.k === 'd') { const cx = e.x + (e.axis === 'x' ? e.w / 2 : 0.5), cz = e.z + (e.axis === 'z' ? e.w / 2 : 0.5); consider('door', e.id, cx, e.y, cz, 2.6, e.open ? `Close: ${e.label}` : e.label ?? 'Door', 'E'); }
      else if (e.k === 'n' && /contact|mechanic|shopkeeper|waitress|officer|bouncer|receptionist/.test(e.r)) consider('npc', e.id, e.x, e.y, e.z, 2.8, `Talk to ${e.name ?? 'them'}`, 'E');
      else if (e.k === 'v' && !(e as VehicleEnt).occ.every(Boolean)) {
        const def = VEHICLES[e.m as keyof typeof VEHICLES];
        consider('veh', e.id, e.x, e.y, e.z, 2.2 + def.length / 2, `Enter ${e.label ?? def.name}`, 'F');
      }
    }
    for (const a of worldAnchors()) {
      if (a.kind !== 'interact') continue;
      if (a.poi === 'safehouse' && this.instanceKind !== 'interior') continue;
      consider('anchor', a.key, a.wx, a.wy, a.wz, INTERACT_RANGE, a.label ?? 'Use', 'E');
    }
    return best;
  }

  /** driver's seat when free, otherwise the free seat whose door is nearest */
  private seatFor(v: VehicleEnt): number | undefined {
    if (!v.occ[0]) return 0;
    const def = VEHICLES[v.m as keyof typeof VEHICLES];
    let best: number | undefined, bd = Infinity;
    for (let i = 1; i < v.occ.length; i++) {
      if (v.occ[i]) continue;
      const [sx] = seatOffset(def, i);
      this.doorPos(v, def, i, sx >= 0 ? 1 : -1, tmpV);
      const d = Math.hypot(tmpV.x - this.local.x, tmpV.z - this.local.z);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  /** Small "now playing" card when the station changes (not spoken, not ducking). */
  private radioToast(station: string) {
    const np = audio.radio.nowPlaying();
    setState({ radioCard: { station, title: np?.title ?? '', artist: np?.artist ?? '', at: Date.now() } });
    setTimeout(() => { const n2 = audio.radio.nowPlaying(); const c = getState().radioCard; if (c && c.station === station && n2 && n2.title !== c.title) setState({ radioCard: { ...c, title: n2.title, artist: n2.artist } }); }, 600);
  }

  private handleActions(s: ReturnType<typeof getState>) {
    if (s.screen !== 'game' || s.overlay || !this.me) return;
    const inp = this.input;
    if (s.cutscene) { return; }
    if (inp.tapped('camera')) { const st = getState().settings; void import('../state/actions').then((a) => a.updateSettings({ camera: st.camera === 'first' ? 'third' : 'first' })); }
    if (inp.tapped('heal')) net.send({ t: 'item.use', item: 'medkit' });
    if (inp.tapped('radio') && this.me.veh) this.radioToast(audio.radio.next());
    // horn: held = honking (others hear it via the vehicle's horn flag)
    const hornWant = !!this.me.veh && (this.me.seat ?? 0) === 0 && inp.held('horn');
    if (hornWant !== this.hornOn) { this.hornOn = hornWant; net.send({ t: 'veh.horn', on: hornWant }); }
    // interact (E) — supports hold
    const target = this.nearestInteract();
    if (inp.tapped('interact') && target && target.kind !== 'veh') {
      net.send({ t: 'interact', target: target.id });
      if (target.kind !== 'obj') audio.sfx('ui_click', { volume: 0.5 });
    }
    if (this.holding && (inp.releasedAction('interact') || !inp.held('interact'))) {
      if ((performance.now() - this.holding.start) / 1000 < this.holding.seconds - 0.05) net.send({ t: 'interact.stop' });
      this.holding = null;
    }
    // vehicles (F)
    if (inp.tapped('vehicle')) {
      if (this.me.veh) net.send({ t: 'veh.exit' });
      else {
        let id: string | null = target?.kind === 'veh' ? target.id : null;
        if (!id) {
          // nearest vehicle even if another prompt is closer
          let best: { id: string; d: number } | null = null;
          for (const e of this.latest.values()) if (e.k === 'v') { const d = Math.hypot(e.x - this.local.x, e.z - this.local.z); if (d < 5 && (!best || d < best.d)) best = { id: e.id, d }; }
          id = best?.id ?? null;
        }
        const v = id ? this.latest.get(id) as VehicleEnt | undefined : undefined;
        if (v) net.send({ t: 'veh.enter', vehicle: v.id, seat: this.seatFor(v) });
      }
    }
    // car radio: hold TAB for the station wheel (flick the mouse or scroll, release to tune); scroll alone also changes station
    if (this.me.veh && !s.cutscene) {
      const n = audio.radio.list().length + 1; // + Off
      if (inp.held('wheel')) {
        if (!this.wheelOpen) { this.wheelOpen = true; this.wheelVec = { x: 0, y: 0 }; inp.captureAll = true; setState({ wheel: { open: true, selected: String(audio.radio.index()), mode: 'radio' } }); audio.sfx('wheel_whoosh', { volume: 0.4 }); }
        this.wheelVec.x += inp.mouseDX; this.wheelVec.y += inp.mouseDY;
        const len = Math.hypot(this.wheelVec.x, this.wheelVec.y);
        if (len > 80) { this.wheelVec.x *= 80 / len; this.wheelVec.y *= 80 / len; }
        let sel = Number(getState().wheel.selected ?? audio.radio.index());
        if (inp.wheel) { sel = (((sel + Math.sign(inp.wheel)) % n) + n) % n; this.wheelVec = { x: 0, y: 0 }; }
        else if (len > 14) {
          const ang = Math.atan2(this.wheelVec.y, this.wheelVec.x) + Math.PI / 2;
          sel = ((Math.round(ang / ((Math.PI * 2) / n)) % n) + n) % n;
        }
        if (String(sel) !== getState().wheel.selected) { setState({ wheel: { open: true, selected: String(sel), mode: 'radio' } }); audio.sfx('ui_hover', { volume: 0.3 }); }
        return;
      }
      if (this.wheelOpen) {
        this.wheelOpen = false; inp.captureAll = false;
        const sel = Number(getState().wheel.selected);
        setState({ wheel: { open: false, selected: null } });
        if (Number.isFinite(sel) && sel !== audio.radio.index()) this.radioToast(audio.radio.select(sel));
        return;
      }
      if (inp.wheel) { this.radioToast(inp.wheel > 0 ? audio.radio.next() : audio.radio.prev()); }
    }
    // weapon wheel: hold TAB, flick toward a slot, release to equip
    const owned = (s.profile?.weapons ?? [{ id: 'stun', ammo: 999 }]).map((w) => w.id);
    if (inp.held('wheel') && !this.me.veh) {
      if (!this.wheelOpen) { this.wheelOpen = true; this.wheelVec = { x: 0, y: 0 }; inp.captureAll = true; setState({ wheel: { open: true, selected: null, mode: 'weapon' } }); audio.sfx('wheel_whoosh', { volume: 0.4 }); }
      this.wheelVec.x += inp.mouseDX; this.wheelVec.y += inp.mouseDY;
      const len = Math.hypot(this.wheelVec.x, this.wheelVec.y);
      if (len > 80) { this.wheelVec.x *= 80 / len; this.wheelVec.y *= 80 / len; }
      let sel: string | null = getState().wheel.selected;
      if (len > 14) {
        const n = WHEEL_SLOTS.length;
        const ang = Math.atan2(this.wheelVec.y, this.wheelVec.x) + Math.PI / 2;
        const i = ((Math.round(ang / ((Math.PI * 2) / n)) % n) + n) % n;
        sel = WHEEL_SLOTS[i];
      }
      if (sel !== getState().wheel.selected) { setState({ wheel: { open: true, selected: sel, mode: 'weapon' } }); audio.sfx('ui_hover', { volume: 0.35 }); }
      return;
    }
    if (this.wheelOpen) {
      this.wheelOpen = false; inp.captureAll = false;
      const sel = getState().wheel.selected;
      setState({ wheel: { open: false, selected: null } });
      if (sel === 'medkit') net.send({ t: 'item.use', item: 'medkit' });
      else if (sel && owned.includes(sel) && sel !== this.weapon.id) { net.send({ t: 'weapon', id: sel }); audio.sfx('ui_click', { volume: 0.6 }); }
      else if (sel && !owned.includes(sel)) setState({ dialogue: { speaker: '', text: `${WEAPONS[sel]?.name ?? sel}: buy it at Bullseye Arms`, until: Date.now() + 2200 } });
      return;
    }
    // weapons
    for (let i = 0; i < WEAPON_ORDER.length; i++) if (inp.tappedCode(`Digit${i + 1}`) && owned.includes(WEAPON_ORDER[i])) net.send({ t: 'weapon', id: WEAPON_ORDER[i] });
    if (!this.me.veh && (inp.tapped('weaponNext') || inp.wheel)) {
      const cur = owned.indexOf(this.weapon.id);
      const next = owned[(cur + (inp.wheel < 0 ? -1 : 1) + owned.length) % owned.length];
      if (next && next !== this.weapon.id) net.send({ t: 'weapon', id: next });
    }
    if (inp.tapped('reload')) net.send({ t: 'reload' });
    const w = WEAPONS[this.weapon.id];
    // in a vehicle you shoot only while aiming out of the window (drive-by)
    const canShoot = !this.trans && (!this.me.veh || this.driveBy);
    const wantFire = canShoot && (w?.auto ? inp.held('fire') : inp.tapped('fire'));
    if (wantFire && w && performance.now() > this.weapon.reloadingUntil && performance.now() - this.weapon.lastFire > 1000 / w.rate) {
      if (this.weapon.mag > 0) this.fireWeapon(s, w);
      else if (inp.tapped('fire')) { synth.dry(); if (this.weapon.reserve > 0) net.send({ t: 'reload' }); }
    }
    // ping (G): mark where the camera looks
    if (inp.tapped('ping')) {
      const dir = new THREE.Vector3(); this.r.camera.getWorldDirection(dir);
      const o = this.r.camera.position;
      const d = raycastVoxels(this.r.chunks, o.x, o.y, o.z, dir.x, dir.y, dir.z, 120);
      if (d < 120) net.send({ t: 'ping.mark', x: o.x + dir.x * d, y: o.y + dir.y * d, z: o.z + dir.z * d, kind: 'go' });
    }
  }

  private fireWeapon(s: ReturnType<typeof getState>, w: (typeof WEAPONS)[string]) {
    const now = performance.now();
    const reduce = s.settings.reduceShake;
    const fp = s.settings.camera === 'first';
    const consecutive = now - this.weapon.lastFire < (1000 / w.rate) * 2.2;
    this.shotIdx = consecutive ? this.shotIdx + 1 : 0;
    this.weapon.mag--; this.weapon.lastFire = now; this.weapon.firing = now;
    // aim direction: first person = the view; third person = from the gun's origin (your head on the
    // server) toward whatever the crosshair ray hits, so shots land under the crosshair
    let yaw = this.yaw, pitch = this.pitch;
    const vx = -Math.sin(yaw) * Math.cos(pitch), vy = Math.sin(pitch), vz = -Math.cos(yaw) * Math.cos(pitch);
    if (!fp) {
      const c = this.r.camera.position;
      const range = Math.min(140, w.range + 10);
      const d = Math.min(range, raycastVoxels(this.r.chunks, c.x, c.y, c.z, vx, vy, vz, range));
      const ax = c.x + vx * d, ay = c.y + vy * d, az = c.z + vz * d;
      const ox = this.me?.veh ? this.vRender.x : this.local.x, oz = this.me?.veh ? this.vRender.z : this.local.z;
      const oy = (this.me?.veh ? this.vRender.y : this.local.y) + EYE_HEIGHT;
      const dx = ax - ox, dy = ay - oy, dz = az - oz, l = Math.hypot(dx, dy, dz);
      if (l > 1.5) { yaw = Math.atan2(-dx, -dz); pitch = Math.asin(clamp(dy / l, -1, 1)); }
    }
    net.send({ t: 'fire', yaw, pitch: clamp(pitch, -1.55, 1.55), aim: this.aimHeld || undefined });
    audio.sfx(w.sfx, { volume: 0.9, rate: (w.kind === 'shotgun' ? 0.7 : w.kind === 'rifle' ? 0.9 : w.kind === 'smg' ? 1.12 : 1) * (0.97 + Math.random() * 0.06) });
    this.heat = Math.min(1.5, this.heat + heatAdd(w));
    // recoil: pattern kick (pays back over time) + visual punch
    const rec = recoilFor(w.id, w.kind);
    const pat = rec.pattern;
    const idx = this.shotIdx < pat.length ? this.shotIdx : pat.length - Math.min(6, pat.length) + ((this.shotIdx - pat.length) % Math.min(6, pat.length));
    const ads = 1 - 0.35 * this.aimK;
    const kp = rec.up * ads * (reduce ? 0.6 : 1) * (0.85 + Math.random() * 0.3);
    const ky = (pat[idx] * rec.side + (Math.random() - 0.5) * rec.side * 0.5) * ads;
    this.pitch = Math.min(1.5, this.pitch + kp); this.recoilP += kp;
    if (this.me?.veh) this.vehLook -= ky; else this.yaw -= ky;
    this.recoilY += ky;
    if (!reduce) {
      this.punch += rec.punch * (1 - 0.5 * this.aimK); this.punchYaw -= ky * 0.6;
      this.punchRoll += (Math.random() < 0.5 ? -1 : 1) * rec.roll;
      this.shake = Math.min(1, this.shake + rec.shake * 0.25);
    }
    // world flash light + shell casing
    this.fx.muzzle(this.muzzlePos.x, this.muzzlePos.y, this.muzzlePos.z, w.kind === 'shotgun' ? 1.4 : w.kind === 'rifle' ? 1.15 : 1, !!w.stun);
    if (!w.stun) {
      const c = this.r.camera;
      const yawS = fp || this.me?.veh ? this.yaw : this.charYaw;
      const rx = Math.cos(yawS), rz = -Math.sin(yawS), fx = -Math.sin(yawS), fz = -Math.cos(yawS);
      const ex = fp ? c.position.x + rx * 0.2 + fx * 0.45 : this.muzzlePos.x - fx * 0.45;
      const ey = fp ? c.position.y - 0.12 : this.muzzlePos.y + 0.05;
      const ez = fp ? c.position.z + rz * 0.2 + fz * 0.45 : this.muzzlePos.z - fz * 0.45;
      const delay = w.kind === 'shotgun' ? 0.32 : 0;
      if (delay) setTimeout(() => { this.fx.shell(ex, ey, ez, rx, rz, fx, fz, w.kind); }, delay * 1000);
      else this.fx.shell(ex, ey, ez, rx, rz, fx, fz, w.kind);
      if (!this.me?.veh) synth.shell(0.38 + delay + Math.random() * 0.1);
    }
    const low = Math.max(1, Math.ceil(w.mag * 0.25));
    if (!w.stun && this.weapon.mag > 0 && this.weapon.mag <= low) synth.lowAmmo();
    if (this.weapon.mag === 0 && this.weapon.reserve > 0) net.send({ t: 'reload' });
  }

  // ───────────────────────────────────────────────────────── cutscenes
  private cutsceneCamera(cs: NonNullable<ReturnType<typeof getState>['cutscene']>): THREE.Vector3 {
    const def = CUTSCENES[cs.id];
    if (!def) return new THREE.Vector3(this.local.x, this.local.y, this.local.z);
    const first = def.shots[0];
    if (cs.phase === 'waiting') {
      this.r.camera.position.set(...first.cam.from);
      this.r.camera.lookAt(...first.cam.lookFrom);
      const focus = new THREE.Vector3(...first.cam.lookFrom);
      if (this.csLoadedSent !== cs.id && (this.r.chunks.readiness(focus.x, focus.z, 3) > 0.9 || performance.now() - this.loadingSince > 6000)) {
        this.csLoadedSent = cs.id;
        net.send({ t: 'cs.loaded', cs: cs.id });
      }
      if (!this.csLoadedSent) this.loadingSince = this.loadingSince || performance.now();
      return focus;
    }
    let t = (net.serverNow() - cs.startAt) / 1000;
    if (t < 0) t = 0;
    let i = 0;
    while (i < def.shots.length - 1 && t > def.shots[i].dur) { t -= def.shots[i].dur; i++; }
    const shot = def.shots[i];
    const k = Math.min(1, t / shot.dur);
    const e = k * k * (3 - 2 * k);
    const from = new THREE.Vector3(...shot.cam.from), to = new THREE.Vector3(...shot.cam.to);
    const lf = new THREE.Vector3(...shot.cam.lookFrom), lt = new THREE.Vector3(...shot.cam.lookTo);
    this.r.camera.position.copy(from.lerp(to, e));
    const look = lf.lerp(lt, e);
    this.r.camera.lookAt(look);
    if (i !== this.lastDialogueShot) {
      this.lastDialogueShot = i;
      if (shot.sub) { setState({ dialogue: { speaker: shot.sub.speaker, text: shot.sub.text, until: Date.now() + shot.dur * 1000 } }); tts.say(shot.sub.speaker, shot.sub.text, 'dialogue'); }
      if (shot.sfx) audio.sfx(shot.sfx);
    }
    return look;
  }

  private cutsceneActors(id: string): Ent[] {
    const def = CUTSCENES[id];
    if (!def) return [];
    return def.actors.map((a) => ({ id: `cs:${a.id}`, k: 'n', r: a.role === 'contact' ? `contact:${a.id}` : a.role, x: a.pos[0], y: a.pos[1], z: a.pos[2], yaw: a.yaw, a: a.anim === 'walk' ? 1 : a.anim === 'sit' ? 5 : 0, sk: a.skin, name: a.name } as NpcEnt));
  }

  // ───────────────────────────────────────────────────────── audio
  private audioMenu(screen: string) {
    audio.setListener(this.r.camera.position.x, this.r.camera.position.y, this.r.camera.position.z, 0);
    audio.radio.setInVehicle(false);
    audio.stopLoopsExcept(new Set());
    audio.ambience({ city: 0.15, waves: 0.25, wetland: 0, wind: 0.1, club: 0, crowd: 0, traffic: 0, gulls: 0, birds: 0 });
    if (screen === 'login' || screen === 'menu' || screen === 'boot') { audio.playMusic('menu'); audio.setMusicScale(0.45); audio.background(false); }
    audio.duck(false);
  }

  private keepLoops = new Set<string>();
  private audioFrame(s: ReturnType<typeof getState>, remote: Ent[], localVeh: VehicleEnt | null, dt: number) {
    const c = this.r.camera;
    const e = _e.setFromQuaternion(c.quaternion, 'YXZ');
    audio.setListener(c.position.x, c.position.y, c.position.z, e.y);
    const keep = this.keepLoops; keep.clear();
    // your own car is rendered from local prediction and is not in `remote`: include it so its engine plays
    const vehList: Ent[] = localVeh && !remote.some((r) => r.id === localVeh.id) ? [...remote, localVeh as unknown as Ent] : remote;
    for (const ent of vehList) {
      if (ent.k !== 'v') continue;
      const d = Math.hypot(ent.x - c.position.x, ent.z - c.position.z);
      if (d > 70 || ent.hp <= 0) continue;
      const def = VEHICLES[ent.m as keyof typeof VEHICLES];
      const sp = Math.abs(ent.sp);
      const occupied = ent.occ.some(Boolean) || sp > 0.3 || ent.id === this.me?.veh;
      if (!occupied) continue;
      const mine = localVeh?.id === ent.id;
      const key = `eng:${ent.id}`;
      keep.add(key);
      if (mine && (this.me?.seat ?? 0) === 0) {
        // engine: simulated gears, rpm from speed within the gear + throttle load
        const f = Math.min(1, sp / def.maxSpeed);
        const th = Math.abs(this.lastVeh.th);
        let rpmT: number;
        if (def.boat) rpmT = 0.2 + th * 0.45 + f * 0.35;
        else {
          const bands = def.bike ? [0, 0.22, 0.45, 0.7, 1.01] : [0, 0.16, 0.34, 0.55, 0.78, 1.01];
          let g = 0; while (g < bands.length - 2 && f > bands[g + 1]) g++;
          if (g > this.prevGear && th > 0.3) audio.sfx('gear_shift', { volume: 0.3, rate: 0.95 + Math.random() * 0.1 });
          this.prevGear = g;
          const inGear = (f - bands[g]) / (bands[g + 1] - bands[g]);
          rpmT = sp < 0.5 ? 0.16 + th * 0.25 : 0.28 + inGear * 0.62 + th * 0.1;
        }
        this.rpm = damp(this.rpm, clamp(rpmT, 0.1, 1), rpmT < this.rpm ? 7 : 11, dt);
        audio.loop(key, def.engineSfx, { x: ent.x, y: ent.y + 0.5, z: ent.z, rate: 0.62 + this.rpm * 1.05, volume: 0.42 + th * 0.18 + f * 0.15 });
      } else audio.loop(key, def.engineSfx, { x: ent.x, y: ent.y + 0.5, z: ent.z, rate: 0.75 + (sp / def.maxSpeed) * 1.15, volume: (mine ? 0.55 : 0.3) * (0.4 + Math.min(1, sp / 10) * 0.6) });
      // tyre screech: hard cornering, handbrake slides, panic braking
      if (!def.boat) {
        let sc = clamp((Math.abs(ent.st) * sp - (def.bike ? 14 : 10)) / 10, 0, 1);
        if (mine && this.lastVeh.hb && sp > 6) sc = Math.max(sc, 0.85);
        if (mine && this.lastVeh.th < 0 && ent.sp > 12) sc = Math.max(sc, 0.55);
        if (mine) { this.screech = damp(this.screech, sc, sc > this.screech ? 14 : 6, dt); sc = this.screech; }
        if (sc > 0.04) { keep.add(`scr:${ent.id}`); audio.loop(`scr:${ent.id}`, 'tire_screech', { x: ent.x, y: ent.y + 0.2, z: ent.z, volume: sc * (mine ? 0.9 : 0.6), rate: 0.9 + sc * 0.2 }); }
      }
      if (ent.horn || (mine && this.hornOn)) { keep.add(`horn:${ent.id}`); audio.loop(`horn:${ent.id}`, 'horn', { x: ent.x, y: ent.y + 0.8, z: ent.z, volume: 0.85 }); }
      if (ent.siren) { keep.add(`siren:${ent.id}`); audio.loop(`siren:${ent.id}`, 'siren', { x: ent.x, y: ent.y + 1, z: ent.z, volume: 0.55 }); }
    }
    if (this.local.inWater && !this.me?.veh && Math.hypot(this.local.vx, this.local.vz) > 0.5) { keep.add('swim'); audio.loop('swim', 'swim', { volume: 0.35 }); }
    if (localVeh) {
      const sp = Math.abs(localVeh.sp ?? 0);
      if (sp > 14) { keep.add('windspeed'); audio.loop('windspeed', 'wind_speed', { volume: Math.min(0.55, (sp - 14) / 40), rate: 0.85 + Math.min(0.4, sp / 120) }); }
      if (this.lastVeh.th < -0.5 && sp > 16 && performance.now() - this.lastSpeedSfx > 2500) { this.lastSpeedSfx = performance.now(); audio.sfx('brake_squeal', { x: localVeh.x, y: localVeh.y, z: localVeh.z, volume: 0.45 }); }
    }
    const hpFrac = this.me ? this.me.hp / Math.max(1, this.me.maxHp) : 1;
    if (this.me && !this.me.down && hpFrac < 0.3) { keep.add('heartbeat'); audio.loop('heartbeat', 'heartbeat', { volume: 0.25 + (0.3 - hpFrac) * 1.4, rate: hpFrac < 0.15 ? 1.25 : 1 }); }
    if (this.wasUnder) { keep.add('underwater'); audio.loop('underwater', 'underwater', { volume: 0.5 }); }
    if (!s.cutscene && this.instanceKind !== 'interior') this.ambientOneShots();
    if (s.activity?.notes?.includes('ALARM TRIPPED')) { keep.add('alarm'); audio.loop('alarm', 'alarm', { volume: 0.3 }); }
    audio.stopLoopsExcept(keep);
    audio.radio.setInVehicle(!!this.me?.veh && !s.cutscene);
    // ambience by surroundings
    const x = this.local.x, z = this.local.z;
    // Palmara has terrain rasters; on Leonia (real city, no rasters on the client) the zone is urban and the coast distance is probed from the loaded blocks
    const leo = WORLD === 'leonia';
    const zone = leo ? 'urban' : raster.zoneAt(x, z);
    const coast = leo ? probeCoast(this.r.chunks, x, z) : raster.distAt(x, z);
    const interior = this.instanceKind === 'interior';
    const urban = zone === 'downtown' || zone === 'urban' ? 1 : zone === 'suburb' || zone === 'industrial' || zone === 'resort' ? 0.55 : 0.1;
    const nearClub = !leo && Math.hypot(x - 2568, z - 3192) < 26;
    const wx = this.r.wx;
    audio.weather(wx.rain, wx.wind, interior ? 1 : wx.shelter, interior);
    audio.ambience({
      city: interior ? 0.05 : urban * 0.6 * (1 - wx.rain * 0.4),
      waves: interior ? 0 : Math.max(0, 1 - Math.max(0, coast - 1) / 8) * 0.7,
      wetland: interior ? 0 : zone === 'wetland' ? 0.6 : 0,
      wind: interior ? 0 : Math.min(1, Math.min(1, Math.max(0, (this.local.y - 30) / 40)) * 0.6 + 0.08 + wx.wind * 0.55),
      club: nearClub ? 0.7 : 0,
      crowd: interior ? 0 : urban * 0.3 * (1 - wx.rain * 0.7),
      traffic: interior ? 0 : urban * 0.28,
      gulls: interior ? 0 : Math.max(0, 1 - Math.max(0, coast - 2) / 10) * 0.3,
      birds: interior ? 0 : (1 - urban) * 0.3 + 0.06 * (1 - wx.rain),
    });
    // music: cutscenes get their score; in a car the radio plays (mission music only when the radio is off);
    // on foot there is no constant music: mission/chase music is faint, otherwise only an occasional quiet track
    const inCar = !!this.me?.veh && !s.cutscene;
    const radioOn = inCar && audio.radio.index() < audio.radio.list().length;
    let track: string | null = null;
    if (s.cutscene) track = CUTSCENES[s.cutscene.id]?.music ?? 'cutscene';
    else if ((this.me?.wanted ?? 0) >= 2) track = 'chase';
    else if (s.activity && (s.activity.phase === 'playing' || s.activity.phase === 'starting')) track = ACTIVITY_BY_ID[s.activity.activity]?.music ?? null;
    if (track && track.startsWith('roam_')) track = null;
    if (radioOn && !s.cutscene) track = null;
    audio.playMusic(track);
    audio.setMusicScale(s.cutscene ? 0.75 : inCar ? 0.45 : 0.3);
    audio.background(!track && !inCar && !s.cutscene && !interior);
    this.activitySounds(s);
    audio.duck(!!s.dialogue && s.dialogue.until > Date.now());
  }

  // ───────────────────────────────────────────────────────── HUD feed (10 Hz)
  private updateHud(s: ReturnType<typeof getState>, localVeh: VehicleEnt | null, remote: Ent[]) {
    const me = this.me;
    if (!me) return;
    const target = this.nearestInteract();
    let prompt = target ? { key: target.key, label: target.label, hold: target.hold } as { key: string; label: string; hold?: number; progress?: number } : null;
    if (this.holding) prompt = { key: 'E', label: this.holding.label, hold: this.holding.seconds, progress: Math.min(1, (performance.now() - this.holding.start) / 1000 / this.holding.seconds) };
    if (me.veh && !this.trans) {
      const w = WEAPONS[this.weapon.id];
      if (!this.driveBy && w && !prompt?.hold) prompt = { key: 'F', label: Math.abs(localVeh?.sp ?? 0) < 1 ? `Exit vehicle · hold RMB to shoot${DRIVEBY_KINDS.has(w.kind) ? '' : ' (pistol/SMG)'}` : 'Exit vehicle' };
    }
    if (this.trans) prompt = null;
    const w = WEAPONS[this.weapon.id];
    const blips: Blip[] = [];
    const lookout = s.activity?.roster.find((r) => r.userId === s.user?.id)?.role === 'lookout';
    for (const e of remote) {
      if (e.k === 'p') blips.push({ id: e.id, x: e.x, z: e.z, kind: (e as PlayerEnt).party ? 'party' : 'player', label: (e as PlayerEnt).n, shape: 'triangle' });
      else if (e.k === 'v' && (e as VehicleEnt).mine) blips.push({ id: e.id, x: e.x, z: e.z, kind: 'mine', label: 'Your vehicle', shape: 'square' });
      else if (e.k === 'v' && (e as VehicleEnt).siren) blips.push({ id: e.id, x: e.x, z: e.z, kind: 'police', shape: 'circle' });
      else if (e.k === 'n' && (e as NpcEnt).r === 'guard' && (lookout || Math.hypot(e.x - this.local.x, e.z - this.local.z) < 25)) blips.push({ id: e.id, x: e.x, z: e.z, kind: 'guard', shape: 'diamond' });
      else if (e.k === 'n' && (e as NpcEnt).r === 'cop') blips.push({ id: e.id, x: e.x, z: e.z, kind: 'police', shape: 'circle' });
    }
    for (const p of this.pings) blips.push({ id: `ping:${p.at}`, x: p.x, z: p.z, kind: 'ping', label: p.from, shape: 'diamond' });
    const wp = getWaypoint();
    void wp;
    setState({
      hud: {
        hp: me.hp, maxHp: me.maxHp, wanted: me.wanted, wantedSeen: me.wantedSeen,
        inVehicle: !!me.veh, speedKmh: localVeh ? Math.abs(localVeh.sp) * 3.6 : 0, vehicleHp: localVeh?.hp ?? 100, vehicleModel: localVeh?.m ?? null, seat: me.seat ?? 0,
        down: me.down ?? null, interior: me.interior ?? null,
        x: livePose.x, y: livePose.y, z: livePose.z, yaw: this.yaw,
        searchArea: me.search ?? null,
        interactPrompt: prompt,
        ammo: w ? { weapon: w.name, mag: this.weapon.mag, reserve: w.stun ? -1 : this.weapon.reserve } : null,
      },
      blips,
      entities: remote.filter((e) => e.k === 'p'),
    });
  }
}

void ({} as ObjEnt | DoorEnt);
void _q; void _col;

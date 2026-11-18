/**
 * A simulated copy of the world. Kinds:
 *  - world:    shared free roam (up to 16 players), traffic, pedestrians, police
 *  - activity: private mission/heist/mini-game instance for one crew
 *  - interior: private safehouse interior for the owner + party
 *
 * Fixed-step simulation (TICK_RATE). Players are input-driven: each processed input
 * advances that player's physics exactly one step, so client prediction matches.
 */
import {
  DT, INTEREST_RADIUS, INTERACT_RANGE, VEHICLE_ENTER_RANGE, VEHICLES, MAX_PLAYERS_PER_INSTANCE,
  stepPlayer, stepVehicle, seatOffset, worldAnchors, raycastVoxels, WEAPONS, plazaSpawn, policeSpawn,
  type AABB, type Ent, type Snapshot, type VehicleModel, type SelfState,
} from '@blockshore/shared';
import { voxels } from './voxels.ts';
import { WeatherClock } from './weather.ts';
import { trafficTick, pedTick, wildlifeTick, spawnStaticNpcs, scarePeds, isAnimal } from './npc.ts';
import { barkTick, barkEvent } from './barks.ts';
import { policeTick, wantedEscaped, searchRadius, type WantedOwner } from './police.ts';
import { round2, type DoorEnt, type NpcEnt, type ObjEnt, type PlayerEnt, type VehicleEnt, type InputMsg, type Wanted } from './entities.ts';
import type { Game } from '../game.ts';
import type { ActivityRun } from '../activities/runner.ts';

export type InstanceKind = 'world' | 'activity' | 'interior';

/** per world (pois.ts): Leonia = Bayfront Plaza on Biscayne Blvd / Leonia PD on NW 3rd Ave */
const PLAZA_SPAWN = plazaSpawn();
const POLICE_SPAWN = policeSpawn();

export class Instance {
  readonly players = new Map<string, PlayerEnt>();
  readonly vehicles = new Map<string, VehicleEnt>();
  readonly npcs = new Map<string, NpcEnt>();
  readonly objects = new Map<string, ObjEnt>();
  readonly doors = new Map<string, DoorEnt>();
  run: ActivityRun | null = null;
  ownerId: string | null = null;
  /** free-roam lobby settings (kind 'world') */
  access: 'public' | 'friends' | 'invite' = 'public';
  hostId: string | null = null;
  hostName = '';
  code = '';
  custom = false;
  tickNo = 0;
  now = Date.now();
  emptySince = Date.now();
  readonly createdAt = Date.now();
  private seq = 0;
  private colliderCache: AABB[] = [];
  private colliderTick = -1;
  closed = false;
  /** shared weather for everyone in this instance */
  readonly weather: WeatherClock;

  readonly capacity: number;
  constructor(readonly game: Game, readonly id: string, readonly kind: InstanceKind, public label: string, capacity = MAX_PLAYERS_PER_INSTANCE, weatherFrom: WeatherClock | null = null) {
    // hard cap: a lobby can never exceed MAX_PLAYERS_PER_INSTANCE
    this.capacity = Math.max(1, Math.min(MAX_PLAYERS_PER_INSTANCE, capacity));
    this.weather = new WeatherClock(id, weatherFrom);
    for (const a of worldAnchors()) {
      if (a.kind !== 'door') continue;
      const locked = a.rule === 'locked' || a.rule?.startsWith('portal:') === true;
      this.doors.set(`d:${a.key}`, { id: `d:${a.key}`, key: a.key, x: a.wx, y: a.wy, z: a.wz, axis: a.axis ?? 'x', w: a.width ?? 1, open: false, locked, rule: a.rule ?? '', label: a.label ?? 'Door', closeAt: 0 });
    }
    spawnStaticNpcs(this);
  }

  nextId(prefix: string) { return `${prefix}:${this.id.slice(0, 4)}${(++this.seq).toString(36)}`; }
  activePlayers() { return [...this.players.values()].filter((p) => !p.linkdeadAt); }
  connectedCount() { return this.activePlayers().length; }
  /** players + reserved (link-dead) slots */
  occupancy() { return this.players.size; }
  hasRoom(n = 1) { return this.players.size + n <= this.capacity; }

  // ───────────────────────────────────────────────────────── players
  addPlayer(info: { userId: string; name: string; partyId: string | null; outfit: number; hair?: number }, pos: { x: number; y: number; z: number }, yaw: number): PlayerEnt {
    const p: PlayerEnt = {
      id: `p:${info.userId}`, userId: info.userId, name: info.name, partyId: info.partyId,
      phys: { x: pos.x, y: pos.y, z: pos.z, vx: 0, vy: 0, vz: 0, onGround: false, inWater: false },
      yaw, pitch: 0, hp: 100, maxHp: 100, outfit: info.outfit, hair: info.hair ?? 0, inputs: [], lastSeq: -1, lastInput: null,
      veh: null, seat: 0, holding: null, downUntil: 0, busted: false, wanted: null, role: 'none', linkdeadAt: 0,
      fireCooldown: 0, sent: new Map(), cutsceneFocus: null, frozen: false, lastSafePos: { ...pos }, pings: [], invulnUntil: Date.now() + 3000,
      personalVehicle: null, inputCredit: 1, weapon: 'stun', ammo: { stun: { mag: 6, reserve: 999 } }, reloadUntil: 0, ammoDirty: false,
    };
    this.players.set(info.userId, p);
    this.emptySince = 0;
    return p;
  }

  removePlayer(userId: string) {
    const p = this.players.get(userId);
    if (!p) return;
    if (p.veh) this.exitVehicle(p, true);
    // personal vehicle goes back to storage when its owner leaves
    for (const v of [...this.vehicles.values()]) if (v.owner?.userId === userId) this.game.storeVehicleFromWorld(v, this);
    this.players.delete(userId);
    for (const o of this.players.values()) o.sent.delete(p.id);
    if (this.players.size === 0) this.emptySince = Date.now();
  }

  teleport(p: PlayerEnt, x: number, y: number, z: number, yaw?: number) {
    if (p.veh) this.exitVehicle(p, true);
    p.phys.x = x; p.phys.y = y; p.phys.z = z; p.phys.vx = p.phys.vy = p.phys.vz = 0;
    if (yaw !== undefined) p.yaw = yaw;
    p.inputs.length = 0;
    p.lastSafePos = { x, y, z };
    this.game.sendCorrection(p, this);
  }

  // ───────────────────────────────────────────────────────── vehicles
  spawnVehicle(model: VehicleModel, x: number, y: number, z: number, yaw: number, o: { color?: number; owner?: VehicleEnt['owner']; activityKey?: string; allowed?: Set<string> | null; label?: string; ghost?: boolean; hp?: number } = {}): VehicleEnt {
    const def = VEHICLES[model];
    const id = this.nextId('v');
    const v: VehicleEnt = {
      id, model, def, phys: { x, y, z, yaw, speed: 0, vy: 0, steer: 0, onGround: true, impact: 0, drowned: false },
      hp: o.hp ?? def.health, color: o.color ?? 0xffffff, occ: new Array(def.seats).fill(null), owner: o.owner ?? null, ai: null,
      ghost: o.ghost ?? false, activityKey: o.activityKey ?? null, allowed: o.allowed ?? null, label: o.label ?? null,
      destroyedAt: 0, siren: false, horn: false, input: { th: 0, st: 0, hb: true }, lastHitAt: 0, idleSince: this.now,
    };
    this.vehicles.set(id, v);
    return v;
  }

  removeVehicle(id: string) {
    const v = this.vehicles.get(id);
    if (!v) return;
    for (const uid of v.occ) if (uid) { const p = this.players.get(uid); if (p) this.exitVehicle(p, true); }
    this.vehicles.delete(id);
    // keep p.sent: the next snapshot reports the id in `gone` so clients drop the car (deleting here left ghosts)
  }

  enterVehicle(p: PlayerEnt, vehId: string, seat?: number): string | null {
    const v = this.vehicles.get(vehId);
    if (!v || v.destroyedAt) return 'That vehicle is not available.';
    if (p.downUntil || p.frozen) return 'You can\'t do that right now.';
    const d = Math.hypot(v.phys.x - p.phys.x, v.phys.z - p.phys.z);
    if (!p.veh && d > VEHICLE_ENTER_RANGE + v.def.length / 2) return 'Too far from the vehicle.';
    if (p.veh && p.veh !== vehId) return 'Get out first.';
    if (v.allowed && !v.allowed.has(p.userId)) return v.owner ? 'This vehicle belongs to another player.' : 'This vehicle is reserved for the crew.';
    if (v.ai?.kind === 'police' && v.occ.every((o) => !o)) return 'Police vehicles are locked.';
    let s = seat;
    if (s !== undefined && (s < 0 || s >= v.occ.length || (v.occ[s] && v.occ[s] !== p.userId))) s = undefined;
    if (s === undefined) s = v.occ.findIndex((o) => !o);
    if (s < 0) return 'Vehicle is full.';
    // hijacking traffic: the NPC driver bails out and someone may call it in
    if (v.ai?.kind === 'traffic') {
      v.ai = null;
      const w = scarePeds(this, v.phys.x, v.phys.z, 25);
      barkEvent(this, 'carjack', v.phys.x, v.phys.z, { vehicle: v });
      if (this.kind === 'world' && w > 0) this.addWanted(p, 1, 'Vehicle theft');
    }
    if (p.veh) { const old = this.vehicles.get(p.veh); if (old) old.occ[p.seat] = null; }
    v.occ[s] = p.userId;
    p.veh = v.id; p.seat = s; p.holding = null;
    p.phys.vx = p.phys.vy = p.phys.vz = 0;
    if (s === 0) v.input = { th: 0, st: 0, hb: false };
    this.game.sfx(this, 'car_door', v.phys.x, v.phys.y, v.phys.z);
    return null;
  }

  exitVehicle(p: PlayerEnt, force = false) {
    const v = p.veh ? this.vehicles.get(p.veh) : null;
    p.veh = null;
    if (!v) return;
    if (v.occ[p.seat] === p.userId) v.occ[p.seat] = null;
    if (p.seat === 0) v.input = { th: 0, st: 0, hb: true };
    // place beside the seat, on the side of the door, at a free spot
    const [sx] = seatOffset(v.def, p.seat);
    const side = sx >= 0 ? 1 : -1;
    const rx = Math.cos(v.phys.yaw), rz = -Math.sin(v.phys.yaw);
    const candidates = [side * (v.def.width / 2 + 0.7), -side * (v.def.width / 2 + 0.7)];
    let placed = false;
    for (const off of candidates) {
      const x = v.phys.x + rx * off, z = v.phys.z + rz * off;
      const y = voxels.groundY(x, z, v.phys.y + 2);
      if (Math.abs(y - v.phys.y) < 2.5) { p.phys.x = x; p.phys.z = z; p.phys.y = y; placed = true; break; }
    }
    if (!placed) { p.phys.x = v.phys.x; p.phys.z = v.phys.z; p.phys.y = v.phys.y + v.def.height + 0.2; }
    p.phys.vx = p.phys.vy = p.phys.vz = 0;
    if (!force) this.game.sfx(this, 'car_door', v.phys.x, v.phys.y, v.phys.z);
    this.game.sendCorrection(p, this);
  }

  // ───────────────────────────────────────────────────────── damage / crime
  damagePlayer(p: PlayerEnt, amount: number, cause: 'police' | 'traffic' | 'fall' | 'vehicle' | 'drown' | 'dev') {
    if (p.downUntil || p.linkdeadAt || this.now < p.invulnUntil || p.frozen) return;
    p.hp -= amount;
    if (p.hp > 0) return;
    p.hp = 0;
    p.downUntil = this.now + (this.run ? 6000 : 7000);
    p.busted = cause === 'police';
    p.holding = null;
    if (p.veh) this.exitVehicle(p, true);
    this.game.notify(p.userId, p.busted ? 'BUSTED — the police got you.' : 'KNOCKED OUT', 'bad', 'mission_fail');
    this.run?.onPlayerDown(p);
  }

  damageVehicle(v: VehicleEnt, amount: number, by: PlayerEnt | null) {
    if (v.destroyedAt) return;
    v.hp -= amount;
    if (v.hp <= 0) {
      v.hp = 0;
      v.destroyedAt = this.now;
      v.phys.speed = 0;
      for (const uid of v.occ) if (uid) { const p = this.players.get(uid); if (p) { this.exitVehicle(p, true); this.damagePlayer(p, 30, 'vehicle'); } }
      this.game.sfx(this, 'crash', v.phys.x, v.phys.y, v.phys.z, 1);
      if (by && this.kind === 'world' && v.ai) this.addWanted(by, 1, 'Vehicle destroyed');
      this.run?.onVehicleDestroyed(v);
    }
  }

  wantedOf(p: PlayerEnt): Wanted | null {
    if (this.run) return this.run.wanted;
    return p.wanted;
  }

  /** Free roam: the offender alone is wanted. In an activity the whole crew shares it. */
  addWanted(p: PlayerEnt, level: number, reason: string) {
    if (this.kind === 'interior') return;
    barkEvent(this, 'wanted', p.phys.x, p.phys.z);
    if (this.run) { this.run.raiseWanted(level, { x: p.phys.x, z: p.phys.z }, reason); return; }
    const w = p.wanted;
    if (!w) {
      p.wanted = { level, lastKnown: { x: p.phys.x, z: p.phys.z }, lastSeenAt: this.now, since: this.now };
      this.game.notify(p.userId, `Wanted: ${reason}`, 'bad', 'siren');
    } else if (level > w.level) {
      w.level = Math.min(3, level);
      w.lastKnown = { x: p.phys.x, z: p.phys.z }; w.lastSeenAt = this.now;
    }
  }

  private wantedOwners(): WantedOwner[] {
    const out: WantedOwner[] = [];
    if (this.run?.wanted) out.push({ key: `run:${this.run.id}`, wanted: this.run.wanted, targets: this.run.participantEnts() });
    if (!this.run) for (const p of this.players.values()) if (p.wanted && !p.linkdeadAt) out.push({ key: p.userId, wanted: p.wanted, targets: [p] });
    return out;
  }

  // ───────────────────────────────────────────────────────── doors
  doorColliders(): AABB[] {
    if (this.colliderTick === this.tickNo) return this.colliderCache;
    this.colliderTick = this.tickNo;
    const out: AABB[] = [];
    for (const d of this.doors.values()) {
      if (d.open) continue;
      const h = d.w >= 6 ? 5 : 2;
      if (d.axis === 'x') out.push({ minX: d.x, maxX: d.x + d.w, minY: d.y, maxY: d.y + h, minZ: d.z, maxZ: d.z + 1 });
      else out.push({ minX: d.x, maxX: d.x + 1, minY: d.y, maxY: d.y + h, minZ: d.z, maxZ: d.z + d.w });
    }
    return (this.colliderCache = out);
  }

  setDoor(key: string, state: 'open' | 'closed' | 'locked') {
    const d = this.doors.get(`d:${key}`);
    if (!d) return;
    d.open = state === 'open';
    d.locked = state === 'locked';
    d.closeAt = 0;
    this.colliderTick = -1;
  }

  // ───────────────────────────────────────────────────────── tick
  tick() {
    this.now = Date.now();
    this.tickNo++;
    const wx = this.weather.poll(this.now);
    if (wx) for (const p of this.players.values()) if (!p.linkdeadAt) this.game.send(p.userId, wx);
    const dt = DT;
    const colliders = this.doorColliders();

    // players: consume queued inputs
    for (const p of this.players.values()) {
      if (p.linkdeadAt) { p.inputs.length = 0; continue; }
      // token bucket: +1 input per tick, burst of 3 → catching up after jitter is fine, sustained speed-up is impossible
      p.inputCredit = Math.min(3, p.inputCredit + 1);
      while (p.inputs.length && p.inputCredit >= 1) {
        const inp = p.inputs.shift()!;
        p.inputCredit--;
        this.applyInput(p, inp, colliders);
      }
      if (p.phys.y < 2) { const s = p.lastSafePos; this.teleport(p, s.x, s.y + 1, s.z); }
    }

    // vehicles without a human driver
    for (const v of this.vehicles.values()) {
      if (v.destroyedAt) { if (this.now - v.destroyedAt > 30_000 && !v.activityKey) this.removeVehicle(v.id); continue; }
      if (v.occ[0]) continue;
      if (v.ai?.kind === 'traffic' || v.ai?.kind === 'police') continue; // driven by their systems
      if (Math.abs(v.phys.speed) < 0.01 && v.phys.onGround) continue;
      stepVehicle(v.phys, { th: 0, st: 0, hb: true }, dt, voxels, v.def, colliders);
    }

    // occupants ride along with their vehicle (independent of whether they sent input)
    for (const p of this.players.values()) {
      if (!p.veh) continue;
      const v = this.vehicles.get(p.veh);
      if (!v) { p.veh = null; continue; }
      const [sx, sy, sz] = seatOffset(v.def, p.seat);
      const rx = Math.cos(v.phys.yaw), rz = -Math.sin(v.phys.yaw), fx = -Math.sin(v.phys.yaw), fz = -Math.cos(v.phys.yaw);
      p.phys.x = v.phys.x + rx * sx + fx * sz; p.phys.y = v.phys.y + sy; p.phys.z = v.phys.z + rz * sx + fz * sz;
      p.phys.vx = p.phys.vy = p.phys.vz = 0;
    }

    // NPC systems
    if (this.kind === 'world') {
      const cn = this.connectedCount();
      trafficTick(this, dt, Math.min(60, 18 + cn * 8));
      pedTick(this, dt, Math.min(130, 45 + cn * 16));
      wildlifeTick(this, dt, Math.min(15, 6 + cn * 3));
    } else if (this.kind === 'activity' && this.run?.allowsTraffic()) {
      trafficTick(this, dt, 8);
      pedTick(this, dt, 10);
    }
    barkTick(this);

    // police + wanted
    const owners = this.wantedOwners();
    if (owners.length || [...this.vehicles.values()].some((v) => v.ai?.kind === 'police')) {
      policeTick(this, dt, owners, this.run?.hasEquipment('jammer') ?? false);
    }
    for (const o of owners) {
      if (wantedEscaped(o.wanted, o.targets, this.now)) {
        if (this.run) this.run.clearWanted();
        else { const p = this.players.get(o.key); if (p) { p.wanted = null; this.game.notify(p.userId, 'You lost the police.', 'good', 'notify'); } }
      }
    }

    this.dynamicCollisions();
    this.updateHolds();

    // down / respawn
    for (const p of this.players.values()) {
      if (!p.downUntil || this.now < p.downUntil) continue;
      p.downUntil = 0;
      p.hp = p.maxHp;
      p.invulnUntil = this.now + 3000;
      let spot = (!this.run && !p.busted ? this.game.spawnSpotFor(p.userId) : null) ?? PLAZA_SPAWN;
      if (this.run) { const r = this.run.respawnPos(p); spot = { x: r[0], y: r[1], z: r[2] }; }
      else if (p.busted) { spot = POLICE_SPAWN; void this.game.bustedFine(p); }
      if (!this.run || p.busted) p.wanted = null;
      p.busted = false;
      this.teleport(p, spot.x, spot.y, spot.z);
    }

    // doors auto-close
    for (const d of this.doors.values()) if (d.open && d.closeAt && this.now > d.closeAt) {
      const blocked = [...this.players.values()].some((p) => Math.abs(p.phys.x - (d.x + (d.axis === 'x' ? d.w / 2 : 0.5))) < d.w / 2 + 0.8 && Math.abs(p.phys.z - (d.z + (d.axis === 'z' ? d.w / 2 : 0.5))) < 1.3);
      if (!blocked) { d.open = false; d.closeAt = 0; this.colliderTick = -1; }
    }

    this.run?.tick(dt);

    // snapshots (every tick)
    for (const p of this.players.values()) if (!p.linkdeadAt) this.game.send(p.userId, this.snapshot(p));
  }

  private applyInput(p: PlayerEnt, inp: InputMsg, colliders: AABB[]) {
    p.lastSeq = inp.seq;
    p.lastInput = inp;
    p.yaw = inp.yaw; p.pitch = inp.pitch;
    if (p.downUntil || p.frozen) return;
    if (p.veh) {
      const v = this.vehicles.get(p.veh);
      if (!v) { p.veh = null; return; }
      if (p.seat === 0 && !v.destroyedAt) {
        v.input = { th: inp.th, st: inp.st, hb: inp.hb };
        stepVehicle(v.phys, v.input, DT, voxels, v.def, colliders);
        if (v.phys.impact > 7) {
          this.damageVehicle(v, (v.phys.impact - 7) * 9, p);
          this.game.sfx(this, 'crash', v.phys.x, v.phys.y, v.phys.z, Math.min(1, v.phys.impact / 25));
          if (v.def.bike && v.phys.impact > 14) { this.exitVehicle(p, true); this.damagePlayer(p, 20, 'vehicle'); }
        }
        if (v.phys.drowned && !v.def.boat) { this.damageVehicle(v, 400 * DT, null); }
        v.idleSince = this.now;
      }
      return;
    }
    const wasAir = !p.phys.onGround, vy = p.phys.vy;
    stepPlayer(p.phys, { mx: inp.mx, mz: inp.mz, yaw: inp.yaw, jump: inp.jump, sprint: inp.sprint }, DT, voxels, colliders);
    if (wasAir && p.phys.onGround && vy < -17) this.damagePlayer(p, (-vy - 17) * 6, 'fall');
    if (p.phys.onGround && !p.phys.inWater) p.lastSafePos = { x: p.phys.x, y: p.phys.y, z: p.phys.z };
  }

  private dynamicCollisions() {
    const vs = [...this.vehicles.values()].filter((v) => !v.destroyedAt);
    const circles = (v: VehicleEnt) => {
      const fx = -Math.sin(v.phys.yaw), fz = -Math.cos(v.phys.yaw), q = v.def.length / 4, r = v.def.width / 2 + 0.05;
      return [{ x: v.phys.x + fx * q, z: v.phys.z + fz * q, r }, { x: v.phys.x - fx * q, z: v.phys.z - fz * q, r }];
    };
    const cache = new Map(vs.map((v) => [v.id, circles(v)]));
    // vehicle ↔ vehicle
    for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) {
      const a = vs[i], b = vs[j];
      if (a.ghost && b.ghost) continue;
      if (Math.abs(a.phys.x - b.phys.x) > 8 || Math.abs(a.phys.z - b.phys.z) > 8 || Math.abs(a.phys.y - b.phys.y) > 2) continue;
      for (const ca of cache.get(a.id)!) for (const cb of cache.get(b.id)!) {
        const dx = cb.x - ca.x, dz = cb.z - ca.z, d = Math.hypot(dx, dz), min = ca.r + cb.r;
        if (d >= min || d < 1e-4) continue;
        const push = (min - d) / 2, nx = dx / d, nz = dz / d;
        a.phys.x -= nx * push; a.phys.z -= nz * push; b.phys.x += nx * push; b.phys.z += nz * push;
        const rel = Math.abs(a.phys.speed - b.phys.speed * Math.cos(a.phys.yaw - b.phys.yaw));
        if (rel > 8 && this.now - a.lastHitAt > 500) {
          a.lastHitAt = b.lastHitAt = this.now;
          const dmg = (rel - 8) * 6;
          const driverA = a.occ[0] ? this.players.get(a.occ[0]!) ?? null : null;
          const driverB = b.occ[0] ? this.players.get(b.occ[0]!) ?? null : null;
          this.damageVehicle(a, dmg, driverB); this.damageVehicle(b, dmg, driverA);
          this.game.sfx(this, 'crash', (a.phys.x + b.phys.x) / 2, a.phys.y, (a.phys.z + b.phys.z) / 2, Math.min(1, rel / 25));
          barkEvent(this, 'crash', (a.phys.x + b.phys.x) / 2, (a.phys.z + b.phys.z) / 2, { vehicles: [a, b] });
          if (b.ai?.kind === 'traffic') b.ai.waitUntil = this.now + 3000;
          if (a.ai?.kind === 'traffic') a.ai.waitUntil = this.now + 3000;
          if (b.ai?.kind === 'police' && driverA && this.kind === 'world') this.addWanted(driverA, 2, 'Rammed a police car');
          if (a.ai?.kind === 'police' && driverB && this.kind === 'world') this.addWanted(driverB, 2, 'Rammed a police car');
        }
        a.phys.speed *= 0.7; b.phys.speed *= 0.7;
      }
    }
    // vehicle ↔ walking player / npc
    for (const v of vs) {
      const cs = cache.get(v.id)!;
      const spd = Math.abs(v.phys.speed);
      const driver = v.occ[0] ? this.players.get(v.occ[0]!) ?? null : null;
      for (const p of this.players.values()) {
        if (p.veh || p.linkdeadAt || Math.abs(p.phys.y - v.phys.y) > 2) continue;
        for (const c of cs) {
          const dx = p.phys.x - c.x, dz = p.phys.z - c.z, d = Math.hypot(dx, dz), min = c.r + 0.35;
          if (d >= min || d < 1e-4) continue;
          p.phys.x += (dx / d) * (min - d); p.phys.z += (dz / d) * (min - d);
          // friendly fire off: player-driven vehicles push but never hurt players
          if (!driver && spd > 4 && v.ai) this.damagePlayer(p, spd * 3, 'traffic');
          if (spd > 2) this.game.sendCorrection(p, this);
        }
      }
      if (spd < 3) continue;
      for (const n of this.npcs.values()) {
        if (n.role === 'static' || n.downUntil > this.now) continue;
        for (const c of cs) {
          if ((n.x - c.x) ** 2 + (n.z - c.z) ** 2 > (c.r + 0.4) ** 2) continue;
          n.downUntil = this.now + 5000;
          n.brain.fleeUntil = this.now + 9000;
          if (driver && this.kind === 'world' && !isAnimal(n)) { // animals are never crimes
            const witnesses = scarePeds(this, n.x, n.z, 30);
            barkEvent(this, 'hit', n.x, n.z, { npc: n });
            if (witnesses > 1 || n.role === 'cop') this.addWanted(driver, n.role === 'cop' ? 2 : 1, 'Hit a pedestrian');
          }
          if (driver && n.role === 'guard' && this.run) this.run.onGuardHit(n);
        }
      }
    }
  }

  private updateHolds() {
    for (const p of this.players.values()) {
      const h = p.holding;
      if (!h) continue;
      const o = this.objects.get(h.target);
      if (!o || o.state !== 0 || p.veh || p.downUntil || p.linkdeadAt) { p.holding = null; continue; }
      if (Math.hypot(o.x - p.phys.x, o.z - p.phys.z) > INTERACT_RANGE + 0.6 || Math.abs(o.y - p.phys.y) > 2.5) {
        p.holding = null; o.progress = 0;
        this.game.notify(p.userId, 'Interrupted — stay close and keep holding E.', 'info');
        continue;
      }
      const prog = (this.now - h.started) / (h.required * 1000);
      o.progress = Math.min(1, prog);
      if (prog >= 1) {
        p.holding = null;
        o.state = 1; o.doneBy = p.userId; o.doneAt = this.now; o.progress = 1;
        this.run?.onObjectDone(o, p);
      }
    }
  }

  // ───────────────────────────────────────────────────────── weapons
  /**
   * Hitscan fire with the equipped weapon. Server checks rate, magazine and line of
   * sight. Damage applies to NPCs, mission targets and NPC vehicles only — never to
   * other players (no PvP in free roam).
   */
  fire(p: PlayerEnt, yaw: number, pitch: number, aim = false) {
    const w = WEAPONS[p.weapon] ?? WEAPONS.stun;
    if (p.downUntil || p.frozen || this.now < p.fireCooldown || this.now < p.reloadUntil) return;
    if (p.veh && w.kind !== 'pistol' && w.kind !== 'smg' && w.kind !== 'stun') return;
    const a = p.ammo[w.id];
    if (!a || a.mag <= 0) { this.game.sfx(this, 'ui_click', p.phys.x, p.phys.y + 1, p.phys.z, 0.4, p.userId); return; }
    p.fireCooldown = this.now + 1000 / w.rate - 5;
    a.mag--; p.ammoDirty = true;
    // spread: tighter when aiming down sights, wider while moving / airborne / after rapid fire.
    // Mirrored for display by the client crosshair (apps/client/src/game/feel.ts spreadMul).
    const fs = fireState.get(p) ?? { heat: 0, at: 0 };
    fs.heat = Math.max(0, fs.heat - (this.now - fs.at) / 1000 * 2.5);
    const moving = p.veh ? 0.6 : Math.min(1, Math.hypot(p.phys.vx, p.phys.vz) / 7.2);
    const mul = (aim ? 0.55 : 1) * (1 + moving * 0.6 + (!p.veh && !p.phys.onGround ? 0.5 : 0)) * (1 + Math.min(1, fs.heat) * 0.6);
    fs.heat = Math.min(1.5, fs.heat + (w.auto ? 0.14 : 0.3)); fs.at = this.now;
    fireState.set(p, fs);
    const spread = w.spread * mul;
    const ox = p.phys.x, oy = p.phys.y + 1.62, oz = p.phys.z;
    if (!w.stun) barkEvent(this, 'gunfire', ox, oz);
    let anyHit = false, kill = false, hitVeh = false;
    for (let k = 0; k < w.pellets; k++) {
      const sy = yaw + (Math.random() - 0.5) * 2 * spread, sp = pitch + (Math.random() - 0.5) * 2 * spread;
      const dx = -Math.sin(sy) * Math.cos(sp), dy = Math.sin(sp), dz = -Math.cos(sy) * Math.cos(sp);
      const wall = raycastVoxels(voxels, ox, oy, oz, dx, dy, dz, w.range);
      let best: { kind: 'npc' | 'obj' | 'veh'; id: string; t: number } | null = null;
      const test = (cx: number, cy0: number, cz: number, r: number, h: number) => {
        const t = (cx - ox) * dx + (cz - oz) * dz + ((cy0 + h / 2) - oy) * dy;
        if (t < 0 || t > Math.min(w.range, wall)) return Infinity;
        const px = ox + dx * t, py = oy + dy * t, pz = oz + dz * t;
        if ((px - cx) ** 2 + (pz - cz) ** 2 > r * r) return Infinity;
        if (py < cy0 - 0.1 || py > cy0 + h + 0.1) return Infinity;
        return t;
      };
      for (const n of this.npcs.values()) {
        if (n.role === 'static' || n.downUntil > this.now || (w.stun && n.stunnedUntil > this.now)) continue;
        const t = test(n.x, n.y, n.z, 0.55, 1.85);
        if (t < (best?.t ?? Infinity)) best = { kind: 'npc', id: n.id, t };
      }
      for (const o of this.objects.values()) {
        if (o.kind !== 'target' || o.state !== 0) continue;
        const t = test(o.x, o.y, o.z, 0.6, 1.8);
        if (t < (best?.t ?? Infinity)) best = { kind: 'obj', id: o.id, t };
      }
      if (!w.stun) for (const v of this.vehicles.values()) {
        if (v.destroyedAt || v.id === p.veh || v.occ.some((u) => u)) continue;
        const t = test(v.phys.x, v.phys.y, v.phys.z, v.def.width * 0.6, v.def.height);
        if (t < (best?.t ?? Infinity)) best = { kind: 'veh', id: v.id, t };
      }
      const dist = best ? best.t : Math.min(w.range, wall);
      if (k === 0) this.game.shot(this, p, ox, oy, oz, ox + dx * dist, oy + dy * dist, oz + dz * dist, w.id, !!best);
      if (!best) continue;
      anyHit = true;
      if (best.kind === 'npc') { if (this.hitNpc(this.npcs.get(best.id)!, p, w.stun ? 0 : w.damage, !!w.stun)) kill = true; }
      else if (best.kind === 'obj') {
        const o = this.objects.get(best.id)!;
        if (o.state === 0) { o.state = 1; o.doneBy = p.userId; o.doneAt = this.now; this.run?.onObjectDone(o, p); }
      } else {
        const v = this.vehicles.get(best.id)!;
        this.damageVehicle(v, w.damage * 2, p);
        hitVeh = true;
        if (this.kind === 'world' && v.ai?.kind === 'police') this.addWanted(p, 2, 'Shot at police');
      }
    }
    if (anyHit) this.game.send(p.userId, { t: 'hitc', kill: kill || undefined, stun: !!w.stun || undefined, veh: (hitVeh && !kill) || undefined });
    if (this.kind === 'world' && !anyHit && !w.stun) {
      const wit = scarePeds(this, ox, oz, 30);
      if (wit > 1) this.addWanted(p, 1, 'Gunfire in public');
    }
  }

  /** returns true when the hit knocked the NPC out (or stunned it) */
  private hitNpc(n: NpcEnt, p: PlayerEnt, damage: number, stun: boolean): boolean {
    this.game.sfx(this, 'hit', n.x, n.y + 1, n.z, 0.8);
    let ko = false;
    if (stun) { n.stunnedUntil = this.now + (n.role === 'guard' ? 20000 : 9000); ko = true; }
    else {
      n.hp = (n.hp ?? 100) - damage;
      if (n.hp <= 0) { n.downUntil = this.now + 45_000; n.hp = 100; ko = true; } // knocked out (non-graphic)
      else n.brain.fleeUntil = this.now + 5000;
    }
    if (this.kind === 'world' && !isAnimal(n)) { // hurting an animal never raises wanted
      scarePeds(this, n.x, n.z, 30);
      barkEvent(this, 'assault', n.x, n.z, { npc: n });
      this.addWanted(p, n.role === 'cop' ? (stun ? 2 : 3) : stun ? 1 : 2, n.role === 'cop' ? 'Attacked an officer' : 'Assault');
    }
    if (this.run) this.run.onNpcStunned(n, p);
    return ko;
  }

  reload(p: PlayerEnt) {
    const w = WEAPONS[p.weapon];
    const a = p.ammo[p.weapon];
    if (!w || !a || a.mag >= w.mag || a.reserve <= 0 || this.now < p.reloadUntil) return;
    p.reloadUntil = this.now + w.reload * 1000;
    setTimeout(() => {
      const need = w.mag - a.mag, take = Math.min(need, a.reserve);
      a.mag += take; if (w.id !== 'stun') a.reserve -= take;
      p.ammoDirty = true;
      this.game.send(p.userId, { t: 'weapon', id: w.id, mag: a.mag, reserve: a.reserve });
    }, w.reload * 1000);
    this.game.send(p.userId, { t: 'weapon', id: w.id, mag: a.mag, reserve: a.reserve, reloading: w.reload });
  }

  // ───────────────────────────────────────────────────────── snapshots
  private focusOf(p: PlayerEnt) {
    if (p.cutsceneFocus) return { x: p.cutsceneFocus[0], z: p.cutsceneFocus[2] };
    return { x: p.phys.x, z: p.phys.z };
  }

  snapshot(p: PlayerEnt): Snapshot {
    const f = this.focusOf(p);
    const R2 = INTEREST_RADIUS * INTEREST_RADIUS;
    const near = (x: number, z: number) => (x - f.x) ** 2 + (z - f.z) ** 2 < R2;
    const ents: Ent[] = [];
    const visible = new Set<string>();
    const consider = (e: Ent) => {
      visible.add(e.id);
      const prev = p.sent.get(e.id);
      // distant moving entities update at ~7 Hz instead of 20 Hz (bandwidth)
      if (prev && e.k !== 'd' && e.k !== 'o' && this.tickNo % 3 !== 0 && (e.x - f.x) ** 2 + (e.z - f.z) ** 2 > 70 * 70) return;
      const cur = e as unknown as Record<string, unknown>;
      if (!prev) { p.sent.set(e.id, cur); ents.push(e); return; }
      // field-level delta: only changed fields are sent; null = field removed
      let delta: Record<string, unknown> | null = null;
      for (const k in cur) {
        const v = cur[k];
        if (v === undefined) continue;
        const pv = prev[k];
        const same = Array.isArray(v) ? Array.isArray(pv) && v.length === pv.length && v.every((x, i) => x === (pv as unknown[])[i]) : v === pv;
        if (!same) (delta ??= { id: e.id })[k] = v;
      }
      for (const k in prev) if (prev[k] !== undefined && cur[k] === undefined) (delta ??= { id: e.id })[k] = null;
      if (delta) { p.sent.set(e.id, cur); ents.push(delta as unknown as Ent); }
    };
    // pedestrians and wildlife are only relevant up close
    const NEAR_NPC2 = 125 * 125;
    for (const o of this.players.values()) {
      if (o === p || o.linkdeadAt) continue;
      const sameParty = !!p.partyId && o.partyId === p.partyId;
      if (!near(o.phys.x, o.phys.z) && !sameParty) continue;
      consider({
        id: o.id, k: 'p', n: o.name, x: round2(o.phys.x), y: round2(o.phys.y), z: round2(o.phys.z), yaw: round2(o.yaw), pitch: round2(o.pitch),
        a: playerAnim(o), v: o.veh ?? undefined, s: o.veh ? o.seat : undefined, hp: Math.round(o.hp), c: o.outfit, hr: o.hair || undefined, party: sameParty || undefined,
        role: o.role !== 'none' ? o.role : undefined,
        w: o.weapon, fa: this.now - (fireState.get(o)?.at ?? 0) < 1200 || undefined,
      });
    }
    for (const v of this.vehicles.values()) {
      if (!near(v.phys.x, v.phys.z) && !(v.owner?.userId === p.userId) && !(v.activityKey && this.run)) continue;
      consider({
        id: v.id, k: 'v', m: v.model, x: round2(v.phys.x), y: round2(v.phys.y), z: round2(v.phys.z), yaw: round2(v.phys.yaw),
        sp: round2(v.phys.speed), st: round2(v.phys.steer), hp: Math.round((v.hp / v.def.health) * 100), col: v.color, occ: v.occ,
        siren: v.siren || undefined, horn: v.horn || undefined, ghost: v.ghost || undefined, label: v.label ?? undefined,
        mine: v.owner?.userId === p.userId || undefined,
      });
    }
    for (const n of this.npcs.values()) {
      if (!near(n.x, n.z)) continue;
      if ((n.role as string).startsWith('ped') || (n.role as string).startsWith('animal')) { if ((n.x - f.x) ** 2 + (n.z - f.z) ** 2 > NEAR_NPC2) continue; }
      consider({ id: n.id, k: 'n', r: n.role === 'static' ? n.label : n.role, x: round2(n.x), y: round2(n.y), z: round2(n.z), yaw: round2(n.yaw), a: n.stunnedUntil > this.now || n.downUntil > this.now ? 6 : n.anim, sk: n.skin, name: n.name, al: n.role === 'guard' ? round2(n.alert) : undefined, stun: n.stunnedUntil > this.now || undefined });
    }
    for (const o of this.objects.values()) {
      if (o.state === 2) continue;
      consider({ id: o.id, k: 'o', m: o.kind, x: o.x, y: o.y, z: o.z, st: o.state, label: o.label, hold: o.hold, prog: round2(o.progress), yaw: o.yaw });
    }
    for (const d of this.doors.values()) consider({ id: d.id, k: 'd', x: d.x, y: d.y, z: d.z, axis: d.axis, w: d.w, open: d.open, label: d.label });
    const gone: string[] = [];
    for (const id of p.sent.keys()) if (!visible.has(id)) { gone.push(id); p.sent.delete(id); }

    const w = this.wantedOf(p);
    const v = p.veh ? this.vehicles.get(p.veh) : null;
    const me: SelfState = {
      x: round4(p.phys.x), y: round4(p.phys.y), z: round4(p.phys.z), vx: round4(p.phys.vx), vy: round4(p.phys.vy), vz: round4(p.phys.vz), og: p.phys.onGround,
      hp: Math.round(p.hp), maxHp: p.maxHp, wanted: w?.level ?? 0, wantedSeen: !!w && this.now - w.lastSeenAt < 1500,
      veh: p.veh ?? undefined, seat: p.veh ? p.seat : undefined,
      vp: v && p.seat === 0 ? { x: round4(v.phys.x), y: round4(v.phys.y), z: round4(v.phys.z), yaw: round4(v.phys.yaw), speed: round4(v.phys.speed), vy: round4(v.phys.vy), steer: round4(v.phys.steer), og: v.phys.onGround } : undefined,
      down: p.downUntil ? p.downUntil : undefined,
      interior: this.kind === 'interior' ? this.label : undefined,
      search: w ? { x: Math.round(w.lastKnown.x), z: Math.round(w.lastKnown.z), r: searchRadius(w.level) } : undefined,
    };
    return { t: 'snap', tick: this.tickNo, time: this.now, ack: p.lastSeq, me, ents, gone };
  }

  /** wanted search areas for the HUD/minimap */
  searchArea(p: PlayerEnt) {
    const w = this.wantedOf(p);
    return w ? { x: w.lastKnown.x, z: w.lastKnown.z, level: w.level } : null;
  }
}

/** per-player spread heat for fire(); kept outside the entity type */
const fireState = new WeakMap<PlayerEnt, { heat: number; at: number }>();

function round4(v: number) { return Math.round(v * 10000) / 10000; }

function playerAnim(p: PlayerEnt): number {
  if (p.downUntil) return 6;
  if (p.veh) return 5;
  if (p.phys.inWater) return 3;
  if (!p.phys.onGround) return 4;
  const sp = Math.hypot(p.phys.vx, p.phys.vz);
  if (sp > 5.5) return 2;
  if (sp > 0.4) return 1;
  return 0;
}

export { PLAZA_SPAWN };
export function interactRangeOk(p: PlayerEnt, x: number, y: number, z: number, extra = 0.6) {
  return Math.hypot(x - p.phys.x, z - p.phys.z) <= INTERACT_RANGE + extra && Math.abs(y - p.phys.y) < 2.6;
}

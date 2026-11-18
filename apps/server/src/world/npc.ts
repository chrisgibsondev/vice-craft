/**
 * Lightweight NPC simulation: street-grid traffic (cars, taxis, buses, patrols), region-aware
 * pedestrians (lot-ring walkers + free-roaming wanderers), wildlife, static shop/contact NPCs
 * and heist guards. Only simulated near players; everything far away is despawned (bounded
 * entity counts per instance) and far-but-alive NPCs are stepped at a reduced rate.
 *
 * Client-facing role strings: 'ped' | 'ped:<kind>' | 'animal:<kind>' (the snapshot sends NpcEnt.role as `r`).
 */
import { WORLD, ZONE_KINDS, PalmaraNav, worldAnchors, raycastVoxels, angleDiff, hash2, B, SEA_LEVEL, type ZoneKind, type VehicleModel } from '@blockshore/shared';
import { voxels, worldGen } from './voxels.ts';
import { nav, leoniaNav } from './nav.ts';
import { spawnTrafficLeonia, driveTrafficLeonia, trySpawnPedLeonia, stepWalker, trySpawnAnimalLeonia } from './npcLeonia.ts';
import { barkEvent } from './barks.ts';
import type { Instance } from './instance.ts';
import type { NpcEnt, VehicleEnt } from './entities.ts';

const G = 48;
const URBANISH = new Set<ZoneKind>(['suburb', 'urban', 'downtown', 'industrial', 'resort']);

export const isPed = (n: NpcEnt) => n.role === 'ped' || n.role.startsWith('ped:');
export const isAnimal = (n: NpcEnt) => n.role.startsWith('animal:');
const asRole = (s: string) => s as NpcEnt['role'];

/** a street spot where traffic / police may be placed (WorldNav; Palmara: urban zone on the 48-grid) */
export function streetOk(x: number, z: number): boolean { return nav.isStreet(x, z); }
/** Palmara grid segment check (grid traffic only) */
const palNav = nav instanceof PalmaraNav ? nav : null;
function segmentOk(ax: number, az: number, bx: number, bz: number) { return !!palNav && palNav.segmentOk(ax, az, bx, bz); }
function laneOffset(axis: 'x' | 'z', dir: number) {
  // right-hand traffic
  return axis === 'x' ? (dir > 0 ? 2 : -2) : (dir > 0 ? -2 : 2);
}
function laneWaypoint(axis: 'x' | 'z', dir: number, line: number, at: number) {
  const o = laneOffset(axis, dir);
  return axis === 'x' ? { x: at, z: line + o } : { x: line + o, z: at };
}
export function pickW<T>(tbl: readonly (readonly [T, number])[]): T {
  let t = 0;
  for (const e of tbl) t += e[1];
  let r = Math.random() * t;
  for (const e of tbl) { r -= e[1]; if (r <= 0) return e[0]; }
  return tbl[0][0];
}
export const rnd = (a: number, b: number) => a + Math.random() * (b - a);
export const d2xz = (ax: number, az: number, bx: number, bz: number) => (ax - bx) ** 2 + (az - bz) ** 2;

// ───────────────────────────────────────────────────────────── terrain probing
const FLOOR = new Set<number>([B.GRASS, B.DIRT, B.SAND, B.MUD, B.GRAVEL, B.SIDEWALK, B.CONCRETE, B.PLANK, B.DOCK, B.DARK_PLANK, B.FARMLAND]);
// Leonia paints parks, plazas, courts and golf with more surface blocks
if (WORLD === 'leonia') for (const b of [B.PATH, B.COBBLE, B.GRANITE, B.MARBLE, B.FAIRWAY, B.PUTTING, B.COURT_GREEN, B.COURT_RED, B.POOL_TILE]) FLOOR.add(b);
const SOFT = new Set<number>([B.AIR, B.TALL_GRASS, B.FLOWERS, B.REEDS, B.CANE, B.PALM_LEAVES]);
const SOLIDISH = (id: number) => !SOFT.has(id) && id !== B.WATER;

/**
 * Feet height of a standable, open-air walking spot at (x,z), or null (water, building interior, under a roof,
 * on a tree, on a road). Works for piers/docks over water. Cheap enough to call a few thousand times a second.
 */
export function footing(x: number, z: number): number | null {
  const bx = Math.floor(x), bz = Math.floor(z);
  if (!nav.inBounds(bx, bz)) return null;
  const top = nav.groundTop(bx, bz);
  for (let y = top + 2; y >= top - 2; y--) {
    const g = voxels.getBlock(bx, y, bz);
    if (!FLOOR.has(g)) continue;
    if (!SOFT.has(voxels.getBlock(bx, y + 1, bz)) || !SOFT.has(voxels.getBlock(bx, y + 2, bz))) continue;
    for (let k = 3; k <= 5; k++) if (SOLIDISH(voxels.getBlock(bx, y + k, bz))) return null;
    return y + 1;
  }
  return null;
}
/** y of surface water if (x,z) is shallow water (wading depth), else null */
export function shallowWater(x: number, z: number): number | null {
  const bx = Math.floor(x), bz = Math.floor(z);
  if (voxels.getBlock(bx, SEA_LEVEL, bz) !== B.WATER) return null;
  for (let y = SEA_LEVEL - 1; y >= SEA_LEVEL - 3; y--) {
    const g = voxels.getBlock(bx, y, bz);
    if (g !== B.WATER) return FLOOR.has(g) ? SEA_LEVEL + 0.88 : null;
  }
  return null;
}
export function onRoad(x: number, z: number) { return nav.isRoad(x, z); }

// ───────────────────────────────────────────────────────────── traffic
export interface TrafficKind { model: VehicleModel; color?: number; label?: string; speed: number }
const PALETTE = [0xe63946, 0xf1faee, 0x457b9d, 0x1d3557, 0xffb703, 0x2a9d8f, 0x8d99ae, 0x264653, 0xe76f51, 0x6a4c93, 0xffffff, 0x111111];
const SPEED_MUL: Record<string, number> = { compact: 1.0, sedan: 1.0, sports: 1.3, pickup: 0.95, van: 0.85, moto: 1.2, police: 1.0, muscle: 1.15, supercar: 1.3, coupe: 1.15, luxury: 1.0, taxi: 1.05, ambulance: 1.0, firetruck: 0.9, bus: 0.72, limo: 0.9, classic: 0.95, buggy: 1.1 };
export const pal = () => PALETTE[Math.floor(Math.random() * PALETTE.length)];

function countLabel(inst: Instance, label: string) {
  let c = 0;
  for (const v of inst.vehicles.values()) if (v.label === label && v.ai?.kind === 'traffic') c++;
  return c;
}
export function pickTraffic(inst: Instance, zone: ZoneKind | 'highway'): TrafficKind {
  type E = readonly [TrafficKind, number];
  const base: E[] = [
    [{ model: 'compact', speed: 1 }, 20], [{ model: 'sedan', speed: 1 }, 30], [{ model: 'pickup', speed: 0.95 }, zone === 'highway' ? 16 : 9],
    [{ model: 'van', speed: 0.85 }, 8], [{ model: 'sports', speed: 1.3 }, 6], [{ model: 'moto', speed: 1.2 }, 5],
    [{ model: 'coupe', speed: 1.15 }, 7], [{ model: 'luxury', speed: 1.0 }, 6], [{ model: 'muscle', speed: 1.15 }, 4], [{ model: 'classic', speed: 0.95 }, 3],
    [{ model: 'limo', speed: 0.9 }, 2], [{ model: 'supercar', speed: 1.3 }, zone === 'resort' ? 4 : 1], [{ model: 'ambulance', speed: 1.0 }, 1], [{ model: 'firetruck', speed: 0.9 }, 1],
  ];
  const city = zone === 'downtown' || zone === 'urban' || zone === 'resort';
  if (city) base.push([{ model: 'taxi', label: 'taxi', speed: 1.05 }, zone === 'downtown' ? 22 : 12]);
  if ((zone === 'downtown' || zone === 'urban') && countLabel(inst, 'bus') < 4) base.push([{ model: 'bus', color: 0x2a7de1, label: 'bus', speed: 0.72 }, zone === 'downtown' ? 12 : 6]);
  if (zone !== 'highway' && zone !== 'industrial' && countLabel(inst, 'patrol') < 3) base.push([{ model: 'police', color: 0xf6f7f8, label: 'patrol', speed: 0.95 }, city || zone === 'suburb' ? 5 : 2]);
  return pickW(base);
}

export function trafficTick(inst: Instance, dt: number, cap: number) {
  const players = inst.activePlayers();
  const traffic: VehicleEnt[] = [];
  for (const v of inst.vehicles.values()) if (v.ai?.kind === 'traffic') traffic.push(v);
  // despawn far / over cap
  for (const v of traffic) {
    const near = players.some((p) => d2xz(p.phys.x, p.phys.z, v.phys.x, v.phys.z) < 175 * 175);
    if (!near && v.occ.every((o) => !o)) inst.removeVehicle(v.id);
  }
  // spawn more aggressively while the street is thin (up to 3 tries per tick)
  const missing = cap - traffic.length;
  if (missing > 0 && players.length) {
    const tries = missing > cap * 0.5 ? 5 : 2;
    for (let k = 0; k < tries; k++) if (Math.random() < 0.7) spawnTraffic(inst, players[Math.floor(Math.random() * players.length)]);
  }
  const tn = inst.tickNo;
  let idx = 0;
  for (const v of inst.vehicles.values()) {
    if (v.ai?.kind !== 'traffic' || v.occ[0] || v.destroyedAt !== 0) continue;
    idx++;
    // distant cars are simulated at half rate
    let near = false;
    for (const p of players) if (d2xz(p.phys.x, p.phys.z, v.phys.x, v.phys.z) < 100 * 100) { near = true; break; }
    const drive = leoniaNav ? driveTrafficLeonia : driveTraffic;
    if (!near) { if ((tn + idx) % 2) continue; drive(inst, v, dt * 2); } else drive(inst, v, dt);
  }
}

export function tooClose(inst: Instance, x: number, z: number, r: number) {
  for (const p of inst.activePlayers()) if (d2xz(p.phys.x, p.phys.z, x, z) < r * r) return true;
  return false;
}

function spawnHighway(inst: Instance, near: { phys: { x: number; z: number } }): boolean {
  const r = worldGen.r;
  const ang = Math.random() * Math.PI * 2, d = 55 + Math.random() * 95;
  const px = near.phys.x + Math.cos(ang) * d, pz = near.phys.z + Math.sin(ang) * d;
  const segs = r.segsNear(px, pz).map((i) => r.segs[i]).filter((sg) => sg.kind === 'road');
  if (!segs.length) return false;
  const sg = segs[Math.floor(Math.random() * segs.length)];
  const dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
  const t = Math.random();
  const lane = sg.roadKind === 'highway' ? 4 : 2;
  // right-hand lane: offset to the right of travel direction
  const tdx = sg.dx * dir, tdz = sg.dz * dir;
  const rx = -tdz, rz = tdx;
  const x = sg.ax + (sg.bx - sg.ax) * t + rx * lane, z = sg.az + (sg.bz - sg.az) * t + rz * lane;
  if (tooClose(inst, x, z, 40)) return false;
  if (!worldGen.r.isLand(Math.floor(x), Math.floor(z)) && !worldGen.lineInfo(Math.floor(x), Math.floor(z)).road) return false;
  for (const v of inst.vehicles.values()) if (d2xz(v.phys.x, v.phys.z, x, z) < 100) return false;
  const yaw = Math.atan2(-tdx, -tdz);
  const k = pickTraffic(inst, 'highway');
  const v = inst.spawnVehicle(k.model, x, 22, z, yaw, { color: k.color ?? pal(), label: k.label });
  const idx = r.segs.indexOf(sg);
  const end = dir > 0 ? { x: sg.bx + rx * lane, z: sg.bz + rz * lane } : { x: sg.ax + rx * lane, z: sg.az + rz * lane };
  const base = sg.roadKind === 'highway' ? 19 + Math.random() * 7 : 12 + Math.random() * 4;
  v.ai = { kind: 'traffic', waypoint: end, speed: base * k.speed, line: idx, dir, axis: undefined };
  return true;
}

function spawnTraffic(inst: Instance, near: { phys: { x: number; z: number } }) {
  if (leoniaNav) { spawnTrafficLeonia(inst, near); return; }
  const inCity = streetOk(Math.round(near.phys.x / G) * G, Math.round(near.phys.z / G) * G);
  if ((!inCity || Math.random() < 0.2) && spawnHighway(inst, near)) return;
  for (let tries = 0; tries < 6; tries++) {
    const ang = Math.random() * Math.PI * 2, d = 28 + Math.random() * 100;
    const ix = Math.round((near.phys.x + Math.cos(ang) * d) / G) * G;
    const iz = Math.round((near.phys.z + Math.sin(ang) * d) / G) * G;
    if (!streetOk(ix, iz)) continue;
    const opts: { axis: 'x' | 'z'; dir: 1 | -1 }[] = [];
    if (segmentOk(ix, iz, ix + G, iz)) opts.push({ axis: 'x', dir: 1 });
    if (segmentOk(ix, iz, ix - G, iz)) opts.push({ axis: 'x', dir: -1 });
    if (segmentOk(ix, iz, ix, iz + G)) opts.push({ axis: 'z', dir: 1 });
    if (segmentOk(ix, iz, ix, iz - G)) opts.push({ axis: 'z', dir: -1 });
    if (!opts.length) continue;
    const o = opts[Math.floor(Math.random() * opts.length)];
    const line = o.axis === 'x' ? iz : ix;
    const start = laneWaypoint(o.axis, o.dir, line, (o.axis === 'x' ? ix : iz) + o.dir * 8);
    if (tooClose(inst, start.x, start.z, 16)) continue;
    // don't spawn on top of something
    let blocked = false;
    for (const v of inst.vehicles.values()) if (d2xz(v.phys.x, v.phys.z, start.x, start.z) < 64) { blocked = true; break; }
    if (blocked) continue;
    const yaw = o.axis === 'x' ? (o.dir > 0 ? -Math.PI / 2 : Math.PI / 2) : (o.dir > 0 ? Math.PI : 0);
    const k = pickTraffic(inst, worldGen.r.zoneAt(ix, iz));
    const v = inst.spawnVehicle(k.model, start.x, 22, start.z, yaw, { color: k.color ?? pal(), label: k.label });
    const nextAt = (o.axis === 'x' ? ix : iz) + o.dir * G;
    v.ai = { kind: 'traffic', axis: o.axis, dir: o.dir, line, waypoint: laneWaypoint(o.axis, o.dir, line, nextAt), speed: (9 + Math.random() * 3) * k.speed };
    return;
  }
}

/** horn blast; with inst + a reason the driver may also shout a bark line (see barks.ts) */
export function honk(v: VehicleEnt, now: number, inst?: Instance, why: 'player' | 'ped' | 'jam' | 'tap' = 'tap') {
  v.ai!.hornAt = now;
  if (inst && why !== 'tap') barkEvent(inst, 'honk', v.phys.x, v.phys.z, { vehicle: v, reason: why });
  v.horn = true;
  setTimeout(() => (v.horn = false), 350 + Math.random() * 500);
}

function driveTraffic(inst: Instance, v: VehicleEnt, dt: number) {
  const ai = v.ai!;
  const now = inst.now;
  if (ai.waitUntil && now < ai.waitUntil) { v.phys.speed = 0; return; }
  const wp = ai.waypoint!;
  const dx = wp.x - v.phys.x, dz = wp.z - v.phys.z;
  const d = Math.hypot(dx, dz);
  if (d < 2.2 && ai.axis === undefined) {
    // highway car: continue onto the next segment of the same polyline, or turn around at the end
    const r = worldGen.r;
    const cur = r.segs[ai.line!];
    const nextIdx = ai.line! + ai.dir!;
    const nxt = r.segs[nextIdx];
    const lane = cur.roadKind === 'highway' ? 4 : 2;
    if (nxt && nxt.featureId === cur.featureId) {
      ai.line = nextIdx;
      const tdx = nxt.dx * ai.dir!, tdz = nxt.dz * ai.dir!;
      const rx = -tdz, rz = tdx;
      ai.waypoint = ai.dir! > 0 ? { x: nxt.bx + rx * lane, z: nxt.bz + rz * lane } : { x: nxt.ax + rx * lane, z: nxt.az + rz * lane };
    } else inst.removeVehicle(v.id);
    return;
  }
  if (d < 2.2) {
    // buses make short stops at junctions
    if (v.label === 'bus' && Math.random() < 0.3) ai.waitUntil = now + 2500 + Math.random() * 3000;
    // at an intersection: pick the next lane
    const ix = ai.axis === 'x' ? wp.x : ai.line!, iz = ai.axis === 'x' ? ai.line! : wp.z;
    const cx = Math.round(ix / G) * G, cz = Math.round(iz / G) * G;
    const opts: { axis: 'x' | 'z'; dir: 1 | -1; w: number }[] = [];
    const add = (axis: 'x' | 'z', dir: 1 | -1, w: number) => {
      const ok = axis === 'x' ? segmentOk(cx, cz, cx + dir * G, cz) : segmentOk(cx, cz, cx, cz + dir * G);
      if (ok) opts.push({ axis, dir, w });
    };
    add(ai.axis!, ai.dir!, 6);
    if (ai.axis === 'x') { add('z', 1, 2); add('z', -1, 2); } else { add('x', 1, 2); add('x', -1, 2); }
    if (!opts.length) { inst.removeVehicle(v.id); return; }
    let r = Math.random() * opts.reduce((s, o) => s + o.w, 0);
    let pick = opts[0];
    for (const o of opts) { r -= o.w; if (r <= 0) { pick = o; break; } }
    const line = pick.axis === 'x' ? cz : cx;
    const at = (pick.axis === 'x' ? cx : cz) + pick.dir * G;
    ai.axis = pick.axis; ai.dir = pick.dir; ai.line = line;
    ai.waypoint = laneWaypoint(pick.axis, pick.dir, line, at);
    return;
  }
  // obstacle check
  const fx = -Math.sin(v.phys.yaw), fz = -Math.cos(v.phys.yaw);
  let blocked = false, blockedByPlayer = false, blockedByPed = false;
  const check = (x: number, z: number, kind: 0 | 1 | 2) => {
    const ox = x - v.phys.x, oz = z - v.phys.z;
    const ahead = ox * fx + oz * fz;
    if (ahead < 0.5 || ahead > 8) return;
    const side = Math.abs(ox * -fz + oz * fx);
    if (side < 1.8) { blocked = true; if (kind === 1) blockedByPlayer = true; if (kind === 2) blockedByPed = true; }
  };
  for (const o of inst.vehicles.values()) if (o !== v && o.destroyedAt === 0) check(o.phys.x, o.phys.z, o.occ[0] ? 1 : 0);
  for (const p of inst.players.values()) if (!p.veh && !p.linkdeadAt) check(p.phys.x, p.phys.z, 1);
  for (const n of inst.npcs.values()) if (isPed(n)) check(n.x, n.z, 2);
  const target = blocked ? 0 : ai.speed! * (d < 14 ? 0.6 : 1);
  v.phys.speed += Math.max(-14 * dt, Math.min(6 * dt, target - v.phys.speed));
  // honking: at players in the way, at people crossing, when stuck in a jam, and the odd bored tap downtown
  ai.stuckFor = blocked && v.phys.speed < 0.5 ? (ai.stuckFor ?? 0) + dt : 0;
  const cool = !ai.hornAt || now - ai.hornAt > 4500;
  if (cool && ((blockedByPlayer && v.phys.speed < 0.5) || (blockedByPed && v.phys.speed < 1.5 && Math.random() < 0.05) || ((ai.stuckFor ?? 0) > 1.6 && Math.random() < 0.08) || Math.random() < 0.00006)) honk(v, now, inst, blockedByPlayer ? 'player' : blockedByPed ? 'ped' : (ai.stuckFor ?? 0) > 1.6 ? 'jam' : 'tap');
  if ((ai.stuckFor ?? 0) > 20) { inst.removeVehicle(v.id); return; } // deadlocked at a junction: just clear it
  const want = Math.atan2(-dx, -dz);
  const diff = angleDiff(want, v.phys.yaw);
  v.phys.yaw += Math.max(-2.6 * dt, Math.min(2.6 * dt, diff));
  v.phys.steer = Math.max(-1, Math.min(1, diff * 2));
  v.phys.x += -Math.sin(v.phys.yaw) * v.phys.speed * dt;
  v.phys.z += -Math.cos(v.phys.yaw) * v.phys.speed * dt;
  v.phys.y = 22;
}
void SPEED_MUL;

// ───────────────────────────────────────────────────────────── pedestrians
const RING = [[4.5, 4.5], [43.5, 4.5], [43.5, 43.5], [4.5, 43.5]];

export interface Prof { sp: [number, number]; run?: boolean; pause: number; pauseMs: [number, number]; sit: number; group: number; dog: number; leg: [number, number]; skate?: boolean }
export const PROF: Record<string, Prof> = {
  '': { sp: [1.2, 1.7], pause: 0.3, pauseMs: [1500, 4500], sit: 0.05, group: 0.12, dog: 0.1, leg: [8, 26] },
  business: { sp: [1.6, 2.0], pause: 0.12, pauseMs: [1000, 3000], sit: 0.01, group: 0.15, dog: 0, leg: [10, 30] },
  tourist: { sp: [0.9, 1.25], pause: 0.5, pauseMs: [2500, 7000], sit: 0.08, group: 0.45, dog: 0, leg: [8, 24] },
  beach: { sp: [0.9, 1.35], pause: 0.45, pauseMs: [3000, 9000], sit: 0.3, group: 0.35, dog: 0.05, leg: [8, 28] },
  jogger: { sp: [3.0, 3.8], run: true, pause: 0.02, pauseMs: [800, 1500], sit: 0, group: 0.15, dog: 0.15, leg: [30, 70] },
  worker: { sp: [1.2, 1.5], pause: 0.35, pauseMs: [2500, 8000], sit: 0.1, group: 0.35, dog: 0, leg: [8, 22] },
  farmer: { sp: [1.0, 1.3], pause: 0.45, pauseMs: [3000, 9000], sit: 0.04, group: 0.1, dog: 0.15, leg: [8, 24] },
  fisher: { sp: [0.8, 1.1], pause: 0.75, pauseMs: [9000, 24000], sit: 0.35, group: 0.1, dog: 0, leg: [4, 12] },
  ranger: { sp: [1.3, 1.7], pause: 0.25, pauseMs: [2000, 6000], sit: 0.02, group: 0.12, dog: 0.1, leg: [10, 32] },
  student: { sp: [1.4, 1.9], pause: 0.2, pauseMs: [1500, 5000], sit: 0.1, group: 0.5, dog: 0, leg: [8, 26] },
  elder: { sp: [0.6, 0.85], pause: 0.45, pauseMs: [3000, 9000], sit: 0.3, group: 0.12, dog: 0.15, leg: [6, 16] },
  skater: { sp: [4.0, 5.5], run: true, pause: 0.04, pauseMs: [500, 1500], sit: 0, group: 0.2, dog: 0, leg: [22, 50], skate: true },
};
export type Tbl = readonly (readonly [string, number])[];
export const URBAN_TBL: Partial<Record<ZoneKind, Tbl>> = {
  downtown: [['business', 44], ['', 20], ['student', 10], ['tourist', 8], ['elder', 5], ['skater', 5], ['worker', 5], ['jogger', 3]],
  urban: [['', 30], ['student', 14], ['business', 14], ['elder', 9], ['skater', 7], ['jogger', 6], ['tourist', 6], ['worker', 10]],
  suburb: [['', 26], ['elder', 13], ['jogger', 16], ['student', 14], ['skater', 6], ['worker', 5], ['business', 5], ['tourist', 3]],
  resort: [['tourist', 40], ['beach', 14], ['jogger', 10], ['', 14], ['elder', 8], ['business', 4], ['skater', 6], ['student', 4]],
  industrial: [['worker', 62], ['', 16], ['business', 8], ['jogger', 3], ['elder', 3], ['student', 2]],
};
export const FREE_TBL: Partial<Record<ZoneKind, Tbl>> = {
  wetland: [['ranger', 45], ['fisher', 35], ['', 12], ['tourist', 8]],
  forest: [['ranger', 62], ['', 18], ['jogger', 12], ['student', 8]],
  farmland: [['farmer', 78], ['', 8], ['ranger', 6], ['jogger', 8]],
  none: [['', 30], ['ranger', 24], ['farmer', 20], ['jogger', 12], ['tourist', 14]],
  suburb: [['', 30], ['elder', 16], ['jogger', 16], ['student', 16], ['skater', 8], ['farmer', 4], ['tourist', 10]],
  urban: [['', 28], ['student', 18], ['jogger', 12], ['skater', 12], ['elder', 10], ['tourist', 10], ['worker', 10]],
  downtown: [['business', 40], ['', 26], ['student', 12], ['skater', 8], ['tourist', 8], ['elder', 6]],
  industrial: [['worker', 70], ['', 20], ['jogger', 10]],
  resort: [['tourist', 40], ['beach', 25], ['jogger', 12], ['', 12], ['elder', 6], ['skater', 5]],
};
export const BEACH_TBL: Tbl = [['beach', 54], ['jogger', 14], ['tourist', 14], ['', 8], ['elder', 5], ['student', 5]];
export const SHORE_TBL: Tbl = [['fisher', 45], ['beach', 20], ['tourist', 15], ['jogger', 10], ['', 10]];

export interface Ext {
  mode: 'ring' | 'wander' | 'follow' | 'sit' | 'walk';
  /** sidewalk / footway walkers (Leonia road graph): edge, arc length from a, direction, side (−1/+1, 0 = footway) */
  we?: number; ws?: number; wd?: 1 | -1; wside?: number;
  kind: string;
  hasT: boolean; tx: number; tz: number;
  wait: number; sitUntil: number;
  leader?: string; ox: number; oz: number;
  acc: number;
  ck: number; // distance since last footing check
  fails: number;
  hd: number; // preferred heading (joggers keep going)
  idle: number; // seconds without progress
}
export const EXT = new WeakMap<NpcEnt, Ext>();

function newExt(kind: string, mode: Ext['mode']): Ext {
  return { mode, kind, hasT: false, tx: 0, tz: 0, wait: 0, sitUntil: 0, ox: 0, oz: 0, acc: 0, ck: 0, fails: 0, hd: Math.random() * 6.283, idle: 0 };
}

export function makePed(inst: Instance, kind: string, x: number, y: number, z: number, mode: Ext['mode']): NpcEnt {
  const P = PROF[kind] ?? PROF[''];
  const id = inst.nextId('n');
  const n: NpcEnt = {
    id, role: asRole(kind ? 'ped:' + kind : 'ped'), label: 'ped', x, y, z, yaw: Math.random() * 6.283, anim: 1,
    skin: Math.floor(Math.random() * 16), stunnedUntil: 0, downUntil: 0, alert: 0, activityKey: null, speed: rnd(P.sp[0], P.sp[1]), brain: {},
  };
  EXT.set(n, newExt(kind, mode));
  inst.npcs.set(id, n);
  return n;
}

function spawnRingPed(inst: Instance, kind: string, i: number, j: number, corner: number, dir: 1 | -1): NpcEnt {
  const n = makePed(inst, kind, i * G + RING[corner][0], 22, j * G + RING[corner][1], 'ring');
  n.brain = { lot: { i, j }, corner, dir, pauseUntil: 0 };
  return n;
}

export function groupSize(P: Prof): number { return Math.random() < P.group ? (Math.random() < 0.4 ? 3 : 2) : 1; }

export function addFollowers(inst: Instance, lead: NpcEnt, kind: string, size: number) {
  for (let k = 1; k < size; k++) {
    const f = makePed(inst, kind, lead.x + (k === 1 ? -1.1 : 1.1), lead.y, lead.z + 0.6 * k, 'follow');
    const e = EXT.get(f)!;
    e.leader = lead.id; e.ox = (k === 1 ? -1.1 : 1.1); e.oz = 0.9 * k;
    f.speed = lead.speed;
    f.skin = Math.floor(Math.random() * 16);
    if (kind === 'student' || kind === 'tourist') f.brain.lot = lead.brain.lot;
  }
}

export function maybeDog(inst: Instance, owner: NpcEnt, kind: string) {
  const P = PROF[kind] ?? PROF[''];
  if (Math.random() >= P.dog) return;
  let dogs = 0;
  for (const a of inst.npcs.values()) if ((a.role as string) === 'animal:dog') dogs++;
  if (dogs >= 5) return;
  const a = makeAnimal(inst, 'dog', owner.x + 1, owner.y, owner.z + 1);
  a.brain.owner = owner.id;
}

/** pick a random free-roam spot near (x,z) for a wandering person. Returns role kind + feet y, or null. */
function freeSpot(x: number, z: number): { kind: string; y: number } | null {
  const f = footing(x, z);
  if (f === null) return null;
  if (onRoad(x, z)) return null;
  const zone = nav.zoneAt(x, z), land = !nav.isWater(x, z), dist = nav.coastDist(x, z);
  if (zone === 'airport') return null;
  const below = voxels.getBlock(Math.floor(x), f - 1, Math.floor(z));
  let kind: string;
  if (!land) kind = pickW(zone === 'wetland' ? FREE_TBL.wetland! : SHORE_TBL); // pier / dock / boardwalk over water
  else if (below === B.SAND && dist < 14) kind = pickW(dist <= 2 ? SHORE_TBL : BEACH_TBL);
  else if (below === B.DOCK || below === B.PLANK || below === B.DARK_PLANK) kind = pickW(zone === 'wetland' ? FREE_TBL.wetland! : SHORE_TBL);
  else kind = pickW(FREE_TBL[zone] ?? FREE_TBL.none!);
  return { kind, y: f };
}

function trySpawnPed(inst: Instance, p: { phys: { x: number; z: number } }, room: number): number {
  if (leoniaNav) return trySpawnPedLeonia(inst, p, room);
  const ang = Math.random() * Math.PI * 2, d = 9 + Math.sqrt(Math.random()) * 105;
  const x = p.phys.x + Math.cos(ang) * d, z = p.phys.z + Math.sin(ang) * d;
  if (!nav.inBounds(x, z)) return 0;
  const r = worldGen.r;
  const land = r.isLand(Math.floor(x), Math.floor(z));
  const zone = r.zoneAt(x, z);
  const dist = r.distAt(x, z);
  const coastal = land && dist < 14;
  const ring = () => {
    if (!land || !URBANISH.has(zone)) return 0;
    const i = Math.floor(x / G), j = Math.floor(z / G);
    const plan = worldGen.lotPlan(i, j);
    if (plan.kind === 'margin') return 0;
    const kind = pickW(URBAN_TBL[plan.zone] ?? URBAN_TBL.urban!);
    const P = PROF[kind];
    const size = Math.min(room, groupSize(P));
    const corner = Math.floor(Math.random() * 4), dir: 1 | -1 = Math.random() < 0.5 ? 1 : -1;
    const lead = spawnRingPed(inst, kind, i, j, corner, dir);
    if (tooClose(inst, lead.x, lead.z, 6)) { inst.npcs.delete(lead.id); return 0; }
    addFollowers(inst, lead, kind, size);
    maybeDog(inst, lead, kind);
    return size;
  };
  const free = () => {
    const s = freeSpot(x, z);
    if (!s || tooClose(inst, x, z, 6)) return 0;
    const P = PROF[s.kind];
    const size = Math.min(room, groupSize(P));
    const lead = makePed(inst, s.kind, x, s.y, z, 'wander');
    addFollowers(inst, lead, s.kind, size);
    maybeDog(inst, lead, s.kind);
    return size;
  };
  if (coastal || !URBANISH.has(zone)) return free() || (URBANISH.has(zone) ? ring() : 0);
  // inside city blocks: lots (80%) otherwise the open ground between them (margins, small towns)
  return Math.random() < 0.8 ? ring() || free() : free() || ring();
}

export function pedTick(inst: Instance, dt: number, cap: number) {
  const players = inst.activePlayers();
  const peds: NpcEnt[] = [];
  const now = inst.now;
  for (const n of inst.npcs.values()) if (isPed(n)) peds.push(n);
  // despawn far
  for (const n of peds) {
    let near = false;
    for (const p of players) if (d2xz(p.phys.x, p.phys.z, n.x, n.z) < 140 * 140) { near = true; break; }
    if (!near) inst.npcs.delete(n.id);
  }
  let count = 0;
  for (const n of inst.npcs.values()) if (isPed(n)) count++;
  // over cap (players left): thin out the farthest
  if (count > cap + 3 && players.length) {
    let worst: NpcEnt | null = null, wd = -1;
    for (const n of inst.npcs.values()) {
      if (!isPed(n)) continue;
      let md = Infinity;
      for (const p of players) md = Math.min(md, d2xz(p.phys.x, p.phys.z, n.x, n.z));
      if (md > wd) { wd = md; worst = n; }
    }
    if (worst) { inst.npcs.delete(worst.id); count--; }
  }
  // spawn: aggressively while the streets are thin, toward the player with the emptiest surroundings
  if (count < cap && players.length) {
    const local = players.map((p) => { let c = 0; for (const n of inst.npcs.values()) if (isPed(n) && d2xz(p.phys.x, p.phys.z, n.x, n.z) < 120 * 120) c++; return c; });
    const attempts = count < cap * 0.5 ? 10 : count < cap * 0.8 ? 5 : 2;
    for (let k = 0; k < attempts && count < cap; k++) {
      const cand: number[] = [];
      for (let i = 0; i < players.length; i++) if (local[i] < 60) cand.push(i);
      if (!cand.length) break;
      const bi = cand[Math.floor(Math.random() * cand.length)];
      const made = trySpawnPed(inst, players[bi], cap - count);
      count += made; local[bi] += made;
    }
  }
  // simulate
  const tn = inst.tickNo;
  let idx = 0;
  for (const n of inst.npcs.values()) {
    if (!isPed(n)) continue;
    const e = EXT.get(n);
    if (!e) continue;
    idx++;
    let md = Infinity;
    for (const p of players) { const q = d2xz(p.phys.x, p.phys.z, n.x, n.z); if (q < md) md = q; }
    // far people (>85 m) step every 3rd tick, mid (>55 m) every 2nd; dt accumulates so speeds stay right
    const every = md > 70 * 70 ? 4 : md > 28 * 28 ? 2 : 1;
    e.acc += dt;
    if (every > 1 && (tn + idx) % every) continue;
    const sdt = e.acc; e.acc = 0;
    stepPed(inst, n, e, sdt, now);
  }
}

function stepPed(inst: Instance, n: NpcEnt, e: Ext, dt: number, now: number) {
  if (n.downUntil > now || n.stunnedUntil > now) { n.anim = 6; return; }
  const P = PROF[e.kind] ?? PROF[''];
  const fleeing = (n.brain.fleeUntil ?? 0) > now;
  if (e.mode === 'follow') { stepFollower(inst, n, e, dt, fleeing); return; }
  if (e.mode === 'ring') { stepRing(n, e, P, dt, now, fleeing); return; }
  if (e.mode === 'walk') { stepWalker(inst, n, e, P, dt, now, fleeing); return; }
  stepWander(inst, n, e, P, dt, now, fleeing);
}

function stepRing(n: NpcEnt, e: Ext, P: Prof, dt: number, now: number, fleeing: boolean) {
  const b = n.brain;
  if (e.mode === 'ring' && e.sitUntil > now && !fleeing) { n.anim = 5; return; }
  if (b.pauseUntil && now < b.pauseUntil && !fleeing) { n.anim = 0; return; }
  const next = ((b.corner! + b.dir! + 4) % 4);
  const tx = b.lot!.i * G + RING[next][0], tz = b.lot!.j * G + RING[next][1];
  const dx = tx - n.x, dz = tz - n.z, d = Math.hypot(dx, dz);
  if (d < 0.4) {
    b.corner = next;
    if (!fleeing && Math.random() < P.pause) {
      b.pauseUntil = now + rnd(P.pauseMs[0], P.pauseMs[1]);
      if (Math.random() < P.sit) e.sitUntil = b.pauseUntil;
    }
    if (Math.random() < 0.15) b.dir = (b.dir === 1 ? -1 : 1);
    return;
  }
  const sp = n.speed * (fleeing ? (P.run ? 1.4 : 3) : 1);
  n.x += (dx / d) * Math.min(d, sp * dt);
  n.z += (dz / d) * Math.min(d, sp * dt);
  n.yaw = Math.atan2(-dx, -dz);
  n.anim = fleeing || P.run ? 2 : 1;
}

function stepFollower(inst: Instance, n: NpcEnt, e: Ext, dt: number, fleeing: boolean) {
  const L = e.leader ? inst.npcs.get(e.leader) : undefined;
  if (!L || !isPed(L)) { e.mode = 'wander'; e.leader = undefined; e.hasT = false; return; }
  if (L.downUntil > inst.now || fleeing) { n.brain.fleeUntil = L.brain.fleeUntil; }
  if (L.anim === 5) { n.anim = 5; return; }
  const tx = L.x + e.ox, tz = L.z + e.oz;
  const dx = tx - n.x, dz = tz - n.z, d = Math.hypot(dx, dz);
  if (d > 16) { e.mode = 'wander'; e.leader = undefined; e.hasT = false; return; }
  n.y += (L.y - n.y) * Math.min(1, 8 * dt);
  const lrun = L.anim === 2;
  if (d < 0.35 && L.anim !== 1 && !lrun) { n.anim = 0; n.yaw = L.yaw; return; }
  const sp = Math.min(d / Math.max(dt, 0.02), L.speed * (d > 1.5 ? 1.7 : 1.05) * (L.anim === 0 ? 0.6 : 1) * (lrun ? 1.6 : 1) * ((L.brain.fleeUntil ?? 0) > inst.now ? 3 : 1) + 0.1);
  const st = Math.min(d, sp * dt);
  n.x += (dx / d) * st; n.z += (dz / d) * st;
  n.yaw = d > 0.5 ? Math.atan2(-dx, -dz) : L.yaw;
  n.anim = st / dt > 0.2 ? (lrun || fleeing ? 2 : 1) : 0;
}

function pickTarget(n: NpcEnt, e: Ext, P: Prof): boolean {
  for (let k = 0; k < 5; k++) {
    let ang: number, d: number;
    if (P.run) { ang = e.hd + rnd(-0.5, 0.5); d = rnd(P.leg[0], P.leg[1]); }
    else { ang = Math.random() * 6.283; d = rnd(P.leg[0], P.leg[1]); }
    const tx = n.x + Math.cos(ang) * d, tz = n.z + Math.sin(ang) * d;
    // validate the end and midpoint so we don't aim across water or into buildings
    const f = footing(tx, tz);
    if (f === null || Math.abs(f - n.y) > 3.5) continue;
    if (footing((n.x + tx) / 2, (n.z + tz) / 2) === null) continue;
    if (onRoad(tx, tz)) continue;
    if (e.kind === 'beach' || e.kind === 'fisher') {
      // stay near the coast
      const dd = nav.coastDist(tx, tz);
      if (dd > 16 && Math.random() < 0.85) continue;
    }
    e.tx = tx; e.tz = tz; e.hasT = true; e.hd = ang;
    return true;
  }
  if (P.run) e.hd += Math.PI * (0.6 + Math.random() * 0.8); // blocked: turn around and keep jogging
  return false;
}

function stepWander(inst: Instance, n: NpcEnt, e: Ext, P: Prof, dt: number, now: number, fleeing: boolean) {
  if (e.mode === 'sit') {
    if (now < e.sitUntil && !fleeing) { n.anim = 5; return; }
    e.mode = 'wander'; e.hasT = false;
  }
  if (e.wait > now && !fleeing) { n.anim = 0; return; }
  if (!e.hasT) {
    if (!pickTarget(n, e, P)) {
      e.wait = now + 600; n.anim = 0;
      if (++e.fails > 12) inst.npcs.delete(n.id); // boxed in: drop and let the spawner place someone elsewhere
      return;
    }
  }
  const dx = e.tx - n.x, dz = e.tz - n.z, d = Math.hypot(dx, dz);
  if (d < 0.5) {
    e.hasT = false; n.anim = 0;
    if (!fleeing && Math.random() < P.pause) {
      e.wait = now + rnd(P.pauseMs[0], P.pauseMs[1]);
      if (Math.random() < P.sit) { e.mode = 'sit'; e.sitUntil = e.wait; }
    }
    return;
  }
  const sp = n.speed * (fleeing ? (P.run ? 1.4 : 3) : 1);
  const st = Math.min(d, sp * dt);
  const px = n.x, pz = n.z;
  n.x += (dx / d) * st; n.z += (dz / d) * st;
  n.yaw = Math.atan2(-dx, -dz);
  n.anim = fleeing || P.run ? 2 : 1;
  e.ck += st;
  if (e.ck > 0.6) {
    e.ck = 0;
    const f = footing(n.x, n.z);
    if (f === null || Math.abs(f - n.y) > 1.35) { n.x = px; n.z = pz; e.hasT = false; e.wait = now + 400; e.fails++; n.anim = 0; if (e.fails > 14) inst.npcs.delete(n.id); }
    else { n.y = f; e.fails = 0; }
  }
}

/** Make nearby pedestrians (and animals) flee (gunfire, crashes). Returns number of human witnesses. */
export function scarePeds(inst: Instance, x: number, z: number, r: number): number {
  let w = 0;
  for (const n of inst.npcs.values()) {
    const ped = isPed(n), animal = isAnimal(n);
    if (!ped && !animal) continue;
    if (d2xz(n.x, n.z, x, z) < r * r) {
      n.brain.fleeUntil = inst.now + 6000;
      n.brain.pauseUntil = 0;
      const e = EXT.get(n);
      if (e) { e.wait = 0; if (e.mode === 'sit') e.mode = 'wander'; e.sitUntil = 0; }
      if (ped) w++;
    }
  }
  return w;
}

// ───────────────────────────────────────────────────────────── wildlife
export interface AProf { speed: [number, number]; run: number; fleeR: number; fly?: boolean; water?: boolean; max: number; range: number }
export const APROF: Record<string, AProf> = {
  gator: { speed: [0.5, 0.9], run: 2.4, fleeR: 6, water: true, max: 4, range: 14 },
  heron: { speed: [0.35, 0.6], run: 3, fleeR: 9, fly: true, max: 3, range: 6 },
  egret: { speed: [0.35, 0.6], run: 3, fleeR: 9, fly: true, max: 3, range: 6 },
  gull: { speed: [6, 8.5], run: 0, fleeR: 0, fly: true, max: 4, range: 0 },
  pelican: { speed: [0.4, 0.6], run: 3, fleeR: 9, fly: true, max: 3, range: 5 },
  deer: { speed: [0.8, 1.3], run: 7.5, fleeR: 17, max: 4, range: 14 },
  cow: { speed: [0.35, 0.6], run: 2.6, fleeR: 4.5, max: 6, range: 10 },
  dog: { speed: [1.6, 2.4], run: 5.5, fleeR: 0, max: 5, range: 0 },
  dolphin: { speed: [4.5, 6], run: 0, fleeR: 0, max: 2, range: 0 },
};
export interface AExt {
  kind: string; hasT: boolean; tx: number; tz: number; wait: number; ck: number; fails: number;
  hx: number; hz: number; // home
  cx: number; cz: number; rad: number; ang: number; dir: number; alt: number; // circling birds / dolphins
  flyUntil: number; altT: number; acc: number;
}
export const AEXT = new WeakMap<NpcEnt, AExt>();

export function makeAnimal(inst: Instance, kind: string, x: number, y: number, z: number): NpcEnt {
  const P = APROF[kind];
  const id = inst.nextId('n');
  const n: NpcEnt = {
    id, role: asRole('animal:' + kind), label: 'animal', x, y, z, yaw: Math.random() * 6.283, anim: 0,
    skin: Math.floor(Math.random() * 8), stunnedUntil: 0, downUntil: 0, alert: 0, activityKey: null, speed: rnd(P.speed[0], P.speed[1]), brain: {},
  };
  AEXT.set(n, { kind, hasT: false, tx: 0, tz: 0, wait: 0, ck: 0, fails: 0, hx: x, hz: z, cx: x, cz: z, rad: rnd(10, 30), ang: Math.random() * 6.283, dir: Math.random() < 0.5 ? 1 : -1, alt: P.fly && (kind === 'gull') ? rnd(9, 20) : 0, flyUntil: 0, altT: 0, acc: 0 });
  inst.npcs.set(id, n);
  return n;
}

export function countKind(inst: Instance, kind: string) {
  let c = 0;
  for (const n of inst.npcs.values()) if (n.role === 'animal:' + kind) c++;
  return c;
}

function trySpawnAnimal(inst: Instance, p: { phys: { x: number; z: number } }) {
  if (leoniaNav) { trySpawnAnimalLeonia(inst, p); return; }
  const ang = Math.random() * Math.PI * 2, d = 35 + Math.random() * 95;
  const x = p.phys.x + Math.cos(ang) * d, z = p.phys.z + Math.sin(ang) * d;
  if (!nav.inBounds(x, z)) return;
  if (tooClose(inst, x, z, 22)) return;
  const r = worldGen.r;
  const land = r.isLand(Math.floor(x), Math.floor(z));
  const zone = r.zoneAt(x, z), dist = r.distAt(x, z);
  const room = (k: string) => countKind(inst, k) < APROF[k].max;
  if (land && zone === 'wetland') {
    const kind = pickW([['gator', 40], ['heron', 30], ['egret', 30]] as const);
    if (!room(kind)) return;
    const f = footing(x, z), sw = kind === 'gator' ? shallowWater(x, z) : null;
    if (f !== null) makeAnimal(inst, kind, x, f, z);
    else if (sw !== null) makeAnimal(inst, kind, x, sw, z);
    return;
  }
  if (land && zone === 'forest' && room('deer')) {
    const f = footing(x, z);
    if (f !== null && !onRoad(x, z)) makeAnimal(inst, 'deer', x, f, z);
    return;
  }
  if (land && zone === 'farmland' && room('cow')) {
    const f = footing(x, z);
    if (f === null || onRoad(x, z)) return;
    const k = 1 + Math.floor(Math.random() * 3);
    for (let i = 0; i < k && room('cow'); i++) {
      const cx = x + rnd(-4, 4), cz = z + rnd(-4, 4), cf = footing(cx, cz);
      if (cf !== null) makeAnimal(inst, 'cow', cx, cf, cz);
    }
    return;
  }
  // coast: gulls and pelicans, dolphins out in the bay
  if (!land && dist > -14 && dist < 0 && room('dolphin') && Math.random() < 0.35 && voxels.getBlock(Math.floor(x), SEA_LEVEL, Math.floor(z)) === B.WATER) {
    const R = 9;
    let ok = true;
    for (let k = 0; k < 4 && ok; k++) ok = !r.isLand(Math.floor(x + Math.cos(k * 1.571) * R), Math.floor(z + Math.sin(k * 1.571) * R));
    if (ok) { const a = makeAnimal(inst, "dolphin", x, SEA_LEVEL + 0.85, z); const e = AEXT.get(a)!; e.cx = x; e.cz = z; e.rad = R * 0.8; }
    return;
  }
  if (dist > -10 && dist < 14) {
    if (!land) {
      const f = footing(x, z); // a pier or dock over the water
      if (f !== null && room('pelican')) makeAnimal(inst, 'pelican', x, f, z);
      else if (room('gull') && Math.random() < 0.6) { const a = makeAnimal(inst, 'gull', x, 30, z); a.y = 22 + AEXT.get(a)!.alt; }
      return;
    }
    if (room('gull') && Math.random() < 0.55) { const a = makeAnimal(inst, 'gull', x, 30, z); a.y = 22 + AEXT.get(a)!.alt; return; }
    const f = footing(x, z);
    if (f !== null && dist < 4 && room('pelican') && !onRoad(x, z)) makeAnimal(inst, 'pelican', x, f, z);
  }
}

export function wildlifeTick(inst: Instance, dt: number, cap: number) {
  const players = inst.activePlayers();
  const now = inst.now;
  const animals: NpcEnt[] = [];
  for (const n of inst.npcs.values()) if (isAnimal(n)) animals.push(n);
  for (const n of animals) {
    let near = false;
    for (const p of players) if (d2xz(p.phys.x, p.phys.z, n.x, n.z) < 165 * 165) { near = true; break; }
    const own = n.brain.owner;
    if (!near || (own && !inst.npcs.has(own))) inst.npcs.delete(n.id);
  }
  if (animals.length < cap && players.length && Math.random() < 0.25) trySpawnAnimal(inst, players[Math.floor(Math.random() * players.length)]);
  const tn = inst.tickNo;
  let idx = 0;
  for (const n of inst.npcs.values()) {
    if (!isAnimal(n)) continue;
    const a = AEXT.get(n);
    if (!a) continue;
    idx++;
    let md = Infinity;
    for (const p of players) { const q = d2xz(p.phys.x, p.phys.z, n.x, n.z); if (q < md) md = q; }
    const every = md > 70 * 70 ? 3 : md > 28 * 28 ? 2 : 1;
    a.acc += dt;
    if (every > 1 && (tn + idx) % every) continue;
    const sdt = a.acc; a.acc = 0;
    stepAnimal(inst, n, a, sdt, now);
  }
}

function threatened(inst: Instance, n: NpcEnt, R: number): { x: number; z: number } | null {
  let best: { x: number; z: number } | null = null, bd = R * R;
  for (const p of inst.players.values()) {
    if (p.linkdeadAt) continue;
    const q = d2xz(p.phys.x, p.phys.z, n.x, n.z);
    // sprinting/driving players spook from further away
    const sp = Math.hypot(p.phys.vx, p.phys.vz);
    if (q < bd * (sp > 5 ? 1.7 : 1)) { bd = q; best = p.phys; }
  }
  for (const v of inst.vehicles.values()) {
    if (Math.abs(v.phys.speed) < 3) continue;
    const q = d2xz(v.phys.x, v.phys.z, n.x, n.z);
    if (q < (R * 1.4) ** 2 && q < bd * 2) { bd = q; best = v.phys; }
  }
  return best;
}

function stepAnimal(inst: Instance, n: NpcEnt, a: AExt, dt: number, now: number) {
  const P = APROF[a.kind];
  if (n.downUntil > now || n.stunnedUntil > now) { n.anim = 6; return; }
  if (a.kind === 'gull') { circle(n, a, dt, 0); return; }
  if (a.kind === 'dolphin') { circle(n, a, dt, 1); return; }
  if (a.kind === 'dog') { stepDog(inst, n, a, dt, now); return; }
  const scared = (n.brain.fleeUntil ?? 0) > now;
  const thr = P.fleeR > 0 ? threatened(inst, n, P.fleeR) : null;
  // flying herons/pelicans: take off when disturbed, land again after a bit
  if (a.flyUntil > now) {
    const hd = a.ang;
    n.x += -Math.sin(hd) * 6.5 * dt; n.z += -Math.cos(hd) * 6.5 * dt;
    n.yaw = hd;
    a.altT = Math.min(7, a.altT + 8 * dt);
    n.y += (groundGuess(n.x, n.z) + a.altT - n.y) * Math.min(1, 3 * dt);
    n.anim = 4;
    if (now >= a.flyUntil) {
      const f = footing(n.x, n.z);
      if (f === null) a.flyUntil = now + 800; else { a.flyUntil = 0; a.altT = 0; n.y = f; n.anim = 0; a.hasT = false; }
    }
    return;
  }
  if ((thr || scared) && P.fly) {
    const src = thr ?? { x: n.x + rnd(-3, 3), z: n.z + rnd(-3, 3) };
    a.ang = Math.atan2(-(n.x - src.x), -(n.z - src.z)); // fly directly away from the threat
    a.flyUntil = now + rnd(4500, 8000); a.altT = 0;
    return;
  }
  let sp = n.speed;
  if (thr || scared) {
    const src = thr ?? { x: n.x + rnd(-3, 3), z: n.z + rnd(-3, 3) };
    const ax = n.x - src.x, az = n.z - src.z, al = Math.hypot(ax, az) || 1;
    a.tx = n.x + (ax / al) * 14; a.tz = n.z + (az / al) * 14; a.hasT = true; a.wait = 0;
    sp = P.run;
    if (!thr && scared) sp = P.run * 0.8;
  } else if (a.wait > now) { n.anim = 0; return; }
  if (!a.hasT) {
    const ang = Math.random() * 6.283, d = rnd(3, P.range || 6);
    const tx = a.hx + Math.cos(ang) * d * (0.4 + Math.random()), tz = a.hz + Math.sin(ang) * d * (0.4 + Math.random());
    if (!animalOk(a, tx, tz, n.y)) { a.wait = now + 1500; a.fails++; if (a.fails > 10) { a.hx = n.x; a.hz = n.z; a.fails = 0; } return; }
    a.tx = tx; a.tz = tz; a.hasT = true;
  }
  const dx = a.tx - n.x, dz = a.tz - n.z, d = Math.hypot(dx, dz);
  if (d < 0.5) { a.hasT = false; a.wait = now + rnd(2500, 10000) * (a.kind === 'heron' || a.kind === 'pelican' ? 2 : 1); n.anim = 0; return; }
  const st = Math.min(d, sp * dt);
  const px = n.x, pz = n.z;
  n.x += (dx / d) * st; n.z += (dz / d) * st;
  n.yaw = Math.atan2(-dx, -dz);
  n.anim = sp > P.speed[1] * 1.6 ? 2 : 1;
  a.ck += st;
  if (a.ck > 0.7) {
    a.ck = 0;
    const y = animalY(a, n.x, n.z);
    if (y === null || Math.abs(y - n.y) > 1.4) { n.x = px; n.z = pz; a.hasT = false; a.wait = now + 600; n.anim = 0; }
    else n.y = y;
  }
}

function animalY(a: AExt, x: number, z: number): number | null {
  const f = footing(x, z);
  if (f !== null) return f;
  if (APROF[a.kind].water) return shallowWater(x, z);
  return null;
}
function animalOk(a: AExt, x: number, z: number, y: number) {
  const v = animalY(a, x, z);
  if (v === null || Math.abs(v - y) > 2.5) return false;
  if (a.kind !== 'gator' && onRoad(x, z)) return false;
  return true;
}
function groundGuess(x: number, z: number) { return nav.surfaceY(x, z); }

/** gulls wheel overhead; dolphins arc through the bay. mode 0 = bird, 1 = dolphin */
function circle(n: NpcEnt, a: AExt, dt: number, mode: 0 | 1) {
  const sp = n.speed;
  a.ang += (sp / Math.max(6, a.rad)) * dt * a.dir;
  const px = n.x, pz = n.z;
  n.x = a.cx + Math.cos(a.ang) * a.rad; n.z = a.cz + Math.sin(a.ang) * a.rad;
  n.yaw = Math.atan2(-(n.x - px), -(n.z - pz));
  if (mode === 0) {
    a.alt += Math.sin(a.ang * 3.1) * 0.02;
    n.y = groundGuess(n.x, n.z) + a.alt + Math.sin(a.ang * 5) * 0.8;
    n.anim = 4;
    if (Math.random() < 0.0015) { a.cx += rnd(-8, 8); a.cz += rnd(-8, 8); a.rad = rnd(10, 32); }
  } else {
    const s = Math.sin(a.ang * 2.2);
    n.y = SEA_LEVEL + 0.85 + Math.max(0, s) * 2.4;
    n.anim = s > 0.15 ? 4 : 3;
  }
}

function stepDog(inst: Instance, n: NpcEnt, a: AExt, dt: number, now: number) {
  const o = n.brain.owner ? inst.npcs.get(n.brain.owner) : undefined;
  if (!o) return;
  if (o.anim === 5 || o.anim === 6) { n.anim = o.anim === 6 ? 7 : 5; n.y = o.y; return; }
  const fleeing = (n.brain.fleeUntil ?? 0) > now;
  // trot beside the owner, sniffing about when idle
  const wob = Math.sin(now / 900 + a.ang) * 1.2;
  const tx = o.x + Math.cos(a.ang) * 1.5 + wob * 0.3, tz = o.z + Math.sin(a.ang) * 1.5;
  const dx = tx - n.x, dz = tz - n.z, d = Math.hypot(dx, dz);
  if (Math.random() < 0.01) a.ang += rnd(-1.2, 1.2);
  n.y += (o.y - n.y) * Math.min(1, 8 * dt);
  if (d < 0.25 && !fleeing) { n.anim = 0; return; }
  const sp = d > 4 ? APROF.dog.run : d > 1.5 ? Math.max(2.6, o.speed * 1.5) : Math.max(1.3, o.speed * 1.1);
  const st = Math.min(d, sp * dt * (fleeing ? 1.6 : 1));
  n.x += (dx / d) * st; n.z += (dz / d) * st;
  n.yaw = Math.atan2(-dx, -dz);
  n.anim = sp > 4 || fleeing ? 2 : 1;
}

// ───────────────────────────────────────────────────────────── static NPCs
export function spawnStaticNpcs(inst: Instance) {
  for (const a of worldAnchors()) {
    if (a.kind !== 'npc') continue;
    const id = `n:${a.key}`;
    const role = a.rule ?? 'static';
    inst.npcs.set(id, {
      id, role: 'static', label: role, name: a.label, x: a.wx, y: a.wy, z: a.wz, yaw: a.yaw ?? 0, anim: 0,
      skin: Math.floor(hash2(a.wx, a.wz, 3) * 16), stunnedUntil: 0, downUntil: 0, alert: 0, activityKey: null, speed: 0, brain: {},
    });
  }
}

// ───────────────────────────────────────────────────────────── guards
export function spawnGuard(inst: Instance, key: string, patrol: [number, number, number][]) {
  const id = `n:${key}`;
  inst.npcs.set(id, {
    id, role: 'guard', label: 'guard', name: 'Security guard', x: patrol[0][0], y: patrol[0][1], z: patrol[0][2], yaw: 0, anim: 1,
    skin: 12, stunnedUntil: 0, downUntil: 0, alert: 0, activityKey: key, speed: 1.5,
    brain: { path: patrol.map((p) => ({ x: p[0], z: p[2] })), pi: 1, pauseUntil: 0 },
  });
}

export const GUARD_VIEW = 11;
export const GUARD_FOV = Math.cos((40 * Math.PI) / 180);

/** Guards patrol and build suspicion when they see a participant. Returns true if the alarm should trip. */
export function guardTick(inst: Instance, dt: number, alarm: boolean): { tripped: boolean; by?: string } {
  const now = inst.now;
  let tripped = false, by: string | undefined;
  for (const n of inst.npcs.values()) {
    if (n.role !== 'guard') continue;
    if (n.stunnedUntil > now) { n.anim = 6; n.alert = Math.max(0, n.alert - dt * 0.5); continue; }
    if (n.downUntil > now) { n.anim = 6; continue; }
    if (alarm) {
      n.alert = 1;
      // half the guards are armed and return fire; the rest cower
      const armed = hash2(n.x | 0, n.z | 0, 9) < 0.5 || n.brain.target === 'armed';
      if (!armed) { n.anim = 7; continue; }
      n.brain.target = 'armed';
      hostileShoot(inst, n, 18, 1100, 6);
      continue;
    }
    const b = n.brain;
    if (!b.pauseUntil || now >= b.pauseUntil) {
      const t = b.path![b.pi!];
      const dx = t.x - n.x, dz = t.z - n.z, d = Math.hypot(dx, dz);
      if (d < 0.3) { b.pi = (b.pi! + 1) % b.path!.length; b.pauseUntil = now + 2200; n.anim = 0; }
      else {
        n.x += (dx / d) * Math.min(d, n.speed * dt); n.z += (dz / d) * Math.min(d, n.speed * dt);
        n.yaw = Math.atan2(-dx, -dz); n.anim = 1;
      }
    } else {
      n.anim = 0;
      // look around while paused
      n.yaw += Math.sin(now / 700) * dt * 0.8;
    }
    // vision
    let seeing = 0;
    const fx = -Math.sin(n.yaw), fz = -Math.cos(n.yaw);
    for (const p of inst.players.values()) {
      if (p.linkdeadAt || p.downUntil) continue;
      const dx = p.phys.x - n.x, dz = p.phys.z - n.z, dy = (p.phys.y + 1.2) - (n.y + 1.6);
      const d = Math.hypot(dx, dz);
      if (d > GUARD_VIEW || d < 0.01) continue;
      const close = d < 2.2; // too close: noticed regardless of facing
      if (!close && (dx * fx + dz * fz) / d < GUARD_FOV) continue;
      const len = Math.hypot(dx, dy, dz);
      const hit = raycastVoxels(voxels, n.x, n.y + 1.6, n.z, dx / len, dy / len, dz / len, len);
      if (hit < len - 0.4) continue;
      seeing = Math.max(seeing, close ? 2.5 : d < 5 ? 1.6 : 1.0);
      by = p.userId;
    }
    if (seeing > 0) n.alert = Math.min(1, n.alert + dt * 0.9 * seeing);
    else n.alert = Math.max(0, n.alert - dt * 0.35);
    if (n.alert >= 1) tripped = true;
  }
  return { tripped, by };
}

/** NPC returns fire at the nearest visible player (non-graphic: knocks players out at 0 hp). */
export function hostileShoot(inst: Instance, n: NpcEnt, range: number, intervalMs: number, damage: number) {
  const now = inst.now;
  let best: { p: import('./entities.ts').PlayerEnt; d: number } | null = null;
  for (const p of inst.players.values()) {
    if (p.linkdeadAt || p.downUntil) continue;
    const dx = p.phys.x - n.x, dz = p.phys.z - n.z, d = Math.hypot(dx, dz);
    if (d > range) continue;
    const dy = p.phys.y + 1.2 - (n.y + 1.5), len = Math.hypot(dx, dy, dz);
    if (raycastVoxels(voxels, n.x, n.y + 1.5, n.z, dx / len, dy / len, dz / len, len) < len - 0.5) continue;
    if (!best || d < best.d) best = { p, d };
  }
  if (!best) { n.anim = 0; return; }
  n.yaw = Math.atan2(-(best.p.phys.x - n.x), -(best.p.phys.z - n.z));
  n.anim = 8;
  if (now < (n.shootAt ?? 0)) return;
  n.shootAt = now + intervalMs * (0.8 + Math.random() * 0.4);
  const hit = Math.random() < Math.max(0.25, 0.85 - best.d / 30) * (best.p.veh ? 0.5 : 1);
  const tx = best.p.phys.x + (hit ? 0 : (Math.random() - 0.5) * 3), tz = best.p.phys.z + (hit ? 0 : (Math.random() - 0.5) * 3);
  inst.game.shotFromNpc(inst, n.id, n.x, n.y + 1.5, n.z, tx, best.p.phys.y + 1.2, tz);
  if (hit) inst.damagePlayer(best.p, damage, 'police');
}

void ZONE_KINDS;

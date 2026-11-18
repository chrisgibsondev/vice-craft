/**
 * Shared deterministic movement code. The server runs it authoritatively; the
 * client runs the exact same functions for prediction + reconciliation.
 *
 * Conventions: yaw 0 looks toward -z (north). Forward vector = (-sin yaw, -cos yaw).
 */
import { SOLID, B } from './world/blocks.ts';
import { SEA_LEVEL } from './constants.ts';

export interface VoxelQuery { getBlock(x: number, y: number, z: number): number }
export interface AABB { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number }

export const PLAYER_HALF = 0.3;
export const PLAYER_HEIGHT = 1.8;
export const EYE_HEIGHT = 1.62;

export interface PlayerPhys {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  onGround: boolean;
  inWater: boolean;
}

export interface MoveInput {
  /** strafe -1..1 (right +) */ mx: number;
  /** forward -1..1 */ mz: number;
  yaw: number;
  jump: boolean;
  sprint: boolean;
}

const WALK = 4.4, SPRINT = 7.2, SWIM = 3.0, JUMP_V = 8.2, GRAVITY = 26;

function solidAt(w: VoxelQuery, x: number, y: number, z: number) {
  return SOLID[w.getBlock(Math.floor(x), Math.floor(y), Math.floor(z))] === 1;
}

function boxHitsWorld(w: VoxelQuery, b: AABB, extra?: AABB[]): boolean {
  const x0 = Math.floor(b.minX), x1 = Math.floor(b.maxX - 1e-6);
  const y0 = Math.floor(b.minY), y1 = Math.floor(b.maxY - 1e-6);
  const z0 = Math.floor(b.minZ), z1 = Math.floor(b.maxZ - 1e-6);
  for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    if (SOLID[w.getBlock(x, y, z)] === 1) return true;
  }
  if (extra) for (const e of extra) {
    if (b.minX < e.maxX && b.maxX > e.minX && b.minY < e.maxY && b.maxY > e.minY && b.minZ < e.maxZ && b.maxZ > e.minZ) return true;
  }
  return false;
}

function playerBox(x: number, y: number, z: number): AABB {
  return { minX: x - PLAYER_HALF, minY: y, minZ: z - PLAYER_HALF, maxX: x + PLAYER_HALF, maxY: y + PLAYER_HEIGHT, maxZ: z + PLAYER_HALF };
}

export function waterAt(w: VoxelQuery, x: number, y: number, z: number) {
  return w.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)) === B.WATER;
}

/** Advance a walking player by dt. Mutates `p`. */
export function stepPlayer(p: PlayerPhys, inp: MoveInput, dt: number, w: VoxelQuery, colliders?: AABB[]) {
  const inWater = waterAt(w, p.x, p.y + 0.6, p.z);
  p.inWater = inWater;
  let mx = Math.max(-1, Math.min(1, inp.mx)), mz = Math.max(-1, Math.min(1, inp.mz));
  const len = Math.hypot(mx, mz);
  if (len > 1) { mx /= len; mz /= len; }
  const s = Math.sin(inp.yaw), c = Math.cos(inp.yaw);
  const speed = inWater ? SWIM : inp.sprint ? SPRINT : WALK;
  const wantX = (-s * mz + c * mx) * speed;
  const wantZ = (-c * mz - s * mx) * speed;
  const accel = p.onGround || inWater ? 40 : 10;
  const k = Math.min(1, accel * dt / Math.max(0.001, speed));
  p.vx += (wantX - p.vx) * Math.min(1, k * 2.5);
  p.vz += (wantZ - p.vz) * Math.min(1, k * 2.5);

  if (inWater) {
    // Buoyancy: swimmers float up until their head is out of the water and tread water there, so they
    // never sink to the bottom (Space swims up faster). Surface = top of the water column above the body.
    let surf = Math.floor(p.y + 0.6);
    while (surf < Math.floor(p.y + 0.6) + 40 && waterAt(w, p.x, surf + 1, p.z)) surf++;
    const headUnder = surf + 1 - (p.y + 1.35); // > 0: head below the surface
    if (inp.jump) p.vy = Math.min(p.vy + 22 * dt, 3.2);
    else if (headUnder > 0.05) p.vy = Math.min(p.vy + 16 * dt, 2.6);
    else p.vy = Math.max(-0.4, p.vy - GRAVITY * 0.18 * dt);
    p.vy *= 1 - Math.min(1, 2.5 * dt);
  } else {
    p.vy -= GRAVITY * dt;
    if (inp.jump && p.onGround) p.vy = JUMP_V;
  }
  p.vy = Math.max(p.vy, -50);

  // Y (sub-stepped so fast falls cannot tunnel through one-block floors)
  let remaining = p.vy * dt;
  p.onGround = false;
  while (Math.abs(remaining) > 1e-6) {
    const step = Math.max(-0.8, Math.min(0.8, remaining));
    remaining -= step;
    const ny = p.y + step;
    if (boxHitsWorld(w, playerBox(p.x, ny, p.z), colliders)) {
      if (step < 0) {
        const top = Math.floor(ny) + 1;
        if (!boxHitsWorld(w, playerBox(p.x, top, p.z), colliders) && top <= p.y + 1e-6) p.y = top;
        p.onGround = true;
      }
      p.vy = 0;
      break;
    }
    p.y = ny;
  }

  // X / Z with auto step-up of one block when grounded
  const tryAxis = (dx: number, dz: number) => {
    const nx = p.x + dx, nz = p.z + dz;
    if (!boxHitsWorld(w, playerBox(nx, p.y, nz), colliders)) { p.x = nx; p.z = nz; return true; }
    if (p.onGround || inWater) {
      // grounded: step up one block. Swimming: climb out onto a seawall, dock or bank up to 3 blocks
      // above the water (needs clear headroom straight above the swimmer and a free spot on the ledge).
      const maxUp = inWater ? 4.6 : 1.05;
      for (let up = Math.floor(p.y + 1e-3) + 1; up - p.y <= maxUp; up++) {
        if (boxHitsWorld(w, playerBox(p.x, up, p.z), colliders)) break; // ceiling above: can't climb higher
        if (!boxHitsWorld(w, playerBox(nx, up, nz), colliders)) {
          p.x = nx; p.z = nz; p.y = up;
          if (inWater && up - p.y > 1.05) p.vy = 0;
          return true;
        }
      }
    }
    return false;
  };
  if (!tryAxis(p.vx * dt, 0)) p.vx = 0;
  if (!tryAxis(0, p.vz * dt)) p.vz = 0;

  // ground probe (stay grounded when walking down 1-block steps)
  if (!p.onGround && p.vy <= 0 && !inWater) {
    if (boxHitsWorld(w, playerBox(p.x, p.y - 0.05, p.z), colliders)) p.onGround = true;
  }
  if (p.y < 1) { p.y = 30; p.vy = 0; }
}

// ───────────────────────────────────────────────────────────── vehicles
export type VehicleModel = 'compact' | 'sedan' | 'sports' | 'pickup' | 'moto' | 'police' | 'van' | 'boat'
  | 'muscle' | 'supercar' | 'coupe' | 'luxury' | 'taxi' | 'ambulance' | 'firetruck' | 'bus' | 'limo' | 'classic' | 'buggy' | 'jetski';

export interface VehicleDef {
  model: VehicleModel;
  name: string;
  maxSpeed: number; reverse: number; accel: number; brake: number; turn: number; drag: number;
  length: number; width: number; height: number;
  seats: number; boat?: boolean; bike?: boolean;
  price: number; health: number;
  engineSfx: string;
}

export const VEHICLES: Record<VehicleModel, VehicleDef> = {
  compact: { model: 'compact', name: 'Dart Hatch', maxSpeed: 30, reverse: 9, accel: 13, brake: 26, turn: 2.4, drag: 0.08, length: 4.2, width: 1.65, height: 1.45, seats: 4, price: 6000, health: 900, engineSfx: 'engine_car' },
  sedan: { model: 'sedan', name: 'Meridian Sedan', maxSpeed: 34, reverse: 9, accel: 12, brake: 26, turn: 2.2, drag: 0.07, length: 4.6, width: 2.0, height: 1.6, seats: 4, price: 14000, health: 1100, engineSfx: 'engine_car' },
  sports: { model: 'sports', name: 'Vireo GT', maxSpeed: 48, reverse: 10, accel: 20, brake: 32, turn: 2.5, drag: 0.06, length: 4.4, width: 2.0, height: 1.25, seats: 2, price: 68000, health: 900, engineSfx: 'engine_sports' },
  pickup: { model: 'pickup', name: 'Bayou Hauler', maxSpeed: 32, reverse: 9, accel: 12, brake: 24, turn: 2.0, drag: 0.08, length: 5.0, width: 2.2, height: 2.0, seats: 2, price: 18000, health: 1500, engineSfx: 'engine_car' },
  moto: { model: 'moto', name: 'Kestrel 600', maxSpeed: 42, reverse: 5, accel: 19, brake: 30, turn: 3.0, drag: 0.07, length: 2.2, width: 0.9, height: 1.4, seats: 2, price: 11000, health: 600, bike: true, engineSfx: 'engine_moto' },
  police: { model: 'police', name: 'Interceptor', maxSpeed: 44, reverse: 10, accel: 17, brake: 30, turn: 2.4, drag: 0.07, length: 4.8, width: 2.0, height: 1.6, seats: 4, price: 0, health: 1400, engineSfx: 'engine_sports' },
  van: { model: 'van', name: 'Courier Van', maxSpeed: 27, reverse: 8, accel: 10, brake: 22, turn: 1.8, drag: 0.09, length: 5.2, width: 2.2, height: 2.5, seats: 4, price: 16000, health: 1600, engineSfx: 'engine_car' },
  boat: { model: 'boat', name: 'Reef Runner', maxSpeed: 32, reverse: 6, accel: 11, brake: 10, turn: 1.6, drag: 0.25, length: 5.5, width: 2.2, height: 1.4, seats: 4, boat: true, price: 24000, health: 1000, engineSfx: 'engine_boat' },
  // ── roster expansion (realistic-shaped Sketchfab models; all names fictional)
  muscle: { model: 'muscle', name: 'Ravager R/T', maxSpeed: 45, reverse: 10, accel: 18, brake: 30, turn: 2.2, drag: 0.065, length: 4.9, width: 2.1, height: 1.35, seats: 2, price: 38000, health: 1100, engineSfx: 'engine_sports' },
  supercar: { model: 'supercar', name: 'Vanta Strike', maxSpeed: 55, reverse: 10, accel: 24, brake: 34, turn: 2.6, drag: 0.055, length: 4.5, width: 2.2, height: 1.3, seats: 2, price: 120000, health: 800, engineSfx: 'engine_sports' },
  coupe: { model: 'coupe', name: 'Sable GT-S', maxSpeed: 44, reverse: 9, accel: 19, brake: 30, turn: 2.7, drag: 0.065, length: 4.4, width: 1.8, height: 1.35, seats: 2, price: 32000, health: 850, engineSfx: 'engine_sports' },
  luxury: { model: 'luxury', name: 'Marquess LX', maxSpeed: 38, reverse: 9, accel: 13, brake: 26, turn: 2.1, drag: 0.07, length: 5.0, width: 1.95, height: 1.35, seats: 4, price: 46000, health: 1200, engineSfx: 'engine_car' },
  taxi: { model: 'taxi', name: 'Metro Cab', maxSpeed: 33, reverse: 9, accel: 12, brake: 25, turn: 2.1, drag: 0.075, length: 5.2, width: 2.1, height: 1.8, seats: 4, price: 0, health: 1200, engineSfx: 'engine_car' },
  ambulance: { model: 'ambulance', name: 'Lifeline Medic', maxSpeed: 36, reverse: 8, accel: 13, brake: 26, turn: 1.9, drag: 0.08, length: 5.2, width: 2.4, height: 2.3, seats: 4, price: 0, health: 1500, engineSfx: 'engine_car' },
  firetruck: { model: 'firetruck', name: 'Blaze Engine', maxSpeed: 26, reverse: 7, accel: 8, brake: 20, turn: 1.5, drag: 0.1, length: 7.4, width: 3.1, height: 3.1, seats: 4, price: 0, health: 3000, engineSfx: 'engine_car' },
  bus: { model: 'bus', name: 'Cityline Bus', maxSpeed: 24, reverse: 6, accel: 7, brake: 18, turn: 1.3, drag: 0.11, length: 9.5, width: 2.75, height: 2.5, seats: 4, price: 0, health: 3500, engineSfx: 'engine_car' },
  limo: { model: 'limo', name: 'Regent Stretch', maxSpeed: 32, reverse: 8, accel: 10, brake: 22, turn: 1.7, drag: 0.08, length: 6.4, width: 1.55, height: 1.2, seats: 4, price: 55000, health: 1100, engineSfx: 'engine_car' },
  classic: { model: 'classic', name: 'Belvedere 60', maxSpeed: 36, reverse: 9, accel: 11, brake: 22, turn: 2.0, drag: 0.07, length: 5.6, width: 2.1, height: 1.4, seats: 4, price: 28000, health: 1000, engineSfx: 'engine_car' },
  buggy: { model: 'buggy', name: 'Dune Jackal', maxSpeed: 36, reverse: 9, accel: 16, brake: 26, turn: 3.0, drag: 0.07, length: 3.4, width: 2.4, height: 1.85, seats: 2, price: 22000, health: 700, engineSfx: 'engine_sports' },
  jetski: { model: 'jetski', name: 'Wavelet Ski', maxSpeed: 38, reverse: 5, accel: 14, brake: 10, turn: 2.4, drag: 0.22, length: 3.0, width: 1.0, height: 0.9, seats: 2, boat: true, price: 15000, health: 500, engineSfx: 'engine_boat' },
};

export interface VehiclePhys {
  x: number; y: number; z: number; yaw: number;
  speed: number; vy: number; steer: number;
  onGround: boolean;
  /** collision impact speed recorded during the last step (for damage + sfx) */
  impact: number;
  drowned: boolean;
}

export interface VehInput { th: number; st: number; hb: boolean }

function groundUnder(w: VoxelQuery, x: number, y: number, z: number): number {
  // highest solid block top in [y-3, y+1.2]
  const bx = Math.floor(x), bz = Math.floor(z);
  for (let by = Math.floor(y + 1.2); by >= Math.floor(y - 3); by--) {
    if (SOLID[w.getBlock(bx, by, bz)] === 1) return by + 1;
  }
  return -Infinity;
}

export function stepVehicle(v: VehiclePhys, inp: VehInput, dt: number, w: VoxelQuery, def: VehicleDef, colliders?: AABB[]) {
  v.impact = 0;
  const th = Math.max(-1, Math.min(1, inp.th));
  const st = Math.max(-1, Math.min(1, inp.st));
  v.steer += (st - v.steer) * Math.min(1, 8 * dt);

  const s = Math.sin(v.yaw), c = Math.cos(v.yaw);
  // boats: need water under the hull
  const waterBelow = waterAt(w, v.x, SEA_LEVEL, v.z);
  const grounded = def.boat ? waterBelow : v.onGround;
  const traction = def.boat ? (waterBelow ? 1 : 0.05) : grounded ? 1 : 0.15;

  if (!v.drowned) {
    if (th > 0) {
      if (v.speed < -0.5) v.speed += def.brake * th * dt * traction;
      else v.speed += def.accel * th * dt * traction * (1 - Math.max(0, v.speed) / def.maxSpeed * 0.65);
    } else if (th < 0) {
      if (v.speed > 0.5) v.speed += def.brake * th * dt * traction;
      else v.speed = Math.max(-def.reverse, v.speed + def.accel * 0.6 * th * dt * traction);
    }
  }
  if (inp.hb) v.speed -= Math.sign(v.speed) * Math.min(Math.abs(v.speed), def.brake * 0.8 * dt);
  v.speed *= 1 - Math.min(1, (def.drag + (th === 0 ? 0.25 : 0) + (def.boat && !waterBelow ? 4 : 0)) * dt);
  if (Math.abs(v.speed) < 0.05 && th === 0) v.speed = 0;
  v.speed = Math.max(-def.reverse, Math.min(def.maxSpeed, v.speed));

  // steering
  const spd = Math.abs(v.speed);
  const steerAuthority = Math.min(1, spd / 6) * (1 - 0.45 * Math.min(1, spd / def.maxSpeed));
  const yawRate = v.steer * def.turn * steerAuthority * Math.sign(v.speed || 1) * (inp.hb ? 1.5 : 1) * (grounded ? 1 : 0.2);
  v.yaw -= yawRate * dt;

  // planar move with collision
  const nx = v.x + -Math.sin(v.yaw) * v.speed * dt;
  const nz = v.z + -Math.cos(v.yaw) * v.speed * dt;
  if (bodyHits(w, nx, v.y, nz, v.yaw, def, colliders)) {
    // try a step up (kerbs / one-block bumps) for wheeled vehicles
    if (!def.boat && !bodyHits(w, nx, v.y + 1, nz, v.yaw, def, colliders) && v.onGround) {
      v.x = nx; v.z = nz; v.y += 1;
    } else {
      v.impact = Math.abs(v.speed);
      v.speed = -v.speed * 0.25;
    }
  } else { v.x = nx; v.z = nz; }
  void s; void c;

  // vertical
  if (def.boat) {
    const target = waterBelow ? SEA_LEVEL + 0.75 : groundUnder(w, v.x, v.y, v.z);
    if (target === -Infinity) v.vy -= GRAVITY * dt;
    else { v.y += (target - v.y) * Math.min(1, 6 * dt); v.vy = 0; }
    v.y += v.vy * dt;
    v.onGround = true;
  } else {
    let g = -Infinity;
    const hl = def.length / 2 - 0.3, hw = def.width / 2 - 0.2;
    const fx = -Math.sin(v.yaw), fz = -Math.cos(v.yaw), rx = Math.cos(v.yaw), rz = -Math.sin(v.yaw);
    for (const [a, b2] of [[hl, hw], [hl, -hw], [-hl, hw], [-hl, -hw], [0, 0]]) {
      g = Math.max(g, groundUnder(w, v.x + fx * a + rx * b2, v.y, v.z + fz * a + rz * b2));
    }
    if (g !== -Infinity && g >= v.y - 0.05) {
      // rise smoothly onto steps
      v.y = g > v.y ? Math.min(g, v.y + 9 * dt) : g;
      v.vy = 0; v.onGround = true;
    } else {
      v.vy -= GRAVITY * dt;
      v.y += v.vy * dt;
      if (g !== -Infinity && v.y <= g) { v.y = g; v.vy = 0; v.onGround = true; } else v.onGround = false;
    }
    // sinking in water
    if (waterAt(w, v.x, v.y + 0.4, v.z)) {
      v.speed *= 1 - Math.min(1, 3 * dt);
      if (waterAt(w, v.x, v.y + 1.2, v.z)) v.drowned = true;
    }
  }
  if (v.y < 1) { v.y = 1; v.vy = 0; }
}

function bodyHits(w: VoxelQuery, x: number, y: number, z: number, yaw: number, def: VehicleDef, colliders?: AABB[]): boolean {
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
  const hl = def.length / 2, hw = def.width / 2;
  const samples: [number, number][] = [[hl, hw * 0.9], [hl, -hw * 0.9], [hl, 0], [-hl, hw * 0.9], [-hl, -hw * 0.9], [0, hw], [0, -hw], [hl * 0.5, hw], [hl * 0.5, -hw], [-hl * 0.5, hw], [-hl * 0.5, -hw]];
  const ys = def.boat ? [y + 0.4] : [y + 0.5, y + Math.min(1.4, def.height - 0.1)];
  for (const [a, b] of samples) {
    const px = x + fx * a + rx * b, pz = z + fz * a + rz * b;
    for (const yy of ys) {
      if (solidAt(w, px, yy, pz)) return true;
      if (colliders) for (const e of colliders) if (px > e.minX && px < e.maxX && yy > e.minY && yy < e.maxY && pz > e.minZ && pz < e.maxZ) return true;
    }
  }
  return false;
}

/** Seat offsets (local: right, up, forward) for camera/avatars. */
/** per-model seat tables (right, up, forward) where the generic layout does not fit the body */
const SEAT_TABLES: Partial<Record<string, [number, number, number][]>> = {
  jetski: [[0, 0.62, 0.05], [0, 0.68, -0.55]],
  bus: [[-0.75, 1.0, 3.4], [0.75, 1.0, 2.4], [-0.75, 1.0, 0.8], [0.75, 1.0, -1.2]],
  firetruck: [[-0.7, 1.25, 2.2], [0.7, 1.25, 2.2], [-0.7, 1.25, 1.0], [0.7, 1.25, 1.0]],
  ambulance: [[-0.5, 0.75, 1.0], [0.5, 0.75, 1.0], [-0.5, 0.75, -1.2], [0.5, 0.75, -1.2]],
  limo: [[-0.4, 0.45, 1.1], [0.4, 0.45, 1.1], [-0.4, 0.45, -1.5], [0.4, 0.45, -1.5]],
};

export function seatOffset(def: VehicleDef, seat: number): [number, number, number] {
  const tbl = SEAT_TABLES[def.model];
  if (tbl) return tbl[Math.max(0, Math.min(tbl.length - 1, seat))].slice() as [number, number, number];
  if (def.bike) return seat === 0 ? [0, 0.9, 0.1] : [0, 1.0, -0.5];
  if (def.boat) return [[-0.5, 0.9, 0.6], [0.5, 0.9, 0.6], [-0.5, 0.9, -1.0], [0.5, 0.9, -1.0]][seat] as [number, number, number];
  const front = def.seats === 2 || seat < 2;
  return [seat % 2 === 0 ? -0.45 : 0.45, 0.55, front ? 0.15 : -0.85];
}

export function angleDiff(a: number, b: number) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Voxel ray cast (for LOS / shooting). Returns distance to first solid block or Infinity. */
export function raycastVoxels(w: VoxelQuery, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): number {
  let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
  const sx = Math.sign(dx), sy = Math.sign(dy), sz = Math.sign(dz);
  const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity, tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity, tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
  let tmx = dx !== 0 ? ((sx > 0 ? x + 1 - ox : ox - x) * tdx) : Infinity;
  let tmy = dy !== 0 ? ((sy > 0 ? y + 1 - oy : oy - y) * tdy) : Infinity;
  let tmz = dz !== 0 ? ((sz > 0 ? z + 1 - oz : oz - z) * tdz) : Infinity;
  let t = 0;
  while (t <= maxDist) {
    const id = w.getBlock(x, y, z);
    if (SOLID[id] === 1 && id !== B.GLASS) return t;
    if (tmx < tmy && tmx < tmz) { x += sx; t = tmx; tmx += tdx; }
    else if (tmy < tmz) { y += sy; t = tmy; tmy += tdy; }
    else { z += sz; t = tmz; tmz += tdz; }
  }
  return Infinity;
}

/**
 * Placement frames: stamp a 48×48 lot-local prefab (structures.ts) anywhere in a world with a
 * rotation in 90° steps. Used by Leonia, where the enterable buildings sit at real street
 * addresses instead of on Palmara's 48-block lot grid.
 *
 * A frame is the world position of the lot centre (local 24,24; integer, so cells map 1:1)
 * plus `rot` = clockwise quarter turns. The prefab front (local −z, "north") then faces:
 * rot 0 → north (−z), 1 → east (+x), 2 → south (+z), 3 → west (−x).
 * Local (u, v) = (lx − 24, lz − 24) maps to world O + R(u, v) with
 * R0 = (u, v), R1 = (−v, u), R2 = (−u, −v), R3 = (v, −u).
 * Yaws (forward = (−sin yaw, −cos yaw)) rotate by −rot·π/2.
 */
import { LOT } from './structures.ts';

export type Rot = 0 | 1 | 2 | 3;
export interface Frame { ox: number; oz: number; rot: Rot }

const H = LOT / 2;

function rotate(rot: Rot, u: number, v: number): [number, number] {
  switch (rot) {
    case 0: return [u, v];
    case 1: return [-v, u];
    case 2: return [-u, -v];
    default: return [v, -u];
  }
}
function unrotate(rot: Rot, a: number, b: number): [number, number] {
  switch (rot) {
    case 0: return [a, b];
    case 1: return [b, -a];
    case 2: return [-a, -b];
    default: return [-b, a];
  }
}

/** continuous lot-local point → world */
export function frameToWorld(f: Frame, lx: number, lz: number): [number, number] {
  const [a, b] = rotate(f.rot, lx - H, lz - H);
  return [f.ox + a, f.oz + b];
}
/** continuous world point → lot-local */
export function worldToFrame(f: Frame, x: number, z: number): [number, number] {
  const [u, v] = unrotate(f.rot, x - f.ox, z - f.oz);
  return [u + H, v + H];
}
/** world block column → lot-local block column (may be outside 0..47) */
export function frameCellOf(f: Frame, cx: number, cz: number): [number, number] {
  const [u, v] = unrotate(f.rot, cx + 0.5 - f.ox, cz + 0.5 - f.oz);
  return [Math.floor(u + H), Math.floor(v + H)];
}
export function frameYaw(f: Frame, yaw: number): number {
  let y = yaw - (f.rot * Math.PI) / 2;
  while (y > Math.PI) y -= Math.PI * 2;
  while (y <= -Math.PI) y += Math.PI * 2;
  return y;
}
/**
 * A door anchor spans cells x..x+w−1 (axis 'x') or z..z+w−1 (axis 'z') of one row. Returns the
 * rotated door's world min corner and axis.
 */
export function frameDoor(f: Frame, x: number, z: number, axis: 'x' | 'z', w: number): { x: number; z: number; axis: 'x' | 'z' } {
  const x1 = axis === 'x' ? x + w : x + 1, z1 = axis === 'z' ? z + w : z + 1;
  const [ax, az] = frameToWorld(f, x, z), [bx, bz] = frameToWorld(f, x1, z1);
  const odd = f.rot % 2 === 1;
  return { x: Math.min(ax, bx), z: Math.min(az, bz), axis: odd ? (axis === 'x' ? 'z' : 'x') : axis };
}
/** world-aligned rectangle [x0,x1)×[z0,z1) covered by a lot-local rectangle [lx0,lx1)×[lz0,lz1) */
export function frameRect(f: Frame, lx0: number, lz0: number, lx1: number, lz1: number): [number, number, number, number] {
  const [ax, az] = frameToWorld(f, lx0, lz0), [bx, bz] = frameToWorld(f, lx1, lz1);
  return [Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz)];
}
/** world direction the prefab entrance faces (unit vector) */
export function frameFront(f: Frame): [number, number] { return rotate(f.rot, 0, -1) as [number, number]; }

/**
 * The part of the lot a placed prefab claims (lot-local, half-open): everything except the
 * street band in front (z < 4) and the side/back street bands of the Palmara lot layout.
 * Generated buildings touching it are removed, the ground is levelled to a sidewalk pad and
 * the prefab is stamped on top.
 */
export const PAD = { x0: 5, z0: 4, x1: 43, z1: 43 } as const;

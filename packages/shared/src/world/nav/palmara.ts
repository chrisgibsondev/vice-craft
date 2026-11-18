/**
 * PalmaraNav: the hand-authored map's 48-block city grid, wrapping the stage-1 logic that
 * npc.ts / police.ts / game.ts used directly (streetOk, segmentOk, gridWaypoint, the
 * "nearest street spot" delivery formula). Behaviour is unchanged.
 */
import type { WorldGen } from '../worldgen.ts';
import type { ZoneKind } from '../mapTypes.ts';
import { B } from '../blocks.ts';
import { SEA_LEVEL } from '../../constants.ts';
import type { LaneSpot, NavPoint, NavVoxels, PursuitState, WalkKind, WalkSpot, WorldNav } from './types.ts';

export const GRID = 48;
const URBANISH = new Set<ZoneKind>(['suburb', 'urban', 'downtown', 'industrial', 'resort']);

/** Manhattan routing on the city grid: head for the next intersection toward the goal. */
export function gridWaypoint(x: number, z: number, gx: number, gz: number): NavPoint {
  const G = GRID;
  const cx = Math.round(x / G) * G, cz = Math.round(z / G) * G;
  const onV = Math.abs(x - cx) < 6, onH = Math.abs(z - cz) < 6;
  const tx = Math.round(gx / G) * G, tz = Math.round(gz / G) * G;
  if (onV && onH) {
    if (Math.abs(tx - cx) >= Math.abs(tz - cz) && tx !== cx) return { x: cx + Math.sign(tx - cx) * G, z: cz };
    if (tz !== cz) return { x: cx, z: cz + Math.sign(tz - cz) * G };
    return { x: gx, z: gz };
  }
  if (onV) {
    const nz = gz > z ? Math.ceil(z / G) * G : Math.floor(z / G) * G;
    return { x: cx, z: nz === cz && Math.abs(z - nz) < 3 ? nz + Math.sign(gz - z) * G : nz };
  }
  if (onH) {
    const nx = gx > x ? Math.ceil(x / G) * G : Math.floor(x / G) * G;
    return { x: nx, z: cz };
  }
  return { x: cx, z: cz };
}

export class PalmaraNav implements WorldNav {
  readonly world = 'palmara' as const;
  readonly graph = null;
  readonly width: number; readonly depth: number;
  constructor(readonly gen: WorldGen, readonly vox: NavVoxels, size: { width: number; depth: number }) {
    this.width = size.width; this.depth = size.depth;
  }

  inBounds(x: number, z: number) { return x >= 0 && z >= 0 && x < this.width && z < this.depth; }
  /** stage-1 `streetOk`: on land in an urban-ish zone */
  isStreet(x: number, z: number): boolean {
    if (!this.inBounds(x, z)) return false;
    if (!this.gen.r.isLand(Math.floor(x), Math.floor(z))) return false;
    return URBANISH.has(this.gen.r.zoneAt(x, z));
  }
  /** stage-1 `segmentOk`: five samples along a grid segment */
  segmentOk(ax: number, az: number, bx: number, bz: number) {
    const s = (x: number, z: number) => this.isStreet(x, z);
    return s(ax, az) && s(bx, bz) && s((ax + bx) / 2, (az + bz) / 2) && s(ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25) && s(ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75);
  }
  isRoad(x: number, z: number) {
    const li = this.gen.lineInfo(Math.floor(x), Math.floor(z));
    return !!li.road || li.roadDist < 1.2;
  }
  zoneAt(x: number, z: number): ZoneKind { return this.gen.r.zoneAt(x, z); }
  isWater(x: number, z: number) { return !this.gen.r.isLand(Math.floor(x), Math.floor(z)); }
  coastDist(x: number, z: number) { return this.gen.r.distAt(x, z); }
  groundTop(x: number, z: number) { const bx = Math.floor(x), bz = Math.floor(z); return this.gen.r.isLand(bx, bz) ? this.gen.terrainTop(bx, bz) : 21; }
  surfaceY(x: number, z: number) { const bx = Math.floor(x), bz = Math.floor(z); return (this.gen.r.isLand(bx, bz) ? this.gen.terrainTop(bx, bz) : 20) + 1; }

  /** nearest grid street lane (right-hand side of the closer street line) */
  nearestRoad(x: number, z: number): LaneSpot | null {
    const G = GRID;
    const gx = Math.round(x / G) * G, gz = Math.round(z / G) * G;
    const onX = Math.abs(x - gx) < Math.abs(z - gz); // closer to a north-south street (x = gx)
    if (onX) {
      // north-south street at x = gx: the east lane runs north (dir -1), the west lane south (dir +1)
      const east = x >= gx;
      return { x: gx + (east ? 2 : -2), y: 22, z, yaw: east ? 0 : Math.PI, edge: -1, dir: east ? -1 : 1, s: 0, lane: 0, offset: 2, speed: 10, cls: 0 };
    }
    // east-west street at z = gz: the south lane runs east (dir +1), the north lane west (dir -1)
    const south = z >= gz;
    return { x, y: 22, z: gz + (south ? 2 : -2), yaw: south ? -Math.PI / 2 : Math.PI / 2, edge: -1, dir: south ? 1 : -1, s: 0, lane: 0, offset: 2, speed: 10, cls: 0 };
  }
  randomLaneNear(x: number, z: number, rMin: number, rMax: number): LaneSpot | null {
    const G = GRID;
    for (let tries = 0; tries < 8; tries++) {
      const ang = Math.random() * Math.PI * 2, d = rMin + Math.random() * (rMax - rMin);
      const ix = Math.round((x + Math.cos(ang) * d) / G) * G, iz = Math.round((z + Math.sin(ang) * d) / G) * G;
      if (!this.isStreet(ix, iz)) continue;
      return { x: ix, y: 22, z: iz, yaw: 0, edge: -1, dir: 1, s: 0, lane: 0, offset: 0, speed: 10, cls: 0 };
    }
    return null;
  }
  nextEdge() { return null; }
  route(ax: number, az: number, bx: number, bz: number): NavPoint[] | null {
    const out: NavPoint[] = [];
    let x = ax, z = az;
    for (let k = 0; k < 64; k++) {
      const wp = gridWaypoint(x, z, bx, bz);
      out.push(wp);
      if (wp.x === bx && wp.z === bz) return out;
      if (wp.x === x && wp.z === z) break;
      x = wp.x; z = wp.z;
    }
    out.push({ x: bx, z: bz });
    return out;
  }
  pursuitWaypoint(_s: PursuitState, x: number, z: number, gx: number, gz: number): NavPoint { return gridWaypoint(x, z, gx, gz); }
  /** stage-1 game.ts delivery formula: nearest street line, 6 m ahead along it */
  deliverySpot(x: number, z: number): { x: number; z: number; yaw: number } {
    const gx = Math.round(x / GRID) * GRID, gz = Math.round(z / GRID) * GRID;
    const onX = Math.abs(x - gx) < Math.abs(z - gz);
    return { x: onX ? gx + 2 : x + 6, z: onX ? z + 6 : gz + 2, yaw: onX ? 0 : Math.PI / 2 };
  }
  boatSpot() { return null; }
  walkKindAt(x: number, z: number): WalkKind | null {
    if (!this.inBounds(x, z) || this.isWater(x, z)) return null;
    if (this.isRoad(x, z)) return null;
    const top = this.groundTop(x, z);
    const g = this.vox.getBlock(Math.floor(x), top, Math.floor(z));
    return g === B.SAND ? 'beach' : g === B.SIDEWALK ? 'sidewalk' : g === B.GRASS ? 'park' : 'open';
  }
  randomWalkSpot(x: number, z: number, rMin: number, rMax: number): WalkSpot | null {
    const ang = Math.random() * Math.PI * 2, d = rMin + Math.random() * (rMax - rMin);
    const px = x + Math.cos(ang) * d, pz = z + Math.sin(ang) * d;
    const k = this.walkKindAt(px, pz);
    return k ? { x: px, z: pz, kind: k } : null;
  }
}
void SEA_LEVEL;

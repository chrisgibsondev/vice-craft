/**
 * Landmarks (unique hand-placed structures at fixed coordinates, built once and
 * cached per chunk) plus procedurally scattered features (cabins, farmsteads, stilt
 * houses, piers, roadside stops...). Everything is a pure function of the map data
 * and the deterministic hashes, so the server and every client worker stamp the same
 * blocks no matter how the world is cut into regions.
 */
import { B, letterBlock } from './blocks.ts';
import { hash2, hashInt } from './noise.ts';
import { RG, BILLBOARDS, type LotKind } from './regions.ts';
import type { MapData, ZoneKind } from './mapTypes.ts';

/** world-space block sink */
export interface Sink { set(x: number, y: number, z: number, id: number): void }
/** the bits of WorldGen the builders need (kept structural to avoid an import cycle) */
export interface GenProbe {
  terrainTop(x: number, z: number): number;
  isLandAt(x: number, z: number): boolean;
  roadDistAt(x: number, z: number): number;
  onRoad(x: number, z: number): boolean;
  zoneAt(x: number, z: number): ZoneKind;
  regionAt(x: number, z: number): number;
  distAt(x: number, z: number): number;
  waterBodyAt(x: number, z: number): number;
}

const URBAN = new Set<ZoneKind>(['suburb', 'urban', 'downtown', 'industrial', 'resort']);
const COLORS = [B.STUCCO_PINK, B.STUCCO_TEAL, B.STUCCO_YELLOW, B.STUCCO_SKY, B.STUCCO_MINT, B.STUCCO_LAVENDER, B.AWNING_RED, B.AWNING_BLUE];
const SIDING = [B.SIDING_MINT, B.SIDING_CORAL, B.SIDING_LEMON, B.SIDING_SKY, B.SIDING_LILAC, B.SIDING_WHITE];
const AWN = [B.AWNING_RED, B.AWNING_GREEN, B.AWNING_BLUE, B.AWNING_YELLOW];

// ───────────────────────────────────────────────────────────── drawing helpers
export class Draw {
  constructor(public s: Sink) {}
  set(x: number, y: number, z: number, id: number) { if (y >= 0 && y < 128) this.s.set(x, y, z, id); }
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number) {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.set(x, y, z, id);
  }
  walls(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number) {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) if (x === x0 || x === x1 || z === z0 || z === z1) this.set(x, y, z, id);
  }
  cyl(cx: number, cz: number, r: number, y0: number, y1: number, id: number, shell = false) {
    const ri = Math.ceil(r), r2 = r * r + r * 0.6, ri2 = (r - 1) * (r - 1) + (r - 1) * 0.6;
    for (let dz = -ri; dz <= ri; dz++) for (let dx = -ri; dx <= ri; dx++) {
      const d = dx * dx + dz * dz;
      if (d > r2 || (shell && d <= ri2 && r > 1)) continue;
      for (let y = y0; y <= y1; y++) this.set(cx + dx, y, cz + dz, id);
    }
  }
  /** cone from radius r at y0 to a point at y0+h */
  cone(cx: number, cz: number, r: number, y0: number, h: number, id: number) {
    for (let k = 0; k <= h; k++) { const rr = r * (1 - k / (h + 1)); this.cyl(cx, cz, Math.max(0.3, rr), y0 + k, y0 + k, id); }
  }
  sphere(cx: number, cy: number, cz: number, r: number, id: number, top = false) {
    const ri = Math.ceil(r);
    for (let dy = top ? 0 : -ri; dy <= ri; dy++) for (let dz = -ri; dz <= ri; dz++) for (let dx = -ri; dx <= ri; dx++) {
      if (dx * dx + dy * dy + dz * dz <= r * r + r * 0.5) this.set(cx + dx, cy + dy, cz + dz, id);
    }
  }
  line(ax: number, ay: number, az: number, bx: number, by: number, bz: number, id: number) {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay), Math.abs(bz - az))));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      this.set(Math.round(ax + (bx - ax) * t), Math.round(ay + (by - ay) * t), Math.round(az + (bz - az) * t), id);
    }
  }
  /** Text of letter blocks. face = side the reader stands on. Centred on c (x for N/S, z for E/W). */
  text(str: string, c: number, y: number, at: number, face: 'N' | 'S' | 'E' | 'W') {
    const n = str.length;
    for (let i = 0; i < n; i++) {
      const id = letterBlock(str[i]);
      if (face === 'S') this.set(c - (n >> 1) + i, y, at, id);
      else if (face === 'N') this.set(c + ((n - 1) >> 1) - i, y, at, id);
      else if (face === 'E') this.set(at, y, c + ((n - 1) >> 1) - i, id);
      else this.set(at, y, c - (n >> 1) + i, id);
    }
  }
  palm(x: number, y: number, z: number, h: number) {
    for (let k = 0; k < h; k++) this.set(x, y + k, z, B.PALM_LOG);
    const t = y + h;
    this.set(x, t, z, B.LEAVES);
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) for (let k = 1; k <= 3; k++) this.set(x + dx * k, t - (k === 3 ? 1 : 0), z + dz * k, B.PALM_LEAVES);
    for (const [dx, dz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) { this.set(x + dx, t, z + dz, B.PALM_LEAVES); this.set(x + dx * 2, t - 1, z + dz * 2, B.PALM_LEAVES); }
  }
  lamp(x: number, y: number, z: number, h = 4) { for (let k = 0; k < h; k++) this.set(x, y + k, z, B.METAL); this.set(x, y + h, z, B.LAMP); }
  /** simple gable-roofed house, front facing -z */
  cottage(x0: number, y: number, z0: number, w: number, d: number, wall: number, roof: number, storeys = 1) {
    const h = storeys * 4;
    this.box(x0, y, z0, x0 + w - 1, y + h - 1, z0 + d - 1, wall);
    for (let k = 1; k < h; k += 4) for (let x = x0 + 1; x < x0 + w - 1; x += 2) { this.set(x, y + k, z0, B.WINDOW); this.set(x, y + k + 1, z0, B.WINDOW); this.set(x, y + k, z0 + d - 1, B.WINDOW); }
    this.set(x0 + (w >> 1), y, z0, B.DARK_PLANK); this.set(x0 + (w >> 1), y + 1, z0, B.DARK_PLANK);
    const half = Math.ceil(w / 2);
    for (let k = 0; k <= half; k++) for (let z = z0 - 1; z <= z0 + d; z++) {
      this.set(x0 - 1 + k, y + h + k, z, roof); this.set(x0 + w - k, y + h + k, z, roof);
      if (k > 0 && (z === z0 || z === z0 + d - 1)) for (let x = x0 + k; x <= x0 + w - 1 - k; x++) this.set(x, y + h + k - 1, z, wall);
    }
  }
}

/** Records a builder's blocks once, bucketed by 16x16 chunk, for fast replay. */
class Recorder implements Sink {
  buckets = new Map<number, number[]>();
  set(x: number, y: number, z: number, id: number) {
    const key = (z >> 4) * 1024 + (x >> 4);
    let a = this.buckets.get(key);
    if (!a) this.buckets.set(key, (a = []));
    a.push((x & 15) | ((z & 15) << 4) | (y << 8) | (id << 15));
  }
}

// ───────────────────────────────────────────────────────────── landmarks
export interface Landmark {
  id: string;
  name: string;
  /** block bounds [x0, z0, x1, z1] (inclusive) */
  bbox: [number, number, number, number];
  /** area kept flat and free of trees / decorations */
  flat: [number, number, number, number];
  /** lots (i, j) taken over: urban generation leaves them empty, or uses the given kind */
  lots?: [number, number, LotKind][];
  build(d: Draw, g: GenProbe): void;
}

const G = 22;

function starfallPark(d: Draw) {
  const X0 = 1588, Z0 = 1652, X1 = 1716, Z1 = 1820;
  const AV = 1652; // north-south avenue centre x
  // grounds
  for (let z = Z0; z <= Z1; z++) for (let x = X0; x <= X1; x++) {
    const onAve = Math.abs(x - AV) <= 4 || (z >= 1672 && z <= 1676);
    const ring = Math.abs(Math.hypot(x - AV, z - 1730) - 30) < 2.5;
    const loop = Math.abs(Math.hypot((x - 1652) / 1.9, z - 1790) - 26) < 2.2;
    d.set(x, 21, z, onAve || ring || loop ? ((x + z) % 7 === 0 ? B.MARBLE : B.COBBLE) : B.GRASS);
    if (!(onAve || ring || loop)) { const h = hash2(x, z, 404); if (h < 0.05) d.set(x, G, z, B.FLOWERS); else if (h < 0.08) d.set(x, G, z, B.FLOWERS_BLUE); else if (h < 0.1) d.set(x, G, z, B.FLOWERS_WHITE); }
    if (x === X0 || x === X1 || z === Z1 || (z === Z0 && Math.abs(x - AV) > 12)) d.set(x, G, z, B.IRON_RAIL);
  }
  // entrance gate with the park name
  d.box(1638, G, 1654, 1641, G + 13, 1657, B.CASTLE_STONE);
  d.box(1663, G, 1654, 1666, G + 13, 1657, B.CASTLE_STONE);
  d.cone(1639, 1655, 2.5, G + 14, 6, B.CASTLE_ROOF); d.cone(1664, 1655, 2.5, G + 14, 6, B.CASTLE_ROOF);
  d.box(1638, G + 9, 1655, 1666, G + 12, 1656, B.CASTLE_ROOF);
  d.box(1638, G + 13, 1655, 1666, G + 13, 1656, B.GOLD_TRIM);
  d.text('STARFALL PARK', AV, G + 11, 1654, 'N');
  d.text('STARFALL PARK', AV, G + 11, 1657, 'S');
  for (let k = 0; k < 5; k++) { d.set(AV, G + 15 + k, 1655, B.NEON_YELLOW); d.set(AV - 2 + k, G + 17, 1655, B.NEON_YELLOW); }
  d.set(AV - 1, G + 18, 1655, B.NEON_YELLOW); d.set(AV + 1, G + 16, 1655, B.NEON_YELLOW); d.set(AV + 1, G + 18, 1655, B.NEON_YELLOW); d.set(AV - 1, G + 16, 1655, B.NEON_YELLOW);
  // castle
  const cx = 1652, cz = 1730;
  d.box(cx - 18, G, cz - 14, cx + 18, G + 11, cz + 14, B.CASTLE_STONE);
  for (let x = cx - 18; x <= cx + 18; x += 2) { d.set(x, G + 12, cz - 14, B.CASTLE_STONE); d.set(x, G + 12, cz + 14, B.CASTLE_STONE); }
  for (let z = cz - 14; z <= cz + 14; z += 2) { d.set(cx - 18, G + 12, z, B.CASTLE_STONE); d.set(cx + 18, G + 12, z, B.CASTLE_STONE); }
  d.box(cx - 3, G, cz - 14, cx + 3, G + 6, cz - 14, B.AIR); // gate arch
  d.box(cx - 4, G + 7, cz - 15, cx + 4, G + 7, cz - 15, B.GOLD_TRIM);
  for (const [tx, tz] of [[cx - 18, cz - 14], [cx + 18, cz - 14], [cx - 18, cz + 14], [cx + 18, cz + 14]]) {
    d.cyl(tx, tz, 3.2, G, G + 25, B.CASTLE_STONE);
    for (let k = 4; k < 24; k += 5) d.set(tx, G + k, tz - 3, B.STAINED_GLASS);
    d.cone(tx, tz, 4, G + 26, 11, B.CASTLE_ROOF);
    d.set(tx, G + 38, tz, B.GOLD_TRIM); d.set(tx, G + 39, tz, B.FLAG);
  }
  for (const tx of [cx - 9, cx + 9]) { d.cyl(tx, cz - 14, 2.2, G, G + 33, B.CASTLE_STONE); d.cone(tx, cz - 14, 3, G + 34, 9, B.CASTLE_ROOF); d.set(tx, G + 44, cz - 14, B.GOLD_TRIM); }
  d.box(cx - 7, G + 12, cz - 7, cx + 7, G + 39, cz + 7, B.CASTLE_STONE);
  for (let k = 14; k < 38; k += 4) for (let o = -5; o <= 5; o += 2) { d.set(cx + o, G + k, cz - 7, B.STAINED_GLASS); d.set(cx + o, G + k, cz + 7, B.STAINED_GLASS); d.set(cx - 7, G + k, cz + o, B.STAINED_GLASS); d.set(cx + 7, G + k, cz + o, B.STAINED_GLASS); }
  d.box(cx - 8, G + 40, cz - 8, cx + 8, G + 40, cz + 8, B.GOLD_TRIM);
  for (const [tx, tz] of [[cx - 7, cz - 7], [cx + 7, cz - 7], [cx - 7, cz + 7], [cx + 7, cz + 7]]) { d.cyl(tx, tz, 2, G + 40, G + 47, B.CASTLE_STONE); d.cone(tx, tz, 2.6, G + 48, 7, B.CASTLE_ROOF); }
  d.cyl(cx, cz, 4.2, G + 41, G + 60, B.CASTLE_STONE);
  for (let k = 44; k < 60; k += 5) { d.set(cx, G + k, cz - 4, B.STAINED_GLASS); d.set(cx, G + k, cz + 4, B.STAINED_GLASS); }
  d.cyl(cx, cz, 5, G + 61, G + 61, B.GOLD_TRIM);
  d.cone(cx, cz, 5, G + 62, 22, B.CASTLE_ROOF);
  d.box(cx, G + 85, cz, cx, G + 88, cz, B.GOLD_TRIM); d.set(cx, G + 89, cz, B.NEON_YELLOW);
  // ferris wheel (in the x-y plane)
  const fx = 1694, fy = G + 26, fz = 1690, R = 20;
  for (let a = 0; a < 720; a++) {
    const t = (a / 720) * Math.PI * 2;
    const x = Math.round(fx + Math.cos(t) * R), y = Math.round(fy + Math.sin(t) * R);
    d.set(x, y, fz - 1, B.TRUSS); d.set(x, y, fz + 1, B.TRUSS);
    if (a % 30 === 0) { d.set(x, y, fz - 1, B.NEON_PINK); d.set(x, y, fz + 1, B.NEON_CYAN); }
  }
  for (let s = 0; s < 12; s++) {
    const t = (s / 12) * Math.PI * 2;
    d.line(fx, fy, fz - 1, fx + Math.cos(t) * R, fy + Math.sin(t) * R, fz - 1, B.TRUSS);
    d.line(fx, fy, fz + 1, fx + Math.cos(t) * R, fy + Math.sin(t) * R, fz + 1, B.TRUSS);
  }
  for (let s = 0; s < 16; s++) {
    const t = (s / 16) * Math.PI * 2 + 0.1;
    const gx = Math.round(fx + Math.cos(t) * (R + 1)), gy = Math.round(fy + Math.sin(t) * (R + 1)) - 2;
    const col = COLORS[s % COLORS.length];
    d.box(gx - 1, gy, fz - 1, gx, gy + 1, fz + 1, col);
    d.set(gx - 1, gy + 1, fz, B.GLASS); d.set(gx, gy + 1, fz, B.GLASS);
  }
  d.box(fx - 1, fy - 1, fz - 3, fx + 1, fy + 1, fz + 3, B.GOLD_TRIM);
  for (const oz of [-3, 3]) { d.line(fx, fy, fz + oz, fx - 12, G, fz + oz, B.TRUSS_RED); d.line(fx, fy, fz + oz, fx + 12, G, fz + oz, B.TRUSS_RED); }
  d.box(fx - 4, G, fz - 4, fx + 4, G, fz + 4, B.MARBLE);
  // roller coaster: track + supports around the south loop
  let last = -1;
  for (let i = 0; i < 2400; i++) {
    const t = (i / 2400) * Math.PI * 2;
    const x = Math.round(1652 + Math.cos(t) * 52), z = Math.round(1790 + Math.sin(t) * 24);
    const lift = Math.max(0, Math.cos(t - 0.4)) ** 6;
    const y = Math.round(G + 12 + Math.sin(t * 3) * 6 + Math.cos(t * 5) * 3 + lift * 28);
    d.set(x, y, z, B.COASTER_TRACK);
    const key = Math.floor(i / 18);
    if (key !== last) { last = key; for (let k = G; k < y; k++) d.set(x, k, z, B.TRUSS); }
  }
  d.box(1597, G, 1784, 1606, G + 4, 1796, B.STUCCO_PINK); d.box(1596, G + 5, 1783, 1607, G + 5, 1797, B.AWNING_YELLOW);
  // drop tower
  d.box(1608, G, 1700, 1609, G + 95, 1701, B.TRUSS);
  d.cyl(1608, 1700, 3, G + 58, G + 59, B.NEON_PURPLE, true);
  d.box(1607, G + 96, 1699, 1610, G + 97, 1702, B.GOLD_TRIM); d.set(1608, G + 98, 1700, B.LIGHT_RED);
  d.cyl(1608, 1700, 4, G, G, B.MARBLE);
  // carousel
  d.cyl(1614, 1746, 6, G, G, B.MARBLE);
  for (let a = 0; a < 12; a++) { const t = (a / 12) * Math.PI * 2; const x = Math.round(1614 + Math.cos(t) * 4.5), z = Math.round(1746 + Math.sin(t) * 4.5); d.box(x, G + 1, z, x, G + 4, z, B.GOLD_TRIM); d.set(x, G + 2, z, COLORS[a % COLORS.length]); }
  for (let k = 0; k <= 5; k++) { const r = 7 - k * 1.2; for (let a = 0; a < 64; a++) { const t = (a / 64) * Math.PI * 2; for (let rr = 0; rr <= r; rr += 0.8) d.set(Math.round(1614 + Math.cos(t) * rr), G + 6 + k, Math.round(1746 + Math.sin(t) * rr), (a >> 3) % 2 ? B.AWNING_RED : B.STUCCO_WHITE); } }
  d.set(1614, G + 12, 1746, B.GOLD_TRIM);
  // kiosks along the avenue
  for (let k = 0; k < 6; k++) {
    const z = 1682 + k * 6, x = k % 2 ? AV + 7 : AV - 10;
    const c = COLORS[(k * 3) % COLORS.length];
    d.box(x, G, z, x + 3, G + 2, z + 3, c);
    d.set(k % 2 ? x : x + 3, G + 1, z + 1, B.FOOD_TRUCK);
    d.box(x - 1, G + 3, z - 1, x + 4, G + 3, z + 4, AWN[k & 3]);
    d.set(x + 1, G + 4, z + 1, [B.NEON_PINK, B.NEON_CYAN, B.NEON_YELLOW][k % 3]);
  }
  for (let z = 1662; z <= 1810; z += 10) { d.lamp(AV - 5, G, z, 4); d.lamp(AV + 5, G, z, 4); }
  for (const [x, z] of [[1600, 1664], [1704, 1664], [1600, 1720], [1704, 1730], [1680, 1760], [1626, 1760]]) d.palm(x, G, z, 7);
}

function rocketPad(d: Draw, px: number, pz: number, big: boolean) {
  const R = big ? 15 : 10;
  d.box(px - R, 21, pz - R, px + R, 21, pz + R, B.CONCRETE);
  d.box(px - 6, G, pz - 6, px + 6, G, pz + 6, B.CONCRETE);
  d.box(px - 2, 18, pz - R + 1, px + 2, G, pz - 7, B.AIR); // flame trench
  for (let x = px - R; x <= px + R; x++) for (const z of [pz - R - 2, pz + R + 2]) d.box(x, G, z, x, G + 2, z, B.CHAINLINK);
  for (let z = pz - R - 2; z <= pz + R + 2; z++) for (const x of [px - R - 2, px + R + 2]) d.box(x, G, z, x, G + 2, z, B.CHAINLINK);
  for (const [x, z] of [[px - R, pz - R], [px + R, pz - R], [px - R, pz + R], [px + R, pz + R]]) { d.box(x, G, z, x, G + 8, z, B.METAL); d.set(x, G + 9, z, B.LIGHT_RED); }
  if (big) {
    // core stage (orange), upper stage (white), two boosters
    d.cyl(px, pz, 2.6, G + 1, G + 3, B.METAL);
    d.cyl(px, pz, 2.6, G + 4, G + 58, B.ROCKET_TANK);
    for (const y of [G + 20, G + 40]) d.cyl(px, pz, 2.7, y, y, B.ROCKET_BAND);
    d.cyl(px, pz, 2.4, G + 59, G + 76, B.ROCKET_WHITE);
    d.cyl(px, pz, 2.5, G + 66, G + 67, B.ROCKET_BAND);
    d.cone(px, pz, 2.4, G + 77, 12, B.ROCKET_WHITE);
    for (const ox of [-5, 5]) {
      d.cyl(px + ox, pz, 1.3, G + 1, G + 2, B.METAL);
      d.cyl(px + ox, pz, 1.3, G + 3, G + 46, B.ROCKET_WHITE);
      d.cyl(px + ox, pz, 1.4, G + 30, G + 30, B.ROCKET_BAND);
      d.cone(px + ox, pz, 1.3, G + 47, 5, B.ROCKET_WHITE);
      d.box(Math.min(px, px + ox) + 1, G + 10, pz, Math.max(px, px + ox) - 1, G + 10, pz, B.METAL);
      d.box(Math.min(px, px + ox) + 1, G + 40, pz, Math.max(px, px + ox) - 1, G + 40, pz, B.METAL);
    }
    d.text('HALCYON', pz, G + 50, px - 3, 'W');
  } else {
    d.cyl(px, pz, 1.5, G + 1, G + 2, B.METAL);
    d.cyl(px, pz, 1.6, G + 3, G + 44, B.ROCKET_WHITE);
    d.cyl(px, pz, 1.7, G + 22, G + 23, B.ROCKET_BAND);
    d.cone(px, pz, 1.6, G + 45, 7, B.ROCKET_WHITE);
  }
  // gantry tower
  const gx = px + (big ? 7 : 5), top = big ? G + 92 : G + 56;
  for (let y = G; y <= top; y++) for (let z = pz - 2; z <= pz + 2; z++) for (let x = gx; x <= gx + 4; x++) {
    const edge = (x === gx || x === gx + 4) && (z === pz - 2 || z === pz + 2);
    if (edge || (y % 8 === 0 && (x === gx || x === gx + 4 || z === pz - 2 || z === pz + 2))) d.set(x, y, z, B.TRUSS_RED);
    else if ((x === gx || x === gx + 4 || z === pz - 2 || z === pz + 2) && ((y + x + z) % 4 === 0)) d.set(x, y, z, B.TRUSS_RED);
  }
  for (let y = G + 8; y <= top; y += 16) d.box(gx, y, pz - 2, gx + 4, y, pz + 2, B.METAL);
  for (const y of big ? [G + 50, G + 74] : [G + 30, G + 44]) d.box(px + 2, y, pz - 1, gx, y, pz + 1, B.TRUSS_RED);
  d.box(gx + 2, top + 1, pz, gx + 2, top + 6, pz, B.METAL); d.set(gx + 2, top + 7, pz, B.LIGHT_RED);
  // water tower + service building
  d.cyl(px - R + 4, pz + R - 4, 2, G, G + 10, B.TRUSS); d.cyl(px - R + 4, pz + R - 4, 3, G + 11, G + 15, B.STUCCO_WHITE);
}

function capeComplex(d: Draw) {
  rocketPad(d, 2512, 1497, true);
  // assembly building
  const x0 = 2470, x1 = 2500, z0 = 1528, z1 = 1572, top = G + 62;
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    const edge = x === x0 || x === x1 || z === z0 || z === z1;
    for (let y = 21; y <= top; y++) {
      let id = B.PANEL_WHITE;
      if (edge && (x - x0) % 6 === 0 && z !== z0 && z !== z1) id = B.PANEL_GREY;
      if (edge && (z - z0) % 6 === 0 && (x === x0 || x === x1)) id = B.PANEL_GREY;
      if (x === x1 && z >= 1544 && z <= 1556 && y < top - 6) id = (z === 1544 || z === 1556) ? B.PANEL_GREY : B.SHUTTER;
      if (y === top) id = edge ? B.PANEL_GREY : B.METAL;
      if (!edge && y < top) continue;
      d.set(x, y, z, id);
    }
  }
  // flag-like emblem on the south face, name on the north face
  for (let y = top - 22; y <= top - 8; y++) for (let x = x0 + 4; x <= x0 + 14; x++) d.set(x, y, z1, y > top - 14 && x < x0 + 9 ? B.AWNING_BLUE : ((y - top) & 2) ? B.AWNING_RED : B.STUCCO_WHITE);
  d.text('HALCYON', (x0 + x1) >> 1, top - 6, z0, 'N');
  for (let x = x0 + 4; x < x1; x += 8) d.set(x, top + 1, z0 + 6, B.AC_UNIT);
  // radar dome + open dish
  d.cyl(2526, 1588, 4, G, G + 3, B.CONCRETE); d.sphere(2526, G + 6, 1588, 5, B.DISH, true);
  d.box(2482, G, 1600, 2484, G + 6, 1602, B.CONCRETE);
  for (let dz = -6; dz <= 6; dz++) for (let dx = -6; dx <= 6; dx++) { const r2 = dx * dx + dz * dz; if (r2 > 40) continue; d.set(2483 + dx, G + 9 + Math.floor(r2 / 9) + Math.floor(dz / 3), 1601 + dz, B.DISH); }
  d.box(2483, G + 7, 1601, 2483, G + 13, 1601, B.TRUSS); d.set(2483, G + 14, 1601, B.LIGHT_RED);
  // pad 2 on the barrier island
  rocketPad(d, 2612, 1975, false);
}

function cedarBridge(d: Draw) {
  const cx = 2116, cz = 513, dx = 0.98, dz = 0.196, nx = -0.196, nz = 0.98;
  for (const side of [-1, 1]) {
    const tx = Math.round(cx + nx * 11 * side), tz = Math.round(cz + nz * 11 * side);
    for (let y = 14; y <= G + 46; y++) { const r = y > G + 30 ? 1 : 1.6; d.cyl(tx, tz, r, y, y, B.LIMESTONE); }
    d.cyl(tx, tz, 2.2, G + 47, G + 48, B.COPPER_ROOF); d.cone(tx, tz, 1.5, G + 49, 5, B.COPPER_ROOF); d.set(tx, G + 55, tz, B.LIGHT_RED);
    for (let k = 1; k <= 4; k++) for (const dir of [-1, 1]) {
      const a = k * 9 * dir;
      d.line(tx, G + 44 - k * 2, tz, Math.round(cx + dx * a + nx * 10 * side), G + 1, Math.round(cz + dz * a + nz * 10 * side), B.TRUSS);
    }
  }
  // portal beams over the deck
  d.line(Math.round(cx - nx * 11), G + 36, Math.round(cz - nz * 11), Math.round(cx + nx * 11), G + 36, Math.round(cz + nz * 11), B.LIMESTONE);
  d.line(Math.round(cx - nx * 11), G + 37, Math.round(cz - nz * 11), Math.round(cx + nx * 11), G + 37, Math.round(cz + nz * 11), B.LIMESTONE);
  d.line(Math.round(cx - nx * 11), G + 42, Math.round(cz - nz * 11), Math.round(cx + nx * 11), G + 42, Math.round(cz + nz * 11), B.COPPER_ROOF);
}

function bayhavenPort(d: Draw, g: GenProbe) {
  /** east shore of the bay at row z: first land block east of the water */
  const shore = (z: number) => { let x = 1060; while (x > 880 && g.isLandAt(x, z)) x--; return x + 1; };
  for (const cz of [2028, 2058, 2088]) {
    const sx = shore(cz);
    const lx0 = sx + 5, lx1 = sx + 15;
    for (const lx of [lx0, lx1]) for (const lz of [cz - 4, cz + 4]) { d.box(lx, G, lz, lx, G + 30, lz, B.TRUSS_RED); d.set(lx, G - 1, lz, B.CONCRETE); }
    d.box(lx0, G + 12, cz - 4, lx1, G + 12, cz - 4, B.TRUSS_RED); d.box(lx0, G + 12, cz + 4, lx1, G + 12, cz + 4, B.TRUSS_RED);
    d.box(lx0, G + 31, cz - 4, lx0, G + 31, cz + 4, B.TRUSS_RED); d.box(lx1, G + 31, cz - 4, lx1, G + 31, cz + 4, B.TRUSS_RED);
    // boom over the water + back reach
    d.box(sx - 34, G + 32, cz - 1, lx1 + 6, G + 33, cz + 1, B.TRUSS_RED);
    d.box(lx0 + 1, G + 34, cz - 2, lx0 + 7, G + 37, cz + 2, B.PANEL_WHITE);
    d.box(lx0 + 2, G + 35, cz - 2, lx0 + 6, G + 35, cz - 2, B.WINDOW);
    d.box(lx0 + 3, G + 38, cz, lx0 + 3, G + 44, cz, B.TRUSS_RED);
    d.line(lx0 + 3, G + 44, cz, sx - 34, G + 34, cz, B.TRUSS);
    d.line(lx0 + 3, G + 44, cz, lx1 + 6, G + 34, cz, B.TRUSS);
    d.box(sx - 6, G + 29, cz - 1, sx - 4, G + 31, cz + 1, B.WINDOW);
    d.box(sx - 16, G + 14, cz, sx - 16, G + 31, cz, B.IRON_RAIL);
    d.box(sx - 18, G + 11, cz - 1, sx - 14, G + 13, cz + 1, B.CONTAINER_ORANGE);
    d.set(sx - 34, G + 34, cz, B.LIGHT_RED);
  }
  // container ship moored along the quay
  const qx = Math.min(shore(2030), shore(2060), shore(2085)) - 4;
  const X1 = qx, X0 = qx - 12, Z0 = 2022, Z1 = 2090;
  for (let z = Z0; z <= Z1; z++) {
    const taper = z < Z0 + 6 ? Math.ceil((Z0 + 6 - z) / 1.2) : 0;
    for (let x = X0 + taper; x <= X1 - taper; x++) {
      const edge = x === X0 + taper || x === X1 - taper || z === Z0 || z === Z1;
      for (let y = 16; y <= G + 2; y++) d.set(x, y, z, edge ? (y < 19 ? B.RED_STUCCO : B.HULL_BLUE) : (y === G + 2 ? B.METAL : B.HULL_BLUE));
    }
  }
  for (let z = Z0 + 10; z <= Z1 - 14; z += 7) for (let x = X0 + 2; x <= X1 - 2; x += 3) {
    const st = 1 + hashInt(x, z, 4, 77);
    const c = [B.CONTAINER_RED, B.CONTAINER_BLUE, B.CONTAINER_GREEN, B.CONTAINER_ORANGE, B.CONTAINER_WHITE, B.CONTAINER_YELLOW][hashInt(x, z, 6, 78)];
    d.box(x, G + 3, z, x + 1, G + 2 + st * 2, z + 5, c);
  }
  d.box(X0 + 1, G + 3, Z1 - 10, X1 - 1, G + 14, Z1 - 3, B.STUCCO_WHITE);
  d.box(X0 + 1, G + 12, Z1 - 10, X1 - 1, G + 12, Z1 - 10, B.WINDOW);
  d.box(X0 + 5, G + 15, Z1 - 6, X0 + 7, G + 20, Z1 - 4, B.RED_STUCCO);
  d.text('GULF RUNNER', (Z0 + Z1) >> 1, G, X0, 'W');
}

function lighthouse(d: Draw, x: number, z: number, h: number) {
  d.cyl(x, z, 4.5, 21, G, B.LIMESTONE);
  for (let y = G + 1; y <= G + h; y++) {
    const r = 3.4 - (y - G) / (h * 1.6);
    d.cyl(x, z, r, y, y, Math.floor((y - G) / 6) % 2 ? B.RED_STUCCO : B.STUCCO_WHITE, true);
  }
  for (let k = 4; k < h; k += 7) d.set(x, G + k, z - 3, B.WINDOW);
  const t = G + h + 1;
  d.cyl(x, z, 4, t, t, B.METAL); d.cyl(x, z, 4, t + 1, t + 1, B.IRON_RAIL, true);
  d.cyl(x, z, 2.2, t + 1, t + 4, B.GLASS); d.box(x, t + 1, z, x, t + 3, z, B.LAMP);
  d.cyl(x, z, 2.6, t + 5, t + 5, B.METAL); d.cone(x, z, 2, t + 6, 3, B.METAL); d.set(x, t + 10, z, B.LIGHT_RED);
}

function conchHarbor(d: Draw) {
  lighthouse(d, 1364, 4238, 34);
  d.cottage(1349, G, 4232, 7, 6, B.SIDING_WHITE, B.TIN_ROOF);
  // sunset pier off the south shore
  const px = 1318;
  for (let z = 4318; z <= 4356; z++) for (let x = px - 2; x <= px + 2; x++) {
    d.set(x, 21, z, B.DOCK);
    if ((x === px - 2 || x === px + 2)) { d.set(x, G, z, B.IRON_RAIL); if (z % 4 === 0) for (let y = 12; y <= 20; y++) d.set(x, y, z, B.DARK_PLANK); }
  }
  for (let z = 4352; z <= 4362; z++) for (let x = px - 9; x <= px + 9; x++) {
    d.set(x, 21, z, B.DOCK);
    if (x === px - 9 || x === px + 9 || z === 4362) d.set(x, G, z, B.IRON_RAIL);
    if ((x - px) % 6 === 0 && (z === 4352 || z === 4362)) for (let y = 12; y <= 20; y++) d.set(x, y, z, B.DARK_PLANK);
  }
  for (let z = 4354; z <= 4360; z++) d.set(px, G, z, B.AIR);
  for (const x of [px - 9, px + 9]) { d.lamp(x, G, 4352, 4); d.lamp(x, G, 4362, 4); }
  for (let x = px - 7; x <= px + 7; x += 3) d.set(x, G, 4360, B.DARK_PLANK);
  d.box(px - 6, G, 4352, px - 3, G + 2, 4355, B.SIDING_CORAL); d.box(px - 7, G + 3, 4351, px - 2, G + 3, 4356, B.TIN_ROOF);
  // entry arch
  d.box(px - 4, G, 4318, px - 4, G + 7, 4318, B.STUCCO_WHITE); d.box(px + 4, G, 4318, px + 4, G + 7, 4318, B.STUCCO_WHITE);
  d.box(px - 6, G + 7, 4318, px + 6, G + 9, 4318, B.NEON_ORANGE);
  d.text('SUNSET PIER', px, G + 8, 4318, 'N');
}

function lakePier(d: Draw, g: GenProbe) {
  const z = 2700;
  let sx = 1990;
  while (sx < 2080 && g.isLandAt(sx, z)) sx++;
  const end = sx + 46;
  for (let x = sx - 4; x <= end; x++) for (let dz = -2; dz <= 2; dz++) {
    d.set(x, 21, z + dz, B.DOCK);
    if (Math.abs(dz) === 2 && x >= sx) { d.set(x, G, z + dz, B.IRON_RAIL); if (x % 5 === 0) for (let y = 12; y <= 20; y++) d.set(x, y, z + dz, B.DARK_PLANK); }
  }
  for (let x = end - 4; x <= end + 4; x++) for (let dz = -9; dz <= 9; dz++) {
    d.set(x, 21, z + dz, B.DOCK);
    if (Math.abs(dz) === 9 || x === end + 4) d.set(x, G, z + dz, B.IRON_RAIL);
  }
  for (let dz = -1; dz <= 1; dz++) for (let x = end - 4; x <= end; x++) d.set(x, G, z + dz, B.AIR);
  for (let x = sx; x <= end; x += 8) { d.lamp(x, G, z - 2, 3); d.lamp(x, G, z + 2, 3); }
  d.box(end - 2, G, z - 8, end + 2, G + 2, z - 5, B.SIDING_SKY); d.box(end - 3, G + 3, z - 9, end + 3, G + 3, z - 4, B.TIN_ROOF);
  // bait shop at the shore
  d.cottage(sx - 14, G, z - 12, 8, 6, B.SIDING_LEMON, B.TIN_ROOF);
  d.text('BAIT', sx - 10, G + 5, z - 13, 'N');
  // moored boats
  for (const [bx, bz] of [[sx + 12, z - 6], [sx + 26, z + 6]]) boat(d, bx, bz, true, B.HULL_WHITE);
}

/** small motorboat moored at y=20/21 (long axis x when alongX) */
function boat(d: Draw, x: number, z: number, alongX: boolean, hull: number) {
  for (let i = -3; i <= 3; i++) for (let j = -1; j <= 1; j++) {
    const bx = alongX ? x + i : x + j, bz = alongX ? z + j : z + i;
    if (Math.abs(i) === 3 && j !== 0) continue;
    d.set(bx, 20, bz, hull); d.set(bx, 21, bz, Math.abs(j) === 1 || Math.abs(i) === 3 ? hull : B.DOCK);
  }
  const cx = alongX ? x - 1 : x, cz = alongX ? z : z - 1;
  d.set(cx, G, cz, B.WINDOW); d.set(cx, G + 1, cz, B.STUCCO_WHITE);
}

function welcomeSign(d: Draw) {
  const cx = 783, z = 855;
  d.box(cx - 10, 21, z - 4, cx + 10, 21, z + 2, B.GRASS);
  for (let x = cx - 10; x <= cx + 10; x++) { d.set(x, G, z + 2, B.FLOWERS); d.set(x, G, z - 4, B.FLOWERS_BLUE); }
  for (const ox of [-6, 6]) d.box(cx + ox, G, z - 1, cx + ox, G + 6, z - 1, B.PALM_LOG);
  d.box(cx - 8, G + 7, z - 2, cx + 8, G + 13, z, B.SIGN_PANEL);
  d.box(cx - 9, G + 7, z - 1, cx + 9, G + 7, z - 1, B.NEON_CYAN);
  d.text('WELCOME TO', cx, G + 11, z, 'S'); d.text('PALMARA', cx, G + 9, z, 'S');
  d.text('WELCOME TO', cx, G + 11, z - 2, 'N'); d.text('PALMARA', cx, G + 9, z - 2, 'N');
  const bands = [B.NEON_YELLOW, B.NEON_ORANGE, B.NEON_PINK, B.NEON_PURPLE];
  for (let k = 0; k < 4; k++) d.box(cx - 9 + k, G + 14 + k, z - 1, cx + 9 - k, G + 14 + k, z - 1, bands[k]);
  for (let dy = 0; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) if (dx * dx + dy * dy <= 18) d.set(cx + dx, G + 18 + dy, z - 1, B.NEON_YELLOW);
  d.palm(cx - 12, G, z - 1, 8); d.palm(cx + 12, G, z - 1, 9);
}

function plane(d: Draw, x0: number, z: number, len: number, tail: number) {
  const y = G + 1;
  for (let i = 0; i < len; i++) {
    const x = x0 + i;
    const nose = i < 3, aft = i > len - 5;
    const r = nose ? (i === 0 ? 0 : 1) : 1;
    for (let dz = -r; dz <= r; dz++) for (let dy = -r; dy <= r; dy++) d.set(x, y + 1 + dy, z + dz, B.FUSELAGE);
    if (aft) { d.set(x, y + 3, z, tail); d.set(x, y + 4, z, tail); if (i > len - 3) { d.set(x, y + 5, z, tail); d.set(x, y + 6, z, tail); } }
  }
  d.set(x0, y + 1, z, B.WINDOW); d.set(x0 + 1, y + 2, z - 1, B.WINDOW); d.set(x0 + 1, y + 2, z + 1, B.WINDOW);
  const wx = x0 + Math.floor(len * 0.4);
  for (let s = 2; s <= 10; s++) for (let k = 0; k < 4; k++) { d.set(wx + k + (s >> 2), y, z - s, B.PANEL_WHITE); d.set(wx + k + (s >> 2), y, z + s, B.PANEL_WHITE); }
  for (let s = 1; s <= 4; s++) { d.set(x0 + len - 2, y + 2, z - s, B.PANEL_WHITE); d.set(x0 + len - 2, y + 2, z + s, B.PANEL_WHITE); }
  for (const s of [-5, 5]) { d.box(wx - 1, y - 1, z + s, wx + 2, y - 1, z + s, B.METAL); d.set(wx - 1, y - 1, z + s, B.FAN_CAGE); }
  d.set(x0 + 2, G, z, B.TIRE); d.set(wx + 1, G, z - 2, B.TIRE); d.set(wx + 1, G, z + 2, B.TIRE);
}

function controlTower(d: Draw, x: number, z: number, h: number) {
  d.cyl(x, z, 2, G, G + h, B.CONCRETE);
  d.cyl(x, z, 4.2, G + h + 1, G + h + 1, B.CONCRETE);
  d.cyl(x, z, 4.2, G + h + 2, G + h + 4, B.CURTAIN_DARK, true);
  d.cyl(x, z, 4.6, G + h + 5, G + h + 5, B.METAL);
  d.box(x, G + h + 6, z, x, G + h + 11, z, B.TRUSS); d.set(x, G + h + 12, z, B.LIGHT_RED);
}

function hangarBlock(d: Draw, x0: number, z0: number, w: number, dd: number, wall: number) {
  for (let x = x0; x <= x0 + w; x++) {
    const t = (x - x0 - w / 2) / (w / 2 + 0.5);
    const h = 6 + Math.floor(9 * Math.sqrt(Math.max(0, 1 - t * t)));
    for (let z = z0; z <= z0 + dd; z++) for (let k = 0; k <= h; k++) {
      const edge = x === x0 || x === x0 + w || z === z0 || z === z0 + dd;
      if (!edge && k < h) continue;
      d.set(x, G + k, z, k === h ? B.METAL : (z === z0 && x > x0 && x < x0 + w && k < h - 2) ? B.SHUTTER : wall);
    }
  }
}

function solanoAirport(d: Draw) {
  // terminal
  const x0 = 2296, x1 = 2372, z0 = 3334, z1 = 3356;
  d.box(x0, 21, z0 - 2, x1, 21, z1, B.CONCRETE);
  for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
    const edge = x === x0 || x === x1 || z === z0 || z === z1;
    const h = 9 + (Math.abs(x - (x0 + x1) / 2) < 12 ? 3 : 0);
    for (let k = 0; k <= h; k++) {
      if (!edge && k < h) continue;
      let id = B.PANEL_WHITE;
      if (z === z0 && k > 0 && k < h - 1) id = B.CURTAIN_BLUE;
      if (z === z1 && k > 0 && k < 4 && (x % 4)) id = B.GLASS;
      if (k === h) id = edge ? B.STUCCO_WHITE : B.METAL;
      d.set(x, G + k, z, id);
    }
  }
  d.text('SOLANO INTL', (x0 + x1) >> 1, G + 14, z0 + 1, 'N');
  d.box(2322, G + 13, z0 + 1, 2346, G + 13, z0 + 1, B.SIGN_PANEL); d.box(2322, G + 15, z0 + 1, 2346, G + 15, z0 + 1, B.NEON_CYAN);
  for (const jx of [2310, 2334, 2358]) { d.box(jx, G + 3, z0 - 5, jx + 2, G + 5, z0 - 1, B.PANEL_GREY); d.box(jx + 1, G, z0 - 5, jx + 1, G + 2, z0 - 5, B.METAL); }
  controlTower(d, 2282, 3345, 38);
  hangarBlock(d, 2162, 3334, 28, 22, B.PANEL_GREY);
  hangarBlock(d, 2200, 3334, 28, 22, B.METAL);
  d.text('SOLANO AIR', 2176, G + 12, 3334, 'N');
  plane(d, 2298, 3282, 24, B.PLANE_TAIL);
  plane(d, 2334, 3282, 22, B.AWNING_RED);
}

function lastKeyAirport(d: Draw) {
  d.box(1196, 21, 4231, 1246, 21, 4249, B.CONCRETE);
  for (let z = 4234; z <= 4244; z++) for (let x = 1200; x <= 1230; x++) {
    const edge = x === 1200 || x === 1230 || z === 4234 || z === 4244;
    for (let k = 0; k <= 6; k++) { if (!edge && k < 6) continue; d.set(x, G + k, z, k === 6 ? B.TIN_ROOF : (z === 4244 && k > 0 && k < 4 && x % 3) ? B.GLASS : B.SIDING_SKY); }
  }
  d.text('LAST KEY', 1215, G + 7, 4244, 'S');
  controlTower(d, 1240, 4240, 22);
  plane(d, 1170, 4304, 16, B.AWNING_YELLOW);
  plane(d, 1200, 4306, 14, B.PLANE_TAIL);
}

function lookoutTower(d: Draw, g: GenProbe) {
  const x = 1916, z = 958, base = g.terrainTop(x, z) + 1;
  for (const [ox, oz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) d.line(x + ox * 1.6, base, z + oz * 1.6, x + ox, base + 30, z + oz, B.TRUSS);
  for (let y = base + 6; y < base + 30; y += 6) d.walls(x - 3, y, z - 3, x + 3, y, z + 3, B.TRUSS);
  for (let y = base; y < base + 31; y++) d.set(x + 1, y, z, B.IRON_RAIL);
  d.box(x - 4, base + 31, z - 4, x + 4, base + 31, z + 4, B.DARK_PLANK);
  d.walls(x - 3, base + 32, z - 3, x + 3, base + 35, z + 3, B.DARK_PLANK);
  d.walls(x - 3, base + 33, z - 3, x + 3, base + 34, z + 3, B.GLASS);
  for (let k = 0; k <= 3; k++) d.box(x - 4 + k, base + 36 + k, z - 4 + k, x + 4 - k, base + 36 + k, z + 4 - k, B.CEDAR_SHINGLE);
  d.set(x, base + 40, z, B.METAL); d.set(x, base + 41, z, B.FLAG);
  d.cottage(x + 7, base, z - 3, 6, 5, B.LOG_WALL, B.CEDAR_SHINGLE);
}

function lumberMill(d: Draw) {
  const x0 = 1186, z0 = 812;
  d.box(x0 - 2, 21, z0 - 2, x0 + 54, 21, z0 + 38, B.GRAVEL);
  d.box(x0 - 2, G, z0 - 2, x0 + 54, G + 12, z0 + 38, B.AIR);
  d.cottage(x0, G, z0, 28, 12, B.DARK_PLANK, B.TIN_ROOF, 2);
  d.text('PINEWOOD LUMBER', x0 + 14, G + 6, z0 - 1, 'N');
  for (let r = 0; r < 4; r++) for (let x = x0 + 32; x <= x0 + 50; x++) { d.set(x, G + r, z0 + 2 + r, B.BARK); d.set(x, G + r, z0 + 3 + r, B.BARK); if (r < 3) d.set(x, G + r, z0 + 4 + r, B.BARK); }
  for (let k = 0; k < 4; k++) d.box(x0 + 2 + k * 7, G, z0 + 20, x0 + 6 + k * 7, G + 2 + (k % 2), z0 + 26, B.LUMBER);
  // teepee burner
  for (let y = 0; y < 18; y++) d.cyl(x0 + 44, z0 + 28, 6 - y * 0.28, G + y, G + y, B.METAL, true);
  d.cyl(x0 + 44, z0 + 28, 1.2, G + 18, G + 20, B.FAN_CAGE);
  d.line(x0 + 28, G + 6, z0 + 6, x0 + 40, G + 12, z0 + 24, B.METAL);
  // log truck
  d.box(x0 + 10, G, z0 + 32, x0 + 22, G, z0 + 34, B.TIRE); d.box(x0 + 10, G + 1, z0 + 32, x0 + 13, G + 3, z0 + 34, B.AWNING_RED);
  d.box(x0 + 14, G + 1, z0 + 32, x0 + 22, G + 1, z0 + 34, B.METAL); d.box(x0 + 14, G + 2, z0 + 32, x0 + 22, G + 3, z0 + 34, B.BARK);
}

function sugarMill(d: Draw) {
  const x0 = 1528, z0 = 1762;
  d.box(x0 - 4, 21, z0 - 4, x0 + 56, 21, z0 + 50, B.CONCRETE);
  for (let z = z0; z <= z0 + 24; z++) for (let x = x0; x <= x0 + 36; x++) {
    const edge = x === x0 || x === x0 + 36 || z === z0 || z === z0 + 24;
    const h = x < x0 + 14 ? 26 : 16;
    for (let k = 0; k <= h; k++) { if (!edge && k < h) continue; d.set(x, G + k, z, k === h ? B.METAL : (k % 5 === 2 && x % 3 && edge) ? B.WINDOW : B.PANEL_GREY); }
  }
  d.text('PALMARA SUGAR', x0 + 25, G + 12, z0, 'N');
  for (const sx of [x0 + 4, x0 + 9]) { d.cyl(sx, z0 + 6, 1.8, G + 27, G + 58, B.BRICK); d.cyl(sx, z0 + 6, 2, G + 56, G + 57, B.BRICK_DARK); d.set(sx, G + 59, z0 + 6, B.LIGHT_RED); }
  d.cyl(x0 + 6, z0 + 18, 1.4, G + 27, G + 48, B.METAL);
  for (let k = 0; k < 3; k++) { d.cyl(x0 + 44, z0 + 4 + k * 10, 4, G, G + 14, B.SILO_STAVE); d.cone(x0 + 44, z0 + 4 + k * 10, 4, G + 15, 2, B.METAL); }
  // cane yard + rail siding
  for (let x = x0; x <= x0 + 50; x++) { d.set(x, 21, z0 + 32, B.DARK_PLANK); d.set(x, 21, z0 + 34, B.DARK_PLANK); d.set(x, G, z0 + 32, B.RAIL); d.set(x, G, z0 + 34, B.RAIL); }
  for (let k = 0; k < 3; k++) { d.box(x0 + 4 + k * 13, G + 1, z0 + 31, x0 + 14 + k * 13, G + 3, z0 + 35, k === 0 ? B.CONTAINER_GREEN : B.METAL); d.box(x0 + 5 + k * 13, G + 4, z0 + 32, x0 + 13 + k * 13, G + 4, z0 + 34, B.HAY_BALE); }
  for (let z = z0 + 40; z <= z0 + 48; z++) for (let x = x0; x <= x0 + 30; x++) { const h = 3 - Math.floor(Math.abs(z - z0 - 44) / 2); for (let k = 0; k < h; k++) d.set(x, G + k, z, B.HAY_BALE); }
}

function rangerStation(d: Draw) {
  const x0 = 1834, z0 = 3238;
  d.box(x0 - 2, 21, z0 - 2, x0 + 20, 21, z0 + 20, B.GRASS);
  for (const [x, z] of [[x0, z0], [x0 + 12, z0], [x0, z0 + 10], [x0 + 12, z0 + 10]]) d.box(x, G, z, x, G + 2, z, B.DARK_PLANK);
  d.box(x0 - 2, G + 3, z0 - 2, x0 + 14, G + 3, z0 + 12, B.DOCK);
  d.walls(x0 - 2, G + 4, z0 - 2, x0 + 14, G + 4, z0 + 12, B.IRON_RAIL);
  d.cottage(x0, G + 4, z0, 13, 11, B.DARK_PLANK, B.TIN_ROOF);
  d.text('RANGER', x0 + 6, G + 10, z0 - 1, 'N');
  for (let k = 0; k < 4; k++) d.box(x0 + 6, G + k, z0 - 3 - k, x0 + 8, G + k, z0 - 3 - k, B.DOCK);
  // observation tower
  const tx = x0 + 17, tz = z0 + 15;
  for (const [ox, oz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) d.box(tx + ox, G, tz + oz, tx + ox, G + 24, tz + oz, B.DARK_PLANK);
  for (let y = G + 6; y <= G + 24; y += 6) d.walls(tx - 2, y, tz - 2, tx + 2, y, tz + 2, B.DARK_PLANK);
  d.box(tx - 3, G + 25, tz - 3, tx + 3, G + 25, tz + 3, B.DOCK); d.walls(tx - 3, G + 26, tz - 3, tx + 3, G + 26, tz + 3, B.IRON_RAIL);
  for (const [ox, oz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) d.box(tx + ox, G + 26, tz + oz, tx + ox, G + 28, tz + oz, B.DARK_PLANK);
  for (let k = 0; k <= 3; k++) d.box(tx - 4 + k, G + 29 + k, tz - 4 + k, tx + 4 - k, G + 29 + k, tz + 4 - k, B.TIN_ROOF);
  d.set(x0 + 16, G, z0, B.METAL); d.box(x0 + 16, G, z0, x0 + 16, G + 8, z0, B.METAL); d.set(x0 + 16, G + 9, z0, B.FLAG);
}

function waterTower(d: Draw, x: number, z: number, name: string, tank: number) {
  for (const [ox, oz] of [[-4, -4], [4, -4], [-4, 4], [4, 4]]) d.line(x + ox * 1.25, G, z + oz * 1.25, x + ox, G + 26, z + oz, B.TRUSS);
  for (let y = G + 8; y <= G + 24; y += 8) d.walls(x - 4, y, z - 4, x + 4, y, z + 4, B.TRUSS);
  d.box(x, G, z, x, G + 26, z, B.METAL);
  d.cyl(x, z, 6, G + 27, G + 27, B.METAL);
  d.cyl(x, z, 5.6, G + 28, G + 35, tank);
  d.cyl(x, z, 6, G + 28, G + 28, B.IRON_RAIL, true);
  d.sphere(x, G + 36, z, 4.6, tank, true);
  d.set(x, G + 41, z, B.METAL); d.set(x, G + 42, z, B.LIGHT_RED);
  const w = Math.max(name.length + 2, 7);
  for (const [zz, face] of [[z - 7, 'N'], [z + 7, 'S']] as const) {
    d.box(x - (w >> 1), G + 30, zz, x - (w >> 1) + w - 1, G + 32, zz, tank === B.STUCCO_WHITE ? B.AWNING_BLUE : B.STUCCO_WHITE);
    d.text(name, x, G + 31, zz, face);
  }
}

function radioMast(d: Draw, x: number, z: number, g: GenProbe) {
  const b = g.terrainTop(x, z) + 1;
  for (let y = b; y <= 120; y++) { d.set(x, y, z, Math.floor((y - b) / 8) % 2 ? B.TRUSS_RED : B.TRUSS); }
  for (let y = b + 20; y <= 120; y += 25) { d.set(x + 1, y, z, B.LIGHT_RED); d.set(x - 1, y, z, B.LIGHT_RED); }
  d.set(x, 121, z, B.LIGHT_RED);
  for (let a = 0; a < 3; a++) {
    const t = (a / 3) * Math.PI * 2 + 0.3;
    const ax = Math.round(x + Math.cos(t) * 36), az = Math.round(z + Math.sin(t) * 36);
    const ab = g.terrainTop(ax, az) + 1;
    d.line(x, 100, z, ax, ab, az, B.IRON_RAIL); d.line(x, 60, z, ax, ab, az, B.IRON_RAIL);
    d.box(ax - 1, ab, az - 1, ax + 1, ab, az + 1, B.CONCRETE);
  }
  d.cottage(x + 4, b, z + 4, 6, 5, B.CONCRETE, B.METAL);
}

/** Small-town water towers: [x, z, name, tank]. Placed in a lot centre of each town zone. */
export const TOWN_TOWERS: [number, number, string, number][] = [
  [1224, 936, 'PINEWOOD', B.STUCCO_WHITE], [1464, 1752, 'CANE', B.SILO_BLUE], [1800, 3048, 'GATOR', B.STUCCO_WHITE],
  [696, 1416, 'SANDPIPER', B.STUCCO_SKY], [1944, 2616, 'MIRABEL', B.STUCCO_WHITE], [1512, 408, 'BLUEWATER', B.SILO_BLUE],
  [2280, 1128, 'SEAGRAPE', B.STUCCO_PINK],
];

const lot = (x: number, z: number) => [Math.floor(x / 48), Math.floor(z / 48)] as const;
export const LANDMARKS: Landmark[] = [
  { id: 'starfall_park', name: 'Starfall Park', bbox: [1586, 1650, 1718, 1822], flat: [1586, 1650, 1718, 1822], build: (d) => starfallPark(d) },
  { id: 'cape_halcyon', name: 'Cape Halcyon Spaceport', bbox: [2464, 1478, 2532, 1612], flat: [2464, 1478, 2532, 1612], build: (d) => { capeComplex(d); } },
  { id: 'halcyon_pad_2', name: 'Halcyon Shore Pad 2', bbox: [2598, 1961, 2626, 1989], flat: [2598, 1961, 2626, 1989], build: (d) => rocketPad(d, 2612, 1975, false) },
  { id: 'cedar_bridge', name: 'Cedar Bluff river bridge', bbox: [2070, 480, 2162, 546], flat: [2108, 496, 2124, 530], build: (d) => cedarBridge(d) },
  { id: 'bayhaven_port', name: 'Bayhaven port cranes', bbox: [860, 2015, 1030, 2096], flat: [930, 2015, 1030, 2096], build: (d, g) => bayhavenPort(d, g), lots: [[20, 41, 'container_yard'], [21, 41, 'container_yard'], [20, 42, 'container_yard'], [21, 42, 'container_yard'], [20, 43, 'container_yard'], [21, 43, 'container_yard']] },
  { id: 'conch_lighthouse', name: 'Conch Harbor lighthouse & sunset pier', bbox: [1300, 4226, 1372, 4364], flat: [1346, 4226, 1372, 4246], build: (d) => conchHarbor(d), lots: [[28, 88, 'landmark']] },
  { id: 'mirabel_pier', name: 'Lake Mirabel fishing pier', bbox: [1990, 2686, 2070, 2712], flat: [1990, 2686, 2070, 2712], build: (d, g) => lakePier(d, g) },
  { id: 'welcome_sign', name: 'Welcome to Palmara sign (Sunstate Turnpike)', bbox: [768, 848, 798, 860], flat: [768, 848, 798, 860], build: (d) => welcomeSign(d) },
  { id: 'solano_airport', name: 'Solano International terminal, tower and hangars', bbox: [2160, 3270, 2374, 3358], flat: [2160, 3330, 2374, 3358], build: (d) => solanoAirport(d) },
  { id: 'lastkey_airport', name: 'Last Key airfield', bbox: [1158, 4226, 1248, 4318], flat: [1196, 4231, 1246, 4249], build: (d) => lastKeyAirport(d) },
  { id: 'fire_lookout', name: 'Timberline fire lookout', bbox: [1908, 948, 1926, 964], flat: [1908, 948, 1926, 964], build: (d, g) => lookoutTower(d, g) },
  { id: 'lumber_mill', name: 'Pinewood lumber mill', bbox: [1184, 810, 1240, 850], flat: [1184, 810, 1240, 850], build: (d) => lumberMill(d) },
  { id: 'sugar_mill', name: 'Palmara Sugar mill', bbox: [1524, 1758, 1584, 1812], flat: [1524, 1758, 1584, 1812], build: (d) => sugarMill(d) },
  { id: 'ranger_station', name: 'Sawgrass ranger station', bbox: [1832, 3234, 1856, 3258], flat: [1832, 3234, 1856, 3258], build: (d) => rangerStation(d) },
  { id: 'radio_mast', name: 'WPAL radio mast', bbox: [1624, 2124, 1700, 2200], flat: [1655, 2155, 1671, 2171], build: (d, g) => radioMast(d, 1660, 2160, g) },
  ...TOWN_TOWERS.map(([x, z, name, tank]): Landmark => {
    const [i, j] = lot(x, z);
    return { id: `tower_${name.toLowerCase()}`, name: `${name[0]}${name.slice(1).toLowerCase()} water tower`, bbox: [x - 8, z - 8, x + 8, z + 8], flat: [x - 8, z - 8, x + 8, z + 8], lots: [[i, j, 'landmark']], build: (d) => waterTower(d, x, z, name, tank) };
  }),
];

// ───────────────────────────────────────────────────────────── scattered features
export type FeatureType =
  | 'cabin' | 'campsite' | 'farmstead' | 'windmill' | 'stilt_house' | 'airboat_dock' | 'boardwalk' | 'hammock'
  | 'beach_set' | 'pier' | 'key_cottage' | 'bait_shack' | 'dock' | 'bunker';
export interface FeaturePlan { type: FeatureType; x: number; z: number; r: number; base: number; v: number; dx: number; dz: number }

export const FCELL = 80;
const FEATURE_R: Record<FeatureType, number> = {
  cabin: 9, campsite: 8, farmstead: 20, windmill: 4, stilt_house: 8, airboat_dock: 10, boardwalk: 18, hammock: 9,
  beach_set: 12, pier: 30, key_cottage: 8, bait_shack: 10, dock: 14, bunker: 7,
};
export const FEATURE_MAX_R = 30;

/** Cardinal direction from (x,z) toward the nearest water within `max` blocks, or null. */
function waterDir(g: GenProbe, x: number, z: number, max: number): [number, number, number] | null {
  for (let s = 2; s <= max; s += 2) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!g.isLandAt(x + dx * s, z + dz * s)) return [dx, dz, s];
  return null;
}

export function planFeature(g: GenProbe, ci: number, cj: number, protect: (x: number, z: number, r: number) => boolean, mapW: number, mapD: number): FeaturePlan | null {
  const hv = hash2(ci, cj, 6061);
  const x = ci * FCELL + 14 + hashInt(ci, cj, FCELL - 28, 6062), z = cj * FCELL + 14 + hashInt(ci, cj, FCELL - 28, 6063);
  if (x < 40 || z < 40 || x > mapW - 40 || z > mapD - 40) return null;
  const land = g.isLandAt(x, z);
  const reg = g.regionAt(x, z), zone = g.zoneAt(x, z);
  const dist = g.distAt(x, z);
  const lakeNear = g.waterBodyAt(x + 24, z) === 1 || g.waterBodyAt(x - 24, z) === 1 || g.waterBodyAt(x, z + 24) === 1 || g.waterBodyAt(x, z - 24) === 1;
  let type: FeatureType | null = null;
  const v = hash2(ci, cj, 6064);
  if (!land) return null;
  if (reg === RG.sawgrass) type = hv < 0.28 ? 'stilt_house' : hv < 0.48 ? 'boardwalk' : hv < 0.68 ? 'hammock' : hv < 0.85 ? 'airboat_dock' : null;
  else if (reg === RG.keys || reg === RG.conch_harbor) type = dist <= 3 ? (hv < 0.35 ? 'key_cottage' : hv < 0.6 ? 'dock' : hv < 0.75 ? 'bait_shack' : 'beach_set') : (hv < 0.5 ? 'key_cottage' : null);
  else if (lakeNear && hv < 0.55) type = 'dock';
  else if (dist >= 1 && dist <= 4 && zone !== 'wetland') type = hv < 0.45 ? 'beach_set' : hv < 0.62 ? 'pier' : hv < 0.75 ? (z > 2800 ? 'key_cottage' : 'cabin') : null;
  else if (reg === RG.timberline) type = hv < 0.35 ? 'cabin' : hv < 0.5 ? 'campsite' : hv < 0.58 ? 'windmill' : null;
  else if (reg === RG.farmland) type = hv < 0.5 ? 'farmstead' : hv < 0.68 ? 'windmill' : null;
  else if (reg === RG.cape_halcyon) type = hv < 0.35 ? 'bunker' : null;
  else if (zone === 'none') type = z < 1300 ? (hv < 0.3 ? 'cabin' : hv < 0.4 ? 'campsite' : null) : z > 2850 ? (hv < 0.3 ? 'stilt_house' : hv < 0.45 ? 'hammock' : null) : (hv < 0.32 ? 'farmstead' : hv < 0.45 ? 'windmill' : null);
  if (!type) return null;
  const r = FEATURE_R[type];
  let dx = 0, dz = 0;
  if (type === 'pier' || type === 'dock' || type === 'airboat_dock' || type === 'bait_shack' || type === 'beach_set') {
    const w = waterDir(g, x, z, type === 'beach_set' ? 24 : 18);
    if (!w) return null;
    dx = w[0]; dz = w[1];
  }
  if (protect(x, z, r + 6)) return null;
  // footprint must be dry land, away from roads, outside towns / cities
  const water = type === 'pier' || type === 'dock' || type === 'airboat_dock' || type === 'beach_set' || type === 'bait_shack';
  for (const [ox, oz] of [[0, 0], [-r, -r], [r, -r], [-r, r], [r, r], [0, r], [r, 0], [-r, 0], [0, -r]]) {
    const px = x + ox, pz = z + oz;
    if (g.onRoad(px, pz) || g.roadDistAt(px, pz) < 3) return null;
    if (URBAN.has(g.zoneAt(px, pz)) || g.zoneAt(px, pz) === 'airport') return null;
    if (!water && !g.isLandAt(px, pz)) return null;
  }
  const base = g.terrainTop(x, z) + 1;
  return { type, x, z, r, base, v, dx, dz };
}

export function buildFeature(d: Draw, f: FeaturePlan, g: GenProbe) {
  const { x, z, base: b, v } = f;
  switch (f.type) {
    case 'cabin': {
      const wall = v < 0.6 ? B.LOG_WALL : B.DARK_PLANK;
      d.box(x - 6, b - 1, z - 5, x + 6, b - 1, z + 6, B.DIRT);
      d.box(x - 6, b, z - 5, x + 6, b + 9, z + 6, B.AIR);
      d.cottage(x - 4, b, z - 2, 9, 7, wall, v < 0.5 ? B.CEDAR_SHINGLE : B.TIN_ROOF);
      d.box(x - 4, b, z - 4, x + 4, b, z - 3, B.DOCK); d.set(x - 4, b + 1, z - 4, B.DARK_PLANK); d.set(x + 4, b + 1, z - 4, B.DARK_PLANK);
      d.box(x - 2, b + 6, z + 1, x - 2, b + 9, z + 1, B.STONE);
      for (let k = 0; k < 3; k++) d.box(x + 6, b + k, z + 2, x + 6, b + k, z + 5, B.BARK);
      d.set(x - 6, b, z - 4, B.LUMBER);
      break;
    }
    case 'campsite': {
      d.box(x - 6, b - 1, z - 6, x + 6, b - 1, z + 6, B.PATH);
      d.box(x - 6, b, z - 6, x + 6, b + 5, z + 6, B.AIR);
      d.set(x, b - 1, z, B.STONE); d.set(x, b, z, B.LAMP);
      for (const [ox, oz] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) d.set(x + ox, b, z + oz, B.STONE);
      for (let k = 0; k < 3; k++) {
        const t = k * 2.1 + v * 3, tx = Math.round(x + Math.cos(t) * 4.5), tz = Math.round(z + Math.sin(t) * 4.5);
        const c = AWN[(k + Math.floor(v * 4)) & 3];
        d.box(tx - 1, b, tz - 1, tx + 1, b, tz + 1, c); d.set(tx, b + 1, tz, c); d.set(tx, b, tz - 1, B.AIR);
      }
      d.box(x - 5, b, z + 4, x - 3, b, z + 4, B.DARK_PLANK);
      d.box(x + 3, b, z - 5, x + 5, b + 1, z - 4, B.AWNING_BLUE);
      break;
    }
    case 'farmstead': {
      d.box(x - 19, b - 1, z - 19, x + 19, b - 1, z + 19, B.GRASS);
      d.box(x - 19, b, z - 19, x + 19, b + 16, z + 19, B.AIR);
      // red barn with white trim and a gambrel roof
      const bx0 = x - 6, bz0 = z - 16, bw = 12, bd = 16;
      d.box(bx0, b, bz0, bx0 + bw, b + 6, bz0 + bd, B.BARN_RED);
      d.box(bx0 + 4, b, bz0, bx0 + 8, b + 4, bz0, B.STUCCO_WHITE); d.box(bx0 + 5, b, bz0, bx0 + 7, b + 3, bz0, B.DARK_PLANK);
      for (let k = 0; k <= 6; k++) {
        const inset = k < 3 ? k * 2 : 4 + (k - 2);
        if (inset * 2 > bw) break;
        for (let zz = bz0 - 1; zz <= bz0 + bd + 1; zz++) { d.set(bx0 - 1 + inset, b + 7 + k, zz, B.TIN_ROOF); d.set(bx0 + bw + 1 - inset, b + 7 + k, zz, B.TIN_ROOF); }
        for (let xx = bx0 + inset; xx <= bx0 + bw - inset; xx++) { d.set(xx, b + 7 + k, bz0, B.BARN_RED); d.set(xx, b + 7 + k, bz0 + bd, B.BARN_RED); }
      }
      d.set(x, b + 9, bz0, B.STUCCO_WHITE);
      // silos
      d.cyl(x + 11, z - 12, 3, b, b + 16, v < 0.5 ? B.SILO_BLUE : B.SILO_STAVE); d.sphere(x + 11, b + 17, z - 12, 3, B.METAL, true);
      d.cyl(x + 11, z - 4, 2.4, b, b + 12, B.SILO_STAVE); d.cone(x + 11, z - 4, 2.4, b + 13, 2, B.METAL);
      // farmhouse
      d.cottage(x - 16, b, z + 4, 9, 8, v < 0.5 ? B.SIDING_WHITE : B.SIDING_LEMON, B.TIN_ROOF, 2);
      d.box(x - 16, b, z + 2, x - 8, b, z + 3, B.DOCK);
      // fences + hay
      for (let k = -19; k <= 19; k++) { d.set(x + k, b, z + 19, B.FENCE); d.set(x + 19, b, z + k, B.FENCE); }
      for (let k = 0; k < 4; k++) d.set(x + 4 + k * 3, b, z + 8, B.HAY_BALE);
      d.box(x - 3, b - 1, z + 10, x + 1, b - 1, z + 19, B.PATH);
      // tractor
      d.box(x + 4, b, z + 13, x + 6, b, z + 15, B.TIRE); d.box(x + 4, b + 1, z + 14, x + 6, b + 1, z + 14, B.AWNING_GREEN); d.set(x + 4, b + 2, z + 14, B.AWNING_GREEN); d.set(x + 4, b + 3, z + 14, B.METAL);
      break;
    }
    case 'windmill': {
      for (const [ox, oz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]]) d.line(x + ox, b, z + oz, x + (ox >> 1), b + 14, z + (oz >> 1), B.TRUSS);
      d.box(x, b + 15, z, x, b + 15, z + 1, B.METAL);
      for (let a = 0; a < 8; a++) { const t = a * Math.PI / 4; d.line(x, b + 15, z - 1, x + Math.cos(t) * 3, b + 15 + Math.sin(t) * 3, z - 1, B.METAL); }
      d.box(x, b + 15, z + 2, x, b + 15, z + 4, B.METAL); d.box(x, b + 14, z + 4, x, b + 16, z + 4, B.METAL);
      d.cyl(x + 4, z, 2, b, b + 2, B.METAL, true); d.cyl(x + 4, z, 1, b + 1, b + 1, B.WATER);
      break;
    }
    case 'stilt_house': {
      const wall = SIDING[Math.floor(v * SIDING.length)];
      for (const [ox, oz] of [[-4, -4], [4, -4], [-4, 4], [4, 4], [0, -4], [0, 4]]) d.box(x + ox, 18, z + oz, x + ox, b + 3, z + oz, B.DARK_PLANK);
      d.box(x - 5, b + 4, z - 6, x + 5, b + 4, z + 5, B.DOCK);
      d.walls(x - 5, b + 5, z - 6, x + 5, b + 5, z + 5, B.IRON_RAIL);
      d.cottage(x - 3, b + 5, z - 2, 7, 6, wall, B.TIN_ROOF);
      for (let k = 0; k < 5; k++) d.box(x - 1, b + k, z - 7 - (4 - k), x + 1, b + k, z - 7 - (4 - k), B.DOCK);
      break;
    }
    case 'airboat_dock': {
      const ax = x + f.dx * 6, az = z + f.dz * 6;
      d.box(Math.min(x, ax) - 2, 21, Math.min(z, az) - 2, Math.max(x, ax) + 2, 21, Math.max(z, az) + 2, B.DOCK);
      d.cottage(x - 3 - f.dx * 4, b, z - 3 - f.dz * 4, 6, 5, B.DARK_PLANK, B.TIN_ROOF);
      d.text('AIRBOATS', x - f.dx * 2, b + 6, z - 3 - f.dz * 4 - 1, 'N');
      for (const s of [-1, 1]) {
        const bx = ax + (f.dz !== 0 ? s * 4 : f.dx * 4), bz = az + (f.dx !== 0 ? s * 4 : f.dz * 4);
        d.box(bx - 1, 20, bz - 1, bx + 1, 20, bz + 1, B.HULL_WHITE); d.box(bx - 1, 21, bz - 1, bx + 1, 21, bz + 1, B.METAL);
        d.box(bx, 22, bz, bx, 23, bz, B.STUCCO_WHITE); d.box(bx - 1, 22, bz + 1, bx + 1, 24, bz + 1, B.FAN_CAGE);
      }
      break;
    }
    case 'boardwalk': {
      const len = 16;
      const ax = v < 0.5 ? 1 : 0, az = 1 - ax;
      for (let s = -len; s <= len; s++) for (let w = -1; w <= 1; w++) {
        const px = x + ax * s + az * w, pz = z + az * s + ax * w;
        d.set(px, b, pz, B.DOCK); d.set(px, b - 1, pz, B.AIR);
        if (w !== 0) d.set(px, b + 1, pz, s % 4 === 0 ? B.DARK_PLANK : B.AIR);
        if (s % 5 === 0 && w !== 0) for (let y = 17; y < b; y++) d.set(px, y, pz, B.DARK_PLANK);
      }
      d.box(x - 3, b, z - 3, x + 3, b, z + 3, B.DOCK); d.walls(x - 3, b + 1, z - 3, x + 3, b + 1, z + 3, B.IRON_RAIL);
      for (const [ox, oz] of [[-3, -3], [3, -3], [-3, 3], [3, 3]]) d.box(x + ox, b + 1, z + oz, x + ox, b + 3, z + oz, B.DARK_PLANK);
      for (let k = 0; k <= 2; k++) d.box(x - 4 + k, b + 4 + k, z - 4 + k, x + 4 - k, b + 4 + k, z + 4 - k, B.TIN_ROOF);
      break;
    }
    case 'hammock': {
      d.cyl(x, z, 7, b - 1, b - 1, B.GRASS);
      for (let k = 0; k < 5; k++) {
        const t = k * 1.3 + v * 6, tx = Math.round(x + Math.cos(t) * 4), tz = Math.round(z + Math.sin(t) * 4);
        const h = 5 + ((k + Math.floor(v * 7)) % 3);
        for (let y = 0; y < h; y++) d.set(tx, b + y, tz, B.PALM_LOG);
        d.sphere(tx, b + h, tz, 1.6, B.PALM_LEAVES);
        d.set(tx, b + h, tz, B.LEAVES);
      }
      d.box(x, b, z, x, b + 4, z, B.BARK); d.sphere(x, b + 6, z, 3, B.LEAVES);
      for (let k = 0; k < 6; k++) d.set(x - 2 + (k % 3) * 2, b + 3, z - 2 + (k >> 1), B.MOSS);
      break;
    }
    case 'beach_set': {
      // lifeguard tower + umbrellas on the sand toward the water
      const lx = x + f.dx * 4, lz = z + f.dz * 4;
      const c = COLORS[Math.floor(v * COLORS.length)];
      for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) d.box(lx + ox, b, lz + oz, lx + ox, b + 2, lz + oz, B.STUCCO_WHITE);
      d.box(lx - 2, b + 3, lz - 2, lx + 2, b + 3, lz + 2, B.DOCK);
      d.box(lx - 1, b + 4, lz - 1, lx + 1, b + 6, lz + 1, c);
      d.set(lx + f.dx, b + 5, lz + f.dz, B.WINDOW); d.set(lx, b + 5, lz, B.WINDOW);
      d.box(lx - 2, b + 7, lz - 2, lx + 2, b + 7, lz + 2, B.AWNING_RED);
      d.box(lx, b + 8, lz, lx, b + 9, lz, B.METAL); d.set(lx, b + 10, lz, B.FLAG);
      for (let k = 0; k < 6; k++) {
        const ux = x + Math.round(Math.cos(k * 1.05 + v) * 9), uz = z + Math.round(Math.sin(k * 1.05 + v) * 9);
        if (!g.isLandAt(ux, uz)) continue;
        const ub = g.terrainTop(ux, uz) + 1;
        d.box(ux, ub, uz, ux, ub + 1, uz, B.METAL);
        const col = AWN[(k + Math.floor(v * 9)) & 3];
        d.box(ux - 1, ub + 2, uz - 1, ux + 1, ub + 2, uz + 1, col); d.set(ux, ub + 3, uz, col);
        d.set(ux + 1, ub, uz, B.STUCCO_WHITE);
      }
      break;
    }
    case 'pier': {
      const len = 26;
      for (let s = -4; s <= len; s++) for (let w = -2; w <= 2; w++) {
        const px = x + f.dx * s + (f.dz !== 0 ? w : 0), pz = z + f.dz * s + (f.dx !== 0 ? w : 0);
        d.set(px, 21, pz, B.DOCK);
        if (Math.abs(w) === 2 && s > 0) { d.set(px, G, pz, B.IRON_RAIL); if (s % 4 === 0) for (let y = 12; y <= 20; y++) d.set(px, y, pz, B.DARK_PLANK); }
      }
      const ex = x + f.dx * len, ez = z + f.dz * len;
      d.box(ex - 4, 21, ez - 4, ex + 4, 21, ez + 4, B.DOCK);
      d.walls(ex - 4, G, ez - 4, ex + 4, G, ez + 4, B.IRON_RAIL);
      d.lamp(ex - 4, G, ez - 4, 3); d.lamp(ex + 4, G, ez + 4, 3);
      d.box(ex - 1, G, ez - 1, ex + 1, G + 2, ez + 1, B.SIDING_SKY); d.box(ex - 2, G + 3, ez - 2, ex + 2, G + 3, ez + 2, B.TIN_ROOF);
      break;
    }
    case 'key_cottage': {
      const wall = SIDING[Math.floor(v * SIDING.length)];
      for (const [ox, oz] of [[-4, -3], [4, -3], [-4, 4], [4, 4]]) d.box(x + ox, b - 3, z + oz, x + ox, b + 1, z + oz, B.DARK_PLANK);
      d.box(x - 5, b + 2, z - 5, x + 5, b + 2, z + 5, B.DOCK);
      d.cottage(x - 3, b + 3, z - 2, 7, 6, wall, B.TIN_ROOF);
      d.walls(x - 5, b + 3, z - 5, x + 5, b + 3, z + 5, B.PICKET);
      d.set(x, b + 3, z - 5, B.AIR);
      for (let k = 0; k < 2; k++) d.box(x - 1, b + k, z - 6 - (1 - k), x + 1, b + k, z - 6 - (1 - k), B.DOCK);
      d.palm(x + 7, b, z + 2, 6 + Math.floor(v * 3));
      break;
    }
    case 'bait_shack': {
      d.cottage(x - 3, b, z - 3, 7, 6, B.SIDING_SKY, B.TIN_ROOF);
      d.text('BAIT', x, b + 5, z - 4, 'N');
      const ax = x + f.dx * 8, az = z + f.dz * 8;
      d.box(Math.min(x, ax) - 1, 21, Math.min(z, az) - 1, Math.max(x, ax) + 1, 21, Math.max(z, az) + 1, B.DOCK);
      boat(d, ax + f.dz * 4 + f.dx * 3, az + f.dx * 4 + f.dz * 3, f.dx !== 0, v < 0.5 ? B.HULL_WHITE : B.HULL_BLUE);
      break;
    }
    case 'dock': {
      const len = 12;
      for (let s = 0; s <= len; s++) for (let w = -1; w <= 1; w++) {
        const px = x + f.dx * s + (f.dz !== 0 ? w : 0), pz = z + f.dz * s + (f.dx !== 0 ? w : 0);
        d.set(px, 21, pz, B.DOCK);
        if (s % 4 === 0 && w !== 0) for (let y = 14; y <= 20; y++) if (!g.isLandAt(px, pz)) d.set(px, y, pz, B.DARK_PLANK);
      }
      const ex = x + f.dx * len, ez = z + f.dz * len;
      boat(d, ex + f.dz * 3, ez + f.dx * 3, f.dx !== 0, v < 0.5 ? B.HULL_WHITE : B.HULL_BLUE);
      d.lamp(ex, G, ez, 2);
      break;
    }
    case 'bunker': {
      d.box(x - 5, b - 1, z - 4, x + 5, b - 1, z + 4, B.CONCRETE);
      for (let k = 0; k < 4; k++) d.box(x - 5 + k, b + k, z - 4 + k, x + 5 - k, b + k, z + 4 - k, B.CONCRETE);
      d.box(x - 1, b, z - 4, x + 1, b + 1, z - 4, B.SHUTTER);
      d.box(x + 3, b + 4, z, x + 3, b + 9, z, B.TRUSS); d.set(x + 3, b + 10, z, B.LIGHT_RED);
      for (let k = -7; k <= 7; k++) { d.set(x + k, b, z + 7, B.CHAINLINK); d.set(x + k, b + 1, z + 7, B.CHAINLINK); }
      break;
    }
  }
}

// ───────────────────────────────────────────────────────────── roadside slots
export type SlotType = 'billboard' | 'gas' | 'rest_stop' | 'fruit_stand' | 'gator_sign';
export interface RoadSlot { type: SlotType; x: number; z: number; r: number; /** driveway end on the road edge */ rx: number; rz: number; v: number; facing: 'N' | 'S' | 'E' | 'W' }

export function planRoadSlots(map: MapData, g: GenProbe, protect: (x: number, z: number, r: number) => boolean): RoadSlot[] {
  const out: RoadSlot[] = [];
  const SP = 210;
  for (const road of map.roads) {
    if (road.kind === 'street') continue;
    const hw = road.kind === 'highway' ? 8 : 5;
    let acc = 0;
    let slot = 0;
    for (let k = 0; k + 1 < road.points.length; k++) {
      const [ax, az] = road.points[k], [bx, bz] = road.points[k + 1];
      const len = Math.hypot(bx - ax, bz - az);
      const dx = (bx - ax) / len, dz = (bz - az) / len;
      for (let s = (SP - (acc % SP)) % SP; s < len; s += SP) {
        slot++;
        const hv = hash2(slot, road.id.length * 131 + road.points.length, 7071 + k);
        const side = hv < 0.5 ? 1 : -1;
        const nx = -dz * side, nz = dx * side;
        const px = ax + dx * s, pz = az + dz * s;
        const reg = g.regionAt(px, pz), zone = g.zoneAt(px, pz);
        if (URBAN.has(zone) || zone === 'airport' || reg === RG.starfall) continue;
        const u = hash2(slot, k, 7072 + road.id.length);
        let type: SlotType = u < 0.5 ? 'billboard' : u < 0.68 ? 'gas' : u < 0.8 ? 'rest_stop' : 'fruit_stand';
        if (type === 'fruit_stand' && reg !== RG.farmland && reg !== RG.wild) type = 'billboard';
        if (reg === RG.sawgrass && u > 0.8) type = 'gator_sign';
        const r = type === 'billboard' ? 6 : type === 'gas' ? 13 : type === 'rest_stop' ? 13 : type === 'gator_sign' ? 8 : 6;
        const off = hw + 4 + r;
        const cx = Math.round(px + nx * off), cz = Math.round(pz + nz * off);
        let ok = true;
        for (const [ox, oz] of [[0, 0], [-r, -r], [r, -r], [-r, r], [r, r]]) {
          const qx = cx + ox, qz = cz + oz;
          if (!g.isLandAt(qx, qz) || g.onRoad(qx, qz) || g.roadDistAt(qx, qz) < 2 || URBAN.has(g.zoneAt(qx, qz)) || g.zoneAt(qx, qz) === 'airport') { ok = false; break; }
          if (g.terrainTop(qx, qz) > 23) { ok = false; break; }
        }
        if (!ok || protect(cx, cz, r + 4)) continue;
        const facing: RoadSlot['facing'] = Math.abs(nx) > Math.abs(nz) ? (nx > 0 ? 'W' : 'E') : (nz > 0 ? 'N' : 'S');
        out.push({ type, x: cx, z: cz, r, rx: Math.round(px + nx * (hw - 1)), rz: Math.round(pz + nz * (hw - 1)), v: u, facing });
      }
      acc += len;
    }
  }
  return out;
}

export function buildSlot(d: Draw, s: RoadSlot, g: GenProbe) {
  const { x, z, r, v } = s;
  // flatten the pad
  if (s.type !== 'billboard') {
    d.box(x - r, 21, z - r, x + r, 21, z + r, s.type === 'gas' ? B.ASPHALT : B.GRASS);
    d.box(x - r, 22, z - r, x + r, 26, z + r, B.AIR);
    // driveway to the road
    const n = Math.ceil(Math.hypot(s.rx - x, s.rz - z));
    for (let i = 0; i <= n; i++) {
      const px = Math.round(x + ((s.rx - x) * i) / n), pz = Math.round(z + ((s.rz - z) * i) / n);
      for (let a = -2; a <= 2; a++) for (let c = -2; c <= 2; c++) if (Math.abs(a) + Math.abs(c) <= 2 && !g.onRoad(px + a, pz + c)) { d.set(px + a, 21, pz + c, B.ASPHALT); for (let y = 22; y < 25; y++) d.set(px + a, y, pz + c, B.AIR); }
    }
  }
  switch (s.type) {
    case 'billboard': {
      const bb = BILLBOARDS[Math.floor(v * BILLBOARDS.length)];
      const ew = s.facing === 'E' || s.facing === 'W';
      const w = bb[0].length + 3;
      const b = g.terrainTop(x, z) + 1;
      for (const o of [-(w >> 1) + 2, (w >> 1) - 2]) { const px = ew ? x : x + o, pz = ew ? z + o : z; for (let y = b; y < b + 7; y++) d.set(px, y, pz, B.METAL); }
      for (let o = -(w >> 1); o <= (w >> 1); o++) for (let k = 7; k <= 11; k++) { const px = ew ? x : x + o, pz = ew ? z + o : z; d.set(px, b + k, pz, bb[1]); }
      d.text(bb[0], ew ? z : x, b + 9, ew ? x : z, s.facing);
      for (let o = -(w >> 1); o <= (w >> 1); o += 3) d.set(ew ? x : x + o, b + 12, ew ? z + o : z, B.LAMP);
      break;
    }
    case 'gas': {
      const brand = ['GATOR GAS', 'SUNPUMP', 'BLUEWAVE'][Math.floor(v * 3)];
      const col = [B.AWNING_GREEN, B.AWNING_YELLOW, B.AWNING_BLUE][Math.floor(v * 3)];
      d.box(x - 8, G + 5, z - 5, x + 8, G + 5, z + 3, B.STUCCO_WHITE);
      d.walls(x - 8, G + 5, z - 5, x + 8, G + 6, z + 3, col);
      d.text(brand, x, G + 6, z - 5, 'N'); d.text(brand, x, G + 6, z + 3, 'S');
      for (const px of [x - 4, x + 4]) { d.box(px, G, z - 3, px, G, z + 1, B.CONCRETE); d.box(px, G + 1, z - 1, px, G + 4, z - 1, B.METAL); d.set(px, G + 1, z - 3, B.PUMP); d.set(px, G + 2, z - 3, B.PUMP); d.set(px, G + 1, z + 1, B.PUMP); d.set(px, G + 2, z + 1, B.PUMP); }
      d.box(x - 6, G, z + 6, x + 6, G + 4, z + 12, B.STUCCO_WHITE);
      d.box(x - 5, G + 1, z + 6, x + 5, G + 2, z + 6, B.GLASS);
      d.box(x - 6, G + 4, z + 6, x + 6, G + 4, z + 6, col);
      d.text('MART', x, G + 5, z + 6, 'N');
      d.box(x + 11, G, z - 11, x + 11, G + 9, z - 11, B.METAL); d.box(x + 10, G + 10, z - 11, x + 12, G + 12, z - 11, col);
      d.set(x + 11, G + 11, z - 11, B.NEON_YELLOW);
      break;
    }
    case 'rest_stop': {
      d.box(x - 12, 21, z - 12, x + 12, 21, z - 4, B.ASPHALT);
      for (let px = x - 11; px <= x + 11; px += 3) d.box(px, 21, z - 11, px, 21, z - 7, B.LINE_WHITE);
      d.cottage(x - 4, G, z + 1, 9, 7, B.BRICK_TAN, B.SHINGLE_GREEN);
      d.text('REST AREA', x, G + 6, z, 'N');
      for (const [px, pz] of [[x - 9, z + 3], [x + 9, z + 3], [x - 9, z + 9], [x + 9, z + 9]]) {
        d.box(px - 1, G, pz, px + 1, G, pz, B.DARK_PLANK); d.box(px - 1, G, pz - 1, px + 1, G, pz - 1, B.PLANK); d.box(px - 1, G, pz + 1, px + 1, G, pz + 1, B.PLANK);
        d.box(px, G + 1, pz, px, G + 2, pz, B.METAL); d.box(px - 1, G + 3, pz - 1, px + 1, G + 3, pz + 1, B.TIN_ROOF);
      }
      d.lamp(x - 12, G, z - 3, 5); d.lamp(x + 12, G, z - 3, 5);
      d.palm(x - 12, G, z + 11, 7); d.palm(x + 12, G, z + 11, 8);
      break;
    }
    case 'fruit_stand': {
      d.box(x - 3, G, z - 2, x + 3, G, z + 2, B.DARK_PLANK);
      d.box(x - 3, G + 1, z - 2, x + 3, G + 1, z - 2, B.ORANGE_LEAVES);
      for (const [ox, oz] of [[-3, -2], [3, -2], [-3, 2], [3, 2]]) d.box(x + ox, G + 1, z + oz, x + ox, G + 3, z + oz, B.DARK_PLANK);
      d.box(x - 4, G + 4, z - 3, x + 4, G + 4, z + 3, B.AWNING_YELLOW);
      d.text('CITRUS', x, G + 5, z - 3, 'N');
      for (let k = 0; k < 4; k++) d.set(x - 5 + k * 3, G, z + 4, B.HAY_BALE);
      break;
    }
    case 'gator_sign': {
      d.box(x - 6, G, z, x + 6, G, z, B.DARK_PLANK);
      for (const o of [-5, 5]) d.box(x + o, G, z, x + o, G + 5, z, B.DARK_PLANK);
      d.box(x - 6, G + 6, z, x + 6, G + 8, z, B.AWNING_GREEN);
      d.text('GATOR TOURS', x, G + 7, z, s.facing === 'S' ? 'S' : 'N');
      d.cottage(x - 4, G, z + 4, 8, 6, B.DARK_PLANK, B.TIN_ROOF);
      break;
    }
  }
}

/**
 * Pre-computed coarse rasters derived from the map data (4-block cells), plus a
 * spatial index for line features (roads, rivers). Built once per process/worker.
 */
import type { MapData, P2, RoadKind, ZoneKind } from './mapTypes.ts';
import { ZONE_KINDS } from './mapTypes.ts';
import { valueNoise } from './noise.ts';

export const CELL = 4;

export interface Seg {
  ax: number; az: number; bx: number; bz: number;
  /** half width */
  hw: number;
  kind: 'road' | 'river';
  roadKind?: RoadKind;
  /** unit direction */
  dx: number; dz: number; len: number;
  /** distance along the polyline at segment start (for dash patterns) */
  s0: number;
  featureId: string;
}

function fillPolygon(points: P2[], cw: number, ch: number, cb: (i: number) => void) {
  // scanline at cell centres
  const n = points.length;
  let minZ = Infinity, maxZ = -Infinity;
  for (const p of points) { minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]); }
  const r0 = Math.max(0, Math.floor(minZ / CELL)), r1 = Math.min(ch - 1, Math.ceil(maxZ / CELL));
  const xs: number[] = [];
  for (let r = r0; r <= r1; r++) {
    const z = r * CELL + CELL / 2;
    xs.length = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, zi] = points[i], [xj, zj] = points[j];
      if ((zi > z) !== (zj > z)) xs.push(xi + ((z - zi) / (zj - zi)) * (xj - xi));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(xs[k] / CELL - 0.5)), c1 = Math.min(cw - 1, Math.floor(xs[k + 1] / CELL - 0.5));
      for (let c = c0; c <= c1; c++) cb(r * cw + c);
    }
  }
}

export function pointInPolygon(x: number, z: number, pts: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, zi] = pts[i], [xj, zj] = pts[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

export class MapRaster {
  readonly cw: number;
  readonly ch: number;
  /** smoothed land 0..1 */
  readonly land: Float32Array;
  /** 0 none, 1 lake (fresh), 2 sea inlet */
  readonly waterBody: Uint8Array;
  readonly zone: Uint8Array;
  /** signed distance (cells) to the shoreline: >0 on land, <0 in water. capped at ±48 */
  readonly dist: Int8Array;
  readonly segs: Seg[] = [];
  private buckets = new Map<number, number[]>();
  static readonly BUCKET = 64;

  constructor(readonly map: MapData) {
    const cw = (this.cw = Math.ceil(map.width / CELL));
    const ch = (this.ch = Math.ceil(map.depth / CELL));
    const n = cw * ch;
    const raw = new Uint8Array(n);
    for (const l of map.land) fillPolygon(l.points, cw, ch, (i) => (raw[i] = 1));
    // barrier islands: stroke
    for (const bar of map.barriers) this.stroke(bar.points, bar.width / 2, cw, ch, (i) => (raw[i] = 1));
    const wb = (this.waterBody = new Uint8Array(n));
    for (const w of map.water) fillPolygon(w.points, cw, ch, (i) => { raw[i] = 0; wb[i] = w.kind === 'lake' ? 1 : 2; });

    // blur twice (3x3 box)
    let a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = raw[i];
    for (let pass = 0; pass < 2; pass++) {
      const b = new Float32Array(n);
      for (let r = 0; r < ch; r++) for (let c = 0; c < cw; c++) {
        let s = 0, k = 0;
        for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= ch || cc >= cw) { k++; continue; }
          s += a[rr * cw + cc]; k++;
        }
        b[r * cw + c] = s / k;
      }
      a = b;
    }
    this.land = a;

    // signed distance via two BFS passes
    const dist = (this.dist = new Int8Array(n));
    const isLand = (i: number) => a[i] >= 0.5;
    const bfs = (landSide: boolean) => {
      const d = new Int16Array(n).fill(-1);
      const q = new Int32Array(n);
      let qh = 0, qt = 0;
      for (let r = 0; r < ch; r++) for (let c = 0; c < cw; c++) {
        const i = r * cw + c;
        if (isLand(i) !== landSide) continue;
        // boundary cell?
        let edge = false;
        if (c > 0 && isLand(i - 1) !== landSide) edge = true;
        else if (c < cw - 1 && isLand(i + 1) !== landSide) edge = true;
        else if (r > 0 && isLand(i - cw) !== landSide) edge = true;
        else if (r < ch - 1 && isLand(i + cw) !== landSide) edge = true;
        if (edge) { d[i] = 1; q[qt++] = i; }
      }
      while (qh < qt) {
        const i = q[qh++];
        const di = d[i];
        if (di >= 48) continue;
        const c = i % cw, r = (i / cw) | 0;
        const nb = [c > 0 ? i - 1 : -1, c < cw - 1 ? i + 1 : -1, r > 0 ? i - cw : -1, r < ch - 1 ? i + cw : -1];
        for (const j of nb) {
          if (j < 0 || d[j] !== -1 || isLand(j) !== landSide) continue;
          d[j] = di + 1; q[qt++] = j;
        }
      }
      return d;
    };
    const dl = bfs(true), dw = bfs(false);
    for (let i = 0; i < n; i++) dist[i] = isLand(i) ? (dl[i] < 0 ? 48 : dl[i]) : -(dw[i] < 0 ? 48 : dw[i]);

    // zones (later wins)
    const zone = (this.zone = new Uint8Array(n));
    for (const z of map.zones) {
      const k = ZONE_KINDS.indexOf(z.kind);
      fillPolygon(z.points, cw, ch, (i) => (zone[i] = k));
    }

    // line features
    for (const r of map.roads) {
      const hw = r.kind === 'highway' ? 8 : r.kind === 'arterial' ? 5 : 4;
      this.addPolyline(r.points, hw, 'road', r.id, r.kind);
    }
    for (const rv of map.rivers) this.addPolyline(rv.points, rv.width / 2, 'river', rv.id);
  }

  private stroke(points: P2[], hw: number, cw: number, ch: number, cb: (i: number) => void) {
    for (let k = 0; k + 1 < points.length; k++) {
      const [ax, az] = points[k], [bx, bz] = points[k + 1];
      const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - hw) / CELL)), c1 = Math.min(cw - 1, Math.ceil((Math.max(ax, bx) + hw) / CELL));
      const r0 = Math.max(0, Math.floor((Math.min(az, bz) - hw) / CELL)), r1 = Math.min(ch - 1, Math.ceil((Math.max(az, bz) + hw) / CELL));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
        const d = distToSeg(c * CELL + 2, r * CELL + 2, ax, az, bx, bz);
        if (d <= hw) cb(r * cw + c);
      }
    }
  }

  private addPolyline(points: P2[], hw: number, kind: 'road' | 'river', id: string, roadKind?: RoadKind) {
    let s = 0;
    for (let k = 0; k + 1 < points.length; k++) {
      const [ax, az] = points[k], [bx, bz] = points[k + 1];
      const len = Math.hypot(bx - ax, bz - az) || 1;
      const seg: Seg = { ax, az, bx, bz, hw, kind, roadKind, dx: (bx - ax) / len, dz: (bz - az) / len, len, s0: s, featureId: id };
      s += len;
      const idx = this.segs.push(seg) - 1;
      const B = MapRaster.BUCKET, m = hw + 32;
      const x0 = Math.floor((Math.min(ax, bx) - m) / B), x1 = Math.floor((Math.max(ax, bx) + m) / B);
      const z0 = Math.floor((Math.min(az, bz) - m) / B), z1 = Math.floor((Math.max(az, bz) + m) / B);
      for (let bz2 = z0; bz2 <= z1; bz2++) for (let bx2 = x0; bx2 <= x1; bx2++) {
        const key = bz2 * 4096 + bx2;
        let arr = this.buckets.get(key);
        if (!arr) this.buckets.set(key, (arr = []));
        arr.push(idx);
      }
    }
  }

  segsNear(x: number, z: number): number[] {
    const B = MapRaster.BUCKET;
    return this.buckets.get(Math.floor(z / B) * 4096 + Math.floor(x / B)) ?? EMPTY;
  }

  cellIndex(x: number, z: number): number {
    const c = Math.min(this.cw - 1, Math.max(0, Math.floor(x / CELL)));
    const r = Math.min(this.ch - 1, Math.max(0, Math.floor(z / CELL)));
    return r * this.cw + c;
  }

  /** Smooth landness with coastline noise. */
  landValue(x: number, z: number): number {
    const fx = x / CELL - 0.5, fz = z / CELL - 0.5;
    const c = Math.floor(fx), r = Math.floor(fz);
    const tx = fx - c, tz = fz - r;
    const g = (cc: number, rr: number) => {
      if (cc < 0 || rr < 0 || cc >= this.cw || rr >= this.ch) return 0;
      return this.land[rr * this.cw + cc];
    };
    const v = g(c, r) * (1 - tx) * (1 - tz) + g(c + 1, r) * tx * (1 - tz) + g(c, r + 1) * (1 - tx) * tz + g(c + 1, r + 1) * tx * tz;
    return v + valueNoise(x / 14, z / 14, 7) * 0.12;
  }

  isLand(x: number, z: number): boolean {
    if (x < 0 || z < 0 || x >= this.map.width || z >= this.map.depth) return false;
    return this.landValue(x + 0.5, z + 0.5) >= 0.5;
  }

  zoneAt(x: number, z: number): ZoneKind { return ZONE_KINDS[this.zone[this.cellIndex(x, z)]]; }
  zoneIdx(x: number, z: number): number { return this.zone[this.cellIndex(x, z)]; }
  distAt(x: number, z: number): number { return this.dist[this.cellIndex(x, z)]; }
  waterBodyAt(x: number, z: number): number { return this.waterBody[this.cellIndex(x, z)]; }
}

const EMPTY: number[] = [];

export function distToSeg(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax, vz = bz - az;
  const l2 = vx * vx + vz * vz;
  let t = l2 > 0 ? ((px - ax) * vx + (pz - az) * vz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + vx * t), pz - (az + vz * t));
}

let shared: MapRaster | null = null;
let sharedFor: MapData | null = null;
export function getRaster(map: MapData): MapRaster {
  if (!shared || sharedFor !== map) { shared = new MapRaster(map); sharedFor = map; }
  return shared;
}

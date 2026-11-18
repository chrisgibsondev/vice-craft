/**
 * Deterministic world generator. Given the map data it produces the exact same
 * blocks on the server (collision) and in client workers (rendering).
 *
 * Two passes per region:
 *  1. column pass: terrain (beaches + dunes, rock outcrops, meadows, fields and
 *     groves, wetland pools, reefs), roads with guard rails, airports, and the urban
 *     street grid whose lots are filled by the per-region generators in regions.ts;
 *  2. stamp pass: POI prefabs, landmarks (landmarks.ts), roadside stops, scattered
 *     features, then trees (oak, longleaf, spruce, cypress, sabal, palm, mangrove).
 *
 * Region layout: index = x + z*w + y*w*d, y in 0..WORLD_H-1.
 */
import { B } from './blocks.ts';
import type { MapData, ZoneKind } from './mapTypes.ts';
import { ZONE_KINDS } from './mapTypes.ts';
import { getRaster, distToSeg, type MapRaster, type Seg } from './raster.ts';
import { fbm, hash2, hashInt, valueNoise } from './noise.ts';
import { WORLD_H, SEA_LEVEL } from '../constants.ts';
import { getPrefab, LOT, STRUCT_H } from './structures.ts';
import { POI_BY_LOT, lotKey } from '../content/pois.ts';
import {
  RegionRaster, RG, REGION_LIST, STYLES, LOT_GENS, MIN_SIDE, pickMix, styleLot,
  type LotKind, type LotPlan, type RegionId,
} from './regions.ts';
import {
  Draw, LANDMARKS, FCELL, FEATURE_MAX_R, planFeature, buildFeature, planRoadSlots, buildSlot,
  type GenProbe, type FeaturePlan, type RoadSlot, type Landmark, type Sink,
} from './landmarks.ts';

export type { LotKind, LotPlan, RegionId };
export { REGION_LIST, LANDMARKS };

const URBANISH = new Set<ZoneKind>(['suburb', 'urban', 'downtown', 'industrial', 'resort']);
const Z = Object.fromEntries(ZONE_KINDS.map((k, i) => [k, i])) as Record<ZoneKind, number>;
const MCELL = 4;

/** Gameplay areas that procedural scatter must never touch (missions, cutscenes, boat legs). */
const PROTECT_RECTS: [number, number, number, number][] = [
  [2140, 2940, 2900, 3480], // Port Solano metro: downtown, port, beach, airport (all mission content)
  [1330, 4262, 1400, 4320], // Conch Harbor arrival (story_7 / cutscenes)
];
/** Lots holding mission spots: forced to open kinds so every authored position stays walkable. */
const KEEP_LOTS: [number, number, LotKind][] = [[28, 89, 'square'], [53, 67, 'plaza'], [56, 66, 'square']];
const PROTECT_LEGS: [number, number][] = [[2162, 4062], [2006, 4146], [1850, 4206], [1496, 4278], [1388, 4290]];

export interface RoadInfo {
  seg: Seg;
  /** signed lateral offset from the centre line */
  cross: number;
  along: number;
}
type TreeType = 'oak' | 'pine' | 'palm' | 'cypress' | 'longleaf' | 'spruce' | 'sabal' | 'mangrove' | 'mossy_oak';

export class WorldGen implements GenProbe {
  readonly r: MapRaster;
  readonly regions: RegionRaster;
  private lots = new Map<number, LotPlan>();
  /** 4-block cells: 1 = landmark/roadside footprint (flat, no decoration), 2 = guard-rail gap */
  private mask: Uint8Array;
  private lotOverride = new Map<number, LotKind>();
  private recorded = new Map<string, Map<number, Int32Array>>();
  private features = new Map<number, FeaturePlan | null>();
  readonly slots: RoadSlot[];
  private slotBoxes: [number, number, number, number][];
  private towns: [number, number, number, number][] = [];

  constructor(readonly map: MapData) {
    this.r = getRaster(map);
    this.regions = new RegionRaster(map);
    this.mask = new Uint8Array(this.r.cw * this.r.ch);
    for (const z of map.zones) if (z.id.startsWith('town_')) {
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const [x, zz] of z.points) { x0 = Math.min(x0, x); z0 = Math.min(z0, zz); x1 = Math.max(x1, x); z1 = Math.max(z1, zz); }
      this.towns.push([x0, z0, x1, z1]);
    }
    for (const [i, j, k] of KEEP_LOTS) this.lotOverride.set(lotKey(i, j), k);
    for (const l of LANDMARKS) {
      this.markRect(l.flat, 1);
      for (const [i, j, k] of l.lots ?? []) this.lotOverride.set(lotKey(i, j), k);
    }
    this.slots = planRoadSlots(map, this, (x, z, r) => this.isProtected(x, z, r));
    this.slotBoxes = this.slots.map((s) => {
      this.markRect([s.x - s.r, s.z - s.r, s.x + s.r, s.z + s.r], 1);
      this.markRect([s.rx - 6, s.rz - 6, s.rx + 6, s.rz + 6], 2);
      return [Math.min(s.x - s.r, s.rx - 4), Math.min(s.z - s.r, s.rz - 4), Math.max(s.x + s.r, s.rx + 4), Math.max(s.z + s.r, s.rz + 4)] as [number, number, number, number];
    });
  }

  private markRect([x0, z0, x1, z1]: [number, number, number, number], v: number) {
    const c0 = Math.max(0, Math.floor(x0 / MCELL)), c1 = Math.min(this.r.cw - 1, Math.floor(x1 / MCELL));
    const r0 = Math.max(0, Math.floor(z0 / MCELL)), r1 = Math.min(this.r.ch - 1, Math.floor(z1 / MCELL));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const i = r * this.r.cw + c; if (this.mask[i] !== 1) this.mask[i] = v; }
  }
  maskAt(x: number, z: number): number { return this.mask[this.r.cellIndex(x, z)]; }
  isProtected(x: number, z: number, r: number): boolean {
    for (const [x0, z0, x1, z1] of PROTECT_RECTS) if (x + r >= x0 && x - r <= x1 && z + r >= z0 && z - r <= z1) return true;
    for (let k = 0; k + 1 < PROTECT_LEGS.length; k++) {
      const [ax, az] = PROTECT_LEGS[k], [bx, bz] = PROTECT_LEGS[k + 1];
      if (distToSeg(x, z, ax, az, bx, bz) < r + 24) return true;
    }
    for (const l of LANDMARKS) { const [x0, z0, x1, z1] = l.bbox; if (x + r >= x0 - 6 && x - r <= x1 + 6 && z + r >= z0 - 6 && z - r <= z1 + 6) return true; }
    return false;
  }

  // ── GenProbe ─────────────────────────────────────────────────────────────
  isLandAt(x: number, z: number) { return this.r.isLand(x, z); }
  roadDistAt(x: number, z: number) { return this.lineInfo(x, z).roadDist; }
  onRoad(x: number, z: number) { return this.lineInfo(x, z).road !== null; }
  zoneAt(x: number, z: number) { return this.r.zoneAt(x, z); }
  regionAt(x: number, z: number) { return this.regions.at(x, z); }
  distAt(x: number, z: number) { return this.r.distAt(x, z); }
  waterBodyAt(x: number, z: number) { return this.r.waterBodyAt(x, z); }

  // ── classification helpers ───────────────────────────────────────────────
  /** Nearest road hit (if on a road), river flag, and distances to the nearest road / river edge. */
  lineInfo(x: number, z: number): { road: RoadInfo | null; river: boolean; roadDist: number; riverDist: number } {
    const px = x + 0.5, pz = z + 0.5;
    let road: RoadInfo | null = null, best = Infinity, river = false, roadDist = Infinity, riverDist = Infinity;
    for (const si of this.r.segsNear(px, pz)) {
      const s = this.r.segs[si];
      const d = distToSeg(px, pz, s.ax, s.az, s.bx, s.bz);
      if (s.kind === 'river') { if (d <= s.hw) river = true; if (d - s.hw < riverDist) riverDist = d - s.hw; continue; }
      const edge = d - s.hw;
      if (edge < roadDist) roadDist = edge;
      if (d <= s.hw && d < best) {
        best = d;
        const rx = px - s.ax, rz = pz - s.az;
        road = { seg: s, cross: rx * s.dz - rz * s.dx, along: s.s0 + rx * s.dx + rz * s.dz };
      }
    }
    return { road, river, roadDist, riverDist };
  }
  /** distance to the centre line of the nearest road that is not `fid` */
  private otherRoadDist(x: number, z: number, fid: string): number {
    let best = Infinity;
    for (const si of this.r.segsNear(x + 0.5, z + 0.5)) {
      const s = this.r.segs[si];
      if (s.kind !== 'road' || s.featureId === fid) continue;
      best = Math.min(best, distToSeg(x + 0.5, z + 0.5, s.ax, s.az, s.bx, s.bz) - s.hw);
    }
    return best;
  }

  lotPlan(i: number, j: number): LotPlan {
    const key = lotKey(i, j);
    let p = this.lots.get(key);
    if (p) return p;
    const cx = i * LOT + 24, cz = j * LOT + 24;
    const zone = this.r.zoneAt(cx, cz);
    const seed = Math.floor(hash2(i, j, 99) * 1e9);
    const region = this.regions.at(cx, cz);
    const rv = new Float32Array(20);
    for (let k = 0; k < 20; k++) rv[k] = hash2(i * 7 + k, j * 13 - k, seed & 1023);
    p = { kind: 'margin', zone, seed, region, rect: [0, 0, 33, 33], rv, wall: B.STUCCO_WHITE, accent: B.NEON_CYAN, trim: B.STUCCO_WHITE, roof: B.CONCRETE, h: 10, h2: 10, inset: 0, name: '' };
    const st = STYLES[REGION_LIST[region]];
    if (POI_BY_LOT.has(key)) p.kind = 'poi';
    else if (this.lotOverride.has(key)) { p.kind = this.lotOverride.get(key)!; if (p.kind !== 'landmark') p.rect = this.freeRect(i, j) ?? [0, 0, 33, 33]; }
    else if (URBANISH.has(zone)) {
      const rect = this.freeRect(i, j);
      if (rect) {
        p.rect = rect;
        const m = Math.min(rect[2] - rect[0], rect[3] - rect[1]) + 1;
        const mix = (m >= 30 ? st.big : m >= 16 ? st.mid : st.small).filter(([k]) => (MIN_SIDE[k] ?? 99) <= m);
        if (mix.length) {
          let kind = pickMix(mix, rv[1]);
          // never the same special lot type as the west / north neighbour
          if (!REPEATABLE.has(kind)) {
            const w = pickMix(mix, hash2((i - 1) * 7 + 1, j * 13 - 1, Math.floor(hash2(i - 1, j, 99) * 1e9) & 1023));
            const n = pickMix(mix, hash2(i * 7 + 1, (j - 1) * 13 - 1, Math.floor(hash2(i, j - 1, 99) * 1e9) & 1023));
            for (let t = 0; t < 4 && (kind === w || kind === n); t++) kind = pickMix(mix, hash2(i, j, 300 + t));
          }
          p.kind = kind;
        }
      }
    }
    if (p.kind !== 'margin' && p.kind !== 'poi') styleLot(p, st);
    this.lots.set(key, p);
    return p;
  }

  /** Largest road-free rectangle of the lot's building area (sampled every 3 blocks), or null. */
  private freeRect(i: number, j: number): [number, number, number, number] | null {
    const N = 12, S = 3;
    const free = new Uint8Array(N * N);
    let all = true;
    for (let a = 0; a < N; a++) for (let b = 0; b < N; b++) {
      const x = i * LOT + 7 + b * S, z = j * LOT + 7 + a * S;
      let ok = this.r.isLand(x, z) && URBANISH.has(this.r.zoneAt(x, z)) && this.maskAt(x, z) !== 1;
      if (ok) { const li = this.lineInfo(x, z); ok = !li.river && li.roadDist >= 3; }
      free[a * N + b] = ok ? 1 : 0;
      if (!ok) all = false;
    }
    if (all) return [0, 0, 33, 33];
    // prefix sums for O(1) rectangle checks
    const P = new Int32Array((N + 1) * (N + 1));
    for (let a = 0; a < N; a++) for (let b = 0; b < N; b++) P[(a + 1) * (N + 1) + b + 1] = free[a * N + b] + P[a * (N + 1) + b + 1] + P[(a + 1) * (N + 1) + b] - P[a * (N + 1) + b];
    const sum = (a0: number, b0: number, a1: number, b1: number) => P[(a1 + 1) * (N + 1) + b1 + 1] - P[a0 * (N + 1) + b1 + 1] - P[(a1 + 1) * (N + 1) + b0] + P[a0 * (N + 1) + b0];
    let best = 0, br: [number, number, number, number] | null = null;
    for (let a0 = 0; a0 < N; a0++) for (let b0 = 0; b0 < N; b0++) {
      if (!free[a0 * N + b0]) continue;
      for (let a1 = a0; a1 < N; a1++) {
        if (!free[a1 * N + b0]) break;
        for (let b1 = b0; b1 < N; b1++) {
          const area = (a1 - a0 + 1) * (b1 - b0 + 1);
          if (sum(a0, b0, a1, b1) !== area) break;
          const score = Math.min(a1 - a0, b1 - b0) * 100 + area;
          if (score > best) { best = score; br = [b0, a0, b1, a1]; }
        }
      }
    }
    if (!br) return null;
    const [b0, a0, b1, a1] = br;
    const x0 = b0 === 0 ? 0 : b0 * S + 1, z0 = a0 === 0 ? 0 : a0 * S + 1, x1 = b1 === N - 1 ? 33 : b1 * S - 1, z1 = a1 === N - 1 ? 33 : a1 * S - 1;
    if (x1 - x0 < 7 || z1 - z0 < 7) return null;
    return [x0, z0, x1, z1];
  }

  private flatFactor(x: number, z: number): number {
    let f = 1;
    for (const [x0, z0, x1, z1] of this.towns) {
      const dx = Math.max(x0 - x, 0, x - x1), dz = Math.max(z0 - z, 0, z - z1);
      const d = Math.max(dx, dz);
      if (d < 40) f = Math.min(f, d / 40);
    }
    return f;
  }

  private hillHeight(x: number, z: number, zone: ZoneKind, roadDist: number, dist: number): number {
    const amp = zone === 'forest' ? (z < 1300 ? 6 : 3) : zone === 'farmland' ? 1.5 : 0;
    if (amp === 0) return 0;
    let h = (fbm(x / 160, z / 160, 31, 3) * 0.5 + 0.5) * amp;
    h *= Math.min(1, Math.max(0, (roadDist - 3) / 24));
    h *= Math.min(1, Math.max(0, (dist - 2) / 6));
    if (zone === 'forest') h *= this.flatFactor(x, z);
    return Math.floor(h);
  }

  /** extra ground height from dunes / rock outcrops (0 when not applicable) */
  private reliefAt(x: number, z: number, zone: ZoneKind, roadDist: number, dist: number, masked: boolean): { add: number; rock: boolean; dune: boolean } {
    if (masked || URBANISH.has(zone) || zone === 'airport' || zone === 'wetland') return NO_RELIEF;
    if (dist >= 2 && dist <= 5 && roadDist > 5 && zone !== 'farmland') {
      const n = valueNoise(x / 7, z / 9, 91) * 0.5 + 0.5;
      const fade = Math.min(1, (dist - 1) / 2) * Math.min(1, (6 - dist) / 2) * Math.min(1, (roadDist - 5) / 6);
      const add = Math.floor(n * 2.6 * fade);
      return add > 0 ? { add, rock: false, dune: true } : NO_RELIEF;
    }
    if (z < 1300 && (zone === 'forest' || zone === 'none') && roadDist > 8 && dist > 4) {
      const n = fbm(x / 36, z / 36, 71, 2);
      if (n > 0.38) return { add: Math.min(7, Math.floor((n - 0.38) * 26 * Math.min(1, (roadDist - 8) / 10) * this.flatFactor(x, z))), rock: true, dune: false };
    }
    return NO_RELIEF;
  }

  /** Height (y of the top solid block) of ground terrain at x,z ignoring buildings. */
  terrainTop(x: number, z: number): number {
    if (!this.r.isLand(x, z)) return SEA_LEVEL - 4;
    const li = this.lineInfo(x, z);
    if (li.road) return 21;
    if (li.river) return 16;
    const zone = this.r.zoneAt(x, z);
    const dist = this.r.distAt(x, z);
    const masked = this.maskAt(x, z) === 1;
    const hill = masked ? 0 : this.hillHeight(x, z, zone, li.roadDist, dist);
    return 21 + hill + this.reliefAt(x, z, zone, li.roadDist, dist, masked).add;
  }

  // ── region generation ────────────────────────────────────────────────────
  generateRegion(x0: number, z0: number, w: number, d: number, out: Uint8Array) {
    const plane = w * d;
    const H = WORLD_H;
    out.fill(0);
    const set = (lx: number, y: number, lz: number, id: number) => {
      if (lx < 0 || lz < 0 || lx >= w || lz >= d || y < 0 || y >= H) return;
      out[lx + lz * w + y * plane] = id;
    };
    const get = (lx: number, y: number, lz: number) => {
      if (lx < 0 || lz < 0 || lx >= w || lz >= d || y < 0 || y >= H) return B.AIR;
      return out[lx + lz * w + y * plane];
    };
    const W = this.map.width, D = this.map.depth;

    for (let lz = 0; lz < d; lz++) {
      for (let lx = 0; lx < w; lx++) {
        const x = x0 + lx, z = z0 + lz;
        const col = lx + lz * w;
        const fillCol = (y0: number, y1: number, id: number) => { for (let y = y0; y <= y1; y++) out[col + y * plane] = id; };

        if (x < 0 || z < 0 || x >= W || z >= D) {
          fillCol(0, 6, B.STONE); fillCol(7, 7, B.SAND); fillCol(8, SEA_LEVEL, B.WATER);
          continue;
        }
        const land = this.r.isLand(x, z);
        const dist = this.r.distAt(x, z);
        const zone = this.r.zoneAt(x, z);
        const li = this.lineInfo(x, z);

        // ── water columns (sea, lakes, rivers) ──
        if (!land || li.river) {
          let floor: number;
          const lake = this.r.waterBodyAt(x, z) === 1;
          if (li.river && land) floor = 16;
          else if (lake) floor = SEA_LEVEL - Math.min(8, 1 + Math.floor(-dist * 0.7));
          else floor = SEA_LEVEL - Math.min(14, 1 + Math.floor(-dist * 0.9));
          floor = Math.max(4, floor);
          fillCol(0, floor - 2, B.STONE);
          let bed: number = li.river ? B.MUD : B.SAND;
          if (!li.river && !lake && floor <= 17 && (z > 2700 || x > 2560 || x < 820)) {
            // shallow sea floors: seagrass meadows and coral heads in the warm south / east
            const n = valueNoise(x / 11, z / 11, 133);
            if (n > 0.1) bed = B.SEAGRASS;
            if (floor <= 15 && (z > 2900 || x > 2640)) {
              const hv = hash2(x, z, 134) * (valueNoise(x / 23, z / 23, 137) > 0.2 ? 1 : 4);
              if (hv < 0.018) {
                const c = hv < 0.006 ? B.CORAL_PINK : hv < 0.012 ? B.CORAL_ORANGE : B.CORAL_PURPLE;
                fillCol(floor - 1, floor, bed);
                fillCol(floor + 1, Math.min(18, floor + 1 + (hv < 0.009 ? 1 : 0)), c);
                fillCol(Math.min(18, floor + 1 + (hv < 0.009 ? 1 : 0)) + 1, SEA_LEVEL, B.WATER);
                if (li.road) this.bridgeDeck(li.road, floor, col, plane, out);
                continue;
              }
            }
          } else if (lake && floor <= 18 && valueNoise(x / 6, z / 6, 135) > 0.35) bed = B.MUD;
          fillCol(floor - 1, floor, bed);
          fillCol(floor + 1, SEA_LEVEL, B.WATER);
          if (lake && dist >= -1 && !li.road && hash2(x, z, 136) < 0.35) out[col + 21 * plane] = B.REEDS;
          if (li.road) this.bridgeDeck(li.road, floor, col, plane, out);
          continue;
        }

        // ── land ──
        const masked = this.maskAt(x, z);
        const hill = li.road || masked === 1 ? 0 : this.hillHeight(x, z, zone, li.roadDist, dist);
        const rel = li.road ? NO_RELIEF : this.reliefAt(x, z, zone, li.roadDist, dist, masked === 1);
        const top = 21 + hill + rel.add;
        fillCol(0, top - 4, B.STONE);
        fillCol(top - 3, top - 1, rel.rock ? B.STONE : B.DIRT);
        let surf: number = B.GRASS;
        const beachy = zone !== 'urban' && zone !== 'downtown' && zone !== 'industrial' && zone !== 'airport';
        if (rel.rock) surf = valueNoise(x / 5, z / 5, 72) > 0 ? B.MOSSY_STONE : B.GRANITE;
        else if (beachy && dist <= (zone === 'resort' ? 7 : 3) && zone !== 'wetland') surf = B.SAND;
        else if (rel.dune) surf = B.SAND;
        else if (zone === 'wetland') surf = valueNoise(x / 9, z / 9, 5) > 0.25 ? B.MUD : B.GRASS;
        out[col + top * plane] = surf;
        if (surf === B.SAND) fillCol(top - 2, top - 1, B.SAND);

        if (li.road) {
          this.roadSurface(li.road, (id) => out[col + 21 * plane] = id);
          // guard rails along highways in the open country
          const s = li.road.seg;
          if (s.roadKind === 'highway' && Math.abs(li.road.cross) >= s.hw - 0.75 && !URBANISH.has(zone) && zone !== 'airport' && masked !== 2 && this.otherRoadDist(x, z, s.featureId) > 10) {
            out[col + 22 * plane] = ((Math.floor(li.road.along) % 4) + 4) % 4 === 0 ? B.METAL : B.RAIL;
          }
          continue;
        }

        // airport pattern + runway lights
        if (zone === 'airport') {
          const m = ((z % 96) + 96) % 96;
          if (m >= 30 && m < 52) {
            let id: number = B.RUNWAY;
            if (m === 30 || m === 51) id = B.LINE_WHITE;
            else if ((m === 40 || m === 41) && (x % 16) < 8) id = B.LINE_WHITE;
            out[col + 21 * plane] = id;
          } else if (m >= 60 && m < 66) {
            out[col + 21 * plane] = (m === 62 || m === 63) ? B.LINE_YELLOW : B.ASPHALT;
          } else if ((m === 28 || m === 53) && ((x % 8) + 8) % 8 === 0) out[col + 22 * plane] = B.LIGHT_BLUE;
          else if ((m === 58 || m === 67) && ((x % 10) + 10) % 10 === 0) out[col + 22 * plane] = B.LIGHT_GREEN;
          else if (m >= 66 && m < 70) out[col + 21 * plane] = B.CONCRETE;
          else if (hash2(x, z, 3) < 0.04) out[col + 22 * plane] = B.TALL_GRASS;
          continue;
        }

        if (URBANISH.has(zone)) { this.urbanColumn(x, z, (y, id) => (out[col + y * plane] = id), li.riverDist); continue; }
        if (masked === 1) continue;

        const put = (y: number, id: number) => (out[col + y * plane] = id);
        if (rel.rock) { if (hash2(x, z, 73) < 0.05) put(top + 1, B.MOSSY_STONE); continue; }
        if (surf === B.SAND) {
          const hv = hash2(x, z, 74);
          if (dist >= 2 && hv < (rel.dune ? 0.3 : 0.08)) put(top + 1, B.SEA_OATS);
          else if (hv < 0.004) put(top + 1, B.DARK_PLANK); // driftwood
          continue;
        }

        // farmland fields
        if (zone === 'farmland' && li.roadDist > 4) { this.fieldColumn(x, z, top, li.roadDist, put); continue; }
        if (zone === 'wetland') {
          const n = fbm(x / 36, z / 36, 17, 2);
          if (n < -0.22 && li.roadDist > 3) {
            out[col + top * plane] = B.WATER;
            out[col + (top - 1) * plane] = B.MUD;
            if (n > -0.27 && hash2(x, z, 10) < 0.25) out[col + (top + 1) * plane] = B.REEDS;
            continue;
          }
          const hv = hash2(x, z, 9);
          if (n < -0.1 && hv < 0.55) out[col + (top + 1) * plane] = B.REEDS;
          else if (hv < 0.22) out[col + (top + 1) * plane] = B.TALL_GRASS;
          else if (hv < 0.24) out[col + (top + 1) * plane] = B.CANE; // sawgrass tussocks
          else if (hv < 0.245) out[col + (top + 1) * plane] = B.FLOWERS_WHITE;
          continue;
        }
        if (surf === B.GRASS) {
          const hv = hash2(x, z, 4);
          // wildflower meadows in open country and forest clearings
          const meadow = fbm(x / 70, z / 70, 55, 2);
          if (meadow > 0.3 && li.roadDist > 3) {
            const c = hash2(x, z, 56);
            if (hv < 0.35) put(top + 1, c < 0.4 ? B.FLOWERS : c < 0.7 ? B.FLOWERS_BLUE : B.FLOWERS_WHITE);
            else if (hv < 0.55) put(top + 1, B.TALL_GRASS);
            continue;
          }
          if (hv < 0.05) put(top + 1, B.TALL_GRASS);
          else if (hv < 0.065) put(top + 1, B.FLOWERS);
          else if ((zone === 'forest' || (zone === 'none' && z > 1300)) && hv < 0.1) put(top + 1, B.PALMETTO);
          else if (hv < 0.072) put(top + 1, B.FLOWERS_BLUE);
          // lake / river shores: reeds
          if (dist === 1 && hv > 0.6 && this.r.waterBodyAt(x + 6, z) + this.r.waterBodyAt(x - 6, z) + this.r.waterBodyAt(x, z + 6) + this.r.waterBodyAt(x, z - 6) > 0) put(top + 1, B.REEDS);
          if (li.riverDist < 3 && hv > 0.5) put(top + 1, B.REEDS);
        }
      }
    }

    this.stampFeatures(x0, z0, w, d, set, get);
  }

  private bridgeDeck(road: RoadInfo, floor: number, col: number, plane: number, out: Uint8Array) {
    this.roadSurface(road, (id) => out[col + 21 * plane] = id);
    out[col + 20 * plane] = B.CONCRETE;
    const edge = road.seg.hw - Math.abs(road.cross);
    if (edge < 1) { out[col + 21 * plane] = B.CONCRETE; out[col + 22 * plane] = B.RAIL; }
    if (Math.floor(road.along) % 24 === 0) for (let y = floor + 1; y <= 19; y++) out[col + y * plane] = B.CONCRETE; // piers
  }

  /** Crop fields: cane, citrus groves, corn, vegetable rows, pasture with hay, fallow; fenced edges. */
  private fieldColumn(x: number, z: number, top: number, roadDist: number, put: (y: number, id: number) => void) {
    const FS = 64;
    const fx = Math.floor((x + 17) / FS), fz = Math.floor((z + 29) / FS);
    const u = ((x + 17) % FS + FS) % FS, v = ((z + 29) % FS + FS) % FS;
    const t = hash2(fx, fz, 81);
    if (u === 0 || v === 0) { put(top, B.GRASS); if (roadDist > 5 && hash2(fx, fz, 82) < 0.6) put(top + 1, B.FENCE); return; }
    if (u === 1 || v === 1) { put(top, B.PATH); return; }
    if (t < 0.32) {
      // sugar cane rows
      if (x % 5 !== 0) { put(top, B.FARMLAND); if (hash2(x, z, 8) < 0.88) { put(top + 1, B.CANE); if (hash2(x, z, 83) < 0.5) put(top + 2, B.CANE); } }
      else put(top, B.DIRT);
    } else if (t < 0.56) {
      // citrus grove: round orange trees on a 6-block grid
      put(top, B.GRASS);
      const a = ((x % 6) + 6) % 6 - 3, b = ((z % 6) + 6) % 6 - 3;
      const aa = Math.abs(a), bb = Math.abs(b);
      if (aa <= 1 && bb <= 1) {
        if (aa === 0 && bb === 0) { put(top + 1, B.BARK); put(top + 2, B.BARK); put(top + 5, B.ORANGE_LEAVES); }
        else put(top + 2, B.ORANGE_LEAVES);
        put(top + 3, B.ORANGE_LEAVES); put(top + 4, B.ORANGE_LEAVES);
      } else if ((aa === 2 && bb <= 1) || (bb === 2 && aa <= 1)) { put(top + 3, B.ORANGE_LEAVES); }
      else if (hash2(x, z, 84) < 0.05) put(top + 1, B.TALL_GRASS);
    } else if (t < 0.68) {
      // corn
      if (z % 3 !== 0) { put(top, B.FARMLAND); put(top + 1, B.CORN); put(top + 2, B.CORN); } else put(top, B.DIRT);
    } else if (t < 0.8) {
      // vegetable rows under plastic-free beds
      if (x % 4 !== 0) { put(top, B.FARMLAND); if (hash2(x, z, 85) < 0.8) put(top + 1, B.VEG); } else put(top, B.PATH);
    } else if (t < 0.94) {
      // pasture with hay bales
      put(top, B.GRASS);
      const hv = hash2(x, z, 86);
      if (hv < 0.006) put(top + 1, B.HAY_BALE);
      else if (hv < 0.1) put(top + 1, B.TALL_GRASS);
      else if (hv < 0.115) put(top + 1, B.FLOWERS_WHITE);
    } else {
      put(top, B.DIRT);
      if (hash2(x, z, 87) < 0.15) put(top + 1, B.TALL_GRASS);
    }
  }

  private roadSurface(ri: RoadInfo, put: (id: number) => void) {
    const a = Math.abs(ri.cross);
    const s = ri.seg;
    let id: number = B.ASPHALT;
    if (s.roadKind === 'highway') {
      if (a < 1) id = B.LINE_YELLOW;
      else if (a >= 3.6 && a < 4.6 && ((Math.floor(ri.along) % 10) + 10) % 10 < 5) id = B.LINE_WHITE;
      else if (a >= s.hw - 1.2 && a < s.hw - 0.4) id = B.LINE_WHITE;
    } else if (a < 0.5) id = ((Math.floor(ri.along) % 6) + 6) % 6 < 3 ? B.LINE_YELLOW : B.ASPHALT;
    put(id);
  }

  /** Street grid, sidewalks and the per-region lot generators for urban zones. */
  private urbanColumn(x: number, z: number, put: (y: number, id: number) => void, riverDist = Infinity) {
    const S = LOT;
    const lx = ((x % S) + S) % S, lz = ((z % S) + S) % S;
    const i = Math.floor(x / S), j = Math.floor(z / S);
    const inSx = lx < 4 || lx >= 44, inSz = lz < 4 || lz >= 44;
    if (inSx || inSz) {
      let id: number = B.ASPHALT;
      if (inSx && !inSz) {
        if (lx === 47 || lx === 0) id = B.LINE_YELLOW;
        if ((lz < 7 || lz >= 41) && x % 2 === 0) id = B.LINE_WHITE;
      } else if (inSz && !inSx) {
        if (lz === 47 || lz === 0) id = B.LINE_YELLOW;
        if ((lx < 7 || lx >= 41) && z % 2 === 0) id = B.LINE_WHITE;
      }
      put(21, id);
      return;
    }
    const plan = this.lotPlan(i, j);
    const region = this.regions.at(x, z);
    if (plan.kind === 'margin' && riverDist < 7 && (region === RG.cedar_bluff || region === RG.smalltown || region === RG.lakemont_core)) {
      // riverside promenade: paving, lamps and a railing on the water edge
      put(21, riverDist < 1.5 ? B.LIMESTONE : (Math.floor(riverDist) === 4 ? B.SIDEWALK : B.COBBLE));
      if (riverDist < 1.5) put(22, B.IRON_RAIL);
      else if (Math.floor(riverDist) === 3 && ((x + z) % 14 === 0)) { for (let y = 22; y <= 24; y++) put(y, B.METAL); put(25, B.LAMP); }
      else if (Math.floor(riverDist) === 5 && hash2(x, z, 16) < 0.08) put(22, B.DARK_PLANK);
      return;
    }
    if (plan.kind === 'margin') {
      if (region === RG.solano_beach || region === RG.conch_harbor || this.r.distAt(x, z) <= 2) {
        put(21, B.SAND);
        const hv = hash2(x, z, 12);
        if (hv < 0.05) put(22, B.SEA_OATS);
        // beach umbrellas on the sand
        if (region === RG.solano_beach) {
          const ux = ((x % 13) + 13) % 13, uz = ((z % 11) + 11) % 11;
          const cell = hash2(Math.floor(x / 13), Math.floor(z / 11), 15);
          if (cell < 0.45 && ux >= 4 && ux <= 6 && uz >= 4 && uz <= 6) {
            const c = [B.AWNING_RED, B.AWNING_YELLOW, B.AWNING_BLUE, B.AWNING_GREEN][Math.floor(cell * 8.8) & 3];
            put(24, c);
            if (ux === 5 && uz === 5) { put(25, c); put(23, B.METAL); }
          }
        }
        return;
      }
      // grass verge with occasional shrubs and flowers
      put(21, B.GRASS);
      const hv = hash2(x, z, 12);
      if (hv < 0.03) put(22, B.HEDGE); else if (hv < 0.05) put(22, B.TALL_GRASS); else if (hv < 0.06) put(22, B.FLOWERS);
      return;
    }
    const sidewalk = lx < 7 || lx >= 41 || lz < 7 || lz >= 41;
    if (sidewalk) {
      const paver = region === RG.cedar_bluff || region === RG.bayhaven ? B.COBBLE : B.SIDEWALK;
      put(21, (lx === 6 || lx === 41 || lz === 6 || lz === 41) && paver === B.COBBLE ? B.SIDEWALK : paver);
      // lamp posts
      if (((lx === 5 || lx === 42) && lz === 24) || ((lz === 5 || lz === 42) && lx === 24)) {
        for (let y = 22; y <= 25; y++) put(y, B.METAL);
        put(26, B.LAMP);
      }
      return;
    }
    if (plan.kind === 'poi') { put(21, B.SIDEWALK); return; }
    const bx = lx - 7, bz = lz - 7; // 0..33
    const st = STYLES[REGION_LIST[plan.region]];
    if (plan.kind === 'landmark') { put(21, st.ground === B.SAND ? B.SAND : B.GRASS); return; }
    const [rx0, rz0, rx1, rz1] = plan.rect;
    if (bx < rx0 - 2 || bx > rx1 + 2 || bz < rz0 - 2 || bz > rz1 + 2) {
      put(21, st.ground === B.MARBLE ? B.SIDEWALK : st.ground);
      if (st.ground === B.GRASS && hash2(x, z, 19) < 0.03) put(22, B.HEDGE);
      return;
    }
    const gen = LOT_GENS[plan.kind];
    if (gen) gen(x, z, bx, bz, plan, put);
    else put(21, B.GRASS);
  }

  // ── stamped features ─────────────────────────────────────────────────────
  private landmarkBuckets(l: Landmark): Map<number, Int32Array> {
    let m = this.recorded.get(l.id);
    if (m) return m;
    const rec = { buckets: new Map<number, number[]>(), set(x: number, y: number, z: number, id: number) {
      const key = (z >> 4) * 1024 + (x >> 4);
      let a = this.buckets.get(key);
      if (!a) this.buckets.set(key, (a = []));
      a.push((x & 15) | ((z & 15) << 4) | (y << 8) | (id << 15));
    } };
    l.build(new Draw(rec), this);
    m = new Map();
    for (const [k, a] of rec.buckets) m.set(k, Int32Array.from(a));
    this.recorded.set(l.id, m);
    return m;
  }

  featureAt(ci: number, cj: number): FeaturePlan | null {
    const key = cj * 4096 + ci;
    if (this.features.has(key)) return this.features.get(key)!;
    const f = planFeature(this, ci, cj, (x, z, r) => this.isProtected(x, z, r) || this.maskAt(x, z) !== 0, this.map.width, this.map.depth);
    this.features.set(key, f);
    return f;
  }
  /** true if a tree at (x,z) would clash with a landmark, roadside stop or scattered feature */
  private occupied(x: number, z: number): boolean {
    if (this.maskAt(x, z) === 1) return true;
    const ci = Math.floor(x / FCELL), cj = Math.floor(z / FCELL);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const f = this.featureAt(ci + di, cj + dj);
      if (f && Math.abs(f.x - x) <= f.r + 3 && Math.abs(f.z - z) <= f.r + 3) return true;
    }
    return false;
  }

  private stampFeatures(x0: number, z0: number, w: number, d: number,
    set: (lx: number, y: number, lz: number, id: number) => void, get: (lx: number, y: number, lz: number) => number) {
    const M = 4;
    const xe = x0 + w - 1, ze = z0 + d - 1;
    // POI prefabs
    const i0 = Math.floor(x0 / LOT), i1 = Math.floor((x0 + w - 1) / LOT);
    const j0 = Math.floor(z0 / LOT), j1 = Math.floor((z0 + d - 1) / LOT);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const poi = POI_BY_LOT.get(lotKey(i, j));
      if (!poi) continue;
      const s = getPrefab(poi.prefab);
      const ox = i * LOT - x0, oz = j * LOT - z0;
      for (let y = 0; y <= Math.min(s.maxY, STRUCT_H - 1); y++) {
        for (let lz = Math.max(0, oz); lz < Math.min(d, oz + LOT); lz++) {
          for (let lx = Math.max(0, ox); lx < Math.min(w, ox + LOT); lx++) {
            const v = s.data[(lx - ox) + (lz - oz) * LOT + y * LOT * LOT];
            if (v) set(lx, 21 + y, lz, v - 1);
          }
        }
      }
    }

    // landmarks (recorded once, replayed per chunk bucket)
    for (const l of LANDMARKS) {
      const [bx0, bz0, bx1, bz1] = l.bbox;
      if (bx1 + 40 < x0 || bx0 - 40 > xe || bz1 + 40 < z0 || bz0 - 40 > ze) continue;
      const buckets = this.landmarkBuckets(l);
      for (let cz = z0 >> 4; cz <= ze >> 4; cz++) for (let cx = x0 >> 4; cx <= xe >> 4; cx++) {
        const a = buckets.get(cz * 1024 + cx);
        if (!a) continue;
        const bx = cx * 16 - x0, bz = cz * 16 - z0;
        for (let k = 0; k < a.length; k++) {
          const e = a[k];
          set(bx + (e & 15), (e >> 8) & 127, bz + ((e >> 4) & 15), (e >> 15) & 255);
        }
      }
    }

    const sink: Sink = { set: (x, y, z, id) => set(x - x0, y, z - z0, id) };
    const draw = new Draw(sink);
    // roadside stops
    for (let k = 0; k < this.slots.length; k++) {
      const [sx0, sz0, sx1, sz1] = this.slotBoxes[k];
      if (sx1 + 20 < x0 || sx0 - 20 > xe || sz1 + 20 < z0 || sz0 - 20 > ze) continue;
      buildSlot(draw, this.slots[k], this);
    }
    // scattered features
    const R = FEATURE_MAX_R + 12;
    for (let cj = Math.floor((z0 - R) / FCELL); cj <= Math.floor((ze + R) / FCELL); cj++) for (let ci = Math.floor((x0 - R) / FCELL); ci <= Math.floor((xe + R) / FCELL); ci++) {
      const f = this.featureAt(ci, cj);
      if (!f) continue;
      const rr = f.r + (f.type === 'pier' ? 34 : f.type === 'beach_set' ? 14 : 8);
      if (f.x + rr < x0 || f.x - rr > xe || f.z + rr < z0 || f.z - rr > ze) continue;
      buildFeature(draw, f, this);
    }

    // trees on an 8-block jittered grid
    const T = 8;
    const ci0 = Math.floor((x0 - M) / T), ci1 = Math.floor((x0 + w + M) / T);
    const cj0 = Math.floor((z0 - M) / T), cj1 = Math.floor((z0 + d + M) / T);
    for (let cj = cj0; cj <= cj1; cj++) for (let ci = ci0; ci <= ci1; ci++) {
      const tx = ci * T + 1 + hashInt(ci, cj, 6, 41), tz = cj * T + 1 + hashInt(ci, cj, 6, 42);
      const hv = hash2(ci, cj, 43);
      if (hv > 0.6) continue;
      if (tx < 0 || tz < 0 || tx >= this.map.width || tz >= this.map.depth) continue;
      const zoneI = this.r.zoneIdx(tx, tz);
      const h2 = hash2(ci, cj, 44);
      const dist = this.r.distAt(tx, tz);
      let type: TreeType | null = null;
      if (zoneI === Z.forest) {
        if (hv < 0.46) type = tz < 900 && h2 < 0.3 ? 'spruce' : h2 < 0.45 ? 'longleaf' : h2 < 0.65 ? 'pine' : h2 < 0.85 ? 'oak' : 'mossy_oak';
      } else if (zoneI === Z.wetland) type = hv < 0.1 ? 'cypress' : hv < 0.14 ? 'sabal' : null;
      else if (zoneI === Z.farmland) type = hv < 0.03 ? (h2 < 0.5 ? 'mossy_oak' : 'oak') : null;
      else if (zoneI === Z.none) {
        if (tz < 1300) type = hv < 0.14 ? (h2 < 0.5 ? 'longleaf' : 'oak') : null;
        else if (tz > 2850) type = hv < 0.1 ? (h2 < 0.6 ? 'sabal' : 'mossy_oak') : null;
        else type = hv < 0.08 ? (h2 < 0.35 ? 'mossy_oak' : h2 < 0.7 ? 'oak' : 'sabal') : null;
      } else if (zoneI === Z.resort || zoneI === Z.suburb) type = null; // handled via lots
      const south = tz > 2850 || this.regions.at(tx, tz) === RG.keys;
      if (!type) {
        // beach palms anywhere near the coast (not in cities); mangroves on southern shores
        if (dist >= 1 && dist <= 3 && hv < 0.25 && zoneI !== Z.downtown && zoneI !== Z.urban && zoneI !== Z.industrial && zoneI !== Z.airport) type = south && dist <= 1 && hv < 0.15 ? 'mangrove' : 'palm';
        else if (south && dist <= -1 && dist >= -2 && hv < 0.3) type = 'mangrove';
      }
      if (!type) continue;
      if (type === 'mangrove' && dist <= 0) {
        if (this.isProtected(tx, tz, 3)) continue;
        const li = this.lineInfo(tx, tz);
        if (li.road || li.roadDist < 4) continue;
        this.tree('mangrove', tx - x0, 19, tz - z0, hash2(ci, cj, 45), set, get);
        continue;
      }
      if (!this.r.isLand(tx, tz)) continue;
      const li = this.lineInfo(tx, tz);
      if (li.road || li.river || li.roadDist < 3) continue;
      if (URBANISH.has(this.r.zoneAt(tx, tz)) && type !== 'palm' && type !== 'mangrove') continue;
      if (this.occupied(tx, tz)) continue;
      if (type === 'mangrove' && this.isProtected(tx, tz, 3)) continue;
      const base = this.terrainTop(tx, tz) + 1;
      this.tree(type, tx - x0, base, tz - z0, hash2(ci, cj, 45), set, get);
    }

    // palms on city sidewalks and in parks / yards
    for (let j = j0 - 1; j <= j1 + 1; j++) for (let i = i0 - 1; i <= i1 + 1; i++) {
      const plan = this.lotPlan(i, j);
      if (plan.kind === 'margin') continue;
      const st = STYLES[REGION_LIST[plan.region]];
      const spots: [number, number][] = [];
      if (plan.zone === 'downtown' || plan.zone === 'resort' || plan.zone === 'urban') {
        spots.push([5, 13], [5, 34], [42, 13], [42, 34], [13, 5], [34, 5], [13, 42], [34, 42]);
      }
      const k0 = spots.length;
      if (plan.kind === 'park' || plan.kind === 'plaza' || plan.kind === 'pond') spots.push([12, 12], [35, 12], [12, 35], [35, 35], [20, 28], [28, 20]);
      if (plan.kind === 'houses' || plan.kind === 'villas' || plan.kind === 'conch_houses') spots.push([10, 23], [27, 23], [10, 40], [27, 40]);
      if (plan.kind === 'hotel' || plan.kind === 'deco_hotel' || plan.kind === 'beach_club' || plan.kind === 'condo') spots.push([10, 34], [37, 34], [23, 38]);
      if (plan.kind === 'golf') spots.push([9, 9], [38, 14], [12, 30], [36, 38], [24, 9]);
      if (plan.kind === 'church' || plan.kind === 'school' || plan.kind === 'town_hall') spots.push([9, 9], [38, 9]);
      for (let k = 0; k < spots.length; k++) {
        const [sx, sz] = spots[k];
        if (hash2(i * 31 + k, j * 17 - k, 46) > (plan.kind === 'poi' ? 0.45 : 0.75)) continue;
        const wx = i * LOT + sx, wz = j * LOT + sz;
        if (wx < x0 - M || wx > x0 + w + M || wz < z0 - M || wz > z0 + d + M) continue;
        if (k >= k0) {
          const [rx0, rz0, rx1, rz1] = plan.rect;
          if (sx - 7 < rx0 || sx - 7 > rx1 || sz - 7 < rz0 || sz - 7 > rz1) continue;
        }
        let kind: TreeType = 'palm';
        if (!st.palms || (plan.region === RG.smalltown && j * LOT < 1300)) kind = k % 2 ? 'mossy_oak' : 'oak';
        else if ((plan.kind === 'park' || plan.kind === 'pond') && k % 2 === 1 && plan.zone !== 'resort') kind = 'oak';
        if ((sx === 5 || sx === 42 || sz === 5 || sz === 42) && this.lineInfo(wx, wz).roadDist < 2) continue;
        if (k >= k0 && get(wx - x0, 22, wz - z0) !== B.AIR && wx >= x0 && wx < x0 + w && wz >= z0 && wz < z0 + d) continue;
        if (k >= k0 && LOT_TREE_BLOCKED.has(plan.kind)) continue;
        this.tree(kind, wx - x0, 22, wz - z0, hash2(i, j, 47 + k), set, get);
      }
    }
  }

  private tree(type: TreeType, lx: number, base: number, lz: number, rnd: number,
    set: (lx: number, y: number, lz: number, id: number) => void, get: (lx: number, y: number, lz: number) => number) {
    const put = (x: number, y: number, z: number, id: number) => { const g = get(x, y, z); if (g === B.AIR || g === B.TALL_GRASS || g === B.FLOWERS || g === B.PALMETTO || g === B.FLOWERS_BLUE || g === B.FLOWERS_WHITE) set(x, y, z, id); };
    if (type === 'palm') {
      const h = 6 + Math.floor(rnd * 3);
      for (let y = 0; y < h; y++) put(lx + (y > h - 3 && rnd > 0.7 ? 1 : 0), base + y, lz, B.PALM_LOG);
      const ox = rnd > 0.7 ? 1 : 0;
      const ty = base + h;
      put(lx + ox, ty, lz, B.LEAVES);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        for (let k = 1; k <= 3; k++) put(lx + ox + dx * k, ty - (k === 3 ? 1 : 0), lz + dz * k, B.PALM_LEAVES);
      }
      for (const [dx, dz] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) { put(lx + ox + dx, ty, lz + dz, B.PALM_LEAVES); put(lx + ox + dx * 2, ty - 1, lz + dz * 2, B.PALM_LEAVES); }
      return;
    }
    if (type === 'sabal') {
      // cabbage palm: short trunk, dense round crown
      const h = 4 + Math.floor(rnd * 3);
      for (let y = 0; y < h; y++) put(lx, base + y, lz, B.PALM_LOG);
      const ty = base + h;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) { put(lx + dx, ty, lz + dz, B.PALM_LEAVES); put(lx + dx * 2, ty - 1, lz + dz * 2, B.PALM_LEAVES); }
      put(lx, ty + 1, lz, B.PALM_LEAVES);
      return;
    }
    if (type === 'pine' || type === 'spruce') {
      const h = (type === 'spruce' ? 9 : 7) + Math.floor(rnd * 4);
      const leaf = type === 'spruce' ? B.SPRUCE_LEAVES : B.PINE_LEAVES;
      for (let y = 0; y < h; y++) put(lx, base + y, lz, B.BARK);
      for (let y = 3; y <= h + 1; y++) {
        const r = Math.max(0, Math.floor((h + 1 - y) / (type === 'spruce' ? 2.6 : 2.2)));
        for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (Math.abs(dx) + Math.abs(dz) <= r + 0.5) put(lx + dx, base + y, lz + dz, leaf);
      }
      put(lx, base + h + 2, lz, leaf);
      return;
    }
    if (type === 'longleaf') {
      // tall bare trunk with a small tufted crown
      const h = 11 + Math.floor(rnd * 5);
      for (let y = 0; y < h; y++) put(lx, base + y, lz, B.BARK);
      for (let y = h - 3; y <= h + 1; y++) {
        const r = y === h + 1 ? 0 : y === h - 3 ? 1 : 2;
        for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) + Math.abs(dz) > r + (rnd > 0.5 ? 1 : 0)) continue;
          if (hash2(lx + dx * 3, lz + dz * 5, y) < 0.25 && r > 0) continue;
          put(lx + dx, base + y, lz + dz, B.PINE_LEAVES);
        }
      }
      return;
    }
    if (type === 'mangrove') {
      // arching prop roots out of the water, low glossy canopy
      for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0]]) for (let y = base; y <= 21; y++) if (dx === 0 || y >= 20) set(lx + dx, y, lz + dz, B.MANGROVE_ROOT);
      for (const [dx, dz] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) { set(lx + dx, 20, lz + dz, B.MANGROVE_ROOT); set(lx + dx, 21, lz + dz, B.MANGROVE_ROOT); }
      put(lx, 22, lz, B.BARK); put(lx, 23, lz, B.BARK);
      const r = 2 + (rnd > 0.6 ? 1 : 0);
      for (let y = 23; y <= 25; y++) {
        const rr = y === 25 ? r - 1 : r;
        for (let dz = -rr; dz <= rr; dz++) for (let dx = -rr; dx <= rr; dx++) if (dx * dx + dz * dz <= rr * rr + 1 && !(y === 23 && dx === 0 && dz === 0)) put(lx + dx, y, lz + dz, B.MANGROVE_LEAVES);
      }
      return;
    }
    const moss = type === 'mossy_oak' || type === 'cypress';
    const h = type === 'cypress' ? 8 + Math.floor(rnd * 3) : (type === 'mossy_oak' ? 5 : 4) + Math.floor(rnd * 2);
    for (let y = 0; y < h; y++) put(lx, base + y, lz, B.BARK);
    const r = type === 'cypress' ? 1 : type === 'mossy_oak' ? 3 : 2;
    for (let y = h - 2; y <= h + 1; y++) {
      const rr = y === h + 1 ? r - 1 : r;
      for (let dz = -rr; dz <= rr; dz++) for (let dx = -rr; dx <= rr; dx++) {
        if (dx * dx + dz * dz > rr * rr + 1) continue;
        if ((Math.abs(dx) === rr && Math.abs(dz) === rr) && hash2(lx + dx, lz + dz, y) < 0.5) continue;
        put(lx + dx, base + y, lz + dz, B.LEAVES);
      }
    }
    if (moss) {
      // Spanish moss hanging from the canopy edge
      for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r - 1, r - 1], [1 - r, 1 - r]]) {
        if (hash2(lx + dx, lz + dz, 77) < 0.35) continue;
        put(lx + dx, base + h - 3, lz + dz, B.MOSS);
        if (hash2(lx - dx, lz + dz, 78) < 0.5) put(lx + dx, base + h - 4, lz + dz, B.MOSS);
      }
    }
  }
}

const NO_RELIEF = { add: 0, rock: false, dune: false };
/** lot kinds that may repeat next to each other (they vary per building internally) */
const REPEATABLE = new Set<LotKind>(['houses', 'conch_houses', 'shops_row', 'glass_tower', 'tower', 'cul_de_sac', 'villas', 'deco_hotel', 'warehouse', 'container_yard', 'golf', 'apartments', 'midrise']);
/** lots whose generators fill the yard spots themselves */
const LOT_TREE_BLOCKED = new Set<LotKind>(['courts', 'gas_station', 'parking', 'parking_garage', 'construction', 'strip_mall', 'diner', 'motel', 'food_trucks', 'container_yard', 'warehouse', 'hangar', 'radar', 'school']);

let shared: WorldGen | null = null;
export function getWorldGen(map: MapData): WorldGen {
  if (!shared || shared.map !== map) shared = new WorldGen(map);
  return shared;
}

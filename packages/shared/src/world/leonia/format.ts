/**
 * Leonia binary tile format (shared by the build pipeline encoder and the runtime decoder).
 *
 * One file per 512 m x 512 m tile: `t_<tx>_<tz>.bin`, little-endian, all integers are
 * unsigned LEB128 varints unless noted; coordinates are integer metres in world space
 * (x east, z south, origin = NW corner of the bbox), stored as the first point absolute
 * and the rest as zigzag deltas.
 *
 *   magic "LEO1"  u8 version  varint tx  varint tz
 *   water   : varint mode (0 = all land, 1 = all water, 2 = RLE rows); for RLE, per row
 *             varint nRuns then nRuns run lengths alternating land, water, land, ...
 *   strings : varint n, each varint byteLen + utf8
 *   areas   : varint n, each u8 kind, u8 angle (0..255 = 0..pi, dominant edge), rings
 *   builds  : varint n, each u8 kind, u8 roof, u8 flags, varint height dm, varint minHeight dm,
 *             u8 levels, varint name+1, varint seed, u8 colour, rings
 *   roads   : varint n, each u8 class, u8 lanes, varint width dm, u8 flags, u8 layer+8,
 *             varint name+1, line; if flags&BRIDGE: per point varint deck height dm
 *   pois    : varint n, each u8 cat, u8 arg, point
 *   rings   = varint nRings, per ring a line (ring 0 outer, others holes; even-odd fill)
 *   line    = varint nPts, points
 *
 * Areas are clipped to the tile (+16 m margin) and sorted by descending area so painting in
 * order lets smaller features win. Buildings are stored in every tile their bbox touches;
 * roads in every tile within their half-width + 24 m; POIs only in the owning tile.
 */
export const TILE = 512;
export const TILE_MAGIC = 0x314f454c; // 'LEO1'
export const TILE_VERSION = 1;

/** area kinds. `LU_*` are base land use (one raster), the rest are surface cover (second raster). */
export const AK = {
  NONE: 0,
  // base land use
  RESIDENTIAL: 1, COMMERCIAL: 2, RETAIL: 3, INDUSTRIAL: 4, PORT: 5, RAILWAY: 6, CONSTRUCTION: 7,
  MILITARY: 8, EDUCATION: 9, HOSPITAL: 10, AERODROME: 11, RELIGIOUS: 12, FARMLAND: 13,
  // surface cover
  GRASS: 30, PARK: 31, GARDEN: 32, FOREST: 33, SCRUB: 34, WETLAND: 35, CEMETERY: 36,
  GOLF: 37, GOLF_ROUGH: 38, GOLF_FAIRWAY: 39, GOLF_GREEN: 40, GOLF_TEE: 41, GOLF_BUNKER: 42,
  BEACH: 43, SAND: 44, PARKING: 45, PITCH: 46, PLAYGROUND: 47, PLAZA: 48, APRON: 49,
  RUNWAY: 50, HELIPAD: 51, MARINA: 52, PIER: 53, BREAKWATER: 54, BRIDGE: 55, POOL: 56,
  STADIUM: 57, NATURE: 58, TRACK: 59, ZOO: 60, CAMPUS_GREEN: 61, DOG_PARK: 62,
} as const;
export const LU_MAX = 29;

export const BK = {
  OTHER: 0, HOUSE: 1, RESIDENTIAL: 2, APARTMENTS: 3, COMMERCIAL: 4, RETAIL: 5, OFFICE: 6,
  INDUSTRIAL: 7, WAREHOUSE: 8, HANGAR: 9, TERMINAL: 10, CHURCH: 11, SCHOOL: 12, HOSPITAL: 13,
  HOTEL: 14, PARKING: 15, SHED: 16, ROOF: 17, CIVIC: 18, STADIUM: 19, TRANSPORT: 20,
  CONSTRUCTION: 21, SERVICE: 22, GARAGE: 23,
} as const;
export const ROOF = { UNKNOWN: 0, FLAT: 1, GABLED: 2, HIPPED: 3, PYRAMIDAL: 4, DOME: 5, SKILLION: 6, ROUND: 7 } as const;
/** building flags */
export const BF = { REAL_HEIGHT: 1, PART: 2, SYNTHETIC: 4, LEVELS: 8, HAS_PARTS: 16 } as const;

export const RC = {
  MOTORWAY: 1, TRUNK: 2, PRIMARY: 3, SECONDARY: 4, TERTIARY: 5, UNCLASSIFIED: 6, RESIDENTIAL: 7,
  LIVING: 8, SERVICE: 9, PEDESTRIAN: 10, FOOTWAY: 11, CYCLEWAY: 12, PATH: 13, STEPS: 14, TRACK: 15,
  RUNWAY: 20, TAXIWAY: 21,
  RAIL: 30, LIGHT_RAIL: 31, SUBWAY: 32, TRAM: 33, MONORAIL: 34,
  PIER: 40, BREAKWATER: 41,
} as const;
export const RF = { ONEWAY: 1, BRIDGE: 2, TUNNEL: 4, LINK: 8, SIDEWALK: 16, CAUSEWAY: 32 } as const;
export const isRail = (c: number) => c >= 30 && c < 40;
export const isCarRoad = (c: number) => c >= 1 && c <= 9;
export const isFoot = (c: number) => c >= 10 && c <= 15;

export const POI = {
  TREE: 1, PALM: 2, LAMP: 3, SIGNAL: 4, BUS_STOP: 5, CROSSING: 6, BENCH: 7, FOUNTAIN: 8,
  FOOD: 10, CAFE: 11, BAR: 12, SHOP: 13, SUPERMARKET: 14, FUEL: 15, BANK: 16, PHARMACY: 17,
  HOSPITAL: 18, SCHOOL: 19, POLICE: 20, FIRE: 21, WORSHIP: 22, HOTEL: 23, MUSEUM: 24,
  ATTRACTION: 25, VIEWPOINT: 26, PLAYGROUND: 27, STATION: 28, LIGHTHOUSE: 29, TOWER: 30,
  MARINA: 31, CINEMA: 32, NIGHTCLUB: 33, LIBRARY: 34, POST: 35, TOILETS: 36,
  /** road junction; arg = radius in metres */
  JUNCTION: 50,
  /** tunnel portal (surface road ends and dives into a dropped tunnel); arg = direction into the tunnel, (atan2(dz,dx)+pi)/2pi * 255 */
  PORTAL: 51,
} as const;

// ───────────────────────────────────────────────────────── decoded shapes
export interface LArea { kind: number; angle: number; rings: Int32Array[]; bbox: [number, number, number, number] }
export interface LBuilding {
  kind: number; roof: number; flags: number; height: number; minHeight: number; levels: number;
  name: string; seed: number; colour: number; rings: Int32Array[]; bbox: [number, number, number, number];
}
export interface LRoad {
  cls: number; lanes: number; width: number; flags: number; layer: number; name: string;
  pts: Int32Array; deck: Float32Array | null;
}
export interface LPoi { cat: number; arg: number; x: number; z: number }
export interface LTile {
  tx: number; tz: number;
  /** 1 = water, 0 = land; TILE*TILE, row-major (z rows) */
  water: Uint8Array;
  areas: LArea[]; buildings: LBuilding[]; roads: LRoad[]; pois: LPoi[];
}

// ───────────────────────────────────────────────────────── decoder
class Reader {
  o = 0;
  constructor(readonly b: Uint8Array) {}
  u8() { return this.b[this.o++]; }
  v(): number {
    let r = 0, s = 1, c: number;
    do { c = this.b[this.o++]; r += (c & 0x7f) * s; s *= 128; } while (c & 0x80);
    return r;
  }
  zz(): number { const u = this.v(); return u % 2 ? -(u + 1) / 2 : u / 2; }
  line(): Int32Array {
    const n = this.v();
    const a = new Int32Array(n * 2);
    let x = 0, z = 0;
    for (let i = 0; i < n; i++) {
      if (i === 0) { x = this.v(); z = this.v(); } else { x += this.zz(); z += this.zz(); }
      a[i * 2] = x; a[i * 2 + 1] = z;
    }
    return a;
  }
  rings(): Int32Array[] { const n = this.v(); const r: Int32Array[] = []; for (let i = 0; i < n; i++) r.push(this.line()); return r; }
}
function bboxOf(rings: Int32Array[]): [number, number, number, number] {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const r of rings) for (let i = 0; i < r.length; i += 2) {
    if (r[i] < x0) x0 = r[i]; if (r[i] > x1) x1 = r[i];
    if (r[i + 1] < z0) z0 = r[i + 1]; if (r[i + 1] > z1) z1 = r[i + 1];
  }
  return [x0, z0, x1, z1];
}

export function decodeTile(buf: Uint8Array): LTile {
  const r = new Reader(buf);
  const magic = buf[0] | (buf[1] << 8) | (buf[2] << 16) | (buf[3] << 24);
  if (magic !== TILE_MAGIC) throw new Error('bad Leonia tile magic');
  r.o = 4;
  if (r.u8() !== TILE_VERSION) throw new Error('unsupported Leonia tile version');
  const tx = r.v(), tz = r.v();
  const water = new Uint8Array(TILE * TILE);
  const mode = r.v();
  if (mode === 1) water.fill(1);
  else if (mode === 2) {
    for (let row = 0; row < TILE; row++) {
      const n = r.v();
      let x = 0, wv = 0;
      for (let k = 0; k < n; k++) {
        const len = r.v();
        if (wv) water.fill(1, row * TILE + x, row * TILE + x + len);
        x += len; wv ^= 1;
      }
    }
  }
  const strings: string[] = [];
  const td = new TextDecoder();
  for (let i = 0, n = r.v(); i < n; i++) { const len = r.v(); strings.push(td.decode(buf.subarray(r.o, r.o + len))); r.o += len; }
  const areas: LArea[] = [];
  for (let i = 0, n = r.v(); i < n; i++) {
    const kind = r.u8(), angle = r.u8(), rings = r.rings();
    areas.push({ kind, angle: (angle / 256) * Math.PI, rings, bbox: bboxOf(rings) });
  }
  const buildings: LBuilding[] = [];
  for (let i = 0, n = r.v(); i < n; i++) {
    const kind = r.u8(), roof = r.u8(), flags = r.u8();
    const height = r.v() / 10, minHeight = r.v() / 10, levels = r.u8();
    const ni = r.v(), seed = r.v(), colour = r.u8();
    const rings = r.rings();
    buildings.push({ kind, roof, flags, height, minHeight, levels, name: ni ? strings[ni - 1] : '', seed, colour, rings, bbox: bboxOf(rings) });
  }
  const roads: LRoad[] = [];
  for (let i = 0, n = r.v(); i < n; i++) {
    const cls = r.u8(), lanes = r.u8(), width = r.v() / 10, flags = r.u8(), layer = r.u8() - 8, ni = r.v();
    const pts = r.line();
    let deck: Float32Array | null = null;
    if (flags & RF.BRIDGE) { deck = new Float32Array(pts.length / 2); for (let k = 0; k < deck.length; k++) deck[k] = r.v() / 10; }
    roads.push({ cls, lanes, width, flags, layer, name: ni ? strings[ni - 1] : '', pts, deck });
  }
  const pois: LPoi[] = [];
  let px = 0, pz = 0;
  for (let i = 0, n = r.v(); i < n; i++) {
    const cat = r.u8(), arg = r.u8();
    if (i === 0) { px = r.v(); pz = r.v(); } else { px += r.zz(); pz += r.zz(); }
    pois.push({ cat, arg, x: px, z: pz });
  }
  return { tx, tz, water, areas, buildings, roads, pois };
}

// ───────────────────────────────────────────────────────── encoder (build pipeline)
export class Writer {
  private buf = new Uint8Array(1 << 16);
  o = 0;
  private grow(n: number) { if (this.o + n <= this.buf.length) return; let s = this.buf.length * 2; while (s < this.o + n) s *= 2; const nb = new Uint8Array(s); nb.set(this.buf.subarray(0, this.o)); this.buf = nb; }
  u8(v: number) { this.grow(1); this.buf[this.o++] = v & 255; }
  v(v: number) {
    v = Math.max(0, Math.round(v));
    this.grow(10);
    do { let c = v % 128; v = Math.floor(v / 128); if (v) c |= 0x80; this.buf[this.o++] = c; } while (v);
  }
  zz(v: number) { this.v(v >= 0 ? v * 2 : -v * 2 - 1); }
  bytes(b: Uint8Array) { this.grow(b.length); this.buf.set(b, this.o); this.o += b.length; }
  line(pts: ArrayLike<number>) {
    const n = pts.length / 2;
    this.v(n);
    let x = 0, z = 0;
    for (let i = 0; i < n; i++) {
      const nx = pts[i * 2], nz = pts[i * 2 + 1];
      if (i === 0) { this.v(nx); this.v(nz); } else { this.zz(nx - x); this.zz(nz - z); }
      x = nx; z = nz;
    }
  }
  rings(rs: ArrayLike<number>[]) { this.v(rs.length); for (const r of rs) this.line(r); }
  done() { return this.buf.slice(0, this.o); }
}

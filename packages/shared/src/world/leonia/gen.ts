/**
 * LeoniaGen: the real-data world generator (Miami area, true scale, 1 block = 1 m).
 * Same contract as WorldGen.generateRegion(x0, z0, w, d, out): index = x + z*w + y*w*d.
 * Ground is flat (street top block y=21, sea surface block y=20). All inputs come from the
 * tile rasters (tiles.ts), which depend only on the tile files, so output is identical on
 * the server and in client workers. Client workers must `await gen.prepare(...)` first.
 */
import { B } from '../blocks.ts';
import { WORLD_H, SEA_LEVEL } from '../../constants.ts';
import { AK, BK, BF, ROOF, RC, RF, isCarRoad, isRail, isFoot, TILE, type LBuilding } from './format.ts';
import { LeoniaTiles, TileRaster, RS, SEG, SIDEWALK_W, SF_DRIVEWAY, ST, h32, type LeoniaSource } from './tiles.ts';
import { districtAt, type DistrictStyle } from './districts.ts';
import { LEONIA_PROJ, lonLatToWorld } from './proj.ts';
import { getPrefab, LOT, STRUCT_H, type Struct } from '../structures.ts';
import { frameRect, frameCellOf, PAD as LOT_PAD, type Frame } from '../placement.ts';
import { leoniaPlacements } from '../../content/pois.ts';

/** an enterable prefab stamped at a real address (content/pois.ts → leonia) */
interface Placed { s: Struct; f: Frame; pad: [number, number, number, number]; box: [number, number, number, number] }
let placedCache: Placed[] | null = null;
/** the prefab placements (pad rect = generated buildings whose bbox touches it are removed) */
export function leoniaPlaced(): Placed[] {
  if (!placedCache) placedCache = leoniaPlacements().map(({ prefab, frame }) => ({
    s: getPrefab(prefab), f: frame,
    pad: frameRect(frame, LOT_PAD.x0, LOT_PAD.z0, LOT_PAD.x1, LOT_PAD.z1),
    box: frameRect(frame, 0, 0, LOT, LOT),
  }));
  return placedCache;
}
/** true if a generated building (by bbox) is cleared for a prefab placement — also used by the far-city LOD */
export function leoniaBuildingRemoved(bbox: readonly [number, number, number, number] | number[]): boolean {
  for (const p of leoniaPlaced()) {
    const r = p.pad;
    if (bbox[2] > r[0] && bbox[0] < r[2] && bbox[3] > r[1] && bbox[1] < r[3]) return true;
  }
  return false;
}

const G = 22; // first block above street level
const PAD = 12;
/** tallest building top (blocks above street); OSM heights above this are capped */
export const LEONIA_MAX_H = WORLD_H - G - 8;

const PASTEL = [B.STUCCO_PINK, B.STUCCO_TEAL, B.STUCCO_YELLOW, B.STUCCO_PEACH, B.STUCCO_MINT, B.STUCCO_LAVENDER, B.STUCCO_SKY];
const CURTAINS = [B.CURTAIN_TEAL, B.CURTAIN_BLUE, B.CURTAIN_DARK, B.CURTAIN_BLUE, B.CURTAIN_TEAL, B.CURTAIN_GOLD];
const NEONS = [B.NEON_PINK, B.NEON_CYAN, B.NEON_YELLOW, B.NEON_GREEN, B.NEON_ORANGE, B.NEON_PURPLE];
const CONTAINERS = [B.CONTAINER_RED, B.CONTAINER_BLUE, B.CONTAINER_GREEN, B.CONTAINER_ORANGE, B.CONTAINER_WHITE, B.CONTAINER_YELLOW];
const CAR_COLOURS = [B.PANEL_WHITE, B.CURTAIN_DARK, B.AWNING_RED, B.PANEL_GREY, B.CURTAIN_BLUE, B.STUCCO_WHITE, B.TIRE, B.AWNING_YELLOW];
const MURALS = [B.MURAL_A, B.MURAL_B, B.MURAL_C, B.MURAL_D, B.MURAL_E];
const AWN = [B.AWNING_RED, B.AWNING_BLUE, B.AWNING_YELLOW, B.AWNING_GREEN];
/** building:colour codes from the pipeline → wall blocks */
const COLOUR_BLOCKS = [0, B.STUCCO_WHITE, B.PANEL_GREY, B.STUCCO_CREAM, B.STUCCO_YELLOW, B.STUCCO_PINK, B.RED_STUCCO, B.BRICK_TAN, B.STUCCO_SKY, B.STUCCO_MINT, B.CURTAIN_DARK, B.STUCCO_OCHRE];

type Family = 'glass' | 'condo' | 'deco' | 'mid' | 'house' | 'ware' | 'hangar' | 'terminal' | 'garage' | 'canopy' | 'church' | 'shed' | 'civic';
export interface Facade {
  fam: Family; wall: number; trim: number; win: number; roof: number; accent: number; fh: number;
  hWall: number; roofShape: 'flat' | 'hip' | 'dome' | 'vault'; roofCap: number;
  fins: boolean; bands: boolean; crown: number; pool: boolean; helipad: boolean; mast: number; tank: boolean; mural: number;
  cx: number; cz: number; top: number; base: number; solar: boolean;
  /** landmark id ('' = none): freedom, tower, arena, ballpark, oceandrive, terminal */
  lm: string;
  /** glass curtain wall: vertical mullions + spandrel lines */
  grid: boolean;
  /** tower on a podium (storefront-height base band) */
  podium: boolean;
  /** ground floor storefront glass (+ awning block, 0 = none) */
  store: boolean; awn: number;
  /** balcony rails on upper floors */
  balc: boolean;
  /** parapet height above the roof slab (1 or 2) and roof equipment density 0..1 */
  par: number; units: number;
  /** stair bulkhead / penthouse height / chimney / antenna height (placement derives from the seed) */
  bulk: boolean; pent: number; chimney: boolean; antenna: number;
  /** painted-wall mosaics (Wynwood) */
  murals: boolean;
  seed: number;
  /** per-building roof layout offsets: bulkhead xz, tank xz, antenna xz, chimney xz */
  ofs: number[];
}
const pick = <T,>(a: readonly T[], u: number): T => a[Math.min(a.length - 1, Math.floor(u * a.length))];

/** facade choice for a building (exported for the client far-city LOD, which colours its boxes the same way) */
export function facadeFor(b: LBuilding, maxDist: number, style: DistrictStyle): Facade {
  const u = (k: number) => h32(b.seed, k, 7);
  const top = Math.max(2, Math.min(LEONIA_MAX_H, Math.round(b.height)));
  const base = Math.max(0, Math.min(top - 1, Math.round(b.minHeight)));
  const h = top - base;
  const k = b.kind;
  const area = (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]);
  const dense = style === 'downtown' || style === 'brickell' || style === 'edgewater';
  const beachy = style === 'sobe' || style === 'beach' || style === 'keys';
  let fam: Family;
  if (k === BK.ROOF) fam = 'canopy';
  else if (k === BK.PARKING) fam = 'garage';
  else if (k === BK.HANGAR) fam = 'hangar';
  else if (k === BK.TERMINAL || (style === 'airport' && h >= 12 && k !== BK.WAREHOUSE)) fam = 'terminal';
  else if (k === BK.CHURCH) fam = 'church';
  else if (k === BK.SHED || k === BK.GARAGE || (area < 40 && h <= 4)) fam = 'shed';
  else if (k === BK.WAREHOUSE || k === BK.INDUSTRIAL || ((style === 'port' || style === 'industrial') && h < 16 && k !== BK.HOUSE)) fam = 'ware';
  else if (k === BK.HOUSE || (h <= 8 && area < 500 && (k === BK.RESIDENTIAL || k === BK.OTHER) && !dense)) fam = 'house';
  else if (h >= 45 || (h >= 28 && dense)) fam = (k === BK.APARTMENTS || k === BK.RESIDENTIAL || k === BK.HOTEL) && (beachy || u(1) < 0.45) ? 'condo' : 'glass';
  else if (beachy && h >= 26) fam = 'condo';
  else if (style === 'sobe' || (beachy && h < 26)) fam = 'deco';
  else if (k === BK.SCHOOL || k === BK.CIVIC || k === BK.HOSPITAL) fam = 'civic';
  else if (style === 'wynwood' && h <= 20) fam = u(2) < 0.6 ? 'ware' : 'mid';
  else fam = 'mid';

  let wall: number, trim: number = B.STUCCO_WHITE, roof: number = B.CONCRETE, win: number = B.WINDOW, accent = pick(NEONS, u(3)), fh = 4;
  switch (fam) {
    case 'glass': wall = pick(CURTAINS, u(4)); trim = pick([B.CHROME, B.STUCCO_WHITE, B.CONCRETE, B.PANEL_GREY], u(5)); break;
    case 'condo': wall = pick([B.STUCCO_WHITE, B.STUCCO_WHITE, B.STUCCO_CREAM, B.PANEL_WHITE, B.STUCCO_SKY], u(4)); win = pick([B.GLASS, B.CURTAIN_TEAL, B.CURTAIN_BLUE, B.GLASS], u(5)); trim = B.STUCCO_WHITE; fh = 3; break;
    case 'deco': wall = pick(PASTEL.concat([B.STUCCO_WHITE, B.STUCCO_WHITE]), u(4)); trim = u(5) < 0.7 ? B.STUCCO_WHITE : pick(PASTEL, u(6)); accent = pick(PASTEL, u(7)); fh = 3; break;
    case 'house': {
      const gab = style === 'gables' || style === 'grove' || style === 'keys';
      wall = gab ? pick([B.STUCCO_CREAM, B.STUCCO_OCHRE, B.STUCCO_WHITE, B.STUCCO_PEACH, B.STUCCO_PINK], u(4)) : pick(PASTEL.concat([B.STUCCO_WHITE, B.STUCCO_CREAM, B.STUCCO_WHITE]), u(4));
      roof = gab || u(5) < 0.55 ? B.ROOF_TILE : pick([B.SHINGLE_GREY, B.SHINGLE_BROWN, B.TIN_ROOF, B.ROOF_TILE], u(6));
      trim = B.STUCCO_WHITE; fh = 3; break;
    }
    case 'ware': wall = style === 'wynwood' ? pick([B.PANEL_GREY, B.CONCRETE, B.BRICK, B.STUCCO_WHITE], u(4)) : pick([B.METAL, B.PANEL_GREY, B.PANEL_WHITE, B.CONCRETE, B.BRICK_TAN], u(4)); trim = pick([B.STRIPE, B.CONCRETE, B.PANEL_GREY], u(5)); roof = u(6) < 0.25 ? B.SOLAR : B.METAL; fh = 5; break;
    case 'hangar': wall = pick([B.METAL, B.PANEL_WHITE, B.PANEL_GREY], u(4)); roof = B.METAL; trim = B.AWNING_BLUE; break;
    case 'terminal': wall = B.PANEL_WHITE; trim = B.CHROME; win = B.GLASS; roof = B.PANEL_GREY; fh = 5; break;
    case 'garage': wall = B.CONCRETE; trim = B.CONCRETE; fh = 3; break;
    case 'canopy': wall = B.METAL; trim = B.PANEL_WHITE; roof = B.PANEL_WHITE; break;
    case 'church': wall = pick([B.LIMESTONE, B.STUCCO_CREAM, B.STUCCO_WHITE], u(4)); roof = B.ROOF_TILE; win = B.STAINED_GLASS; trim = B.LIMESTONE; break;
    case 'shed': wall = pick([B.PLANK, B.SIDING_WHITE, B.PANEL_GREY, B.STUCCO_WHITE], u(4)); roof = B.TIN_ROOF; break;
    case 'civic': wall = pick([B.LIMESTONE, B.STUCCO_CREAM, B.BRICK_TAN, B.CONCRETE], u(4)); trim = B.LIMESTONE; break;
    default: {
      const pal: Record<string, number[]> = {
        havana: [B.STUCCO_PEACH, B.STUCCO_YELLOW, B.STUCCO_TEAL, B.STUCCO_PINK, B.STUCCO_CREAM, B.STUCCO_WHITE],
        wynwood: [B.BRICK, B.STUCCO_WHITE, B.PANEL_GREY, B.CONCRETE],
        gables: [B.STUCCO_CREAM, B.STUCCO_OCHRE, B.LIMESTONE, B.STUCCO_WHITE],
        design: [B.STUCCO_WHITE, B.CONCRETE, B.PANEL_WHITE, B.STUCCO_CREAM],
        downtown: [B.CONCRETE, B.LIMESTONE, B.STUCCO_WHITE, B.BRICK_TAN, B.PANEL_GREY],
      };
      wall = pick(pal[style] ?? [B.STUCCO_WHITE, B.STUCCO_CREAM, B.STUCCO_PEACH, B.CONCRETE, B.STUCCO_SKY, B.BRICK_TAN, B.STUCCO_YELLOW], u(4));
      trim = pick([B.STUCCO_WHITE, B.CONCRETE, B.LIMESTONE], u(5)); fh = h > 14 ? 3 : 4;
    }
  }
  if (b.colour && (fam === 'mid' || fam === 'house' || fam === 'deco' || fam === 'condo' || fam === 'civic')) wall = COLOUR_BLOCKS[b.colour] || wall;

  // roof shape: OSM hint first, then sensible defaults
  let roofShape: Facade['roofShape'] = 'flat';
  if (b.roof === ROOF.DOME) roofShape = 'dome';
  else if (b.roof === ROOF.ROUND || fam === 'hangar') roofShape = 'vault';
  else if (b.roof === ROOF.GABLED || b.roof === ROOF.HIPPED || b.roof === ROOF.PYRAMIDAL) roofShape = 'hip';
  else if (b.roof === ROOF.UNKNOWN && (fam === 'house' || fam === 'church' || fam === 'shed')) roofShape = fam === 'shed' && u(8) < 0.5 ? 'flat' : 'hip';
  if (fam === 'house' && style !== 'gables' && style !== 'grove' && u(9) < 0.25) { roofShape = 'flat'; roof = B.ROOF_WHITE; }
  // low residential mid-rises get Mediterranean tile roofs instead of bare slabs
  const tiledRes = fam === 'mid' && h <= 14 && !dense && (k === BK.APARTMENTS || k === BK.RESIDENTIAL || k === BK.HOUSE) &&
    (style === 'havana' || style === 'gables' || style === 'grove' || style === 'keys' || style === 'suburb' || style === 'north') && u(19) < 0.55 && roofShape === 'flat';
  if (tiledRes) { roofShape = 'hip'; roof = B.ROOF_TILE; }
  // flat roof membranes
  if (roofShape === 'flat' && roof === B.CONCRETE) {
    if (fam === 'glass' || fam === 'condo') roof = u(20) < 0.6 ? B.ROOF_WHITE : B.ROOF_DARK;
    else if (fam === 'mid' || fam === 'deco' || fam === 'civic') roof = u(20) < 0.45 ? B.ROOF_WHITE : u(20) < 0.75 ? B.ROOF_DARK : B.CONCRETE;
  }
  // landmarks (shapes only, matched by name or by the Ocean Drive strip)
  const cxw = (b.bbox[0] + b.bbox[2]) / 2, czw = (b.bbox[1] + b.bbox[3]) / 2;
  const lm = landmarkOf(b, cxw, czw, fam, h);
  let lmWall = 0;
  if (lm === 'freedom') { fam = 'civic'; wall = B.STUCCO_CREAM; trim = B.LIMESTONE; roof = B.COPPER_ROOF; win = B.ARCH_WINDOW; roofShape = 'flat'; lmWall = Math.round(h * 0.7); }
  else if (lm === 'tower') { fam = 'terminal'; wall = B.CONCRETE; trim = B.CHROME; win = B.GLASS; roof = B.PANEL_GREY; roofShape = 'flat'; lmWall = Math.round(h * 0.8); }
  else if (lm === 'arena') { fam = 'terminal'; wall = B.PANEL_WHITE; trim = B.CHROME; win = B.GLASS; roof = B.PANEL_GREY; roofShape = 'dome'; }
  else if (lm === 'ballpark') { fam = 'terminal'; wall = B.STUCCO_WHITE; trim = B.CHROME; win = B.GLASS; roof = B.PANEL_WHITE; roofShape = 'dome'; }
  else if (lm === 'oceandrive') { fam = 'deco'; wall = pick(PASTEL, u(4)); trim = B.STUCCO_WHITE; accent = pick(PASTEL, u(7)); fh = 3; roofShape = 'flat'; roof = B.ROOF_WHITE; }
  else if (lm === 'terminal') { roofShape = 'flat'; roof = B.PANEL_WHITE; }
  const roofCap = roofShape === 'hip' ? Math.min(fam === 'house' || fam === 'shed' ? 2 : tiledRes ? 3 : 5, Math.max(1, Math.ceil(maxDist * 0.5))) : roofShape === 'flat' ? 0 : Math.min(maxDist, Math.round(h * (lm === 'ballpark' ? 0.34 : lm === 'arena' ? 0.3 : 0.4)));
  let hWall = Math.max(fam === 'house' ? 3 : 1, h - (roofShape === 'flat' ? 0 : roofCap));
  if (lmWall) hWall = Math.max(2, lmWall);
  const [x0, z0, x1, z1] = b.bbox;
  const commercial = k === BK.COMMERCIAL || k === BK.RETAIL || k === BK.OFFICE || k === BK.HOTEL || k === BK.OTHER || k === BK.RESIDENTIAL || k === BK.APARTMENTS;
  const strip = style === 'downtown' || style === 'brickell' || style === 'edgewater' || style === 'havana' || style === 'sobe' || style === 'wynwood' || style === 'design' || style === 'beach' || style === 'north';
  const storeFam = fam === 'mid' || fam === 'deco' || fam === 'civic' || fam === 'ware';
  const store = storeFam && strip && commercial && h >= 4 && (fam !== 'ware' || u(21) < 0.35) && (k !== BK.APARTMENTS || u(22) < 0.4);
  const hotel = k === BK.HOTEL;
  return {
    fam, wall, trim, win, roof, accent, fh, hWall, roofShape, roofCap,
    fins: u(10) < 0.3, bands: u(10) >= 0.3 && u(10) < 0.6, crown: (fam === 'glass' || fam === 'deco') && u(11) < 0.4 ? pick(NEONS, u(12)) : -1,
    pool: ((fam === 'condo' || fam === 'glass') && h >= 25 && maxDist >= 7 && u(13) < 0.55) || (hotel && roofShape === 'flat' && h >= 8 && maxDist >= 6 && (fam === 'deco' || fam === 'mid' || fam === 'condo' || fam === 'glass') && u(13) < 0.7),
    helipad: fam === 'glass' && h >= 80 && maxDist >= 7 && u(14) < 0.5,
    mast: fam === 'glass' && h >= 60 ? 6 + Math.floor(u(15) * 14) : 0,
    tank: (fam === 'mid' || fam === 'deco' || fam === 'condo' || fam === 'civic') && h >= 9 && h <= 45 && maxDist >= 4 && u(16) < 0.38,
    mural: 0,
    cx: Math.floor((x0 + x1) / 2), cz: Math.floor((z0 + z1) / 2), top, base, solar: roof === B.SOLAR,
    lm, grid: fam === 'glass' && u(10) >= 0.6, podium: fam === 'glass' && h >= 40,
    store, awn: store ? pick(AWN, u(23)) : 0, balc: (fam === 'mid' || fam === 'condo') && (k === BK.APARTMENTS || k === BK.RESIDENTIAL || hotel) && u(24) < 0.7,
    par: fam === 'deco' || fam === 'civic' ? 2 : 1,
    units: fam === 'ware' || fam === 'hangar' ? 0.35 : fam === 'glass' ? 0.5 : 0.7,
    bulk: (fam === 'mid' || fam === 'deco' || fam === 'condo' || fam === 'glass' || fam === 'civic') && h >= 9 && maxDist >= 3,
    pent: (fam === 'glass' || fam === 'condo') && h >= 30 && maxDist >= 6 ? 3 + Math.floor(u(26) * 5) : 0,
    chimney: fam === 'house' && roofShape === 'hip' && u(27) < 0.3 && maxDist >= 3,
    antenna: (fam === 'mid' || fam === 'condo' || fam === 'civic') && h >= 20 && u(28) < 0.45 ? 4 + Math.floor(u(29) * 7) : 0,
    murals: style === 'wynwood' && (fam === 'ware' || fam === 'mid' || fam === 'deco') && u(17) < 0.8,
    seed: b.seed | 0,
    ofs: [0, 1, 2, 3, 4, 5, 6, 7].map((q) => Math.floor(u(40 + q) * 7) - 3),
  };
}

/** landmark id for a building (shapes only: generic structures matched by name / strip) */
function landmarkOf(b: LBuilding, cx: number, cz: number, fam: Family, h: number): string {
  const n = b.name;
  if (n) {
    if (/freedom tower/i.test(n)) return 'freedom';
    if (/control tower/i.test(n)) return 'tower';
    if (/^concourse|^terminal [a-z0-9]+$/i.test(n) && b.kind === BK.TERMINAL) return 'terminal';
  }
  // the arena on Biscayne Bay and the ballpark in Little Havana, matched by position (generic shapes, no names)
  if (h >= 30 && h <= 120) {
    for (const [id, p] of LM_POINTS) if (b.bbox[0] <= p[0] && b.bbox[2] >= p[0] && b.bbox[1] <= p[1] && b.bbox[3] >= p[1] && (b.bbox[2] - b.bbox[0]) >= 100) return id;
  }
  if ((fam === 'deco' || b.kind === BK.HOTEL) && h <= 32 && cx >= OD.x0 && cx <= OD.x1 && cz >= OD.z0 && cz <= OD.z1) return 'oceandrive';
  return '';
}
const LM_POINTS: [string, [number, number]][] = [['arena', lonLatToWorld(-80.18795, 25.78136)], ['ballpark', lonLatToWorld(-80.2197, 25.7781)]];
const OD = (() => { const [x0, z1] = lonLatToWorld(-80.1322, 25.7695), [x1, z0] = lonLatToWorld(-80.1302, 25.7865); return { x0, x1, z0, z1 }; })();

export class LeoniaGen {
  readonly tiles: LeoniaTiles;
  readonly width = LEONIA_PROJ.width;
  readonly depth = LEONIA_PROJ.depth;
  private facades = new WeakMap<TileRaster, Map<number, Facade>>();
  private removedB = new WeakMap<TileRaster, Uint8Array>();
  /** 1 if building bid of this tile is removed for a prefab placement */
  private removed(t: TileRaster, bid: number): boolean {
    let m = this.removedB.get(t);
    if (!m) {
      m = new Uint8Array(t.t.buildings.length + 1);
      t.t.buildings.forEach((b, k) => { if (leoniaBuildingRemoved(b.bbox)) m![k + 1] = 1; });
      this.removedB.set(t, m);
    }
    return m[bid] === 1;
  }
  /** scratch buffers */
  private wdist = new Uint8Array(0);

  constructor(source: LeoniaSource | null = null, cacheTiles = 16) {
    this.tiles = new LeoniaTiles(source, cacheTiles);
  }

  /** async: load every tile the region (plus padding) touches */
  prepare(x0: number, z0: number, w: number, d: number): Promise<void> {
    return this.tiles.ensure(x0 - PAD, z0 - PAD, x0 + w + PAD, z0 + d + PAD);
  }

  private tileAt(x: number, z: number): TileRaster | null {
    const t = this.tiles.get(Math.floor(x / TILE), Math.floor(z / TILE));
    return t ?? null;
  }
  isWater(x: number, z: number): boolean {
    if (x < 0 || z < 0 || x >= this.width || z >= this.depth) return true;
    const t = this.tileAt(x, z);
    return t ? t.water(x, z) : true;
  }

  private facade(t: TileRaster, bid: number, x: number, z: number): Facade {
    let m = this.facades.get(t);
    if (!m) { m = new Map(); this.facades.set(t, m); }
    let f = m.get(bid);
    if (!f) {
      const b = t.t.buildings[bid - 1];
      f = facadeFor(b, t.bMax[bid], districtAt((b.bbox[0] + b.bbox[2]) / 2, (b.bbox[1] + b.bbox[3]) / 2).style);
      m.set(bid, f);
    }
    void x; void z;
    return f;
  }

  generateRegion(x0: number, z0: number, w: number, d: number, out: Uint8Array) {
    const H = WORLD_H, plane = w * d;
    out.fill(0);
    // ── distance from water cells to land (window with padding), for depth + docks ──
    const WW = w + PAD * 2, WD = d + PAD * 2;
    if (this.wdist.length < WW * WD) this.wdist = new Uint8Array(WW * WD);
    const wd = this.wdist;
    for (let j = 0; j < WD; j++) for (let i = 0; i < WW; i++) wd[j * WW + i] = this.isWater(x0 - PAD + i, z0 - PAD + j) ? 40 : 0;
    for (let j = 0; j < WD; j++) for (let i = 0; i < WW; i++) { const k = j * WW + i; if (!wd[k]) continue; let v = wd[k]; if (i) v = Math.min(v, wd[k - 1] + 1); if (j) v = Math.min(v, wd[k - WW] + 1); wd[k] = v; }
    for (let j = WD - 1; j >= 0; j--) for (let i = WW - 1; i >= 0; i--) { const k = j * WW + i; if (!wd[k]) continue; let v = wd[k]; if (i < WW - 1) v = Math.min(v, wd[k + 1] + 1); if (j < WD - 1) v = Math.min(v, wd[k + WW] + 1); wd[k] = v; }

    let curT: TileRaster | null = null, curTx = -1e9, curTz = -1e9;
    for (let lz = 0; lz < d; lz++) for (let lx = 0; lx < w; lx++) {
      const x = x0 + lx, z = z0 + lz;
      const col = lx + lz * w;
      const put = (y: number, id: number) => { if (y >= 0 && y < H) out[col + y * plane] = id; };
      const fill = (ya: number, yb: number, id: number) => { for (let y = Math.max(0, ya); y <= Math.min(H - 1, yb); y++) out[col + y * plane] = id; };
      const wdist = wd[(lz + PAD) * WW + lx + PAD];
      if (x < 0 || z < 0 || x >= this.width || z >= this.depth) { fill(0, 8, B.STONE); put(9, B.SAND); fill(10, SEA_LEVEL, B.WATER); continue; }
      const tx = Math.floor(x / TILE), tz = Math.floor(z / TILE);
      if (tx !== curTx || tz !== curTz) { curT = this.tileAt(x, z); curTx = tx; curTz = tz; }
      const t = curT;
      if (!t) { fill(0, 8, B.STONE); put(9, B.SAND); fill(10, SEA_LEVEL, B.WATER); continue; }
      const i = t.idx(x, z);
      const water = t.water(x, z);
      const sf = t.sf[i], lu = t.lu[i];
      const deckId = t.deck[i];

      if (water) {
        const depth = Math.min(9, 1 + Math.floor(wdist / 2) + (wdist > 14 ? 1 : 0));
        const floor = SEA_LEVEL - depth;
        fill(0, floor - 1, B.STONE);
        put(floor, wdist <= 2 ? B.SAND : h32(x >> 2, z >> 2, 3) < 0.35 && depth < 7 ? B.SEAGRASS : B.SAND);
        fill(floor + 1, SEA_LEVEL, B.WATER);
        // piers / breakwaters / docks
        const rid = t.road[i];
        if (rid) {
          const c = t.segCls[rid];
          const dd = t.distTo(rid, x + 0.5, z + 0.5), hw = t.segs[(rid - 1) * SEG.N + 5];
          if (dd <= hw && (c === RC.PIER || isFoot(c))) { this.pier(put, fill, x, z, floor, dd, hw); }
          else if (dd <= hw && c === RC.BREAKWATER) fill(floor, 21, h32(x, z, 4) < 0.5 ? B.GRANITE : B.STONE);
          else if (dd <= hw + 0.5 && (isCarRoad(c) || isRail(c)) && !deckId) {
            // road on water without a raised deck: causeway fill (mapping mismatch or low approach)
            fill(floor, 20, B.STONE);
            put(21, dd <= hw ? this.roadSurface(c, t.segFlags[rid], t.segLanes[rid], hw, 0, 0, 0, x, z, 0) : B.CONCRETE);
            if (dd > hw - 0.6) put(22, B.CONCRETE);
          }
        }
        if (sf === AK.PIER) this.pier(put, fill, x, z, floor, 0, 9);
        else if (sf === AK.BREAKWATER) fill(floor, 21, B.GRANITE);
        else if (wdist === 1 && !rid) {
          // seawall docks along residential canals and marinas
          const lnd = this.landNeighbour(x, z);
          if (lnd && (lnd.lu === AK.RESIDENTIAL || lnd.sf === AK.MARINA || lnd.res)) { put(SEA_LEVEL + 1, B.DOCK); if ((x + z) % 4 === 0) fill(floor + 1, SEA_LEVEL, B.DARK_PLANK); }
        }
        if (deckId) this.deck(put, fill, t, deckId, x, z, floor + 1, true);
        continue;
      }

      // ── land column ──
      fill(0, 17, B.STONE); fill(18, 20, B.DIRT);
      let bid = t.bld[i];
      if (bid && this.removed(t, bid)) bid = 0;
      const rid = t.road[i];
      if (bid) {
        this.building(put, fill, t, bid, i, x, z);
        if (deckId) this.deck(put, fill, t, deckId, x, z, 22, false);
        continue;
      }
      let top = B.GRASS;
      let roadDone = false;
      if (rid) {
        const o = (rid - 1) * SEG.N, s = t.segs;
        const cls = t.segCls[rid], flags = t.segFlags[rid], lanes = t.segLanes[rid];
        const ax = s[o], az = s[o + 1], bx = s[o + 2], bz = s[o + 3], L = s[o + 8] || 1e-6, hw = s[o + 5];
        const dx = (bx - ax) / L, dz = (bz - az) / L;
        const px = x + 0.5 - ax, pz = z + 0.5 - az;
        let tt = px * dx + pz * dz; const along = s[o + 4] + tt;
        if (tt < 0) tt = 0; else if (tt > L) tt = L;
        const cross = px * -dz + pz * dx; // signed lateral offset (left +)
        const dist = Math.hypot(px - dx * tt, pz - dz * tt);
        const sw = flags & RF.SIDEWALK ? SIDEWALK_W : 0;
        if (dist <= hw) {
          roadDone = true;
          top = this.roadSurface(cls, flags, lanes, hw, cross, along, t.junc[i], x, z, sf);
          if (isRail(cls)) { put(21, top); if (top === B.RAIL || top === B.DARK_PLANK) put(20, B.GRAVEL); }
          else if (cls === RC.PIER) { put(21, B.DOCK); if (hw >= 2 && Math.abs(Math.abs(cross) - hw) < 0.8) put(22, B.IRON_RAIL); }
          else if (cls === RC.BREAKWATER) { put(21, B.GRANITE); }
          else put(21, top);
        } else if (dist <= hw + sw && isCarRoad(cls)) {
          roadDone = true;
          put(21, sf === SF_DRIVEWAY ? B.CONCRETE : B.SIDEWALK);
          // curb planters / bins downtown
          if ((districtAt(x, z).style === 'downtown' || districtAt(x, z).style === 'brickell') && Math.abs(dist - hw - sw + 0.5) < 0.5 && (Math.floor(along) % 11) === 5 && !t.junc[i]) put(G, B.HEDGE);
        } else if (isCarRoad(cls) && dist <= hw + sw + 1.5 && sw && (lu === AK.RESIDENTIAL || (!lu && districtAt(x, z).style === 'suburb')) && !sf) {
          // front-yard boundary: hedges / picket fences with gaps
          put(21, B.GRASS);
          if (dist > hw + sw + 0.5 && h32(Math.floor(along / 9), rid, 2) < 0.55) put(G, h32(Math.floor(along / 30), rid, 3) < 0.5 ? B.HEDGE : B.PICKET);
          roadDone = true;
        }
      }
      if (!roadDone) this.surface(put, fill, t, i, x, z, sf, lu);
      if (deckId) this.deck(put, fill, t, deckId, x, z, 22, false);
    }
    this.stamps(x0, z0, w, d, out);
    this.prefabs(x0, z0, w, d, out);
  }

  /** enterable prefabs: level the pad (sidewalk at y 21, air above) and stamp the rotated prefab */
  private prefabs(x0: number, z0: number, w: number, d: number, out: Uint8Array) {
    const H = WORLD_H, plane = w * d;
    for (const p of leoniaPlaced()) {
      const [bx0, bz0, bx1, bz1] = p.box;
      const ax = Math.max(x0, bx0), az = Math.max(z0, bz0), ex = Math.min(x0 + w, bx1), ez = Math.min(z0 + d, bz1);
      if (ax >= ex || az >= ez) continue;
      const sd = p.s.data, ymax = Math.min(p.s.maxY, STRUCT_H - 1);
      for (let z = az; z < ez; z++) for (let x = ax; x < ex; x++) {
        const [lx, lz] = frameCellOf(p.f, x, z);
        if (lx < LOT_PAD.x0 || lx >= LOT_PAD.x1 || lz >= LOT_PAD.z1 || lz < 0) continue;
        const col = (x - x0) + (z - z0) * w;
        if (lz < LOT_PAD.z0) {
          // the real street in front: keep the road/sidewalk, clear street trees, lamps and shelters off the frontage
          for (let y = G; y < G + 16; y++) { const k = col + y * plane; const id = out[k]; if (id !== B.CONCRETE && id !== B.IRON_RAIL && id !== B.ASPHALT && id !== B.SIDEWALK) out[k] = B.AIR; }
          continue;
        }
        for (let y = G; y < H; y++) out[col + y * plane] = B.AIR;
        out[col + 21 * plane] = B.SIDEWALK;
        for (let y = 0; y <= ymax; y++) {
          const v = sd[lx + lz * LOT + y * LOT * LOT];
          if (v) out[col + (21 + y) * plane] = v - 1;
        }
      }
    }
  }

  private landNeighbour(x: number, z: number): { lu: number; sf: number; res: boolean } | null {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const qx = x + dx, qz = z + dz;
      if (this.isWater(qx, qz)) continue;
      const t = this.tileAt(qx, qz); if (!t) continue;
      const i = t.idx(qx, qz);
      const b = t.bld[i];
      return { lu: t.lu[i], sf: t.sf[i], res: !!b && t.t.buildings[b - 1].kind === BK.HOUSE };
    }
    return null;
  }

  private pier(put: (y: number, id: number) => void, fill: (a: number, b: number, id: number) => void, x: number, z: number, floor: number, dd: number, hw: number) {
    put(21, B.DOCK);
    if ((x % 4 === 0 && z % 4 === 0)) fill(floor, 20, B.DARK_PLANK);
    if (hw >= 2 && hw - dd < 0.8) put(22, B.IRON_RAIL);
  }

  private roadSurface(cls: number, flags: number, lanes: number, hw: number, cross: number, along: number, junc: number, x: number, z: number, sf: number): number {
    if (cls === RC.RUNWAY) {
      const ac = Math.abs(cross);
      if (ac < 0.75 && ((Math.floor(along) % 50) + 50) % 50 < 25) return B.LINE_WHITE;
      if (ac > hw - 1.5 && ac <= hw - 0.5) return B.LINE_WHITE;
      return B.RUNWAY;
    }
    if (cls === RC.TAXIWAY) return Math.abs(cross) < 0.6 ? B.LINE_YELLOW : B.ASPHALT;
    if (isRail(cls)) {
      const tracks = Math.max(1, lanes);
      for (let k = 0; k < tracks; k++) {
        const c = -hw + 2 + k * 4;
        const off = Math.abs(cross - c);
        if (off >= 0.4 && off < 1.4) return B.RAIL;
        if (off < 0.4) return ((Math.floor(along) % 2) + 2) % 2 === 0 ? B.DARK_PLANK : B.GRAVEL;
      }
      return B.GRAVEL;
    }
    if (isFoot(cls)) {
      if (cls === RC.PEDESTRIAN) return (Math.floor(along / 2) + Math.floor(cross + 50)) % 5 === 0 ? B.MARBLE : B.COBBLE;
      if (cls === RC.STEPS) return B.CONCRETE;
      if (cls === RC.CYCLEWAY) return B.ASPHALT;
      if (cls === RC.TRACK) return B.PATH;
      const green = sf === AK.PARK || sf === AK.GARDEN || sf === AK.NATURE || sf === AK.FOREST || sf === AK.GOLF || sf === AK.GOLF_ROUGH || sf === AK.SCRUB || sf === AK.ZOO;
      if (sf === AK.BEACH || sf === AK.SAND) return B.PLANK;
      return green ? B.PATH : B.SIDEWALK;
    }
    if (cls === RC.PIER) return B.DOCK;
    if (cls === RC.BREAKWATER) return B.GRANITE;
    // car roads
    if (junc === 1) return B.ASPHALT;
    if (junc === 2 && cls !== RC.SERVICE && cls !== RC.MOTORWAY) return ((Math.floor(cross + 100)) % 2 === 0) ? B.LINE_WHITE : B.ASPHALT;
    if (cls === RC.SERVICE) return B.ASPHALT;
    const ac = Math.abs(cross);
    const oneway = (flags & RF.ONEWAY) !== 0;
    const a = ((Math.floor(along) % 10) + 10) % 10;
    if (!oneway && lanes >= 2 && ac < 0.5) return B.LINE_YELLOW;
    if (lanes >= 2) {
      const lw = (hw * 2) / lanes;
      for (let k = 1; k < lanes; k++) {
        const p = -hw + k * lw;
        if (!oneway && Math.abs(p) < 0.6) continue;
        if (Math.abs(cross - p) < 0.5 && a < 4) return B.LINE_WHITE;
      }
    }
    if ((cls === RC.MOTORWAY || cls === RC.TRUNK) && ac > hw - 1.2 && ac <= hw - 0.4) return B.LINE_WHITE;
    void x; void z;
    return B.ASPHALT;
  }

  private surface(put: (y: number, id: number) => void, fill: (a: number, b: number, id: number) => void, t: TileRaster, i: number, x: number, z: number, sf: number, lu: number, noEdge = false) {
    const hv = h32(x, z, 101);
    const edge = () => t.sf[i - 1] !== sf || t.sf[i + 1] !== sf || t.sf[i - RS] !== sf || t.sf[i + RS] !== sf;
    switch (sf) {
      case SF_DRIVEWAY: put(21, B.CONCRETE); return;
      case AK.PARKING: {
        const ang = (t.sfAng[i] / 255) * Math.PI;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const u = x * ca + z * sa, v = -x * sa + z * ca;
        const vm = ((v % 17) + 17) % 17, um = ((u % 2.7) + 2.7) % 2.7;
        const bay = vm < 5.5 ? 0 : vm >= 11.5 ? 1 : -1;
        put(21, B.ASPHALT);
        if (!noEdge && edge()) { put(21, B.SIDEWALK); if (hv < 0.3) put(G, B.HEDGE); return; }
        if (bay >= 0 && um < 0.4) { put(21, B.LINE_WHITE); return; }
        if (bay >= 0) {
          const slot = Math.floor(u / 2.7), row = Math.floor(v / 17) * 2 + bay;
          if (h32(slot, row, Math.floor(ang * 100)) < 0.55 && um > 0.55 && um < 2.35) {
            const inBay = bay === 0 ? vm : vm - 11.5;
            if (inBay > 0.5 && inBay < 5.0) {
              const col = CAR_COLOURS[Math.floor(h32(slot, row, 9) * CAR_COLOURS.length)];
              put(G, col);
              if (inBay > 1.5 && inBay < 3.8) put(G + 1, B.CURTAIN_DARK);
            }
          }
        }
        return;
      }
      case AK.PLAZA: put(21, (x + z) % 7 === 0 || (x - z + 700) % 7 === 0 ? B.MARBLE : B.COBBLE); if (hv < 0.01) put(G, B.HEDGE); return;
      case AK.PITCH: put(21, edge() ? B.COURT_LINE : B.COURT_GREEN); return;
      case AK.TRACK: put(21, B.COURT_RED); return;
      case AK.STADIUM: put(21, B.CONCRETE); return;
      case AK.PLAYGROUND: put(21, B.SAND); if (hv < 0.03) { fill(G, G + 2, B.FENCE); put(G + 3, pick(AWN, h32(x, z, 4))); } return;
      case AK.POOL: if (edge()) put(21, B.CONCRETE); else { put(20, B.POOL_TILE); put(21, B.WATER); } return;
      case AK.FOREST: case AK.NATURE: put(21, B.GRASS); if (hv < 0.12) put(G, B.PALMETTO); else if (hv < 0.2) put(G, B.TALL_GRASS); return;
      case AK.SCRUB: put(21, hv < 0.2 ? B.SAND : B.GRASS); if (hv > 0.75) put(G, hv > 0.9 ? B.PALMETTO : B.TALL_GRASS); return;
      case AK.WETLAND: if (hv < 0.3) { put(20, B.MUD); put(21, B.WATER); } else { put(21, B.MUD); if (hv > 0.6) put(G, B.REEDS); } return;
      case AK.CEMETERY: put(21, B.GRASS); if (x % 3 === 0 && z % 4 === 1 && hv < 0.85) put(G, hv < 0.15 ? B.MARBLE : B.LIMESTONE); return;
      case AK.GOLF: case AK.GOLF_ROUGH: put(21, B.GRASS); if (hv < 0.04) put(G, B.TALL_GRASS); return;
      case AK.GOLF_FAIRWAY: put(21, B.FAIRWAY); return;
      case AK.GOLF_GREEN: case AK.GOLF_TEE: put(21, B.PUTTING); return;
      case AK.GOLF_BUNKER: case AK.SAND: put(21, B.SAND); return;
      case AK.BEACH: put(21, B.SAND); fill(18, 20, B.SAND); if (hv < 0.006) put(G, B.SEA_OATS); return;
      case AK.APRON: put(21, B.CONCRETE); return;
      case AK.RUNWAY: put(21, B.RUNWAY); return;
      case AK.HELIPAD: put(21, B.HELIPAD); return;
      case AK.MARINA: case AK.BRIDGE: put(21, B.CONCRETE); return;
      case AK.PIER: put(21, B.DOCK); return;
      case AK.BREAKWATER: put(21, B.GRANITE); return;
      case AK.PARK: case AK.GARDEN: case AK.ZOO: case AK.CAMPUS_GREEN: case AK.DOG_PARK: case AK.GRASS:
        put(21, B.GRASS); if (hv < 0.025) put(G, hv < 0.01 ? B.FLOWERS : B.TALL_GRASS); else if (sf === AK.GARDEN && hv < 0.1) put(G, B.FLOWERS); return;
    }
    switch (lu) {
      case AK.RESIDENTIAL: put(21, B.GRASS); if (hv < 0.015) put(G, B.FLOWERS); return;
      case AK.COMMERCIAL: case AK.RETAIL: put(21, ((x >> 1) + (z >> 1)) % 6 === 0 ? B.CONCRETE : B.SIDEWALK); return;
      case AK.INDUSTRIAL: case AK.PORT: {
        put(21, B.CONCRETE);
        const style = districtAt(x, z).style;
        if (lu === AK.PORT || style === 'port') this.containers(put, x, z, (t.luAng[i] / 255) * Math.PI);
        else if (hv < 0.02) put(G, B.CRATE);
        return;
      }
      case AK.RAILWAY: put(21, B.GRAVEL); return;
      case AK.CONSTRUCTION: put(21, hv < 0.5 ? B.DIRT : B.GRAVEL); if (hv > 0.995) fill(G, G + 3, B.SCAFFOLD); return;
      case AK.FARMLAND: put(21, B.FARMLAND); if (hv < 0.5) put(G, B.VEG); return;
      case AK.AERODROME: put(21, B.GRASS); return;
      case AK.EDUCATION: case AK.HOSPITAL: case AK.RELIGIOUS: case AK.MILITARY: put(21, B.GRASS); return;
    }
    // no land use mapped: paved in the dense urban districts, grass elsewhere
    const st = districtAt(x, z).style;
    if (st === 'downtown' || st === 'brickell' || st === 'edgewater' || st === 'design' || st === 'wynwood') {
      // vacant urban lots: surface parking (as most of them really are), paved plazas near buildings
      const nearB = t.bld[i - 2] || t.bld[i + 2] || t.bld[i - 2 * RS] || t.bld[i + 2 * RS];
      if (nearB) { put(21, ((x >> 1) + (z >> 1)) % 6 === 0 ? B.CONCRETE : B.SIDEWALK); if (hv < 0.006) put(G, B.HEDGE); return; }
      this.surface(put, fill, t, i, x, z, AK.PARKING, 0, true);
      return;
    }
    put(21, B.GRASS);
    if (hv < 0.06) put(G, B.TALL_GRASS);
  }

  private containers(put: (y: number, id: number) => void, x: number, z: number, ang: number) {
    // container blocks: 4 x 12 m boxes along u, 6 rows of 2.5 m along v, then a 6 m straddle lane
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const u = x * ca + z * sa, v = -x * sa + z * ca;
    const BU = 4 * 12.5 + 7, BV = 6 * 2.6 + 6;
    const bu = Math.floor(u / BU), bv = Math.floor(v / BV);
    const mu = u - bu * BU, mv = v - bv * BV;
    if (mu >= 50 || mv >= 15.6) { if (mv >= 15.6 && mv < 16.2 && ((Math.floor(u) % 6) + 6) % 6 < 3) put(21, B.LINE_YELLOW); return; }
    if (mu % 12.5 > 12.1) return;
    const box = Math.floor(mu / 12.5), row = Math.floor(mv / 2.6);
    if (mv % 2.6 > 2.45) return;
    if (h32(bu, bv, 63) < 0.12) return; // empty block
    const base = 1 + Math.floor(h32(bu, bv, 64) * 3.2);
    const stack = Math.max(0, Math.min(4, base + (h32(bu * 8 + box, bv * 8 + row, 65) < 0.3 ? -1 : 0)));
    const muted = [B.CONTAINER_BLUE, B.CONTAINER_RED, B.CONTAINER_WHITE, B.PANEL_GREY, B.CONTAINER_GREEN, B.CONTAINER_BLUE, B.CONTAINER_WHITE, B.CONTAINER_ORANGE, B.CONTAINER_RED, B.CONTAINER_YELLOW];
    for (let s2 = 0; s2 < stack; s2++) {
      const c = muted[Math.floor(h32(bu * 31 + box * 7 + s2, bv * 17 + row, 62) * (s2 === 0 ? 7 : muted.length))];
      put(G + s2 * 2, c); put(G + s2 * 2 + 1, c);
    }
  }

  private deck(put: (y: number, id: number) => void, fill: (a: number, b: number, id: number) => void, t: TileRaster, id: number, x: number, z: number, groundY: number, overWater: boolean) {
    const o = (id - 1) * SEG.N, s = t.segs;
    const ax = s[o], az = s[o + 1], bx = s[o + 2], bz = s[o + 3], L = s[o + 8] || 1e-6, hw = s[o + 5];
    const dx = (bx - ax) / L, dz = (bz - az) / L;
    const px = x + 0.5 - ax, pz = z + 0.5 - az;
    let tt = px * dx + pz * dz; const along = s[o + 4] + tt;
    if (tt < 0) tt = 0; else if (tt > L) tt = L;
    const cross = px * -dz + pz * dx;
    const dist = Math.hypot(px - dx * tt, pz - dz * tt);
    const h = s[o + 6] + ((s[o + 7] - s[o + 6]) * tt) / L;
    const cls = t.segCls[id];
    const dy = 21 + Math.round(h);
    if (dy >= WORLD_H - 2) return;
    const sw = isCarRoad(cls) && t.segFlags[id] & RF.SIDEWALK ? SIDEWALK_W : 0;
    if (dist > hw && dist <= hw + sw) { // walkable sidewalk on the deck
      put(dy - 1, B.CONCRETE); put(dy, B.SIDEWALK);
      return;
    }
    if (dist > hw) { // parapet: jersey barrier + rail (+ lamp posts every 24 m on the main roads)
      const lampStep = ((Math.floor(along) % 24) + 24) % 24;
      put(dy - 1, B.CONCRETE); put(dy, B.CONCRETE);
      put(dy + 1, isFoot(cls) || isRail(cls) || isCarRoad(cls) ? B.IRON_RAIL : B.CONCRETE);
      if (isCarRoad(cls) && cls <= RC.SECONDARY && dist <= hw + sw + 1 && lampStep === 0 && dy - groundY >= 3) { fill(dy + 1, dy + 4, B.METAL); put(dy + 5, B.LAMP); }
      if (dy - groundY >= 4) put(dy - 2, B.CONCRETE); // deeper fascia girder on the raised spans
      return;
    }
    put(dy - 1, B.CONCRETE);
    put(dy, isFoot(cls) ? (cls === RC.FOOTWAY || cls === RC.PATH ? B.CONCRETE : B.ASPHALT) : this.roadSurface(cls, t.segFlags[id], t.segLanes[id], hw, cross, along, 0, x, z, 0));
    if (isRail(cls)) put(dy - 1, B.CONCRETE);
    // piers every ~32 m: a bent of two 3-wide columns joined by a cap beam under the deck. On land a column
    // never stands on a carriageway below (elevated rail / flyovers over streets): it moves 16 m along to the next gap.
    const a = ((Math.floor(along) % 32) + 32) % 32;
    const colX = Math.abs(Math.abs(cross) - hw * 0.55) < 1.5;
    if (dy - 3 >= groundY && (a < 3 || (a >= 16 && a < 19 && !overWater))) {
      if (colX) {
        let pier = false;
        if (a < 3) pier = overWater || !this.onCarriageway(x, z);
        else pier = !this.onCarriageway(x, z) && this.onCarriageway(Math.floor(x + 0.5 - dx * 16), Math.floor(z + 0.5 - dz * 16));
        if (pier) fill(overWater ? groundY - 6 : groundY, dy - 2, B.CONCRETE);
      } else if (a < 3 && Math.abs(cross) <= hw + 1 && (overWater || dy - 3 >= 26)) { put(dy - 2, B.CONCRETE); put(dy - 3, B.CONCRETE); } // cap beam
    }
  }

  /** ground-level car carriageway (not a deck) at a column */
  private onCarriageway(x: number, z: number): boolean {
    const t = this.tileAt(x, z); if (!t) return false;
    const rid = t.road[t.idx(x, z)];
    if (!rid || !isCarRoad(t.segCls[rid])) return false;
    return t.distTo(rid, x + 0.5, z + 0.5) <= t.segs[(rid - 1) * SEG.N + 5] + 0.5;
  }

  private building(put: (y: number, id: number) => void, fill: (a: number, b: number, id: number) => void, t: TileRaster, bid: number, i: number, x: number, z: number) {
    const f = this.facade(t, bid, x, z);
    const dist = t.bdist[i];
    put(21, B.CONCRETE);
    if (f.lm === 'freedom' || f.lm === 'tower') { this.tiered(put, t, bid, i, f, dist, x, z); return; }
    const y0 = G + f.base;
    const edge = dist === 1;
    // wall orientation → coordinate along the wall
    const outX = t.bld[i - 1] !== bid || t.bld[i + 1] !== bid;
    const along = outX ? z : x;
    const am = (n: number) => ((along % n) + n) % n;
    const hw = f.hWall;
    const u = h32(x, z, 201);
    switch (f.fam) {
      case 'canopy': {
        put(y0 + hw - 1, f.roof);
        if (edge && am(7) === 0) fill(G, y0 + hw - 2, B.METAL);
        return;
      }
      case 'garage': {
        for (let k = 0; k < hw; k++) {
          const y = y0 + k, row = k % 3;
          if (row === 0 || k === hw - 1) put(y, B.CONCRETE);
          else if (edge) { if (row === 1) put(y, B.CONCRETE); else if (am(6) === 0) put(y, B.CONCRETE); }
          else if (((x % 8) + 8) % 8 === 0 && ((z % 8) + 8) % 8 === 0) put(y, B.CONCRETE);
          else if (row === 1 && h32(x >> 1, z >> 2, k) < 0.25) put(y, CAR_COLOURS[Math.floor(h32(x >> 1, z >> 2, k + 9) * 8)]);
        }
        if (edge) put(y0 + hw, B.CONCRETE);
        else if (dist >= 2) {
          // top deck: parked cars in bays and light poles
          if (((x % 8) + 8) % 8 === 0 && ((z % 8) + 8) % 8 === 0) { fill(y0 + hw, y0 + hw + 2, B.METAL); put(y0 + hw + 3, B.LIGHT_RED); }
          else if (h32(x >> 1, z >> 2, 77) < 0.2) put(y0 + hw, CAR_COLOURS[Math.floor(h32(x >> 1, z >> 2, 78) * 8)]);
        }
        return;
      }
    }
    // walls
    const corner = edge && (t.bld[i - 1] !== bid || t.bld[i + 1] !== bid) && (t.bld[i - RS] !== bid || t.bld[i + RS] !== bid);
    for (let k = 0; k < hw; k++) {
      const y = y0 + k;
      let id = f.wall;
      if (edge) id = this.wallBlock(f, k, hw, am, u, corner, along);
      else if (k === hw - 1 && f.roofShape === 'flat') id = f.roof;
      put(y, id);
    }
    // roofs
    const ytop = y0 + hw;
    if (f.roofShape === 'flat') {
      if (edge) {
        if (f.fam !== 'shed') {
          // stepped corners on Art Deco blocks (suggests rounded corners), otherwise a parapet
          if (f.fam === 'deco' && corner) { put(ytop - 1, f.trim); return; }
          put(ytop, f.trim);
          if (f.par >= 2) put(ytop + 1, f.trim);
          else if ((f.fam === 'glass' || f.fam === 'condo') && f.top >= 24 && am(2) === 0) put(ytop + 1, B.IRON_RAIL);
        }
        return;
      }
      this.roofItems(put, fill, f, t, bid, dist, x, z, ytop);
      return;
    }
    const maxD = t.bMax[bid];
    let rh: number;
    if (f.roofShape === 'hip') rh = Math.min(f.fam === 'house' || f.fam === 'shed' ? Math.ceil(dist / 2) : dist, f.roofCap);
    else { const R = Math.max(1, maxD); const q = 1 - (R - dist) / R; rh = Math.round(f.roofCap * Math.sqrt(Math.max(0, 1 - (1 - q) * (1 - q)))); if (f.roofShape === 'vault') rh = Math.max(1, rh); }
    if (f.lm === 'ballpark' && !edge && Math.abs(z - f.cz) < 7) { put(ytop - 1, B.GRASS); return; } // open roof slot over the pitch
    if (rh > 0) {
      fill(ytop, ytop + rh - 1, f.roof);
      if ((f.lm === 'arena' || f.lm === 'ballpark') && (((x - f.cx) % 8 + 8) % 8 === 0 || ((z - f.cz) % 8 + 8) % 8 === 0)) put(ytop + rh - 1, f.trim); // roof ribs
    } else if (edge) put(ytop, f.roof);
    if (f.fam === 'church' && dist === maxD && maxD >= 3 && x === f.cx) fill(ytop + rh, ytop + rh + 6, B.LIMESTONE);
    if (f.chimney && dist >= 2 && x === f.cx + f.ofs[6] && z === f.cz + f.ofs[7]) fill(ytop, ytop + rh + 1, B.BRICK);
  }

  /** tall landmark towers whose silhouette is not a prism (column solidity depends on height and wall distance) */
  private tiered(put: (y: number, id: number) => void, t: TileRaster, bid: number, i: number, f: Facade, dist: number, x: number, z: number) {
    const y0 = G + f.base, H = f.top - f.base, maxD = Math.max(2, t.bMax[bid]);
    const free = f.lm === 'freedom';
    // monotone stepped body (Freedom Tower) or shaft + cab (control tower)
    const d1 = Math.max(2, Math.round(maxD * 0.3)), d2 = Math.max(d1 + 2, Math.round(maxD * 0.55)), d3 = Math.max(d2 + 2, Math.round(maxD * 0.8));
    const s0 = Math.max(2, Math.ceil(maxD * 0.6));
    const solid = (k: number, D: number): boolean => {
      if (D <= 0) return false;
      if (free) {
        const top = D >= d3 ? H : D >= d2 ? H * 0.93 : D >= d1 ? H * 0.82 : H * 0.62;
        if (k < top) return true;
        return D >= maxD - 1 && k < H + 7;
      }
      if (k < 6) return D >= 1; // plinth
      if (D >= s0 && k < H - 18) return true; // shaft
      if (k >= H - 18 && k < H - 6) return D >= 2; // cab
      if (k >= H - 6 && k < H - 3) return D >= 3 + (k - (H - 6));
      if (k >= H - 3 && k < H) return D >= s0;
      return D >= maxD - 1 && k < H + 14; // mast
    };
    const col = (j: number) => (t.bld[j] === bid ? t.bdist[j] : 0);
    const dN = col(i - RS), dS = col(i + RS), dW = col(i - 1), dE = col(i + 1);
    const along = t.bld[i - 1] !== bid || t.bld[i + 1] !== bid ? z : x;
    const am = (n: number) => ((along % n) + n) % n;
    const kMax = Math.min(WORLD_H - y0 - 2, H + 15);
    for (let k = 0; k <= kMax; k++) {
      if (!solid(k, dist)) continue;
      const exposed = !solid(k, dN) || !solid(k, dS) || !solid(k, dW) || !solid(k, dE);
      const topBlock = !solid(k + 1, dist);
      let id: number = f.wall;
      if (free) {
        if (k > H) id = B.GOLD_TRIM;
        else if (topBlock) id = dist >= d3 ? B.COPPER_ROOF : f.trim;
        else if (exposed) id = k < 4 ? (am(5) < 2 ? f.wall : B.ARCH_WINDOW) : k % 5 === 0 ? f.trim : am(4) === 0 ? f.wall : (k % 5 <= 3 ? B.ARCH_WINDOW : f.wall);
      } else {
        if (k > H) id = k === kMax ? B.LIGHT_RED : B.CHROME;
        else if (topBlock) id = f.trim;
        else if (exposed) id = k >= H - 18 && k < H - 6 ? (k % 6 === 0 || am(4) === 0 ? B.CHROME : B.GLASS) : k >= H - 3 ? B.GLASS : (k % 10 === 0 ? f.trim : f.wall);
      }
      put(y0 + k, id);
    }
  }

  private wallBlock(f: Facade, k: number, hw: number, am: (n: number) => number, u: number, corner: boolean, along: number): number {
    const top = k === hw - 1;
    // painted wall mosaics (original abstract colour fields, 18 m wall panels, Wynwood)
    if (f.murals && !top && k >= (f.store ? 4 : 1) && k < hw - 1) {
      const seg = Math.floor(along / 18);
      if (h32(f.seed, seg, 31) < 0.72) {
        const q = (Math.floor(along / 3) + Math.floor(k / 3) + Math.floor(h32(f.seed, seg, 32) * 5)) % 5;
        return MURALS[(q + 5) % 5];
      }
    }
    // ground-floor storefronts: piers, glass, awning band
    if (f.store && k <= 3 && (f.fam === 'mid' || f.fam === 'deco' || f.fam === 'civic' || f.fam === 'ware')) {
      const bay = am(6);
      if (bay === 0) return f.wall;
      if (k === 0) return f.trim;
      if (k === 3) return f.awn;
      return B.GLASS;
    }
    switch (f.fam) {
      case 'glass': {
        if (top) return f.trim;
        if (f.podium && k < 7) { if (k === 0 || k === 6) return f.trim; return am(6) === 0 ? B.CHROME : B.GLASS; }
        if (k < 4) return k === 0 ? f.trim : B.GLASS;
        if (f.crown >= 0 && k === hw - 3) return f.crown;
        if (f.grid) { if (am(3) === 0) return B.CHROME; if (k % 4 === 0) return B.CURTAIN_DARK; return f.wall; }
        if (f.fins && am(4) === 0) return f.trim;
        if (f.bands && k % 4 === 0) return f.wall === B.CURTAIN_DARK ? B.CHROME : B.CURTAIN_DARK;
        return f.wall;
      }
      case 'condo': {
        if (top) return f.trim;
        if (k < 3) return am(3) === 0 ? f.wall : B.GLASS;
        if (k % 3 === 0) return f.trim;
        if (k % 3 === 1 && am(5) !== 0) return B.IRON_RAIL;
        return am(5) === 0 ? f.wall : f.win;
      }
      case 'deco': {
        if (top) return f.trim;
        if (corner && k >= hw - 3) return f.accent;
        if (f.crown >= 0 && k === hw - 2 && (f.lm === 'oceandrive' || am(2) === 0)) return f.crown;
        if (am(9) === 4) return f.accent;
        if (k < 3) return k === 0 ? f.wall : (am(3) === 0 ? f.wall : B.GLASS);
        if (k % 3 === 0) return f.trim; // eyebrow line over each window row
        if (k % 3 === 1 && am(6) === 3) return B.ARCH_WINDOW;
        return am(3) === 0 ? f.wall : B.WINDOW;
      }
      case 'house': {
        if (k === 0) return f.wall;
        const row = k % f.fh;
        if (row !== 0 && am(5) >= 1 && am(5) <= 2) return B.WINDOW;
        return f.wall;
      }
      case 'ware': {
        if (top) return f.trim;
        if (f.mural && k >= 1 && k < hw - 1) return f.mural;
        if (k < 5 && am(14) >= 3 && am(14) <= 8) return B.SHUTTER;
        if (k === hw - 3 && am(3) !== 0) return B.WINDOW;
        return f.wall;
      }
      case 'hangar': {
        if (k < Math.min(12, hw - 1) && am(40) >= 4 && am(40) <= 30) return B.SHUTTER;
        return f.wall;
      }
      case 'terminal': {
        if (top) return f.trim;
        const r = k % 5;
        if (r >= 1 && r <= 3) return am(6) === 0 ? B.CHROME : B.GLASS;
        return f.wall;
      }
      case 'church': {
        if (k >= 2 && k < hw - 2 && am(4) === 2) return f.win;
        return f.wall;
      }
      case 'shed': return f.wall;
      case 'civic': {
        if (top) return f.trim;
        if (f.lm === 'freedom') return f.wall;
        const row = k % 4;
        if (row !== 0 && am(3) !== 0) return B.WINDOW;
        if (k < 4 && am(6) === 0) return f.trim;
        return f.wall;
      }
      default: {
        if (top) return f.trim;
        const row = k % f.fh;
        if (k < 4) return k === 0 ? f.wall : am(2) ? B.GLASS : f.wall;
        if (row === 0) return f.trim;
        if (f.balc && row === 1 && am(6) < 4) return B.IRON_RAIL;
        if (am(3) !== 0) return B.WINDOW;
        void u;
        return f.wall;
      }
    }
  }

  private roofItems(put: (y: number, id: number) => void, fill: (a: number, b: number, id: number) => void, f: Facade, t: TileRaster, bid: number, dist: number, x: number, z: number, ytop: number) {
    const ry = ytop - 1; // roof surface block
    const dx = x - f.cx, dz = z - f.cz;
    if (f.solar && dist >= 2) { put(ry, B.SOLAR); return; }
    // roof membrane seams (tar strips) so big roofs are not one flat colour
    if ((f.roof === B.ROOF_WHITE || f.roof === B.CONCRETE) && f.fam !== 'house' && ((dz + 600) % 9 === 0)) put(ry, B.ROOF_DARK);
    const maxD = t.bMax[bid];
    if (f.helipad && dist >= 3 && Math.abs(dx) <= 4 && Math.abs(dz) <= 4) { put(ry, B.HELIPAD); if (Math.abs(dx) === 4 && Math.abs(dz) === 4) put(ytop, B.LIGHT_RED); return; }
    if (f.pool && dist >= 3 && Math.abs(dx) <= 5 && Math.abs(dz) <= 2) { put(ry, B.WATER); put(ry - 1, B.POOL_TILE); return; }
    if (f.pool && dist >= 2 && Math.abs(dx) <= 7 && Math.abs(dz) <= 4) {
      put(ry, B.TILE_FLOOR);
      if ((dx + dz) % 4 === 0 && Math.abs(dz) === 4) { put(ytop, B.FENCE); put(ytop + 1, pick(AWN, h32(bid, 3))); put(ytop + 2, pick(AWN, h32(bid, 3))); } // umbrellas
      else if (Math.abs(dz) === 3 && dx % 3 === 0 && Math.abs(dx) <= 6) put(ytop, B.STUCCO_WHITE); // loungers
      return;
    }
    if (f.mast && dx === 0 && dz === 0 && !f.helipad) { const yy = Math.min(WORLD_H - 2, ytop + f.mast); fill(ytop, yy, B.CHROME); put(yy + 1, B.LIGHT_RED); return; }
    // penthouse / mechanical floor, set back from the edge
    if (f.pent && dist >= Math.max(3, Math.round(maxD * 0.55))) {
      const edgeP = dist === Math.max(3, Math.round(maxD * 0.55));
      fill(ytop, ytop + f.pent - 1, edgeP && (x + z) % 3 === 0 ? f.win : f.wall);
      put(ytop + f.pent, f.trim);
      return;
    }
    // stair bulkhead (3 x 3 x 3 with a door)
    if (f.bulk) {
      const bx = f.cx + f.ofs[0], bz = f.cz + f.ofs[1];
      if (Math.abs(x - bx) <= 1 && Math.abs(z - bz) <= 1) {
        fill(ytop, ytop + 2, B.CONCRETE); put(ytop + 3, B.ROOF_DARK);
        if (z === bz + 1 && x === bx) { put(ytop, B.SHUTTER); put(ytop + 1, B.SHUTTER); }
        return;
      }
    }
    // wooden water tank on a steel stand
    if (f.tank) {
      const tx = f.cx + f.ofs[2], tz = f.cz + f.ofs[3];
      const ax = x - tx, az = z - tz;
      if (Math.abs(ax) <= 1 && Math.abs(az) <= 1) {
        if (Math.abs(ax) === 1 && Math.abs(az) === 1) fill(ytop, ytop + 1, B.TRUSS);
        fill(ytop + 2, ytop + 4, B.DARK_PLANK);
        if (ax === 0 && az === 0) put(ytop + 5, B.METAL);
        return;
      }
    }
    // antenna mast on mid-rises
    if (f.antenna && x === f.cx + f.ofs[4] && z === f.cz + f.ofs[5]) { fill(ytop, ytop + f.antenna, B.TRUSS); if (f.antenna >= 8) put(ytop + f.antenna + 1, B.LIGHT_RED); return; }
    // equipment on a 6 m grid: AC condensers, chillers with fans, vent stacks, solar rows
    if (dist < 2) return;
    const gx = Math.floor((dx + 600) / 6), gz = Math.floor((dz + 600) / 6);
    const lx = dx + 600 - gx * 6, lz = dz + 600 - gz * 6;
    const hc = h32(gx, gz, (f.seed & 0xffff) + 977);
    const un = f.units;
    if (hc < un * 0.5) { if (lx >= 1 && lx <= 2 && lz >= 1 && lz <= 2) put(ytop, B.AC_UNIT); }
    else if (hc < un * 0.65) { if (lx >= 1 && lx <= 3 && lz >= 1 && lz <= 2) { fill(ytop, ytop + 1, B.AC_UNIT); if (lx === 2) put(ytop + 2, B.FAN_CAGE); } }
    else if (hc < un * 0.78) { if (lx === 3 && lz === 3) fill(ytop, ytop + 2, B.METAL); }
    else if (hc < un * 0.86 && f.fam !== 'glass') { if (lx >= 0 && lx <= 3 && lz >= 1 && lz <= 2) put(ytop, B.SOLAR); }
    else if (f.lm === 'terminal' && lz === 3 && lx <= 4) put(ry, B.GLASS); // skylight rows
  }

  // ───────────────────────────────────────────────────────────── stamps
  private stamps(x0: number, z0: number, w: number, d: number, out: Uint8Array) {
    const H = WORLD_H, plane = w * d;
    const M = 44;
    const set = (x: number, y: number, z: number, id: number) => {
      const lx = x - x0, lz = z - z0;
      if (lx < 0 || lz < 0 || lx >= w || lz >= d || y < 0 || y >= H) return;
      out[lx + lz * w + y * plane] = id;
    };
    const setAir = (x: number, y: number, z: number, id: number) => {
      const lx = x - x0, lz = z - z0;
      if (lx < 0 || lz < 0 || lx >= w || lz >= d || y < 0 || y >= H) return;
      const k = lx + lz * w + y * plane;
      if (out[k] === B.AIR || out[k] === B.TALL_GRASS || out[k] === B.FLOWERS) out[k] = id;
    };
    const t0x = Math.floor((x0 - M) / TILE), t1x = Math.floor((x0 + w + M) / TILE), t0z = Math.floor((z0 - M) / TILE), t1z = Math.floor((z0 + d + M) / TILE);
    for (let tz = t0z; tz <= t1z; tz++) for (let tx = t0x; tx <= t1x; tx++) {
      const t = this.tiles.get(tx, tz);
      if (!t) continue;
      const s = t.stamps;
      for (let k = 0; k < s.length; k += 5) {
        const x = s[k + 1], z = s[k + 2];
        if (x < x0 - M || z < z0 - M || x >= x0 + w + M || z >= z0 + d + M) continue;
        const type = s[k], ang = s[k + 3] / 1000, p = s[k + 4];
        switch (type) {
          case ST.PALM: {
            const hgt = 6 + Math.floor(h32(x, z, 1) * 5) + (p === 1 ? 1 : 0);
            for (let y = G; y < G + hgt; y++) setAir(x, y, z, B.PALM_LOG);
            const ty = G + hgt;
            setAir(x, ty, z, B.PALM_LEAVES);
            for (const [ddx, ddz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
              setAir(x + ddx, ty, z + ddz, B.PALM_LEAVES);
              setAir(x + ddx * 2, ty - (ddx && ddz ? 1 : 0), z + ddz * 2, B.PALM_LEAVES);
              if (!(ddx && ddz)) setAir(x + ddx * 3, ty - 1, z + ddz * 3, B.PALM_LEAVES);
            }
            break;
          }
          case ST.TREE: {
            const hgt = 3 + Math.floor(h32(x, z, 2) * 3), r = 2 + (h32(x, z, 3) < 0.4 ? 1 : 0);
            const leaves = p === 1 ? B.MANGROVE_LEAVES : B.LEAVES;
            for (let y = G; y < G + hgt; y++) setAir(x, y, z, B.BARK);
            const cy = G + hgt + 1;
            for (let dy = -r + 1; dy <= r - 1; dy++) for (let ddz = -r; ddz <= r; ddz++) for (let ddx = -r; ddx <= r; ddx++) {
              const q = ddx * ddx + ddz * ddz + dy * dy * 1.6;
              if (q <= r * r + 0.5 && h32(x + ddx, z + ddz, dy + 9) < 0.92) setAir(x + ddx, cy + dy, z + ddz, leaves);
            }
            break;
          }
          case ST.PLANE: {
            // airliner, nose toward the gate (direction ang); ~38 m long, 34 m span
            const ca = Math.cos(ang), sa = Math.sin(ang);
            const tail = [B.PLANE_TAIL, B.AWNING_RED, B.CURTAIN_DARK, B.AWNING_GREEN][p % 4];
            for (let ddz = -20; ddz <= 20; ddz++) for (let ddx = -20; ddx <= 20; ddx++) {
              const u = ddx * ca + ddz * sa, v = -ddx * sa + ddz * ca; // u: along fuselage (+ = nose)
              const av = Math.abs(v);
              if (u >= -19 && u <= 17) {
                const taper = u > 13 ? 2 - (u - 13) * 0.5 : u < -14 ? 2 - (-14 - u) * 0.35 : 2;
                if (av <= taper) { set(x + ddx, G + 3, z + ddz, B.FUSELAGE); if (av <= taper - 0.8) { set(x + ddx, G + 2, z + ddz, B.FUSELAGE); set(x + ddx, G + 4, z + ddz, u > 14 ? B.CURTAIN_DARK : B.FUSELAGE); } }
              }
              // wings (swept back), engines, tail
              const sweep = -2 - av * 0.35;
              if (av <= 17 && av > 1.5 && u <= sweep + 3 && u >= sweep - 2 + av * 0.08) set(x + ddx, G + 2, z + ddz, B.PANEL_WHITE);
              if (Math.abs(av - 6.5) < 1 && u <= sweep + 5 && u >= sweep + 1.5) set(x + ddx, G + 1, z + ddz, B.METAL);
              if (av <= 6 && u >= -19 && u <= -16) set(x + ddx, G + 4, z + ddz, B.PANEL_WHITE);
              if (av < 0.6 && u >= -19 && u <= -14) for (let y = G + 5; y <= G + 6 + Math.round((-14 - u) * 1.4); y++) set(x + ddx, y, z + ddz, tail);
            }
            break;
          }
          case ST.CRANE: {
            // ship-to-shore gantry crane: 4 legs, portal beam, boom over the water
            const ca = Math.cos(ang), sa = Math.sin(ang);
            const at = (u: number, v: number): [number, number] => [Math.round(x + u * ca - v * sa), Math.round(z + u * sa + v * ca)];
            for (const [u, v] of [[-6, -7], [-6, 7], [6, -7], [6, 7]]) { const [px, pz] = at(u, v); for (let y = G; y < G + 30; y++) set(px, y, pz, B.CRANE_YELLOW); }
            for (let u = -6; u <= 6; u++) for (const v of [-7, 7]) { const [px, pz] = at(u, v); set(px, G + 30, pz, B.CRANE_YELLOW); set(px, G + 14, pz, B.TRUSS); }
            for (let u = -22; u <= 40; u++) for (const v of [-1, 0, 1]) { const [px, pz] = at(u, v); set(px, G + 32, pz, v === 0 ? B.CRANE_YELLOW : B.TRUSS); }
            for (let v = -7; v <= 7; v++) { const [px, pz] = at(0, v); set(px, G + 31, pz, B.CRANE_YELLOW); }
            for (let y = G + 33; y < G + 42; y++) { const [px, pz] = at(-4, 0); set(px, y, pz, B.CRANE_YELLOW); }
            { const [px, pz] = at(-4, 0); set(px, G + 42, pz, B.LIGHT_RED); }
            for (let u = -4; u <= 0; u++) for (const v of [-1, 1]) { const [px, pz] = at(u, v); set(px, G + 33, pz, B.PANEL_WHITE); }
            break;
          }
          case ST.SHRUB: setAir(x, G, z, B.HEDGE); setAir(x + 1, G, z, B.HEDGE); setAir(x, G, z + 1, B.HEDGE); break;
          case ST.LAMP: {
            for (let y = G; y < G + 5; y++) setAir(x, y, z, B.METAL);
            const ax = Math.round(Math.cos(ang)), az = Math.round(Math.sin(ang));
            setAir(x, G + 5, z, B.METAL); setAir(x + ax, G + 5, z + az, B.LAMP);
            break;
          }
          case ST.PORTAL: this.portal(set, x, z, ang, p / 10); break;
          case ST.CAR: this.car(set, x, z, ang, CAR_COLOURS[p % CAR_COLOURS.length], G); break;
          case ST.BOAT: case ST.YACHT: {
            const L2 = type === ST.YACHT ? 6 : 3.5, W2 = type === ST.YACHT ? 2 : 1.3;
            const ca = Math.cos(ang), sa = Math.sin(ang);
            const R = Math.ceil(L2) + 1;
            for (let ddz = -R; ddz <= R; ddz++) for (let ddx = -R; ddx <= R; ddx++) {
              const u = ddx * ca + ddz * sa, v = -ddx * sa + ddz * ca;
              const taper = W2 * Math.min(1, (L2 - Math.abs(u)) / 1.5 + 0.35);
              if (Math.abs(u) > L2 || Math.abs(v) > taper) continue;
              const hull = type === ST.YACHT ? B.HULL_WHITE : (h32(x, z, 5) < 0.5 ? B.HULL_WHITE : B.HULL_BLUE);
              set(x + ddx, SEA_LEVEL, z + ddz, hull);
              if (Math.abs(u) < L2 * 0.35 && Math.abs(v) < taper - 0.5) { set(x + ddx, SEA_LEVEL + 1, z + ddz, B.PANEL_WHITE); if (type === ST.YACHT) set(x + ddx, SEA_LEVEL + 2, z + ddz, Math.abs(u) < 1 ? B.CURTAIN_DARK : B.PANEL_WHITE); }
            }
            break;
          }
          case ST.UMBRELLA: {
            for (let y = G; y < G + 3; y++) setAir(x, y, z, B.FENCE);
            const c = AWN[p % 4];
            for (let ddz = -1; ddz <= 1; ddz++) for (let ddx = -1; ddx <= 1; ddx++) setAir(x + ddx, G + 3, z + ddz, c);
            setAir(x + 2, G, z, B.STUCCO_WHITE);
            break;
          }
          case ST.LIFEGUARD: {
            const c = [B.STUCCO_PINK, B.STUCCO_TEAL, B.STUCCO_YELLOW, B.STUCCO_LAVENDER][p % 4];
            for (const [ddx, ddz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) for (let y = G; y < G + 3; y++) setAir(x + ddx, y, z + ddz, B.FENCE);
            for (let ddz = -2; ddz <= 2; ddz++) for (let ddx = -1; ddx <= 1; ddx++) setAir(x + ddx, G + 3, z + ddz, B.PLANK);
            for (let ddz = -1; ddz <= 1; ddz++) for (let ddx = -1; ddx <= 1; ddx++) {
              const e = Math.abs(ddx) === 1 || Math.abs(ddz) === 1;
              if (e) { setAir(x + ddx, G + 4, z + ddz, c); setAir(x + ddx, G + 5, z + ddz, ddz === 1 && ddx === 0 ? B.GLASS : c); }
              setAir(x + ddx, G + 6, z + ddz, B.AWNING_RED);
            }
            for (let k = 1; k <= 3; k++) setAir(x, G + 3 - k, z + 2 + k, B.PLANK);
            break;
          }
          case ST.BUS_STOP: {
            const ca = Math.round(Math.cos(ang)), sa = Math.round(Math.sin(ang));
            for (let q = -1; q <= 2; q++) {
              const bx = x + ca * q, bz = z + sa * q;
              setAir(bx, G + 3, bz, B.PANEL_WHITE);
              if (q === -1 || q === 2) { setAir(bx, G, bz, B.METAL); setAir(bx, G + 1, bz, B.SIGN_PANEL); setAir(bx, G + 2, bz, B.METAL); }
              else setAir(bx, G, bz, B.DARK_PLANK);
            }
            break;
          }
          case ST.BENCH: {
            const ca = Math.round(Math.cos(ang)), sa = Math.round(Math.sin(ang));
            setAir(x, G, z, B.DARK_PLANK); setAir(x + ca, G, z + sa, B.DARK_PLANK);
            break;
          }
        }
      }
    }
  }

  /** closed, covered tunnel mouth: road ends in a short concrete box with a dark sealed end (tunnels themselves are not modelled) */
  private portal(set: (x: number, y: number, z: number, id: number) => void, x: number, z: number, ang: number, hw: number) {
    const ca = Math.cos(ang), sa = Math.sin(ang), LEN = 11, R = Math.ceil(LEN + hw + 3);
    for (let ddz = -R; ddz <= R; ddz++) for (let ddx = -R; ddx <= R; ddx++) {
      const u = ddx * ca + ddz * sa, v = -ddx * sa + ddz * ca;
      if (u < -0.5 || u > LEN || Math.abs(v) > hw + 2) continue;
      const bx = x + ddx, bz = z + ddz, av = Math.abs(v);
      const wet = this.isWater(bx, bz);
      if (wet) for (let y = SEA_LEVEL - 5; y <= 20; y++) set(bx, y, bz, B.CONCRETE);
      if (av <= hw) {
        set(bx, 21, bz, av < 0.5 && ((Math.floor(u) % 4) + 4) % 4 < 2 ? B.LINE_YELLOW : B.ASPHALT);
        for (let y = G; y < G + 5; y++) set(bx, y, bz, u > LEN - 1 ? (y === G + 2 ? B.NEON_ORANGE : B.BRICK_DARK) : B.AIR);
        for (let y = G + 5; y <= G + 6; y++) set(bx, y, bz, B.CONCRETE);
        if (u < 1.5) { for (let y = G + 4; y <= G + 7; y++) set(bx, y, bz, y === G + 4 ? B.NEON_ORANGE : B.GRANITE); }
      } else {
        for (let y = 21; y <= G + 6; y++) set(bx, y, bz, av <= hw + 1 ? B.CONCRETE : B.GRANITE);
        if (u < 2) set(bx, G + 7, bz, B.GRANITE);
      }
    }
  }

  private car(set: (x: number, y: number, z: number, id: number) => void, x: number, z: number, ang: number, col: number, y: number) {
    const ca = Math.cos(ang), sa = Math.sin(ang);
    for (let ddz = -3; ddz <= 3; ddz++) for (let ddx = -3; ddx <= 3; ddx++) {
      const u = (ddx + 0.5) * ca + (ddz + 0.5) * sa, v = -(ddx + 0.5) * sa + (ddz + 0.5) * ca;
      if (Math.abs(u) > 2.3 || Math.abs(v) > 1.0) continue;
      set(x + ddx, y, z + ddz, col);
      if (Math.abs(u) < 1.2) set(x + ddx, y + 1, z + ddz, B.CURTAIN_DARK);
    }
  }
}

// ───────────────────────────────────────────────────────────── world metadata
const SPAWN_LL: [number, number] = [-80.188712, 25.774256]; // sidewalk of E Flagler St by Biscayne Blvd, downtown
export const LEONIA = {
  id: 'leonia' as const,
  name: 'Leonia',
  width: LEONIA_PROJ.width,
  depth: LEONIA_PROJ.depth,
  seaLevel: SEA_LEVEL,
  proj: LEONIA_PROJ,
  tileSize: TILE,
  dataPath: 'world/leonia',
  attribution: '© OpenStreetMap contributors (ODbL 1.0)',
  get spawn(): [number, number, number] { const [x, z] = lonLatToWorld(SPAWN_LL[0], SPAWN_LL[1]); return [Math.round(x) + 0.5, G, Math.round(z) + 0.5]; },
};
export { BF };

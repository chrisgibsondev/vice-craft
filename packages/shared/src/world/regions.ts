/**
 * Regions: every column of Palmara belongs to a region (Port Solano downtown, Solano
 * Beach, Bayhaven, Cedar Bluff, ...). A region carries its own architecture palette
 * and lot mix; the column generators below build the lot contents one column at a
 * time (pure functions of x, z and the cached lot plan), so they stay fast and
 * identical on the server and in the client workers.
 *
 * Lot-local coordinates: bx, bz in 0..33 is the building area inside the sidewalks
 * (world lx = bx + 7). y = 21 is the ground layer, 22 the first block above ground.
 */
import { B, letterBlock } from './blocks.ts';
import type { MapData, P2, ZoneKind } from './mapTypes.ts';
import { hash2 } from './noise.ts';

// ───────────────────────────────────────────────────────────── region ids
export const REGION_LIST = [
  'wild', 'ps_downtown', 'ps_midtown', 'ps_suburbs', 'solano_beach', 'port_island', 'bayhaven', 'bayhaven_suburbs',
  'cedar_bluff', 'lakemont', 'lakemont_core', 'coral_sands', 'palm_haven', 'cape_halcyon', 'conch_harbor', 'sawgrass',
  'timberline', 'farmland', 'airport', 'keys', 'starfall', 'smalltown',
] as const;
export type RegionId = typeof REGION_LIST[number];
export const RG = Object.fromEntries(REGION_LIST.map((r, i) => [r, i])) as Record<RegionId, number>;

/** zone polygon id → region */
const ZONE_REGION: Record<string, RegionId> = {
  timberline_forest: 'timberline', central_farmland: 'farmland', mirabel_farms: 'farmland', sawgrass_glades: 'sawgrass',
  cedar_bluff: 'cedar_bluff', lakemont: 'lakemont', lakemont_core: 'lakemont_core', cape_halcyon: 'cape_halcyon',
  bayhaven: 'bayhaven', bayhaven_suburbs: 'bayhaven_suburbs', coral_sands: 'coral_sands', palm_haven: 'palm_haven',
  solano_suburbs: 'ps_suburbs', solano_urban: 'ps_midtown', solano_downtown: 'ps_downtown', solano_airport: 'airport',
  solano_port: 'port_island', solano_beach_strip: 'solano_beach', conch_harbor: 'conch_harbor', last_key_airport: 'airport',
  starfall_park: 'starfall',
};
/** Region-only areas (do not change zones): applied to columns that no zone claims. */
const EXTRA_AREAS: { region: RegionId; points: P2[] }[] = [
  // the cape and the Halcyon Shore barrier island (spaceport grounds)
  { region: 'cape_halcyon', points: [[2380, 1380], [2600, 1380], [2760, 2000], [2760, 2600], [2600, 2600], [2480, 1700], [2380, 1640]] },
  // the Coral Keys island chain
  { region: 'keys', points: [[1100, 3880], [2420, 3760], [2420, 4400], [1100, 4400]] },
];

const RCELL = 4;
function fillPoly(points: P2[], cw: number, ch: number, cb: (i: number) => void) {
  // identical scanline rule to MapRaster (cell centres)
  const n = points.length;
  let minZ = Infinity, maxZ = -Infinity;
  for (const p of points) { minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]); }
  const r0 = Math.max(0, Math.floor(minZ / RCELL)), r1 = Math.min(ch - 1, Math.ceil(maxZ / RCELL));
  const xs: number[] = [];
  for (let r = r0; r <= r1; r++) {
    const z = r * RCELL + RCELL / 2;
    xs.length = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, zi] = points[i], [xj, zj] = points[j];
      if ((zi > z) !== (zj > z)) xs.push(xi + ((z - zi) / (zj - zi)) * (xj - xi));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(xs[k] / RCELL - 0.5)), c1 = Math.min(cw - 1, Math.floor(xs[k + 1] / RCELL - 0.5));
      for (let c = c0; c <= c1; c++) cb(r * cw + c);
    }
  }
}

export class RegionRaster {
  readonly cw: number;
  readonly ch: number;
  readonly data: Uint8Array;
  constructor(map: MapData) {
    const cw = (this.cw = Math.ceil(map.width / RCELL)), ch = (this.ch = Math.ceil(map.depth / RCELL));
    const d = (this.data = new Uint8Array(cw * ch));
    for (const e of EXTRA_AREAS) fillPoly(e.points, cw, ch, (i) => (d[i] = RG[e.region]));
    for (const z of map.zones) {
      const reg = ZONE_REGION[z.id] ?? (z.kind === 'suburb' || z.kind === 'urban' ? 'smalltown' : z.kind === 'none' ? null : null);
      if (!reg) continue;
      const id = RG[reg];
      fillPoly(z.points, cw, ch, (i) => { d[i] = id; });
    }
  }
  at(x: number, z: number): number {
    const c = Math.min(this.cw - 1, Math.max(0, Math.floor(x / RCELL)));
    const r = Math.min(this.ch - 1, Math.max(0, Math.floor(z / RCELL)));
    return this.data[r * this.cw + c];
  }
}

// ───────────────────────────────────────────────────────────── lot plans
export type LotKind =
  | 'tower' | 'midrise' | 'houses' | 'warehouse' | 'hotel' | 'park' | 'poi' | 'margin' | 'landmark'
  | 'glass_tower' | 'apartments' | 'deco_hotel' | 'beach_club' | 'condo' | 'cul_de_sac' | 'villas' | 'golf'
  | 'conch_houses' | 'shops_row' | 'cigar_factory' | 'church' | 'school' | 'courts' | 'gas_station' | 'parking'
  | 'parking_garage' | 'construction' | 'strip_mall' | 'diner' | 'motel' | 'food_trucks' | 'billboard'
  | 'container_yard' | 'hangar' | 'radar' | 'town_hall' | 'plaza' | 'pond' | 'square';

export interface LotPlan {
  kind: LotKind;
  zone: ZoneKind;
  wall: number;
  accent: number;
  h: number;
  h2: number;
  inset: number;
  seed: number;
  /** region index (RG) */
  region: number;
  /** usable building rectangle in lot-local bx/bz coords [x0, z0, x1, z1] */
  rect: [number, number, number, number];
  trim: number;
  roof: number;
  /** per-lot random values in [0,1) */
  rv: Float32Array;
  /** sign / brand text */
  name: string;
}
export type Put = (y: number, id: number) => void;
export type LotGen = (x: number, z: number, bx: number, bz: number, p: LotPlan, put: Put) => void;

type Mix = [LotKind, number][];
export interface RegionStyle {
  walls: number[]; trims: number[]; roofs: number[]; accents: number[];
  big: Mix; mid: Mix; small: Mix;
  /** tower height range (blocks) */
  hMin: number; hMax: number;
  ground: number;
  house: 'stucco' | 'bungalow' | 'ranch' | 'cracker' | 'modern';
  church: 'stone' | 'white' | 'mission';
  shops: 'brick' | 'stone' | 'colour' | 'deco';
  palms: boolean;
}

const PASTEL = [B.STUCCO_PINK, B.STUCCO_TEAL, B.STUCCO_YELLOW, B.STUCCO_PEACH, B.STUCCO_MINT, B.STUCCO_LAVENDER, B.STUCCO_SKY];
const SIDINGS = [B.SIDING_MINT, B.SIDING_CORAL, B.SIDING_LEMON, B.SIDING_SKY, B.SIDING_LILAC, B.SIDING_WHITE];
const CURTAINS = [B.CURTAIN_TEAL, B.CURTAIN_BLUE, B.CURTAIN_GOLD, B.CURTAIN_DARK];
const NEONS = [B.NEON_PINK, B.NEON_CYAN, B.NEON_YELLOW, B.NEON_GREEN, B.NEON_ORANGE, B.NEON_PURPLE];
const AWNINGS = [B.AWNING_RED, B.AWNING_GREEN, B.AWNING_BLUE, B.AWNING_YELLOW];
const CONTAINERS = [B.CONTAINER_RED, B.CONTAINER_BLUE, B.CONTAINER_GREEN, B.CONTAINER_ORANGE, B.CONTAINER_WHITE, B.CONTAINER_YELLOW];

const SMALL_DEFAULT: Mix = [['parking', 2], ['courts', 2], ['food_trucks', 1.5], ['billboard', 1.5], ['plaza', 1], ['park', 1.5]];

export const STYLES: Record<RegionId, RegionStyle> = {
  wild: { walls: [B.STUCCO_WHITE], trims: [B.STUCCO_WHITE], roofs: [B.SHINGLE_GREY], accents: [B.NEON_CYAN], big: [['houses', 1]], mid: [['park', 1]], small: SMALL_DEFAULT, hMin: 8, hMax: 12, ground: B.GRASS, house: 'ranch', church: 'white', shops: 'colour', palms: false },
  ps_downtown: {
    walls: CURTAINS, trims: [B.CHROME, B.STUCCO_WHITE, B.CONCRETE], roofs: [B.CONCRETE], accents: NEONS,
    big: [['glass_tower', 6], ['tower', 3], ['parking_garage', 1], ['construction', 1.2], ['plaza', 0.8]],
    mid: [['glass_tower', 3], ['tower', 2], ['parking_garage', 1], ['plaza', 1]], small: SMALL_DEFAULT,
    hMin: 36, hMax: 96, ground: B.MARBLE, house: 'modern', church: 'stone', shops: 'colour', palms: true,
  },
  ps_midtown: {
    walls: [B.STUCCO_WHITE, B.STUCCO_PEACH, B.STUCCO_TEAL, B.CONCRETE, B.STUCCO_YELLOW, B.BRICK_TAN, B.STUCCO_SKY], trims: [B.STUCCO_WHITE, B.CONCRETE], roofs: [B.CONCRETE], accents: NEONS,
    big: [['apartments', 3], ['midrise', 3], ['strip_mall', 1.4], ['diner', 1], ['gas_station', 1], ['courts', 0.8], ['food_trucks', 0.8], ['church', 0.7], ['construction', 0.8], ['motel', 0.8], ['parking', 0.6]],
    mid: [['apartments', 2], ['diner', 1], ['gas_station', 1], ['food_trucks', 1], ['courts', 1]], small: SMALL_DEFAULT,
    hMin: 12, hMax: 32, ground: B.SIDEWALK, house: 'stucco', church: 'mission', shops: 'colour', palms: true,
  },
  ps_suburbs: {
    walls: PASTEL, trims: [B.STUCCO_WHITE], roofs: [B.ROOF_TILE, B.ROOF_TILE, B.SHINGLE_GREY], accents: NEONS,
    big: [['houses', 7], ['school', 1], ['church', 1], ['strip_mall', 1], ['gas_station', 1], ['courts', 0.7], ['park', 0.7], ['motel', 0.5], ['diner', 0.5]],
    mid: [['houses', 3], ['gas_station', 1], ['courts', 1], ['diner', 0.7]], small: SMALL_DEFAULT,
    hMin: 8, hMax: 12, ground: B.GRASS, house: 'stucco', church: 'mission', shops: 'colour', palms: true,
  },
  solano_beach: {
    walls: PASTEL, trims: [B.STUCCO_WHITE], roofs: [B.CONCRETE], accents: NEONS,
    big: [['deco_hotel', 6], ['beach_club', 2], ['condo', 2], ['diner', 0.5]], mid: [['deco_hotel', 3], ['beach_club', 2], ['diner', 1]],
    small: [['beach_club', 2], ['food_trucks', 1], ['plaza', 1]], hMin: 14, hMax: 30, ground: B.SAND, house: 'stucco', church: 'mission', shops: 'deco', palms: true,
  },
  port_island: {
    walls: [B.METAL, B.PANEL_GREY, B.PANEL_WHITE, B.BRICK], trims: [B.STRIPE, B.CONCRETE], roofs: [B.METAL], accents: [B.NEON_ORANGE],
    big: [['warehouse', 3], ['container_yard', 3]], mid: [['container_yard', 2], ['warehouse', 1]], small: [['container_yard', 2], ['parking', 1]],
    hMin: 10, hMax: 14, ground: B.CONCRETE, house: 'modern', church: 'stone', shops: 'brick', palms: false,
  },
  bayhaven: {
    walls: [B.BRICK, B.BRICK_DARK, B.BRICK, B.BRICK_TAN, B.STUCCO_CREAM], trims: [B.LIMESTONE, B.STUCCO_CREAM], roofs: [B.ROOF_TILE, B.SLATE_ROOF], accents: AWNINGS,
    big: [['shops_row', 5], ['cigar_factory', 2.5], ['church', 1], ['plaza', 1], ['apartments', 0.8], ['diner', 0.6], ['parking', 0.5], ['construction', 0.5], ['container_yard', 0.5]],
    mid: [['shops_row', 3], ['diner', 1], ['plaza', 1]], small: SMALL_DEFAULT,
    hMin: 10, hMax: 22, ground: B.SIDEWALK, house: 'bungalow', church: 'stone', shops: 'brick', palms: true,
  },
  bayhaven_suburbs: {
    walls: SIDINGS, trims: [B.SIDING_WHITE], roofs: [B.SHINGLE_GREY, B.SHINGLE_BROWN, B.SHINGLE_GREEN, B.TIN_ROOF], accents: AWNINGS,
    big: [['houses', 7], ['school', 1], ['church', 1], ['strip_mall', 1], ['gas_station', 1], ['courts', 0.7], ['park', 0.8], ['motel', 0.6], ['diner', 0.5]],
    mid: [['houses', 3], ['gas_station', 1], ['diner', 0.7], ['courts', 1]], small: SMALL_DEFAULT,
    hMin: 8, hMax: 12, ground: B.GRASS, house: 'bungalow', church: 'white', shops: 'colour', palms: true,
  },
  cedar_bluff: {
    walls: [B.LIMESTONE, B.BRICK_DARK, B.BRICK, B.LIMESTONE, B.BRICK_TAN], trims: [B.LIMESTONE, B.STUCCO_CREAM], roofs: [B.SLATE_ROOF, B.COPPER_ROOF], accents: AWNINGS,
    big: [['shops_row', 5], ['church', 2], ['town_hall', 1], ['plaza', 1], ['parking', 0.5], ['diner', 0.5], ['apartments', 0.6]],
    mid: [['shops_row', 3], ['church', 1], ['plaza', 1]], small: SMALL_DEFAULT,
    hMin: 10, hMax: 20, ground: B.SIDEWALK, house: 'bungalow', church: 'stone', shops: 'stone', palms: false,
  },
  lakemont: {
    walls: [B.SIDING_WHITE, B.SIDING_SKY, B.BRICK, B.STUCCO_CREAM, B.SIDING_LEMON, B.BRICK_TAN], trims: [B.SIDING_WHITE], roofs: [B.SHINGLE_GREY, B.SHINGLE_BROWN, B.SHINGLE_GREEN], accents: AWNINGS,
    big: [['cul_de_sac', 4], ['houses', 3], ['pond', 1.2], ['school', 1], ['church', 1], ['strip_mall', 1], ['gas_station', 1], ['motel', 0.8], ['courts', 0.7], ['diner', 0.5]],
    mid: [['houses', 2], ['pond', 1], ['gas_station', 1], ['courts', 1], ['diner', 0.7]], small: SMALL_DEFAULT,
    hMin: 8, hMax: 12, ground: B.GRASS, house: 'ranch', church: 'white', shops: 'colour', palms: true,
  },
  lakemont_core: {
    walls: [B.STUCCO_CREAM, B.SIDING_MINT, B.BRICK, B.STUCCO_PEACH, B.SIDING_SKY, B.BRICK_TAN], trims: [B.STUCCO_WHITE], roofs: [B.SHINGLE_GREY], accents: AWNINGS,
    big: [['shops_row', 4], ['town_hall', 1], ['food_trucks', 1], ['parking', 1], ['diner', 1], ['apartments', 1], ['strip_mall', 1]],
    mid: [['shops_row', 2], ['food_trucks', 1], ['diner', 1]], small: SMALL_DEFAULT,
    hMin: 10, hMax: 18, ground: B.SIDEWALK, house: 'ranch', church: 'white', shops: 'colour', palms: true,
  },
  coral_sands: {
    walls: [B.STUCCO_CREAM, B.STUCCO_OCHRE, B.STUCCO_WHITE, B.STUCCO_PEACH], trims: [B.STUCCO_WHITE], roofs: [B.ROOF_TILE], accents: [B.AWNING_BLUE, B.AWNING_GREEN],
    big: [['villas', 5], ['golf', 3], ['condo', 1], ['church', 0.6], ['courts', 0.8], ['strip_mall', 0.6], ['gas_station', 0.5], ['plaza', 0.5]],
    mid: [['villas', 2], ['golf', 2], ['courts', 1]], small: [['golf', 2], ['courts', 1], ['plaza', 1], ['park', 1]],
    hMin: 14, hMax: 26, ground: B.GRASS, house: 'stucco', church: 'mission', shops: 'deco', palms: true,
  },
  palm_haven: {
    walls: [B.STUCCO_CREAM, B.STUCCO_WHITE, B.STUCCO_OCHRE, B.STUCCO_PINK], trims: [B.STUCCO_WHITE], roofs: [B.ROOF_TILE], accents: [B.AWNING_BLUE, B.AWNING_YELLOW],
    big: [['villas', 5], ['golf', 3], ['condo', 1], ['church', 0.6], ['courts', 0.8], ['strip_mall', 0.6], ['plaza', 0.5]],
    mid: [['villas', 2], ['golf', 2], ['courts', 1]], small: [['golf', 2], ['courts', 1], ['plaza', 1], ['park', 1]],
    hMin: 14, hMax: 26, ground: B.GRASS, house: 'stucco', church: 'mission', shops: 'deco', palms: true,
  },
  cape_halcyon: {
    walls: [B.PANEL_WHITE, B.PANEL_GREY, B.METAL], trims: [B.AWNING_BLUE, B.STRIPE], roofs: [B.METAL], accents: [B.NEON_CYAN],
    big: [['hangar', 3], ['radar', 2], ['parking', 1]], mid: [['radar', 2], ['hangar', 1]], small: [['radar', 1], ['parking', 1]],
    hMin: 10, hMax: 16, ground: B.CONCRETE, house: 'modern', church: 'white', shops: 'colour', palms: false,
  },
  conch_harbor: {
    walls: SIDINGS, trims: [B.SIDING_WHITE], roofs: [B.TIN_ROOF], accents: [B.AWNING_RED, B.AWNING_YELLOW, B.AWNING_GREEN],
    big: [['conch_houses', 6], ['plaza', 1], ['diner', 0.6], ['church', 0.5], ['food_trucks', 0.6], ['motel', 0.5]],
    mid: [['conch_houses', 4], ['food_trucks', 1]], small: [['conch_houses', 3], ['food_trucks', 1], ['plaza', 1]],
    hMin: 8, hMax: 12, ground: B.GRASS, house: 'cracker', church: 'white', shops: 'colour', palms: true,
  },
  sawgrass: { walls: [B.DARK_PLANK], trims: [B.PLANK], roofs: [B.TIN_ROOF], accents: [B.AWNING_GREEN], big: [['houses', 1]], mid: [['park', 1]], small: SMALL_DEFAULT, hMin: 8, hMax: 10, ground: B.GRASS, house: 'cracker', church: 'white', shops: 'colour', palms: false },
  timberline: { walls: [B.LOG_WALL], trims: [B.DARK_PLANK], roofs: [B.CEDAR_SHINGLE], accents: [B.AWNING_RED], big: [['houses', 1]], mid: [['park', 1]], small: SMALL_DEFAULT, hMin: 8, hMax: 10, ground: B.GRASS, house: 'cracker', church: 'white', shops: 'colour', palms: false },
  farmland: { walls: [B.SIDING_WHITE], trims: [B.SIDING_WHITE], roofs: [B.TIN_ROOF], accents: [B.AWNING_RED], big: [['houses', 1]], mid: [['park', 1]], small: SMALL_DEFAULT, hMin: 8, hMax: 10, ground: B.GRASS, house: 'cracker', church: 'white', shops: 'colour', palms: false },
  airport: { walls: [B.PANEL_WHITE], trims: [B.AWNING_BLUE], roofs: [B.METAL], accents: [B.NEON_CYAN], big: [['hangar', 1]], mid: [['hangar', 1]], small: SMALL_DEFAULT, hMin: 10, hMax: 14, ground: B.CONCRETE, house: 'modern', church: 'white', shops: 'colour', palms: false },
  keys: { walls: SIDINGS, trims: [B.SIDING_WHITE], roofs: [B.TIN_ROOF], accents: [B.AWNING_YELLOW], big: [['conch_houses', 1]], mid: [['conch_houses', 1]], small: SMALL_DEFAULT, hMin: 8, hMax: 10, ground: B.GRASS, house: 'cracker', church: 'white', shops: 'colour', palms: true },
  starfall: { walls: [B.CASTLE_STONE], trims: [B.GOLD_TRIM], roofs: [B.CASTLE_ROOF], accents: NEONS, big: [['plaza', 1]], mid: [['plaza', 1]], small: [['plaza', 1]], hMin: 8, hMax: 10, ground: B.COBBLE, house: 'stucco', church: 'white', shops: 'colour', palms: true },
  smalltown: {
    walls: [B.SIDING_WHITE, B.SIDING_LEMON, B.BRICK, B.SIDING_SKY, B.STUCCO_CREAM, B.SIDING_MINT, B.BRICK_TAN], trims: [B.SIDING_WHITE], roofs: [B.TIN_ROOF, B.SHINGLE_GREY, B.SHINGLE_BROWN], accents: AWNINGS,
    big: [['houses', 4], ['shops_row', 2], ['gas_station', 1.2], ['diner', 1], ['motel', 1], ['church', 1], ['school', 0.6], ['courts', 0.5], ['park', 0.6], ['strip_mall', 0.6]],
    mid: [['houses', 2], ['gas_station', 1], ['diner', 1], ['shops_row', 1]], small: SMALL_DEFAULT,
    hMin: 8, hMax: 14, ground: B.GRASS, house: 'cracker', church: 'white', shops: 'colour', palms: true,
  },
};

// sign texts (all original)
const HOTEL_NAMES = ['AZURE', 'CORAL', 'TIDES', 'MARLIN', 'BREEZE', 'PALMS', 'SANDS', 'SURF', 'LAGUNA', 'ORCHID', 'NEPTUNE', 'SOLANA', 'BEACON', 'MIRAGE'];
const SHOP_NAMES = ['TACOS', 'NAILS', 'DONUTS', 'VIDEO', 'PAWN', 'DELI', 'SUSHI', 'PIZZA', 'PHARMACY', 'LAUNDRY', 'BAIT', 'SURF', 'CAFE', 'BOOKS', 'GYM', 'TOYS', 'BAKERY', 'RECORDS', 'CUBANO', 'TATTOO', 'BIKES', 'FLOWERS', 'HARDWARE', 'OPTICS'];
const GAS_BRANDS: [string, number, number][] = [['GATOR GAS', B.AWNING_GREEN, B.NEON_GREEN], ['SUNPUMP', B.AWNING_YELLOW, B.NEON_ORANGE], ['BLUEWAVE', B.AWNING_BLUE, B.NEON_CYAN], ['FLAMINGO', B.STUCCO_PINK, B.NEON_PINK]];
export const BILLBOARDS: [string, number][] = [['SUNFIZZ', B.NEON_ORANGE], ['PELICAN PIZZA', B.AWNING_RED], ['TROPIQ MOBILE', B.STUCCO_SKY], ['GATOR GAS', B.AWNING_GREEN], ['MANGO FM', B.AWNING_YELLOW], ['SHORELINE BANK', B.AWNING_BLUE], ['CONCH BURGER', B.STUCCO_PINK], ['KEY LIME PIE', B.NEON_GREEN]];

export function pickMix(mix: Mix, u: number): LotKind {
  let tot = 0;
  for (const m of mix) tot += m[1];
  let a = u * tot;
  for (const m of mix) { a -= m[1]; if (a < 0) return m[0]; }
  return mix[mix.length - 1][0];
}
export const pickArr = <T,>(arr: readonly T[], u: number): T => arr[Math.min(arr.length - 1, Math.floor(u * arr.length))];

/** Fill in style fields of a plan (kind already chosen). */
export function styleLot(p: LotPlan, st: RegionStyle) {
  const r = p.rv;
  p.wall = pickArr(st.walls, r[2]);
  p.trim = pickArr(st.trims, r[3]);
  p.roof = pickArr(st.roofs, r[4]);
  p.accent = pickArr(st.accents, r[5]);
  p.h = st.hMin + Math.floor(r[6] * ((st.hMax - st.hMin) / 4 + 1)) * 4;
  p.h2 = 8 + Math.floor(r[7] * 5) * 4;
  p.inset = Math.floor(r[8] * 3);
  switch (p.kind) {
    case 'deco_hotel': p.name = pickArr(HOTEL_NAMES, r[9]); break;
    case 'gas_station': p.name = pickArr(GAS_BRANDS, r[9])[0]; break;
    case 'billboard': p.name = pickArr(BILLBOARDS, r[9])[0]; break;
    case 'diner': p.name = 'DINER'; break;
    case 'motel': p.name = 'MOTEL'; break;
    default: p.name = pickArr(SHOP_NAMES, r[9]);
  }
}

// ───────────────────────────────────────────────────────────── column helpers
const G = 22; // first block above ground

function fill(put: Put, y0: number, y1: number, id: number) { for (let y = y0; y <= y1; y++) put(y, id); }
const inR = (bx: number, bz: number, x0: number, z0: number, x1: number, z1: number) => bx >= x0 && bx <= x1 && bz >= z0 && bz <= z1;

interface ShellOpts { wall: number; win?: number; every?: number; fh?: number; trim?: number; roof?: number; ground?: number; band?: number; corner?: number; door?: boolean }
/** Solid building volume with a window pattern on its perimeter, y0 = first layer, h layers. */
function shell(put: Put, bx: number, bz: number, x0: number, z0: number, x1: number, z1: number, y0: number, h: number, s: ShellOpts): boolean {
  if (bx < x0 || bx > x1 || bz < z0 || bz > z1 || h <= 0) return false;
  const ex = bx === x0 || bx === x1, ez = bz === z0 || bz === z1;
  const edge = ex || ez, corner = ex && ez;
  const along = ex ? bz - z0 : bx - x0;
  const fh = s.fh ?? 4, every = s.every ?? 3;
  const mid = (x0 + x1) >> 1;
  for (let k = 0; k < h; k++) {
    let id = s.wall;
    if (k === h - 1) id = edge ? (s.trim ?? s.wall) : (s.roof ?? B.CONCRETE);
    else if (corner) { if (s.corner !== undefined) id = s.corner; }
    else if (edge) {
      const row = k % fh;
      if (row === 0) { if (k > 0 && s.band !== undefined) id = s.band; }
      else if (s.win !== undefined && along % every !== 0) id = s.win;
      if (k < fh && row !== 0 && s.ground !== undefined) id = s.ground;
      if (s.door && bz === z0 && k > 0 && k < 3 && (bx === mid || bx === mid + 1)) id = B.GLASS;
    }
    put(y0 + k, id);
  }
  return true;
}
/** Gable roof over a rect, ridge along x (axisX) or z. Fills gable ends with `gable`. */
function gable(put: Put, bx: number, bz: number, x0: number, z0: number, x1: number, z1: number, yb: number, axisX: boolean, roof: number, gableId: number, cap = 8): boolean {
  if (bx < x0 || bx > x1 || bz < z0 || bz > z1) return false;
  const d = Math.min(cap, axisX ? Math.min(bz - z0, z1 - bz) : Math.min(bx - x0, x1 - bx));
  const end = axisX ? (bx === x0 || bx === x1) : (bz === z0 || bz === z1);
  if (end) fill(put, yb, yb + d - 1, gableId);
  put(yb + d, roof);
  return true;
}
function hip(put: Put, bx: number, bz: number, x0: number, z0: number, x1: number, z1: number, yb: number, roof: number, cap = 6): boolean {
  if (bx < x0 || bx > x1 || bz < z0 || bz > z1) return false;
  const d = Math.min(cap, bx - x0, x1 - bx, bz - z0, z1 - bz);
  fill(put, yb, yb + d, roof);
  return true;
}
/** Pyramid spire tapering from radius r0 at yb to a point at yb+h. */
function spire(put: Put, bx: number, bz: number, cx: number, cz: number, yb: number, r0: number, h: number, id: number): boolean {
  const d = Math.max(Math.abs(bx - cx), Math.abs(bz - cz));
  if (d > r0) return false;
  const top = yb + Math.floor(h * (1 - d / (r0 + 1)));
  fill(put, yb, top, id);
  return true;
}
function inCircle(bx: number, bz: number, cx: number, cz: number, r: number) { const dx = bx - cx, dz = bz - cz; return dx * dx + dz * dz <= r * r + r * 0.6; }
/** letter for a north-facing sign (viewer at -z, reading east→west) centred on cx */
function signN(bx: number, cx: number, text: string): number {
  const n = text.length;
  const xs = cx + ((n - 1) >> 1);
  const i = xs - bx;
  if (i < 0 || i >= n) return -1;
  return letterBlock(text[i]);
}
/** letter for a south-facing sign (viewer at +z, reading west→east) */
function signS(bx: number, cx: number, text: string): number {
  const n = text.length;
  const i = bx - (cx - (n >> 1));
  if (i < 0 || i >= n) return -1;
  return letterBlock(text[i]);
}
function lampPost(put: Put, h = 4) { fill(put, G, G + h - 1, B.METAL); put(G + h, B.LAMP); }

// ───────────────────────────────────────────────────────────── generators
const tower: LotGen = (x, z, bx, bz, p, put) => towerCore(x, z, bx, bz, p, put, false);
const glassTower: LotGen = (x, z, bx, bz, p, put) => towerCore(x, z, bx, bz, p, put, true);

function towerCore(x: number, z: number, bx: number, bz: number, p: LotPlan, put: Put, glass: boolean) {
  const [rx0, rz0, rx1, rz1] = p.rect;
  const ins = p.inset;
  const x0 = rx0 + ins, z0 = rz0 + ins, x1 = rx1 - ins, z1 = rz1 - ins;
  put(21, glass ? B.MARBLE : B.SIDEWALK);
  if (bx < x0 || bx > x1 || bz < z0 || bz > z1) {
    // forecourt: planters + benches
    if ((bx + bz) % 9 === 0 && hash2(x, z, 5) < 0.5) put(G, B.HEDGE);
    return;
  }
  const r = p.rv;
  const h = p.h;
  const podium = 8 + Math.floor(r[10] * 2) * 4;
  const h1 = Math.max(podium + 4, Math.floor((h * (0.55 + r[11] * 0.2)) / 4) * 4);
  const s1 = 3, s2 = 3 + (r[12] < 0.6 ? 3 : 2);
  // tier the column belongs to
  const inT1 = inR(bx, bz, x0 + s1, z0 + s1, x1 - s1, z1 - s1);
  const inT2 = inR(bx, bz, x0 + s2, z0 + s2, x1 - s2, z1 - s2);
  const fins = r[13] < 0.4, bands = r[13] >= 0.4 && r[13] < 0.75;
  const mat = glass ? p.wall : p.wall;
  const crownNeon = r[14] < 0.45 ? NEONS[Math.floor(r[15] * NEONS.length)] : -1;
  const top = inT2 ? h : inT1 ? h1 : podium;
  for (let k = 0; k < top; k++) {
    const y = G + k;
    const fx0 = k < podium ? x0 : k < h1 ? x0 + s1 : x0 + s2;
    const fz0 = k < podium ? z0 : k < h1 ? z0 + s1 : z0 + s2;
    const fx1 = k < podium ? x1 : k < h1 ? x1 - s1 : x1 - s2;
    const fz1 = k < podium ? z1 : k < h1 ? z1 - s1 : z1 - s2;
    const ex = bx === fx0 || bx === fx1, ez = bz === fz0 || bz === fz1;
    const edge = ex || ez, corner = ex && ez;
    const tierTop = k === podium - 1 || k === h1 - 1 || k === h - 1;
    let id: number;
    if (!edge) id = tierTop ? (k === h - 1 ? B.CONCRETE : (r[16] < 0.55 ? B.GRASS : B.CONCRETE)) : mat;
    else if (corner && glass && !tierTop) id = k < podium ? p.trim : B.AIR; // chamfered corners
    else if (tierTop) id = p.trim;
    else {
      const along = ex ? bz - fz0 : bx - fx0;
      if (glass) {
        id = mat;
        if (fins && along % 4 === 0) id = p.trim;
        else if (bands && k % 4 === 0) id = B.CURTAIN_DARK === mat ? B.CHROME : B.CURTAIN_DARK;
        if (k < 4) id = k === 0 ? p.trim : B.GLASS;
        if (crownNeon >= 0 && k === h - 3) id = crownNeon;
      } else {
        id = k % 4 !== 0 && along % 3 !== 0 ? B.WINDOW : mat;
        if (k < 4 && k > 0) id = along % 2 ? B.GLASS : mat;
        if (crownNeon >= 0 && k === h - 3) id = crownNeon;
      }
    }
    if (id !== B.AIR) put(y, id);
  }
  // roof furniture on each tier top
  const yTop = G + top;
  const tierX0 = inT2 ? x0 + s2 : inT1 ? x0 + s1 : x0, tierX1 = inT2 ? x1 - s2 : inT1 ? x1 - s1 : x1;
  const tierZ0 = inT2 ? z0 + s2 : inT1 ? z0 + s1 : z0, tierZ1 = inT2 ? z1 - s2 : inT1 ? z1 - s1 : z1;
  const edge = bx === tierX0 || bx === tierX1 || bz === tierZ0 || bz === tierZ1;
  if (edge) { put(yTop, glass ? B.GLASS : p.trim); return; }
  if (inT2) {
    const cx = (tierX0 + tierX1) >> 1, cz = (tierZ0 + tierZ1) >> 1;
    const helipad = r[17] < 0.45;
    if (helipad) {
      if (Math.abs(bx - cx) <= 3 && Math.abs(bz - cz) <= 3) { put(yTop - 1, B.HELIPAD); if (Math.abs(bx - cx) === 3 && Math.abs(bz - cz) === 3) put(yTop, B.LIGHT_RED); }
    } else if (bx === cx && bz === cz) {
      const mh = 8 + Math.floor(r[18] * 14);
      fill(put, yTop, Math.min(126, yTop + mh), glass ? B.CHROME : B.METAL);
      put(Math.min(127, yTop + mh + 1), B.LIGHT_RED);
    } else if (Math.abs(bx - cx) <= 1 && Math.abs(bz - cz) <= 1 && r[18] < 0.5) {
      fill(put, yTop, yTop + 3, glass ? p.wall : p.trim);
    } else if (hash2(Math.floor(x / 3), Math.floor(z / 3), 77) < 0.15) put(yTop, B.AC_UNIT);
  } else if (!inT1 || (inT1 && !inT2)) {
    // terrace garden
    const hv = hash2(x, z, 79);
    if (r[16] < 0.55) { if (hv < 0.12) put(yTop, B.HEDGE); else if (hv < 0.2) put(yTop, B.FLOWERS); else if (hv < 0.23) { put(yTop, B.LEAVES); put(yTop + 1, B.LEAVES); } }
    else if (hv < 0.08) put(yTop, B.AC_UNIT); else if (hv < 0.12) put(yTop, B.SOLAR);
  }
}

const midrise: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  put(21, B.SIDEWALK);
  const split = x0 + Math.floor((x1 - x0) * (0.4 + p.rv[10] * 0.2));
  const murals = p.region === RG.ps_midtown || p.region === RG.bayhaven;
  const aw = AWNINGS[Math.floor(p.rv[11] * 4)];
  // awnings over storefronts (front face, one block out)
  if (bz === z0 - 1 && bx > x0 && bx < x1 && bx !== split && bx !== split + 2) { put(G + 3, aw); return; }
  if (shell(put, bx, bz, x0, z0, split, z1, G, p.h, { wall: p.wall, win: B.WINDOW, ground: B.GLASS, trim: p.trim, every: 3 })) {
    if (murals && bx === split && bz > z0 + 2 && bz < z1 - 2) for (let k = 5; k < p.h - 2; k++) put(G + k, p.rv[12] < 0.5 ? B.MURAL_A : B.MURAL_B);
    return;
  }
  const wall2 = pickArr(STYLES[REGION_LIST[p.region]].walls, p.rv[13]);
  if (shell(put, bx, bz, split + 2, z0, x1, z1, G, p.h2, { wall: wall2, win: B.WINDOW, ground: B.GLASS, trim: p.accent, every: 4 })) {
    if (bx === split + 2 && murals && bz > z0 + 2 && bz < z1 - 2) for (let k = 4; k < p.h2 - 2; k++) put(G + k, p.rv[12] < 0.5 ? B.MURAL_B : B.MURAL_A);
    if (bx === x1 - 2 && bz === z1 - 2) { fill(put, G + p.h2, G + p.h2 + 2, B.TRUSS); fill(put, G + p.h2 + 3, G + p.h2 + 5, B.DARK_PLANK); } // water tank
    return;
  }
  if (bx > split && bx < split + 2) put(21, B.ASPHALT); // alley
};

const apartments: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  put(21, B.GRASS);
  const depth = Math.min(12, z1 - z0 - 6);
  const az0 = z0 + 2, az1 = az0 + depth;
  // balconies on the front + back faces
  if ((bz === az0 - 1 || bz === az1 + 1) && bx > x0 + 1 && bx < x1 - 1) {
    for (let k = 4; k < p.h - 1; k += 4) { put(G + k - 1, B.CONCRETE); if ((bx - x0) % 5 !== 0) put(G + k, B.IRON_RAIL); }
    return;
  }
  if (shell(put, bx, bz, x0 + 1, az0, x1 - 1, az1, G, p.h, { wall: p.wall, win: B.WINDOW, trim: p.trim, ground: B.GLASS, every: 2, door: true })) {
    if (!(bx === x0 + 1 || bx === x1 - 1 || bz === az0 || bz === az1) && hash2(x, z, 8) < 0.1) put(G + p.h, B.AC_UNIT);
    return;
  }
  // back courtyard: parking + pool
  if (bz > az1 + 2) {
    const px0 = x0 + 3, px1 = Math.min(x1 - 3, px0 + 12), pz0 = az1 + 4, pz1 = Math.min(z1 - 1, pz0 + 6);
    if (inR(bx, bz, px0, pz0, px1, pz1)) { const rim = bx === px0 || bx === px1 || bz === pz0 || bz === pz1; put(21, rim ? B.CONCRETE : B.WATER); if (!rim) put(20, B.POOL_TILE); return; }
    put(21, (bx % 3 === 0 && bz > pz1) ? B.LINE_WHITE : B.ASPHALT);
  }
};

const decoHotel: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  put(21, B.SIDEWALK);
  const depth = Math.min(16, z1 - z0 - 4);
  const hz0 = z0 + 2, hz1 = hz0 + depth;
  const cx = (x0 + x1) >> 1;
  const h = p.h, crownH = h + 4 + Math.floor(p.rv[10] * 2) * 4;
  const fin = NEONS[Math.floor(p.rv[11] * NEONS.length)];
  // front café terrace with umbrellas
  if (bz < hz0 - 2) {
    if ((bx - x0) % 5 === 2 && bz === z0) { put(G, B.METAL); put(G + 1, B.METAL); put(G + 2, AWNINGS[(bx >> 2) & 3]); }
    return;
  }
  // neon fin: 1 wide, 2 deep, sticking out in front of the centre
  if (bx === cx && (bz === hz0 - 1 || bz === hz0 - 2)) {
    const sign = p.name;
    for (let k = 3; k < crownH + 4; k++) {
      const fromTop = crownH + 3 - k;
      let id = fin;
      if (bz === hz0 - 2 && fromTop >= 1 && fromTop <= sign.length) id = letterBlock(sign[fromTop - 1]);
      put(G + k, id);
    }
    return;
  }
  // eyebrows: white ledges over every window row on the front face
  if (bz === hz0 - 1 && bx > x0 && bx < x1) { for (let k = 3; k < h - 1; k += 4) put(G + k, B.STUCCO_WHITE); if (bx > cx - 3 && bx < cx + 3) put(G + 3, B.AWNING_BLUE); return; }
  // stepped crown over the centre
  if (Math.abs(bx - cx) <= 4 && bz >= hz0 && bz <= hz0 + 6) {
    const step = Math.abs(bx - cx) <= 2 ? crownH : h + 2;
    shell(put, bx, bz, cx - 4, hz0, cx + 4, hz0 + 6, G, step, { wall: p.wall, win: B.WINDOW, trim: B.STUCCO_WHITE, ground: B.GLASS, every: 2, band: B.STUCCO_WHITE });
    if (bx === cx && bz === hz0 + 3) put(G + step, B.LIGHT_RED);
    return;
  }
  // main block with rounded (chamfered) corners and ribbon windows
  if (inR(bx, bz, x0, hz0, x1, hz1)) {
    const cornerCut = (bx === x0 || bx === x1) && (bz === hz0 || bz === hz1);
    if (cornerCut) { put(21, B.SIDEWALK); return; }
    shell(put, bx, bz, x0, hz0, x1, hz1, G, h, { wall: p.wall, win: B.WINDOW, trim: B.STUCCO_WHITE, ground: B.GLASS, every: 4, band: (p.rv[12] < 0.5 ? B.STUCCO_WHITE : undefined) });
    if (bx === x0 + 1 || bx === x1 - 1) if (bz > hz0 && bz < hz1) put(G + h, p.wall); // parapet ends
    return;
  }
  // back: pool deck facing the sea
  if (bz > hz1 + 1) {
    const px0 = x0 + 3, px1 = x1 - 3, pz0 = hz1 + 3, pz1 = Math.min(z1, pz0 + 7);
    if (inR(bx, bz, px0, pz0, px1, pz1)) { const rim = bx === px0 || bx === px1 || bz === pz0 || bz === pz1; put(21, rim ? B.STUCCO_WHITE : B.WATER); if (!rim) put(20, B.POOL_TILE); return; }
    put(21, B.TILE_FLOOR);
    if (bz === pz1 + 1 && bx % 3 === 0) put(G, B.STUCCO_WHITE); // loungers
  }
};

const beachClub: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  put(21, B.SAND);
  const mx1 = Math.min(x1, x0 + 14);
  // pavilion
  if (shell(put, bx, bz, x0, z0, mx1, z0 + 7, G, 5, { wall: p.wall, win: B.GLASS, trim: B.STUCCO_WHITE, every: 2, door: true })) {
    if (bz === z0 && bx === ((x0 + mx1) >> 1) - 2) put(G + 5, B.NEON_CYAN);
    return;
  }
  if (inR(bx, bz, x0, z0 - 1, mx1, z0 - 1)) { put(G + 3, p.accent >= B.AWNING_RED && p.accent <= B.AWNING_YELLOW ? p.accent : B.AWNING_RED); return; }
  // pool
  const pz0 = z0 + 10, pz1 = Math.min(z1 - 2, pz0 + 6), px1 = Math.min(x1 - 1, x0 + 16);
  if (inR(bx, bz, x0 + 1, pz0, px1, pz1)) { const rim = bx === x0 + 1 || bx === px1 || bz === pz0 || bz === pz1; put(21, rim ? B.TILE_FLOOR : B.WATER); if (!rim) put(20, B.POOL_TILE); return; }
  // cabanas: rows of striped canopies on posts
  if (bx > px1 + 1 && bz > z0 + 1) {
    const cx = (bx - px1 - 2) % 5, cz = (bz - z0 - 2) % 6;
    if (cx < 3 && cz < 3) {
      const corner = (cx === 0 || cx === 2) && (cz === 0 || cz === 2);
      if (corner) fill(put, G, G + 1, B.DARK_PLANK);
      put(G + 2, AWNINGS[((bx >> 2) + (bz >> 2)) & 3]);
      if (cx === 1 && cz === 1) put(G, B.STUCCO_WHITE);
    }
    return;
  }
  // loungers + umbrellas between
  if (bz > pz1 + 1 && bx % 4 === 1) { put(G, B.STUCCO_WHITE); if (bz % 4 === 0) { put(G + 1, B.METAL); put(G + 2, AWNINGS[(bx + bz) & 3]); } }
};

const condo: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  put(21, B.GRASS);
  const w = Math.min(x1 - x0 - 4, 22), d = Math.min(z1 - z0 - 6, 12);
  const cx0 = x0 + ((x1 - x0 - w) >> 1), cz0 = z0 + 3;
  const h = p.h + 8;
  // continuous glass-rail balconies on the long faces
  if ((bz === cz0 - 1 || bz === cz0 + d + 1) && bx >= cx0 && bx <= cx0 + w) {
    for (let k = 3; k < h - 1; k += 3) { put(G + k, B.STUCCO_WHITE); put(G + k + 1, B.GLASS); }
    return;
  }
  if (shell(put, bx, bz, cx0, cz0, cx0 + w, cz0 + d, G, h, { wall: B.STUCCO_WHITE, win: p.region === RG.solano_beach ? B.CURTAIN_TEAL : B.CURTAIN_BLUE, trim: B.STUCCO_WHITE, every: 4, fh: 3, door: true })) {
    // rooftop pool
    if (inR(bx, bz, cx0 + 2, cz0 + 2, cx0 + w - 2, cz0 + d - 2)) { const rim = bx === cx0 + 2 || bx === cx0 + w - 2 || bz === cz0 + 2 || bz === cz0 + d - 2; if (!rim) { put(G + h - 1, B.WATER); put(G + h - 2, B.POOL_TILE); } }
    return;
  }
  if (bz > cz0 + d + 3 && hash2(x, z, 31) < 0.05) put(G, B.HEDGE);
};

// ─── houses
interface HouseStyle { wall: number; roof: number; trim: number; kind: number; pool: boolean; garage: boolean; fence: number; porch: boolean; storeys: number }
function houseStyle(p: LotPlan, hx: number, hz: number): HouseStyle {
  const h = (k: number) => hash2(hx * 3 + k, hz * 5 - k, p.seed & 4095);
  const st = STYLES[REGION_LIST[p.region]];
  let wall: number, roof: number;
  switch (st.house) {
    case 'bungalow': wall = pickArr(SIDINGS, h(1)); roof = pickArr([B.SHINGLE_GREY, B.SHINGLE_BROWN, B.SHINGLE_GREEN], h(2)); break;
    case 'ranch': wall = pickArr([B.BRICK, B.SIDING_WHITE, B.SIDING_SKY, B.STUCCO_CREAM, B.BRICK_TAN, B.SIDING_LEMON, B.STUCCO_WHITE], h(1)); roof = pickArr([B.SHINGLE_GREY, B.SHINGLE_BROWN, B.SHINGLE_GREEN, B.SLATE_ROOF], h(2)); break;
    case 'cracker': wall = pickArr(SIDINGS, h(1)); roof = h(2) < 0.75 ? B.TIN_ROOF : B.SHINGLE_GREY; break;
    case 'modern': wall = pickArr([B.STUCCO_WHITE, B.CONCRETE], h(1)); roof = B.CONCRETE; break;
    default: wall = pickArr(PASTEL, h(1)); roof = h(2) < 0.75 ? B.ROOF_TILE : B.SHINGLE_GREY;
  }
  const fences = [B.HEDGE, B.PICKET, B.CHAINLINK, B.AIR, B.HEDGE];
  return {
    wall, roof, trim: st.house === 'bungalow' || st.house === 'cracker' ? B.SIDING_WHITE : B.STUCCO_WHITE,
    kind: Math.floor(h(3) * 4), pool: h(4) < (st.house === 'stucco' ? 0.45 : 0.2), garage: h(5) < 0.5,
    fence: st.house === 'cracker' ? (h(6) < 0.6 ? B.PICKET : B.AIR) : pickArr(fences, h(6)), porch: st.house === 'bungalow' || st.house === 'cracker' || h(7) < 0.3,
    storeys: h(8) < (st.house === 'cracker' ? 0.45 : 0.2) ? 2 : 1,
  };
}
/** One house on a plot [0..pw]x[0..pd] (local u,v), front at v = 0. */
function house(put: Put, u: number, v: number, pw: number, pd: number, s: HouseStyle, x: number, z: number) {
  put(21, B.GRASS);
  const fx0 = 2, fx1 = pw - 2, fz0 = 3, fz1 = Math.min(pd - 4, fz0 + 8);
  // fence / hedge on the plot border
  if (u === 0 || v === 0) {
    if (s.fence !== B.AIR && !(v === 0 && u >= (pw >> 1) - 1 && u <= (pw >> 1) + 1) && !(s.garage && v === 0 && u >= fx1 - 3 && u <= fx1)) put(G, s.fence);
    return;
  }
  // garage + driveway
  const gx0 = fx1 - 3;
  if (s.garage && u >= gx0 && u <= fx1 && v < fz0) { put(21, B.CONCRETE); return; }
  if (u >= (pw >> 1) - 1 && u <= (pw >> 1) && v < fz0 - 1) { put(21, B.SIDEWALK); return; }
  const h = s.storeys === 2 ? 8 : 4;
  // porch
  if (s.porch && v === fz0 - 1 && u > fx0 && u < (s.garage ? gx0 - 1 : fx1)) {
    put(21, B.DOCK);
    if ((u - fx0) % 3 === 0) fill(put, G, G + 2, s.trim);
    put(G + 3, s.roof);
    return;
  }
  if (inR(u, v, fx0, fz0, fx1, fz1)) {
    put(21, B.PLANK);
    const edge = u === fx0 || u === fx1 || v === fz0 || v === fz1;
    for (let k = 0; k < h; k++) {
      let id = s.wall;
      if (edge && (k % 4 === 1 || k % 4 === 2)) {
        const along = (u === fx0 || u === fx1) ? v : u;
        if (along % 3 === 1) id = B.WINDOW;
      }
      if (k % 4 === 3 && edge) id = s.trim;
      if (v === fz0 && u === (pw >> 1) && k < 2) id = B.DARK_PLANK; // door
      if (s.garage && v === fz0 && u > gx0 && u < fx1 && k < 3) id = B.SHUTTER;
      put(G + k, id);
    }
    if (s.roof === B.CONCRETE) { put(G + h, (u === fx0 || u === fx1 || v === fz0 || v === fz1) ? s.trim : B.CONCRETE); if (u === fx1 - 2 && v === fz1 - 2) put(G + h + 1, B.SOLAR); return; }
  }
  if (s.roof !== B.CONCRETE) {
    const yb = G + h;
    if (s.kind === 0 || s.kind === 3) gable(put, u, v, fx0 - 1, fz0 - 1, fx1 + 1, fz1 + 1, yb, true, s.roof, s.wall, 5);
    else if (s.kind === 1) gable(put, u, v, fx0 - 1, fz0 - 1, fx1 + 1, fz1 + 1, yb, false, s.roof, s.wall, 5);
    else hip(put, u, v, fx0 - 1, fz0 - 1, fx1 + 1, fz1 + 1, yb, s.roof, 4);
    if (s.kind === 3 && u === fx0 + 2 && v === fz1 - 2) fill(put, yb, yb + 6, B.BRICK); // chimney
  }
  // pool / yard
  if (v > fz1 + 1) {
    if (s.pool && u >= 3 && u <= pw - 3 && v >= fz1 + 2 && v <= pd - 1) {
      const rim = u === 3 || u === pw - 3 || v === fz1 + 2 || v === pd - 1;
      put(21, rim ? B.TILE_FLOOR : B.WATER); if (!rim) put(20, B.POOL_TILE);
    } else if (hash2(x, z, 61) < 0.03) put(G, B.FLOWERS);
    else if (hash2(x, z, 62) < 0.012) { put(G, B.STUCCO_WHITE); }
  }
}
const houses: LotGen = (x, z, bx, bz, p, put) => {
  // four plots of 17x17
  const qx = bx < 17 ? 0 : 1, qz = bz < 17 ? 0 : 1;
  const [rx0, rz0, rx1, rz1] = p.rect;
  if (qx * 17 < rx0 || qx * 17 + 16 > rx1 || qz * 17 < rz0 || qz * 17 + 16 > rz1) { put(21, B.GRASS); if (hash2(x, z, 18) < 0.04) put(G, B.HEDGE); return; }
  const u = bx - qx * 17, v0 = bz - qz * 17;
  // back plots face south (mirror v) so every house fronts a street
  const v = qz === 1 ? 16 - v0 : v0;
  const s = houseStyle(p, Math.floor(x / 17), Math.floor(z / 17));
  house(put, u, v, 16, 16, s, x, z);
};
const culDeSac: LotGen = (x, z, bx, bz, p, put) => {
  put(21, B.GRASS);
  const cx = 16.5, cz = 19;
  const dx = bx - cx, dz = bz - cz, r2 = dx * dx + dz * dz;
  if (r2 <= 36) { put(21, r2 <= 4 ? B.GRASS : B.ASPHALT); if (r2 <= 1.5) { put(G, B.LEAVES); put(G + 1, B.LEAVES); } return; }
  if (bx >= 15 && bx <= 18 && bz < 14) { put(21, B.ASPHALT); return; }
  if (r2 <= 49) { put(21, B.SIDEWALK); return; }
  // six plots around the ring
  const plots: [number, number, number, number][] = [[0, 0, 13, 12], [20, 0, 33, 12], [0, 14, 10, 26], [23, 14, 33, 26], [0, 27, 15, 33], [18, 27, 33, 33]];
  for (let i = 0; i < plots.length; i++) {
    const [a, b, c, d] = plots[i];
    if (!inR(bx, bz, a, b, c, d)) continue;
    const s = houseStyle(p, i * 31 + (p.seed & 63), 7);
    // front faces the ring: map to local coords with v = distance from the ring side
    let u: number, v: number, pw: number, pd: number;
    if (i < 2) { u = bx - a; pw = c - a; v = d - bz; pd = d - b; }
    else if (i === 2) { u = bz - b; pw = d - b; v = c - bx; pd = c - a; }
    else if (i === 3) { u = bz - b; pw = d - b; v = bx - a; pd = c - a; }
    else { u = bx - a; pw = c - a; v = bz - b; pd = d - b; }
    house(put, u, v, pw, pd, { ...s, fence: B.AIR }, x, z);
    return;
  }
};

const villas: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  put(21, B.GRASS);
  // garden wall with gate
  if ((bx === x0 || bx === x1 || bz === z0 || bz === z1)) {
    if (!(bz === z0 && Math.abs(bx - ((x0 + x1) >> 1)) <= 1)) { put(G, p.wall); if ((bx + bz) % 4 === 0) put(G + 1, B.ROOF_TILE); }
    return;
  }
  const vx0 = x0 + 3, vx1 = x1 - 3, vz0 = z0 + 5, vz1 = Math.min(z1 - 3, z0 + 22);
  const cx = (x0 + x1) >> 1;
  // driveway
  if (Math.abs(bx - cx) <= 1 && bz < vz0) { put(21, B.COBBLE); return; }
  // U-shaped villa around a pool courtyard (open to the south)
  const wing = 6;
  const inMain = inR(bx, bz, vx0, vz0, vx1, vz0 + 6);
  const inWing = inR(bx, bz, vx0, vz0, vx0 + wing, vz1) || inR(bx, bz, vx1 - wing, vz0, vx1, vz1);
  if (inMain || inWing) {
    const tall = inMain && Math.abs(bx - cx) <= 4;
    const h = tall ? 9 : 5;
    const fx0 = inMain ? vx0 : (bx <= vx0 + wing ? vx0 : vx1 - wing), fx1 = inMain ? vx1 : (bx <= vx0 + wing ? vx0 + wing : vx1);
    const fz0 = vz0, fz1 = inMain ? vz0 + 6 : vz1;
    const edge = bx === fx0 || bx === fx1 || bz === fz0 || bz === fz1;
    for (let k = 0; k < h; k++) {
      let id = p.wall;
      if (edge) {
        const along = (bx === fx0 || bx === fx1) ? bz : bx;
        if ((k === 1 || k === 2 || k === 5 || k === 6) && along % 3 === 1) id = k < 3 ? B.GLASS : B.WINDOW;
        if (k === 3 && along % 3 === 1 && !inMain) id = B.STUCCO_WHITE; // arch head
      }
      put(G + k, id);
    }
    hip(put, bx, bz, tall ? cx - 4 : fx0 - 0, fz0, tall ? cx + 4 : fx1, fz1, G + h, B.ROOF_TILE, tall ? 4 : 3);
    return;
  }
  // courtyard pool
  if (inR(bx, bz, vx0 + wing + 2, vz0 + 9, vx1 - wing - 2, vz1 - 1)) {
    const rim = bx === vx0 + wing + 2 || bx === vx1 - wing - 2 || bz === vz0 + 9 || bz === vz1 - 1;
    put(21, rim ? B.TILE_FLOOR : B.WATER); if (!rim) put(20, B.POOL_TILE);
    return;
  }
  if (inR(bx, bz, vx0 + wing + 1, vz0 + 7, vx1 - wing - 1, vz1)) { put(21, B.TILE_FLOOR); return; }
  if (hash2(x, z, 23) < 0.04) put(G, B.HEDGE); else if (hash2(x, z, 24) < 0.04) put(G, B.FLOWERS);
};

const golf: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  const flip = p.rv[10] < 0.5;
  const t = (flip ? bz - z0 : z1 - bz) / Math.max(1, z1 - z0); // 0 = tee end, 1 = green end
  const wx = x0 + (x1 - x0) * (0.3 + 0.4 * (p.rv[11] + (p.rv[12] - p.rv[11]) * t));
  const dfw = Math.abs(bx - wx);
  let id: number = B.GRASS;
  if (dfw < 6) id = B.FAIRWAY;
  const gz = flip ? z1 - 5 : z0 + 5, gx = x0 + (x1 - x0) * (0.3 + 0.4 * p.rv[12]);
  const dg = Math.hypot(bx - gx, bz - gz);
  if (dg < 4.5) id = B.PUTTING;
  // bunkers
  const b1 = Math.hypot(bx - gx - 5, bz - gz + (flip ? -3 : 3)), b2 = Math.hypot(bx - wx + 6, bz - (z0 + z1) / 2);
  if ((b1 < 2.6 && dg >= 4.5) || b2 < 2.2 + p.rv[13]) id = B.SAND;
  // tee box
  const tz = flip ? z0 + 2 : z1 - 2, tx = x0 + (x1 - x0) * (0.3 + 0.4 * p.rv[11]);
  if (Math.abs(bx - tx) <= 2 && Math.abs(bz - tz) <= 1) id = B.PUTTING;
  // pond on some holes
  if (p.rv[14] < 0.4 && Math.hypot(bx - (x0 + 4), bz - (z0 + z1) / 2) < 4 + p.rv[15] * 2 && id === B.GRASS) { put(21, B.WATER); put(20, B.SAND); return; }
  // cart path along the edge
  if (bx === x1 - 1) id = B.PATH;
  put(21, id);
  if (Math.round(bx) === Math.round(gx) && Math.round(bz) === Math.round(gz)) { fill(put, G, G + 2, B.METAL); put(G + 3, B.FLAG); }
  if (id === B.GRASS && hash2(x, z, 41) < 0.02) put(G, B.TALL_GRASS);
};

const conchHouses: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  put(21, B.GRASS);
  const pw = 11;
  const n = Math.max(1, Math.floor((x1 - x0 + 1) / pw));
  const i = Math.floor((bx - x0) / pw);
  if (i >= n || bx < x0) return;
  const back = bz > (z0 + z1) >> 1;
  const u = bx - x0 - i * pw;
  const v = back ? z1 - bz : bz - z0;
  const pd = ((z1 - z0) >> 1);
  const hh = (k: number) => hash2(Math.floor(x / pw) * 7 + k + (back ? 3 : 0), Math.floor(z / 48), 97);
  const wall = pickArr(SIDINGS, hh(1));
  const roof = hh(2) < 0.8 ? B.TIN_ROOF : B.SHINGLE_GREY;
  // picket fence along the street
  if (v === 0) { if (!(u === 5)) put(G, hh(5) < 0.7 ? B.PICKET : B.HEDGE); return; }
  if (u === 0) return;
  const fx0 = 2, fx1 = 9, fz0 = 4, fz1 = Math.min(pd - 1, 11);
  const two = hh(3) < 0.5;
  const h = two ? 8 : 4;
  // wraparound porch (two levels on two-storey houses)
  if (inR(u, v, fx0 - 1, fz0 - 2, fx1 + 1, fz1) && !inR(u, v, fx0, fz0, fx1, fz1)) {
    put(21, B.DOCK);
    const post = (u === fx0 - 1 || u === fx1 + 1) && (v - fz0) % 3 === 0 || v === fz0 - 2 && (u - fx0) % 3 === 0;
    if (post) fill(put, G, G + h - 1, B.SIDING_WHITE);
    else if (v === fz0 - 2 || u === fx0 - 1 || u === fx1 + 1) { put(G, B.PICKET); if (two) put(G + 4, B.PICKET); }
    if (two) put(G + 3, B.DOCK);
    put(G + h, roof);
    return;
  }
  if (inR(u, v, fx0, fz0, fx1, fz1)) {
    const edge = u === fx0 || u === fx1 || v === fz0 || v === fz1;
    for (let k = 0; k < h; k++) {
      let id = wall;
      if (edge && (k % 4 === 1 || k % 4 === 2) && ((u === fx0 || u === fx1 ? v : u) % 3 === 1)) id = B.WINDOW;
      if (edge && k % 4 === 1 && ((u === fx0 || u === fx1 ? v : u) % 3 === 2)) id = B.SIDING_WHITE; // shutters
      if (v === fz0 && u === 5 && k < 2) id = B.DARK_PLANK;
      put(G + k, id);
    }
  }
  gable(put, u, v, fx0 - 1, fz0, fx1 + 1, fz1, G + h, false, roof, wall, 5);
  if (v > fz1 + 1 && hash2(x, z, 37) < 0.05) put(G, B.FLOWERS);
};

/** Row of attached shop buildings with storefronts, awnings and signs. */
const shopsRow: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  const st = STYLES[REGION_LIST[p.region]];
  put(21, B.SIDEWALK);
  const depth = Math.min(16, z1 - z0 - 2);
  const sz0 = z0 + 1, sz1 = sz0 + depth;
  // unit index along x
  const uw = 8 + Math.floor(p.rv[10] * 4);
  const ui = Math.floor((bx - x0) / uw);
  const ux0 = x0 + ui * uw, ux1 = Math.min(x1, ux0 + uw - 1);
  const uh = (k: number) => hash2(ui * 13 + k, p.seed & 8191, 515);
  const wall = pickArr(st.walls, uh(1));
  const floors = 2 + Math.floor(uh(2) * (p.region === RG.bayhaven || p.region === RG.cedar_bluff ? 3 : 2));
  const h = floors * 4 + 1;
  const aw = AWNINGS[Math.floor(uh(3) * 4)];
  const arches = st.shops === 'brick' || st.shops === 'stone';
  const text = pickArr(SHOP_NAMES, uh(4));
  const cx = (ux0 + ux1) >> 1;
  if (bz === sz0 - 1) {
    // awning + hanging sign letters
    if (bx > ux0 && bx < ux1) {
      put(G + 3, aw);
      const l = signN(bx, cx, text.length <= ux1 - ux0 - 1 ? text : text.slice(0, ux1 - ux0 - 1));
      if (l >= 0) put(G + 4, l);
    }
    if (st.shops === 'brick' && uh(5) < 0.5 && bx > ux0 && bx < ux1) for (let k = 7; k < h - 1; k += 4) put(G + k, B.IRON_RAIL); // iron balconies
    return;
  }
  if (inR(bx, bz, x0, sz0, x1, sz1)) {
    const edgeX = bx === ux0 || bx === ux1;
    const ez = bz === sz0 || bz === sz1;
    for (let k = 0; k < h; k++) {
      let id = wall;
      if (ez && !edgeX) {
        const row = k % 4;
        if (k < 4) id = row === 0 ? wall : (bx === cx && row < 3 ? B.GLASS : B.GLASS);
        else if (row === 1 || row === 2) id = (bx - ux0) % 2 === 1 ? (arches && row === 2 ? B.ARCH_WINDOW : B.WINDOW) : wall;
        if (k === 4 && bz === sz0) id = p.trim;
      }
      if (k === h - 1) id = (ez || edgeX) ? p.trim : (st.shops === 'stone' ? B.SLATE_ROOF : B.CONCRETE);
      put(G + k, id);
    }
    // cornice + parapet
    if (ez || edgeX) put(G + h, p.trim);
    else if (hash2(x, z, 88) < 0.05) put(G + h, B.AC_UNIT);
    if (st.shops === 'stone' && uh(6) < 0.4 && !ez && !edgeX) hip(put, bx, bz, ux0 + 1, sz0 + 1, ux1 - 1, sz1 - 1, G + h, B.SLATE_ROOF, 3);
    return;
  }
  // back: courtyard / parking
  if (bz > sz1 + 1) put(21, (bz > sz1 + 3 && bx % 3 === 0) ? B.LINE_WHITE : B.ASPHALT);
};

const cigarFactory: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  put(21, B.SIDEWALK);
  const fz0 = z0 + 2, fz1 = Math.min(z1 - 2, fz0 + 16);
  const h = 17;
  const cx = (x0 + x1) >> 1;
  // central entrance tower
  if (Math.abs(bx - cx) <= 3 && bz >= fz0 - 1 && bz <= fz0 + 5) {
    shell(put, bx, bz, cx - 3, fz0 - 1, cx + 3, fz0 + 5, G, h + 7, { wall: B.BRICK, win: B.ARCH_WINDOW, trim: B.LIMESTONE, every: 2, door: true, band: B.LIMESTONE });
    if (bz === fz0 - 1 && Math.abs(bx - cx) <= 1) put(G + h + 3, B.CLOCK);
    if (bx === cx && bz === fz0 + 2) { fill(put, G + h + 7, G + h + 10, B.COPPER_ROOF); }
    return;
  }
  if (shell(put, bx, bz, x0, fz0, x1, fz1, G, h, { wall: p.wall === B.BRICK_TAN ? B.BRICK_TAN : B.BRICK, win: B.ARCH_WINDOW, trim: B.LIMESTONE, every: 2, band: B.LIMESTONE, corner: B.LIMESTONE })) {
    // roof: water tank on stilts + smokestack
    const tx = x0 + 4, tz = fz0 + 4;
    if (Math.abs(bx - tx) <= 2 && Math.abs(bz - tz) <= 2) {
      const r2 = (bx - tx) ** 2 + (bz - tz) ** 2;
      if ((Math.abs(bx - tx) === 2 && Math.abs(bz - tz) === 2)) fill(put, G + h, G + h + 4, B.TRUSS);
      if (r2 <= 5) { fill(put, G + h + 5, G + h + 9, B.DARK_PLANK); put(G + h + 10, r2 <= 1 ? B.METAL : B.DARK_PLANK); }
      if (r2 === 0) put(G + h + 11, B.METAL);
    }
    const sx = x1 - 4, sz = fz1 - 4;
    if ((bx - sx) ** 2 + (bz - sz) ** 2 <= 2) { fill(put, G + h, G + h + 18, B.BRICK_DARK); put(G + h + 19, (bx === sx && bz === sz) ? B.AIR : B.LIMESTONE); }
    return;
  }
  if (bz > fz1 + 1) put(21, B.COBBLE);
};

const church: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  const st = STYLES[REGION_LIST[p.region]].church;
  const wall = st === 'stone' ? (p.rv[10] < 0.5 ? B.LIMESTONE : B.BRICK) : st === 'white' ? B.SIDING_WHITE : B.STUCCO_CREAM;
  const roof = st === 'stone' ? (p.rv[11] < 0.5 ? B.SLATE_ROOF : B.COPPER_ROOF) : st === 'white' ? B.SHINGLE_GREY : B.ROOF_TILE;
  put(21, B.GRASS);
  const cx = (x0 + x1) >> 1;
  const nw = Math.min(6, (x1 - x0 - 4) >> 1);
  const nz0 = z0 + 8, nz1 = Math.min(z1 - 2, nz0 + 20);
  const nh = st === 'stone' ? 10 : 7;
  // tower + spire at the front
  const tz0 = z0 + 3, tz1 = z0 + 8;
  if (inR(bx, bz, cx - 2, tz0, cx + 2, tz1)) {
    const th = st === 'stone' ? 20 : st === 'white' ? 14 : 16;
    shell(put, bx, bz, cx - 2, tz0, cx + 2, tz1, G, th, { wall, win: st === 'stone' ? B.STAINED_GLASS : B.WINDOW, trim: st === 'mission' ? B.STUCCO_WHITE : wall, every: 2, fh: 6, door: true });
    if (st === 'mission') { hip(put, bx, bz, cx - 2, tz0, cx + 2, tz1, G + th, B.ROOF_TILE, 2); if (bx === cx && bz === tz0 + 2) fill(put, G + th + 3, G + th + 4, B.GOLD_TRIM); }
    else spire(put, bx, bz, cx, (tz0 + tz1) >> 1, G + th, 2, st === 'stone' ? 22 : 16, roof);
    if (bx === cx && bz === ((tz0 + tz1) >> 1)) put(G + th + (st === 'stone' ? 23 : 17), B.GOLD_TRIM);
    if (bz === tz0 && bx === cx && st !== 'white') put(G + th - 4, B.CLOCK);
    return;
  }
  if (inR(bx, bz, cx - nw, nz0, cx + nw, nz1)) {
    shell(put, bx, bz, cx - nw, nz0, cx + nw, nz1, G, nh, { wall, win: B.STAINED_GLASS, trim: wall, every: 3, fh: nh });
    gable(put, bx, bz, cx - nw - 1, nz0, cx + nw + 1, nz1, G + nh, false, roof, wall, nw + 1);
    if (bz === nz1 && bx === cx) { put(G + nh + 2, B.STAINED_GLASS); put(G + nh + 3, B.STAINED_GLASS); }
    return;
  }
  // front lawn path + parking at the side
  if (Math.abs(bx - cx) <= 1 && bz < tz0) put(21, B.SIDEWALK);
  else if (bx > cx + nw + 3 && bz > z0 + 4) put(21, (bx % 3 === 0) ? B.LINE_WHITE : B.ASPHALT);
  else if (hash2(x, z, 51) < 0.03) put(G, B.FLOWERS);
};

const school: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  put(21, B.GRASS);
  const wall = p.region === RG.coral_sands || p.region === RG.palm_haven || p.region === RG.ps_suburbs ? B.STUCCO_CREAM : B.BRICK_TAN;
  // L-shaped two-storey block
  if (shell(put, bx, bz, x0, z0 + 2, x1, z0 + 10, G, 9, { wall, win: B.WINDOW, trim: B.STUCCO_WHITE, every: 2, door: true, band: B.STUCCO_WHITE }) ||
      shell(put, bx, bz, x0, z0 + 2, x0 + 8, z1 - 1, G, 9, { wall, win: B.WINDOW, trim: B.STUCCO_WHITE, every: 2, band: B.STUCCO_WHITE })) {
    if (bz === z0 + 2 && bx === ((x0 + x1) >> 1) - 3) put(G + 9, B.NEON_YELLOW);
    return;
  }
  // flagpole + bus at the front
  if (bz === z0 && bx === x0 + 12) { fill(put, G, G + 9, B.METAL); put(G + 10, B.FLAG); return; }
  if (bz >= z0 && bz <= z0 + 1 && bx >= x0 + 16 && bx <= x0 + 23) { put(G, B.TIRE); put(G + 1, B.CONTAINER_YELLOW); put(G + 2, bx === x0 + 16 ? B.CONTAINER_YELLOW : B.WINDOW); put(G + 3, B.CONTAINER_YELLOW); return; }
  // basketball court
  const cx0 = x0 + 11, cz0 = z0 + 13, cx1 = Math.min(x1 - 1, cx0 + 14), cz1 = Math.min(z1 - 1, cz0 + 9);
  if (inR(bx, bz, cx0, cz0, cx1, cz1)) {
    const line = bx === cx0 || bx === cx1 || bz === cz0 || bz === cz1 || bx === ((cx0 + cx1) >> 1);
    put(21, line ? B.COURT_LINE : B.COURT_BLUE);
    if ((bx === cx0 || bx === cx1) && bz === ((cz0 + cz1) >> 1)) { fill(put, G, G + 2, B.METAL); put(G + 3, B.GLASS); }
    return;
  }
  // running track oval
  if (bz > cz1 + 1) { const tx = (bx - (x0 + x1) / 2) / 12, tz = (bz - (cz1 + z1) / 2) / 4; const d = tx * tx + tz * tz; if (d > 0.7 && d < 1.3) put(21, B.COURT_RED); }
};

const courts: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  put(21, B.GRASS);
  const tennis = p.rv[10] < 0.55;
  const surf = tennis ? (p.rv[11] < 0.5 ? B.COURT_GREEN : B.COURT_BLUE) : (p.rv[11] < 0.5 ? B.COURT_RED : B.COURT_BLUE);
  const cw = tennis ? 12 : 14, cd = tennis ? 24 : 15;
  const n = Math.max(1, Math.floor((x1 - x0 + 2) / (cw + 2)));
  const ci = Math.floor((bx - x0) / (cw + 2));
  if (ci >= n) return;
  const lx0 = x0 + ci * (cw + 2), lx1 = lx0 + cw;
  const lz0 = z0 + Math.max(0, ((z1 - z0) - cd) >> 1), lz1 = Math.min(z1, lz0 + cd);
  if (!inR(bx, bz, lx0 - 1, lz0 - 1, lx1 + 1, lz1 + 1)) return;
  if (bx === lx0 - 1 || bx === lx1 + 1 || bz === lz0 - 1 || bz === lz1 + 1) {
    put(21, B.CONCRETE);
    if (!(bz === lz0 - 1 && bx === lx0 + 2)) fill(put, G, G + 2, B.CHAINLINK);
    if ((bx === lx0 - 1 || bx === lx1 + 1) && (bz === lz0 - 1 || bz === lz1 + 1)) { fill(put, G, G + 5, B.METAL); put(G + 6, B.LAMP); }
    return;
  }
  const u = bx - lx0, v = bz - lz0;
  let line: boolean;
  if (tennis) line = u === 0 || u === cw || u === 2 || u === cw - 2 || v === 0 || v === cd || ((v === 6 || v === cd - 6) && u > 2 && u < cw - 2) || (u === cw >> 1 && v > 6 && v < cd - 6);
  else line = u === 0 || u === cw || v === 0 || v === cd || v === cd >> 1 || (Math.abs(u - cw / 2) <= 2 && (v === 4 || v === cd - 4));
  put(21, line ? B.COURT_LINE : surf);
  if (tennis && v === cd >> 1) put(G, u === 0 || u === cw ? B.METAL : B.IRON_RAIL);
  if (!tennis && u === cw >> 1 && (v === 0 || v === cd)) { fill(put, G, G + 2, B.METAL); put(G + 3, B.GLASS); }
};

const gasStation: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  const brand = GAS_BRANDS.find((g) => g[0] === p.name) ?? GAS_BRANDS[0];
  put(21, B.ASPHALT);
  const cx0 = x0 + 2, cx1 = Math.min(x1 - 2, cx0 + 17), cz0 = z0 + 3, cz1 = Math.min(z1 - 10, cz0 + 9);
  const ccx = (cx0 + cx1) >> 1;
  // canopy
  if (inR(bx, bz, cx0, cz0, cx1, cz1)) {
    const edge = bx === cx0 || bx === cx1 || bz === cz0 || bz === cz1;
    put(G + 5, edge ? brand[1] : B.STUCCO_WHITE);
    if (edge) { put(G + 6, brand[1]); if (bz === cz0) { const l = signN(bx, ccx, brand[0]); if (l >= 0) put(G + 6, l); } }
    else put(G + 4, B.LAMP);
    // posts + pump islands
    const islands = [cx0 + 4, cx1 - 4];
    if (islands.includes(bx) && bz > cz0 + 1 && bz < cz1 - 1) {
      put(21, B.CONCRETE); put(G, B.CONCRETE);
      if (bz === cz0 + 3 || bz === cz1 - 3) { put(G + 1, B.PUMP); put(G + 2, B.PUMP); }
      if (bz === ((cz0 + cz1) >> 1)) fill(put, G + 1, G + 4, B.METAL);
    }
    return;
  }
  // shop behind
  const sz0 = cz1 + 4, sz1 = Math.min(z1, sz0 + 7);
  if (shell(put, bx, bz, x0 + 1, sz0, Math.min(x1, x0 + 16), sz1, G, 5, { wall: B.STUCCO_WHITE, win: B.GLASS, trim: brand[1], every: 2, door: true })) {
    if (bz === sz0) { const l = signN(bx, ((x0 + 1 + Math.min(x1, x0 + 16)) >> 1), 'MART'); if (l >= 0) put(G + 4, l); }
    return;
  }
  // price pylon
  if (bx === x1 && bz === z0) { fill(put, G, G + 7, B.METAL); fill(put, G + 8, G + 10, brand[2]); put(G + 11, brand[1]); return; }
  if (bz > cz1 && bz < sz0 && bx % 4 === 0) put(21, B.LINE_WHITE);
};

const parking: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  put(21, B.ASPHALT);
  if (bx === x0 || bx === x1 || bz === z0 || bz === z1) { put(21, B.GRASS); if ((bx + bz) % 6 === 0) put(G, B.HEDGE); return; }
  // rows: bays (6 deep) / aisle (6) alternating along z
  const rz = (bz - z0 - 1) % 13;
  if (rz < 6) {
    if ((bx - x0) % 3 === 0) put(21, B.LINE_WHITE);
    if (rz === 5 && (bx - x0) % 12 === 6 && bx < x1 - 2) { put(21, B.GRASS); lampPost(put, 5); }
  } else if (rz === 12) put(21, B.CONCRETE);
  if (bx === x0 + 1 && bz === z0 + 1) { fill(put, G, G + 2, B.STUCCO_WHITE); put(G + 3, B.AWNING_BLUE); }
};

const parkingGarage: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  put(21, B.ASPHALT);
  const decks = 4 + Math.floor(p.rv[10] * 3);
  if (!inR(bx, bz, x0 + 1, z0 + 1, x1 - 1, z1 - 1)) return;
  const edge = bx === x0 + 1 || bx === x1 - 1 || bz === z0 + 1 || bz === z1 - 1;
  const pillar = (bx - x0 - 1) % 6 === 0 && (bz - z0 - 1) % 6 === 0;
  for (let d = 1; d <= decks; d++) {
    const yf = 21 + d * 3;
    put(yf, (!edge && (bx - x0) % 3 === 0 && (bz - z0) % 12 < 5) ? B.LINE_WHITE : B.CONCRETE);
    if (edge) put(yf + 1, d === decks ? B.STRIPE : B.CONCRETE);
    if (pillar || (edge && (bx === x0 + 1 || bx === x1 - 1) && (bz === z0 + 1 || bz === z1 - 1))) { put(yf - 1, B.CONCRETE); put(yf - 2, B.CONCRETE); }
  }
  if (edge && bz === z0 + 1 && bx === ((x0 + x1) >> 1)) { const yt = 21 + decks * 3 + 2; put(yt, B.SIGN_PANEL); put(yt + 1, B.LETTER_P); }
  if (!edge && (bx - x0) % 8 === 4 && (bz - z0) % 8 === 4) { const yt = 21 + decks * 3 + 1; fill(put, yt, yt + 2, B.METAL); put(yt + 3, B.LAMP); }
};

const construction: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  put(21, hash2(x, z, 3) < 0.5 ? B.DIRT : B.GRAVEL);
  // fence
  if (bx === x0 || bx === x1 || bz === z0 || bz === z1) { if (!(bz === z0 && bx > x0 + 4 && bx < x0 + 9)) fill(put, G, G + 1, B.CHAINLINK); return; }
  const fx0 = x0 + 3, fz0 = z0 + 3, fx1 = x1 - 3, fz1 = z1 - 3;
  const built = 12 + Math.floor(p.rv[10] * 6) * 4;
  const frame = built + 8;
  if (inR(bx, bz, fx0, fz0, fx1, fz1)) {
    const pillar = (bx - fx0) % 5 === 0 && (bz - fz0) % 5 === 0;
    const edge = bx === fx0 || bx === fx1 || bz === fz0 || bz === fz1;
    for (let k = 0; k < frame; k++) {
      if (k % 4 === 3 && k < built) put(G + k, B.CONCRETE);
      else if (pillar) put(G + k, k < built ? B.CONCRETE : B.METAL);
      else if (edge && k < built && k % 4 === 1 && (bx + bz) % 2 === 0) put(G + k, B.SCAFFOLD);
    }
  }
  // tower crane
  const mx = x0 + 2, mz = z0 + 2;
  const top = G + frame + 10;
  if (bx === mx && bz === mz) { fill(put, G, top + 2, B.CRANE_YELLOW); put(top + 3, B.LIGHT_RED); return; }
  if (bz === mz && bx > mx && bx <= x1) { put(top, B.CRANE_YELLOW); if (bx === mx + 1) { put(top - 1, B.WINDOW); put(top - 2, B.CRANE_YELLOW); } if (bx === mx + 18) fill(put, top - 14, top - 1, B.IRON_RAIL); return; }
  if (bx === mx && bz > mz && bz <= mz + 6) { put(top, B.CRANE_YELLOW); if (bz >= mz + 5) { put(top - 1, B.CONCRETE); put(top - 2, B.CONCRETE); } return; }
  // material piles
  if (bz > fz1 && bx > x0 + 2 && bx < x0 + 8) { put(G, B.LUMBER); if (bx % 2) put(G + 1, B.LUMBER); }
  if (bz > fz1 && bx === x1 - 2) { put(G, B.AWNING_BLUE); put(G + 1, B.AWNING_BLUE); put(G + 2, B.STUCCO_WHITE); }
};

const stripMall: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  put(21, B.ASPHALT);
  const sz0 = Math.max(z0 + 12, z1 - 11), sz1 = z1;
  const n = Math.max(2, Math.floor((x1 - x0 + 1) / 7));
  const uw = Math.floor((x1 - x0 + 1) / n);
  const ui = Math.min(n - 1, Math.floor((bx - x0) / uw));
  const ux0 = x0 + ui * uw, ux1 = ui === n - 1 ? x1 : ux0 + uw - 1;
  const text = SHOP_NAMES[(Math.floor(p.rv[10] * 97) + ui * 5) % SHOP_NAMES.length];
  const col = AWNINGS[(ui + Math.floor(p.rv[11] * 4)) & 3];
  if (bz === sz0 - 1) { if (bx > ux0 && bx < ux1) put(G + 3, col); return; }
  if (inR(bx, bz, x0, sz0, x1, sz1)) {
    const front = bz === sz0;
    for (let k = 0; k < 5; k++) {
      let id = p.wall;
      if (front && bx !== ux0 && k > 0 && k < 3) id = B.GLASS;
      if (front && k === 4) id = col;
      put(G + k, id);
    }
    if (front) { const l = signN(bx, (ux0 + ux1) >> 1, text.slice(0, Math.max(1, ux1 - ux0 - 1))); if (l >= 0) put(G + 5, l); else put(G + 5, col); }
    else if (bz === sz0 + 1) put(G + 5, col);
    return;
  }
  // pylon sign
  if (bx === x0 + 1 && bz === z0 + 1) { fill(put, G, G + 8, B.METAL); fill(put, G + 9, G + 11, NEONS[Math.floor(p.rv[12] * 6)]); return; }
  const rz = (bz - z0) % 13;
  if (rz < 6 && (bx - x0) % 3 === 0) put(21, B.LINE_WHITE);
};

const diner: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  put(21, B.ASPHALT);
  const dx0 = x0 + 3, dx1 = Math.min(x1 - 3, dx0 + 15), dz0 = z0 + 6, dz1 = dz0 + 6;
  const cx = (dx0 + dx1) >> 1;
  if (inR(bx, bz, dx0, dz0, dx1, dz1)) {
    const edge = bx === dx0 || bx === dx1 || bz === dz0 || bz === dz1;
    put(21, B.TILE_FLOOR);
    put(G, edge ? B.CHROME : B.TILE_FLOOR);
    put(G + 1, edge ? B.AWNING_RED : B.CHROME);
    put(G + 2, edge ? ((bx + bz) % 3 === 0 ? B.CHROME : B.WINDOW) : B.CHROME);
    put(G + 3, edge ? B.AWNING_RED : B.CHROME);
    put(G + 4, B.CHROME);
    if (!edge) put(G + 5, B.METAL);
    if (bz === dz0 && bx === cx) { put(G + 1, B.GLASS); put(G + 2, B.GLASS); }
    if (bz === dz0 + 3) { const l = signN(bx, cx, p.name); if (l >= 0) { put(G + 6, l); put(G + 5, B.NEON_PINK); } }
    return;
  }
  // tall pylon sign
  if (bx === x1 - 1 && bz === z0 + 1) { fill(put, G, G + 10, B.METAL); fill(put, G + 11, G + 13, B.NEON_PINK); put(G + 14, B.NEON_CYAN); return; }
  if (bz > dz1 + 2 && (bx - x0) % 3 === 0) put(21, B.LINE_WHITE);
  if (bz < dz0 - 1 && bz > z0 && (bx - x0) % 3 === 0) put(21, B.LINE_WHITE);
};

const motel: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  put(21, B.ASPHALT);
  const wall = pickArr(PASTEL, p.rv[10]);
  const door = pickArr([B.AWNING_RED, B.AWNING_BLUE, B.AWNING_GREEN, B.DARK_PLANK], p.rv[11]);
  // L-shape: back wing along x, side wing along z
  const bz0 = z1 - 7, bz1 = z1;
  const sx0 = x0, sx1 = x0 + 7;
  const inBack = inR(bx, bz, x0, bz0, x1, bz1), inSide = inR(bx, bz, sx0, z0 + 4, sx1, bz1);
  if (inBack || inSide) {
    const fx0 = inBack ? x0 : sx0, fx1 = inBack ? x1 : sx1, fz0 = inBack ? bz0 : z0 + 4, fz1 = bz1;
    const front = inBack ? bz === fz0 : bx === fx1;
    const along = inBack ? bx : bz;
    for (let k = 0; k < 8; k++) {
      let id = wall;
      if (front && k !== 3 && k !== 7) id = along % 4 === 1 ? (k % 4 < 2 ? door : wall) : along % 4 === 3 && (k % 4 === 1 || k % 4 === 2) ? B.WINDOW : wall;
      if (k === 7) id = B.STUCCO_WHITE;
      put(G + k, id);
    }
    return;
  }
  // upper walkway in front of the doors
  const walkBack = bz === bz0 - 1 || bz === bz0 - 2, walkSide = bx === sx1 + 1 || bx === sx1 + 2;
  if ((walkBack && bx >= x0 && bx <= x1) || (walkSide && bz >= z0 + 4 && bz <= bz1)) {
    put(G + 3, B.CONCRETE);
    const outer = bz === bz0 - 2 || bx === sx1 + 2;
    if (outer) { put(G + 4, B.IRON_RAIL); if ((bx + bz) % 6 === 0) fill(put, G, G + 2, B.STUCCO_WHITE); }
    put(G + 7, B.STUCCO_WHITE);
    return;
  }
  // pool in the courtyard
  const px0 = sx1 + 5, px1 = Math.min(x1 - 3, px0 + 10), pz0 = z0 + 8, pz1 = Math.min(bz0 - 4, pz0 + 6);
  if (inR(bx, bz, px0, pz0, px1, pz1)) { const rim = bx === px0 || bx === px1 || bz === pz0 || bz === pz1; put(21, rim ? B.CONCRETE : B.WATER); if (!rim) put(20, B.POOL_TILE); return; }
  // tall vertical MOTEL sign
  if (bx === x1 && bz === z0) {
    fill(put, G, G + 5, B.METAL);
    for (let i = 0; i < 5; i++) put(G + 11 - i, letterBlock('MOTEL'[i]));
    put(G + 12, B.NEON_PINK); put(G + 6, B.NEON_PINK);
    return;
  }
  if (bz < pz0 - 1 && (bx - x0) % 3 === 0) put(21, B.LINE_WHITE);
};

const foodTrucks: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  put(21, B.COBBLE);
  const cols = [B.STUCCO_PINK, B.STUCCO_TEAL, B.STUCCO_YELLOW, B.AWNING_RED, B.STUCCO_SKY];
  // trucks parked along the north edge, serving windows facing south
  const tw = 7;
  const ti = Math.floor((bx - x0 - 1) / (tw + 2));
  const tu = (bx - x0 - 1) % (tw + 2);
  if (bz >= z0 + 1 && bz <= z0 + 3 && tu >= 0 && tu < tw && bx > x0 && ti < 4) {
    const c = cols[(ti + Math.floor(p.rv[10] * 5)) % cols.length];
    put(G, (tu === 1 || tu === tw - 2) && (bz === z0 + 1 || bz === z0 + 3) ? B.TIRE : B.METAL);
    put(G + 1, bz === z0 + 3 && tu > 1 && tu < tw - 1 ? B.FOOD_TRUCK : c);
    put(G + 2, tu === 0 ? B.WINDOW : c);
    put(G + 3, c);
    if (tu === 3 && bz === z0 + 2) put(G + 4, B.AC_UNIT);
    return;
  }
  if (bz === z0 + 4 && tu > 1 && tu < tw - 1 && ti < 4 && bx > x0) { put(G + 3, AWNINGS[ti & 3]); return; }
  // picnic tables + string-light poles
  const u = (bx - x0) % 6, v = (bz - z0 - 7) % 6;
  if (bz > z0 + 6 && bz < z1 - 1) {
    if (v === 2 && u >= 1 && u <= 3) put(G, B.DARK_PLANK);
    else if ((v === 1 || v === 3) && u >= 1 && u <= 3) put(G, B.PLANK);
    if (u === 0 && v === 0) { fill(put, G, G + 3, B.METAL); put(G + 4, B.LAMP); }
  }
};

const billboard: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  put(21, B.GRASS);
  if (hash2(x, z, 13) < 0.06) put(G, B.TALL_GRASS);
  const bb = BILLBOARDS.find((b) => b[0] === p.name) ?? BILLBOARDS[0];
  const cz = (z0 + z1) >> 1, cx = (x0 + x1) >> 1;
  const w = Math.min(x1 - x0, bb[0].length + 4);
  const bx0 = cx - (w >> 1), bx1 = bx0 + w;
  if ((bz !== cz && bz !== cz - 1) || bx < bx0 || bx > bx1) return;
  if (bx === bx0 + 2 || bx === bx1 - 2) fill(put, G, G + 6, B.METAL);
  // double-sided face: brand colour frame, letters in the middle row reading correctly from both sides
  for (let k = 7; k <= 11; k++) {
    let id = bb[1];
    if (k === 9) { const l = bz === cz ? signS(bx, cx, bb[0]) : signN(bx, cx, bb[0]); if (l >= 0) id = l; }
    put(G + k, id);
  }
  if (bx % 3 === 0 && bz === cz) put(G + 12, B.LAMP);
};

const warehouse: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  put(21, B.CONCRETE);
  const wz1 = Math.min(z1, z0 + 22);
  if (shell(put, bx, bz, x0 + 1, z0 + 3, x1 - 1, wz1, G, 10 + Math.floor(p.rv[10] * 2) * 2, { wall: p.wall, win: B.WINDOW, trim: p.trim, every: 5, fh: 9, roof: p.rv[11] < 0.4 ? B.SOLAR : B.METAL })) {
    if (bz === z0 + 3 && (bx - x0) % 6 > 1 && (bx - x0) % 6 < 5) { for (let k = 0; k < 5; k++) put(G + k, B.SHUTTER); }
    return;
  }
  if (bz < z0 + 3 && (bx - x0) % 6 === 3) put(21, B.LINE_YELLOW);
  if (bz > wz1 + 1) {
    const ci = Math.floor((bx - x0) / 7);
    if ((bx - x0) % 7 < 6) {
      const stack = 1 + Math.floor(hash2(ci, Math.floor(bz / 3) + p.seed, 5) * 3);
      const col = CONTAINERS[Math.floor(hash2(ci, Math.floor(bz / 3), p.seed & 255) * CONTAINERS.length)];
      if (bz % 3 !== 0) for (let k = 0; k < stack * 2; k++) put(G + k, col);
    }
  }
};

const containerYard: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  put(21, B.CONCRETE);
  // container rows: 6 long (x), 2 wide (z); lanes every 3 rows
  const row = Math.floor((bz - z0) / 3), rz = (bz - z0) % 3;
  const lane = row % 4 === 3;
  if (lane) { if (rz === 1) put(21, B.LINE_YELLOW); return; }
  if (rz === 2) return;
  const ci = Math.floor((bx - x0) / 7);
  if ((bx - x0) % 7 === 6) return;
  const hv = hash2(ci + (p.seed & 1023), row, 9);
  const stack = 1 + Math.floor(hv * 4);
  for (let t = 0; t < stack; t++) {
    const col = CONTAINERS[Math.floor(hash2(ci * 3 + t, row, p.seed & 4095) * CONTAINERS.length)];
    put(G + t * 2, col); put(G + t * 2 + 1, col);
  }
  // portal crane straddling a row
  const gx = x0 + 3 + Math.floor(p.rv[10] * Math.max(1, x1 - x0 - 6));
  if (bx === gx || bx === gx + 1) { if ((bz - z0) % 9 === 0) fill(put, G + stack * 2, G + 10, B.CRANE_YELLOW); put(G + 11, B.CRANE_YELLOW); }
};

const hangar: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  put(21, B.CONCRETE);
  const hx0 = x0 + 1, hx1 = x1 - 1, hz0 = z0 + 4, hz1 = Math.min(z1 - 1, z0 + 28);
  if (!inR(bx, bz, hx0, hz0, hx1, hz1)) { if (bz < hz0 && (bx - x0) % 8 === 4) put(21, B.LINE_YELLOW); return; }
  // vaulted roof: height from a half-ellipse across x
  const t = (bx - (hx0 + hx1) / 2) / ((hx1 - hx0) / 2 + 0.5);
  const h = 6 + Math.floor(8 * Math.sqrt(Math.max(0, 1 - t * t)));
  const front = bz === hz0, back = bz === hz1, side = bx === hx0 || bx === hx1;
  const mat = p.wall;
  for (let k = 0; k < h; k++) {
    let id = mat;
    if (front && !side && k < h - 2) id = B.SHUTTER;
    if (front && k === h - 2) id = p.trim;
    if (side && k === 2 && (bz % 3 === 0)) id = B.WINDOW;
    if (back && k === 3 && Math.abs(bx - (hx0 + hx1) / 2) < 2) id = B.NEON_CYAN;
    put(G + k, id);
  }
  put(G + h, B.METAL);
};

const radar: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  put(21, B.CONCRETE);
  if (bx === x0 || bx === x1 || bz === z0 || bz === z1) { fill(put, G, G + 2, B.CHAINLINK); return; }
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const r = Math.min(7, Math.floor((Math.min(x1 - x0, z1 - z0) - 4) / 2));
  const dx = bx - cx, dz = bz - cz, d2 = dx * dx + dz * dz;
  if (p.rv[10] < 0.5) {
    // radome on a drum
    if (d2 <= (r - 1) * (r - 1)) fill(put, G, G + 3, B.CONCRETE);
    if (d2 <= r * r) { const hh = Math.sqrt(r * r - d2); fill(put, G + 4, G + 4 + Math.floor(hh), B.DISH); }
  } else {
    // open dish: tilted bowl on a pedestal
    if (d2 <= 2) fill(put, G, G + 5, B.CONCRETE);
    if (d2 <= r * r) { const bowl = G + 6 + Math.floor(d2 / (r * 1.2)) + Math.floor((dz / r) * 2.5 + 2.5); put(bowl, B.DISH); if (d2 < 1) fill(put, bowl, bowl + 4, B.TRUSS); }
  }
  if (bx === x0 + 2 && bz === z0 + 2) { fill(put, G, G + 16, B.TRUSS); put(G + 17, B.LIGHT_RED); }
};

const townHall: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  put(21, B.GRASS);
  const wall = p.region === RG.cedar_bluff ? B.LIMESTONE : B.BRICK;
  const hx0 = x0 + 3, hx1 = x1 - 3, hz0 = z0 + 9, hz1 = Math.min(z1 - 2, hz0 + 14);
  const cx = (hx0 + hx1) >> 1;
  // portico of columns
  if (bz >= hz0 - 3 && bz < hz0 && Math.abs(bx - cx) <= 6) {
    put(21, B.MARBLE);
    if (bz === hz0 - 3 && (bx - cx) % 2 === 0) fill(put, G, G + 7, B.STUCCO_WHITE);
    put(G + 8, B.LIMESTONE);
    gable(put, bx, bz, cx - 6, hz0 - 3, cx + 6, hz0 - 1, G + 9, false, B.LIMESTONE, B.LIMESTONE, 3);
    return;
  }
  // clock tower with dome
  if (Math.abs(bx - cx) <= 2 && bz >= hz0 + 4 && bz <= hz0 + 8) {
    shell(put, bx, bz, cx - 2, hz0 + 4, cx + 2, hz0 + 8, G, 22, { wall, win: B.WINDOW, trim: B.LIMESTONE, every: 2, band: B.LIMESTONE });
    if ((bz === hz0 + 4 || bz === hz0 + 8 || bx === cx - 2 || bx === cx + 2) && !((bx === cx - 2 || bx === cx + 2) && (bz === hz0 + 4 || bz === hz0 + 8))) put(G + 18, B.CLOCK);
    const d = Math.max(Math.abs(bx - cx), Math.abs(bz - hz0 - 6));
    fill(put, G + 22, G + 22 + (2 - d) * 2 + 1, B.COPPER_ROOF);
    if (d === 0) { put(G + 28, B.GOLD_TRIM); put(G + 29, B.GOLD_TRIM); }
    return;
  }
  if (shell(put, bx, bz, hx0, hz0, hx1, hz1, G, 12, { wall, win: B.WINDOW, trim: B.LIMESTONE, every: 2, band: B.LIMESTONE, corner: B.LIMESTONE })) {
    hip(put, bx, bz, hx0, hz0, hx1, hz1, G + 12, p.region === RG.cedar_bluff ? B.COPPER_ROOF : B.SLATE_ROOF, 3);
    return;
  }
  if (Math.abs(bx - cx) <= 1 && bz < hz0 - 3) put(21, B.MARBLE);
  if (bz === z0 + 2 && (bx === cx - 5 || bx === cx + 5)) { fill(put, G, G + 9, B.METAL); put(G + 10, B.FLAG); }
};

const park: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  const cx = (x0 + x1) >> 1, cz = (z0 + z1) >> 1;
  const path = bx === cx || bx === cx + 1 || bz === cz || bz === cz + 1;
  put(21, path ? B.GRAVEL : B.GRASS);
  const hv = hash2(x, z, 21);
  // gazebo or playground in the centre
  if (Math.abs(bx - cx) <= 3 && Math.abs(bz - cz) <= 3 && !path) {
    if (p.rv[10] < 0.5) {
      if ((Math.abs(bx - cx) === 3 || Math.abs(bx - cx - 1) === 3) && (Math.abs(bz - cz) === 3 || Math.abs(bz - cz - 1) === 3)) fill(put, G, G + 2, B.STUCCO_WHITE);
      hip(put, bx, bz, cx - 3, cz - 3, cx + 4, cz + 4, G + 3, B.SHINGLE_GREEN, 3);
    } else {
      put(21, B.SAND);
      if ((bx + bz) % 5 === 0) { fill(put, G, G + 1, (bx & 1) ? B.AWNING_RED : B.AWNING_YELLOW); put(G + 2, B.AWNING_BLUE); }
    }
    return;
  }
  if (!path) { if (hv < 0.04) put(G, B.FLOWERS); else if (hv < 0.06) put(G, B.TALL_GRASS); else if (hv < 0.07) put(G, B.FLOWERS_BLUE); }
  else if ((bx === cx + 2 || bz === cz + 2) && (bx + bz) % 8 === 0) put(G, B.DARK_PLANK); // benches
};

const plaza: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const dx = bx - cx, dz = bz - cz, d = Math.sqrt(dx * dx + dz * dz);
  put(21, (Math.floor(d) % 4 === 0) ? B.MARBLE : B.COBBLE);
  if (d < 6.5) {
    if (d >= 5.5) { put(21, B.LIMESTONE); put(G, B.LIMESTONE); }
    else { put(21, B.WATER); put(20, B.POOL_TILE); if (d < 1.2) { fill(put, 21, G + 1, B.LIMESTONE); put(G + 2, B.WATER); } }
    return;
  }
  if (Math.abs(d - 10) < 0.5 && (Math.round(Math.atan2(dz, dx) * 4) % 2 === 0)) put(G, B.DARK_PLANK);
  if ((bx === x0 + 2 || bx === x1 - 2) && (bz === z0 + 2 || bz === z1 - 2)) lampPost(put, 4);
  if ((bx === x0 + 2 || bx === x1 - 2) && Math.abs(bz - cz) < 1) { put(G, B.HEDGE); put(G + 1, B.FLOWERS); }
};

const pond: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const rx = (x1 - x0) / 2 - 3, rz = (z1 - z0) / 2 - 3;
  const e = ((bx - cx) / rx) ** 2 + ((bz - cz) / rz) ** 2 + (hash2(bx, bz, p.seed & 255) - 0.5) * 0.08;
  put(21, B.GRASS);
  if (e < 1) {
    put(21, B.WATER); put(20, e < 0.5 ? B.MUD : B.SAND);
    if (Math.abs(bx - cx) < 0.6 && Math.abs(bz - cz) < 0.6) { put(G, B.WATER); put(G + 1, B.WATER); }
    if (e > 0.82 && hash2(x, z, 4) < 0.3) put(G, B.REEDS);
    // little dock
    if (Math.abs(bx - x0 - 4) <= 1 && bz > cz - 1 && bz < cz + 1) put(21, B.DOCK);
    return;
  }
  if (e < 1.35) { put(21, B.GRAVEL); if (hash2(x, z, 6) < 0.05) put(G, B.DARK_PLANK); return; }
  if (hash2(x, z, 7) < 0.05) put(G, B.FLOWERS);
};

const hotel: LotGen = (x, z, bx, bz, p, put) => decoHotel(x, z, bx, bz, p, put);

/** Open paved square (keeps mission spots walkable): patterned paving, corner lamps and planters. */
const square: LotGen = (x, z, bx, bz, p, put) => {
  const [x0, z0, x1, z1] = p.rect;
  const ind = p.region === RG.port_island || p.region === RG.cape_halcyon;
  const a = ind ? B.CONCRETE : B.COBBLE, b = ind ? B.LINE_YELLOW : B.MARBLE;
  put(21, ((bx + bz) % 8 === 0 || (bx - bz + 64) % 8 === 0) && !ind ? b : (ind && (bx - x0) % 8 === 0 ? b : a));
  const cx = bx === x0 + 1 || bx === x1 - 1, cz = bz === z0 + 1 || bz === z1 - 1;
  if (cx && cz) lampPost(put, 4);
  else if ((bx === x0 || bx === x1) && (bz === z0 || bz === z1)) { put(G, B.HEDGE); put(G + 1, ind ? B.HEDGE : B.FLOWERS); }
};

export const LOT_GENS: Partial<Record<LotKind, LotGen>> = {
  tower, glass_tower: glassTower, midrise, apartments, deco_hotel: decoHotel, beach_club: beachClub, condo, houses,
  cul_de_sac: culDeSac, villas, golf, conch_houses: conchHouses, shops_row: shopsRow, cigar_factory: cigarFactory,
  church, school, courts, gas_station: gasStation, parking, parking_garage: parkingGarage, construction, strip_mall: stripMall,
  diner, motel, food_trucks: foodTrucks, billboard, warehouse, container_yard: containerYard, hangar, radar,
  town_hall: townHall, park, plaza, pond, hotel, square,
};

/** Minimum usable rect side for each kind (blocks). */
export const MIN_SIDE: Partial<Record<LotKind, number>> = {
  tower: 18, glass_tower: 18, midrise: 24, apartments: 16, deco_hotel: 16, beach_club: 14, condo: 16, houses: 17, cul_de_sac: 34,
  villas: 22, golf: 14, conch_houses: 12, shops_row: 14, cigar_factory: 24, church: 18, school: 30, courts: 14, gas_station: 18,
  parking: 10, parking_garage: 16, construction: 18, strip_mall: 18, diner: 16, motel: 22, food_trucks: 12, billboard: 8,
  warehouse: 18, container_yard: 12, hangar: 18, radar: 14, town_hall: 26, park: 10, plaza: 14, pond: 18, hotel: 16, square: 8,
};

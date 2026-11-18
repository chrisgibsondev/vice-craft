/**
 * Block textures: two WebGL2 texture arrays (one layer per tile, so tiles never bleed
 * into each other at any mip level and REPEAT wrapping is free).
 *   albedo   (sRGB RGBA, alpha = cutout)
 *   material (linear RGBA: RG = tangent-space normal XY, B = roughness, A = gloss mask:
 *             1 = may reflect (spec tier blocks), ~0.5 = puddle-capable road, ~0 = matte frame)
 *
 * Layers are TILE px. Photographic materials (public/textures, see its manifest) cover
 * REPEAT = 2 blocks per layer (64 px per block); everything else is painted here: the
 * original 16 px painters are cleaned (edge-preserving), EPX-upscaled ×8, given hi-res
 * grain and a height-derived normal, and the most visible graphic tiles (signs, letters,
 * neon, glazing, screens, foliage, plants) have dedicated hi-res canvas painters.
 * Extra variant layers for big ground materials are appended after TILE_NAMES so tile
 * indices stay stable.
 */
import * as THREE from 'three';
import { TILE_NAMES, TILE_INDEX } from '@blockshore/shared';

/** layer resolution in px (pow2: clean mips) */
export const TILE = 128;
/** texel density of the photographic materials (TILE / REPEAT) */
export const PX_PER_BLOCK = 64;
const SRC = 16;

type RGB = [number, number, number];
type Painter = (px: (x: number, y: number, c: RGB) => void, r: () => number) => void;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
}
const hex = (h: number): RGB => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
const jit = (c: RGB, r: () => number, amt: number): RGB => {
  const k = 1 + (r() - 0.5) * amt;
  return [c[0] * k, c[1] * k, c[2] * k];
};
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function noiseFill(base: number, amt: number): Painter {
  return (px, r) => { const c = hex(base); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, jit(c, r, amt)); };
}
function stucco(base: number): Painter {
  return (px, r) => {
    const c = hex(base);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      let k = jit(c, r, 0.08);
      if (r() < 0.05) k = mix(k, [255, 255, 255], 0.15);
      px(x, y, k);
    }
  };
}
function planks(base: number, dark = 0.75): Painter {
  return (px, r) => {
    const c = hex(base);
    for (let y = 0; y < 16; y++) {
      const row = Math.floor(y / 4);
      const off = (row % 2) * 7;
      for (let x = 0; x < 16; x++) {
        let k = jit(c, r, 0.1);
        if (y % 4 === 3) k = mix(k, [0, 0, 0], 1 - dark);
        if ((x + off) % 16 === 0) k = mix(k, [0, 0, 0], 0.3);
        px(x, y, k);
      }
    }
  };
}
function bricks(base: number, mortar: number): Painter {
  return (px, r) => {
    const c = hex(base), m = hex(mortar);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const row = Math.floor(y / 4), off = (row % 2) * 4;
      const isM = y % 4 === 3 || (x + off) % 8 === 7;
      px(x, y, isM ? jit(m, r, 0.06) : jit(c, r, 0.14));
    }
  };
}
function windowTile(frame: number, glassTop: number, glassBot: number, lit = false): Painter {
  return (px, r) => {
    const f = hex(frame), a = hex(glassTop), b = hex(glassBot);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const edge = x === 0 || x === 15 || y === 0 || y === 15 || x === 7 || x === 8;
      let k = edge ? jit(f, r, 0.05) : mix(a, b, y / 15);
      if (!edge && (x + y) % 9 === 0 && y < 9) k = mix(k, [255, 255, 255], 0.35); // reflection streak
      if (lit && !edge && r() < 0.02) k = [255, 230, 160];
      px(x, y, k);
    }
  };
}

const P: Record<string, Painter> = {
  grass_top: (px, r) => { const a = hex(0x6fbf4a), b = hex(0x4f9a38); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, mix(a, b, r() * 0.8)); },
  grass_side: (px, r) => {
    const d = hex(0x8a5f3c), g = hex(0x5fae42);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const gl = y < 3 || (y < 5 && r() < 0.5);
      px(x, y, gl ? jit(g, r, 0.2) : jit(d, r, 0.2));
    }
  },
  dirt: noiseFill(0x8a5f3c, 0.25),
  sand: (px, r) => { const a = hex(0xf0dca0), b = hex(0xe2c98a); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, mix(a, b, r())); },
  stone: (px, r) => { const a = hex(0x8e9196); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, r() < 0.12 ? jit(a, r, 0.5) : jit(a, r, 0.12)); },
  water: (px, r) => { const a = hex(0x3a9bd8), b = hex(0x67c3f0); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, mix(a, b, (Math.sin((x + y * 0.5) * 0.9) * 0.5 + 0.5) * 0.5 + r() * 0.2)); },
  asphalt: (px, r) => { const a = hex(0x3c4046); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, r() < 0.08 ? jit(a, r, 0.6) : jit(a, r, 0.1)); },
  line_white: (px, r) => { const a = hex(0xeeeeea); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, (x < 2 || x > 13) ? jit(hex(0x3c4046), r, 0.1) : jit(a, r, 0.06)); },
  line_yellow: (px, r) => { const a = hex(0xf2c230); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, (x < 4 || x > 11) ? jit(hex(0x3c4046), r, 0.1) : jit(a, r, 0.06)); },
  runway: (px, r) => { const a = hex(0x4a4e55); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, jit(a, r, 0.1)); },
  sidewalk: (px, r) => { const a = hex(0xcbc8c0); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, (x === 0 || y === 0) ? jit(hex(0xa9a59c), r, 0.05) : jit(a, r, 0.06)); },
  concrete: noiseFill(0xb8b8b4, 0.08),
  brick: bricks(0xb4553f, 0xd8cbb8),
  glass: (px) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const edge = x === 0 || y === 0 || x === 15 || y === 15; px(x, y, edge ? [220, 235, 240] : (x - y === 4 || x - y === 5) ? [235, 248, 255] : [170, 215, 235]); } },
  plank: planks(0xb98a55),
  dark_plank: planks(0x6b4a2e),
  palm_log: (px, r) => { const a = hex(0x9b7a4e); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, jit(y % 4 === 0 ? mix(a, [60, 40, 20], 0.4) : a, r, 0.12)); },
  palm_log_top: (px, r) => { const a = hex(0xc6a36b); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const d = Math.hypot(x - 7.5, y - 7.5); px(x, y, jit(Math.floor(d) % 3 === 0 ? mix(a, [80, 60, 30], 0.4) : a, r, 0.08)); } },
  leaves: (px, r) => { const a = hex(0x3f8f3a), b = hex(0x2d6b2b); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, r() < 0.1 ? [0, 0, 0, ] as unknown as RGB : mix(a, b, r())); },
  palm_leaves: (px, r) => { const a = hex(0x5fb84a), b = hex(0x3a8a33); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const frond = Math.abs(((x + y) % 6) - 3) < 2 || Math.abs(x - 8) < 1; px(x, y, frond ? mix(a, b, r()) : [0, 0, 0]); } },
  pine_leaves: (px, r) => { const a = hex(0x2e6b3f), b = hex(0x1f4d2d); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, r() < 0.08 ? [0, 0, 0] : mix(a, b, r())); },
  hedge: (px, r) => { const a = hex(0x3d7d32), b = hex(0x2a5c24); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, mix(a, b, r())); },
  stucco_white: stucco(0xf1eee6), stucco_pink: stucco(0xf4a7b9), stucco_teal: stucco(0x6fd3c7), stucco_yellow: stucco(0xf6d77a), stucco_peach: stucco(0xf6bf98),
  red_stucco: stucco(0xd9443a), police_blue: stucco(0x2c4f9e),
  metal: (px, r) => { const a = hex(0x8f9aa6); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, jit(x % 4 === 0 ? mix(a, [40, 50, 60], 0.35) : a, r, 0.05)); },
  roof_tile: (px, r) => { const a = hex(0xc0603c); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, jit(y % 4 === 3 || (x + (Math.floor(y / 4) % 2) * 4) % 8 === 0 ? mix(a, [60, 20, 10], 0.4) : a, r, 0.1)); },
  tile_floor: (px) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, ((x >> 3) + (y >> 3)) % 2 ? [40, 40, 46] : [236, 236, 230]); },
  carpet: (px, r) => { const a = hex(0x8c2f39); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, (x === 1 || x === 14 || y === 1 || y === 14) ? [214, 168, 70] : jit(a, r, 0.1)); },
  neon_pink: (px) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const c = y > 4 && y < 11; px(x, y, c ? [255, 140, 220] : [255, 60, 180]); } },
  neon_cyan: (px) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const c = y > 4 && y < 11; px(x, y, c ? [170, 255, 255] : [40, 220, 255]); } },
  mud: noiseFill(0x5a4632, 0.25),
  reeds: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const stalk = x % 4 === 1 && y > (r() * 6); px(x, y, stalk ? jit(hex(0x8fae55), r, 0.2) : [0, 0, 0]); } },
  lamp: (px) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const d = Math.hypot(x - 7.5, y - 7.5); px(x, y, d < 6 ? [255, 246, 214] : [250, 214, 140]); } },
  rail: (px) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, (x % 5 === 0 || y < 2) ? [150, 158, 166] : [92, 100, 108]); },
  window: windowTile(0xd8d8d0, 0x7fb7d9, 0x30566f),
  gravel: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, jit(hex(r() < 0.5 ? 0x9b958a : 0x7d776e), r, 0.2)); },
  counter_top: (px, r) => { const a = hex(0xe9e5dc); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, jit(a, r, 0.04)); },
  counter_side: (px, r) => { const a = hex(0x2f8f83); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, y < 2 ? [233, 229, 220] : jit(a, r, 0.06)); },
  shelf: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const board = y % 5 === 0; const item = !board && r() < 0.7; const cols: RGB[] = [[230, 80, 70], [70, 160, 220], [250, 200, 60], [120, 200, 90]]; px(x, y, board ? [120, 90, 60] : item ? cols[(x >> 2) % 4] : [60, 45, 30]); } },
  bed_top: (px) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, y < 5 ? [245, 245, 245] : [70, 120, 200]); },
  bed_side: (px) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, y < 8 ? [70, 120, 200] : [140, 100, 60]); },
  sofa_top: noiseFill(0xd8664f, 0.08), sofa_side: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, jit(y < 6 ? hex(0xe07a5f) : hex(0xb8503c), r, 0.06)); },
  crate: (px, r) => { const a = hex(0xb58b52); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const fr = x < 2 || x > 13 || y < 2 || y > 13 || Math.abs(x - y) < 1.2; px(x, y, jit(fr ? mix(a, [60, 40, 20], 0.35) : a, r, 0.1)); } },
  container_red: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, jit(x % 3 === 0 ? hex(0x8f2c22) : hex(0xb33a2c), r, 0.06)); },
  container_blue: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, jit(x % 3 === 0 ? hex(0x1f4d8f) : hex(0x2b62ae), r, 0.06)); },
  shutter: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, jit(y % 2 ? hex(0x9aa3ad) : hex(0x7b848e), r, 0.04)); },
  flowers: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const stem = x % 5 === 2 && y > 6; const bloom = x % 5 > 0 && x % 5 < 4 && y > 3 && y < 7; px(x, y, bloom ? (x < 8 ? [255, 90, 140] : [255, 220, 60]) : stem ? [70, 150, 60] : [0, 0, 0]); void r; } },
  cane: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const s = x % 4 === 1; px(x, y, s ? jit(hex(y % 5 === 0 ? 0x7c9a3c : 0xa6c95a), r, 0.1) : [0, 0, 0]); } },
  tall_grass: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const blade = y > 4 + ((x * 7) % 6) && x % 2 === 0; px(x, y, blade ? jit(hex(0x67b34a), r, 0.2) : [0, 0, 0]); } },
  club_floor: (px) => { const cols: RGB[] = [[255, 60, 180], [40, 220, 255], [255, 220, 60], [140, 80, 255]]; for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, (x === 0 || y === 0) ? [20, 20, 30] : cols[((x >> 3) + (y >> 3) * 2) % 4]); },
  marble: (px, r) => { const a = hex(0xeceae4); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, (Math.abs(Math.sin(x * 0.7 + y * 0.35) ) < 0.08) ? [190, 188, 182] : jit(a, r, 0.03)); },
  chrome: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, jit(mix(hex(0xf2f4f6), hex(0x9aa4ae), y / 15), r, 0.03)); },
  screen: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const edge = x === 0 || x === 15 || y === 0 || y === 15; px(x, y, edge ? [30, 30, 36] : mix([40, 110, 220], [120, 220, 255], (y + r() * 3) / 18)); } },
  fridge: (px) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, (x === 0 || x === 15 || y === 7) ? [170, 176, 182] : x === 13 && y > 1 && y < 6 ? [90, 90, 90] : [226, 232, 236]); },
  stove_top: (px) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const d1 = Math.hypot(x - 4.5, y - 4.5), d2 = Math.hypot(x - 11, y - 11); px(x, y, d1 < 3 || d2 < 3 ? [40, 40, 40] : [220, 220, 220]); } },
  stove_side: (px) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, y > 4 && y < 12 && x > 2 && x < 13 ? [50, 50, 55] : [210, 210, 210]); },
  dock: planks(0x9e7b56, 0.6),
  farmland: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, jit(y % 4 < 1 ? hex(0x4f3826) : hex(0x6b4c33), r, 0.15)); },
  safe_front: (px) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const d = Math.hypot(x - 7.5, y - 7.5); px(x, y, d < 3.2 ? (d < 1.2 ? [200, 200, 200] : [120, 120, 125]) : (x === 0 || y === 0 || x === 15 || y === 15) ? [40, 42, 46] : [70, 74, 80]); } },
  arcade: (px) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, y < 7 ? [80, 40, 160] : [30, 30, 40]); },
  stool_top: (px) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, Math.hypot(x - 7.5, y - 7.5) < 7 ? [220, 60, 70] : [180, 180, 190]); },
  stripe: (px) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, ((x + y) >> 2) % 2 ? [250, 200, 30] : [30, 30, 30]); },
};

// ───────────────────────────────────────────── regions pack painters (original art)
const T: RGB = [0, 0, 0]; // transparent on cutout tiles
const each = (f: (x: number, y: number) => RGB): Painter => (px) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, f(x, y)); };
function curtain(top: number, bot: number, frame: number): Painter {
  return (px, r) => {
    const a = hex(top), b = hex(bot), f = hex(frame);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const mull = x === 0 || x === 8 || y === 0 || y === 8;
      let k = mix(a, b, ((y % 8) / 7) * 0.8 + (x % 8) / 40);
      if (!mull && ((x % 8) - (y % 8) === 2 || (x % 8) - (y % 8) === 3)) k = mix(k, [255, 255, 255], 0.28);
      if (!mull && r() < 0.03) k = mix(k, [255, 236, 190], 0.5);
      px(x, y, mull ? jit(f, r, 0.04) : k);
    }
  };
}
function siding(base: number): Painter {
  return (px, r) => {
    const c = hex(base);
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      let k = jit(c, r, 0.05);
      if (y % 4 === 0) k = mix(k, [255, 255, 255], 0.22);
      if (y % 4 === 3) k = mix(k, [0, 0, 0], 0.22);
      if ((x + (y >> 2) * 5) % 16 === 0 && y % 4 !== 0) k = mix(k, [0, 0, 0], 0.12);
      px(x, y, k);
    }
  };
}
function awning(base: number): Painter {
  return (px, r) => { const c = hex(base); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { let k = (x >> 2) % 2 ? jit(c, r, 0.04) : jit([246, 244, 236], r, 0.03); if (y === 15 || (y === 14 && (x % 4 === 1 || x % 4 === 2))) k = mix(k, [0, 0, 0], 0.25); if (y === 0) k = mix(k, [255, 255, 255], 0.2); px(x, y, k); } };
}
function shingles(base: number, gap = 0.35): Painter {
  return (px, r) => { const c = hex(base); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const row = y >> 2; const off = (row % 2) * 3; let k = jit(c, r, 0.12); if (y % 4 === 3) k = mix(k, [0, 0, 0], gap); else if ((x + off) % 6 === 0) k = mix(k, [0, 0, 0], gap * 0.6); px(x, y, k); } };
}
function container(base: number, dark: number): Painter {
  return (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { let k = jit(x % 3 === 0 ? hex(dark) : hex(base), r, 0.05); if (y === 0 || y === 15) k = mix(k, [0, 0, 0], 0.3); px(x, y, k); } };
}
function lattice(base: number): Painter {
  return (px) => { const c = hex(base), d = mix(c, [0, 0, 0], 0.35); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const frame = x <= 1 || x >= 14 || y <= 1 || y >= 14; const diag = Math.abs(x - y) <= 0.7 || Math.abs(x + y - 15) <= 0.7; px(x, y, frame ? (x === 0 || y === 0 ? mix(c, [255, 255, 255], 0.2) : c) : diag ? d : T); } };
}
function courtTile(base: number): Painter { return (px, r) => { const c = hex(base); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, jit(c, r, 0.04)); }; }
function neon(core: RGB, rim: RGB): Painter { return each((x, y) => { const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5)); return d < 4 ? mix(core, [255, 255, 255], 0.35) : d < 6.5 ? core : rim; }); }
function coral(a: number, b: number): Painter {
  return (px, r) => { const c1 = hex(a), c2 = hex(b); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const v = Math.sin(x * 1.3 + Math.sin(y * 0.9) * 2) * Math.cos(y * 1.1); px(x, y, jit(v > 0.2 ? c1 : v < -0.4 ? mix(c2, [0, 0, 0], 0.3) : c2, r, 0.08)); } };
}
function light(c: RGB): Painter { return each((x, y) => { const d = Math.hypot(x - 7.5, y - 10.5); return d < 1.6 ? [255, 255, 255] : d < 3 ? c : (x === 7 || x === 8) && y > 12 ? [60, 60, 66] : T; }); }

// 5x7 sign font, A-Z (original glyph set)
const FONT: Record<string, string> = {
  A: '01110100011000111111100011000110001', B: '11110100011000111110100011000111110', C: '01110100011000010000100001000101110', D: '11110100011000110001100011000111110',
  E: '11111100001000011110100001000011111', F: '11111100001000011110100001000010000', G: '01110100011000010111100011000101111', H: '10001100011000111111100011000110001',
  I: '01110001000010000100001000010001110', J: '00111000100001000010000101001001100', K: '10001100101010011000101001001010001', L: '10000100001000010000100001000011111',
  M: '10001110111010110101100011000110001', N: '10001100011100110101100111000110001', O: '01110100011000110001100011000101110', P: '11110100011000111110100001000010000',
  Q: '01110100011000110001101011001001101', R: '11110100011000111110101001001010001', S: '01111100001000001110000010000111110', T: '11111001000010000100001000010000100',
  U: '10001100011000110001100011000101110', V: '10001100011000110001100010101000100', W: '10001100011000110101101011010101010', X: '10001100010101000100010101000110001',
  Y: '10001100010101000100001000010000100', Z: '11111000010001000100010001000011111',
};
function letter(ch: string): Painter {
  const g = FONT[ch];
  return (px) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const gx = Math.floor((x - 3) / 2), gy = Math.floor((y - 1) / 2);
      const on = gx >= 0 && gx < 5 && gy >= 0 && gy < 7 && x >= 3 && y >= 1 && g[gy * 5 + gx] === '1';
      const border = x === 0 || y === 0 || x === 15 || y === 15;
      px(x, y, on ? (y < 8 ? [255, 250, 232] : [255, 236, 196]) : border ? [44, 56, 96] : [26, 34, 64]);
    }
  };
}

const REGION_PAINTERS: Record<string, Painter> = {
  curtain_teal: curtain(0x9fe3dc, 0x2f7f86, 0xd4dcdc), curtain_blue: curtain(0x9cc4f0, 0x23508f, 0xc8d0dc),
  curtain_gold: curtain(0xf2d79a, 0x8a6430, 0x5a4a38), curtain_dark: curtain(0x6a7f96, 0x1a2430, 0x384450),
  helipad: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const d = Math.hypot(x - 7.5, y - 7.5); const H = (x === 5 || x === 10) && y >= 4 && y <= 11 || (y === 7 || y === 8) && x >= 5 && x <= 10; px(x, y, H ? [250, 250, 250] : d > 6.4 && d < 7.6 ? [250, 210, 40] : jit([76, 80, 88], r, 0.06)); } },
  limestone: (px, r) => { const c = hex(0xdcd2b8); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const row = y >> 3, off = row % 2 ? 8 : 0; const j = y % 8 === 7 || (x + off) % 16 === 15; px(x, y, j ? mix(c, [90, 80, 60], 0.35) : jit(r() < 0.06 ? mix(c, [150, 140, 110], 0.3) : c, r, 0.04)); } },
  cobble: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const cx = ((x + ((y >> 2) % 2) * 2) % 4), cy = y % 4; const gap = cx === 3 || cy === 3; px(x, y, gap ? [70, 66, 60] : jit(hex(r() < 0.5 ? 0x9a948a : 0x847e74), r, 0.1)); } },
  brick_dark: bricks(0x7e3a2c, 0x4a3a32), brick_tan: bricks(0xc9a46a, 0xece0c8),
  arch_window: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const inArch = x >= 3 && x <= 12 && y >= 3 && (y >= 7 || Math.hypot(x - 7.5, y - 7) <= 4.6); const frame = !inArch && x >= 2 && x <= 13 && y >= 2 && (y >= 6 || Math.hypot(x - 7.5, y - 7) <= 5.8); let k: RGB = jit(hex(((y >> 2) + (x >> 3)) % 2 ? 0xb4553f : 0xa84c38), r, 0.1); if (y % 4 === 3 && !frame && !inArch) k = [216, 203, 184]; if (frame) k = [226, 218, 196]; if (inArch) k = (x === 7 || x === 8 || y === 10) ? [210, 206, 196] : mix([120, 170, 210], [40, 70, 100], y / 15); px(x, y, k); } },
  awning_red: awning(0xd8463e), awning_green: awning(0x3f9a5a), awning_blue: awning(0x3d6fc0), awning_yellow: awning(0xf0c33c),
  iron_rail: each((x, y) => (y <= 1 || y === 14 || (x % 4 === 1 && y > 1)) ? [36, 36, 40] : (y === 7 && x % 4 === 3) ? [36, 36, 40] : T),
  siding_mint: siding(0x9fe0c4), siding_coral: siding(0xf28b7a), siding_lemon: siding(0xf5e07a), siding_sky: siding(0x8cc8ee), siding_lilac: siding(0xc7a6e0), siding_white: siding(0xf2f0ea),
  tin_roof: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const rib = x % 4; let k = mix(hex(0xc2c9cf), hex(0x8a939b), rib === 0 ? 0.9 : rib === 1 ? 0 : rib === 2 ? 0.25 : 0.6); if (r() < 0.04) k = mix(k, [150, 100, 70], 0.35); px(x, y, jit(k, r, 0.03)); } },
  picket: each((x, y) => { const p = x % 4; const post = (p === 1 || p === 2) && (y >= 2 || (y === 1 && p === 1)); if (post) return y === 15 ? [200, 200, 196] : [244, 244, 240]; if (y === 5 || y === 11) return [228, 228, 224]; return T; }),
  barn_red: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { let k = jit(hex(0xa8322a), r, 0.08); if (x % 4 === 0) k = mix(k, [0, 0, 0], 0.3); if (r() < 0.03) k = mix(k, [200, 160, 140], 0.3); px(x, y, k); } },
  silo_blue: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, jit(mix(hex(0x3a64a0), hex(0x22406a), (x % 8) / 8), r, 0.04)); },
  silo_stave: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, jit(y % 5 === 4 ? hex(0x8a8478) : x % 8 === 0 ? hex(0xb8b0a0) : hex(0xd2cbbb), r, 0.05)); },
  hay_top: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const d = Math.hypot(x - 7.5, y - 7.5); px(x, y, jit(Math.floor(d) % 2 ? hex(0xe0bf62) : hex(0xc9a348), r, 0.1)); } },
  hay_side: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, jit((y + (x >> 2)) % 3 ? hex(0xdcb85a) : hex(0xb8963c), r, 0.12)); },
  fence: each((x, y) => (x <= 1 || x >= 14) ? [120, 88, 56] : (y >= 3 && y <= 4) || (y >= 10 && y <= 11) ? [146, 108, 70] : T),
  orange_leaves: (px, r) => { const a = hex(0x3f8a36), b = hex(0x2a6428); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const fruit = ((x * 7 + y * 3) % 11 === 0) || ((x * 5 + y * 9) % 13 === 0); px(x, y, r() < 0.06 ? T : fruit ? (y % 2 ? [250, 150, 30] : [255, 180, 60]) : mix(a, b, r())); } },
  corn: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const stalk = x % 5 === 2; const leaf = (x % 5 === 3 || x % 5 === 1) && (y % 6 === 2 || y % 6 === 3); const cob = x % 5 === 3 && y >= 6 && y <= 9; px(x, y, cob ? [236, 206, 90] : stalk ? jit(hex(0x8fb24a), r, 0.1) : leaf ? jit(hex(0x6f9a3a), r, 0.1) : T); } },
  veg: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const leaf = y > 7 && Math.abs(((x * 3 + y) % 8) - 4) < 3; const fruit = y > 9 && (x * 5 + y * 7) % 17 === 0; px(x, y, fruit ? [220, 50, 40] : leaf ? jit(hex(0x4f9a3c), r, 0.15) : T); } },
  flowers_blue: (px) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const stem = x % 5 === 2 && y > 6; const bloom = x % 5 > 0 && x % 5 < 4 && y > 3 && y < 7; px(x, y, bloom ? (x < 8 ? [110, 120, 230] : [180, 120, 230]) : stem ? [70, 150, 60] : T); } },
  flowers_white: (px) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const stem = x % 4 === 1 && y > 8; const bloom = x % 4 < 3 && y > 5 && y < 9; px(x, y, bloom ? ((x % 4 === 1 && y === 7) ? [250, 210, 60] : [246, 246, 240]) : stem ? [80, 150, 70] : T); } },
  mossy_stone_top: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, r() < 0.55 ? jit(hex(0x5f8a4a), r, 0.15) : jit(hex(0x8e9196), r, 0.15)); },
  mossy_stone: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, (y < 3 + (x % 3) && r() < 0.8) ? jit(hex(0x5f8a4a), r, 0.15) : jit(hex(0x858a8c), r, r() < 0.1 ? 0.5 : 0.12)); },
  granite: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const v = r(); px(x, y, v < 0.15 ? [70, 66, 66] : v < 0.3 ? [196, 170, 160] : jit(hex(0x9c8f88), r, 0.1)); } },
  mangrove_root: each((x, y) => { const a = Math.abs(x - 4 - Math.sin(y * 0.6) * 2) < 1.2, b = Math.abs(x - 11 + Math.sin(y * 0.5) * 2) < 1.2, c = Math.abs(x + y * 0.6 - 14) < 1; return a || b || c ? (y % 3 ? [106, 74, 48] : [84, 58, 38]) : T; }),
  mangrove_leaves: (px, r) => { const a = hex(0x2f6a34), b = hex(0x4a8a3c); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, r() < 0.12 ? T : mix(a, b, r() * 0.9)); },
  seagrass: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, (x * 3 + y) % 5 === 0 || r() < 0.35 ? jit(hex(0x5a8a48), r, 0.2) : jit(hex(0xd8c896), r, 0.08)); },
  coral_pink: coral(0xff9ab8, 0xe0607e), coral_orange: coral(0xffb060, 0xe07a2a), coral_purple: coral(0xc890f0, 0x8a4ac0),
  bark: (px, r) => { const a = hex(0x5b4330); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const fur = (x + Math.floor(Math.sin(y * 0.5 + x) * 1.5)) % 4 === 0; px(x, y, jit(fur ? mix(a, [0, 0, 0], 0.35) : a, r, 0.12)); } },
  bark_top: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const d = Math.hypot(x - 7.5, y - 7.5); px(x, y, jit(d > 6.5 ? hex(0x4a3524) : Math.floor(d) % 2 ? hex(0xb08a5a) : hex(0x9a7448), r, 0.08)); } },
  spruce_leaves: (px, r) => { const a = hex(0x24503a), b = hex(0x173a2a); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, r() < 0.07 ? T : mix(a, b, r())); },
  moss: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const strand = x % 3 === 1 && y < 6 + ((x * 7) % 10); px(x, y, strand ? jit(hex(0x9aa58a), r, 0.15) : T); } },
  crane_yellow: lattice(0xf0b428), truss: lattice(0xa8b0b8), truss_red: lattice(0xd0482e),
  coaster_top: each((x) => (x <= 2 || x >= 13) ? [200, 200, 210] : x % 4 === 0 ? [90, 60, 40] : [216, 58, 90]),
  coaster_side: each((x, y) => y <= 3 ? [216, 58, 90] : y === 4 ? [140, 30, 50] : (x % 5 === 2 && y < 12) ? [216, 58, 90] : y >= 12 ? [200, 200, 210] : [216, 58, 90]),
  rocket_white: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, y === 0 || (x === 8 && y % 8 < 6) ? [200, 202, 206] : jit([242, 242, 240], r, 0.02)); },
  rocket_band: each((x, y) => ((x >> 2) + (y >> 3)) % 2 ? [30, 30, 34] : [242, 242, 240]),
  rocket_tank: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, jit(y % 8 === 0 ? hex(0xb05a20) : hex(0xd9772e), r, 0.07)); },
  dish: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, x % 8 === 0 || y % 8 === 0 ? [200, 206, 212] : jit([238, 242, 245], r, 0.02)); },
  chainlink: each((x, y) => ((x + y) % 4 === 0 || (x - y + 16) % 4 === 0) ? [168, 176, 182] : (y === 0 ? [140, 146, 152] : T)),
  court_green: courtTile(0x3f8a5a), court_blue: courtTile(0x3a6ab0), court_red: courtTile(0xb05a40), court_line: courtTile(0xf2f2f2),
  pump: (px) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const screen = x >= 4 && x <= 11 && y >= 3 && y <= 6; const nozzle = x >= 12 && y >= 8 && y <= 12; px(x, y, screen ? [40, 50, 60] : nozzle ? [30, 30, 30] : y < 2 ? [240, 240, 240] : [216, 74, 58]); } },
  neon_yellow: neon([255, 226, 74], [255, 190, 40]), neon_green: neon([90, 255, 138], [40, 210, 90]), neon_orange: neon([255, 138, 58], [240, 96, 30]), neon_purple: neon([190, 110, 255], [140, 60, 230]),
  clock: (px) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const d = Math.hypot(x - 7.5, y - 7.5); const hand = (x === 7 || x === 8) && y >= 3 && y <= 8 || (y === 7 || y === 8) && x >= 7 && x <= 11; const tick = d > 5.2 && d < 6.2 && ((x === 7 || x === 8) || (y === 7 || y === 8)); px(x, y, d > 6.8 ? [214, 206, 184] : hand || tick ? [30, 30, 36] : d > 6 ? [180, 150, 70] : [246, 242, 226]); } },
  stained_glass: (px) => { const cols: RGB[] = [[200, 60, 70], [60, 110, 200], [240, 190, 60], [80, 170, 90], [150, 80, 190]]; for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const lead = x % 4 === 0 || y % 5 === 0 || x === 15; px(x, y, lead ? [40, 36, 40] : cols[((x >> 2) * 3 + Math.floor(y / 5) * 2) % 5]); } },
  copper_roof: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, jit(x % 4 === 0 ? hex(0x4f8a78) : r() < 0.1 ? hex(0x9ad0bc) : hex(0x6fae9a), r, 0.06)); },
  slate_roof: shingles(0x4a4f58, 0.4), shingle_brown: shingles(0x7a5640), shingle_grey: shingles(0x6c7076), shingle_green: shingles(0x4a6a4a),
  stucco_cream: stucco(0xf0e1c0), stucco_ochre: stucco(0xdca85a), stucco_lavender: stucco(0xc9b4ea), stucco_mint: stucco(0xa8ecd0), stucco_sky: stucco(0x9cd4f4),
  fairway: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, jit((x >> 2) % 2 ? hex(0x6cc050) : hex(0x58a842), r, 0.04)); },
  putting: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, jit(((x + y) >> 3) % 2 ? hex(0x86da64) : hex(0x78cc58), r, 0.03)); },
  flag: each((x, y) => (x <= 1 ? [230, 230, 230] : (y >= 1 && y <= 7 && x <= 14 - (y > 4 ? (y - 4) * 2 : 0)) ? [226, 58, 58] : T)),
  fan_cage: each((x, y) => { const d = Math.hypot(x - 7.5, y - 7.5); return (Math.abs(d - 7) < 0.7 || Math.abs(d - 4) < 0.6 || x === 7 || y === 7) ? [60, 64, 70] : (Math.abs(x - y) < 1 && d < 4) ? [120, 120, 126] : T; }),
  boat_deck: planks(0xc8a070, 0.7),
  hull_white: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, y >= 12 ? [40, 90, 170] : y === 3 ? [40, 90, 170] : jit([242, 242, 240], r, 0.02)); },
  hull_blue: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, y >= 13 ? [180, 50, 40] : y === 2 ? [240, 240, 240] : jit(hex(0x2a5aa8), r, 0.05)); },
  plane_top: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, jit([236, 238, 242], r, 0.02)); },
  fuselage: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const win = y >= 5 && y <= 7 && x % 4 !== 0; px(x, y, win ? [40, 60, 90] : y >= 11 ? [200, 206, 214] : y === 9 ? [42, 106, 208] : jit([246, 246, 248], r, 0.015)); } },
  plane_tail: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, (x + y) % 12 < 3 ? [255, 200, 60] : jit(hex(0x2a6ad0), r, 0.04)); },
  light_blue: light([80, 150, 255]), light_red: light([255, 60, 60]), light_green: light([60, 255, 110]),
  mural_a: each((x, y) => { const sky = mix([255, 120, 90], [255, 214, 110], y / 10); if (Math.hypot(x - 10, y - 6) < 3) return [255, 240, 170]; const trunk = Math.abs(x - 4 - (y - 8) * 0.25) < 0.8 && y > 6; const frond = y < 7 && Math.abs(Math.abs(x - 4) - (7 - y) * 0.9) < 0.8; if (trunk || frond) return [40, 30, 50]; return y > 12 ? [60, 160, 190] : sky; }),
  mural_b: each((x, y) => { const cols: RGB[] = [[40, 180, 200], [250, 200, 60], [240, 90, 120], [90, 70, 180]]; const k = Math.floor((x + y * 0.6) / 4) % 4; return Math.abs((x * 2 + y) % 9 - 4) < 1 ? [250, 250, 245] : cols[(k + 4) % 4]; }),
  // abstract muralled walls (original patterns: no figures, no lettering)
  mural_c: each((x, y) => { const d1 = Math.hypot(x - 5, y - 6), d2 = Math.hypot(x - 11, y - 10); const bg: RGB = [250, 232, 200]; if (d1 < 3) return [226, 62, 112]; if (d1 < 4.6) return [250, 160, 60]; if (d2 < 2.6) return [40, 120, 190]; if (d2 < 4.2) return [252, 236, 120]; return (x + y) % 8 < 1 ? [60, 40, 90] : bg; }),
  mural_d: each((x, y) => { const w = Math.sin(x * 0.55 + y * 0.35) * 2.2; const k = Math.floor((y + w + 8) / 3) % 5; const cols: RGB[] = [[30, 150, 130], [60, 200, 170], [250, 250, 240], [240, 120, 90], [250, 200, 70]]; return cols[(k + 5) % 5]; }),
  mural_e: each((x, y) => { const tri = (y > x - 2 && y > 14 - x) ? 1 : 0; const dia = Math.abs(x - 8) + Math.abs(y - 6) < 4; if (dia) return [250, 90, 120]; if (tri) return [70, 60, 160]; return (x * 3 + y) % 11 < 3 ? [255, 214, 80] : [90, 200, 220]; }),
  roof_white: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, (x === 0 || y === 0) ? [200, 204, 202] : jit([232, 234, 230], r, 0.03)); },
  roof_dark: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, (x === 0 || y === 0) ? [58, 60, 64] : jit([74, 76, 80], r, 0.06)); },
  castle_stone: (px, r) => { const c = hex(0xece4f4); for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const row = y >> 2, off = row % 2 ? 4 : 0; const j = y % 4 === 3 || (x + off) % 8 === 7; px(x, y, j ? [196, 186, 214] : jit(c, r, 0.03)); } },
  castle_roof: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const sc = (y % 4 === 3) || ((x + ((y >> 2) % 2) * 2) % 4 === 0 && y % 4 === 2); px(x, y, sc ? [36, 60, 150] : jit(hex(0x4a70d8), r, 0.06)); } },
  gold_trim: (px) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const v = Math.sin((x + y) * 0.7) * 0.5 + 0.5; px(x, y, mix([200, 150, 40], [255, 226, 120], v)); } },
  panel_white: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, x === 0 || y === 0 ? [196, 200, 206] : jit([232, 234, 236], r, 0.02)); },
  panel_grey: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, x === 0 || y === 0 ? [120, 126, 134] : jit([156, 162, 170], r, 0.03)); },
  log_wall: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const yy = y % 5; px(x, y, jit(yy === 0 ? hex(0x4a3020) : yy === 1 || yy === 4 ? hex(0x7a4e2c) : hex(0x956238), r, 0.08)); } },
  log_top: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const d = Math.hypot(x - 7.5, y - 7.5); px(x, y, jit(d > 7 ? hex(0x5a3a22) : Math.floor(d) % 2 ? hex(0xc49a64) : hex(0xb08654), r, 0.06)); } },
  cedar_shingle: shingles(0x6a4630, 0.3),
  lumber_side: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, jit(y % 4 === 3 ? hex(0x9a7444) : hex(0xd8b070), r, 0.06)); },
  lumber_top: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, (x % 4 === 3 || y % 4 === 3) ? [120, 90, 54] : jit(hex(0xe2c088), r, 0.05)); },
  pool_tile: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, (x % 4 === 0 || y % 4 === 0) ? [200, 236, 246] : jit(hex(0x6ac4e2), r, 0.04)); },
  path: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const v = r(); px(x, y, v < 0.1 ? [150, 130, 100] : v < 0.16 ? [210, 196, 160] : jit(hex(0xb89a6a), r, 0.08)); } },
  sea_oats: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const stem = x % 4 === 1 && y > 3; const head = (x % 4 === 1 || x % 4 === 2) && y <= 4 && y >= 1; px(x, y, head ? [200, 170, 110] : stem ? jit(hex(0xbfb880), r, 0.15) : T); } },
  palmetto: (px) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const a = Math.atan2(y - 15, x - 7.5); const d = Math.hypot(x - 7.5, y - 15); const blade = d < 14 && Math.abs(Math.sin(a * 6)) > 0.55 && y < 14; px(x, y, blade ? (Math.abs(Math.sin(a * 6)) > 0.85 ? [96, 150, 70] : [62, 120, 56]) : (x === 7 || x === 8) && y > 12 ? [90, 80, 50] : T); } },
  container_green: container(0x2f7a4a, 0x22603a), container_orange: container(0xe07a2a, 0xb05a1a), container_white: container(0xdcdcd6, 0xb0b0aa), container_yellow: container(0xe8c030, 0xb89418),
  food_truck: (px) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const hatch = x >= 2 && x <= 13 && y >= 4 && y <= 10; const menu = hatch && y <= 5; const shelf = y === 11; px(x, y, menu ? [250, 210, 60] : hatch ? (y % 3 === 0 ? [180, 120, 60] : [50, 40, 36]) : shelf ? [200, 200, 205] : y < 3 ? [255, 90, 120] : [244, 244, 240]); } },
  tire: (px) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const d = Math.hypot(x - 7.5, y - 7.5); px(x, y, d < 3 ? [170, 174, 180] : (x + y) % 3 === 0 ? [44, 44, 48] : [30, 30, 34]); } },
  scaffold: each((x, y) => (x <= 1 || x >= 14 || y <= 1 || y === 8) ? [140, 150, 160] : (y >= 13 && y <= 14) ? [176, 136, 80] : T),
  solar: (px) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, (x % 4 === 0 || y % 4 === 0) ? [190, 196, 204] : ((x + y) % 7 === 0 ? [80, 110, 170] : [30, 50, 96])); },
  ac_top: (px) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const d = Math.hypot(x - 7.5, y - 7.5); px(x, y, d < 6 ? ((Math.floor(Math.atan2(y - 7.5, x - 7.5) * 3) + 6) % 2 ? [70, 74, 80] : [110, 114, 120]) : [196, 200, 204]); } },
  ac_side: (px) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, (y % 3 === 0 && x > 1 && x < 14) ? [150, 154, 160] : [204, 208, 212]); },
  sign_panel: (px, r) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) px(x, y, x === 0 || y === 0 || x === 15 || y === 15 ? [44, 56, 96] : jit([26, 34, 64], r, 0.05)); },
};
for (const ch of Object.keys(FONT)) REGION_PAINTERS[`letter_${ch.toLowerCase()}`] = letter(ch);
Object.assign(P, REGION_PAINTERS);

/** Index of tiles whose black pixels are transparent (cutout/cross). */
export const CUTOUT_TILES = new Set(['leaves', 'palm_leaves', 'pine_leaves', 'reeds', 'flowers', 'cane', 'tall_grass',
  'iron_rail', 'picket', 'fence', 'orange_leaves', 'corn', 'veg', 'flowers_blue', 'flowers_white', 'mangrove_root', 'mangrove_leaves',
  'spruce_leaves', 'moss', 'crane_yellow', 'truss', 'truss_red', 'chainlink', 'flag', 'fan_cage', 'light_blue', 'light_red', 'light_green',
  'sea_oats', 'palmetto', 'scaffold']);
export const GLOW_TILES = new Set(['neon_pink', 'neon_cyan', 'lamp', 'screen', 'club_floor', 'arcade', 'neon_yellow', 'neon_green', 'neon_orange', 'neon_purple', 'light_blue', 'light_red', 'light_green', 'stained_glass']);

// ───────────────────────────────────────────── layer layout (pure data: also used by the mesher worker)

/** tiles the photographic pack supplies; their layers cover 2×2 blocks (per-block graphics are painted per quadrant) */
export const PHOTO_TILES = new Set([
  'asphalt', 'runway', 'concrete', 'sidewalk', 'sand', 'dirt', 'path', 'mud', 'gravel', 'stone', 'cobble', 'granite', 'limestone', 'marble',
  'counter_top', 'mossy_stone_top', 'mossy_stone', 'grass_top', 'fairway', 'putting', 'grass_side', 'seagrass', 'farmland',
  'line_white', 'line_yellow', 'helipad', 'court_green', 'court_blue', 'court_red', 'court_line',
  'stucco_white', 'stucco_pink', 'stucco_teal', 'stucco_yellow', 'stucco_peach', 'red_stucco', 'police_blue', 'stucco_cream', 'stucco_ochre',
  'stucco_lavender', 'stucco_mint', 'stucco_sky', 'brick', 'brick_dark', 'brick_tan', 'castle_stone', 'pool_tile', 'tile_floor',
  'roof_tile', 'slate_roof', 'shingle_brown', 'shingle_grey', 'shingle_green', 'cedar_shingle', 'copper_roof', 'tin_roof',
  'container_red', 'container_blue', 'container_green', 'container_orange', 'container_white', 'container_yellow', 'silo_blue', 'shutter', 'metal', 'silo_stave',
  'plank', 'dark_plank', 'dock', 'boat_deck', 'siding_mint', 'siding_coral', 'siding_lemon', 'siding_sky', 'siding_lilac', 'siding_white',
  'barn_red', 'bark', 'palm_log', 'log_wall', 'lumber_side', 'lumber_top', 'crate', 'log_top', 'bark_top', 'palm_log_top', 'hay_side', 'hay_top',
  'carpet', 'awning_red', 'awning_green', 'awning_blue', 'awning_yellow', 'sofa_top', 'coral_pink', 'coral_orange', 'coral_purple',
]);
/** seamless variant layers per large ground material (must match the pack manifest) */
export const VARIANT_COUNTS: Record<string, number> = { grass_top: 2, sand: 2, dirt: 2, asphalt: 2, sidewalk: 2, concrete: 1, stone: 1, gravel: 1, mud: 1, path: 1, runway: 1 };
/** stochastic one-block tiles rotated by a random multiple of 90° per block */
export const ROTATE_TILES = new Set(['leaves', 'pine_leaves', 'spruce_leaves', 'mangrove_leaves', 'orange_leaves', 'hedge']);

export interface TileLayout {
  /** total layers (TILE_NAMES + appended variants) */
  count: number;
  /** blocks covered by one layer, per layer */
  repeat: Uint8Array;
  /** 1 = random 90° rotation per block */
  rotate: Uint8Array;
  /** extra variant layers per base tile index */
  variants: number[][];
}
let layoutCache: TileLayout | null = null;
export function tileLayout(): TileLayout {
  if (layoutCache) return layoutCache;
  const n = TILE_NAMES.length;
  const variants: number[][] = TILE_NAMES.map(() => []);
  const base: number[] = [];
  let count = n;
  for (const [name, k] of Object.entries(VARIANT_COUNTS)) {
    const i = TILE_INDEX[name];
    if (i === undefined) continue;
    for (let j = 0; j < k; j++) { variants[i].push(count++); base.push(i); }
  }
  const repeat = new Uint8Array(count).fill(1), rotate = new Uint8Array(count);
  TILE_NAMES.forEach((name, i) => { if (PHOTO_TILES.has(name)) repeat[i] = 2; if (ROTATE_TILES.has(name)) rotate[i] = 1; });
  base.forEach((b, j) => { repeat[n + j] = repeat[b]; });
  return (layoutCache = { count, repeat, rotate, variants });
}

// ───────────────────────────────────────────── material response per tile

export interface MatProps { rough: number; gloss: number; nstr: number; grain: number }
/** roughness / gloss mask / normal strength / grain for a tile (gloss ≈0.5 marks puddle-capable roads) */
export function matProps(name: string): MatProps {
  if (/^(asphalt|runway|line_)/.test(name)) return { rough: 0.6, gloss: 0.5, nstr: 1.4, grain: 0.05 };
  if (GLOW_TILES.has(name) || /^letter_|^neon|sign_panel/.test(name)) return { rough: 0.3, gloss: 1, nstr: 0.6, grain: 0.012 };
  if (/chrome/.test(name)) return { rough: 0.1, gloss: 1, nstr: 0.4, grain: 0.015 };
  if (/glass|window|curtain/.test(name)) return { rough: 0.06, gloss: 1, nstr: 0.6, grain: 0.015 };
  if (/panel_|hull_|fuselage|plane_|rocket_|dish|solar|fridge|stove|safe|pump|food_truck|ac_|gold_trim|coaster|stool|police/.test(name)) return { rough: 0.32, gloss: 1, nstr: 1.2, grain: 0.03 };
  if (/metal|truss|crane|scaffold|chainlink|iron_rail|fan_cage|^rail|shutter|container|tin_roof|copper|silo_blue/.test(name)) return { rough: 0.45, gloss: 1, nstr: 1.4, grain: 0.04 };
  if (/marble|tile_floor|pool_tile|counter|club_floor|court_/.test(name)) return { rough: 0.28, gloss: 1, nstr: 1.0, grain: 0.03 };
  if (/leaves|hedge|grass|reeds|flowers|cane|corn|veg|oats|palmetto|moss/.test(name)) return { rough: 0.6, gloss: 1, nstr: 1.6, grain: 0.07 };
  if (/plank|log|lumber|crate|dock|deck|bark|fence|picket|siding|barn|shelf|bed|sofa|carpet|awning|hay|tire/.test(name)) return { rough: 0.75, gloss: 1, nstr: 1.5, grain: 0.06 };
  return { rough: 0.85, gloss: 1, nstr: 1.5, grain: 0.06 };
}

// ───────────────────────────────────────────── hi-res helpers

const S = TILE;
type RGBA = Uint8ClampedArray;
/** hi-res painter output in image space (row 0 = top) */
interface HiTile { rgba: RGBA; gloss?: Float32Array; height?: Float32Array }
type HiPainter = (r: () => number) => HiTile;

const css = (c: RGB, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
let scratch: CanvasRenderingContext2D | null = null;
function canvasTile(draw: (g: CanvasRenderingContext2D, r: () => number) => void): HiPainter {
  return (r) => {
    if (!scratch) {
      const c = document.createElement('canvas'); c.width = c.height = S;
      scratch = c.getContext('2d', { willReadFrequently: true })!;
    }
    const g = scratch;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, S, S);
    g.globalAlpha = 1; g.shadowBlur = 0; g.shadowColor = 'transparent'; g.lineCap = 'round'; g.lineJoin = 'round';
    draw(g, r);
    return { rgba: new Uint8ClampedArray(g.getImageData(0, 0, S, S).data) };
  };
}
function pixelTile(f: (u: number, v: number, x: number, y: number) => [RGB, number, number]): HiPainter {
  // f returns [colour, gloss, height]
  return () => {
    const rgba = new Uint8ClampedArray(S * S * 4), gloss = new Float32Array(S * S), height = new Float32Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const [c, gl, h] = f((x + 0.5) / S, (y + 0.5) / S, x, y);
      const o = (y * S + x) * 4;
      rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255;
      gloss[y * S + x] = gl; height[y * S + x] = h;
    }
    return { rgba, gloss, height };
  };
}
/** draw something at every wrapped offset so the tile stays seamless */
function wrapDraw(fn: (dx: number, dy: number) => void) { for (const dy of [-S, 0, S]) for (const dx of [-S, 0, S]) fn(dx, dy); }
const sstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// signs and letters
function signBack(g: CanvasRenderingContext2D) {
  const gr = g.createLinearGradient(0, 0, 0, S); gr.addColorStop(0, '#26305a'); gr.addColorStop(1, '#141a36');
  g.fillStyle = gr; g.fillRect(0, 0, S, S);
  g.strokeStyle = '#46558c'; g.lineWidth = S * 0.045; g.strokeRect(S * 0.022, S * 0.022, S * 0.956, S * 0.956);
  g.strokeStyle = '#0c1024'; g.lineWidth = S * 0.018; g.strokeRect(S * 0.06, S * 0.06, S * 0.88, S * 0.88);
  g.fillStyle = '#8a96c0';
  for (const [x, y] of [[0.08, 0.08], [0.92, 0.08], [0.08, 0.92], [0.92, 0.92]]) { g.beginPath(); g.arc(x * S, y * S, S * 0.014, 0, Math.PI * 2); g.fill(); }
}
function letterHi(ch: string): HiPainter {
  return canvasTile((g) => {
    signBack(g);
    g.font = `900 ${Math.round(S * 0.72)}px "Arial Black","Segoe UI Black","Helvetica Neue",Arial,sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    const m = g.measureText(ch);
    const h = (m.actualBoundingBoxAscent ?? S * 0.5) - (m.actualBoundingBoxDescent ?? 0);
    const y = S / 2 + h / 2;
    g.shadowColor = 'rgba(255,214,150,0.85)'; g.shadowBlur = S * 0.07;
    const lg = g.createLinearGradient(0, S * 0.15, 0, S * 0.85); lg.addColorStop(0, '#fffcf2'); lg.addColorStop(1, '#ffe0aa');
    g.fillStyle = lg; g.fillText(ch, S / 2, y);
    g.shadowBlur = 0; g.lineWidth = S * 0.012; g.strokeStyle = 'rgba(150,110,60,0.6)'; g.strokeText(ch, S / 2, y);
  });
}
// neon light boxes
function neonHi(core: RGB, rim: RGB, band: boolean): HiPainter {
  return canvasTile((g) => {
    const gr = g.createLinearGradient(0, 0, 0, S); gr.addColorStop(0, css(mix(rim, [255, 255, 255], 0.08))); gr.addColorStop(1, css(mix(rim, [0, 0, 0], 0.12)));
    g.fillStyle = gr; g.fillRect(0, 0, S, S);
    g.shadowColor = css(core); g.shadowBlur = S * 0.12;
    g.strokeStyle = css(core); g.lineWidth = S * 0.2;
    if (band) { g.beginPath(); g.moveTo(-S, S / 2); g.lineTo(2 * S, S / 2); g.stroke(); }
    else { g.beginPath(); g.roundRect(S * 0.22, S * 0.22, S * 0.56, S * 0.56, S * 0.14); g.stroke(); }
    g.shadowBlur = S * 0.05; g.strokeStyle = css(mix(core, [255, 255, 255], 0.75)); g.lineWidth = S * 0.07;
    if (band) { g.beginPath(); g.moveTo(-S, S / 2); g.lineTo(2 * S, S / 2); g.stroke(); }
    else { g.beginPath(); g.roundRect(S * 0.22, S * 0.22, S * 0.56, S * 0.56, S * 0.14); g.stroke(); }
    g.shadowBlur = 0; g.strokeStyle = css(mix(rim, [0, 0, 0], 0.35)); g.lineWidth = S * 0.03; g.strokeRect(0, 0, S, S);
  });
}
// glazing
function windowHi(frame: number, top: number, bot: number): HiPainter {
  const f = hex(frame), a = hex(top), b = hex(bot);
  const fw = 0.055;
  return pixelTile((u, v) => {
    const du = Math.min(u, 1 - u), dv = Math.min(v, 1 - v), dm = Math.abs(u - 0.5);
    const d = Math.min(du, dv, dm + fw * 0.4);
    if (d < fw) {
      // bevelled frame: light top/left, darker bottom/right
      const shade = d < fw * 0.35 ? 1.06 : (v > 1 - fw || u > 1 - fw || (dm < fw * 0.6 && u > 0.5)) ? 0.86 : 0.97;
      return [[f[0] * shade, f[1] * shade, f[2] * shade], 0.08, 1 - d / fw * 0.3];
    }
    let k = mix(a, b, sstep(0.04, 1, v));
    const s = (u * 0.9 + v * 1.1) % 0.62;
    const streak = sstep(0.0, 0.05, s) * (1 - sstep(0.07, 0.16, s)) * (1 - sstep(0.15, 0.75, v));
    k = mix(k, [236, 246, 255], streak * 0.45);
    k = mix(k, [255, 255, 255], (1 - sstep(0, 0.12, Math.min(du, dv, dm) - fw)) * 0.08);
    return [k, 1, 0];
  });
}
function glassHi(): HiPainter {
  return pixelTile((u, v) => {
    const d = Math.min(u, 1 - u, v, 1 - v);
    if (d < 0.03) return [[222, 236, 242], 0.5, 1];
    const s = (u - v + 1) % 1;
    const streak = sstep(0.18, 0.22, s) * (1 - sstep(0.26, 0.34, s)) + sstep(0.38, 0.4, s) * (1 - sstep(0.42, 0.44, s)) * 0.6;
    return [mix([166, 212, 232], [240, 250, 255], streak * 0.7), 1, 0];
  });
}
function curtainHi(top: number, bot: number, frame: number, seed: number): HiPainter {
  const a = hex(top), b = hex(bot), f = hex(frame);
  const lit = rng(seed);
  const pane = [lit() < 0.12, lit() < 0.12, lit() < 0.12, lit() < 0.12];
  return pixelTile((u, v) => {
    const pu = (u * 2) % 1, pv = (v * 2) % 1;
    const du = Math.min(pu, 1 - pu), dv = Math.min(pv, 1 - pv);
    const w = 0.045;
    if (du < w || dv < w) return [jitless(f, du < w * 0.4 || dv < w * 0.4 ? 1.08 : 0.9), 0.1, 1];
    const p = (u < 0.5 ? 0 : 1) + (v < 0.5 ? 0 : 2);
    let k = mix(a, b, sstep(0, 1, pv) * 0.8 + pu * 0.08);
    const s = (pu * 0.9 + pv) % 0.9;
    k = mix(k, [250, 252, 255], sstep(0.05, 0.1, s) * (1 - sstep(0.12, 0.22, s)) * 0.3);
    if (pane[p]) k = mix(k, [255, 232, 180], 0.28 * (1 - pv * 0.5));
    return [k, 1, 0];
  });
}
const jitless = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
function screenHi(): HiPainter {
  return pixelTile((u, v) => {
    const d = Math.min(u, 1 - u, v, 1 - v);
    if (d < 0.06) return [d < 0.02 ? [52, 52, 60] : [26, 26, 32], 0.6, 1];
    let k = mix([36, 96, 210], [110, 210, 255], sstep(0.06, 0.94, v));
    if ((v > 0.2 && v < 0.26 && u < 0.7) || (v > 0.34 && v < 0.38 && u < 0.55) || (v > 0.46 && v < 0.5 && u < 0.62)) k = mix(k, [235, 248, 255], 0.55);
    if (u > 0.68 && u < 0.88 && v > 0.58 && v < 0.86) k = mix(k, [255, 210, 90], 0.6);
    k = jitless(k, Math.floor(v * S) % 3 === 0 ? 0.92 : 1);
    return [k, 1, 0];
  });
}
function lampHi(): HiPainter {
  return pixelTile((u, v) => {
    const d = Math.min(u, 1 - u, v, 1 - v);
    if (d < 0.05) return [[70, 72, 78], 0.4, 1];
    const r = Math.hypot(u - 0.5, v - 0.5);
    const k = mix([255, 248, 222], [248, 200, 120], sstep(0.05, 0.62, r));
    return [jitless(k, 1 - (Math.floor(u * 8) === 4 || Math.floor(v * 8) === 4 ? 0.05 : 0)), 1, 0.2];
  });
}
// foliage
function foliageHi(a: number, b: number, opts: { holes: boolean; count: number; size: number; needle?: boolean; fruit?: RGB[]; bg?: number }): HiPainter {
  return canvasTile((g, r) => {
    const ca = hex(a), cb = hex(b);
    if (!opts.holes) { g.fillStyle = css(mix(cb, [0, 0, 0], 0.35)); g.fillRect(0, 0, S, S); }
    for (let i = 0; i < opts.count; i++) {
      const x = r() * S, y = r() * S, ang = r() * Math.PI * 2, sz = opts.size * (0.7 + r() * 0.6);
      const c = mix(ca, cb, r());
      const lit = 0.75 + r() * 0.45;
      wrapDraw((dx, dy) => {
        const px = x + dx, py = y + dy;
        if (px < -sz * 2 || px > S + sz * 2 || py < -sz * 2 || py > S + sz * 2) return;
        g.save(); g.translate(px, py); g.rotate(ang);
        if (opts.needle) {
          g.strokeStyle = css(jitless(c, lit)); g.lineWidth = 1.6;
          for (let k = -2; k <= 2; k++) { g.beginPath(); g.moveTo(0, 0); g.lineTo(sz * Math.cos(k * 0.35), sz * Math.sin(k * 0.35)); g.stroke(); }
        } else {
          g.fillStyle = css(jitless(c, lit));
          g.beginPath(); g.ellipse(0, 0, sz, sz * 0.46, 0, 0, Math.PI * 2); g.fill();
          g.strokeStyle = css(jitless(c, lit * 0.7)); g.lineWidth = 0.9;
          g.beginPath(); g.moveTo(-sz * 0.85, 0); g.lineTo(sz * 0.85, 0); g.stroke();
        }
        g.restore();
      });
    }
    if (opts.fruit) for (let i = 0; i < 9; i++) {
      const x = r() * S, y = r() * S, c = opts.fruit[i % opts.fruit.length];
      wrapDraw((dx, dy) => {
        const gr = g.createRadialGradient(x + dx - 2, y + dy - 2, 1, x + dx, y + dy, 6);
        gr.addColorStop(0, css(mix(c, [255, 255, 255], 0.35))); gr.addColorStop(1, css(mix(c, [0, 0, 0], 0.25)));
        g.fillStyle = gr; g.beginPath(); g.arc(x + dx, y + dy, 5.5, 0, Math.PI * 2); g.fill();
      });
    }
  });
}
function palmHi(): HiPainter {
  return canvasTile((g, r) => {
    const a = hex(0x5fb84a), b = hex(0x357f30);
    for (let k = -1; k < 4; k++) {
      const off = k * S / 2.5 + r() * 6;
      wrapDraw((dx, dy) => {
        if (dy !== 0) return;
        const x0 = off + dx, y0 = S + 4, x1 = off + dx + S, y1 = -4;
        g.strokeStyle = css([150, 140, 70]); g.lineWidth = 2.2; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke();
        for (let t = 0.02; t < 1; t += 0.035) {
          const px = x0 + (x1 - x0) * t, py = y0 + (y1 - y0) * t;
          for (const side of [-1, 1]) {
            const L = 15 + r() * 6;
            const ang = -Math.PI / 4 + side * (1.15 + r() * 0.2);
            g.strokeStyle = css(mix(a, b, r())); g.lineWidth = 3.2 - t;
            g.beginPath(); g.moveTo(px, py); g.quadraticCurveTo(px + Math.cos(ang) * L * 0.6, py + Math.sin(ang) * L * 0.6 + 2, px + Math.cos(ang) * L, py + Math.sin(ang) * L + 5); g.stroke();
          }
        }
      });
    }
  });
}
// cross plants
interface Blade { x: number; h: number; bend: number; w: number; c: RGB }
function bladesHi(colA: number, colB: number, n: number, minH: number, maxH: number, extra?: (g: CanvasRenderingContext2D, r: () => number, blades: Blade[]) => void, width = 4): HiPainter {
  return canvasTile((g, r) => {
    const ca = hex(colA), cb = hex(colB);
    const blades: Blade[] = [];
    for (let i = 0; i < n; i++) blades.push({ x: 6 + r() * (S - 12), h: (minH + r() * (maxH - minH)) * S, bend: (r() - 0.5) * 0.8, w: width * (0.6 + r() * 0.7), c: mix(ca, cb, r()) });
    blades.sort((p, q) => q.h - p.h);
    for (const bl of blades) {
      const tx = bl.x + bl.bend * bl.h * 0.6, ty = S - bl.h;
      const gr = g.createLinearGradient(0, S, 0, ty); gr.addColorStop(0, css(jitless(bl.c, 0.6))); gr.addColorStop(1, css(jitless(bl.c, 1.15)));
      g.fillStyle = gr;
      g.beginPath(); g.moveTo(bl.x - bl.w / 2, S);
      g.quadraticCurveTo(bl.x - bl.w / 2 + bl.bend * bl.h * 0.15, S - bl.h * 0.55, tx, ty);
      g.quadraticCurveTo(bl.x + bl.w / 2 + bl.bend * bl.h * 0.15, S - bl.h * 0.55, bl.x + bl.w / 2, S);
      g.fill();
    }
    extra?.(g, r, blades);
  });
}
function flowersHi(colors: RGB[]): HiPainter {
  return bladesHi(0x4f9a3c, 0x6fb84a, 16, 0.25, 0.55, (g, r) => {
    for (let i = 0; i < 9; i++) {
      const x = 10 + r() * (S - 20), y = S * (0.2 + r() * 0.35), c = colors[i % colors.length], rad = 6 + r() * 4;
      g.strokeStyle = css([70, 140, 60]); g.lineWidth = 2; g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + (r() - 0.5) * 10, (y + S) / 2, x + (r() - 0.5) * 6, S); g.stroke();
      for (let p = 0; p < 5; p++) {
        const a = p / 5 * Math.PI * 2 + r();
        g.fillStyle = css(jitless(c, 0.85 + r() * 0.3));
        g.beginPath(); g.ellipse(x + Math.cos(a) * rad * 0.55, y + Math.sin(a) * rad * 0.55, rad * 0.55, rad * 0.32, a, 0, Math.PI * 2); g.fill();
      }
      g.fillStyle = css([250, 210, 70]); g.beginPath(); g.arc(x, y, rad * 0.25, 0, Math.PI * 2); g.fill();
    }
  }, 3);
}

const HI: Record<string, HiPainter> = {
  sign_panel: canvasTile((g) => signBack(g)),
  neon_pink: neonHi([255, 120, 210], [255, 60, 180], true), neon_cyan: neonHi([150, 250, 255], [40, 210, 255], true),
  neon_yellow: neonHi([255, 236, 120], [255, 190, 40], false), neon_green: neonHi([140, 255, 170], [40, 210, 90], false),
  neon_orange: neonHi([255, 170, 90], [240, 96, 30], false), neon_purple: neonHi([210, 150, 255], [140, 60, 230], false),
  window: windowHi(0xd8d8d0, 0x86bddc, 0x2c526b), glass: glassHi(),
  curtain_teal: curtainHi(0x9fe3dc, 0x2f7f86, 0xd4dcdc, 1), curtain_blue: curtainHi(0x9cc4f0, 0x23508f, 0xc8d0dc, 2),
  curtain_gold: curtainHi(0xf2d79a, 0x8a6430, 0x5a4a38, 3), curtain_dark: curtainHi(0x6a7f96, 0x1a2430, 0x384450, 4),
  screen: screenHi(), lamp: lampHi(),
  leaves: foliageHi(0x4a9a40, 0x2a6428, { holes: true, count: 330, size: 9 }),
  hedge: foliageHi(0x4a8c3a, 0x2a5c24, { holes: false, count: 420, size: 8 }),
  orange_leaves: foliageHi(0x449038, 0x2a6428, { holes: true, count: 320, size: 9, fruit: [[250, 150, 30], [255, 176, 50]] }),
  mangrove_leaves: foliageHi(0x4a8a3c, 0x2a6430, { holes: true, count: 300, size: 10 }),
  pine_leaves: foliageHi(0x2e6b3f, 0x1c4a2a, { holes: true, count: 420, size: 9, needle: true }),
  spruce_leaves: foliageHi(0x2a5a40, 0x163828, { holes: true, count: 440, size: 9, needle: true }),
  palm_leaves: palmHi(),
  tall_grass: bladesHi(0x5aa842, 0x8cc858, 34, 0.35, 0.9),
  reeds: bladesHi(0x7f9f4a, 0xa6c060, 16, 0.6, 0.95, (g, r, bl) => { for (const b of bl.slice(0, 6)) { const x = b.x + b.bend * b.h * 0.45; g.fillStyle = css([110, 72, 40]); g.beginPath(); g.roundRect(x - 3, S - b.h * 0.85, 6, 18 + r() * 6, 3); g.fill(); } }, 3),
  sea_oats: bladesHi(0xb8b070, 0xd8cc90, 18, 0.5, 0.95, (g, r, bl) => { for (const b of bl.slice(0, 7)) { const x = b.x + b.bend * b.h * 0.55, y = S - b.h * 0.92; for (let k = 0; k < 7; k++) { g.fillStyle = css(mix([210, 180, 120], [180, 150, 90], r())); g.beginPath(); g.ellipse(x + (k % 2 ? 4 : -4), y + k * 4, 2.6, 4.5, k % 2 ? 0.4 : -0.4, 0, Math.PI * 2); g.fill(); } } }, 2.5),
  cane: canvasTile((g, r) => { for (let i = 0; i < 4; i++) { const x = 14 + i * 32 + r() * 6; for (let y = 0; y < S; y += 20) { g.fillStyle = css(mix([150, 190, 80], [120, 160, 60], r())); g.fillRect(x - 4, y, 8, 18); g.fillStyle = css([110, 140, 56]); g.fillRect(x - 5, y + 18, 10, 2); } g.strokeStyle = css([110, 160, 60]); g.lineWidth = 3; g.beginPath(); g.moveTo(x, 30 + r() * 30); g.quadraticCurveTo(x + 22, 20, x + 30, 40); g.stroke(); } }),
  corn: canvasTile((g, r) => { for (const x of [36, 92]) { g.fillStyle = css([140, 176, 70]); g.fillRect(x - 3, 0, 6, S); for (let k = 0; k < 5; k++) { const y = 10 + k * 24 + r() * 6, side = k % 2 ? 1 : -1; g.strokeStyle = css(mix([110, 154, 58], [140, 180, 74], r())); g.lineWidth = 5; g.beginPath(); g.moveTo(x, y + 14); g.quadraticCurveTo(x + side * 26, y - 6, x + side * 40, y + 16); g.stroke(); } g.fillStyle = css([236, 206, 90]); g.beginPath(); g.ellipse(x + 8, 70, 6, 15, 0.2, 0, Math.PI * 2); g.fill(); g.fillStyle = css([130, 170, 70]); g.beginPath(); g.ellipse(x + 10, 76, 5, 14, 0.3, 0, Math.PI * 2); g.fill(); } }),
  veg: bladesHi(0x3f8a34, 0x5fae46, 26, 0.2, 0.45, (g, r) => { for (let i = 0; i < 8; i++) { const x = 10 + r() * (S - 20), y = S * (0.68 + r() * 0.22); const gr = g.createRadialGradient(x - 2, y - 2, 1, x, y, 7); gr.addColorStop(0, css([255, 120, 100])); gr.addColorStop(1, css([190, 36, 30])); g.fillStyle = gr; g.beginPath(); g.arc(x, y, 6.5, 0, Math.PI * 2); g.fill(); } }, 9),
  flowers: flowersHi([[255, 90, 140], [255, 220, 60]]), flowers_blue: flowersHi([[110, 120, 230], [180, 120, 230]]), flowers_white: flowersHi([[246, 246, 240]]),
  palmetto: canvasTile((g, r) => { for (let i = 0; i < 15; i++) { const a = -Math.PI * (0.08 + 0.84 * i / 14) + (r() - 0.5) * 0.08, L = S * (0.6 + r() * 0.35); const x1 = S / 2 + Math.cos(a) * L, y1 = S + Math.sin(a) * L; g.strokeStyle = css(mix([62, 120, 56], [100, 156, 72], r())); g.lineWidth = 7; g.beginPath(); g.moveTo(S / 2, S); g.lineTo(x1, y1); g.stroke(); g.strokeStyle = css([120, 170, 90]); g.lineWidth = 1; g.beginPath(); g.moveTo(S / 2, S); g.lineTo(x1, y1); g.stroke(); } }),
  moss: canvasTile((g, r) => { for (let i = 0; i < 26; i++) { const x = r() * S, L = S * (0.3 + r() * 0.65); g.strokeStyle = css(mix([150, 162, 136], [120, 132, 108], r())); g.lineWidth = 1.5 + r() * 2; g.beginPath(); g.moveTo(x, 0); for (let y = 8; y < L; y += 8) g.lineTo(x + Math.sin(y * 0.15 + i) * 3, y); g.stroke(); } }),
};
for (const ch of Object.keys(FONT)) HI[`letter_${ch.toLowerCase()}`] = letterHi(ch);
// store shelves: wooden boards stocked with boxes, cans and bottles
HI.shelf = canvasTile((g, r) => {
  g.fillStyle = '#3b2a1c'; g.fillRect(0, 0, S, S);
  const rows = 3, rh = S / rows;
  const goods: RGB[] = [[230, 80, 70], [70, 160, 220], [250, 200, 60], [120, 200, 90], [240, 240, 236], [200, 90, 180], [255, 140, 40]];
  for (let k = 0; k < rows; k++) {
    const y0 = k * rh, base = y0 + rh - 8;
    let x = 3;
    while (x < S - 6) {
      const w = 7 + Math.floor(r() * 10), h = rh * (0.42 + r() * 0.4), c = goods[Math.floor(r() * goods.length)];
      const kind = r();
      const gr = g.createLinearGradient(x, 0, x + w, 0); gr.addColorStop(0, css(jitless(c, 0.75))); gr.addColorStop(0.35, css(jitless(c, 1.1))); gr.addColorStop(1, css(jitless(c, 0.7)));
      g.fillStyle = gr;
      if (kind < 0.35) { g.beginPath(); g.roundRect(x, base - h, w, h, [w * 0.4, w * 0.4, 1, 1]); g.fill(); g.fillStyle = 'rgba(255,255,255,0.75)'; g.fillRect(x + 1, base - h * 0.55, w - 2, h * 0.22); }
      else if (kind < 0.6) { g.fillRect(x, base - h * 0.6, w, h * 0.6); g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(x, base - h * 0.6, w, 2); }
      else { g.fillRect(x, base - h, w, h); g.fillStyle = 'rgba(255,255,255,0.55)'; g.fillRect(x + 2, base - h * 0.75, w - 4, 3); }
      x += w + 1 + Math.floor(r() * 2);
    }
    const bg = g.createLinearGradient(0, base, 0, base + 8); bg.addColorStop(0, '#a07850'); bg.addColorStop(1, '#5e4228');
    g.fillStyle = bg; g.fillRect(0, base, S, 8);
    g.fillStyle = '#f2efe6'; g.fillRect(6, base + 2, 10, 4); g.fillRect(S / 2, base + 2, 10, 4);
  }
});
// leaded church glass
HI.stained_glass = canvasTile((g, r) => {
  const cols: RGB[] = [[200, 60, 70], [60, 110, 200], [240, 190, 60], [80, 170, 90], [150, 80, 190], [80, 180, 210]];
  const n = 4;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = i * S / n, y = j * S / n, c = cols[(i * 3 + j * 2 + (i * j) % 3) % cols.length];
    const gr = g.createRadialGradient(x + S / n / 2, y + S / n / 2, 2, x + S / n / 2, y + S / n / 2, S / n);
    gr.addColorStop(0, css(mix(c, [255, 255, 255], 0.35))); gr.addColorStop(1, css(jitless(c, 0.75)));
    g.fillStyle = gr; g.fillRect(x, y, S / n, S / n);
    if ((i + j) % 2) { g.fillStyle = css(mix(cols[(i + j * 5 + 1) % cols.length], [255, 255, 255], 0.2)); g.beginPath(); g.moveTo(x + S / n / 2, y + 4); g.lineTo(x + S / n - 4, y + S / n / 2); g.lineTo(x + S / n / 2, y + S / n - 4); g.lineTo(x + 4, y + S / n / 2); g.fill(); }
  }
  g.strokeStyle = '#2a2628'; g.lineWidth = 4;
  for (let k = 0; k <= n; k++) { g.beginPath(); g.moveTo(k * S / n, 0); g.lineTo(k * S / n, S); g.stroke(); g.beginPath(); g.moveTo(0, k * S / n); g.lineTo(S, k * S / n); g.stroke(); }
  g.lineWidth = 2;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if ((i + j) % 2) {
    const x = i * S / n, y = j * S / n;
    g.beginPath(); g.moveTo(x + S / n / 2, y + 4); g.lineTo(x + S / n - 4, y + S / n / 2); g.lineTo(x + S / n / 2, y + S / n - 4); g.lineTo(x + 4, y + S / n / 2); g.closePath(); g.stroke();
  }
  void r;
});
// tyre stack seen from the side: tread blocks + rim
HI.tire = canvasTile((g) => {
  g.fillStyle = '#1e1e22'; g.fillRect(0, 0, S, S);
  const c = S / 2;
  for (let a = 0; a < 48; a++) {
    const t = a / 48 * Math.PI * 2;
    g.fillStyle = a % 2 ? '#2c2c31' : '#151518';
    g.beginPath(); g.moveTo(c + Math.cos(t) * S * 0.36, c + Math.sin(t) * S * 0.36); g.arc(c, c, S * 0.5, t, t + Math.PI * 2 / 48); g.closePath(); g.fill();
  }
  const rg = g.createRadialGradient(c - 6, c - 6, 4, c, c, S * 0.3); rg.addColorStop(0, '#e2e6ea'); rg.addColorStop(1, '#7a8088');
  g.fillStyle = '#26262a'; g.beginPath(); g.arc(c, c, S * 0.36, 0, Math.PI * 2); g.fill();
  g.fillStyle = rg; g.beginPath(); g.arc(c, c, S * 0.24, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#4a4e54';
  for (let k = 0; k < 5; k++) { const t = k / 5 * Math.PI * 2; g.beginPath(); g.arc(c + Math.cos(t) * S * 0.12, c + Math.sin(t) * S * 0.12, S * 0.025, 0, Math.PI * 2); g.fill(); }
});

// ───────────────────────────────────────────── 16 px → hi-res upgrade (edge-preserving clean + EPX + bilinear blend)

function paint16(name: string, seed: number): RGBA {
  const t = new Uint8ClampedArray(SRC * SRC * 4);
  const painter = P[name] ?? noiseFill(0xff00ff, 0.1);
  const cut = CUTOUT_TILES.has(name);
  painter((x, y, c) => {
    const o = (y * SRC + x) * 4;
    const black = c[0] === 0 && c[1] === 0 && c[2] === 0;
    t[o] = c[0]; t[o + 1] = c[1]; t[o + 2] = c[2]; t[o + 3] = cut && black ? 0 : 255;
  }, rng(seed));
  return t;
}
const cdist = (a: RGBA, i: number, b: RGBA, j: number) => Math.abs(a[i] - b[j]) + Math.abs(a[i + 1] - b[j + 1]) + Math.abs(a[i + 2] - b[j + 2]) + Math.abs(a[i + 3] - b[j + 3]);
/** remove per-pixel jitter but keep shapes: average each pixel with similar-coloured neighbours */
function clean(src: RGBA, w: number, tol = 42): RGBA {
  const out = new Uint8ClampedArray(src.length);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const j = ((((y + dy) % w + w) % w) * w + (((x + dx) % w + w) % w)) * 4;
      if (cdist(src, i, src, j) < tol) { r += src[j]; g += src[j + 1]; b += src[j + 2]; a += src[j + 3]; n++; }
    }
    out[i] = r / n; out[i + 1] = g / n; out[i + 2] = b / n; out[i + 3] = a / n;
  }
  return out;
}
function scale2x(a: RGBA, w: number): RGBA {
  const W = w * 2, o = new Uint8ClampedArray(W * W * 4);
  const eq = (i: number, j: number) => cdist(a, i, a, j) < 24;
  const put = (x: number, y: number, s: number) => { const d = (y * W + x) * 4; o[d] = a[s]; o[d + 1] = a[s + 1]; o[d + 2] = a[s + 2]; o[d + 3] = a[s + 3]; };
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) {
    const P0 = (y * w + x) * 4, A = ((((y - 1 + w) % w) * w) + x) * 4, B = (y * w + (x + 1) % w) * 4, C = (y * w + (x - 1 + w) % w) * 4, D = ((((y + 1) % w) * w) + x) * 4;
    put(2 * x, 2 * y, eq(C, A) && !eq(C, D) && !eq(A, B) ? A : P0);
    put(2 * x + 1, 2 * y, eq(A, B) && !eq(A, C) && !eq(B, D) ? B : P0);
    put(2 * x, 2 * y + 1, eq(D, C) && !eq(D, B) && !eq(C, A) ? C : P0);
    put(2 * x + 1, 2 * y + 1, eq(B, D) && !eq(B, A) && !eq(D, C) ? D : P0);
  }
  return o;
}
function bilinear(a: RGBA, w: number, W: number): RGBA {
  const o = new Uint8ClampedArray(W * W * 4), f = w / W;
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const sx = (x + 0.5) * f - 0.5, sy = (y + 0.5) * f - 0.5;
    const x0 = Math.floor(sx), y0 = Math.floor(sy), tx = sx - x0, ty = sy - y0;
    const i00 = (((y0 + w) % w) * w + ((x0 + w) % w)) * 4, i10 = (((y0 + w) % w) * w + ((x0 + 1) % w)) * 4;
    const i01 = (((y0 + 1) % w) * w + ((x0 + w) % w)) * 4, i11 = (((y0 + 1) % w) * w + ((x0 + 1) % w)) * 4;
    const d = (y * W + x) * 4;
    for (let c = 0; c < 4; c++) o[d + c] = (a[i00 + c] * (1 - tx) + a[i10 + c] * tx) * (1 - ty) + (a[i01 + c] * (1 - tx) + a[i11 + c] * tx) * ty;
  }
  return o;
}
/** 16 px art → W px: crisp EPX edges where colours change, smooth bilinear inside flat/gradient areas */
function upscale(src: RGBA, W: number): RGBA {
  let e = clean(src, SRC), w = SRC;
  const smooth = bilinear(e, SRC, W);
  while (w < W) { e = scale2x(e, w); w *= 2; }
  for (let i = 0; i < e.length; i += 4) {
    if (cdist(e, i, smooth, i) < 40) { e[i] = smooth[i]; e[i + 1] = smooth[i + 1]; e[i + 2] = smooth[i + 2]; e[i + 3] = smooth[i + 3]; }
    else if (e[i + 3] > 0 && e[i + 3] < 255) e[i + 3] = e[i + 3] < 128 ? 0 : 255;
  }
  return e;
}

/** periodic value noise in [0,1] */
function vnoise(W: number, freq: number, r: () => number): Float32Array {
  const g = new Float32Array(freq * freq).map(() => r());
  const o = new Float32Array(W * W);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const fx = (x / W) * freq, fy = (y / W) * freq, x0 = Math.floor(fx), y0 = Math.floor(fy);
    let tx = fx - x0, ty = fy - y0; tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
    const a = g[(y0 % freq) * freq + (x0 % freq)], b = g[(y0 % freq) * freq + ((x0 + 1) % freq)];
    const c = g[((y0 + 1) % freq) * freq + (x0 % freq)], d = g[((y0 + 1) % freq) * freq + ((x0 + 1) % freq)];
    o[y * W + x] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }
  return o;
}

/** finish a hi-res tile: grain, alpha bleed, height → normal, roughness, gloss → (albedo RGBA, material RGBA) in image space */
function finish(name: string, t: HiTile, seed: number, W = S): { alb: RGBA; mat: RGBA } {
  const pr = matProps(name);
  const r = rng(seed * 31 + 7);
  const n1 = vnoise(W, 8, r), n2 = vnoise(W, 32, r);
  const alb = t.rgba, mat = new Uint8ClampedArray(W * W * 4);
  const h = new Float32Array(W * W);
  const glow = GLOW_TILES.has(name);
  for (let i = 0, p = 0; p < W * W; p++, i += 4) {
    const grain = (n1[p] - 0.5) * 0.6 + (n2[p] - 0.5) * 0.8 + (r() - 0.5) * 0.35;
    const k = 1 + grain * pr.grain * 2;
    alb[i] *= k; alb[i + 1] *= k; alb[i + 2] *= k;
    const l = (alb[i] * 0.3 + alb[i + 1] * 0.55 + alb[i + 2] * 0.15) / 255;
    h[p] = alb[i + 3] < 128 ? 0 : (t.height ? t.height[p] * 0.7 + l * 0.15 : l) + grain * 0.06;
    mat[i + 2] = Math.max(8, Math.min(255, (pr.rough + grain * 0.12) * 255));
    mat[i + 3] = (t.gloss ? t.gloss[p] : pr.gloss) * 255;
  }
  // bleed colour into transparent texels so mips do not darken cutout edges
  if (CUTOUT_TILES.has(name)) {
    let filled = new Uint8Array(W * W);
    for (let p = 0; p < W * W; p++) filled[p] = alb[p * 4 + 3] >= 128 ? 1 : 0;
    for (let pass = 0; pass < 8; pass++) {
      const next = filled.slice();
      for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
        const p = y * W + x;
        if (filled[p]) continue;
        let rr = 0, gg = 0, bb = 0, n = 0;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const q = (((y + dy) % W + W) % W) * W + (((x + dx) % W + W) % W);
          if (filled[q]) { rr += alb[q * 4]; gg += alb[q * 4 + 1]; bb += alb[q * 4 + 2]; n++; }
        }
        if (n) { alb[p * 4] = rr / n; alb[p * 4 + 1] = gg / n; alb[p * 4 + 2] = bb / n; next[p] = 1; }
      }
      filled = next;
    }
    for (let i = 3; i < alb.length; i += 4) if (alb[i] < 128) alb[i] = 0;
  }
  const str = (glow ? 0.5 : pr.nstr) * 2.2 * (W / S);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x;
    const dx = (h[y * W + (x + 1) % W] - h[y * W + (x - 1 + W) % W]) * 0.5 * str;
    const dy = (h[((y - 1 + W) % W) * W + x] - h[((y + 1) % W) * W + x]) * 0.5 * str; // +Y = up (towards row 0)
    const inv = 1 / Math.hypot(dx, dy, 1);
    mat[p * 4] = (-dx * inv * 0.5 + 0.5) * 255;
    mat[p * 4 + 1] = (-dy * inv * 0.5 + 0.5) * 255;
  }
  return { alb, mat };
}

// ───────────────────────────────────────────── atlas

export interface BlockAtlas {
  albedo: THREE.DataArrayTexture;
  material: THREE.DataArrayTexture;
  layout: TileLayout;
}

/** copy an image-space (row 0 = top) S×S tile into a layer (row 0 = v 0 = bottom) */
export function writeLayer(data: Uint8Array, layer: number, src: ArrayLike<number>, srcStride = S, sx = 0, sy = 0, alpha?: number) {
  const base = layer * S * S * 4;
  for (let y = 0; y < S; y++) {
    const so = ((sy + S - 1 - y) * srcStride + sx) * 4, d = base + y * S * 4;
    for (let x = 0; x < S * 4; x++) data[d + x] = src[so + x];
    if (alpha !== undefined) for (let x = 3; x < S * 4; x += 4) data[d + x] = alpha;
  }
}

function makeArray(data: Uint8Array, count: number, srgb: boolean) {
  const t = new THREE.DataArrayTexture(data, S, S, count);
  t.format = THREE.RGBAFormat;
  t.type = THREE.UnsignedByteType;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.unpackAlignment = 4;
  t.needsUpdate = true;
  return t;
}

export function buildAtlas(): { texture: THREE.DataArrayTexture; material: THREE.DataArrayTexture; atlas: BlockAtlas } {
  const layout = tileLayout();
  const albData = new Uint8Array(layout.count * S * S * 4);
  const matData = new Uint8Array(layout.count * S * S * 4);
  TILE_NAMES.forEach((name, i) => {
    const seed = i * 9973 + 17;
    let tile: HiTile;
    if (HI[name]) tile = HI[name](rng(seed));
    else if (layout.repeat[i] === 2) {
      // placeholder for photographic tiles (until the pack loads): the 16 px art per block, 2×2
      const half = upscale(paint16(name, seed), S / 2);
      const rgba = new Uint8ClampedArray(S * S * 4);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const s = ((y % (S / 2)) * (S / 2) + (x % (S / 2))) * 4, d = (y * S + x) * 4;
        rgba[d] = half[s]; rgba[d + 1] = half[s + 1]; rgba[d + 2] = half[s + 2]; rgba[d + 3] = half[s + 3];
      }
      tile = { rgba };
    } else tile = { rgba: upscale(paint16(name, seed), S) };
    const { alb, mat } = finish(name, tile, seed);
    writeLayer(albData, i, alb);
    writeLayer(matData, i, mat);
    for (const v of layout.variants[i]) {
      albData.copyWithin(v * S * S * 4, i * S * S * 4, (i + 1) * S * S * 4);
      matData.copyWithin(v * S * S * 4, i * S * S * 4, (i + 1) * S * S * 4);
    }
  });
  const albedo = makeArray(albData, layout.count, true);
  const material = makeArray(matData, layout.count, false);
  const atlas: BlockAtlas = { albedo, material, layout };
  albedo.userData = { atlas, material };
  return { texture: albedo, material, atlas };
}

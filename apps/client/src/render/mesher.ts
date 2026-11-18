/**
 * Chunk mesher (runs inside workers). Input: a padded region (CHUNK+2·pad)² × WORLD_H
 * produced by the shared generator. Output: typed arrays per render bucket with
 * per-vertex ambient occlusion, emissive flags and an `extra` attribute:
 *   extra.rgb = coloured block light flood-filled from emissive blocks (lamps, neon, screens)
 *   extra.a   = material code: sway amount (0..63) + 64 × specular tier (0..3)
 *   uv        = continuous texture coordinates in units of one texture-array layer; layers that
 *               cover REPEAT blocks are mapped from world position / REPEAT (the array wraps with
 *               REPEAT, so merged quads simply span several repeats)
 *   tile      = (layer, variant info): variant info = first variant layer + 4096·count +
 *               16384·(REPEAT−1), or 0. The block shader picks the seamless ground variant per
 *               REPEAT cell from a world-position hash, so merged quads keep the variation.
 *               Stochastic one-block tiles (foliage) get a random 90° rotation here (never merged).
 *
 * Speed (Leonia columns are 256 high):
 *   - the column is classified in 16-high sections; all-air sections and sections that are
 *     solid and enclosed by solid neighbours (ground, tower cores) are skipped outright
 *   - opaque blocks with six opaque neighbours are skipped with one table lookup each
 *   - coplanar faces with the same block, uniform AO and no block light are greedy-merged
 *     per slice (walls, roofs, roads, water); faces with AO gradients or light keep per-block quads
 *   - output buffers are typed arrays reused across jobs (only the final slice is copied)
 * The region padding lets light from emissive blocks in neighbouring chunks spill across
 * chunk borders without seams.
 */
import { BLOCKS, B, CHUNK, WORLD_H, TILE_INDEX } from '@blockshore/shared';
import { tileLayout } from './atlas';

/** region padding generated around each chunk (light reach is LIGHT_MAX-1 blocks) */
export const MESH_PAD = 8;
const LIGHT_MAX = 8;
const SECTION = 16;

// per block: render kind code 0 none 1 opaque 2 cutout 3 cross 4 translucent 5 water
const KIND = new Uint8Array(256);
const OCC = new Uint8Array(256); // occludes AO + hides faces
const EMI = new Uint8Array(256);
const TOP = new Uint16Array(256), SIDE = new Uint16Array(256), BOT = new Uint16Array(256);
/** light emitted (level 0..LIGHT_MAX per channel) */
const LR = new Uint8Array(256), LG = new Uint8Array(256), LB = new Uint8Array(256);
/** sway amount 0..63 */
const SWAY = new Uint8Array(256);
/** specular tier 0 none, 1 mild (metal/marble/tile), 2 glossy (panels, hulls), 3 mirror (glass, chrome, windows) */
const SPEC = new Uint8Array(256);

const NAMED_LIGHT: [RegExp, [number, number, number]][] = [
  [/neon_pink/, [1, 0.25, 0.7]], [/neon_cyan/, [0.25, 0.95, 1]], [/neon_yellow/, [1, 0.85, 0.3]],
  [/neon_green/, [0.35, 1, 0.5]], [/neon_orange/, [1, 0.55, 0.2]], [/neon_purple/, [0.7, 0.35, 1]],
  [/lamp|lantern|torch/, [1, 0.8, 0.52]], [/screen|arcade|tv|monitor/, [0.55, 0.75, 1]],
  [/letter|sign/, [0.95, 0.92, 1]], [/club/, [1, 0.3, 0.85]],
];

function lightColour(name: string, color?: number): [number, number, number] {
  for (const [re, c] of NAMED_LIGHT) if (re.test(name)) return c;
  if (color !== undefined) {
    const r = ((color >> 16) & 255) / 255, g = ((color >> 8) & 255) / 255, b = (color & 255) / 255;
    const m = Math.max(r, g, b, 1e-3);
    return [r / m, g / m, b / m];
  }
  return [1, 0.85, 0.65];
}

for (const b of BLOCKS) {
  KIND[b.id] = { none: 0, opaque: 1, cutout: 2, cross: 3, translucent: 4, water: 5 }[b.render];
  OCC[b.id] = b.render === 'opaque' ? 1 : 0;
  EMI[b.id] = Math.round((b.emissive ?? 0) * 255);
  TOP[b.id] = TILE_INDEX[b.tiles[0]] ?? 0;
  SIDE[b.id] = TILE_INDEX[b.tiles[1]] ?? 0;
  BOT[b.id] = TILE_INDEX[b.tiles[2]] ?? 0;
  const lvl = Math.round((b.emissive ?? 0) * LIGHT_MAX);
  if (lvl >= 2) {
    const c = lightColour(b.name, b.color);
    LR[b.id] = Math.round(lvl * c[0]); LG[b.id] = Math.round(lvl * c[1]); LB[b.id] = Math.round(lvl * c[2]);
  }
  const n = b.name;
  if (b.render === 'cross' && !(b.emissive)) SWAY[b.id] = /corn|cane/.test(n) ? 45 : /moss|flowers/.test(n) ? 35 : 63;
  else if (/palm_leaves/.test(n)) SWAY[b.id] = 40;
  else if (/leaves/.test(n)) SWAY[b.id] = 22;
  else if (/hedge/.test(n)) SWAY[b.id] = 8;
  else if (/^flag$/.test(n)) SWAY[b.id] = 30;
  if (/^glass$|window|chrome|solar|stained_glass/.test(n)) SPEC[b.id] = 3;
  else if (/panel_|hull_|fuselage|rocket_|police|dish|screen|pool_tile/.test(n)) SPEC[b.id] = 2;
  else if (/metal|marble|tile_floor|tin_roof|copper_roof|container_|silo_blue|court_/.test(n)) SPEC[b.id] = 1;
}

const LAYOUT = tileLayout();
/** per layer: variant info word for the `tile` attribute (see header) */
const VINFO = new Uint16Array(LAYOUT.count);
for (let t = 0; t < LAYOUT.count; t++) {
  const v = LAYOUT.variants[t];
  if (v && v.length) VINFO[t] = v[0] + v.length * 4096 + (LAYOUT.repeat[t] - 1) * 16384;
}

function hash3(x: number, y: number, z: number, f: number) {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(z, 0x9e3779b1) ^ Math.imul(f, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

// per face: u axis and v axis as [axis 0=x 1=y 2=z, sign] (matches the old atlas orientation)
const FACE_UV: [[number, number], [number, number]][] = [
  [[2, -1], [1, 1]], [[2, 1], [1, 1]], [[0, 1], [2, -1]], [[0, 1], [2, 1]], [[0, 1], [1, 1]], [[0, -1], [1, 1]],
];

// face definitions: normal, 4 corner offsets (CCW seen from outside)
const FN = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const FC = [
  [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]],
  [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
  [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]],
  [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
  [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
];
/** 0 = side, 1 = top, 2 = bottom */
const FT = [0, 0, 1, 2, 0, 0];

const AO_LEVELS = [90, 150, 205, 255];

// ───────────────────────────────────────────────────────────── output buffers (reused)
class Bucket {
  pos = new Float32Array(3 * 4096); nrm = new Int8Array(3 * 4096); uv = new Float32Array(2 * 4096);
  light = new Uint8Array(2 * 4096); extra = new Uint8Array(4 * 4096); tile = new Uint16Array(2 * 4096);
  idx = new Uint32Array(6 * 1024);
  n = 0; ni = 0;
  reset() { this.n = 0; this.ni = 0; }
  private grow() {
    const cap = this.pos.length / 3 * 2;
    const g = <T extends Float32Array | Int8Array | Uint8Array | Uint16Array | Uint32Array>(a: T, k: number): T => { const b = new (a.constructor as new (n: number) => T)(cap * k); b.set(a); return b; };
    this.pos = g(this.pos, 3); this.nrm = g(this.nrm, 3); this.uv = g(this.uv, 2); this.light = g(this.light, 2);
    this.extra = g(this.extra, 4); this.tile = g(this.tile, 2);
    const ix = new Uint32Array(cap / 4 * 6); ix.set(this.idx); this.idx = ix;
  }
  /** one quad: v = 12 floats, u = 8 floats, ao/bl/code per corner */
  quad(v: ArrayLike<number>, nx: number, ny: number, nz: number, u: ArrayLike<number>, ao: ArrayLike<number>, emi: number, flip: boolean, bl: ArrayLike<number>, code: ArrayLike<number>, layer: number, vinfo: number) {
    if ((this.n + 4) * 3 > this.pos.length) this.grow();
    const base = this.n;
    const P = this.pos, N = this.nrm, U = this.uv, L = this.light, E = this.extra, T = this.tile;
    for (let i = 0; i < 4; i++) {
      const o = (base + i);
      P[o * 3] = v[i * 3]; P[o * 3 + 1] = v[i * 3 + 1]; P[o * 3 + 2] = v[i * 3 + 2];
      N[o * 3] = nx * 127; N[o * 3 + 1] = ny * 127; N[o * 3 + 2] = nz * 127;
      U[o * 2] = u[i * 2]; U[o * 2 + 1] = u[i * 2 + 1];
      L[o * 2] = ao[i]; L[o * 2 + 1] = emi;
      E[o * 4] = bl[i * 3]; E[o * 4 + 1] = bl[i * 3 + 1]; E[o * 4 + 2] = bl[i * 3 + 2]; E[o * 4 + 3] = code[i];
      T[o * 2] = layer; T[o * 2 + 1] = vinfo;
    }
    const I = this.idx, k = this.ni;
    if (flip) { I[k] = base + 1; I[k + 1] = base + 2; I[k + 2] = base + 3; I[k + 3] = base + 1; I[k + 4] = base + 3; I[k + 5] = base; }
    else { I[k] = base; I[k + 1] = base + 1; I[k + 2] = base + 2; I[k + 3] = base; I[k + 4] = base + 2; I[k + 5] = base + 3; }
    this.n += 4; this.ni += 6;
  }
  out() {
    const n = this.n, ni = this.ni;
    return {
      pos: this.pos.slice(0, n * 3), nrm: this.nrm.slice(0, n * 3), uv: this.uv.slice(0, n * 2),
      light: this.light.slice(0, n * 2), extra: this.extra.slice(0, n * 4), tile: this.tile.slice(0, n * 2),
      idx: n > 65000 ? this.idx.slice(0, ni) : Uint16Array.from(this.idx.subarray(0, ni)),
    };
  }
}
export type MeshArrays = ReturnType<Bucket['out']>;
export interface ChunkMesh { opaque: MeshArrays; cutout: MeshArrays; translucent: MeshArrays; water: MeshArrays; maxY: number; minY: number; faces: number; merged: number }

const B_OPAQUE = new Bucket(), B_CUTOUT = new Bucket(), B_TRANS = new Bucket(), B_WATER = new Bucket();

// light scratch buffers (sized for the largest region seen)
let lr = new Uint8Array(0), lg = new Uint8Array(0), lb = new Uint8Array(0);
let queue = new Int32Array(0);

/** coloured block light flood fill over the padded region (y ≤ top); returns false when nothing emits */
function floodLight(region: Uint8Array, P: number, top: number): boolean {
  const PLANE = P * P, N = PLANE * WORLD_H;
  if (lr.length < N) { lr = new Uint8Array(N); lg = new Uint8Array(N); lb = new Uint8Array(N); queue = new Int32Array(N); }
  const yEnd = Math.min(WORLD_H, top + 2) * PLANE;
  let tail = 0;
  for (let i = 0; i < yEnd; i++) {
    const id = region[i];
    if (LR[id] | LG[id] | LB[id]) queue[tail++] = i;
  }
  if (!tail) return false;
  lr.fill(0, 0, yEnd); lg.fill(0, 0, yEnd); lb.fill(0, 0, yEnd);
  for (let k = 0; k < tail; k++) { const i = queue[k], id = region[i]; lr[i] = LR[id]; lg[i] = LG[id]; lb[i] = LB[id]; }
  let head = 0;
  while (head < tail) {
    const i = queue[head++];
    const r = lr[i] - 1, g = lg[i] - 1, b = lb[i] - 1;
    if (r <= 0 && g <= 0 && b <= 0) continue;
    const y = (i / PLANE) | 0, rem = i - y * PLANE, z = (rem / P) | 0, x = rem - z * P;
    for (let k = 0; k < 6; k++) {
      let j: number;
      if (k === 0) { if (x + 1 >= P) continue; j = i + 1; }
      else if (k === 1) { if (x === 0) continue; j = i - 1; }
      else if (k === 2) { if (z + 1 >= P) continue; j = i + P; }
      else if (k === 3) { if (z === 0) continue; j = i - P; }
      else if (k === 4) { if (y + 1 > top + 1 || y + 1 >= WORLD_H) continue; j = i + PLANE; }
      else { if (y === 0) continue; j = i - PLANE; }
      if (OCC[region[j]]) continue;
      let ch = false;
      if (r > lr[j]) { lr[j] = r; ch = true; }
      if (g > lg[j]) { lg[j] = g; ch = true; }
      if (b > lb[j]) { lb[j] = b; ch = true; }
      if (ch && tail < queue.length) queue[tail++] = j;
    }
  }
  return true;
}

// greedy masks: per face direction, slices × (A × Bdim) cells; key = 1 + id + 256·aoLevel (0 = empty)
const MASK = [0, 1, 2, 3, 4, 5].map(() => new Int32Array(CHUNK * CHUNK * WORLD_H));
/** mask geometry per face: slice axis, a axis, b axis, A dim, B dim */
const MG: [number, number, number][] = [[0, 2, 1], [0, 2, 1], [1, 0, 2], [1, 0, 2], [2, 0, 1], [2, 0, 1]];

const v12 = new Float32Array(12), uv8 = new Float32Array(8), ao4 = new Uint8Array(4), bl12 = new Uint8Array(12), code4 = new Uint8Array(4);
const ZERO12 = new Uint8Array(12);
const FULL4 = new Uint8Array([255, 255, 255, 255]);
const wc = [0, 0, 0], ext = [1, 1, 1];

/** fill uv8 for a box face: block min corner world coords (wx,wy,wz), extents ext, face f, tile; rot = quarter turns */
function boxUV(tile: number, f: number, wx: number, wy: number, wz: number, rot: number) {
  const R = LAYOUT.repeat[tile];
  wc[0] = wx; wc[1] = wy; wc[2] = wz;
  const ua = FACE_UV[f][0], va = FACE_UV[f][1];
  const C = FC[f];
  for (let i = 0; i < 4; i++) {
    const c = C[i];
    const Wu = wc[ua[0]] + c[ua[0]] * ext[ua[0]], Wv = wc[va[0]] + c[va[0]] * ext[va[0]];
    const u = (ua[1] > 0 ? Wu : -Wu) / R, v = (va[1] > 0 ? Wv : -Wv) / R;
    uv8[i * 2] = u; uv8[i * 2 + 1] = v;
  }
  // keep the numbers small (REPEAT wrapping makes integer shifts invisible)
  let mu = Infinity, mv = Infinity;
  for (let i = 0; i < 4; i++) { mu = Math.min(mu, uv8[i * 2]); mv = Math.min(mv, uv8[i * 2 + 1]); }
  const su = Math.floor(mu), sv = Math.floor(mv);
  for (let i = 0; i < 4; i++) { uv8[i * 2] -= su; uv8[i * 2 + 1] -= sv; }
  for (let k = 0; k < rot; k++) for (let i = 0; i < 4; i++) { const t = uv8[i * 2]; uv8[i * 2] = uv8[i * 2 + 1]; uv8[i * 2 + 1] = 1 - t; }
}

/** `ox`,`oz` = world position of the chunk's first block (texture variation hashes) */
export function meshChunk(region: Uint8Array, pad = 1, ox = 0, oz = 0): ChunkMesh {
  const P = CHUNK + pad * 2;
  const PLANE = P * P;
  const H = WORLD_H;
  const opaque = B_OPAQUE, cutout = B_CUTOUT, translucent = B_TRANS, water = B_WATER;
  opaque.reset(); cutout.reset(); translucent.reset(); water.reset();
  const idxOf = (x: number, y: number, z: number) => (x + pad) + (z + pad) * P + y * PLANE;

  // ── section classification over the inner column (+1 ring for enclosure tests) ──
  const NS = Math.ceil(H / SECTION);
  const nonAir = new Int32Array(NS), solid = new Int32Array(NS);
  let maxY = -1, minY = H;
  for (let y = 0; y < H; y++) {
    const s = (y / SECTION) | 0;
    let na = 0, so = 0;
    const row = y * PLANE;
    for (let z = -1; z <= CHUNK; z++) {
      const r0 = row + (z + pad) * P + pad;
      for (let x = -1; x <= CHUNK; x++) {
        const id = region[r0 + x];
        const inner = x >= 0 && x < CHUNK && z >= 0 && z < CHUNK;
        if (id !== 0 && inner) na++;
        if (OCC[id]) so++;
      }
    }
    nonAir[s] += na; solid[s] += so;
    if (na) { if (y > maxY) maxY = y; if (y < minY) minY = y; }
  }
  if (maxY < 0) maxY = 0;
  if (minY > maxY) minY = 0;
  const ringCells = (CHUNK + 2) * (CHUNK + 2) * SECTION;
  // y range of the light flood: the column's top, or a neighbour's emitter up to 7 blocks higher
  let regionTop = maxY;
  for (let y = H - 1; y > regionTop; y--) {
    let any = false;
    for (let i = 0; i < PLANE; i++) if (region[i + y * PLANE] !== 0) { any = true; break; }
    if (any) { regionTop = y; break; }
  }
  const lit = pad > 1 ? floodLight(region, P, regionTop) : false;

  // clear the greedy masks for the used range
  const yLo = minY, yHi = maxY;
  for (let f = 0; f < 6; f++) {
    const m = MASK[f];
    if (f === 2 || f === 3) m.fill(0, yLo * CHUNK * CHUNK, (yHi + 1) * CHUNK * CHUNK);
    else m.fill(0);
  }

  let faces = 0, merged = 0;
  const OFF = [1, -1, PLANE, -PLANE, P, -P];
  const occ = (j: number, yy: number) => (yy < 0 || yy >= H) ? 0 : OCC[region[j]];
  const toByte = (l: number) => Math.min(255, Math.round((l / LIGHT_MAX) * 255));
  let sr = 0, sg = 0, sb = 0, sn = 0;
  const addL = (j: number, yy: number) => {
    if (yy < 0 || yy >= H) return;
    const a = lr[j], b2 = lg[j], c = lb[j];
    if (a | b2 | c || !OCC[region[j]]) { sr += a; sg += b2; sb += c; sn++; }
  };

  for (let s = (yLo / SECTION) | 0; s <= ((yHi / SECTION) | 0); s++) {
    if (!nonAir[s]) continue;
    // solid section whose ring and the rows above/below are solid too → nothing visible inside
    if (solid[s] === ringCells) {
      const ya = s * SECTION - 1, yb = (s + 1) * SECTION;
      let enclosed = true;
      for (const yy of [ya, yb]) {
        if (yy < 0 || yy >= H) { if (yy >= H) enclosed = false; continue; }
        for (let z = 0; z < CHUNK && enclosed; z++) for (let x = 0; x < CHUNK; x++) if (!OCC[region[idxOf(x, yy, z)]]) { enclosed = false; break; }
      }
      if (enclosed) continue;
    }
    const y0 = Math.max(yLo, s * SECTION), y1 = Math.min(yHi, s * SECTION + SECTION - 1);
    for (let y = y0; y <= y1; y++) for (let z = 0; z < CHUNK; z++) for (let x = 0; x < CHUNK; x++) {
      const i = idxOf(x, y, z);
      const id = region[i];
      const kind = KIND[id];
      if (kind === 0) continue;
      if (kind === 1 && OCC[region[i + 1]] && OCC[region[i - 1]] && OCC[region[i + P]] && OCC[region[i - P]] &&
        (y + 1 < H && OCC[region[i + PLANE]]) && (y === 0 || OCC[region[i - PLANE]])) continue;
      const emi = EMI[id];
      const spec = SPEC[id] * 64;
      const sway = SWAY[id];
      if (kind === 3) {
        // cross-shaped plant: bottom vertices anchored, top vertices sway
        const t = SIDE[id];
        const u = [0, 0, 1, 0, 1, 1, 0, 1];
        const sx = 0.15, e = 0.85;
        let lgt: ArrayLike<number> = ZERO12;
        if (lit) {
          const r = toByte(lr[i]), g = toByte(lg[i]), b = toByte(lb[i]);
          lgt = [r, g, b, r, g, b, r, g, b, r, g, b];
        }
        code4[0] = code4[1] = spec; code4[2] = code4[3] = spec + sway;
        cutout.quad([x + sx, y, z + sx, x + e, y, z + e, x + e, y + 1, z + e, x + sx, y + 1, z + sx], 0, 1, 0, u, FULL4, emi, false, lgt, code4, t, 0);
        cutout.quad([x + e, y, z + e, x + sx, y, z + sx, x + sx, y + 1, z + sx, x + e, y + 1, z + e], 0, 1, 0, u, FULL4, emi, false, lgt, code4, t, 0);
        cutout.quad([x + sx, y, z + e, x + e, y, z + sx, x + e, y + 1, z + sx, x + sx, y + 1, z + e], 0, 1, 0, u, FULL4, emi, false, lgt, code4, t, 0);
        cutout.quad([x + e, y, z + sx, x + sx, y, z + e, x + sx, y + 1, z + e, x + e, y + 1, z + sx], 0, 1, 0, u, FULL4, emi, false, lgt, code4, t, 0);
        faces += 4;
        continue;
      }
      code4[0] = code4[1] = code4[2] = code4[3] = spec + sway;
      for (let f = 0; f < 6; f++) {
        const n = FN[f];
        const nx = n[0], ny = n[1], nz = n[2];
        const yn = y + ny;
        const nb = yn < 0 ? B.STONE : yn >= H ? B.AIR : region[i + OFF[f]];
        if (kind === 5) {
          // water: draw only against air / non-water non-opaque
          if (nb === B.WATER || OCC[nb]) continue;
          if (ny === -1) continue;
        } else if (kind === 4 || kind === 2) {
          if (OCC[nb] || nb === id) continue;
        } else if (OCC[nb]) continue;
        faces++;
        const tile = FT[f] === 1 ? TOP[id] : FT[f] === 2 ? BOT[id] : SIDE[id];
        // AO (+ smooth block light) per corner
        const C = FC[f];
        let aoMin = 3, aoMax = 0;
        let anyLight = false;
        const fi = i + OFF[f];
        for (let c = 0; c < 4; c++) {
          const cc = C[c];
          const dx = cc[0] * 2 - 1, dy = cc[1] * 2 - 1, dz = cc[2] * 2 - 1;
          let s1: number, s2: number, s3: number;
          let o1: number, o2: number, o3: number, y1n: number, y2n: number, y3n: number;
          if (nx !== 0) { o1 = dy * PLANE; o2 = dz * P; y1n = yn + dy; y2n = yn; }
          else if (ny !== 0) { o1 = dx; o2 = dz * P; y1n = yn; y2n = yn; }
          else { o1 = dx; o2 = dy * PLANE; y1n = yn; y2n = yn + dy; }
          o3 = o1 + o2; y3n = nx !== 0 ? yn + dy : nz !== 0 ? yn + dy : yn;
          s1 = occ(fi + o1, y1n); s2 = occ(fi + o2, y2n); s3 = occ(fi + o3, y3n);
          const lvl = s1 && s2 ? 0 : 3 - (s1 + s2 + s3);
          ao4[c] = AO_LEVELS[lvl];
          if (lvl < aoMin) aoMin = lvl; if (lvl > aoMax) aoMax = lvl;
          if (lit) {
            sr = sg = sb = sn = 0;
            addL(fi, yn); addL(fi + o1, y1n); addL(fi + o2, y2n); if (!(s1 && s2)) addL(fi + o3, y3n);
            const k = sn ? 1 / sn : 0;
            const r = toByte(sr * k), g = toByte(sg * k), b = toByte(sb * k);
            bl12[c * 3] = r; bl12[c * 3 + 1] = g; bl12[c * 3 + 2] = b;
            if (r | g | b) anyLight = true;
          }
        }
        // mergeable: uniform AO, no block light, not a per-block rotated tile
        const rot = LAYOUT.rotate[tile];
        if (!anyLight && !rot && (aoMin === aoMax || kind === 5)) {
          const g = MG[f];
          const sl = g[0] === 0 ? x : g[0] === 1 ? y : z;
          const a = g[1] === 0 ? x : z;
          const bb = g[2] === 1 ? y : z;
          const A = CHUNK, BD = g[2] === 1 ? H : CHUNK;
          MASK[f][sl * A * BD + bb * A + a] = 1 + id + 256 * (kind === 5 ? 3 : aoMin);
          continue;
        }
        ext[0] = ext[1] = ext[2] = 1;
        boxUV(tile, f, ox + x, y, oz + z, rot ? hash3(ox + x, y, oz + z, 7) & 3 : 0);
        for (let c = 0; c < 4; c++) { const cc = C[c]; v12[c * 3] = x + cc[0]; v12[c * 3 + 1] = y + cc[1]; v12[c * 3 + 2] = z + cc[2]; }
        if (kind === 5 && ny === 1) { v12[1] -= 0.12; v12[4] -= 0.12; v12[7] -= 0.12; v12[10] -= 0.12; }
        const flip = ao4[0] + ao4[2] < ao4[1] + ao4[3];
        const bucket = kind === 1 ? opaque : kind === 2 ? cutout : kind === 4 ? translucent : water;
        bucket.quad(v12, nx, ny, nz, uv8, ao4, emi, flip, lit ? bl12 : ZERO12, code4, tile, VINFO[tile]);
      }
    }
  }

  // ── greedy merge of the masked faces ──
  for (let f = 0; f < 6; f++) {
    const m = MASK[f];
    const g = MG[f];
    const A = CHUNK, BD = g[2] === 1 ? H : CHUNK;
    const nS = g[0] === 1 ? H : CHUNK;
    const s0 = g[0] === 1 ? yLo : 0, s1 = g[0] === 1 ? yHi : nS - 1;
    const b0 = g[2] === 1 ? yLo : 0, b1 = g[2] === 1 ? yHi : BD - 1;
    const n = FN[f], C = FC[f];
    for (let sl = s0; sl <= s1; sl++) {
      const base = sl * A * BD;
      for (let bb = b0; bb <= b1; bb++) for (let a = 0; a < A; a++) {
        const key = m[base + bb * A + a];
        if (!key) continue;
        let w = 1;
        while (a + w < A && m[base + bb * A + a + w] === key) w++;
        let h = 1;
        outer: while (bb + h <= b1) {
          const r = base + (bb + h) * A + a;
          for (let k = 0; k < w; k++) if (m[r + k] !== key) break outer;
          h++;
        }
        for (let j = 0; j < h; j++) m.fill(0, base + (bb + j) * A + a, base + (bb + j) * A + a + w);
        const id = (key - 1) & 255, lvl = (key - 1) >> 8;
        const kind = KIND[id];
        // box: block min corner + extents
        let x = 0, y = 0, z = 0;
        ext[0] = ext[1] = ext[2] = 1;
        if (g[0] === 0) { x = sl; z = a; y = bb; ext[2] = w; ext[1] = h; }
        else if (g[0] === 1) { y = sl; x = a; z = bb; ext[0] = w; ext[2] = h; }
        else { z = sl; x = a; y = bb; ext[0] = w; ext[1] = h; }
        const tile = FT[f] === 1 ? TOP[id] : FT[f] === 2 ? BOT[id] : SIDE[id];
        boxUV(tile, f, ox + x, y, oz + z, 0);
        for (let c = 0; c < 4; c++) { const cc = C[c]; v12[c * 3] = x + cc[0] * ext[0]; v12[c * 3 + 1] = y + cc[1] * ext[1]; v12[c * 3 + 2] = z + cc[2] * ext[2]; }
        if (kind === 5 && n[1] === 1) { v12[1] -= 0.12; v12[4] -= 0.12; v12[7] -= 0.12; v12[10] -= 0.12; }
        const ao = AO_LEVELS[lvl];
        ao4[0] = ao4[1] = ao4[2] = ao4[3] = ao;
        const c4 = SPEC[id] * 64 + SWAY[id];
        code4[0] = code4[1] = code4[2] = code4[3] = c4;
        const bucket = kind === 1 ? opaque : kind === 2 ? cutout : kind === 4 ? translucent : water;
        bucket.quad(v12, n[0], n[1], n[2], uv8, ao4, EMI[id], false, ZERO12, code4, tile, VINFO[tile]);
        merged++;
      }
    }
  }
  return { opaque: opaque.out(), cutout: cutout.out(), translucent: translucent.out(), water: water.out(), maxY, minY, faces, merged };
}

/**
 * Leonia verification renders: for each district, a top-down render of the generator
 * output (1 px = 1 block, height-shaded) side by side with the decoded OSM vector data
 * (water, areas, footprints — synthetic infill in orange — and roads), plus a chunk
 * generation benchmark.
 *   BLOCKSHORE_WORLD=leonia npx tsx scripts/osm/render.ts [district ...]
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WORLD_H, WORLD } from '../../packages/shared/src/constants.ts';
import { BLOCKS, B } from '../../packages/shared/src/world/blocks.ts';
import { LeoniaGen } from '../../packages/shared/src/world/leonia/gen.ts';
import { lonLatToWorld } from '../../packages/shared/src/world/leonia/proj.ts';
import { TILE, AK, BF, RC, decodeTile, isCarRoad, isRail } from '../../packages/shared/src/world/leonia/format.ts';
import { OUT_DIR, ROOT } from './config.ts';
import { png } from './png.ts';

if (WORLD !== 'leonia') { console.error('run with BLOCKSHORE_WORLD=leonia'); process.exit(1); }
const source = { readSync: (tx: number, tz: number) => { const f = join(OUT_DIR, `t_${tx}_${tz}.bin`); return existsSync(f) ? new Uint8Array(readFileSync(f)) : null; } };
const gen = new LeoniaGen(source, 64);

const PAL: Record<string, [number, number, number]> = {
  grass: [95, 160, 70], dirt: [120, 90, 60], sand: [230, 214, 160], stone: [128, 128, 128], water: [50, 120, 200], asphalt: [55, 58, 62],
  line_white: [235, 235, 235], line_yellow: [240, 200, 40], sidewalk: [190, 190, 185], concrete: [170, 170, 170], brick: [160, 80, 60],
  glass: [170, 220, 240], window: [80, 120, 160], marble: [235, 235, 230], leaves: [60, 130, 50], palm_leaves: [90, 170, 70],
  stucco_pink: [240, 170, 180], stucco_teal: [100, 200, 190], stucco_yellow: [245, 220, 120], stucco_peach: [245, 190, 150], stucco_white: [240, 240, 235],
  metal: [140, 150, 160], roof_tile: [190, 90, 60], neon_pink: [255, 60, 200], neon_cyan: [40, 240, 255], hedge: [50, 110, 40], chrome: [210, 215, 220],
  container_red: [180, 50, 40], container_blue: [40, 80, 160], lamp: [255, 240, 180], plank: [185, 138, 85], palm_log: [155, 122, 78], mud: [90, 70, 50],
  reeds: [143, 174, 85], rail: [120, 128, 136], gravel: [140, 134, 124], runway: [74, 78, 85], dock: [158, 123, 86], farmland: [107, 76, 51],
  tall_grass: [103, 179, 74], dark_plank: [107, 74, 46], flowers: [230, 90, 140], shutter: [140, 148, 156], red_stucco: [217, 68, 58], stripe: [200, 170, 40], tile_floor: [200, 200, 196],
};
const COL: [number, number, number][] = BLOCKS.map((b) => PAL[b.name] ?? (b.color !== undefined ? [(b.color >> 16) & 255, (b.color >> 8) & 255, b.color & 255] : [200, 0, 200]));

const DISTRICTS: Record<string, { ll: [number, number]; size: number }> = {
  downtown: { ll: [-80.1905, 25.7745], size: 1536 },
  brickell: { ll: [-80.1930, 25.7600], size: 1280 },
  sobe: { ll: [-80.1325, 25.7810], size: 1536 },
  causeway: { ll: [-80.1700, 25.7880], size: 1536 },
  port: { ll: [-80.1700, 25.7760], size: 1536 },
  airport: { ll: [-80.2870, 25.7950], size: 2560 },
  residential: { ll: [-80.2620, 25.7330], size: 1280 },
  keybiscayne: { ll: [-80.1600, 25.6930], size: 2048 },
  wynwood: { ll: [-80.1990, 25.8010], size: 1024 },
  havana: { ll: [-80.2200, 25.7700], size: 1024 },
  northmiami: { ll: [-80.1900, 25.8850], size: 1280 },
};

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(DISTRICTS);
const outDir = join(ROOT, 'docs/progress');
mkdirSync(outDir, { recursive: true });
const R = 128; // region side for rendering
const region = new Uint8Array(R * R * WORLD_H);

for (const name of names) {
  const d = DISTRICTS[name];
  if (!d) { console.warn('unknown district', name); continue; }
  const [cx, cz] = lonLatToWorld(d.ll[0], d.ll[1]);
  const S = d.size, x0 = Math.round(cx - S / 2), z0 = Math.round(cz - S / 2);
  const img = new Uint8Array(S * 2 * S * 3);
  const heights = new Int16Array(S * S);
  const t0 = performance.now();
  let regions = 0;
  for (let rz = 0; rz < S; rz += R) for (let rx = 0; rx < S; rx += R) {
    gen.generateRegion(x0 + rx, z0 + rz, R, R, region); regions++;
    for (let z = 0; z < R; z++) for (let x = 0; x < R; x++) {
      let y = WORLD_H - 1;
      while (y > 0 && region[x + z * R + y * R * R] === B.AIR) y--;
      const id = region[x + z * R + y * R * R];
      const px = rx + x, pz = rz + z;
      heights[pz * S + px] = y;
      const c = COL[id] ?? [255, 0, 255];
      img.set(c, (pz * S * 2 + px) * 3);
    }
  }
  const ms = performance.now() - t0;
  // hillshade by height (light from NW)
  for (let z = 1; z < S; z++) for (let x = 1; x < S; x++) {
    const h = heights[z * S + x], dh = h - Math.max(heights[(z - 1) * S + x], heights[z * S + x - 1]);
    const k = (z * S * 2 + x) * 3;
    const f = Math.max(0.55, Math.min(1.35, 1 + dh * 0.06 + (h - 21) * 0.0025));
    for (let c = 0; c < 3; c++) img[k + c] = Math.min(255, img[k + c] * f);
  }
  // OSM panel
  const panel = (px: number, pz: number, c: [number, number, number]) => { if (px >= 0 && pz >= 0 && px < S && pz < S) img.set(c, (pz * S * 2 + S + px) * 3); };
  for (let z = 0; z < S; z++) for (let x = 0; x < S; x++) panel(x, z, gen.isWater(x0 + x, z0 + z) ? [60, 110, 180] : [225, 222, 210]);
  const AC: Record<number, [number, number, number]> = { [AK.PARK]: [170, 215, 150], [AK.GRASS]: [190, 225, 170], [AK.GOLF]: [160, 210, 140], [AK.BEACH]: [245, 230, 180], [AK.PARKING]: [200, 200, 205], [AK.RESIDENTIAL]: [230, 225, 215], [AK.COMMERCIAL]: [235, 215, 215], [AK.INDUSTRIAL]: [220, 210, 230], [AK.AERODROME]: [215, 215, 225], [AK.APRON]: [190, 190, 200], [AK.FOREST]: [140, 190, 130], [AK.NATURE]: [150, 200, 140], [AK.CEMETERY]: [180, 210, 180], [AK.PORT]: [210, 200, 225] };
  const tiles = new Set<string>();
  for (let tz = Math.floor(z0 / TILE); tz <= Math.floor((z0 + S) / TILE); tz++) for (let tx = Math.floor(x0 / TILE); tx <= Math.floor((x0 + S) / TILE); tx++) tiles.add(`${tx}_${tz}`);
  const fillR = (rings: Int32Array[], c: [number, number, number]) => {
    let zmin = Infinity, zmax = -Infinity; for (const r of rings) for (let i = 1; i < r.length; i += 2) { zmin = Math.min(zmin, r[i]); zmax = Math.max(zmax, r[i]); }
    for (let row = Math.max(z0, Math.floor(zmin)); row <= Math.min(z0 + S - 1, Math.ceil(zmax)); row++) {
      const zc = row + 0.5, xs: number[] = [];
      for (const r of rings) { const n = r.length / 2; for (let i = 0, j = n - 1; i < n; j = i++) { const az = r[j * 2 + 1], bz = r[i * 2 + 1]; if ((az > zc) !== (bz > zc)) xs.push(r[j * 2] + ((zc - az) * (r[i * 2] - r[j * 2])) / (bz - az)); } }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.ceil(xs[k] - 0.5); x <= Math.floor(xs[k + 1] - 0.5); x++) panel(x - x0, row - z0, c);
    }
  };
  const decoded = [...tiles].map((k) => { const [tx, tz] = k.split('_').map(Number); const f = join(OUT_DIR, `t_${tx}_${tz}.bin`); return existsSync(f) ? decodeTile(new Uint8Array(readFileSync(f))) : null; }).filter((t) => t !== null);
  for (const t of decoded) for (const a of t!.areas) if (AC[a.kind]) fillR(a.rings, AC[a.kind]);
  let nb = 0, nsyn = 0;
  const seen = new Set<string>();
  for (const t of decoded) for (const b of t!.buildings) {
    const k = `${b.rings[0][0]},${b.rings[0][1]},${b.seed}`; if (seen.has(k)) continue; seen.add(k);
    const syn = (b.flags & BF.SYNTHETIC) !== 0;
    const cx2 = (b.bbox[0] + b.bbox[2]) / 2, cz2 = (b.bbox[1] + b.bbox[3]) / 2;
    if (cx2 >= x0 && cz2 >= z0 && cx2 < x0 + S && cz2 < z0 + S && !(b.flags & BF.PART)) { nb++; if (syn) nsyn++; }
    const v = Math.max(60, 200 - b.height * 1.2);
    fillR(b.rings, syn ? [235, 150, 60] : [v, v * 0.95, v * 0.9]);
  }
  for (const t of decoded) for (const r of t!.roads) {
    const c: [number, number, number] = isCarRoad(r.cls) ? (r.cls <= RC.PRIMARY ? [230, 120, 60] : [120, 120, 120]) : isRail(r.cls) ? [80, 40, 120] : r.cls === RC.RUNWAY ? [40, 40, 40] : [200, 120, 160];
    const hw = Math.max(0.5, r.width / 2);
    for (let k = 0; k + 3 < r.pts.length; k += 2) {
      const ax = r.pts[k], az = r.pts[k + 1], bx = r.pts[k + 2], bz = r.pts[k + 3];
      const L = Math.hypot(bx - ax, bz - az);
      for (let s = 0; s <= L; s += 0.5) for (let q = -hw; q <= hw; q += 0.7) {
        const px = ax + ((bx - ax) * s) / (L || 1) - ((bz - az) / (L || 1)) * q, pz = az + ((bz - az) * s) / (L || 1) + ((bx - ax) / (L || 1)) * q;
        panel(Math.floor(px) - x0, Math.floor(pz) - z0, c);
      }
    }
  }
  // divider
  for (let z = 0; z < S; z++) img.set([0, 0, 0], (z * S * 2 + S) * 3);
  const file = join(outDir, `leonia-topdown-${name}.png`);
  writeFileSync(file, png(S * 2, S, img));
  const chunks = (S / 16) * (S / 16);
  const km2 = (S * S) / 1e6;
  console.log(`${name}: ${S}x${S} m in ${(ms / 1000).toFixed(1)} s → ${(chunks / (ms / 1000)).toFixed(0)} chunks/s (incl. tile builds; ${gen.tiles.loads} tiles built, ${gen.tiles.buildMs.toFixed(0)} ms) · buildings ${nb} (${nsyn} synthetic) = ${(nb / km2).toFixed(0)}/km² · ${file}`);
}

// pure chunk benchmark on warm tiles (16x16 regions, like the server)
{
  const [cx, cz] = lonLatToWorld(-80.1905, 25.7745);
  const c16 = new Uint8Array(16 * 16 * WORLD_H);
  const P = 16 + 2 * 2, c20 = new Uint8Array(P * P * WORLD_H);
  for (let k = 0; k < 64; k++) gen.generateRegion(Math.floor(cx) + (k % 8) * 16, Math.floor(cz) + Math.floor(k / 8) * 16, 16, 16, c16); // warm
  let t0 = performance.now(), n = 0;
  for (let k = 0; k < 1024; k++, n++) gen.generateRegion(Math.floor(cx) - 256 + (k % 32) * 16, Math.floor(cz) - 256 + Math.floor(k / 32) * 16, 16, 16, c16);
  const a = n / ((performance.now() - t0) / 1000);
  t0 = performance.now(); n = 0;
  for (let k = 0; k < 1024; k++, n++) gen.generateRegion(Math.floor(cx) - 256 + (k % 32) * 16 - 2, Math.floor(cz) - 256 + Math.floor(k / 32) * 16 - 2, P, P, c20);
  const b = n / ((performance.now() - t0) / 1000);
  console.log(`benchmark downtown (warm tiles, single thread): ${a.toFixed(0)} chunks/s server-size 16x16, ${b.toFixed(0)} chunks/s client-size 20x20 padded; tile build avg ${(gen.tiles.buildMs / Math.max(1, gen.tiles.loads)).toFixed(0)} ms; heap ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} MB`);
}

/**
 * Map tooling:
 *  - docs/map-overlay.svg : annotated map (land, water, zones, roads, counties, places, POIs, inferred areas)
 *  - docs/map-preview.png : whole-state preview from the real generator rasters (1 px = 4 blocks)
 *  - docs/downtown-topdown.png : full-detail top-down render of downtown Port Solano (1 px = 1 block)
 *  - docs/topdown/<area>.png : the same for every region, landmark and in-between area
 * Run: npm run map:overlay
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { PALMARA } from '../packages/shared/src/content/map/palmara.map.ts';
import { getWorldGen } from '../packages/shared/src/world/worldgen.ts';
import { POIS } from '../packages/shared/src/content/pois.ts';
import { B, BLOCKS } from '../packages/shared/src/world/blocks.ts';
import { WORLD_H } from '../packages/shared/src/constants.ts';

const map = PALMARA;
mkdirSync('docs', { recursive: true });

// ── PNG encoder ──
function crc32(buf: Uint8Array) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(w: number, h: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.subarray(y * w * 3, (y + 1) * w * 3).forEach((v, i) => (raw[y * (w * 3 + 1) + 1 + i] = v)); }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const gen = getWorldGen(map);
const r = gen.r;
const t0 = performance.now();

// ── whole-map preview ──
{
  const S = 4, w = map.width / S, h = map.depth / S;
  const out = new Uint8Array(w * h * 3);
  const ZC: Record<string, [number, number, number]> = {
    none: [96, 160, 80], forest: [56, 120, 60], farmland: [150, 170, 80], wetland: [90, 130, 90], suburb: [200, 196, 180],
    urban: [170, 170, 176], downtown: [140, 140, 150], industrial: [150, 140, 120], airport: [120, 120, 120], resort: [230, 200, 190],
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const wx = x * S + 2, wz = y * S + 2;
    let c: [number, number, number];
    const li = gen.lineInfo(wx, wz);
    if (!r.isLand(wx, wz) || li.river) {
      const dd = -r.distAt(wx, wz);
      c = r.waterBodyAt(wx, wz) === 1 || li.river ? [70, 140, 200] : [30 + Math.max(0, 60 - dd * 2), 110 + Math.max(0, 60 - dd * 2), 190];
      if (li.road) c = [240, 240, 240];
    } else if (li.road) c = li.road.seg.roadKind === 'highway' ? [250, 250, 250] : [225, 225, 225];
    else {
      c = ZC[r.zoneAt(wx, wz)];
      if (r.distAt(wx, wz) <= 3 && !['urban', 'downtown', 'industrial', 'airport', 'wetland'].includes(r.zoneAt(wx, wz))) c = [236, 220, 160];
    }
    out.set(c, (y * w + x) * 3);
  }
  writeFileSync('docs/map-preview.png', png(w, h, out));
}

// ── full-detail top-downs (1 px = 1 block): downtown + every region and the country between ──
const PAL: Record<string, [number, number, number]> = {
  grass: [95, 160, 70], dirt: [120, 90, 60], sand: [230, 214, 160], stone: [128, 128, 128], water: [50, 120, 200], asphalt: [55, 58, 62],
  line_white: [235, 235, 235], line_yellow: [240, 200, 40], sidewalk: [190, 190, 185], concrete: [170, 170, 170], brick: [160, 80, 60],
  glass: [170, 220, 240], window: [80, 120, 160], marble: [235, 235, 230], leaves: [60, 130, 50], palm_leaves: [90, 170, 70],
  stucco_pink: [240, 170, 180], stucco_teal: [100, 200, 190], stucco_yellow: [245, 220, 120], stucco_peach: [245, 190, 150], stucco_white: [240, 240, 235],
  metal: [140, 150, 160], roof_tile: [190, 90, 60], neon_pink: [255, 60, 200], neon_cyan: [40, 240, 255], hedge: [50, 110, 40], chrome: [210, 215, 220],
  police_blue: [40, 70, 160], container_red: [180, 50, 40], container_blue: [40, 80, 160], lamp: [255, 240, 180],
  plank: [185, 138, 85], palm_log: [155, 122, 78], mud: [90, 70, 50], reeds: [143, 174, 85], rail: [120, 128, 136], gravel: [140, 134, 124],
  runway: [74, 78, 85], pine_leaves: [46, 107, 63], dock: [158, 123, 86], farmland: [107, 76, 51], tall_grass: [103, 179, 74], dark_plank: [107, 74, 46],
  flowers: [230, 90, 140], cane: [166, 201, 90], shutter: [140, 148, 156], red_stucco: [217, 68, 58], stripe: [200, 170, 40], tile_floor: [200, 200, 196],
  carpet: [140, 47, 57], crate: [181, 139, 82], counter: [233, 229, 220], shelf: [120, 90, 60], club_floor: [180, 80, 200], screen: [60, 140, 230],
};
const COL: Record<number, [number, number, number]> = {};
for (const b of BLOCKS) COL[b.id] = PAL[b.name] ?? (b.color !== undefined ? [(b.color >> 16) & 255, (b.color >> 8) & 255, b.color & 255] : [200, 0, 200]);
mkdirSync('docs/topdown', { recursive: true });
let totalCols = 0, totalMs = 0;
function topdown(file: string, x0: number, z0: number, W: number, D: number, log = false) {
  const region = new Uint8Array(W * D * WORLD_H);
  const tg = performance.now();
  gen.generateRegion(x0, z0, W, D, region);
  const genMs = performance.now() - tg;
  totalCols += W * D; totalMs += genMs;
  const out = new Uint8Array(W * D * 3);
  for (let z = 0; z < D; z++) for (let x = 0; x < W; x++) {
    let y = WORLD_H - 1;
    while (y > 0 && region[x + z * W + y * W * D] === B.AIR) y--;
    const id = region[x + z * W + y * W * D];
    const c = COL[id] ?? [255, 0, 255];
    // height shading + a light from the north-west for relief
    let yn = WORLD_H - 1; const xn = Math.max(0, x - 1), zn = Math.max(0, z - 1);
    while (yn > 0 && region[xn + zn * W + yn * W * D] === B.AIR) yn--;
    const shade = Math.min(1.3, 0.78 + (y - 20) / 70) * (yn > y ? 0.82 : 1);
    out.set(c.map((v) => Math.min(255, v * shade)) as unknown as number[], (z * W + x) * 3);
  }
  writeFileSync(file, png(W, D, out));
  if (log) console.log(`downtown region ${W}x${D} generated in ${genMs.toFixed(0)} ms (${((W * D) / 256 / (genMs / 1000)).toFixed(0)} chunks/s)`);
}
topdown('docs/downtown-topdown.png', 2368, 2992, 480, 352, true);
const AREAS: [string, number, number, number, number][] = [
  ['bayhaven', 840, 1880, 300, 300], ['cedar_bluff', 1990, 440, 300, 300], ['lakemont', 1560, 1440, 400, 390],
  ['conch_harbor', 1130, 4200, 280, 180], ['cape_halcyon', 2430, 1420, 220, 220], ['halcyon_shore', 2560, 1880, 120, 200],
  ['sawgrass', 1700, 2980, 320, 340], ['farmland', 1370, 1660, 330, 320], ['timberline', 1130, 780, 330, 330],
  ['solano_beach', 2736, 2920, 112, 560], ['coral_keys', 1780, 4080, 360, 200], ['coral_sands', 850, 2360, 270, 300],
  ['turnpike_welcome', 690, 760, 260, 220], ['lake_mirabel', 1860, 2540, 240, 220], ['north_coast', 1380, 300, 260, 200],
  ['palm_haven', 1090, 2950, 250, 250], ['solano_airport', 2140, 3260, 250, 180], ['fire_lookout', 1820, 880, 200, 160],
  ['gulf_coast', 600, 1300, 220, 260], ['cross_glades', 1300, 2980, 300, 160],
];
for (const [n, ax, az, aw, ad] of AREAS) topdown(`docs/topdown/${n}.png`, ax, az, aw, ad);
console.log(`${AREAS.length + 1} top-downs: ${(totalCols / 256 / (totalMs / 1000)).toFixed(0)} chunks/s average`);

// ── annotated SVG overlay ──
{
  const sc = 0.25;
  const poly = (pts: [number, number][]) => pts.map(([x, z]) => `${(x * sc).toFixed(1)},${(z * sc).toFixed(1)}`).join(' ');
  const parts: string[] = [];
  parts.push(`<rect width="100%" height="100%" fill="#2b6fa8"/>`);
  for (const l of map.land) parts.push(`<polygon points="${poly(l.points)}" fill="#6aa05a" stroke="#e9d9a0" stroke-width="1.5"/>`);
  for (const b of map.barriers) parts.push(`<polyline points="${poly(b.points)}" fill="none" stroke="#e9d9a0" stroke-width="${b.width * sc}" stroke-linecap="round"/>`);
  const zc: Record<string, string> = { forest: '#2f6e3a', farmland: '#a7b35a', wetland: '#5c8f6a', suburb: '#cfc6b4', urban: '#a9a9b2', downtown: '#7d7d8c', industrial: '#9a8a70', airport: '#888', resort: '#e7c2b8' };
  for (const z of map.zones) parts.push(`<polygon points="${poly(z.points)}" fill="${zc[z.kind] ?? '#999'}" fill-opacity="0.55"/>`);
  for (const w of map.water) parts.push(`<polygon points="${poly(w.points)}" fill="#3d8fd0"/>`);
  for (const rv of map.rivers) parts.push(`<polyline points="${poly(rv.points)}" fill="none" stroke="#3d8fd0" stroke-width="${rv.width * sc}"/>`);
  for (const rd of map.roads) parts.push(`<polyline points="${poly(rd.points)}" fill="none" stroke="${rd.kind === 'highway' ? '#fff' : '#eee'}" stroke-width="${rd.kind === 'highway' ? 3 : 1.6}" stroke-linejoin="round"/>`);
  for (const c of map.counties) parts.push(`<polygon points="${poly(c.points)}" fill="none" stroke="#fff" stroke-dasharray="6 4" stroke-opacity="0.35"/><text x="${c.label[0] * sc}" y="${c.label[1] * sc}" fill="#fff" font-family="sans-serif" font-weight="700" font-size="18" text-anchor="middle" stroke="#0006" stroke-width="3" paint-order="stroke">${c.name.toUpperCase()}</text>`);
  for (const p of map.places) parts.push(`<circle cx="${p.pos[0] * sc}" cy="${p.pos[1] * sc}" r="3" fill="#ffd34d"/><text x="${p.pos[0] * sc + 6}" y="${p.pos[1] * sc + 4}" fill="#fff" font-family="sans-serif" font-size="12" stroke="#0008" stroke-width="2.5" paint-order="stroke">${p.name}</text>`);
  // inset of downtown POIs
  const ix = 20, iy = 20, isc = 0.9, ox = 2390, oz = 3060;
  parts.push(`<g transform="translate(${ix},${iy})"><rect width="${280 * isc}" height="${230 * isc}" fill="#000a" stroke="#fff"/>`);
  parts.push(`<text x="8" y="16" fill="#ffd34d" font-family="sans-serif" font-size="12" font-weight="700">PORT SOLANO DOWNTOWN (M1 district)</text>`);
  for (const p of POIS) {
    const x = (p.lot[0] * 48 - ox) * isc, y = (p.lot[1] * 48 - oz) * isc + 20;
    parts.push(`<rect x="${x + 6}" y="${y + 6}" width="${36 * isc}" height="${36 * isc}" fill="#ffffff22" stroke="#ffd34d"/><text x="${x + 8}" y="${y + 20}" fill="#fff" font-family="sans-serif" font-size="8">${p.id}</text>`);
  }
  parts.push(`</g>`);
  parts.push(`<text x="${map.width * sc - 10}" y="${map.depth * sc - 30}" fill="#fff" font-family="sans-serif" font-size="11" text-anchor="end">N ↑ · 1 px = 4 blocks · 1 block = 1 m · world ${map.width}×${map.depth}</text>`);
  parts.push(`<text x="${map.width * sc - 10}" y="${map.depth * sc - 14}" fill="#fff" font-family="sans-serif" font-size="11" text-anchor="end">Traced from real Florida geography (stylised); all names original.</text>`);
  writeFileSync('docs/map-overlay.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="${map.width * sc}" height="${map.depth * sc}" viewBox="0 0 ${map.width * sc} ${map.depth * sc}">${parts.join('')}</svg>`);
}
console.log(`map tooling done in ${(performance.now() - t0).toFixed(0)} ms`);

/// <reference lib="webworker" />
/**
 * Far-city LOD worker: fetches a Leonia tile, decodes it (no voxel raster) and returns
 *   - the building mesh for the requested detail level (lodBuild.buildingMesh)
 *   - a GROUND_PX² RGBA ground texture: rgb = land use / roads / roofs / water depth ramp,
 *     a = 255 on water, otherwise 0..127 street-light glow for the night shader.
 * Named 'lod world=leonia' so the shared constants resolve WORLD_H = 256 here.
 */
import { decodeTile, AK, RC, facadeFor, districtAt, type LTile } from '@blockshore/shared';
import { buildingMesh, paintTile, paintGlow, type TilePalette } from './lodBuild';
import { GROUND_PX } from './lodShared';

let colours: Uint8Array = new Uint8Array(256 * 6);
const cache = new Map<number, LTile | null>();
const order: number[] = [];

async function tile(tx: number, tz: number): Promise<LTile | null> {
  const k = tz * 1024 + tx;
  if (cache.has(k)) return cache.get(k)!;
  let t: LTile | null = null;
  try {
    const r = await fetch(`${self.location.origin}/world/leonia/t_${tx}_${tz}.bin`);
    if (r.ok) t = decodeTile(new Uint8Array(await r.arrayBuffer()));
  } catch { t = null; }
  cache.set(k, t); order.push(k);
  while (order.length > 24) cache.delete(order.shift()!);
  return t;
}

const hex = (r: number, g: number, b: number) => `rgb(${r | 0},${g | 0},${b | 0})`;
function col(id: number, side = false): [number, number, number] { const o = id * 6 + (side ? 3 : 0); return [colours[o], colours[o + 1], colours[o + 2]]; }
const shade = (c: [number, number, number], k: number) => hex(c[0] * k, c[1] * k, c[2] * k);
const mixc = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
let pal: TilePalette | null = null;
/** block ids by name for the palette (sent with the colours) */
let ids: Record<string, number> = {};

function palette(): TilePalette {
  if (pal) return pal;
  const id = (n: string) => ids[n] ?? 0;
  const grass = col(id('grass')), asphalt = col(id('asphalt')), side = col(id('sidewalk')), sand = col(id('sand')), conc = col(id('concrete'));
  const leaves = col(id('leaves')), gravel = col(id('gravel')), dirt = col(id('dirt')), fair = col(id('fairway')), dock = col(id('dock'));
  const runway = col(id('runway')), granite = col(id('granite')), marble = col(id('marble')), court = col(id('court_green'));
  // block-average greens are vivid; seen from far away lawns mix with tree canopy, roofs and drives
  const lawn = mixc(mixc(grass, leaves, 0.35), conc, 0.18), yard = mixc(lawn, conc, 0.3), canopy = mixc(leaves, grass, 0.2);
  const areas: Record<number, string> = {
    [AK.RESIDENTIAL]: shade(yard, 0.85), [AK.COMMERCIAL]: shade(conc, 0.85), [AK.RETAIL]: shade(conc, 0.85), [AK.INDUSTRIAL]: shade(conc, 0.78),
    [AK.PORT]: shade(conc, 0.8), [AK.RAILWAY]: shade(gravel, 0.9), [AK.CONSTRUCTION]: shade(dirt, 1), [AK.MILITARY]: shade(lawn, 0.8),
    [AK.EDUCATION]: shade(lawn, 0.9), [AK.HOSPITAL]: shade(conc, 0.9), [AK.AERODROME]: shade(lawn, 0.95), [AK.RELIGIOUS]: shade(lawn, 0.9),
    [AK.FARMLAND]: shade(dirt, 0.9),
    [AK.GRASS]: shade(lawn, 1), [AK.PARK]: shade(lawn, 0.9), [AK.GARDEN]: shade(lawn, 0.9), [AK.FOREST]: shade(canopy, 0.85), [AK.SCRUB]: shade(canopy, 1),
    [AK.WETLAND]: shade(canopy, 0.9), [AK.CEMETERY]: shade(lawn, 0.95), [AK.GOLF]: shade(fair, 1), [AK.GOLF_ROUGH]: shade(lawn, 0.9),
    [AK.GOLF_FAIRWAY]: shade(fair, 1.05), [AK.GOLF_GREEN]: shade(fair, 1.1), [AK.GOLF_TEE]: shade(fair, 1.05), [AK.GOLF_BUNKER]: shade(sand, 1),
    [AK.BEACH]: shade(sand, 1.02), [AK.SAND]: shade(sand, 1), [AK.PARKING]: shade(asphalt, 1.1), [AK.PITCH]: shade(court, 1), [AK.PLAYGROUND]: shade(sand, 0.9),
    [AK.PLAZA]: shade(marble, 0.9), [AK.APRON]: shade(runway, 1.05), [AK.RUNWAY]: shade(runway, 1), [AK.HELIPAD]: shade(conc, 1),
    [AK.MARINA]: shade(dock, 0.9), [AK.PIER]: shade(dock, 1), [AK.BREAKWATER]: shade(granite, 1), [AK.BRIDGE]: shade(conc, 1),
    [AK.POOL]: 'rgb(70,190,210)', [AK.STADIUM]: shade(conc, 0.95), [AK.NATURE]: shade(canopy, 0.95), [AK.TRACK]: 'rgb(170,80,60)',
    [AK.ZOO]: shade(lawn, 0.9), [AK.CAMPUS_GREEN]: shade(lawn, 1), [AK.DOG_PARK]: shade(lawn, 0.95),
  };
  const asp = shade(asphalt, 1), aspL = shade(asphalt, 1.15);
  pal = {
    land: shade(yard, 0.85),
    area: (k) => areas[k] ?? null,
    water: (dm) => {
      // shallow turquoise near the shore → deep blue; the shader adds reflections
      const t = Math.min(1, dm / 60);
      return [Math.round(30 + (12 - 30) * t), Math.round(120 + (60 - 120) * t), Math.round(125 + (105 - 125) * t)];
    },
    road: (c) => {
      if (c === RC.FOOTWAY || c === RC.PATH || c === RC.CYCLEWAY || c === RC.STEPS || c === RC.TRACK) return { fill: shade(side, 0.95), edge: null, minPx: 0 };
      if (c >= RC.RAIL && c <= RC.MONORAIL) return { fill: shade(gravel, 0.8), edge: null, minPx: 0.5 };
      if (c === RC.PIER) return { fill: shade(dock, 1), edge: null, minPx: 0.5 };
      if (c === RC.BREAKWATER) return { fill: shade(granite, 1), edge: null, minPx: 0.5 };
      if (c === RC.RUNWAY || c === RC.TAXIWAY) return { fill: shade(runway, 1), edge: null, minPx: 1 };
      if (c === RC.PEDESTRIAN) return { fill: shade(marble, 0.85), edge: null, minPx: 0.5 };
      return { fill: c <= RC.PRIMARY ? asp : aspL, edge: null, minPx: c <= RC.SECONDARY ? 1 : 0.5 };
    },
    sidewalk: shade(side, 1),
    // roofs: the LOD boxes drop small buildings at distance, so their roofs live in the ground texture
    building: (b) => {
      const w = b.bbox[2] - b.bbox[0], d = b.bbox[3] - b.bbox[1];
      const f = facadeFor(b, Math.max(1, Math.floor(Math.min(w, d) / 2)), districtAt((b.bbox[0] + b.bbox[2]) / 2, (b.bbox[1] + b.bbox[3]) / 2).style);
      return shade(col(f.roof), 0.9);
    },
  };
  return pal;
}

interface Canvases { ctx: OffscreenCanvasRenderingContext2D; glow: OffscreenCanvasRenderingContext2D; scratch: { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } }
const canvases = new Map<number, Canvases>();

function ground(t: LTile, S = GROUND_PX): Uint8Array {
  if (typeof OffscreenCanvas === 'undefined') {
    // no 2D canvas in workers: water mask only
    const out = new Uint8Array(S * S * 4);
    const st = 512 / S;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const w = t.water[Math.floor((y + 0.5) * st) * 512 + Math.floor((x + 0.5) * st)];
      const o = (y * S + x) * 4;
      if (w) { out[o] = 20; out[o + 1] = 90; out[o + 2] = 115; out[o + 3] = 255; } else { out[o] = 120; out[o + 1] = 130; out[o + 2] = 100; out[o + 3] = 0; }
    }
    return out;
  }
  let c = canvases.get(S);
  if (!c) {
    const sc = new OffscreenCanvas(S, S);
    c = {
      ctx: new OffscreenCanvas(S, S).getContext('2d', { willReadFrequently: true })!,
      glow: new OffscreenCanvas(S, S).getContext('2d', { willReadFrequently: true })!,
      scratch: { canvas: sc, ctx: sc.getContext('2d')! },
    };
    canvases.set(S, c);
  }
  const p = palette();
  paintTile(c.ctx, t, S, p, c.scratch);
  paintGlow(c.glow, t, S);
  const rgb = c.ctx.getImageData(0, 0, S, S).data;
  const gl = c.glow.getImageData(0, 0, S, S).data;
  const out = new Uint8Array(S * S * 4);
  const st = 512 / S;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = y * S + x, o = i * 4;
    out[o] = rgb[o]; out[o + 1] = rgb[o + 1]; out[o + 2] = rgb[o + 2];
    const w = t.water[Math.floor((y + 0.5) * st) * 512 + Math.floor((x + 0.5) * st)];
    out[o + 3] = w && gl[o] < 40 ? 255 : Math.round(gl[o] / 2);
  }
  return out;
}

self.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  if (m.type === 'init') { colours = m.colours; ids = m.ids; pal = null; return; }
  if (m.type === 'tile') {
    const t = await tile(m.tx, m.tz);
    // open sea: nothing to draw (the ocean plane covers it)
    if (t && !t.buildings.length && !t.roads.length && !t.areas.length && t.water.every((v) => v === 1)) { (self as unknown as Worker).postMessage({ type: 'tile', tx: m.tx, tz: m.tz, level: m.level, empty: true }); return; }
    if (!t) { (self as unknown as Worker).postMessage({ type: 'tile', tx: m.tx, tz: m.tz, level: m.level, empty: true }); return; }
    const mesh = buildingMesh(t, colours, m.level);
    const g = m.ground ? ground(t, m.ground) : null;
    const tr: Transferable[] = [mesh.pos.buffer, mesh.nrm.buffer, mesh.col.buffer, mesh.idx.buffer];
    if (g) tr.push(g.buffer);
    (self as unknown as Worker).postMessage({ type: 'tile', tx: m.tx, tz: m.tz, level: m.level, mesh, ground: g, groundPx: m.ground || 0 }, tr);
  }
};

/**
 * Pre-rendered map texture for the selected world, built progressively so the UI never freezes.
 * 1 texture pixel = MAP_SCALE world blocks.
 *
 *  - Palmara: from the shared world-generator rasters (time-sliced on the main thread) plus the
 *    road / river vectors and the 48-block street grid.
 *  - Leonia (real-data world, 22 × 24 km): a worker (render/lod/mapWorker.ts) paints each 512 m
 *    tile from the tile data (water depth, land use, roads by class) into an 8 m/px overview,
 *    nearest-to-the-player first. Close zooms use detail tiles (2 m/px, with building footprints)
 *    requested on demand through getDetailTile() and kept in a small LRU.
 */
import { PALMARA, getWorldGen, ZONE_KINDS, WORLD, LEONIA, DISTRICTS, districtAt } from '@blockshore/shared';
import { ZONE_COLORS } from './util';

const IS_LEONIA = WORLD === 'leonia';

/** world shown by the map UI */
export const MAP_WORLD = IS_LEONIA
  ? { id: 'leonia' as const, name: 'Leonia', width: LEONIA.width, depth: LEONIA.depth, attribution: LEONIA.attribution }
  : { id: 'palmara' as const, name: 'Palmara', width: PALMARA.width, depth: PALMARA.depth, attribution: '' };

export const MAP_SCALE = IS_LEONIA ? 8 : 3;
export const MAP_W = Math.ceil(MAP_WORLD.width / MAP_SCALE);
export const MAP_H = Math.ceil(MAP_WORLD.depth / MAP_SCALE);
/** Leonia tiles: metres per tile, overview / detail pixels per tile */
export const TILE_M = 512;
const OVERVIEW_PX = TILE_M / MAP_SCALE;
export const DETAIL_PX = 256;

export interface MapTex { canvas: HTMLCanvasElement; progress: number; ready: boolean }

let tex: MapTex | null = null;
const listeners = new Set<(t: MapTex) => void>();
export function onMapTexture(cb: (t: MapTex) => void) { listeners.add(cb); return () => { listeners.delete(cb); }; }

/** labels for the map: Leonia districts (box centres), empty for Palmara (it has its own places) */
export const MAP_LABELS: { id: string; name: string; x: number; z: number; big: boolean }[] = IS_LEONIA
  ? DISTRICTS.map((d) => ({ id: d.id, name: d.name, x: (d.x0 + d.x1) / 2, z: (d.z0 + d.z1) / 2, big: (d.x1 - d.x0) * (d.z1 - d.z0) > 12e6 }))
  : [];

/** "where am I" text for Leonia (district + state) */
export function leoniaLocation(x: number, z: number): { county: string; place: string } {
  if (x < 0 || z < 0 || x >= MAP_WORLD.width || z >= MAP_WORLD.depth) return { county: 'Open sea', place: '' };
  return { county: 'Leonia', place: districtAt(x, z).name };
}

// ───────────────────────────────────────────────────────────── Leonia (worker tiles)

let focusX = IS_LEONIA ? LEONIA.spawn[0] : 0, focusZ = IS_LEONIA ? LEONIA.spawn[2] : 0;
/** hint for the build order (the minimap calls this with the player position) */
export function setMapFocus(x: number, z: number) { focusX = x; focusZ = z; }

interface Req { id: number; tx: number; tz: number; px: number; detail: boolean }
let worker: Worker | null = null;
let nextId = 1;
const inflight = new Map<number, Req>();
const overviewQueue: { tx: number; tz: number }[] = [];
const detailWanted: { tx: number; tz: number; at: number }[] = [];
const detail = new Map<number, ImageBitmap | 'pending'>();
const detailOrder: number[] = [];
const detailListeners = new Set<() => void>();
const DETAIL_MAX = 96;
const NT_X = Math.ceil(MAP_WORLD.width / TILE_M), NT_Z = Math.ceil(MAP_WORLD.depth / TILE_M);
let overviewDone = 0;
let emitAt = 0;

export function onDetailTile(cb: () => void) { detailListeners.add(cb); return () => { detailListeners.delete(cb); }; }

/** 2 m/px tile bitmap (null while it is being painted; the request is queued) */
export function getDetailTile(tx: number, tz: number): ImageBitmap | null {
  if (!IS_LEONIA || tx < 0 || tz < 0 || tx >= NT_X || tz >= NT_Z) return null;
  const k = tz * 1024 + tx;
  const v = detail.get(k);
  if (v && v !== 'pending') return v;
  if (!v) {
    detail.set(k, 'pending');
    detailWanted.push({ tx, tz, at: performance.now() });
    pump();
  }
  return null;
}

function pump() {
  if (!worker) return;
  while (inflight.size < 4) {
    let r: Req | null = null;
    // detail requests first (newest first: they belong to the current view)
    while (detailWanted.length && !r) {
      const d = detailWanted.pop()!;
      if (performance.now() - d.at > 4000) { detail.delete(d.tz * 1024 + d.tx); continue; }
      r = { id: nextId++, tx: d.tx, tz: d.tz, px: DETAIL_PX, detail: true };
    }
    if (!r && overviewQueue.length) {
      // nearest to the focus first (re-picked each time: the player moves)
      const fx = focusX / TILE_M, fz = focusZ / TILE_M;
      let best = 0, bd = Infinity;
      for (let i = 0; i < overviewQueue.length; i++) {
        const q = overviewQueue[i];
        const d = (q.tx + 0.5 - fx) ** 2 + (q.tz + 0.5 - fz) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      const q = overviewQueue.splice(best, 1)[0];
      r = { id: nextId++, tx: q.tx, tz: q.tz, px: OVERVIEW_PX, detail: false };
    }
    if (!r) return;
    inflight.set(r.id, r);
    worker.postMessage(r);
  }
}

function startLeonia(t: MapTex, ctx: CanvasRenderingContext2D) {
  worker = new Worker(new URL('../render/lod/mapWorker.ts', import.meta.url), { type: 'module', name: 'map world=leonia' });
  for (let tz = 0; tz < NT_Z; tz++) for (let tx = 0; tx < NT_X; tx++) overviewQueue.push({ tx, tz });
  const total = overviewQueue.length;
  const emit = (force = false) => {
    const now = performance.now();
    if (!force && now - emitAt < 150) return;
    emitAt = now;
    for (const l of listeners) l(t);
  };
  worker.onmessage = (e: MessageEvent<{ id: number; tx: number; tz: number; px: number; detail: boolean; bmp: ImageBitmap }>) => {
    const m = e.data;
    inflight.delete(m.id);
    if (m.detail) {
      const k = m.tz * 1024 + m.tx;
      detail.set(k, m.bmp);
      detailOrder.push(k);
      while (detailOrder.length > DETAIL_MAX) {
        const old = detailOrder.shift()!;
        const b = detail.get(old);
        if (b && b !== 'pending') b.close();
        detail.delete(old);
      }
      for (const l of detailListeners) l();
    } else {
      ctx.drawImage(m.bmp, m.tx * OVERVIEW_PX, m.tz * OVERVIEW_PX);
      m.bmp.close();
      overviewDone++;
      t.progress = overviewDone / total;
      if (overviewDone >= total) { t.ready = true; t.progress = 1; emit(true); } else emit();
    }
    pump();
  };
  pump();
}

// ───────────────────────────────────────────────────────────── Palmara (main-thread raster)

function rgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const mix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

const ZONE_RGB = ZONE_KINDS.map((k) => rgb(ZONE_COLORS[k] ?? '#2f6b3c'));
const SAND = rgb('#f1dfa6');
const STREET = rgb('#55507a');
const LAKE = rgb('#4cc9d8');
const SEA_SHALLOW = rgb('#43d6d0');
const SEA_MID = rgb('#2a8fd0');
const SEA_DEEP = rgb('#16356f');
const URBANISH = new Set(['suburb', 'urban', 'downtown', 'industrial', 'resort']);

export function getMapTexture(): MapTex {
  if (tex) return tex;
  const canvas = document.createElement('canvas');
  canvas.width = MAP_W; canvas.height = MAP_H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#16356f';
  ctx.fillRect(0, 0, MAP_W, MAP_H);
  const t: MapTex = (tex = { canvas, progress: 0, ready: false });
  if (IS_LEONIA) { startLeonia(t, ctx); return t; }
  const emit = () => { for (const l of listeners) l(t); };

  const ROWS = 12;
  let row = 0;
  let wg: ReturnType<typeof getWorldGen> | null = null;
  const img = ctx.createImageData(MAP_W, ROWS);

  const slice = () => {
    if (!wg) wg = getWorldGen(PALMARA);
    const r = wg.r;
    const start = performance.now();
    while (row < MAP_H && performance.now() - start < 9) {
      const rows = Math.min(ROWS, MAP_H - row);
      const d = img.data;
      for (let ry = 0; ry < rows; ry++) {
        const wz = (row + ry + 0.5) * MAP_SCALE;
        for (let px = 0; px < MAP_W; px++) {
          const wx = (px + 0.5) * MAP_SCALE;
          let c: [number, number, number];
          if (r.isLand(wx, wz)) {
            const zi = r.zoneIdx(wx, wz);
            c = ZONE_RGB[zi] ?? ZONE_RGB[0];
            const dist = r.distAt(wx, wz);
            if (dist <= 2) c = mix(SAND, c, Math.max(0, (dist - 1) / 2));
            if (URBANISH.has(ZONE_KINDS[zi]) && (((wx | 0) % 48) < 8 || ((wz | 0) % 48) < 8)) c = mix(c, STREET, 0.8);
          } else if (r.waterBodyAt(wx, wz) === 1) {
            c = mix(LAKE, SEA_MID, Math.min(1, Math.max(0, -r.distAt(wx, wz) - 2) / 14) * 0.6);
          } else {
            const dd = Math.min(24, Math.max(0, -r.distAt(wx, wz)));
            c = dd < 5 ? mix(SEA_SHALLOW, SEA_MID, dd / 5) : mix(SEA_MID, SEA_DEEP, Math.min(1, (dd - 5) / 18));
          }
          const o = (ry * MAP_W + px) * 4;
          d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, row, 0, 0, MAP_W, rows);
      row += rows;
    }
    t.progress = (row / MAP_H) * 0.95;
    emit();
    if (row < MAP_H) { setTimeout(slice, 0); return; }
    drawVectors(ctx);
    t.progress = 1; t.ready = true;
    emit();
  };
  setTimeout(slice, 0);
  return t;
}

function drawVectors(ctx: CanvasRenderingContext2D) {
  const k = 1 / MAP_SCALE;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const stroke = (pts: [number, number][], w: number, color: string) => {
    ctx.beginPath();
    pts.forEach(([x, z], i) => (i ? ctx.lineTo(x * k, z * k) : ctx.moveTo(x * k, z * k)));
    ctx.lineWidth = w * k; ctx.strokeStyle = color; ctx.stroke();
  };
  for (const rv of PALMARA.rivers) stroke(rv.points, rv.width, '#4cc9d8');
  const order = { street: 0, arterial: 1, highway: 2 } as const;
  const roads = [...PALMARA.roads].sort((a, b) => order[a.kind] - order[b.kind]);
  for (const rd of roads) {
    const w = rd.kind === 'highway' ? 16 : rd.kind === 'arterial' ? 10 : 7;
    stroke(rd.points, w + 6, '#241a45');
  }
  for (const rd of roads) {
    const w = rd.kind === 'highway' ? 16 : rd.kind === 'arterial' ? 10 : 7;
    stroke(rd.points, w, rd.kind === 'highway' ? '#ffb347' : rd.kind === 'arterial' ? '#fff3d6' : '#d9d4ee');
  }
  ctx.restore();
}

/// <reference lib="webworker" />
/**
 * Map tiles for the Leonia map UI (ui/mapTexture.ts): paints one 512 m tile from the tile data
 * in the game's map style (same painter as the far-city LOD ground, different palette) and
 * returns an ImageBitmap. Overview tiles (64 px, 8 m/px) skip building footprints; detail
 * tiles (256 px, 2 m/px) draw them.
 */
import { decodeTile, AK, RC, BK, BF, type LTile } from '@blockshore/shared';
import { paintTile, type TilePalette } from './lodBuild';

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
  while (order.length > 48) cache.delete(order.shift()!);
  return t;
}

const rgb = (h: string): [number, number, number] => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const mix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const SEA_SHALLOW = rgb('#43d6d0'), SEA_MID = rgb('#2a8fd0'), SEA_DEEP = rgb('#16356f');

// map style (matches the Palmara map: purple streets, warm highways, teal shallows)
const AREA: Record<number, string> = {
  [AK.RESIDENTIAL]: '#8fb06a', [AK.COMMERCIAL]: '#a9a9b8', [AK.RETAIL]: '#b3a9c4', [AK.INDUSTRIAL]: '#8b8896', [AK.PORT]: '#8b8896',
  [AK.RAILWAY]: '#8a8494', [AK.CONSTRUCTION]: '#a8957a', [AK.MILITARY]: '#7f9a68', [AK.EDUCATION]: '#b9c48e', [AK.HOSPITAL]: '#c9b0b8',
  [AK.AERODROME]: '#b8bcc4', [AK.RELIGIOUS]: '#a9b88a', [AK.FARMLAND]: '#7aa044',
  [AK.GRASS]: '#79b45a', [AK.PARK]: '#5fa850', [AK.GARDEN]: '#6aad55', [AK.FOREST]: '#1f5a36', [AK.SCRUB]: '#4f8a46', [AK.WETLAND]: '#3f8a63',
  [AK.CEMETERY]: '#7aa070', [AK.GOLF]: '#6fbf5a', [AK.GOLF_ROUGH]: '#5aa84a', [AK.GOLF_FAIRWAY]: '#7fd068', [AK.GOLF_GREEN]: '#8fe07a', [AK.GOLF_TEE]: '#7fd068',
  [AK.GOLF_BUNKER]: '#f1dfa6', [AK.BEACH]: '#f1dfa6', [AK.SAND]: '#ecd89a', [AK.PARKING]: '#9a96aa', [AK.PITCH]: '#5bb878', [AK.PLAYGROUND]: '#d9c48a',
  [AK.PLAZA]: '#cfc8dc', [AK.APRON]: '#a4a8b4', [AK.RUNWAY]: '#6e6a80', [AK.HELIPAD]: '#a4a8b4', [AK.MARINA]: '#c8a878', [AK.PIER]: '#c8a878',
  [AK.BREAKWATER]: '#8a8494', [AK.BRIDGE]: '#cfc8dc', [AK.POOL]: '#4cc9d8', [AK.STADIUM]: '#b0aac0', [AK.NATURE]: '#2f7a46', [AK.TRACK]: '#c46a50',
  [AK.ZOO]: '#6aa858', [AK.CAMPUS_GREEN]: '#79b45a', [AK.DOG_PARK]: '#79b45a',
};
function roadStyle(c: number, detail: boolean): { fill: string; edge: string | null; minPx: number } | null {
  if (c === RC.MOTORWAY || c === RC.TRUNK) return { fill: '#ffb347', edge: '#241a45', minPx: detail ? 3 : 1.6 };
  if (c === RC.PRIMARY) return { fill: '#ffd98a', edge: '#241a45', minPx: detail ? 2.5 : 1.3 };
  if (c === RC.SECONDARY || c === RC.TERTIARY) return { fill: '#fff3d6', edge: detail ? '#3a2e66' : null, minPx: detail ? 2 : 1 };
  if (c === RC.RESIDENTIAL || c === RC.LIVING || c === RC.UNCLASSIFIED) return { fill: '#d9d4ee', edge: null, minPx: detail ? 1.4 : 0.6 };
  if (c === RC.SERVICE) return detail ? { fill: '#c6c0dc', edge: null, minPx: 0.8 } : null;
  if (c === RC.PEDESTRIAN) return { fill: '#e8e2f4', edge: null, minPx: detail ? 1 : 0 };
  if (c >= RC.FOOTWAY && c <= RC.TRACK) return detail ? { fill: '#efe6c8', edge: null, minPx: 0.6 } : null;
  if (c === RC.RUNWAY) return { fill: '#55507a', edge: null, minPx: 1.5 };
  if (c === RC.TAXIWAY) return { fill: '#6e6a8a', edge: null, minPx: 0.8 };
  if (c >= RC.RAIL && c <= RC.MONORAIL) return { fill: '#5a5470', edge: null, minPx: detail ? 1.2 : 0.7 };
  if (c === RC.PIER) return { fill: '#c8a878', edge: null, minPx: 0.8 };
  if (c === RC.BREAKWATER) return { fill: '#8a8494', edge: null, minPx: 0.8 };
  return null;
}
function buildingColour(kind: number, flags: number, h: number): string {
  if (h >= 60) return '#6c62a0';
  if (h >= 25) return '#7d74ac';
  if (kind === BK.HOUSE || kind === BK.RESIDENTIAL) return flags & BF.SYNTHETIC ? '#c9b08e' : '#d4b48a';
  if (kind === BK.WAREHOUSE || kind === BK.INDUSTRIAL || kind === BK.HANGAR) return '#a39fb4';
  return '#b4a6c8';
}
const palettes = [false, true].map((detail): TilePalette => ({
  land: '#97b578',
  area: (k) => AREA[k] ?? null,
  water: (dm) => {
    const d = dm / 4; // metres → "blocks of depth" feel of the Palmara map ramp
    const c = d < 5 ? mix(SEA_SHALLOW, SEA_MID, d / 5) : mix(SEA_MID, SEA_DEEP, Math.min(1, (d - 5) / 18));
    return [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])];
  },
  road: (c) => roadStyle(c, detail),
  sidewalk: null,
  building: detail ? (b) => buildingColour(b.kind, b.flags, b.height - b.minHeight) : null,
  buildingEdge: detail ? 'rgba(36,26,69,0.35)' : null,
}));

const canvases = new Map<number, { c: OffscreenCanvas; x: OffscreenCanvasRenderingContext2D; s: { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D } }>();
function surface(S: number) {
  let v = canvases.get(S);
  if (!v) {
    const c = new OffscreenCanvas(S, S), sc = new OffscreenCanvas(S, S);
    v = { c, x: c.getContext('2d')!, s: { canvas: sc, ctx: sc.getContext('2d')! } };
    canvases.set(S, v);
  }
  return v;
}

self.onmessage = async (e: MessageEvent<{ id: number; tx: number; tz: number; px: number; detail: boolean }>) => {
  const { id, tx, tz, px, detail } = e.data;
  const t = await tile(tx, tz);
  const v = surface(px);
  if (!t) {
    v.x.fillStyle = '#16356f'; v.x.fillRect(0, 0, px, px);
  } else paintTile(v.x, t, px, palettes[detail ? 1 : 0], v.s);
  // bitmap copy of the canvas (the canvas is reused for the next tile)
  const bmp = await createImageBitmap(v.c);
  (self as unknown as Worker).postMessage({ id, tx, tz, px, detail, bmp, empty: !t }, [bmp]);
};

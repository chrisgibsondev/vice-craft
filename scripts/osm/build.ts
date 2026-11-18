/**
 * Leonia build: OSM (BBBike Miami PBF extract + Overpass gap tiles) → compact binary tiles.
 *   NODE_OPTIONS=--max-old-space-size=12000 npx tsx scripts/osm/build.ts
 * Steps: load + dedupe → project → classify → land/water mask (coastline flood fill +
 * inland water) → bridge deck profiles → junctions → procedural infill of bare developed
 * frontage → per-tile clip/simplify/quantise/encode → index.json + credits + stats.
 * Data © OpenStreetMap contributors (ODbL 1.0).
 */
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { RAW_DIR, OUT_DIR, ROOT } from './config.ts';
import { readPbf, type OsmEl } from './pbf.ts';
import { LEONIA_PROJ, lonLatToWorld } from '../../packages/shared/src/world/leonia/proj.ts';
import { DISTRICTS, districtAt } from '../../packages/shared/src/world/leonia/districts.ts';
import { TILE, TILE_MAGIC, TILE_VERSION, AK, BK, ROOF, BF, RC, RF, POI, LU_MAX, Writer, isCarRoad, isRail } from '../../packages/shared/src/world/leonia/format.ts';
import { areaKind, isWaterArea, waterwayWidth, buildingKind, roofShape, buildingHeight, colourCode, roadClass, roadDims, poiCat, type Tags } from './classify.ts';
import { png } from './png.ts';
import { computeDecks, simplifyDeckIdx } from './decks.ts';
import { assembleRings, ringArea, simplify, simplifyRing, quantLine, clipRing, fillRings, strokeLine, type Pt } from './geom.ts';

const t00 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t00) / 1000).toFixed(1)}s]`, ...a);
const W = LEONIA_PROJ.width, D = LEONIA_PROJ.depth;
const TX = Math.ceil(W / TILE), TZ = Math.ceil(D / TILE);
// Geofabrik Florida (full coverage) is preferred; the BBBike Miami extract is the fallback.
const PBF_FL = join(ROOT, '.cache/osm/pbf/florida-latest.osm.pbf');
const PBF = existsSync(PBF_FL) ? PBF_FL : join(ROOT, '.cache/osm/pbf/Miami.osm.pbf');
const PBF_BBOX = { s: LEONIA_PROJ.latS - 0.02, n: LEONIA_PROJ.latN + 0.02, w: LEONIA_PROJ.lonW - 0.02, e: LEONIA_PROJ.lonE + 0.02 };

// ───────────────────────────────────────────────────────────── load + dedupe
const ways = new Map<number, OsmEl>(), rels = new Map<number, OsmEl>(), nodes = new Map<number, OsmEl>();
const addEl = (e: OsmEl) => {
  const m = e.type === 'way' ? ways : e.type === 'relation' ? rels : nodes;
  const old = m.get(e.id);
  const size = (x: OsmEl) => (x.geometry?.length ?? 0) + (x.members?.reduce((s, mm) => s + (mm.geometry?.length ?? 0), 0) ?? 0);
  if (!old || size(e) > size(old)) m.set(e.id, e);
};
let srcPbf = 0, srcOverpass = 0;
if (existsSync(PBF)) {
  const d = readPbf(PBF, PBF_BBOX);
  for (const e of d.nodes) addEl(e);
  for (const e of d.ways) if (e.tags && Object.keys(e.tags).length) addEl(e);
  for (const e of d.relations) addEl(e);
  srcPbf = d.ways.length;
  log('pbf', d.nodes.length, 'tagged nodes', d.ways.length, 'ways', d.relations.length, 'relations');
}
if (existsSync(RAW_DIR)) for (const f of readdirSync(RAW_DIR).filter((f) => f.endsWith('.json'))) {
  const j = JSON.parse(readFileSync(join(RAW_DIR, f), 'utf8')) as { elements?: OsmEl[] };
  for (const e of j.elements ?? []) { if (e.type === 'way' && !e.tags) continue; addEl(e); srcOverpass++; }
}
log('merged', nodes.size, 'nodes', ways.size, 'ways', rels.size, 'relations; overpass elements', srcOverpass);

const proj = (g: { lat: number; lon: number }[]): Pt[] => g.map((p) => lonLatToWorld(p.lon, p.lat));
const inWorld = (pts: Pt[], m = 200) => pts.some(([x, z]) => x > -m && z > -m && x < W + m && z < D + m);

// ───────────────────────────────────────────────────────────── classify
interface FArea { kind: number; rings: Pt[][]; area: number; angle: number }
interface FBld { kind: number; roof: number; flags: number; h: number; min: number; levels: number; name: string; seed: number; colour: number; rings: Pt[][] }
interface FRoad { cls: number; lanes: number; width: number; flags: number; layer: number; name: string; pts: Pt[]; nodes: number[]; deck?: number[] }
interface FPoi { cat: number; arg: number; x: number; z: number }
const areas: FArea[] = [], blds: FBld[] = [], roads: FRoad[] = [], pois: FPoi[] = [];
const tunnels: { cls: number; pts: Pt[] }[] = [];
const waterPolys: Pt[][][] = [], waterLines: { pts: Pt[]; hw: number }[] = [], coast: Pt[][] = [];
const stats = { heightTag: 0, levelsTag: 0, defaultH: 0, synthetic: 0, roadsByClass: {} as Record<string, number>, roadKm: 0, droppedTunnels: 0 };

/** dominant edge angle (0..pi) of the largest ring, for aligning parking bays / container rows */
function domAngle(r: Pt[]): number {
  const bins = new Float64Array(36);
  for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let ang = Math.atan2(b[1] - a[1], b[0] - a[0]); if (ang < 0) ang += Math.PI; if (ang >= Math.PI) ang -= Math.PI;
    bins[Math.floor((ang / Math.PI) * 36) % 36] += L;
  }
  let bi = 0; for (let i = 1; i < 36; i++) if (bins[i] > bins[bi]) bi = i;
  return ((bi + 0.5) / 36) * Math.PI;
}
function hashSeed(id: number) { let h = (id * 2654435761) >>> 0; h ^= h >>> 15; h = Math.imul(h, 2246822519) >>> 0; return (h ^ (h >>> 13)) >>> 0; }

function addPolygon(tags: Tags, rings: Pt[][], id: number) {
  rings = rings.filter((r) => r.length >= 3);
  if (!rings.length || !rings.some((r) => inWorld(r))) return;
  // largest ring is the outer one (even-odd fill makes ring order irrelevant beyond that)
  rings.sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)));
  const outerArea = Math.abs(ringArea(rings[0]));
  const holes = rings.slice(1).reduce((s, r) => s + Math.abs(ringArea(r)), 0);
  const area = outerArea - holes;
  if (tags.building || tags['building:part']) {
    if (tags.building === 'no' || tags['building:part'] === 'no' || area < 6) return;
    const isPart = !tags.building && !!tags['building:part'];
    const kind = buildingKind(tags);
    const hh = buildingHeight(tags, kind, area);
    if (tags.location === 'underground' || (tags.layer && +tags.layer < 0 && !tags.height)) return;
    let flags = isPart ? BF.PART : 0;
    if (hh.src === 'height') { flags |= BF.REAL_HEIGHT; stats.heightTag++; } else if (hh.src === 'levels') { flags |= BF.LEVELS; stats.levelsTag++; } else stats.defaultH++;
    blds.push({ kind, roof: roofShape(tags), flags, h: hh.h, min: hh.min, levels: Math.min(255, Math.round(hh.levels)), name: tags.name ?? '', seed: hashSeed(id), colour: colourCode(tags['building:colour']), rings });
    return;
  }
  if (isWaterArea(tags) && tags.tunnel !== 'culvert') { waterPolys.push(rings); return; }
  const k = areaKind(tags);
  if (k) areas.push({ kind: k, rings, area, angle: domAngle(rings[0]) });
}

for (const w of ways.values()) {
  const t = w.tags ?? {};
  if (!w.geometry || w.geometry.length < 2) continue;
  const pts = proj(w.geometry);
  if (!inWorld(pts)) continue;
  const closed = w.nodes ? w.nodes.length >= 4 && w.nodes[0] === w.nodes[w.nodes.length - 1] : (pts.length >= 4 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]);
  if (t.natural === 'coastline') { coast.push(pts); continue; }
  const cls = roadClass(t);
  const asArea = closed && (t.area === 'yes' || cls === RC.PIER || cls === RC.BREAKWATER);
  if (cls && !asArea) {
    const dims = roadDims(t, cls);
    if (dims.flags & RF.TUNNEL) { stats.droppedTunnels++; if (isCarRoad(cls) || isRail(cls)) tunnels.push({ cls, pts }); continue; }
    const layer = Math.max(-5, Math.min(5, parseInt(t.layer ?? '0', 10) || 0));
    roads.push({ cls, lanes: dims.lanes, width: dims.width, flags: dims.flags, layer, name: t.name ?? '', pts, nodes: w.nodes ?? [] });
    stats.roadsByClass[cls] = (stats.roadsByClass[cls] ?? 0) + 1;
    continue;
  }
  if (t.waterway && !closed) {
    const ww = waterwayWidth(t);
    if (ww > 0 && t.tunnel !== 'culvert' && t.tunnel !== 'yes' && t.layer !== '-1') waterLines.push({ pts, hw: ww / 2 });
    continue;
  }
  if (closed) addPolygon(t, [pts.slice(0, -1)], w.id);
}
for (const r of rels.values()) {
  const t = r.tags ?? {};
  if (t.type !== 'multipolygon' && t.type !== 'building') continue;
  const parts: Pt[][] = [];
  for (const m of r.members ?? []) if (m.type === 'way' && m.geometry && m.geometry.length >= 2 && (m.role === 'outer' || m.role === 'inner' || m.role === '' || m.role === 'outline')) parts.push(proj(m.geometry));
  if (!parts.length) continue;
  addPolygon(t, assembleRings(parts), r.id + 1e10);
}
for (const n of nodes.values()) {
  const t = n.tags ?? {};
  if (n.lat === undefined) continue;
  const cat = poiCat(t);
  if (!cat) continue;
  const [x, z] = lonLatToWorld(n.lon!, n.lat);
  if (x < 0 || z < 0 || x >= W || z >= D) continue;
  pois.push({ cat, arg: 0, x: Math.round(x), z: Math.round(z) });
}
log('features: buildings', blds.length, 'areas', areas.length, 'roads', roads.length, 'water polys', waterPolys.length, 'waterways', waterLines.length, 'coastline ways', coast.length, 'pois', pois.length);

// ───────────────────────────────────────────────────────────── land / water mask
// bit 1 water, 2 occupied (no infill), 4 open land use, 8 developed, 16 residential, 32 commercial, 64 industrial
const M = new Uint8Array(W * D);
{
  const label = new Uint16Array(W * D);
  const BAR = 65535;
  const seeds: number[] = []; // (index, isWater)
  for (const line of coast) for (let k = 0; k + 1 < line.length; k++) {
    const [ax, az] = line[k], [bx, bz] = line[k + 1];
    const L = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(L * 2));
    for (let s = 0; s <= steps; s++) {
      const x = Math.floor(ax + ((bx - ax) * s) / steps), z = Math.floor(az + ((bz - az) * s) / steps);
      if (x >= 0 && z >= 0 && x < W && z < D) label[z * W + x] = BAR;
    }
    // OSM coastline: land on the left, water on the right as seen on a north-up map. The
    // world map is also north-up (z grows south), so (-dz, dx) is the visual right = water.
    if (L < 1e-6) continue;
    const nx = -(bz - az) / L, nz = (bx - ax) / L; // visual-right normal
    for (const f of [0.25, 0.5, 0.75]) {
      const mx = ax + (bx - ax) * f, mz = az + (bz - az) * f;
      for (const off of [1.6, 2.6]) {
        const wx = Math.floor(mx + nx * off), wz = Math.floor(mz + nz * off);
        const lx = Math.floor(mx - nx * off), lz = Math.floor(mz - nz * off);
        if (wx >= 0 && wz >= 0 && wx < W && wz < D) seeds.push(wz * W + wx, 1);
        if (lx >= 0 && lz >= 0 && lx < W && lz < D) seeds.push(lz * W + lx, 0);
      }
    }
  }
  log('coastline seeds', seeds.length / 2);
  const votes: number[][] = [[0, 0]];
  const stack = new Int32Array(1 << 24);
  let comp = 0;
  for (let s = 0; s < seeds.length; s += 2) {
    const i0 = seeds[s];
    if (label[i0] === 0) {
      comp++;
      if (comp >= BAR) throw new Error('too many coastline components');
      votes.push([0, 0]);
      // scanline flood fill
      let sp = 0; stack[sp++] = i0;
      while (sp) {
        const i = stack[--sp];
        if (label[i] !== 0) continue;
        const z = (i / W) | 0;
        let xl = i - z * W, xr = xl;
        while (xl > 0 && label[z * W + xl - 1] === 0) xl--;
        while (xr < W - 1 && label[z * W + xr + 1] === 0) xr++;
        for (let x = xl; x <= xr; x++) label[z * W + x] = comp;
        for (const zz of [z - 1, z + 1]) {
          if (zz < 0 || zz >= D) continue;
          let inRun = false;
          for (let x = xl; x <= xr; x++) {
            const j = zz * W + x;
            if (label[j] === 0) { if (!inRun) { if (sp >= stack.length - 2) throw new Error('flood stack overflow'); stack[sp++] = j; inRun = true; } }
            else inRun = false;
          }
        }
      }
    }
    const c = label[i0];
    if (c !== BAR && c !== 0) votes[c][seeds[s + 1]]++;
  }
  let waterCells = 0;
  const isWaterComp = votes.map((v) => v[1] > v[0]);
  for (let i = 0; i < W * D; i++) {
    const c = label[i];
    if (c !== BAR && c !== 0 && isWaterComp[c]) { M[i] = 1; waterCells++; }
  }
  log('coastline components', comp, 'water fraction', (waterCells / (W * D)).toFixed(3));
}
{ // debug: mask overview (1 px = 16 m) with coastline in red
  const S = 16, w = Math.ceil(W / S), h = Math.ceil(D / S), rgb = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const wv = M[Math.min(D - 1, y * S) * W + Math.min(W - 1, x * S)] & 1; rgb.set(wv ? [40, 90, 160] : [200, 200, 170], (y * w + x) * 3); }
  for (const l of coast) for (const [x, z] of l) { const px = Math.floor(x / S), py = Math.floor(z / S); if (px >= 0 && py >= 0 && px < w && py < h) rgb.set([255, 0, 0], (py * w + px) * 3); }
  mkdirSync(join(ROOT, '.cache/osm/work'), { recursive: true });
  writeFileSync(join(ROOT, '.cache/osm/work/mask.png'), png(w, h, rgb));
}
for (const rings of waterPolys) {
  const qr = rings.map((r) => r.flatMap((p) => p));
  fillRings(qr, 0, 0, W, D, (i) => { M[i] |= 1; });
}
for (const l of waterLines) strokeLine(l.pts.flatMap((p) => p), l.hw, 0, 0, W, D, (i) => { M[i] |= 1; });
{ let wc = 0; for (let i = 0; i < W * D; i++) wc += M[i] & 1; log('water fraction incl. inland', (wc / (W * D)).toFixed(3)); }
const waterAt = (x: number, z: number) => { const xi = Math.floor(x), zi = Math.floor(z); return xi < 0 || zi < 0 || xi >= W || zi >= D ? true : (M[zi * W + xi] & 1) === 1; };

// ───────────────────────────────────────────────────────────── bridge decks
{
  const st = computeDecks(roads, waterAt);
  log('bridges', st.bridges, 'components', st.components);
}

// ───────────────────────────────────────────────────────────── tunnel portals
// Tunnels are not modelled (the world is flat); wherever a surface road runs into one, a closed, covered
// portal is stamped at the road end (tiles.ts / gen.ts) so the road ends cleanly instead of in a gap.
{
  const ends = new Map<string, true>();
  const key = (x: number, z: number) => `${Math.round(x / 4)},${Math.round(z / 4)}`;
  for (const r of roads) for (const k of [0, r.pts.length - 1]) ends.set(key(r.pts[k][0], r.pts[k][1]), true);
  const near = (p: Pt) => { for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (ends.has(key(p[0] + dx * 4, p[1] + dz * 4))) return true; return false; };
  let np = 0;
  for (const tu of tunnels) {
    let len = 0; for (let k = 0; k + 1 < tu.pts.length; k++) len += Math.hypot(tu.pts[k + 1][0] - tu.pts[k][0], tu.pts[k + 1][1] - tu.pts[k][1]);
    if (len < 15) continue;
    for (const end of [0, 1]) {
      const a = end === 0 ? tu.pts[0] : tu.pts[tu.pts.length - 1], b = end === 0 ? tu.pts[1] : tu.pts[tu.pts.length - 2];
      if (!near(a) || a[0] < 0 || a[1] < 0 || a[0] >= W || a[1] >= D) continue;
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      pois.push({ cat: POI.PORTAL, arg: Math.max(0, Math.min(255, Math.round(((ang + Math.PI) / (2 * Math.PI)) * 255))), x: Math.round(a[0]), z: Math.round(a[1]) }); np++;
    }
  }
  log('tunnel portals', np, 'from', tunnels.length, 'tunnel ways');
}

// ───────────────────────────────────────────────────────────── junctions (for crosswalks)
{
  const use = new Map<number, { n: number; r: number; major: number }>();
  for (const r of roads) {
    if (!isCarRoad(r.cls) || r.flags & RF.BRIDGE || r.nodes.length !== r.pts.length) continue;
    const seen = new Set<number>();
    for (const n of r.nodes) {
      if (seen.has(n)) continue; seen.add(n);
      const u = use.get(n) ?? { n: 0, r: 0, major: 0 };
      u.n++; u.r = Math.max(u.r, r.width / 2); if (r.cls <= RC.LIVING) u.major++;
      use.set(n, u);
    }
  }
  const pos = new Map<number, Pt>();
  for (const r of roads) if (r.nodes.length === r.pts.length) r.nodes.forEach((n, k) => { if ((use.get(n)?.n ?? 0) > 1) pos.set(n, r.pts[k]); });
  let nj = 0;
  for (const [n, u] of use) {
    if (u.n < 2 || u.major < 2) continue;
    const p = pos.get(n); if (!p) continue;
    if (p[0] < 0 || p[1] < 0 || p[0] >= W || p[1] >= D) continue;
    pois.push({ cat: POI.JUNCTION, arg: Math.min(40, Math.round(u.r)), x: Math.round(p[0]), z: Math.round(p[1]) }); nj++;
  }
  log('junctions', nj);
}

// ───────────────────────────────────────────────────────────── occupancy + procedural infill
const OPEN = new Set<number>([AK.GRASS, AK.PARK, AK.GARDEN, AK.FOREST, AK.SCRUB, AK.WETLAND, AK.CEMETERY, AK.GOLF, AK.GOLF_ROUGH, AK.GOLF_FAIRWAY, AK.GOLF_GREEN, AK.GOLF_TEE, AK.GOLF_BUNKER, AK.BEACH, AK.SAND, AK.PARKING, AK.PITCH, AK.PLAYGROUND, AK.PLAZA, AK.APRON, AK.RUNWAY, AK.HELIPAD, AK.MARINA, AK.PIER, AK.BREAKWATER, AK.POOL, AK.STADIUM, AK.NATURE, AK.TRACK, AK.ZOO, AK.DOG_PARK, AK.AERODROME, AK.RAILWAY, AK.MILITARY, AK.CONSTRUCTION, AK.FARMLAND]);
const SIDEWALK_W = 2.5;
{
  for (const a of areas) {
    const bit = OPEN.has(a.kind) ? 4 : a.kind === AK.RESIDENTIAL ? 8 | 16 : a.kind === AK.COMMERCIAL || a.kind === AK.RETAIL ? 8 | 32 : a.kind === AK.INDUSTRIAL || a.kind === AK.PORT ? 8 | 64 : a.kind <= LU_MAX ? 8 : 0;
    if (!bit) continue;
    fillRings(a.rings.map((r) => r.flatMap((p) => p)), 0, 0, W, D, (i) => { M[i] |= bit; });
  }
  for (const b of blds) {
    const fr = b.rings.map((r) => r.flatMap((p) => p));
    fillRings(fr, 0, 0, W, D, (i) => { M[i] |= 2; });
    for (const r of fr) strokeLine([...r, r[0], r[1]], 2, 0, 0, W, D, (i) => { M[i] |= 2; });
  }
  for (const r of roads) {
    if (r.flags & RF.BRIDGE && r.deck && Math.max(...r.deck) > 4) continue;
    const hw = r.width / 2 + (r.flags & RF.SIDEWALK ? SIDEWALK_W : 0) + (isCarRoad(r.cls) ? 1.5 : isRail(r.cls) ? 3 : 0.5);
    strokeLine(r.pts.flatMap((p) => p), hw, 0, 0, W, D, (i) => { M[i] |= 2; });
  }
  log('occupancy rasterised');
}
const hash = (x: number, z: number, s: number) => { let h = (Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263) + Math.imul(s, 2147483647)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
{
  let placed = 0;
  const rectPoly = (cx: number, cz: number, ux: number, uz: number, hw: number, hd: number): Pt[] => {
    const vx = -uz, vz = ux;
    return [[cx - ux * hw - vx * hd, cz - uz * hw - vz * hd], [cx + ux * hw - vx * hd, cz + uz * hw - vz * hd], [cx + ux * hw + vx * hd, cz + uz * hw + vz * hd], [cx - ux * hw + vx * hd, cz - uz * hw + vz * hd]];
  };
  const tryPlace = (poly: Pt[], need: number) => {
    const flat = poly.flatMap((p) => p);
    let ok = true, n = 0, dev = 0;
    fillRings([flat], 0, 0, W, D, (i) => { n++; const m = M[i]; if (m & 7) ok = false; if (m & need) dev++; });
    if (!ok || n < 20) return false;
    if (need && dev < n * 0.6) return false;
    return true;
  };
  const mark = (poly: Pt[], buf: number) => {
    const flat = poly.flatMap((p) => p);
    fillRings([flat], 0, 0, W, D, (i) => { M[i] |= 2; });
    strokeLine([...flat, flat[0], flat[1]], buf, 0, 0, W, D, (i) => { M[i] |= 2; });
  };
  const frontage = roads.filter((r) => r.cls >= RC.TRUNK && r.cls <= RC.LIVING && !(r.flags & (RF.BRIDGE | RF.LINK)));
  for (const r of frontage) {
    const hwr = r.width / 2 + (r.flags & RF.SIDEWALK ? SIDEWALK_W : 0);
    const majorRoad = r.cls <= RC.SECONDARY;
    let carry = 0;
    for (let k = 0; k + 1 < r.pts.length; k++) {
      const [ax, az] = r.pts[k], [bx, bz] = r.pts[k + 1];
      const L = Math.hypot(bx - ax, bz - az);
      if (L < 1) continue;
      const ux = (bx - ax) / L, uz = (bz - az) / L;
      let s = carry;
      while (s < L) {
        const px = ax + ux * s, pz = az + uz * s;
        let step = 14;
        for (const side of [-1, 1]) {
          const nx = -uz * side, nz = ux * side;
          const probe = (d: number) => { const x = Math.floor(px + nx * d), z = Math.floor(pz + nz * d); return x >= 0 && z >= 0 && x < W && z < D ? M[z * W + x] : 1; };
          const m = probe(hwr + 12);
          if (m & 5) continue;
          const dist = districtAt(px, pz).style;
          const industrial = (m & 64) !== 0 || dist === 'industrial' || dist === 'port';
          const commercial = !industrial && ((m & 32) !== 0 || (majorRoad && !(m & 16)));
          const u = hash(Math.round(px), Math.round(pz), side + 7);
          let kind: number, fw: number, dp: number, set: number, h: number, roof: number = ROOF.FLAT;
          if (industrial) { kind = BK.WAREHOUSE; fw = 22 + u * 18; dp = 18 + u * 14; set = 5; h = 7 + Math.floor(u * 3) * 2; }
          else if (commercial) {
            kind = BK.COMMERCIAL; fw = 14 + u * 14; dp = 14 + u * 10; set = 1.5;
            const dense = dist === 'downtown' || dist === 'brickell' || dist === 'edgewater' || dist === 'sobe' || dist === 'beach';
            h = dense ? 10 + Math.floor(u * 5) * 3.2 : 4.5 + Math.floor(u * 2.99) * 3.5;
            if (dense && u > 0.6) kind = BK.APARTMENTS;
          } else {
            kind = BK.HOUSE; fw = 10 + u * 4; dp = 11 + u * 5; set = 5 + u * 2; h = u < 0.7 ? 4.5 : 7.5; roof = ROOF.HIPPED;
            if (dist === 'havana' || dist === 'north' || dist === 'suburb') { if (u > 0.92) { kind = BK.APARTMENTS; fw = 18; dp = 20; h = 9.6; roof = ROOF.FLAT; } }
          }
          const need = industrial || commercial ? 0 : 0;
          let done = false;
          for (const shrink of [1, 0.8, 0.62]) {
            const w2 = (fw * shrink) / 2, d2 = (dp * shrink) / 2;
            const off = hwr + set + d2;
            const cx = px + nx * off, cz = pz + nz * off;
            const poly = rectPoly(cx, cz, ux, uz, w2, d2);
            if (!tryPlace(poly, need)) continue;
            mark(poly, kind === BK.HOUSE ? 2 : 1.2);
            blds.push({ kind, roof, flags: BF.SYNTHETIC, h, min: 0, levels: Math.max(1, Math.round(h / 3.2)), name: '', seed: Math.floor(hash(Math.round(cx), Math.round(cz), 3) * 4e9), colour: 0, rings: [poly] });
            placed++; done = true;
            step = Math.max(step, fw * shrink + (kind === BK.HOUSE ? 4 : 2));
            // second (back) row in deep residential blocks
            if (kind === BK.HOUSE) {
              const off2 = off + d2 * 2 + 6;
              const p2 = rectPoly(px + nx * off2, pz + nz * off2, ux, uz, w2, d2);
              if (tryPlace(p2, 16)) { mark(p2, 2); blds.push({ kind, roof, flags: BF.SYNTHETIC, h: h > 5 ? 4.5 : 7.5, min: 0, levels: 1, name: '', seed: Math.floor(hash(Math.round(px + nx * off2), Math.round(pz + nz * off2), 3) * 4e9), colour: 0, rings: [p2] }); placed++; }
            }
            break;
          }
          if (!done) step = Math.min(step, 6);
        }
        s += step;
      }
      carry = s - L;
    }
  }
  stats.synthetic = placed;
  log('infill buildings', placed);
}

// ───────────────────────────────────────────────────────────── tiles
if (existsSync(OUT_DIR)) rmSync(OUT_DIR, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });
const AREA_M = 16, ROAD_M = 24;
interface TileBin { areas: { a: FArea; rings: number[][] }[]; blds: FBld[]; roads: { r: FRoad; pts: number[]; deck: number[] | null }[]; pois: FPoi[] }
const bins: TileBin[] = Array.from({ length: TX * TZ }, () => ({ areas: [], blds: [], roads: [], pois: [] }));
const tileRange = (x0: number, z0: number, x1: number, z1: number) => [Math.max(0, Math.floor(x0 / TILE)), Math.max(0, Math.floor(z0 / TILE)), Math.min(TX - 1, Math.floor(x1 / TILE)), Math.min(TZ - 1, Math.floor(z1 / TILE))];
const bboxPts = (rs: Pt[][]) => { let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity; for (const r of rs) for (const [x, z] of r) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); } return [x0, z0, x1, z1]; };

// simplify once (metres), then clip/quantise per tile
for (const a of areas) a.rings = a.rings.map((r) => simplifyRing(r, 0.5)).filter((r) => r.length >= 3);
for (const b of blds) b.rings = b.rings.map((r) => simplifyRing(r, 0.5)).filter((r) => r.length >= 3);
for (const a of areas) {
  const [x0, z0, x1, z1] = bboxPts(a.rings);
  const [t0, s0, t1, s1] = tileRange(x0 - AREA_M, z0 - AREA_M, x1 + AREA_M, z1 + AREA_M);
  for (let tz = s0; tz <= s1; tz++) for (let tx = t0; tx <= t1; tx++) {
    const cx0 = tx * TILE - AREA_M, cz0 = tz * TILE - AREA_M, cx1 = (tx + 1) * TILE + AREA_M, cz1 = (tz + 1) * TILE + AREA_M;
    const inside = x0 >= cx0 && z0 >= cz0 && x1 <= cx1 && z1 <= cz1;
    const rings = a.rings.map((r) => quantLine(inside ? r : clipRing(r, cx0, cz0, cx1, cz1), true)).filter((r) => r.length >= 6);
    if (rings.length) bins[tz * TX + tx].areas.push({ a, rings });
  }
}
let bldTileRefs = 0;
for (const b of blds) {
  const [x0, z0, x1, z1] = bboxPts(b.rings);
  const [t0, s0, t1, s1] = tileRange(x0 - 3, z0 - 3, x1 + 3, z1 + 3);
  for (let tz = s0; tz <= s1; tz++) for (let tx = t0; tx <= t1; tx++) { bins[tz * TX + tx].blds.push(b); bldTileRefs++; }
}
for (const r of roads) {
  // bridge roads keep every vertex where the deck height leaves the chord's linear ramp (deck-aware Douglas-Peucker)
  const keepIdx = r.deck ? simplifyDeckIdx(r.pts, r.deck, 0.5, 0.3) : null;
  const sp = keepIdx ? keepIdx.map((q) => r.pts[q]) : simplify(r.pts, 0.5);
  const deckS: number[] | null = keepIdx ? keepIdx.map((q) => r.deck![q]) : null;
  const m = r.width / 2 + ROAD_M;
  for (let k = 0; k + 1 < sp.length; k++) {
    const [t0, s0, t1, s1] = tileRange(Math.min(sp[k][0], sp[k + 1][0]) - m, Math.min(sp[k][1], sp[k + 1][1]) - m, Math.max(sp[k][0], sp[k + 1][0]) + m, Math.max(sp[k][1], sp[k + 1][1]) + m);
    for (let tz = s0; tz <= s1; tz++) for (let tx = t0; tx <= t1; tx++) {
      const bin = bins[tz * TX + tx];
      const last = bin.roads[bin.roads.length - 1];
      // extend the current run when this segment continues it
      if (last && last.r === r && (last as unknown as { k: number }).k === k) {
        last.pts.push(Math.round(sp[k + 1][0]), Math.round(sp[k + 1][1])); if (last.deck) last.deck.push(deckS![k + 1]);
        (last as unknown as { k: number }).k = k + 1;
      } else {
        const run = { r, pts: [Math.round(sp[k][0]), Math.round(sp[k][1]), Math.round(sp[k + 1][0]), Math.round(sp[k + 1][1])], deck: deckS ? [deckS[k], deckS[k + 1]] : null, k: k + 1 };
        bin.roads.push(run);
      }
    }
  }
}
for (const p of pois) { const tx = Math.floor(p.x / TILE), tz = Math.floor(p.z / TILE); if (tx >= 0 && tz >= 0 && tx < TX && tz < TZ) bins[tz * TX + tx].pois.push(p); }

let totalBytes = 0, maxBytes = 0;
const tileSizes: Record<string, number> = {};
const sect = { water: 0, strings: 0, areas: 0, blds: 0, roads: 0, pois: 0 };
for (let tz = 0; tz < TZ; tz++) for (let tx = 0; tx < TX; tx++) {
  const bin = bins[tz * TX + tx];
  const w = new Writer();
  w.u8(TILE_MAGIC & 255); w.u8((TILE_MAGIC >> 8) & 255); w.u8((TILE_MAGIC >> 16) & 255); w.u8((TILE_MAGIC >>> 24) & 255);
  w.u8(TILE_VERSION); w.v(tx); w.v(tz);
  let o = w.o;
  // water RLE
  let allL = true, allW = true;
  const rowRuns: number[][] = [];
  for (let r = 0; r < TILE; r++) {
    const z = tz * TILE + r;
    const runs: number[] = []; let cur = 0, len = 0;
    for (let c = 0; c < TILE; c++) {
      const x = tx * TILE + c;
      const wv = x >= W || z >= D ? 1 : M[z * W + x] & 1;
      if (wv) allL = false; else allW = false;
      if (wv === cur) len++; else { runs.push(len); cur = wv; len = 1; }
    }
    runs.push(len);
    rowRuns.push(runs);
  }
  if (allL) w.v(0); else if (allW) w.v(1); else { w.v(2); for (const runs of rowRuns) { w.v(runs.length); for (const l of runs) w.v(l); } }
  sect.water += w.o - o; o = w.o;
  const strings: string[] = []; const sIdx = new Map<string, number>();
  const str = (s: string) => { if (!s) return 0; let i = sIdx.get(s); if (i === undefined) { i = strings.length; strings.push(s); sIdx.set(s, i); } return i + 1; };
  bin.blds.forEach((b) => str(b.name)); bin.roads.forEach((r) => str(r.r.name));
  const te = new TextEncoder();
  w.v(strings.length); for (const s of strings) { const b = te.encode(s); w.v(b.length); w.bytes(b); }
  sect.strings += w.o - o; o = w.o;
  bin.areas.sort((a, b) => b.a.area - a.a.area);
  w.v(bin.areas.length);
  for (const { a, rings } of bin.areas) { w.u8(a.kind); w.u8(Math.floor((a.angle / Math.PI) * 256) & 255); w.rings(rings); }
  sect.areas += w.o - o; o = w.o;
  // parts first so the runtime can let parts win over their outline
  bin.blds.sort((a, b) => (b.flags & BF.PART) - (a.flags & BF.PART));
  w.v(bin.blds.length);
  for (const b of bin.blds) {
    w.u8(b.kind); w.u8(b.roof); w.u8(b.flags); w.v(b.h * 10); w.v(b.min * 10); w.u8(b.levels); w.v(str(b.name)); w.v(b.seed); w.u8(b.colour);
    w.rings(b.rings.map((r) => quantLine(r, true)).filter((r) => r.length >= 6));
  }
  sect.blds += w.o - o; o = w.o;
  w.v(bin.roads.length);
  for (const { r, pts, deck } of bin.roads) {
    w.u8(r.cls); w.u8(r.lanes); w.v(r.width * 10); w.u8(r.flags); w.u8(r.layer + 8); w.v(str(r.name));
    w.line(pts);
    if (r.flags & RF.BRIDGE) for (let k = 0; k < pts.length / 2; k++) w.v((deck?.[k] ?? 0) * 10);
  }
  sect.roads += w.o - o; o = w.o;
  bin.pois.sort((a, b) => a.z - b.z || a.x - b.x);
  w.v(bin.pois.length);
  let px = 0, pz = 0;
  bin.pois.forEach((p, i) => { w.u8(p.cat); w.u8(p.arg); if (i === 0) { w.v(p.x); w.v(p.z); } else { w.zz(p.x - px); w.zz(p.z - pz); } px = p.x; pz = p.z; });
  sect.pois += w.o - o;
  const buf = w.done();
  writeFileSync(join(OUT_DIR, `t_${tx}_${tz}.bin`), buf);
  tileSizes[`${tx}_${tz}`] = buf.length;
  totalBytes += buf.length; maxBytes = Math.max(maxBytes, buf.length);
}
log('tiles', TX * TZ, 'total', (totalBytes / 1e6).toFixed(2), 'MB, max tile', (maxBytes / 1e3).toFixed(0), 'KB', sect);

// ───────────────────────────────────────────────────────────── per-district density
const density = DISTRICTS.map((d) => {
  let land = 0;
  const x0 = Math.max(0, Math.floor(d.x0)), x1 = Math.min(W - 1, Math.floor(d.x1)), z0 = Math.max(0, Math.floor(d.z0)), z1 = Math.min(D - 1, Math.floor(d.z1));
  for (let z = z0; z <= z1; z += 4) for (let x = x0; x <= x1; x += 4) if (!(M[z * W + x] & 1)) land += 16;
  let real = 0, syn = 0;
  for (const b of blds) {
    if (b.flags & BF.PART) continue;
    const [bx0, bz0, bx1, bz1] = bboxPts(b.rings); const cx = (bx0 + bx1) / 2, cz = (bz0 + bz1) / 2;
    if (cx >= d.x0 && cx <= d.x1 && cz >= d.z0 && cz <= d.z1) { if (b.flags & BF.SYNTHETIC) syn++; else real++; }
  }
  const km2 = land / 1e6;
  return { id: d.id, name: d.name, landKm2: +km2.toFixed(2), real, synthetic: syn, perKm2: Math.round((real + syn) / Math.max(0.01, km2)) };
});

const spawn = lonLatToWorld(-80.188712, 25.774256); // sidewalk of E Flagler St by Biscayne Blvd (matches LEONIA.spawn)
const index = {
  name: 'Leonia', version: 1, built: new Date().toISOString(),
  attribution: '© OpenStreetMap contributors (ODbL 1.0)',
  projection: { type: 'local-equirectangular', ...LEONIA_PROJ, origin: 'NW corner (latN, lonW) = (0,0); x east, z south; 1 block = 1 m' },
  tile: TILE, tilesX: TX, tilesZ: TZ, width: W, depth: D,
  spawn: [Math.floor(spawn[0]), 22, Math.floor(spawn[1])],
  counts: {
    buildings: blds.filter((b) => !(b.flags & BF.SYNTHETIC)).length, syntheticBuildings: stats.synthetic, buildingTileRefs: bldTileRefs,
    heightTag: stats.heightTag, levelsTag: stats.levelsTag, defaultHeight: stats.defaultH,
    roads: roads.filter((r) => isCarRoad(r.cls)).length, paths: roads.filter((r) => r.cls >= RC.PEDESTRIAN && r.cls <= RC.TRACK).length,
    rail: roads.filter((r) => isRail(r.cls)).length, aeroways: roads.filter((r) => r.cls === RC.RUNWAY || r.cls === RC.TAXIWAY).length,
    areas: areas.length, waterPolygons: waterPolys.length, waterways: waterLines.length, coastlineWays: coast.length, pois: pois.length, droppedTunnels: stats.droppedTunnels,
    roadsByClass: stats.roadsByClass,
  },
  bytes: { total: totalBytes, max: maxBytes, sections: sect },
  density,
  sources: { pbf: PBF === PBF_FL ? 'Geofabrik florida-latest.osm.pbf (OSM data)' : 'BBBike.org "Miami" extract (lon -80.32..-80.05, lat 25.65..25.86), OSM data', overpass: `Overpass API gap tiles (${readdirSync(RAW_DIR).length} cached responses)`, pbfWays: srcPbf, overpassElements: srcOverpass },
  tiles: tileSizes,
};
writeFileSync(join(OUT_DIR, 'index.json'), JSON.stringify(index));
writeFileSync(join(OUT_DIR, 'CREDITS.txt'), `Leonia world data\n\nMap data © OpenStreetMap contributors, available under the Open Database Licence (ODbL) 1.0.\nhttps://www.openstreetmap.org/copyright\n\nSources: BBBike.org Miami extract (OSM), Overpass API.\nThis directory is a Produced Work / derivative database of OpenStreetMap: simplified (<=0.5 m),\nquantised to 1 m, re-encoded as binary tiles, plus procedurally generated infill buildings flagged SYNTHETIC.\nBuilt ${index.built}.\n`);
log('done', JSON.stringify({ counts: index.counts, density }, null, 1));

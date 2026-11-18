/**
 * Leonia road graph build: OSM (same sources as build.ts) → apps/client/public/world/leonia/graph.bin
 *   NODE_OPTIONS=--max-old-space-size=8000 npx tsx scripts/osm/graph.ts
 * Nodes = OSM nodes shared by >= 2 graph ways (junctions) plus way ends; edges = way pieces
 * between them with class, lanes, width, oneway (oneway=-1 reversed), speed (maxspeed or a
 * class default), bridge deck profile (scripts/osm/decks.ts, identical to the tiles), implicit
 * sidewalks, private access. Car roads (motorway…service, minus driveways/parking aisles) and the
 * foot network (pedestrian, footway, cycleway, path, steps, track, piers) share one graph, so
 * crossings join sidewalks and footpaths. Water for deck clearance comes from the built tiles.
 * Data © OpenStreetMap contributors (ODbL 1.0).
 */
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { RAW_DIR, OUT_DIR, ROOT } from './config.ts';
import { readPbf, type OsmEl } from './pbf.ts';
import { LEONIA_PROJ, lonLatToWorld } from '../../packages/shared/src/world/leonia/proj.ts';
import { TILE, RC, RF, decodeTile, isCarRoad } from '../../packages/shared/src/world/leonia/format.ts';
import { roadClass, roadDims, type Tags } from './classify.ts';
import { computeDecks, simplifyDeckIdx, type DeckRoad } from './decks.ts';
import { encodeGraph, RoadGraph, GF, GN, type GraphEdgeIn } from '../../packages/shared/src/world/nav/graph.ts';
import type { Pt } from './geom.ts';

const t00 = Date.now();
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t00) / 1000).toFixed(1)}s]`, ...a);
const W = LEONIA_PROJ.width, D = LEONIA_PROJ.depth;
const TX = Math.ceil(W / TILE), TZ = Math.ceil(D / TILE);
const PBF_FL = join(ROOT, '.cache/osm/pbf/florida-latest.osm.pbf');
const PBF = existsSync(PBF_FL) ? PBF_FL : join(ROOT, '.cache/osm/pbf/Miami.osm.pbf');
const PBF_BBOX = { s: LEONIA_PROJ.latS - 0.02, n: LEONIA_PROJ.latN + 0.02, w: LEONIA_PROJ.lonW - 0.02, e: LEONIA_PROJ.lonE + 0.02 };

// ───────────────────────────────────────────────────────────── load (same merge rules as build.ts)
const ways = new Map<number, OsmEl>();
const signals: Pt[] = [];
const size = (x: OsmEl) => x.geometry?.length ?? 0;
const addWay = (e: OsmEl) => { const old = ways.get(e.id); if (!old || size(e) > size(old)) ways.set(e.id, e); };
const keepWay = (t: Tags | undefined) => !!t && !!(t.highway || t.railway || t.aeroway || t.man_made || t.natural === 'coastline');
if (existsSync(PBF)) {
  const d = readPbf(PBF, PBF_BBOX);
  for (const e of d.ways) if (keepWay(e.tags)) addWay(e);
  for (const n of d.nodes) if (n.tags?.highway === 'traffic_signals' && n.lat !== undefined) signals.push(lonLatToWorld(n.lon!, n.lat));
  log('pbf', d.ways.length, 'ways');
}
if (existsSync(RAW_DIR)) for (const f of readdirSync(RAW_DIR).filter((f) => f.endsWith('.json'))) {
  const j = JSON.parse(readFileSync(join(RAW_DIR, f), 'utf8')) as { elements?: OsmEl[] };
  for (const e of j.elements ?? []) {
    if (e.type === 'way' && keepWay(e.tags)) addWay(e);
    else if (e.type === 'node' && e.tags?.highway === 'traffic_signals' && e.lat !== undefined) signals.push(lonLatToWorld(e.lon!, e.lat));
  }
}
log('ways kept', ways.size, 'signals', signals.length);

// ───────────────────────────────────────────────────────────── classify (mirrors build.ts)
interface GRoad extends DeckRoad { lanes: number; width: number; name: string; ids: number[]; tags: Tags }
const roads: GRoad[] = [];
const proj = (g: { lat: number; lon: number }[]): Pt[] => g.map((p) => lonLatToWorld(p.lon, p.lat));
const inWorld = (pts: Pt[], m = 200) => pts.some(([x, z]) => x > -m && z > -m && x < W + m && z < D + m);
let synthId = -1;
const coordIds = new Map<string, number>();
for (const w of ways.values()) {
  const t = w.tags ?? {};
  if (!w.geometry || w.geometry.length < 2) continue;
  const pts = proj(w.geometry);
  if (!inWorld(pts)) continue;
  const closed = w.nodes ? w.nodes.length >= 4 && w.nodes[0] === w.nodes[w.nodes.length - 1] : (pts.length >= 4 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]);
  if (t.natural === 'coastline') continue;
  const cls = roadClass(t);
  const asArea = closed && (t.area === 'yes' || cls === RC.PIER || cls === RC.BREAKWATER);
  if (!cls || asArea) continue;
  const dims = roadDims(t, cls);
  if (dims.flags & RF.TUNNEL) continue;
  const layer = Math.max(-5, Math.min(5, parseInt(t.layer ?? '0', 10) || 0));
  // node ids aligned with the projected points (PBF: gnodes; Overpass: nodes == geometry)
  let ids: number[];
  if (w.gnodes && w.gnodes.length === pts.length) ids = w.gnodes;
  else if (w.nodes && w.nodes.length === pts.length) ids = w.nodes;
  else ids = pts.map(([x, z]) => { const k = `${x.toFixed(2)},${z.toFixed(2)}`; let id = coordIds.get(k); if (id === undefined) { id = synthId--; coordIds.set(k, id); } return id; });
  roads.push({ cls, lanes: dims.lanes, width: dims.width, flags: dims.flags, layer, name: t.name ?? '', pts, nodes: w.nodes ?? [], ids, tags: t });
}
log('road ways', roads.length);

// ───────────────────────────────────────────────────────────── water from the built tiles (bit-packed)
const waterTiles: (Uint8Array | 0 | 1)[] = new Array(TX * TZ).fill(1);
{
  let n = 0;
  for (let tz = 0; tz < TZ; tz++) for (let tx = 0; tx < TX; tx++) {
    const f = join(OUT_DIR, `t_${tx}_${tz}.bin`);
    if (!existsSync(f)) continue;
    const t = decodeTile(new Uint8Array(readFileSync(f)));
    let any = 0, all = 1;
    for (let i = 0; i < t.water.length; i++) { if (t.water[i]) any = 1; else all = 0; if (any && !all) break; }
    if (!any) { waterTiles[tz * TX + tx] = 0; n++; continue; }
    if (all) { waterTiles[tz * TX + tx] = 1; n++; continue; }
    const bits = new Uint8Array(TILE * TILE / 8);
    for (let i = 0; i < t.water.length; i++) if (t.water[i]) bits[i >> 3] |= 1 << (i & 7);
    waterTiles[tz * TX + tx] = bits; n++;
  }
  log('tiles read for water', n);
}
const waterAt = (x: number, z: number) => {
  const xi = Math.floor(x), zi = Math.floor(z);
  if (xi < 0 || zi < 0 || xi >= W || zi >= D) return true;
  const t = waterTiles[Math.floor(zi / TILE) * TX + Math.floor(xi / TILE)];
  if (t === 0 || t === 1) return t === 1;
  const i = (zi % TILE) * TILE + (xi % TILE);
  return (t[i >> 3] & (1 << (i & 7))) !== 0;
};

// ───────────────────────────────────────────────────────────── decks (same algorithm + inputs as the tiles)
{ const st = computeDecks(roads, waterAt); log('bridges', st.bridges, 'components', st.components); }

// ───────────────────────────────────────────────────────────── graph ways
const isFootCls = (c: number) => (c >= RC.PEDESTRIAN && c <= RC.TRACK) || c === RC.PIER;
const gways = roads.filter((r) => {
  if (isCarRoad(r.cls)) {
    const sv = r.tags.service;
    if (sv === 'driveway' || sv === 'parking_aisle' || sv === 'drive-through' || sv === 'emergency_access') return false;
    if (r.tags.access === 'no' && !r.tags.motor_vehicle && !r.tags.psv) return false;
    return true;
  }
  return isFootCls(r.cls);
});
const use = new Map<number, number>();
for (const r of gways) {
  const seen = new Set<number>();
  r.ids.forEach((id, k) => {
    if (seen.has(id)) { use.set(id, (use.get(id) ?? 0) + 1); return; } // self-crossing / closed loop
    seen.add(id);
    let u = (use.get(id) ?? 0) + 1;
    if (k === 0 || k === r.ids.length - 1) u += 1; // way ends are always nodes
    use.set(id, u);
  });
}
const inside = ([x, z]: Pt) => x >= 0 && z >= 0 && x < W && z < D;

const nodeIdx = new Map<number, number>();
const nodes: { x: number; z: number; flags: number }[] = [];
const nodeOf = (id: number, p: Pt) => { let i = nodeIdx.get(id); if (i === undefined) { i = nodes.length; nodes.push({ x: p[0], z: p[1], flags: 0 }); nodeIdx.set(id, i); } return i; };

/** Douglas–Peucker keeping indices (endpoints always kept) */
function dpIdx(pts: Pt[], eps: number): number[] {
  const keep = new Uint8Array(pts.length); keep[0] = 1; keep[pts.length - 1] = 1;
  const st: [number, number][] = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop()!;
    if (b <= a + 1) continue;
    const [ax, az] = pts[a], [bx, bz] = pts[b];
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
    let bi = -1, bd = eps;
    for (let i = a + 1; i < b; i++) {
      const [px, pz] = pts[i];
      const d = L < 1e-9 ? Math.hypot(px - ax, pz - az) : Math.abs((px - ax) * dz - (pz - az) * dx) / L;
      if (d > bd) { bd = d; bi = i; }
    }
    if (bi >= 0) { keep[bi] = 1; st.push([a, bi], [bi, b]); }
  }
  const out: number[] = []; keep.forEach((k, i) => { if (k) out.push(i); });
  return out;
}

function parseSpeed(t: Tags, cls: number, flags: number): number {
  const m = /^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh)?/.exec(t.maxspeed ?? '');
  if (m) { const v = parseFloat(m[1]); return m[2] === 'mph' || !m[2] ? v * 1.609 : v; } // US data: bare numbers are mph
  const link = flags & RF.LINK;
  switch (cls) {
    case RC.MOTORWAY: return link ? 65 : 105;
    case RC.TRUNK: return link ? 55 : 80;
    case RC.PRIMARY: return link ? 50 : 60;
    case RC.SECONDARY: return 55;
    case RC.TERTIARY: return 50;
    case RC.UNCLASSIFIED: return 45;
    case RC.RESIDENTIAL: return 40;
    case RC.LIVING: return 20;
    case RC.SERVICE: return 25;
    default: return 5;
  }
}

const edges: GraphEdgeIn[] = [];
let droppedShort = 0;
for (const r of gways) {
  const rev = r.tags.oneway === '-1';
  let pts = r.pts, ids = r.ids, deck = r.deck ?? null;
  if (rev) { pts = [...pts].reverse(); ids = [...ids].reverse(); deck = deck ? [...deck].reverse() : null; }
  let flags = 0;
  if (r.flags & RF.ONEWAY && isCarRoad(r.cls)) flags |= GF.ONEWAY;
  if (r.flags & RF.BRIDGE && deck && deck.some((h) => h > 0.05)) flags |= GF.BRIDGE;
  if (r.flags & RF.LINK) flags |= GF.LINK;
  if (r.flags & RF.SIDEWALK) flags |= GF.SIDEWALK;
  if (r.tags.junction === 'roundabout' || r.tags.junction === 'circular') flags |= GF.ROUNDABOUT;
  if (r.cls === RC.PIER) flags |= GF.PIER;
  const acc = r.tags.access, mv = r.tags.motor_vehicle ?? r.tags.motorcar;
  if (acc === 'private' || acc === 'no' || acc === 'customers' || acc === 'delivery' || mv === 'private' || mv === 'no') flags |= GF.PRIVATE;
  const speed = parseSpeed(r.tags, r.cls, r.flags);
  // split into inside-the-world runs, then at junction nodes
  let start = -1;
  const emit = (i0: number, i1: number) => {
    // pieces between nodes
    let a = i0;
    for (let k = i0 + 1; k <= i1; k++) {
      const isNode = k === i1 || (use.get(ids[k]) ?? 0) > 1;
      if (!isNode) continue;
      const seg = pts.slice(a, k + 1);
      let L = 0; for (let q = 1; q < seg.length; q++) L += Math.hypot(seg[q][0] - seg[q - 1][0], seg[q][1] - seg[q - 1][1]);
      if (L < 0.3) { droppedShort++; a = k; continue; }
      const keep = flags & GF.BRIDGE && deck ? simplifyDeckIdx(seg, deck.slice(a, k + 1), 0.5, 0.3) : dpIdx(seg, 0.5);
      const na = nodeOf(ids[a], pts[a]), nb = nodeOf(ids[k], pts[k]);
      edges.push({
        a: na, b: nb, cls: r.cls, lanes: r.lanes, width: r.width, flags, layer: r.layer, speedKmh: speed, name: r.name,
        pts: keep.map((q) => seg[q]), deck: flags & GF.BRIDGE && deck ? keep.map((q) => deck![a + q]) : null,
      });
      a = k;
    }
  };
  for (let k = 0; k < pts.length; k++) {
    if (inside(pts[k])) { if (start < 0) start = k; }
    else if (start >= 0) { if (k - 1 > start) emit(start, k - 1); start = -1; }
  }
  if (start >= 0 && pts.length - 1 > start) emit(start, pts.length - 1);
}
log('graph nodes', nodes.length, 'edges', edges.length, 'dropped tiny', droppedShort);

// ───────────────────────────────────────────────────────────── node flags: signals, dead ends
{
  const deg = new Uint16Array(nodes.length), cdeg = new Uint16Array(nodes.length);
  for (const e of edges) { deg[e.a]++; deg[e.b]++; if (isCarRoad(e.cls)) { cdeg[e.a]++; cdeg[e.b]++; } }
  const cell = new Map<number, number[]>();
  const key = (x: number, z: number) => Math.floor(z / 32) * 4096 + Math.floor(x / 32);
  nodes.forEach((n, i) => { if (cdeg[i] >= 3) { const k = key(n.x, n.z); (cell.get(k) ?? cell.set(k, []).get(k)!).push(i); } });
  let ns = 0;
  for (const [sx, sz] of signals) {
    let best = -1, bd = 26;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) for (const i of cell.get(key(sx + dx * 32, sz + dz * 32)) ?? []) {
      const d = Math.hypot(nodes[i].x - sx, nodes[i].z - sz); if (d < bd) { bd = d; best = i; }
    }
    if (best >= 0 && !(nodes[best].flags & GN.SIGNAL)) { nodes[best].flags |= GN.SIGNAL; ns++; }
  }
  let de = 0;
  nodes.forEach((n, i) => { if (cdeg[i] === 1 && deg[i] <= 1) { n.flags |= GN.DEADEND; de++; } });
  log('signalised junctions', ns, 'dead ends', de);
}

// ───────────────────────────────────────────────────────────── spatial order + encode
{
  const order = nodes.map((_, i) => i);
  const tk = (i: number) => { const n = nodes[i]; return Math.floor(n.z / 256) * 1000 + Math.floor(n.x / 256); };
  order.sort((a, b) => tk(a) - tk(b) || nodes[a].z - nodes[b].z || nodes[a].x - nodes[b].x);
  const remap = new Uint32Array(nodes.length);
  order.forEach((old, ni) => { remap[old] = ni; });
  const sorted = order.map((i) => nodes[i]);
  for (const e of edges) { e.a = remap[e.a]; e.b = remap[e.b]; }
  edges.sort((p, q) => p.a - q.a || p.b - q.b);
  const buf = encodeGraph(sorted, edges);
  writeFileSync(join(OUT_DIR, 'graph.bin'), buf);
  const gz = gzipSync(buf).length;
  // stats + round trip
  const t0 = performance.now();
  const g = new RoadGraph(buf, W, D);
  const loadMs = performance.now() - t0;
  let carKm = 0, footKm = 0, sideKm = 0, bridgeEdges = 0, oneway = 0;
  for (let e = 0; e < g.nEdges; e++) {
    if (g.isCar(e)) { carKm += g.eLen[e] / 1000; if (g.eFlags[e] & GF.SIDEWALK) sideKm += g.eLen[e] / 1000; if (g.eFlags[e] & GF.ONEWAY) oneway++; } else footKm += g.eLen[e] / 1000;
    if (g.eFlags[e] & GF.BRIDGE) bridgeEdges++;
  }
  // largest strongly-ish connected car component (undirected) for reporting
  const comp = new Int32Array(g.nNodes).fill(-1);
  let bestC = 0;
  for (let s = 0, c = 0; s < g.nNodes; s++) {
    if (comp[s] >= 0) continue;
    let n = 0; const st = [s]; comp[s] = c;
    while (st.length) { const v = st.pop()!; n++; for (let k = g.adjStart[v]; k < g.adjStart[v + 1]; k++) { if (!g.isCar(g.adjE[k])) continue; const e = g.adjE[k]; const u = g.eA[e] === v ? g.eB[e] : g.eA[e]; if (comp[u] < 0) { comp[u] = c; st.push(u); } } }
    bestC = Math.max(bestC, n); c++;
  }
  // deck agreement with the tiles: compare graph deck at bridge vertices with tile deck points
  let cmp = 0, diff = 0, maxDiff = 0;
  const tcache = new Map<number, { x: number; z: number; h: number }[]>();
  const tileDecks = (tx: number, tz: number) => {
    const k = tz * TX + tx; let a = tcache.get(k);
    if (!a) {
      a = [];
      const f = join(OUT_DIR, `t_${tx}_${tz}.bin`);
      if (existsSync(f)) for (const r of decodeTile(new Uint8Array(readFileSync(f))).roads) if (r.deck) for (let q = 0; q < r.deck.length; q++) a.push({ x: r.pts[q * 2], z: r.pts[q * 2 + 1], h: r.deck[q] });
      tcache.set(k, a);
    }
    return a;
  };
  for (let e = 0; e < g.nEdges && cmp < 4000; e += 7) {
    if (!(g.eFlags[e] & GF.BRIDGE)) continue;
    for (let k = 0; k < g.eN[e]; k++) {
      const p = g.eP0[e] + k, x = g.px[p], z = g.pz[p];
      let bd = 1.2, h = -1;
      for (const q of tileDecks(Math.floor(x / TILE), Math.floor(z / TILE))) { const d = Math.hypot(q.x - x, q.z - z); if (d < bd) { bd = d; h = q.h; } }
      if (h < 0) continue;
      const dd = Math.abs(h - g.pdeck[p]); cmp++; diff += dd; maxDiff = Math.max(maxDiff, dd);
    }
  }
  const stats = {
    bytes: buf.length, gzip: gz, loadMs: +loadMs.toFixed(1), nodes: g.nNodes, edges: g.nEdges, points: g.px.length,
    carKm: Math.round(carKm), footKm: Math.round(footKm), sidewalkKm: Math.round(sideKm), onewayEdges: oneway, bridgeEdges,
    signals: sorted.filter((n) => n.flags & GN.SIGNAL).length, largestCarComponentNodes: bestC,
    deckVsTiles: { compared: cmp, meanAbsM: +(diff / Math.max(1, cmp)).toFixed(3), maxAbsM: +maxDiff.toFixed(2) },
  };
  writeFileSync(join(OUT_DIR, 'graph.json'), JSON.stringify({ format: 'LEOG v1 (packages/shared/src/world/nav/graph.ts)', built: new Date().toISOString(), attribution: '© OpenStreetMap contributors (ODbL 1.0)', ...stats }, null, 1));
  log('graph.bin', stats);
}

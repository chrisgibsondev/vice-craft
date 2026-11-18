/**
 * Moves the authored content (32 activities, 63 cutscenes; authored in Palmara coordinates) onto
 * Leonia and writes packages/shared/src/content/leonia/positions.gen.ts.
 *
 *   npx tsx scripts/leonia-content.ts            # writes the table + prints a report
 *
 * How positions move (details: docs/LEONIA.md §10):
 *  1. Anything on or around an enterable building's Palmara lot moves with that building's
 *     placement frame (translation + 90° rotation), so interiors, doors, guards, loot and close
 *     camera work stay exact relative to the prefab.
 *  2. Other Palmara places map onto real ones: Port Island → the Dodge Island cargo yard (the
 *     warehouse frame), Solano Beach / Ocean Drive → South Beach's Ocean Drive, Solano Airfield →
 *     the MIA hangar aprons, Conch Harbor → Virginia Key Beach, the lagoon → Biscayne Bay; loose
 *     downtown street spots follow the nearest building frame.
 *  3. Snapping against the generated world: on-foot spots to the nearest standable cell (sidewalk
 *     preferred), vehicles to the nearest driving lane of the road graph (facing the lane), boats
 *     to open water, cameras lifted out of blocks.
 *  4. Hand-authored Leonia geography where a mission is about the route: the three races (real
 *     streets / bay buoys via the road graph, par times from route length), the boat trip in
 *     story 7, and every stage time limit / taxi + delivery par re-timed from the new distances.
 */
process.env.BLOCKSHORE_WORLD = 'leonia';
process.env.BLOCKSHORE_RAW_CONTENT = '1';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sh = await import('../packages/shared/src/index.ts');
const { walkContent } = await import('../packages/shared/src/content/leonia/walk.ts');
type V3 = [number, number, number];
type Frame = import('../packages/shared/src/world/placement.ts').Frame;
const { B, WORLD_H, LEONIA, LeoniaGen, RoadGraph, LeoniaNav, VEHICLES, POIS, poiFrame, worldToFrame, frameToWorld, lonLatToWorld, worldToLonLat, PAD, TILE, AK } = sh;

const DIR = process.env.BLOCKSHORE_LEONIA_DATA ?? join(process.cwd(), 'apps/client/public/world/leonia');
const gen = new LeoniaGen({ readSync: (tx, tz) => { const f = join(DIR, `t_${tx}_${tz}.bin`); return existsSync(f) ? new Uint8Array(readFileSync(f)) : null; } }, 96);
const chunks = new Map<number, Uint8Array>();
export function blk(x: number, y: number, z: number): number {
  if (y < 0) return B.STONE; if (y >= WORLD_H) return B.AIR;
  const cx = Math.floor(x / 16), cz = Math.floor(z / 16), k = cz * 4096 + cx;
  let c = chunks.get(k);
  if (!c) { c = new Uint8Array(16 * 16 * WORLD_H); gen.generateRegion(cx * 16, cz * 16, 16, 16, c); chunks.set(k, c); if (chunks.size > 6000) chunks.delete(chunks.keys().next().value as number); }
  return c[(Math.floor(x) - cx * 16) + (Math.floor(z) - cz * 16) * 16 + y * 256];
}
const PASS = new Set<number>([B.AIR, B.TALL_GRASS, B.FLOWERS, B.REEDS, B.SEA_OATS]);
const passable = (id: number) => PASS.has(id);
const vox = {
  getBlock: (x: number, y: number, z: number) => blk(Math.floor(x), y, Math.floor(z)),
  groundY: (x: number, z: number, fromY = 60) => { for (let y = Math.floor(fromY); y > 0; y--) { const id = blk(Math.floor(x), y, Math.floor(z)); if (!passable(id) && id !== B.PALM_LEAVES && id !== B.LEAVES) return y + 1; } return 22; },
};
const graph = new RoadGraph(new Uint8Array(readFileSync(join(DIR, 'graph.bin'))), LEONIA.width, LEONIA.depth);
export const nav = new LeoniaNav(graph, gen.tiles, vox);

const SOLID_BAD = new Set<number>([B.WATER, B.AIR, B.LEAVES, B.PALM_LEAVES, B.MANGROVE_LEAVES]);
/** feet at (x,y,z) fits a player: solid floor, two passable cells */
export function standable(x: number, y: number, z: number): boolean {
  const fx = Math.floor(x), fz = Math.floor(z);
  const fl = blk(fx, y - 1, fz);
  return !SOLID_BAD.has(fl) && !passable(fl) && passable(blk(fx, y, fz)) && passable(blk(fx, y + 1, fz));
}
const ROADB = new Set<number>([B.ASPHALT, B.LINE_WHITE, B.LINE_YELLOW, B.RUNWAY]);
function isWaterCol(x: number, z: number) { return blk(Math.floor(x), 20, Math.floor(z)) === B.WATER && passable(blk(Math.floor(x), 21, Math.floor(z))) && passable(blk(Math.floor(x), 22, Math.floor(z))); }
function openWater(x: number, z: number, r = 5) {
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (!isWaterCol(x + dx, z + dz)) return false;
  return true;
}

// ───────────────────────────────────────────────────────── snapping
/**
 * A standable cell is only a usable on-foot spot when a player can walk from it to the street network: flood the
 * cells around it (1-block steps, as stepPlayer allows) until a carriageway floor is reached or the open area is
 * large. Sealed courtyards, gated lots and roofs fail (a package placed in one can never be picked up).
 */
const connMemo = new Map<string, boolean>();
export function connectedToStreet(x: number, y: number, z: number): boolean {
  const k0 = `${Math.floor(x)},${y},${Math.floor(z)}`;
  const hit = connMemo.get(k0);
  if (hit !== undefined) return hit;
  const seen = new Set<string>([k0]); const q: [number, number, number][] = [[Math.floor(x), y, Math.floor(z)]];
  let ok = false;
  for (let i = 0; i < q.length && !ok; i++) {
    const [cx, cy, cz] = q[i];
    if ((cy === 22 && ROADB.has(blk(cx, cy - 1, cz))) || q.length > 12000) { ok = true; break; }
    for (let dz = -1; dz <= 1 && !ok; dz++) for (let dx = -1; dx <= 1; dx++) {
      if ((!dx && !dz) || (dx && dz)) continue; // 4-neighbour only: no squeezing through diagonal wall gaps
      const nx = cx + dx, nz = cz + dz;
      for (const dy of [1, 0, -1, -2]) {
        if (!standable(nx + 0.5, cy + dy, nz + 0.5)) continue;
        if (dy === 1 && !passable(blk(cx, cy + 2, cz))) continue;
        const k = `${nx},${cy + dy},${nz}`;
        if (!seen.has(k)) { seen.add(k); q.push([nx, cy + dy, nz]); }
        break;
      }
    }
  }
  if (process.env.DEBUG_CONN && k0 === process.env.DEBUG_CONN) console.log("CONN", k0, ok, q.length, seen.size, q[q.length-1]);
  for (const k of seen) connMemo.set(k, ok);
  return ok;
}
export function snapFoot(x: number, z: number, y = 22, maxR = 48, preferWalk = true): V3 | null {
  let best: V3 | null = null, bs = Infinity;
  for (let r = 0; r <= maxR; r++) {
    if (best && r > bs) break;
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const cx = Math.floor(x) + dx, cz = Math.floor(z) + dz;
      for (const yy of [y, 22, y + 1, y - 1]) {
        if (yy < 21 || !standable(cx + 0.5, yy, cz + 0.5) || !connectedToStreet(cx + 0.5, yy, cz + 0.5)) continue;
        const road = ROADB.has(blk(cx, yy - 1, cz));
        const d = Math.hypot(dx, dz) + (preferWalk && road ? 4 : 0) + Math.abs(yy - y) * 4;
        if (d < bs) { bs = d; best = [cx + 0.5, yy, cz + 0.5]; }
        break;
      }
    }
  }
  return best;
}
export function snapWater(x: number, z: number, maxR = 260): V3 | null {
  for (let r = 0; r <= maxR; r += 1) {
    let best: [number, number] | null = null, bd = Infinity;
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const px = Math.floor(x) + dx + 0.5, pz = Math.floor(z) + dz + 0.5;
      if (!openWater(px, pz)) continue;
      const d = Math.hypot(dx, dz);
      if (d < bd) { bd = d; best = [px, pz]; }
    }
    if (best) return [best[0], 21, best[1]];
  }
  return null;
}
function camFree(x: number, y: number, z: number) {
  for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!passable(blk(Math.floor(x + dx * 0.6), Math.floor(y + dy * 0.6), Math.floor(z + dz * 0.6))) && blk(Math.floor(x + dx * 0.6), Math.floor(y + dy * 0.6), Math.floor(z + dz * 0.6)) !== B.WATER) return false;
  return true;
}
export function liftCam(p: V3): V3 {
  let y = p[1];
  for (let k = 0; k < 200 && !camFree(p[0], y, p[2]); k++) y += 1;
  return [p[0], y, p[2]];
}

// ───────────────────────────────────────────────────────── Palmara → Leonia mapping
interface Mapped { x: number; z: number; rot: number; via: string; exact: boolean }
const ll = (lon: number, lat: number) => lonLatToWorld(lon, lat);
function streetPoint(name: RegExp, lon: number, lat: number): [number, number] {
  const [x, z] = ll(lon, lat);
  const h = graph.nearest(x, z, 700, (e) => graph.isCar(e) && name.test(graph.name(e)));
  if (!h) throw new Error(`no street ${name} near ${lon},${lat}`);
  return [h.x, h.z];
}
function apronNear(x: number, z: number, r = 140): [number, number] {
  let sx = 0, sz = 0, n = 0;
  for (let dz = -r; dz <= r; dz += 4) for (let dx = -r; dx <= r; dx += 4) {
    const X = Math.round(x + dx), Z = Math.round(z + dz);
    const t = gen.tiles.get(Math.floor(X / TILE), Math.floor(Z / TILE)); if (!t) continue;
    const i = t.idx(X, Z);
    if (t.sf[i] === AK.APRON && !t.bld[i]) { sx += X; sz += Z; n++; }
  }
  return n ? [sx / n, sz / n] : [x, z];
}
/** nearest land cell of surface kind `sf` (e.g. beach sand) */
function nearestSurface(x: number, z: number, sf: number, r = 600): [number, number] {
  let best: [number, number] = [x, z], bd = Infinity;
  for (let dz = -r; dz <= r; dz += 3) for (let dx = -r; dx <= r; dx += 3) {
    const X = Math.round(x + dx), Z = Math.round(z + dz);
    const t = gen.tiles.get(Math.floor(X / TILE), Math.floor(Z / TILE)); if (!t || t.water(X, Z)) continue;
    const i = t.idx(X, Z);
    if (t.sf[i] !== sf || t.bld[i]) continue;
    const d = Math.hypot(dx, dz); if (d < bd) { bd = d; best = [X + 0.5, Z + 0.5]; }
  }
  return best;
}
export const VK_BEACH = nearestSurface(...ll(-80.1440, 25.7395), AK.BEACH);
const OCEAN_DR = streetPoint(/^Ocean Drive$/, -80.1302, 25.7800);
const MIA_APRON = apronNear(4468, 10479);
interface Site { id: string; box: [number, number, number, number]; pal: [number, number]; leo: [number, number]; rot: 0 | 1 | 2 | 3 }
const SITES: Site[] = [
  // Palmara Ocean Drive runs north–south at x≈2800 with the Atlantic to the east: South Beach is the same shape
  { id: 'beach', box: [2752, 2880, 3100, 3560], pal: [2800, 3200], leo: [OCEAN_DR[0], OCEAN_DR[1]], rot: 0 },
  { id: 'airfield', box: [2100, 3255, 2400, 3470], pal: [2240, 3300], leo: MIA_APRON, rot: 0 },
  { id: 'keys', box: [1100, 3900, 2500, 4500], pal: [1370, 4288], leo: VK_BEACH, rot: 0 },
  { id: 'lagoon', box: [2640, 2930, 2770, 3176], pal: [2700, 3090], leo: ll(-80.1805, 25.7735), rot: 0 },
];
const DT_PAL = [2520, 3167], DT_LEO = [14000, 13900], DT_SCALE = 2.2;
const PORT_BOX = [2630, 3130, 2780, 3330];
const palFrames = POIS.map((p) => ({ p, pal: poiFrame(p, 'palmara'), leo: poiFrame(p, 'leonia') }));

const DOWNTOWN_POIS = new Set(['safehouse', 'plaza', 'garage', 'store', 'diner', 'police']);
function viaFrame(f: typeof palFrames[number], x: number, z: number, via: string): Mapped {
  const l = worldToFrame(f.pal, x, z);
  const [wx, wz] = frameToWorld(f.leo, l[0], l[1]);
  return { x: wx, z: wz, rot: f.leo.rot, via, exact: false };
}
/**
 * relevant: buildings this activity is about; home: its main building (loose street spots of an
 * activity whose home is outside downtown follow the home building); loose: ignore building lots
 * (checkpoint chains move as one piece)
 */
export function mapPoint(x: number, z: number, relevant?: Set<string>, home: string | null = null, loose = false): Mapped {
  // 1. on / around an enterable building's lot
  let best: { f: typeof palFrames[number]; d: number; l: [number, number] } | null = null;
  for (const f of palFrames) {
    if (relevant && !relevant.has(f.p.id)) continue;
    const l = worldToFrame(f.pal, x, z);
    const d = Math.max(0, -l[0], l[0] - 48, -l[1], l[1] - 48);
    if (!best || d < best.d) best = { f, d, l };
  }
  const inPort = x >= PORT_BOX[0] && x < PORT_BOX[2] && z >= PORT_BOX[1] && z < PORT_BOX[3];
  const inPad = (l: [number, number]) => l[0] >= PAD.x0 && l[0] < PAD.x1 && l[1] >= PAD.z0 && l[1] < PAD.z1;
  if (best && !loose && (inPad(best.l) || Math.hypot(best.l[0] - 24, best.l[1] - 6) < 14 || (best.f.p.id === home && best.d <= 6))) {
    const [wx, wz] = frameToWorld(best.f.leo, best.l[0], best.l[1]);
    const exact = best.l[0] >= PAD.x0 && best.l[0] < PAD.x1 && best.l[1] >= PAD.z0 && best.l[1] < PAD.z1;
    return { x: wx, z: wz, rot: best.f.leo.rot, via: best.f.p.id, exact };
  }
  if (inPort) {
    const f = palFrames.find((q) => q.p.id === 'warehouse')!;
    const l = worldToFrame(f.pal, x, z);
    const [wx, wz] = frameToWorld(f.leo, l[0], l[1]);
    return { x: wx, z: wz, rot: f.leo.rot, via: 'port', exact: false };
  }
  // 2. other Palmara places
  for (const s of SITES) {
    if (x >= s.box[0] && x < s.box[2] && z >= s.box[1] && z < s.box[3]) return { x: s.leo[0] + (x - s.pal[0]), z: s.leo[1] + (z - s.pal[1]), rot: s.rot, via: s.id, exact: false };
  }
  // 3. loose downtown streets: around the home building when that is outside downtown, otherwise
  //    Palmara's compact downtown grid spread x2.2 over downtown Miami
  if (home && !DOWNTOWN_POIS.has(home) && x >= 2360 && x < 2680 && z >= 3020 && z < 3330) return viaFrame(palFrames.find((q) => q.p.id === home)!, x, z, `home:${home}`);
  if (x >= 2360 && x < 2680 && z >= 3020 && z < 3330) return { x: DT_LEO[0] + (x - DT_PAL[0]) * DT_SCALE, z: DT_LEO[1] + (z - DT_PAL[1]) * DT_SCALE, rot: 0, via: 'downtown', exact: false };
  let s = SITES[0], sd = Infinity;
  for (const q of SITES) { const d = Math.hypot(x - q.pal[0], z - q.pal[1]); if (d < sd) { sd = d; s = q; } }
  warn(`far point ${x},${z} → site ${s.id}`);
  return { x: s.leo[0] + (x - s.pal[0]), z: s.leo[1] + (z - s.pal[1]), rot: s.rot, via: `far:${s.id}`, exact: false };
}

// ───────────────────────────────────────────────────────── output + report
const POS: Record<string, V3> = {};
const YAW: Record<string, number> = {};
const SET: Record<string, unknown> = {};
const TEXT: Record<string, string> = {};
function setLine(path: string, text: string) { SET[path] = text; TEXT[path] = text; }
const warnings: string[] = [];
function warn(s: string) { warnings.push(s); }
const r1 = (n: number) => Math.round(n * 10) / 10;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const report = new Map<string, { n: number; exact: number; snapped: number; maxSnap: number; vias: Set<string>; problems: string[] }>();
function rep(id: string) { let r = report.get(id); if (!r) report.set(id, r = { n: 0, exact: 0, snapped: 0, maxSnap: 0, vias: new Set(), problems: [] }); return r; }

const { ACTIVITIES, CUTSCENES, contentRoots } = sh;
type Visit = Parameters<Parameters<typeof walkContent>[1]>[0];
const visits: Visit[] = [];
walkContent(contentRoots(), (v) => visits.push(v));

/** rotation applied to the position that owns a yaw */
const holderRot = new Map<unknown, number>();
const holderYaw = new Map<unknown, number>();
/** vehicles placed per activity (keep them apart) */
const placedVeh = new Map<string, { x: number; z: number }[]>();

function rootOf(path: string) { return path.split('/')[0]; }
/** a parked vehicle's footprint (r = 1 cars, 2 vans/trucks) has a floor and nothing in the way */
function footprintFree(x: number, y: number, z: number, r: number): boolean {
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    const fx = Math.floor(x + dx), fz = Math.floor(z + dz), fy = Math.floor(y + 0.01);
    const f = blk(fx, fy - 1, fz);
    if (passable(f) || f === B.WATER) return false;
    if (!passable(blk(fx, fy, fz)) || !passable(blk(fx, fy + 1, fz))) return false;
  }
  return true;
}
function vehicleSpot(act: string, x: number, z: number, want: number | null, big = false, separate = true): { p: V3; yaw: number } | null {
  let l = nav.nearestRoad(x, z, 120);
  if (!l) return null;
  const r = big ? 2 : 1;
  // prefer the direction closest to the authored heading on two-way roads
  if (want !== null && !(graph.eFlags[l.edge] & sh.GF.ONEWAY)) {
    const dy = Math.abs(sh.angleDiff(l.yaw, want));
    if (dy > Math.PI / 2) l = nav.laneSpot(l.edge, (l.dir === 1 ? -1 : 1), graph.eLen[l.edge] - l.s, graph.lanesDir(l.edge) - 1);
  }
  const list = placedVeh.get(act) ?? [];
  const bad = (q: typeof l) => !footprintFree(q!.x, q!.y, q!.z, r) || (separate && list.some((p) => Math.hypot(p.x - q!.x, p.z - q!.z) < 7.5));
  for (let k = 0; k < 24 && bad(l); k++) {
    // other lanes first, then step 4 m along the travel direction
    let found = false;
    for (let ln = 0; ln < graph.lanesDir(l.edge) && !found; ln++) { const q = nav.laneSpot(l.edge, l.dir, l.s, ln); if (!bad(q)) { l = q; found = true; } }
    if (found) break;
    const s = l.s + 4;
    if (s < graph.eLen[l.edge] - 2) l = nav.laneSpot(l.edge, l.dir, s, l.lane);
    else { const nx = nav.nextEdge(l.edge, l.dir); if (!nx) break; l = nav.laneSpot(nx.edge, nx.dir, 3, graph.lanesDir(nx.edge) - 1); }
  }
  if (separate) { list.push({ x: l.x, z: l.z }); placedVeh.set(act, list); }
  return { p: [r1(l.x), r1(l.y), r1(l.z)], yaw: r3(l.yaw) };
}

// which buildings an activity (with its cutscenes) is about: those whose interior pad holds one of
// its points, or whose doors it scripts. Points on other buildings' lots spread with downtown.
const palDoors = sh.worldAnchors('palmara').filter((a) => a.kind === 'door');
const padHits = new Map<string, Set<string>>();
const hitCount = new Map<string, number>();
for (const v of visits) {
  if (v.kind !== 'v3') continue;
  const root = rootOf(v.path);
  for (const f of palFrames) {
    const l = worldToFrame(f.pal, v.value[0], v.value[2]);
    const nearDoor = Math.hypot(l[0] - 24, l[1] - 9) < 7 || palDoors.some((d) => d.poi === f.p.id && Math.hypot(d.wx - v.value[0], d.wz - v.value[2]) < 6);
    if ((l[0] >= 8 && l[0] < 40 && l[1] >= 8 && l[1] < 40) || nearDoor) { let s = padHits.get(root); if (!s) padHits.set(root, s = new Set()); s.add(f.p.id); hitCount.set(`${root}|${f.p.id}`, (hitCount.get(`${root}|${f.p.id}`) ?? 0) + 1); }
  }
}
for (const a of ACTIVITIES) for (const st of a.stages) for (const sp of st.spawn ?? []) if (sp.kind === 'door') { let s = padHits.get(a.id); if (!s) padHits.set(a.id, s = new Set()); s.add(sp.door.split('.')[0]); }
const relevance = new Map<string, Set<string>>();
for (const a of ACTIVITIES) {
  const set = new Set(padHits.get(a.id) ?? []);
  for (const st of a.stages) if (st.cutscene) for (const q of padHits.get(`cs:${st.cutscene}`) ?? []) set.add(q);
  relevance.set(a.id, set);
}
/** activities whose street spots are not about a building (Palmara lot hits are incidental) */
const LOOSE_ONLY = new Set(['prep_tower_convoy', 'cs:tw_convoy_in', 'cs:tw_convoy_out']);
const homeOf = new Map<string, string | null>();
for (const a of ACTIVITIES) {
  const roots = [a.id, ...a.stages.filter((s) => s.cutscene).map((s) => `cs:${s.cutscene}`)];
  let best: string | null = null, bn = 0;
  for (const poi of relevance.get(a.id)!) { const n = roots.reduce((t, r) => t + (hitCount.get(`${r}|${poi}`) ?? 0), 0); if (n > bn) { bn = n; best = poi; } }
  // the home only steers loose spots when the activity starts at it (within 60 m of its lot)
  if (best) { const f = palFrames.find((q) => q.p.id === best)!; const l = worldToFrame(f.pal, a.start[0], a.start[2]); if (Math.max(0, -l[0], l[0] - 48, -l[1], l[1] - 48) > 60) best = null; }
  homeOf.set(a.id, best);
  for (const st of a.stages) if (st.cutscene && !homeOf.has(`cs:${st.cutscene}`)) homeOf.set(`cs:${st.cutscene}`, best);
}
for (const a of ACTIVITIES) for (const st of a.stages) if (st.cutscene) {
  const k = `cs:${st.cutscene}`; let s = relevance.get(k); if (!s) relevance.set(k, s = new Set());
  for (const q of relevance.get(a.id)!) s.add(q);
}
for (const v of visits) {
  if (v.kind !== 'v3') continue;
  const act = rootOf(v.path);
  const r = rep(act);
  r.n++;
  const [px, py, pz] = v.value;
  const holder = v.holder as Record<string, unknown>;
  const key = String(v.key);
  const parent = v.ctx[v.ctx.length - 1] as Record<string, unknown> | undefined;
  const chain = Array.isArray(holder) && !!parent && (parent as { type?: string }).type === 'checkpoints';
  const m = mapPoint(px, pz, LOOSE_ONLY.has(act) ? new Set() : relevance.get(act) ?? padHits.get(act) ?? new Set(), homeOf.get(act) ?? null, chain);
  r.vias.add(m.via);
  const isCs = act.startsWith('cs:');
  let out: V3;
  const water = py <= 21;
  if (isCs && (key === 'from' || key === 'to')) {
    // cameras keep their framing: placed relative to what they look at
    const look = (holder as Record<string, V3>)[key === 'from' ? 'lookFrom' : 'lookTo'];
    const lm = mapPoint(look[0], look[2], relevance.get(act) ?? new Set(), homeOf.get(act) ?? null);
    const a2 = -lm.rot * Math.PI / 2 * -1, dx = px - look[0], dz = pz - look[2];
    const rx = lm.rot === 0 ? dx : lm.rot === 1 ? -dz : lm.rot === 2 ? -dx : dz, rz = lm.rot === 0 ? dz : lm.rot === 1 ? dx : lm.rot === 2 ? -dz : -dx;
    void a2;
    out = liftCam([r1(lm.x + rx), py, r1(lm.z + rz)]);
    if (out[1] - py > 0) r.snapped++;
  } else if (isCs && (key === 'lookFrom' || key === 'lookTo')) {
    out = [r1(m.x), py, r1(m.z)];
  } else if (!Array.isArray(holder) && key === 'pos' && holder.kind === 'vehicle') {
    const model = String(holder.model);
    if (VEHICLES[model as keyof typeof VEHICLES]?.boat) {
      const w = snapWater(m.x, m.z);
      if (!w) { r.problems.push(`${v.path}: no water`); out = [m.x, 21, m.z]; } else out = w;
      holderRot.set(holder, m.rot);
    } else {
      const want = typeof holder.yaw === 'number' ? sh.frameYaw({ ox: 0, oz: 0, rot: m.rot as 0 }, holder.yaw) : null;
      const s = vehicleSpot(act, m.x, m.z, want, model === 'van' || model === 'pickup');
      if (!s) { r.problems.push(`${v.path}: no road`); out = [m.x, 22, m.z]; } else { out = s.p; holderYaw.set(holder, s.yaw); }
    }
    r.snapped++;
  } else if (!Array.isArray(holder) && key === 'pos' && holder.type === 'reach' && typeof holder.vehicle === 'string' && !water) {
    // drive-to targets sit on the street (the vehicle must fit there)
    const s = vehicleSpot(act, m.x, m.z, null, true, false);
    out = s ? s.p : [m.x, 22, m.z];
    if (!s) r.problems.push(`${v.path}: no road`);
    r.snapped++;
  } else if (Array.isArray(holder) && parent && (parent.startGrid === holder)) {
    out = [r1(m.x), 22, r1(m.z)]; // races: replaced below
  } else if (water) {
    const w = m.exact ? null : snapWater(m.x, m.z);
    out = w ?? [r1(m.x), py, r1(m.z)];
    if (!w && !m.exact) r.problems.push(`${v.path}: no water near`);
    r.snapped++;
  } else if (m.exact && standable(m.x, py, m.z) && connectedToStreet(m.x, py, m.z)) {
    out = [r3(m.x), py, r3(m.z)];
    r.exact++;
  } else {
    const s = snapFoot(m.x, m.z, Math.max(22, py), 60);
    if (!s) { r.problems.push(`${v.path}: nothing standable near ${m.x.toFixed(0)},${m.z.toFixed(0)}`); out = [m.x, py, m.z]; }
    else {
      const d = Math.hypot(s[0] - m.x, s[2] - m.z);
      r.maxSnap = Math.max(r.maxSnap, d);
      if (d > 0.8) r.snapped++;
      if (m.exact) out = s; else out = s;
      if (d > 30) warn(`${v.path}: snapped ${d.toFixed(0)} m (${m.via})`);
    }
  }
  POS[v.path] = out;
  if (process.env.DEBUG_ACT && act === process.env.DEBUG_ACT) console.log(v.path.padEnd(48), [px, py, pz].join(",").padEnd(18), m.via.padEnd(12), out.map((n) => n.toFixed(0)).join(","));
  if (!Array.isArray(holder)) holderRot.set(holder, m.rot);
  else if (parent && !holderRot.has(parent)) holderRot.set(parent, m.rot);
}
for (const v of visits) {
  if (v.kind !== 'yaw') continue;
  const ly = holderYaw.get(v.holder);
  if (ly !== undefined) { YAW[v.path] = ly; continue; }
  const rot = holderRot.get(v.holder) ?? 0;
  YAW[v.path] = r3(sh.frameYaw({ ox: 0, oz: 0, rot: rot as 0 }, v.value));
}

// ───────────────────────────────────────────────────────── routes (races, boat trip)
type Pt = { x: number; z: number };
function routeVia(pts: [number, number][]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    // racers may drive against one-way streets: route on the carriageways ignoring one-way rules
    const node = (x: number, z: number) => { const h = graph.nearest(x, z, 80, (e) => graph.isCar(e) && graph.eCls[e] < 8)!; const a = graph.eA[h.e], b = graph.eB[h.e]; return Math.hypot(graph.nodeX[a] - x, graph.nodeZ[a] - z) < Math.hypot(graph.nodeX[b] - x, graph.nodeZ[b] - z) ? a : b; };
    const rr = graph.route(node(pts[i][0], pts[i][1]), node(pts[i + 1][0], pts[i + 1][1]), { car: true, oneway: 'ignore', maxExpand: 200000, edgeCost: (e) => graph.eCls[e] >= 8 ? 4 : 1 });
    if (!rr) throw new Error(`no route ${pts[i]} → ${pts[i + 1]}`);
    const r: Pt[] = [];
    rr.edges.forEach((e, k) => { const pl = graph.polyline(e, rr.dirs[k]); r.push(...pl); });
    for (const p of r) if (!out.length || Math.hypot(out[out.length - 1].x - p.x, out[out.length - 1].z - p.z) > 0.5) out.push(p);
  }
  return out;
}
const polyLen = (p: Pt[]) => p.reduce((s, q, i) => (i ? s + Math.hypot(q.x - p[i - 1].x, q.z - p[i - 1].z) : 0), 0);
/** checkpoints along a polyline: every `spacing` m and at sharp turns */
function cpsAlong(poly: Pt[], spacing: number, y: (p: Pt) => number): V3[] {
  const out: V3[] = [];
  let acc = 0;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1], b = poly[i];
    acc += Math.hypot(b.x - a.x, b.z - a.z);
    let turn = 0;
    if (i + 1 < poly.length) {
      const c = poly[i + 1];
      const a1 = Math.atan2(b.z - a.z, b.x - a.x), a2 = Math.atan2(c.z - b.z, c.x - b.x);
      turn = Math.abs(sh.angleDiff(a1, a2));
    }
    if (acc >= spacing || (turn > 0.6 && acc > 40) || i === poly.length - 1) { out.push([r1(b.x), y(b), r1(b.z)]); acc = 0; }
  }
  return out;
}
function laneAt(p: Pt) { return nav.nearestRoad(p.x, p.z, 20); }
const roadY = (p: Pt) => { const l = laneAt(p); return l ? r1(l.y) : 22; };
/** start grid: 4 slots on the lanes behind `p`, facing along the route */
function grid(p: Pt, next: Pt): { slots: V3[]; yaw: number } {
  const yaw = sh.yawOf(next.x - p.x, next.z - p.z);
  const fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
  const slots: V3[] = [];
  for (let k = 0; k < 4; k++) {
    const back = 8 * Math.floor(k / 2), side = (k % 2 ? 1 : -1) * 1.6;
    const x = p.x - fx * back + rx * side, z = p.z - fz * back + rz * side;
    slots.push([r1(x), roadY({ x, z }), r1(z)]);
  }
  return { slots, yaw: r3(yaw) };
}
function palLen(pts: V3[], laps: number, start?: V3) {
  let L = 0; const all = start ? [start, ...pts] : pts;
  for (let i = 1; i < all.length; i++) L += Math.hypot(all[i][0] - all[i - 1][0], all[i][2] - all[i - 1][2]);
  if (laps > 1) L += (laps - 1) * (L - (start ? Math.hypot(pts[0][0] - start[0], pts[0][2] - start[2]) : 0) + Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][2] - pts[pts.length - 1][2]));
  return L;
}
const ACT = Object.fromEntries(ACTIVITIES.map((a) => [a.id, a]));
const RACE_IDS = new Set(['race_downtown', 'mini_trial', 'mini_boatrace', 'story_4']);
function raceOut(id: string, route: Pt[], loop: boolean, spacing: number, opts: { boat?: boolean; startSpot?: V3 } = {}) {
  const a = ACT[id];
  const ri = a.stages.findIndex((s) => s.objectives.some((x) => x.type === 'checkpoints'));
  const rs = a.stages[ri];
  const o = rs.objectives.find((x) => x.type === 'checkpoints') as { points: V3[]; laps: number; r: number };
  const si = rs.objectives.indexOf(o as never);
  const yf = opts.boat ? () => 21 : roadY;
  // start a few metres down the route; checkpoints from there, finishing at the start line for loops
  const start = route[0], next = route[Math.min(route.length - 1, 3)];
  let cps = cpsAlong(route, spacing, yf);
  if (loop) cps.push([r1(start.x), yf(start), r1(start.z)]);
  // drop checkpoints closer than 25 m
  { const f: V3[] = []; for (const c of cps) { if (f.length && Math.hypot(c[0] - f[f.length - 1][0], c[2] - f[f.length - 1][2]) <= 25) f[f.length - 1] = c; else f.push(c); } cps = f; }
  const g = opts.boat ? (() => {
    const yaw = sh.yawOf(next.x - start.x, next.z - start.z), fx = -Math.sin(yaw), fz = -Math.cos(yaw), rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const slots: V3[] = [0, 1, 2, 3].map((k) => { const b = 10 + 9 * Math.floor(k / 2), s = (k % 2 ? 1 : -1) * 4; return [r1(start.x - fx * b + rx * s), 21, r1(start.z - fz * b + rz * s)] as V3; });
    return { slots, yaw: r3(yaw) };
  })() : grid(start, next);
  const lapLen = polyLen(route) + (loop ? 0 : 0);
  const Lleo = lapLen * o.laps;
  const Lpal = palLen(o.points, o.laps, a.race!.startGrid[0]);
  const par = a.race!.parTimes.map((t) => Math.round((t * Lleo) / Lpal)) as [number, number, number];
  const base = `${id}/stages/${ri}`;
  SET[`${base}/objectives/${si}/points`] = cps;
  SET[`${id}/race/startGrid`] = g.slots;
  SET[`${id}/race/parTimes`] = par;
  if (rs.timeLimit) SET[`${base}/timeLimit`] = Array(4).fill(Math.ceil((par[2] * 1.6) / 10) * 10 + 30);
  const sp = rs.spawn!.findIndex((s) => s.kind === 'vehicle');
  POS[`${base}/spawn/${sp}/pos`] = g.slots[0];
  YAW[`${base}/spawn/${sp}/yaw`] = g.yaw;
  if (ri === 0) YAW[`${id}/startYaw`] = g.yaw;
  a.race!.startGrid.forEach((_, i) => { POS[`${id}/race/startGrid/${i}`] = g.slots[i]; });
  // the cutscene end spots of the intro: on the grid
  const cs = rs.cutscene;
  const shoreSpots = (st: V3) => [0, 1, 2, 3].map((i) => snapFoot(st[0] + i * 1.5, st[2], 22, 20) ?? st);
  const st = opts.startSpot ?? snapFoot(start.x, start.z, 22, 40)!;
  if (cs) {
    // the intro is staged around the grid: move it rigidly from the Palmara grid to the Leonia one
    const c = CUTSCENES[cs];
    const P0 = a.race!.startGrid[0], y0 = (rs.spawn!.find((q) => q.kind === 'vehicle') as { yaw: number }).yaw;
    const G0 = g.slots[0];
    const ang = (y: number) => Math.atan2(-Math.cos(y), -Math.sin(y));
    const al = ang(g.yaw) - ang(y0), ca = Math.cos(al), sa = Math.sin(al);
    const tr = (q: V3, lift: boolean): V3 => { const dx = q[0] - P0[0], dz = q[2] - P0[2]; const o: V3 = [r1(G0[0] + dx * ca - dz * sa), q[1] - 22 + G0[1], r1(G0[2] + dx * sa + dz * ca)]; return lift ? liftCam(o) : o; };
    c.shots.forEach((sh2, k) => { for (const key of ['from', 'to', 'lookFrom', 'lookTo'] as const) POS[`cs:${cs}/shots/${k}/cam/${key}`] = tr(sh2.cam[key], key === 'from' || key === 'to'); });
    c.actors.forEach((ac, k) => {
      const o = tr(ac.pos, false); POS[`cs:${cs}/actors/${k}/pos`] = opts.boat ? shoreSpots(st)[3] : (snapFoot(o[0], o[2], 22, 20) ?? o);
      YAW[`cs:${cs}/actors/${k}/yaw`] = r3(ac.yaw - al);
      if (ac.walkTo) POS[`cs:${cs}/actors/${k}/walkTo`] = snapFoot(...(tr(ac.walkTo, false).filter((_, i) => i !== 1) as [number, number]), 22, 20) ?? tr(ac.walkTo, false);
    });
    c.endSpots.forEach((_, i) => { POS[`cs:${cs}/endSpots/${i}`] = opts.boat ? shoreSpots(st)[i % 4] : g.slots[i % 4]; }); YAW[`cs:${cs}/endYaw`] = g.yaw;
  }
  // on-foot start marker + spots: beside the grid (sidewalk / shore)
  if (ri === 0) {
    POS[`${id}/start`] = st;
    a.startSpots.forEach((_, i) => { POS[`${id}/startSpots/${i}`] = shoreSpots(st)[i]; });
  }
  raceInfo.push({ id, lap: Math.round(lapLen), laps: o.laps, cps: cps.length, par, palLap: Math.round(Lpal / o.laps) });
}
const raceInfo: { id: string; lap: number; laps: number; cps: number; par: [number, number, number]; palLap: number }[] = [];

// Downtown Sprint: two laps from Torque & Tide (NE 1st Ave) round the downtown grid
{
  const gar = poiFrame(POIS.find((p) => p.id === 'garage')!, 'leonia');
  const [gx, gz] = frameToWorld(gar, 24, 1);
  const pts: [number, number][] = [
    [gx, gz],
    streetPoint(/Northeast 1st Avenue/, -80.1918, 25.7742),          // south on NE 1st Ave to Flagler
    streetPoint(/East Flagler Street/, -80.1885, 25.7743),          // east on Flagler to Biscayne Blvd
    streetPoint(/Biscayne Boulevard/, -80.1874, 25.7790),           // north on Biscayne Blvd
    streetPoint(/Northeast 5th Street/, -80.1905, 25.7793),         // west on NE 5th St
    streetPoint(/Northeast 1st Avenue/, -80.1921, 25.7790),         // south on NE 1st Ave
    [gx, gz],
  ];
  raceOut('race_downtown', routeVia(pts), true, 150);
}
// Neon Warm-Up (story 4): Kilo's qualifying loop round the club's block in Wynwood, on real streets
{
  const a = ACT.story_4;
  const ri = a.stages.findIndex((s) => s.objectives.some((x) => x.type === 'checkpoints'));
  const oi = a.stages[ri].objectives.findIndex((x) => x.type === 'checkpoints');
  void oi;
  const ways: [number, number][] = [
    streetPoint(/Northwest 2nd Avenue/, -80.1990, 25.8008),
    streetPoint(/Northwest 2nd Avenue/, -80.1991, 25.8031),
    streetPoint(/Northwest 28th Street/, -80.2005, 25.8032),
    streetPoint(/Northwest 3rd Avenue/, -80.2016, 25.8031),
    streetPoint(/Northwest 3rd Avenue/, -80.2015, 25.8004),
    streetPoint(/Northwest 26th Street/, -80.2003, 25.8003),
  ];
  ways.push(ways[0]);
  raceOut('story_4', routeVia(ways), true, 110);
}
// Palm Mile Time Trial: Sunline Motors (5th St) → MacArthur Causeway → downtown → Venetian Causeway → Ocean Drive → 5th St
{
  const sl = poiFrame(POIS.find((p) => p.id === 'sunline')!, 'leonia');
  const [sx, sz] = frameToWorld(sl, 24, 1);
  const pts: [number, number][] = [
    [sx, sz],
    streetPoint(/Alton Road/, -80.1405, 25.7745),
    streetPoint(/Alton Road/, -80.1415, 25.7900),
    streetPoint(/Dade Boulevard|17th Street/, -80.1360, 25.7920),
    streetPoint(/Collins Avenue/, -80.1295, 25.7925),
    streetPoint(/Collins Avenue/, -80.1310, 25.7860),
    streetPoint(/^Ocean Drive$/, -80.1300, 25.7810),
    streetPoint(/^Ocean Drive$/, -80.1335, 25.7740),
    [sx, sz],
  ];
  raceOut('mini_trial', routeVia(pts), true, 220);
  setLine('mini_trial/blurb', 'One lap of the South Beach ring: Alton Road, 17th Street, Collins Avenue and Ocean Drive, back to 5th Street. You against the clock - nobody to hit, nowhere to hide.');
}
// Lagoon Cup: three laps round buoys in Biscayne Bay off Bayfront Park
{
  const buoys = [[-80.1822, 25.7746], [-80.1812, 25.7753], [-80.1801, 25.7748], [-80.1802, 25.7736], [-80.1815, 25.7734]] as [number, number][];
  const pts = buoys.map(([lo, la]) => { const [x, z] = ll(lo, la); const w = snapWater(x, z, 60)!; return { x: w[0], z: w[2] }; });
  // densify the loop for spacing purposes
  const loop: Pt[] = [];
  for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; for (let k = 0; k < 4; k++) loop.push({ x: a.x + ((b.x - a.x) * k) / 4, z: a.z + ((b.z - a.z) * k) / 4 }); }
  loop.push(pts[0]);
  const shore = snapFoot(ll(-80.1858, 25.7752)[0], ll(-80.1858, 25.7752)[1], 22, 40)!;
  raceOut('mini_boatrace', loop, true, 120, { boat: true, startSpot: shore });
}

// Story 7 "Dead Reckoning": South Beach → out past the surf → round South Pointe → down the
// ocean side of Fisher Island → Norris Cut → Virginia Key Beach. No bridges on the way.
{
  const legs: [number, number][] = [
    [-80.1265, 25.7790], // leg1 out past the surf
    [-80.1235, 25.7655], // leg2 round South Pointe (Government Cut mouth)
    [-80.1290, 25.7560], // leg3 open water off Fisher Island
    [-80.1380, 25.7480], // leg4 Norris Cut
    [-80.1395, 25.7430], // leg5 along Virginia Key
    [-80.1405, 25.7405], // leg6 the island lights
    worldToLonLat(VK_BEACH[0] + 18, VK_BEACH[1]) as [number, number], // dock: just off Virginia Key Beach
  ];
  const a = ACT.story_7;
  const ids = ['leg1', 'leg2', 'leg3', 'leg4', 'leg5', 'leg6', 'dock'];
  let prev: [number, number] = [POS['story_7/stages/0/spawn/0/pos'][0], POS['story_7/stages/0/spawn/0/pos'][2]];
  ids.forEach((sid, k) => {
    const si = a.stages.findIndex((s) => s.id === sid);
    const [x, z] = ll(legs[k][0], legs[k][1]);
    const w = snapWater(x, z, 150);
    if (!w) { rep('story_7').problems.push(`${sid}: no water`); return; }
    POS[`story_7/stages/${si}/objectives/0/pos`] = w;
    const d = Math.hypot(w[0] - prev[0], w[2] - prev[1]); // prev is [x, z]
    SET[`story_7/stages/${si}/timeLimit`] = Array(4).fill(Math.max(45, Math.ceil((d / 14 + 25) / 5) * 5));
    if (process.env.DEBUG_S7) console.log("S7", sid, si, w, prev, d, SET[`story_7/stages/${si}/timeLimit`]);
    prev = [w[0], w[2]];
  });
}

// ───────────────────────────────────────────────────────── camera moves clear of blocks and foliage
// The client interpolates each shot from → to: the whole move (not just its ends) must stay in the
// air. Shots that cut through a building, a tree or a palm crown are lifted as a whole.
const camLifts: string[] = [];
for (const [id, c] of Object.entries(CUTSCENES)) c.shots.forEach((s, k) => {
  const pf = `cs:${id}/shots/${k}/cam/from`, pt = `cs:${id}/shots/${k}/cam/to`;
  const a = POS[pf] ?? s.cam.from, b = POS[pt] ?? s.cam.to;
  let dy = 0;
  const clear = () => { for (let i = 0; i <= 16; i++) { const f = i / 16; if (!camFree(a[0] + (b[0] - a[0]) * f, a[1] + dy + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f)) return false; } return true; };
  while (dy < 80 && !clear()) dy++;
  if (dy) { POS[pf] = [a[0], a[1] + dy, a[2]]; POS[pt] = [b[0], b[1] + dy, b[2]]; camLifts.push(`${id}#${k} +${dy}`); }
});

// ───────────────────────────────────────────────────────── boat legs: straight runs in open water
// Each water target must be reachable in a straight line from the previous boat point (the
// validator checks the same corridor). A blocked target moves to the nearest open-water spot
// within 900 m that has a clear run.
function clearLeg(a: V3, b: V3): boolean {
  const len = Math.hypot(b[0] - a[0], b[2] - a[2]); if (len < 1) return true;
  const n = Math.ceil(len / 2), nx = (b[2] - a[2]) / len, nz = -(b[0] - a[0]) / len;
  for (let i = 0; i <= n; i++) {
    const x = a[0] + ((b[0] - a[0]) * i) / n, z = a[2] + ((b[2] - a[2]) * i) / n;
    for (const o of [-2, 0, 2]) if (!isWaterCol(x + nx * o, z + nz * o)) return false;
  }
  return true;
}
const legFixes: string[] = [];
for (const a of ACTIVITIES) {
  if (RACE_IDS.has(a.id)) continue;
  let last: V3 | null = null;
  a.stages.forEach((s, si) => {
    s.spawn?.forEach((sp, k) => { if (sp.kind === 'vehicle' && VEHICLES[sp.model as keyof typeof VEHICLES]?.boat) last = POS[`${a.id}/stages/${si}/spawn/${k}/pos`] ?? last; });
    s.objectives.forEach((o, oi) => {
      if (o.type !== 'reach') return;
      const path = `${a.id}/stages/${si}/objectives/${oi}/pos`;
      const p = POS[path]; if (!p || p[1] > 21 || !isWaterCol(p[0], p[2])) return;
      if (last && !clearLeg(last, p)) {
        let best: V3 | null = null, bd = Infinity;
        for (let rr = 10; rr <= 900 && !best; rr += 10) for (let k = 0; k < Math.max(8, Math.round(rr / 6)); k++) {
          const an = (k / Math.max(8, Math.round(rr / 6))) * Math.PI * 2;
          const q: V3 = [r1(p[0] + Math.cos(an) * rr), 21, r1(p[2] + Math.sin(an) * rr)];
          if (!openWater(q[0], q[2], 4) || !clearLeg(last, q)) continue;
          const d = rr; if (d < bd) { bd = d; best = q; }
        }
        if (best) { POS[path] = best; legFixes.push(`${path}: moved ${bd} m for a clear run`); }
        else legFixes.push(`${path}: NO clear run`);
      }
      last = POS[path];
    });
  });
}

// ───────────────────────────────────────────────────────── taxi shift: four fares inside downtown
// Mapping Palmara's fares put two drop-offs across the bay (6 km legs, par 1 130 s). The shift is authored on the
// real downtown instead: pick-ups / drop-offs at the early-game landmarks, each leg 350-1 200 m by road.
{
  const poi = (id: string) => { const c = sh.poiCenter(id); return [c[0], c[1]] as [number, number]; };
  // the kerb in front of the landmark: nearest carriageway lane, then the closest walkable non-road cell beside it (never inside the building)
  const curb = (p: [number, number], dx = 0, dz = 0): V3 => { const lane = nav.nearestRoad(p[0], p[1], 120); const bx = lane ? lane.x : p[0], bz = lane ? lane.z : p[1]; return snapFoot(bx + dx, bz + dz, 22, 30) ?? [bx, 22, bz]; };
  const legs: [string, string][] = [['garage', 'plaza'], ['store', 'safehouse'], ['diner', 'store'], ['safehouse', 'police']];
  const taxi = ACTIVITIES.find((a) => a.id === 'mini_taxi');
  if (taxi) {
    let prev: [number, number] = [POS['mini_taxi/start']?.[0] ?? taxi.start[0], POS['mini_taxi/start']?.[2] ?? taxi.start[2]];
    let total = 0; const lens: number[] = [];
    legs.forEach(([a, b], i) => {
      const A = poi(a), Bp = poi(b);
      for (const [k, [pt, dx]] of ([[A, 0], [A, 8]] as [[number, number], number][]).entries()) POS[`mini_taxi/stages/${1 + i * 2}/spawn/${k}/pos`] = curb(pt, dx, 0);
      for (const [k, [pt, dx]] of ([[Bp, 0], [Bp, 8]] as [[number, number], number][]).entries()) POS[`mini_taxi/stages/${2 + i * 2}/spawn/${k}/pos`] = curb(pt, dx, 0);
      const len = (x: [number, number], y: [number, number]) => { const r = nav.route(x[0], x[1], y[0], y[1]); let L = 0; if (r) for (let j = 1; j < r.length; j++) L += Math.hypot(r[j].x - r[j - 1].x, r[j].z - r[j - 1].z); return r ? L : Math.hypot(x[0] - y[0], x[1] - y[1]) * 1.4; };
      const toPick = len(prev, A), ride = len(A, Bp);
      lens.push(toPick, ride); total += toPick + ride; prev = Bp;
      const tl = (t: number) => [t, t - 10, t - 20, t - 25];
      SET[`mini_taxi/stages/${1 + i * 2}/timeLimit`] = tl(Math.ceil((toPick / 11 + 45) / 10) * 10);
      SET[`mini_taxi/stages/${2 + i * 2}/timeLimit`] = tl(Math.ceil((ride / 11 + 45) / 10) * 10);
    });
    // 8 stops × ~9 s of kerb work, driving at ~15 m/s average on city streets
    const gold = Math.ceil((total / 15 + 75) / 5) * 5;
    SET['mini_taxi/minigame/parScores'] = [gold, Math.ceil(gold * 1.3 / 5) * 5, Math.ceil(gold * 1.7 / 5) * 5];
    console.log(`taxi: legs ${lens.map((l) => Math.round(l)).join('/')} m, total ${Math.round(total)} m, par ${(SET['mini_taxi/minigame/parScores'] as number[]).join('/')} s`);
  }
}

// ───────────────────────────────────────────────────────── re-time stages / minigame pars
const RACES = new Set(['race_downtown', 'mini_trial', 'mini_boatrace']);
const retime: string[] = [];
function posOf(path: string, raw: V3): V3 { return POS[path] ?? raw; }
for (const a of ACTIVITIES) {
  if (RACES.has(a.id)) continue;
  let prevPal: V3 = a.start, prevLeo: V3 = posOf(`${a.id}/start`, a.start);
  let extraTotal = 0;
  let vehicleSeen = false;
  a.stages.forEach((s, si) => {
    // where this stage sends the crew (in order)
    const spawnPath = new Map<string, string>();
    s.spawn?.forEach((sp, k) => { spawnPath.set(sp.id, `${a.id}/stages/${si}/spawn/${k}/pos`); if (sp.kind === 'vehicle') vehicleSeen = true; });
    const targets: [V3, V3][] = [];
    s.objectives.forEach((o, oi) => {
      if (o.type === 'reach' || o.type === 'defend') targets.push([o.pos, posOf(`${a.id}/stages/${si}/objectives/${oi}/pos`, o.pos)]);
      if (o.type === 'interact') for (const t of o.targets) { const sp = s.spawn?.find((q) => q.id === t) as { pos?: V3 } | undefined; if (sp?.pos) targets.push([sp.pos, posOf(spawnPath.get(t)!, sp.pos)]); }
    });
    if (!targets.length) return;
    let dp = 0, dl = 0, pp = prevPal, pl = prevLeo;
    for (const [tp, tl] of targets) { dp += Math.hypot(tp[0] - pp[0], tp[2] - pp[2]); dl += Math.hypot(tl[0] - pl[0], tl[2] - pl[2]); pp = tp; pl = tl; }
    prevPal = pp; prevLeo = pl;
    const extra = Math.max(0, dl * 1.3 - dp * 1.3);
    const boat = s.objectives.some((o) => (o as { pos?: V3 }).pos?.[1] === 21);
    const v = boat ? 15 : vehicleSeen ? 16 : 4.5;
    const add = extra / v;
    extraTotal += add;
    if (s.timeLimit && add > 5 && !SET[`${a.id}/stages/${si}/timeLimit`]) {
      const tl = s.timeLimit.map((t) => Math.ceil((t + add) / 10) * 10);
      SET[`${a.id}/stages/${si}/timeLimit`] = tl;
      retime.push(`${a.id}/${s.id}: ${s.timeLimit[0]} → ${tl[0]} s (${dp.toFixed(0)} m → ${dl.toFixed(0)} m)`);
    }
  });
  if (a.minigame?.parScores && a.minigame.scoring === 'time' && extraTotal > 5 && !SET[`${a.id}/minigame/parScores`]) {
    SET[`${a.id}/minigame/parScores`] = a.minigame.parScores.map((p) => Math.ceil((p + extraTotal * 0.8) / 5) * 5);
    retime.push(`${a.id}: par ${a.minigame.parScores.join('/')} → ${(SET[`${a.id}/minigame/parScores`] as number[]).join('/')}`);
  }
}

// ───────────────────────────────────────────────────────── text that names directions / geography
void setLine;

// ───────────────────────────────────────────────────────── write
const fmt = (o: unknown) => JSON.stringify(o);
const lines = [
  '// generated by scripts/leonia-content.ts — do not edit (re-run the script after content or world changes)',
  `// ${Object.keys(POS).length} positions, ${Object.keys(YAW).length} headings, ${Object.keys(SET).length} overrides`,
  'export const LEONIA_POS: Record<string, [number, number, number]> = {',
  ...Object.entries(POS).map(([k, v]) => `  ${fmt(k)}: ${fmt(v)},`),
  '};',
  'export const LEONIA_YAW: Record<string, number> = {',
  ...Object.entries(YAW).map(([k, v]) => `  ${fmt(k)}: ${v},`),
  '};',
  'export const LEONIA_SET: Record<string, unknown> = {',
  ...Object.entries(SET).map(([k, v]) => `  ${fmt(k)}: ${fmt(v)},`),
  '};',
  '',
];
writeFileSync('packages/shared/src/content/leonia/positions.gen.ts', lines.join('\n'));

console.log('activity / cutscene        positions exact snapped maxSnap  via');
for (const [id, r] of report) console.log(`${id.padEnd(26)} ${String(r.n).padStart(4)} ${String(r.exact).padStart(5)} ${String(r.snapped).padStart(7)} ${r.maxSnap.toFixed(1).padStart(6)}  ${[...r.vias].join(',')}${r.problems.length ? '\n    PROBLEMS: ' + r.problems.join('; ') : ''}`);
console.log('\nraces:'); for (const r of raceInfo) console.log(`  ${r.id}: lap ${r.lap} m (Palmara ${r.palLap} m) × ${r.laps}, ${r.cps} checkpoints, par ${r.par.join('/')}`);
console.log('\nre-timed:'); for (const s of retime) console.log('  ' + s);
console.log(`\nwarnings (${warnings.length}):`); for (const w of warnings) console.log('  ' + w);
void worldToLonLat;
console.log('boat legs:', legFixes.join(' | ') || 'all clear');
console.log('camera lifts:', camLifts.length, camLifts.join(' '));

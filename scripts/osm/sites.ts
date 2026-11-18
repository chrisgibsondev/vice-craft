/**
 * Leonia site finder for enterable prefabs (docs/LEONIA.md §10). For a target lon/lat it walks
 * the frontage of every car street nearby (optionally only streets whose name matches) and
 * scores 48×48 prefab placements that face the street: rejects pads crossed by car roads, rail,
 * bridge decks or water, and reports which generated buildings the pad would remove.
 *
 *   npx tsx scripts/osm/sites.ts <lon> <lat> [radius=250] [streetRegex] [--top=8]
 *   npx tsx scripts/osm/sites.ts --check <ox> <oz> <rot>      # inspect one frame
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  LeoniaTiles, RoadGraph, LEONIA, lonLatToWorld, worldToLonLat, districtAt, TILE, BF, isCarRoad, isRail,
} from '../../packages/shared/src/index.ts';
import { frameRect, PAD, type Frame, type Rot } from '../../packages/shared/src/world/placement.ts';

const DIR = join(process.cwd(), 'apps/client/public/world/leonia');
export const tiles = new LeoniaTiles({ readSync: (tx, tz) => { const f = join(DIR, `t_${tx}_${tz}.bin`); return existsSync(f) ? new Uint8Array(readFileSync(f)) : null; } }, 64);
export const graph = new RoadGraph(new Uint8Array(readFileSync(join(DIR, 'graph.bin'))), LEONIA.width, LEONIA.depth);

export interface SiteReport {
  frame: Frame; rect: [number, number, number, number]; street: string; offAngle: number;
  removed: { name: string; h: number; area: number; synthetic: boolean }[]; cost: number;
  reject: string | null; district: string; curb: [number, number];
}

function segRectDist(ax: number, az: number, bx: number, bz: number, r: [number, number, number, number]): number {
  // distance between a segment and an axis-aligned rect (0 if intersecting); sampled
  let best = Infinity;
  const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / 0.5));
  for (let i = 0; i <= n; i++) {
    const x = ax + ((bx - ax) * i) / n, z = az + ((bz - az) * i) / n;
    const dx = Math.max(r[0] - x, 0, x - r[2]), dz = Math.max(r[1] - z, 0, z - r[3]);
    best = Math.min(best, Math.hypot(dx, dz));
  }
  return best;
}

export function inspect(frame: Frame, frontEdge = -1): SiteReport {
  const rect = frameRect(frame, PAD.x0, PAD.z0, PAD.x1, PAD.z1);
  const [x0, z0, x1, z1] = rect;
  let reject: string | null = null;
  // water / decks
  let water = 0, decks = 0;
  for (let z = Math.floor(z0); z < z1; z++) for (let x = Math.floor(x0); x < x1; x++) {
    const t = tiles.get(Math.floor(x / TILE), Math.floor(z / TILE));
    if (!t) { water++; continue; }
    if (t.water(x, z)) water++;
    if (t.deck[t.idx(x, z)]) decks++;
  }
  if (water) reject = `water ${water}`;
  else if (decks) reject = `bridge deck ${decks}`;
  // car roads / rail through the pad
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  for (const e of graph.edgesNear(cx, cz, 40)) {
    const cls = graph.eCls[e];
    if (!isCarRoad(cls) && !isRail(cls)) continue;
    if (e === frontEdge) continue;
    const p0 = graph.eP0[e], n = graph.eN[e], hw = graph.eWidth[e] / 2;
    for (let k = 0; k + 1 < n; k++) {
      const d = segRectDist(graph.px[p0 + k], graph.pz[p0 + k], graph.px[p0 + k + 1], graph.pz[p0 + k + 1], rect);
      if (d < hw - 0.3) { reject ??= `${isRail(cls) ? 'rail' : 'road'} ${graph.name(e) || '(unnamed)'} cls ${cls}`; break; }
    }
  }
  // buildings removed (bbox rule, same as the generator)
  const seen = new Set<number>();
  const removed: SiteReport['removed'] = [];
  let cost = 0;
  for (let tz = Math.floor(z0 / TILE); tz <= Math.floor(z1 / TILE); tz++) for (let tx = Math.floor(x0 / TILE); tx <= Math.floor(x1 / TILE); tx++) {
    const t = tiles.get(tx, tz); if (!t) continue;
    for (const b of t.t.buildings) {
      const [bx0, bz0, bx1, bz1] = b.bbox;
      if (bx1 <= x0 || bx0 >= x1 || bz1 <= z0 || bz0 >= z1) continue;
      if (seen.has(b.seed)) continue; seen.add(b.seed);
      const area = (bx1 - bx0) * (bz1 - bz0);
      const syn = (b.flags & BF.SYNTHETIC) !== 0;
      removed.push({ name: b.name, h: Math.round(b.height), area, synthetic: syn });
      cost += syn ? area * 0.002 : area * Math.max(4, b.height) * 0.0006 + 2;
    }
  }
  const [lon, lat] = worldToLonLat(frame.ox, frame.oz);
  void lon; void lat;
  return { frame, rect, street: '', offAngle: 0, removed, cost, reject, district: districtAt(frame.ox, frame.oz).name, curb: [0, 0] };
}

/** candidate frames along streets near (x,z) */
export function search(x: number, z: number, radius: number, name?: RegExp): SiteReport[] {
  const out: SiteReport[] = [];
  const pt = { x: 0, z: 0, tx: 0, tz: 0, deck: 0 };
  for (const e of graph.edgesNear(x, z, radius, (e) => graph.isCar(e))) {
    if (name && !name.test(graph.name(e))) continue;
    if (graph.eCls[e] >= 8) continue; // skip service/track-ish
    const L = graph.eLen[e];
    for (let s = 4; s < L - 4; s += 4) {
      graph.pointAt(e, s, pt);
      if (Math.hypot(pt.x - x, pt.z - z) > radius) continue;
      if (pt.deck > 0.5) continue;
      const ang = Math.atan2(pt.tz, pt.tx); // 0 = east
      // nearest cardinal
      const q = Math.round(ang / (Math.PI / 2));
      const off = ang - q * (Math.PI / 2);
      if (Math.abs(off) > (8 * Math.PI) / 180) continue;
      const hw = graph.eWidth[e] / 2 + 0.2;
      for (const side of [-1, 1]) {
        // normal to the right of travel (x east, z south): (−tz, tx)
        const nx = -pt.tz * side, nz = pt.tx * side;
        // building lies along +n; its front faces −n
        const fx = -Math.round(nx), fz = -Math.round(nz);
        const rot: Rot = fz === -1 ? 0 : fx === 1 ? 1 : fz === 1 ? 2 : 3;
        const curbX = pt.x + nx * hw, curbZ = pt.z + nz * hw;
        const back = 20.5 + 19 * Math.abs(Math.tan(off)) + 0.5;
        const frame: Frame = { ox: Math.round(curbX - fx * back), oz: Math.round(curbZ - fz * back), rot };
        const r = inspect(frame, e);
        r.street = graph.name(e) || '(unnamed)'; r.offAngle = (off * 180) / Math.PI; r.curb = [curbX, curbZ];
        out.push(r);
      }
    }
  }
  return out.filter((r) => !r.reject).sort((a, b) => a.cost - b.cost);
}

function fmt(r: SiteReport) {
  const [lon, lat] = worldToLonLat(r.frame.ox, r.frame.oz);
  const rem = r.removed.map((b) => `${b.synthetic ? 's' : 'R'}${b.h}m/${b.area}${b.name ? ' ' + b.name : ''}`).join(', ');
  return `frame {ox:${r.frame.ox}, oz:${r.frame.oz}, rot:${r.frame.rot}} lon ${lon.toFixed(6)} lat ${lat.toFixed(6)} | ${r.street} (${r.offAngle.toFixed(1)}°) | ${r.district} | cost ${r.cost.toFixed(1)} | removes ${r.removed.length}: ${rem}${r.reject ? ' | REJECT ' + r.reject : ''}`;
}

if (process.argv[1]?.endsWith('sites.ts')) {
  const a = process.argv.slice(2);
  if (a[0] === '--check') {
    console.log(fmt(inspect({ ox: +a[1], oz: +a[2], rot: +a[3] as Rot })));
  } else {
    const [lon, lat] = [+a[0], +a[1]];
    const radius = +(a[2] ?? 250);
    const re = a[3] && !a[3].startsWith('--') ? new RegExp(a[3], 'i') : undefined;
    const top = +(a.find((s) => s.startsWith('--top='))?.slice(6) ?? 8);
    const [x, z] = lonLatToWorld(lon, lat);
    const rs = search(x, z, radius, re);
    // de-duplicate near-identical frames
    const keep: SiteReport[] = [];
    const avoid = (a.find((s) => s.startsWith('--avoid='))?.slice(8) ?? '').split(';').filter(Boolean).map((q) => q.split(',').map(Number));
    for (const r of rs) if (!avoid.some(([ax, az]) => Math.abs(ax - r.frame.ox) < 49 && Math.abs(az - r.frame.oz) < 49) &&!keep.some((k) => k.frame.rot === r.frame.rot && Math.hypot(k.frame.ox - r.frame.ox, k.frame.oz - r.frame.oz) < 20)) { keep.push(r); if (keep.length >= top) break; }
    console.log(`target ${x.toFixed(0)},${z.toFixed(0)} — ${rs.length} valid candidates`);
    for (const r of keep) console.log(fmt(r));
  }
}

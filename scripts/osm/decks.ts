/**
 * Bridge deck profiles (shared by build.ts and graph.ts so tiles and the road graph agree).
 * Bridge ways are chained through shared end nodes; each chain gets a clearance target and a
 * ramp profile measured from the chain's free ends by a multi-source shortest path.
 * Writes `deck` (metres above street level, per vertex) onto every bridge road.
 */
import { RC, RF, isRail } from '../../packages/shared/src/world/leonia/format.ts';
import type { Pt } from './geom.ts';

export interface DeckRoad { cls: number; flags: number; layer: number; pts: Pt[]; nodes: number[]; deck?: number[]; name?: string }

let synthNode = -1_000_000_000;
/** insert vertices so a bridge way has one at least every `step` m (the deck profile is sampled at vertices) */
function densify(r: DeckRoad, step: number) {
  const ids = (r as unknown as { ids?: number[] }).ids;
  const alignNodes = r.nodes.length === r.pts.length, alignIds = !!ids && ids.length === r.pts.length;
  const pts: Pt[] = [], nodes: number[] = [], nids: number[] = [];
  for (let k = 0; k < r.pts.length; k++) {
    pts.push(r.pts[k]); if (alignNodes) nodes.push(r.nodes[k]); if (alignIds) nids.push(ids![k]);
    if (k + 1 >= r.pts.length) break;
    const a = r.pts[k], b = r.pts[k + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.floor(L / step);
    for (let q = 1; q <= n; q++) {
      const f = q / (n + 1);
      pts.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
      if (alignNodes) nodes.push(synthNode); if (alignIds) nids.push(synthNode);
      synthNode--;
    }
  }
  r.pts = pts; if (alignNodes) r.nodes = nodes; if (alignIds) (r as unknown as { ids: number[] }).ids = nids;
}

/** Douglas-Peucker over (x, z, deck): a vertex also stays when the deck height deviates from the chord's linear ramp */
export function simplifyDeckIdx(pts: Pt[], deck: number[], eps: number, epsDeck: number): number[] {
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st: [number, number][] = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop()!;
    if (b <= a + 1) continue;
    const [ax, az] = pts[a], [bx, bz] = pts[b];
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
    let bi = -1, bd = 1;
    for (let i = a + 1; i < b; i++) {
      const [px, pz] = pts[i];
      const perp = L < 1e-9 ? Math.hypot(px - ax, pz - az) : Math.abs((px - ax) * dz - (pz - az) * dx) / L;
      const t = L < 1e-9 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (L * L)));
      const dd = Math.abs(deck[i] - (deck[a] + (deck[b] - deck[a]) * t));
      const e = Math.max(perp / eps, dd / epsDeck);
      if (e > bd) { bd = e; bi = i; }
    }
    if (bi >= 0) { keep[bi] = 1; st.push([a, bi], [bi, b]); }
  }
  const out: number[] = []; keep.forEach((k, i) => { if (k) out.push(i); });
  return out;
}

export function computeDecks(roads: DeckRoad[], waterAt: (x: number, z: number) => boolean): { bridges: number; components: number } {
  const bridges = roads.filter((r) => r.flags & RF.BRIDGE);
  for (const r of bridges) densify(r, 9);
  const group = (r: DeckRoad) => (isRail(r.cls) ? 'r' : r.cls >= RC.PEDESTRIAN && r.cls <= RC.TRACK ? 'f' : 'c');
  const parent = bridges.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const byEnd = new Map<string, number[]>();
  bridges.forEach((r, i) => {
    if (!r.nodes.length) return;
    for (const n of [r.nodes[0], r.nodes[r.nodes.length - 1]]) { const k = group(r) + n; const a = byEnd.get(k) ?? []; a.push(i); byEnd.set(k, a); }
  });
  for (const a of byEnd.values()) for (let k = 1; k < a.length; k++) parent[find(a[k])] = find(a[0]);
  // free ends that nearly touch (ways split without a shared node) belong to one chain as well
  const near: [number, number, number, number][] = []; // [wayA, endA, wayB, endB]
  {
    const grid = new Map<string, [number, number][]>();
    const cell = (p: Pt) => `${Math.floor(p[0] / 3)},${Math.floor(p[1] / 3)}`;
    bridges.forEach((r, i) => { for (const e of [0, 1]) { const p = r.pts[e ? r.pts.length - 1 : 0]; const k = cell(p); (grid.get(k) ?? grid.set(k, []).get(k)!).push([i, e]); } });
    bridges.forEach((r, i) => {
      for (const e of [0, 1]) {
        const p = r.pts[e ? r.pts.length - 1 : 0];
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) for (const [j, ej] of grid.get(`${Math.floor(p[0] / 3) + dx},${Math.floor(p[1] / 3) + dz}`) ?? []) {
          if (j <= i || group(bridges[j]) !== group(r)) continue;
          const q = bridges[j].pts[ej ? bridges[j].pts.length - 1 : 0];
          if (Math.hypot(p[0] - q[0], p[1] - q[1]) > 2.5) continue;
          near.push([i, e, j, ej]); parent[find(j)] = find(i);
        }
      }
    });
  }
  const comps = new Map<number, number[]>();
  bridges.forEach((_, i) => { const c = find(i); const a = comps.get(c) ?? []; a.push(i); comps.set(c, a); });
  // endpoint degree among bridge ways (per group)
  const deg = new Map<string, number>();
  for (const [k, a] of byEnd) deg.set(k, a.length);
  const joined = new Set<string>(); // "way:end" of ends joined by proximity
  for (const [i, e, j, ej] of near) { joined.add(`${i}:${e}`); joined.add(`${j}:${ej}`); }
  for (const members of comps.values()) {
    const rs = members.map((i) => bridges[i]);
    const g = group(rs[0]);
    let len = 0, overWater = 0, maxLayer = 1, major = false;
    for (const r of rs) {
      for (let k = 0; k + 1 < r.pts.length; k++) {
        const L = Math.hypot(r.pts[k + 1][0] - r.pts[k][0], r.pts[k + 1][1] - r.pts[k][1]);
        len += L;
        for (let s = 0; s < L; s += 4) { const f = s / L; if (waterAt(r.pts[k][0] + (r.pts[k + 1][0] - r.pts[k][0]) * f, r.pts[k][1] + (r.pts[k + 1][1] - r.pts[k][1]) * f)) overWater += 4; }
      }
      maxLayer = Math.max(maxLayer, r.layer);
      if (r.cls <= RC.SECONDARY) major = true;
    }
    let Hc = g === 'f' ? 4.5 : g === 'r' ? 7.5 : 6 + 4.5 * (maxLayer - 1);
    if (g !== 'f' && overWater > 60) Hc = Math.max(Hc, major ? 12 : 8);
    if (g !== 'f' && overWater > 250 && major) Hc = Math.max(Hc, 15);
    if (g !== 'f' && overWater > 600 && major) Hc = Math.max(Hc, 18); // long high-level crossings (Rickenbacker, Julia Tuttle)
    Hc = Math.min(Hc, 30);
    // the Venetian Causeway is a string of low bascule / fixed spans, not a high-level crossing
    if (g === 'c' && rs.some((r) => /venetian/i.test(r.name ?? ''))) Hc = Math.min(Hc, 6);
    const grade = g === 'f' ? 1 / 7 : 1 / 12;
    // eased ramp (smoothstep, a little longer than the straight-grade ramp so the steepest part stays near `grade`)
    const Lr = (Hc / grade) * 1.4;
    // multi-source Dijkstra (simple, components are small) over vertices keyed by node id or coord
    const vkey = (r: DeckRoad, k: number) => (r.nodes.length === r.pts.length ? 'n' + r.nodes[k] : `p${r.pts[k][0].toFixed(1)},${r.pts[k][1].toFixed(1)}`);
    const adj = new Map<string, [string, number][]>();
    const link = (a: string, b: string, L: number) => { (adj.get(a) ?? adj.set(a, []).get(a)!).push([b, L]); (adj.get(b) ?? adj.set(b, []).get(b)!).push([a, L]); };
    const terms: string[] = [];
    members.forEach((bi) => {
      const r = bridges[bi];
      for (let k = 0; k + 1 < r.pts.length; k++) link(vkey(r, k), vkey(r, k + 1), Math.hypot(r.pts[k + 1][0] - r.pts[k][0], r.pts[k + 1][1] - r.pts[k][1]));
      for (const e of [0, 1]) {
        const k = e ? r.pts.length - 1 : 0;
        if (joined.has(`${bi}:${e}`)) continue;
        if (!r.nodes.length || (deg.get(g + r.nodes[k]) ?? 1) <= 1) terms.push(vkey(r, k));
      }
    });
    for (const [i, e, j, ej] of near) if (members.includes(i)) link(vkey(bridges[i], e ? bridges[i].pts.length - 1 : 0), vkey(bridges[j], ej ? bridges[j].pts.length - 1 : 0), 0.5);
    if (!terms.length) for (const r of rs) terms.push(vkey(r, 0));
    const dist = new Map<string, number>();
    const q: [string, number][] = terms.map((t) => [t, 0]);
    while (q.length) {
      let bi = 0; for (let i = 1; i < q.length; i++) if (q[i][1] < q[bi][1]) bi = i;
      const [v, d] = q.splice(bi, 1)[0];
      if (dist.has(v)) continue;
      dist.set(v, d);
      for (const [u, L] of adj.get(v) ?? []) if (!dist.has(u)) q.push([u, d + L]);
    }
    for (const r of rs) r.deck = r.pts.map((_, k) => { const t = Math.min(1, (dist.get(vkey(r, k)) ?? 0) / Lr); return Hc * t * t * (3 - 2 * t); });
    void len;
  }
  return { bridges: bridges.length, components: comps.size };
}

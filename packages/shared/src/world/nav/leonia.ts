/**
 * LeoniaNav: navigation on the real OSM road graph (graph.ts) plus the tile rasters
 * (land use, surface cover, water, buildings) for walkability and zones.
 * Lanes: right-hand traffic; two-way roads split their lanes per direction, oneway roads
 * spread all lanes across the carriageway. Heights: feet y = 22 + deck profile.
 */
import type { ZoneKind } from '../mapTypes.ts';
import { AK, RC, RF, isCarRoad } from '../leonia/format.ts';
import { TILE } from '../leonia/format.ts';
import { SEG, SF_DRIVEWAY, type LeoniaTiles, type TileRaster } from '../leonia/tiles.ts';
import { districtAt, type DistrictStyle } from '../leonia/districts.ts';
import { RoadGraph, GF, type EdgePoint } from './graph.ts';
import { yawOf, type LaneSpot, type NavPoint, type NavVoxels, type PursuitState, type WalkKind, type WalkSpot, type WorldNav } from './types.ts';

const STYLE_ZONE: Record<DistrictStyle, ZoneKind> = {
  downtown: 'downtown', brickell: 'downtown', edgewater: 'urban', wynwood: 'urban', design: 'urban', havana: 'urban', north: 'urban',
  gables: 'suburb', grove: 'suburb', suburb: 'suburb', keys: 'resort', sobe: 'resort', beach: 'resort',
  port: 'industrial', industrial: 'industrial', airport: 'airport', nature: 'forest',
};
const PARKISH = new Set<number>([AK.PARK, AK.GARDEN, AK.GRASS, AK.PLAYGROUND, AK.DOG_PARK, AK.CAMPUS_GREEN, AK.CEMETERY, AK.GOLF_ROUGH, AK.NATURE, AK.PITCH, AK.ZOO, AK.FOREST, AK.SCRUB]);
const BEACHY = new Set<number>([AK.BEACH, AK.SAND]);
const PIERISH = new Set<number>([AK.PIER, AK.BREAKWATER, AK.MARINA]);
/** walking offset from the carriageway edge to the sidewalk line (sidewalk is 2.5 m wide; trees/lamps sit at 1.9 m) */
export const SIDEWALK_LINE = 1.0;

export class LeoniaNav implements WorldNav {
  readonly world = 'leonia' as const;
  readonly width: number; readonly depth: number;
  private tmp: EdgePoint = { x: 0, z: 0, tx: 0, tz: 0, deck: 0 };
  private carOk = (e: number) => this.graph.isCar(e) && !(this.graph.eFlags[e] & GF.PRIVATE);

  constructor(readonly graph: RoadGraph, readonly tiles: LeoniaTiles, readonly vox: NavVoxels | null) {
    this.width = graph.width; this.depth = graph.depth;
  }

  private tile(x: number, z: number): TileRaster | null {
    return this.tiles.get(Math.floor(x / TILE), Math.floor(z / TILE)) ?? null;
  }

  inBounds(x: number, z: number) { return x >= 0 && z >= 0 && x < this.width && z < this.depth; }
  isWater(x: number, z: number) {
    if (!this.inBounds(x, z)) return true;
    const t = this.tile(x, z);
    return t ? t.water(Math.floor(x), Math.floor(z)) : true;
  }
  /** carriageway cell (same rule the generator paints asphalt with) */
  isRoad(x: number, z: number): boolean {
    const t = this.tile(x, z);
    if (!t) return false;
    const bx = Math.floor(x), bz = Math.floor(z);
    const i = t.idx(bx, bz), id = t.road[i];
    if (!id || !isCarRoad(t.segCls[id])) return false;
    return t.distTo(id, bx + 0.5, bz + 0.5) <= t.segs[(id - 1) * SEG.N + 5];
  }
  isStreet(x: number, z: number) { return !!this.graph.nearest(x, z, 6, this.carOk); }
  zoneAt(x: number, z: number): ZoneKind {
    let zone = STYLE_ZONE[districtAt(x, z).style] ?? 'suburb';
    const t = this.tile(x, z);
    if (t) {
      const i = t.idx(Math.floor(x), Math.floor(z));
      const lu = t.lu[i], sf = t.sf[i];
      if (sf === AK.WETLAND) zone = 'wetland';
      else if (sf === AK.FOREST || sf === AK.NATURE || sf === AK.SCRUB) zone = 'forest';
      else if (lu === AK.FARMLAND) zone = 'farmland';
      else if (lu === AK.INDUSTRIAL || lu === AK.PORT) zone = 'industrial';
      else if (lu === AK.AERODROME) zone = 'airport';
      else if ((lu === AK.COMMERCIAL || lu === AK.RETAIL) && zone === 'suburb') zone = 'urban';
    }
    return zone;
  }
  coastDist(x: number, z: number): number {
    const w = this.isWater(x, z);
    for (const r of [2, 4, 7, 11, 16, 24, 34]) {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        if (this.isWater(x + Math.cos(a) * r, z + Math.sin(a) * r) !== w) return w ? -r : r;
      }
    }
    return w ? -40 : 40;
  }
  groundTop() { return 21; }
  surfaceY(x: number, z: number) { return this.isWater(x, z) ? 21 : 22; }

  // ───────────────────────────────────────────────────────── lanes
  /** lane position on edge e travelled in dir, `s` from the travel start */
  laneSpot(e: number, dir: 1 | -1, s: number, lane: number): LaneSpot {
    const g = this.graph, L = g.eLen[e];
    const p = g.pointAt(e, dir > 0 ? s : L - s, this.tmp);
    const fx = p.tx * dir, fz = p.tz * dir;
    const off = g.laneOffset(e, lane);
    return { x: p.x - fz * off, y: 22 + p.deck, z: p.z + fx * off, yaw: yawOf(fx, fz), edge: e, dir, s, lane, offset: off, speed: g.eSpeed[e], cls: g.eCls[e] };
  }
  nearestRoad(x: number, z: number, maxDist = 60): LaneSpot | null {
    const g = this.graph;
    const h = g.nearest(x, z, maxDist, this.carOk);
    if (!h) return null;
    const dir: 1 | -1 = g.eFlags[h.e] & GF.ONEWAY || h.side >= 0 ? 1 : -1;
    return this.laneSpot(h.e, dir, dir > 0 ? h.s : g.eLen[h.e] - h.s, g.lanesDir(h.e) - 1);
  }
  randomLaneNear(x: number, z: number, rMin: number, rMax: number, opt: { minClass?: number; maxClass?: number; toward?: NavPoint; noBridge?: boolean } = {}): LaneSpot | null {
    const g = this.graph;
    const lo = opt.minClass ?? RC.MOTORWAY, hi = opt.maxClass ?? RC.SERVICE;
    const ok = (e: number) => this.carOk(e) && g.eCls[e] >= lo && g.eCls[e] <= hi && g.eLen[e] > 8 && !(opt.noBridge && g.eFlags[e] & GF.BRIDGE);
    for (let tries = 0; tries < 10; tries++) {
      const ang = Math.random() * Math.PI * 2, d = rMin + Math.random() * (rMax - rMin);
      const h = g.nearest(x + Math.cos(ang) * d, z + Math.sin(ang) * d, 30, ok);
      if (!h) continue;
      const c = g.eCls[h.e];
      if (c === RC.SERVICE && Math.random() < 0.85) continue; // parking lots, alleys: rare
      const dd = Math.hypot(h.x - x, h.z - z);
      if (dd < rMin * 0.8 || dd > rMax * 1.15) continue;
      const L = g.eLen[h.e];
      const sa = Math.max(3, Math.min(L - 3, h.s));
      let dir: 1 | -1 = g.eFlags[h.e] & GF.ONEWAY ? 1 : Math.random() < 0.5 ? 1 : -1;
      if (opt.toward && !(g.eFlags[h.e] & GF.ONEWAY)) {
        const p = g.pointAt(h.e, sa, this.tmp);
        dir = (opt.toward.x - p.x) * p.tx + (opt.toward.z - p.z) * p.tz >= 0 ? 1 : -1;
      }
      const lane = Math.floor(Math.random() * g.lanesDir(h.e));
      return this.laneSpot(h.e, dir, dir > 0 ? sa : L - sa, lane);
    }
    return null;
  }

  /** unit travel direction leaving node n along (e, dir), measured over the first few metres */
  private leaveDir(e: number, dir: 1 | -1): [number, number] {
    const g = this.graph, L = g.eLen[e];
    const n = g.startNode(e, dir);
    const p = g.pointAt(e, dir > 0 ? Math.min(L, 6) : Math.max(0, L - 6), this.tmp);
    const dx = p.x - g.nodeX[n], dz = p.z - g.nodeZ[n], l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  }
  /** unit travel direction arriving at the end node of (e, dir) */
  arriveDir(e: number, dir: 1 | -1): [number, number] {
    const g = this.graph, L = g.eLen[e];
    const n = g.endNode(e, dir);
    const p = g.pointAt(e, dir > 0 ? Math.max(0, L - 6) : Math.min(L, 6), this.tmp);
    const dx = g.nodeX[n] - p.x, dz = g.nodeZ[n] - p.z, l = Math.hypot(dx, dz) || 1;
    return [dx / l, dz / l];
  }
  /** turn angle (rad, 0 = straight) from (e1,d1) into (e2,d2) */
  turnAngle(e1: number, d1: 1 | -1, e2: number, d2: 1 | -1): number {
    const [ax, az] = this.arriveDir(e1, d1), [bx, bz] = this.leaveDir(e2, d2);
    return Math.acos(Math.max(-1, Math.min(1, ax * bx + az * bz)));
  }
  nextEdge(edge: number, dir: 1 | -1, toward?: NavPoint): { edge: number; dir: 1 | -1 } | null {
    const g = this.graph;
    const n = g.endNode(edge, dir);
    const fromCls = g.eCls[edge];
    const opts: { edge: number; dir: 1 | -1; w: number }[] = [];
    let uturn: { edge: number; dir: 1 | -1 } | null = null;
    for (let k = g.adjStart[n]; k < g.adjStart[n + 1]; k++) {
      const e2 = g.adjE[k], d2 = g.adjD[k] as 1 | -1;
      if (!g.canDrive(e2, d2)) continue;
      if (e2 === edge && d2 === -dir) { uturn = { edge: e2, dir: d2 }; continue; }
      if (g.eA[e2] === g.eB[e2] && g.eLen[e2] < 4) continue;
      const ang = this.turnAngle(edge, dir, e2, d2);
      let w = ang < 0.35 ? 6 : ang < 1.25 ? 2.2 : ang < 2.3 ? 1.4 : 0.25;
      const c = g.eCls[e2];
      if (c === RC.SERVICE && fromCls !== RC.SERVICE) w *= 0.1;
      if (g.eFlags[e2] & GF.PRIVATE) w *= 0.02;
      if (c < fromCls) w *= 1.3; // drift toward bigger roads
      if (toward) {
        const [bx, bz] = this.leaveDir(e2, d2);
        const tx = toward.x - g.nodeX[n], tz = toward.z - g.nodeZ[n], tl = Math.hypot(tx, tz) || 1;
        w *= Math.exp(((bx * tx + bz * tz) / tl) * 2);
      }
      opts.push({ edge: e2, dir: d2, w });
    }
    if (!opts.length) return uturn;
    let r = Math.random() * opts.reduce((s, o) => s + o.w, 0);
    for (const o of opts) { r -= o.w; if (r <= 0) return { edge: o.edge, dir: o.dir }; }
    return opts[0];
  }

  // ───────────────────────────────────────────────────────── routing
  route(ax: number, az: number, bx: number, bz: number): NavPoint[] | null {
    const g = this.graph;
    const ha = g.nearest(ax, az, 80, this.carOk), hb = g.nearest(bx, bz, 140, this.carOk);
    if (!ha || !hb) return null;
    const out: NavPoint[] = [{ x: ha.x, z: ha.z }];
    if (ha.e === hb.e) {
      const pts = g.polyline(ha.e, hb.s >= ha.s ? 1 : -1);
      const lo = Math.min(ha.s, hb.s), hi = Math.max(ha.s, hb.s);
      const p0 = g.eP0[ha.e];
      const mid = pts.filter((_, k) => { const c = g.pcum[hb.s >= ha.s ? p0 + k : p0 + g.eN[ha.e] - 1 - k]; return c > lo && c < hi; });
      return [...out, ...mid, { x: hb.x, z: hb.z }];
    }
    const near = (e: number, x: number, z: number) => {
      const a = g.eA[e], b = g.eB[e];
      return Math.hypot(g.nodeX[a] - x, g.nodeZ[a] - z) <= Math.hypot(g.nodeX[b] - x, g.nodeZ[b] - z) ? a : b;
    };
    const src = g.eFlags[ha.e] & GF.ONEWAY ? g.eB[ha.e] : near(ha.e, bx, bz);
    const dst = g.eFlags[hb.e] & GF.ONEWAY ? g.eA[hb.e] : near(hb.e, ax, az);
    const r = g.route(src, dst, { car: true, oneway: 'penalty', maxExpand: 30000, edgeCost: (e) => (g.eFlags[e] & GF.PRIVATE ? Infinity : 1) });
    if (!r) return null;
    // partial start edge → src
    const partial = (e: number, s: number, toNode: number, rev: boolean) => {
      const pts: NavPoint[] = [];
      const p0 = g.eP0[e], n = g.eN[e];
      const towardB = toNode === g.eB[e];
      for (let k = 0; k < n; k++) {
        const p = p0 + k, c = g.pcum[p];
        if (towardB ? c > s : c < s) pts.push({ x: g.px[p], z: g.pz[p] });
      }
      if (!towardB) pts.reverse();
      return rev ? pts.reverse() : pts;
    };
    out.push(...partial(ha.e, ha.s, src, false));
    for (let k = 0; k < r.edges.length; k++) { const pl = g.polyline(r.edges[k], r.dirs[k]); out.push(...pl.slice(1)); }
    out.push(...partial(hb.e, hb.s, dst, true));
    out.push({ x: hb.x, z: hb.z });
    // drop duplicates
    const clean: NavPoint[] = [];
    for (const p of out) { const l = clean[clean.length - 1]; if (!l || Math.hypot(l.x - p.x, l.z - p.z) > 0.5) clean.push(p); }
    return clean;
  }
  /**
   * Pure-pursuit along an A* route: re-planned when the goal moves > 25 m, every 6 s, or when the
   * vehicle strays > 20 m from the route; aims ~11 m ahead of the projection on the route and
   * advises a speed for the sharpest bend in the next 30 m.
   */
  pursuitWaypoint(st: PursuitState, x: number, z: number, gx: number, gz: number, now: number): NavPoint & { vmax?: number } {
    if (Math.hypot(gx - x, gz - z) < 18) return { x: gx, z: gz, vmax: 12 };
    const stale = !st.pts || !st.goal || Math.hypot(st.goal.x - gx, st.goal.z - gz) > 25 || now - (st.at ?? 0) > 6000;
    if (stale && (!st.pts || now - (st.at ?? 0) >= 700)) {
      const pts = this.route(x, z, gx, gz);
      st.at = now; st.goal = { x: gx, z: gz };
      if (!pts || pts.length < 2) { st.pts = undefined; st.fails = (st.fails ?? 0) + 1; return { x: gx, z: gz }; }
      const cum = [0];
      for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z));
      st.pts = pts; st.cum = cum; st.i = 0; st.fails = 0;
    }
    const pts = st.pts, cum = st.cum;
    if (!pts || !cum || pts.length < 2) return { x: gx, z: gz };
    // project onto the route (window around the last segment)
    let bj = st.i ?? 0, bt = 0, bd = Infinity;
    for (let j = Math.max(0, (st.i ?? 0) - 1); j < Math.min(pts.length - 1, (st.i ?? 0) + 14); j++) {
      const ax = pts[j].x, az = pts[j].z, dx = pts[j + 1].x - ax, dz = pts[j + 1].z - az, L2 = dx * dx + dz * dz || 1e-9;
      let t = ((x - ax) * dx + (z - az) * dz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(x - ax - dx * t, z - az - dz * t);
      if (d < bd) { bd = d; bj = j; bt = t; }
    }
    st.i = bj;
    if (bd > 20) st.at = 0; // strayed: re-plan
    const along = cum[bj] + bt * (cum[bj + 1] - cum[bj]);
    st.along = along;
    const total = cum[cum.length - 1];
    const at = (s: number): NavPoint => {
      s = Math.min(total, Math.max(0, s));
      let j = bj; while (j < pts.length - 2 && cum[j + 1] < s) j++;
      const f = (s - cum[j]) / Math.max(1e-6, cum[j + 1] - cum[j]);
      return { x: pts[j].x + (pts[j + 1].x - pts[j].x) * f, z: pts[j].z + (pts[j + 1].z - pts[j].z) * f };
    };
    const tgt = at(along + 11);
    // sharpest heading change within the next 30 m
    let maxTurn = 0;
    const h0 = Math.atan2(pts[bj + 1].z - pts[bj].z, pts[bj + 1].x - pts[bj].x);
    for (let j = bj + 1; j < pts.length - 1 && cum[j] < along + 30; j++) {
      if (cum[j + 1] - cum[j] < 0.5) continue;
      let dh = Math.abs(Math.atan2(pts[j + 1].z - pts[j].z, pts[j + 1].x - pts[j].x) - h0);
      if (dh > Math.PI) dh = Math.PI * 2 - dh;
      maxTurn = Math.max(maxTurn, dh);
    }
    let vmax = maxTurn > 1.2 ? 9 : maxTurn > 0.6 ? 14 : maxTurn > 0.3 ? 20 : 30;
    if (total - along < 25) vmax = Math.min(vmax, 12);
    return { x: tgt.x, z: tgt.z, vmax };
  }

  deliverySpot(x: number, z: number): { x: number; z: number; yaw: number; y?: number } {
    const g = this.graph;
    const h = g.nearest(x, z, 80, (e) => this.carOk(e) && g.eCls[e] >= RC.PRIMARY && g.eCls[e] !== RC.SERVICE && !(g.eFlags[e] & GF.BRIDGE)) ?? g.nearest(x, z, 80, this.carOk);
    if (!h) return { x: x + 4, z, yaw: 0 };
    const side = h.side >= 0 ? 1 : -1;
    const dir: 1 | -1 = side > 0 ? 1 : -1;
    const L = g.eLen[h.e];
    const s = Math.max(Math.min(2, L / 2), Math.min(L - Math.min(2, L / 2), h.s + 6 * dir));
    const p = g.pointAt(h.e, s, this.tmp);
    const off = Math.max(1.2, g.eWidth[h.e] / 2 - 1.3) * side;
    return { x: p.x - p.tz * off, z: p.z + p.tx * off, yaw: yawOf(p.tx * dir, p.tz * dir), y: 22 + p.deck };
  }
  boatSpot(x: number, z: number): { x: number; z: number; yaw: number } | null {
    const open = (px: number, pz: number) => {
      if (!this.isWater(px, pz)) return false;
      for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2; if (!this.isWater(px + Math.cos(a) * 6, pz + Math.sin(a) * 6)) return false; }
      return true;
    };
    for (let r = 0; r <= 600; r += 8) {
      const n = Math.max(1, Math.round((r * Math.PI * 2) / 10));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2, px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
        if (open(px, pz)) return { x: px, z: pz, yaw: yawOf(-Math.cos(a), -Math.sin(a)) };
      }
    }
    return null;
  }

  // ───────────────────────────────────────────────────────── walking
  walkKindAt(x: number, z: number): WalkKind | null {
    const t = this.tile(x, z);
    if (!t) return null;
    const bx = Math.floor(x), bz = Math.floor(z);
    const i = t.idx(bx, bz);
    const sf = t.sf[i];
    if (t.water(bx, bz)) return PIERISH.has(sf) ? 'pier' : null;
    if (t.bld[i]) return null;
    const id = t.road[i];
    if (id) {
      const c = t.segCls[id], d = t.distTo(id, bx + 0.5, bz + 0.5), hw = t.segs[(id - 1) * SEG.N + 5];
      if (isCarRoad(c)) { if (d <= hw) return null; if (t.segFlags[id] & RF.SIDEWALK && d <= hw + 2.5) return 'sidewalk'; }
      else if (c === RC.PIER && d <= hw) return 'pier';
      else if (c >= RC.PEDESTRIAN && c <= RC.TRACK && d <= hw) return 'footway';
      else if (c >= 30 && d <= hw + 1) return null; // rail
    }
    if (BEACHY.has(sf)) return 'beach';
    if (PARKISH.has(sf)) return 'park';
    if (sf === AK.PLAZA) return 'plaza';
    if (PIERISH.has(sf)) return 'pier';
    if (sf === AK.RUNWAY || sf === AK.APRON || t.lu[i] === AK.AERODROME || t.lu[i] === AK.RAILWAY || t.lu[i] === AK.MILITARY) return null;
    if (sf === SF_DRIVEWAY || t.lu[i] === AK.RESIDENTIAL) return 'yard';
    return 'open';
  }
  randomWalkSpot(x: number, z: number, rMin: number, rMax: number): WalkSpot | null {
    const g = this.graph;
    const ang = Math.random() * Math.PI * 2, d = rMin + Math.sqrt(Math.random()) * (rMax - rMin);
    const px = x + Math.cos(ang) * d, pz = z + Math.sin(ang) * d;
    if (!this.inBounds(px, pz)) return null;
    if (Math.random() < 0.7) {
      const h = g.nearest(px, pz, 25, (e) => (g.isCar(e) && (g.eFlags[e] & GF.SIDEWALK) !== 0) || (!g.isCar(e) && g.eCls[e] !== RC.STEPS));
      if (h) {
        if (g.isCar(h.e)) {
          const side = h.side >= 0 ? 1 : -1;
          const p = g.pointAt(h.e, h.s, this.tmp);
          const off = (g.eWidth[h.e] / 2 + SIDEWALK_LINE) * side;
          return { x: p.x - p.tz * off, z: p.z + p.tx * off, kind: 'sidewalk', edge: h.e, s: h.s, side };
        }
        return { x: h.x, z: h.z, kind: g.eFlags[h.e] & GF.PIER ? 'pier' : 'footway', edge: h.e, s: h.s, side: 0 };
      }
    }
    const k = this.walkKindAt(px, pz);
    if (k === 'park' || k === 'beach' || k === 'plaza' || k === 'pier') return { x: px, z: pz, kind: k };
    return null;
  }
  /** sidewalk / footway walking line point on edge e at arc length s (from a) */
  walkPoint(e: number, s: number, side: number): { x: number; z: number; y: number; tx: number; tz: number } {
    const g = this.graph;
    const p = g.pointAt(e, s, this.tmp);
    const off = side ? (g.eWidth[e] / 2 + SIDEWALK_LINE) * side : 0;
    return { x: p.x - p.tz * off, z: p.z + p.tx * off, y: 22 + Math.round(p.deck), tx: p.tx, tz: p.tz };
  }
  /** can a pedestrian walk along edge e (sidewalk or footway) */
  walkable(e: number) { const g = this.graph; return g.isCar(e) ? (g.eFlags[e] & GF.SIDEWALK) !== 0 : true; }
}

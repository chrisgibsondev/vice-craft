/**
 * Road graph for real-data worlds (Leonia): nodes at junctions / way ends, edges = road or
 * footway polylines between them. Built by scripts/osm/graph.ts into `graph.bin` next to
 * the tiles; decoded once on the server (and optionally the client for GPS).
 *
 *   magic "LEOG"  u8 version
 *   nodes   : varint n, per node zz dx dm, zz dz dm (delta from previous node), u8 flags
 *   strings : varint n, each varint byteLen + utf8
 *   edges   : varint n, per edge zz (a - previous a), zz (b - a), u8 class, u8 lanes, varint width dm,
 *             u8 flags (GF), u8 layer+8, u8 speed km/h, varint name+1, varint nInterior,
 *             interior points as zz deltas (dm) from the previous point (starting at node a),
 *             if flags & BRIDGE: per point (n+2) varint deck height dm
 *
 * Geometry is the OSM way split at shared nodes, simplified at 0.5 m, stored at 0.1 m.
 * Oneway edges always run a → b (oneway=-1 ways are reversed by the builder). Deck heights
 * are metres above street level (feet y = 22 + deck), the same profile the tiles carry.
 */
import { RC, isCarRoad, Writer } from '../leonia/format.ts';

export const GRAPH_MAGIC = 0x474f454c; // 'LEOG'
export const GRAPH_VERSION = 1;

/** edge flags */
export const GF = { ONEWAY: 1, BRIDGE: 2, LINK: 4, SIDEWALK: 8, PRIVATE: 16, ROUNDABOUT: 32, PIER: 64 } as const;
/** node flags */
export const GN = { SIGNAL: 1, DEADEND: 2 } as const;

export interface GraphEdgeIn {
  a: number; b: number; cls: number; lanes: number; width: number; flags: number; layer: number; speedKmh: number; name: string;
  /** full polyline incl. both end nodes, metres */
  pts: [number, number][];
  deck: number[] | null;
}

export function encodeGraph(nodes: { x: number; z: number; flags: number }[], edges: GraphEdgeIn[]): Uint8Array {
  const w = new Writer();
  w.u8(GRAPH_MAGIC & 255); w.u8((GRAPH_MAGIC >> 8) & 255); w.u8((GRAPH_MAGIC >> 16) & 255); w.u8((GRAPH_MAGIC >>> 24) & 255);
  w.u8(GRAPH_VERSION);
  w.v(nodes.length);
  let px = 0, pz = 0;
  for (const n of nodes) {
    const x = Math.round(n.x * 10), z = Math.round(n.z * 10);
    w.zz(x - px); w.zz(z - pz); w.u8(n.flags);
    px = x; pz = z;
  }
  const strings: string[] = []; const sIdx = new Map<string, number>();
  const str = (s: string) => { if (!s) return 0; let i = sIdx.get(s); if (i === undefined) { i = strings.length; strings.push(s); sIdx.set(s, i); } return i + 1; };
  for (const e of edges) str(e.name);
  const te = new TextEncoder();
  w.v(strings.length); for (const s of strings) { const b = te.encode(s); w.v(b.length); w.bytes(b); }
  w.v(edges.length);
  let pa = 0;
  for (const e of edges) {
    w.zz(e.a - pa); w.zz(e.b - e.a); pa = e.a; w.u8(e.cls); w.u8(e.lanes); w.v(e.width * 10); w.u8(e.flags); w.u8(e.layer + 8); w.u8(Math.min(255, Math.round(e.speedKmh))); w.v(str(e.name));
    const n = e.pts.length - 2;
    w.v(n);
    let qx = Math.round(nodes[e.a].x * 10), qz = Math.round(nodes[e.a].z * 10);
    for (let k = 1; k <= n; k++) { const x = Math.round(e.pts[k][0] * 10), z = Math.round(e.pts[k][1] * 10); w.zz(x - qx); w.zz(z - qz); qx = x; qz = z; }
    if (e.flags & GF.BRIDGE) for (let k = 0; k < e.pts.length; k++) w.v((e.deck?.[k] ?? 0) * 10);
  }
  return w.done();
}

class R {
  o = 0;
  constructor(readonly b: Uint8Array) {}
  u8() { return this.b[this.o++]; }
  v(): number { let r = 0, s = 1, c: number; do { c = this.b[this.o++]; r += (c & 0x7f) * s; s *= 128; } while (c & 0x80); return r; }
  zz(): number { const u = this.v(); return u % 2 ? -(u + 1) / 2 : u / 2; }
}

/** min-heap on a Float64 key (A*) */
class Heap {
  k: number[] = []; v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, val: number) {
    const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = val;
  }
  pop(): number {
    const k = this.k, v = this.v; const top = v[0]; const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      let i = 0; const n = k.length;
      for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && k[c + 1] < k[c]) c++; if (k[c] >= lk) break; k[i] = k[c]; v[i] = v[c]; i = c; }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

export interface EdgeHit { e: number; s: number; d: number; x: number; z: number; /** signed lateral offset (+ = right of the edge's a→b direction) */ side: number }
export interface EdgePoint { x: number; z: number; tx: number; tz: number; deck: number }

/** cell size of the spatial segment index (m) */
const CELL = 32;

export class RoadGraph {
  readonly nNodes: number; readonly nEdges: number;
  readonly nodeX: Float32Array; readonly nodeZ: Float32Array; readonly nodeFlags: Uint8Array;
  readonly eA: Uint32Array; readonly eB: Uint32Array;
  readonly eCls: Uint8Array; readonly eLanes: Uint8Array; readonly eWidth: Float32Array; readonly eFlags: Uint8Array; readonly eLayer: Int8Array;
  /** m/s */
  readonly eSpeed: Float32Array; readonly eName: Uint32Array;
  readonly eP0: Uint32Array; readonly eN: Uint32Array; readonly eLen: Float32Array;
  readonly px: Float32Array; readonly pz: Float32Array; readonly pcum: Float32Array; readonly pdeck: Float32Array;
  readonly ptEdge: Uint32Array;
  readonly strings: string[];
  /** adjacency (all edges, both directions): CSR by node; adjE = edge, adjD = +1 leaving from a, -1 leaving from b */
  readonly adjStart: Uint32Array; readonly adjE: Uint32Array; readonly adjD: Int8Array;
  /** spatial index: per cell, list of segment start point indices */
  private readonly gw: number; private readonly gh: number;
  private readonly cellStart: Uint32Array; private readonly cellSeg: Uint32Array;
  readonly bytes: number; readonly loadMs: number;

  constructor(buf: Uint8Array, readonly width: number, readonly depth: number) {
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.bytes = buf.length;
    const r = new R(buf);
    const magic = buf[0] | (buf[1] << 8) | (buf[2] << 16) | (buf[3] << 24);
    if (magic !== GRAPH_MAGIC) throw new Error('bad road graph magic');
    r.o = 4;
    if (r.u8() !== GRAPH_VERSION) throw new Error('unsupported road graph version');
    const nN = r.v();
    this.nNodes = nN;
    this.nodeX = new Float32Array(nN); this.nodeZ = new Float32Array(nN); this.nodeFlags = new Uint8Array(nN);
    let qx = 0, qz = 0;
    for (let i = 0; i < nN; i++) { qx += r.zz(); qz += r.zz(); this.nodeX[i] = qx / 10; this.nodeZ[i] = qz / 10; this.nodeFlags[i] = r.u8(); }
    const td = new TextDecoder();
    this.strings = [];
    for (let i = 0, n = r.v(); i < n; i++) { const len = r.v(); this.strings.push(td.decode(buf.subarray(r.o, r.o + len))); r.o += len; }
    const nE = r.v();
    this.nEdges = nE;
    this.eA = new Uint32Array(nE); this.eB = new Uint32Array(nE); this.eCls = new Uint8Array(nE); this.eLanes = new Uint8Array(nE);
    this.eWidth = new Float32Array(nE); this.eFlags = new Uint8Array(nE); this.eLayer = new Int8Array(nE); this.eSpeed = new Float32Array(nE);
    this.eName = new Uint32Array(nE); this.eP0 = new Uint32Array(nE); this.eN = new Uint32Array(nE); this.eLen = new Float32Array(nE);
    // first pass decode into growable arrays
    let cap = nE * 4 + 16;
    let px = new Float32Array(cap), pz = new Float32Array(cap), pd = new Float32Array(cap);
    let np = 0;
    const push = (x: number, z: number) => {
      if (np >= cap) { cap *= 2; const a = new Float32Array(cap); a.set(px); px = a; const b = new Float32Array(cap); b.set(pz); pz = b; const c = new Float32Array(cap); c.set(pd); pd = c; }
      px[np] = x; pz[np] = z; np++;
    };
    let pa = 0;
    for (let e = 0; e < nE; e++) {
      const a = pa + r.zz(), b = a + r.zz(); pa = a;
      this.eA[e] = a; this.eB[e] = b;
      this.eCls[e] = r.u8(); this.eLanes[e] = r.u8(); this.eWidth[e] = r.v() / 10; this.eFlags[e] = r.u8(); this.eLayer[e] = r.u8() - 8;
      this.eSpeed[e] = r.u8() / 3.6; this.eName[e] = r.v();
      const n = r.v();
      this.eP0[e] = np; this.eN[e] = n + 2;
      let x = Math.round(this.nodeX[a] * 10), z = Math.round(this.nodeZ[a] * 10);
      push(this.nodeX[a], this.nodeZ[a]);
      for (let k = 0; k < n; k++) { x += r.zz(); z += r.zz(); push(x / 10, z / 10); }
      push(this.nodeX[b], this.nodeZ[b]);
      if (this.eFlags[e] & GF.BRIDGE) for (let k = 0; k < n + 2; k++) pd[this.eP0[e] + k] = r.v() / 10;
    }
    this.px = px.slice(0, np); this.pz = pz.slice(0, np); this.pdeck = pd.slice(0, np);
    this.pcum = new Float32Array(np); this.ptEdge = new Uint32Array(np);
    for (let e = 0; e < nE; e++) {
      const p0 = this.eP0[e], n = this.eN[e];
      let c = 0;
      for (let k = 0; k < n; k++) {
        const p = p0 + k;
        if (k) c += Math.hypot(this.px[p] - this.px[p - 1], this.pz[p] - this.pz[p - 1]);
        this.pcum[p] = c; this.ptEdge[p] = e;
      }
      this.eLen[e] = c;
    }
    // adjacency
    const deg = new Uint32Array(nN + 1);
    for (let e = 0; e < nE; e++) { deg[this.eA[e]]++; deg[this.eB[e]]++; }
    this.adjStart = new Uint32Array(nN + 1);
    for (let i = 0; i < nN; i++) this.adjStart[i + 1] = this.adjStart[i] + deg[i];
    this.adjE = new Uint32Array(this.adjStart[nN]); this.adjD = new Int8Array(this.adjStart[nN]);
    const fillAt = this.adjStart.slice(0, nN);
    for (let e = 0; e < nE; e++) {
      let i = fillAt[this.eA[e]]++; this.adjE[i] = e; this.adjD[i] = 1;
      i = fillAt[this.eB[e]]++; this.adjE[i] = e; this.adjD[i] = -1;
    }
    // spatial index (segments)
    this.gw = Math.ceil(width / CELL) + 1; this.gh = Math.ceil(depth / CELL) + 1;
    const nc = this.gw * this.gh;
    const counts = new Uint32Array(nc + 1);
    const visit = (cb: (cell: number, seg: number) => void) => {
      for (let p = 0; p + 1 < np; p++) {
        if (this.ptEdge[p + 1] !== this.ptEdge[p] || this.pcum[p + 1] === 0) continue;
        const x0 = Math.min(this.px[p], this.px[p + 1]), x1 = Math.max(this.px[p], this.px[p + 1]);
        const z0 = Math.min(this.pz[p], this.pz[p + 1]), z1 = Math.max(this.pz[p], this.pz[p + 1]);
        const c0 = Math.max(0, Math.floor(x0 / CELL)), c1 = Math.min(this.gw - 1, Math.floor(x1 / CELL));
        const r0 = Math.max(0, Math.floor(z0 / CELL)), r1 = Math.min(this.gh - 1, Math.floor(z1 / CELL));
        for (let rr = r0; rr <= r1; rr++) for (let cc = c0; cc <= c1; cc++) cb(rr * this.gw + cc, p);
      }
    };
    visit((c) => counts[c + 1]++);
    for (let i = 0; i < nc; i++) counts[i + 1] += counts[i];
    this.cellStart = counts;
    this.cellSeg = new Uint32Array(counts[nc]);
    const at = counts.slice(0, nc);
    visit((c, p) => { this.cellSeg[at[c]++] = p; });
    this.loadMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  }

  isCar(e: number) { return isCarRoad(this.eCls[e]); }
  name(e: number) { const i = this.eName[e]; return i ? this.strings[i - 1] : ''; }
  /** lanes per travel direction */
  lanesDir(e: number) { const l = Math.max(1, this.eLanes[e]); return this.eFlags[e] & GF.ONEWAY ? l : Math.max(1, Math.floor(l / 2)); }
  /** lateral offset (m, right of travel) of lane `i` (0 = innermost / leftmost) */
  laneOffset(e: number, i: number) {
    const ld = this.lanesDir(e);
    const lw = this.eWidth[e] / Math.max(1, this.eFlags[e] & GF.ONEWAY ? ld : ld * 2);
    const k = Math.min(ld - 1, Math.max(0, i));
    return this.eFlags[e] & GF.ONEWAY ? -this.eWidth[e] / 2 + (k + 0.5) * lw : (k + 0.5) * lw;
  }
  /** can a car travel the edge in direction dir */
  canDrive(e: number, dir: number) { return this.isCar(e) && (dir > 0 || !(this.eFlags[e] & GF.ONEWAY)); }
  /** node the edge ends at when travelled in dir */
  endNode(e: number, dir: number) { return dir > 0 ? this.eB[e] : this.eA[e]; }
  startNode(e: number, dir: number) { return dir > 0 ? this.eA[e] : this.eB[e]; }

  /** point at arc length s (from node a), with unit tangent (a→b) and deck height */
  pointAt(e: number, s: number, out: EdgePoint = { x: 0, z: 0, tx: 0, tz: 0, deck: 0 }): EdgePoint {
    const p0 = this.eP0[e], n = this.eN[e], L = this.eLen[e];
    if (s <= 0) s = 0; else if (s >= L) s = L;
    // binary search segment
    let lo = 0, hi = n - 2;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (this.pcum[p0 + m] <= s) lo = m; else hi = m - 1; }
    const p = p0 + lo;
    const sl = this.pcum[p + 1] - this.pcum[p] || 1e-6;
    const f = Math.min(1, Math.max(0, (s - this.pcum[p]) / sl));
    const dx = this.px[p + 1] - this.px[p], dz = this.pz[p + 1] - this.pz[p];
    const dl = Math.hypot(dx, dz) || 1;
    out.x = this.px[p] + dx * f; out.z = this.pz[p] + dz * f;
    out.tx = dx / dl; out.tz = dz / dl;
    out.deck = this.pdeck[p] + (this.pdeck[p + 1] - this.pdeck[p]) * f;
    return out;
  }

  /** nearest edge segment to (x,z) within maxD, optionally filtered by edge */
  nearest(x: number, z: number, maxD: number, filter?: (e: number) => boolean): EdgeHit | null {
    const c0 = Math.max(0, Math.floor((x - maxD) / CELL)), c1 = Math.min(this.gw - 1, Math.floor((x + maxD) / CELL));
    const r0 = Math.max(0, Math.floor((z - maxD) / CELL)), r1 = Math.min(this.gh - 1, Math.floor((z + maxD) / CELL));
    let best: EdgeHit | null = null, bd = maxD;
    for (let rr = r0; rr <= r1; rr++) for (let cc = c0; cc <= c1; cc++) {
      const ci = rr * this.gw + cc;
      for (let k = this.cellStart[ci]; k < this.cellStart[ci + 1]; k++) {
        const p = this.cellSeg[k];
        const e = this.ptEdge[p];
        if (filter && !filter(e)) continue;
        const ax = this.px[p], az = this.pz[p], dx = this.px[p + 1] - ax, dz = this.pz[p + 1] - az;
        const L2 = dx * dx + dz * dz || 1e-9;
        let t = ((x - ax) * dx + (z - az) * dz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + dx * t, qz = az + dz * t;
        const d = Math.hypot(x - qx, z - qz);
        if (d < bd) {
          bd = d;
          const L = Math.sqrt(L2);
          const side = ((x - ax) * -dz + (z - az) * dx) / L; // right of a→b in x-east/z-south = (−dz, dx)
          best = { e, s: this.pcum[p] + t * L, d, x: qx, z: qz, side };
        }
      }
    }
    return best;
  }

  /** all edges with a segment inside the square (x±r, z±r) */
  edgesNear(x: number, z: number, r: number, filter?: (e: number) => boolean): number[] {
    const c0 = Math.max(0, Math.floor((x - r) / CELL)), c1 = Math.min(this.gw - 1, Math.floor((x + r) / CELL));
    const r0 = Math.max(0, Math.floor((z - r) / CELL)), r1 = Math.min(this.gh - 1, Math.floor((z + r) / CELL));
    const out = new Set<number>();
    for (let rr = r0; rr <= r1; rr++) for (let cc = c0; cc <= c1; cc++) {
      const ci = rr * this.gw + cc;
      for (let k = this.cellStart[ci]; k < this.cellStart[ci + 1]; k++) { const e = this.ptEdge[this.cellSeg[k]]; if (!filter || filter(e)) out.add(e); }
    }
    return [...out];
  }

  /**
   * A* over nodes. Cost = travel time (length / speed × penalty). `car` restricts to car
   * edges; `oneway` respects one-way restrictions (police may ignore them at a penalty).
   * Returns the node sequence plus the edges/dirs used, or null.
   */
  route(from: number, to: number, opt: { car: boolean; oneway: 'respect' | 'penalty' | 'ignore'; maxExpand?: number; edgeCost?: (e: number, dir: number) => number }): { nodes: number[]; edges: number[]; dirs: number[] } | null {
    if (from === to) return { nodes: [from], edges: [], dirs: [] };
    const maxExpand = opt.maxExpand ?? 40000;
    const g = new Map<number, number>();
    const came = new Map<number, number>(); // node -> adj index used to reach it
    const closed = new Set<number>();
    const h = (n: number) => Math.hypot(this.nodeX[n] - this.nodeX[to], this.nodeZ[n] - this.nodeZ[to]) / 30;
    const heap = new Heap();
    g.set(from, 0); heap.push(h(from), from);
    let expanded = 0;
    while (heap.size) {
      const n = heap.pop();
      if (closed.has(n)) continue;
      if (n === to) break;
      closed.add(n);
      if (++expanded > maxExpand) return null;
      const gn = g.get(n)!;
      for (let k = this.adjStart[n]; k < this.adjStart[n + 1]; k++) {
        const e = this.adjE[k], dir = this.adjD[k];
        if (opt.car && !this.isCar(e)) continue;
        let pen = 1;
        if (opt.car && dir < 0 && this.eFlags[e] & GF.ONEWAY) { if (opt.oneway === 'respect') continue; if (opt.oneway === 'penalty') pen = 3; }
        if (opt.car && this.eCls[e] === RC.SERVICE) pen *= 1.6;
        if (this.eFlags[e] & GF.PRIVATE) pen *= 2.5;
        if (opt.edgeCost) pen *= opt.edgeCost(e, dir);
        if (!isFinite(pen)) continue;
        const m = dir > 0 ? this.eB[e] : this.eA[e];
        if (closed.has(m)) continue;
        const sp = opt.car ? Math.max(3, this.eSpeed[e]) : 1.4;
        const c = gn + (this.eLen[e] / sp) * pen + 0.5;
        if (c < (g.get(m) ?? Infinity)) { g.set(m, c); came.set(m, k); heap.push(c + h(m), m); }
      }
    }
    if (!came.has(to)) return null;
    const nodes = [to], edges: number[] = [], dirs: number[] = [];
    let cur = to;
    while (cur !== from) {
      const k = came.get(cur)!;
      edges.push(this.adjE[k]); dirs.push(this.adjD[k]);
      cur = this.adjD[k] > 0 ? this.eA[this.adjE[k]] : this.eB[this.adjE[k]];
      nodes.push(cur);
    }
    nodes.reverse(); edges.reverse(); dirs.reverse();
    return { nodes, edges, dirs };
  }

  /** polyline of an edge in travel direction (centre line), appended to out */
  polyline(e: number, dir: number, out: { x: number; z: number }[] = []) {
    const p0 = this.eP0[e], n = this.eN[e];
    for (let k = 0; k < n; k++) { const p = dir > 0 ? p0 + k : p0 + n - 1 - k; out.push({ x: this.px[p], z: this.pz[p] }); }
    return out;
  }

  /** number of car edges at a node (any direction) */
  carDegree(n: number) { let c = 0; for (let k = this.adjStart[n]; k < this.adjStart[n + 1]; k++) if (this.isCar(this.adjE[k])) c++; return c; }
}

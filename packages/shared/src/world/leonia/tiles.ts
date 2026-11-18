/**
 * Leonia tile runtime: loading (sync fs on the server, async fetch in client workers) with
 * an LRU cache, and per-tile rasterisation of the decoded vector data into 1 m lookup
 * grids (land use, surface, buildings + distance-to-wall, road / bridge-deck segment ids,
 * junction bands) plus a deterministic list of stamps (trees, lamps, cars, boats, ...).
 * Everything here depends only on the tile's own bytes, so server and client agree.
 */
import { TILE, AK, BK, BF, RC, RF, POI, LU_MAX, decodeTile, isCarRoad, isRail, isFoot, type LTile, type LBuilding } from './format.ts';
import { districtAt } from './districts.ts';
import { LEONIA_PROJ } from './proj.ts';

export const APRON = 4;
export const RS = TILE + APRON * 2;
export const SIDEWALK_W = 2.5;
/** runtime-only surface code for house driveways */
export const SF_DRIVEWAY = 100;

export const ST = { PALM: 1, TREE: 2, LAMP: 3, CAR: 4, BOAT: 5, UMBRELLA: 6, LIFEGUARD: 7, BUS_STOP: 8, BENCH: 9, SHRUB: 10, YACHT: 11, CRANE: 12, PLANE: 13, PORTAL: 14 } as const;

export function h32(a: number, b: number, c = 0): number {
  let h = (Math.imul(a | 0, 374761393) + Math.imul(b | 0, 668265263) + Math.imul(c | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** flattened segment table: per segment 10 floats */
export const SEG = { AX: 0, AZ: 1, BX: 2, BZ: 3, S0: 4, HW: 5, DA: 6, DB: 7, LEN: 8, RI: 9, N: 10 } as const;

export class TileRaster {
  readonly ox: number; readonly oz: number;
  readonly lu = new Uint8Array(RS * RS);
  readonly sf = new Uint8Array(RS * RS);
  readonly sfAng = new Uint8Array(RS * RS);
  readonly luAng = new Uint8Array(RS * RS);
  readonly bld = new Uint16Array(RS * RS);
  readonly bdist = new Uint8Array(RS * RS);
  readonly road = new Uint16Array(RS * RS);
  readonly deck = new Uint16Array(RS * RS);
  readonly junc = new Uint8Array(RS * RS);
  readonly segs: Float32Array;
  readonly segCls: Uint8Array;
  readonly segFlags: Uint8Array;
  readonly segLanes: Uint8Array;
  /** max wall distance per building (index+1 aligned with bld ids) */
  readonly bMax: Uint8Array;
  /** stamps: [type, x, z, angle(rad*1000), param] flattened */
  readonly stamps: Int32Array;

  constructor(readonly t: LTile) {
    this.ox = t.tx * TILE - APRON; this.oz = t.tz * TILE - APRON;
    // ── areas (largest first, smaller win) ──
    for (const a of t.areas) {
      const isLu = a.kind <= LU_MAX;
      const ang = Math.round((a.angle / Math.PI) * 255);
      this.fill(a.rings, (i) => { if (isLu) { this.lu[i] = a.kind; this.luAng[i] = ang; } else { this.sf[i] = a.kind; this.sfAng[i] = ang; } });
    }
    // ── buildings ──
    const B = t.buildings;
    for (let bi = 0; bi < B.length && bi < 65534; bi++) {
      const b = B[bi];
      const part = (b.flags & BF.PART) !== 0;
      this.fill(b.rings, (i) => {
        const cur = this.bld[i];
        if (!cur) { this.bld[i] = bi + 1; return; }
        const o = B[cur - 1];
        const oPart = (o.flags & BF.PART) !== 0;
        if (part && !oPart) this.bld[i] = bi + 1;
        else if (part === oPart && b.height > o.height) this.bld[i] = bi + 1;
      });
    }
    this.bMax = new Uint8Array(B.length + 1);
    this.chamfer();
    // ── roads ──
    let nseg = 0;
    for (const r of t.roads) nseg += r.pts.length / 2 - 1;
    this.segs = new Float32Array(Math.max(1, nseg) * SEG.N);
    this.segCls = new Uint8Array(nseg + 1); this.segFlags = new Uint8Array(nseg + 1); this.segLanes = new Uint8Array(nseg + 1);
    const score = new Float32Array(RS * RS).fill(1e9);
    const dscore = new Float32Array(RS * RS).fill(1e9);
    let si = 0;
    t.roads.forEach((r, ri) => {
      let s0 = 0;
      const hw = r.width / 2;
      const sw = r.flags & RF.SIDEWALK ? SIDEWALK_W : 0;
      const ext = isCarRoad(r.cls) ? sw + 2 : isRail(r.cls) ? 1.5 : 0.5;
      const pen = isCarRoad(r.cls) || r.cls === RC.RUNWAY || r.cls === RC.TAXIWAY ? 0 : isRail(r.cls) ? 3 : 8;
      for (let k = 0; k + 1 < r.pts.length / 2; k++) {
        const ax = r.pts[k * 2], az = r.pts[k * 2 + 1], bx = r.pts[k * 2 + 2], bz = r.pts[k * 2 + 3];
        const L = Math.hypot(bx - ax, bz - az);
        const o = si * SEG.N;
        const da = r.deck ? r.deck[k] : 0, db = r.deck ? r.deck[k + 1] : 0;
        this.segs.set([ax, az, bx, bz, s0, hw, da, db, L, ri], o);
        this.segCls[si + 1] = r.cls; this.segFlags[si + 1] = r.flags; this.segLanes[si + 1] = r.lanes;
        const id = si + 1;
        si++;
        s0 += L;
        if (L < 0.01) continue;
        const R = hw + ext;
        const c0 = Math.max(0, Math.floor(Math.min(ax, bx) - R - this.ox)), c1 = Math.min(RS - 1, Math.ceil(Math.max(ax, bx) + R - this.ox));
        const r0 = Math.max(0, Math.floor(Math.min(az, bz) - R - this.oz)), r1 = Math.min(RS - 1, Math.ceil(Math.max(az, bz) + R - this.oz));
        const dx = (bx - ax) / L, dz = (bz - az) / L;
        const bridge = !!r.deck && (da > 0.8 || db > 0.8);
        for (let rr = r0; rr <= r1; rr++) for (let cc = c0; cc <= c1; cc++) {
          const px = this.ox + cc + 0.5 - ax, pz = this.oz + rr + 0.5 - az;
          let tt = px * dx + pz * dz;
          if (tt < 0) tt = 0; else if (tt > L) tt = L;
          const ex = px - dx * tt, ez = pz - dz * tt;
          const d = Math.sqrt(ex * ex + ez * ez);
          if (d > R) continue;
          const i = rr * RS + cc;
          const h = bridge ? da + ((db - da) * tt) / L : 0;
          if (bridge && h >= 1) {
            // deck = carriageway + sidewalks (car roads with sidewalks) + 1 m parapet
            if (d > hw + (isCarRoad(r.cls) && r.flags & RF.SIDEWALK ? SIDEWALK_W : 0) + 1) continue;
            const sc = -h * 10 + d * 0.01;
            if (sc < dscore[i]) { dscore[i] = sc; this.deck[i] = id; }
            continue;
          }
          const sc = (d <= hw ? 0 : 1000) + pen + d;
          if (sc < score[i]) { score[i] = sc; this.road[i] = id; }
        }
      }
    });
    // ── junction bands ──
    for (const p of t.pois) {
      if (p.cat !== POI.JUNCTION) continue;
      const r = p.arg + 0.5, R = p.arg + 4.5;
      for (let dz = -Math.ceil(R); dz <= Math.ceil(R); dz++) for (let dx = -Math.ceil(R); dx <= Math.ceil(R); dx++) {
        const cc = p.x + dx - this.ox, rr = p.z + dz - this.oz;
        if (cc < 0 || rr < 0 || cc >= RS || rr >= RS) continue;
        const d = Math.hypot(dx, dz);
        const i = rr * RS + cc;
        if (d <= r) this.junc[i] = 1; else if (d <= R && this.junc[i] !== 1 && d > r + 1) this.junc[i] = 2;
      }
    }
    this.driveways();
    this.stamps = this.buildStamps();
  }

  /** scanline-fill rings into the raster (cell centres) */
  fill(rings: Int32Array[], cb: (i: number) => void) {
    let zmin = Infinity, zmax = -Infinity;
    for (const r of rings) for (let i = 1; i < r.length; i += 2) { if (r[i] < zmin) zmin = r[i]; if (r[i] > zmax) zmax = r[i]; }
    const r0 = Math.max(0, Math.floor(zmin - this.oz)), r1 = Math.min(RS - 1, Math.ceil(zmax - this.oz));
    const xs: number[] = [];
    for (let row = r0; row <= r1; row++) {
      const zc = this.oz + row + 0.5;
      xs.length = 0;
      for (const r of rings) {
        const n = r.length / 2;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const az = r[j * 2 + 1], bz = r[i * 2 + 1];
          if ((az > zc) !== (bz > zc)) { const ax = r[j * 2], bx = r[i * 2]; xs.push(ax + ((zc - az) * (bx - ax)) / (bz - az)); }
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil(xs[k] - this.ox - 0.5)), c1 = Math.min(RS - 1, Math.floor(xs[k + 1] - this.ox - 0.5));
        for (let c = c0; c <= c1; c++) cb(row * RS + c);
      }
    }
  }

  /** 4-neighbour distance (in cells) to the nearest cell not in the same building, capped */
  private chamfer() {
    const { bld, bdist } = this;
    const CAP = 250;
    for (let r = 0; r < RS; r++) for (let c = 0; c < RS; c++) {
      const i = r * RS + c, b = bld[i];
      if (!b) { bdist[i] = 0; continue; }
      const up = r > 0 && bld[i - RS] === b ? bdist[i - RS] : 0;
      const lf = c > 0 && bld[i - 1] === b ? bdist[i - 1] : 0;
      bdist[i] = Math.min(CAP, Math.min(up, lf) + 1);
    }
    for (let r = RS - 1; r >= 0; r--) for (let c = RS - 1; c >= 0; c--) {
      const i = r * RS + c, b = bld[i];
      if (!b) continue;
      const dn = r < RS - 1 && bld[i + RS] === b ? bdist[i + RS] : 0;
      const rt = c < RS - 1 && bld[i + 1] === b ? bdist[i + 1] : 0;
      const v = Math.min(bdist[i], Math.min(dn, rt) + 1);
      bdist[i] = v;
      if (v > this.bMax[b]) this.bMax[b] = v;
    }
  }

  segOf(i: number): number { return this.road[i]; }

  /** concrete strips from houses to the nearest residential street */
  private driveways() {
    const B = this.t.buildings;
    const cands: number[] = [];
    this.segCls.forEach((c, id) => { if (id && (c === RC.RESIDENTIAL || c === RC.LIVING || c === RC.UNCLASSIFIED || c === RC.TERTIARY) && !(this.segFlags[id] & RF.BRIDGE)) cands.push(id); });
    if (!cands.length) return;
    B.forEach((b, bi) => {
      if (b.kind !== BK.HOUSE) return;
      const [x0, z0, x1, z1] = b.bbox;
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
      if (cx < this.ox + APRON || cz < this.oz + APRON || cx >= this.ox + APRON + TILE || cz >= this.oz + APRON + TILE) return;
      let best = 40, fx = 0, fz = 0, sid = 0;
      for (const id of cands) {
        const o = (id - 1) * SEG.N, s = this.segs;
        const ax = s[o], az = s[o + 1], bx = s[o + 2], bz = s[o + 3], L = s[o + 8];
        if (Math.abs(ax - cx) > 80 && Math.abs(bx - cx) > 80) continue;
        if (L < 0.01) continue;
        const dx = (bx - ax) / L, dz = (bz - az) / L;
        let t = (cx - ax) * dx + (cz - az) * dz; t = Math.max(0, Math.min(L, t));
        const px = ax + dx * t, pz = az + dz * t;
        const d = Math.hypot(px - cx, pz - cz) - s[o + 5];
        if (d < best) { best = d; fx = px; fz = pz; sid = id; }
      }
      if (!sid) return;
      const L = Math.hypot(fx - cx, fz - cz);
      if (L < 1) return;
      const ux = (fx - cx) / L, uz = (fz - cz) / L;
      // side offset so the driveway runs beside the door, not through the middle
      const side = h32(b.seed, 1) < 0.5 ? -1 : 1;
      const halfW = Math.min(x1 - x0, z1 - z0) / 2;
      const off = Math.max(0, halfW - 2.5) * side;
      const sx = cx - uz * off, sz = cz + ux * off;
      let carAt = -1;
      for (let s = 0; s < L + 2; s += 0.5) {
        const px = sx + ux * s, pz = sz + uz * s;
        for (const w of [-1.2, 0, 1.2]) {
          const qx = Math.floor(px - uz * w) - this.ox, qz = Math.floor(pz + ux * w) - this.oz;
          if (qx < 0 || qz < 0 || qx >= RS || qz >= RS) continue;
          const i = qz * RS + qx;
          if (this.bld[i]) continue;
          const rid = this.road[i];
          if (rid) {
            const o = (rid - 1) * SEG.N;
            const d = this.distTo(rid, qx + this.ox + 0.5, qz + this.oz + 0.5);
            if (d <= this.segs[o + 5]) continue; // carriageway reached
          }
          if (this.sf[i] && this.sf[i] !== AK.GRASS && this.sf[i] !== AK.GARDEN) continue;
          this.sf[i] = SF_DRIVEWAY;
          if (carAt < 0 && w === 0) carAt = s;
        }
      }
      void bi;
    });
  }

  distTo(id: number, x: number, z: number): number {
    const o = (id - 1) * SEG.N, s = this.segs;
    const ax = s[o], az = s[o + 1], bx = s[o + 2], bz = s[o + 3], L = s[o + 8] || 1e-6;
    const dx = (bx - ax) / L, dz = (bz - az) / L;
    let t = (x - ax) * dx + (z - az) * dz; t = Math.max(0, Math.min(L, t));
    return Math.hypot(x - ax - dx * t, z - az - dz * t);
  }

  idx(x: number, z: number): number { return (z - this.oz) * RS + (x - this.ox); }
  inOwn(x: number, z: number) { const lx = x - this.ox - APRON, lz = z - this.oz - APRON; return lx >= 0 && lz >= 0 && lx < TILE && lz < TILE; }
  water(x: number, z: number): boolean { return this.t.water[(z - this.t.tz * TILE) * TILE + (x - this.t.tx * TILE)] === 1; }

  // ───────────────────────────────────────────────────────────── stamps
  private buildStamps(): Int32Array {
    const out: number[] = [];
    const add = (type: number, x: number, z: number, ang: number, p: number) => out.push(type, Math.round(x), Math.round(z), Math.round(ang * 1000), p);
    const T0x = this.t.tx * TILE, T0z = this.t.tz * TILE;
    const own = (x: number, z: number) => x >= T0x && z >= T0z && x < T0x + TILE && z < T0z + TILE;
    const cell = (x: number, z: number) => (Math.floor(z) - this.oz) * RS + (Math.floor(x) - this.ox);
    const free = (x: number, z: number, r: number) => {
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        const i = cell(x + dx, z + dz);
        if (i < 0 || i >= RS * RS || this.bld[i] || this.deck[i]) return false;
      }
      return true;
    };
    const onRoadCore = (x: number, z: number) => {
      const i = cell(x, z), id = this.road[i];
      if (!id) return false;
      const c = this.segCls[id];
      const d = this.distTo(id, Math.floor(x) + 0.5, Math.floor(z) + 0.5);
      return d <= this.segs[(id - 1) * SEG.N + 5] + (isCarRoad(c) || isRail(c) ? 0.6 : 0);
    };
    const palmShare = (x: number, z: number) => {
      const s = districtAt(x, z).style;
      return s === 'sobe' || s === 'beach' || s === 'keys' ? 0.85 : s === 'downtown' || s === 'brickell' || s === 'edgewater' ? 0.75 : s === 'grove' || s === 'gables' ? 0.35 : 0.55;
    };
    // (a) OSM points
    for (const p of this.t.pois) {
      if (!own(p.x, p.z) || this.water(p.x, p.z)) continue;
      if (p.cat === POI.TREE || p.cat === POI.PALM) { if (free(p.x, p.z, 0) && !onRoadCore(p.x, p.z)) add(p.cat === POI.PALM || h32(p.x, p.z, 8) < palmShare(p.x, p.z) * 0.85 ? ST.PALM : ST.TREE, p.x, p.z, 0, 0); }
      else if (p.cat === POI.PORTAL) {
        if (!free(p.x, p.z, 1)) continue;
        // road half-width at the portal (the surface road ends here); param = half-width in decimetres
        const id = this.road[cell(p.x, p.z)];
        const hw = id ? this.segs[(id - 1) * SEG.N + 5] : 4;
        add(ST.PORTAL, p.x, p.z, (p.arg / 255) * Math.PI * 2 - Math.PI, Math.round(hw * 10));
      }
      else if (p.cat === POI.LAMP) { if (!onRoadCore(p.x, p.z) && free(p.x, p.z, 0)) add(ST.LAMP, p.x, p.z, 0, 0); }
      else if (p.cat === POI.BUS_STOP || p.cat === POI.BENCH) {
        const i = cell(p.x, p.z); const id = this.road[i];
        if (!id || onRoadCore(p.x, p.z) || !free(p.x, p.z, 1)) continue;
        const o = (id - 1) * SEG.N, s = this.segs;
        add(p.cat === POI.BUS_STOP ? ST.BUS_STOP : ST.BENCH, p.x, p.z, Math.atan2(s[o + 3] - s[o + 1], s[o + 2] - s[o]), 0);
      }
    }
    // (b) street trees + lamps along urban streets with sidewalks, benches along park paths
    const n = this.segCls.length - 1;
    for (let id = 1; id <= n; id++) {
      const c = this.segCls[id], f = this.segFlags[id];
      const o = (id - 1) * SEG.N, s = this.segs;
      const ax = s[o], az = s[o + 1], bx = s[o + 2], bz = s[o + 3], s0 = s[o + 4], hw = s[o + 5], L = s[o + 8];
      if (L < 1 || (f & RF.BRIDGE && (s[o + 6] > 0.8 || s[o + 7] > 0.8))) continue;
      const ux = (bx - ax) / L, uz = (bz - az) / L;
      if (isCarRoad(c) && f & RF.SIDEWALK) {
        const step = 13, lampStep = 31;
        for (let a = Math.ceil(s0 / step) * step; a < s0 + L; a += step) {
          const t = a - s0;
          for (const side of [-1, 1]) {
            const x = ax + ux * t - uz * side * (hw + SIDEWALK_W - 0.6), z = az + uz * t + ux * side * (hw + SIDEWALK_W - 0.6);
            if (!own(x, z) || this.water(Math.floor(x), Math.floor(z))) continue;
            const i = cell(x, z);
            if (this.junc[i] || this.road[i] !== id || this.sf[i] === SF_DRIVEWAY || !free(x, z, 1)) continue;
            if (h32(Math.round(a), id, side) < 0.18) continue;
            add(h32(Math.floor(x), Math.floor(z), 5) < palmShare(x, z) ? ST.PALM : ST.TREE, x, z, 0, 1);
          }
        }
        for (let a = Math.ceil((s0 + 7) / lampStep) * lampStep - 7; a < s0 + L; a += lampStep) {
          if (a < s0) continue;
          const t = a - s0;
          for (const side of [-1, 1]) {
            const x = ax + ux * t - uz * side * (hw + 0.7), z = az + uz * t + ux * side * (hw + 0.7);
            if (!own(x, z) || this.water(Math.floor(x), Math.floor(z))) continue;
            const i = cell(x, z);
            if (this.junc[i] === 1 || this.road[i] !== id || !free(x, z, 0)) continue;
            add(ST.LAMP, x, z, Math.atan2(uz, ux) + (side > 0 ? Math.PI / 2 : -Math.PI / 2), 0);
          }
        }
      } else if (isFoot(c)) {
        for (let a = Math.ceil(s0 / 23) * 23; a < s0 + L; a += 23) {
          const t = a - s0, side = h32(Math.round(a), id) < 0.5 ? -1 : 1;
          const x = ax + ux * t - uz * side * (hw + 1), z = az + uz * t + ux * side * (hw + 1);
          if (!own(x, z) || this.water(Math.floor(x), Math.floor(z))) continue;
          const sf = this.sf[cell(x, z)];
          if ((sf === AK.PARK || sf === AK.GARDEN || sf === AK.GRASS || sf === AK.NATURE || sf === AK.BEACH) && free(x, z, 1) && !onRoadCore(x, z)) add(ST.BENCH, x, z, Math.atan2(uz, ux), 0);
        }
      }
    }
    // (c) procedural vegetation on a jittered 6 m grid
    const G = 6;
    for (let gz = T0z; gz < T0z + TILE; gz += G) for (let gx = T0x; gx < T0x + TILE; gx += G) {
      const x = gx + Math.floor(h32(gx, gz, 11) * G), z = gz + Math.floor(h32(gx, gz, 12) * G);
      if (!own(x, z)) continue;
      const i = cell(x, z);
      if (this.water(x, z) || this.bld[i] || this.deck[i]) continue;
      const sf = this.sf[i], lu = this.lu[i];
      let p = 0;
      if (this.road[i]) {
        const id = this.road[i];
        if (this.distTo(id, x + 0.5, z + 0.5) <= this.segs[(id - 1) * SEG.N + 5] + (this.segFlags[id] & RF.SIDEWALK ? SIDEWALK_W : 0) + 1) continue;
      }
      switch (sf) {
        case AK.PARK: case AK.GARDEN: case AK.ZOO: p = 0.33; break;
        case AK.FOREST: case AK.NATURE: p = 0.8; break;
        case AK.SCRUB: p = 0.3; break;
        case AK.WETLAND: p = 0.25; break;
        case AK.GOLF: case AK.GOLF_ROUGH: p = 0.22; break;
        case AK.CEMETERY: p = 0.06; break;
        case AK.GRASS: case AK.CAMPUS_GREEN: case AK.DOG_PARK: p = 0.14; break;
        case AK.BEACH: case AK.SAND: p = 0.025; break;
        case 0:
          if (lu === AK.RESIDENTIAL) p = 0.3;
          else if (lu === AK.EDUCATION || lu === AK.HOSPITAL || lu === AK.RELIGIOUS || lu === AK.MILITARY) p = 0.16;
          else if (lu === AK.COMMERCIAL || lu === AK.RETAIL) p = 0.06;
          else if (lu === 0) { const st = districtAt(x, z).style; p = st === 'nature' ? 0.6 : st === 'downtown' || st === 'brickell' || st === 'edgewater' || st === 'design' || st === 'wynwood' || st === 'sobe' || st === 'port' ? 0.03 : 0.2; }
          else if (lu === AK.AERODROME) p = 0;
          break;
        default: p = 0;
      }
      if (!p || h32(x, z, 13) >= p || !free(x, z, 2)) continue;
      const u = h32(x, z, 14);
      if (sf === AK.BEACH || sf === AK.SAND) add(ST.PALM, x, z, 0, 2);
      else if (u < palmShare(x, z) * (sf === AK.FOREST || sf === AK.NATURE || sf === AK.WETLAND ? 0.3 : 0.8)) add(ST.PALM, x, z, 0, 0);
      else if (u > 0.92 && sf !== AK.FOREST) add(ST.SHRUB, x, z, 0, 0);
      else add(ST.TREE, x, z, 0, sf === AK.WETLAND ? 1 : 0);
    }
    // (d) cars parked on driveways
    for (let gz = T0z; gz < T0z + TILE; gz += 4) for (let gx = T0x; gx < T0x + TILE; gx += 4) {
      const i = cell(gx, gz);
      if (this.water(gx, gz)) continue;
      if (this.sf[i] !== SF_DRIVEWAY || h32(gx, gz, 21) > 0.35) continue;
      const id = this.road[i];
      let ang = 0;
      if (id) { const o = (id - 1) * SEG.N, s = this.segs; ang = Math.atan2(s[o + 3] - s[o + 1], s[o + 2] - s[o]) + Math.PI / 2; }
      else {
        // align with the driveway: probe which axis continues
        const ex = this.sf[i + 2] === SF_DRIVEWAY && this.sf[i - 2] === SF_DRIVEWAY, ez = this.sf[i + 2 * RS] === SF_DRIVEWAY && this.sf[i - 2 * RS] === SF_DRIVEWAY;
        ang = ez && !ex ? Math.PI / 2 : 0;
      }
      if (id) continue; // keep the curb cut clear
      add(ST.CAR, gx, gz, ang, Math.floor(h32(gx, gz, 22) * 8));
    }
    // (e) water life: boats along residential canals and in marinas, beach umbrellas, lifeguard towers
    const landNear = (x: number, z: number, R: number): [number, number, number] => {
      let best = 99, vx = 0, vz = 0;
      for (let dz = -R; dz <= R; dz += 1) for (let dx = -R; dx <= R; dx += 1) {
        const qx = x + dx, qz = z + dz;
        if (qx < T0x || qz < T0z || qx >= T0x + TILE || qz >= T0z + TILE) continue;
        if (!this.water(qx, qz)) { const d = Math.hypot(dx, dz); if (d < best) { best = d; vx = dx; vz = dz; } }
      }
      return [best, vx, vz];
    };
    for (let gz = T0z + 6; gz < T0z + TILE - 6; gz += 11) for (let gx = T0x + 6; gx < T0x + TILE - 6; gx += 11) {
      const x = gx + Math.floor(h32(gx, gz, 31) * 5), z = gz + Math.floor(h32(gx, gz, 32) * 5);
      if (!own(x, z) || !this.water(x, z)) continue;
      const i = cell(x, z);
      if (this.deck[i]) continue;
      const marina = this.sf[i] === AK.MARINA;
      const [d, vx, vz] = landNear(x, z, 8);
      if (d > 8) { if (marina && h32(x, z, 33) < 0.6) add(ST.BOAT, x, z, Math.round(h32(x, z, 34) * 2) * (Math.PI / 2), 0); continue; }
      if (d < 3.5 || d > 7) continue;
      const li = cell(x + vx, z + vz);
      const resi = this.lu[li] === AK.RESIDENTIAL || this.bld[li] && this.t.buildings[this.bld[li] - 1].kind === BK.HOUSE || this.sf[li] === SF_DRIVEWAY;
      if (!(marina || resi || this.sf[li] === AK.MARINA)) continue;
      if (h32(x, z, 35) > (marina ? 0.85 : 0.5)) continue;
      add(h32(x, z, 36) < 0.15 ? ST.YACHT : ST.BOAT, x, z, Math.atan2(vz, vx) + Math.PI / 2, 0);
    }
    // (g) airliners parked nose-in at terminal gates
    for (let gz = T0z + 20; gz < T0z + TILE - 20; gz += 48) for (let gx = T0x + 20; gx < T0x + TILE - 20; gx += 48) {
      const i = cell(gx, gz);
      if (this.sf[i] !== AK.APRON || this.road[i] || this.bld[i]) continue;
      let best = 99, ba = 0;
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2, vx = Math.cos(a), vz = Math.sin(a);
        for (let r = 6; r <= 46; r += 2) {
          const j = cell(gx + vx * r, gz + vz * r);
          if (j < 0 || j >= RS * RS) break;
          const b = this.bld[j];
          if (b) { const bk = this.t.buildings[b - 1].kind; if ((bk === BK.TERMINAL || bk === BK.TRANSPORT || bk === BK.OTHER || bk === BK.COMMERCIAL) && r < best) { best = r; ba = a; } break; }
        }
      }
      if (best < 18 || best > 44 || h32(gx, gz, 81) > 0.8) continue;
      add(ST.PLANE, gx, gz, ba, Math.floor(h32(gx, gz, 82) * 4));
    }
    // (f) gantry cranes along port quays
    for (let gz = T0z + 8; gz < T0z + TILE - 8; gz += 16) for (let gx = T0x + 8; gx < T0x + TILE - 8; gx += 16) {
      const i = cell(gx, gz);
      if (this.lu[i] !== AK.PORT || this.water(gx, gz) || this.bld[i] || this.road[i]) continue;
      const [d, vx, vz] = landNearWaterVec(this, gx, gz, T0x, T0z);
      if (d > 10 || d < 4) continue;
      if (h32(Math.floor(gx / 64), Math.floor(gz / 64), 71) > 0.9) continue;
      if (((Math.floor(gx / 16) + Math.floor(gz / 16)) % 4) !== 0) continue;
      add(ST.CRANE, gx, gz, Math.atan2(vz, vx), 0);
    }
    for (let gz = T0z; gz < T0z + TILE; gz += 9) for (let gx = T0x; gx < T0x + TILE; gx += 9) {
      const x = gx + Math.floor(h32(gx, gz, 41) * 4), z = gz + Math.floor(h32(gx, gz, 42) * 4);
      if (!own(x, z)) continue;
      const i = cell(x, z);
      if (this.sf[i] !== AK.BEACH || this.water(x, z) || this.bld[i] || this.road[i]) continue;
      const [d] = landNearWater(this, x, z, T0x, T0z);
      if (d < 6 || d > 45) continue;
      if (h32(x, z, 43) < 0.3) add(ST.UMBRELLA, x, z, 0, Math.floor(h32(x, z, 44) * 4));
    }
    for (let gz = T0z; gz < T0z + TILE; gz += 160) for (let gx = T0x; gx < T0x + TILE; gx += 160) {
      for (let k = 0; k < 40; k++) {
        const x = gx + Math.floor(h32(gx, gz, 50 + k) * 160), z = gz + Math.floor(h32(gx, gz, 90 + k) * 160);
        if (!own(x, z)) continue;
        const i = cell(x, z);
        if (this.sf[i] !== AK.BEACH || this.water(x, z) || this.bld[i] || this.road[i]) continue;
        const [d] = landNearWater(this, x, z, T0x, T0z);
        if (d < 14 || d > 32) continue;
        add(ST.LIFEGUARD, x, z, 0, Math.floor(h32(x, z, 51) * 4));
        break;
      }
    }
    return Int32Array.from(out);
  }
}

/** distance + direction from a land cell to the nearest water inside the tile */
function landNearWaterVec(t: TileRaster, x: number, z: number, T0x: number, T0z: number): [number, number, number] {
  for (let r = 1; r <= 12; r++) {
    for (let k = 0; k < 32; k++) {
      const a = (k / 32) * Math.PI * 2, vx = Math.cos(a), vz = Math.sin(a);
      const qx = Math.round(x + vx * r), qz = Math.round(z + vz * r);
      if (qx < T0x || qz < T0z || qx >= T0x + TILE || qz >= T0z + TILE) continue;
      if (t.water(qx, qz)) return [r, vx, vz];
    }
  }
  return [99, 0, 0];
}
/** distance (m, coarse) from a land cell to the nearest water inside the tile */
function landNearWater(t: TileRaster, x: number, z: number, T0x: number, T0z: number): [number] {
  for (let r = 2; r <= 48; r += 3) {
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      const qx = Math.round(x + Math.cos(a) * r), qz = Math.round(z + Math.sin(a) * r);
      if (qx < T0x || qz < T0z || qx >= T0x + TILE || qz >= T0z + TILE) continue;
      if (t.water(qx, qz)) return [r];
    }
  }
  return [99];
}

// ───────────────────────────────────────────────────────────── loader
export interface LeoniaSource {
  /** synchronous read (server, scripts); null = missing tile */
  readSync?(tx: number, tz: number): Uint8Array | null;
  /** asynchronous read (client workers); null = missing tile */
  read?(tx: number, tz: number): Promise<Uint8Array | null>;
}

export const LEONIA_TILES_X = Math.ceil(LEONIA_PROJ.width / TILE);
export const LEONIA_TILES_Z = Math.ceil(LEONIA_PROJ.depth / TILE);

export class LeoniaTiles {
  private cache = new Map<number, TileRaster | null>();
  private loading = new Map<number, Promise<void>>();
  loads = 0; buildMs = 0;
  constructor(public source: LeoniaSource | null = null, public max = 16) {}

  private key(tx: number, tz: number) { return tz * 1024 + tx; }
  private put(k: number, t: TileRaster | null) {
    this.cache.set(k, t);
    while (this.cache.size > this.max) this.cache.delete(this.cache.keys().next().value as number);
  }
  private build(buf: Uint8Array | null): TileRaster | null {
    if (!buf) return null;
    const t0 = performance.now();
    const r = new TileRaster(decodeTile(buf));
    this.buildMs += performance.now() - t0; this.loads++;
    return r;
  }
  /** tile raster or null (no data: open sea); undefined when not loaded and no sync source */
  get(tx: number, tz: number): TileRaster | null | undefined {
    if (tx < 0 || tz < 0 || tx >= LEONIA_TILES_X || tz >= LEONIA_TILES_Z) return null;
    const k = this.key(tx, tz);
    const c = this.cache.get(k);
    if (c !== undefined) { this.cache.delete(k); this.cache.set(k, c); return c; }
    if (this.source?.readSync) { const t = this.build(this.source.readSync(tx, tz)); this.put(k, t); return t; }
    return undefined;
  }
  /** make sure all tiles touching the world rect are resident (async sources) */
  async ensure(x0: number, z0: number, x1: number, z1: number): Promise<void> {
    const t0 = Math.floor(x0 / TILE), t1 = Math.floor(x1 / TILE), s0 = Math.floor(z0 / TILE), s1 = Math.floor(z1 / TILE);
    const waits: Promise<void>[] = [];
    for (let tz = s0; tz <= s1; tz++) for (let tx = t0; tx <= t1; tx++) {
      if (tx < 0 || tz < 0 || tx >= LEONIA_TILES_X || tz >= LEONIA_TILES_Z) continue;
      const k = this.key(tx, tz);
      if (this.cache.has(k)) continue;
      if (this.source?.readSync) { this.get(tx, tz); continue; }
      let p = this.loading.get(k);
      if (!p) {
        p = (async () => {
          let buf: Uint8Array | null = null;
          try { buf = (await this.source?.read?.(tx, tz)) ?? null; } catch { buf = null; }
          this.put(k, this.build(buf));
          this.loading.delete(k);
        })();
        this.loading.set(k, p);
      }
      waits.push(p);
    }
    if (waits.length) await Promise.all(waits);
  }
}

export type { LBuilding };

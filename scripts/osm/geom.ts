/** Geometry helpers for the OSM build: ring assembly, simplification, clipping, rasterising. */
export type Pt = [number, number];

export function ringArea(r: Pt[]): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return a / 2;
}

/** Douglas-Peucker on an open polyline (keeps endpoints). */
export function simplify(pts: Pt[], eps: number): Pt[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, az] = pts[a], [bx, bz] = pts[b];
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
    let best = -1, bi = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, pz] = pts[i];
      const d = L < 1e-9 ? Math.hypot(px - ax, pz - az) : Math.abs(dx * (az - pz) - dz * (ax - px)) / L;
      if (d > best) { best = d; bi = i; }
    }
    if (best > eps) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
/** simplify a closed ring (first point != last point in input/output) */
export function simplifyRing(r: Pt[], eps: number): Pt[] {
  if (r.length < 4) return r.slice();
  // split at the point farthest from point 0 so both halves are anchored
  let far = 0, fd = -1;
  for (let i = 1; i < r.length; i++) { const d = Math.hypot(r[i][0] - r[0][0], r[i][1] - r[0][1]); if (d > fd) { fd = d; far = i; } }
  const a = simplify(r.slice(0, far + 1), eps);
  const b = simplify([...r.slice(far), r[0]], eps);
  return [...a, ...b.slice(1, -1)];
}
/** quantise to integer metres and drop repeats; returns flat [x,z,...] */
export function quantLine(pts: Pt[], closed: boolean): number[] {
  const out: number[] = [];
  for (const [x, z] of pts) {
    const qx = Math.round(x), qz = Math.round(z);
    const n = out.length;
    if (n && out[n - 2] === qx && out[n - 1] === qz) continue;
    out.push(qx, qz);
  }
  if (closed && out.length >= 4 && out[0] === out[out.length - 2] && out[1] === out[out.length - 1]) out.length -= 2;
  return out;
}

/** Join way member segments into closed rings (by matching endpoints). */
export function assembleRings(parts: Pt[][]): Pt[][] {
  const key = (p: Pt) => `${p[0].toFixed(7)},${p[1].toFixed(7)}`;
  const rings: Pt[][] = [];
  const open = parts.filter((p) => p.length >= 2).map((p) => p.slice());
  for (let i = open.length - 1; i >= 0; i--) {
    const p = open[i];
    if (p.length >= 4 && key(p[0]) === key(p[p.length - 1])) { rings.push(p.slice(0, -1)); open.splice(i, 1); }
  }
  while (open.length) {
    let cur = open.pop()!;
    let guard = 0;
    while (key(cur[0]) !== key(cur[cur.length - 1]) && guard++ < 10000) {
      const end = key(cur[cur.length - 1]);
      let found = -1, rev = false;
      for (let i = 0; i < open.length; i++) {
        if (key(open[i][0]) === end) { found = i; break; }
        if (key(open[i][open[i].length - 1]) === end) { found = i; rev = true; break; }
      }
      if (found < 0) break; // unclosed (clipped by the query bbox): close it straight
      const nx = open.splice(found, 1)[0];
      if (rev) nx.reverse();
      cur = cur.concat(nx.slice(1));
    }
    if (key(cur[0]) === key(cur[cur.length - 1])) cur = cur.slice(0, -1);
    if (cur.length >= 3) rings.push(cur);
  }
  return rings;
}

/** Sutherland-Hodgman clip of a ring against an axis-aligned rect. */
export function clipRing(r: Pt[], x0: number, z0: number, x1: number, z1: number): Pt[] {
  let out = r;
  const edges: [(p: Pt) => boolean, (a: Pt, b: Pt) => Pt][] = [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= z0, (a, b) => [a[0] + ((b[0] - a[0]) * (z0 - a[1])) / (b[1] - a[1]), z0]],
    [(p) => p[1] <= z1, (a, b) => [a[0] + ((b[0] - a[0]) * (z1 - a[1])) / (b[1] - a[1]), z1]],
  ];
  for (const [inside, cut] of edges) {
    if (!out.length) break;
    const inp = out; out = [];
    for (let i = 0; i < inp.length; i++) {
      const cur = inp[i], prev = inp[(i + inp.length - 1) % inp.length];
      const ci = inside(cur), pi = inside(prev);
      if (ci) { if (!pi) out.push(cut(prev, cur)); out.push(cur); }
      else if (pi) out.push(cut(prev, cur));
    }
  }
  return out;
}

/**
 * Even-odd scanline fill of rings (flat [x,z,...] arrays) sampled at cell centres into a
 * raster of size w x h whose cell (0,0) is world (ox, oz). cb(index) per covered cell.
 */
export function fillRings(rings: ArrayLike<number>[], ox: number, oz: number, w: number, h: number, cb: (i: number) => void) {
  let zmin = Infinity, zmax = -Infinity;
  for (const r of rings) for (let i = 1; i < r.length; i += 2) { if (r[i] < zmin) zmin = r[i]; if (r[i] > zmax) zmax = r[i]; }
  const r0 = Math.max(0, Math.floor(zmin - oz)), r1 = Math.min(h - 1, Math.ceil(zmax - oz));
  const xs: number[] = [];
  for (let row = r0; row <= r1; row++) {
    const zc = oz + row + 0.5;
    xs.length = 0;
    for (const r of rings) {
      const n = r.length / 2;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const ax = r[j * 2], az = r[j * 2 + 1], bx = r[i * 2], bz = r[i * 2 + 1];
        if ((az > zc) !== (bz > zc)) xs.push(ax + ((zc - az) * (bx - ax)) / (bz - az));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(xs[k] - ox - 0.5)), c1 = Math.min(w - 1, Math.floor(xs[k + 1] - ox - 0.5));
      for (let c = c0; c <= c1; c++) cb(row * w + c);
    }
  }
}

/** Cells within `hw` of a polyline (flat array), raster origin (ox,oz) size w x h. */
export function strokeLine(pts: ArrayLike<number>, hw: number, ox: number, oz: number, w: number, h: number, cb: (i: number) => void) {
  for (let k = 0; k + 3 < pts.length; k += 2) {
    const ax = pts[k], az = pts[k + 1], bx = pts[k + 2], bz = pts[k + 3];
    const c0 = Math.max(0, Math.floor(Math.min(ax, bx) - hw - ox)), c1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + hw - ox));
    const r0 = Math.max(0, Math.floor(Math.min(az, bz) - hw - oz)), r1 = Math.min(h - 1, Math.ceil(Math.max(az, bz) + hw - oz));
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9;
    const hw2 = hw * hw;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const px = ox + c + 0.5, pz = oz + r + 0.5;
      let t = ((px - ax) * dx + (pz - az) * dz) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = ax + dx * t - px, ez = az + dz * t - pz;
      if (ex * ex + ez * ez <= hw2) cb(r * w + c);
    }
  }
}

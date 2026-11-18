/**
 * Far-city LOD builders (worker side, no DOM): per Leonia tile (512 m)
 *   - buildingMesh(): extruded building footprints (walls + triangulated flat roofs, hip roofs
 *     as a lower flat cap), coloured with the same facade choice the voxel generator makes
 *     (facadeFor → wall / roof block → average texture colour); vertex alpha carries the window
 *     style for the shader (0 none, 1 curtain glass, 2 grid, 3 house, 4 warehouse)
 *   - paintTile(): a 2D raster of the tile (land use, water with depth ramp, roads by class,
 *     optional building footprints) used both for the LOD ground texture and the map UI.
 * Everything depends only on the tile bytes, so it matches the voxel world.
 */
import { ShapeUtils, Vector2 } from 'three';
import { B, AK, BF, RC, RF, TILE, isCarRoad, isRail, isFoot, facadeFor, districtAt, LEONIA_MAX_H, leoniaBuildingRemoved, type LTile, type LBuilding } from '@blockshore/shared';

const G = 22; // first block above street level (matches gen.ts)

export interface LodMesh { pos: Float32Array; nrm: Int8Array; col: Uint8Array; idx: Uint32Array; maxY: number; buildings: number }
/** per block id: top rgb, side rgb (sRGB bytes), 6 bytes per block */
export type BlockColours = Uint8Array;

export const WIN = { NONE: 0, GLASS: 1, GRID: 2, HOUSE: 3, WARE: 4 } as const;

/** level 0 = every building, 1 = drop low small ones, 2 = landmarks/tall only */
export function keepAtLevel(b: LBuilding, level: number): boolean {
  if (level === 0) return true;
  const h = b.height - b.minHeight;
  const area = (b.bbox[2] - b.bbox[0]) * (b.bbox[3] - b.bbox[1]);
  if (level === 1) return h >= 11 || area >= 1600;
  return h >= 24 || area >= 7000;
}

/** buildings owned by this tile (buildings are stored in every tile their bbox touches) */
export function ownBuildings(t: LTile): LBuilding[] {
  const out: LBuilding[] = [];
  for (const b of t.buildings) {
    if (b.flags & BF.HAS_PARTS) continue; // the parts are drawn instead of their outline
    if (leoniaBuildingRemoved(b.bbox)) continue; // cleared for an enterable prefab
    const cx = Math.floor((b.bbox[0] + b.bbox[2]) / 2 / TILE), cz = Math.floor((b.bbox[1] + b.bbox[3]) / 2 / TILE);
    if (cx === t.tx && cz === t.tz) out.push(b);
  }
  return out;
}

function ringArea(r: Int32Array, n: number) {
  let a = 0;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; a += r[i * 2] * r[j * 2 + 1] - r[j * 2] * r[i * 2 + 1]; }
  return a / 2;
}

class Out {
  pos: number[] = []; nrm: number[] = []; col: number[] = []; idx: number[] = [];
  n = 0; maxY = 0;
  v(x: number, y: number, z: number, nx: number, ny: number, nz: number, c: number[]) {
    this.pos.push(x, y, z); this.nrm.push(Math.round(nx * 127), Math.round(ny * 127), Math.round(nz * 127)); this.col.push(c[0], c[1], c[2], c[3]);
    if (y > this.maxY) this.maxY = y;
    return this.n++;
  }
}

/** one quad (p0..p3 counter-clockwise seen from outside along n), winding fixed against the normal */
function quad(o: Out, p: number[][], n: number[], c: number[]) {
  const a = o.v(p[0][0], p[0][1], p[0][2], n[0], n[1], n[2], c), b = o.v(p[1][0], p[1][1], p[1][2], n[0], n[1], n[2], c);
  const cc = o.v(p[2][0], p[2][1], p[2][2], n[0], n[1], n[2], c), d = o.v(p[3][0], p[3][1], p[3][2], n[0], n[1], n[2], c);
  const e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]], e2 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
  const cx = e1[1] * e2[2] - e1[2] * e2[1], cy = e1[2] * e2[0] - e1[0] * e2[2], cz = e1[0] * e2[1] - e1[1] * e2[0];
  if (cx * n[0] + cy * n[1] + cz * n[2] > 0) o.idx.push(a, b, cc, a, cc, d); else o.idx.push(a, cc, b, a, d, cc);
}
/** axis-aligned box (x0..x1, z0..z1, y0..y1): four sides in `side`, the lid in `lid` */
function box(o: Out, x0: number, z0: number, x1: number, z1: number, y0: number, y1: number, side: number[], lid: number[]) {
  quad(o, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1], side);
  quad(o, [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]], [0, 0, -1], side);
  quad(o, [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], [1, 0, 0], side);
  quad(o, [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0], side);
  quad(o, [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], [0, 1, 0], lid);
}
const rgb = (c: BlockColours, id: number, side = false) => { const o = id * 6 + (side ? 3 : 0); return [c[o], c[o + 1], c[o + 2]]; };
const mixRgb = (a: number[], b: number[], t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** wall colour seen from far away: the voxel facade is wall + window + trim (+ murals), not one flat block */
function lodWall(f: ReturnType<typeof facadeFor>, c: BlockColours): number[] {
  const w = rgb(c, f.wall, true), tr = rgb(c, f.trim, true);
  switch (f.fam) {
    case 'mid': case 'deco': case 'civic': case 'condo': case 'house': {
      let m = mixRgb(w, tr, f.fam === 'condo' ? 0.3 : 0.18);
      if (f.murals) { const a = [B.MURAL_A, B.MURAL_B, B.MURAL_C, B.MURAL_D, B.MURAL_E].map((q) => rgb(c, q, true)); m = mixRgb(m, [a.reduce((s, q) => s + q[0], 0) / 5, a.reduce((s, q) => s + q[1], 0) / 5, a.reduce((s, q) => s + q[2], 0) / 5], 0.55); }
      return m;
    }
    case 'glass': return f.grid ? mixRgb(w, rgb(c, B.CHROME, true), 0.14) : w;
    default: return w;
  }
}

export function buildingMesh(t: LTile, colours: BlockColours, level: number): LodMesh {
  const ox = t.tx * TILE, oz = t.tz * TILE;
  const o = new Out();
  let count = 0;
  for (const b of ownBuildings(t)) {
    if (!keepAtLevel(b, level)) continue;
    const w = b.bbox[2] - b.bbox[0], d = b.bbox[3] - b.bbox[1];
    const style = districtAt((b.bbox[0] + b.bbox[2]) / 2, (b.bbox[1] + b.bbox[3]) / 2).style;
    const f = facadeFor(b, Math.max(1, Math.min(60, Math.floor(Math.min(w, d) / 2))), style);
    const top = Math.max(2, Math.min(LEONIA_MAX_H, Math.round(b.height)));
    const base = Math.max(0, Math.min(top - 1, Math.round(b.minHeight)));
    let wallTop = G + base + f.hWall, roofY = wallTop;
    if (f.roofShape !== 'flat') roofY = wallTop + Math.max(1, f.roofCap * 0.45);
    else if (f.fam !== 'shed') roofY = wallTop + f.par; // parapet / trim row
    if (f.fam === 'canopy') { wallTop = G + base + f.hWall; roofY = wallTop; }
    const y0 = f.fam === 'canopy' ? wallTop - 1 : G + base;
    const win = f.fam === 'glass' || f.fam === 'terminal' ? WIN.GLASS : f.fam === 'condo' || f.fam === 'mid' || f.fam === 'deco' || f.fam === 'civic' || f.fam === 'garage' ? WIN.GRID
      : f.fam === 'house' ? WIN.HOUSE : f.fam === 'ware' || f.fam === 'hangar' ? WIN.WARE : WIN.NONE;
    const lw = lodWall(f, colours);
    const wc = [lw[0], lw[1], lw[2], win * 32 + (b.seed & 31)];
    const rc = [colours[f.roof * 6], colours[f.roof * 6 + 1], colours[f.roof * 6 + 2], 0];
    const pc = [...rgb(colours, f.trim, true), 0]; // parapet = the facade trim block
    const x0 = b.bbox[0] - ox, x1 = b.bbox[2] - ox, z0 = b.bbox[1] - oz, z1 = b.bbox[3] - oz, hx = (x1 - x0) / 2, hz = (z1 - z0) / 2, mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
    const Ht = Math.max(2, Math.min(LEONIA_MAX_H, Math.round(b.height))) - base;
    if (f.lm === 'tower') {
      // control tower: plinth, narrow shaft, wide glazed cab, mast
      const cw = [...rgb(colours, B.GLASS, true), win * 32 + 1], sh = [...rgb(colours, B.CONCRETE, true), 0];
      box(o, x0, z0, x1, z1, G, G + 6, sh, sh);
      box(o, mx - hx * 0.4, mz - hz * 0.4, mx + hx * 0.4, mz + hz * 0.4, G + 6, G + Ht - 18, sh, sh);
      box(o, x0, z0, x1, z1, G + Ht - 18, G + Ht - 6, cw, pc);
      box(o, mx - hx * 0.6, mz - hz * 0.6, mx + hx * 0.6, mz + hz * 0.6, G + Ht - 6, G + Ht - 2, cw, pc);
      box(o, mx - 0.6, mz - 0.6, mx + 0.6, mz + 0.6, G + Ht - 2, G + Ht + 14, pc, pc);
      count++; continue;
    }
    // walls for every ring (outer + holes), outward normals from ring orientation
    const contour: Vector2[] = [], holes: Vector2[][] = [];
    for (let ri = 0; ri < b.rings.length; ri++) {
      const r = b.rings[ri];
      let n = r.length / 2;
      if (n >= 2 && r[0] === r[(n - 1) * 2] && r[1] === r[(n - 1) * 2 + 1]) n--;
      if (n < 3) continue;
      const A = ringArea(r, n);
      if (Math.abs(A) < 1) continue;
      // outer ring: outward = right of the edge when CCW (A > 0); holes the other way round
      const sgn = (A > 0 ? 1 : -1) * (ri === 0 ? 1 : -1);
      const pts: Vector2[] = [];
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const ax = r[i * 2] - ox, az = r[i * 2 + 1] - oz, bx = r[j * 2] - ox, bz = r[j * 2 + 1] - oz;
        pts.push(new Vector2(ax, az));
        const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
        if (L < 0.01) continue;
        const nx = (dz / L) * sgn, nz = (-dx / L) * sgn;
        const a = o.v(ax, y0, az, nx, 0, nz, wc), bb = o.v(bx, y0, bz, nx, 0, nz, wc), c = o.v(bx, wallTop, bz, nx, 0, nz, wc), dd = o.v(ax, wallTop, az, nx, 0, nz, wc);
        // (a,b,c) faces left of the edge (-dz, dx); flip when the outward normal is the right side
        if (sgn > 0) o.idx.push(a, c, bb, a, dd, c); else o.idx.push(a, bb, c, a, c, dd);
        if (roofY > wallTop + 0.01) {
          // parapet / roof band in the roof colour (keeps the silhouette height right)
          const e = o.v(ax, wallTop, az, nx, 0, nz, rc), g = o.v(bx, wallTop, bz, nx, 0, nz, rc), h = o.v(bx, roofY, bz, nx, 0, nz, rc), k = o.v(ax, roofY, az, nx, 0, nz, rc);
          if (sgn > 0) o.idx.push(e, h, g, e, k, h); else o.idx.push(e, g, h, e, h, k);
        }
      }
      if (ri === 0) contour.push(...pts); else holes.push(pts);
    }
    if (contour.length < 3) continue;
    // roof
    let tris: number[][];
    try { tris = ShapeUtils.triangulateShape(contour, holes); } catch { continue; }
    const all = contour.concat(...holes);
    const base0 = o.n;
    for (const p of all) o.v(p.x, roofY, p.y, 0, 1, 0, rc);
    for (const tr of tris) {
      const p0 = all[tr[0]], p1 = all[tr[1]], p2 = all[tr[2]];
      // upward normal: cross((p1-p0),(p2-p0)).y = dz1*dx2 - dx1*dz2 must be > 0
      const cy = (p1.y - p0.y) * (p2.x - p0.x) - (p1.x - p0.x) * (p2.y - p0.y);
      if (cy > 0) o.idx.push(base0 + tr[0], base0 + tr[1], base0 + tr[2]);
      else o.idx.push(base0 + tr[0], base0 + tr[2], base0 + tr[1]);
    }
    // rooftop silhouette: setback penthouse, stair bulkhead, antenna / mast, landmark tiers (same offsets as the voxels)
    if (f.roofShape === 'flat' && f.lm !== 'freedom') {
      const mind = Math.min(hx, hz);
      if (f.pent && mind >= 6) { const e = mind * 0.42; box(o, mx - e, mz - e, mx + e, mz + e, roofY, roofY + f.pent + 1, wc, pc); }
      else if (f.bulk && mind >= 4) { const bx = mx + f.ofs[0], bz = mz + f.ofs[1]; box(o, bx - 1.5, bz - 1.5, bx + 1.5, bz + 1.5, roofY, roofY + 3, [...rgb(colours, B.CONCRETE, true), 0], [...rgb(colours, B.ROOF_DARK), 0]); }
      if (f.mast || f.antenna) { const hgt = f.mast || f.antenna; const q = f.mast ? 0 : 1; box(o, mx + (q ? f.ofs[4] : 0) - 0.5, mz + (q ? f.ofs[5] : 0) - 0.5, mx + (q ? f.ofs[4] : 0) + 0.5, mz + (q ? f.ofs[5] : 0) + 0.5, roofY, roofY + hgt + 1, [...rgb(colours, B.CHROME, true), 0], [...rgb(colours, B.CHROME), 0]); }
    }
    if (f.lm === 'freedom') {
      const tw = [...rgb(colours, B.STUCCO_CREAM, true), 2 * 32 + (b.seed & 31)];
      box(o, mx - hx * 0.62, mz - hz * 0.62, mx + hx * 0.62, mz + hz * 0.62, roofY, G + base + Ht * 0.93, tw, rc);
      box(o, mx - hx * 0.4, mz - hz * 0.4, mx + hx * 0.4, mz + hz * 0.4, G + base + Ht * 0.93, G + base + Ht, tw, rc);
      box(o, mx - 0.8, mz - 0.8, mx + 0.8, mz + 0.8, G + base + Ht, G + base + Ht + 7, [...rgb(colours, B.GOLD_TRIM, true), 0], [...rgb(colours, B.GOLD_TRIM), 0]);
    }
    count++;
  }
  return { pos: new Float32Array(o.pos), nrm: new Int8Array(o.nrm), col: new Uint8Array(o.col), idx: new Uint32Array(o.idx), maxY: o.maxY, buildings: count };
}

// ───────────────────────────────────────────────────────────── 2D tile painter

type Ctx = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
export interface TilePalette {
  land: string;
  /** colour for an area kind (null = not drawn) */
  area: (kind: number) => string | null;
  /** water colour by distance to land in metres */
  water: (distM: number) => [number, number, number];
  road: (cls: number) => { fill: string; edge: string | null; minPx: number } | null;
  sidewalk: string | null;
  building: ((b: LBuilding) => string) | null;
  /** extra stroke around building footprints (map style) */
  buildingEdge?: string | null;
}

const WATER_OVER = new Set<number>([AK.PIER, AK.BREAKWATER, AK.BRIDGE, AK.MARINA]);

function pathRings(ctx: Ctx, rings: Int32Array[], ox: number, oz: number, k: number) {
  ctx.beginPath();
  for (const r of rings) {
    for (let i = 0; i < r.length; i += 2) {
      const x = (r[i] - ox) * k, y = (r[i + 1] - oz) * k;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }
}

/** water layer: RGBA (alpha 255 on water) at S×S with a depth ramp from the distance to land */
export function waterLayer(t: LTile, S: number, pal: TilePalette): ImageData | null {
  const step = TILE / S;
  const wet = new Uint8Array(S * S);
  let any = 0;
  for (let y = 0; y < S; y++) {
    const wz = Math.min(TILE - 1, Math.floor((y + 0.5) * step));
    for (let x = 0; x < S; x++) {
      const wx = Math.min(TILE - 1, Math.floor((x + 0.5) * step));
      const v = t.water[wz * TILE + wx];
      wet[y * S + x] = v; any |= v;
    }
  }
  if (!any) return null;
  // chamfer distance to land in pixels (tile-local; tile edges count as far from land)
  const D = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) D[i] = wet[i] ? 1e6 : 0;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) { const i = y * S + x; let v = D[i]; if (!v) continue; if (x) v = Math.min(v, D[i - 1] + 1); if (y) v = Math.min(v, D[i - S] + 1); if (x && y) v = Math.min(v, D[i - S - 1] + 1.414); if (x < S - 1 && y) v = Math.min(v, D[i - S + 1] + 1.414); D[i] = v; }
  for (let y = S - 1; y >= 0; y--) for (let x = S - 1; x >= 0; x--) { const i = y * S + x; let v = D[i]; if (!v) continue; if (x < S - 1) v = Math.min(v, D[i + 1] + 1); if (y < S - 1) v = Math.min(v, D[i + S] + 1); if (x < S - 1 && y < S - 1) v = Math.min(v, D[i + S + 1] + 1.414); if (x && y < S - 1) v = Math.min(v, D[i + S - 1] + 1.414); D[i] = v; }
  const img = new ImageData(S, S);
  const d = img.data;
  for (let i = 0; i < S * S; i++) {
    if (!wet[i]) continue;
    const c = pal.water(Math.min(400, D[i] * step));
    d[i * 4] = c[0]; d[i * 4 + 1] = c[1]; d[i * 4 + 2] = c[2]; d[i * 4 + 3] = 255;
  }
  return img;
}

/** paint one tile into ctx at S px per 512 m (ctx origin = tile NW corner) */
export function paintTile(ctx: Ctx, t: LTile, S: number, pal: TilePalette, scratch: { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: Ctx } | null) {
  const k = S / TILE, ox = t.tx * TILE, oz = t.tz * TILE;
  ctx.fillStyle = pal.land;
  ctx.fillRect(0, 0, S, S);
  for (const a of t.areas) {
    if (WATER_OVER.has(a.kind)) continue;
    const c = pal.area(a.kind);
    if (!c) continue;
    ctx.fillStyle = c;
    pathRings(ctx, a.rings, ox, oz, k);
    ctx.fill('evenodd');
  }
  const wl = waterLayer(t, S, pal);
  if (wl) {
    if (scratch) {
      scratch.ctx.putImageData(wl, 0, 0);
      ctx.drawImage(scratch.canvas as CanvasImageSource, 0, 0, S, S, 0, 0, S, S);
    }
  }
  for (const a of t.areas) {
    if (!WATER_OVER.has(a.kind)) continue;
    const c = pal.area(a.kind);
    if (!c) continue;
    ctx.fillStyle = c;
    pathRings(ctx, a.rings, ox, oz, k);
    ctx.fill('evenodd');
  }
  // roads: minor first, sidewalks under car roads
  const roads = t.roads.slice().sort((a, b) => roadRank(a.cls) - roadRank(b.cls) || (a.flags & RF.BRIDGE) - (b.flags & RF.BRIDGE));
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  const line = (pts: Int32Array) => {
    ctx.beginPath();
    for (let i = 0; i < pts.length; i += 2) { const x = (pts[i] - ox) * k, y = (pts[i + 1] - oz) * k; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
  };
  if (pal.sidewalk) {
    ctx.strokeStyle = pal.sidewalk;
    for (const r of roads) {
      if (!isCarRoad(r.cls) || !(r.flags & RF.SIDEWALK)) continue;
      const w = (r.width + 5) * k;
      if (w < 0.6) continue;
      ctx.lineWidth = w; line(r.pts); ctx.stroke();
    }
  }
  // per class rank: all casings first, then all fills (no casing seams where ways join)
  for (let i = 0; i < roads.length;) {
    let j = i;
    const rank = roadRank(roads[i].cls);
    while (j < roads.length && roadRank(roads[j].cls) === rank) j++;
    for (let pass = 0; pass < 2; pass++) for (let q = i; q < j; q++) {
      const r = roads[q];
      const st = pal.road(r.cls);
      if (!st) continue;
      const w = Math.max(st.minPx, r.width * k);
      if (pass === 0) { if (!st.edge) continue; ctx.strokeStyle = st.edge; ctx.lineWidth = w + Math.max(1, w * 0.35); }
      else { ctx.strokeStyle = st.fill; ctx.lineWidth = w; }
      line(r.pts); ctx.stroke();
    }
    i = j;
  }
  if (pal.building) {
    for (const b of t.buildings) {
      if (b.flags & BF.HAS_PARTS || leoniaBuildingRemoved(b.bbox)) continue;
      ctx.fillStyle = pal.building(b);
      pathRings(ctx, b.rings, ox, oz, k);
      ctx.fill('evenodd');
      if (pal.buildingEdge && S >= 512) { ctx.strokeStyle = pal.buildingEdge; ctx.lineWidth = 1; ctx.stroke(); }
    }
  }
}

export function roadRank(cls: number): number {
  if (isFoot(cls)) return 0;
  if (cls === RC.SERVICE) return 1;
  if (isRail(cls)) return 2;
  if (cls === RC.RESIDENTIAL || cls === RC.LIVING || cls === RC.UNCLASSIFIED) return 3;
  if (cls === RC.TERTIARY) return 4;
  if (cls === RC.SECONDARY) return 5;
  if (cls === RC.PRIMARY) return 6;
  if (cls === RC.TRUNK) return 7;
  if (cls === RC.MOTORWAY) return 8;
  if (cls === RC.RUNWAY || cls === RC.TAXIWAY) return 2;
  return 1;
}

/** ground emissive mask (street lighting at night): roads stroked into a grey canvas, 0..255 */
export function paintGlow(ctx: Ctx, t: LTile, S: number) {
  const k = S / TILE, ox = t.tx * TILE, oz = t.tz * TILE;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, S, S);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  for (const r of t.roads) {
    if (!isCarRoad(r.cls) && r.cls !== RC.PEDESTRIAN && r.cls !== RC.RUNWAY && r.cls !== RC.TAXIWAY) continue;
    const major = r.cls <= RC.SECONDARY || r.cls === RC.RUNWAY;
    ctx.strokeStyle = major ? '#fff' : r.cls === RC.SERVICE ? '#555' : '#aaa';
    ctx.lineWidth = Math.max(1, (r.width + 6) * k);
    ctx.beginPath();
    for (let i = 0; i < r.pts.length; i += 2) { const x = (r.pts[i] - ox) * k, y = (r.pts[i + 1] - oz) * k; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke();
  }
}

/** Vehicles: GLB loading + normalisation, paint variants, wheel splitting, lights, siren, smoke and the per-vehicle rig. */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { VEHICLES, seatOffset, type VehicleEnt, type VehicleModel } from '@blockshore/shared';
import { Bin, canvas2d, clamp, damp, lerpAngle, smoothTexture } from './util';
import { GLB_SPECS, MODEL_FILE, type GlassRule, type GlbSpec, type TintSpec } from './vehicleModels';
import { getVoxelProto } from './voxelVehicles';

export const MODELS: VehicleModel[] = Object.keys(MODEL_FILE) as VehicleModel[];

// ───────────────────────────────────────────────────────────── protos & materials
interface SlotDef { mat: THREE.MeshLambertMaterial; tint: 'none' | 'color' | 'shader'; spec?: TintSpec; glass?: boolean }
interface ProtoPart { geo: THREE.BufferGeometry; slot: string }
interface WheelPart { pos: THREE.Vector3; parts: ProtoPart[]; front: boolean; r: number; scale?: THREE.Vector3; extra?: THREE.BufferGeometry }
export interface VehicleProto {
  key: string; model: VehicleModel; kind: 'glb' | 'voxel';
  slots: Record<string, SlotDef>;
  parts: ProtoPart[];
  wheels: WheelPart[];
  length: number; width: number; height: number;
  enclosed: boolean; spec: GlbSpec;
  /** has see-through window glass: occupants are drawn, so they sit lower to fit under the roof */
  glassy?: boolean;
}

/** how far a seated character is lowered so the head stays under the roof of a glass-windowed model */
export function occupantDrop(proto: VehicleProto, up: number): number {
  if (!proto.glassy) return 0;
  return Math.max(0, Math.min(0.5, (up - 0.45 + 1.55) - (proto.height - 0.08)));
}

const _c = new THREE.Color();
const TINT_VERT_KEY = 'vtint1';

function patchTint(m: THREE.MeshLambertMaterial, spec: TintSpec, col: number) {
  if (spec.mode !== 'hue' && spec.mode !== 'light') return;
  const key = new THREE.Color(spec.key); // linear
  const mx = Math.max(key.r, key.g, key.b, 1e-4);
  const u = {
    uKeyCh: { value: new THREE.Vector3(key.r / mx, key.g / mx, key.b / mx) },
    uKeyMax: { value: mx },
    uKeyLum: { value: key.r * 0.2126 + key.g * 0.7152 + key.b * 0.0722 },
    uTint: { value: new THREE.Color(col) },
    uTol: { value: spec.mode === 'hue' ? spec.tol : 0.3 },
    uMode: { value: spec.mode === 'hue' ? 0 : 1 },
  };
  m.userData.tint = u;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uKeyCh; uniform float uKeyMax; uniform float uKeyLum; uniform vec3 uTint; uniform float uTol; uniform float uMode;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 c0 = diffuseColor.rgb;
          float mx0 = max(c0.r, max(c0.g, c0.b)); float mn0 = min(c0.r, min(c0.g, c0.b));
          float sat0 = (mx0 - mn0) / max(mx0, 1e-4);
          float msk = 0.0; float sc = 1.0;
          if (uMode < 0.5) {
            float d0 = distance(c0 / max(mx0, 1e-4), uKeyCh);
            msk = (1.0 - smoothstep(uTol * 0.5, uTol, d0)) * smoothstep(0.22, 0.38, sat0);
            sc = mx0 / uKeyMax;
          } else {
            float lum0 = dot(c0, vec3(0.2126, 0.7152, 0.0722));
            msk = smoothstep(uKeyLum * 0.5, uKeyLum * 0.78, lum0) * (1.0 - smoothstep(0.06, 0.16, sat0));
            sc = lum0 / uKeyLum;
          }
          diffuseColor.rgb = mix(c0, uTint * sc, msk);
        }`);
  };
  m.customProgramCacheKey = () => TINT_VERT_KEY;
}

const variantCache = new Map<string, THREE.Material>();
const variantBin = new Bin();
/** state: 0 normal, 1 wreck, 2 ghost */
export function slotMaterial(proto: VehicleProto, slot: string, col: number, state: number): THREE.Material {
  const sd = proto.slots[slot];
  const tinted = sd.tint !== 'none';
  const key = `${proto.key}|${slot}|${state}|${tinted ? col : 0}`;
  let m = variantCache.get(key);
  if (m) return m;
  const mat = sd.mat.clone() as THREE.MeshLambertMaterial;
  if (sd.glass) {
    if (proto.kind === 'glb') { mat.map = null; mat.vertexColors = false; mat.side = THREE.FrontSide; }
    mat.transparent = true; mat.opacity = proto.kind === 'glb' ? 0.3 : 0.42; mat.depthWrite = false; mat.color.set('#2e5163');
    mat.emissive.set('#0a141c');
  }
  if (state === 1) {
    if (sd.glass) { mat.color.multiplyScalar(0.5); mat.opacity = 0.8; }
    else { const c = mat.color; const l = (c.r * 0.3 + c.g * 0.59 + c.b * 0.11) * 0.22 + 0.012; c.setRGB(l * 1.12, l, l * 0.9); }
  } else {
    if (sd.tint === 'color') mat.color.set(col);
    else if (sd.tint === 'shader' && sd.spec) patchTint(mat, sd.spec, col);
  }
  if (state === 2) { mat.transparent = true; mat.opacity = sd.glass ? 0.2 : 0.36; mat.depthWrite = false; }
  variantBin.add(mat);
  variantCache.set(key, mat);
  return mat;
}

// ───────────────────────────────────────────────────────────── GLB processing
function unionFind(n: number) {
  const p = new Int32Array(n); for (let i = 0; i < n; i++) p[i] = i;
  const find = (a: number): number => { while (p[a] !== a) { p[a] = p[p[a]]; a = p[a]; } return a; };
  return { find, union: (a: number, b: number) => { a = find(a); b = find(b); if (a !== b) p[a] = b; } };
}

interface Comp { geo: THREE.BufferGeometry; slot: string; box: THREE.Box3 }

/** split a non-indexed geometry into connected components (vertices welded by position) */
function components(geo: THREE.BufferGeometry, slot: string): Comp[] {
  const pos = geo.attributes.position;
  const tris = pos.count / 3;
  const ids = new Map<string, number>();
  const vid = new Int32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const k = Math.round(pos.getX(i) * 400) + ',' + Math.round(pos.getY(i) * 400) + ',' + Math.round(pos.getZ(i) * 400);
    let id = ids.get(k);
    if (id === undefined) { id = ids.size; ids.set(k, id); }
    vid[i] = id;
  }
  const uf = unionFind(ids.size);
  for (let t = 0; t < tris; t++) { uf.union(vid[t * 3], vid[t * 3 + 1]); uf.union(vid[t * 3], vid[t * 3 + 2]); }
  const groups = new Map<number, number[]>();
  for (let t = 0; t < tris; t++) { const r = uf.find(vid[t * 3]); let a = groups.get(r); if (!a) groups.set(r, (a = [])); a.push(t); }
  const out: Comp[] = [];
  const names = Object.keys(geo.attributes);
  for (const tl of groups.values()) {
    const g = new THREE.BufferGeometry();
    for (const n of names) {
      const src = geo.attributes[n] as THREE.BufferAttribute; const sz = src.itemSize;
      const arr = new Float32Array(tl.length * 3 * sz);
      let o = 0;
      for (const t of tl) for (let v = 0; v < 3; v++) for (let c = 0; c < sz; c++) arr[o++] = src.getComponent(t * 3 + v, c);
      g.setAttribute(n, new THREE.BufferAttribute(arr, sz));
    }
    g.computeBoundingBox();
    out.push({ geo: g, slot, box: g.boundingBox!.clone() });
  }
  return out;
}

function mergeComps(list: Comp[]): THREE.BufferGeometry | null {
  if (!list.length) return null;
  if (list.length === 1) return list[0].geo;
  return mergeGeometries(list.map((c) => c.geo), false);
}

function subGeo(geo: THREE.BufferGeometry, tris: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const n of Object.keys(geo.attributes)) {
    const src = geo.attributes[n] as THREE.BufferAttribute; const sz = src.itemSize;
    const arr = new Float32Array(tris.length * 3 * sz);
    let o = 0;
    for (const t of tris) for (let v = 0; v < 3; v++) for (let c = 0; c < sz; c++) arr[o++] = src.getComponent(t * 3 + v, c);
    g.setAttribute(n, new THREE.BufferAttribute(arr, sz));
  }
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

/** colour of the texel under uv (0-255), or null when the image is not readable */
function texReader(map: THREE.Texture | null): ((u: number, v: number) => [number, number, number]) | null {
  const img = map?.image as CanvasImageSource & { width: number; height: number } | undefined;
  if (!img || !img.width) return null;
  try {
    const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
    const cx = cv.getContext('2d', { willReadFrequently: true })!; cx.drawImage(img, 0, 0);
    const data = cx.getImageData(0, 0, cv.width, cv.height).data;
    const flipY = map!.flipY;
    return (u, v) => {
      const fu = ((u % 1) + 1) % 1, fv = ((v % 1) + 1) % 1;
      const x = Math.min(cv.width - 1, Math.floor(fu * cv.width)), y = Math.min(cv.height - 1, Math.floor((flipY ? 1 - fv : fv) * cv.height));
      const i = (y * cv.width + x) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    };
  } catch { return null; }
}

/**
 * Pull window triangles out of the merged body geometry into their own `glass` slots (see GlassRule in vehicleModels.ts).
 * Returns whether any glass was found.
 */
function splitGlass(merged: { slot: string; geo: THREE.BufferGeometry }[], srcBySlot: Map<string, THREE.MeshStandardMaterial>, slots: Record<string, SlotDef>, rules: GlassRule[], H: number): boolean {
  let found = false;
  const add: { slot: string; geo: THREE.BufferGeometry }[] = [];
  for (const m of [...merged]) {
    const src = srcBySlot.get(m.slot)!;
    const pos = m.geo.attributes.position, col = m.geo.attributes.color, uv = m.geo.attributes.uv;
    const read = rules.some((r) => r.tex) ? texReader(src.map) : null;
    const n = pos.count / 3;
    const glass: number[] = [], keep: number[] = [];
    for (let t = 0; t < n; t++) {
      const y = (pos.getY(t * 3) + pos.getY(t * 3 + 1) + pos.getY(t * 3 + 2)) / 3 / H;
      let hit = false;
      for (const r of rules) {
        if (r.mat && src.name !== r.mat) continue;
        if (r.minY != null && y < r.minY) continue;
        if (r.maxY != null && y > r.maxY) continue;
        if (r.vcolor) {
          if (!col) continue;
          const tol = (r.vtol ?? 6) / 255;
          if (Math.abs(col.getX(t * 3) - r.vcolor[0] / 255) > tol || Math.abs(col.getY(t * 3) - r.vcolor[1] / 255) > tol || Math.abs(col.getZ(t * 3) - r.vcolor[2] / 255) > tol) continue;
        }
        if (r.tex) {
          if (!read || !uv) continue;
          const c = read((uv.getX(t * 3) + uv.getX(t * 3 + 1) + uv.getX(t * 3 + 2)) / 3, (uv.getY(t * 3) + uv.getY(t * 3 + 1) + uv.getY(t * 3 + 2)) / 3);
          const tol = r.ttol ?? 8;
          if (Math.abs(c[0] - r.tex[0]) > tol || Math.abs(c[1] - r.tex[1]) > tol || Math.abs(c[2] - r.tex[2]) > tol) continue;
        }
        hit = true; break;
      }
      (hit ? glass : keep).push(t);
    }
    if (!glass.length) continue;
    found = true;
    const gslot = 'glass:' + m.slot;
    slots[gslot] = { mat: slots[m.slot].mat, tint: 'none', glass: true };
    add.push({ slot: gslot, geo: glass.length === n ? m.geo : subGeo(m.geo, glass) });
    if (glass.length === n) merged.splice(merged.indexOf(m), 1);
    else m.geo = subGeo(m.geo, keep);
  }
  merged.push(...add);
  return found;
}

const wheelReport: Record<string, unknown> = {};

function buildGlbProto(model: VehicleModel, scene: THREE.Object3D): VehicleProto {
  const spec = GLB_SPECS[model];
  const def = VEHICLES[model];
  scene.updateMatrixWorld(true);
  // 1. flatten + group by material
  const groups = new Map<THREE.Material, THREE.BufferGeometry[]>();
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const g = m.geometry.clone();
    g.applyMatrix4(m.matrixWorld);
    const mat = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.Material;
    let a = groups.get(mat); if (!a) groups.set(mat, (a = []));
    a.push(g);
  });
  const rot = new THREE.Matrix4().makeRotationY(spec.yaw);
  const slots: Record<string, SlotDef> = {};
  const srcBySlot = new Map<string, THREE.MeshStandardMaterial>();
  let merged: { slot: string; geo: THREE.BufferGeometry }[] = [];
  let si = 0;
  for (const [mat, geos] of groups) {
    // common attribute set (position, normal, uv, color), all non-indexed
    const keep = ['position', 'normal', 'uv', 'color'].filter((n) => geos.every((g) => g.attributes[n]));
    const clean = geos.map((g) => {
      const ng = g.index ? g.toNonIndexed() : g;
      for (const n of Object.keys(ng.attributes)) if (!keep.includes(n)) ng.deleteAttribute(n);
      return ng;
    });
    const geo = clean.length === 1 ? clean[0] : mergeGeometries(clean, false);
    if (!geo) continue;
    if (!geo.attributes.normal) geo.computeVertexNormals();
    geo.applyMatrix4(rot);
    const src = mat as THREE.MeshStandardMaterial;
    const hasVC = !!geo.attributes.color;
    const lm = new THREE.MeshLambertMaterial({
      map: src.map ?? null, color: hasVC ? new THREE.Color(1, 1, 1) : src.color.clone(), vertexColors: hasVC,
      transparent: src.transparent || src.opacity < 1, opacity: src.opacity, side: src.side === THREE.DoubleSide ? THREE.DoubleSide : THREE.FrontSide,
    });
    if (src.map) { src.map.anisotropy = 4; src.map.magFilter = THREE.NearestFilter; src.map.minFilter = THREE.NearestMipmapLinearFilter; src.map.generateMipmaps = true; src.map.needsUpdate = true; }
    const name = (src.name || 'mat') + '#' + si++;
    let tint: SlotDef['tint'] = 'none';
    const ts = spec.tint;
    if (ts.mode === 'mat' && (src.name === ts.mat)) tint = 'color';
    else if (ts.mode === 'hue' || ts.mode === 'light') tint = 'shader';
    slots[name] = { mat: lm, tint, spec: tint === 'shader' ? ts : undefined };
    srcBySlot.set(name, src);
    merged.push({ slot: name, geo });
  }
  // 2. normalise: scale by length (z), centre x/z, drop to floor
  const box = new THREE.Box3();
  for (const m of merged) { m.geo.computeBoundingBox(); box.union(m.geo.boundingBox!); }
  const size = box.getSize(new THREE.Vector3());
  const s = def.length / size.z;
  const ctr = box.getCenter(new THREE.Vector3());
  const tf = new THREE.Matrix4().makeTranslation(-ctr.x * s, spec.floor - box.min.y * s, -ctr.z * s).multiply(new THREE.Matrix4().makeScale(s, s, s));
  for (const m of merged) { m.geo.applyMatrix4(tf); m.geo.computeBoundingBox(); m.geo.computeBoundingSphere(); }
  const dims = new THREE.Vector3(size.x * s, size.y * s, size.z * s);
  // 2b. window glass -> see-through slots so seated occupants show
  const hasGlass = !!spec.glass?.length && splitGlass(merged, srcBySlot, slots, spec.glass, dims.y);
  if (spec.glass?.length && !hasGlass) console.warn('[entities] glass rules matched nothing for', model);

  // 3. wheels
  const wheels: WheelPart[] = [];
  let parts: ProtoPart[] = merged.map((m) => ({ geo: m.geo, slot: m.slot }));
  const expected = model === 'moto' ? 2 : spec.wheelDetect ? 4 : 0;
  if (expected) {
    try {
      const comps: Comp[] = [];
      for (const m of merged) comps.push(...components(m.geo, m.slot));
      const L = dims.z, H = dims.y, W = dims.x;
      const cands = comps.filter((c) => {
        const dx = c.box.max.x - c.box.min.x, dy = c.box.max.y - c.box.min.y, dz = c.box.max.z - c.box.min.z;
        const cx = (c.box.max.x + c.box.min.x) / 2;
        const lowest = c.box.min.y < spec.floor + H * 0.12;
        const round = Math.abs(dy - dz) < 0.3 * Math.max(dy, dz);
        const sized = dy > L * 0.065 && dy < L * 0.3;
        const outboard = model === 'moto' ? Math.abs(cx) < W * 0.2 : Math.abs(cx) > W * 0.22;
        const thin = dx < Math.max(dy, dz) * (model === 'moto' ? 0.7 : 0.95);
        return lowest && round && sized && outboard && thin;
      });
      wheelReport[model] = { comps: comps.length, cands: cands.length, expected, sample: cands.slice(0, 6).map((c) => c.box.min.toArray().map((v) => +v.toFixed(2)).join(',') + '>' + c.box.max.toArray().map((v) => +v.toFixed(2)).join(',')) };
      if (cands.length === expected) {
        // attach any component (any material) whose centre falls inside a wheel's inflated box
        const used = new Set<Comp>();
        const wheelParts: { cand: Comp; members: Comp[] }[] = cands.map((cd) => ({ cand: cd, members: [cd] }));
        for (const w of wheelParts) used.add(w.cand);
        const inflate = (b: THREE.Box3) => b.clone().expandByScalar(Math.max(b.max.y - b.min.y, 0.1) * 0.08);
        for (const c of comps) {
          if (used.has(c)) continue;
          const cc = c.box.getCenter(new THREE.Vector3());
          const csize = c.box.getSize(new THREE.Vector3());
          for (const w of wheelParts) {
            if (inflate(w.cand.box).containsPoint(cc) && csize.y < (w.cand.box.max.y - w.cand.box.min.y) * 1.05) { w.members.push(c); used.add(c); break; }
          }
        }
        const rest = comps.filter((c) => !used.has(c));
        const restBySlot = new Map<string, Comp[]>();
        for (const c of rest) { let a = restBySlot.get(c.slot); if (!a) restBySlot.set(c.slot, (a = [])); a.push(c); }
        parts = [];
        for (const [slot, list] of restBySlot) { const g = mergeComps(list); if (g) parts.push({ geo: g, slot }); }
        for (const w of wheelParts) {
          const bb = w.cand.box;
          const center = bb.getCenter(new THREE.Vector3());
          const wp: ProtoPart[] = [];
          const bySlot = new Map<string, Comp[]>();
          for (const c of w.members) { let a = bySlot.get(c.slot); if (!a) bySlot.set(c.slot, (a = [])); a.push(c); }
          for (const [slot, list] of bySlot) { const g = mergeComps(list); if (g) { g.translate(-center.x, -center.y, -center.z); wp.push({ geo: g, slot }); } }
          wheels.push({ pos: center, parts: wp, front: center.z < 0, r: (bb.max.y - bb.min.y) / 2 });
        }
      }
    } catch (e) { console.warn('[entities] wheel split failed for', model, e); wheels.length = 0; parts = merged.map((m) => ({ geo: m.geo, slot: m.slot })); }
  }
  merged = [];
  return { key: 'glb:' + model, model, kind: 'glb', slots, parts, wheels, length: dims.z, width: dims.x, height: dims.y, enclosed: spec.enclosed && !hasGlass, glassy: hasGlass, spec };
}

function buildVoxelProto(model: VehicleModel): VehicleProto {
  const v = getVoxelProto(model);
  const spec = GLB_SPECS[model];
  const mk = (vc: boolean, color = '#ffffff') => new THREE.MeshLambertMaterial({ vertexColors: vc, color });
  const slots: Record<string, SlotDef> = {
    body: { mat: mk(true), tint: 'color' },
    trim: { mat: mk(true), tint: 'none' },
    glass: { mat: mk(true), tint: 'none', glass: true },
  };
  const parts: ProtoPart[] = [];
  if (v.body) parts.push({ geo: v.body, slot: 'body' });
  parts.push({ geo: v.trim, slot: 'trim' });
  if (v.glass) parts.push({ geo: v.glass, slot: 'glass' });
  const wheels: WheelPart[] = v.wheels.map((w) => ({
    pos: new THREE.Vector3(w.x, w.y, w.z), parts: [{ geo: v.wheelGeo, slot: 'trim' }], front: w.front, r: w.r,
    scale: new THREE.Vector3(w.w, w.r * 2, w.r * 2), extra: w.extra,
  }));
  return { key: 'vox:' + model, model, kind: 'voxel', slots, parts, wheels, length: v.length, width: v.width, height: v.height, enclosed: false, spec };
}

// ───────────────────────────────────────────────────────────── smoke / fire particles
export class SmokeFX {
  readonly points: THREE.Points;
  private N = 700;
  private pos = new Float32Array(this.N * 3);
  private vel = new Float32Array(this.N * 3);
  private age = new Float32Array(this.N);
  private life = new Float32Array(this.N);
  private size = new Float32Array(this.N);
  private kind = new Float32Array(this.N); // 0 smoke 1 fire
  private aAge: THREE.BufferAttribute; private aSize: THREE.BufferAttribute; private aKind: THREE.BufferAttribute; private aPos: THREE.BufferAttribute;
  private head = 0;
  private mat: THREE.ShaderMaterial;
  private geo = new THREE.BufferGeometry();
  constructor(private L: { night: { value: number } }) {
    for (let i = 0; i < this.N; i++) { this.age[i] = 1; this.life[i] = 1; this.pos[i * 3 + 1] = -1000; }
    this.aPos = new THREE.BufferAttribute(this.pos, 3); this.aPos.setUsage(THREE.DynamicDrawUsage);
    this.aAge = new THREE.BufferAttribute(new Float32Array(this.N), 1); this.aAge.setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1); this.aSize.setUsage(THREE.DynamicDrawUsage);
    this.aKind = new THREE.BufferAttribute(this.kind, 1); this.aKind.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.aPos); this.geo.setAttribute('aAge', this.aAge); this.geo.setAttribute('aSize', this.aSize); this.geo.setAttribute('aKind', this.aKind);
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, toneMapped: false,
      uniforms: { uScale: { value: 500 }, uNight: this.L.night as { value: number } },
      vertexShader: `attribute float aAge; attribute float aSize; attribute float aKind; uniform float uScale; varying float vAge; varying float vKind;
        void main(){ vAge=aAge; vKind=aKind; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_Position = projectionMatrix*mv; gl_PointSize = aSize*(0.6+aAge*1.4)*uScale/max(0.5,-mv.z); }`,
      fragmentShader: `varying float vAge; varying float vKind; uniform float uNight;
        void main(){ vec2 p = gl_PointCoord-0.5; float d = length(p)*2.0; if(d>1.0) discard;
          float soft = smoothstep(1.0,0.2,d);
          if (vKind > 0.5) { vec3 c = mix(vec3(3.2,1.7,0.35), vec3(1.2,0.18,0.04), vAge); gl_FragColor = vec4(c, soft*(1.0-vAge)*0.85); }
          else { float g = mix(0.32,0.1,vAge); g = mix(g, 0.05, uNight*0.5); gl_FragColor = vec4(vec3(g), soft*(1.0-vAge)*0.62); } }`,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false; this.points.renderOrder = 5;
  }
  emit(x: number, y: number, z: number, fire: boolean) {
    const i = this.head; this.head = (this.head + 1) % this.N;
    this.pos[i * 3] = x + (Math.random() - 0.5) * 0.4; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z + (Math.random() - 0.5) * 0.4;
    this.vel[i * 3] = (Math.random() - 0.5) * 0.5; this.vel[i * 3 + 1] = fire ? 1.4 + Math.random() : 1.1 + Math.random() * 0.9; this.vel[i * 3 + 2] = (Math.random() - 0.5) * 0.5;
    this.age[i] = 0; this.life[i] = fire ? 0.5 + Math.random() * 0.4 : 1.6 + Math.random() * 1.4;
    this.size[i] = fire ? 0.45 + Math.random() * 0.3 : 0.7 + Math.random() * 0.5; this.kind[i] = fire ? 1 : 0;
  }
  update(dt: number, viewH: number, fov: number) {
    this.mat.uniforms.uScale.value = viewH / (2 * Math.tan((fov * Math.PI) / 360));
    const a = this.aAge.array as Float32Array;
    for (let i = 0; i < this.N; i++) {
      if (this.age[i] >= 1) { a[i] = 1; this.pos[i * 3 + 1] = -1000; continue; }
      this.age[i] += dt / this.life[i];
      this.pos[i * 3] += this.vel[i * 3] * dt; this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt; this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      this.vel[i * 3 + 1] *= 1 - 0.3 * dt;
      a[i] = Math.min(1, this.age[i]);
    }
    this.aPos.needsUpdate = true; this.aAge.needsUpdate = true; this.aSize.needsUpdate = true; this.aKind.needsUpdate = true;
  }
  dispose() { this.geo.dispose(); this.mat.dispose(); }
}

// ───────────────────────────────────────────────────────────── shared light assets
export class VehicleAssets {
  bin = new Bin();
  flareTex: THREE.CanvasTexture;
  headMat: THREE.SpriteMaterial; tailMat: THREE.SpriteMaterial; brakeMat: THREE.SpriteMaterial; redFlare: THREE.SpriteMaterial; blueFlare: THREE.SpriteMaterial;
  lampMat: THREE.MeshBasicMaterial; tailLampMat: THREE.MeshBasicMaterial; brakeLampMat: THREE.MeshBasicMaterial;
  sirenRed: THREE.MeshBasicMaterial; sirenBlue: THREE.MeshBasicMaterial;
  lampGeo: THREE.PlaneGeometry; sirenGeo: THREE.BoxGeometry;
  beamGeo: THREE.BufferGeometry; beamMat: THREE.MeshBasicMaterial;
  glowTex: THREE.CanvasTexture; glowGeo: THREE.PlaneGeometry; glowRed: THREE.MeshBasicMaterial; glowBlue: THREE.MeshBasicMaterial;
  constructor() {
    const [c, ctx] = canvas2d(64, 64);
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.2, 'rgba(255,255,255,0.7)'); g.addColorStop(0.5, 'rgba(255,255,255,0.18)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
    this.flareTex = this.bin.add(smoothTexture(c));
    const sm = (color: number, intensity: number) => this.bin.add(new THREE.SpriteMaterial({ map: this.flareTex, color: new THREE.Color(color).multiplyScalar(intensity), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false }));
    this.headMat = sm(0xfff2cc, 1); this.tailMat = sm(0xff2018, 1); this.brakeMat = sm(0xff2018, 1.8); this.redFlare = sm(0xff2a1a, 1); this.blueFlare = sm(0x2a62ff, 1);
    const bm = (color: number, k: number) => this.bin.add(new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(k), toneMapped: false, transparent: true, side: THREE.DoubleSide }));
    this.lampMat = bm(0xfff4d6, 1); this.tailLampMat = bm(0xff2018, 1); this.brakeLampMat = bm(0xff3a2a, 2);
    this.sirenRed = bm(0xff1a1a, 5); this.sirenBlue = bm(0x1a4cff, 5);
    this.lampGeo = this.bin.add(new THREE.PlaneGeometry(0.34, 0.17));
    this.sirenGeo = this.bin.add(new THREE.BoxGeometry(0.5, 0.16, 0.3));
    // headlight beam on the ground: triangle fan with alpha falling off
    const bg = new THREE.BufferGeometry();
    const pos = [0, 0, 0, -0.9, 0, -14, 0.9, 0, -14, -3.4, 0, -18, 3.4, 0, -18];
    const col = [1, 1, 1, 0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0, 0, 0, 0, 0, 0];
    bg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    bg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    bg.setIndex([0, 2, 1, 1, 2, 3, 2, 4, 3]);
    this.beamGeo = this.bin.add(bg);
    this.beamMat = this.bin.add(new THREE.MeshBasicMaterial({ vertexColors: true, color: 0xffeeb0, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    this.glowTex = this.flareTex;
    this.glowGeo = this.bin.add(new THREE.PlaneGeometry(9, 9)); this.glowGeo.rotateX(-Math.PI / 2);
    const gm = (color: number) => this.bin.add(new THREE.MeshBasicMaterial({ map: this.flareTex, color, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    this.glowRed = gm(0xff2a1a); this.glowBlue = gm(0x2a62ff);
  }
  dispose() { this.bin.disposeAll(); }
}

// ───────────────────────────────────────────────────────────── rig
interface MeshSlot { mesh: THREE.Mesh; slot: string }
interface WheelRig { pivot: THREE.Group; spin: THREE.Group; slots: MeshSlot[]; front: boolean; r: number; angle: number }

const _v = new THREE.Vector3();

export class VehicleRig {
  readonly root = new THREE.Group();
  readonly tilt = new THREE.Group();
  readonly seats = new THREE.Group();
  readonly meshes: MeshSlot[] = [];
  readonly wheels: WheelRig[] = [];
  proto: VehicleProto;
  id: string; model: VehicleModel;
  col = -1; hp = 100; ghost = false; siren = false; wreck = false;
  private variantKey = '';
  // visual pose
  px = 0; py = 0; pz = 0; yaw = 0; pitch = 0; roll = 0; bob = 0;
  tx = 0; ty = 0; tz = 0; tyaw = 0; sp = 0; st = 0; prevSp = 0; accel = 0;
  init = false;
  phase = Math.random() * 10;
  private headL: THREE.Sprite[] = []; private tailL: THREE.Sprite[] = [];
  private lampH: THREE.Mesh[] = []; private lampT: THREE.Mesh[] = [];
  private beam: THREE.Mesh | null = null;
  private sirenR: THREE.Mesh | null = null; private sirenB: THREE.Mesh | null = null;
  private sirenFlareR: THREE.Sprite | null = null; private sirenFlareB: THREE.Sprite | null = null;
  private glowR: THREE.Mesh | null = null; private glowB: THREE.Mesh | null = null;
  private emit = 0;
  braking = false;
  label: THREE.Sprite | null = null; labelKey = '';

  constructor(readonly sys: Vehicles, id: string, model: VehicleModel, proto: VehicleProto) {
    this.id = id; this.model = model; this.proto = proto;
    this.root.add(this.tilt); this.tilt.add(this.seats);
    this.build();
  }

  private build() {
    const P = this.proto, A = this.sys.assets;
    for (const p of P.parts) { const m = new THREE.Mesh(p.geo, undefined); m.frustumCulled = true; this.tilt.add(m); this.meshes.push({ mesh: m, slot: p.slot }); }
    for (const w of P.wheels) {
      const pivot = new THREE.Group(); pivot.position.copy(w.pos); pivot.rotation.order = 'YXZ';
      const spin = new THREE.Group(); pivot.add(spin);
      const slots: MeshSlot[] = [];
      for (const p of w.parts) { const m = new THREE.Mesh(p.geo, undefined); if (w.scale) m.scale.copy(w.scale); spin.add(m); slots.push({ mesh: m, slot: p.slot }); }
      if (w.extra) { const m = new THREE.Mesh(w.extra, undefined); pivot.add(m); slots.push({ mesh: m, slot: 'trim' }); }
      this.tilt.add(pivot);
      this.wheels.push({ pivot, spin, slots, front: w.front, r: w.r, angle: 0 });
    }
    // lights
    const sp = P.spec.lights, L = P.length, W = P.width, H = P.height;
    const hx = sp.hx * W / 2, hy = sp.hy * H, hz = -sp.hz * L / 2, tx = sp.tx * W / 2, ty = sp.ty * H, tz = sp.tz * L / 2;
    const single = P.model === 'moto';
    for (const sx of single ? [0] : [-1, 1]) {
      const h = new THREE.Sprite(A.headMat); h.position.set(sx * hx, hy, hz - 0.02); this.tilt.add(h); this.headL.push(h);
      const t = new THREE.Sprite(A.tailMat); t.position.set(sx * tx, ty, tz + 0.02); this.tilt.add(t); this.tailL.push(t);
      const lh = new THREE.Mesh(A.lampGeo, A.lampMat); lh.position.set(sx * hx, hy, hz - 0.012); lh.rotation.y = Math.PI; this.tilt.add(lh); this.lampH.push(lh);
      const lt = new THREE.Mesh(A.lampGeo, A.tailLampMat); lt.position.set(sx * tx, ty, tz + 0.012); this.tilt.add(lt); this.lampT.push(lt);
      if (single) { lh.scale.setScalar(0.6); lt.scale.set(0.5, 0.5, 1); }
    }
    this.beam = new THREE.Mesh(A.beamGeo, A.beamMat); this.beam.position.set(0, 0.08, hz); this.beam.scale.set(Math.max(0.5, W / 2.2), 1, 1); this.beam.visible = false; this.beam.frustumCulled = false; this.tilt.add(this.beam);
    // siren (lazily visible)
    const rf = P.spec.roof, ry = rf.y * H + 0.04, rz = rf.z * L / 2, rw = rf.w * W;
    this.sirenR = new THREE.Mesh(A.sirenGeo, A.sirenRed); this.sirenR.position.set(-rw * 0.5, ry, rz); this.sirenR.visible = false; this.tilt.add(this.sirenR);
    this.sirenB = new THREE.Mesh(A.sirenGeo, A.sirenBlue); this.sirenB.position.set(rw * 0.5, ry, rz); this.sirenB.visible = false; this.tilt.add(this.sirenB);
    this.sirenFlareR = new THREE.Sprite(A.redFlare); this.sirenFlareR.position.set(-rw * 0.5, ry + 0.15, rz); this.sirenFlareR.scale.setScalar(2.4); this.sirenFlareR.visible = false; this.tilt.add(this.sirenFlareR);
    this.sirenFlareB = new THREE.Sprite(A.blueFlare); this.sirenFlareB.position.set(rw * 0.5, ry + 0.15, rz); this.sirenFlareB.scale.setScalar(2.4); this.sirenFlareB.visible = false; this.tilt.add(this.sirenFlareB);
    this.glowR = new THREE.Mesh(A.glowGeo, A.glowRed); this.glowR.position.set(-1.2, 0.1, rz); this.glowR.visible = false; this.glowR.scale.setScalar(L / 4.5); this.root.add(this.glowR);
    this.glowB = new THREE.Mesh(A.glowGeo, A.glowBlue); this.glowB.position.set(1.2, 0.1, rz); this.glowB.visible = false; this.glowB.scale.setScalar(L / 4.5); this.root.add(this.glowB);
    this.applyMaterials(true);
  }

  applyMaterials(force = false) {
    const state = this.hp <= 0 ? 1 : this.ghost ? 2 : 0;
    const key = state + '|' + this.col;
    if (!force && key === this.variantKey) return;
    this.variantKey = key;
    this.wreck = state === 1;
    for (const ms of this.meshes) ms.mesh.material = slotMaterial(this.proto, ms.slot, this.col, state);
    for (const w of this.wheels) for (const ms of w.slots) ms.mesh.material = slotMaterial(this.proto, ms.slot, this.col, state);
  }

  setTarget(e: VehicleEnt) {
    this.tx = e.x; this.ty = e.y; this.tz = e.z; this.tyaw = e.yaw; this.sp = e.sp; this.st = e.st;
    if (e.col !== this.col || e.hp !== this.hp || !!e.ghost !== this.ghost) { this.col = e.col; this.hp = e.hp; this.ghost = !!e.ghost; this.applyMaterials(); }
    this.siren = !!e.siren;
  }

  /** seat anchor (hip pivot) in vehicle local space */
  seatLocal(out: THREE.Vector3, up: number, right: number, forward: number) { out.set(right, up, -forward); }

  update(dt: number, t: number, night: number, dist: number) {
    const A = this.sys.assets;
    if (!this.init) { this.px = this.tx; this.py = this.ty; this.pz = this.tz; this.yaw = this.tyaw; this.init = true; }
    const dx = this.tx - this.px, dz = this.tz - this.pz;
    if (dx * dx + dz * dz > 36 || Math.abs(this.ty - this.py) > 8) { this.px = this.tx; this.py = this.ty; this.pz = this.tz; this.yaw = this.tyaw; }
    else {
      const k = 1 - Math.exp(-22 * dt);
      this.px += dx * k; this.pz += dz * k; this.py += (this.ty - this.py) * (1 - Math.exp(-16 * dt));
      this.yaw = lerpAngle(this.yaw, this.tyaw, 1 - Math.exp(-20 * dt));
    }
    const boat = this.model === 'boat', bike = this.model === 'moto';
    // pitch/roll from acceleration + steering
    this.accel = damp(this.accel, dt > 0 ? (this.sp - this.prevSp) / dt : 0, 6, dt);
    this.prevSp = this.sp;
    this.braking = this.accel < -4 && this.sp > 1;
    let pitchT = clamp(this.accel * 0.0045, -0.05, 0.05);
    let rollT = bike ? clamp(-this.st * Math.abs(this.sp) * 0.018, -0.55, 0.55) : clamp(this.st * Math.abs(this.sp) * 0.0016, -0.06, 0.06);
    let by = 0;
    if (boat) {
      const s = Math.min(1, Math.abs(this.sp) / 20);
      by = Math.sin(t * 1.7 + this.phase) * 0.07 + Math.sin(t * 2.9 + this.phase * 2) * 0.03;
      pitchT += Math.sin(t * 1.3 + this.phase) * 0.025 + s * 0.06;
      rollT += Math.sin(t * 1.1 + this.phase * 1.7) * 0.035 - this.st * s * 0.12;
    }
    if (this.wreck) { rollT += 0.03; pitchT += 0.02; }
    this.pitch = damp(this.pitch, pitchT, 8, dt); this.roll = damp(this.roll, rollT, 7, dt);
    this.root.position.set(this.px, this.py + by, this.pz);
    this.root.rotation.y = this.yaw;
    this.tilt.rotation.set(this.pitch, 0, this.roll);

    // wheels
    const spinD = (this.sp * dt);
    for (const w of this.wheels) {
      w.angle -= spinD / Math.max(0.15, w.r);
      w.spin.rotation.x = w.angle;
      if (w.front) w.pivot.rotation.y = -this.st * 0.5 * (bike ? 0.5 : 1);
    }

    // lights
    const near = dist < 140;
    const on = night > 0.05;
    const hs = 0.3 + night * 1.0, ts = 0.22 + night * 0.4 + (this.braking ? 0.5 : 0);
    for (const h of this.headL) { h.visible = near && !this.wreck; h.scale.setScalar(hs); }
    for (const l of this.tailL) { l.visible = near && !this.wreck; l.scale.setScalar(ts); (l.material as THREE.SpriteMaterial) !== (this.braking ? A.brakeMat : A.tailMat) && (l.material = this.braking ? A.brakeMat : A.tailMat); }
    for (const l of this.lampH) l.visible = !this.wreck;
    for (const l of this.lampT) { l.visible = !this.wreck; l.material = this.braking ? A.brakeLampMat : A.tailLampMat; }
    if (this.beam) this.beam.visible = on && dist < 90 && !this.wreck && night > 0.2;

    // siren
    const sv = this.siren && !this.wreck;
    if (this.sirenR && this.sirenB && this.sirenFlareR && this.sirenFlareB && this.glowR && this.glowB) {
      const ph = Math.sin(t * 15 + this.phase);
      const r = sv && ph > 0, b = sv && ph <= 0;
      this.sirenR.visible = r; this.sirenFlareR.visible = r && near; this.glowR.visible = r && near;
      this.sirenB.visible = b; this.sirenFlareB.visible = b && near; this.glowB.visible = b && near;
      if (sv) { const k = 0.25 + night * 0.6; (this.glowR.material as THREE.MeshBasicMaterial).opacity = k; (this.glowB.material as THREE.MeshBasicMaterial).opacity = k; }
    }

    // smoke / fire
    const damaged = this.hp < 35;
    if (damaged && dist < 110) {
      const rate = this.wreck ? 22 : 6 + (35 - this.hp) * 0.45;
      this.emit += rate * dt;
      while (this.emit >= 1) {
        this.emit -= 1;
        const hoodZ = -this.proto.length * 0.28;
        _v.set((Math.random() - 0.5) * this.proto.width * 0.5, this.proto.height * 0.62, hoodZ);
        this.tilt.localToWorld(_v);
        this.sys.smoke.emit(_v.x, _v.y, _v.z, this.wreck && Math.random() < 0.45);
      }
    }
  }
}

// ───────────────────────────────────────────────────────────── system
export class Vehicles {
  readonly group = new THREE.Group();
  readonly assets = new VehicleAssets();
  readonly smoke: SmokeFX;
  protos = new Map<VehicleModel, VehicleProto>();
  rigs = new Map<string, VehicleRig>();
  loaded = new Set<VehicleModel>();
  failed: string[] = [];
  forceVoxel = false;
  constructor(L: { night: { value: number } }) {
    this.smoke = new SmokeFX(L);
    this.group.add(this.smoke.points);
  }

  async load(onProgress?: (p: number) => void) {
    const loader = new GLTFLoader();
    let done = 0;
    await Promise.all(MODELS.map(async (m) => {
      try {
        const g = await loader.loadAsync(`/models/${MODEL_FILE[m]}.glb`);
        this.protos.set(m, buildGlbProto(m, g.scene));
        this.loaded.add(m);
      } catch (e) {
        console.warn('[entities] GLB failed, using voxel fallback:', m, e);
        this.failed.push(m);
      } finally { done++; onProgress?.(done / MODELS.length); }
    }));
    (window as unknown as { __wheelReport?: unknown }).__wheelReport = wheelReport;
  }

  proto(m: VehicleModel): VehicleProto {
    if (!this.forceVoxel) { const p = this.protos.get(m); if (p) return p; }
    let p = this.voxProtos.get(m);
    if (!p) { p = buildVoxelProto(m); this.voxProtos.set(m, p); }
    return p;
  }
  private voxProtos = new Map<VehicleModel, VehicleProto>();

  get(id: string, e: VehicleEnt): VehicleRig {
    const model = (e.m in VEHICLES ? e.m : 'sedan') as VehicleModel;
    const p = this.proto(model);
    let r = this.rigs.get(id);
    if (r && (r.proto !== p)) { this.remove(id); r = undefined; }
    if (!r) { r = new VehicleRig(this, id, model, p); this.rigs.set(id, r); this.group.add(r.root); }
    return r;
  }
  remove(id: string) {
    const r = this.rigs.get(id);
    if (!r) return;
    r.root.removeFromParent();
    this.rigs.delete(id);
  }
  dispose() {
    this.assets.dispose(); this.smoke.dispose();
    variantBin.disposeAll(); variantCache.clear();
    for (const p of [...this.protos.values(), ...this.voxProtos.values()]) {
      for (const pt of p.parts) if (p.kind === 'glb') pt.geo.dispose();
      for (const w of p.wheels) for (const pt of w.parts) if (p.kind === 'glb') pt.geo.dispose();
      for (const s of Object.values(p.slots)) { s.mat.map?.dispose(); s.mat.dispose(); }
    }
    this.protos.clear(); this.voxProtos.clear(); this.rigs.clear();
  }
}

// ───────────────────────────────────────────────────────────── get-in / get-out blend (remote players)
/** a walk-to-door + slide-into-seat (enter) or slide-out (exit) animation for a character that is not the local player */
export interface SeatTrans { kind: 'enter' | 'exit'; veh: string; seat: number; t0: number; walk: number; dur: number; from: THREE.Vector3; fromYaw: number; side: number }
export interface SeatPose { x: number; y: number; z: number; yaw: number; anim: number; inSeat: boolean }

const ease = (k: number) => { k = Math.max(0, Math.min(1, k)); return k * k * (3 - 2 * k); };
const lerpYaw = (a: number, b: number, k: number) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return a + d * k; };

/** feet position just outside the seat's door, in world space (follows the rig's visual pose) */
export function doorWorld(rig: VehicleRig, seat: number, side: number, out: THREE.Vector3) {
  const def = VEHICLES[rig.model];
  const [, , sz] = seatOffset(def, seat);
  const rx = Math.cos(rig.yaw), rz = -Math.sin(rig.yaw), fx = -Math.sin(rig.yaw), fz = -Math.cos(rig.yaw);
  const off = def.bike ? 0.75 : def.width / 2 + 0.45;
  return out.set(rig.px + rx * side * off + fx * sz, rig.py + (def.boat ? 0.2 : 0), rig.pz + rz * side * off + fz * sz);
}

/** character root position when seated, in world space (matches EntityRenderer.seat) */
export function seatWorld(rig: VehicleRig, seat: number, out: THREE.Vector3) {
  const def = VEHICLES[rig.model];
  const [sx, sy, sz] = seatOffset(def, seat);
  const rx = Math.cos(rig.yaw), rz = -Math.sin(rig.yaw), fx = -Math.sin(rig.yaw), fz = -Math.cos(rig.yaw);
  return out.set(rig.px + rx * sx + fx * sz, rig.py + sy - (def.bike ? 0.5 : 0.45) + (def.boat ? 0.02 : 0) - occupantDrop(rig.proto, sy), rig.pz + rz * sx + fz * sz);
}

export function seatSide(model: VehicleModel, seat: number) { return seatOffset(VEHICLES[model], seat)[0] >= 0 ? 1 : -1; }

/** start an enter blend from an on-foot position; null when the player is too far away for it to make sense (teleport) */
export function beginSeatEnter(rig: VehicleRig, seat: number, now: number, from: THREE.Vector3, fromYaw: number): SeatTrans | null {
  const def = VEHICLES[rig.model];
  if (Math.hypot(from.x - rig.px, from.z - rig.pz) > def.length / 2 + 6) return null;
  const side = seatSide(rig.model, seat);
  const door = doorWorld(rig, seat, side, new THREE.Vector3());
  const walk = Math.max(0, Math.min(0.55, Math.hypot(door.x - from.x, door.z - from.z) / 4.6));
  const getIn = def.bike ? 0.42 : def.boat ? 0.5 : 0.62;
  return { kind: 'enter', veh: rig.id, seat, t0: now, walk, dur: walk + getIn, from: from.clone(), fromYaw, side };
}

/** start an exit blend from the seat to where the server put the player; null when far apart */
export function beginSeatExit(rig: VehicleRig, seat: number, now: number, to: THREE.Vector3): SeatTrans | null {
  const from = seatWorld(rig, seat, new THREE.Vector3());
  if (Math.hypot(from.x - to.x, from.z - to.z) > 6) return null;
  const def = VEHICLES[rig.model];
  return { kind: 'exit', veh: rig.id, seat, t0: now, walk: 0, dur: def.bike ? 0.36 : def.boat ? 0.45 : 0.52, from, fromYaw: rig.yaw, side: seatSide(rig.model, seat) };
}

const _sa = new THREE.Vector3(), _sb = new THREE.Vector3();
/** pose at `now`, or null when the blend is over. `to` is the live on-foot position (exit target). */
export function stepSeatTrans(t: SeatTrans, rig: VehicleRig, now: number, to: THREE.Vector3): SeatPose | null {
  const el = now - t.t0;
  if (el >= t.dur) return null;
  const out = { x: 0, y: 0, z: 0, yaw: 0, anim: 0, inSeat: false };
  if (t.kind === 'enter') {
    const def = VEHICLES[rig.model];
    doorWorld(rig, t.seat, t.side, _sa);
    const faceIn = rig.yaw + t.side * Math.PI / 2;
    if (el < t.walk) {
      const k = el / Math.max(0.01, t.walk);
      _sb.lerpVectors(t.from, _sa, ease(k));
      const walkYaw = Math.atan2(-(_sa.x - t.from.x), -(_sa.z - t.from.z));
      out.yaw = lerpYaw(lerpYaw(t.fromYaw, walkYaw, Math.min(1, k * 3)), faceIn, ease((k - 0.6) / 0.4));
      out.anim = 1;
    } else {
      const k2 = (el - t.walk) / Math.max(0.01, t.dur - t.walk);
      seatWorld(rig, t.seat, _sb);
      _sb.lerpVectors(_sa, _sb, ease(k2));
      _sb.y += Math.sin(Math.max(0, Math.min(1, k2)) * Math.PI) * (def.bike ? 0.35 : 0.12);
      out.yaw = lerpYaw(faceIn, rig.yaw, ease((k2 - 0.15) / 0.6));
      out.anim = k2 > 0.25 ? 5 : 0; out.inSeat = k2 > 0.55;
    }
  } else {
    const k = el / t.dur;
    seatWorld(rig, t.seat, _sa);
    _sb.lerpVectors(_sa, to, ease(k));
    _sb.y += Math.sin(Math.max(0, Math.min(1, k)) * Math.PI) * 0.12;
    out.yaw = lerpYaw(rig.yaw, rig.yaw - t.side * Math.PI / 2, ease(k * 1.4));
    out.anim = k < 0.45 ? 5 : 0; out.inSeat = k < 0.3;
  }
  out.x = _sb.x; out.y = _sb.y; out.z = _sb.z;
  return out;
}

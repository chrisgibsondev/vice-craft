/**
 * Downloaded voxel weapon GLBs (CC-BY Sketchfab, see public/models/manifest.json) for the first-person view model.
 * Each is normalised to the shared convention: origin = grip, barrel toward -z, top = +y, length = procedural length.
 * Loading is async + cached + failure tolerant: if a model is missing or `enabled` is false the caller keeps the procedural one.
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { getWeaponModel, weaponKind } from './weapons';

export interface WeaponGlbConfig {
  enabled: boolean;
  /** Euler XYZ (radians) applied to the raw scene so the barrel points to -z and the top is +y */
  rot: [number, number, number];
  /** multiplier on the procedural `length` used to size the model along z */
  lenMul: number;
  /** grip point as fractions of the rotated bbox: x 0..1 (left..right), y 0..1 (bottom..top), z 0..1 (rear..front) */
  grip: [number, number, number];
  /** muzzle point, fractions of the bbox */
  muzzle: [number, number, number];
  /** second-hand (forend) point, fractions of the bbox, or null for one-handed weapons */
  fore: [number, number, number] | null;
  /** tint multipliers for untextured/flat models (optional) */
  tint?: number;
  /** flat emissive grey added so near-black textures still read under the view-model lights */
  lift?: number;
  /** raw node names to delete (e.g. arms/outlier markers baked into the model) */
  drop?: string[];
}

export const WEAPON_GLB_CONFIG: Record<string, WeaponGlbConfig> = {
  // sci-fi zapper; raw model faces +z, so turn it round
  stun: { enabled: true, rot: [0, Math.PI, 0], lenMul: 1, grip: [0.5, 0.3, 0.3], muzzle: [0.5, 0.65, 1], fore: null },
  pistol: { enabled: true, rot: [0, Math.PI / 2, 0], tint: 3, lift: 0.03, lenMul: 1, grip: [0.5, 0.5, 0.27], muzzle: [0.5, 0.85, 1], fore: null },
  // raw smg.glb carries two baked-in arms + a stray marker; those nodes are dropped
  smg: { enabled: true, rot: [0, 0, 0], drop: ['Object_162', 'Object_165', 'Object_176'], tint: 3, lift: 0.03, lenMul: 0.82, grip: [0.5, 0.3, 0.29], muzzle: [0.5, 0.8, 1], fore: [0.5, 0.5, 0.75] },
  // raw shotgun.glb is a single thin flat-white tilted bar: looks bad, keep the procedural model
  shotgun: { enabled: false, rot: [0, 0, 0], lenMul: 1, grip: [0.5, 0.3, 0.3], muzzle: [0.5, 0.6, 1], fore: [0.5, 0.4, 0.7] },
  rifle: { enabled: true, rot: [-0.02, -Math.PI / 2, 0], tint: 2.5, lift: 0.04, lenMul: 0.9, grip: [0.5, 0.3, 0.25], muzzle: [0.5, 0.58, 1], fore: [0.5, 0.5, 0.55] },
};

export interface WeaponGlb { root: THREE.Object3D; muzzle: THREE.Vector3; fore: THREE.Vector3 | null; length: number; size: THREE.Vector3 }

const url = (k: string) => `/models/weapons/${k}.glb`;
const loaded = new Map<string, WeaponGlb>();
const pending = new Map<string, Promise<WeaponGlb | null>>();
const failed = new Set<string>();
const raw = new Map<string, THREE.Object3D>();
const listeners = new Set<(k: string) => void>();

/** called whenever a model finishes loading so a live ViewModel can swap it in */
export function onWeaponGlbLoaded(fn: (k: string) => void) { listeners.add(fn); return () => listeners.delete(fn); }
export function getWeaponGlb(kind: string): WeaponGlb | null { return loaded.get(weaponKind(kind)) ?? null; }
export function weaponGlbFailed(kind: string) { return failed.has(weaponKind(kind)); }
/** unnormalised scene (debug / tuning) */
export function getRawWeaponScene(kind: string) { return raw.get(weaponKind(kind)) ?? null; }

function lambertise(root: THREE.Object3D, cfg: WeaponGlbConfig) {
  const cache = new Map<THREE.Material, THREE.MeshLambertMaterial>();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.castShadow = false; m.receiveShadow = false; m.frustumCulled = false;
    const conv = (src: THREE.Material): THREE.Material => {
      let c = cache.get(src);
      if (c) return c;
      const s = src as THREE.MeshStandardMaterial;
      c = new THREE.MeshLambertMaterial({
        color: s.color ? s.color.clone() : new THREE.Color(0x888888),
        map: s.map ?? null,
        vertexColors: !!m.geometry.getAttribute('color'),
        transparent: s.transparent, opacity: s.opacity, alphaTest: s.alphaTest, side: s.side,
        emissive: cfg.lift != null ? new THREE.Color(cfg.lift, cfg.lift, cfg.lift) : s.emissive ? s.emissive.clone() : new THREE.Color(0),
        emissiveMap: s.emissiveMap ?? null,
      });
      if (cfg.tint != null) c.color.multiplyScalar(cfg.tint);
      if (c.map) { c.map.magFilter = THREE.NearestFilter; c.map.minFilter = THREE.NearestFilter; c.map.generateMipmaps = false; c.map.needsUpdate = true; }
      cache.set(src, c);
      return c;
    };
    m.material = Array.isArray(m.material) ? m.material.map(conv) : conv(m.material);
  });
}

function normalise(kind: string, scene: THREE.Object3D): WeaponGlb {
  const cfg = WEAPON_GLB_CONFIG[kind];
  const holder = new THREE.Group();
  const inner = scene;
  if (cfg.drop) { const kill: THREE.Object3D[] = []; inner.traverse((o) => { if (cfg.drop!.includes(o.name)) kill.push(o); }); for (const o of kill) o.removeFromParent(); }
  inner.rotation.set(...cfg.rot);
  holder.add(inner);
  lambertise(inner, cfg);
  holder.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(holder);
  const size = bb.getSize(new THREE.Vector3());
  const target = getWeaponModel(kind).length * cfg.lenMul;
  const s = target / Math.max(size.z, 1e-6);
  const at = (f: [number, number, number]) => new THREE.Vector3(
    (bb.min.x + size.x * f[0]) * s, (bb.min.y + size.y * f[1]) * s, (bb.min.z + size.z * (1 - f[2])) * s); // f.z: 0 rear .. 1 front (front = -z)
  const grip = at(cfg.grip);
  const root = new THREE.Group();
  holder.scale.setScalar(s);
  holder.position.set(-grip.x, -grip.y, -grip.z);
  root.add(holder);
  const muzzle = at(cfg.muzzle).sub(grip);
  const fore = cfg.fore ? at(cfg.fore).sub(grip) : null;
  return { root, muzzle, fore, length: target, size: size.multiplyScalar(s) };
}

export function loadWeaponGlb(kind: string): Promise<WeaponGlb | null> {
  const k = weaponKind(kind);
  const hit = pending.get(k);
  if (hit) return hit;
  const p = (async () => {
    if (!WEAPON_GLB_CONFIG[k]?.enabled) return null;
    try {
      const g = await new GLTFLoader().loadAsync(url(k));
      raw.set(k, g.scene);
      const w = normalise(k, g.scene.clone(true));
      loaded.set(k, w);
      for (const fn of listeners) fn(k);
      return w;
    } catch (e) {
      console.warn('[weapons] GLB failed, keeping procedural model:', k, e);
      failed.add(k);
      return null;
    }
  })();
  pending.set(k, p);
  return p;
}

export function preloadWeaponGlbs() { return Promise.all(['stun', 'pistol', 'smg', 'shotgun', 'rifle'].map(loadWeaponGlb)); }

/** re-run normalisation after a config edit (tuning in the demo) */
export function renormaliseWeapon(kind: string) {
  const k = weaponKind(kind);
  const sc = raw.get(k); if (!sc) return null;
  const w = normalise(k, sc.clone(true));
  loaded.set(k, w);
  for (const fn of listeners) fn(k);
  return w;
}

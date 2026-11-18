/**
 * Pooled combat effects: voxel particles (sparks, dust, splinters, glass, shell casings),
 * bullet-hole decals that fade, travelling tracer streaks and the world muzzle-flash light
 * (a three.js PointLight for models + the block shader's dynamic light uniform).
 *
 * Everything is preallocated; spawning and updating never allocate.
 */
import * as THREE from 'three';
import type { LightingUniforms } from './materials';

export type ImpactKind = 'metal' | 'concrete' | 'wood' | 'dirt' | 'sand' | 'grass' | 'glass' | 'water' | 'hit' | 'stun' | 'vehicle';

interface VoxelQuery { getBlock(x: number, y: number, z: number): number }
type SolidTest = (id: number) => boolean;

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/** one instanced pool of little cubes */
class CubePool {
  readonly mesh: THREE.InstancedMesh;
  private n = 0;
  readonly cap: number;
  private px: Float32Array; private py: Float32Array; private pz: Float32Array;
  private vx: Float32Array; private vy: Float32Array; private vz: Float32Array;
  private life: Float32Array; private max: Float32Array; private size: Float32Array;
  private grav: Float32Array; private drag: Float32Array; private bounce: Float32Array;
  private rot: Float32Array; private spin: Float32Array; private stretch: Float32Array;
  private r: Float32Array; private g: Float32Array; private bl: Float32Array;
  private shrink: Uint8Array;

  constructor(cap: number, mat: THREE.Material) {
    this.cap = cap;
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, _c.setRGB(1, 1, 1));
    this.mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    const f = () => new Float32Array(cap);
    this.px = f(); this.py = f(); this.pz = f(); this.vx = f(); this.vy = f(); this.vz = f();
    this.life = f(); this.max = f(); this.size = f(); this.grav = f(); this.drag = f(); this.bounce = f();
    this.rot = f(); this.spin = f(); this.stretch = f(); this.r = f(); this.g = f(); this.bl = f();
    this.shrink = new Uint8Array(cap);
  }

  spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size: number, r: number, g: number, b: number, grav: number, drag: number, bounce = 0, stretch = 0, shrink = true) {
    let i = this.n;
    if (i >= this.cap) i = (Math.random() * this.cap) | 0; // pool full: recycle a random slot
    else this.n++;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z; this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.life[i] = life; this.max[i] = life; this.size[i] = size; this.grav[i] = grav; this.drag[i] = drag; this.bounce[i] = bounce;
    this.rot[i] = Math.random() * 6.28; this.spin[i] = (Math.random() - 0.5) * 22; this.stretch[i] = stretch;
    this.r[i] = r; this.g[i] = g; this.bl[i] = b; this.shrink[i] = shrink ? 1 : 0;
  }

  private kill(i: number) {
    const j = --this.n;
    if (i === j) return;
    this.px[i] = this.px[j]; this.py[i] = this.py[j]; this.pz[i] = this.pz[j];
    this.vx[i] = this.vx[j]; this.vy[i] = this.vy[j]; this.vz[i] = this.vz[j];
    this.life[i] = this.life[j]; this.max[i] = this.max[j]; this.size[i] = this.size[j];
    this.grav[i] = this.grav[j]; this.drag[i] = this.drag[j]; this.bounce[i] = this.bounce[j];
    this.rot[i] = this.rot[j]; this.spin[i] = this.spin[j]; this.stretch[i] = this.stretch[j];
    this.r[i] = this.r[j]; this.g[i] = this.g[j]; this.bl[i] = this.bl[j]; this.shrink[i] = this.shrink[j];
  }

  update(dt: number, w: VoxelQuery | null, solid: SolidTest) {
    let i = 0;
    while (i < this.n) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.kill(i); continue; }
      const k = Math.max(0, 1 - this.drag[i] * dt);
      this.vx[i] *= k; this.vz[i] *= k; this.vy[i] = this.vy[i] * k - this.grav[i] * dt;
      let nx = this.px[i] + this.vx[i] * dt, ny = this.py[i] + this.vy[i] * dt;
      const nz = this.pz[i] + this.vz[i] * dt;
      if (this.bounce[i] > 0 && w && solid(w.getBlock(Math.floor(nx), Math.floor(ny), Math.floor(nz)))) {
        // landed: bounce off the top face (shells clink and settle)
        if (!solid(w.getBlock(Math.floor(nx), Math.floor(this.py[i]), Math.floor(nz)))) {
          ny = Math.floor(ny) + 1.001;
          this.vy[i] = Math.abs(this.vy[i]) * this.bounce[i];
          this.vx[i] *= 0.45; this.vz[i] *= 0.45; this.spin[i] *= 0.5;
          if (this.vy[i] < 0.6) { this.vy[i] = 0; this.grav[i] = 0; this.vx[i] *= 0.2; this.vz[i] *= 0.2; this.spin[i] = 0; }
        } else { this.vx[i] *= -0.3; this.vz[i] *= -0.3; nx = this.px[i]; }
      }
      this.px[i] = nx; this.py[i] = ny; this.pz[i] = nz;
      this.rot[i] += this.spin[i] * dt;
      const t = this.life[i] / this.max[i];
      const sz = this.size[i] * (this.shrink[i] ? 0.35 + 0.65 * t : Math.min(1, t * 6));
      _p.set(this.px[i], this.py[i], this.pz[i]);
      if (this.stretch[i] > 0) {
        // sparks: stretched along velocity
        const sp = Math.hypot(this.vx[i], this.vy[i], this.vz[i]);
        _a.set(this.vx[i], this.vy[i], this.vz[i]).divideScalar(Math.max(1e-4, sp));
        _q.setFromUnitVectors(_up, _a);
        _s.set(sz, sz + sp * this.stretch[i], sz);
      } else {
        _e.set(this.rot[i], this.rot[i] * 0.7, 0);
        _q.setFromEuler(_e);
        _s.set(sz, sz, sz);
      }
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(i, _m);
      this.mesh.setColorAt(i, _c.setRGB(this.r[i], this.g[i], this.bl[i]));
      i++;
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

interface Decal { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; life: number }
interface Tracer { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; sx: number; sy: number; sz: number; dx: number; dy: number; dz: number; len: number; t: number; speed: number; on: boolean; width: number }

const DECAL_LIFE = 9;
const TRACER_SPEED = 260;

function holeTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const x = c.getContext('2d')!;
  // blocky bullet hole: dark core, scorched pixel ring
  x.fillStyle = 'rgba(0,0,0,0)'; x.fillRect(0, 0, 32, 32);
  x.fillStyle = 'rgba(30,26,22,0.55)';
  for (const [px, py] of [[10, 8], [18, 6], [24, 12], [24, 20], [18, 24], [8, 22], [6, 14]]) x.fillRect(px, py, 4, 4);
  x.fillStyle = 'rgba(20,18,16,0.85)'; x.fillRect(10, 10, 12, 12);
  x.fillStyle = 'rgba(5,5,5,1)'; x.fillRect(13, 13, 6, 6);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter; t.minFilter = THREE.NearestFilter; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Effects {
  readonly group = new THREE.Group();
  private glow: CubePool;
  private solidP: CubePool;
  private decals: Decal[] = [];
  private decalNext = 0;
  private tracers: Tracer[] = [];
  private tracerNext = 0;
  readonly light = new THREE.PointLight(0xffb060, 0, 9, 2);
  private flashT = 0; private flashMax = 0.06; private flashI = 0;
  private holeTex = holeTexture();
  private world: VoxelQuery | null = null;
  private solid: SolidTest = () => false;

  constructor(scene: THREE.Scene, private L: LightingUniforms) {
    const glowMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
    const solidMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.glow = new CubePool(320, glowMat);
    this.solidP = new CubePool(360, solidMat);
    this.group.add(this.glow.mesh, this.solidP.mesh);
    const dg = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < 64; i++) {
      const mat = new THREE.MeshBasicMaterial({ map: this.holeTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, opacity: 1 });
      const mesh = new THREE.Mesh(dg, mat);
      mesh.visible = false; mesh.renderOrder = 2; mesh.frustumCulled = false;
      this.group.add(mesh);
      this.decals.push({ mesh, mat, life: 0 });
    }
    const tg = new THREE.BoxGeometry(1, 1, 1); tg.translate(0, 0, -0.5); // origin at the tail, extends to -z
    for (let i = 0; i < 32; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 2.4, 1.2), toneMapped: false, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
      const mesh = new THREE.Mesh(tg, mat);
      mesh.visible = false; mesh.frustumCulled = false;
      this.group.add(mesh);
      this.tracers.push({ mesh, mat, sx: 0, sy: 0, sz: 0, dx: 0, dy: 0, dz: 1, len: 0, t: 0, speed: TRACER_SPEED, on: false, width: 0.03 });
    }
    this.light.castShadow = false;
    this.group.add(this.light);
    scene.add(this.group);
  }

  /** voxel world used for shell bounces */
  setWorld(w: VoxelQuery, solid: SolidTest) { this.world = w; this.solid = solid; }

  /** world muzzle flash: lights nearby models and blocks for a few frames */
  muzzle(x: number, y: number, z: number, strength = 1, stun = false) {
    this.light.position.set(x, y, z);
    this.light.color.setHex(stun ? 0x6fc8ff : 0xffb060);
    this.flashI = 14 * strength; this.flashT = this.flashMax = 0.05 + 0.02 * strength;
    this.L.dynPos.value.set(x, y, z, 7 + 3 * strength);
    if (stun) this.L.dynCol.value.setRGB(0.5, 1.1, 1.8); else this.L.dynCol.value.setRGB(1.9, 1.25, 0.55);
  }

  /** own-vehicle headlights on the blocks (driver view at night). range 0 = off */
  headlight(on: boolean, x = 0, y = 0, z = 0, dx = 0, dy = 0, dz = -1, intensity = 1) {
    if (!on || intensity <= 0.01) { this.L.headPos.value.w = 0; return; }
    this.L.headPos.value.set(x, y, z, 34);
    this.L.headDir.value.set(dx, dy, dz).normalize();
    this.L.headCol.value.setRGB(1.25 * intensity, 1.15 * intensity, 0.9 * intensity);
  }

  /** shell casing ejected to the right of the gun */
  shell(x: number, y: number, z: number, rx: number, rz: number, fx: number, fz: number, kind: string) {
    const big = kind === 'rifle' ? 1.25 : 1;
    const red = kind === 'shotgun';
    const sp = 2.2 + Math.random() * 1.2;
    this.solidP.spawn(x, y, z, rx * sp - fx * 0.4 + (Math.random() - 0.5) * 0.5, 2.4 + Math.random() * 1.4, rz * sp - fz * 0.4 + (Math.random() - 0.5) * 0.5,
      2.2, (red ? 0.05 : 0.032) * big, red ? 0.8 : 0.95, red ? 0.15 : 0.7, red ? 0.12 : 0.25, 13, 0.4, 0.38, 0, false);
  }

  /** bullet impact at a surface point with normal n */
  impact(x: number, y: number, z: number, nx: number, ny: number, nz: number, kind: ImpactKind, color?: THREE.Color, decal = true) {
    const g = this.glow, s = this.solidP;
    const rnd = (k: number) => (Math.random() - 0.5) * k;
    const sparks = kind === 'metal' ? 14 : kind === 'vehicle' ? 12 : kind === 'concrete' ? 5 : kind === 'glass' ? 3 : kind === 'hit' ? 6 : kind === 'stun' ? 14 : 0;
    for (let i = 0; i < sparks; i++) {
      const sp = 5 + Math.random() * 9;
      const st = kind === 'stun';
      g.spawn(x, y, z, (nx + rnd(1.6)) * sp, (ny + rnd(1.6)) * sp + 1.5, (nz + rnd(1.6)) * sp, 0.12 + Math.random() * 0.22, 0.022,
        st ? 0.5 : 3.2, st ? 1.6 : 2.0, st ? 3.4 : 0.7, 14, 2.5, 0, 0.016);
    }
    // flash pop at the impact point
    g.spawn(x + nx * 0.04, y + ny * 0.04, z + nz * 0.04, 0, 0, 0, 0.05, kind === 'stun' ? 0.22 : 0.14, kind === 'stun' ? 0.7 : 2.6, kind === 'stun' ? 1.6 : 1.9, kind === 'stun' ? 3 : 1.1, 0, 0, 0, 0, true);
    if (kind === 'water') {
      for (let i = 0; i < 16; i++) s.spawn(x + rnd(0.3), y, z + rnd(0.3), rnd(2.2), 3 + Math.random() * 4, rnd(2.2), 0.5 + Math.random() * 0.4, 0.07, 0.75, 0.88, 1, 18, 0.5);
      return;
    }
    if (kind === 'hit' || kind === 'stun') return;
    // debris + dust in the block colour
    const c = color ?? _c.setRGB(0.6, 0.6, 0.6);
    const cr = c.r, cg = c.g, cb = c.b;
    const chunks = kind === 'glass' ? 12 : kind === 'wood' ? 9 : kind === 'metal' || kind === 'vehicle' ? 2 : 7;
    for (let i = 0; i < chunks; i++) {
      const sp = 2 + Math.random() * 4;
      const glassy = kind === 'glass';
      const sh = 0.75 + Math.random() * 0.4;
      s.spawn(x + nx * 0.05, y + ny * 0.05, z + nz * 0.05, (nx + rnd(1.4)) * sp, (ny + rnd(1.2)) * sp + 2, (nz + rnd(1.4)) * sp,
        0.5 + Math.random() * 0.6, glassy ? 0.05 : kind === 'wood' ? 0.06 : 0.045,
        glassy ? 0.7 : cr * sh, glassy ? 0.9 : cg * sh, glassy ? 1 : cb * sh, 16, 0.8, 0, 0, true);
    }
    if (kind !== 'metal' && kind !== 'glass' && kind !== 'vehicle') {
      // soft dust puff: slow, larger, rising
      for (let i = 0; i < 6; i++) {
        s.spawn(x + nx * 0.1, y + ny * 0.1, z + nz * 0.1, (nx * 1.4 + rnd(1.2)), (ny * 1.4 + rnd(1)) + 0.5, (nz * 1.4 + rnd(1.2)),
          0.5 + Math.random() * 0.5, 0.14 + Math.random() * 0.1, Math.min(1, cr * 1.15 + 0.1), Math.min(1, cg * 1.15 + 0.1), Math.min(1, cb * 1.15 + 0.1), -0.6, 3.2, 0, 0, false);
      }
    }
    if (decal && kind !== 'vehicle') this.decal(x, y, z, nx, ny, nz, kind === 'glass' ? 0.2 : kind === 'wood' ? 0.15 : 0.13);
  }

  decal(x: number, y: number, z: number, nx: number, ny: number, nz: number, size: number) {
    const d = this.decals[this.decalNext];
    this.decalNext = (this.decalNext + 1) % this.decals.length;
    d.mesh.position.set(x + nx * 0.012, y + ny * 0.012, z + nz * 0.012);
    _a.set(x + nx, y + ny, z + nz);
    d.mesh.lookAt(_a);
    d.mesh.rotateZ(Math.random() * 6.28);
    d.mesh.scale.setScalar(size * (0.85 + Math.random() * 0.3));
    d.life = DECAL_LIFE; d.mat.opacity = 1; d.mesh.visible = true;
  }

  /** bullet streak travelling from s to e. mine = brighter/thicker near your view */
  tracer(sx: number, sy: number, sz: number, ex: number, ey: number, ez: number, mine: boolean, stun = false) {
    const t = this.tracers[this.tracerNext];
    this.tracerNext = (this.tracerNext + 1) % this.tracers.length;
    const dx = ex - sx, dy = ey - sy, dz = ez - sz;
    const len = Math.hypot(dx, dy, dz);
    if (len < 0.3) return;
    t.sx = sx; t.sy = sy; t.sz = sz; t.dx = dx / len; t.dy = dy / len; t.dz = dz / len; t.len = len; t.t = 0; t.on = true;
    t.speed = stun ? 120 : TRACER_SPEED; t.width = mine ? 0.022 : 0.03;
    if (stun) t.mat.color.setRGB(0.8, 2, 3.4); else t.mat.color.setRGB(3, 2.3, 1.1);
    t.mesh.visible = true;
  }

  update(dt: number) {
    this.glow.update(dt, null, this.solid);
    this.solidP.update(dt, this.world, this.solid);
    for (const d of this.decals) {
      if (!d.mesh.visible) continue;
      d.life -= dt;
      if (d.life <= 0) { d.mesh.visible = false; continue; }
      d.mat.opacity = Math.min(1, d.life / 2.5);
    }
    for (const t of this.tracers) {
      if (!t.on) continue;
      t.t += dt;
      const travel = t.t * t.speed;
      const head = Math.min(t.len, travel);
      const tail = Math.min(t.len, Math.max(0, travel - (3.5 + t.len * 0.04)));
      if (tail >= t.len - 0.05) { t.on = false; t.mesh.visible = false; continue; }
      _a.set(t.sx + t.dx * tail, t.sy + t.dy * tail, t.sz + t.dz * tail);
      _b.set(_a.x + t.dx, _a.y + t.dy, _a.z + t.dz);
      t.mesh.position.copy(_a);
      t.mesh.lookAt(_b);
      // lookAt points +z toward the target for non-cameras; our box extends to -z, so flip
      t.mesh.rotateY(Math.PI);
      t.mesh.scale.set(t.width, t.width, Math.max(0.05, head - tail));
      t.mat.opacity = head >= t.len ? Math.max(0, 1 - (tail / Math.max(0.01, t.len))) * 0.9 : 0.9;
    }
    if (this.flashT > 0) {
      this.flashT -= dt;
      const k = Math.max(0, this.flashT / this.flashMax);
      this.light.intensity = this.flashI * k;
      this.L.dynPos.value.w = k > 0 ? this.L.dynPos.value.w : 0;
      if (k <= 0) { this.light.intensity = 0; this.L.dynPos.value.w = 0; }
      else this.L.dynCol.value.multiplyScalar(0.8 + 0.2 * k);
    }
  }
}

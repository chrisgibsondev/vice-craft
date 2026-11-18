/** First-person arms + held weapon, drawn after the world with its own camera/scene so it never clips into walls. */
import * as THREE from 'three';
import { WEAPONS } from '@blockshore/shared';
import type { GameRenderer } from '../renderer';
import { Bin, BoxBuilder, canvas2d, clamp, damp, smoothTexture } from './util';
import { getWeaponModel, weaponGlowMaterial, weaponKind, weaponMaterial } from './weapons';
import { getWeaponGlb, loadWeaponGlb, onWeaponGlbLoaded } from './weaponModels';

export interface ViewModelState { weapon: string; firing: boolean; reloading: boolean; moving: number; visible: boolean; /** ADS blend 0..1 (hip..sights) */ aim?: number; aiming?: boolean; outfit?: number; skin?: string }

/** per-kind sight line in weapon space (grip origin, barrel -z) */
const SIGHT_Y: Record<string, number> = { stun: 0.13, pistol: 0.093, smg: 0.16, shotgun: 0.083, rifle: 0.175 };
const SIGHT_Z: Record<string, number> = { stun: -0.1, pistol: -0.02, smg: -0.05, shotgun: 0.0, rifle: -0.12 };
const SIGHT_DROP: Record<string, number> = { stun: 0.01, pistol: 0.012, smg: 0.012, shotgun: 0.01, rifle: 0.012 };
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

export class ViewModel {
  private scene = new THREE.Scene();
  private cam = new THREE.PerspectiveCamera(62, 1, 0.02, 20);
  private hemi = new THREE.HemisphereLight(0xffffff, 0x666666, 1.4);
  private sun = new THREE.DirectionalLight(0xffffff, 2);
  private root = new THREE.Group();       // whole rig (bob, sway, draw)
  private wpn = new THREE.Group();        // weapon + hands (recoil, reload)
  private wpnMesh = new THREE.Mesh();
  private wpnGlow = new THREE.Mesh();
  private rArm = new THREE.Group(); private lArm = new THREE.Group();
  private flash = new THREE.Group();
  private bin = new Bin();
  private skinMat: THREE.MeshLambertMaterial; private sleeveMat: THREE.MeshLambertMaterial;
  private armGeoR: THREE.BufferGeometry;
  private flashMat: THREE.MeshBasicMaterial;
  private weaponId = ''; private kind = '';
  private t = 0; private kick = 0; private kickY = 0; private fireAcc = 0; private flashT = 0; private prevFiring = false;
  private rel = 0; private relT = 0; private draw = 0; private bob = 0; private movingS = 0;
  private visible = true; private sleeveCol = -1; private skinCol = '';
  private fore: THREE.Vector3 | null = null;
  /** weapon-local point (rear sight / optic top) that is brought to the screen centre when aiming */
  private sight = new THREE.Vector3(0, 0.08, -0.05);
  private aimS = 0;
  private glbObj: THREE.Object3D | null = null;
  private offGlb: () => void;

  constructor(private r: GameRenderer) {
    this.scene.add(this.hemi, this.sun, this.sun.target, this.root);
    this.root.add(this.wpn);
    this.wpn.scale.setScalar(0.62);
    this.skinMat = this.bin.add(new THREE.MeshLambertMaterial({ color: 0xe0a97c, vertexColors: true }));
    this.sleeveMat = this.bin.add(new THREE.MeshLambertMaterial({ color: 0x3a7bd5, vertexColors: true }));
    // arm: sleeve + forearm + hand (+ thumb), extends toward +z from the hand
    const arm = new BoxBuilder();
    arm.box(0, 0, 0.06, 0.1, 0.1, 0.16, '#ffffff');         // hand
    arm.box(0.04, 0.045, -0.02, 0.03, 0.03, 0.08, '#ffffff'); // thumb
    for (let i = 0; i < 3; i++) arm.box(-0.03 + i * 0.03, -0.045, -0.06, 0.022, 0.03, 0.06, '#d6d6d6'); // fingers curled
    arm.box(0, 0, 0.26, 0.095, 0.095, 0.26, '#ffffff');       // forearm
    this.armGeoR = this.bin.add(arm.build());
    const sleeve = new BoxBuilder(); sleeve.box(0, 0, 0.55, 0.125, 0.125, 0.42, '#ffffff'); sleeve.box(0, 0, 0.35, 0.135, 0.135, 0.04, '#e6e6e6');
    const sleeveGeo = this.bin.add(sleeve.build());
    for (const a of [this.rArm, this.lArm]) {
      const m = new THREE.Mesh(this.armGeoR, this.skinMat);
      const sl = new THREE.Mesh(sleeveGeo, this.sleeveMat);
      this.sleeveMats.push(sl);
      a.add(m, sl); this.wpn.add(a);
    }
    this.wpn.add(this.wpnMesh, this.wpnGlow);
    this.wpnMesh.material = weaponMaterial(); this.wpnGlow.material = weaponGlowMaterial();
    // muzzle flash: two crossed additive quads + core
    const [c, ctx] = canvas2d(64, 64);
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, 'rgba(255,255,230,1)'); g.addColorStop(0.3, 'rgba(255,200,90,.85)'); g.addColorStop(1, 'rgba(255,120,20,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
    ctx.fillStyle = 'rgba(255,240,180,.95)';
    ctx.beginPath(); ctx.moveTo(32, 0); ctx.lineTo(38, 26); ctx.lineTo(64, 32); ctx.lineTo(38, 38); ctx.lineTo(32, 64); ctx.lineTo(26, 38); ctx.lineTo(0, 32); ctx.lineTo(26, 26); ctx.closePath(); ctx.fill();
    const ft = this.bin.add(smoothTexture(c));
    this.flashMat = this.bin.add(new THREE.MeshBasicMaterial({ map: ft, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false, color: new THREE.Color(2.2, 1.8, 1.2), side: THREE.DoubleSide }));
    const fg = this.bin.add(new THREE.PlaneGeometry(0.34, 0.34));
    for (let i = 0; i < 2; i++) { const q = new THREE.Mesh(fg, this.flashMat); q.rotation.z = i * Math.PI / 4; this.flash.add(q); }
    const q2 = new THREE.Mesh(fg, this.flashMat); q2.rotation.y = Math.PI / 2; q2.scale.set(1.6, 0.5, 1); this.flash.add(q2);
    this.flash.visible = false; this.wpn.add(this.flash);
    this.flashLight = new THREE.PointLight(0xffb060, 0, 3, 2); this.flash.add(this.flashLight);
    this.root.position.set(0.17, -0.2, -0.36);
    this.offGlb = onWeaponGlbLoaded((k) => { if (k === this.kind) this.setWeapon(this.weaponId, true); });
  }
  private sleeveMats: THREE.Mesh[] = [];
  private flashLight: THREE.PointLight;

  private setWeapon(id: string, keepDraw = false) {
    this.weaponId = id;
    const kind = weaponKind(id);
    this.kind = kind;
    const m = getWeaponModel(kind);
    if (this.glbObj) { this.glbObj.removeFromParent(); this.glbObj = null; }
    const glb = getWeaponGlb(kind);
    if (glb) {
      // downloaded voxel model (origin = grip, barrel -z); procedural meshes are hidden
      this.glbObj = glb.root.clone(true); this.wpn.add(this.glbObj);
      this.wpnMesh.visible = false; this.wpnGlow.visible = false;
      this.fore = glb.fore;
      this.flash.position.copy(glb.muzzle);
      const bb = new THREE.Box3().setFromObject(glb.root);
      this.sight.set((bb.min.x + bb.max.x) / 2, bb.max.y - (SIGHT_DROP[kind] ?? 0.01), SIGHT_Z[kind] ?? -0.05);
    } else {
      void loadWeaponGlb(kind);
      this.wpnMesh.visible = true;
      this.wpnMesh.geometry = m.geo;
      if (m.glow) { this.wpnGlow.geometry = m.glow; this.wpnGlow.visible = true; } else this.wpnGlow.visible = false;
      this.fore = m.fore;
      this.flash.position.copy(m.muzzle);
      this.sight.set(0, SIGHT_Y[kind] ?? 0.09, SIGHT_Z[kind] ?? -0.05);
    }
    const fore = this.fore;
    // hands: right on the grip; left supports the forend for long guns (else hidden)
    this.rArm.position.set(0, -0.045, 0.0);
    this.rArm.rotation.set(0.5, 0.3, 0.08, 'YXZ');
    if (fore) {
      this.lArm.visible = true; this.lArm.position.set(0.0, fore.y - 0.06, fore.z);
      this.lArm.rotation.set(0.45, -0.55, -0.1, 'YXZ');
    } else this.lArm.visible = false;
    if (!keepDraw) this.draw = 0;
  }

  update(dt: number, s: ViewModelState) {
    this.visible = s.visible;
    if (!s.visible) return;
    if (s.weapon !== this.weaponId) this.setWeapon(s.weapon || 'stun');
    if ((s.outfit ?? 0x3a7bd5) !== this.sleeveCol) { this.sleeveCol = s.outfit ?? 0x3a7bd5; this.sleeveMat.color.setHex(this.sleeveCol); }
    this.t += dt;
    const def = WEAPONS[this.weaponId];
    const rate = def?.rate ?? 3;
    // fire kicks
    const k = this.kind;
    const heavy = k === 'shotgun' ? 2.2 : k === 'rifle' ? 1.1 : k === 'smg' ? 0.6 : k === 'pistol' ? 1.0 : 0.7;
    if (s.firing && !s.reloading) {
      if (!this.prevFiring) { this.fireAcc = 1; }
      this.fireAcc += dt * rate;
      while (this.fireAcc >= 1) { this.fireAcc -= 1; this.kick = Math.min(1.6, this.kick + 0.55 * heavy); this.kickY = (Math.random() - 0.5) * 0.4; this.flashT = k === 'smg' || k === 'rifle' ? 0.045 : 0.07; this.flash.rotation.z = Math.random() * 6; }
    }
    this.prevFiring = s.firing;
    this.kick = damp(this.kick, 0, 16, dt);
    this.flashT -= dt;
    const showFlash = this.flashT > 0 && k !== 'stun';
    this.flash.visible = showFlash || (k === 'stun' && this.flashT > 0);
    this.flashLight.intensity = this.flash.visible ? 4 : 0;
    // reload
    if (s.reloading) { this.relT += dt; } else this.relT = 0;
    this.rel = damp(this.rel, s.reloading ? 1 : 0, 10, dt);
    this.draw = Math.min(1, this.draw + dt * 4.5);
    this.movingS = damp(this.movingS, s.moving, 8, dt);
    this.bob += dt * (6 + this.movingS * 5);
    const m = this.movingS;
    const d = 1 - smooth(this.draw);
    const kk = this.kick;
    const wob = Math.sin(this.relT * 9) * 0.03 * this.rel;
    // ADS blend (~0.15 s); reloading drops the gun out of the sights
    this.aimS = damp(this.aimS, s.reloading ? 0 : clamp(s.aim ?? (s.aiming ? 1 : 0), 0, 1), 20, dt);
    const a = smooth(this.aimS), calm = 1 - 0.85 * a;
    // root: bob + sway + draw-in, then slide so the sight sits on the crosshair
    const hx = 0.15 + Math.sin(this.bob * 0.5) * 0.012 * m * calm, hy = -0.18 - Math.abs(Math.cos(this.bob * 0.5)) * 0.014 * m * calm - d * 0.25;
    const sc = this.wpn.scale.x;
    const ax = -this.sight.x * sc, ay = -this.sight.y * sc;
    this.root.position.set(hx + (ax - hx) * a, hy + (ay - hy) * a, -0.4 - 0.02 * a);
    this.root.rotation.set((Math.sin(this.t * 1.3) * 0.004 + d * 0.5) * (1 - 0.6 * a), Math.sin(this.bob * 0.25) * 0.012 * m * calm, Math.cos(this.bob * 0.5) * 0.01 * m * calm);
    // weapon: recoil + reload tilt (recoil stays fully visible while aiming)
    this.wpn.position.set(0, -0.18 * this.rel * 0.5 + this.kickY * 0.005 * kk, kk * 0.05 * (1 - 0.3 * a) + 0.05 * this.rel);
    this.wpn.rotation.set(kk * 0.08 * (1 - 0.15 * a) - this.rel * 0.55 + wob, this.kickY * 0.03 * kk + this.rel * 0.25, wob * 2 + this.rel * 0.35);
    // arms tuck down and flatten while aiming so they frame the sights instead of covering them
    this.rArm.position.set(0, -0.045 - 0.075 * a, 0.0 + 0.04 * a);
    this.rArm.rotation.set(0.5 - 0.32 * a, 0.3 - 0.12 * a, 0.08, 'YXZ');
    if (this.fore) {
      this.lArm.position.set(0.0, this.fore.y - 0.06 - 0.045 * a, this.fore.z);
      this.lArm.rotation.set(0.45 - 0.2 * a, -0.55 + 0.15 * a, -0.1, 'YXZ');
    }
    // lights from the world
    this.hemi.color.copy(this.r.hemi.color); this.hemi.groundColor.copy(this.r.hemi.groundColor); this.hemi.intensity = this.r.hemi.intensity;
    this.sun.color.copy(this.r.sun.color); this.sun.intensity = this.r.sun.intensity;
    _q.copy(this.r.camera.quaternion).invert();
    _v.copy(this.r.L.sunDir.value).applyQuaternion(_q).multiplyScalar(10);
    this.sun.position.copy(_v);
    const skin = s.skin ?? '#e0a97c';
    if (skin !== this.skinCol) { this.skinCol = skin; this.skinMat.color.set(skin); }
  }

  render() {
    if (!this.visible) return;
    const rr = this.r.renderer;
    const prev = rr.autoClear;
    rr.autoClear = false;
    rr.clearDepth();
    this.cam.aspect = this.r.camera.aspect;
    this.cam.updateProjectionMatrix();
    rr.render(this.scene, this.cam);
    rr.autoClear = prev;
  }

  dispose() { this.offGlb(); this.bin.disposeAll(); }
}

function smooth(t: number) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }

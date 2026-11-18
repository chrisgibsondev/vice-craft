/**
 * Cinematic world tour (used behind the title screen) + free-fly camera for the
 * world preview (?preview). Pure camera control, no networking.
 */
import * as THREE from 'three';
import type { GameRenderer } from './renderer';

const KEYS: [THREE.Vector3, THREE.Vector3, number][] = [
  // [camera, look-at, seconds to next]
  [new THREE.Vector3(2715, 62, 3196), new THREE.Vector3(2520, 40, 3170), 9],
  [new THREE.Vector3(2660, 42, 3110), new THREE.Vector3(2540, 30, 3150), 9],
  [new THREE.Vector3(2600, 28, 3172), new THREE.Vector3(2480, 24, 3168), 8],
  [new THREE.Vector3(2520, 25.5, 3171), new THREE.Vector3(2440, 23, 3168), 8],
  [new THREE.Vector3(2474, 30, 3240), new THREE.Vector3(2472, 24, 3160), 9],
  [new THREE.Vector3(2440, 62, 3300), new THREE.Vector3(2520, 30, 3180), 10],
  [new THREE.Vector3(2600, 80, 3360), new THREE.Vector3(2800, 22, 3200), 10],
  [new THREE.Vector3(2850, 34, 3240), new THREE.Vector3(2790, 22, 3120), 9],
];

export class WorldTour {
  private t = 0;
  private camCurve: THREE.CatmullRomCurve3;
  private lookCurve: THREE.CatmullRomCurve3;
  private total: number;
  private stamps: number[] = [];
  constructor(private r: GameRenderer) {
    this.camCurve = new THREE.CatmullRomCurve3(KEYS.map((k) => k[0]), true, 'centripetal');
    this.lookCurve = new THREE.CatmullRomCurve3(KEYS.map((k) => k[1]), true, 'centripetal');
    let acc = 0;
    for (const k of KEYS) { this.stamps.push(acc); acc += k[2]; }
    this.total = acc;
  }
  /** jump to a given second of the tour */
  seek(s: number) { this.t = s; }
  update(dt: number) {
    this.t = (this.t + dt) % this.total;
    // map time → curve parameter (piecewise linear between key stamps)
    let i = 0;
    while (i + 1 < this.stamps.length && this.stamps[i + 1] <= this.t) i++;
    const seg = KEYS[i][2];
    const local = (this.t - this.stamps[i]) / seg;
    const eased = local * local * (3 - 2 * local);
    const u = (i + eased) / KEYS.length;
    const p = this.camCurve.getPointAt(u);
    const l = this.lookCurve.getPointAt(u);
    this.r.camera.position.copy(p);
    this.r.camera.lookAt(l);
    return p;
  }
}

export class FlyCamera {
  yaw = 0; pitch = -0.2;
  private keys = new Set<string>();
  enabled = false;
  constructor(private cam: THREE.PerspectiveCamera, private el: HTMLElement) {
    window.addEventListener('keydown', (e) => this.keys.add(e.code));
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    el.addEventListener('click', () => el.requestPointerLock());
    document.addEventListener('pointerlockchange', () => {
      this.enabled = document.pointerLockElement === el;
      if (this.enabled) { const e = new THREE.Euler().setFromQuaternion(cam.quaternion, 'YXZ'); this.yaw = e.y; this.pitch = e.x; }
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      this.yaw -= e.movementX * 0.0022;
      this.pitch = Math.max(-1.5, Math.min(1.5, this.pitch - e.movementY * 0.0022));
    });
  }
  update(dt: number) {
    if (!this.enabled) return false;
    const sp = (this.keys.has('ShiftLeft') ? 60 : 16) * dt;
    const f = new THREE.Vector3(-Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), -Math.cos(this.yaw) * Math.cos(this.pitch));
    const r = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    if (this.keys.has('KeyW')) this.cam.position.addScaledVector(f, sp);
    if (this.keys.has('KeyS')) this.cam.position.addScaledVector(f, -sp);
    if (this.keys.has('KeyD')) this.cam.position.addScaledVector(r, sp);
    if (this.keys.has('KeyA')) this.cam.position.addScaledVector(r, -sp);
    if (this.keys.has('Space')) this.cam.position.y += sp;
    if (this.keys.has('ControlLeft')) this.cam.position.y -= sp;
    this.cam.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
    return true;
  }
}

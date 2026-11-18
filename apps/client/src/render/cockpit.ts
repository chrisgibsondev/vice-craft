/**
 * First-person vehicle interior. When you drive or ride in first person the external
 * car model is hidden and this cockpit is drawn instead: dashboard with gauges,
 * steering wheel that turns with your input, your hands on the wheel, A-pillars,
 * roof liner, rear-view mirror and the hood in the car's paint colour. Bikes get
 * handlebars + tank, boats a helm console + windscreen.
 *
 * Built per vehicle model (cached) in local space: x right, y up, -z forward,
 * origin = vehicle ground centre, then placed at the vehicle pose each frame.
 */
import * as THREE from 'three';
import { VEHICLES, seatOffset, type VehicleModel } from '@blockshore/shared';

const lam = (c: number, emissive = 0) => new THREE.MeshLambertMaterial({ color: c, emissive: emissive ? c : 0, emissiveIntensity: emissive });

// interiors get a little self-light so they read as surfaces instead of black holes in shade
const MAT = {
  dash: lam(0x3a3d44, 0.35), dashTop: lam(0x2c2f35, 0.3), trim: lam(0x5a5f68, 0.3), seat: lam(0x4a4c53, 0.3), wheel: lam(0x2a2c31, 0.45),
  liner: lam(0x9a968e, 0.35),
  chrome: lam(0xc9d1d9, 0.2), gaugeFace: lam(0x0d1b2a, 0.2), gaugeGlow: lam(0x2ee6d6, 1.6), needle: lam(0xff4f6d, 1.4),
  skin: lam(0xc68b59, 0.3), glove: lam(0x2b2b2b, 0.3), mirror: lam(0x9fb7c9, 0.15), glass: new THREE.MeshLambertMaterial({ color: 0xa8d8ea, transparent: true, opacity: 0.12, depthWrite: false }),
  screen: lam(0x3a86ff, 1.2), led: lam(0xffd23f, 1.5),
};

interface Rig {
  root: THREE.Group;
  body: THREE.MeshLambertMaterial;
  sleeve: THREE.MeshLambertMaterial;
  steer: THREE.Group | null;
  needle: THREE.Mesh | null;
  tach: THREE.Mesh | null;
  eye: THREE.Vector3;
}

function box(w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  mesh.position.set(x, y, z);
  mesh.rotation.set(rx, ry, rz);
  return mesh;
}

export class Cockpit {
  readonly group = new THREE.Group();
  private rigs = new Map<string, Rig>();
  private active: Rig | null = null;
  private wheelAngle = 0;
  private needleK = 0;
  private tachK = 0;

  constructor(scene: THREE.Scene) {
    this.group.visible = false;
    this.group.renderOrder = 5;
    scene.add(this.group);
  }

  /** camera eye position in vehicle-local space for a seat */
  eyeOffset(model: VehicleModel, seat: number): THREE.Vector3 {
    return this.rig(model, seat).eye.clone();
  }

  private rig(model: VehicleModel, seat: number): Rig {
    const key = `${model}:${seat}`;
    let r = this.rigs.get(key);
    if (r) return r;
    r = this.build(model, seat);
    this.rigs.set(key, r);
    return r;
  }

  private build(model: VehicleModel, seat: number): Rig {
    const def = VEHICLES[model];
    const root = new THREE.Group();
    const body = lam(0xffffff);
    const sleeve = lam(0xff6f59);
    const [sx, sy, sz] = seatOffset(def, seat);
    // dash, wheel and console are anchored to the DRIVER seat so passengers (incl. back seats) see them at their real position
    const [sx0, sy0, sz0] = seatOffset(def, 0);
    const fwd = -sz0;
    const W = def.width, H = def.height;
    let steer: THREE.Group | null = null;
    let needle: THREE.Mesh | null = null;
    const driver = seat === 0;

    // jet skis ride like bikes: handlebars + gauge pod, no dash
    if (def.bike || def.model === 'jetski') {
      // tank + handlebars
      root.add(box(0.36, 0.22, 0.7, body, 0, sy0 - 0.05, fwd - 0.55));
      steer = new THREE.Group();
      steer.position.set(0, sy0 + 0.35, fwd - 0.85);
      steer.add(box(0.72, 0.05, 0.05, MAT.chrome, 0, 0, 0));
      steer.add(box(0.12, 0.07, 0.07, MAT.wheel, -0.33, 0, 0), box(0.12, 0.07, 0.07, MAT.wheel, 0.33, 0, 0));
      steer.add(box(0.2, 0.12, 0.08, MAT.gaugeFace, 0, 0.1, 0.02));
      // gauge face is the rider-facing (+z) side of the pod
      needle = box(0.01, 0.042, 0.006, MAT.needle, 0, 0.1, 0.066);
      needle.geometry.translate(0, 0.021, 0); // pivot at the base (gauge centre)
      steer.add(needle);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.046, 0.054, 16), MAT.gaugeGlow);
      ring.position.set(0, 0.1, 0.0615); steer.add(ring);
      if (driver) for (const s of [-1, 1]) {
        steer.add(box(0.09, 0.09, 0.12, MAT.glove, s * 0.33, 0.01, 0.05));
        const arm = box(0.085, 0.085, 0.34, sleeve, s * 0.29, -0.1, 0.2, -0.55, s * 0.3);
        steer.add(arm);
      }
      root.add(steer);
      root.add(box(0.5, 0.06, 0.06, MAT.chrome, 0, sy0 + 0.22, fwd - 1.05)); // headlight bar
      const eye = new THREE.Vector3(sx, sy + 0.78, -sz + 0.15);
      return { root, body, sleeve, steer, needle, tach: null, eye };
    }

    if (def.boat) {
      root.add(box(W * 0.55, 0.75, 0.45, MAT.trim, sx0, sy0 - 0.05, fwd - 0.95));
      root.add(box(W * 0.55, 0.05, 0.5, MAT.dashTop, sx0, sy0 + 0.34, fwd - 0.95));
      root.add(box(0.2, 0.1, 0.02, MAT.screen, sx0 + 0.17, sy0 + 0.42, fwd - 0.82, -0.6));
      const ws = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.75, 0.42), MAT.glass);
      ws.position.set(0, sy0 + 0.62, fwd - 1.25); ws.rotation.x = 0.35;
      root.add(ws);
      root.add(box(W * 0.75, 0.04, 0.04, MAT.chrome, 0, sy0 + 0.82, fwd - 1.18));
      steer = new THREE.Group();
      steer.position.set(sx0, sy0 + 0.5, fwd - 0.74);
      steer.rotation.x = -0.9;
      const rim = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.02, 6, 20), MAT.chrome);
      steer.add(rim);
      for (let i = 0; i < 6; i++) { const sp = box(0.02, 0.17, 0.02, MAT.chrome, 0, 0, 0); sp.rotation.z = (i / 6) * Math.PI * 2; sp.translateY(0.085); steer.add(sp); }
      if (driver) for (const s of [-1, 1]) steer.add(box(0.08, 0.1, 0.08, MAT.glove, s * 0.16, 0.02, 0.03));
      root.add(steer);
      // bow deck in hull colour
      root.add(box(W * 0.9, 0.12, def.length * 0.42, body, 0, sy0 + 0.12, -def.length * 0.3));
      // throttle gauge on the console
      const face = new THREE.Mesh(new THREE.CircleGeometry(0.06, 16), MAT.gaugeFace);
      face.position.set(sx0 - 0.17, sy0 + 0.4, fwd - 0.8); face.rotation.x = -0.6; root.add(face);
      needle = box(0.008, 0.05, 0.004, MAT.needle, 0, 0, 0);
      needle.geometry.translate(0, 0.025, 0);
      const ng = new THREE.Group(); ng.position.copy(face.position); ng.rotation.x = -0.6; ng.add(needle); needle.position.z = 0.004; root.add(ng);
      const eye = new THREE.Vector3(sx, sy + 0.95, -sz + 0.1);
      return { root, body, sleeve, steer, needle, tach: null, eye };
    }

    // ── cars, vans, police ──
    const eyeY = Math.min(H - 0.3, sy + 0.78);
    const dashZ = fwd - 0.78;
    const dashY = eyeY - 0.42;
    // hood (paint) visible through the windscreen
    // cab-over trucks/buses have no hood in front of the windscreen
    const hoodLen = def.length / 2 - (-dashZ) - 0.1;
    if (hoodLen > 0.5) root.add(box(W - 0.1, 0.08, hoodLen, body, 0, dashY - 0.06, dashZ - 0.25 - hoodLen / 2, 0.06));
    const open = def.model === 'buggy';
    // dashboard
    root.add(box(W - 0.14, 0.32, 0.55, MAT.dash, 0, dashY - 0.12, dashZ));
    root.add(box(W - 0.14, 0.05, 0.6, MAT.dashTop, 0, dashY + 0.06, dashZ - 0.04));
    root.add(box(W - 0.14, 0.05, 0.06, MAT.trim, 0, dashY - 0.02, dashZ + 0.29)); // trim strip
    // centre stack + screen
    root.add(box(0.36, 0.42, 0.12, MAT.dash, 0, dashY - 0.22, dashZ + 0.24));
    root.add(box(0.24, 0.14, 0.02, MAT.screen, 0, dashY - 0.1, dashZ + 0.31, -0.25));
    root.add(box(0.05, 0.03, 0.01, MAT.led, -0.08, dashY - 0.25, dashZ + 0.31), box(0.05, 0.03, 0.01, MAT.led, 0.08, dashY - 0.25, dashZ + 0.31));
    // instrument cluster in front of the driver
    const sideX = seatOffset(def, 0)[0];
    const cluster = new THREE.Group();
    cluster.position.set(sideX, dashY + 0.02, dashZ + 0.2);
    cluster.rotation.x = -0.35;
    cluster.add(box(0.42, 0.16, 0.06, MAT.dashTop, 0, 0.04, -0.02));
    for (const gx of [-0.1, 0.1]) {
      const face = new THREE.Mesh(new THREE.CircleGeometry(0.065, 18), MAT.gaugeFace);
      face.position.set(gx, 0.04, 0.012); cluster.add(face);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.058, 0.066, 18), MAT.gaugeGlow);
      ring.position.set(gx, 0.04, 0.013); cluster.add(ring);
    }
    needle = box(0.008, 0.055, 0.004, MAT.needle, -0.1, 0.04, 0.016);
    needle.geometry.translate(0, 0.0275, 0);
    cluster.add(needle);
    const tach = box(0.008, 0.05, 0.004, MAT.needle, 0.1, 0.04, 0.016);
    tach.geometry.translate(0, 0.025, 0);
    cluster.add(tach);
    root.add(cluster);
    // steering wheel
    steer = new THREE.Group();
    steer.position.set(sideX, dashY - 0.02, dashZ + 0.42);
    steer.rotation.x = -1.15;
    const rimMesh = new THREE.Mesh(new THREE.TorusGeometry(0.18, 0.026, 8, 24), MAT.wheel);
    steer.add(rimMesh);
    steer.add(box(0.07, 0.07, 0.05, MAT.trim, 0, 0, -0.01));
    for (const a of [Math.PI / 2, Math.PI * 7 / 6, -Math.PI / 6]) { const sp = box(0.03, 0.17, 0.02, MAT.wheel, 0, 0, 0); sp.rotation.z = a; sp.translateY(-0.085); steer.add(sp); }
    steer.add(box(0.04, 0.02, 0.02, MAT.led, 0, 0.175, 0.02)); // top-centre marker
    if (driver) {
      for (const s of [-1, 1]) {
        steer.add(box(0.075, 0.1, 0.075, MAT.skin, s * 0.175, 0.02, 0.02));
        // short cuff only: full forearms filled the lower corners of the view
        steer.add(box(0.085, 0.085, 0.09, sleeve, s * 0.178, -0.02, 0.085));
      }
    }
    root.add(steer);
    // A-pillars, roof liner, header, mirror
    const roofY = H - 0.06;
    if (open) {
      // roll cage instead of pillars/roof/glass
      for (const s of [-1, 1]) {
        const px = s * (W / 2 - 0.12);
        root.add(box(0.06, roofY - dashY, 0.06, MAT.chrome, px, (roofY + dashY) / 2, dashZ - 0.1, -0.35));
        root.add(box(0.06, 0.06, 2.0, MAT.chrome, px, roofY, dashZ + 0.9));
        root.add(box(0.06, 0.06, 1.0, MAT.trim, px, dashY - 0.05, dashZ + 1.1));
      }
      root.add(box(W - 0.2, 0.06, 0.06, MAT.chrome, 0, roofY, dashZ - 0.2));
      const eye = new THREE.Vector3(sx, eyeY, -sz + 0.12);
      return { root, body, sleeve, steer, needle, tach, eye };
    }
    for (const s of [-1, 1]) {
      const px = s * (W / 2 - 0.09);
      const p = box(0.06, (roofY - dashY) * 1.2, 0.08, MAT.trim, px, (roofY + dashY) / 2, dashZ - 0.03, 0.57); // top leans back toward the driver
      root.add(p);
      // beltline / door top
      root.add(box(0.07, 0.07, 2.3, MAT.trim, px, dashY - 0.02, dashZ + 1.2));
      // door card
      root.add(box(0.05, 0.38, 2.0, MAT.dash, px * 1.0, dashY - 0.25, dashZ + 1.25));
    }
    root.add(box(W - 0.1, 0.06, 0.14, MAT.trim, 0, roofY - 0.02, dashZ + 0.12)); // header (raked windscreen: sits back over the dash)
    const liner = box(W - 0.1, 0.03, 2.1, MAT.liner, 0, roofY, dashZ + 1.22);
    root.add(liner);
    root.add(box(0.26, 0.07, 0.03, MAT.mirror, 0, roofY - 0.12, dashZ + 0.2, 0.25));
    root.add(box(0.04, 0.08, 0.03, MAT.trim, 0, roofY - 0.06, dashZ + 0.16));
    // windscreen tint + wipers (subtle)
    const ws = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.2, roofY - dashY), MAT.glass);
    ws.position.set(0, (roofY + dashY) / 2, dashZ - 0.05); ws.rotation.x = 0.57; ws.scale.y = 1.2;
    root.add(ws);
    // seats in view (passenger/driver headrests ahead when in the back)
    if (seat >= 2) for (const s of [-1, 1]) {
      const fx = seatOffset(def, s < 0 ? 0 : 1)[0], fz = -seatOffset(def, 0)[2];
      root.add(box(0.5, 0.65, 0.12, MAT.seat, fx, sy + 0.45, fz + 0.25));
      root.add(box(0.26, 0.2, 0.1, MAT.seat, fx, sy + 0.9, fz + 0.25));
    }
    const eye = new THREE.Vector3(sx, eyeY, -sz + 0.12);
    return { root, body, sleeve, steer, needle, tach, eye };
  }

  /**
   * Show the cockpit for the given vehicle pose (world), or hide with `null`.
   * steer in -1..1, speed in m/s.
   */
  update(dt: number, v: { model: VehicleModel; seat: number; x: number; y: number; z: number; yaw: number; steer: number; speed: number; color: number; outfit: number; rpm?: number; pitch?: number; roll?: number; mirror?: THREE.Color } | null) {
    if (!v) { this.group.visible = false; return; }
    const r = this.rig(v.model, v.seat);
    if (this.active !== r) {
      this.group.clear();
      this.group.add(r.root);
      this.active = r;
    }
    this.group.visible = true;
    r.body.color.setHex(v.color);
    r.sleeve.color.setHex(v.outfit);
    this.group.position.set(v.x, v.y, v.z);
    this.group.rotation.set(v.pitch ?? 0, v.yaw, v.roll ?? 0, 'YXZ');
    if (v.mirror) MAT.mirror.color.copy(v.mirror).multiplyScalar(0.85);
    // wheel follows steering input smoothly (about 2 turns lock-to-lock feel, capped visually)
    const target = -v.steer * 1.7;
    this.wheelAngle += (target - this.wheelAngle) * Math.min(1, dt * 12);
    if (r.steer) {
      const def = VEHICLES[v.model];
      if (def.bike) r.steer.rotation.y = this.wheelAngle * 0.35;
      else r.steer.rotation.z = this.wheelAngle;
    }
    // speedo sweeps clockwise from lower-left (0) to lower-right (max); boats show throttle/rpm
    const def = VEHICLES[v.model];
    const sp01 = Math.min(1, Math.abs(v.speed) / def.maxSpeed);
    this.needleK += ((def.boat ? (v.rpm ?? sp01) : sp01) - this.needleK) * Math.min(1, dt * 10);
    if (r.needle) r.needle.rotation.z = 2.2 - this.needleK * 4.4;
    if (r.tach) { this.tachK += ((v.rpm ?? 0) - this.tachK) * Math.min(1, dt * 14); r.tach.rotation.z = 2.2 - this.tachK * 4.4; }
  }
}

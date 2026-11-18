/** Objective markers (beams, chevrons, diamonds, ring gates, danger zones) and teammate pings. Shape = primary cue, colour second. */
import * as THREE from 'three';
import type { ObjectiveView } from '@blockshore/shared';
import { Bin, canvas2d, clamp, smoothTexture, textTexture } from './util';

type MarkerData = ObjectiveView['markers'][number];
type Shape = MarkerData['shape'];

const COLORS: Record<string, string> = {
  go: '#35d6ff', interact: '#ffe27a', vehicle: '#7dff8f', deliver: '#ffb02e', checkpoint: '#c4ff3a', danger: '#ff3b3b',
};
const PING_COLORS: Record<string, string> = { go: '#35d6ff', danger: '#ff3b3b', loot: '#ffd23f', vehicle: '#7dff8f' };

function shapePath(c: CanvasRenderingContext2D, shape: Shape, cx: number, cy: number, r: number) {
  c.beginPath();
  switch (shape) {
    case 'circle': c.arc(cx, cy, r, 0, Math.PI * 2); break;
    case 'diamond': c.moveTo(cx, cy - r * 1.2); c.lineTo(cx + r * 0.9, cy); c.lineTo(cx, cy + r * 1.2); c.lineTo(cx - r * 0.9, cy); c.closePath(); break;
    case 'triangle': c.moveTo(cx, cy - r * 1.05); c.lineTo(cx + r * 1.05, cy + r * 0.8); c.lineTo(cx - r * 1.05, cy + r * 0.8); c.closePath(); break;
    case 'square': c.rect(cx - r * 0.85, cy - r * 0.85, r * 1.7, r * 1.7); break;
  }
}

/** colour-blind pattern per shape so identical hues stay distinguishable */
function patternFor(c: CanvasRenderingContext2D, shape: Shape) {
  c.save(); c.globalAlpha = 0.9; c.strokeStyle = '#0b0e14'; c.fillStyle = '#0b0e14'; c.lineWidth = 6;
  if (shape === 'circle') { for (let x = -128; x < 256; x += 22) { c.beginPath(); c.moveTo(x, 128); c.lineTo(x + 128, 0); c.stroke(); } }          // diagonal stripes
  else if (shape === 'diamond') { for (let y = 10; y < 128; y += 20) for (let x = (y / 20) % 2 ? 10 : 20; x < 128; x += 20) { c.beginPath(); c.arc(x, y, 4.5, 0, 7); c.fill(); } } // dots
  else if (shape === 'triangle') { for (let y = 12; y < 128; y += 18) { c.beginPath(); c.moveTo(0, y); c.lineTo(128, y); c.stroke(); } }                // horizontal bars
  else { for (let x = 8; x < 128; x += 22) for (let y = 8; y < 128; y += 22) if (((x + y) / 22) % 2 < 1) c.fillRect(x, y, 14, 14); }                        // checker
  c.restore();
}

export class MarkerAssets {
  bin = new Bin();
  private glyphs = new Map<string, THREE.SpriteMaterial>();
  private tagMats = new Map<string, THREE.SpriteMaterial>();
  ringTex: THREE.CanvasTexture; zoneTex: THREE.CanvasTexture; dashTex: THREE.CanvasTexture; hatchTex: THREE.CanvasTexture;
  beamGeo: THREE.CylinderGeometry; flatGeo: THREE.PlaneGeometry; torusGeo: THREE.TorusGeometry; octaGeo: THREE.OctahedronGeometry; chevGeo: THREE.BufferGeometry; coneGeo: THREE.ConeGeometry; wallGeo: THREE.CylinderGeometry;
  constructor() {
    const [r, rc] = canvas2d(128, 128);
    const g = rc.createRadialGradient(64, 64, 20, 64, 64, 62);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.55, 'rgba(255,255,255,0.15)'); g.addColorStop(0.82, 'rgba(255,255,255,1)'); g.addColorStop(0.9, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    rc.fillStyle = g; rc.fillRect(0, 0, 128, 128);
    this.ringTex = this.bin.add(smoothTexture(r));
    const [z, zc] = canvas2d(128, 128);
    const zg = zc.createRadialGradient(64, 64, 0, 64, 64, 62);
    zg.addColorStop(0, 'rgba(255,255,255,0.12)'); zg.addColorStop(0.8, 'rgba(255,255,255,0.3)'); zg.addColorStop(0.93, 'rgba(255,255,255,0.95)'); zg.addColorStop(1, 'rgba(255,255,255,0)');
    zc.fillStyle = zg; zc.fillRect(0, 0, 128, 128);
    this.zoneTex = this.bin.add(smoothTexture(z));
    const [d, dc] = canvas2d(64, 16);
    dc.fillStyle = '#fff'; dc.fillRect(0, 0, 64, 16); dc.fillStyle = '#000'; for (let i = 0; i < 4; i++) dc.fillRect(i * 16 + 8, 0, 8, 16);
    this.dashTex = this.bin.add(smoothTexture(d)); this.dashTex.wrapS = this.dashTex.wrapT = THREE.RepeatWrapping; this.dashTex.repeat.set(6, 1);
    const [h, hc] = canvas2d(64, 64);
    hc.fillStyle = '#fff'; hc.fillRect(0, 0, 64, 64); hc.strokeStyle = '#000'; hc.lineWidth = 10; for (let i = -64; i < 128; i += 22) { hc.beginPath(); hc.moveTo(i, 64); hc.lineTo(i + 64, 0); hc.stroke(); }
    this.hatchTex = this.bin.add(smoothTexture(h)); this.hatchTex.wrapS = this.hatchTex.wrapT = THREE.RepeatWrapping; this.hatchTex.repeat.set(10, 2);
    this.beamGeo = this.bin.add(new THREE.CylinderGeometry(1, 1, 1, 28, 1, true)); this.beamGeo.translate(0, 0.5, 0);
    this.wallGeo = this.bin.add(new THREE.CylinderGeometry(1, 1, 1, 48, 1, true)); this.wallGeo.translate(0, 0.5, 0);
    this.flatGeo = this.bin.add(new THREE.PlaneGeometry(1, 1)); this.flatGeo.rotateX(-Math.PI / 2);
    this.torusGeo = this.bin.add(new THREE.TorusGeometry(1, 0.06, 8, 40));
    this.octaGeo = this.bin.add(new THREE.OctahedronGeometry(0.5, 0));
    this.coneGeo = this.bin.add(new THREE.ConeGeometry(0.5, 1, 4));
    // chevron: V made from two slanted bars (points down)
    const cs = new THREE.Shape(); cs.moveTo(-1, 0.4); cs.lineTo(0, -0.5); cs.lineTo(1, 0.4); cs.lineTo(1, 0.85); cs.lineTo(0, -0.05); cs.lineTo(-1, 0.85); cs.closePath();
    const eg = new THREE.ExtrudeGeometry(cs, { depth: 0.3, bevelEnabled: false }); eg.translate(0, 0, -0.15);
    this.chevGeo = this.bin.add(eg);
  }
  glyph(shape: Shape, kind: string, colorblind: boolean): THREE.SpriteMaterial {
    const key = `${shape}|${kind}|${colorblind}`;
    let m = this.glyphs.get(key);
    if (m) return m;
    const [c, ctx] = canvas2d(128, 128);
    const col = COLORS[kind] ?? '#ffffff';
    // dark outline, white rim, coloured fill
    shapePath(ctx, shape, 64, 66, 48); ctx.fillStyle = 'rgba(8,12,20,0.92)'; ctx.fill(); ctx.lineWidth = 12; ctx.strokeStyle = 'rgba(8,12,20,0.92)'; ctx.lineJoin = 'round'; ctx.stroke();
    shapePath(ctx, shape, 64, 66, 42); ctx.fillStyle = '#ffffff'; ctx.fill();
    shapePath(ctx, shape, 64, 66, 35); ctx.fillStyle = col; ctx.fill();
    if (colorblind) { ctx.save(); shapePath(ctx, shape, 64, 66, 35); ctx.clip(); patternFor(ctx, shape); ctx.restore(); }
    // inner glyph by kind
    ctx.fillStyle = '#0b0e14'; ctx.strokeStyle = '#0b0e14'; ctx.lineWidth = 7; ctx.lineCap = 'round';
    if (kind === 'go') { ctx.beginPath(); ctx.moveTo(52, 80); ctx.lineTo(64, 52); ctx.lineTo(76, 80); ctx.stroke(); }
    else if (kind === 'interact') { ctx.fillRect(61, 48, 6, 22); ctx.beginPath(); ctx.arc(64, 82, 4.5, 0, 7); ctx.fill(); }
    else if (kind === 'vehicle') { ctx.fillRect(48, 66, 32, 10); ctx.fillRect(54, 58, 20, 8); ctx.beginPath(); ctx.arc(54, 78, 4, 0, 7); ctx.arc(74, 78, 4, 0, 7); ctx.fill(); }
    else if (kind === 'deliver') { ctx.fillRect(50, 56, 28, 22); ctx.strokeRect(50, 56, 28, 22); ctx.fillStyle = col; ctx.fillRect(61, 56, 6, 22); }
    else if (kind === 'checkpoint') { ctx.beginPath(); ctx.arc(64, 66, 14, 0, 7); ctx.stroke(); }
    else if (kind === 'danger') { ctx.fillRect(61, 48, 6, 22); ctx.beginPath(); ctx.arc(64, 82, 4.5, 0, 7); ctx.fill(); }
    m = this.bin.add(new THREE.SpriteMaterial({ map: this.bin.add(smoothTexture(c)), transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false }));
    this.glyphs.set(key, m);
    return m;
  }
  tag(text: string, color = '#ffffff'): { mat: THREE.SpriteMaterial; ratio: number } {
    const key = text + '|' + color;
    const t = textTexture(text, color, { size: 26 });
    let m = this.tagMats.get(key);
    if (!m) { m = this.bin.add(new THREE.SpriteMaterial({ map: t.tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false })); this.tagMats.set(key, m); }
    return { mat: m, ratio: t.w / t.h };
  }
  dispose() { this.bin.disposeAll(); this.glyphs.clear(); this.tagMats.clear(); }
}

// ───────────────────────────────────────────────────────────── beam shader
function makeBeamMaterial(color: string, colorblind: boolean, tex: THREE.Texture | null): THREE.ShaderMaterial {
  const c = new THREE.Color(color);
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false,
    uniforms: { uColor: { value: c.multiplyScalar(1.5) }, uTime: { value: 0 }, uCam: { value: new THREE.Vector3() }, uCb: { value: colorblind ? 1 : 0 }, uH: { value: 60 }, uTex: { value: tex } },
    vertexShader: `varying float vY; varying vec3 vW; varying vec2 vUv; void main(){ vY = position.y; vUv = uv; vec4 w = modelMatrix*vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix*viewMatrix*w; }`,
    fragmentShader: `uniform vec3 uColor; uniform float uTime; uniform vec3 uCam; uniform float uCb; uniform float uH; varying float vY; varying vec3 vW; varying vec2 vUv;
      void main(){
        float a = pow(1.0 - vY, 1.4) * 0.55 + 0.08 * (1.0 - vY);
        a *= 0.8 + 0.2 * sin(vY * uH * 0.7 - uTime * 3.0);
        float dcam = distance(vW.xz, uCam.xz);
        a *= smoothstep(1.2, 7.0, dcam);
        if (uCb > 0.5) { float s = step(0.5, fract(vUv.x * 6.0 + vY * uH * 0.15 - uTime * 0.4)); a *= 0.35 + 0.65 * s; }
        gl_FragColor = vec4(uColor, a);
      }`,
  });
}

const mats = { basic: (c: string, k = 1.6, o = 1) => new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(k), toneMapped: false, transparent: o < 1, opacity: o }) };

// ───────────────────────────────────────────────────────────── marker rigs
class MarkerRig {
  readonly root = new THREE.Group();
  readonly sig: string;
  glyph: THREE.Sprite; label: THREE.Sprite | null = null;
  beam: THREE.Mesh | null = null; beamMat: THREE.ShaderMaterial | null = null;
  base: THREE.Mesh | null = null;
  spinner: THREE.Mesh | null = null;
  gate: THREE.Group | null = null;
  zone: THREE.Mesh | null = null; wall: THREE.Mesh | null = null;
  kind: string; shape: Shape;
  private own = new Bin();
  constructor(readonly sys: MarkerSystem, m: MarkerData, colorblind: boolean) {
    this.kind = m.kind; this.shape = m.shape;
    this.sig = sigOf(m, colorblind);
    const A = sys.assets, col = COLORS[m.kind] ?? '#fff';
    this.glyph = new THREE.Sprite(A.glyph(m.shape, m.kind, colorblind)); this.glyph.renderOrder = 30; this.root.add(this.glyph);
    if (m.label) { const t = A.tag(m.label, '#ffffff'); this.label = new THREE.Sprite(t.mat); this.label.userData.ratio = t.ratio; this.label.renderOrder = 31; this.root.add(this.label); }
    const own = <T extends { dispose(): void }>(x: T) => this.own.add(x);
    switch (m.kind) {
      case 'go': case 'deliver': {
        this.beamMat = own(makeBeamMaterial(col, colorblind, null));
        this.beam = new THREE.Mesh(A.beamGeo, this.beamMat); this.beam.frustumCulled = false; this.root.add(this.beam);
        const rm = own(new THREE.MeshBasicMaterial({ map: A.ringTex, color: new THREE.Color(col).multiplyScalar(1.8), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
        this.base = new THREE.Mesh(A.flatGeo, rm); this.base.position.y = 0.07; this.root.add(this.base);
        break;
      }
      case 'vehicle': {
        const cm = own(mats.basic(col, 1.7));
        this.spinner = new THREE.Mesh(A.chevGeo, cm); this.spinner.rotation.x = 0; this.root.add(this.spinner);
        const rm = own(new THREE.MeshBasicMaterial({ map: A.ringTex, color: new THREE.Color(col).multiplyScalar(1.6), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
        this.base = new THREE.Mesh(A.flatGeo, rm); this.base.position.y = 0.07; this.root.add(this.base);
        break;
      }
      case 'interact': {
        const dm = own(mats.basic(col, 1.9));
        this.spinner = new THREE.Mesh(A.octaGeo, dm); this.root.add(this.spinner);
        const rm = own(new THREE.MeshBasicMaterial({ map: A.ringTex, color: new THREE.Color(col).multiplyScalar(1.5), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
        this.base = new THREE.Mesh(A.flatGeo, rm); this.base.position.y = 0.07; this.root.add(this.base);
        break;
      }
      case 'checkpoint': {
        this.gate = new THREE.Group();
        const gm = own(new THREE.MeshBasicMaterial({ color: new THREE.Color(col).multiplyScalar(2.0), map: colorblind ? A.dashTex : null, toneMapped: false }));
        const t1 = new THREE.Mesh(A.torusGeo, gm); const t2 = new THREE.Mesh(A.torusGeo, gm); t2.scale.setScalar(0.78);
        const fill = own(new THREE.MeshBasicMaterial({ color: new THREE.Color(col).multiplyScalar(1.0), transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false }));
        const disc = new THREE.Mesh(own(new THREE.CircleGeometry(0.95, 32)), fill);
        this.gate.add(t1, t2, disc); this.root.add(this.gate);
        const rm = own(new THREE.MeshBasicMaterial({ map: A.ringTex, color: new THREE.Color(col).multiplyScalar(1.5), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
        this.base = new THREE.Mesh(A.flatGeo, rm); this.base.position.y = 0.07; this.root.add(this.base);
        break;
      }
      case 'danger': {
        const zm = own(new THREE.MeshBasicMaterial({ map: A.zoneTex, color: new THREE.Color(col).multiplyScalar(1.6), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
        this.zone = new THREE.Mesh(A.flatGeo, zm); this.zone.position.y = 0.09; this.root.add(this.zone);
        const wm = own(new THREE.MeshBasicMaterial({ map: A.hatchTex, color: new THREE.Color(col).multiplyScalar(1.4), transparent: true, opacity: colorblind ? 0.5 : 0.28, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false, alphaMap: A.hatchTex }));
        this.wall = new THREE.Mesh(A.wallGeo, wm); this.wall.frustumCulled = false; this.root.add(this.wall);
        break;
      }
    }
  }
  update(t: number, cam: THREE.Vector3, m: MarkerData, camera: THREE.PerspectiveCamera) {
    const dx = m.x - cam.x, dz = m.z - cam.z, dy = m.y - cam.y;
    const dist = Math.sqrt(dx * dx + dz * dz + dy * dy);
    this.root.position.set(m.x, m.y, m.z);
    const k = camera.fov / 75;
    const s = clamp(dist * 0.045 * k, 0.9, 16);       // glyph world size (~constant on screen)
    const kind = this.kind;
    let gy = 3.2 + s * 0.55;
    switch (kind) {
      case 'go': case 'deliver': {
        const r = clamp(0.55 + dist * 0.012, 0.6, 2.4);
        const H = 90;
        this.beam!.scale.set(r, H, r); this.beamMat!.uniforms.uTime.value = t; this.beamMat!.uniforms.uCam.value.copy(cam); this.beamMat!.uniforms.uH.value = H;
        const pulse = 1 + Math.sin(t * 3) * 0.08; this.base!.scale.setScalar(r * 3.6 * pulse);
        (this.base!.material as THREE.MeshBasicMaterial).opacity = 0.7 + Math.sin(t * 3) * 0.2;
        gy = 4.5 + s * 0.6 + Math.sin(t * 2) * 0.2;
        break;
      }
      case 'vehicle': {
        const bounce = Math.abs(Math.sin(t * 3.2)) * 0.9;
        const cs = clamp(0.9 + dist * 0.025, 1, 6);
        this.spinner!.position.y = 3.0 + cs * 0.9 + bounce * cs * 0.5; this.spinner!.scale.set(cs * 0.9, cs * 0.9, cs * 0.9); this.spinner!.rotation.y = t * 1.4;
        this.base!.scale.setScalar(2.6 + Math.sin(t * 3.2) * 0.2); gy = this.spinner!.position.y + cs * 1.3;
        break;
      }
      case 'interact': {
        const ds = clamp(0.5 + dist * 0.03, 0.6, 3);
        this.spinner!.position.y = 1.6 + ds * 0.4 + Math.sin(t * 2.2) * 0.12; this.spinner!.scale.set(ds * 0.6, ds, ds * 0.6); this.spinner!.rotation.y = t * 2;
        this.base!.scale.setScalar(1.3 + Math.sin(t * 3) * 0.12); gy = this.spinner!.position.y + ds * 0.9;
        break;
      }
      case 'checkpoint': {
        const R = 4 + clamp(dist * 0.01, 0, 2);
        // face the camera horizontally
        this.gate!.position.y = R + 0.4; this.gate!.scale.setScalar(R); this.gate!.rotation.y = Math.atan2(dx, dz) * -1 + Math.PI;
        this.gate!.rotation.y = Math.atan2(-dx, -dz);
        this.gate!.children[1].rotation.z = t * 0.8;
        this.base!.scale.setScalar(R * 1.4);
        gy = R * 2 + 1.6 + s * 0.3;
        break;
      }
      case 'danger': {
        const R = 9;
        const pul = 0.5 + 0.5 * Math.sin(t * 3.2);
        this.zone!.scale.setScalar(R * 2 * (1 + pul * 0.03)); (this.zone!.material as THREE.MeshBasicMaterial).opacity = 0.55 + pul * 0.4;
        this.wall!.scale.set(R, 4, R); (this.wall!.material as THREE.MeshBasicMaterial).opacity = (0.22 + pul * 0.14);
        this.wall!.rotation.y = t * 0.1;
        gy = 5.5 + s * 0.5;
        break;
      }
    }
    this.glyph.position.set(0, gy, 0); this.glyph.scale.set(s, s, 1);
    if (this.label) {
      const ls = s * 0.34;
      this.label.scale.set(ls * (this.label.userData.ratio as number), ls, 1); this.label.position.set(0, gy + s * 0.78, 0);
    }
  }
  dispose() { this.own.disposeAll(); }
}

function sigOf(m: MarkerData, cb: boolean) { return `${m.kind}|${m.shape}|${m.label ?? ''}|${cb ? 1 : 0}`; }

// ───────────────────────────────────────────────────────────── pings
interface PingRig { root: THREE.Group; ripple: THREE.Mesh; arrow: THREE.Mesh; label: THREE.Sprite; born: number; key: string; kind: string }

export class MarkerSystem {
  readonly group = new THREE.Group();
  readonly assets = new MarkerAssets();
  private rigs: MarkerRig[] = [];
  private data: MarkerData[] = [];
  private cb = false;
  private pings = new Map<string, PingRig>();
  private clock = 0;
  private pingMats = new Map<string, THREE.MeshBasicMaterial>();

  set(markers: MarkerData[], colorblind: boolean) {
    this.data = markers.slice(0, 24);
    this.cb = colorblind;
    // reuse rigs where the signature is unchanged; rebuild the rest
    const next: MarkerRig[] = [];
    const pool = this.rigs.slice();
    for (const m of this.data) {
      const sig = sigOf(m, colorblind);
      const i = pool.findIndex((r) => r.sig === sig);
      if (i >= 0) { next.push(pool.splice(i, 1)[0]); }
      else { const r = new MarkerRig(this, m, colorblind); this.group.add(r.root); next.push(r); }
    }
    for (const r of pool) { r.root.removeFromParent(); r.dispose(); }
    this.rigs = next;
  }

  setPings(pings: { x: number; y: number; z: number; kind: string; from: string; at: number }[]) {
    const seen = new Set<string>();
    for (const p of pings) {
      const key = `${p.kind}|${p.from}|${p.at}|${p.x.toFixed(1)}|${p.z.toFixed(1)}`;
      seen.add(key);
      if (this.pings.has(key)) continue;
      const col = PING_COLORS[p.kind] ?? '#ffffff';
      let m = this.pingMats.get(col);
      if (!m) { m = this.assets.bin.add(new THREE.MeshBasicMaterial({ map: this.assets.ringTex, color: new THREE.Color(col).multiplyScalar(1.8), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false })); this.pingMats.set(col, m); }
      const root = new THREE.Group(); root.position.set(p.x, p.y, p.z);
      const ripple = new THREE.Mesh(this.assets.flatGeo, m); ripple.position.y = 0.1; ripple.material = m; root.add(ripple);
      const arrowMat = this.assets.bin.add(mats.basic(col, 1.9)); const arrow = new THREE.Mesh(this.assets.coneGeo, arrowMat); arrow.rotation.x = Math.PI; root.add(arrow);
      const t = this.assets.tag(`${p.from}: ${p.kind === 'go' ? 'Go here' : p.kind === 'danger' ? 'Danger' : p.kind === 'loot' ? 'Loot' : 'Vehicle'}`, col);
      const label = new THREE.Sprite(t.mat); label.userData.ratio = t.ratio; label.renderOrder = 31; root.add(label);
      this.group.add(root);
      this.pings.set(key, { root, ripple, arrow, label, born: this.clock, key, kind: p.kind });
    }
    for (const [k, r] of this.pings) if (!seen.has(k)) { r.root.removeFromParent(); this.pings.delete(k); }
  }

  update(dt: number, camera: THREE.PerspectiveCamera) {
    this.clock += dt;
    const cam = camera.position;
    for (let i = 0; i < this.rigs.length; i++) this.rigs[i].update(this.clock, cam, this.data[i], camera);
    for (const [k, r] of this.pings) {
      const age = this.clock - r.born;
      if (age > 9) { r.root.removeFromParent(); this.pings.delete(k); continue; }
      const dist = r.root.position.distanceTo(cam);
      const s = clamp(dist * 0.03, 0.8, 8);
      const ph = (age * 0.9) % 1;
      r.ripple.scale.setScalar(2 + ph * 7); (r.ripple.material as THREE.MeshBasicMaterial).opacity = (1 - ph) * clamp(9 - age, 0, 1);
      r.arrow.position.y = 2.6 + s * 0.8 + Math.abs(Math.sin(age * 4)) * 0.6; r.arrow.scale.set(s * 0.8, s * 1.3, s * 0.8);
      const ls = s * 0.4; r.label.scale.set(ls * (r.label.userData.ratio as number), ls, 1); r.label.position.y = r.arrow.position.y + s * 1.1;
    }
  }
  dispose() { for (const r of this.rigs) r.dispose(); this.rigs = []; this.pings.clear(); this.assets.dispose(); }
}

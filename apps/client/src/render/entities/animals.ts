/** Original blocky wildlife (r = 'animal:<kind>'): shared vertex-coloured part geometries, one tiny rig per animal, procedural animation. */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { NpcEnt } from '@blockshore/shared';
import { Bin, clamp, lerpAngle } from './util';

type Box = [w: number, h: number, d: number, cx: number, cy: number, cz: number, color: string];
interface Part { name: string; parent?: string; at: [number, number, number]; boxes: Box[] }

const mirror = (b: Box): Box => [b[0], b[1], b[2], -b[3], b[4], b[5], b[6]];

function model(kind: string, v: number): Part[] {
  const P: Part[] = [];
  const add = (name: string, at: [number, number, number], boxes: Box[], parent?: string) => P.push({ name, at, boxes, parent });
  const legs4 = (x: number, y: number, zf: number, zb: number, w: number, h: number, col: string, hoof: string) => {
    for (const [n, sx, z] of [['legFL', 1, -zf], ['legFR', -1, -zf], ['legBL', 1, zb], ['legBR', -1, zb]] as const)
      add(n, [sx * x, y, z], [[w, h, w, 0, -h / 2, 0, col], [w * 1.1, h * 0.12, w * 1.2, 0, -h + h * 0.06, -w * 0.1, hoof]]);
  };
  switch (kind) {
    case 'gator': {
      const g = ['#3e5a2e', '#47612f', '#35502e', '#4a5a34'][v & 3], gd = '#2a4020', belly = '#c9c58a';
      const scutes: Box[] = [];
      for (let i = 0; i < 6; i++) for (const s of [-1, 1]) scutes.push([0.1, 0.06, 0.14, s * 0.13, 0.44, -0.45 + i * 0.18, gd]);
      add('body', [0, 0, 0], [[0.62, 0.26, 1.3, 0, 0.28, 0, g], [0.5, 0.08, 1.2, 0, 0.15, 0, belly], ...scutes]);
      add('head', [0, 0.3, -0.65], [[0.42, 0.2, 0.35, 0, 0, -0.1, g], [0.3, 0.12, 0.55, 0, -0.02, -0.5, g], [0.07, 0.07, 0.07, 0.14, 0.12, -0.12, '#e6c43a'], [0.07, 0.07, 0.07, -0.14, 0.12, -0.12, '#e6c43a'], [0.05, 0.03, 0.04, 0.06, 0.05, -0.78, '#111']]);
      add('jaw', [0, 0.26, -0.65], [[0.28, 0.06, 0.55, 0, -0.04, -0.5, belly]]);
      add('tail1', [0, 0.28, 0.65], [[0.4, 0.2, 0.6, 0, 0, 0.3, g]]);
      add('tail2', [0, 0.28, 1.25], [[0.26, 0.14, 0.6, 0, 0, 0.3, g]]);
      add('tail3', [0, 0.27, 1.85], [[0.14, 0.1, 0.5, 0, 0, 0.25, gd]]);
      legs4(0.36, 0.2, 0.4, 0.4, 0.16, 0.2, g, gd);
      break;
    }
    case 'heron': case 'egret': {
      const egret = kind === 'egret';
      const body = egret ? '#f4f4ef' : ['#8fa3b5', '#7d93a8', '#9aabb8', '#8a9aa6'][v & 3], dark = egret ? '#e2e2da' : '#4b5a68', beak = egret ? '#f0b323' : '#d6a437', leg = egret ? '#1a1a1a' : '#c9ac48';
      add('body', [0, 0.65, 0], [[0.22, 0.26, 0.55, 0, 0, 0.05, body], [0.18, 0.1, 0.4, 0, -0.1, 0.0, dark], [0.1, 0.06, 0.22, 0, 0.02, 0.4, dark]]);
      add('neck', [0, 0.75, -0.2], [[0.07, 0.22, 0.07, 0, 0.1, -0.03, body], [0.07, 0.2, 0.07, 0, 0.28, -0.08, body], [0.1, 0.1, 0.16, 0, 0.42, -0.14, egret ? body : '#f1f1f1'], [0.045, 0.045, 0.34, 0, 0.4, -0.36, beak], [0.03, 0.03, 0.2, 0, 0.46, 0.0, '#111']]);
      for (const [n, s] of [['legL', 1], ['legR', -1]] as const) add(n, [s * 0.05, 0.55, 0.0], [[0.035, 0.55, 0.035, 0, -0.275, 0, leg], [0.07, 0.02, 0.14, 0, -0.55, -0.04, leg]]);
      const wing: Box[] = [[0.5, 0.03, 0.38, 0.25, 0, 0.02, body], [0.18, 0.031, 0.38, 0.5, 0, 0.02, dark]];
      add('wingR', [0.12, 0.72, 0.0], wing); add('wingL', [-0.12, 0.72, 0.0], wing.map(mirror));
      break;
    }
    case 'gull': {
      const wing: Box[] = [[0.46, 0.025, 0.28, 0.23, 0, 0, '#b7c0ca'], [0.14, 0.026, 0.26, 0.5, 0, 0.0, '#222831']];
      add('body', [0, 0.1, 0], [[0.16, 0.14, 0.36, 0, 0, 0, '#f4f6f8'], [0.1, 0.1, 0.12, 0, 0.05, -0.22, '#f4f6f8'], [0.035, 0.035, 0.1, 0, 0.03, -0.31, '#f0b323'], [0.1, 0.05, 0.16, 0, 0.0, 0.25, '#f4f6f8']]);
      add('wingR', [0.07, 0.14, -0.02], wing); add('wingL', [-0.07, 0.14, -0.02], wing.map(mirror));
      break;
    }
    case 'pelican': {
      const body = v & 1 ? '#7a6652' : '#f1ede2', head = '#f6f2e8';
      const wing: Box[] = [[0.9, 0.04, 0.5, 0.45, 0, 0.02, v & 1 ? '#8a7560' : '#e9e5da'], [0.26, 0.045, 0.5, 0.95, 0, 0.02, '#2a2a30']];
      add('body', [0, 0.4, 0], [[0.34, 0.3, 0.7, 0, 0, 0.05, body], [0.1, 0.08, 0.3, 0, 0.0, 0.5, '#555']]);
      add('neck', [0, 0.5, -0.3], [[0.1, 0.32, 0.1, 0, 0.14, -0.03, head], [0.13, 0.13, 0.17, 0, 0.32, -0.1, head], [0.07, 0.06, 0.55, 0, 0.3, -0.45, '#e6a635'], [0.09, 0.06, 0.4, 0, 0.24, -0.4, '#d7872b']]);
      for (const [n, s] of [['legL', 1], ['legR', -1]] as const) add(n, [s * 0.08, 0.28, 0.05], [[0.04, 0.28, 0.04, 0, -0.14, 0, '#555'], [0.1, 0.02, 0.14, 0, -0.28, -0.05, '#555']]);
      add('wingR', [0.17, 0.52, 0.0], wing); add('wingL', [-0.17, 0.52, 0.0], wing.map(mirror));
      break;
    }
    case 'deer': {
      const c = ['#a9744a', '#9a6a44', '#b58352', '#8e6240'][v & 3], cd = shade(c, 0.7);
      add('body', [0, 0, 0], [[0.36, 0.4, 0.85, 0, 0.78, 0, c], [0.3, 0.1, 0.8, 0, 0.58, 0, '#e8dcc4'], [0.16, 0.16, 0.02, 0, 0.82, 0.43, '#f4efe6'], [0.08, 0.12, 0.1, 0, 0.9, 0.5, '#f4efe6']]);
      add('neck', [0, 0.95, -0.35], [[0.14, 0.4, 0.16, 0, 0.18, -0.05, c]]);
      const head: Box[] = [[0.14, 0.16, 0.28, 0, 0.06, -0.14, c], [0.1, 0.1, 0.14, 0, 0.0, -0.32, '#d8c4a0'], [0.05, 0.05, 0.03, 0, 0.02, -0.4, '#222'], [0.12, 0.05, 0.08, 0.1, 0.17, 0.0, c], [0.12, 0.05, 0.08, -0.1, 0.17, 0.0, c]];
      if (v & 1) for (const s of [-1, 1]) head.push([0.03, 0.3, 0.03, s * 0.06, 0.32, -0.04, '#d8cfb4'], [0.03, 0.03, 0.2, s * 0.06, 0.4, -0.12, '#d8cfb4'], [0.03, 0.14, 0.03, s * 0.06, 0.42, -0.2, '#d8cfb4']);
      add('head', [0, 0.38, -0.05], head, 'neck');
      legs4(0.12, 0.6, 0.3, 0.3, 0.07, 0.6, cd, '#2a2420');
      break;
    }
    case 'cow': {
      const pc = v & 1 ? '#3a2a22' : '#1c1c20', w = '#f4f2ec';
      const patches: Box[] = [[0.72, 0.3, 0.4, 0, 0.98, -0.2, pc], [0.72, 0.28, 0.36, 0, 0.8, 0.35, pc], [0.3, 0.2, 0.3, 0.3, 1.2, 0.0, pc]];
      add('body', [0, 0, 0], [[0.7, 0.62, 1.3, 0, 0.9, 0, w], ...(v & 2 ? [] : patches), [0.2, 0.1, 0.24, 0, 0.55, 0.35, '#e9a9a9']]);
      add('head', [0, 1.0, -0.62], [[0.34, 0.34, 0.4, 0, -0.02, -0.18, v & 2 ? pc : w], [0.26, 0.16, 0.12, 0, -0.12, -0.42, '#e9a9a9'], [0.05, 0.05, 0.12, 0.18, 0.2, -0.05, '#e6ddc0'], [0.05, 0.05, 0.12, -0.18, 0.2, -0.05, '#e6ddc0'], [0.12, 0.06, 0.1, 0.22, 0.1, 0.0, pc], [0.12, 0.06, 0.1, -0.22, 0.1, 0.0, pc], [0.05, 0.05, 0.03, 0.12, 0.05, -0.38, '#111'], [0.05, 0.05, 0.03, -0.12, 0.05, -0.38, '#111']]);
      add('tail', [0, 1.1, 0.65], [[0.05, 0.6, 0.05, 0, -0.3, 0.04, w], [0.09, 0.12, 0.09, 0, -0.62, 0.04, pc]]);
      legs4(0.25, 0.62, 0.45, 0.45, 0.14, 0.62, w, '#2a2420');
      break;
    }
    case 'dog': {
      const c = ['#a9743c', '#2b2b30', '#e6d3a8', '#8e8e94'][v & 3], cd = shade(c, 0.7);
      add('body', [0, 0, 0], [[0.22, 0.24, 0.5, 0, 0.36, 0, c], [0.24, 0.06, 0.12, 0, 0.5, -0.2, '#c0392b']]);
      add('head', [0, 0.5, -0.28], [[0.18, 0.18, 0.2, 0, 0.02, -0.08, c], [0.1, 0.08, 0.12, 0, -0.03, -0.22, shade(c, 1.15)], [0.05, 0.04, 0.03, 0, -0.01, -0.29, '#111'], [0.06, 0.12, 0.06, 0.09, 0.12, 0, cd], [0.06, 0.12, 0.06, -0.09, 0.12, 0, cd]]);
      add('tail', [0, 0.46, 0.26], [[0.05, 0.05, 0.22, 0, 0.06, 0.1, c]]);
      legs4(0.08, 0.26, 0.18, 0.18, 0.07, 0.26, cd, '#222');
      break;
    }
    case 'dolphin': {
      const c = ['#7f93a5', '#6f8499', '#8a9bab', '#768a9c'][v & 3];
      add('body', [0, 0.1, 0], [[0.34, 0.34, 0.7, 0, 0, -0.05, c], [0.26, 0.1, 0.6, 0, -0.14, -0.05, '#e8edf1'], [0.04, 0.2, 0.18, 0, 0.24, 0.0, shade(c, 0.8)], [0.2, 0.03, 0.12, 0.26, -0.1, -0.1, shade(c, 0.85)], [0.2, 0.03, 0.12, -0.26, -0.1, -0.1, shade(c, 0.85)]]);
      add('head', [0, 0.1, -0.4], [[0.28, 0.28, 0.3, 0, 0, -0.1, c], [0.1, 0.08, 0.28, 0, -0.04, -0.34, '#a7b5c2'], [0.04, 0.04, 0.03, 0.12, 0.05, -0.2, '#111'], [0.04, 0.04, 0.03, -0.12, 0.05, -0.2, '#111']]);
      add('tail1', [0, 0.1, 0.3], [[0.24, 0.24, 0.5, 0, 0, 0.25, c]]);
      add('tail2', [0, 0, 0.5], [[0.14, 0.14, 0.3, 0, 0, 0.15, c], [0.62, 0.04, 0.18, 0, 0, 0.34, shade(c, 0.8)]], 'tail1');
      break;
    }
  }
  return P;
}
function shade(c: string, f: number): string {
  const n = parseInt(c.slice(1), 16);
  const k = (s: number) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * f)));
  return '#' + ((k(16) << 16) | (k(8) << 8) | k(0)).toString(16).padStart(6, '0');
}

interface Proto { parts: { name: string; parent?: string; at: [number, number, number]; geo: THREE.BufferGeometry }[] }
interface Rig {
  root: THREE.Group; n: Record<string, THREE.Object3D>; kind: string;
  seen: boolean; init: boolean; px: number; py: number; pz: number; spd: number; vy: number;
  phase: number; t: number; wk: number; run: number; fly: number; down: number; cur: number;
}

export class AnimalSystem {
  readonly group = new THREE.Group();
  private bin = new Bin();
  private mat = this.bin.add(new THREE.MeshLambertMaterial({ vertexColors: true }));
  private protos = new Map<string, Proto>();
  private rigs = new Map<string, Rig>();
  constructor() { this.group.name = 'animals'; }

  private proto(kind: string, v: number): Proto {
    const key = kind + v;
    let pr = this.protos.get(key);
    if (pr) return pr;
    pr = { parts: [] };
    for (const p of model(kind, v)) {
      const gs: THREE.BufferGeometry[] = [];
      for (const [w, h, d, cx, cy, cz, col] of p.boxes) {
        const g = new THREE.BoxGeometry(w, h, d).toNonIndexed();
        g.translate(cx, cy, cz);
        const c = new THREE.Color(col);
        const arr = new Float32Array(g.attributes.position.count * 3);
        for (let i = 0; i < arr.length; i += 3) { arr[i] = c.r; arr[i + 1] = c.g; arr[i + 2] = c.b; }
        g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
        g.deleteAttribute('uv');
        gs.push(g);
      }
      const geo = this.bin.add(mergeGeometries(gs, false)!);
      for (const g of gs) g.dispose();
      pr.parts.push({ name: p.name, parent: p.parent, at: p.at, geo });
    }
    this.protos.set(key, pr);
    return pr;
  }

  private make(kind: string, v: number): Rig {
    const pr = this.proto(kind, v);
    const root = new THREE.Group();
    const n: Record<string, THREE.Object3D> = {};
    for (const p of pr.parts) {
      const g = new THREE.Group();
      g.position.set(...p.at);
      const m = new THREE.Mesh(p.geo, this.mat); m.frustumCulled = false;
      g.add(m);
      (p.parent ? n[p.parent] : root).add(g);
      n[p.name] = g;
    }
    this.group.add(root);
    return { root, n, kind, seen: true, init: false, px: 0, py: 0, pz: 0, spd: 0, vy: 0, phase: Math.random() * 6, t: Math.random() * 50, wk: 0, run: 0, fly: 0, down: 0, cur: 0 };
  }

  update(dt: number, e: NpcEnt, cx: number, cz: number, cull2: number) {
    let r = this.rigs.get(e.id);
    const kind = e.r.slice(7);
    if (!r) { r = this.make(kind, e.sk & 3); this.rigs.set(e.id, r); }
    r.seen = true;
    const dx = e.x - cx, dz = e.z - cz;
    r.root.visible = dx * dx + dz * dz < cull2;
    if (!r.root.visible) { r.init = false; return; }
    if (!r.init) { r.px = e.x; r.py = e.y; r.pz = e.z; r.init = true; r.root.position.set(e.x, e.y, e.z); }
    const mx = e.x - r.px, mz = e.z - r.pz;
    const sp = dt > 0 ? Math.hypot(mx, mz) / dt : 0;
    r.spd += (Math.min(sp, 14) - r.spd) * Math.min(1, 10 * dt);
    r.vy += ((dt > 0 ? (e.y - r.py) / dt : 0) - r.vy) * Math.min(1, 8 * dt);
    r.px = e.x; r.py = e.y; r.pz = e.z;
    r.root.position.set(e.x, e.y, e.z);
    r.root.rotation.y = lerpAngle(r.root.rotation.y, e.yaw, 1 - Math.exp(-14 * dt));
    this.animate(r, e.a, dt);
  }

  private animate(r: Rig, a: number, dt: number) {
    const n = r.n, k = 1 - Math.exp(-10 * dt);
    r.t += dt;
    const flying = a === 4 && (r.kind === 'gull' || r.kind === 'heron' || r.kind === 'egret' || r.kind === 'pelican');
    r.fly += ((flying ? 1 : 0) - r.fly) * k;
    r.wk += ((a === 1 || a === 2 ? 1 : 0) - r.wk) * k;
    r.run += ((a === 2 ? 1 : 0) - r.run) * k;
    r.down += ((a === 6 || a === 7 ? 1 : 0) - r.down) * (1 - Math.exp(-6 * dt));
    const rate = r.kind === 'gull' ? 15 : flying ? 9 : 5 + r.run * 8 + clamp(r.spd, 0, 8) * 0.5;
    r.phase += dt * rate * (r.wk > 0.05 || r.fly > 0.05 || r.kind === 'dolphin' ? 1 : 0.2);
    const s = Math.sin(r.phase), c = Math.cos(r.phase);
    const set = (name: string, x?: number, y?: number, z?: number) => { const o = n[name]; if (!o) return; if (x !== undefined) o.rotation.x = x; if (y !== undefined) o.rotation.y = y; if (z !== undefined) o.rotation.z = z; };
    const idle = 1 - Math.max(r.wk, r.fly);
    const amp = 0.45 + r.run * 0.45;
    switch (r.kind) {
      case 'gator': {
        set('legFL', s * 0.5 * r.wk); set('legBR', s * 0.5 * r.wk); set('legFR', -s * 0.5 * r.wk); set('legBL', -s * 0.5 * r.wk);
        set('tail1', 0, s * 0.35 * (0.3 + r.wk)); set('tail2', 0, Math.sin(r.phase - 0.9) * 0.5 * (0.3 + r.wk)); set('tail3', 0, Math.sin(r.phase - 1.8) * 0.6 * (0.3 + r.wk));
        set('jaw', 0.05 + (Math.sin(r.t * 0.5) > 0.9 ? 0.35 : 0)); set('head', 0, Math.sin(r.phase * 0.5) * 0.12 * r.wk);
        break;
      }
      case 'heron': case 'egret': case 'pelican': {
        const walkPhase = r.phase * 0.7;
        set('legL', Math.sin(walkPhase) * 0.5 * r.wk * (1 - r.fly) - 1.2 * r.fly); set('legR', -Math.sin(walkPhase) * 0.5 * r.wk * (1 - r.fly) - 1.2 * r.fly);
        const flap = Math.sin(r.phase) * 0.75;
        set('wingR', 0, 0, (-1.45 * (1 - r.fly)) + flap * r.fly + 0.05); set('wingL', 0, 0, (1.45 * (1 - r.fly)) - flap * r.fly - 0.05);
        const nk = r.kind === 'pelican' ? 0.5 : 0.25;
        set('neck', r.fly * 0.9 + Math.sin(r.t * 1.3) * 0.05 * idle + Math.max(0, Math.sin(r.phase * 0.7)) * nk * r.wk * (1 - r.fly) * 0.4);
        if (n.body) n.body.position.y = (r.kind === 'pelican' ? 0.4 : 0.65) + Math.abs(Math.sin(r.phase)) * 0.03 * r.fly;
        break;
      }
      case 'gull': {
        const flap = Math.sin(r.phase) * 0.6;
        set('wingR', 0, 0, flap + 0.1); set('wingL', 0, 0, -flap - 0.1);
        if (n.body) n.body.rotation.z = Math.sin(r.t * 0.8) * 0.18;
        break;
      }
      case 'deer': case 'cow': case 'dog': {
        const sw = s * amp * r.wk;
        set('legFL', sw); set('legBR', sw); set('legFR', -sw); set('legBL', -sw);
        if (r.kind === 'dog') { set('tail', -0.7 + Math.sin(r.t * (r.wk > 0.2 ? 14 : 8)) * 0.1, Math.sin(r.t * 14) * 0.5); set('head', Math.sin(r.t * 1.2) * 0.05 * idle + 0.1 * r.wk); }
        else {
          // graze: head dips while standing
          const graze = idle * Math.max(0, Math.sin(r.t * 0.35 + r.phase)) ** 0.5;
          if (r.kind === 'deer') { set('neck', -0.55 + graze * 1.15 - r.run * 0.25); set('head', 0.3 * graze); } else set('head', graze * 0.9 + 0.15 * Math.sin(r.t * 0.6) * idle);
          if (r.kind === 'cow') set('tail', Math.sin(r.t * 1.6) * 0.18, 0, Math.sin(r.t * 1.1) * 0.2);
        }
        if (n.body) n.body.position.y = Math.abs(c) * 0.03 * r.wk * (1 + r.run);
        break;
      }
      case 'dolphin': {
        const sw = Math.sin(r.phase * 0.8) * 0.4;
        set('tail1', sw); set('tail2', sw * 1.2); set('head', -sw * 0.25);
        r.root.rotation.x = clamp(r.vy * 0.2, -0.9, 0.9);
        break;
      }
    }
    // knocked out: lie on one side
    r.root.rotation.z = r.down * 1.45;
    r.root.position.y += -0.1 * r.down;
  }

  sweep() {
    for (const [id, r] of this.rigs) if (!r.seen) { r.root.removeFromParent(); this.rigs.delete(id); } else r.seen = false;
  }
  dispose() { this.group.removeFromParent(); this.bin.disposeAll(); this.rigs.clear(); this.protos.clear(); }
}

/** Interactable world objects (packages, loot, keypads, safes, photo spots, targets, locks, evidence) and doors. */
import * as THREE from 'three';
import type { DoorEnt, ObjEnt } from '@blockshore/shared';
import { Bin, BoxBuilder, canvas2d, clamp, makeSprite, pixelTexture, releaseLabel, smoothTexture, textTexture } from './util';

// ───────────────────────────────────────────────────────────── textures
function tex(w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void, pixel = true) {
  const [c, ctx] = canvas2d(w, h); draw(ctx); return pixel ? pixelTexture(c) : smoothTexture(c);
}

export class ObjectAssets {
  private shared = new Bin();
  /** while a rig is being constructed its per-instance resources go to the rig's own bin so removal can dispose them */
  scope: Bin | null = null;
  get bin(): Bin { return this.scope ?? this.shared; }
  /** run fn with per-instance resources tracked in a fresh bin */
  scoped<T>(fn: () => T): { out: T; bin: Bin } {
    const bin = new Bin(); this.scope = bin;
    try { return { out: fn(), bin }; } finally { this.scope = null; }
  }
  lambert = (m: THREE.MeshLambertMaterialParameters) => this.bin.add(new THREE.MeshLambertMaterial(m));
  geo = <T extends THREE.BufferGeometry>(g: T) => this.bin.add(g);
  basic = (m: THREE.MeshBasicMaterialParameters) => this.bin.add(new THREE.MeshBasicMaterial({ toneMapped: false, ...m }));

  starTex = this.bin.add(tex(64, 64, (c) => {
    c.translate(32, 32);
    const g = c.createRadialGradient(0, 0, 0, 0, 0, 30); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.25, 'rgba(255,255,255,.5)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(-32, -32, 64, 64);
    c.fillStyle = '#fff';
    for (let i = 0; i < 2; i++) { c.beginPath(); c.moveTo(0, -30); c.lineTo(3, -3); c.lineTo(30, 0); c.lineTo(3, 3); c.lineTo(0, 30); c.lineTo(-3, 3); c.lineTo(-30, 0); c.lineTo(-3, -3); c.closePath(); c.fill(); c.rotate(Math.PI / 4); c.scale(0.6, 0.6); }
  }, false));
  sparkleMat = this.bin.add(new THREE.SpriteMaterial({ map: this.starTex, color: new THREE.Color(2.4, 2.0, 1.1), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false }));
  sparkleMatBlue = this.bin.add(new THREE.SpriteMaterial({ map: this.starTex, color: new THREE.Color(0.8, 1.8, 2.6), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false }));

  cardboard = this.bin.add(tex(32, 32, (c) => {
    c.fillStyle = '#b98a54'; c.fillRect(0, 0, 32, 32);
    for (let i = 0; i < 60; i++) { c.fillStyle = i % 2 ? 'rgba(90,60,30,.18)' : 'rgba(255,230,180,.12)'; c.fillRect((i * 7) % 32, (i * 13) % 32, 2, 1); }
    c.fillStyle = '#d9bb85'; c.fillRect(13, 0, 6, 32);             // tape
    c.fillStyle = '#f4efe2'; c.fillRect(3, 18, 8, 9); c.fillStyle = '#333'; c.fillRect(4, 20, 6, 1); c.fillRect(4, 22, 5, 1); c.fillRect(4, 24, 6, 1);
    c.fillStyle = '#c0392b'; c.fillRect(22, 4, 7, 2); c.fillRect(22, 8, 5, 2);
    c.fillStyle = 'rgba(0,0,0,.25)'; c.fillRect(0, 0, 32, 1); c.fillRect(0, 31, 32, 1);
  }));
  keypad = this.bin.add(tex(32, 48, (c) => {
    c.fillStyle = '#22262c'; c.fillRect(0, 0, 32, 48);
    c.fillStyle = '#3a4048'; c.fillRect(1, 1, 30, 46);
    c.fillStyle = '#0c1a14'; c.fillRect(4, 4, 24, 9); c.fillStyle = '#2f6f4a'; c.fillRect(6, 6, 14, 2);
    for (let r = 0; r < 4; r++) for (let q = 0; q < 3; q++) { c.fillStyle = '#c9ced6'; c.fillRect(5 + q * 8, 17 + r * 7, 6, 5); c.fillStyle = '#7d848f'; c.fillRect(5 + q * 8, 21 + r * 7, 6, 1); }
  }));
  target = this.bin.add(tex(64, 64, (c) => {
    c.fillStyle = '#e9e4d6'; c.fillRect(0, 0, 64, 64);
    const cols = ['#e9e4d6', '#c0392b', '#e9e4d6', '#c0392b', '#e9e4d6', '#c0392b'];
    for (let i = 0; i < 6; i++) { c.fillStyle = cols[i]; c.beginPath(); c.arc(32, 32, 30 - i * 5, 0, Math.PI * 2); c.fill(); c.strokeStyle = 'rgba(0,0,0,.35)'; c.lineWidth = 1; c.stroke(); }
    c.fillStyle = '#222'; c.fillRect(31, 31, 2, 2);
  }, false));
  folder = this.bin.add(tex(32, 24, (c) => {
    c.fillStyle = '#e2bd72'; c.fillRect(0, 0, 32, 24); c.fillStyle = '#cfa655'; c.fillRect(0, 0, 32, 2); c.fillRect(0, 22, 32, 2);
    c.fillStyle = '#f2e9d0'; c.fillRect(3, 6, 14, 9); c.fillStyle = '#444'; c.fillRect(5, 8, 10, 1); c.fillRect(5, 10, 8, 1); c.fillRect(5, 12, 9, 1);
    c.fillStyle = '#b3262d'; c.fillRect(20, 6, 9, 3); c.fillStyle = '#fff'; c.fillRect(21, 7, 7, 1);
  }));
  woodDoor = this.bin.add(tex(32, 64, (c) => {
    c.fillStyle = '#8b5a2f'; c.fillRect(0, 0, 32, 64);
    for (let i = 0; i < 5; i++) { c.fillStyle = i % 2 ? '#7c4f28' : '#99663a'; c.fillRect(i * 6 + 1, 0, 5, 64); }
    c.fillStyle = '#5c3a1c'; c.fillRect(0, 0, 32, 3); c.fillRect(0, 61, 32, 3); c.fillRect(0, 0, 3, 64); c.fillRect(29, 0, 3, 64);
    c.fillStyle = '#6b4322'; c.fillRect(6, 8, 20, 22); c.fillRect(6, 34, 20, 22);
    c.fillStyle = '#a2703f'; c.fillRect(8, 10, 16, 18); c.fillRect(8, 36, 16, 18);
  }));
  slats = this.bin.add(tex(16, 16, (c) => {
    c.fillStyle = '#b8bec6'; c.fillRect(0, 0, 16, 16);
    for (let i = 0; i < 4; i++) { c.fillStyle = '#d6dbe1'; c.fillRect(0, i * 4, 16, 1); c.fillStyle = '#8a9099'; c.fillRect(0, i * 4 + 3, 16, 1); c.fillStyle = '#a5acb5'; c.fillRect(0, i * 4 + 1, 16, 2); }
  }));
  glass = this.bin.add(tex(32, 64, (c) => {
    c.fillStyle = 'rgba(150,215,235,0.55)'; c.fillRect(0, 0, 32, 64);
    c.fillStyle = 'rgba(255,255,255,0.35)'; for (let i = 0; i < 4; i++) { c.beginPath(); c.moveTo(4 + i * 7, 0); c.lineTo(10 + i * 7, 0); c.lineTo(0 + i * 7 - 8, 64); c.lineTo(-6 + i * 7 - 8, 64); c.closePath(); c.fill(); }
    c.strokeStyle = '#c9d2d9'; c.lineWidth = 3; c.strokeRect(1.5, 1.5, 29, 61);
  }, false));
  ringTex: THREE.CanvasTexture[] = [];
  iconCamera = this.bin.add(tex(128, 128, (c) => {
    c.fillStyle = 'rgba(10,14,22,.78)'; c.beginPath(); c.arc(64, 64, 58, 0, 7); c.fill();
    c.strokeStyle = '#7bd8ff'; c.lineWidth = 5; c.beginPath(); c.arc(64, 64, 54, 0, 7); c.stroke();
    c.fillStyle = '#fff'; c.fillRect(30, 46, 68, 44); c.fillRect(40, 38, 20, 10); c.fillStyle = '#1b2230'; c.beginPath(); c.arc(64, 68, 16, 0, 7); c.fill(); c.fillStyle = '#7bd8ff'; c.beginPath(); c.arc(64, 68, 9, 0, 7); c.fill(); c.fillStyle = '#ff5a4a'; c.fillRect(86, 52, 6, 5);
  }, false));
  iconLock = this.bin.add(tex(128, 128, (c) => {
    c.fillStyle = 'rgba(10,14,22,.78)'; c.beginPath(); c.arc(64, 64, 58, 0, 7); c.fill();
    c.strokeStyle = '#ffd166'; c.lineWidth = 5; c.beginPath(); c.arc(64, 64, 54, 0, 7); c.stroke();
  }, false));
  ringGeo = this.bin.add(new THREE.PlaneGeometry(1, 1));
  constructor() {
    for (let i = 0; i <= 32; i++) {
      this.ringTex.push(this.bin.add(tex(128, 128, (c) => {
        c.translate(64, 64);
        c.fillStyle = 'rgba(8,12,20,.6)'; c.beginPath(); c.arc(0, 0, 58, 0, 7); c.fill();
        c.lineWidth = 12; c.strokeStyle = 'rgba(255,255,255,.18)'; c.beginPath(); c.arc(0, 0, 46, 0, 7); c.stroke();
        c.strokeStyle = i >= 32 ? '#6dff9a' : '#ffd166'; c.lineCap = 'round';
        c.beginPath(); c.arc(0, 0, 46, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * i) / 32); c.stroke();
      }, false)));
    }
    this.ringMats = this.ringTex.map((t) => this.bin.add(new THREE.SpriteMaterial({ map: t, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false })));
  }
  ringMats: THREE.SpriteMaterial[] = [];
  dispose() { this.shared.disposeAll(); }
}

// ───────────────────────────────────────────────────────────── object rigs
const mk = (b: BoxBuilder, bin: Bin) => bin.add(b.build());

export class ObjectRig {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  kind: string;
  phase = Math.random() * 10;
  appear = 0;             // 0..1 pop-in / pop-out scale
  doneT = 0;              // animated state value (0 normal .. 1 done)
  ring: THREE.Sprite;
  ringStep = -1;
  tag: THREE.Sprite | null = null; tagKey = ''; labelKey = '';
  own: Bin | null = null;
  sparkles: THREE.Sprite[] = [];
  part: { door?: THREE.Object3D; led?: THREE.Mesh; shackle?: THREE.Object3D; lid?: THREE.Object3D; board?: THREE.Object3D } = {};

  constructor(readonly sys: ObjectSystem, readonly id: string, kind: string) {
    this.kind = kind;
    const A = sys.assets;
    this.root.add(this.body);
    this.ring = new THREE.Sprite(A.ringMats[0]); this.ring.renderOrder = 20; this.ring.scale.set(0.9, 0.9, 1); this.ring.visible = false; this.root.add(this.ring);
    this.build();
  }

  private build() {
    const A = this.sys.assets, bin = A.bin, B = this.body;
    const sparkle = (n: number, spread: number, y: number, blue = false) => {
      for (let i = 0; i < n; i++) { const s = new THREE.Sprite(blue ? A.sparkleMatBlue : A.sparkleMat); s.userData.o = i; s.userData.sp = spread; s.userData.y = y; B.add(s); this.sparkles.push(s); }
    };
    switch (this.kind) {
      case 'package': {
        const g = A.geo(new THREE.BoxGeometry(0.56, 0.44, 0.44));
        const m = new THREE.Mesh(g, A.lambert({ map: A.cardboard })); m.position.y = 0.22; B.add(m);
        const tape = new THREE.Mesh(A.geo(new THREE.BoxGeometry(0.1, 0.012, 0.45)), A.lambert({ color: 0xe7d29b })); tape.position.set(0, 0.446, 0); B.add(tape);
        sparkle(2, 0.4, 0.3);
        break;
      }
      case 'loot': {
        const base = new THREE.Mesh(A.geo(new THREE.BoxGeometry(0.62, 0.14, 0.44)), A.lambert({ color: 0x3a2a22 })); base.position.y = 0.07; B.add(base);
        const glass = new THREE.Mesh(A.geo(new THREE.BoxGeometry(0.58, 0.3, 0.4)), A.bin.add(new THREE.MeshLambertMaterial({ color: 0x9fdcf2, transparent: true, opacity: 0.3, depthWrite: false })));
        glass.position.y = 0.29; this.part.lid = glass; B.add(glass);
        const gems = new BoxBuilder();
        gems.box(-0.15, 0.2, 0, 0.14, 0.1, 0.14, '#ffd45a'); gems.box(0.05, 0.22, 0.04, 0.12, 0.14, 0.12, '#5ae6ff'); gems.box(0.18, 0.2, -0.03, 0.1, 0.1, 0.1, '#ff5a9a'); gems.box(-0.03, 0.2, -0.08, 0.1, 0.08, 0.1, '#7dff9a');
        const gm = new THREE.Mesh(mk(gems, bin), A.basic({ vertexColors: true, color: new THREE.Color(1.5, 1.5, 1.5) })); B.add(gm);
        sparkle(5, 0.35, 0.3);
        break;
      }
      case 'keypad': {
        const panel = new THREE.Mesh(A.geo(new THREE.BoxGeometry(0.34, 0.5, 0.07)), [A.lambert({ color: 0x20242a }), A.lambert({ color: 0x20242a }), A.lambert({ color: 0x20242a }), A.lambert({ color: 0x20242a }), A.lambert({ color: 0x20242a }), A.lambert({ map: A.keypad })]);
        // BoxGeometry material order: +x,-x,+y,-y,+z,-z ; front faces -z
        panel.position.y = 1.2; B.add(panel);
        const led = new THREE.Mesh(A.geo(new THREE.BoxGeometry(0.07, 0.035, 0.02)), A.basic({ color: new THREE.Color(3, 0.15, 0.1) }));
        led.position.set(0.09, 1.4, -0.045); B.add(led); this.part.led = led;
        sparkle(0, 0, 0);
        break;
      }
      case 'safe': {
        const bodyM = A.lambert({ color: 0x3a4a48 });
        const shell = new THREE.Mesh(A.geo(new THREE.BoxGeometry(1.3, 1.5, 0.75)), bodyM); shell.position.y = 0.75; B.add(shell);
        const inner = new THREE.Mesh(A.geo(new THREE.BoxGeometry(1.02, 1.2, 0.2)), A.lambert({ color: 0x0f1313 })); inner.position.set(0, 0.78, -0.33); B.add(inner);
        const gold = new THREE.Mesh(A.geo(new THREE.BoxGeometry(0.5, 0.3, 0.12)), A.lambert({ color: 0x8a6d2b })); gold.position.set(0, 0.3, -0.25); B.add(gold);
        const hinge = new THREE.Group(); hinge.position.set(-0.6, 0.75, -0.38);
        const door = new THREE.Mesh(A.geo(new THREE.BoxGeometry(1.2, 1.4, 0.14)), A.lambert({ color: 0x4d605d })); door.position.set(0.6, 0, -0.07); hinge.add(door);
        const dial = new THREE.Mesh(A.geo(new THREE.CylinderGeometry(0.2, 0.2, 0.06, 16)), A.lambert({ color: 0xc8ced6 })); dial.rotation.x = Math.PI / 2; dial.position.set(0.6, 0.12, -0.16); hinge.add(dial);
        const handle = new THREE.Mesh(A.geo(new THREE.BoxGeometry(0.34, 0.07, 0.07)), A.lambert({ color: 0xe0c060 })); handle.position.set(0.6, 0.12, -0.2); hinge.add(handle);
        const lamp = new THREE.Mesh(A.geo(new THREE.BoxGeometry(0.1, 0.05, 0.03)), A.basic({ color: new THREE.Color(3, 0.2, 0.15) })); lamp.position.set(0.6, 0.5, -0.16); hinge.add(lamp); this.part.led = lamp;
        const bolts = new BoxBuilder(); for (const sx of [-1, 1]) for (const sy of [-1, 1]) bolts.box(0.6 + sx * 0.5, sy * 0.58, -0.15, 0.08, 0.08, 0.05, '#9aa3ad');
        const bm = new THREE.Mesh(mk(bolts, bin), A.lambert({ vertexColors: true })); hinge.add(bm);
        B.add(hinge); this.part.door = hinge;
        sparkle(0, 0, 0);
        break;
      }
      case 'photo': {
        const spr = makeSprite(A.iconCamera, { depthTest: false }); spr.position.y = 1.5; spr.scale.set(0.8, 0.8, 1); spr.renderOrder = 9; B.add(spr); this.part.board = spr;
        const post = new THREE.Mesh(A.geo(new THREE.CylinderGeometry(0.03, 0.03, 1.1, 6)), A.basic({ color: new THREE.Color(0.6, 1.4, 1.8), transparent: true, opacity: 0.6 })); post.position.y = 0.55; B.add(post);
        sparkle(4, 0.5, 0.4, true);
        break;
      }
      case 'target': {
        const board = new THREE.Group(); board.position.y = 0;                           // pivots at the base so it can fall
        const post = new THREE.Mesh(A.geo(new THREE.BoxGeometry(0.1, 1.1, 0.1)), A.lambert({ color: 0x7a5530 })); post.position.y = 0.55; board.add(post);
        const disc = new THREE.Mesh(A.geo(new THREE.BoxGeometry(0.7, 0.7, 0.07)), [A.lambert({ color: 0xcfc6ae }), A.lambert({ color: 0xcfc6ae }), A.lambert({ color: 0xcfc6ae }), A.lambert({ color: 0xcfc6ae }), A.lambert({ color: 0xcfc6ae }), A.lambert({ map: A.target })]);
        disc.position.set(0, 1.3, 0); board.add(disc);
        const foot = new THREE.Mesh(A.geo(new THREE.BoxGeometry(0.6, 0.08, 0.5)), A.lambert({ color: 0x4a4f57 })); foot.position.y = 0.04; B.add(foot);
        B.add(board); this.part.board = board;
        break;
      }
      case 'lock': {
        const body = new THREE.Mesh(A.geo(new THREE.BoxGeometry(0.36, 0.3, 0.14)), A.lambert({ color: 0xe0b940, emissive: 0x4a3508 })); body.position.y = 1.2; B.add(body);
        const sh = new THREE.Group(); sh.position.set(0, 1.35, 0);
        const sb = new BoxBuilder(); sb.box(-0.1, 0.1, 0, 0.06, 0.2, 0.07, '#d9dde3'); sb.box(0.1, 0.1, 0, 0.06, 0.2, 0.07, '#d9dde3'); sb.box(0, 0.2, 0, 0.26, 0.06, 0.07, '#d9dde3');
        sh.add(new THREE.Mesh(mk(sb, bin), A.lambert({ vertexColors: true }))); B.add(sh); this.part.shackle = sh;
        const kh = new THREE.Mesh(A.geo(new THREE.BoxGeometry(0.05, 0.1, 0.02)), A.lambert({ color: 0x2a2220 })); kh.position.set(0, 1.18, -0.075); B.add(kh);
        sparkle(3, 0.35, 1.25);
        break;
      }
      case 'evidence': {
        const f = new THREE.Mesh(A.geo(new THREE.BoxGeometry(0.46, 0.04, 0.34)), [A.lambert({ color: 0xcfa655 }), A.lambert({ color: 0xcfa655 }), A.lambert({ map: A.folder }), A.lambert({ color: 0xcfa655 }), A.lambert({ color: 0xcfa655 }), A.lambert({ color: 0xcfa655 })]);
        f.position.y = 0.04; B.add(f);
        const tab = new THREE.Mesh(A.geo(new THREE.BoxGeometry(0.14, 0.04, 0.04)), A.lambert({ color: 0xcfa655 })); tab.position.set(-0.12, 0.04, -0.19); B.add(tab);
        const tape = new THREE.Mesh(A.geo(new THREE.BoxGeometry(0.46, 0.005, 0.04)), A.lambert({ color: 0xe9c500 })); tape.position.set(0, 0.063, 0.04); B.add(tape);
        sparkle(2, 0.3, 0.2, true);
        break;
      }
      default: {
        const m = new THREE.Mesh(A.geo(new THREE.BoxGeometry(0.4, 0.4, 0.4)), A.lambert({ color: 0xff00ff })); m.position.y = 0.2; B.add(m);
      }
    }
  }

  dispose() {
    if (this.tag) (this.tag.material as THREE.SpriteMaterial).dispose();
    releaseLabel(this.labelKey); this.labelKey = '';
    this.own?.disposeAll(); this.own = null;
  }

  update(dt: number, t: number, e: ObjEnt, dist: number, camPos: THREE.Vector3) {
    const A = this.sys.assets;
    const done = e.st === 1;
    this.doneT += ((done ? 1 : 0) - this.doneT) * (1 - Math.exp(-6 * dt));
    this.root.position.set(e.x, e.y, e.z);
    this.root.rotation.y = e.yaw ?? 0;
    const k = this.kind;
    const ph = this.phase + t;
    let vis = 1;
    this.body.position.y = 0; this.body.rotation.y = 0; this.body.scale.setScalar(1);
    switch (k) {
      case 'package': this.body.position.y = 0.14 + Math.sin(ph * 2.2) * 0.07; this.body.rotation.y = ph * 0.8; vis = 1 - smooth(this.doneT); break;
      case 'loot': { this.body.position.y = 0.02; if (this.part.lid) this.part.lid.visible = !done; vis = done ? 0.9 : 1; break; }
      case 'keypad': { const led = this.part.led!; (led.material as THREE.MeshBasicMaterial).color.setRGB(done ? 0.15 : 3, done ? 3 : 0.15, done ? 0.35 : 0.1); break; }
      case 'safe': {
        const hinge = this.part.door!; hinge.rotation.y = -this.doneT * 1.75;
        const led = this.part.led!; (led.material as THREE.MeshBasicMaterial).color.setRGB(done ? 0.15 : 3, done ? 3 : 0.2, done ? 0.4 : 0.15);
        break;
      }
      case 'photo': { this.body.position.y = Math.sin(ph * 2) * 0.1; vis = 1 - smooth(this.doneT); break; }
      case 'target': { const b = this.part.board!; b.rotation.x = -Math.min(1.5, this.doneT * 1.55) * 1; break; }
      case 'lock': { this.body.position.y = Math.sin(ph * 2.4) * 0.05; this.part.shackle!.position.y = 1.35 + this.doneT * 0.14; this.part.shackle!.rotation.y = this.doneT * 1.2; vis = 1 - smooth(Math.max(0, this.doneT * 1.4 - 0.4)); break; }
      case 'evidence': { this.body.position.y = 0.1 + Math.sin(ph * 2.0) * 0.06; this.body.rotation.y = Math.sin(ph) * 0.4; vis = 1 - smooth(this.doneT); break; }
    }
    this.appear += ((vis > 0.02 ? 1 : 0) - this.appear) * (1 - Math.exp(-8 * dt));
    this.body.scale.setScalar(Math.max(0.001, vis * this.appear));
    this.body.visible = vis * this.appear > 0.02;
    // sparkles
    for (const s of this.sparkles) {
      const o = s.userData.o as number, sp = s.userData.sp as number;
      const a = ph * (0.9 + o * 0.17) + o * 2.3;
      const tw = 0.5 + 0.5 * Math.sin(ph * 3.1 + o * 1.7);
      s.position.set(Math.cos(a) * sp * 0.7, (s.userData.y as number) + Math.sin(ph * 1.3 + o) * 0.18, Math.sin(a) * sp * 0.7);
      const sc = 0.06 + tw * 0.2;
      s.scale.set(sc, sc, 1);
      s.visible = !done || k === 'loot' && false;
    }
    // hold progress ring
    const prog = e.prog ?? 0;
    const show = prog > 0.01 && !done && dist < 25;
    this.ring.visible = show;
    if (show) {
      const step = clamp(Math.round(prog * 32), 0, 32);
      if (step !== this.ringStep) { this.ringStep = step; this.ring.material = A.ringMats[step]; }
      this.ring.position.set(0, k === 'safe' ? 1.9 : k === 'keypad' ? 1.75 : 1.3, 0);
      const s = clamp(0.6 + dist * 0.035, 0.7, 1.8); this.ring.scale.set(s, s, 1);
    }
    // label
    if (e.label && dist < 14 && !done) {
      const key = e.label + (e.mine ? '*' : '');
      if (!this.tag) { this.tag = new THREE.Sprite(new THREE.SpriteMaterial()); this.tag.renderOrder = 10; this.root.add(this.tag); }
      if (this.tagKey !== key) {
        this.tagKey = key;
        const tt = textTexture(e.label, e.mine ? '#9bffb0' : '#ffffff', { size: 24 });
        releaseLabel(this.labelKey); this.labelKey = tt.key;
        const tm = this.tag.material as THREE.SpriteMaterial;
        tm.map = tt.tex; tm.transparent = true; tm.depthWrite = false; tm.toneMapped = false; tm.fog = false; tm.needsUpdate = true;
        this.tag.userData.ratio = tt.w / tt.h;
      }
      const s = clamp(dist * 0.03, 0.22, 0.6);
      this.tag.scale.set(s * (this.tag.userData.ratio as number), s, 1);
      this.tag.position.set(0, (k === 'safe' ? 2.1 : k === 'keypad' ? 1.65 : 1.0) + (k === 'photo' || k === 'lock' ? 0.8 : 0) + (this.ring.visible ? 0.55 : 0), 0);
      this.tag.visible = true;
    } else if (this.tag) this.tag.visible = false;
    void camPos;
  }
}

function smooth(t: number) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }

// ───────────────────────────────────────────────────────────── doors
export class DoorRig {
  readonly root = new THREE.Group();
  open = 0; kind: 'wood' | 'glass' | 'shutter';
  hinge = new THREE.Group();
  leaves: THREE.Object3D[] = [];
  curtain: THREE.Mesh | null = null; barrel: THREE.Mesh | null = null;
  w: number; h: number; axis: 'x' | 'z';
  own: Bin | null = null;
  dispose() { this.own?.disposeAll(); this.own = null; }
  constructor(readonly sys: ObjectSystem, e: DoorEnt) {
    const A = this.sys.assets;
    this.w = e.w; this.axis = e.axis;
    this.h = e.w >= 6 ? 5 : 2;
    const label = (e.label ?? '') + e.id;
    this.kind = e.w >= 6 ? 'shutter' : /glass|shop|store|entrance|lobby|front|bank|jewel|boutique|cafe|diner|club/i.test(label) ? 'glass' : 'wood';
    const w = e.w, h = this.h;
    this.root.add(this.hinge);
    if (this.kind === 'shutter') {
      const frame = new THREE.Mesh(A.geo(new THREE.BoxGeometry(w + 0.2, 0.3, 0.3)), A.lambert({ color: 0x4a4f57 })); frame.position.set(0, h + 0.1, 0); this.root.add(frame);
      this.barrel = new THREE.Mesh(A.geo(new THREE.CylinderGeometry(0.22, 0.22, w - 0.1, 12)), A.lambert({ color: 0x80878f })); this.barrel.rotation.z = Math.PI / 2; this.barrel.position.set(0, h - 0.2, 0); this.root.add(this.barrel);
      for (const sx of [-1, 1]) { const g = new THREE.Mesh(A.geo(new THREE.BoxGeometry(0.16, h, 0.34)), A.lambert({ color: 0x4a4f57 })); g.position.set(sx * (w / 2 + 0.02), h / 2, 0); this.root.add(g); }
      const slat = A.slats.clone(); slat.repeat.set(Math.max(1, Math.round(w / 1)), h * 2); slat.wrapS = slat.wrapT = THREE.RepeatWrapping; slat.needsUpdate = true; A.bin.add(slat);
      this.curtain = new THREE.Mesh(A.geo(new THREE.BoxGeometry(w - 0.1, h - 0.3, 0.12)), A.lambert({ map: slat }));
      this.curtain.geometry.translate(0, -(h - 0.3) / 2, 0); this.curtain.position.set(0, h - 0.3, 0); this.hinge.add(this.curtain);
      const bar = new THREE.Mesh(A.geo(new THREE.BoxGeometry(w - 0.1, 0.18, 0.18)), A.lambert({ color: 0x3c4148 })); bar.position.set(0, -(h - 0.3) + 0.09, 0); this.curtain.add(bar);
    } else if (this.kind === 'wood') {
      const t = A.woodDoor.clone(); A.bin.add(t); t.needsUpdate = true;
      const frameM = A.lambert({ color: 0x4a2f18 });
      for (const sx of [-1, 1]) { const f = new THREE.Mesh(A.geo(new THREE.BoxGeometry(0.1, h + 0.1, 0.22)), frameM); f.position.set(sx * (w / 2 + 0.05), h / 2, 0); this.root.add(f); }
      const top = new THREE.Mesh(A.geo(new THREE.BoxGeometry(w + 0.2, 0.12, 0.22)), frameM); top.position.set(0, h + 0.05, 0); this.root.add(top);
      this.hinge.position.set(-w / 2, 0, 0);
      const leaf = new THREE.Mesh(A.geo(new THREE.BoxGeometry(w - 0.04, h - 0.05, 0.12)), [A.lambert({ color: 0x5c3a1c }), A.lambert({ color: 0x5c3a1c }), A.lambert({ color: 0x5c3a1c }), A.lambert({ color: 0x5c3a1c }), A.lambert({ map: t }), A.lambert({ map: t })]);
      leaf.position.set(w / 2, h / 2, 0); this.hinge.add(leaf);
      for (const z of [-0.08, 0.08]) { const hd = new THREE.Mesh(A.geo(new THREE.BoxGeometry(0.06, 0.06, 0.06)), A.lambert({ color: 0xe0c060 })); hd.position.set(w - 0.2, h * 0.48, z); this.hinge.add(hd); }
    } else {
      const fm = A.lambert({ color: 0x9aa3ad });
      for (const sx of [-1, 1]) { const f = new THREE.Mesh(A.geo(new THREE.BoxGeometry(0.1, h + 0.1, 0.26)), fm); f.position.set(sx * (w / 2 + 0.05), h / 2, 0); this.root.add(f); }
      const top = new THREE.Mesh(A.geo(new THREE.BoxGeometry(w + 0.2, 0.14, 0.26)), fm); top.position.set(0, h + 0.07, 0); this.root.add(top);
      const gm = A.bin.add(new THREE.MeshLambertMaterial({ map: A.glass, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, emissive: 0x16252d }));
      for (const sx of [-1, 1]) {
        const leaf = new THREE.Mesh(A.geo(new THREE.BoxGeometry(w / 2 - 0.02, h - 0.05, 0.05)), gm); leaf.position.set(sx * w / 4, h / 2, sx * 0.03); leaf.userData.sx = sx; this.root.add(leaf); this.leaves.push(leaf);
        const hd = new THREE.Mesh(A.geo(new THREE.BoxGeometry(0.05, 0.5, 0.05)), A.lambert({ color: 0xc9d2d9 })); hd.position.set(-sx * (w / 4 - 0.18) * -1 * 0, h * 0.5, 0); hd.position.set(-sx * 0.12, h * 0.5, -0.05); leaf.add(hd);
      }
    }
    // placement
    if (e.axis === 'x') { this.root.position.set(e.x + w / 2, e.y, e.z + 0.5); this.root.rotation.y = 0; }
    else { this.root.position.set(e.x + 0.5, e.y, e.z + w / 2); this.root.rotation.y = Math.PI / 2; }
  }
  update(dt: number, e: DoorEnt) {
    this.open += ((e.open ? 1 : 0) - this.open) * (1 - Math.exp(-(this.kind === 'shutter' ? 3.2 : 7) * dt));
    const o = this.open;
    if (this.kind === 'wood') this.hinge.rotation.y = -o * 1.65;
    else if (this.kind === 'glass') for (const l of this.leaves) l.position.x = (l.userData.sx as number) * (this.w / 4 + o * (this.w / 2 - 0.1) * 0.98);
    else if (this.curtain) { const s = Math.max(0.03, 1 - o * 0.97); this.curtain.scale.y = s; this.curtain.visible = s > 0.04; if (this.barrel) this.barrel.scale.setScalar(1 + o * 0.25); }
  }
}

// ───────────────────────────────────────────────────────────── system
export class ObjectSystem {
  readonly group = new THREE.Group();
  readonly assets = new ObjectAssets();
  rigs = new Map<string, ObjectRig>();
  doors = new Map<string, DoorRig>();
  getObj(e: ObjEnt): ObjectRig {
    let r = this.rigs.get(e.id);
    if (r && r.kind !== e.m) { this.removeObj(e.id); r = undefined; }
    if (!r) { const s = this.assets.scoped(() => new ObjectRig(this, e.id, e.m)); r = s.out; r.own = s.bin; this.rigs.set(e.id, r); this.group.add(r.root); }
    return r;
  }
  removeObj(id: string) { const r = this.rigs.get(id); if (!r) return; r.root.removeFromParent(); r.dispose(); this.rigs.delete(id); }
  getDoor(e: DoorEnt): DoorRig {
    let r = this.doors.get(e.id);
    if (r && (r.w !== e.w || r.axis !== e.axis)) { this.removeDoor(e.id); r = undefined; }
    if (!r) { const s = this.assets.scoped(() => new DoorRig(this, e)); r = s.out; r.own = s.bin; this.doors.set(e.id, r); this.group.add(r.root); r.open = e.open ? 1 : 0; }
    return r;
  }
  removeDoor(id: string) { const r = this.doors.get(id); if (!r) return; r.root.removeFromParent(); r.dispose(); this.doors.delete(id); }
  dispose() { for (const r of this.rigs.values()) r.dispose(); for (const r of this.doors.values()) r.dispose(); this.assets.dispose(); this.rigs.clear(); this.doors.clear(); }
}

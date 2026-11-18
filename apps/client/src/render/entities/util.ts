/** Shared helpers for the entity renderer: canvas textures, pixel-art helpers, label sprites, disposal tracking. */
import * as THREE from 'three';

export type Disposable = { dispose(): void };

/** Collects everything we create so dispose() can release it. */
export class Bin {
  private items = new Set<Disposable>();
  add<T extends Disposable>(x: T): T { this.items.add(x); return x; }
  disposeAll() { for (const i of this.items) i.dispose(); this.items.clear(); }
}

export function canvas2d(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: false })!;
  ctx.imageSmoothingEnabled = false;
  return [c, ctx];
}

/** Pixel-art texture: nearest filtering, sRGB. */
export function pixelTexture(c: HTMLCanvasElement, mip = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.NearestFilter;
  t.minFilter = mip ? THREE.NearestMipmapLinearFilter : THREE.NearestFilter;
  t.generateMipmaps = mip;
  t.anisotropy = 4;
  return t;
}

export function smoothTexture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Cheap deterministic hash of a string to an unsigned 32-bit int. */
export function hash(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

export function hex(n: number): string { return '#' + (n & 0xffffff).toString(16).padStart(6, '0'); }

export function shade(c: string, f: number): string {
  const n = parseInt(c.slice(1), 16);
  const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 255) * f)));
  const g = Math.max(0, Math.min(255, Math.round(((n >> 8) & 255) * f)));
  const b = Math.max(0, Math.min(255, Math.round((n & 255) * f)));
  return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

export function mix(a: string, b: string, t: number): string {
  const x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16);
  const f = (s: number) => Math.round(((x >> s) & 255) * (1 - t) + ((y >> s) & 255) * t);
  return '#' + ((f(16) << 16) | (f(8) << 8) | f(0)).toString(16).padStart(6, '0');
}

export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2; else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export function clamp(v: number, a: number, b: number) { return v < a ? a : v > b ? b : v; }
export function damp(cur: number, target: number, rate: number, dt: number) { return target + (cur - target) * Math.exp(-rate * dt); }
export function smooth01(t: number) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }

/** Axis-aligned box geometry appended into arrays (used to bake many boxes into one BufferGeometry). */
export class BoxBuilder {
  pos: number[] = []; nor: number[] = []; col: number[] = []; uv: number[] = []; idx: number[] = [];
  private tmp = new THREE.Color();
  /** box centred at (cx,cy,cz) with size (sx,sy,sz), colour (sRGB hex string) baked as vertex colour; per-face brightness for fake AO */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, color: string, opts?: { top?: number; bottom?: number; side?: number; uv?: [number, number] }) {
    this.tmp.set(color); // sRGB -> linear by ColorManagement
    const r = this.tmp.r, g = this.tmp.g, b = this.tmp.b;
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    const tb = opts?.top ?? 1, bb = opts?.bottom ?? 0.6, sb = opts?.side ?? 1;
    const u = opts?.uv ?? [0, 0];
    const faces: [number[], number[], number][] = [
      [[1, 0, 0], [hx, -hy, hz, hx, -hy, -hz, hx, hy, -hz, hx, hy, hz], sb],
      [[-1, 0, 0], [-hx, -hy, -hz, -hx, -hy, hz, -hx, hy, hz, -hx, hy, -hz], sb * 0.92],
      [[0, 1, 0], [-hx, hy, hz, hx, hy, hz, hx, hy, -hz, -hx, hy, -hz], tb],
      [[0, -1, 0], [-hx, -hy, -hz, hx, -hy, -hz, hx, -hy, hz, -hx, -hy, hz], bb],
      [[0, 0, 1], [-hx, -hy, hz, hx, -hy, hz, hx, hy, hz, -hx, hy, hz], sb * 0.96],
      [[0, 0, -1], [hx, -hy, -hz, -hx, -hy, -hz, -hx, hy, -hz, hx, hy, -hz], sb * 0.96],
    ];
    for (const [n, v, k] of faces) {
      const base = this.pos.length / 3;
      for (let i = 0; i < 4; i++) {
        this.pos.push(cx + v[i * 3], cy + v[i * 3 + 1], cz + v[i * 3 + 2]);
        this.nor.push(n[0], n[1], n[2]);
        this.col.push(r * k, g * k, b * k);
        this.uv.push(u[0], u[1]);
      }
      this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return this;
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

interface LabelEntry { tex: THREE.CanvasTexture; w: number; h: number; key: string; refs: number }
const labelCache = new Map<string, LabelEntry>();
const LABEL_IDLE_MAX = 24;

/** Release one reference taken by textTexture(); unreferenced textures linger briefly (LRU) then are disposed. */
export function releaseLabel(key: string | null | undefined) {
  if (!key) return;
  const e = labelCache.get(key);
  if (!e) return;
  if (--e.refs > 0) return;
  e.refs = 0;
  labelCache.delete(key); labelCache.set(key, e); // move to the idle end
  let idle = 0;
  for (const v of labelCache.values()) if (v.refs === 0) idle++;
  for (const [k, v] of labelCache) {
    if (idle <= LABEL_IDLE_MAX) break;
    if (v.refs === 0) { v.tex.dispose(); labelCache.delete(k); idle--; }
  }
}

/**
 * Name-tag style text texture. Cached by key and reference counted: every call takes a reference
 * that the caller must give back with releaseLabel(key). opts.nocache returns a caller-owned texture instead.
 */
export function textTexture(text: string, color: string, opts?: { bg?: string; size?: number; bold?: boolean; nocache?: boolean }): { tex: THREE.CanvasTexture; w: number; h: number; key: string } {
  const key = text + '|' + color + '|' + (opts?.bg ?? '') + '|' + (opts?.size ?? 0);
  if (!opts?.nocache) {
    const hit = labelCache.get(key);
    if (hit) { hit.refs++; return hit; }
  }
  const size = opts?.size ?? 28;
  const [probe, pctx] = canvas2d(8, 8);
  pctx.font = `700 ${size}px "Inter", "Segoe UI", sans-serif`;
  const tw = Math.ceil(pctx.measureText(text).width);
  void probe;
  const padX = 14, padY = 8;
  const w = tw + padX * 2, h = size + padY * 2;
  const [c, ctx] = canvas2d(w, h);
  if (opts?.bg !== '') {
    ctx.fillStyle = opts?.bg ?? 'rgba(8,12,20,0.62)';
    const r = 10;
    ctx.beginPath(); ctx.moveTo(r, 0); ctx.arcTo(w, 0, w, h, r); ctx.arcTo(w, h, 0, h, r); ctx.arcTo(0, h, 0, 0, r); ctx.arcTo(0, 0, w, 0, r); ctx.closePath(); ctx.fill();
  }
  ctx.font = `700 ${size}px "Inter", "Segoe UI", sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 5; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineJoin = 'round';
  ctx.strokeText(text, w / 2, h / 2 + 1);
  ctx.fillStyle = color; ctx.fillText(text, w / 2, h / 2 + 1);
  const tex = smoothTexture(c);
  tex.generateMipmaps = true;
  const out: LabelEntry = { tex, w, h, key, refs: 1 };
  if (!opts?.nocache) labelCache.set(key, out);
  return out;
}

export function disposeLabelCache() {
  for (const v of labelCache.values()) v.tex.dispose();
  labelCache.clear();
}

export function makeSprite(tex: THREE.Texture, opts?: { depthTest?: boolean; additive?: boolean; color?: number }): THREE.Sprite {
  const m = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: opts?.depthTest ?? true, toneMapped: false, color: opts?.color ?? 0xffffff, fog: false });
  if (opts?.additive) m.blending = THREE.AdditiveBlending;
  return new THREE.Sprite(m);
}

/** Reference-counted resource pool: unreferenced entries linger (LRU, up to idleMax) then are freed. */
export class RefPool<T> {
  private map = new Map<string, { v: T; refs: number }>();
  constructor(private free: (v: T) => void, private idleMax = 16) {}
  get size() { return this.map.size; }
  acquire(key: string, make: () => T): T {
    let e = this.map.get(key);
    if (!e) { e = { v: make(), refs: 0 }; this.map.set(key, e); }
    e.refs++;
    return e.v;
  }
  release(key: string | null | undefined) {
    if (!key) return;
    const e = this.map.get(key);
    if (!e || e.refs <= 0) return;
    if (--e.refs > 0) return;
    this.map.delete(key); this.map.set(key, e); // most recently idled goes last
    let idle = 0;
    for (const x of this.map.values()) if (x.refs === 0) idle++;
    for (const [k, x] of this.map) {
      if (idle <= this.idleMax) break;
      if (x.refs === 0) { this.free(x.v); this.map.delete(k); idle--; }
    }
  }
  clear() { for (const x of this.map.values()) this.free(x.v); this.map.clear(); }
}

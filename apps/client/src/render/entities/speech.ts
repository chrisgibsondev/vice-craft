/**
 * Speech bubbles for NPC "barks" (server message { t: 'bark' }): a billboarded rounded panel above the speaker's head
 * that pops in, holds for a few seconds (longer for longer lines) and fades out. Max MAX_BUBBLES on screen, hidden
 * beyond HIDE_DIST, size grows with distance so text stays legible. Sprites are pooled; bubble textures come from a
 * reference-counted RefPool keyed by (text, accent) so repeated lines share one canvas and everything is disposed.
 */
import * as THREE from 'three';
import { BARK_SPEAKER, barkClip, barkGroupOf, type BarkGroup } from '@blockshore/shared';
import { RefPool, canvas2d, smoothTexture, clamp } from './util';

const MAX_BUBBLES = 4;
const HIDE_DIST = 30;
const FADE_START = 22;

interface Tex { tex: THREE.CanvasTexture; ratio: number }
interface Bubble {
  id: string; key: string; text: string; sprite: THREE.Sprite; mat: THREE.SpriteMaterial; ratio: number;
  age: number; life: number; dist: number;
}

const ACCENT: Partial<Record<BarkGroup, string>> = { cop: '#6aa8ff', guard: '#ff5a72', driver: '#ffd23f', shop: '#ff4fa3', contact: '#b394ff' };
const accentFor = (g: BarkGroup | null) => (g && ACCENT[g]) || '#2ee6d6';

function wrap(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (cur && ctx.measureText(t).width > maxW) { lines.push(cur); cur = w; } else cur = t;
  }
  if (cur) lines.push(cur);
  return lines;
}

function makeTexture(text: string, accent: string): Tex {
  const font = '700 30px "Inter", "Segoe UI", sans-serif';
  const [probe, pctx] = canvas2d(8, 8);
  void probe;
  pctx.font = font;
  const lines = wrap(pctx, text, 360);
  const tw = Math.ceil(Math.max(...lines.map((l) => pctx.measureText(l).width)));
  const padX = 22, padY = 14, lh = 38, tail = 16, border = 3;
  const w = tw + padX * 2 + border * 2, bodyH = lines.length * lh + padY * 2 + border * 2, h = bodyH + tail;
  const [c, ctx] = canvas2d(w, h);
  const r = 16;
  ctx.beginPath();
  ctx.moveTo(r, 0); ctx.arcTo(w, 0, w, bodyH, r); ctx.arcTo(w, bodyH, 0, bodyH, r);
  // tail pointing down at the speaker
  ctx.lineTo(w / 2 + 12, bodyH); ctx.lineTo(w / 2, bodyH + tail - 1); ctx.lineTo(w / 2 - 12, bodyH);
  ctx.arcTo(0, bodyH, 0, 0, r); ctx.arcTo(0, 0, w, 0, r); ctx.closePath();
  ctx.fillStyle = 'rgba(30,16,66,0.9)'; ctx.fill();
  ctx.lineWidth = border; ctx.strokeStyle = accent; ctx.lineJoin = 'round'; ctx.stroke();
  ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.fillStyle = '#ffffff'; ctx.lineJoin = 'round';
  lines.forEach((l, i) => { const y = border + padY + lh * i + lh / 2 + 1; ctx.strokeText(l, w / 2, y); ctx.fillText(l, w / 2, y); });
  const tex = smoothTexture(c);
  tex.generateMipmaps = true;
  return { tex, ratio: w / h };
}

export class SpeechSystem {
  readonly group = new THREE.Group();
  /** called when a line has a recorded clip (BARK_CLIPS in shared/content/barks.ts): play it from that entity */
  clipHook: ((url: string, speakerId: string, line: string) => void) | null = null;
  private pool = new RefPool<Tex>((t) => t.tex.dispose(), 24);
  private active: Bubble[] = [];
  private spare: THREE.Sprite[] = [];
  private tmp = new THREE.Vector3();
  private disposed = false;

  constructor() { this.group.name = 'speech'; this.group.renderOrder = 30; }

  /** show a line over entity `id`; returns the speaker caption (for subtitles) */
  say(id: string, line: string, text: string): string {
    const g = barkGroupOf(line);
    const speaker = g ? BARK_SPEAKER[g] : 'Local';
    if (this.disposed || !text) return speaker;
    const old = this.active.findIndex((b) => b.id === id);
    if (old >= 0) this.retire(old);
    while (this.active.length >= MAX_BUBBLES) this.retire(this.farthestOrOldest());
    const accent = accentFor(g);
    const key = text + '|' + accent;
    const t = this.pool.acquire(key, () => makeTexture(text, accent));
    const sprite = this.spare.pop() ?? this.newSprite();
    const mat = sprite.material as THREE.SpriteMaterial;
    mat.map = t.tex; mat.opacity = 0; mat.needsUpdate = true;
    sprite.visible = false;
    this.group.add(sprite);
    this.active.push({ id, key, text, sprite, mat, ratio: t.ratio, age: 0, life: clamp(1.9 + text.length * 0.05, 2.4, 5.2), dist: 0 });
    const url = barkClip(line);
    if (url && this.clipHook) this.clipHook(url, id, line);
    return speaker;
  }

  private newSprite() {
    const m = new THREE.SpriteMaterial({ transparent: true, depthWrite: false, toneMapped: false, fog: false });
    const s = new THREE.Sprite(m);
    s.center.set(0.5, 0); s.renderOrder = 30; s.frustumCulled = false;
    return s;
  }

  private farthestOrOldest(): number {
    let best = 0, bv = -1;
    for (let i = 0; i < this.active.length; i++) { const v = this.active[i].age * 2 + this.active[i].dist * 0.1; if (v > bv) { bv = v; best = i; } }
    return best;
  }

  private retire(i: number) {
    const b = this.active[i];
    this.active.splice(i, 1);
    this.group.remove(b.sprite);
    b.mat.map = null;
    this.pool.release(b.key);
    if (this.spare.length < 6) this.spare.push(b.sprite); else b.mat.dispose();
  }

  /** anchor(id, out) writes the world position just above the speaker's head and returns false if it is not around */
  update(dt: number, camera: THREE.Camera, anchor: (id: string, out: THREE.Vector3) => boolean, enabled: boolean) {
    if (this.disposed) return;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const b = this.active[i];
      b.age += dt;
      if (b.age >= b.life || !enabled || !anchor(b.id, this.tmp)) { this.retire(i); continue; }
      const dx = this.tmp.x - camera.position.x, dy = this.tmp.y - camera.position.y, dz = this.tmp.z - camera.position.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      b.dist = dist;
      if (dist > HIDE_DIST) { b.sprite.visible = false; continue; }
      // world height grows with distance so the text keeps a readable size on screen
      const h = clamp(0.3 + dist * 0.062, 0.38, 2.1);
      const pop = Math.min(1, b.age / 0.16), out = Math.min(1, (b.life - b.age) / 0.45);
      const k = 0.75 + 0.25 * (1 - (1 - pop) * (1 - pop));
      b.sprite.position.copy(this.tmp);
      b.sprite.scale.set(h * b.ratio * k, h * k, 1);
      b.mat.opacity = Math.min(pop, out) * (dist > FADE_START ? 1 - (dist - FADE_START) / (HIDE_DIST - FADE_START) : 1);
      b.sprite.visible = true;
    }
  }

  get count() { return this.active.length; }

  dispose() {
    this.disposed = true;
    while (this.active.length) this.retire(0);
    for (const s of this.spare) (s.material as THREE.SpriteMaterial).dispose();
    this.spare.length = 0;
    this.pool.clear();
    this.group.removeFromParent();
  }
}

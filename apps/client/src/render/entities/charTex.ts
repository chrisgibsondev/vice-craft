/** Character texture atlas layout, procedural pixel-art painters and box geometry builder. */
import * as THREE from 'three';
import { canvas2d, mix, pixelTexture, shade } from './util';

export const ATLAS = 128;
export const U = 1 / 32; // metres per texel

export interface PartDef { w: number; h: number; d: number; ox: number; oy: number }
export const PARTS = {
  head: { w: 18, h: 18, d: 18, ox: 0, oy: 0 },
  torso: { w: 14, h: 18, d: 10, ox: 0, oy: 36 },
  arm: { w: 6, h: 18, d: 6, ox: 76, oy: 0 },
  leg: { w: 7, h: 21, d: 7, ox: 76, oy: 24 },
  shoe: { w: 8, h: 3, d: 11, ox: 0, oy: 68 },
} satisfies Record<string, PartDef>;
export type PartName = keyof typeof PARTS;
export type Face = 'top' | 'bottom' | 'right' | 'front' | 'left' | 'back';
const SWATCH_Y = 92;
const SIDES: Face[] = ['front', 'back', 'right', 'left'];

export function faceRect(p: PartDef, f: Face): [number, number, number, number] {
  switch (f) {
    case 'top': return [p.ox + p.d, p.oy, p.w, p.d];
    case 'bottom': return [p.ox + p.d + p.w, p.oy, p.w, p.d];
    case 'right': return [p.ox, p.oy + p.d, p.d, p.h];
    case 'front': return [p.ox + p.d, p.oy + p.d, p.w, p.h];
    case 'left': return [p.ox + p.d + p.w, p.oy + p.d, p.d, p.h];
    case 'back': return [p.ox + 2 * p.d + p.w, p.oy + p.d, p.w, p.h];
  }
}

/** [normal, 4 corner sign triples (BL,BR,TR,TL as seen from outside)] */
const FACES: Record<Face, { n: [number, number, number]; v: number[] }> = {
  front: { n: [0, 0, -1], v: [1, -1, -1, -1, -1, -1, -1, 1, -1, 1, 1, -1] },
  back: { n: [0, 0, 1], v: [-1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1] },
  right: { n: [1, 0, 0], v: [1, -1, 1, 1, -1, -1, 1, 1, -1, 1, 1, 1] },
  left: { n: [-1, 0, 0], v: [-1, -1, -1, -1, -1, 1, -1, 1, 1, -1, 1, -1] },
  top: { n: [0, 1, 0], v: [-1, 1, 1, 1, 1, 1, 1, 1, -1, -1, 1, -1] },
  bottom: { n: [0, -1, 0], v: [-1, -1, -1, 1, -1, -1, 1, -1, 1, -1, -1, 1] },
};
const FACE_ORDER: Face[] = ['right', 'left', 'top', 'bottom', 'back', 'front'];

export function swatchUV(i: number): [number, number] { return [(i * 8 + 4) / ATLAS, 1 - (SWATCH_Y + 4) / ATLAS]; }

export class GeoBuilder {
  pos: number[] = []; nor: number[] = []; uv: number[] = []; idx: number[] = [];
  /** textured box using an atlas part layout */
  part(p: PartDef, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number) {
    for (const f of FACE_ORDER) {
      const [x, y, w, h] = faceRect(p, f);
      const e = 0.02;
      const u0 = (x + e) / ATLAS, u1 = (x + w - e) / ATLAS, vt = 1 - (y + e) / ATLAS, vb = 1 - (y + h - e) / ATLAS;
      this.face(f, cx, cy, cz, sx / 2, sy / 2, sz / 2, [u0, vb, u1, vb, u1, vt, u0, vt]);
    }
    return this;
  }
  /** flat-colour box using swatch cell i */
  sw(i: number, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number) {
    const [u, v] = swatchUV(i);
    for (const f of FACE_ORDER) this.face(f, cx, cy, cz, sx / 2, sy / 2, sz / 2, [u, v, u, v, u, v, u, v]);
    return this;
  }
  private face(f: Face, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, uv: number[]) {
    const fd = FACES[f];
    const base = this.pos.length / 3;
    for (let i = 0; i < 4; i++) {
      this.pos.push(cx + fd.v[i * 3] * hx, cy + fd.v[i * 3 + 1] * hy, cz + fd.v[i * 3 + 2] * hz);
      this.nor.push(fd.n[0], fd.n[1], fd.n[2]);
      this.uv.push(uv[i * 2], uv[i * 2 + 1]);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/** Pixel painter bound to one atlas canvas. */
export class Painter {
  readonly c: HTMLCanvasElement; readonly ctx: CanvasRenderingContext2D;
  constructor() { [this.c, this.ctx] = canvas2d(ATLAS, ATLAS); }
  /** fill a rect in part/face local texel coordinates (clipped to the face) */
  r(part: PartName, face: Face, x: number, y: number, w: number, h: number, col: string) {
    const [fx, fy, fw, fh] = faceRect(PARTS[part], face);
    const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(fw, x + w), y1 = Math.min(fh, y + h);
    if (x1 <= x0 || y1 <= y0) return;
    this.ctx.fillStyle = col;
    this.ctx.fillRect(fx + x0, fy + y0, x1 - x0, y1 - y0);
  }
  rs(part: PartName, faces: Face[], x: number, y: number, w: number, h: number, col: string) { for (const f of faces) this.r(part, f, x, y, w, h, col); }
  all(part: PartName, col: string) {
    this.ctx.fillStyle = col;
    for (const f of ['top', 'bottom', 'right', 'front', 'left', 'back'] as Face[]) { const [fx, fy, fw, fh] = faceRect(PARTS[part], f); this.ctx.fillRect(fx, fy, fw, fh); }
  }
  /** speckle noise for fabric/skin variation */
  noise(part: PartName, face: Face, seed: number, amt: number, y0 = 0, y1 = 999) {
    const [fx, fy, fw, fh] = faceRect(PARTS[part], face);
    let s = seed >>> 0;
    for (let y = y0; y < Math.min(fh, y1); y++) for (let x = 0; x < fw; x++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const k = (s >>> 24) / 255;
      if (k > 0.55) { this.ctx.fillStyle = k > 0.8 ? `rgba(255,255,255,${amt * 0.6})` : `rgba(0,0,0,${amt})`; this.ctx.fillRect(fx + x, fy + y, 1, 1); }
    }
  }
  swatches(cols: string[]) { cols.forEach((c, i) => { this.ctx.fillStyle = c; this.ctx.fillRect(i * 8, SWATCH_Y, 8, 8); }); }
  texture() { return pixelTexture(this.c); }
}

export interface LookDef {
  skin: string; hair: string; eye: string;
  hairStyle: 'short' | 'long' | 'pomp' | 'bald' | 'pony' | 'bun' | 'hood' | 'tall';
  hat: 'none' | 'cap' | 'copHat' | 'officerCap' | 'beanie' | 'hard' | 'sun' | 'straw' | 'bucket' | 'ranger' | 'visor' | 'band';
  torsoAcc: string; // comma list: holster,radio,epaulets,tools,chain,backpack,camera,rod,towel,bag
  head: string;     // extra head parts: shades,headset,earpiece,earring
  shirt: string; shirt2: string; pants: string; shoes: string;
  sleeve: number;   // texels of sleeve on the arm (18 = full)
  legPants: number; // texels of pants on leg before skin (shorts) (17 = full)
  face: string;     // comma list: sun,glasses,stache,stubble,liner
  detail: string;   // role id for painted details
  sw: string[];     // swatch colours (0 hair,1 hairDark,2 hat,3 hatAccent,4 gold,5 black,6 white,7 shade,8 a,9 b)
  scaleW: number; scaleH: number;
  /** forward stoop in radians (elders) and 1 when the character rides a skateboard */
  lean: number; board: number;
}

export function paintLook(L: LookDef, seed: number): Painter {
  const P = new Painter();
  P.ctx.clearRect(0, 0, ATLAS, ATLAS);
  const skinD = shade(L.skin, 0.86), skinL = shade(L.skin, 1.06);

  // ---- head
  P.all('head', L.skin);
  P.r('head', 'top', 0, 0, 18, 18, L.hair);
  const longHair = L.hairStyle === 'long' || L.hairStyle === 'pony' || L.hairStyle === 'hood';
  P.rs('head', ['right', 'left'], 0, 0, 18, longHair ? 18 : 5, L.hair);
  P.r('head', 'back', 0, 0, 18, longHair ? 18 : 10, L.hair);
  if (L.hairStyle === 'bald') {
    P.r('head', 'top', 0, 0, 18, 18, L.skin); P.rs('head', ['right', 'left', 'back'], 0, 0, 18, 6, L.skin);
    P.noise('head', 'top', seed, 0.05);
  } else {
    P.noise('head', 'top', seed + 3, 0.12);
    P.noise('head', 'back', seed + 4, 0.12, 0, 18);
    const fringe = 3 + (seed % 2);
    P.r('head', 'front', 0, 0, 18, fringe, L.hair);
    for (let x = 0; x < 18; x++) if (((x * 7 + seed) % 5) < 2) P.r('head', 'front', x, fringe, 1, 1, L.hair);
    P.r('head', 'front', 0, fringe, 2, 4, L.hair); P.r('head', 'front', 16, fringe, 2, 4, L.hair); // sideburns
    if (L.hairStyle === 'long') { P.r('head', 'front', 0, fringe, 3, 14, L.hair); P.r('head', 'front', 15, fringe, 3, 14, L.hair); }
  }
  // eyes
  const eyeY = 8;
  for (const ex of [3, 11]) {
    P.r('head', 'front', ex, eyeY, 4, 2, '#f7f7f4');
    P.r('head', 'front', ex + 1, eyeY, 2, 2, L.eye);
    P.r('head', 'front', ex + 1, eyeY + 1, 2, 1, shade(L.eye, 0.45));
    P.r('head', 'front', ex + 1, eyeY, 1, 1, '#ffffff');
    P.r('head', 'front', ex, eyeY - 1, 4, 1, shade(L.skin, 0.7)); // lid line
    P.r('head', 'front', ex, eyeY + 2, 4, 1, skinD);              // eye bag
    P.r('head', 'front', ex, eyeY - 3, 4, 1, shade(L.hair === L.skin ? '#3a2a20' : L.hair, 0.85)); // brow
  }
  // nose, mouth, cheeks
  P.r('head', 'front', 8, 10, 2, 3, skinD);
  P.r('head', 'front', 8, 12, 2, 1, shade(L.skin, 0.78));
  const lip = mix(L.skin, '#a83a46', 0.55);
  P.r('head', 'front', 7, 14, 4, 1, lip); P.r('head', 'front', 6, 13, 1, 1, lip); P.r('head', 'front', 11, 13, 1, 1, lip);
  P.r('head', 'front', 8, 15, 2, 1, mix(L.skin, '#a83a46', 0.28));
  P.r('head', 'front', 2, 11, 2, 2, mix(L.skin, '#ff7d8a', 0.22)); P.r('head', 'front', 14, 11, 2, 2, mix(L.skin, '#ff7d8a', 0.22));
  // ears (sides)
  P.rs('head', ['right', 'left'], 8, 8, 3, 4, skinD);
  P.rs('head', ['right', 'left'], 9, 9, 1, 2, shade(L.skin, 0.7));
  // face extras
  const fx = L.face.split(',');
  if (fx.includes('sun')) {
    P.r('head', 'front', 1, 7, 16, 4, '#0d0f14'); P.r('head', 'front', 8, 7, 2, 1, '#0d0f14'); P.r('head', 'front', 8, 8, 2, 2, L.skin);
    P.r('head', 'front', 3, 8, 3, 1, '#2d3a55'); P.r('head', 'front', 11, 8, 3, 1, '#2d3a55');
    P.rs('head', ['right', 'left'], 0, 8, 18, 2, '#0d0f14');
  }
  if (fx.includes('glasses')) {
    for (const ex of [2, 11]) { P.r('head', 'front', ex, 7, 5, 1, '#1b1d22'); P.r('head', 'front', ex, 11, 5, 1, '#1b1d22'); P.r('head', 'front', ex, 8, 1, 3, '#1b1d22'); P.r('head', 'front', ex + 4, 8, 1, 3, '#1b1d22'); }
    P.r('head', 'front', 7, 8, 4, 1, '#1b1d22');
  }
  if (fx.includes('stache')) { P.r('head', 'front', 5, 12, 8, 2, shade(L.hair, 0.9)); P.r('head', 'front', 8, 14, 2, 1, lip); }
  if (fx.includes('stubble')) P.noise('head', 'front', seed + 9, 0.35, 11, 17);
  if (fx.includes('liner')) { for (const ex of [3, 11]) P.r('head', 'front', ex, 7, 4, 1, '#16121a'); P.r('head', 'front', 7, 14, 4, 1, '#b3162f'); }

  // ---- torso
  const sh = L.shirt, sh2 = L.shirt2;
  P.all('torso', sh);
  for (const f of SIDES) P.noise('torso', f, seed + f.length, 0.07, 0, 15);
  P.r('torso', 'top', 0, 0, 14, 10, sh); P.r('torso', 'bottom', 0, 0, 14, 10, L.pants);
  P.r('torso', 'top', 4, 3, 6, 4, L.skin);
  P.r('torso', 'front', 4, 0, 6, 2, L.skin); P.r('torso', 'front', 5, 2, 4, 1, L.skin);
  P.r('torso', 'front', 3, 0, 1, 2, sh2); P.r('torso', 'front', 10, 0, 1, 2, sh2); P.r('torso', 'front', 4, 2, 1, 1, sh2); P.r('torso', 'front', 9, 2, 1, 1, sh2);
  P.r('torso', 'back', 3, 0, 8, 1, sh2);
  const belt = L.detail === 'mechanic' || L.detail === 'ped' || L.detail === 'player' ? '#3b2e22' : '#111317';
  for (const f of SIDES) { P.r('torso', f, 0, 15, 14, 2, belt); P.r('torso', f, 0, 17, 14, 1, L.pants); }
  P.r('torso', 'front', 6, 15, 2, 2, '#d8b24a'); P.r('torso', 'front', 6, 15, 2, 1, '#f3d97a');
  for (const x of [1, 3, 10, 12]) P.r('torso', 'front', x, 15, 1, 1, shade(belt, 1.8));

  // ---- arms
  P.all('arm', L.skin);
  const sl = Math.max(0, Math.min(18, L.sleeve));
  for (const f of SIDES) {
    P.r('arm', f, 0, 0, 6, sl, L.detail === 'mechanic' ? '#c3c6cc' : sh);
    if (sl > 0 && sl < 18) P.r('arm', f, 0, sl - 1, 6, 1, shade(sh, 0.78));
    if (sl >= 18) { P.r('arm', f, 0, 15, 6, 3, L.skin); P.r('arm', f, 0, 14, 6, 1, shade(sh, 0.75)); }
    P.noise('arm', f, seed + 11 + f.length, 0.06, 0, sl);
  }
  P.r('arm', 'top', 0, 0, 6, 6, sh); P.r('arm', 'bottom', 0, 0, 6, 6, skinL);

  // ---- legs
  P.all('leg', L.pants);
  for (const f of SIDES) {
    P.noise('leg', f, seed + 21 + f.length, 0.08, 0, 18);
    P.r('leg', f, 0, 0, 7, 1, shade(L.pants, 0.82));
    if (L.legPants < 17) { P.r('leg', f, 0, L.legPants, 7, 17 - L.legPants, L.skin); P.r('leg', f, 0, L.legPants, 7, 1, shade(L.pants, 0.75)); }
    P.r('leg', f, 0, 17, 7, 1, '#f1f1f1');
    P.r('leg', f, 0, 18, 7, 3, L.shoes);
    P.r('leg', f, 0, 20, 7, 1, shade(L.shoes, 0.5));
  }
  P.r('leg', 'right', 6, 1, 1, 16, shade(L.pants, 0.86));
  P.r('leg', 'left', 0, 1, 1, 16, shade(L.pants, 0.86));
  if (L.legPants >= 12) P.r('leg', 'front', 2, 7, 3, 1, shade(L.pants, 0.8));
  P.r('leg', 'bottom', 0, 0, 7, 7, shade(L.shoes, 0.4)); P.r('leg', 'top', 0, 0, 7, 7, L.pants);

  // ---- shoes
  P.all('shoe', L.shoes);
  for (const f of SIDES) P.r('shoe', f, 0, 2, 11, 1, '#f4f4f4');
  for (let i = 0; i < 4; i++) P.r('shoe', 'top', 2, 2 + i * 2, 4, 1, shade(L.shoes, 1.7));
  P.r('shoe', 'bottom', 0, 0, 8, 11, '#1b1c20');

  paintRole(P, L, seed);
  P.swatches(L.sw);
  return P;
}

/** role-specific painted details (badges, aprons, overalls, patterns) */
function paintRole(P: Painter, L: LookDef, seed: number) {
  const T: PartName = 'torso';
  switch (L.detail) {
    case 'guard': {
      P.r(T, 'front', 8, 4, 4, 3, '#c9cdd3'); P.r(T, 'front', 9, 5, 2, 1, '#2a2d33');
      P.r(T, 'front', 1, 6, 4, 6, '#3a3e45'); P.r(T, 'front', 2, 7, 2, 1, '#7d838c');
      P.r(T, 'front', 3, 2, 1, 13, '#2f3338'); P.r(T, 'front', 10, 2, 1, 13, '#2f3338');
      P.r(T, 'back', 2, 4, 10, 1, '#d9dce0'); P.r(T, 'back', 2, 6, 10, 1, '#d9dce0');
      for (let i = 0; i < 5; i++) P.r(T, 'back', 2 + i * 2, 5, 1, 1, '#d9dce0');
      for (const f of SIDES) { P.r('arm', f, 1, 2, 4, 3, '#7d838c'); P.r('arm', f, 2, 3, 2, 1, '#2f3338'); }
      break;
    }
    case 'cop': {
      P.r(T, 'front', 6, 1, 2, 7, '#0d1020'); P.r(T, 'front', 6, 1, 2, 1, '#2a3558');
      P.r(T, 'front', 5, 2, 1, 1, '#b8cdf0'); P.r(T, 'front', 8, 2, 1, 1, '#b8cdf0');
      const gold = '#f1c64a', gd = '#b8902c';
      P.r(T, 'front', 9, 4, 4, 5, gold); P.r(T, 'front', 10, 9, 2, 1, gold); P.r(T, 'front', 9, 4, 4, 1, gd); P.r(T, 'front', 10, 6, 2, 2, '#1e2b4f');
      P.r(T, 'front', 1, 5, 4, 1, '#d9dde6'); P.r(T, 'front', 1, 6, 4, 1, '#8890a3');
      P.r(T, 'front', 1, 11, 5, 3, '#1c2c55'); P.r(T, 'front', 8, 11, 5, 3, '#1c2c55');
      for (const f of SIDES) { P.r('arm', f, 1, 2, 4, 3, '#2a4a8a'); P.r('arm', f, 2, 3, 2, 1, '#f1c64a'); }
      break;
    }
    case 'officer': {
      P.r(T, 'front', 6, 1, 2, 8, '#10131a');
      for (let i = 0; i < 4; i++) P.r(T, 'front', 9 + (i % 2) * 2, 4 + Math.floor(i / 2), 2, 1, ['#d33c3c', '#3c6ad3', '#f1c64a', '#3cba5a'][i]);
      P.r(T, 'front', 2, 4, 4, 1, '#f1c64a'); P.r(T, 'front', 2, 6, 5, 1, '#c8cdd6');
      P.r(T, 'front', 1, 11, 5, 4, '#e2e5ea'); P.r(T, 'front', 8, 11, 5, 4, '#e2e5ea');
      P.r(T, 'front', 3, 2, 1, 13, '#dde0e6'); P.r(T, 'front', 10, 2, 1, 13, '#dde0e6');
      break;
    }
    case 'mechanic': {
      const ov = '#2c5ca8', ovd = '#1f4480';
      P.r(T, 'front', 2, 5, 10, 12, ov); P.r(T, 'front', 3, 0, 2, 5, ov); P.r(T, 'front', 9, 0, 2, 5, ov);
      P.r(T, 'front', 4, 8, 6, 4, ovd); P.r(T, 'front', 5, 9, 4, 2, ov);
      P.r(T, 'front', 3, 4, 2, 1, '#e8c04a'); P.r(T, 'front', 9, 4, 2, 1, '#e8c04a');
      P.r(T, 'front', 6, 6, 2, 1, '#ffffff'); P.r(T, 'front', 6, 12, 2, 3, ovd);
      P.r(T, 'front', 2, 13, 2, 1, '#171717'); P.r(T, 'front', 10, 14, 3, 1, '#2a2a2a'); P.r(T, 'front', 3, 8, 1, 2, '#1a1a1a');
      P.r(T, 'back', 2, 3, 10, 12, ov); P.r(T, 'back', 3, 0, 2, 3, ov); P.r(T, 'back', 9, 0, 2, 3, ov);
      P.rs(T, ['right', 'left'], 0, 3, 10, 12, ovd);
      for (const f of SIDES) { P.r('leg', f, 0, 0, 7, 17, ov); P.r('leg', f, 0, 12, 7, 1, ovd); }
      P.r('leg', 'front', 1, 8, 2, 3, '#161616'); P.r('leg', 'front', 5, 10, 1, 2, '#161616');
      break;
    }
    case 'shopkeeper': {
      const ap = '#2f8f5b', apd = '#1f6b42';
      P.r(T, 'front', 2, 4, 10, 11, ap); P.r(T, 'front', 3, 1, 1, 3, ap); P.r(T, 'front', 10, 1, 1, 3, ap);
      P.r(T, 'front', 4, 9, 6, 4, apd); P.r(T, 'front', 5, 10, 4, 2, ap);
      P.r(T, 'front', 5, 5, 4, 2, '#f4f1e8'); P.r(T, 'front', 6, 5, 2, 1, '#d33c3c');
      P.rs(T, ['right', 'left'], 3, 3, 4, 12, ap);
      P.r(T, 'back', 3, 1, 1, 3, ap); P.r(T, 'back', 10, 1, 1, 3, ap); P.r(T, 'back', 3, 13, 8, 1, ap);
      break;
    }
    case 'waitress': {
      P.r(T, 'front', 3, 10, 8, 5, '#ffffff'); P.r(T, 'front', 3, 10, 8, 1, '#e6c9d9'); P.r(T, 'front', 5, 12, 4, 2, '#f0e0ea');
      P.r(T, 'front', 8, 4, 3, 2, '#ffffff'); P.r(T, 'front', 9, 5, 1, 1, '#d83a7a');
      P.r(T, 'front', 2, 0, 10, 1, '#ffd6ea');
      break;
    }
    case 'marisol': {
      P.r(T, 'front', 5, 0, 4, 8, '#f6efe6'); P.r(T, 'front', 4, 0, 1, 3, '#7e1840'); P.r(T, 'front', 9, 0, 1, 3, '#7e1840');
      P.r(T, 'front', 6, 1, 2, 3, L.skin); P.r(T, 'front', 5, 8, 1, 7, '#7e1840'); P.r(T, 'front', 8, 8, 1, 7, '#7e1840');
      P.r(T, 'front', 7, 9, 1, 1, '#d9b14a'); P.r(T, 'front', 7, 12, 1, 1, '#d9b14a'); P.r(T, 'front', 1, 4, 2, 2, '#e9c35a');
      P.r(T, 'front', 6, 3, 2, 1, '#e9c35a'); P.r(T, 'front', 5, 4, 1, 1, '#e9c35a'); P.r(T, 'front', 8, 4, 1, 1, '#e9c35a');
      break;
    }
    case 'kilo': {
      const lime = '#9be64a';
      P.r(T, 'front', 2, 9, 10, 6, shade(L.shirt, 0.82)); P.r(T, 'front', 3, 10, 8, 1, lime);
      P.r(T, 'front', 5, 1, 1, 6, lime); P.r(T, 'front', 8, 1, 1, 6, lime); P.r(T, 'front', 5, 7, 1, 1, '#ffffff'); P.r(T, 'front', 8, 7, 1, 1, '#ffffff');
      P.r(T, 'front', 4, 0, 6, 2, '#1d232b');
      P.r(T, 'back', 3, 4, 8, 6, lime); P.r(T, 'back', 5, 5, 4, 1, L.shirt); P.r(T, 'back', 4, 7, 6, 1, L.shirt);
      for (const f of SIDES) P.r('arm', f, 0, 8, 6, 1, lime);
      break;
    }
    case 'bouncer': {
      P.r(T, 'front', 4, 0, 6, 2, '#25262c'); P.r(T, 'front', 5, 5, 4, 1, '#f1c64a'); P.r(T, 'front', 5, 7, 4, 1, '#f1c64a');
      P.r(T, 'back', 3, 5, 8, 1, '#f1c64a'); P.r(T, 'back', 3, 7, 8, 1, '#f1c64a');
      for (let i = 0; i < 4; i++) P.r(T, 'back', 4 + i * 2, 6, 1, 1, '#f1c64a');
      break;
    }
    case 'receptionist': {
      P.r(T, 'front', 4, 0, 6, 3, '#2a6f97'); P.r(T, 'front', 5, 3, 4, 3, '#2a6f97'); P.r(T, 'front', 6, 3, 2, 1, '#164a68');
      P.r(T, 'front', 8, 7, 3, 2, '#ffffff'); P.r(T, 'front', 9, 8, 1, 1, '#2a6f97');
      for (const f of SIDES) { P.r('leg', f, 0, 0, 7, 8, '#23344e'); P.r('leg', f, 0, 8, 7, 9, L.skin); P.r('leg', f, 0, 8, 7, 1, '#1a2740'); }
      break;
    }
    case 'jeweler': {
      const vest = '#6b1d2f', vd = '#4a1220';
      P.r(T, 'front', 2, 2, 4, 13, vest); P.r(T, 'front', 8, 2, 4, 13, vest); P.r(T, 'front', 6, 8, 2, 7, '#f4f1ea');
      P.r(T, 'front', 3, 3, 1, 8, vd); P.r(T, 'front', 10, 3, 1, 8, vd);
      for (let i = 0; i < 3; i++) P.r(T, 'front', 6, 9 + i * 2, 2, 1, '#d8b24a');
      P.r(T, 'front', 5, 1, 4, 2, '#111111'); P.r(T, 'front', 6, 1, 2, 1, '#2a2a2a');
      P.r(T, 'front', 2, 12, 4, 1, '#d8b24a');
      P.r(T, 'back', 2, 2, 10, 13, vest); P.r(T, 'back', 6, 2, 2, 12, vd);
      break;
    }
    case 'ped': {
      const v = seed % 5;
      if (v === 2) {
        for (let i = 0; i < 26; i++) {
          const x = (i * 5 + seed) % 14, y = (i * 3 + seed * 2) % 15, c = ['#fff1a8', '#ff9bb8', '#ffffff', '#6fe3a0'][i % 4];
          P.r(T, 'front', x, y, 1, 1, c); P.r(T, 'back', (x * 3) % 14, y, 1, 1, c);
        }
      } else if (v === 1) {
        P.r(T, 'front', 0, 0, 3, 8, L.skin); P.r(T, 'front', 11, 0, 3, 8, L.skin); P.r(T, 'back', 0, 0, 3, 8, L.skin); P.r(T, 'back', 11, 0, 3, 8, L.skin);
        P.rs(T, ['right', 'left'], 0, 0, 10, 6, L.skin);
      } else if (v === 3) {
        P.r(T, 'front', 0, 5, 14, 1, L.shirt2); P.r(T, 'front', 0, 9, 14, 1, L.shirt2); P.r(T, 'front', 6, 2, 2, 4, '#ffffff');
      } else if (v === 4) {
        P.r(T, 'front', 4, 5, 6, 5, L.shirt2); P.r(T, 'front', 5, 6, 4, 3, shade(L.shirt2, 0.6));
      }
      break;
    }
    case 'business': {
      const tie = L.sw[8];
      P.r(T, 'front', 5, 2, 4, 10, '#f3f4f7'); P.r(T, 'front', 4, 1, 1, 2, '#f3f4f7'); P.r(T, 'front', 9, 1, 1, 2, '#f3f4f7');
      P.r(T, 'front', 3, 2, 2, 8, shade(L.shirt, 0.78)); P.r(T, 'front', 9, 2, 2, 8, shade(L.shirt, 0.78));
      P.r(T, 'front', 6, 2, 2, 9, tie); P.r(T, 'front', 6, 2, 2, 1, shade(tie, 0.6)); P.r(T, 'front', 6, 11, 2, 1, shade(tie, 0.8));
      P.r(T, 'front', 10, 6, 2, 1, '#f3f4f7');
      for (const y of [12, 14]) P.r(T, 'front', 6, y, 2, 1, shade(L.shirt, 1.5));
      P.r(T, 'back', 6, 0, 2, 15, shade(L.shirt, 0.82)); P.r(T, 'back', 3, 13, 8, 1, shade(L.shirt, 0.82));
      for (const f of SIDES) P.r('arm', f, 0, 15, 6, 1, '#f3f4f7');
      break;
    }
    case 'tourist': {
      const cols = ['#fff1a8', '#ff6b8b', '#ffffff', '#2fd3a3', '#ffb703'];
      for (let i = 0; i < 34; i++) {
        const x = (i * 5 + seed) % 14, y = (i * 3 + seed * 2) % 14, c = cols[i % cols.length];
        P.r(T, 'front', x, y, 2, 1, c); P.r(T, 'front', x + 1, y + 1, 1, 1, c); P.r(T, 'back', (x * 3 + seed) % 13, y, 2, 1, c);
      }
      P.r(T, 'front', 6, 2, 2, 12, L.shirt2); // open placket
      P.r(T, 'front', 2, 0, 1, 11, '#1b1b1b'); P.r(T, 'front', 11, 0, 1, 11, '#1b1b1b'); P.r(T, 'back', 3, 0, 1, 12, '#1b1b1b'); P.r(T, 'back', 10, 0, 1, 12, '#1b1b1b');
      for (const f of SIDES) { P.r('leg', f, 0, 17, 7, 1, '#f1f1f1'); P.r('leg', f, 1, 6, 5, 1, shade(L.pants, 0.9)); }
      break;
    }
    case 'beach': {
      const v = seed % 3, trunks = L.pants, bk = L.sw[8];
      if (v === 1) { // swimsuit top
        P.r(T, 'front', 2, 3, 4, 3, bk); P.r(T, 'front', 8, 3, 4, 3, bk); P.r(T, 'front', 5, 3, 3, 1, bk); P.r(T, 'front', 2, 0, 1, 3, bk); P.r(T, 'front', 11, 0, 1, 3, bk);
        P.r(T, 'back', 2, 4, 10, 2, bk); P.r(T, 'back', 6, 0, 2, 4, bk);
      } else if (v === 2) { // sleeveless tee
        P.r(T, 'front', 2, 0, 3, 13, L.sw[9]); P.r(T, 'front', 9, 0, 3, 13, L.sw[9]); P.r(T, 'front', 4, 5, 6, 8, L.sw[9]); P.r(T, 'front', 6, 8, 2, 2, '#ffffff');
        P.r(T, 'back', 2, 0, 10, 13, L.sw[9]);
      }
      for (const f of SIDES) { P.r(T, f, 0, 13, 14, 5, trunks); P.r(T, f, 0, 13, 14, 1, shade(trunks, 0.8)); P.r(T, f, 5, 13, 1, 3, '#ffffff'); }
      P.r(T, 'front', 6, 15, 2, 1, shade(trunks, 1.4));
      for (const f of SIDES) { P.r('leg', f, 0, 17, 7, 1, L.skin); P.r('leg', f, 0, 6, 7, 1, shade(trunks, 0.8)); }
      break;
    }
    case 'jogger': {
      P.r(T, 'front', 4, 5, 6, 5, '#f6f6f6'); P.r(T, 'front', 5, 6, 1, 3, '#222222'); P.r(T, 'front', 7, 6, 1, 3, '#222222'); P.r(T, 'front', 8, 7, 1, 1, '#222222');
      P.r(T, 'front', 0, 0, 2, 14, shade(L.shirt, 0.8)); P.r(T, 'front', 12, 0, 2, 14, shade(L.shirt, 0.8));
      P.r(T, 'back', 5, 2, 4, 1, '#f6f6f6'); P.r(T, 'back', 5, 3, 4, 3, shade(L.shirt, 1.25));
      for (const f of SIDES) { P.r(T, f, 0, 14, 14, 4, L.pants); P.r(T, f, 0, 14, 14, 1, L.sw[8]); }
      for (const f of ['right', 'left'] as Face[]) P.r('leg', f, 2, 0, 3, 9, '#f6f6f6');
      for (const f of SIDES) { P.r('leg', f, 0, 17, 7, 1, '#f6f6f6'); P.r('shoe', f, 0, 0, 11, 2, L.sw[8]); }
      break;
    }
    case 'worker': {
      const vest = '#ff7a1a', vd = '#d9570c', refl = '#e8eef2';
      P.r(T, 'front', 1, 0, 4, 14, vest); P.r(T, 'front', 9, 0, 4, 14, vest); P.r(T, 'front', 5, 0, 4, 14, shade(L.shirt, 0.85));
      P.r(T, 'front', 1, 7, 12, 1, refl); P.r(T, 'front', 1, 11, 12, 1, refl); P.r(T, 'front', 3, 0, 1, 7, refl); P.r(T, 'front', 10, 0, 1, 7, refl);
      P.r(T, 'back', 2, 0, 10, 14, vest); P.r(T, 'back', 2, 7, 10, 1, refl); P.r(T, 'back', 2, 11, 10, 1, refl);
      for (let i = 0; i < 6; i++) { P.r(T, 'back', 3 + i, 1 + i, 1, 1, refl); P.r(T, 'back', 10 - i, 1 + i, 1, 1, refl); }
      P.rs(T, ['right', 'left'], 2, 0, 6, 14, vd);
      P.r(T, 'front', 2, 9, 3, 2, vd); P.r(T, 'front', 9, 9, 3, 2, vd);
      for (const f of SIDES) { P.r('leg', f, 0, 17, 7, 1, shade(L.pants, 0.7)); P.r('leg', f, 1, 7, 5, 3, shade(L.pants, 0.85)); P.r('arm', f, 0, 6, 6, 1, refl); }
      break;
    }
    case 'farmer': {
      const den = '#37578a', dd = '#27406a';
      for (let y = 0; y < 15; y += 3) P.r(T, 'front', 0, y, 14, 1, L.shirt2);
      for (let x = 0; x < 14; x += 3) P.r(T, 'front', x, 0, 1, 15, L.shirt2);
      P.r(T, 'front', 3, 6, 8, 9, den); P.r(T, 'front', 3, 0, 2, 6, den); P.r(T, 'front', 9, 0, 2, 6, den);
      P.r(T, 'front', 5, 8, 4, 3, dd); P.r(T, 'front', 6, 9, 2, 1, den); P.r(T, 'front', 3, 5, 1, 1, '#e8c04a'); P.r(T, 'front', 10, 5, 1, 1, '#e8c04a');
      P.r(T, 'back', 3, 0, 2, 8, den); P.r(T, 'back', 9, 0, 2, 8, den); P.r(T, 'back', 3, 8, 8, 7, den);
      for (const f of SIDES) { P.r('leg', f, 0, 0, 7, 17, den); P.r('leg', f, 1, 9, 5, 4, dd); P.r('leg', f, 0, 17, 7, 1, shade(L.shoes, 1.2)); }
      for (const f of SIDES) for (let y = 0; y < 14; y += 3) P.r('arm', f, 0, y, 6, 1, L.shirt2);
      break;
    }
    case 'fisher': {
      const vest = '#b79a62', vd = '#8d7440', wad = '#4a5a3a';
      P.r(T, 'front', 2, 9, 10, 9, wad); P.r(T, 'front', 3, 0, 2, 9, wad); P.r(T, 'front', 9, 0, 2, 9, wad);
      P.r(T, 'front', 1, 1, 4, 8, vest); P.r(T, 'front', 9, 1, 4, 8, vest); P.r(T, 'front', 2, 4, 3, 3, vd); P.r(T, 'front', 9, 4, 3, 3, vd);
      P.r(T, 'back', 2, 1, 10, 10, vest); P.r(T, 'back', 3, 6, 8, 1, vd);
      for (const f of SIDES) { P.r('leg', f, 0, 0, 7, 17, wad); P.r('leg', f, 0, 12, 7, 5, shade(wad, 0.8)); }
      break;
    }
    case 'ranger': {
      P.r(T, 'front', 9, 4, 3, 4, '#f1c64a'); P.r(T, 'front', 10, 5, 1, 2, '#6b4a1a'); P.r(T, 'front', 2, 5, 3, 1, '#2a3a24');
      P.r(T, 'front', 2, 3, 3, 2, shade(L.shirt, 0.8)); P.r(T, 'front', 9, 9, 3, 3, shade(L.shirt, 0.82)); P.r(T, 'front', 2, 9, 3, 3, shade(L.shirt, 0.82));
      P.r(T, 'front', 6, 2, 2, 12, shade(L.shirt, 0.72));
      for (const f of SIDES) { P.r('arm', f, 1, 1, 4, 3, '#2d4a2b'); P.r('arm', f, 2, 2, 2, 1, '#f1c64a'); P.r('leg', f, 1, 8, 5, 3, shade(L.pants, 0.82)); }
      break;
    }
    case 'student': {
      P.r(T, 'front', 3, 10, 8, 5, shade(L.shirt, 0.82)); P.r(T, 'front', 3, 10, 8, 1, shade(L.shirt, 0.7));
      P.r(T, 'front', 4, 0, 6, 2, shade(L.shirt, 0.8)); P.r(T, 'front', 5, 2, 1, 5, '#f2f2f2'); P.r(T, 'front', 8, 2, 1, 5, '#f2f2f2');
      P.r(T, 'front', 4, 4, 6, 3, L.sw[8]); P.r(T, 'front', 5, 5, 4, 1, '#ffffff');
      P.r(T, 'back', 3, 0, 8, 4, shade(L.shirt, 0.85));
      for (const f of SIDES) { P.r('arm', f, 0, 15, 6, 3, shade(L.shirt, 0.82)); P.r('leg', f, 0, 17, 7, 1, '#f6f6f6'); }
      break;
    }
    case 'elder': {
      P.r(T, 'front', 5, 0, 1, 15, shade(L.shirt, 0.65)); P.r(T, 'front', 8, 0, 1, 15, shade(L.shirt, 0.65)); P.r(T, 'front', 6, 2, 2, 12, '#f3efe6');
      for (const y of [4, 7, 10, 13]) P.r(T, 'front', 6, y, 2, 1, '#8a6a3a');
      P.r(T, 'front', 1, 9, 3, 4, shade(L.shirt, 0.85)); P.r(T, 'front', 10, 9, 3, 4, shade(L.shirt, 0.85));
      P.r(T, 'back', 3, 0, 8, 2, shade(L.shirt, 0.8));
      for (const f of SIDES) { P.r('arm', f, 0, 12, 6, 2, shade(L.shirt, 0.85)); P.r('leg', f, 3, 1, 1, 15, shade(L.pants, 0.82)); }
      break;
    }
    case 'skater': {
      P.r(T, 'front', 2, 3, 10, 7, L.sw[8]); P.r(T, 'front', 4, 5, 6, 3, L.shirt); P.r(T, 'front', 5, 6, 4, 1, '#ffffff');
      P.r(T, 'back', 2, 3, 10, 7, L.sw[8]); P.r(T, 'back', 5, 5, 4, 3, L.shirt);
      for (const f of SIDES) { P.r('leg', f, 0, 12, 7, 2, shade(L.pants, 0.82)); P.r('leg', f, 0, 17, 7, 1, '#f6f6f6'); P.r('shoe', f, 0, 0, 11, 2, '#f6f6f6'); }
      break;
    }
    case 'player': {
      const em = shade(L.shirt, 0.55), emL = shade(L.shirt, 1.4);
      P.r(T, 'front', 4, 5, 6, 6, em); P.r(T, 'front', 5, 6, 4, 4, emL); P.r(T, 'front', 6, 7, 2, 2, em);
      P.r(T, 'back', 3, 4, 8, 1, em);
      P.r(T, 'front', 0, 13, 14, 1, shade(L.shirt, 0.8));
      break;
    }
  }
}

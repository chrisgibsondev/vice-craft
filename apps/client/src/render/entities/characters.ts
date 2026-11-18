/** Original blocky humanoids: looks per role/skin, rigs, procedural animation, name tags and alert meters. */
import * as THREE from 'three';
import { Bin, RefPool, canvas2d, clamp, damp, hash, hex, makeSprite, releaseLabel, shade, smoothTexture, textTexture } from './util';
import { GeoBuilder, LookDef, PARTS, U, paintLook } from './charTex';
import { getWeaponModel, weaponGlowMaterial, weaponMaterial } from './weapons';

const SKINS = ['#f7d7bd', '#efc39e', '#e0a97c', '#cc9168', '#b07650', '#8a5a3b', '#6b412a', '#f3cdb0'];
const HAIRS = ['#2a1b12', '#4a2c17', '#7a4a24', '#b9803c', '#e2c25a', '#cfcabd', '#9b2f23', '#15151a'];
const EYES = ['#5b3a1e', '#2f6fa8', '#3f8a4f', '#6b4a2a', '#2a2a34', '#7a5a8a'];
const STYLES: LookDef['hairStyle'][] = ['short', 'pomp', 'long', 'short', 'tall', 'pony', 'short', 'bun'];
const PED_SHIRT = ['#e8505b', '#4aa3df', '#f6c344', '#6fcf97', '#bb6bd9', '#f2994a', '#56ccf2', '#f5f5f5'];
const PED_PANTS = ['#2b3a55', '#3a3f4a', '#7c6a4e', '#4a5a3a', '#5a3a3a', '#1f2430', '#d9d2c0', '#2f4f6f'];
const PED_SHOES = ['#f4f4f4', '#1b1c20', '#8a5a34', '#d33c3c', '#4aa3df'];

type SwArgs = [hair: string, hairD: string, hat: string, hatAcc: string, gold: string, black: string, white: string, shadeC: string, a: string, b: string];
const sw = (...a: SwArgs) => a;

/** Build the full look for an entity. `sk` 0..15 picks skin tone/hair/clothes palettes. */
export function lookFor(kind: 'p' | 'n', role: string, sk: number, outfit: number, id: string, hairColour = 0): LookDef {
  const h = hash(id) >>> 0;
  if (kind === 'p') sk = h & 15;
  sk = ((sk % 16) + 16) % 16;
  const skin = SKINS[sk & 7];
  const hair = HAIRS[((sk >> 1) + sk * 3) & 7];
  const hairStyle = STYLES[(sk * 5 + 3) & 7];
  const eye = EYES[(sk * 7 + 1) % EYES.length];
  const base: LookDef = {
    skin, hair, eye, hairStyle, hat: 'none', torsoAcc: '', head: '', shirt: '#cccccc', shirt2: '#999999', pants: '#2b3a55', shoes: '#1b1c20',
    sleeve: 7, legPants: 17, face: '', detail: 'ped', sw: sw(hair, shade(hair, 0.7), '#444444', '#222222', '#f1c64a', '#14161a', '#f2f2f2', '#14161a', '#888888', '#555555'),
    scaleW: 1, scaleH: 1, lean: 0, board: 0,
  };
  const L = base;
  const gold = '#f1c64a', black = '#14161a';
  switch (role) {
    case 'player': {
      L.detail = 'player';
      L.shirt = hex(outfit); L.shirt2 = shade(L.shirt, 0.72);
      // barber colour (0 = the id-derived default)
      const hc = hairColour ? hex(hairColour) : hair;
      L.hair = hc;
      L.pants = ['#2b3a55', '#2f2f38', '#4a3b2a', '#38453a'][(h >> 4) & 3];
      L.shoes = PED_SHOES[(h >> 8) % 3 === 1 ? 0 : (h >> 8) % 2 ? 1 : 0];
      L.sleeve = 7;
      if ((h >> 12) % 6 === 0) L.face = 'sun';
      L.sw = sw(hc, shade(hc, 0.7), L.shirt2, '#222', gold, black, '#fff', '#14161a', shade(L.shirt, 1.2), '#555');
      break;
    }
    case 'guard': {
      L.detail = 'guard'; L.shirt = '#454a52'; L.shirt2 = '#2f3338'; L.pants = '#2a2d33'; L.shoes = '#17181b'; L.sleeve = 18;
      L.hat = 'cap'; L.torsoAcc = 'holster,radio'; L.hairStyle = 'short';
      L.sw = sw(hair, shade(hair, 0.7), '#2f3338', '#17181b', gold, black, '#d9dce0', black, '#7d838c', '#555');
      break;
    }
    case 'cop': {
      L.detail = 'cop'; L.shirt = '#233a68'; L.shirt2 = '#17274a'; L.pants = '#161f38'; L.shoes = '#0e0f13'; L.sleeve = 18;
      L.hat = 'copHat'; L.torsoAcc = 'holster,radio'; L.hairStyle = 'short';
      L.sw = sw(hair, shade(hair, 0.7), '#1a2b52', '#0e1424', gold, black, '#f2f2f2', black, '#2a4a8a', '#555');
      break;
    }
    case 'officer': {
      L.detail = 'officer'; L.shirt = '#eef0f4'; L.shirt2 = '#c5cbd6'; L.pants = '#1a2748'; L.shoes = '#0e0f13'; L.sleeve = 18;
      L.hat = 'officerCap'; L.torsoAcc = 'epaulets,holster'; L.hairStyle = 'short'; L.face = 'stubble';
      L.sw = sw(hair, shade(hair, 0.7), '#1a2748', '#10131a', gold, black, '#f5f5f7', black, '#2a4a8a', '#555');
      break;
    }
    case 'mechanic': {
      L.detail = 'mechanic'; L.shirt = '#c9ccd1'; L.shirt2 = '#a5a9b0'; L.pants = '#2c5ca8'; L.shoes = '#5a3d28'; L.sleeve = 18;
      L.hat = 'cap'; L.torsoAcc = 'tools'; L.face = 'stubble'; L.hairStyle = 'short';
      L.sw = sw(hair, shade(hair, 0.7), '#d33c2a', '#8a2418', gold, black, '#f2f2f2', black, '#aab0b8', '#555');
      break;
    }
    case 'shopkeeper': {
      L.detail = 'shopkeeper'; L.shirt = '#f4f1e8'; L.shirt2 = '#d6d2c4'; L.pants = '#7c6a4e'; L.shoes = '#6b4a2a'; L.sleeve = 8;
      L.face = 'glasses,stache'; L.hairStyle = 'short';
      L.sw = sw('#9a9a9a', '#777', '#2f8f5b', '#1f6b42', gold, black, '#f2f2f2', black, '#555', '#555');
      L.hair = '#9a9a9a';
      break;
    }
    case 'waitress': {
      L.detail = 'waitress'; L.shirt = '#f06aa6'; L.shirt2 = '#ffd6ea'; L.pants = '#3a3340'; L.shoes = '#f4f4f4'; L.sleeve = 6;
      L.hairStyle = 'pony'; L.face = 'liner';
      L.sw = sw(hair, shade(hair, 0.7), '#f06aa6', '#d83a7a', gold, black, '#fff', black, '#d83a7a', '#555');
      break;
    }
    case 'contact:marisol': {
      L.detail = 'marisol'; L.skin = SKINS[3]; L.hair = '#15151a'; L.shirt = '#b3265a'; L.shirt2 = '#7e1840'; L.pants = '#1d1d29'; L.shoes = '#c9a24a';
      L.sleeve = 18; L.hairStyle = 'long'; L.head = 'shades,earring'; L.face = 'liner'; L.eye = '#3a2418'; L.torsoAcc = 'chain';
      L.sw = sw('#15151a', '#0a0a0e', '#b3265a', '#7e1840', '#e9c35a', black, '#fff', '#11131a', '#7e1840', '#555');
      break;
    }
    case 'contact:kilo': {
      L.detail = 'kilo'; L.skin = SKINS[5]; L.hair = '#15151a'; L.shirt = '#4b5d6b'; L.shirt2 = '#344350'; L.pants = '#262b33'; L.shoes = '#f4f4f4';
      L.sleeve = 18; L.hairStyle = 'hood'; L.face = 'sun,stubble'; L.torsoAcc = 'chain'; L.hat = 'none';
      L.sw = sw('#4b5d6b', '#2a3640', '#4b5d6b', '#9be64a', '#e9c35a', black, '#fff', '#0d0f14', '#9be64a', '#555');
      break;
    }
    case 'bouncer': {
      L.detail = 'bouncer'; L.shirt = '#15161a'; L.shirt2 = '#25262c'; L.pants = '#101114'; L.shoes = '#0b0b0d'; L.sleeve = 8;
      L.hairStyle = 'bald'; L.face = 'sun'; L.head = 'earpiece'; L.scaleW = 1.18; L.scaleH = 1.05;
      L.sw = sw('#222', '#111', '#222', '#111', gold, black, '#fff', black, '#555', '#555');
      break;
    }
    case 'receptionist': {
      L.detail = 'receptionist'; L.shirt = '#f1f4f8'; L.shirt2 = '#2a6f97'; L.pants = '#23344e'; L.shoes = '#14161a'; L.sleeve = 6; L.legPants = 8;
      L.hairStyle = 'bun'; L.head = 'headset'; L.face = 'liner';
      L.sw = sw(hair, shade(hair, 0.7), '#2a6f97', '#164a68', gold, black, '#fff', black, '#555', '#555');
      break;
    }
    case 'jeweler': {
      L.detail = 'jeweler'; L.shirt = '#f4f1ea'; L.shirt2 = '#d6d2c4'; L.pants = '#2b2b30'; L.shoes = '#14161a'; L.sleeve = 18;
      L.hair = '#cfcabd'; L.hairStyle = 'short'; L.face = 'glasses,stache'; L.skin = SKINS[1];
      L.sw = sw('#cfcabd', '#a9a498', '#6b1d2f', '#4a1220', gold, black, '#fff', black, '#555', '#555');
      break;
    }
    default: { // ped and anything unknown: varied civilians
      if (role.startsWith('ped:')) { pedKind(L, role.slice(4), sk, h); break; }
      L.detail = 'ped';
      const s = sk * 3 + (h & 3);
      L.shirt = PED_SHIRT[s & 7]; L.shirt2 = PED_SHIRT[(s + 3) & 7];
      L.pants = PED_PANTS[(s >> 1) & 7]; L.shoes = PED_SHOES[s % 5];
      const v = (sk + (h >> 3)) % 5;
      L.sleeve = v === 1 ? 0 : v === 4 ? 12 : v === 0 ? 18 : 7;
      L.legPants = (s % 3 === 0) ? 10 : 17;
      if (sk % 4 === 0) L.face = 'sun';
      if (sk % 7 === 3) L.torsoAcc = 'backpack';
      if (sk % 5 === 2) L.hat = 'cap';
      L.sw = sw(hair, shade(hair, 0.7), PED_SHIRT[(s + 5) & 7], shade(PED_SHIRT[(s + 5) & 7], 0.7), gold, black, '#fff', black, PED_SHIRT[(s + 1) & 7], '#555');
      // paint code keys the shirt variant off this (kept stable per sk)
      break;
    }
  }
  return L;
}


// ───────────────────────────────────────────────────────────── region-specific people
const SUITS = ['#1f2a44', '#2b2d33', '#4a4e57', '#3a2f2a', '#24403a'];
const TIES = ['#c0392b', '#2d6cdf', '#d4a017', '#7b3fa0', '#1f8a5b'];
const NEON = ['#ff4d6d', '#2ec4b6', '#ffbe0b', '#8338ec', '#06d6a0', '#fb5607', '#3a86ff', '#ff006e'];
const TROPIC = ['#ff7f50', '#20c5c0', '#ffd23f', '#ff5d8f', '#4cc9f0', '#9be15d'];
const JEANS = ['#37578a', '#2c3c5a', '#222a38', '#6f7f99'];

/** Outfits for `ped:<kind>` roles. Everything is derived from `sk` (0..15) so the texture count stays small. */
function pedKind(L: LookDef, kind: string, sk: number, h: number) {
  const pick = <T,>(a: readonly T[], k = 0) => a[(sk + k * 3 + (h & 1)) % a.length];
  const gold = '#f1c64a', black = '#14161a';
  const set = (hat: string, acc: string, a: string, b: string) => { L.sw = sw(L.hair, shade(L.hair, 0.7), hat, acc, gold, black, '#fff', black, a, b); };
  L.detail = kind;
  L.shoes = '#1b1c20'; L.sleeve = 7; L.legPants = 17;
  switch (kind) {
    case 'business': {
      const suit = pick(SUITS), tie = pick(TIES, 1);
      L.shirt = suit; L.shirt2 = shade(suit, 0.7); L.pants = suit; L.shoes = '#14161a'; L.sleeve = 18; L.hairStyle = sk % 4 === 2 ? 'long' : 'short';
      L.face = sk % 3 === 0 ? 'glasses' : sk % 5 === 1 ? 'stubble' : '';
      set('#444', '#222', tie, '#555');
      break;
    }
    case 'tourist': {
      const sh = pick(TROPIC);
      L.shirt = sh; L.shirt2 = shade(sh, 0.75); L.pants = pick(['#d9c9a0', '#8fb8c9', '#e8e1d0', '#c9a48a'], 1); L.legPants = 10; L.shoes = '#b58a5a';
      L.hat = sk % 4 === 1 ? 'visor' : 'sun'; if (sk % 2 === 0) L.face = 'sun';
      L.torsoAcc = sk % 3 === 2 ? 'backpack' : 'camera';
      set(pick(['#f3e3b0', '#ffffff', '#e8a0a8', '#9fd3c7'], 2), sh, pick(NEON, 1), '#555');
      break;
    }
    case 'beach': {
      L.shirt = L.skin; L.shirt2 = shade(L.skin, 0.93); L.pants = pick(NEON); L.legPants = 8; L.sleeve = 0; L.shoes = L.skin;
      L.hat = sk % 3 === 0 ? 'sun' : sk % 5 === 1 ? 'visor' : 'none'; if (sk % 2) L.face = 'sun';
      L.torsoAcc = sk % 3 === 1 ? 'towel' : '';
      set(pick(['#f3e3b0', '#ffffff', '#e8a0a8'], 2), '#ff7f50', pick(NEON, 2), pick(TROPIC, 1));
      break;
    }
    case 'jogger': {
      const sh = pick(NEON);
      L.shirt = sh; L.shirt2 = shade(sh, 0.7); L.pants = sk % 2 ? '#1e2230' : pick(NEON, 2); L.legPants = 9; L.sleeve = sk % 3 ? 0 : 6; L.shoes = pick(NEON, 1);
      L.hat = 'band'; L.hairStyle = sk % 3 === 0 ? 'pony' : 'short'; if (sk % 4 === 0) L.face = 'sun'; if (sk % 2) L.head = 'earpiece';
      set(pick(NEON, 1), pick(NEON, 1), pick(NEON, 3), '#555');
      break;
    }
    case 'worker': {
      L.shirt = pick(['#6d7480', '#8a8f98', '#5d6b78']); L.shirt2 = shade(L.shirt, 0.8); L.pants = pick(['#7c6a4e', '#2f3a4f', '#5a5f3a']); L.shoes = '#5a3d28'; L.sleeve = 18;
      L.hat = 'hard'; if (sk % 3 === 0) L.face = 'stubble'; if (sk % 2) L.torsoAcc = 'tools';
      const hh = pick(['#f5c518', '#ffffff', '#ff7a1a', '#2f80ed']);
      set(hh, shade(hh, 0.7), '#bbb', '#555');
      break;
    }
    case 'farmer': {
      const sh = pick(['#b5392e', '#2f5fa8', '#3b7a4a', '#c9902f']);
      L.shirt = sh; L.shirt2 = shade(sh, 0.68); L.pants = '#37578a'; L.shoes = '#5a3d28'; L.sleeve = 18; L.hat = 'straw'; L.face = sk % 2 ? 'stubble' : sk % 3 === 0 ? 'stache' : '';
      set('#d9bb6a', '#8a3a2a', '#aaa', '#555');
      break;
    }
    case 'fisher': {
      L.shirt = pick(['#e8e6dc', '#7aa3c2', '#c9d6a8']); L.shirt2 = shade(L.shirt, 0.8); L.pants = '#4a5a3a'; L.shoes = '#17181b'; L.sleeve = 8;
      L.hat = 'bucket'; L.face = sk % 2 ? 'sun' : 'glasses'; L.torsoAcc = 'rod';
      const bc = pick(['#d9cfa8', '#9fb08a', '#e8e0c8']);
      set(bc, shade(bc, 0.7), '#b79a62', '#555');
      break;
    }
    case 'ranger': {
      L.shirt = '#9aa268'; L.shirt2 = shade(L.shirt, 0.78); L.pants = '#3d4f33'; L.shoes = '#5a3d28'; L.sleeve = sk % 2 ? 18 : 8; L.hat = 'ranger';
      if (sk % 2 === 0) L.torsoAcc = 'backpack'; L.face = sk % 3 === 0 ? 'stubble' : sk % 3 === 1 ? 'glasses' : '';
      set(pick(['#6e5a34', '#4b6b3a', '#7b6a3e']), '#2a2a22', '#555', '#555');
      break;
    }
    case 'student': {
      const sh = pick(NEON, 1);
      L.shirt = sh; L.shirt2 = shade(sh, 0.75); L.pants = pick(JEANS); L.shoes = '#f6f6f6'; L.sleeve = 18; L.torsoAcc = sk % 3 === 0 ? 'bag' : 'backpack';
      if (sk % 4 === 0) L.hat = 'beanie'; if (sk % 3 === 1) L.head = 'headset';
      set(pick(NEON, 2), '#fff', pick(NEON, 3), pick(NEON, 4));
      break;
    }
    case 'elder': {
      L.hair = pick(['#cfcabd', '#e8e6e2', '#9a9a9a']); L.hairStyle = sk % 3 === 0 ? 'bun' : 'short';
      L.shirt = pick(['#c9b79c', '#9db4c0', '#c3a6a0', '#a9bf9c']); L.shirt2 = shade(L.shirt, 0.8); L.pants = pick(['#8a8576', '#4a4f5c', '#6a6254']);
      L.shoes = sk % 2 ? '#5a3d28' : '#f4f4f4'; L.sleeve = 18; if (sk % 2) L.face = 'glasses'; if (sk % 3 === 1) L.torsoAcc = 'bag';
      L.scaleH = 0.95; L.lean = 0.16;
      set(L.hair, L.hair, '#aaa', '#8a6a3a');
      break;
    }
    case 'skater': {
      const sh = pick(NEON);
      L.shirt = sh; L.shirt2 = shade(sh, 0.7); L.pants = pick(['#2b2f3a', '#6b5a46', '#3a4a6a', '#5a2f3a']); L.shoes = pick(['#e63946', '#f6f6f6', '#ffbe0b', '#2ec4b6']); L.sleeve = 8;
      L.hat = sk % 2 ? 'beanie' : 'cap'; L.hairStyle = sk % 3 === 0 ? 'long' : 'short'; L.board = 1;
      set(pick(NEON, 2), '#fff', pick(NEON, 3), pick(NEON, 5));
      break;
    }
    default: set('#444', '#222', '#888', '#555');
  }
}

// ───────────────────────────────────────────────────────────── geometry
const u = U;
const headBase = (g: GeoBuilder) => g.part(PARTS.head, 0, 9 * u, 0, 18 * u, 18 * u, 18 * u);

function buildHead(style: LookDef['hairStyle'], hat: LookDef['hat'], extra: string): THREE.BufferGeometry {
  const g = new GeoBuilder();
  headBase(g);
  const W = 19.6 * u;
  const slab = (cy: number, h: number) => g.sw(0, 0, cy * u, 0, W, h * u, W);
  const back = (y0: number, y1: number) => g.sw(0, 0, ((y0 + y1) / 2) * u, 8.9 * u, W, (y1 - y0) * u, 2 * u);
  const side = (y0: number, y1: number, z0: number, z1: number) => { for (const s of [-1, 1]) g.sw(0, s * 9.8 * u, ((y0 + y1) / 2) * u, ((z0 + z1) / 2) * u, 1.2 * u, (y1 - y0) * u, (z1 - z0) * u); };
  const hatUp = hat !== 'none';
  switch (style) {
    case 'short': slab(17.8, 3.4); back(8, 19.5); side(12, 19.5, -4, 9.8); break;
    case 'long': slab(17.8, 3.4); back(-3, 19.5); side(2, 19.5, 1, 9.8); side(13, 19.5, -6, 1); break;
    case 'pomp': slab(17.8, 3.4); back(8, 19.5); side(12, 19.5, -4, 9.8); g.sw(0, 0, 21.4 * u, -1.5 * u, 11 * u, 4.5 * u, 14 * u); break;
    case 'tall': g.sw(0, 0, 20.5 * u, 0, 21.4 * u, 9 * u, 21.4 * u); g.sw(0, 0, 11 * u, 8.6 * u, 20.4 * u, 14 * u, 2.4 * u); break;
    case 'pony': slab(17.8, 3.4); back(6, 19.5); side(12, 19.5, -4, 9.8); g.sw(0, 0, 10 * u, 11.2 * u, 5 * u, 13 * u, 4 * u); g.sw(1, 0, 15.5 * u, 11 * u, 5.8 * u, 1.6 * u, 4.8 * u); break;
    case 'bun': slab(17.8, 3.4); back(8, 19.5); side(12, 19.5, -4, 9.8); if (!hatUp) g.sw(0, 0, 22 * u, 4 * u, 8 * u, 6 * u, 8 * u); break;
    case 'hood': {
      g.sw(2, 0, 19.2 * u, 0.3 * u, 22 * u, 4.4 * u, 22 * u);
      g.sw(2, 0, 9 * u, 10.2 * u, 22 * u, 20 * u, 3 * u);
      for (const s of [-1, 1]) g.sw(2, s * 10.4 * u, 9.5 * u, 0.5 * u, 2.6 * u, 20 * u, 22 * u);
      g.sw(3, 0, 19.2 * u, -10.4 * u, 22 * u, 1.4 * u, 1 * u);
      for (const s of [-1, 1]) g.sw(2, s * 4 * u, -1.2 * u, -4 * u, 7 * u, 3 * u, 12 * u); // hood drape on shoulders
      break;
    }
    case 'bald': break;
  }
  switch (hat) {
    case 'cap': g.sw(2, 0, 20 * u, 0, 20.6 * u, 4.4 * u, 20.6 * u); g.sw(3, 0, 18.4 * u, -12.2 * u, 18 * u, 1.2 * u, 7 * u); g.sw(3, 0, 22.5 * u, 0, 2 * u, 1 * u, 2 * u); break;
    case 'copHat':
      g.sw(2, 0, 21.4 * u, 0.4 * u, 21 * u, 5 * u, 21 * u); g.sw(5, 0, 19 * u, 0, 21.6 * u, 1.8 * u, 21.6 * u);
      g.sw(5, 0, 18.4 * u, -12 * u, 19 * u, 1 * u, 8 * u); g.sw(4, 0, 21 * u, -10.8 * u, 4.4 * u, 4 * u, 0.6 * u);
      break;
    case 'officerCap':
      g.sw(6, 0, 22 * u, 0.4 * u, 22.4 * u, 5.6 * u, 22.4 * u); g.sw(2, 0, 19 * u, 0, 21.4 * u, 2 * u, 21.4 * u);
      g.sw(5, 0, 18.5 * u, -12.2 * u, 19 * u, 1 * u, 8 * u); g.sw(4, 0, 18.9 * u, -11.2 * u, 12 * u, 0.7 * u, 1 * u); g.sw(4, 0, 21.2 * u, -11.4 * u, 5 * u, 4 * u, 0.6 * u);
      break;
    case 'beanie': g.sw(2, 0, 20 * u, 0, 21 * u, 6 * u, 21 * u); g.sw(3, 0, 17.4 * u, 0, 21.6 * u, 2.4 * u, 21.6 * u); break;
    case 'hard':
      g.sw(2, 0, 21 * u, 0, 21 * u, 6 * u, 21 * u); g.sw(3, 0, 24.5 * u, 0, 3 * u, 1.5 * u, 22 * u); g.sw(2, 0, 18.6 * u, -11.5 * u, 19 * u, 1.2 * u, 5 * u);
      break;
    case 'sun':
      g.sw(2, 0, 19.2 * u, 0, 35 * u, 1.1 * u, 35 * u); g.sw(2, 0, 21.8 * u, 0, 20.4 * u, 4.4 * u, 20.4 * u); g.sw(3, 0, 19.9 * u, 0, 21 * u, 1.4 * u, 21 * u);
      break;
    case 'straw':
      g.sw(2, 0, 19 * u, 0, 38 * u, 1 * u, 38 * u); g.sw(2, 0, 22 * u, 0, 19.4 * u, 5.4 * u, 19.4 * u); g.sw(3, 0, 19.9 * u, 0, 20.2 * u, 1.6 * u, 20.2 * u);
      break;
    case 'bucket':
      g.sw(2, 0, 21 * u, 0, 20.6 * u, 5.5 * u, 20.6 * u); g.sw(2, 0, 18.8 * u, 0, 27 * u, 1 * u, 27 * u); g.sw(3, 0, 19.6 * u, 0, 21 * u, 1 * u, 21 * u);
      break;
    case 'ranger':
      g.sw(2, 0, 19 * u, 0, 30 * u, 1 * u, 30 * u); g.sw(2, 0, 22.2 * u, 0, 19 * u, 6.4 * u, 19 * u); g.sw(3, 0, 19.9 * u, 0, 19.8 * u, 1.4 * u, 19.8 * u);
      break;
    case 'visor':
      g.sw(2, 0, 18.6 * u, 0, 20.4 * u, 2.4 * u, 20.4 * u); g.sw(3, 0, 18.4 * u, -12.4 * u, 18 * u, 0.9 * u, 9 * u);
      break;
    case 'band':
      g.sw(3, 0, 15.6 * u, 0, 19.6 * u, 1.8 * u, 19.6 * u);
      break;
    case 'none': break;
  }
  if (extra.includes('shades')) { for (const s of [-1, 1]) g.sw(7, s * 4.2 * u, 19.6 * u, -6 * u, 7 * u, 2.4 * u, 3 * u); g.sw(7, 0, 19.8 * u, -6 * u, 2 * u, 0.8 * u, 2.6 * u); }
  if (extra.includes('headset')) { for (const s of [-1, 1]) g.sw(5, s * 9.9 * u, 8 * u, 0, 2 * u, 6 * u, 5.5 * u); g.sw(5, 0, 19.2 * u, 0, 20 * u, 1.2 * u, 2 * u); g.sw(5, -7 * u, 4 * u, -9 * u, 1 * u, 1 * u, 5 * u); }
  if (extra.includes('earpiece')) { g.sw(5, 9.8 * u, 8 * u, 0, 1.6 * u, 3 * u, 2 * u); g.sw(5, 9.8 * u, 4 * u, 1 * u, 0.6 * u, 6 * u, 0.6 * u); }
  if (extra.includes('earring')) g.sw(4, -9.7 * u, 6 * u, 0, 1 * u, 2 * u, 1.4 * u);
  return g.build();
}

function buildTorso(acc: string): THREE.BufferGeometry {
  const g = new GeoBuilder();
  g.part(PARTS.torso, 0, 9 * u, 0, 14 * u, 18 * u, 10 * u);
  if (acc.includes('holster')) { g.sw(5, 5.2 * u, 2.2 * u, -5.6 * u, 3.8 * u, 6.4 * u, 2.4 * u); g.sw(5, 5.2 * u, 5.7 * u, -5.4 * u, 4.2 * u, 1 * u, 2 * u); }
  if (acc.includes('radio')) { g.sw(5, -5.6 * u, 13.6 * u, -5.6 * u, 3.4 * u, 4.6 * u, 2.2 * u); g.sw(5, -6.4 * u, 17.6 * u, -5.6 * u, 0.7 * u, 4 * u, 0.7 * u); }
  if (acc.includes('epaulets')) for (const s of [-1, 1]) { g.sw(4, s * 8 * u, 18.4 * u, 0, 4.6 * u, 1 * u, 6.4 * u); g.sw(5, s * 8 * u, 18.9 * u, 0, 3.2 * u, 0.4 * u, 4.4 * u); }
  if (acc.includes('tools')) { g.sw(8, -8 * u, 4 * u, -1 * u, 1.6 * u, 8 * u, 2 * u); g.sw(9, -8 * u, 0.2 * u, -1 * u, 3 * u, 1.6 * u, 2.4 * u); g.sw(5, 5.6 * u, 3 * u, -5.6 * u, 4 * u, 3.4 * u, 2 * u); }
  if (acc.includes('chain')) { g.sw(4, 0, 13.2 * u, -5.3 * u, 7 * u, 0.9 * u, 0.7 * u); g.sw(4, 0, 11.6 * u, -5.4 * u, 2.4 * u, 2.6 * u, 0.8 * u); }
  if (acc.includes('backpack')) { g.sw(8, 0, 9 * u, 8 * u, 11 * u, 14 * u, 6 * u); g.sw(9, 0, 5.5 * u, 8.2 * u, 9 * u, 4 * u, 6.4 * u); for (const s of [-1, 1]) g.sw(9, s * 4 * u, 12 * u, -5.3 * u, 1.6 * u, 12 * u, 0.7 * u); }
  if (acc.includes('camera')) {
    g.sw(5, 2.5 * u, 8 * u, -6.6 * u, 6 * u, 4 * u, 3 * u); g.sw(7, 2.5 * u, 8 * u, -8.6 * u, 2.6 * u, 2.6 * u, 1.4 * u); g.sw(6, 4.4 * u, 10.4 * u, -6.6 * u, 1.4 * u, 0.8 * u, 1.2 * u);
    g.sw(5, 4.4 * u, 14 * u, -5.2 * u, 0.9 * u, 8 * u, 0.4 * u); g.sw(5, -4.4 * u, 14 * u, -5.2 * u, 0.9 * u, 8 * u, 0.4 * u);
  }
  if (acc.includes('rod')) {
    for (let i = 0; i < 4; i++) g.sw(3, 9.4 * u, (13 + i * 2.4) * u, (-8 - i * 8) * u, 0.9 * u, 0.9 * u, 8.6 * u);
    g.sw(5, 9.4 * u, 12 * u, -5 * u, 2 * u, 2 * u, 2 * u);
  }
  if (acc.includes('towel')) { g.sw(8, 6.5 * u, 18.4 * u, 0, 3.6 * u, 2.6 * u, 11.5 * u); g.sw(9, 6.5 * u, 18.5 * u, 2.5 * u, 3.7 * u, 2.7 * u, 1.4 * u); }
  if (acc.includes('bag')) { g.sw(8, -9.6 * u, 5 * u, 0, 2.6 * u, 7 * u, 8.5 * u); g.sw(9, -4.8 * u, 12 * u, -5.2 * u, 0.9 * u, 12 * u, 0.4 * u); }
  return g.build();
}

function buildArm(): THREE.BufferGeometry { return new GeoBuilder().part(PARTS.arm, 0, -9 * u, 0, 6 * u, 18 * u, 6 * u).build(); }
function buildLeg(): THREE.BufferGeometry {
  return new GeoBuilder().part(PARTS.leg, 0, -10.5 * u, 0, 7 * u, 21 * u, 7 * u).part(PARTS.shoe, 0, -19.5 * u, -1.5 * u, 8 * u, 3 * u, 11 * u).build();
}

// ───────────────────────────────────────────────────────────── alert meter textures
let alertTex: THREE.CanvasTexture[] | null = null;
function alertTextures(): THREE.CanvasTexture[] {
  if (alertTex) return alertTex;
  alertTex = [];
  for (let i = 0; i <= 9; i++) {
    const [c, ctx] = canvas2d(96, 128);
    const f = i / 9;
    ctx.translate(48, 52);
    ctx.fillStyle = 'rgba(10,12,18,0.72)'; ctx.beginPath(); ctx.arc(0, 0, 40, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = 7; ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.beginPath(); ctx.arc(0, 0, 34, 0, Math.PI * 2); ctx.stroke();
    const col = f >= 1 ? '#ff3b30' : f > 0.55 ? '#ff9f0a' : '#ffd60a';
    ctx.strokeStyle = col; ctx.beginPath(); ctx.arc(0, 0, 34, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * f); ctx.stroke();
    ctx.fillStyle = col; ctx.font = '900 54px "Inter", Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(f >= 1 ? '!' : '?', 0, 4);
    // pointer
    ctx.fillStyle = 'rgba(10,12,18,0.72)'; ctx.beginPath(); ctx.moveTo(-9, 38); ctx.lineTo(9, 38); ctx.lineTo(0, 54); ctx.closePath(); ctx.fill();
    alertTex.push(smoothTexture(c));
  }
  return alertTex;
}

// ───────────────────────────────────────────────────────────── system
export interface PoseIn {
  a: number; pitch: number; speed: number;
  weapon: string; aiming: boolean; firing: boolean; stun: boolean;
}

const HIP = 21 * u;
const SH_Y = 17 * u;

export class CharRig {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  readonly head = new THREE.Group();
  readonly armR = new THREE.Group(); readonly armL = new THREE.Group();
  readonly legR = new THREE.Group(); readonly legL = new THREE.Group();
  readonly item = new THREE.Group();
  readonly itemMesh = new THREE.Mesh(); readonly itemGlow = new THREE.Mesh();
  readonly flash: THREE.Mesh;
  tag: THREE.Sprite | null = null; tagKey = ''; labelKey = '';
  alert: THREE.Sprite | null = null; alertLevel = -1;
  lookKey = '';
  held: LookDef | null = null;
  phase = Math.random() * 6.28; t = Math.random() * 100;
  // damped pose weights
  wk = 0; rn = 0; sw = 0; air = 0; sit = 0; down = 0; cow = 0; atk = 0; aim = 0; hold = 0; aimPitch = 0;
  px = 0; pz = 0; spd = 0; hasPos = false;
  yawS = 0;
  scale = 1; seatScale = 1;
  weaponId = '';
  flashT = 0;
  bike = false;
  /** on-foot sit pose (sits on the ground) instead of a seat; stoop; skateboard; gait cadence multiplier */
  ground = false; lean = 0; board = 0; cad = 1; boardMesh: THREE.Group | null = null;
  constructor(readonly sys: Characters) {
    const r = this;
    r.root.add(r.body);
    r.body.position.y = HIP;
    r.body.add(r.head, r.armR, r.armL, r.legR, r.legL);
    r.head.position.y = 18 * u;
    r.armR.position.set(10.2 * u, SH_Y, 0); r.armL.position.set(-10.2 * u, SH_Y, 0);
    r.legR.position.set(3.6 * u, 0, 0); r.legL.position.set(-3.6 * u, 0, 0);
    r.item.position.set(0, -17 * u, -0.5 * u);
    r.item.rotation.x = -Math.PI / 2;
    r.item.add(r.itemMesh, r.itemGlow);
    r.armR.add(r.item);
    r.item.visible = false;
    this.flash = new THREE.Mesh(sys.flashGeo, sys.flashMat);
    this.flash.visible = false;
    r.item.add(this.flash);
  }
  setLook(def: LookDef, key: string) {
    if (this.lookKey === key) return;
    const prev = this.held, prevKey = this.lookKey;
    this.lookKey = key; this.held = def;
    const set = this.sys.assets(def, key);
    if (prev) this.sys.releaseAssets(prev, prevKey);
    const body = this.body;
    // (re)build meshes
    for (const o of [this.torsoM, this.headM, this.armRM, this.armLM, this.legRM, this.legLM]) if (o) o.removeFromParent();
    this.torsoM = new THREE.Mesh(set.torso, set.mat); this.headM = new THREE.Mesh(set.head, set.mat);
    this.armRM = new THREE.Mesh(set.arm, set.mat); this.armLM = new THREE.Mesh(set.arm, set.mat);
    this.legRM = new THREE.Mesh(set.leg, set.mat); this.legLM = new THREE.Mesh(set.leg, set.mat);
    body.add(this.torsoM); this.head.add(this.headM); this.armR.add(this.armRM); this.armL.add(this.armLM); this.legR.add(this.legRM); this.legL.add(this.legLM);
    for (const m of [this.torsoM, this.headM, this.armRM, this.armLM, this.legRM, this.legLM]) { m.frustumCulled = false; }
    this.scale = 1;
    this.root.scale.set(def.scaleW, def.scaleH, def.scaleW);
    this.scale = def.scaleH;
    this.lean = def.lean; this.board = def.board;
    if (this.boardMesh) { this.boardMesh.removeFromParent(); this.boardMesh = null; }
    if (def.board) { this.boardMesh = this.sys.makeBoard(hash(this.lookKey) & 7); this.root.add(this.boardMesh); }
  }
  private torsoM: THREE.Mesh | null = null; private headM: THREE.Mesh | null = null;
  private armRM: THREE.Mesh | null = null; private armLM: THREE.Mesh | null = null;
  private legRM: THREE.Mesh | null = null; private legLM: THREE.Mesh | null = null;

  setWeapon(id: string) {
    if (id === this.weaponId) return;
    this.weaponId = id;
    if (!id) { this.item.visible = false; return; }
    const w = getWeaponModel(id);
    this.itemMesh.geometry = w.geo; this.itemMesh.material = weaponMaterial();
    if (w.glow) { this.itemGlow.geometry = w.glow; this.itemGlow.material = weaponGlowMaterial(); this.itemGlow.visible = true; } else this.itemGlow.visible = false;
    this.flash.position.copy(w.muzzle);
    this.item.scale.setScalar(0.85);
    this.item.visible = true;
  }

  /** Procedural animation. `seated` forces the sit pose; `crouchOffset` lowers the body. */
  animate(dt: number, p: PoseIn, seated: boolean) {
    this.t += dt;
    const a = seated ? 5 : p.stun ? 6 : p.a;
    const k = 1 - Math.exp(-11 * dt);
    this.wk += ((a === 1 ? 1 : 0) - this.wk) * k;
    this.rn += ((a === 2 ? 1 : 0) - this.rn) * k;
    this.sw += ((a === 3 ? 1 : 0) - this.sw) * k;
    this.air += ((a === 4 ? 1 : 0) - this.air) * k;
    this.sit += ((a === 5 ? 1 : 0) - this.sit) * k;
    this.down += ((a === 6 ? 1 : 0) - this.down) * (1 - Math.exp(-7 * dt));
    this.cow += ((a === 7 ? 1 : 0) - this.cow) * k;
    this.atk += ((a === 8 ? 1 : 0) - this.atk) * k;
    // seated characters only bring the weapon up for drive-bys (aiming/firing from the window)
    const armed = this.weaponId !== '' && a !== 6 && (a !== 5 || p.aiming || p.firing) ? 1 : 0;
    this.hold += (armed - this.hold) * k;
    this.aim += (((p.aiming || p.firing) && armed ? 1 : 0) - this.aim) * (1 - Math.exp(-16 * dt));
    this.aimPitch += (clamp(p.pitch, -1.1, 1.1) - this.aimPitch) * (1 - Math.exp(-14 * dt));
    const move = this.wk + this.rn;
    const stride = 9 + this.rn * 5 + clamp(p.speed, 0, 12) * 0.12;
    this.phase += dt * (stride * (0.35 + 0.65 * Math.min(1, move + this.sw * 1.2))) * this.cad;
    const s = Math.sin(this.phase), c = Math.cos(this.phase);
    const breathe = Math.sin(this.t * 2.1);
    const idle = 1 - Math.min(1, move + this.sw + this.air + this.sit + this.down + this.cow);
    const w = this.hold;

    // body
    const bob = Math.abs(s) * (0.025 * this.wk + 0.055 * this.rn);
    let by = HIP + bob + breathe * 0.006 * idle - 0.2 * this.cow - 0.1 * this.sit;
    if (this.ground) by -= 0.42 * this.sit;
    by = by * (1 - this.down) + 0.17 * this.down;
    by = by * (1 - this.sw) + 0.72 * this.sw;
    this.body.position.y = by + (this.board ? 0.09 : 0);
    this.body.rotation.x = -this.lean * (1 - this.sit) - 0.2 * this.rn - 0.06 * this.wk - 0.5 * this.cow - 1.42 * this.sw + 1.52 * this.down - (this.bike ? 0.3 : 0.1) * this.sit;
    this.body.rotation.z = s * 0.04 * this.rn * 0 + (this.sw > 0.1 ? Math.sin(this.phase * 0.5) * 0.12 * this.sw : 0);
    this.body.rotation.y = this.sw > 0.1 ? Math.sin(this.phase * 0.5) * 0.18 * this.sw : s * 0.1 * this.rn + s * 0.05 * this.wk;

    // head: look up/down with pitch
    const pit = clamp(p.pitch, -1.2, 1.2);
    this.head.rotation.x = pit * 0.7 * (1 - this.down) + 0.35 * this.sw + 0.15 * this.cow - 0.2 * this.down;
    this.head.rotation.y = breathe * 0.04 * idle - s * 0.08 * this.rn;

    // legs
    const legSwing = s * (0.75 * this.wk + 1.05 * this.rn) + Math.sin(this.phase * 1.6) * 0.45 * this.sw;
    this.legR.rotation.x = legSwing + 0.35 * this.air + (this.bike ? 0.9 : 1.5) * this.sit + 1.1 * this.cow + 0.15 * this.down;
    this.legL.rotation.x = -legSwing - 0.25 * this.air + (this.bike ? 0.9 : 1.5) * this.sit + 1.1 * this.cow + 0.05 * this.down - 0.2 * this.sit;
    this.legR.rotation.z = 0.12 * this.air - 0.05 * this.cow + 0.08 * this.down;
    this.legL.rotation.z = -0.12 * this.air + 0.05 * this.cow - 0.08 * this.down;

    // arms
    const arm = -s * (0.6 * this.wk + 0.95 * this.rn);
    const crawl = Math.sin(this.phase * 0.8);
    const idleSway = breathe * 0.03 * idle;
    let rx = arm + idleSway + 2.9 * this.sw + 0.8 * crawl * this.sw + 0.6 * this.air + (this.bike ? 1.15 : 1.3) * this.sit + 2.35 * this.cow + 0.35 * this.down;
    let lx = -arm - idleSway + 2.9 * this.sw - 0.8 * crawl * this.sw + 0.6 * this.air + (this.bike ? 1.15 : 1.3) * this.sit + 2.35 * this.cow + 0.35 * this.down;
    // armed carry: low-ready, raised when aiming/firing
    const carry = 0.75 + 0.7 * this.aim;
    rx = rx * (1 - w) + (carry + arm * 0.15) * w;
    lx = lx * (1 - w * 0.9) + ((this.aim > 0.5 ? 1.45 : 0.1) + -arm * 0.5) * (w * 0.9);
    rx = rx * (1 - this.atk) + 1.55 * this.atk;
    // aiming: both arms point along the view pitch (gun on the camera's aim line); seated = right arm only, out of the window
    const aimW = this.aim * w;
    if (aimW > 0.001) {
      const ax = Math.PI / 2 + this.aimPitch * 0.92;
      rx = rx * (1 - aimW) + ax * aimW;
      if (this.sit < 0.5) lx = lx * (1 - aimW) + (ax - 0.06) * aimW;
    }
    this.armR.rotation.x = rx;
    this.armL.rotation.x = lx;
    this.armR.rotation.z = 0.9 * this.air + 0.05 - 0.4 * this.cow + 0.35 * this.down + 0.05 * breathe * idle - 0.1 * this.sit;
    this.armL.rotation.z = -0.9 * this.air - 0.05 + 0.4 * this.cow - 0.35 * this.down - 0.05 * breathe * idle + 0.1 * this.sit - 0.2 * this.aim * w;
    if (this.aim > 0.3 && w > 0.5 && this.sit < 0.5) this.armL.rotation.z -= 0.35 * this.aim;
    // pull the right arm in toward the body centre so the gun sits on the sight line
    if (aimW > 0.001) this.armR.rotation.z = this.armR.rotation.z * (1 - aimW) + (this.sit > 0.5 ? 0 : -0.16) * aimW;
    // upper body leans into the aim a touch
    if (aimW > 0.001 && this.sit < 0.5) this.body.rotation.y = this.body.rotation.y * (1 - aimW) + 0.12 * aimW;
    if (this.cow > 0.3) { this.armR.rotation.y = -0.5 * this.cow; this.armL.rotation.y = 0.5 * this.cow; } else { this.armR.rotation.y = 0; this.armL.rotation.y = 0; }

    // skateboarders hold a fixed stance while rolling
    if (this.board) {
      const m = Math.min(1, move);
      this.body.position.y = by + 0.09 - 0.05 * m;
      this.legR.rotation.x = 0.42 * m + 0.05; this.legL.rotation.x = -0.36 * m; this.legR.rotation.z = 0.04; this.legL.rotation.z = -0.04;
      this.armR.rotation.z = 0.5 * m + 0.05; this.armL.rotation.z = -0.5 * m - 0.05;
      this.armR.rotation.x = 0.25 * m * Math.sin(this.t * 2.4); this.armL.rotation.x = -0.25 * m * Math.sin(this.t * 2.4);
      this.body.rotation.x = -0.1 * m; this.body.rotation.y = 0.12 * m;
    }

    // taser / weapon flash
    if (p.firing && this.weaponId) this.flashT = 0.06;
    if (this.flashT > 0) { this.flashT -= dt; this.flash.visible = true; this.flash.rotation.z += 1.3; } else this.flash.visible = false;
    if (this.atk > 0.5 && !this.item.visible) { this.setWeapon('stun'); }
  }
}

export interface LookAssets { mat: THREE.MeshLambertMaterial; head: THREE.BufferGeometry; torso: THREE.BufferGeometry; arm: THREE.BufferGeometry; leg: THREE.BufferGeometry }

export class Characters {
  readonly group = new THREE.Group();
  private bin = new Bin();
  // skin textures / materials / head+torso geometries are reference counted per live rig and evicted when unused
  private matCache = new RefPool<{ mat: THREE.MeshLambertMaterial; map: THREE.Texture }>((v) => { v.map.dispose(); v.mat.dispose(); }, 12);
  private headCache = new RefPool<THREE.BufferGeometry>((g) => g.dispose(), 12);
  private torsoCache = new RefPool<THREE.BufferGeometry>((g) => g.dispose(), 12);
  private arm: THREE.BufferGeometry; private leg: THREE.BufferGeometry;
  readonly flashGeo: THREE.BufferGeometry; readonly flashMat: THREE.MeshBasicMaterial;
  private boardGeo: THREE.BufferGeometry[] = []; private boardMats = new Map<number, THREE.MeshLambertMaterial>();
  private wheelMat: THREE.MeshLambertMaterial | null = null;
  /** shared-geometry skateboard (deck + 4 wheels) */
  makeBoard(variant: number): THREE.Group {
    if (!this.boardGeo.length) {
      this.boardGeo = [this.bin.add(new THREE.BoxGeometry(0.24, 0.03, 0.84)), this.bin.add(new THREE.BoxGeometry(0.2, 0.04, 0.06)), this.bin.add(new THREE.BoxGeometry(0.05, 0.05, 0.05))];
      this.wheelMat = this.bin.add(new THREE.MeshLambertMaterial({ color: 0xf2f2f2 }));
    }
    let m = this.boardMats.get(variant);
    if (!m) { m = this.bin.add(new THREE.MeshLambertMaterial({ color: new THREE.Color(NEON[variant % NEON.length]) })); this.boardMats.set(variant, m); }
    const g = new THREE.Group();
    const deck = new THREE.Mesh(this.boardGeo[0], m); deck.position.y = 0.075; g.add(deck);
    for (const z of [-0.3, 0.3]) for (const x of [-0.09, 0.09]) { const w = new THREE.Mesh(this.boardGeo[2], this.wheelMat!); w.position.set(x, 0.03, z); g.add(w); }
    for (const z of [-0.3, 0.3]) { const tr = new THREE.Mesh(this.boardGeo[1], this.wheelMat!); tr.position.set(0, 0.05, z); g.add(tr); }
    for (const c of g.children) c.frustumCulled = false;
    return g;
  }
  constructor() {
    this.arm = this.bin.add(buildArm()); this.leg = this.bin.add(buildLeg());
    this.flashGeo = this.bin.add(new THREE.PlaneGeometry(0.3, 0.3));
    this.flashMat = this.bin.add(new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 2.4, 1.2), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
  }
  private static headKey(def: LookDef) { return def.hairStyle + '|' + def.hat + '|' + def.head; }
  /** acquires a reference on the look's resources; give it back with releaseAssets */
  assets(def: LookDef, key: string): LookAssets {
    const { mat } = this.matCache.acquire(key, () => {
      const P = paintLook(def, hash(key) & 0xffff);
      const map = P.texture();
      return { mat: new THREE.MeshLambertMaterial({ map }), map };
    });
    const head = this.headCache.acquire(Characters.headKey(def), () => buildHead(def.hairStyle, def.hat, def.head));
    const torso = this.torsoCache.acquire(def.torsoAcc, () => buildTorso(def.torsoAcc));
    return { mat, head, torso, arm: this.arm, leg: this.leg };
  }
  releaseAssets(def: LookDef, key: string) {
    this.matCache.release(key); this.headCache.release(Characters.headKey(def)); this.torsoCache.release(def.torsoAcc);
  }
  createRig(def: LookDef): CharRig {
    const key = JSON.stringify(def);
    const rig = new CharRig(this);
    rig.setLook(def, key);
    this.group.add(rig.root);
    return rig;
  }
  /** name tag text sprite (cached material per text+colour) */
  setTag(rig: CharRig, text: string, color: string) {
    const key = text + '|' + color;
    if (rig.tagKey === key) return;
    rig.tagKey = key;
    const t = textTexture(text, color);
    releaseLabel(rig.labelKey); rig.labelKey = t.key;
    if (!rig.tag) { rig.tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: t.tex, transparent: true, depthWrite: false, toneMapped: false, fog: false })); rig.tag.renderOrder = 10; rig.root.add(rig.tag); }
    else { const m = rig.tag.material as THREE.SpriteMaterial; m.map = t.tex; m.needsUpdate = true; }
    rig.tag.userData.ratio = t.w / t.h;
  }
  setAlert(rig: CharRig, level01: number) {
    const lv = level01 <= 0.02 ? -1 : Math.min(9, Math.round(level01 * 9));
    if (lv === rig.alertLevel) return;
    rig.alertLevel = lv;
    if (lv < 0) { if (rig.alert) rig.alert.visible = false; return; }
    const tex = alertTextures()[lv];
    if (!rig.alert) { rig.alert = makeSprite(tex); rig.alert.renderOrder = 11; rig.alert.scale.set(0.6, 0.8, 1); rig.root.add(rig.alert); }
    else (rig.alert.material as THREE.SpriteMaterial).map = tex;
    (rig.alert.material as THREE.SpriteMaterial).needsUpdate = true;
    rig.alert.visible = true;
  }
  removeRig(rig: CharRig) {
    rig.root.removeFromParent();
    if (rig.alert) (rig.alert.material as THREE.SpriteMaterial).dispose();
    if (rig.tag) (rig.tag.material as THREE.SpriteMaterial).dispose();
    releaseLabel(rig.labelKey); rig.labelKey = '';
    if (rig.held) { this.releaseAssets(rig.held, rig.lookKey); rig.held = null; }
  }
  dispose() {
    this.bin.disposeAll();
    alertTex?.forEach((t) => t.dispose()); alertTex = null;
    this.matCache.clear(); this.headCache.clear(); this.torsoCache.clear(); this.boardMats.clear(); this.boardGeo = [];
  }
}

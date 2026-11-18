/** Blocky weapon models shared by the first-person ViewModel and held items on third-person characters. Origin = grip, barrel points toward -z. */
import * as THREE from 'three';
import { BoxBuilder } from './util';

export interface WeaponModel { geo: THREE.BufferGeometry; glow: THREE.BufferGeometry | null; muzzle: THREE.Vector3; /** second-hand position (forend) */ fore: THREE.Vector3 | null; length: number }

const cache = new Map<string, WeaponModel>();

export function weaponKind(id: string): 'stun' | 'pistol' | 'smg' | 'shotgun' | 'rifle' {
  if (id === 'stun' || id === 'pistol' || id === 'smg' || id === 'shotgun' || id === 'rifle') return id;
  return 'pistol';
}

const METAL = '#3c4148', DARK = '#23262b', LIGHT = '#6b727b', WOOD = '#8a5a34', WOOD2 = '#6f4526', POLY = '#2b2e33';

export function getWeaponModel(kind: string): WeaponModel {
  const k = weaponKind(kind);
  const hit = cache.get(k);
  if (hit) return hit;
  const b = new BoxBuilder();
  const g = new BoxBuilder();
  const muzzle = new THREE.Vector3();
  let fore: THREE.Vector3 | null = null;
  let length = 0.3;
  switch (k) {
    case 'stun': {
      // chunky yellow/white zapper with prongs and a glowing coil
      b.box(0, 0.06, -0.1, 0.07, 0.09, 0.26, '#f2c230');
      b.box(0, 0.115, -0.1, 0.075, 0.025, 0.22, '#2c2f35');
      b.box(0, -0.04, 0.02, 0.06, 0.15, 0.07, '#2c2f35');
      b.box(0, 0.0, -0.18, 0.05, 0.04, 0.1, '#e8eaee');
      b.box(0.028, 0.065, -0.3, 0.012, 0.012, 0.1, LIGHT);
      b.box(-0.028, 0.065, -0.3, 0.012, 0.012, 0.1, LIGHT);
      g.box(0, 0.065, -0.3, 0.02, 0.02, 0.09, '#5ad2ff');
      g.box(0, 0.12, -0.1, 0.03, 0.012, 0.07, '#ff4a3a');
      muzzle.set(0, 0.065, -0.36); length = 0.4;
      break;
    }
    case 'pistol': {
      b.box(0, 0.05, -0.1, 0.045, 0.06, 0.28, METAL);        // slide
      b.box(0, 0.015, -0.08, 0.04, 0.03, 0.22, DARK);        // frame
      b.box(0, -0.06, 0.02, 0.045, 0.14, 0.06, POLY);        // grip
      b.box(0, 0.085, -0.02, 0.012, 0.014, 0.012, '#e8eaee'); // rear sight
      b.box(0, 0.085, -0.22, 0.01, 0.014, 0.01, '#e8eaee');
      b.box(0, -0.005, -0.03, 0.01, 0.02, 0.06, DARK);        // trigger guard
      muzzle.set(0, 0.05, -0.25); length = 0.3;
      break;
    }
    case 'smg': {
      b.box(0, 0.05, -0.15, 0.06, 0.09, 0.4, METAL);
      b.box(0, 0.11, -0.14, 0.035, 0.03, 0.3, DARK);
      b.box(0, -0.065, -0.02, 0.045, 0.15, 0.06, POLY);
      b.box(0, -0.1, -0.14, 0.04, 0.2, 0.05, DARK);          // magazine
      b.box(0, 0.035, 0.16, 0.05, 0.07, 0.2, POLY);          // stock
      b.box(0, 0.045, -0.4, 0.03, 0.03, 0.12, LIGHT);        // barrel
      b.box(0, 0.145, -0.04, 0.012, 0.016, 0.012, '#e8eaee');
      muzzle.set(0, 0.045, -0.47); fore = new THREE.Vector3(0, 0.0, -0.26); length = 0.7;
      break;
    }
    case 'shotgun': {
      b.box(0, 0.045, -0.3, 0.045, 0.045, 0.7, METAL);        // barrel
      b.box(0, 0.0, -0.3, 0.04, 0.04, 0.62, DARK);            // magazine tube
      b.box(0, -0.005, -0.34, 0.06, 0.05, 0.2, WOOD2);        // pump
      b.box(0, 0.03, 0.0, 0.055, 0.08, 0.2, METAL);           // receiver
      b.box(0, -0.06, 0.03, 0.045, 0.13, 0.06, WOOD2);        // grip
      b.box(0, 0.0, 0.2, 0.06, 0.1, 0.24, WOOD);              // stock
      b.box(0, 0.075, -0.62, 0.012, 0.016, 0.012, '#ffdf6a');
      muzzle.set(0, 0.045, -0.66); fore = new THREE.Vector3(0, 0.0, -0.34); length = 0.95;
      break;
    }
    case 'rifle': {
      b.box(0, 0.05, -0.2, 0.055, 0.09, 0.46, '#4a5240');     // body (olive)
      b.box(0, 0.12, -0.12, 0.04, 0.035, 0.4, DARK);          // top rail
      b.box(0, 0.05, -0.55, 0.03, 0.03, 0.3, LIGHT);          // barrel
      b.box(0, 0.05, -0.7, 0.04, 0.04, 0.05, DARK);           // muzzle brake
      b.box(0, -0.07, -0.03, 0.045, 0.15, 0.06, POLY);
      b.box(0, -0.09, -0.2, 0.04, 0.17, 0.06, DARK);          // magazine
      b.box(0, 0.025, 0.2, 0.05, 0.11, 0.3, '#4a5240');       // stock
      b.box(0, 0.16, -0.12, 0.03, 0.05, 0.1, DARK);           // optic
      b.box(0, 0.16, -0.17, 0.02, 0.03, 0.01, '#ff4a3a');
      muzzle.set(0, 0.05, -0.74); fore = new THREE.Vector3(0, 0.0, -0.36); length = 1.0;
      break;
    }
  }
  const geo = b.build();
  const m: WeaponModel = { geo, glow: g.pos.length ? g.build() : null, muzzle, fore, length };
  cache.set(k, m);
  return m;
}

let wMat: THREE.MeshLambertMaterial | null = null, gMat: THREE.MeshBasicMaterial | null = null;
export function weaponMaterial() { return wMat ??= new THREE.MeshLambertMaterial({ vertexColors: true }); }
export function weaponGlowMaterial() { return gMat ??= new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, color: new THREE.Color(2, 2, 2) }); }

export function disposeWeapons() {
  for (const m of cache.values()) { m.geo.dispose(); m.glow?.dispose(); }
  cache.clear(); wMat?.dispose(); gMat?.dispose(); wMat = null; gMat = null;
}

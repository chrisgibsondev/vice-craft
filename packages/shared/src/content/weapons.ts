/**
 * Weapons. Damage is applied only to NPCs (guards, cops, hostiles) and mission
 * targets — player-versus-player damage is OFF in public free roam.
 * Sold at Bullseye Arms (original store). Ammo is bought in packs.
 */
export type WeaponKind = 'stun' | 'pistol' | 'smg' | 'shotgun' | 'rifle';
export interface WeaponDef {
  id: string; name: string; kind: WeaponKind;
  /** damage per hit (pellet) */ damage: number;
  /** shots per second */ rate: number;
  mag: number; reload: number;
  /** cone half-angle in radians */ spread: number;
  range: number; pellets: number; auto: boolean;
  price: number; ammoPrice: number; ammoPack: number; maxAmmo: number;
  /** non-lethal: stuns instead of damaging */ stun?: boolean;
  sfx: string; desc: string;
}

export const WEAPONS: Record<string, WeaponDef> = {
  stun: { id: 'stun', name: 'Zapper stun pistol', kind: 'stun', damage: 0, rate: 1.6, mag: 6, reload: 1.4, spread: 0.01, range: 30, pellets: 1, auto: false, price: 0, ammoPrice: 0, ammoPack: 6, maxAmmo: 999, stun: true, sfx: 'pistol', desc: 'Non-lethal. Knocks people out for a while. Everyone starts with one.' },
  pistol: { id: 'pistol', name: 'Marlin 9 pistol', kind: 'pistol', damage: 34, rate: 3.5, mag: 12, reload: 1.3, spread: 0.012, range: 60, pellets: 1, auto: false, price: 1200, ammoPrice: 60, ammoPack: 24, maxAmmo: 180, sfx: 'pistol', desc: 'Reliable sidearm.' },
  smg: { id: 'smg', name: 'Wasp SMG', kind: 'smg', damage: 20, rate: 11, mag: 30, reload: 1.8, spread: 0.035, range: 45, pellets: 1, auto: true, price: 4200, ammoPrice: 90, ammoPack: 60, maxAmmo: 360, sfx: 'pistol', desc: 'Fast, close range. Works from a car.' },
  shotgun: { id: 'shotgun', name: 'Breaker pump shotgun', kind: 'shotgun', damage: 16, rate: 1.1, mag: 6, reload: 2.6, spread: 0.09, range: 25, pellets: 8, auto: false, price: 3600, ammoPrice: 80, ammoPack: 12, maxAmmo: 72, sfx: 'pistol', desc: 'Devastating up close.' },
  rifle: { id: 'rifle', name: 'Gulfstream carbine', kind: 'rifle', damage: 30, rate: 7, mag: 30, reload: 2.1, spread: 0.018, range: 90, pellets: 1, auto: true, price: 8500, ammoPrice: 120, ammoPack: 60, maxAmmo: 360, sfx: 'pistol', desc: 'Accurate at range.' },
};
export const WEAPON_ORDER = ['stun', 'pistol', 'smg', 'shotgun', 'rifle'];

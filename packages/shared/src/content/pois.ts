/**
 * Placed points of interest (enterable buildings + landmarks).
 * Palmara: `lot` = [i, j] city-grid lot index: world x = 48·i … 48·i+47, z = 48·j … 48·j+47.
 * Leonia: `leonia` = a placement frame at a real street address (any 90° rotation).
 */
import { getPrefab, LOT, type Anchor } from '../world/structures.ts';
import { GROUND_Y, WORLD } from '../constants.ts';
import { frameToWorld, frameYaw, frameDoor, type Frame, type Rot } from '../world/placement.ts';
import { worldToLonLat } from '../world/leonia/proj.ts';
import { leoniaText } from './leonia/apply.ts';

export interface PoiDef {
  id: string;
  name: string;
  prefab: string;
  lot: [number, number];
  /**
   * Leonia placement (real Miami address): lot-centre world position + clockwise quarter turns
   * (front faces 0 N, 1 E, 2 S, 3 W). See world/placement.ts and docs/LEONIA.md §10.
   */
  leonia: Frame & { street: string; district: string };
  /** what the building is for (shown on the map & phone) */
  blurb: string;
  icon: string;
  /** true if the interior is a private instance (safehouse) */
  privateInterior?: boolean;
}

export const POIS: PoiDef[] = [
  { id: 'safehouse', name: 'The Coquina — your apartment', prefab: 'safehouse', lot: [51, 65], leonia: { ox: 13871, oz: 13590, rot: 2, street: 'NE 3rd Street', district: 'Downtown' }, icon: 'home', privateInterior: true, blurb: 'Personal safehouse. Rest to save and heal, plan heists on the board. Party members can come in with you.' },
  { id: 'plaza', name: 'Solano Plaza', prefab: 'plaza', lot: [51, 66], leonia: { ox: 14337, oz: 13850, rot: 3, street: 'Biscayne Boulevard (Bayfront Park)', district: 'Downtown' }, icon: 'star', blurb: 'Downtown square. New arrivals start here.' },
  { id: 'garage', name: 'Torque & Tide Garage', prefab: 'garage', lot: [50, 66], leonia: { ox: 13814, oz: 13698, rot: 1, street: 'NE 1st Avenue', district: 'Downtown' }, icon: 'wrench', blurb: 'Repairs, paint jobs, upgrades and your vehicle storage.' },
  { id: 'store', name: 'Quik Pelican', prefab: 'store', lot: [51, 67], leonia: { ox: 14101, oz: 13993, rot: 2, street: 'SE 1st Street', district: 'Downtown' }, icon: 'cart', blurb: 'Snacks (healing), first-aid kits and phone top-ups.' },
  { id: 'diner', name: 'Sunny Side Diner', prefab: 'diner', lot: [52, 66], leonia: { ox: 14033, oz: 13653, rot: 3, street: 'NE 2nd Avenue', district: 'Downtown' }, icon: 'cup', blurb: 'Hot food. Marisol Reyes hands out work from the corner booth.' },
  { id: 'club', name: 'Neon Lagoon', prefab: 'club', lot: [53, 66], leonia: { ox: 13101, oz: 10891, rot: 1, street: 'NW 2nd Avenue', district: 'Wynwood' }, icon: 'music', blurb: 'Nightclub. DJ Kilo runs the street-racing scene.' },
  { id: 'police', name: 'Solano PD — Central Precinct', prefab: 'police', lot: [50, 64], leonia: { ox: 13108, oz: 13381, rot: 3, street: 'NW 3rd Avenue', district: 'Downtown' }, icon: 'shield', blurb: 'Pay off fines to clear a wanted level (when not actively pursued).' },
  { id: 'warehouse', name: 'Pier 9 Warehouse', prefab: 'warehouse', lot: [56, 67], leonia: { ox: 16778, oz: 14106, rot: 0, street: 'Dodge Island cargo yard', district: 'PortMiami' }, icon: 'box', blurb: 'Dockside warehouse on Port Island. Locked — for now.' },
  { id: 'office', name: 'Vega & Sons Imports', prefab: 'office', lot: [52, 64], leonia: { ox: 13551, oz: 15043, rot: 0, street: 'SW 10th Street', district: 'Brickell' }, icon: 'briefcase', blurb: 'An import business with very clean books.' },
  { id: 'jewelers', name: 'Sundial Jewelers', prefab: 'jewelers', lot: [52, 65], leonia: { ox: 13692, oz: 15045, rot: 1, street: 'South Miami Avenue', district: 'Brickell' }, icon: 'gem', blurb: 'High-end jewellery. Closed after dark.' },
  { id: 'gunstore', name: 'Bullseye Arms', prefab: 'gunstore', lot: [50, 65], leonia: { ox: 12628, oz: 11313, rot: 0, street: 'NW 22nd Street', district: 'Wynwood' }, icon: 'box', blurb: 'Licensed gun store. Pistols, SMGs, shotguns, carbines and ammo. The clerk, Rico, will tell you the stun pistol is "a toy". It is not a toy.' },
  { id: 'threadline', name: 'Threadline', prefab: 'threadline', lot: [53, 65], leonia: { ox: 19527, oz: 13457, rot: 1, street: 'Euclid Avenue', district: 'South Beach' }, icon: 'cart', blurb: 'Boutique clothing and, in the back corner, Fade Away Barbers for a new hair colour.' },
  { id: 'sunline', name: 'Sunline Motors', prefab: 'sunline', lot: [54, 66], leonia: { ox: 19254, oz: 13953, rot: 0, street: '5th Street', district: 'South Beach' }, icon: 'star', blurb: 'Car showroom: new Palmara metal on a marble floor. Valentina will sell you anything with wheels - or a hull.' },
];

// Leonia: real place names in names / blurbs (fictional businesses keep theirs)
if (WORLD === 'leonia') for (const p of POIS) { p.name = leoniaText(p.name); p.blurb = leoniaText(p.blurb); }

export const POI_BY_LOT = new Map<number, PoiDef>(POIS.map((p) => [lotKey(p.lot[0], p.lot[1]), p]));
export function lotKey(i: number, j: number) { return j * 1024 + i; }

export interface WorldAnchor extends Anchor {
  poi: string;
  /** world coordinates (y = feet height) */
  wx: number; wy: number; wz: number;
  key: string;
}

/** the placement frame of a POI in the selected world (Palmara lots are unrotated frames) */
export function poiFrame(p: PoiDef, world = WORLD): Frame {
  if (world === 'leonia') return { ox: p.leonia.ox, oz: p.leonia.oz, rot: p.leonia.rot as Rot };
  return { ox: p.lot[0] * LOT + LOT / 2, oz: p.lot[1] * LOT + LOT / 2, rot: 0 };
}
/** Leonia placements for the generator (world/leonia/gen.ts) */
export function leoniaPlacements(): { prefab: string; frame: Frame }[] {
  return POIS.filter((p) => p.prefab).map((p) => ({ prefab: p.prefab, frame: poiFrame(p, 'leonia') }));
}
export function poiLonLat(p: PoiDef): [number, number] { return worldToLonLat(p.leonia.ox, p.leonia.oz); }

const anchorCache = new Map<string, WorldAnchor[]>();
export function worldAnchors(world = WORLD): WorldAnchor[] {
  const c = anchorCache.get(world);
  if (c) return c;
  const out: WorldAnchor[] = [];
  for (const p of POIS) {
    const s = getPrefab(p.prefab);
    const f = poiFrame(p, world);
    for (const a of s.anchors) {
      const [wx, wz] = frameToWorld(f, a.x, a.z);
      const w: WorldAnchor = { ...a, poi: p.id, wx, wy: GROUND_Y - 1 + a.y, wz, key: `${p.id}.${a.id}` };
      if (a.yaw !== undefined) w.yaw = frameYaw(f, a.yaw);
      if (a.kind === 'door') { const d = frameDoor(f, a.x, a.z, a.axis ?? 'x', a.width ?? 1); w.wx = d.x; w.wz = d.z; w.axis = d.axis; }
      out.push(w);
    }
  }
  anchorCache.set(world, out);
  return out;
}
export function anchor(key: string, world = WORLD): WorldAnchor {
  const a = worldAnchors(world).find((x) => x.key === key);
  if (!a) throw new Error(`unknown anchor ${key}`);
  return a;
}
export function poiCenter(id: string, world = WORLD): [number, number] {
  const p = POIS.find((x) => x.id === id)!;
  const f = poiFrame(p, world);
  return [f.ox, f.oz];
}

/** where new arrivals / respawns stand (feet height): the plaza in front of the fountain */
export function plazaSpawn(world = WORLD): { x: number; y: number; z: number } {
  if (world === 'palmara') return { x: 2472, y: GROUND_Y, z: 3204 };
  const [x, z] = frameToWorld(poiFrame(POIS.find((p) => p.id === 'plaza')!, world), 24.5, 12.5);
  return { x, y: GROUND_Y, z };
}
/** where busted players are released: the sidewalk in front of the police station */
export function policeSpawn(world = WORLD): { x: number; y: number; z: number } {
  if (world === 'palmara') return { x: 2423.5, y: GROUND_Y, z: 3076 };
  const [x, z] = frameToWorld(poiFrame(POIS.find((p) => p.id === 'police')!, world), 24, 5.5);
  return { x, y: GROUND_Y, z };
}

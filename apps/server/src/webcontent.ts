/**
 * Catalogue for the in-game web (phone browser). Prices and perks live on the server;
 * the client only renders what /api/web/properties returns.
 */
import { PALMARA, WORLD, poiCenter, lonLatToWorld } from '@blockshore/shared';

export interface PropertyDef {
  id: string; name: string; kind: 'safehouse' | 'garage' | 'business'; area: string; blurb: string;
  price: number;
  perks: { garageSlots?: number; dailyIncome?: number; spawn?: boolean };
  /** world x/z, resolved from the map's places / POIs */
  pos: [number, number];
}

function place(id: string): [number, number] { const p = PALMARA.places.find((x) => x.id === id); return p ? [p.pos[0], p.pos[1]] : [2500, 3160]; }
function poi(id: string): [number, number] { const c = poiCenter(id); return [c[0], c[1]]; }
const LEO = WORLD === 'leonia';
/** real Miami spot (lon, lat) on Leonia, a Palmara place otherwise */
function at(palmaraPlace: string, lon: number, lat: number): [number, number] { if (!LEO) return place(palmaraPlace); const [x, z] = lonLatToWorld(lon, lat); return [Math.round(x), Math.round(z)]; }
/** area label per world */
const area = (palmara: string, leonia: string) => (LEO ? leonia : palmara);

export const BASE_GARAGE_SLOTS = 10;
export const COLLECT_COOLDOWN_H = 24;

export const PROPERTIES: PropertyDef[] = [
  { id: 'plaza_loft', name: 'Plaza Loft', kind: 'safehouse', area: area('Solano Plaza, Port Solano', 'Bayfront Plaza, Biscayne Boulevard, Downtown'), blurb: 'Two floors above the fountain. Pigeons included, noise not.', price: 45_000, perks: { spawn: true }, pos: poi('plaza') },
  { id: 'beach_bungalow', name: 'Ocean Drive Bungalow', kind: 'safehouse', area: area('Solano Beach', 'Ocean Drive at 9th Street, South Beach'), blurb: 'Pastel stucco, a hammock and a carport for two.', price: 62_000, perks: { spawn: true, garageSlots: 2 }, pos: at('solano_beach', -80.1309, 25.7792) },
  { id: 'torque_lockup', name: 'Torque Row Lockup', kind: 'garage', area: area('Next to Torque & Tide, Port Solano', 'Next to Torque & Tide, NE 1st Avenue, Downtown'), blurb: 'Four bays, one flickering light, zero questions.', price: 30_000, perks: { garageSlots: 4 }, pos: poi('garage') },
  { id: 'bayhaven_deck', name: LEO ? 'Calle Ocho Parking Deck' : 'Bayhaven Parking Deck', kind: 'garage', area: area('Bayhaven', 'NW 7th Street, Little Havana'), blurb: 'A whole concrete deck. Valet is a raccoon named Gus.', price: 85_000, perks: { garageSlots: 8 }, pos: at('bayhaven', -80.2190, 25.7790) },
  { id: 'pelican_franchise', name: 'Quik Pelican Franchise', kind: 'business', area: area('Port Solano', 'SE 1st Street, Downtown'), blurb: 'You own a share of the snack bars. The snack bars own you.', price: 60_000, perks: { dailyIncome: 1_500 }, pos: poi('store') },
  { id: 'lagoon_stake', name: 'Neon Lagoon Stake', kind: 'business', area: area('Neon Lagoon, Port Solano', 'Neon Lagoon, NW 2nd Avenue, Wynwood'), blurb: 'A quiet partner in a very loud nightclub.', price: 120_000, perks: { dailyIncome: 3_400 }, pos: poi('club') },
  { id: 'cedar_boathouse', name: LEO ? 'Grove Isle Boathouse' : 'Cedar Bluff Boathouse', kind: 'safehouse', area: area('Cedar Bluff', 'Grove Isle, Coconut Grove'), blurb: 'North-shore boathouse with a slip, a sofa and a sea view.', price: 95_000, perks: { spawn: true, garageSlots: 2, dailyIncome: 600 }, pos: at('cedar_bluff', -80.2310, 25.7330) },
  { id: 'halcyon_hangar', name: LEO ? 'Perimeter Road Hangar' : 'Cape Halcyon Hangar', kind: 'garage', area: area('Cape Halcyon', 'NW 36th Street hangars, Leonia International'), blurb: LEO ? 'Hangar-adjacent storage. The jets are on time, the rent is earlier.' : 'Rocket-adjacent storage. The launch is delayed, the rent is not.', price: 150_000, perks: { garageSlots: 6, spawn: true, dailyIncome: 1_000 }, pos: at('cape_halcyon', -80.2855, 25.8048) },
];
export const PROPERTY_BY_ID: Record<string, PropertyDef> = Object.fromEntries(PROPERTIES.map((p) => [p.id, p]));

export const BANK = { dailyCap: 20_000, min: 10, perTransferMax: 10_000, confirmTtlMs: 120_000, ledgerRows: 30 };
export const AMMO_PREMIUM = 1.15;
export const BIG_HEIST_CASH = 1_000;

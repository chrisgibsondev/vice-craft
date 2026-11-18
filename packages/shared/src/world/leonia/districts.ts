/**
 * Leonia districts: hand-drawn approximate boxes (lat/lon) over the real Miami-area
 * neighbourhoods. They only steer architecture styles, infill density and map labels;
 * geometry always comes from OSM. First match wins, so specific boxes come first.
 * Names are the in-game (fictional state "Leonia") labels for real neighbourhoods.
 */
import { lonLatToWorld } from './proj.ts';

export type DistrictStyle =
  | 'downtown' | 'brickell' | 'edgewater' | 'wynwood' | 'design' | 'havana' | 'gables' | 'grove'
  | 'airport' | 'port' | 'sobe' | 'beach' | 'keys' | 'nature' | 'industrial' | 'suburb' | 'north';

export interface District { id: string; name: string; style: DistrictStyle; lat: [number, number]; lon: [number, number]; x0: number; z0: number; x1: number; z1: number }

const RAW: [string, string, DistrictStyle, [number, number], [number, number]][] = [
  ['port', 'Port Dodge', 'port', [25.768, 25.7815], [-80.183, -80.152]],
  ['downtown', 'Downtown', 'downtown', [25.766, 25.796], [-80.200, -80.183]],
  ['brickell', 'Brickell', 'brickell', [25.745, 25.768], [-80.210, -80.185]],
  ['edgewater', 'Edgewater', 'edgewater', [25.796, 25.830], [-80.192, -80.183]],
  ['wynwood', 'Wynwood', 'wynwood', [25.796, 25.812], [-80.210, -80.192]],
  ['design', 'Design District', 'design', [25.812, 25.842], [-80.200, -80.183]],
  ['havana', 'Little Havana', 'havana', [25.757, 25.782], [-80.245, -80.205]],
  ['mia', 'Leonia International Airport', 'airport', [25.778, 25.812], [-80.322, -80.262]],
  ['grove', 'Coconut Grove', 'grove', [25.708, 25.745], [-80.255, -80.215]],
  ['gables', 'Coral Gables', 'gables', [25.680, 25.760], [-80.300, -80.245]],
  ['virginia', 'Virginia Key', 'nature', [25.725, 25.755], [-80.175, -80.138]],
  ['keybiscayne', 'Key Biscayne', 'keys', [25.660, 25.725], [-80.180, -80.140]],
  ['sobe', 'South Beach', 'sobe', [25.764, 25.800], [-80.146, -80.120]],
  ['midbeach', 'Mid Beach', 'beach', [25.800, 25.850], [-80.140, -80.115]],
  ['northbeach', 'North Beach', 'beach', [25.850, 25.900], [-80.135, -80.110]],
  ['islands', 'Bay Islands', 'beach', [25.775, 25.860], [-80.180, -80.140]],
  ['doral', 'Doral Yards', 'industrial', [25.812, 25.900], [-80.330, -80.280]],
  ['allapattah', 'Allapattah', 'havana', [25.782, 25.815], [-80.262, -80.210]],
  ['northmiami', 'North Shore', 'north', [25.842, 25.900], [-80.230, -80.140]],
];

export const DISTRICTS: District[] = RAW.map(([id, name, style, lat, lon]) => {
  const [x0, z1] = lonLatToWorld(lon[0], lat[0]);
  const [x1, z0] = lonLatToWorld(lon[1], lat[1]);
  return { id, name, style, lat, lon, x0, z0, x1, z1 };
});
const DEFAULT: District = { id: 'suburbs', name: 'Leonia Suburbs', style: 'suburb', lat: [0, 0], lon: [0, 0], x0: 0, z0: 0, x1: 0, z1: 0 };

/** district at a world position (coarse 64 m cache for speed) */
const cache = new Map<number, District>();
export function districtAt(x: number, z: number): District {
  const k = Math.floor(x / 64) * 4096 + Math.floor(z / 64);
  let d = cache.get(k);
  if (d) return d;
  d = DEFAULT;
  const cx = Math.floor(x / 64) * 64 + 32, cz = Math.floor(z / 64) * 64 + 32;
  for (const r of DISTRICTS) if (cx >= r.x0 && cx <= r.x1 && cz >= r.z0 && cz <= r.z1) { d = r; break; }
  if (cache.size > 20000) cache.clear();
  cache.set(k, d);
  return d;
}

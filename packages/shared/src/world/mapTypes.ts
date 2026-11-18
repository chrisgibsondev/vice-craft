export type P2 = [number, number];
export type ZoneKind =
  | 'none' | 'forest' | 'farmland' | 'wetland' | 'suburb' | 'urban'
  | 'downtown' | 'industrial' | 'airport' | 'resort';
export const ZONE_KINDS: ZoneKind[] = ['none', 'forest', 'farmland', 'wetland', 'suburb', 'urban', 'downtown', 'industrial', 'airport', 'resort'];
export type RoadKind = 'highway' | 'arterial' | 'street';

export interface MapData {
  name: string;
  width: number;
  depth: number;
  seaLevel: number;
  seed: number;
  land: { id: string; points: P2[] }[];
  barriers: { id: string; width: number; points: P2[] }[];
  water: { id: string; kind: 'lake' | 'sea'; points: P2[] }[];
  rivers: { id: string; width: number; points: P2[] }[];
  zones: { id: string; kind: ZoneKind; points: P2[] }[];
  roads: { id: string; name: string; kind: RoadKind; points: P2[] }[];
  counties: { id: string; name: string; label: P2; points: P2[] }[];
  places: { id: string; name: string; kind: string; pos: P2 }[];
  streetGrid: { spacing: number; roadWidth: number; sidewalk: number };
}

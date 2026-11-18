/**
 * WorldNav: what server-side AI (traffic, pedestrians, wildlife, police) and gameplay helpers
 * (vehicle delivery) need to know about a world's streets, sidewalks and water. Two
 * implementations: PalmaraNav (the hand-authored map's 48-block street grid, exactly the
 * stage-1 behaviour) and LeoniaNav (real OSM road graph, see graph.ts).
 */
import type { WorldId } from '../../constants.ts';
import type { ZoneKind } from '../mapTypes.ts';
import type { VoxelQuery } from '../../physics.ts';
import type { RoadGraph } from './graph.ts';

export interface NavVoxels extends VoxelQuery { groundY(x: number, z: number, fromY?: number): number }
export interface NavPoint { x: number; z: number }

/** a position in a driving lane */
export interface LaneSpot {
  x: number; y: number; z: number;
  /** heading (game convention: forward = (-sin yaw, -cos yaw)) */
  yaw: number;
  /** graph edge (-1 on grid worlds), travel direction along it, arc length from the travel start */
  edge: number; dir: 1 | -1; s: number;
  /** lane index (0 = innermost) and lateral offset (m, right of travel) */
  lane: number; offset: number;
  /** speed limit, m/s */
  speed: number;
  /** road class (leonia RC) or 0 */
  cls: number;
}

export type WalkKind = 'sidewalk' | 'footway' | 'park' | 'beach' | 'plaza' | 'pier' | 'yard' | 'open';
export interface WalkSpot {
  x: number; z: number; kind: WalkKind;
  /** set when the spot lies on a graph edge's sidewalk / footway: edge, arc length (from a), side (−1 / +1 of a→b, 0 = on the footway) */
  edge?: number; s?: number; side?: number;
}

/** per-agent pursuit routing state (opaque to callers) */
export interface PursuitState {
  pts?: NavPoint[]; cum?: number[]; i?: number; along?: number; passUntil?: number; v?: number; goal?: NavPoint; at?: number; fails?: number;
}

export interface WorldNav {
  readonly world: WorldId;
  readonly width: number; readonly depth: number;
  /** road graph (real-data worlds), null on the grid world */
  readonly graph: RoadGraph | null;

  inBounds(x: number, z: number): boolean;
  /** on a car carriageway (asphalt) */
  isRoad(x: number, z: number): boolean;
  /** a street spot where city traffic / police may be placed (Palmara: urban zone on the grid) */
  isStreet(x: number, z: number): boolean;
  /** coarse zone for role tables (Leonia: district style + land use) */
  zoneAt(x: number, z: number): ZoneKind;
  isWater(x: number, z: number): boolean;
  /** signed coast distance: + on land, − offshore (m, coarse) */
  coastDist(x: number, z: number): number;
  /** top block y of the terrain column (water columns: 21) — footing search centre */
  groundTop(x: number, z: number): number;
  /** feet y over ground or the water surface (birds, flight landing) */
  surfaceY(x: number, z: number): number;

  /** nearest driving-lane position (right-hand lane for the side of the road the point is on) */
  nearestRoad(x: number, z: number, maxDist?: number): LaneSpot | null;
  /** random lane spot in the ring rMin..rMax around (x,z) */
  randomLaneNear(x: number, z: number, rMin: number, rMax: number, opt?: { minClass?: number; maxClass?: number; toward?: NavPoint; noBridge?: boolean }): LaneSpot | null;
  /** next edge at the end of (edge, dir); null at a dead end (graph worlds only) */
  nextEdge(edge: number, dir: 1 | -1, toward?: NavPoint): { edge: number; dir: 1 | -1 } | null;
  /** drivable route (polyline of centre-line points) from a to b, or null */
  route(ax: number, az: number, bx: number, bz: number): NavPoint[] | null;
  /** next steering waypoint for a pursuing vehicle; `vmax` (m/s) = advised speed for the bends ahead (graph worlds) */
  pursuitWaypoint(state: PursuitState, x: number, z: number, gx: number, gz: number, now: number): NavPoint & { vmax?: number };
  /** curb spot near the player for vehicle delivery */
  deliverySpot(x: number, z: number): { x: number; z: number; yaw: number; y?: number };
  /** open-water launch spot for boats near (x,z), or null (caller decides) */
  boatSpot(x: number, z: number): { x: number; z: number; yaw: number } | null;
  /** walking surface class at (x,z), null if not walkable (water, building, carriageway) */
  walkKindAt(x: number, z: number): WalkKind | null;
  /** random walkable spot (sidewalk, footway, park, beach, plaza, pier) in the ring */
  randomWalkSpot(x: number, z: number, rMin: number, rMax: number): WalkSpot | null;
}

export const yawOf = (fx: number, fz: number) => Math.atan2(-fx, -fz);

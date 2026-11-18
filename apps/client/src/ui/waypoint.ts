/** UI-owned waypoint (GPS target). The game loop reads it for guidance. */
export interface Waypoint { x: number; z: number }
let wp: Waypoint | null = null;
const cbs = new Set<(w: Waypoint | null) => void>();
export function getWaypoint(): Waypoint | null { return wp; }
export function setWaypoint(w: Waypoint | null) {
  wp = w ? { x: w.x, z: w.z } : null;
  for (const c of cbs) c(wp);
}
export function onWaypoint(cb: (w: Waypoint | null) => void): () => void {
  cbs.add(cb);
  return () => { cbs.delete(cb); };
}

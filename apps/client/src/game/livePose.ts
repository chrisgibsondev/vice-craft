/**
 * Per-frame values written by the game loop for UI that needs smooth updates
 * (minimap rotation, speedometer needle) without going through React state.
 * Read-only for UI code.
 */
export const livePose = {
  x: 2472, y: 22, z: 3204,
  /** camera yaw (radians, 0 = north/-z) */
  yaw: 0,
  speedKmh: 0,
  /** true while the game world is visible (not in menus) */
  active: false,
};

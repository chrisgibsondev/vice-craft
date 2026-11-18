export const PROTOCOL_VERSION = 1;
export const GAME_VERSION = '0.1.0';
export const TICK_RATE = 20;
export const DT = 1 / TICK_RATE;
export const CHUNK = 16;
/**
 * Which world this process runs. Default 'leonia' (true-scale real Miami from OpenStreetMap,
 * packages/shared/src/world/leonia, docs/LEONIA.md). 'palmara' (the hand-authored map) is chosen
 * by env BLOCKSHORE_WORLD=palmara (server/scripts/tests), ?world=palmara (page) or a worker named
 * '... world=palmara' (chunk workers). Evaluated once at module load.
 */
export type WorldId = 'palmara' | 'leonia';
function detectWorld(): WorldId {
  try {
    const g = globalThis as unknown as { process?: { env?: Record<string, string | undefined> }; name?: unknown; location?: { search?: string } };
    const env = g.process?.env?.BLOCKSHORE_WORLD;
    if (env === 'palmara' || env === 'leonia') return env;
    if (typeof g.name === 'string') { const m = /world=(palmara|leonia)/.exec(g.name); if (m) return m[1] as WorldId; }
    if (typeof g.location?.search === 'string') { const m = /[?&]world=(palmara|leonia)(&|$)/.exec(g.location.search); if (m) return m[1] as WorldId; }
  } catch { /* default */ }
  return 'leonia';
}
export const WORLD: WorldId = detectWorld();
/** Column height in blocks. Leonia doubles it so real towers fit (up to ~226 m above street). */
export const WORLD_H = WORLD === 'leonia' ? 256 : 128;
export const SEA_LEVEL = 20;
/** Height of walkable ground on flat land (top of block y=21). */
export const GROUND_Y = 22;
export const MAX_PLAYERS_PER_INSTANCE = 16;
export const MAX_PARTY = 4;
export const INTEREST_RADIUS = 200;
export const INTERACT_RANGE = 3.2;
export const VEHICLE_ENTER_RANGE = 4.5;
export const RECONNECT_GRACE_MS = 90_000;
export const INVITE_TTL_MS = 15 * 60_000;
export const CUTSCENE_LOAD_WAIT_MS = 8_000;

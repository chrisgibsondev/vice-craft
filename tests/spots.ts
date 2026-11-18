/**
 * World-specific test locations. The suite runs on Leonia by default (BLOCKSHORE_WORLD unset);
 * palmara.test.ts sets BLOCKSHORE_WORLD=palmara and reuses the same helpers.
 * WORLD is read at import time, so import this after any env change.
 */
import { WORLD, anchor, plazaSpawn } from '../packages/shared/src/index.ts';

type P = { x: number; y: number; z: number };
const LEO = WORLD === 'leonia';
/** a long straight street (northbound lanes) where a car can drive ~40 m forward: Biscayne Blvd at NE 4th St / Palmara downtown */
export const STREET: P = LEO ? { x: 14258, y: 22, z: 13605 } : { x: 2460, y: 22, z: 3168 };
/** the plaza (far from the shop counter) */
export const PLAZA: P = plazaSpawn();
/** standing at the Quik Pelican counter */
export function storeCounter(): P { const a = anchor('store.counter'); return { x: a.wx, y: a.wy, z: a.wz }; }
/** an open spot a few metres from the spawn, for position persistence */
export const OPEN: P = LEO ? { x: PLAZA.x - 0.0, y: 22, z: PLAZA.z + 3 } : { x: 2480, y: 22, z: 3190 };

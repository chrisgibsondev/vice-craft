/**
 * Hand-authored prefabs (the enterable buildings). Each prefab is built in lot-local
 * coordinates: x,z in 0..47 (streets occupy 0..3 and 44..47, sidewalks 4..6 and
 * 41..43, building area 7..40), y = 0 is the floor layer (world y 21), y = 1 is the
 * first walkable layer (world y 22). Fronts face north (low z).
 *
 * Anchors (doors, interaction points, NPC spots, spawns) are declared next to the
 * geometry so the server and client derive gameplay positions from the same data.
 */
import { B } from './blocks.ts';

export const STRUCT_H = 44;
export const LOT = 48;

export type AnchorKind = 'door' | 'interact' | 'npc' | 'spawn' | 'marker' | 'guard' | 'loot';
export interface Anchor {
  id: string;
  kind: AnchorKind;
  /** lot-local position; y is the walk layer (1 = ground floor) */
  x: number; y: number; z: number;
  /** door: plane axis ('x' = door spans along x), width in blocks; npc: facing yaw */
  axis?: 'x' | 'z';
  width?: number;
  yaw?: number;
  /** door lock rule or interact action */
  rule?: string;
  label?: string;
}

export class Struct {
  /** stored as id+1 so 0 means "leave terrain unchanged" */
  readonly data = new Uint8Array(LOT * LOT * STRUCT_H);
  readonly anchors: Anchor[] = [];
  maxY = 0;
  set(x: number, y: number, z: number, id: number) {
    if (x < 0 || z < 0 || x >= LOT || z >= LOT || y < 0 || y >= STRUCT_H) return;
    this.data[x + z * LOT + y * LOT * LOT] = id + 1;
    if (y > this.maxY) this.maxY = y;
  }
  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number) {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.set(x, y, z, id);
  }
  clear(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) { this.fill(x0, y0, z0, x1, y1, z1, B.AIR); }
  /** hollow shell: walls on the perimeter between y0..y1 */
  walls(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number) {
    for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      if (x === x0 || x === x1 || z === z0 || z === z1) this.set(x, y, z, id);
    }
  }
  /** windows along the perimeter of a shell for a band of y values */
  windows(x0: number, z0: number, x1: number, z1: number, ys: number[], id: number, every = 4, skip?: (x: number, z: number) => boolean) {
    for (const y of ys) {
      for (let x = x0 + 1; x < x1; x++) {
        if ((x - x0) % every !== 0 && !(skip?.(x, z0))) this.set(x, y, z0, id);
        if ((x - x0) % every !== 0 && !(skip?.(x, z1))) this.set(x, y, z1, id);
      }
      for (let z = z0 + 1; z < z1; z++) {
        if ((z - z0) % every !== 0 && !(skip?.(x0, z))) this.set(x0, y, z, id);
        if ((z - z0) % every !== 0 && !(skip?.(x1, z))) this.set(x1, y, z, id);
      }
    }
  }
  get(x: number, y: number, z: number): number {
    if (x < 0 || z < 0 || x >= LOT || z >= LOT || y < 0 || y >= STRUCT_H) return 0;
    return this.data[x + z * LOT + y * LOT * LOT];
  }
  anchor(a: Anchor) { this.anchors.push(a); }
}

function lamps(s: Struct, x0: number, z0: number, x1: number, z1: number, y: number, step = 6) {
  for (let z = z0 + 2; z <= z1 - 2; z += step) for (let x = x0 + 2; x <= x1 - 2; x += step) s.set(x, y, z, B.LAMP);
}

/** Ground slab under the whole lot building area so prefabs sit on a clean floor. */
function pad(s: Struct, floor: number) {
  s.fill(7, 0, 7, 40, 0, 40, B.SIDEWALK);
  void floor;
}

// ───────────────────────────────────────────────────────────── 1. SAFEHOUSE
function safehouse(): Struct {
  const s = new Struct();
  pad(s, B.SIDEWALK);
  const [x0, z0, x1, z1] = [10, 10, 37, 29];
  s.fill(x0, 1, z0, x1, 10, z1, B.STUCCO_PINK);
  s.fill(x0, 0, z0, x1, 0, z1, B.PLANK);
  s.clear(x0 + 1, 1, z0 + 1, x1 - 1, 4, z1 - 1);
  s.fill(x0, 5, z0, x1, 5, z1, B.STUCCO_WHITE); // floor band
  s.windows(x0, z0, x1, z1, [2, 3], B.GLASS, 4, (x, z) => z === z0 && x >= 22 && x <= 25);
  s.windows(x0, z0, x1, z1, [7, 8], B.WINDOW, 4);
  s.fill(x0 - 1, 11, z0 - 1, x1 + 1, 11, z1 + 1, B.STUCCO_WHITE); // cornice
  s.walls(x0 - 1, 12, z0 - 1, x1 + 1, 12, z1 + 1, B.STUCCO_TEAL); // parapet
  // awning + entrance
  s.fill(21, 4, z0 - 2, 26, 4, z0 - 1, B.STUCCO_TEAL);
  s.clear(23, 1, z0, 24, 2, z0);
  s.set(22, 3, z0 - 1, B.LAMP); s.set(25, 3, z0 - 1, B.LAMP);
  // interior: living room carpet
  s.fill(x0 + 1, 0, z0 + 1, 24, 0, z1 - 1, B.CARPET);
  s.fill(14, 1, 21, 18, 1, 21, B.SOFA);
  s.fill(14, 1, 22, 14, 1, 23, B.SOFA);
  s.fill(15, 1, 16, 17, 1, 16, B.DARK_PLANK); // coffee table... TV facing
  s.fill(14, 2, z0 + 1, 18, 3, z0 + 1, B.SCREEN); // TV on front wall
  // kitchen
  s.fill(26, 1, z0 + 1, 33, 1, z0 + 1, B.COUNTER);
  s.set(34, 1, z0 + 1, B.STOVE);
  s.fill(35, 1, z0 + 1, 35, 2, z0 + 1, B.FRIDGE);
  s.fill(28, 1, 15, 31, 1, 15, B.COUNTER); // island
  // bedroom partition
  s.fill(25, 1, 19, x1 - 1, 4, 19, B.STUCCO_WHITE);
  s.clear(29, 1, 19, 30, 2, 19);
  s.fill(25, 1, 20, 25, 4, z1 - 1, B.STUCCO_WHITE);
  s.fill(32, 1, 25, 35, 1, 27, B.BED);
  s.fill(36, 1, 21, 36, 3, 23, B.SHELF); // wardrobe
  // heist planning board on west wall
  s.fill(x0 + 1, 2, 24, x0 + 1, 3, 27, B.SCREEN);
  s.fill(x0 + 2, 1, 24, x0 + 3, 1, 27, B.DARK_PLANK);
  lamps(s, x0 + 1, z0 + 1, x1 - 1, z1 - 1, 4, 6);
  s.anchor({ id: 'door', kind: 'door', x: 23, y: 1, z: z0, axis: 'x', width: 2, rule: 'portal:safehouse', label: 'Home' });
  s.anchor({ id: 'bed', kind: 'interact', x: 31, y: 1, z: 26, rule: 'safehouse_bed', label: 'Rest & save' });
  s.anchor({ id: 'wardrobe', kind: 'interact', x: 35, y: 1, z: 22, rule: 'safehouse_wardrobe', label: 'Wardrobe' });
  s.anchor({ id: 'board', kind: 'interact', x: x0 + 4, y: 1, z: 25.5, rule: 'heist_board', label: 'Heist planning board' });
  s.anchor({ id: 'tv', kind: 'interact', x: 16.5, y: 1, z: z0 + 3, rule: 'safehouse_tv', label: 'Watch TV' });
  s.anchor({ id: 'inside', kind: 'spawn', x: 23.5, y: 1, z: z0 + 2.5, yaw: Math.PI });
  s.anchor({ id: 'outside', kind: 'spawn', x: 23.5, y: 1, z: z0 - 3, yaw: 0 });
  return s;
}

// ───────────────────────────────────────────────────────────── 2. MECHANIC GARAGE
function garage(): Struct {
  const s = new Struct();
  pad(s, B.SIDEWALK);
  const [x0, z0, x1, z1] = [8, 10, 39, 35];
  s.fill(x0, 1, z0, x1, 3, z1, B.BRICK);
  s.fill(x0, 4, z0, x1, 8, z1, B.METAL);
  s.fill(x0, 0, z0, x1, 0, z1, B.CONCRETE);
  s.clear(x0 + 1, 1, z0 + 1, x1 - 1, 7, z1 - 1);
  // bays
  for (const bx of [13, 27]) {
    s.clear(bx, 1, z0, bx + 6, 4, z0);
    s.fill(bx, 5, z0, bx + 6, 5, z0, B.SHUTTER);
    for (let x = bx; x <= bx + 6; x++) { s.set(x, 0, z0 + 2, B.STRIPE); s.set(x, 0, z0 + 14, B.STRIPE); }
    for (let z = z0 + 2; z <= z0 + 14; z++) { s.set(bx, 0, z, B.STRIPE); s.set(bx + 6, 0, z, B.STRIPE); }
    s.fill(bx - 2, 0, z0 - 3, bx + 8, 0, z0 - 1, B.ASPHALT); // driveway
  }
  s.fill(x0, 7, z0 - 1, x1, 7, z0 - 1, B.NEON_CYAN);
  s.windows(x0, z0, x1, z1, [6], B.WINDOW, 3);
  s.fill(x0 + 1, 1, z1 - 1, 20, 3, z1 - 1, B.SHELF);
  s.fill(x0 + 1, 1, z0 + 18, x0 + 2, 2, z0 + 22, B.CRATE);
  // office counter
  s.fill(33, 1, 26, 33, 1, 32, B.COUNTER);
  s.fill(34, 1, 34, 38, 2, 34, B.SHELF);
  s.set(37, 1, 28, B.SCREEN);
  lamps(s, x0 + 1, z0 + 1, x1 - 1, z1 - 1, 7, 7);
  s.anchor({ id: 'service', kind: 'interact', x: 32, y: 1, z: 29, rule: 'garage_service', label: 'Torque & Tide — service desk' });
  s.anchor({ id: 'mechanic', kind: 'npc', x: 35.5, y: 1, z: 29.5, yaw: -Math.PI / 2, rule: 'mechanic', label: 'Dez (mechanic)' });
  s.anchor({ id: 'bay_a', kind: 'marker', x: 16.5, y: 1, z: 18, rule: 'bay' });
  s.anchor({ id: 'bay_b', kind: 'marker', x: 30.5, y: 1, z: 18, rule: 'bay' });
  s.anchor({ id: 'vehicle_spawn', kind: 'spawn', x: 16.5, y: 1, z: 5, yaw: 0 });
  return s;
}

// ───────────────────────────────────────────────────────────── 3. CONVENIENCE STORE
function store(): Struct {
  const s = new Struct();
  pad(s, B.SIDEWALK);
  const [x0, z0, x1, z1] = [12, 10, 35, 25];
  s.fill(x0, 1, z0, x1, 5, z1, B.STUCCO_WHITE);
  s.fill(x0, 4, z0, x1, 4, z1, B.RED_STUCCO);
  s.fill(x0, 0, z0, x1, 0, z1, B.TILE_FLOOR);
  s.clear(x0 + 1, 1, z0 + 1, x1 - 1, 3, z1 - 1);
  s.fill(x0 + 1, 1, z0, x1 - 1, 3, z0, B.GLASS);
  s.clear(23, 1, z0, 24, 2, z0);
  s.fill(x0 - 1, 5, z0 - 1, x1 + 1, 5, z0 - 1, B.NEON_PINK);
  s.fill(x0 - 1, 6, z0 - 1, x1 + 1, 6, z1 + 1, B.STUCCO_WHITE);
  for (const z of [15, 19]) s.fill(14, 1, z, 25, 2, z, B.SHELF);
  s.fill(x1 - 1, 1, z0 + 2, x1 - 1, 2, z1 - 2, B.FRIDGE);
  s.fill(28, 1, 13, 28, 1, 16, B.COUNTER);
  s.fill(29, 1, 16, 31, 1, 16, B.COUNTER);
  s.set(28, 2, 14, B.SCREEN);
  lamps(s, x0 + 1, z0 + 1, x1 - 1, z1 - 1, 3, 5);
  s.anchor({ id: 'counter', kind: 'interact', x: 27, y: 1, z: 14.5, rule: 'shop_counter', label: 'Quik Pelican — buy' });
  s.anchor({ id: 'clerk', kind: 'npc', x: 30.5, y: 1, z: 13.5, yaw: -Math.PI / 2, rule: 'shopkeeper', label: 'Anjali (clerk)' });
  return s;
}

// ───────────────────────────────────────────────────────────── 4. DINER
function diner(): Struct {
  const s = new Struct();
  pad(s, B.SIDEWALK);
  const [x0, z0, x1, z1] = [9, 12, 38, 27];
  s.fill(x0, 1, z0, x1, 1, z1, B.CHROME);
  s.fill(x0, 2, z0, x1, 4, z1, B.STUCCO_TEAL);
  s.fill(x0, 0, z0, x1, 0, z1, B.TILE_FLOOR);
  s.clear(x0 + 1, 1, z0 + 1, x1 - 1, 4, z1 - 1);
  s.windows(x0, z0, x1, z1, [2, 3], B.GLASS, 30, (_x, z) => z === z1);
  s.clear(23, 1, z0, 24, 3, z0);
  s.fill(x0 - 1, 5, z0 - 1, x1 + 1, 5, z1 + 1, B.STUCCO_WHITE);
  s.fill(x0 - 1, 5, z0 - 1, x1 + 1, 5, z0 - 1, B.NEON_PINK);
  s.fill(18, 6, z0 - 1, 29, 7, z0 - 1, B.NEON_CYAN); // sign
  s.fill(14, 1, 21, 33, 1, 21, B.COUNTER);
  for (let x = 15; x <= 33; x += 2) s.set(x, 1, 19, B.STOOL);
  for (const bx of [10, 16, 27, 33]) {
    s.fill(bx, 1, 13, bx, 1, 14, B.SOFA);
    s.fill(bx + 1, 1, 13, bx + 2, 1, 14, B.COUNTER);
    s.fill(bx + 3, 1, 13, bx + 3, 1, 14, B.SOFA);
  }
  s.fill(14, 1, 26, 17, 1, 26, B.STOVE);
  s.fill(30, 1, 26, 31, 2, 26, B.FRIDGE);
  s.fill(20, 1, 26, 27, 1, 26, B.COUNTER);
  lamps(s, x0 + 1, z0 + 1, x1 - 1, z1 - 1, 4, 5);
  s.anchor({ id: 'counter', kind: 'interact', x: 24.5, y: 1, z: 20, rule: 'diner_counter', label: 'Sunny Side — order food' });
  s.anchor({ id: 'waitress', kind: 'npc', x: 24.5, y: 1, z: 23.5, yaw: Math.PI, rule: 'waitress', label: 'Bea (waitress)' });
  s.anchor({ id: 'contact', kind: 'npc', x: 21.5, y: 1, z: 15.5, yaw: 0, rule: 'contact:marisol', label: 'Marisol Reyes' });
  return s;
}

// ───────────────────────────────────────────────────────────── 5. NIGHTCLUB
function club(): Struct {
  const s = new Struct();
  pad(s, B.SIDEWALK);
  const [x0, z0, x1, z1] = [9, 9, 38, 38];
  s.fill(x0, 1, z0, x1, 8, z1, B.BRICK);
  s.fill(x0, 0, z0, x1, 0, z1, B.MARBLE);
  s.clear(x0 + 1, 1, z0 + 1, x1 - 1, 7, z1 - 1);
  s.walls(x0, 7, z0, x1, 7, z1, B.NEON_PINK);
  s.walls(x0, 3, z0, x1, 3, z1, B.NEON_CYAN);
  s.clear(23, 1, z0, 24, 2, z0);
  s.fill(21, 1, z0 - 1, 21, 3, z0 - 1, B.NEON_CYAN); s.fill(26, 1, z0 - 1, 26, 3, z0 - 1, B.NEON_CYAN);
  s.fill(19, 9, z0, 28, 10, z0, B.NEON_PINK);
  s.fill(15, 0, 18, 32, 0, 32, B.CLUB_FLOOR);
  s.fill(x0 + 2, 1, 14, x0 + 2, 1, 30, B.COUNTER);
  s.fill(x0 + 1, 1, 14, x0 + 1, 3, 30, B.SHELF);
  for (let z = 15; z <= 29; z += 3) s.set(x0 + 4, 1, z, B.STOOL);
  s.fill(20, 1, 35, 27, 1, 35, B.COUNTER);
  s.fill(20, 2, 37, 27, 4, 37, B.SCREEN);
  for (const x of [17, 30]) s.fill(x, 1, 35, x + 1, 4, 36, B.METAL);
  for (let z = 14; z <= 32; z += 6) for (let x = 14; x <= 33; x += 6) s.set(x, 7, z, B.NEON_CYAN);
  s.fill(x1 - 3, 1, 12, x1 - 1, 1, 30, B.SOFA);
  s.anchor({ id: 'bar', kind: 'interact', x: x0 + 3.5, y: 1, z: 22, rule: 'club_bar', label: 'Neon Lagoon — bar' });
  s.anchor({ id: 'dj', kind: 'npc', x: 23.5, y: 1, z: 36.5, yaw: Math.PI, rule: 'contact:kilo', label: 'DJ Kilo' });
  s.anchor({ id: 'bouncer', kind: 'npc', x: 25.5, y: 1, z: z0 - 2, yaw: 0, rule: 'bouncer', label: 'Bouncer' });
  s.anchor({ id: 'dj_talk', kind: 'interact', x: 23.5, y: 1, z: 33.5, rule: 'talk:kilo', label: 'Talk to DJ Kilo' });
  return s;
}

// ───────────────────────────────────────────────────────────── 6. POLICE STATION
function police(): Struct {
  const s = new Struct();
  pad(s, B.SIDEWALK);
  const [x0, z0, x1, z1] = [9, 10, 38, 33];
  s.fill(x0, 1, z0, x1, 6, z1, B.STUCCO_WHITE);
  s.fill(x0, 5, z0, x1, 5, z1, B.POLICE_BLUE);
  s.fill(x0, 0, z0, x1, 0, z1, B.TILE_FLOOR);
  s.clear(x0 + 1, 1, z0 + 1, x1 - 1, 4, 20);
  s.windows(x0, z0, x1, z1, [2, 3], B.WINDOW, 3, (x, z) => z === z0 && x >= 21 && x <= 26);
  s.clear(23, 1, z0, 24, 2, z0);
  s.fill(21, 1, z0, 21, 3, z0, B.GLASS); s.fill(26, 1, z0, 26, 3, z0, B.GLASS);
  s.walls(x0 - 1, 7, z0 - 1, x1 + 1, 7, z1 + 1, B.POLICE_BLUE);
  s.fill(19, 7, z0 - 1, 28, 7, z0 - 1, B.LAMP);
  // desk
  s.fill(14, 1, 17, 22, 1, 17, B.COUNTER);
  s.fill(25, 1, 17, 28, 1, 17, B.COUNTER);
  s.fill(x0 + 1, 1, 21, x1 - 1, 4, 21, B.POLICE_BLUE);
  s.clear(23, 1, 21, 24, 2, 21);
  // cells (visible through bars)
  s.fill(30, 1, z0 + 1, 30, 3, 16, B.RAIL);
  for (let z = z0 + 2; z <= 15; z += 2) s.set(30, 2, z, B.AIR);
  s.fill(34, 1, 12, 37, 1, 12, B.PLANK);
  s.fill(x0 + 1, 1, 12, x0 + 3, 1, 12, B.PLANK);
  s.fill(x0 + 1, 1, 15, x0 + 3, 1, 15, B.PLANK);
  lamps(s, x0 + 1, z0 + 1, x1 - 1, 20, 4, 5);
  s.anchor({ id: 'desk', kind: 'interact', x: 23.5, y: 1, z: 15.5, rule: 'police_desk', label: 'Front desk' });
  s.anchor({ id: 'officer', kind: 'npc', x: 23.5, y: 1, z: 19, yaw: 0, rule: 'officer', label: 'Sgt. Okafor' });
  s.anchor({ id: 'staff_door', kind: 'door', x: 23, y: 1, z: 21, axis: 'x', width: 2, rule: 'locked', label: 'Staff only' });
  s.anchor({ id: 'cell_door', kind: 'door', x: 30, y: 1, z: 17, axis: 'z', width: 1, rule: 'locked', label: 'Holding cell' });
  return s;
}

// ───────────────────────────────────────────────────────────── 7. DOCKSIDE WAREHOUSE
function warehouse(): Struct {
  const s = new Struct();
  pad(s, B.CONCRETE);
  const [x0, z0, x1, z1] = [7, 8, 40, 39];
  s.fill(x0, 1, z0, x1, 9, z1, B.METAL);
  s.fill(x0, 0, z0, x1, 0, z1, B.CONCRETE);
  s.clear(x0 + 1, 1, z0 + 1, x1 - 1, 8, z1 - 1);
  s.windows(x0, z0, x1, z1, [7], B.WINDOW, 3);
  s.clear(18, 1, z0, 29, 5, z0); // big shutter opening (door entity)
  s.fill(17, 6, z0 - 1, 30, 6, z0 - 1, B.STRIPE);
  s.clear(x1, 1, 30, x1, 2, 30); // side door
  // container rows
  for (const [cx, col] of [[10, B.CONTAINER_RED], [13, B.CONTAINER_BLUE]] as const) s.fill(cx, 1, 12, cx + 1, 2, 24, col);
  s.fill(10, 3, 14, 11, 4, 22, B.CONTAINER_BLUE);
  // crate stacks
  for (let x = 18; x <= 28; x += 5) for (let z = 16; z <= 28; z += 6) { s.fill(x, 1, z, x + 1, 2, z + 1, B.CRATE); if ((x + z) % 2) s.fill(x, 3, z, x, 3, z, B.CRATE); }
  // office
  s.fill(31, 1, 29, 39, 3, 29, B.GLASS);
  s.fill(31, 1, 30, 31, 3, 38, B.GLASS);
  s.clear(31, 1, 33, 31, 2, 33);
  s.fill(31, 4, 29, 39, 4, 38, B.METAL);
  s.fill(34, 1, 35, 37, 1, 35, B.COUNTER);
  s.set(35, 2, 35, B.SCREEN);
  s.set(38, 1, 37, B.SAFE);
  // catwalk
  s.fill(x0 + 1, 5, z1 - 3, 30, 5, z1 - 1, B.PLANK);
  for (let i = 0; i < 4; i++) s.fill(26 - i, 1 + i, z1 - 5, 26 - i, 1 + i, z1 - 4, B.PLANK);
  lamps(s, x0 + 1, z0 + 1, x1 - 1, z1 - 1, 8, 7);
  s.anchor({ id: 'shutter', kind: 'door', x: 18, y: 1, z: z0, axis: 'x', width: 12, rule: 'locked', label: 'Loading shutter' });
  s.anchor({ id: 'side_door', kind: 'door', x: x1, y: 1, z: 30, axis: 'z', width: 1, rule: 'locked', label: 'Side door' });
  s.anchor({ id: 'office_pc', kind: 'interact', x: 35.5, y: 1, z: 33.5, rule: 'mission_object', label: 'Office terminal' });
  s.anchor({ id: 'ledger', kind: 'marker', x: 36.5, y: 1, z: 36.5 });
  s.anchor({ id: 'crate_a', kind: 'loot', x: 20, y: 1, z: 19 });
  s.anchor({ id: 'crate_b', kind: 'loot', x: 25, y: 1, z: 25 });
  s.anchor({ id: 'crate_c', kind: 'loot', x: 15, y: 1, z: 30 });
  s.anchor({ id: 'crate_d', kind: 'loot', x: 28, y: 1, z: 31 });
  s.anchor({ id: 'guard_1', kind: 'guard', x: 22, y: 1, z: 12 });
  s.anchor({ id: 'guard_2', kind: 'guard', x: 33, y: 1, z: 20 });
  s.anchor({ id: 'guard_3', kind: 'guard', x: 16, y: 1, z: 34 });
  return s;
}

// ───────────────────────────────────────────────────────────── 8. OFFICE (Vega & Sons Imports)
function office(): Struct {
  const s = new Struct();
  pad(s, B.SIDEWALK);
  const [x0, z0, x1, z1] = [10, 10, 37, 37];
  s.fill(x0, 1, z0, x1, 40, z1, B.CONCRETE);
  s.fill(x0, 0, z0, x1, 0, z1, B.MARBLE);
  s.clear(x0 + 1, 1, z0 + 1, x1 - 1, 5, z1 - 1);
  const ys: number[] = [];
  for (let y = 7; y < 40; y++) if ((y - 7) % 4 !== 3) ys.push(y);
  s.windows(x0, z0, x1, z1, ys, B.WINDOW, 3);
  s.windows(x0, z0, x1, z1, [1, 2, 3, 4], B.GLASS, 9, (x, z) => z === z0 && x >= 22 && x <= 25);
  s.clear(23, 1, z0, 24, 3, z0);
  s.fill(x0 - 1, 41, z0 - 1, x1 + 1, 41, z1 + 1, B.CHROME);
  s.fill(18, 6, z0 - 1, 29, 6, z0 - 1, B.LAMP);
  // lobby
  s.fill(19, 1, 18, 28, 1, 18, B.COUNTER);
  s.fill(12, 1, 13, 12, 1, 17, B.SOFA);
  s.fill(35, 1, 13, 35, 1, 17, B.SOFA);
  s.set(12, 1, 11, B.HEDGE); s.set(35, 1, 11, B.HEDGE);
  s.fill(15, 1, z1 - 1, 20, 4, z1 - 1, B.CHROME); // elevators
  // back office
  s.fill(26, 1, 27, x1 - 1, 5, 27, B.DARK_PLANK);
  s.fill(26, 1, 28, 26, 5, z1 - 1, B.DARK_PLANK);
  s.clear(30, 1, 27, 30, 2, 27);
  s.fill(30, 0, 28, x1 - 1, 0, z1 - 1, B.CARPET);
  s.fill(30, 1, 33, 34, 1, 33, B.DARK_PLANK);
  s.set(32, 2, 33, B.SCREEN);
  s.set(35, 1, 35, B.SAFE);
  lamps(s, x0 + 1, z0 + 1, x1 - 1, z1 - 1, 5, 6);
  s.anchor({ id: 'reception', kind: 'npc', x: 23.5, y: 1, z: 20, yaw: Math.PI, rule: 'receptionist', label: 'Reception' });
  s.anchor({ id: 'office_door', kind: 'door', x: 30, y: 1, z: 27, axis: 'x', width: 1, rule: 'locked', label: 'Private office' });
  s.anchor({ id: 'computer', kind: 'interact', x: 32.5, y: 1, z: 31.5, rule: 'mission_object', label: 'Office computer' });
  s.anchor({ id: 'reception_desk', kind: 'interact', x: 23.5, y: 1, z: 16.5, rule: 'talk:reception', label: 'Reception desk' });
  return s;
}

// ───────────────────────────────────────────────────────────── Heist target: SUNDIAL JEWELERS
function jewelers(): Struct {
  const s = new Struct();
  pad(s, B.SIDEWALK);
  const [x0, z0, x1, z1] = [12, 12, 35, 31];
  s.fill(x0, 1, z0, x1, 6, z1, B.MARBLE);
  s.fill(x0, 5, z0, x1, 5, z1, B.STUCCO_YELLOW);
  s.fill(x0, 0, z0, x1, 0, z1, B.MARBLE);
  s.clear(x0 + 1, 1, z0 + 1, x1 - 1, 4, z1 - 1);
  s.fill(x0 + 1, 1, z0, x1 - 1, 3, z0, B.GLASS);
  s.clear(23, 1, z0, 24, 2, z0);
  s.fill(x0 - 1, 6, z0 - 1, x1 + 1, 6, z0 - 1, B.STUCCO_YELLOW);
  s.fill(19, 7, z0 - 1, 28, 7, z0 - 1, B.LAMP);
  // partition between showroom and back room
  s.fill(x0 + 1, 1, 23, x1 - 1, 4, 23, B.MARBLE);
  s.clear(18, 1, 23, 18, 2, 23);
  // display cases
  for (const [cx, cz, w] of [[15, 16, 3], [21, 19, 6], [30, 16, 3], [15, 21, 2], [31, 21, 2]] as const) {
    s.fill(cx, 1, cz, cx + w - 1, 1, cz + 1, B.COUNTER);
    s.fill(cx, 2, cz, cx + w - 1, 2, cz + 1, B.GLASS);
  }
  // back room
  s.fill(x0 + 1, 0, 24, x1 - 1, 0, z1 - 1, B.CONCRETE);
  s.fill(30, 1, 29, 31, 2, 30, B.SAFE);
  s.set(x0 + 1, 2, 25, B.SCREEN);
  s.set(x1 - 1, 2, 25, B.SCREEN);
  s.clear(26, 1, z1, 26, 2, z1); // back door
  s.fill(14, 1, 29, 18, 2, 30, B.SHELF);
  lamps(s, x0 + 1, z0 + 1, x1 - 1, z1 - 1, 4, 5);
  s.anchor({ id: 'front_door', kind: 'door', x: 23, y: 1, z: z0, axis: 'x', width: 2, rule: 'shop_hours', label: 'Sundial Jewelers' });
  s.anchor({ id: 'inner_door', kind: 'door', x: 18, y: 1, z: 23, axis: 'x', width: 1, rule: 'locked', label: 'Staff only' });
  s.anchor({ id: 'back_door', kind: 'door', x: 26, y: 1, z: z1, axis: 'x', width: 1, rule: 'locked', label: 'Back door' });
  s.anchor({ id: 'keypad_a', kind: 'marker', x: x0 + 2, y: 1, z: 25.5 });
  s.anchor({ id: 'keypad_b', kind: 'marker', x: x1 - 2, y: 1, z: 25.5 });
  s.anchor({ id: 'safe', kind: 'marker', x: 29, y: 1, z: 28 });
  s.anchor({ id: 'case_1', kind: 'loot', x: 16, y: 1, z: 15 });
  s.anchor({ id: 'case_2', kind: 'loot', x: 23, y: 1, z: 18 });
  s.anchor({ id: 'case_3', kind: 'loot', x: 31, y: 1, z: 15 });
  s.anchor({ id: 'case_4', kind: 'loot', x: 16, y: 1, z: 20.5 });
  s.anchor({ id: 'case_5', kind: 'loot', x: 32, y: 1, z: 20.5 });
  s.anchor({ id: 'case_6', kind: 'loot', x: 25, y: 1, z: 21.5 });
  s.anchor({ id: 'guard_1', kind: 'guard', x: 20, y: 1, z: 14 });
  s.anchor({ id: 'guard_2', kind: 'guard', x: 28, y: 1, z: 26 });
  s.anchor({ id: 'guard_3', kind: 'guard', x: 32, y: 1, z: 19 });
  s.anchor({ id: 'clerk', kind: 'npc', x: 24, y: 1, z: 15, yaw: 0, rule: 'shopkeeper', label: 'Jeweler' });
  return s;
}

/** Plaza with fountain (used for downtown open lots and the spawn square). */
function plaza(): Struct {
  const s = new Struct();
  s.fill(7, 0, 7, 40, 0, 40, B.MARBLE);
  for (let x = 7; x <= 40; x++) for (let z = 7; z <= 40; z++) if ((x + z) % 6 === 0) s.set(x, 0, z, B.TILE_FLOOR);
  s.walls(19, 1, 19, 28, 1, 28, B.MARBLE);
  s.fill(20, 0, 20, 27, 0, 27, B.WATER);
  s.fill(23, 1, 23, 24, 3, 24, B.MARBLE);
  s.fill(23, 4, 23, 24, 4, 24, B.WATER);
  for (const [x, z] of [[10, 10], [37, 10], [10, 37], [37, 37]]) s.fill(x - 1, 1, z - 1, x + 1, 1, z + 1, B.HEDGE);
  for (const x of [12, 35]) for (const z of [20, 27]) s.fill(x, 1, z, x, 1, z + 1, B.DARK_PLANK);
  return s;
}


// ───────────────────────────────────────────────────────────── 11. BULLSEYE ARMS (gun store)
function gunstore(): Struct {
  const s = new Struct();
  pad(s, B.SIDEWALK);
  const [x0, z0, x1, z1] = [11, 10, 36, 27];
  s.fill(x0, 1, z0, x1, 5, z1, B.BRICK);
  s.fill(x0, 0, z0, x1, 0, z1, B.TILE_FLOOR);
  s.clear(x0 + 1, 1, z0 + 1, x1 - 1, 4, z1 - 1);
  s.fill(x0 + 1, 1, z0, x1 - 1, 3, z0, B.GLASS); // storefront
  s.clear(23, 1, z0, 24, 3, z0); // door
  s.fill(x0 - 1, 5, z0 - 1, x1 + 1, 6, z0 - 1, B.RED_STUCCO); // sign band
  s.fill(15, 6, z0 - 1, 32, 6, z0 - 1, B.NEON_PINK);
  s.fill(x0 - 1, 6, z0, x1 + 1, 6, z1 + 1, B.STUCCO_WHITE); // roof edge
  // counter + clerk space
  s.fill(17, 1, 18, 31, 1, 18, B.COUNTER);
  s.fill(17, 2, 18, 31, 2, 18, B.GLASS);
  // wall racks
  s.fill(x0 + 1, 1, z1 - 1, x1 - 1, 3, z1 - 1, B.SHELF);
  s.fill(x0 + 1, 1, 14, x0 + 1, 3, 22, B.SHELF);
  s.fill(x1 - 1, 1, 14, x1 - 1, 3, 22, B.SHELF);
  // display tables
  for (const [tx, tz] of [[14, 13], [32, 13]] as const) { s.fill(tx, 1, tz, tx + 1, 1, tz + 1, B.COUNTER); s.fill(tx, 2, tz, tx + 1, 2, tz + 1, B.GLASS); }
  // practice target board in the corner
  s.fill(34, 1, z0 + 1, 34, 3, z0 + 2, B.STRIPE);
  lamps(s, x0 + 1, z0 + 1, x1 - 1, z1 - 1, 4, 5);
  s.anchor({ id: 'counter', kind: 'interact', x: 24, y: 1, z: 16.5, rule: 'shop:gunstore', label: 'Bullseye Arms — browse' });
  s.anchor({ id: 'clerk', kind: 'npc', x: 24.5, y: 1, z: 20.5, yaw: 0, rule: 'shopkeeper', label: 'Rico (gunsmith)' });
  return s;
}

// ───────────────────────────────────────────────────────────── 12. THREADLINE (clothes + barber)
function threadline(): Struct {
  const s = new Struct();
  pad(s, B.SIDEWALK);
  const [x0, z0, x1, z1] = [10, 10, 37, 28];
  s.fill(x0, 1, z0, x1, 5, z1, B.STUCCO_PINK);
  s.fill(x0, 5, z0, x1, 5, z1, B.STUCCO_WHITE);
  s.fill(x0, 0, z0, x1, 0, z1, B.CARPET);
  s.clear(x0 + 1, 1, z0 + 1, x1 - 1, 4, z1 - 1);
  s.fill(x0 + 1, 1, z0, x1 - 1, 3, z0, B.GLASS);
  s.clear(23, 1, z0, 24, 3, z0);
  s.fill(x0 - 1, 6, z0 - 1, x1 + 1, 6, z0 - 1, B.STUCCO_TEAL);
  s.fill(16, 6, z0 - 1, 31, 6, z0 - 1, B.NEON_CYAN);
  s.fill(x0 - 1, 6, z0, x1 + 1, 6, z1 + 1, B.STUCCO_WHITE);
  // clothing racks (west and back)
  s.fill(x0 + 1, 1, 13, x0 + 2, 2, 24, B.SHELF);
  s.fill(x0 + 4, 1, z1 - 1, 24, 2, z1 - 1, B.SHELF);
  for (const x of [15, 19]) s.fill(x, 1, 15, x, 2, 17, B.SHELF);
  // mirrors
  s.fill(14, 2, z1, 21, 3, z1, B.CHROME);
  // till counter
  s.fill(19, 1, 20, 27, 1, 20, B.COUNTER);
  // barber corner (east)
  s.fill(x1 - 1, 2, 14, x1 - 1, 3, 24, B.CHROME); // wall mirror
  s.fill(34, 1, 18, 34, 1, 18, B.SOFA); s.fill(34, 1, 22, 34, 1, 22, B.SOFA); // two chairs
  s.fill(35, 1, 15, 35, 1, 16, B.COUNTER); // station
  lamps(s, x0 + 1, z0 + 1, x1 - 1, z1 - 1, 4, 5);
  s.anchor({ id: 'counter', kind: 'interact', x: 23, y: 1, z: 18.5, rule: 'shop:clothes', label: 'Threadline — try on' });
  s.anchor({ id: 'clerk', kind: 'npc', x: 23.5, y: 1, z: 22.5, yaw: 0, rule: 'shopkeeper', label: 'Odalys (stylist)' });
  s.anchor({ id: 'chair', kind: 'interact', x: 32, y: 1, z: 20, rule: 'shop:barber', label: 'Fade Away Barbers — hair colour' });
  s.anchor({ id: 'barber', kind: 'npc', x: 35.5, y: 1, z: 20, yaw: Math.PI / 2, rule: 'shopkeeper', label: 'Tomas (barber)' });
  return s;
}

// ───────────────────────────────────────────────────────────── 13. SUNLINE MOTORS (car showroom)
function sunline(): Struct {
  const s = new Struct();
  pad(s, B.SIDEWALK);
  const [x0, z0, x1, z1] = [8, 9, 39, 33];
  s.fill(x0, 1, z0, x1, 5, z1, B.STUCCO_WHITE);
  s.fill(x0, 0, z0, x1, 0, z1, B.MARBLE);
  s.clear(x0 + 1, 1, z0 + 1, x1 - 1, 4, z1 - 1);
  s.fill(x0 + 1, 1, z0, x1 - 1, 4, z0, B.GLASS); // wide glass front
  s.clear(22, 1, z0, 25, 3, z0); // door
  s.fill(x0 - 1, 5, z0 - 1, x1 + 1, 6, z0 - 1, B.CHROME);
  s.fill(14, 6, z0 - 1, 33, 6, z0 - 1, B.NEON_CYAN);
  s.fill(x0 - 1, 6, z0, x1 + 1, 6, z1 + 1, B.STUCCO_WHITE);
  s.fill(x0 + 1, 1, z1, x1 - 1, 4, z1, B.GLASS);
  // sales desk
  s.fill(21, 1, 13, 27, 1, 13, B.COUNTER);
  s.set(24, 2, 13, B.SCREEN);
  // three display cars on lit podiums
  for (const [cx, col] of [[12, B.CONTAINER_RED], [22, B.CONTAINER_BLUE], [31, B.STRIPE]] as const) {
    s.fill(cx - 1, 0, 19, cx + 5, 0, 25, B.NEON_CYAN);
    s.fill(cx, 1, 20, cx + 4, 1, 24, B.CHROME);
    s.fill(cx, 2, 20, cx + 4, 2, 24, col);
    s.fill(cx + 1, 3, 21, cx + 3, 3, 23, B.GLASS);
  }
  lamps(s, x0 + 1, z0 + 1, x1 - 1, z1 - 1, 4, 6);
  s.anchor({ id: 'desk', kind: 'interact', x: 24, y: 1, z: 11.5, rule: 'shop:dealer', label: 'Sunline Motors — vehicle dealer' });
  s.anchor({ id: 'salesman', kind: 'npc', x: 24.5, y: 1, z: 15.5, yaw: 0, rule: 'shopkeeper', label: 'Valentina (sales)' });
  return s;
}

export const PREFABS: Record<string, () => Struct> = {
  safehouse, garage, store, diner, club, police, warehouse, office, jewelers, plaza,
  gunstore, threadline, sunline,
};

const cache = new Map<string, Struct>();
export function getPrefab(id: string): Struct {
  let s = cache.get(id);
  if (!s) { s = PREFABS[id](); cache.set(id, s); }
  return s;
}

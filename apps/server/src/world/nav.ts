/**
 * The server's WorldNav for the selected world: the Palmara street grid, or the Leonia
 * road graph (graph.bin next to the tiles, built by scripts/osm/graph.ts) on top of the
 * generator's tile cache.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { WORLD, PALMARA, LEONIA, PalmaraNav, LeoniaNav, RoadGraph, type WorldNav } from '@blockshore/shared';
import { voxels, worldGen, leoniaGen, LEONIA_DIR } from './voxels.ts';

function loadLeonia(): LeoniaNav {
  const f = join(LEONIA_DIR, 'graph.bin');
  if (!existsSync(f)) throw new Error(`Leonia road graph missing: ${f} (run: npx tsx scripts/osm/graph.ts)`);
  const g = new RoadGraph(new Uint8Array(readFileSync(f)), LEONIA.width, LEONIA.depth);
  return new LeoniaNav(g, leoniaGen!.tiles, voxels);
}

export const nav: WorldNav = WORLD === 'leonia' ? loadLeonia() : new PalmaraNav(worldGen, voxels, PALMARA);
/** typed access for Leonia-only systems */
export const leoniaNav: LeoniaNav | null = nav instanceof LeoniaNav ? nav : null;

/**
 * Server-side voxel access: chunks generated on demand from the shared generator and
 * kept in an LRU cache. The world is static (no block editing), so one cache is
 * shared by every instance.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { CHUNK, WORLD_H, WORLD, B, PALMARA, getWorldGen, LeoniaGen, type VoxelQuery } from '@blockshore/shared';

/** Palmara generator (also the raster the stage-1 NPC/traffic systems still query). */
const gen = getWorldGen(PALMARA);

/** Chunk generator for the selected world (BLOCKSHORE_WORLD=leonia → real-data Miami tiles read from disk). */
export const LEONIA_DIR = process.env.BLOCKSHORE_LEONIA_DATA ?? join(fileURLToPath(new URL('.', import.meta.url)), '../../../client/public/world/leonia');
/** Leonia generator (null on Palmara); its tile cache is shared with the navigation layer (nav.ts). */
export const leoniaGen: LeoniaGen | null = WORLD === 'leonia'
  ? new LeoniaGen({ readSync: (tx, tz) => { const f = join(LEONIA_DIR, `t_${tx}_${tz}.bin`); return existsSync(f) ? new Uint8Array(readFileSync(f)) : null; } }, 48)
  : null;
const regionGen: { generateRegion(x0: number, z0: number, w: number, d: number, out: Uint8Array): void } = leoniaGen ?? gen;

/**
& (env BLOCKSHORE_CHUNK_CACHE_MB). A 16×16 column is
 * 32 KB on Palmara (WORLD_H 128) and 64 KB on Leonia (256). Defaults: Palmara 50 MB (1 600
 * chunks, as before); Leonia 512 MB (8 192 chunks) so 16 players spread over the city (≈ 450
 * chunks each inside the 200 m interest radius) plus traffic/police ground probes stay resident.
 */
export function chunkCacheMax(): number {
  const mb = Number(process.env.BLOCKSHORE_CHUNK_CACHE_MB) || (WORLD === 'leonia' ? 512 : 50);
  return Math.max(256, Math.floor((mb * 1024 * 1024) / (CHUNK * CHUNK * WORLD_H)));
}

export class VoxelCache implements VoxelQuery {
  /** columns are stored only up to their highest non-air layer (street-level chunks are ~30 high, not 256) */
  private chunks = new Map<number, Uint8Array>();
  private scratch = new Uint8Array(CHUNK * CHUNK * WORLD_H);
  constructor(readonly max = chunkCacheMax()) {}
  generated = 0;

  private key(cx: number, cz: number) { return cz * 4096 + cx; }

  chunk(cx: number, cz: number): Uint8Array {
    const k = this.key(cx, cz);
    let c = this.chunks.get(k);
    if (c) {
      // refresh LRU order
      this.chunks.delete(k); this.chunks.set(k, c);
      return c;
    }
    c = new Uint8Array(CHUNK * CHUNK * WORLD_H);
    regionGen.generateRegion(cx * CHUNK, cz * CHUNK, CHUNK, CHUNK, c);
    this.generated++;
    this.chunks.set(k, c);
    if (this.chunks.size > this.max) {
      const first = this.chunks.keys().next().value as number;
      this.chunks.delete(first);
    }
    return c;
  }

  getBlock(x: number, y: number, z: number): number {
    if (y < 0) return B.STONE;
    if (y >= WORLD_H) return B.AIR;
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const c = this.chunk(cx, cz);
    if (y * CHUNK * CHUNK >= c.length) return B.AIR; // above the stored height
    return c[(x - cx * CHUNK) + (z - cz * CHUNK) * CHUNK + y * CHUNK * CHUNK];
  }

  /** feet height of the first standable surface at or below `fromY` */
  groundY(x: number, z: number, fromY = 60): number {
    const bx = Math.floor(x), bz = Math.floor(z);
    for (let y = Math.floor(fromY); y > 0; y--) {
      const id = this.getBlock(bx, y, bz);
      if (id !== B.AIR && id !== B.WATER && id !== B.TALL_GRASS && id !== B.FLOWERS && id !== B.REEDS && id !== B.CANE && id !== B.PALM_LEAVES) return y + 1;
      if (id === B.WATER) return y + 1;
    }
    return 22;
  }

  size() { return this.chunks.size; }
}

export const voxels = new VoxelCache();
export { gen as worldGen };

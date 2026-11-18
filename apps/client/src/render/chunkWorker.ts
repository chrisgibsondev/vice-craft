/// <reference lib="webworker" />
/** Generates + meshes chunks off the main thread using the shared deterministic generator. */
import { getWorldGen, PALMARA, CHUNK, WORLD_H, WORLD, LeoniaGen } from '@blockshore/shared';
import { meshChunk, MESH_PAD } from './mesher';

// World selection: chunks.ts names the worker 'world=leonia' / 'world=palmara' after the page's world
// (constants.ts reads self.name; Leonia is the default).
const leonia = WORLD === 'leonia'
  ? new LeoniaGen({ read: async (tx, tz) => { const r = await fetch(`${self.location.origin}/world/leonia/t_${tx}_${tz}.bin`); return r.ok ? new Uint8Array(await r.arrayBuffer()) : null; } }, 12)
  : null; // 12 resident tiles (~26 MB) per worker: a streaming radius spans at most 3×3 tiles plus the move direction
const gen = leonia ?? getWorldGen(PALMARA);
// generous padding so block light from neighbouring chunks spills across borders
const P = CHUNK + MESH_PAD * 2;
const region = new Uint8Array(P * P * WORLD_H);
// Leonia tiles load asynchronously: jobs are serialised so the shared region buffer is never reused mid-job
let chain: Promise<void> = Promise.resolve();

self.onmessage = (e: MessageEvent<{ cx: number; cz: number; key: string }>) => {
  if (leonia) { chain = chain.then(() => leonia.prepare(e.data.cx * CHUNK - MESH_PAD, e.data.cz * CHUNK - MESH_PAD, P, P)).catch((err) => console.warn('leonia tile load failed', err)).then(() => job(e.data)); return; }
  job(e.data);
};

function job({ cx, cz, key }: { cx: number; cz: number; key: string }) {
  gen.generateRegion(cx * CHUNK - MESH_PAD, cz * CHUNK - MESH_PAD, P, P, region);
  const mesh = meshChunk(region, MESH_PAD, cx * CHUNK, cz * CHUNK);
  // inner voxels for client-side collision / prediction, cut above the column's top block
  // (Leonia columns are 256 high but mostly < 40 blocks tall; getBlock treats the rest as air)
  const H = Math.min(WORLD_H, mesh.maxY + 1);
  const vox = new Uint8Array(CHUNK * CHUNK * H);
  for (let y = 0; y < H; y++) for (let z = 0; z < CHUNK; z++) {
    const src = (z + MESH_PAD) * P + MESH_PAD + y * P * P;
    vox.set(region.subarray(src, src + CHUNK), z * CHUNK + y * CHUNK * CHUNK);
  }
  const transfer: Transferable[] = [vox.buffer];
  for (const b of [mesh.opaque, mesh.cutout, mesh.translucent, mesh.water]) transfer.push(b.pos.buffer, b.nrm.buffer, b.uv.buffer, b.light.buffer, b.extra.buffer, b.tile.buffer, b.idx.buffer);
  (self as unknown as Worker).postMessage({ key, cx, cz, mesh, vox }, transfer);
}

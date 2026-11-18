/**
 * Chunk streaming: requests chunks around the camera from a worker pool, builds GPU
 * meshes, unloads far chunks, and exposes the voxel data for client prediction.
 *
 * Scheduling: the queue is ordered by distance with a bonus for chunks in front of the camera
 * (re-sorted when the camera crosses a chunk or turns), workers are refilled straight from their
 * result messages (not once per frame, so slow frames do not throttle streaming), and each worker
 * keeps up to IN_FLIGHT jobs queued. A loaded-chunk mask (128² toroidal texture) lets the far-city
 * LOD fill holes where voxels are not streamed in yet.
 */
import * as THREE from 'three';
import { CHUNK, WORLD_H, WORLD, B, SOLID, type VoxelQuery } from '@blockshore/shared';
import type { ChunkMesh, MeshArrays } from './mesher';

interface Loaded { group: THREE.Group; vox: Uint8Array; tris: number; bytes: number }
interface Job { key: string; cx: number; cz: number; d: number }

const IN_FLIGHT = 3;
/** loaded-chunk mask size (chunks, toroidal) */
export const CHUNK_MASK = 128;

export class ChunkManager implements VoxelQuery {
  readonly root = new THREE.Group();
  private loaded = new Map<string, Loaded>();
  private pending = new Set<string>();
  private workers: Worker[] = [];
  private busy: number[] = [];
  private queue: Job[] = [];
  radius = 8;
  triangles = 0;
  /** GPU bytes of the loaded chunk meshes */
  bytes = 0;
  /** chunks generated per second (for the perf overlay) */
  rate = 0;
  /** total chunks meshed since start */
  total = 0;
  private genCount = 0; private rateAt = performance.now();
  private lastCenter = '';
  private lastSort = 0;
  private center = { cx: 0, cz: 0 };
  private view = new THREE.Vector2(0, -1);
  private sortedView = new THREE.Vector2(0, -1);
  /** R8 mask of loaded chunks (texel = chunk mod CHUNK_MASK), read by the LOD shader */
  readonly mask: THREE.DataTexture;
  private maskData = new Uint8Array(CHUNK_MASK * CHUNK_MASK);
  private maskDirty = false;

  /** layer for water + translucent meshes (rendered in a second pass by the HDR pipeline) */
  static readonly LAYER_TRANSLUCENT = 1;

  constructor(private mats: { opaque: THREE.Material; cutout: THREE.Material; translucent: THREE.Material; water: THREE.Material; cutoutDepth?: THREE.Material },
    workerCount = Math.min(6, Math.max(1, (navigator.hardwareConcurrency || 4) - 2))) {
    for (let i = 0; i < workerCount; i++) {
      // the worker name carries the world selection (Vite needs static worker options, hence two literals)
      const w = WORLD === 'leonia'
        ? new Worker(new URL('./chunkWorker.ts', import.meta.url), { type: 'module', name: 'chunks world=leonia' })
        : new Worker(new URL('./chunkWorker.ts', import.meta.url), { type: 'module', name: 'chunks world=palmara' });
      w.onmessage = (e) => this.onChunk(i, e.data);
      this.workers.push(w);
      this.busy.push(0);
    }
    this.mask = new THREE.DataTexture(this.maskData, CHUNK_MASK, CHUNK_MASK, THREE.RedFormat, THREE.UnsignedByteType);
    this.mask.magFilter = this.mask.minFilter = THREE.NearestFilter;
    this.mask.needsUpdate = true;
  }

  get loadedCount() { return this.loaded.size; }
  get pendingCount() { return this.pending.size + this.queue.length; }
  get workerCount() { return this.workers.length; }

  isLoaded(x: number, z: number) {
    return this.loaded.has(`${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`);
  }

  /** fraction of chunks within `r` chunks of (x,z) that are loaded */
  readiness(x: number, z: number, r = 2) {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    let n = 0, ok = 0;
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) { n++; if (this.loaded.has(`${cx + dx},${cz + dz}`)) ok++; }
    return ok / n;
  }

  getBlock(x: number, y: number, z: number): number {
    if (y < 0) return B.STONE;
    if (y >= WORLD_H) return B.AIR;
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const c = this.loaded.get(`${cx},${cz}`);
    if (!c) return y <= 21 ? B.STONE : B.AIR; // unloaded: assume flat ground so prediction never falls through
    const lx = x - cx * CHUNK, lz = z - cz * CHUNK;
    // vox stops at the column's top block (see chunkWorker): above it is air
    return c.vox[lx + lz * CHUNK + y * CHUNK * CHUNK] ?? B.AIR;
  }

  /** id of the block scanColumn() found */
  scanId = 0;
  /**
   * Weather helper: walk one column from y0 towards y1 (either direction) and return the y of the first solid or
   * water block (id left in scanId), or -1. Resolves the chunk once, so it allocates nothing.
   */
  scanColumn(x: number, z: number, y0: number, y1: number): number {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    const c = this.loaded.get(cx + ',' + cz);
    if (!c) return -1;
    const lx = Math.floor(x) - cx * CHUNK, lz = Math.floor(z) - cz * CHUNK;
    const step = y1 >= y0 ? 1 : -1;
    const top = Math.min(WORLD_H - 1, Math.max(y0, y1)), bot = Math.max(0, Math.min(y0, y1));
    for (let y = step < 0 ? top : bot; step < 0 ? y >= bot : y <= top; y += step) {
      const id = c.vox[lx + lz * CHUNK + y * CHUNK * CHUNK] ?? 0;
      if (id !== 0 && (id === B.WATER || SOLID[id] === 1)) { this.scanId = id; return y; }
    }
    return -1;
  }

  private setMask(cx: number, cz: number, on: boolean) {
    const m = CHUNK_MASK;
    this.maskData[(((cz % m) + m) % m) * m + (((cx % m) + m) % m)] = on ? 255 : 0;
    this.maskDirty = true;
  }

  /** priority: squared distance, shrunk for chunks ahead of the camera (view = horizontal forward) */
  private prio(dx: number, dz: number) {
    const d2 = dx * dx + dz * dz;
    if (d2 <= 4) return d2;
    const inv = 1 / Math.sqrt(d2);
    const ahead = (dx * this.view.x + dz * this.view.y) * inv; // -1..1
    return d2 * (1.35 - 0.65 * Math.max(-0.4, ahead));
  }

  private rebuildQueue() {
    const { cx, cz } = this.center;
    const R = this.radius;
    this.queue = [];
    for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
      if (dx * dx + dz * dz > R * R + 1) continue;
      const k = `${cx + dx},${cz + dz}`;
      if (this.loaded.has(k) || this.pending.has(k)) continue;
      this.queue.push({ key: k, cx: cx + dx, cz: cz + dz, d: this.prio(dx, dz) });
    }
    this.queue.sort((a, b) => b.d - a.d); // pop() takes the most urgent
    this.sortedView.copy(this.view);
  }

  /** focus = streaming centre; dir = camera forward (optional, biases the order toward the view) */
  update(focus: THREE.Vector3, dir?: THREE.Vector3) {
    const cx = Math.floor(focus.x / CHUNK), cz = Math.floor(focus.z / CHUNK);
    if (dir) { const l = Math.hypot(dir.x, dir.z); if (l > 1e-3) this.view.set(dir.x / l, dir.z / l); }
    const key = `${cx},${cz},${this.radius}`;
    const now = performance.now();
    if (key !== this.lastCenter) {
      this.lastCenter = key;
      this.center = { cx, cz };
      this.rebuildQueue();
      this.lastSort = now;
      // unload far
      const U = (this.radius + 2) * (this.radius + 2);
      for (const [k, c] of this.loaded) {
        const i = k.indexOf(',');
        const x = +k.slice(0, i), z = +k.slice(i + 1);
        if ((x - cx) ** 2 + (z - cz) ** 2 > U) {
          this.root.remove(c.group);
          c.group.traverse((o) => { if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose(); });
          this.triangles -= c.tris;
          this.bytes -= c.bytes;
          this.loaded.delete(k);
          this.setMask(x, z, false);
        }
      }
    } else if (this.queue.length > 8 && now - this.lastSort > 250 && this.view.dot(this.sortedView) < 0.97) {
      this.rebuildQueue();
      this.lastSort = now;
    }
    this.pump();
    if (this.maskDirty) { this.mask.needsUpdate = true; this.maskDirty = false; }
    if (now - this.rateAt > 1000) { this.rate = this.genCount * 1000 / (now - this.rateAt); this.genCount = 0; this.rateAt = now; }
  }

  private pump() {
    for (let i = 0; i < this.workers.length; i++) {
      while (this.busy[i] < IN_FLIGHT && this.queue.length) {
        const job = this.queue.pop()!;
        if (this.loaded.has(job.key) || this.pending.has(job.key)) continue;
        this.pending.add(job.key);
        this.busy[i]++;
        this.workers[i].postMessage(job);
      }
    }
  }

  private onChunk(worker: number, data: { key: string; cx: number; cz: number; mesh: ChunkMesh; vox: Uint8Array }) {
    this.busy[worker]--;
    this.pending.delete(data.key);
    this.genCount++; this.total++;
    // keep the worker fed without waiting for the next frame
    this.pump();
    // a chunk that left the streaming radius while in flight is dropped
    const { cx, cz } = this.center;
    const R = this.radius + 2;
    if ((data.cx - cx) ** 2 + (data.cz - cz) ** 2 > R * R) return;
    const group = new THREE.Group();
    group.position.set(data.cx * CHUNK, 0, data.cz * CHUNK);
    let tris = 0, bytes = 0;
    const add = (a: MeshArrays, mat: THREE.Material, order = 0, kind: 'solid' | 'cutout' | 'clear' = 'solid') => {
      if (!a.idx.length) return;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(a.pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(a.nrm, 3, true));
      g.setAttribute('uv', new THREE.BufferAttribute(a.uv, 2));
      g.setAttribute('light', new THREE.BufferAttribute(a.light, 2, true));
      g.setAttribute('extra', new THREE.BufferAttribute(a.extra, 4, true));
      g.setAttribute('tile', new THREE.BufferAttribute(a.tile, 2));
      g.setIndex(new THREE.BufferAttribute(a.idx, 1));
      g.boundingBox = new THREE.Box3(new THREE.Vector3(0, data.mesh.minY ?? 0, 0), new THREE.Vector3(CHUNK, data.mesh.maxY + 1, CHUNK));
      g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
      const m = new THREE.Mesh(g, mat);
      m.renderOrder = order;
      m.matrixAutoUpdate = false;
      m.receiveShadow = true;
      if (kind === 'clear') m.layers.set(ChunkManager.LAYER_TRANSLUCENT);
      else m.castShadow = true;
      if (kind === 'cutout' && this.mats.cutoutDepth) m.customDepthMaterial = this.mats.cutoutDepth;
      group.add(m);
      tris += a.idx.length / 3;
      bytes += a.pos.byteLength + a.nrm.byteLength + a.uv.byteLength + a.light.byteLength + a.extra.byteLength + a.tile.byteLength + a.idx.byteLength;
    };
    add(data.mesh.opaque, this.mats.opaque);
    add(data.mesh.cutout, this.mats.cutout, 0, 'cutout');
    add(data.mesh.water, this.mats.water, 2, 'clear');
    add(data.mesh.translucent, this.mats.translucent, 3, 'clear');
    group.updateMatrixWorld(true);
    group.children.forEach((c) => { c.matrixAutoUpdate = false; c.updateMatrix(); c.matrixWorld.copy(group.matrixWorld); });
    const old = this.loaded.get(data.key);
    if (old) { this.root.remove(old.group); old.group.traverse((o) => { if ((o as THREE.Mesh).geometry) (o as THREE.Mesh).geometry.dispose(); }); this.triangles -= old.tris; this.bytes -= old.bytes; }
    this.root.add(group);
    this.loaded.set(data.key, { group, vox: data.vox, tris, bytes });
    this.triangles += tris;
    this.bytes += bytes;
    this.setMask(data.cx, data.cz, true);
  }

  dispose() { this.workers.forEach((w) => w.terminate()); this.mask.dispose(); }
}

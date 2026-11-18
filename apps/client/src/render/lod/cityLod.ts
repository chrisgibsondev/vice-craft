/**
 * Far-city LOD for Leonia: the skyline stays visible for kilometres beyond the voxel radius.
 *
 * Per 512 m tile, a worker (lodWorker.ts) builds straight from the tile data
 *   - one merged mesh of extruded building footprints (1 draw call per tile, frustum culled),
 *     three detail levels by distance (all → drop small low-rise → landmarks/tall only)
 *   - a 128² ground texture (land use, roads, roofs, water depth, street-light mask) stored in
 *     one texture array; all ground tiles are a single instanced draw, plus one ocean quad.
 *
 * The LOD is drawn in its own pass before the voxel world (renderer.ts / fx/post.ts) with a
 * camera whose near plane sits far out, then the depth buffer is cleared, so LOD and voxels can
 * never z-fight. Voxel chunks dither out across fogNear..fogFar (block/water shaders); the LOD
 * hides itself where voxel chunks are loaded inside fogNear (chunk mask texture) and fills the
 * holes where they are not streamed in yet. Both use the same bsAtmos aerial perspective, and the
 * final dissolve into the sky happens near `lodFar`. At night, walls get window speckle (lit
 * fraction rises after dusk, averaged to a glow once windows get smaller than a few pixels) and
 * streets a sodium glow from the ground texture's light mask.
 */
import * as THREE from 'three';
import { BLOCKS, TILE_INDEX, LEONIA, TILE } from '@blockshore/shared';
import { ATMOS_PARS } from '../fx/atmosphere';
import type { LightingUniforms } from '../materials';
import { CHUNK_MASK } from '../chunks';
import { GROUND_PX } from './lodShared';
import type { LodMesh } from './lodBuild';

export interface LodSettings {
  /** LOD range in metres (0 = off) */
  far: number;
  /** below this distance every building is drawn, then small low-rise ones are dropped */
  full: number;
  /** beyond this only tall buildings / landmarks */
  mid: number;
  /** night window speckle (else a flat glow) */
  windows: boolean;
}

interface TileRec {
  tx: number; tz: number; key: number;
  level: number; want: number; loading: boolean; empty: boolean;
  mesh: THREE.Mesh | null; layer: number; gset: number; dist: number; tris: number; bytes: number;
}

/** average sRGB colour per block (top, side) from the albedo texture array, 6 bytes per block */
export function blockColours(albedo: THREE.DataArrayTexture): Uint8Array {
  const out = new Uint8Array(256 * 6);
  const img = albedo.image as unknown as { data: Uint8Array; width: number; height: number };
  const S = img.width, layerBytes = S * S * 4;
  const avg = (layer: number, o: number) => {
    let r = 0, g = 0, b = 0, n = 0;
    const base = layer * layerBytes;
    for (let y = 0; y < S; y += 4) for (let x = 0; x < S; x += 4) {
      const i = base + (y * S + x) * 4;
      if (img.data[i + 3] < 128) continue;
      r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
    }
    if (n) { out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; } else { out[o] = 128; out[o + 1] = 128; out[o + 2] = 128; }
  };
  for (const b of BLOCKS) {
    if (b.id > 255) continue;
    avg(TILE_INDEX[b.tiles[0]] ?? 0, b.id * 6);
    avg(TILE_INDEX[b.tiles[1]] ?? 0, b.id * 6 + 3);
  }
  return out;
}

const COMMON = /* glsl */ `
  uniform sampler2D chunkMask;
  float bsNightK() { return smoothstep(0.12, 0.8, night); }
  // inside fogNear the voxel chunks own the picture wherever they are loaded
  bool bsLodHidden(vec3 wp) {
    if (length(wp.xz - camPos.xz) >= fogNear) return false;
    ivec2 c = ivec2(floor(wp.xz / 16.0));
    ivec2 m = ((c % ${CHUNK_MASK}) + ${CHUNK_MASK}) % ${CHUNK_MASK};
    return texelFetch(chunkMask, m, 0).r > 0.5;
  }
  float bsH21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
`;

const bldVert = /* glsl */ `
  attribute vec4 col;
  varying vec3 vWorld; varying vec3 vN; varying vec4 vCol;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz; vN = normal; vCol = col;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const bldFrag = /* glsl */ `
  uniform vec3 sunDir; uniform vec3 ambSky; uniform vec3 ambGround; uniform float windowsOn;
  varying vec3 vWorld; varying vec3 vN; varying vec4 vCol;
  ${ATMOS_PARS}
  ${COMMON}
  void main() {
    if (bsLodHidden(vWorld)) discard;
    vec3 n = normalize(vN);
    vec3 alb = pow(vCol.rgb, vec3(2.2));
    // per-block tone variation (1 m cells) so the far buildings carry the same grain as the voxel walls they replace
    {
      vec2 bq = abs(n.y) > 0.5 ? vWorld.xz : vec2(dot(vWorld.xz, vec2(-n.z, n.x)), vWorld.y);
      float fwq = max(fwidth(bq.x), fwidth(bq.y));
      float grain = (bsH21(floor(bq) + vec2(floor(vWorld.y * 0.0), 3.7)) - 0.5) * 0.16;
      alb *= 1.0 + grain * (1.0 - smoothstep(0.35, 1.2, fwq));
    }
    float code = floor(vCol.a * 255.0 + 0.5);
    float win = floor(code / 32.0);
    float seed = code - win * 32.0;
    float h = vWorld.y - 22.0;
    float ndl = max(dot(n, sunDir), 0.0);
    vec3 hemi = mix(ambGround, ambSky, n.y * 0.5 + 0.5);
    float ao = mix(0.6, 1.0, smoothstep(0.0, 9.0, h));
    float nk = bsNightK();
    // facades read darker at night than the moonlit ground (no bounce light from lit streets reaches up)
    vec3 col = alb * (hemi * ao + sunColor * ndl * 0.95) * (1.0 - 0.45 * nk);
    if (win > 0.5 && abs(n.y) < 0.5) {
      vec2 t = vec2(-n.z, n.x);
      float a = dot(vWorld.xz, t);
      float fh = win > 2.5 ? (win > 3.5 ? 5.0 : 3.0) : 3.4;
      float ww = win < 1.5 ? 1.9 : (win > 3.5 ? 6.0 : 2.6);
      vec2 g = vec2(a / ww, h / fh);
      vec2 cell = floor(g), f = fract(g);
      vec2 fw = fwidth(g);
      float mask = win < 1.5 ? step(0.1, f.y) * step(f.y, 0.9)
        : step(0.2, f.x) * step(f.x, 0.8) * step(0.28, f.y) * step(f.y, 0.78);
      float area = win < 1.5 ? 0.55 : 0.6 * 0.5;
      float aa = smoothstep(0.3, 0.85, max(fw.x, fw.y));
      float gm = mix(mask, area, aa);
      // daylight: curtain glass reflects the sky, punched windows read darker
      vec3 V = normalize(camPos - vWorld);
      float fres = pow(1.0 - max(dot(n, V), 0.0), 4.0);
      vec3 R = reflect(-V, n);
      vec3 env = bsSky(normalize(vec3(R.x, abs(R.y) * 0.8 + 0.03, R.z)));
      float k = win < 1.5 ? 0.3 + 0.55 * fres : gm * (0.2 + 0.5 * fres);
      col = mix(col, env * (1.0 - 0.8 * nk) * 0.9, k * (1.0 - nk * 0.5));
      if (win > 1.5) col *= 1.0 - gm * 0.35;
      // night: lit windows (per-window hash; averaged once windows shrink below a few pixels)
      float litFrac = (win > 3.5 ? 0.06 : win > 2.5 ? 0.28 : win < 1.5 ? 0.22 : 0.3) * nk;
      float rnd = bsH21(cell + vec2(seed * 7.13, seed * 3.7) + floor(n.xz * 3.0) * 13.0);
      float lit = step(rnd, litFrac);
      float em = mask * lit;
      if (aa > 0.0) {
        // sub-pixel windows: light whole world-space blocks of 2^n windows (about a pixel each) with the
        // same probability; each carries the block's window area, so the average matches but the
        // skyline keeps its sparkle instead of turning into a uniform glow
        float sz = exp2(max(0.0, ceil(log2(max(fw.x, fw.y) * 1.25))));
        vec2 c2 = floor(g / sz);
        float r2 = bsH21(c2 + vec2(seed * 5.31, seed * 1.9) + floor(n.xz * 3.0) * 17.0);
        em = mix(em, step(r2, litFrac) * area, aa);
        rnd = mix(rnd, r2, aa);
      }
      vec3 wc = mix(vec3(1.0, 0.74, 0.45), vec3(0.72, 0.86, 1.0), step(0.62, fract(rnd * 9.7)));
      if (windowsOn < 0.5) em = area * litFrac * 0.5;
      col += wc * em * 1.7 * nk;
    }
    // aviation-red roof edges are too small to see; give tall roofs a faint night glow instead
    if (n.y > 0.5 && h > 90.0) col += vec3(0.9, 0.2, 0.15) * 0.08 * nk;
    col = bsAtmos(col, vWorld);
    gl_FragColor = vec4(col, 1.0 - rayMask);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const groundVert = /* glsl */ `
  attribute vec3 inst;
  varying vec3 vWorld; varying vec2 vUv; flat varying float vLayer;
  void main() {
    vec3 wp = vec3(inst.x + position.x, 22.0, inst.y + position.z);
    vUv = position.xz / ${TILE}.0;
    vLayer = inst.z;
    vWorld = wp;
    gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
  }
`;
const oceanVert = /* glsl */ `
  varying vec3 vWorld; varying vec2 vUv; flat varying float vLayer;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz; vUv = vec2(0.0); vLayer = -1.0;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const groundFrag = /* glsl */ `
  precision highp sampler2DArray;
  uniform sampler2DArray groundTex;
  uniform vec3 sunDir; uniform vec3 ambSky; uniform float time;
  varying vec3 vWorld; varying vec2 vUv; flat varying float vLayer;
  ${ATMOS_PARS}
  ${COMMON}
  void main() {
    if (bsLodHidden(vWorld)) discard;
    vec4 g = vLayer < 0.0 ? vec4(0.0037, 0.045, 0.141, 1.0) : texture(groundTex, vec3(vUv, vLayer));
    float water = smoothstep(0.7, 0.95, g.a);
    float glow = min(g.a, 0.5) * 2.0 * (1.0 - water);
    vec3 alb = g.rgb;
    float sunUp = max(sunDir.y, 0.0);
    vec3 col = alb * (ambSky * 1.05 + sunColor * sunUp * 0.95);
    // tree canopy / lot texture: low-frequency darkening on green land
    float green = smoothstep(0.02, 0.08, alb.g - max(alb.r, alb.b));
    col *= 1.0 - green * 0.25 * bsH21(floor(vWorld.xz / 6.0));
    if (water > 0.0) {
      vec3 V = normalize(camPos - vWorld);
      float fres = 0.05 + 0.95 * pow(1.0 - max(V.y, 0.0), 5.0);
      // gentle wave normal so the far bay is not a mirror
      vec2 q = vWorld.xz * 0.05 + time * vec2(0.08, 0.05);
      vec3 n = normalize(vec3(sin(q.x * 3.1 + q.y) * 0.04, 1.0, cos(q.y * 2.7 - q.x) * 0.04));
      vec3 R = reflect(-V, n);
      vec3 refl = bsSky(normalize(vec3(R.x, max(R.y, 0.03), R.z)));
      vec3 wcol = alb * (ambSky * 1.1 + sunColor * 0.45);
      vec3 H = normalize(sunDir + V);
      float gl = pow(max(dot(n, H), 0.0), 260.0) * 6.0 * step(0.0, sunDir.y);
      col = mix(col, mix(wcol, refl, fres) + sunColor * gl, water);
    }
    col += vec3(1.0, 0.58, 0.26) * glow * bsNightK() * 0.7;
    col = bsAtmos(col, vWorld);
    gl_FragColor = vec4(col, 1.0 - rayMask);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

/** one ground texture array (all its tiles are a single instanced draw) */
class GroundSet {
  readonly tex: THREE.DataArrayTexture;
  readonly data: Uint8Array;
  readonly free: number[] = [];
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private inst: THREE.InstancedBufferAttribute;
  dirty = true;
  constructor(readonly px: number, readonly cap: number, mat: THREE.ShaderMaterial) {
    this.data = new Uint8Array(px * px * 4 * cap);
    const gt = this.tex = new THREE.DataArrayTexture(this.data, px, px, cap);
    gt.format = THREE.RGBAFormat; gt.type = THREE.UnsignedByteType; gt.colorSpace = THREE.SRGBColorSpace;
    gt.wrapS = gt.wrapT = THREE.ClampToEdgeWrapping;
    gt.magFilter = THREE.LinearFilter; gt.minFilter = THREE.LinearMipmapLinearFilter;
    gt.generateMipmaps = true; gt.anisotropy = 4; gt.needsUpdate = true;
    for (let i = cap - 1; i >= 0; i--) this.free.push(i);
    const q = new THREE.BufferGeometry();
    q.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, TILE, 0, 0, TILE, 0, TILE, 0, 0, TILE], 3));
    q.setIndex([0, 3, 2, 0, 2, 1]);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = q.index;
    this.geo.setAttribute('position', q.getAttribute('position'));
    this.inst = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    this.inst.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('inst', this.inst);
    this.geo.instanceCount = 0;
    const m = new THREE.ShaderMaterial({ uniforms: { ...mat.uniforms, groundTex: { value: gt } }, vertexShader: mat.vertexShader, fragmentShader: mat.fragmentShader });
    this.mesh = new THREE.Mesh(this.geo, m);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }
  upload(layer: number, src: Uint8Array) {
    this.data.set(src, layer * this.px * this.px * 4);
    this.tex.addLayerUpdate(layer);
    this.tex.needsUpdate = true;
    this.dirty = true;
  }
  rebuild(tiles: Iterable<TileRec>, set: number) {
    this.dirty = false;
    const a = this.inst.array as Float32Array;
    let n = 0;
    for (const t of tiles) {
      if (t.gset !== set || t.layer < 0) continue;
      a[n * 3] = t.tx * TILE; a[n * 3 + 1] = t.tz * TILE; a[n * 3 + 2] = t.layer; n++;
    }
    this.geo.instanceCount = n;
    this.inst.needsUpdate = true;
  }
  get bytes() { return this.data.byteLength * 4 / 3; }
  dispose() { this.tex.dispose(); this.geo.dispose(); (this.mesh.material as THREE.Material).dispose(); }
}

export class CityLod {
  /** rendered in the far pass (renderer adds the sky dome + far clouds next to it) */
  readonly root = new THREE.Group();
  readonly settings: LodSettings = { far: 7000, full: 1400, mid: 2800, windows: true };
  private tiles = new Map<number, TileRec>();
  private workers: Worker[] = [];
  private inflight: number[] = [];
  private bldMat: THREE.ShaderMaterial;
  /** ground arrays: 0 = 128 px tiles (levels 0–1), 1 = 64 px tiles (level 2, far) */
  private sets: GroundSet[];
  private ocean: THREE.Mesh;
  private lastPlan = -1e9;
  private planAt = new THREE.Vector2(1e9, 1e9);
  /** stats */
  triangles = 0; bytes = 0; tileCount = 0; built = 0;

  constructor(private L: LightingUniforms, chunkMask: THREE.Texture, albedo: THREE.DataArrayTexture, initial: Partial<LodSettings> = {}, workers = 2) {
    Object.assign(this.settings, initial);
    const colours = blockColours(albedo);
    const ids: Record<string, number> = {};
    for (const b of BLOCKS) ids[b.name] = b.id;
    for (let i = 0; i < workers; i++) {
      const w = new Worker(new URL('./lodWorker.ts', import.meta.url), { type: 'module', name: 'lod world=leonia' });
      w.postMessage({ type: 'init', colours, ids });
      w.onmessage = (e) => this.onTile(i, e.data);
      this.workers.push(w); this.inflight.push(0);
    }
    const common = { ...L, chunkMask: { value: chunkMask } } as Record<string, THREE.IUniform>;
    this.bldMat = new THREE.ShaderMaterial({ uniforms: { ...common, windowsOn: { value: 1 } }, vertexShader: bldVert, fragmentShader: bldFrag });
    // texture-array capacity from the area each detail ring covers (tiles touched by a disc)
    const disc = (r: number) => Math.ceil(Math.PI * (r + 760) ** 2 / (TILE * TILE) * 1.12);
    const s = this.settings;
    const nearCap = Math.min(400, disc(s.mid));
    const farCap = Math.min(1400, Math.max(32, disc(s.far) - Math.floor(disc(s.mid) * 0.7)));
    const groundMat = new THREE.ShaderMaterial({ uniforms: { ...common, groundTex: { value: null } }, vertexShader: groundVert, fragmentShader: groundFrag });
    this.sets = [new GroundSet(GROUND_PX, nearCap, groundMat), new GroundSet(GROUND_PX / 2, farCap, groundMat)];
    // open sea everywhere the tiles do not cover (drawn first, no depth write: tiles always win)
    const oceanMat = new THREE.ShaderMaterial({ uniforms: { ...common, groundTex: { value: this.sets[0].tex } }, vertexShader: oceanVert, fragmentShader: groundFrag, depthWrite: false });
    const og = new THREE.PlaneGeometry(2, 2); og.rotateX(-Math.PI / 2);
    this.ocean = new THREE.Mesh(og, oceanMat);
    this.ocean.frustumCulled = false;
    this.ocean.renderOrder = 0;
    this.root.add(this.ocean, this.sets[0].mesh, this.sets[1].mesh);
  }

  configure(s: Partial<LodSettings>) {
    Object.assign(this.settings, s);
    this.bldMat.uniforms.windowsOn.value = this.settings.windows ? 1 : 0;
    this.lastPlan = -1e9;
  }

  private levelFor(d: number) { return d < this.settings.full ? 0 : d < this.settings.mid ? 1 : 2; }

  update(cam: THREE.Vector3) {
    const far = this.settings.far;
    this.root.visible = far > 0;
    if (far <= 0) return;
    this.ocean.position.set(cam.x, 21.0, cam.z);
    this.ocean.scale.set(far * 1.05, 1, far * 1.05);
    this.ocean.updateMatrixWorld();
    const now = performance.now();
    if (now - this.lastPlan > 400 || this.planAt.distanceTo(_v2.set(cam.x, cam.z)) > 96) this.plan(cam, now);
    this.pump();
    for (let i = 0; i < 2; i++) if (this.sets[i].dirty) this.sets[i].rebuild(this.tiles.values(), i);
  }

  private plan(cam: THREE.Vector3, now: number) {
    this.lastPlan = now;
    this.planAt.set(cam.x, cam.z);
    const far = this.settings.far;
    const t0x = Math.max(0, Math.floor((cam.x - far) / TILE)), t1x = Math.min(Math.ceil(LEONIA.width / TILE) - 1, Math.floor((cam.x + far) / TILE));
    const t0z = Math.max(0, Math.floor((cam.z - far) / TILE)), t1z = Math.min(Math.ceil(LEONIA.depth / TILE) - 1, Math.floor((cam.z + far) / TILE));
    const seen = new Set<number>();
    for (let tz = t0z; tz <= t1z; tz++) for (let tx = t0x; tx <= t1x; tx++) {
      const d = tileDist(tx, tz, cam);
      if (d > far) continue;
      const key = tz * 1024 + tx;
      seen.add(key);
      let t = this.tiles.get(key);
      if (!t) { t = { tx, tz, key, level: -1, want: 0, loading: false, empty: false, mesh: null, layer: -1, gset: -1, dist: d, tris: 0, bytes: 0 }; this.tiles.set(key, t); }
      t.dist = d;
      // hysteresis: keep the current level while the distance is within 120 m of its band
      const lv = this.levelFor(d);
      const lvIn = this.levelFor(Math.max(0, d - 120)), lvOut = this.levelFor(d + 120);
      t.want = t.level >= lvIn && t.level <= lvOut ? t.level : lv;
    }
    for (const [k, t] of this.tiles) {
      if (seen.has(k)) continue;
      t.dist = tileDist(t.tx, t.tz, cam);
      if (t.dist < far + 300) continue;
      this.drop(t);
      this.tiles.delete(k);
    }
  }

  private freeGround(t: TileRec) {
    if (t.layer >= 0 && t.gset >= 0) { this.sets[t.gset].free.push(t.layer); this.sets[t.gset].dirty = true; }
    t.layer = -1; t.gset = -1;
  }

  private drop(t: TileRec) {
    if (t.mesh) { this.root.remove(t.mesh); t.mesh.geometry.dispose(); this.triangles -= t.tris; this.bytes -= t.bytes; t.mesh = null; this.tileCount--; }
    this.freeGround(t);
  }

  private pump() {
    const todo: TileRec[] = [];
    for (const t of this.tiles.values()) if (!t.loading && !t.empty && t.want !== t.level) todo.push(t);
    if (!todo.length) return;
    // tiles with nothing yet before re-levels, nearest first
    todo.sort((a, b) => ((a.level < 0 ? 0 : 1) - (b.level < 0 ? 0 : 1)) || a.dist - b.dist);
    let k = 0;
    for (let i = 0; i < this.workers.length && k < todo.length; i++) {
      while (this.inflight[i] < 2 && k < todo.length) {
        const t = todo[k++];
        t.loading = true;
        this.inflight[i]++;
        const set = t.want >= 2 ? 1 : 0;
        this.workers[i].postMessage({ type: 'tile', tx: t.tx, tz: t.tz, level: t.want, ground: t.gset !== set || t.layer < 0 ? this.sets[set].px : 0 });
      }
    }
  }

  private onTile(w: number, m: { tx: number; tz: number; level: number; empty?: boolean; mesh?: LodMesh; ground?: Uint8Array | null; groundPx?: number }) {
    this.inflight[w]--;
    const t = this.tiles.get(m.tz * 1024 + m.tx);
    this.pump();
    if (!t) return;
    t.loading = false;
    if (m.empty) { t.empty = true; t.level = t.want; return; }
    this.built++;
    if (m.ground && m.groundPx) {
      const set = m.groundPx === this.sets[0].px ? 0 : 1;
      const gs = this.sets[set];
      const layer = gs.free.pop();
      if (layer !== undefined) {
        this.freeGround(t);
        t.layer = layer; t.gset = set;
        gs.upload(layer, m.ground);
      }
    }
    if (t.mesh) { this.root.remove(t.mesh); t.mesh.geometry.dispose(); this.triangles -= t.tris; this.bytes -= t.bytes; t.mesh = null; this.tileCount--; }
    const me = m.mesh!;
    t.level = m.level;
    if (me.idx.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(me.pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(me.nrm, 3, true));
      g.setAttribute('col', new THREE.BufferAttribute(me.col, 4, true));
      g.setIndex(new THREE.BufferAttribute(me.idx, 1));
      g.boundingBox = new THREE.Box3(new THREE.Vector3(-64, 21, -64), new THREE.Vector3(TILE + 64, me.maxY + 1, TILE + 64));
      g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
      const mesh = new THREE.Mesh(g, this.bldMat);
      mesh.position.set(t.tx * TILE, 0, t.tz * TILE);
      mesh.renderOrder = 2;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix(); mesh.updateMatrixWorld();
      this.root.add(mesh);
      t.mesh = mesh;
      t.tris = me.idx.length / 3;
      t.bytes = me.pos.byteLength + me.nrm.byteLength + me.col.byteLength + me.idx.byteLength;
      this.triangles += t.tris; this.bytes += t.bytes; this.tileCount++;
    }
  }

  get groundBytes() { return this.sets[0].bytes + this.sets[1].bytes; }
  get groundLayers() { return this.sets.map((s) => `${s.cap - s.free.length}/${s.cap}@${s.px}`).join(' '); }

  dispose() {
    this.workers.forEach((w) => w.terminate());
    for (const t of this.tiles.values()) this.drop(t);
    this.sets.forEach((s) => s.dispose()); this.bldMat.dispose();
  }
}

const _v2 = new THREE.Vector2();
function tileDist(tx: number, tz: number, cam: THREE.Vector3) {
  const dx = Math.max(tx * TILE - cam.x, 0, cam.x - (tx + 1) * TILE), dz = Math.max(tz * TILE - cam.z, 0, cam.z - (tz + 1) * TILE);
  return Math.hypot(dx, dz);
}

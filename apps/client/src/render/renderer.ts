/**
 * Top-level renderer: WebGL2 renderer, scene graph, sky/lighting, chunk streaming, sun
 * shadows and the HDR post pipeline (see fx/post.ts), all gated by quality level.
 *
 *   low    – direct render (no post unless bloom is on), no shadows; sway, block light,
 *            sky/fog model and the cheap water shader
 *   medium – + HDR pipeline: refractive depth-coloured water with foam, bloom, colour
 *            grading, 1024² sun shadows, cloud shadows
 *   high   – + 2048² shadows, SSAO, god rays, water SSR, depth-aware FXAA
 *   ultra  – + 4096² shadows over a wider range, 16-tap SSAO, longer SSR, native pixel ratio
 */
import * as THREE from 'three';
import { B, WORLD } from '@blockshore/shared';
import { buildAtlas } from './atlas';
import { applyTexturePack } from './texturePack';
import { configureWorldMaterials, makeBlockMaterial, makeCutoutDepthMaterial, makeLighting, makeWaterMaterial, type LightingUniforms } from './materials';
import { Sky } from './sky';
import { ChunkManager } from './chunks';
import { PostPipeline } from './fx/post';
import { SunShadows } from './fx/shadows';
import { CityLod } from './lod/cityLod';
import { Weather } from './fx/weather';
import { getState } from '../state/store';

export type QualityLevel = 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  renderDistance: number; // chunks
  bloom: boolean;
  pixelRatio: number;
  fov: number;
  /** preset this came from; when missing (older callers) it is taken from the saved settings */
  level?: QualityLevel;
  /** HDR pipeline with refractive / depth-coloured water, foam and colour grading */
  post?: boolean;
  /** sun shadow map size (0 = off) and the metres it covers around the camera */
  shadowSize?: number;
  shadowRange?: number;
  /** 0 off, 1 normal, 2 high */
  ssao?: number;
  godRays?: boolean;
  /** water screen-space reflection march steps (0 = sky-only reflections) */
  ssrSteps?: number;
  fxaa?: boolean;
  cloudShadows?: boolean;
  /** far-city LOD (Leonia): range in metres (0 = off), full-detail and mid-detail distances, window speckle */
  lodFar?: number;
  lodFull?: number;
  lodMid?: number;
  lodWindows?: boolean;
}

export const QUALITY_PRESETS: Record<QualityLevel, QualitySettings> = {
  low: { level: 'low', renderDistance: 5, bloom: false, pixelRatio: 0.75, fov: 75, post: false, shadowSize: 0, shadowRange: 0, ssao: 0, godRays: false, ssrSteps: 0, fxaa: false, cloudShadows: false, lodFar: 2200, lodFull: 450, lodMid: 1000, lodWindows: false },
  medium: { level: 'medium', renderDistance: 8, bloom: true, pixelRatio: 1, fov: 75, post: true, shadowSize: 1024, shadowRange: 90, ssao: 0, godRays: false, ssrSteps: 0, fxaa: false, cloudShadows: true, lodFar: 4000, lodFull: 900, lodMid: 1800, lodWindows: true },
  high: { level: 'high', renderDistance: 12, bloom: true, pixelRatio: 1, fov: 75, post: true, shadowSize: 2048, shadowRange: 150, ssao: 1, godRays: true, ssrSteps: 20, fxaa: true, cloudShadows: true, lodFar: 7000, lodFull: 1300, lodMid: 2600, lodWindows: true },
  ultra: { level: 'ultra', renderDistance: 14, bloom: true, pixelRatio: Math.min(2, window.devicePixelRatio || 1), fov: 75, post: true, shadowSize: 4096, shadowRange: 220, ssao: 2, godRays: true, ssrSteps: 36, fxaa: true, cloudShadows: true, lodFar: 9500, lodFull: 1800, lodMid: 3400, lodWindows: true },
};

function resolveQuality(q: QualitySettings): Required<QualitySettings> {
  let level = q.level;
  if (!level) {
    try { level = getState().settings.quality; } catch { /* store unavailable */ }
  }
  const base = QUALITY_PRESETS[level ?? 'high'] ?? QUALITY_PRESETS.high;
  const out = { ...base } as Required<QualitySettings>;
  for (const [k, v] of Object.entries(q)) if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
  out.level = level ?? 'high';
  return out;
}

export function webglSupport(): { ok: boolean; reason?: string } {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return { ok: false, reason: 'WebGL2 is not available in this browser (or hardware acceleration is turned off).' };
    const workers = typeof Worker !== 'undefined';
    if (!workers) return { ok: false, reason: 'Web Workers are not available.' };
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
}

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly L: LightingUniforms;
  readonly sky: Sky;
  /** weather (server-driven; see fx/weather.ts) */
  readonly wx: Weather;
  readonly chunks: ChunkManager;
  readonly atlas: THREE.Texture;
  private post: PostPipeline | null = null;
  private shadows: SunShadows;
  private mats: { opaque: THREE.ShaderMaterial; cutout: THREE.ShaderMaterial; translucent: THREE.ShaderMaterial; water: THREE.ShaderMaterial };
  quality: QualitySettings;
  private q: Required<QualitySettings>;
  /** far-city LOD (Leonia only) + the far pass it is drawn in (sky dome, far clouds, LOD) */
  readonly lod: CityLod | null = null;
  private farScene: THREE.Scene | null = null;
  private farCam = new THREE.PerspectiveCamera();
  timeOfDay = 0.68;
  private elapsed = 0;

  constructor(readonly canvas: HTMLCanvasElement, quality: QualitySettings) {
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.AgXToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.info.autoReset = false;
    this.camera = new THREE.PerspectiveCamera(quality.fov, 1, 0.1, 2000);
    this.camera.layers.enable(ChunkManager.LAYER_TRANSLUCENT);
    this.L = makeLighting();
    const { texture } = buildAtlas();
    this.atlas = texture;
    // licensed block textures override procedural tiles as soon as they load
    void applyTexturePack(texture).then((n) => { if (n) console.info(`[blockshore] texture pack applied (${n} tiles)`); });
    this.mats = {
      opaque: makeBlockMaterial(this.L, texture, 'opaque'),
      cutout: makeBlockMaterial(this.L, texture, 'cutout'),
      translucent: makeBlockMaterial(this.L, texture, 'translucent'),
      water: makeWaterMaterial(this.L),
    };
    this.mats.water.uniforms.projM.value = this.camera.projectionMatrix;
    this.chunks = new ChunkManager({ ...this.mats, cutoutDepth: makeCutoutDepthMaterial(this.L, texture) });
    this.sky = new Sky(this.L);
    this.wx = new Weather(this.L);
    this.scene.add(this.sky.clouds, this.chunks.root, this.wx.group);
    if (WORLD === 'leonia') {
      const q0 = resolveQuality(quality);
      this.lod = new CityLod(this.L, this.chunks.mask, texture, { far: q0.lodFar, full: q0.lodFull, mid: q0.lodMid, windows: q0.lodWindows });
      this.farScene = new THREE.Scene();
      this.farScene.add(this.sky.mesh, this.sky.cloudsFar, this.lod.root);
      this.sky.haze = 0.28;
    } else this.scene.add(this.sky.mesh);
    // light for regular three.js materials (vehicles, characters, glTF models)
    this.hemi = new THREE.HemisphereLight(0xbfd8ff, 0x6b5a48, 1.2);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.2);
    this.scene.add(this.hemi, this.sun, this.sun.target);
    this.shadows = new SunShadows(this.renderer, this.sun, this.scene, [this.chunks.root, this.sky.mesh, this.sky.clouds]);
    this.q = resolveQuality(quality);
    this.applyQuality(quality);
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }
  readonly hemi: THREE.HemisphereLight;
  readonly sun: THREE.DirectionalLight;

  applyQuality(quality: QualitySettings) {
    this.quality = quality;
    const q = this.q = resolveQuality(quality);
    this.wx.configure(q.level);
    this.chunks.radius = q.renderDistance;
    const far = q.renderDistance * 16;
    this.L.fogNear.value = far * 0.74;
    this.L.fogFar.value = far - 6;
    // far enough for the 3D cloud layer even at short render distances
    this.camera.far = Math.max(far * 1.6 + 200, 900);
    if (this.lod) {
      this.L.lodFar.value = q.lodFar;
      this.lod.configure({ far: q.lodFar, full: q.lodFull, mid: q.lodMid, windows: q.lodWindows });
      this.sky.setSplit(q.lodFar > 0 ? this.L.fogFar.value + 24 : 0, q.lodFar);
    }
    this.camera.fov = q.fov;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(q.pixelRatio);
    const usePost = q.post || q.bloom;
    const hqWater = q.post;
    if (usePost && !this.post) this.post = new PostPipeline(this.renderer);
    else if (!usePost && this.post) { this.post.dispose(); this.post = null; }
    if (this.post) {
      this.post.setFeatures({ hqWater, bloom: q.bloom, ssao: q.post ? q.ssao : 0, godRays: q.post && q.godRays, fxaa: q.post && q.fxaa });
      this.mats.water.uniforms.tScene.value = this.post.sceneCopy;
    }
    configureWorldMaterials(this.mats, { hqWater, ssrSteps: q.ssrSteps, cloudShadows: q.cloudShadows, sway: true, normalMaps: q.level !== 'low' });
    this.shadows.configure(q.shadowSize, q.shadowRange);
    this.resize();
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const db = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.post?.setSize(db.x, db.y);
    (this.mats.water.uniforms.resolution.value as THREE.Vector2).copy(db);
  }

  update(dt: number, focus: THREE.Vector3) {
    this.elapsed += dt;
    const L = this.L;
    L.time.value = this.elapsed;
    L.camPos.value.copy(this.camera.position);
    // weather first (wetness / wind / cover uniforms), then the sky model, then the weather pass over the sky colours
    this.wx.update(dt, this.camera, this.chunks, this.L.ambSky.value, 1 - this.L.night.value);
    this.sky.update(this.timeOfDay, this.camera.position, dt, this.camera.far * 0.98);
    this.sky.applyWeather(this.wx, dt);
    this.chunks.update(focus, this.camera.getWorldDirection(_dir));
    this.lod?.update(this.camera.position);
    // under water? (surface sits 0.12 below the block top)
    const p = this.camera.position;
    const id = this.chunks.getBlock(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
    const above = this.chunks.getBlock(Math.floor(p.x), Math.floor(p.y) + 1, Math.floor(p.z));
    const uw = id === B.WATER && (above === B.WATER || p.y - Math.floor(p.y) < 0.86);
    L.underwater.value = uw ? 1 : 0;
    this.sky.clouds.visible = !uw;
    // keep three.js lights in sync with the shader lighting
    const elevAbs = Math.abs(L.sunTrue.value.y);
    const shadowStrength = THREE.MathUtils.smoothstep(elevAbs, 0.03, 0.16) * (L.night.value > 0.5 ? 0.55 : 1) * (1 - this.wx.gray * 0.92);
    if (this.q.shadowSize > 0) this.shadows.update(this.camera, L.sunDir.value, shadowStrength);
    else {
      this.sun.position.copy(this.camera.position).addScaledVector(L.sunDir.value, 100);
      this.sun.target.position.copy(this.camera.position);
    }
    this.sun.color.copy(L.sunColor.value);
    this.hemi.color.copy(L.ambSky.value).multiplyScalar(1.6);
    this.hemi.groundColor.copy(L.ambGround.value).multiplyScalar(1.6);
    const post = this.post;
    if (post) {
      const night = L.night.value, golden = L.golden.value;
      post.time = this.elapsed;
      post.underwater = L.underwater.value;
      post.bloomStrength = 0.07 + night * 0.09 + this.wx.gray * 0.03 + this.wx.flash * 0.1;
      post.aoStrength = 0.55;
      // god rays from the sun by day, faint moon shafts at night
      const sunUp = L.sunTrue.value.y > -0.02;
      post.raysDir.copy(sunUp ? L.sunTrue.value : L.moonDir.value);
      const ray = sunUp ? (0.32 + golden * 0.55) * THREE.MathUtils.smoothstep(L.sunTrue.value.y, -0.02, 0.06) : 0.12 * night;
      post.raysColor.copy(sunUp ? L.sunColor.value : _moonRays).multiplyScalar(uw ? 0 : ray * (1 - this.wx.gray));
      // grading: slightly warm days, teal shadows + magenta highlights at night, warm golden hour
      const g = post.grade;
      g.shadowTint.setRGB(1.0, 1.0, 0.98).lerp(_tealShadow, night).lerp(_goldShadow, golden * 0.6);
      g.highTint.setRGB(1.04, 1.0, 0.94).lerp(_magentaHigh, night).lerp(_goldHigh, golden * 0.6);
      g.saturation = 1.06 + golden * 0.08 - night * 0.04 - this.wx.gray * 0.14;
      g.contrast = 1.04;
      g.exposure = 1.12 + night * 0.12;
      g.vignette = 0.2 + night * 0.12;
    }
  }

  /** camera for the far pass: same view, near plane pushed out (exact z precision for kilometres) */
  private farPass(): { scene: THREE.Object3D; camera: THREE.Camera } | null {
    if (!this.farScene || !this.lod || this.L.lodFar.value <= 0) return null;
    const c = this.camera, f = this.farCam;
    c.updateMatrixWorld();
    f.position.copy(c.position); f.quaternion.copy(c.quaternion);
    f.fov = c.fov; f.aspect = c.aspect;
    // the LOD also fills not-yet-streamed chunks right next to the camera, so the near plane
    // only moves out once the voxel radius is complete
    f.near = this.chunks.pendingCount === 0 ? Math.max(1, this.L.fogNear.value * 0.5) : 1;
    f.far = this.L.lodFar.value * 1.05 + 400;
    f.updateProjectionMatrix();
    f.updateMatrixWorld();
    return { scene: this.farScene, camera: f };
  }

  render() {
    this.renderer.info.reset();
    const far = this.farPass();
    this.L.rayMask.value = this.post ? 1 : 0;
    if (this.post) this.post.render(this.scene, this.camera, ChunkManager.LAYER_TRANSLUCENT, far);
    else {
      this.camera.layers.enable(0);
      this.camera.layers.enable(ChunkManager.LAYER_TRANSLUCENT);
      this.renderer.setRenderTarget(null);
      if (far) {
        this.renderer.render(far.scene, far.camera);
        this.renderer.autoClear = false;
        this.renderer.clearDepth();
        this.renderer.render(this.scene, this.camera);
        this.renderer.autoClear = true;
      } else this.renderer.render(this.scene, this.camera);
    }
  }

  stats() {
    const i = this.renderer.info;
    const lod = this.lod;
    return {
      calls: i.render.calls, tris: i.render.triangles, chunks: this.chunks.loadedCount, pending: this.chunks.pendingCount, genRate: this.chunks.rate,
      chunkTris: this.chunks.triangles, chunkMB: +(this.chunks.bytes / 1048576).toFixed(1), workers: this.chunks.workerCount, meshed: this.chunks.total,
      lodTiles: lod?.tileCount ?? 0, lodTris: lod?.triangles ?? 0, lodMB: lod ? +((lod.bytes + lod.groundBytes) / 1048576).toFixed(1) : 0, lodGround: lod?.groundLayers ?? '',
    };
  }
}

const _dir = new THREE.Vector3();
const _moonRays = new THREE.Color(0.5, 0.6, 0.9);
const _tealShadow = new THREE.Color(0.86, 1.02, 1.1);
const _magentaHigh = new THREE.Color(1.08, 0.94, 1.06);
const _goldShadow = new THREE.Color(0.95, 0.93, 1.02);
const _goldHigh = new THREE.Color(1.08, 0.98, 0.88);

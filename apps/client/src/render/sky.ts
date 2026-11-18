/**
 * Sky dome (gradient + horizon haze + sunrise/sunset scattering, pixel sun, moon with glow,
 * twinkling stars and a faint galactic band), 3D blocky clouds with soft volumetric-looking
 * shading, and the time-of-day lighting model that drives every world shader.
 */
import * as THREE from 'three';
import type { LightingUniforms } from './materials';
import { ATMOS_PARS, WAVES_FN } from './fx/atmosphere';
import { WORLD_H } from '@blockshore/shared';

const skyVert = /* glsl */ `varying vec3 vDir; void main(){ vDir = normalize(position); vec4 p = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position = p.xyww; }`;
const skyFrag = /* glsl */ `
  uniform float time;
  varying vec3 vDir;
  ${ATMOS_PARS}
  ${WAVES_FN}
  float h3(vec3 p){ return fract(sin(dot(p, vec3(12.9898,78.233,37.719))) * 43758.5453); }
  float h2(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
  vec2 basis(vec3 d, vec3 c) {
    vec3 up = abs(c.y) > 0.99 ? vec3(1,0,0) : vec3(0,1,0);
    vec3 r = normalize(cross(up, c)); vec3 u = cross(c, r);
    return vec2(dot(d, r), dot(d, u));
  }
  void main(){
    vec3 d = normalize(vDir);
    if (underwater > 0.5) { gl_FragColor = vec4(waterFog * (0.7 + 0.5 * clamp(d.y, 0.0, 1.0)), 1.0); return; }
    vec3 col = bsSky(d);
    float day = 1.0 - night;
    float clear = 1.0 - overcast;
    // pixel sun: square HDR disc + corona (drives bloom and god rays)
    float mu = dot(d, sunTrue);
    if (mu > 0.0) {
      vec2 q = basis(d, sunTrue);
      float sq = max(abs(q.x), abs(q.y));
      vec3 disc = sunColor / max(max(sunColor.r, sunColor.g), 0.05);
      float vis = smoothstep(-0.06, 0.02, sunTrue.y) * clear;
      col = mix(col, disc * 16.0, step(sq, 0.032) * vis);
      col += disc * (pow(mu, 900.0) * 3.0 + pow(mu, 60.0) * 0.25) * vis * day;
    }
    // stars + faint galactic band
    float stars = 0.0;
    if (night * clear > 0.01 && d.y > -0.05) {
      vec3 bn = normalize(vec3(0.35, 0.55, 0.76));
      float band = exp(-pow(dot(d, bn), 2.0) * 26.0);
      vec3 g = floor(d * 240.0);
      float h = h3(g);
      float thr = 0.9978 - band * 0.0025;
      if (h > thr) {
        float b = 0.35 + pow(fract(h * 31.7), 3.0) * 2.6;
        float tw = 0.65 + 0.35 * sin(time * (1.5 + fract(h * 53.0) * 3.0) + h * 80.0);
        vec3 sc = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.86, 0.7), fract(h * 13.1));
        col += sc * b * tw * night * clear * smoothstep(-0.02, 0.25, d.y);
      }
      float neb = bsNoise(d.xz * 9.0 + d.y * 3.0) * 0.6 + bsNoise(d.xz * 23.0) * 0.4;
      col += vec3(0.32, 0.30, 0.55) * band * neb * 0.07 * night * clear * smoothstep(0.0, 0.3, d.y);
    }
    // moon: pixel disc with craters + glow
    float mm = dot(d, moonDir);
    if (mm > 0.0 && night > 0.05) {
      vec2 q = basis(d, moonDir);
      float sq = max(abs(q.x), abs(q.y));
      if (sq < 0.026) {
        vec2 px = floor(q / 0.026 * 5.0);
        float crater = 0.78 + 0.22 * h2(px + 3.1);
        col = mix(col, vec3(0.92, 0.94, 1.0) * 3.2 * crater, night * clear * smoothstep(-0.05, 0.05, moonDir.y));
      }
    }
    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const cloudVert = /* glsl */ `
  varying vec3 vWorld; varying vec3 vN;
  void main(){
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorld = wp.xyz; vN = normal;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;
const cloudFrag = /* glsl */ `
  uniform vec3 ambSky; uniform float cloudY; uniform float cloudH; uniform float cloudFar; uniform float cloudCut; uniform float cloudFade;
  varying vec3 vWorld; varying vec3 vN;
  ${ATMOS_PARS}
  ${WAVES_FN}
  void main(){
    if (underwater > 0.5) discard;
    // weather: dithered cross-fade while the cover level swaps (see Sky.setCover)
    if (cloudFade < 0.999 && bsHash(gl_FragCoord.xy * 0.731) > cloudFade) discard;
    // near pass of the far-city LOD split: clouds beyond the voxel range are drawn by the far pass
    if (cloudCut > 0.0 && length(vWorld.xz - camPos.xz) > cloudCut) discard;
    vec3 n = normalize(vN);
    float hy = clamp((vWorld.y - cloudY) / cloudH, 0.0, 1.0);
    vec3 toP = vWorld - camPos; float dist = length(toP); vec3 V = toP / dist;
    float diff = max(dot(n, sunTrue), 0.0);
    float puff = bsNoise(vWorld.xz * 0.03) * 0.6 + bsNoise(vWorld.xz * 0.09 + 7.0) * 0.4;
    float k = 0.22 + 0.42 * hy + 0.28 * diff + (puff - 0.5) * 0.35;
    if (n.y > 0.5) k += 0.22;
    if (n.y < -0.5) k -= 0.18;
    k = clamp(k, 0.0, 1.0);
    vec3 lit = sunColor * 1.15 + ambSky * 0.95;
    vec3 shade = ambSky * 0.95 + horizon * 0.22;
    vec3 col = mix(shade, lit, k);
    // silver lining: forward scattering when looking toward the sun
    float fs = pow(max(dot(V, sunTrue), 0.0), 7.0);
    col += sunColor * fs * (0.55 + 0.9 * golden) * (1.0 - 0.5 * hy) * (1.0 - overcast);
    // overcast / storm: flat grey-blue undersides, no sun-lit tops
    col = mix(col, (ambSky * 1.05 + horizon * 0.2) * (0.62 + 0.38 * k), overcast * 0.85);
    vec3 sky = bsSky(V);
    col = mix(col, sky, 0.1 + 0.9 * smoothstep(cloudFar * 0.45, cloudFar, dist));
    // alpha 0 = "not sky" for the god-ray mask (the far pass leaves no depth behind)
    gl_FragColor = vec4(col, 1.0 - rayMask);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const GRID = 128;
const CELL_M = 12;
const CLOUD_H = 5;
/** cloud base; above Leonia's towers (up to ~250 m) */
const CLOUD_Y = WORLD_H > 128 ? 560 : 165;
const TILE = GRID * CELL_M;

/** greedy-meshed 3D cloud boxes for one wrapping tile */
function buildCloudGeometry(on: Uint8Array): THREE.BufferGeometry {
  const pos: number[] = [], nrm: number[] = [], idx: number[] = [];
  const at = (x: number, z: number) => on[((z + GRID) % GRID) * GRID + ((x + GRID) % GRID)];
  const quad = (a: number[], b: number[], c: number[], d: number[], n: number[]) => {
    const base = pos.length / 3;
    pos.push(...a, ...b, ...c, ...d);
    for (let i = 0; i < 4; i++) nrm.push(...n);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const y0 = 0, y1 = CLOUD_H, S = CELL_M;
  // top + bottom: greedy rectangles
  const used = new Uint8Array(GRID * GRID);
  for (let z = 0; z < GRID; z++) for (let x = 0; x < GRID; x++) {
    if (!on[z * GRID + x] || used[z * GRID + x]) continue;
    let w = 1;
    while (x + w < GRID && on[z * GRID + x + w] && !used[z * GRID + x + w]) w++;
    let h = 1;
    outer: while (z + h < GRID) {
      for (let i = 0; i < w; i++) if (!on[(z + h) * GRID + x + i] || used[(z + h) * GRID + x + i]) break outer;
      h++;
    }
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) used[(z + j) * GRID + x + i] = 1;
    const X0 = x * S, X1 = (x + w) * S, Z0 = z * S, Z1 = (z + h) * S;
    quad([X0, y1, Z1], [X1, y1, Z1], [X1, y1, Z0], [X0, y1, Z0], [0, 1, 0]);
    quad([X0, y0, Z0], [X1, y0, Z0], [X1, y0, Z1], [X0, y0, Z1], [0, -1, 0]);
  }
  // sides: merged runs along each edge
  for (let x = 0; x < GRID; x++) {
    for (const dx of [1, -1]) {
      let z = 0;
      while (z < GRID) {
        if (!(at(x, z) && !at(x + dx, z))) { z++; continue; }
        let e = z; while (e < GRID && at(x, e) && !at(x + dx, e)) e++;
        const X = (dx > 0 ? x + 1 : x) * S, Z0 = z * S, Z1 = e * S;
        if (dx > 0) quad([X, y0, Z1], [X, y0, Z0], [X, y1, Z0], [X, y1, Z1], [1, 0, 0]);
        else quad([X, y0, Z0], [X, y0, Z1], [X, y1, Z1], [X, y1, Z0], [-1, 0, 0]);
        z = e;
      }
    }
  }
  for (let z = 0; z < GRID; z++) {
    for (const dz of [1, -1]) {
      let x = 0;
      while (x < GRID) {
        if (!(at(x, z) && !at(x, z + dz))) { x++; continue; }
        let e = x; while (e < GRID && at(e, z) && !at(e, z + dz)) e++;
        const Z = (dz > 0 ? z + 1 : z) * S, X0 = x * S, X1 = e * S;
        if (dz > 0) quad([X0, y0, Z], [X1, y0, Z], [X1, y1, Z], [X0, y1, Z], [0, 0, 1]);
        else quad([X1, y0, Z], [X0, y0, Z], [X0, y1, Z], [X1, y1, Z], [0, 0, -1]);
        x = e;
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(TILE / 2, CLOUD_H / 2, TILE / 2), TILE);
  return g;
}

/** what the weather system hands the sky each frame (fx/weather.ts) */
export interface SkyWeather { cover: number; gray: number; rain: number; flash: number; wind: number }

/** desaturate toward a cool grey of the same brightness and darken */
function greyOut(c: THREE.Color, g: number, dark: number) {
  const lum = c.r * 0.3 + c.g * 0.59 + c.b * 0.11;
  _c1.setRGB(lum * 0.96, lum * 1.0, lum * 1.06).multiplyScalar(dark);
  c.lerp(_c1, Math.min(1, g * 0.88));
}

const _sun = new THREE.Vector3();
const _c1 = new THREE.Color(), _c2 = new THREE.Color(), _c3 = new THREE.Color();

export class Sky {
  readonly mesh: THREE.Mesh;
  /** 3×3 tiles of blocky 3D clouds (a Group; kept under the old name for compatibility) */
  readonly clouds: THREE.Group;
  /** the same clouds for the far-city LOD pass (no distance cut, fades at the LOD range) */
  readonly cloudsFar: THREE.Group;
  private cloudFarMat: THREE.ShaderMaterial;
  private cloudFarTiles: THREE.Mesh[] = [];
  private mat: THREE.ShaderMaterial;
  private cloudMat: THREE.ShaderMaterial;
  private cloudTiles: THREE.Mesh[] = [];
  private wind = 0;
  /** weather: wind-driven cloud drift multiplier, cover levels and the dithered cross-fade between them */
  private levelGeo: THREE.BufferGeometry[] = [];
  private levelTex: THREE.Texture[] = [];
  private level = 1;
  private fading: { to: number; t: number } | null = null;
  private cloudFade = { value: 1 };
  private drift = 1;
  /** aerial-perspective density multiplier (Leonia's true-scale skyline wants a clearer sky) */
  haze = 1;
  constructor(private L: LightingUniforms) {
    this.mat = new THREE.ShaderMaterial({
      uniforms: { ...L },
      vertexShader: skyVert, fragmentShader: skyFrag, side: THREE.BackSide, depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
    // cloud coverage grid (smoothed noise, thresholded)
    let s = 1234567;
    const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1000) / 1000; };
    const grid = new Float32Array(GRID * GRID);
    for (let i = 0; i < grid.length; i++) grid[i] = rnd();
    for (let pass = 0; pass < 4; pass++) {
      const g2 = new Float32Array(grid.length);
      for (let y = 0; y < GRID; y++) for (let x = 0; x < GRID; x++) {
        let sum = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) sum += grid[((y + dy + GRID) % GRID) * GRID + ((x + dx + GRID) % GRID)];
        g2[y * GRID + x] = sum / 9;
      }
      grid.set(g2);
    }
    // four coverage levels from the same noise (weather picks one): sparse / the original scattered sky / broken / full overcast sheet
    const sorted = Float32Array.from(grid).sort();
    const thr = [sorted[Math.floor(grid.length * 0.9)], 0.53, sorted[Math.floor(grid.length * 0.4)], -1];
    for (let lv = 0; lv < 4; lv++) {
      const on = new Uint8Array(GRID * GRID);
      const tex = new Uint8Array(GRID * GRID);
      for (let i = 0; i < grid.length; i++) { on[i] = grid[i] > thr[lv] ? 1 : 0; tex[i] = on[i] ? 255 : 0; }
      // coverage texture for cloud shadows on the ground (linear filter = soft shadow edges)
      const ct = new THREE.DataTexture(tex, GRID, GRID, THREE.RedFormat, THREE.UnsignedByteType);
      ct.wrapS = ct.wrapT = THREE.RepeatWrapping;
      ct.magFilter = THREE.LinearFilter; ct.minFilter = THREE.LinearFilter;
      ct.needsUpdate = true;
      this.levelTex.push(ct);
      this.levelGeo.push(buildCloudGeometry(on));
    }
    L.cloudMap.value = this.levelTex[1];
    L.cloudXf.value.set(0, 0, 1 / TILE, CLOUD_Y + CLOUD_H * 0.5);
    this.cloudMat = new THREE.ShaderMaterial({
      uniforms: { ...L, cloudY: { value: CLOUD_Y }, cloudH: { value: CLOUD_H }, cloudFar: { value: 600 }, cloudCut: { value: 0 }, cloudFade: this.cloudFade },
      vertexShader: cloudVert, fragmentShader: cloudFrag,
    });
    this.cloudFarMat = new THREE.ShaderMaterial({
      uniforms: { ...L, cloudY: { value: CLOUD_Y }, cloudH: { value: CLOUD_H }, cloudFar: { value: 3000 }, cloudCut: { value: 0 }, cloudFade: this.cloudFade },
      vertexShader: cloudVert, fragmentShader: cloudFrag,
    });
    const geo = this.levelGeo[1];
    this.clouds = new THREE.Group();
    for (let i = 0; i < 9; i++) {
      const m = new THREE.Mesh(geo, this.cloudMat);
      m.renderOrder = -5;
      this.cloudTiles.push(m);
      this.clouds.add(m);
    }
    this.cloudsFar = new THREE.Group();
    for (let i = 0; i < 9; i++) {
      const m = new THREE.Mesh(geo, this.cloudFarMat);
      m.renderOrder = -5;
      this.cloudFarTiles.push(m);
      this.cloudsFar.add(m);
    }
  }

  /** far-city LOD split: near clouds stop at `cut` metres, far clouds fade out at `far` (0 = no split) */
  setSplit(cut: number, far: number) {
    this.cloudMat.uniforms.cloudCut.value = cut;
    this.cloudFarMat.uniforms.cloudFar.value = Math.max(1200, Math.min(far, 2600));
  }

  /** t in [0,1): 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset */
  update(t: number, camPos: THREE.Vector3, dt: number, far = 600) {
    const ang = (t - 0.25) * Math.PI * 2;
    const sun = _sun.set(Math.cos(ang) * 0.8, Math.sin(ang), Math.cos(ang) * 0.35 + 0.25).normalize();
    const elev = sun.y;
    const day = THREE.MathUtils.smoothstep(elev, -0.12, 0.25);
    const golden = Math.max(0, 1 - Math.abs(elev - 0.04) / 0.36) * (elev > -0.14 ? 1 : 0);
    const blue = Math.max(0, 1 - Math.abs(elev + 0.07) / 0.09); // blue hour just after sunset
    const night = 1 - day;
    const L = this.L;
    L.sunTrue.value.copy(sun);
    L.moonDir.value.copy(sun).negate();
    L.sunDir.value.copy(elev > 0 ? sun : L.moonDir.value); // moon lights at night
    L.night.value = night;
    L.golden.value = golden;
    const sunCol = _c1.setRGB(1.0, 0.93, 0.82).lerp(_c2.setRGB(1.0, 0.5, 0.22), Math.min(1, golden * 1.05));
    L.sunColor.value.copy(sunCol).multiplyScalar(1.3 * day + 0.16 * night);
    if (night > 0.5) L.sunColor.value.setRGB(0.16, 0.2, 0.36);
    const zenith = _c1.setRGB(0.08, 0.26, 0.72)
      .lerp(_c2.setRGB(0.14, 0.2, 0.5), golden * 0.6)
      .lerp(_c2.setRGB(0.004, 0.008, 0.028), night);
    const horizon = _c3.setRGB(0.52, 0.71, 0.95)
      .lerp(_c2.setRGB(1.0, 0.52, 0.28), Math.min(1, golden * 1.1))
      .lerp(_c2.setRGB(0.38, 0.26, 0.42), blue * 0.6)
      .lerp(_c2.setRGB(0.025, 0.035, 0.075), night * 0.95);
    L.zenith.value.copy(zenith);
    L.horizon.value.copy(horizon);
    L.fogColor.value.copy(horizon).lerp(zenith, 0.25);
    L.fogDensity.value = (0.0010 + golden * 0.0006 + night * 0.0006) * this.haze;
    L.ambSky.value.setRGB(0.5, 0.58, 0.72).lerp(_c2.setRGB(0.75, 0.52, 0.5), golden * 0.5).multiplyScalar(0.44 * day + 0.28 * night);
    if (night > 0.5) L.ambSky.value.setRGB(0.12, 0.15, 0.27);
    L.ambGround.value.copy(L.ambSky.value).multiplyScalar(0.55);
    L.blockLight.value = 0.35 + night * 1.9;
    L.waterFog.value.setRGB(0.03, 0.2, 0.26).multiplyScalar(0.25 + 0.75 * day);
    this.mesh.position.copy(camPos);
    this.mesh.scale.setScalar(900);
    // clouds drift with the wind; 3×3 tiles wrap around the camera
    this.wind += dt * 1.6 * this.drift;
    const ox = this.wind % TILE;
    const baseX = Math.floor((camPos.x - ox) / TILE) * TILE + ox, baseZ = Math.floor(camPos.z / TILE) * TILE;
    let i = 0;
    for (let tz = -1; tz <= 1; tz++) for (let tx = -1; tx <= 1; tx++) {
      this.cloudFarTiles[i].position.set(baseX + tx * TILE - TILE / 2, CLOUD_Y, baseZ + tz * TILE - TILE / 2);
      this.cloudTiles[i++].position.set(baseX + tx * TILE - TILE / 2, CLOUD_Y, baseZ + tz * TILE - TILE / 2);
    }
    // tile origin used by the cloud-shadow lookup (texture repeats every TILE metres)
    L.cloudXf.value.x = ox - TILE / 2;
    L.cloudXf.value.y = -TILE / 2;
    this.cloudMat.uniforms.cloudFar.value = far;
  }

  /**
   * Weather pass: call right after update(). Greys and darkens the sky model, dims the sun, thickens the fog,
   * adds lightning light, swaps the cloud cover level (dither cross-fade) and speeds the drift with the wind.
   */
  applyWeather(w: SkyWeather, dt: number) {
    const L = this.L, g = w.gray;
    L.overcast.value = g;
    this.drift = 1 + w.wind * 2.2;
    // cloud cover level: 0 sparse, 1 scattered, 2 broken, 3 full sheet
    const want = w.cover < 0.2 ? 0 : w.cover < 0.62 ? 1 : w.cover < 0.9 ? 2 : 3;
    if (!this.fading && want !== this.level) this.fading = { to: want, t: 0 };
    if (this.fading) {
      const f = this.fading; f.t += dt;
      if (f.t < 3) this.cloudFade.value = 1 - f.t / 3;
      else {
        if (this.level !== f.to) { this.level = f.to; for (const m of this.cloudTiles) m.geometry = this.levelGeo[f.to]; for (const m of this.cloudFarTiles) m.geometry = this.levelGeo[f.to]; L.cloudMap.value = this.levelTex[f.to]; }
        this.cloudFade.value = Math.min(1, (f.t - 3) / 3);
        if (f.t >= 6) { this.fading = null; this.cloudFade.value = 1; }
      }
    }
    if (g > 0.002 || w.flash > 0.001) {
      greyOut(L.zenith.value, g, 1 - 0.5 * g);
      greyOut(L.horizon.value, g, 1 - 0.3 * g);
      const sunK = 1 - 0.9 * g;
      L.sunColor.value.multiplyScalar(sunK);
      L.ambSky.value.multiplyScalar(1 - 0.32 * g).lerp(_c1.setRGB(L.ambSky.value.g * 0.98, L.ambSky.value.g, L.ambSky.value.g * 1.04), g * 0.5);
      L.ambGround.value.copy(L.ambSky.value).multiplyScalar(0.55);
      L.blockLight.value += g * 0.35; // street lamps read better under a dark sky
      L.fogDensity.value *= 1 + g * 0.9 + w.rain * 2.6;
      if (w.flash > 0.001) {
        const f = w.flash;
        L.zenith.value.r += f * 0.55; L.zenith.value.g += f * 0.62; L.zenith.value.b += f * 0.95;
        L.horizon.value.r += f * 0.8; L.horizon.value.g += f * 0.88; L.horizon.value.b += f * 1.15;
        L.ambSky.value.r += f * 0.42; L.ambSky.value.g += f * 0.47; L.ambSky.value.b += f * 0.62;
        L.ambGround.value.r += f * 0.18; L.ambGround.value.g += f * 0.2; L.ambGround.value.b += f * 0.26;
        L.sunColor.value.r += f * 0.5; L.sunColor.value.g += f * 0.55; L.sunColor.value.b += f * 0.75;
      }
      L.fogColor.value.copy(L.horizon.value).lerp(L.zenith.value, 0.25);
    }
  }
}

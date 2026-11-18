/**
 * Client weather: follows the server's compact `wx` message (state, intensity, wind), blends between
 * states on the shared server clock (so every player in the instance sees the same sky), and drives
 *
 *   - sky / cloud cover / fog darkening (via Sky.applyWeather, uniforms in LightingUniforms)
 *   - wetness that builds while it rains and dries out afterwards (block shader puddles + damp surfaces)
 *   - wind strength for the foliage sway and cloud drift
 *   - rain: GPU-animated streaks that follow the camera, ground splashes, shelter check (roof above the camera)
 *   - lightning (deterministic from server time, so everyone sees the same flashes) + a delayed thunder hook
 *
 * Rain is two draw calls (streaks + splashes) and does no per-frame allocation: streak motion lives in the
 * vertex shader (positions wrap inside a box around the camera), splash rings are a pooled quad buffer whose
 * few respawns per frame scan one voxel column each.
 *
 * Cost by quality (see QUALITY below): low = 700 streaks, no splashes, no puddles (damp darkening only);
 * medium 1800 / 120; high 3000 / 220; ultra 4500 / 320. Nothing is drawn while it is dry.
 */
import * as THREE from 'three';
import { B, WX_STATE_NAMES, type WxMsg, type WxTriple } from '@blockshore/shared';
import type { LightingUniforms } from '../materials';
import type { ChunkManager } from '../chunks';
import type { SkyWeather } from '../sky';

//                       cover gray  rain  storm
const PARAMS: number[][] = [
  [0.05, 0.00, 0.00, 0.00], // clear
  [0.42, 0.14, 0.00, 0.00], // partly cloudy
  [0.86, 0.78, 0.00, 0.00], // overcast
  [0.95, 0.90, 0.60, 0.00], // rain
  [1.00, 1.00, 0.85, 1.00], // thunderstorm
  [1.00, 0.97, 1.00, 0.35], // tropical downpour
];

export interface WeatherQuality { streaks: number; splashes: number; lightning: boolean }
const QUALITY: Record<string, WeatherQuality> = {
  low: { streaks: 700, splashes: 0, lightning: true },
  medium: { streaks: 1800, splashes: 120, lightning: true },
  high: { streaks: 3000, splashes: 220, lightning: true },
  ultra: { streaks: 4500, splashes: 320, lightning: true },
};

const BOX_XZ = 40, BOX_Y = 22;
const BUCKET_MS = 3500;
const SPLASH_LIFE = 0.5;

const rainVert = /* glsl */ `
  attribute vec4 seed; attribute vec2 corner;
  uniform float time; uniform float rain; uniform vec3 camP; uniform vec2 windV; uniform float shelter;
  varying float vA; varying float vX;
  void main() {
    float vis = step(seed.w, rain);
    float sp = 17.0 + fract(seed.w * 37.0) * 7.0;
    vec3 vel = vec3(windV.x, -sp, windV.y);
    vec3 S = vec3(${BOX_XZ}.0, ${BOX_Y}.0, ${BOX_XZ}.0);
    vec3 lo = vec3(-${BOX_XZ / 2}.0, -${BOX_Y * 0.55}, -${BOX_XZ / 2}.0);
    vec3 q = seed.xyz * S + vel * time;
    vec3 p = camP + mod(q - camP - lo, S) + lo;
    vec3 dir = normalize(vel);
    float len = 0.5 + sp * 0.05;
    vec3 a = p - dir * len * corner.y;
    vec3 e = a - camP; float d = length(e);
    vec3 right = normalize(cross(dir, e));
    a += right * corner.x * (0.009 + 0.002 * d);
    float fade = smoothstep(0.7, 2.4, d) * (1.0 - smoothstep(${(BOX_XZ * 0.3).toFixed(1)}, ${(BOX_XZ * 0.5).toFixed(1)}, d));
    fade *= mix(1.0, smoothstep(5.0, 14.0, d) * 0.35, shelter);
    vA = vis * fade * mix(1.0, 0.25, corner.y);
    vX = corner.x;
    gl_Position = projectionMatrix * viewMatrix * vec4(a, 1.0);
  }
`;
const rainFrag = /* glsl */ `
  uniform vec3 rainCol; uniform float alpha;
  varying float vA; varying float vX;
  void main() {
    float a = vA * alpha * (1.0 - vX * vX);
    if (a < 0.004) discard;
    gl_FragColor = vec4(rainCol, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;
const splashVert = /* glsl */ `
  attribute vec2 corner; attribute vec4 info;
  uniform float time; uniform vec3 camP;
  varying vec2 vUv; varying float vK; varying float vD;
  void main() {
    float age = time - info.w;
    float k = age / ${SPLASH_LIFE.toFixed(2)};
    float vis = step(0.0, age) * step(k, 1.0);
    float R = 0.07 + 0.34 * k;
    vec3 p = info.xyz + vec3(corner.x * R, 0.035, corner.y * R);
    vUv = corner; vK = k * vis + (1.0 - vis) * 2.0;
    vD = length(p - camP);
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
  }
`;
const splashFrag = /* glsl */ `
  uniform vec3 rainCol; uniform float alpha;
  varying vec2 vUv; varying float vK; varying float vD;
  void main() {
    if (vK > 1.0) discard;
    float d = length(vUv);
    float r0 = 0.25 + 0.7 * vK;
    float ring = smoothstep(0.2, 0.0, abs(d - r0)) * (1.0 - vK);
    float dot0 = (1.0 - smoothstep(0.0, 0.3, d)) * (1.0 - smoothstep(0.0, 0.35, vK));
    float a = (ring * 0.6 + dot0 * 0.7) * alpha * (1.0 - smoothstep(14.0, 24.0, vD));
    if (a < 0.004) discard;
    gl_FragColor = vec4(rainCol * 1.35, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

const lerp = (a: number, b: number, k: number) => a + (b - a) * k;
function params(t: WxTriple, out: number[]) {
  const P = PARAMS[Math.min(PARAMS.length - 1, Math.max(0, t[0] | 0))];
  const i = Math.min(1, Math.max(0, t[1] / 100));
  out[0] = P[0];
  out[1] = P[1] * (0.85 + 0.15 * i);
  out[2] = P[2] * (0.6 + 0.4 * i);
  out[3] = P[3];
  out[4] = Math.min(1, Math.max(0, t[2] / 100));
}
const hash32 = (a: number) => { a = Math.imul(a ^ (a >>> 16), 0x85ebca6b); a = Math.imul(a ^ (a >>> 13), 0xc2b2ae35); return (a ^ (a >>> 16)) >>> 0; };
const u01 = (h: number, salt: number) => hash32(h ^ Math.imul(salt + 1, 0x9e3779b1)) / 4294967296;

interface Strike { age: number; strength: number }

export class Weather implements SkyWeather {
  /** server clock (ms); the game sets this to net.serverNow */
  clock: () => number = Date.now;
  /** blended values, all 0..1 */
  cover = 0.3; gray = 0; rain = 0; storm = 0; wind = 0.18;
  /** damp-surface amount: rises while it rains, dries over a couple of minutes */
  wetness = 0;
  /** lightning light this frame */
  flash = 0;
  /** 0..1 how covered the camera is from above (roof, tunnel, canopy) */
  shelter = 0;
  /** 1 outdoors, 0 in an interior instance (set by the game); rain, flashes and storm light fade with it */
  outdoor = 1;
  private outdoorK = 1;
  /** hooks: thunder(strength 0..1, delay seconds); the game connects them to the audio engine */
  onThunder: ((strength: number, delaySec: number) => void) | null = null;
  /** debug: last message state name */
  stateName = 'clear';

  private msg: WxMsg | null = null;
  private pa = [0, 0, 0, 0, 0]; private pb = [0, 0, 0, 0, 0];
  private q: WeatherQuality = QUALITY.high;
  private strikes: Strike[] = [{ age: 9, strength: 0 }, { age: 9, strength: 0 }, { age: 9, strength: 0 }];
  private bucket = -1; private strikeAt = -1; private strikeDone = true; private strikeDist = 0; private strikeStrength = 0;
  private shelterT = 0; private shelterTarget = 0;
  private forcedUntilMsg = false;

  readonly group = new THREE.Group();
  private rainMesh: THREE.Mesh | null = null; private rainMat: THREE.ShaderMaterial;
  private splashMesh: THREE.Mesh | null = null; private splashMat: THREE.ShaderMaterial;
  private splashInfo: THREE.BufferAttribute | null = null;
  private splashN = 0; private seedState = 0x1234567;
  private lastStreaks = -1; private lastSplashes = -1;
  private cx = 0; private cy = 0; private cz = 0;

  constructor(private L: LightingUniforms) {
    const blend = {
      transparent: true, depthWrite: false, blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    } as const;
    this.rainMat = new THREE.ShaderMaterial({
      ...blend, vertexShader: rainVert, fragmentShader: rainFrag,
      uniforms: { time: L.time, rain: { value: 0 }, camP: { value: new THREE.Vector3() }, windV: { value: new THREE.Vector2() }, shelter: { value: 0 }, rainCol: { value: new THREE.Color(0.5, 0.55, 0.62) }, alpha: { value: 0.3 } },
    });
    this.splashMat = new THREE.ShaderMaterial({
      ...blend, vertexShader: splashVert, fragmentShader: splashFrag, side: THREE.DoubleSide,
      uniforms: { time: L.time, camP: this.rainMat.uniforms.camP, rainCol: this.rainMat.uniforms.rainCol, alpha: { value: 0.5 } },
    });
    this.group.visible = false;
    this.group.frustumCulled = false;
  }

  configure(level: string) {
    this.q = QUALITY[level] ?? QUALITY.high;
    this.build();
  }

  private build() {
    const q = this.q;
    if (q.streaks !== this.lastStreaks) {
      this.lastStreaks = q.streaks;
      if (this.rainMesh) { this.group.remove(this.rainMesh); this.rainMesh.geometry.dispose(); this.rainMesh = null; }
      const n = q.streaks;
      const pos = new Float32Array(n * 4 * 3), seed = new Float32Array(n * 4 * 4), corner = new Float32Array(n * 4 * 2), idx = new Uint32Array(n * 6);
      let s = 987654321;
      const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; };
      for (let i = 0; i < n; i++) {
        const sx = rnd(), sy = rnd(), sz = rnd(), sw = (i + 0.5) / n; // sw ascending: thinning keeps a uniform subset
        for (let v = 0; v < 4; v++) {
          const o = i * 4 + v;
          seed.set([sx, sy, sz, sw], o * 4);
          corner[o * 2] = v & 1 ? 1 : -1; corner[o * 2 + 1] = v & 2 ? 1 : 0;
        }
        idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2], i * 6);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
      g.setAttribute('corner', new THREE.BufferAttribute(corner, 2));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      this.rainMesh = new THREE.Mesh(g, this.rainMat);
      this.rainMesh.frustumCulled = false; this.rainMesh.renderOrder = 20;
      this.group.add(this.rainMesh);
    }
    if (q.splashes !== this.lastSplashes) {
      this.lastSplashes = q.splashes;
      if (this.splashMesh) { this.group.remove(this.splashMesh); this.splashMesh.geometry.dispose(); this.splashMesh = null; this.splashInfo = null; }
      const n = q.splashes;
      this.splashN = n;
      if (n > 0) {
        const pos = new Float32Array(n * 4 * 3), corner = new Float32Array(n * 4 * 2), info = new Float32Array(n * 4 * 4), idx = new Uint32Array(n * 6);
        for (let i = 0; i < n; i++) {
          for (let v = 0; v < 4; v++) { const o = i * 4 + v; corner[o * 2] = v & 1 ? 1 : -1; corner[o * 2 + 1] = v & 2 ? 1 : -1; info[o * 4 + 3] = -1e5; }
          idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 1, i * 4 + 3, i * 4 + 2], i * 6);
        }
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setAttribute('corner', new THREE.BufferAttribute(corner, 2));
        this.splashInfo = new THREE.BufferAttribute(info, 4); this.splashInfo.setUsage(THREE.DynamicDrawUsage);
        g.setAttribute('info', this.splashInfo);
        g.setIndex(new THREE.BufferAttribute(idx, 1));
        this.splashMesh = new THREE.Mesh(g, this.splashMat);
        this.splashMesh.frustumCulled = false; this.splashMesh.renderOrder = 21;
        this.group.add(this.splashMesh);
      }
    }
  }

  /** new target from the server */
  setMsg(m: WxMsg) {
    const first = !this.msg;
    this.msg = m;
    this.forcedUntilMsg = false;
    if (first) {
      // joining mid-rain: the ground is already wet
      params(m.s, this.pb);
      const k = Math.min(1, Math.max(0, (this.clock() - m.at) / m.d));
      params(m.p, this.pa);
      this.wetness = Math.min(1, lerp(this.pa[2], this.pb[2], k) * 1.5) * 0.9;
    }
  }

  /** local override (preview `wx=` query, tests): jumps straight to a state */
  force(state: string | number, intensity = 100, wind?: number) {
    const idx = typeof state === 'number' ? state : (WX_STATE_NAMES as readonly string[]).indexOf(state);
    if (idx < 0) return;
    const w = wind ?? [18, 32, 40, 55, 82, 62][idx];
    const t: WxTriple = [idx, intensity, w];
    this.msg = { t: 'wx', s: t, p: t, at: this.clock() - 1e6, d: 1000 };
    this.forcedUntilMsg = true;
    params(t, this.pb);
    this.wetness = Math.min(1, this.pb[2] * 1.5) * 0.9;
    this.wetness = Math.max(this.wetness, this.pb[2] > 0 ? 0.9 : 0);
  }

  /** debug / preview: fire a lightning strike now */
  strike(strength = 0.95, distM = 700) {
    let slot = this.strikes[0];
    for (const s of this.strikes) if (s.age > slot.age) slot = s;
    slot.age = 0; slot.strength = strength;
    this.onThunder?.(strength, distM / 343);
  }

  /** instantaneous blend of the current message */
  private evaluate(now: number) {
    const m = this.msg;
    if (!m) { params([1, 100, 20], this.pa); this.stateName = 'clear'; return this.pa; }
    const k0 = Math.min(1, Math.max(0, (now - m.at) / Math.max(1, m.d)));
    const k = k0 * k0 * (3 - 2 * k0);
    params(m.p, this.pa); params(m.s, this.pb);
    for (let i = 0; i < 5; i++) this.pa[i] = lerp(this.pa[i], this.pb[i], k);
    this.stateName = WX_STATE_NAMES[(k0 < 0.5 ? m.p : m.s)[0]] ?? 'clear';
    return this.pa;
  }

  update(dt: number, cam: THREE.Camera, chunks: ChunkManager, ambient: THREE.Color, dayK: number) {
    const now = this.clock();
    const v = this.evaluate(now);
    this.outdoorK += (this.outdoor - this.outdoorK) * Math.min(1, dt * 2.5);
    const o = this.outdoorK;
    this.cover = v[0]; this.gray = v[1] * o; this.rain = v[2] * o; this.storm = v[3]; this.wind = v[4];
    // wetness: builds quickly under rain, dries slowly
    const target = Math.min(1, v[2] * 1.6);
    if (target > this.wetness) this.wetness = Math.min(target, this.wetness + dt * (0.4 + target) / 22);
    else this.wetness = Math.max(0, this.wetness - dt / 150);
    const L = this.L;
    L.wetness.value = this.wetness;
    L.windAmt.value = this.wind;

    this.lightning(dt, now);
    this.flash *= o;

    const p = cam.position;
    this.cx = p.x; this.cy = p.y; this.cz = p.z;
    // shelter: is anything solid above the camera? (8 Hz, damped)
    this.shelterT -= dt;
    if (this.shelterT <= 0) {
      this.shelterT = 0.125;
      this.shelterTarget = this.rain > 0.02 ? this.coverAbove(chunks, p) : 0;
    }
    this.shelter += (this.shelterTarget - this.shelter) * Math.min(1, dt * 5);

    this.draw(dt, p, chunks, ambient, dayK);
  }

  private coverAbove(chunks: ChunkManager, p: THREE.Vector3): number {
    const y0 = Math.floor(p.y) + 1, y1 = Math.min(255, y0 + 70);
    let n = 0;
    if (chunks.scanColumn(p.x, p.z, y0, y1) >= 0) n += 2;
    if (chunks.scanColumn(p.x + 1.2, p.z, y0, y1) >= 0) n++;
    if (chunks.scanColumn(p.x - 1.2, p.z, y0, y1) >= 0) n++;
    if (chunks.scanColumn(p.x, p.z + 1.2, y0, y1) >= 0) n++;
    if (chunks.scanColumn(p.x, p.z - 1.2, y0, y1) >= 0) n++;
    return n / 6;
  }

  /** deterministic strikes from server time: everyone in the instance sees (and hears) the same ones */
  private lightning(dt: number, now: number) {
    for (const s of this.strikes) s.age += dt;
    const b = Math.floor(now / BUCKET_MS);
    if (b !== this.bucket) {
      this.bucket = b;
      const h = hash32(b * 7919 + 13);
      const chance = this.storm * 0.62;
      this.strikeDone = !(this.q.lightning && this.outdoorK > 0.5 && u01(h, 0) < chance);
      this.strikeAt = b * BUCKET_MS + u01(h, 1) * BUCKET_MS * 0.85;
      this.strikeDist = 250 + Math.pow(u01(h, 2), 1.6) * 3200;
      this.strikeStrength = Math.min(1, Math.max(0.12, 1.15 - this.strikeDist / 3600));
    }
    if (!this.strikeDone && now >= this.strikeAt) {
      this.strikeDone = true;
      if (now - this.strikeAt < 2500) {
        let slot = this.strikes[0];
        for (const s of this.strikes) if (s.age > slot.age) slot = s;
        slot.age = 0; slot.strength = this.strikeStrength;
        this.onThunder?.(this.strikeStrength, this.strikeDist / 343);
      }
    }
    let f = 0;
    for (const s of this.strikes) {
      const a = s.age;
      if (a > 1.4) continue;
      let e = Math.exp(-a * 9);
      if (a > 0.14) e += 0.7 * Math.exp(-(a - 0.14) * 12);
      if (a > 0.34) e += 0.45 * Math.exp(-(a - 0.34) * 9);
      f += e * s.strength;
    }
    this.flash = Math.min(1.5, f * 1.3);
  }

  private rnd() { let s = this.seedState; s ^= s << 13; s ^= s >>> 17; s ^= s << 5; this.seedState = s; return (s >>> 0) / 4294967296; }

  private draw(dt: number, p: THREE.Vector3, chunks: ChunkManager, ambient: THREE.Color, dayK: number) {
    const rain = this.rain;
    const show = rain > 0.01 && this.rainMesh !== null;
    this.group.visible = show;
    if (!show) { if (this.splashInfo && this.rain <= 0.01) this.parkSplashes(); return; }
    const u = this.rainMat.uniforms;
    u.rain.value = rain; u.shelter.value = this.shelter;
    (u.camP.value as THREE.Vector3).copy(p);
    // drift with the wind (+x like the clouds)
    (u.windV.value as THREE.Vector2).set(2.5 + this.wind * 7.5, this.wind * 1.8);
    const col = u.rainCol.value as THREE.Color;
    // rain is lit by the sky: grey-blue, brighter by day, picks up lightning through the ambient colour
    col.copy(ambient).multiplyScalar(1.6).addScalar(0.035);
    this.rainMat.uniforms.alpha.value = (0.34 + 0.3 * rain) * (0.7 + 0.3 * dayK);
    this.splashMat.uniforms.alpha.value = 0.5 + 0.3 * rain;
    // splashes: respawn expired ones near the camera, a few columns per frame
    const info = this.splashInfo;
    if (info && this.splashN > 0) {
      const arr = info.array as Float32Array;
      const active = Math.floor(this.splashN * Math.min(1, rain * 1.15));
      let budget = 10, dirty = false;
      const t = this.L.time.value;
      for (let i = 0; i < this.splashN; i++) {
        const o = i * 16;
        const birth = arr[o + 3];
        if (t - birth < SPLASH_LIFE + 0.02 && birth > 0) continue;
        if (i >= active) { if (birth > 0) { for (let v = 0; v < 4; v++) arr[o + v * 4 + 3] = -1e5; dirty = true; } continue; }
        if (budget <= 0) continue;
        budget--;
        // random spot in a disc, biased toward the camera; ground = first solid/water block from far above
        const ang = this.rnd() * Math.PI * 2, r = 0.9 + Math.sqrt(this.rnd()) * 15;
        const x = p.x + Math.cos(ang) * r, z = p.z + Math.sin(ang) * r;
        const y = chunks.scanColumn(x, z, Math.min(250, Math.floor(p.y) + 70), Math.max(0, Math.floor(p.y) - 40));
        let b = -1e5, sy = 0;
        if (y >= 0) { b = t + this.rnd() * 0.35; sy = y + (chunks.scanId === B.WATER ? 0.88 : 1); }
        for (let v = 0; v < 4; v++) { const w = o + v * 4; arr[w] = x; arr[w + 1] = sy; arr[w + 2] = z; arr[w + 3] = b; }
        dirty = true;
      }
      if (dirty) info.needsUpdate = true;
    }
    void dt;
  }

  private parkSplashes() {
    const info = this.splashInfo; if (!info) return;
    const arr = info.array as Float32Array;
    let dirty = false;
    for (let i = 3; i < arr.length; i += 4) if (arr[i] > 0) { arr[i] = -1e5; dirty = true; }
    if (dirty) info.needsUpdate = true;
  }

  dispose() {
    this.rainMesh?.geometry.dispose(); this.splashMesh?.geometry.dispose();
    this.rainMat.dispose(); this.splashMat.dispose();
  }
}

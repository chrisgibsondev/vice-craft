/**
 * HDR post pipeline (medium+ quality, or low with bloom on).
 *
 *   1. opaque pass → HDR target (colour + depth texture)
 *   2. copy pass → colour + linear view depth (refraction / SSR source for the water shader)
 *   3. water + glass pass (camera layer 1) on top of the HDR target
 *   4. SSAO (half res), god rays (half res, radial march toward the sun), bloom mip chain
 *   5. composite: AO, bloom, light shafts, underwater tint, colour grading, AgX, vignette, dither
 *   6. depth-aware FXAA → screen (geometry edges only, pixel textures stay crisp)
 *
 * All passes are RawShaderMaterials so three's own tone mapping / colour conversion never
 * double-applies; the final pass writes sRGB directly to the canvas.
 */
import * as THREE from 'three';

export interface PostFeatures {
  /** water refraction / depth colour / foam / SSR (needs the copy + split passes) */
  hqWater: boolean;
  bloom: boolean;
  /** 0 off, 1 = 8 samples, 2 = 16 samples */
  ssao: number;
  godRays: boolean;
  fxaa: boolean;
}

const VERT = /* glsl */ `
  in vec3 position;
  out vec2 vUv;
  void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const HEAD = /* glsl */ `
  precision highp float;
  precision highp sampler2D;
  in vec2 vUv;
  out vec4 fragColor;
  uniform float cNear; uniform float cFar;
  float linZ(float d) { float z = d * 2.0 - 1.0; return 2.0 * cNear * cFar / (cFar + cNear - z * (cFar - cNear)); }
`;

function raw(frag: string, uniforms: Record<string, THREE.IUniform>, defines: Record<string, number> = {}) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: HEAD + frag, uniforms, defines,
    depthTest: false, depthWrite: false, blending: THREE.NoBlending,
  });
}

const COPY = /* glsl */ `
  uniform sampler2D tColor; uniform sampler2D tDepth;
  void main() { fragColor = vec4(texture(tColor, vUv).rgb, linZ(texture(tDepth, vUv).r)); }
`;

const SSAO = /* glsl */ `
  uniform sampler2D tDepth; uniform vec2 px; uniform vec2 projScale; uniform float radius;
  vec3 viewPos(vec2 uv) { float z = linZ(texture(tDepth, uv).r); return vec3((uv * 2.0 - 1.0) * z / projScale, -z); }
  float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
  void main() {
    float d = texture(tDepth, vUv).r;
    if (d >= 0.99999) { fragColor = vec4(1.0); return; }
    vec3 P = viewPos(vUv);
    // normal from the smaller depth difference on each axis (avoids halos at silhouettes)
    vec3 pr = viewPos(vUv + vec2(px.x, 0.0)), pl = viewPos(vUv - vec2(px.x, 0.0));
    vec3 pu = viewPos(vUv + vec2(0.0, px.y)), pd = viewPos(vUv - vec2(0.0, px.y));
    vec3 dx = abs(pr.z - P.z) < abs(P.z - pl.z) ? pr - P : P - pl;
    vec3 dy = abs(pu.z - P.z) < abs(P.z - pd.z) ? pu - P : P - pd;
    vec3 N = normalize(cross(dx, dy));
    float a0 = ign(gl_FragCoord.xy) * 6.2831853;
    vec3 rv = vec3(cos(a0), sin(a0), 0.0);
    vec3 T = normalize(rv - N * dot(rv, N)); vec3 B = cross(N, T);
    float occ = 0.0;
    for (int i = 0; i < SAMPLES; i++) {
      float fi = (float(i) + 0.5) / float(SAMPLES);
      float th = float(i) * 2.399963;
      float r = sqrt(fi);
      vec3 k = vec3(cos(th) * r, sin(th) * r, sqrt(max(0.0, 1.0 - fi)));
      k *= mix(0.15, 1.0, fi * fi);
      vec3 S = P + (T * k.x + B * k.y + N * k.z) * radius;
      vec2 suv = (S.xy / -S.z) * projScale * 0.5 + 0.5;
      float sz = linZ(texture(tDepth, suv).r);
      float range = smoothstep(0.0, 1.0, radius / max(abs(-S.z - sz), 1e-3));
      occ += step(sz, -S.z - 0.04) * range;
    }
    float ao = 1.0 - occ / float(SAMPLES);
    ao = mix(ao, 1.0, smoothstep(60.0, 110.0, -P.z));
    fragColor = vec4(ao, ao, ao, 1.0);
  }
`;

const RAYS = /* glsl */ `
  uniform sampler2D tDepth; uniform sampler2D tColor; uniform vec2 sunUv; uniform float aspect;
  void main() {
    vec2 delta = (vUv - sunUv) / float(STEPS) * 0.92;
    vec2 c = vUv;
    float decay = 1.0, sum = 0.0;
    float j = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    c -= delta * j;
    for (int i = 0; i < STEPS; i++) {
      c -= delta;
      // sky = no depth AND alpha 1 (the far-city LOD pass and clouds write alpha 0 and leave no depth)
      float sky = step(0.99999, texture(tDepth, c).r) * step(0.5, texture(tColor, c).a);
      vec2 o = (c - sunUv) * vec2(aspect, 1.0);
      float glow = max(0.0, 1.0 - length(o) * 2.2);
      sum += sky * glow * glow * decay;
      decay *= 0.962;
    }
    fragColor = vec4(vec3(sum / float(STEPS)), 1.0);
  }
`;

const PREFILTER = /* glsl */ `
  uniform sampler2D tColor; uniform vec2 px; uniform float threshold;
  void main() {
    vec3 c = texture(tColor, vUv + px * vec2(-0.5, -0.5)).rgb + texture(tColor, vUv + px * vec2(0.5, -0.5)).rgb
           + texture(tColor, vUv + px * vec2(-0.5, 0.5)).rgb + texture(tColor, vUv + px * vec2(0.5, 0.5)).rgb;
    c *= 0.25;
    c = min(c, vec3(40.0));
    float br = max(c.r, max(c.g, c.b));
    float soft = clamp(br - threshold + 0.5, 0.0, 1.0); soft = soft * soft * 0.5;
    float w = max(soft, br - threshold) / max(br, 1e-4);
    fragColor = vec4(c * w, 1.0);
  }
`;
const DOWN = /* glsl */ `
  uniform sampler2D tSrc; uniform vec2 px;
  void main() {
    vec3 c = texture(tSrc, vUv).rgb * 4.0;
    c += texture(tSrc, vUv + px * vec2(-1.0, -1.0)).rgb + texture(tSrc, vUv + px * vec2(1.0, -1.0)).rgb;
    c += texture(tSrc, vUv + px * vec2(-1.0, 1.0)).rgb + texture(tSrc, vUv + px * vec2(1.0, 1.0)).rgb;
    fragColor = vec4(c / 8.0, 1.0);
  }
`;
const UP = /* glsl */ `
  uniform sampler2D tSrc; uniform sampler2D tBase; uniform vec2 px;
  void main() {
    vec3 c = texture(tSrc, vUv + px * vec2(-2.0, 0.0)).rgb + texture(tSrc, vUv + px * vec2(2.0, 0.0)).rgb
           + texture(tSrc, vUv + px * vec2(0.0, -2.0)).rgb + texture(tSrc, vUv + px * vec2(0.0, 2.0)).rgb;
    c += (texture(tSrc, vUv + px * vec2(-1.0, -1.0)).rgb + texture(tSrc, vUv + px * vec2(1.0, -1.0)).rgb
        + texture(tSrc, vUv + px * vec2(-1.0, 1.0)).rgb + texture(tSrc, vUv + px * vec2(1.0, 1.0)).rgb) * 2.0;
    fragColor = vec4(texture(tBase, vUv).rgb + c / 12.0, 1.0);
  }
`;

const COMPOSITE = /* glsl */ `
  uniform sampler2D tColor; uniform sampler2D tBloom; uniform sampler2D tAO; uniform sampler2D tRays; uniform sampler2D tDepth;
  uniform float bloomStrength; uniform float aoStrength; uniform vec3 raysColor; uniform float underwater; uniform float time;
  uniform float exposure; uniform vec3 shadowTint; uniform vec3 highTint; uniform float saturation; uniform float contrast;
  uniform float vignette; uniform vec2 aoPx; uniform float lookPower; uniform float lookSat;

  const mat3 SRGB_TO_2020 = mat3(vec3(0.6274, 0.0691, 0.0164), vec3(0.3293, 0.9195, 0.0880), vec3(0.0433, 0.0113, 0.8956));
  const mat3 R2020_TO_SRGB = mat3(vec3(1.6605, -0.1246, -0.0182), vec3(-0.5876, 1.1329, -0.1006), vec3(-0.0728, -0.0083, 1.1187));
  vec3 agxContrast(vec3 x) { vec3 x2 = x * x; vec3 x4 = x2 * x2;
    return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232; }
  vec3 agx(vec3 color) {
    const mat3 inset = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995), vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903), vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
    const mat3 outset = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826), vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
    const float minEv = -12.47393, maxEv = 4.026069;
    color = SRGB_TO_2020 * color;
    color = inset * color;
    color = clamp((log2(max(color, 1e-10)) - minEv) / (maxEv - minEv), 0.0, 1.0);
    color = agxContrast(color);
    // AgX "look": a touch of punch (power) and saturation in the log/sigmoid domain
    float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
    color = pow(max(color, 0.0), vec3(lookPower));
    color = max(lum + lookSat * (color - lum), 0.0);
    color = outset * color;
    color = pow(max(vec3(0.0), color), vec3(2.2));
    return clamp(R2020_TO_SRGB * color, 0.0, 1.0);
  }
  vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }

  void main() {
    vec2 uv = vUv;
    if (underwater > 0.5) uv += vec2(sin(uv.y * 40.0 + time * 2.0), cos(uv.x * 34.0 + time * 1.7)) * 0.0025;
    vec3 col = texture(tColor, uv).rgb;
    #ifdef USE_AO
      // depth-aware 2×2 tent over the half-res AO
      float zc = linZ(texture(tDepth, uv).r);
      float aw = 0.0, ao = 0.0;
      for (int i = 0; i < 4; i++) {
        vec2 o = vec2(i == 1 || i == 3 ? 1.0 : -1.0, i >= 2 ? 1.0 : -1.0) * aoPx * 0.75;
        float zs = linZ(texture(tDepth, uv + o).r);
        float w = 1.0 / (0.05 + abs(zs - zc));
        ao += texture(tAO, uv + o).r * w; aw += w;
      }
      ao /= aw;
      col *= mix(1.0, ao, aoStrength);
    #endif
    #ifdef USE_BLOOM
      col += texture(tBloom, uv).rgb * bloomStrength;
    #endif
    #ifdef USE_RAYS
      col += texture(tRays, uv).rgb * raysColor;
    #endif
    if (underwater > 0.5) col *= vec3(0.55, 0.88, 1.0);
    // colour grading (scene-referred): exposure, split toning, saturation
    col *= exposure;
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col *= mix(shadowTint, highTint, smoothstep(0.02, 0.9, l));
    l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = max(mix(vec3(l), col, saturation), 0.0);
    col = agx(col);
    // gentle filmic contrast around mid grey in display space
    col = clamp((col - 0.18) * contrast + 0.18, 0.0, 1.0);
    vec2 vq = vUv - 0.5;
    col *= 1.0 - vignette * smoothstep(0.25, 0.85, dot(vq, vq) * 2.2);
    col = toSRGB(col);
    // dither away banding in the sky gradient
    col += (fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)) + time * 0.61)) - 0.5) / 255.0;
    fragColor = vec4(col, 1.0);
  }
`;

const FXAA = /* glsl */ `
  uniform sampler2D tSrc; uniform sampler2D tDepth; uniform vec2 px;
  float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
  void main() {
    vec3 cM = texture(tSrc, vUv).rgb;
    // only anti-alias geometric edges (depth discontinuities); pixel-art textures stay crisp
    float z = linZ(texture(tDepth, vUv).r);
    float z1 = linZ(texture(tDepth, vUv + vec2(px.x, 0.0)).r), z2 = linZ(texture(tDepth, vUv - vec2(px.x, 0.0)).r);
    float z3 = linZ(texture(tDepth, vUv + vec2(0.0, px.y)).r), z4 = linZ(texture(tDepth, vUv - vec2(0.0, px.y)).r);
    float dz = max(max(abs(z1 - z), abs(z2 - z)), max(abs(z3 - z), abs(z4 - z)));
    if (dz < z * 0.015 + 0.02) { fragColor = vec4(cM, 1.0); return; }
    vec3 cNW = texture(tSrc, vUv + px * vec2(-1.0, -1.0)).rgb, cNE = texture(tSrc, vUv + px * vec2(1.0, -1.0)).rgb;
    vec3 cSW = texture(tSrc, vUv + px * vec2(-1.0, 1.0)).rgb, cSE = texture(tSrc, vUv + px * vec2(1.0, 1.0)).rgb;
    float lNW = luma(cNW), lNE = luma(cNE), lSW = luma(cSW), lSE = luma(cSE), lM = luma(cM);
    float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
    float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
    vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
    float red = max((lNW + lNE + lSW + lSE) * 0.03125, 1.0 / 128.0);
    float rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + red);
    dir = clamp(dir * rcpMin, -8.0, 8.0) * px;
    vec3 a = 0.5 * (texture(tSrc, vUv + dir * (1.0 / 3.0 - 0.5)).rgb + texture(tSrc, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
    vec3 b = a * 0.5 + 0.25 * (texture(tSrc, vUv - dir * 0.5).rgb + texture(tSrc, vUv + dir * 0.5).rgb);
    float lb = luma(b);
    fragColor = vec4((lb < lMin || lb > lMax) ? a : b, 1.0);
  }
`;

function rt(w: number, h: number, type: THREE.TextureDataType = THREE.HalfFloatType, depth = false) {
  const t = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: depth, stencilBuffer: false,
  });
  t.texture.generateMipmaps = false;
  return t;
}

export interface GradeParams { exposure: number; shadowTint: THREE.Color; highTint: THREE.Color; saturation: number; contrast: number; vignette: number; lookPower: number; lookSat: number }

export class PostPipeline {
  features: PostFeatures = { hqWater: true, bloom: true, ssao: 0, godRays: false, fxaa: false };
  private scene: THREE.WebGLRenderTarget;
  private copy: THREE.WebGLRenderTarget;
  private ldr: THREE.WebGLRenderTarget;
  private ao: THREE.WebGLRenderTarget;
  private rays: THREE.WebGLRenderTarget;
  private bloomDown: THREE.WebGLRenderTarget[] = [];
  private bloomUp: THREE.WebGLRenderTarget[] = [];
  private quad: THREE.Mesh;
  private quadScene = new THREE.Scene();
  private quadCam = new THREE.Camera();
  private near = { value: 0.1 };
  private far = { value: 1000 };
  private mCopy: THREE.RawShaderMaterial;
  private mSsao: THREE.RawShaderMaterial;
  private mRays: THREE.RawShaderMaterial;
  private mPre: THREE.RawShaderMaterial;
  private mDown: THREE.RawShaderMaterial;
  private mUp: THREE.RawShaderMaterial;
  private mComp: THREE.RawShaderMaterial;
  private mFxaa: THREE.RawShaderMaterial;
  private w = 1; private h = 1;
  /** world-space light direction for the god rays + its colour × strength (set per frame) */
  readonly raysDir = new THREE.Vector3(0, 1, 0);
  readonly raysColor = new THREE.Color(0, 0, 0);
  bloomStrength = 0.6;
  aoStrength = 0.6;
  underwater = 0;
  time = 0;
  readonly grade: GradeParams = { exposure: 1, shadowTint: new THREE.Color(1, 1, 1), highTint: new THREE.Color(1, 1, 1), saturation: 1.08, contrast: 1.04, vignette: 0.22, lookPower: 1.2, lookSat: 1.25 };

  constructor(private renderer: THREE.WebGLRenderer) {
    const depthTex = new THREE.DepthTexture(1, 1, THREE.FloatType);
    depthTex.format = THREE.DepthFormat;
    this.scene = rt(1, 1, THREE.HalfFloatType, true);
    this.scene.depthTexture = depthTex;
    this.copy = rt(1, 1);
    this.ldr = rt(1, 1, THREE.UnsignedByteType);
    this.ao = rt(1, 1, THREE.UnsignedByteType);
    this.rays = rt(1, 1);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.quad = new THREE.Mesh(g);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    const N = this.near, F = this.far;
    const dT = { value: depthTex };
    this.mCopy = raw(COPY, { tColor: { value: this.scene.texture }, tDepth: dT, cNear: N, cFar: F });
    this.mSsao = raw(SSAO, { tDepth: dT, px: { value: new THREE.Vector2() }, projScale: { value: new THREE.Vector2(1, 1) }, radius: { value: 1.1 }, cNear: N, cFar: F }, { SAMPLES: 8 });
    this.mRays = raw(RAYS, { tDepth: dT, tColor: { value: this.scene.texture }, sunUv: { value: new THREE.Vector2() }, aspect: { value: 1 }, cNear: N, cFar: F }, { STEPS: 40 });
    this.mPre = raw(PREFILTER, { tColor: { value: this.scene.texture }, px: { value: new THREE.Vector2() }, threshold: { value: 1.1 }, cNear: N, cFar: F });
    this.mDown = raw(DOWN, { tSrc: { value: null }, px: { value: new THREE.Vector2() }, cNear: N, cFar: F });
    this.mUp = raw(UP, { tSrc: { value: null }, tBase: { value: null }, px: { value: new THREE.Vector2() }, cNear: N, cFar: F });
    this.mComp = raw(COMPOSITE, {
      tColor: { value: this.scene.texture }, tBloom: { value: null }, tAO: { value: this.ao.texture }, tRays: { value: this.rays.texture }, tDepth: dT,
      bloomStrength: { value: 0.6 }, aoStrength: { value: 0.6 }, raysColor: { value: this.raysColor }, underwater: { value: 0 }, time: { value: 0 },
      exposure: { value: 1 }, shadowTint: { value: this.grade.shadowTint }, highTint: { value: this.grade.highTint }, saturation: { value: 1 }, contrast: { value: 1 },
      vignette: { value: 0.2 }, aoPx: { value: new THREE.Vector2() }, lookPower: { value: 1.2 }, lookSat: { value: 1.25 }, cNear: N, cFar: F,
    });
    this.mFxaa = raw(FXAA, { tSrc: { value: this.ldr.texture }, tDepth: dT, px: { value: new THREE.Vector2() }, cNear: N, cFar: F });
  }

  /** texture holding the opaque scene colour (rgb) + linear view depth (a), for the water shader */
  get sceneCopy() { return this.copy.texture; }

  setFeatures(f: PostFeatures) {
    this.features = { ...f };
    const def = (m: THREE.RawShaderMaterial, k: string, on: boolean) => {
      if (on && !(k in m.defines)) { m.defines[k] = 1; m.needsUpdate = true; }
      if (!on && k in m.defines) { delete m.defines[k]; m.needsUpdate = true; }
    };
    def(this.mComp, 'USE_BLOOM', f.bloom);
    def(this.mComp, 'USE_AO', f.ssao > 0);
    def(this.mComp, 'USE_RAYS', f.godRays);
    const samples = f.ssao >= 2 ? 16 : 8;
    if (this.mSsao.defines.SAMPLES !== samples) { this.mSsao.defines.SAMPLES = samples; this.mSsao.needsUpdate = true; }
    const steps = f.ssao >= 2 ? 56 : 40;
    if (this.mRays.defines.STEPS !== steps) { this.mRays.defines.STEPS = steps; this.mRays.needsUpdate = true; }
    this.setSize(this.w, this.h);
  }

  /** drawing-buffer size in pixels */
  setSize(w: number, h: number) {
    this.w = w; this.h = h;
    this.scene.setSize(w, h);
    this.copy.setSize(this.features.hqWater ? w : 1, this.features.hqWater ? h : 1);
    this.ldr.setSize(this.features.fxaa ? w : 1, this.features.fxaa ? h : 1);
    const hw = Math.max(1, w >> 1), hh = Math.max(1, h >> 1);
    this.ao.setSize(this.features.ssao ? hw : 1, this.features.ssao ? hh : 1);
    this.rays.setSize(this.features.godRays ? hw : 1, this.features.godRays ? hh : 1);
    // bloom chain: 1/2 … 1/32
    const levels = this.features.bloom ? 5 : 0;
    while (this.bloomDown.length > levels) { this.bloomDown.pop()!.dispose(); this.bloomUp.pop()!.dispose(); }
    while (this.bloomDown.length < levels) { this.bloomDown.push(rt(1, 1)); this.bloomUp.push(rt(1, 1)); }
    for (let i = 0; i < levels; i++) {
      const s = 2 << i;
      this.bloomDown[i].setSize(Math.max(1, Math.round(w / s)), Math.max(1, Math.round(h / s)));
      this.bloomUp[i].setSize(Math.max(1, Math.round(w / s)), Math.max(1, Math.round(h / s)));
    }
  }

  private pass(m: THREE.Material, target: THREE.WebGLRenderTarget | null) {
    this.quad.material = m;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  /**
   * scene passes + post. `far` (optional) is drawn first with its own camera (far-city LOD, sky,
   * far clouds); the depth buffer is then cleared so the voxel world never depth-fights with it.
   */
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, translucentLayer: number, far?: { scene: THREE.Object3D; camera: THREE.Camera } | null) {
    const r = this.renderer;
    const f = this.features;
    this.near.value = camera.near; this.far.value = camera.far;
    const mask = camera.layers.mask;
    const prevAutoClear = r.autoClear;
    r.autoClear = true;
    // 1–3: scene passes
    r.setRenderTarget(this.scene);
    if (far) {
      r.render(far.scene, far.camera);
      r.autoClear = false;
      r.clearDepth();
    }
    if (f.hqWater) {
      camera.layers.set(0);
      r.render(scene, camera);
      this.pass(this.mCopy, this.copy);
      camera.layers.set(translucentLayer);
      r.autoClear = false;
      r.setRenderTarget(this.scene);
      r.render(scene, camera);
      r.autoClear = true;
    } else {
      camera.layers.set(0); camera.layers.enable(translucentLayer);
      r.render(scene, camera);
    }
    camera.layers.mask = mask | (1 << translucentLayer) | 1;
    // 4: SSAO
    if (f.ssao) {
      const u = this.mSsao.uniforms;
      u.px.value.set(1 / this.w, 1 / this.h);
      u.projScale.value.set(camera.projectionMatrix.elements[0], camera.projectionMatrix.elements[5]);
      this.pass(this.mSsao, this.ao);
      this.mComp.uniforms.aoPx.value.set(2 / this.w, 2 / this.h);
    }
    // god rays toward the sun/moon when it is in front of the camera
    let raysOn = false;
    if (f.godRays && this.raysColor.r + this.raysColor.g + this.raysColor.b > 0.003) {
      const p = _v.copy(camera.position).addScaledVector(this.raysDir, 500).project(camera);
      const facing = _f.set(0, 0, -1).applyQuaternion(camera.quaternion).dot(this.raysDir);
      if (facing > 0.05 && Math.abs(p.x) < 1.8 && Math.abs(p.y) < 1.8) {
        raysOn = true;
        const u = this.mRays.uniforms;
        u.sunUv.value.set(p.x * 0.5 + 0.5, p.y * 0.5 + 0.5);
        u.aspect.value = this.w / this.h;
        this.pass(this.mRays, this.rays);
      }
    }
    // bloom mip chain
    if (f.bloom && this.bloomDown.length) {
      const d = this.bloomDown, up = this.bloomUp;
      this.mPre.uniforms.px.value.set(1 / this.w, 1 / this.h);
      this.pass(this.mPre, d[0]);
      for (let i = 1; i < d.length; i++) {
        this.mDown.uniforms.tSrc.value = d[i - 1].texture;
        this.mDown.uniforms.px.value.set(1 / d[i - 1].width, 1 / d[i - 1].height);
        this.pass(this.mDown, d[i]);
      }
      let src = d[d.length - 1];
      for (let i = d.length - 2; i >= 0; i--) {
        this.mUp.uniforms.tSrc.value = src.texture;
        this.mUp.uniforms.tBase.value = d[i].texture;
        this.mUp.uniforms.px.value.set(1 / src.width, 1 / src.height);
        this.pass(this.mUp, up[i]);
        src = up[i];
      }
      this.mComp.uniforms.tBloom.value = src.texture;
    }
    // composite (+ FXAA) → screen
    const cu = this.mComp.uniforms;
    cu.bloomStrength.value = this.bloomStrength;
    cu.aoStrength.value = this.aoStrength;
    cu.underwater.value = this.underwater;
    cu.time.value = this.time;
    cu.exposure.value = this.grade.exposure * r.toneMappingExposure;
    cu.saturation.value = this.grade.saturation;
    cu.contrast.value = this.grade.contrast;
    cu.vignette.value = this.grade.vignette;
    cu.lookPower.value = this.grade.lookPower;
    cu.lookSat.value = this.grade.lookSat;
    if (!raysOn && 'USE_RAYS' in this.mComp.defines) cu.raysColor.value = _black; else cu.raysColor.value = this.raysColor;
    if (f.fxaa) {
      this.pass(this.mComp, this.ldr);
      this.mFxaa.uniforms.px.value.set(1 / this.w, 1 / this.h);
      this.pass(this.mFxaa, null);
    } else {
      this.pass(this.mComp, null);
    }
    r.autoClear = prevAutoClear;
  }

  dispose() {
    for (const t of [this.scene, this.copy, this.ldr, this.ao, this.rays, ...this.bloomDown, ...this.bloomUp]) t.dispose();
    this.scene.depthTexture?.dispose();
    for (const m of [this.mCopy, this.mSsao, this.mRays, this.mPre, this.mDown, this.mUp, this.mComp, this.mFxaa]) m.dispose();
    this.quad.geometry.dispose();
  }
}

const _v = new THREE.Vector3();
const _f = new THREE.Vector3();
const _black = new THREE.Color(0, 0, 0);

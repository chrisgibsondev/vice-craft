/**
 * Custom block + water shaders with shared lighting/fog uniforms driven by time of day.
 *
 * Block shader: hemisphere + sun lighting with real-time sun/moon shadows (three's PCF
 * directional shadow, sampled manually), cloud shadows, per-vertex AO, coloured block
 * light baked by the mesher, wind sway for foliage, glossy/mirror specular for glass,
 * chrome and windows, emissive glow, and aerial-perspective fog that dissolves into the sky.
 *
 * Water shader: multi-octave waves with pixel-snapped normals, Fresnel sky reflection,
 * sun glint + sparkle, and (HQ, when the HDR pipeline supplies the opaque scene colour and
 * depth) refraction, depth-based absorption (turquoise shallows → deep blue), shoreline
 * foam and screen-space reflections.
 */
import * as THREE from 'three';
import { SEA_LEVEL } from '@blockshore/shared';
import { ATMOS_PARS, SWAY_FN, WAVES_FN } from './fx/atmosphere';
import { TILE } from './atlas';

export interface LightingUniforms {
  /** main light direction (sun by day, moon by night) */
  sunDir: { value: THREE.Vector3 };
  sunColor: { value: THREE.Color };
  ambSky: { value: THREE.Color };
  ambGround: { value: THREE.Color };
  fogColor: { value: THREE.Color };
  fogNear: { value: number };
  fogFar: { value: number };
  night: { value: number };
  time: { value: number };
  /** camera position for the far-LOD fade */
  camPos: { value: THREE.Vector3 };
  /** one dynamic point light for blocks (muzzle flashes): xyz + radius (0 = off), colour × intensity */
  dynPos: { value: THREE.Vector4 };
  dynCol: { value: THREE.Color };
  /** one dynamic spot light for blocks (your own headlights at night): xyz + range (0 = off), direction, colour */
  headPos: { value: THREE.Vector4 };
  headDir: { value: THREE.Vector3 };
  headCol: { value: THREE.Color };
  // ── atmosphere (sky.ts writes these) ──
  /** actual sun direction (may be below the horizon) */
  sunTrue: { value: THREE.Vector3 };
  moonDir: { value: THREE.Vector3 };
  zenith: { value: THREE.Color };
  horizon: { value: THREE.Color };
  /** 0..1 sunrise/sunset strength */
  golden: { value: number };
  /** exponential aerial-perspective density */
  fogDensity: { value: number };
  /** 1 while the camera is under water */
  underwater: { value: number };
  waterFog: { value: THREE.Color };
  /** multiplier for the baked block light (lamps/neon), higher at night */
  blockLight: { value: number };
  /** cloud coverage texture for cloud shadows + its placement: originX, originZ, 1/tileSize, cloudY */
  cloudMap: { value: THREE.Texture | null };
  cloudXf: { value: THREE.Vector4 };
  /** far-city LOD range in metres (0 = off). When on, fogNear..fogFar is the dither band where the
   *  voxel chunks hand over to the LOD pass, and the final dissolve to the sky happens near lodFar */
  lodFar: { value: number };
  /** 1 = HDR pipeline (far-pass geometry and clouds mark themselves with alpha 0), 0 = direct to canvas */
  rayMask: { value: number };
  /** weather: cloud-cover darkening 0..1, wet-surface amount 0..1 (builds in rain, dries out), wind 0..1 (foliage sway) */
  overcast: { value: number };
  wetness: { value: number };
  windAmt: { value: number };
}

export function makeLighting(): LightingUniforms {
  return {
    sunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
    sunColor: { value: new THREE.Color(1, 0.95, 0.85) },
    ambSky: { value: new THREE.Color(0.55, 0.62, 0.75) },
    ambGround: { value: new THREE.Color(0.32, 0.3, 0.28) },
    fogColor: { value: new THREE.Color(0.7, 0.82, 0.95) },
    fogNear: { value: 120 },
    fogFar: { value: 240 },
    night: { value: 0 },
    time: { value: 0 },
    camPos: { value: new THREE.Vector3() },
    dynPos: { value: new THREE.Vector4(0, 0, 0, 0) },
    dynCol: { value: new THREE.Color(0, 0, 0) },
    headPos: { value: new THREE.Vector4(0, 0, 0, 0) },
    headDir: { value: new THREE.Vector3(0, 0, -1) },
    headCol: { value: new THREE.Color(0, 0, 0) },
    sunTrue: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
    moonDir: { value: new THREE.Vector3(-0.4, -0.8, -0.3).normalize() },
    zenith: { value: new THREE.Color(0.1, 0.3, 0.78) },
    horizon: { value: new THREE.Color(0.62, 0.78, 0.95) },
    golden: { value: 0 },
    fogDensity: { value: 0.002 },
    underwater: { value: 0 },
    waterFog: { value: new THREE.Color(0.02, 0.16, 0.22) },
    blockLight: { value: 0.4 },
    cloudMap: { value: null },
    cloudXf: { value: new THREE.Vector4(0, 0, 1 / 1536, 160) },
    lodFar: { value: 0 },
    rayMask: { value: 0 },
    overcast: { value: 0 },
    wetness: { value: 0 },
    windAmt: { value: 0.18 },
  };
}

/** three's light uniforms (needed so the custom shaders can sample the sun shadow map) merged with ours by reference */
function litUniforms(L: LightingUniforms, extra: Record<string, THREE.IUniform>) {
  return { ...THREE.UniformsUtils.clone(THREE.UniformsLib.lights), ...L, ...extra } as Record<string, THREE.IUniform>;
}

const SHADOW_VERT = /* glsl */ `
  #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
    vDirectionalShadowCoord[0] = directionalShadowMatrix[0] * (wp + vec4(normal * directionalLightShadows[0].shadowNormalBias, 0.0));
  #endif
`;
const SHADOW_FRAG = /* glsl */ `
  float bsShadow() {
    #if defined(USE_SHADOWMAP) && NUM_DIR_LIGHT_SHADOWS > 0
      DirectionalLightShadow s = directionalLightShadows[0];
      float sh = getShadow(directionalShadowMap[0], s.shadowMapSize, s.shadowIntensity, s.shadowBias, s.shadowRadius, vDirectionalShadowCoord[0]);
      // fade out towards the edge of the shadow map instead of a hard line
      vec3 sc = vDirectionalShadowCoord[0].xyz / vDirectionalShadowCoord[0].w;
      vec2 e = smoothstep(0.0, 0.08, sc.xy) * smoothstep(1.0, 0.92, sc.xy);
      return mix(1.0, sh, e.x * e.y);
    #else
      return 1.0;
    #endif
  }
  #ifdef CLOUD_SHADOWS
  uniform sampler2D cloudMap; uniform vec4 cloudXf;
  float bsCloudShadow(vec3 wp) {
    vec3 sd = sunTrue;
    if (sd.y < 0.05) return 1.0;
    vec2 p = wp.xz + sd.xz / sd.y * (cloudXf.w - wp.y);
    float c = texture2D(cloudMap, (p - cloudXf.xy) * cloudXf.z).r;
    return 1.0 - c * 0.55 * smoothstep(0.05, 0.25, sd.y);
  }
  #endif
`;

const blockVert = /* glsl */ `
  #include <common>
  #include <shadowmap_pars_vertex>
  attribute vec2 light;
  attribute vec4 extra;
  attribute vec2 tile;
  uniform float time;
  varying vec2 vUv;
  flat varying float vLayer;
  flat varying float vVar;
  varying float vAo;
  varying float vEmi;
  varying vec3 vN;
  varying float vDepth;
  varying vec3 vWorld;
  varying vec3 vBl;
  varying float vSpec;
  varying float vSway;
  ${SWAY_FN}
  void main() {
    // tile = (layer, variant info), uv continuous in layer repeats (see mesher.ts)
    vLayer = tile.x;
    vVar = tile.y;
    vUv = uv;
    vAo = light.x;
    vEmi = light.y;
    vN = normal;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    float code = floor(extra.a * 255.0 + 0.5);
    float tier = floor(code / 64.0);
    float sway = (code - tier * 64.0) / 63.0;
    #ifdef SWAY
      if (sway > 0.0) wp.xyz += bsSway(wp.xyz, time) * sway;
    #endif
    vSpec = tier; vSway = sway;
    vBl = extra.rgb;
    vWorld = wp.xyz;
    ${SHADOW_VERT}
    vec4 mv = viewMatrix * wp;
    vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;

const blockFrag = /* glsl */ `
  #include <common>
  #include <packing>
  #include <shadowmap_pars_fragment>
  precision highp sampler2DArray;
  uniform sampler2DArray map;
  #ifdef MATERIAL_MAP
    uniform sampler2DArray matMap;
  #endif
  uniform vec3 sunDir; uniform vec3 ambSky; uniform vec3 ambGround;
  uniform float alphaTest; uniform float opacity; uniform float blockLight;
  uniform vec4 dynPos; uniform vec3 dynCol; uniform vec4 headPos; uniform vec3 headDir; uniform vec3 headCol;
  varying vec2 vUv; flat varying float vLayer; flat varying float vVar; varying float vAo; varying float vEmi; varying vec3 vN; varying float vDepth; varying vec3 vWorld;
  varying vec3 vBl; varying float vSpec; varying float vSway;
  ${ATMOS_PARS}
  ${SHADOW_FRAG}
  float bsVN(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    float a = fract(sin(dot(i, vec2(127.1, 311.7))) * 43758.5453);
    float b = fract(sin(dot(i + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5453);
    float c = fract(sin(dot(i + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
    float d = fract(sin(dot(i + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5453);
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  uint bsHashU(ivec3 p, uint f) {
    uint h = (uint(p.x) * 0x27d4eb2du) ^ (uint(p.y) * 0x165667b1u) ^ (uint(p.z) * 0x9e3779b1u) ^ (f * 0x85ebca77u);
    h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
    h = (h ^ (h >> 12u)) * 0x297a2d39u;
    return h ^ (h >> 15u);
  }
  void main() {
    // far-city LOD: the voxel world dithers out across the fog band (the LOD pass shows behind it)
    if (lodFar > 0.0) {
      float hd = length(vWorld.xz - camPos.xz);
      float fade = smoothstep(fogNear, fogFar, hd);
      if (fade > 0.0 && fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) < fade) discard;
    }
    float layer = vLayer;
    if (vVar > 0.5) {
      // seamless ground variant per REPEAT cell (world-position hash; works across merged quads)
      float rep = floor(vVar / 16384.0);
      float rest = vVar - rep * 16384.0;
      float nv = floor(rest / 4096.0);
      float v0 = rest - nv * 4096.0;
      vec3 nn = normalize(vN);
      ivec3 cell = ivec3(floor(floor(vWorld - nn * 0.5) / (rep + 1.0)));
      uint h = bsHashU(cell, abs(nn.y) > 0.5 ? 0u : 1u) % uint(nv + 1.0);
      if (h > 0u) layer = v0 + float(h) - 1.0;
    }
    vec3 tc = vec3(vUv, layer);
    vec4 tex = texture(map, tc);
    if (alphaTest > 0.3) {
      // keep cutout foliage dense in the distance: mip averaging thins alpha, so scale it back up
      vec2 dx = dFdx(vUv * ${TILE}.0), dy = dFdy(vUv * ${TILE}.0);
      float lod = 0.5 * log2(max(max(dot(dx, dx), dot(dy, dy)), 1e-8));
      tex.a *= 1.0 + max(lod, 0.0) * 0.28;
    }
    if (tex.a < alphaTest) discard;
    tex.rgb *= 1.0 - wetness * 0.16; // damp, darker surfaces after rain
    vec3 ng = normalize(vN);
    if (!gl_FrontFacing) ng = -ng;
    vec3 n = ng;
    vec3 V = normalize(camPos - vWorld);
    float rough = 0.85, gloss = 1.0, wet = 0.0;
    #ifdef MATERIAL_MAP
      vec4 mt = texture(matMap, tc);
      rough = mt.b; gloss = mt.a;
      // tangent frame from screen-space derivatives (faces are axis-aligned; handles rotated UVs)
      vec3 dp1 = dFdx(vWorld), dp2 = dFdy(vWorld);
      vec2 du1 = dFdx(vUv), du2 = dFdy(vUv);
      vec3 dp2p = cross(dp2, ng), dp1p = cross(ng, dp1);
      vec3 T = dp2p * du1.x + dp1p * du2.x, Bt = dp2p * du1.y + dp1p * du2.y;
      float im = inversesqrt(max(max(dot(T, T), dot(Bt, Bt)), 1e-24));
      vec2 nxy = mt.rg * 2.0 - 1.0;
      // fade normal detail with distance (less shimmer)
      nxy *= 1.0 - smoothstep(60.0, 180.0, vDepth) * 0.7;
      vec3 tn = vec3(nxy, sqrt(max(1.0 - dot(nxy, nxy), 0.0)));
      n = normalize(T * im * tn.x + Bt * im * tn.y + ng * tn.z);
      // break up tiling on big surfaces: low-frequency world-space tone variation
      float macro = bsVN(vWorld.xz * 0.045 + vWorld.y * 0.02) * 0.6 + bsVN(vWorld.xz * 0.17 + 3.1) * 0.4;
      tex.rgb *= 0.92 + macro * 0.16;
      // rain puddles on roads (gloss ~0.5 marks puddle-capable tiles), only on upward faces
      float pud = clamp(1.0 - abs(gloss - 0.5) * 6.0, 0.0, 1.0) * step(0.9, ng.y) * step(vSpec, 0.5);
      // puddles only exist while it is (or recently was) raining: wetness widens them, then they shrink away as it dries
      if (pud > 0.0 && wetness > 0.02) {
        float pn = bsVN(vWorld.xz * 0.21) * 0.7 + bsVN(vWorld.xz * 0.9 + 7.0) * 0.3;
        float thr = mix(0.80, 0.585, wetness);
        wet = smoothstep(thr, thr + 0.04, pn) * pud * smoothstep(0.02, 0.25, wetness);
        wet = max(wet, pud * wetness * 0.3); // a thin sheen over the whole road
      }
      // vertical surfaces at the waterline are wet and dark
      wet = max(wet, smoothstep(${(SEA_LEVEL + 1.35).toFixed(2)}, ${(SEA_LEVEL + 0.75).toFixed(2)}, vWorld.y) * step(abs(ng.y), 0.5) * 0.8);
      tex.rgb *= 1.0 - wet * 0.45;
      rough = mix(rough, 0.04, wet);
      n = normalize(mix(n, ng, wet));
    #endif
    float ndlG = dot(ng, sunDir);
    float ndl = max(dot(n, sunDir), 0.0) * smoothstep(-0.02, 0.12, ndlG);
    float sh = ndlG > 0.0 ? bsShadow() : 1.0;
    #ifdef CLOUD_SHADOWS
      sh *= bsCloudShadow(vWorld);
    #endif
    #ifdef DEBUG_SHADOW
      gl_FragColor = vec4(vec3(sh), 1.0); return;
    #endif
    vec3 hemi = mix(ambGround, ambSky, n.y * 0.5 + 0.5);
    float ao = vAo * vAo;
    vec3 bl = vBl * vBl * blockLight;
    vec3 lit = hemi * ao + sunColor * ndl * sh * (0.35 + 0.65 * ao) + bl * (0.55 + 0.45 * ao);
    // foliage: light leaking through leaves from behind
    if (vSway > 0.0) lit += sunColor * max(dot(-ng, sunDir), 0.0) * 0.3 * sh;
    vec3 col = tex.rgb * lit;
    #ifdef MATERIAL_MAP
      // dielectric GGX sun highlight driven by the roughness map (asphalt sheen, wet edges, tiles)
      {
        vec3 H = normalize(sunDir + V);
        float nh = max(dot(n, H), 0.0);
        float a = max(rough * rough, 0.006), a2 = a * a;
        float dd = nh * nh * (a2 - 1.0) + 1.0;
        float D = a2 / (3.14159 * dd * dd);
        float F = 0.04 + 0.96 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
        col += sunColor * min(D * F * 0.25, 24.0) * ndl * sh * (0.4 + 0.6 * ao) * (1.0 - vEmi);
      }
    #endif
    // dynamic lights (muzzle flash point light, own headlights spot)
    if (dynPos.w > 0.0) {
      vec3 d = dynPos.xyz - vWorld; float dl = length(d);
      float att = max(0.0, 1.0 - dl / dynPos.w); att *= att;
      col += tex.rgb * dynCol * att * (0.35 + 0.65 * max(dot(n, d / max(dl, 1e-3)), 0.0));
    }
    if (headPos.w > 0.0) {
      vec3 d = vWorld - headPos.xyz; float dl = length(d); vec3 dn = d / max(dl, 1e-3);
      float cone = smoothstep(0.82, 0.95, dot(dn, headDir));
      float att = max(0.0, 1.0 - dl / headPos.w);
      col += tex.rgb * headCol * cone * att * att * max(dot(n, -dn), 0.0) * ao;
    }
    // glossy / mirror surfaces (spec tier blocks, masked per texel) and wet patches: sky reflection with Fresnel + sun highlight
    float k = vSpec > 2.5 ? 1.0 : (vSpec > 1.5 ? 0.55 : (vSpec > 0.5 ? 0.25 : 0.0));
    k *= smoothstep(0.2, 0.9, gloss);
    k = max(k, wet * 0.45);
    if (k > 0.0) {
      vec3 R = reflect(-V, n);
      float fres = pow(1.0 - max(dot(n, V), 0.0), 5.0);
      vec3 env = bsSky(normalize(vec3(R.x, abs(R.y) * 0.8 + 0.02, R.z)));
      if (R.y < 0.0) env *= 0.45;
      float refl = (0.04 + 0.96 * fres) * k * 0.85 + k * 0.08;
      col = mix(col, env * (0.35 + 0.65 * ao), refl);
      col += bl * wet * (0.5 + 1.6 * fres); // street lamps and neon mirrored in wet patches
      vec3 H = normalize(sunDir + V);
      float sp = pow(max(dot(n, H), 0.0), mix(40.0, 700.0, k)) * mix(1.0, 18.0, k);
      col += sunColor * sp * sh * k * 0.5 * step(0.0, ndlG);
    }
    // emissive blocks glow brighter at night (bloom picks up > 1.0)
    vec3 glow = tex.rgb * (1.2 + night * 2.4);
    col = mix(col, glow, vEmi);
    col = bsAtmos(col, vWorld);
    gl_FragColor = vec4(col, opacity * min(tex.a, 1.0));
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function makeBlockMaterial(L: LightingUniforms, map: THREE.Texture, kind: 'opaque' | 'cutout' | 'translucent') {
  // the material (normal / roughness / gloss) array travels with the albedo array (see atlas.ts)
  const matMap = (map.userData as { material?: THREE.Texture }).material ?? null;
  const m = new THREE.ShaderMaterial({
    uniforms: litUniforms(L, { map: { value: map }, matMap: { value: matMap }, alphaTest: { value: kind === 'cutout' ? 0.5 : 0.01 }, opacity: { value: kind === 'translucent' ? 0.55 : 1 } }),
    vertexShader: blockVert, fragmentShader: blockFrag,
    transparent: kind === 'translucent',
    side: kind === 'cutout' ? THREE.DoubleSide : THREE.FrontSide,
    depthWrite: kind !== 'translucent',
    lights: true,
    defines: matMap ? { SWAY: 1, MATERIAL_MAP: 1 } : { SWAY: 1 },
  });
  return m;
}

/** shadow-pass depth material for cutout chunks: alpha-tested against the atlas and swaying like the visible mesh */
export function makeCutoutDepthMaterial(L: LightingUniforms, map: THREE.Texture) {
  const m = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.time = L.time;
    sh.uniforms.windAmt = L.windAmt;
    sh.uniforms.atlasMap = { value: map };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec4 extra;\nattribute vec2 tile;\nuniform float time;\nvarying vec2 vAtlasUv;\nflat varying float vAtlasLayer;\n${SWAY_FN}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vAtlasLayer = tile.x;
        vAtlasUv = uv;
        {
          float code = floor(extra.a * 255.0 + 0.5);
          float sway = (code - floor(code / 64.0) * 64.0) / 63.0;
          if (sway > 0.0) transformed += bsSway((modelMatrix * vec4(transformed, 1.0)).xyz, time) * sway;
        }`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nprecision highp sampler2DArray;\nuniform sampler2DArray atlasMap;\nvarying vec2 vAtlasUv;\nflat varying float vAtlasLayer;')
      .replace('#include <alphatest_fragment>', 'if (texture(atlasMap, vec3(vAtlasUv, vAtlasLayer)).a < 0.5) discard;');
  };
  m.customProgramCacheKey = () => 'bs-cutout-depth-array2';
  return m;
}

const waterVert = /* glsl */ `
  #include <common>
  #include <shadowmap_pars_vertex>
  uniform float time;
  varying vec3 vWorld; varying float vViewZ; varying vec3 vN; varying vec3 vViewPos;
  void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    if (normal.y > 0.5) wp.y += (sin(wp.x * 0.35 + time * 1.3) + cos(wp.z * 0.27 + time * 1.1)) * 0.04 + sin(dot(wp.xz, vec2(0.7, -0.5)) + time * 2.2) * 0.02;
    vWorld = wp.xyz;
    vN = normal;
    ${SHADOW_VERT}
    vec4 mv = viewMatrix * wp;
    vViewPos = mv.xyz;
    vViewZ = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
const waterFrag = /* glsl */ `
  #include <common>
  #include <packing>
  #include <shadowmap_pars_fragment>
  uniform vec3 sunDir; uniform vec3 ambSky; uniform float time;
  uniform sampler2D tScene; uniform vec2 resolution; uniform mat4 projM;
  varying vec3 vWorld; varying float vViewZ; varying vec3 vN; varying vec3 vViewPos;
  ${ATMOS_PARS}
  ${WAVES_FN}
  ${SHADOW_FRAG}
  #if defined(WATER_HQ) && SSR_STEPS > 0
  vec4 bsSSR(vec3 vp, vec3 vn) {
    vec3 rd = normalize(reflect(normalize(vp), vn));
    float stepLen = 0.5 + vViewZ * 0.01;
    vec3 p = vp;
    for (int i = 0; i < SSR_STEPS; i++) {
      p += rd * stepLen;
      stepLen *= 1.16;
      vec4 c = projM * vec4(p, 1.0);
      vec2 uv = c.xy / c.w * 0.5 + 0.5;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0 || p.z > -0.1) break;
      float sz = texture2D(tScene, uv).a;
      float rz = -p.z;
      if (rz > sz && rz - sz < stepLen * 2.0 + 0.6) {
        vec3 a = p - rd * stepLen, b = p;
        for (int j = 0; j < 5; j++) {
          vec3 m = (a + b) * 0.5;
          vec4 mc = projM * vec4(m, 1.0);
          vec2 muv = mc.xy / mc.w * 0.5 + 0.5;
          if (-m.z > texture2D(tScene, muv).a) b = m; else a = m;
        }
        vec4 bc = projM * vec4(b, 1.0);
        uv = bc.xy / bc.w * 0.5 + 0.5;
        vec2 e = smoothstep(0.0, 0.12, uv) * smoothstep(1.0, 0.88, uv);
        return vec4(texture2D(tScene, uv).rgb, e.x * e.y * (1.0 - float(i) / float(SSR_STEPS)));
      }
    }
    return vec4(0.0);
  }
  #endif
  void main() {
    if (lodFar > 0.0) {
      float fade = smoothstep(fogNear, fogFar, length(vWorld.xz - camPos.xz));
      if (fade > 0.0 && fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) < fade) discard;
    }
    vec3 toCam = camPos - vWorld;
    float dist = length(toCam);
    vec3 V = toCam / max(dist, 1e-4);
    bool top = vN.y > 0.5;
    // pixel-art friendly: wave normals snapped to the 16-px texel grid near the camera
    vec2 p = vWorld.xz;
    vec2 ps = (floor(p * 16.0) + 0.5) / 16.0;
    p = mix(ps, p, smoothstep(20.0, 55.0, dist));
    float detail = 1.0 - smoothstep(40.0, 160.0, dist);
    vec2 g = bsWaveGrad(p, time, detail);
    float nStr = mix(1.2, 0.45, smoothstep(30.0, 220.0, dist));
    vec3 n = top ? normalize(vec3(-g.x * nStr, 1.0, -g.y * nStr)) : normalize(vN + vec3(g.x, 0.0, g.y) * 0.3);
    float NdV = max(dot(n, V), 0.0);
    float fres = 0.05 + 0.95 * pow(1.0 - NdV, 5.0);
    float sh = bsShadow();
    #ifdef CLOUD_SHADOWS
      sh *= bsCloudShadow(vWorld);
    #endif
    vec3 R = reflect(-V, n);
    R = normalize(vec3(R.x, max(R.y, 0.03), R.z));
    vec3 refl = bsSky(R);
    // sun / moon glint: sharp core + broad sheen
    vec3 H = normalize(sunDir + V);
    float nh = max(dot(n, H), 0.0);
    float glint = pow(nh, 1400.0) * 70.0 + pow(nh, 180.0) * 2.5 + pow(nh, 24.0) * 0.12;
    vec3 spec = sunColor * glint * sh * step(0.0, sunDir.y);
    // pixel sparkle: single bright texels twinkling in the glint path
    vec2 cell = floor(vWorld.xz * 16.0);
    float spk = bsHash(cell + floor(time * 5.0) * 1.37);
    spec += sunColor * sh * step(0.993, spk) * smoothstep(0.25, 0.7, pow(nh, 30.0)) * 6.0;
    vec3 col; float alpha;
    #ifdef WATER_HQ
      vec2 suv = gl_FragCoord.xy / resolution;
      vec2 ruv = suv + n.xz * 0.04 / max(1.0, vViewZ * 0.05);
      vec4 rs = texture2D(tScene, ruv);
      if (rs.a < vViewZ) { ruv = suv; rs = texture2D(tScene, suv); }
      float zthick = max(rs.a - vViewZ, 0.0);
      float path = zthick * dist / max(vViewZ, 1e-3);           // distance light travels through water
      float vdepth = path * max(abs(V.y), 0.08);                  // ≈ water column depth below this pixel
      vec3 absorb = exp(-path * vec3(0.55, 0.17, 0.11));
      vec3 lightIn = ambSky * 1.1 + sunColor * 0.45 * sh;
      vec3 scatter = mix(vec3(0.02, 0.20, 0.24), vec3(0.008, 0.07, 0.15), smoothstep(1.0, 8.0, vdepth)) * lightIn;
      vec3 trans = rs.rgb * absorb + scatter * (1.0 - absorb.g);
      #if SSR_STEPS > 0
        vec3 vn = normalize((viewMatrix * vec4(n, 0.0)).xyz);
        vec4 hit = bsSSR(vViewPos, vn);
        refl = mix(refl, hit.rgb, hit.a);
      #endif
      col = mix(trans, refl, fres) + spec;
      // soft shoreline foam where the water gets shallow
      float zone = 1.0 - smoothstep(0.05, 0.9, vdepth);
      vec2 fp = floor(vWorld.xz * 8.0) / 8.0;
      float fn = bsNoise(fp * 1.6 + vec2(time * 0.35, time * 0.22)) * 0.6 + bsNoise(fp * 4.3 - time * 0.5) * 0.4;
      float foam = smoothstep(0.42, 0.55, fn * zone * 1.5 + zone * 0.25) * zone;
      vec3 foamCol = (ambSky * 0.9 + sunColor * sh * 0.85) * 1.05;
      col = mix(col, foamCol, foam * 0.85 * (top ? 1.0 : 0.0));
      alpha = 1.0;
    #else
      vec3 lightIn = ambSky * 1.1 + sunColor * 0.45 * sh;
      vec3 base = mix(vec3(0.08, 0.42, 0.46), vec3(0.02, 0.14, 0.26), smoothstep(0.1, 0.9, 1.0 - abs(V.y))) * lightIn;
      col = mix(base, refl, fres) + spec;
      alpha = mix(0.74, 0.97, fres);
    #endif
    col = bsAtmos(col, vWorld);
    gl_FragColor = vec4(col, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function makeWaterMaterial(L: LightingUniforms) {
  return new THREE.ShaderMaterial({
    uniforms: litUniforms(L, {
      cameraPos2: L.camPos,
      tScene: { value: null },
      resolution: { value: new THREE.Vector2(1, 1) },
      projM: { value: new THREE.Matrix4() },
    }),
    vertexShader: waterVert, fragmentShader: waterFrag,
    transparent: true, depthWrite: false,
    lights: true,
    defines: { SSR_STEPS: 0 },
  });
}

/** switch the block/water shader feature set for a quality level (forces a recompile when it changes) */
export function configureWorldMaterials(
  mats: { opaque: THREE.ShaderMaterial; cutout: THREE.ShaderMaterial; translucent: THREE.ShaderMaterial; water: THREE.ShaderMaterial },
  o: { hqWater: boolean; ssrSteps: number; cloudShadows: boolean; sway: boolean; normalMaps?: boolean },
) {
  const set = (m: THREE.ShaderMaterial, key: string, on: boolean | number) => {
    const has = key in m.defines;
    if (on === false) { if (has) { delete m.defines[key]; m.needsUpdate = true; } return; }
    const v = on === true ? 1 : on;
    if (m.defines[key] !== v) { m.defines[key] = v; m.needsUpdate = true; }
  };
  for (const m of [mats.opaque, mats.cutout, mats.translucent, mats.water]) {
    set(m, 'CLOUD_SHADOWS', o.cloudShadows);
  }
  for (const m of [mats.opaque, mats.cutout, mats.translucent]) set(m, 'SWAY', o.sway);
  // normal / roughness / gloss sampling (off on low: one texture fetch per fragment, as before)
  const normalMaps = o.normalMaps ?? o.cloudShadows;
  for (const m of [mats.opaque, mats.cutout, mats.translucent]) set(m, 'MATERIAL_MAP', normalMaps && !!m.uniforms.matMap?.value);
  set(mats.water, 'WATER_HQ', o.hqWater);
  set(mats.water, 'SSR_STEPS', o.hqWater ? o.ssrSteps : 0);
  if (mats.water.depthWrite !== o.hqWater) { mats.water.depthWrite = o.hqWater; mats.water.needsUpdate = true; }
}

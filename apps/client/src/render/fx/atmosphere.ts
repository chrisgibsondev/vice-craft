/**
 * Shared GLSL for the sky model, aerial perspective, wind sway and water waves.
 * Every world shader (blocks, water, clouds, sky dome) uses the same `bsSky()` so distant
 * terrain dissolves exactly into the sky behind it.
 */

/** uniforms read by bsSky / bsAtmos (all live in LightingUniforms) */
export const ATMOS_PARS = /* glsl */ `
  uniform vec3 sunTrue; uniform vec3 moonDir; uniform vec3 zenith; uniform vec3 horizon;
  uniform vec3 sunColor; uniform float golden; uniform float night; uniform vec3 camPos;
  uniform float fogNear; uniform float fogFar; uniform float fogDensity;
  uniform float underwater; uniform vec3 waterFog; uniform float lodFar;
  /** 1 while rendering into the HDR target: far-pass geometry + clouds write alpha 0 ("not sky" for god rays) */
  uniform float rayMask;
  /** weather (fx/weather.ts): 0..1 cloud-cover darkening, wet-surface amount */
  uniform float overcast; uniform float wetness;

  vec3 bsSky(vec3 d) {
    float y = d.y;
    float day = 1.0 - night;
    vec3 col = mix(horizon, zenith, pow(clamp(y, 0.0, 1.0), 0.42));
    // horizon haze band
    float haze = exp(-max(y, 0.0) * 8.0);
    col = mix(col, horizon * 1.04, haze * 0.4);
    // below the horizon: a darker, hazy ground plane
    if (y < 0.0) col = mix(col, horizon * 0.6, clamp(-y * 2.5, 0.0, 1.0));
    // Mie forward scattering around the sun (Henyey-Greenstein)
    float mu = dot(d, sunTrue);
    const float g = 0.76;
    float hg = (1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * mu, 1e-4), 1.5);
    col += sunColor * hg * 0.004 * day * (0.5 + 1.5 * golden) * (1.0 - overcast);
    // sunrise / sunset: warm glow hugging the horizon toward the sun
    vec2 hz = normalize(d.xz + vec2(1e-5)); vec2 sz = normalize(sunTrue.xz + vec2(1e-5));
    float az = dot(hz, sz) * 0.5 + 0.5;
    float clr = 1.0 - overcast * 0.85;
    col += vec3(1.0, 0.38, 0.12) * golden * clr * pow(az, 5.0) * exp(-abs(y) * 4.5) * 0.85;
    col += vec3(0.55, 0.25, 0.45) * golden * pow(1.0 - az, 3.0) * exp(-abs(y) * 6.0) * 0.18;
    // moon glow at night
    float mm = max(dot(d, moonDir), 0.0);
    col += vec3(0.40, 0.52, 0.85) * (pow(mm, 80.0) * 0.5 + pow(mm, 8.0) * 0.04) * night * (1.0 - overcast);
    return col;
  }

  /** aerial perspective: height fog with sun in-scattering + render-distance dissolve */
  vec3 bsAtmos(vec3 col, vec3 wp) {
    vec3 dv = wp - camPos; float dist = length(dv); vec3 dir = dv / max(dist, 1e-4);
    if (underwater > 0.5) {
      float uf = 1.0 - exp(-dist * 0.085);
      return mix(col * vec3(0.5, 0.82, 0.92), waterFog, uf);
    }
    // fade toward the sky just above the horizon in this direction (never the dark under-horizon band)
    vec3 sky = bsSky(normalize(vec3(dir.x, max(dir.y, 0.015), dir.z)));
    float hAvg = max(0.5 * (camPos.y + wp.y) - 16.0, 0.0);
    float dens = fogDensity * exp(-hAvg * 0.02);
    float f = 1.0 - exp(-dist * dens);
    float mu = max(dot(dir, sunTrue), 0.0);
    vec3 fc = sky + sunColor * pow(mu, 12.0) * 0.25 * (1.0 - night);
    col = mix(col, fc, f);
    // chunks stream in a horizontal circle, so the render-distance dissolve is cylindrical;
    // with the far-city LOD on, the world only dissolves into the sky near the LOD range
    float hd = length(dv.xz);
    return mix(col, sky, lodFar > 0.0 ? smoothstep(lodFar * 0.8, lodFar, hd) : smoothstep(fogNear, fogFar, hd));
  }
`;

/** wind sway offset for foliage (world space, function of world position only so shared corners never crack) */
export const SWAY_FN = /* glsl */ `
  uniform float windAmt; // 0..1 wind strength from the weather system
  vec3 bsSway(vec3 wp, float t) {
    float ph = wp.x * 0.61 + wp.z * 0.43 + wp.y * 0.2;
    float gust = 0.65 + 0.35 * sin(t * 0.37 + wp.x * 0.02);
    float sx = sin(t * 1.9 + ph) + 0.45 * sin(t * 3.7 + ph * 1.9);
    float sz = cos(t * 1.6 + ph * 0.8) + 0.35 * sin(t * 4.3 + ph * 2.3);
    return vec3(sx, 0.18 * sin(t * 2.6 + ph * 1.3), sz) * 0.075 * gust * (0.72 + windAmt * 1.9);
  }
`;

/** multi-octave wave height gradient (for normals) */
export const WAVES_FN = /* glsl */ `
  float bsHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float bsNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(bsHash(i), bsHash(i + vec2(1, 0)), f.x), mix(bsHash(i + vec2(0, 1)), bsHash(i + vec2(1, 1)), f.x), f.y); }
  vec2 bsWaveGrad(vec2 p, float t, float detail) {
    vec2 g = vec2(0.0);
    // directional swell (amplitude, wavenumber, speed)
    vec2 d1 = normalize(vec2(1.0, 0.35)), d2 = normalize(vec2(-0.45, 1.0)), d3 = normalize(vec2(0.8, -0.7)), d4 = normalize(vec2(-1.0, -0.25));
    g += d1 * 0.060 * 0.55 * cos(dot(d1, p) * 0.55 + t * 1.1);
    g += d2 * 0.045 * 0.9 * cos(dot(d2, p) * 0.9 + t * 1.45);
    g += d3 * 0.030 * 1.7 * cos(dot(d3, p) * 1.7 + t * 2.1);
    g += d4 * 0.020 * 2.9 * cos(dot(d4, p) * 2.9 + t * 2.9);
    // choppy detail (noise derivatives by central differences)
    vec2 q = p * 1.3 + vec2(t * 0.45, -t * 0.3);
    float e = 0.15;
    float n0 = bsNoise(q), nx = bsNoise(q + vec2(e, 0.0)), nz = bsNoise(q + vec2(0.0, e));
    g += vec2(nx - n0, nz - n0) / e * 0.06 * detail;
    vec2 q2 = p * 3.1 - vec2(t * 0.6, t * 0.75);
    float m0 = bsNoise(q2), mx = bsNoise(q2 + vec2(e, 0.0)), mz = bsNoise(q2 + vec2(0.0, e));
    g += vec2(mx - m0, mz - m0) / e * 0.025 * detail;
    return g;
  }
`;

/**
 * Per-model vehicle configuration.
 *
 * GLB orientation + paint findings (measured in the demo inspector, `?inspect=1&view=quad&only=<id>`):
 *
 *  model     glb            raw long axis / FRONT   yaw fix (to face -z)  tint strategy
 *  compact   car_compact    z / +z                  +PI                    material "lambert2" (#ff0000 flat red) -> col
 *  sedan     car_sedan      x / -x (spoiler at +x)  -PI/2                  vertex colour hue-key #d50000 -> col
 *  sports    car_sports     x / -x                  -PI/2                  vertex colour hue-key #ff0000 -> col (white stripes kept)
 *  pickup    car_pickup     z / -z                  0                      texture hue-key green #2bb609 -> col
 *  moto      motorcycle     z / +z                  +PI                    texture hue-key orange #f7874d (tank/fenders) -> col
 *  police    police_car     x / -x (taillights +x)  -PI/2                  none (livery is fixed)
 *  van       delivery_van   x / +x                  +PI/2                  "light body" key (#eee/#bbb panels) -> col
 *  boat      motorboat      z / -z (bow)            0                      none (white hull)
 *
 * Each GLB is flattened (node transforms baked), merged per material, rotated by `yaw`, uniformly scaled so the length
 * along -z equals VEHICLES[model].length, centred on x/z and dropped so its lowest point is y = `floor`.
 * Wheels are separate nodes only in the pickup/boat/moto meshes' *material groups*, never as their own nodes, so wheel
 * spin uses geometry-component detection (see vehicles.ts `splitWheels`); it falls back to a static wheel if that fails.
 */
import type { VehicleModel } from '@blockshore/shared';

export type TintSpec =
  | { mode: 'none' }
  | { mode: 'mat'; mat: string }                          // flat-colour material whose name matches -> colour replaced
  | { mode: 'hue'; key: string; tol: number }             // texels/vertex colours with this hue are re-coloured (shading preserved)
  | { mode: 'light'; key: string };                       // near-white body panels are re-coloured

/**
 * Rule that marks part of a model as window glass. All given fields must match for a triangle to become glass:
 *  mat  exact source material name (the whole material is glass when no other field is given)
 *  vcolor/vtol  vertex colour (0-255 rgb) and per-channel tolerance
 *  tex/ttol  colour of the palette/atlas texel under the triangle centre (0-255 rgb) and per-channel tolerance
 *  minY/maxY  triangle centre height as a fraction of the model height (keeps wheels, grilles and sills out)
 */
export interface GlassRule { mat?: string; vcolor?: [number, number, number]; vtol?: number; tex?: [number, number, number]; ttol?: number; minY?: number; maxY?: number }

export interface GlbSpec {
  id: string;            // manifest id / file stem
  yaw: number;
  tint: TintSpec;
  /** lowest point y relative to the entity position (boats sit below the nominal y) */
  floor: number;
  /** wheel spin: [front axle z, rear axle z] as fraction of length from centre (negative = front), radius fraction of length */
  wheelDetect?: boolean;
  /** cabin glass is opaque in the model, so occupants are hidden */
  enclosed: boolean;
  /**
   * Window-glass rules (see GlassRule). When any rule matches, the glass becomes a see-through tinted pane and the model is
   * treated as open for occupant visibility (seated characters are drawn). Models without rules keep `enclosed` and hide
   * their occupants: see the per-model results below.
   */
  glass?: GlassRule[];
  /** headlight / taillight positions as fractions: x of half width, y of height, z of half length */
  lights: { hx: number; hy: number; hz: number; tx: number; ty: number; tz: number };
  /** roof position for the siren bar: y fraction of height, z fraction of half length */
  roof: { y: number; z: number; w: number };
}

export const GLB_SPECS: Record<VehicleModel, GlbSpec> = {
  compact: { id: 'car_hatch', yaw: Math.PI / 2, tint: { mode: 'mat', mat: 'Kiri10_bodymat' }, floor: 0, wheelDetect: true, enclosed: true, glass: [{ mat: 'UCB_Lights_and_Glass_Transperent' }], lights: { hx: 0.62, hy: 0.34, hz: 0.98, tx: 0.6, ty: 0.34, tz: 0.98 }, roof: { y: 0.98, z: 0.0, w: 0.5 } },
  sedan: { id: 'car_sedan', yaw: -Math.PI / 2, tint: { mode: 'hue', key: '#d50000', tol: 0.32 }, floor: 0, wheelDetect: true, enclosed: true, glass: [{ vcolor: [17, 17, 17], vtol: 4, minY: 0.5 }], lights: { hx: 0.62, hy: 0.36, hz: 0.98, tx: 0.6, ty: 0.44, tz: 0.98 }, roof: { y: 0.98, z: 0.1, w: 0.5 } },
  sports: { id: 'car_sports', yaw: -Math.PI / 2, tint: { mode: 'hue', key: '#ff0000', tol: 0.32 }, floor: 0, wheelDetect: true, enclosed: true, glass: [{ mat: 'VoxMaterial_241' }], lights: { hx: 0.6, hy: 0.42, hz: 0.98, tx: 0.58, ty: 0.5, tz: 0.98 }, roof: { y: 1.0, z: 0.15, w: 0.45 } },
  pickup: { id: 'car_pickup', yaw: 0, tint: { mode: 'hue', key: '#2bb609', tol: 0.3 }, floor: 0, wheelDetect: true, enclosed: true, glass: [{ tex: [76, 126, 151], ttol: 14, minY: 0.45 }], lights: { hx: 0.6, hy: 0.42, hz: 0.99, tx: 0.55, ty: 0.46, tz: 0.99 }, roof: { y: 0.9, z: -0.15, w: 0.45 } },
  moto: { id: 'motorcycle', yaw: Math.PI, tint: { mode: 'hue', key: '#f7874d', tol: 0.3 }, floor: 0, wheelDetect: true, enclosed: false, lights: { hx: 0.0, hy: 0.62, hz: 0.98, tx: 0.0, ty: 0.62, tz: 0.98 }, roof: { y: 0.95, z: 0.0, w: 0.3 } },
  police: { id: 'police_car', yaw: -Math.PI / 2, tint: { mode: 'none' }, floor: 0, wheelDetect: true, enclosed: true, glass: [{ tex: [11, 33, 44], ttol: 8, minY: 0.4 }], lights: { hx: 0.62, hy: 0.36, hz: 0.98, tx: 0.6, ty: 0.42, tz: 0.98 }, roof: { y: 0.98, z: 0.0, w: 0.5 } },
  van: { id: 'delivery_van', yaw: Math.PI / 2, tint: { mode: 'light', key: '#eeeeee' }, floor: 0, wheelDetect: true, enclosed: true, glass: [{ tex: [17, 17, 17], ttol: 6, minY: 0.35 }], lights: { hx: 0.64, hy: 0.28, hz: 0.99, tx: 0.62, ty: 0.34, tz: 0.99 }, roof: { y: 1.0, z: -0.35, w: 0.45 } },
  boat: { id: 'motorboat', yaw: 0, tint: { mode: 'none' }, floor: -0.5, wheelDetect: false, enclosed: false, lights: { hx: 0.3, hy: 0.5, hz: 0.7, tx: 0.3, ty: 0.4, tz: 0.9 }, roof: { y: 1.0, z: 0.1, w: 0.4 } },
  // ── roster expansion (Sketchfab, CC-BY; see manifest.json)
  muscle: { id: 'car_muscle', yaw: Math.PI / 2, tint: { mode: 'mat', mat: 'Phoenix445_Bodymat' }, floor: 0, wheelDetect: true, enclosed: true, glass: [{ mat: 'UCB_Lights_and_Glass_Transperent' }], lights: { hx: 0.62, hy: 0.36, hz: 0.98, tx: 0.6, ty: 0.42, tz: 0.98 }, roof: { y: 0.98, z: 0.1, w: 0.45 } },
  supercar: { id: 'car_supercar', yaw: Math.PI / 2, tint: { mode: 'mat', mat: 'Saba95_Bodymat' }, floor: 0, wheelDetect: true, enclosed: true, glass: [{ mat: 'UCB_Lights_and_Glass_Transperent' }], lights: { hx: 0.62, hy: 0.36, hz: 0.98, tx: 0.6, ty: 0.42, tz: 0.98 }, roof: { y: 1.0, z: 0.0, w: 0.4 } },
  coupe: { id: 'car_coupe', yaw: Math.PI / 2, tint: { mode: 'mat', mat: 'kiri86_Bodymat' }, floor: 0, wheelDetect: true, enclosed: true, glass: [{ mat: 'UCB_Lights_and_Glass_Transperent' }], lights: { hx: 0.62, hy: 0.36, hz: 0.98, tx: 0.6, ty: 0.42, tz: 0.98 }, roof: { y: 0.98, z: 0.05, w: 0.45 } },
  luxury: { id: 'car_luxury', yaw: Math.PI / 2, tint: { mode: 'mat', mat: 'Riverside88_Bodymat' }, floor: 0, wheelDetect: true, enclosed: true, glass: [{ mat: 'UCB_Lights_and_Glass_Transperent' }], lights: { hx: 0.62, hy: 0.36, hz: 0.98, tx: 0.6, ty: 0.42, tz: 0.98 }, roof: { y: 0.98, z: 0.05, w: 0.5 } },
  taxi: { id: 'car_taxi', yaw: Math.PI / 2, tint: { mode: 'none' }, floor: 0, wheelDetect: true, enclosed: true, glass: [{ mat: 'UCB_Lights_and_Glass_Transperent' }], lights: { hx: 0.62, hy: 0.36, hz: 0.98, tx: 0.6, ty: 0.42, tz: 0.98 }, roof: { y: 1.0, z: 0.0, w: 0.5 } },
  ambulance: { id: 'car_ambulance', yaw: Math.PI / 2, tint: { mode: 'none' }, floor: 0, wheelDetect: true, enclosed: true, glass: [{ mat: 'UCB_Lights_and_Glass_Transperent' }], lights: { hx: 0.62, hy: 0.36, hz: 0.98, tx: 0.6, ty: 0.42, tz: 0.98 }, roof: { y: 1.0, z: -0.3, w: 0.5 } },
  firetruck: { id: 'car_firetruck', yaw: -Math.PI / 2, tint: { mode: 'none' }, floor: 0, wheelDetect: false, enclosed: true, glass: [{ mat: 'FnsterBil.001' }], lights: { hx: 0.62, hy: 0.36, hz: 0.98, tx: 0.6, ty: 0.42, tz: 0.98 }, roof: { y: 1.0, z: -0.2, w: 0.5 } },
  bus: { id: 'car_bus', yaw: Math.PI, tint: { mode: 'mat', mat: 'BusPaint' }, floor: 0, wheelDetect: true, enclosed: true, glass: [{ mat: 'Glass' }], lights: { hx: 0.62, hy: 0.36, hz: 0.98, tx: 0.6, ty: 0.42, tz: 0.98 }, roof: { y: 1.0, z: 0.0, w: 0.5 } },
  limo: { id: 'car_limo', yaw: Math.PI, tint: { mode: 'none' }, floor: 0, wheelDetect: true, enclosed: true, glass: [{ mat: 'windows' }], lights: { hx: 0.62, hy: 0.36, hz: 0.98, tx: 0.6, ty: 0.42, tz: 0.98 }, roof: { y: 0.98, z: 0.0, w: 0.4 } },
  classic: { id: 'car_classic', yaw: Math.PI, tint: { mode: 'none' }, floor: 0, wheelDetect: true, enclosed: true, glass: [{ mat: 'Glass' }], lights: { hx: 0.62, hy: 0.36, hz: 0.98, tx: 0.6, ty: 0.42, tz: 0.98 }, roof: { y: 0.98, z: 0.0, w: 0.5 } },
  buggy: { id: 'car_buggy', yaw: Math.PI, tint: { mode: 'none' }, floor: 0, wheelDetect: false, enclosed: false, lights: { hx: 0.62, hy: 0.36, hz: 0.98, tx: 0.6, ty: 0.42, tz: 0.98 }, roof: { y: 1.0, z: 0.0, w: 0.4 } },
  jetski: { id: 'jetski', yaw: Math.PI, tint: { mode: 'none' }, floor: -0.15, wheelDetect: false, enclosed: false, lights: { hx: 0.2, hy: 0.5, hz: 0.8, tx: 0.2, ty: 0.4, tz: 0.9 }, roof: { y: 1.0, z: 0.0, w: 0.3 } },
};

/** protocol model id -> GLB manifest id */
export const MODEL_FILE: Record<VehicleModel, string> = {
  compact: 'car_hatch', sedan: 'car_sedan', sports: 'car_sports', pickup: 'car_pickup', moto: 'motorcycle', police: 'police_car', van: 'delivery_van', boat: 'motorboat',
  muscle: 'car_muscle', supercar: 'car_supercar', coupe: 'car_coupe', luxury: 'car_luxury', taxi: 'car_taxi', ambulance: 'car_ambulance', firetruck: 'car_firetruck', bus: 'car_bus', limo: 'car_limo', classic: 'car_classic', buggy: 'car_buggy', jetski: 'jetski',
};

/**
 * Procedural VOXEL vehicle models for all 8 types. Used when a GLB is missing/fails and as the art-style backup.
 * Everything is built from boxes in metres: origin = ground centre, front = -z, up = +y.
 * Output geometry is split by material role so paint (`col`) only touches the body.
 */
import * as THREE from 'three';
import { VEHICLES, type VehicleModel } from '@blockshore/shared';
import { BoxBuilder } from './util';

export interface WheelProto { x: number; y: number; z: number; r: number; w: number; front: boolean; extra?: THREE.BufferGeometry }
export interface VoxelProto {
  body: THREE.BufferGeometry | null;   // white vertex colours -> tinted with `col`
  trim: THREE.BufferGeometry;          // fixed vertex colours (lit)
  glass: THREE.BufferGeometry | null;  // translucent
  wheelGeo: THREE.BufferGeometry;      // unit wheel (centred, axis = x)
  wheels: WheelProto[];
  length: number; width: number; height: number;
  enclosed: boolean;
}

const WHITE = '#ffffff';
const DARK = '#15171b', GREY = '#8d949d', LIGHT = '#d9dde3', RED = '#c4202a', LENS = '#fff4cf', SEAT = '#2a2d33';

function wheelGeometry(): THREE.BufferGeometry {
  // voxel tyre: dark block with lighter hub block, unit size (diameter 1, width 1) scaled per wheel
  const b = new BoxBuilder();
  b.box(0, 0, 0, 1, 1, 1, '#1b1c20');
  b.box(0, 0, 0, 1.04, 0.56, 0.56, '#aab1ba');
  b.box(0, 0, 0, 1.08, 0.26, 0.26, '#dfe3e8');
  b.box(0, 0, 0, 0.7, 1.02, 0.34, '#26282d'); // tread notch cross
  return b.build();
}

interface CarP {
  L: number; W: number; H: number; R: number; by: number; bh: number;
  cf: number; cr: number; cabH: number; steps: number; sf: number; sr: number;
  axF: number; axR: number;
  tintable?: boolean; fixed?: string;
}

function carCommon(P: CarP, b: BoxBuilder, t: BoxBuilder, g: BoxBuilder, wheels: WheelProto[]) {
  const { L, W, R, by, bh } = P;
  const bb = P.tintable === false ? t : b;
  const bc = P.tintable === false ? (P.fixed ?? '#ffffff') : WHITE;
  const top = by + bh;
  // lower body + hood/trunk
  bb.box(0, by + bh / 2, 0, W, bh, L, bc, { top: 1, bottom: 0.5 });
  bb.box(0, top + 0.02, (P.cf - L / 2) / 2 + 0.05, W - 0.1, 0.04, P.cf + L / 2 - 0.1, bc); // hood bulge
  // wheels + arches
  for (const sx of [-1, 1]) for (const [az, front] of [[P.axF, true], [P.axR, false]] as const) {
    wheels.push({ x: sx * (W / 2 - 0.11), y: R, z: az, r: R, w: 0.3, front });
    t.box(sx * (W / 2 - 0.0), R + 0.03, az, 0.07, R * 2 + 0.2, R * 2 + 0.34, '#0e0f12');
  }
  // cabin shell: roof slab, pillars, stepped glass
  const ch = P.cabH / P.steps;
  const cw = W - 0.22;
  for (let i = 0; i < P.steps; i++) {
    const y = top + ch * (i + 0.5);
    const zf = P.cf + i * P.sf, zr = P.cr - i * P.sr;
    // stepped windscreen / rear glass (thin translucent faces)
    g.box(0, y, zf - 0.015, cw - 0.14, ch * 0.96, 0.05, '#ffffff');
    g.box(0, y, zr + 0.015, cw - 0.14, ch * 0.96, 0.05, '#ffffff');
    // side glass bands
    for (const sx of [-1, 1]) g.box(sx * (cw / 2 - 0.005), y, (zf + zr) / 2, 0.05, ch * 0.92, zr - zf - 0.16, '#ffffff');
    // pillars between glass at the front/back of each step (so it reads as voxel glazing)
    for (const sx of [-1, 1]) {
      bb.box(sx * (cw / 2), y, zf + 0.04, 0.1, ch, 0.12, bc);
      bb.box(sx * (cw / 2), y, zr - 0.04, 0.1, ch, 0.12, bc);
    }
  }
  const topZf = P.cf + (P.steps - 1) * P.sf, topZr = P.cr - (P.steps - 1) * P.sr;
  bb.box(0, top + P.cabH + 0.04, (topZf + topZr) / 2, cw + 0.1, 0.1, topZr - topZf + 0.1, bc, { top: 1.08 });
  // mid pillar
  for (const sx of [-1, 1]) bb.box(sx * (cw / 2), top + P.cabH * 0.5, (P.cf + P.cr) / 2 + 0.1, 0.1, P.cabH, 0.1, bc);
  // interior: seats + dash
  const seatY = by + 0.18;
  t.box(0, by + bh * 0.5, (P.cf + P.cr) / 2, cw - 0.1, 0.1, P.cr - P.cf, '#23252b');
  for (const sx of [-1, 1]) {
    t.box(sx * 0.45, seatY + bh * 0.4, (P.cf + P.cr) / 2 + 0.25, 0.5, 0.18, 0.55, SEAT);
    t.box(sx * 0.45, seatY + bh * 0.4 + 0.3, (P.cf + P.cr) / 2 + 0.55, 0.5, 0.6, 0.14, SEAT);
  }
  t.box(0, top + 0.06, P.cf + 0.2, cw - 0.1, 0.16, 0.34, '#1a1c21'); // dash
  t.box(-0.45, top + 0.28, P.cf + 0.38, 0.34, 0.34, 0.06, '#0d0e10'); // steering wheel
  // bumpers, grille, lights, plate, mirrors
  t.box(0, by + 0.1, -L / 2 - 0.02, W + 0.04, 0.2, 0.16, '#6c737c');
  t.box(0, by + 0.1, L / 2 + 0.02, W + 0.04, 0.2, 0.16, '#6c737c');
  t.box(0, by + bh * 0.52, -L / 2 - 0.01, W * 0.46, bh * 0.36, 0.05, '#101216');
  for (let i = -2; i <= 2; i++) t.box(i * W * 0.085, by + bh * 0.52, -L / 2 - 0.04, 0.03, bh * 0.3, 0.02, '#4a5059');
  for (const sx of [-1, 1]) {
    t.box(sx * W * 0.36, by + bh * 0.62, -L / 2 - 0.02, 0.34, 0.17, 0.06, LENS);
    t.box(sx * W * 0.36, by + bh * 0.62, L / 2 + 0.02, 0.34, 0.15, 0.06, RED);
    t.box(sx * (W / 2 + 0.09), top + 0.2, P.cf + 0.25, 0.12, 0.12, 0.2, DARK);
    t.box(sx * (W / 2 + 0.005), by + bh * 0.62, P.cf + 0.75, 0.012, 0.05, 0.16, '#3a3f46'); // handle
  }
  t.box(0, by + 0.28, L / 2 + 0.05, 0.5, 0.14, 0.02, '#f0f0f0');
  t.box(0, by + 0.28, -L / 2 - 0.08, 0.5, 0.14, 0.02, '#f0f0f0');
  // door seams
  for (const sx of [-1, 1]) for (const z of [P.cf + 0.1, (P.cf + P.cr) / 2 + 0.2, P.cr - 0.05]) t.box(sx * (W / 2 + 0.003), by + bh * 0.62, z, 0.01, bh * 0.8, 0.02, '#0f1114');
}

function finish(b: BoxBuilder | null, t: BoxBuilder, g: BoxBuilder | null, wheels: WheelProto[], dims: [number, number, number], enclosed: boolean): VoxelProto {
  return { body: b && b.pos.length ? b.build() : null, trim: t.build(), glass: g && g.pos.length ? g.build() : null, wheelGeo: wheelGeometry(), wheels, length: dims[2], width: dims[0], height: dims[1], enclosed };
}

function compact(): VoxelProto {
  const d = VEHICLES.compact, b = new BoxBuilder(), t = new BoxBuilder(), g = new BoxBuilder(), w: WheelProto[] = [];
  carCommon({ L: d.length, W: d.width - 0.1, H: d.height, R: 0.32, by: 0.26, bh: 0.52, cf: -0.3, cr: 1.45, cabH: 0.78, steps: 3, sf: 0.14, sr: 0.12, axF: -1.2, axR: 1.2 }, b, t, g, w);
  t.box(0, 0.95, 1.52, 0.9, 0.08, 0.06, '#1a1c21'); // hatch spoiler lip
  return finish(b, t, g, w, [d.width, d.height, d.length], false);
}
function sedan(): VoxelProto {
  const d = VEHICLES.sedan, b = new BoxBuilder(), t = new BoxBuilder(), g = new BoxBuilder(), w: WheelProto[] = [];
  carCommon({ L: d.length, W: d.width - 0.1, H: d.height, R: 0.34, by: 0.28, bh: 0.54, cf: -0.65, cr: 1.25, cabH: 0.7, steps: 3, sf: 0.16, sr: 0.16, axF: -1.5, axR: 1.45 }, b, t, g, w);
  t.box(0, 1.1, 2.1, 1.3, 0.05, 0.3, '#1a1c21');
  return finish(b, t, g, w, [d.width, d.height, d.length], false);
}
function sports(): VoxelProto {
  const d = VEHICLES.sports, b = new BoxBuilder(), t = new BoxBuilder(), g = new BoxBuilder(), w: WheelProto[] = [];
  carCommon({ L: d.length, W: d.width - 0.05, H: d.height, R: 0.33, by: 0.2, bh: 0.44, cf: -0.35, cr: 1.0, cabH: 0.56, steps: 3, sf: 0.26, sr: 0.3, axF: -1.4, axR: 1.35 }, b, t, g, w);
  // racing stripes + wing + splitter + vents
  for (const sx of [-1, 1]) {
    t.box(sx * 0.2, 0.66, -0.2 - 1.0, 0.16, 0.012, 2.05, '#f1f3f6');
    t.box(sx * 0.2, 1.255, 0.3, 0.16, 0.012, 1.1, '#f1f3f6');
    t.box(sx * 0.2, 0.66, 1.7, 0.16, 0.012, 0.7, '#f1f3f6');
    t.box(sx * 0.86, 0.9, 1.9, 0.12, 0.28, 0.12, DARK);
  }
  t.box(0, 1.0, 1.95, 1.9, 0.06, 0.38, '#14161a'); t.box(0, 1.1, 1.95, 1.9, 0.04, 0.3, '#14161a');
  t.box(0, 0.17, -d.length / 2 - 0.08, d.width - 0.1, 0.07, 0.3, '#14161a');
  for (const sx of [-1, 1]) t.box(sx * 0.4, 0.68, -1.6, 0.34, 0.03, 0.5, '#0d0e11'); // hood vents
  return finish(b, t, g, w, [d.width, d.height, d.length], false);
}
function pickup(): VoxelProto {
  const d = VEHICLES.pickup, b = new BoxBuilder(), t = new BoxBuilder(), g = new BoxBuilder(), w: WheelProto[] = [];
  const W = d.width - 0.1;
  carCommon({ L: d.length, W, H: d.height, R: 0.46, by: 0.42, bh: 0.66, cf: -0.55, cr: 0.5, cabH: 0.82, steps: 3, sf: 0.14, sr: 0.0, axF: -1.6, axR: 1.55 }, b, t, g, w);
  // open bed: floor, walls, tailgate, rollbar
  const top = 1.08, bz0 = 0.6, bz1 = d.length / 2 - 0.05;
  t.box(0, top + 0.01, (bz0 + bz1) / 2, W - 0.2, 0.06, bz1 - bz0, '#1e2024');
  for (const sx of [-1, 1]) b.box(sx * (W / 2 - 0.06), top + 0.25, (bz0 + bz1) / 2, 0.12, 0.5, bz1 - bz0, WHITE);
  b.box(0, top + 0.25, bz1, W, 0.5, 0.12, WHITE);
  b.box(0, top + 0.25, bz0 + 0.04, W, 0.5, 0.1, WHITE);
  for (const sx of [-1, 1]) t.box(sx * (W / 2 - 0.1), top + 0.78, bz0 + 0.1, 0.07, 0.55, 0.07, '#1a1c20');
  t.box(0, top + 1.04, bz0 + 0.1, W - 0.2, 0.07, 0.07, '#1a1c20');
  t.box(0, 0.5, -d.length / 2 - 0.12, W + 0.1, 0.5, 0.1, '#1a1c20'); // bull bar
  for (const sx of [-1, 1]) t.box(sx * 0.3, 1.45, -0.3, 0.2, 0.12, 0.08, '#fff2c8'); // roof lamps
  return finish(b, t, g, w, [d.width, d.height, d.length], false);
}
function police(): VoxelProto {
  const d = VEHICLES.police, b = new BoxBuilder(), t = new BoxBuilder(), g = new BoxBuilder(), w: WheelProto[] = [];
  carCommon({ L: d.length, W: d.width - 0.1, H: d.height, R: 0.34, by: 0.28, bh: 0.54, cf: -0.65, cr: 1.25, cabH: 0.68, steps: 3, sf: 0.16, sr: 0.16, axF: -1.5, axR: 1.45, tintable: false, fixed: '#121a24' }, b, t, g, w);
  const W = d.width - 0.1;
  for (const sx of [-1, 1]) {
    t.box(sx * (W / 2 + 0.008), 0.56, 0.45, 0.012, 0.42, 1.6, '#f0f3f7'); // white doors
    t.box(sx * (W / 2 + 0.012), 0.62, 0.45, 0.012, 0.16, 0.8, '#1b4fa8');
  }
  t.box(0, 0.86, -1.5, W - 0.1, 0.014, 1.0, '#f0f3f7'); // white hood
  t.box(0, 0.86, 1.95, W - 0.1, 0.014, 0.6, '#f0f3f7');
  // light bar
  t.box(0, 1.52, 0.1, 1.5, 0.1, 0.4, '#101216');
  t.box(-0.4, 1.62, 0.1, 0.62, 0.14, 0.34, '#ff2a2a'); t.box(0.4, 1.62, 0.1, 0.62, 0.14, 0.34, '#2a6bff');
  t.box(0, 1.62, 0.1, 0.18, 0.14, 0.34, '#f4f4f4');
  t.box(0, 0.4, -d.length / 2 - 0.1, W, 0.3, 0.12, '#0b0c0f'); // push bar
  return finish(null, t, g, w, [d.width, d.height, d.length], false);
}
function van(): VoxelProto {
  const d = VEHICLES.van, b = new BoxBuilder(), t = new BoxBuilder(), g = new BoxBuilder(), w: WheelProto[] = [];
  const W = d.width - 0.1, L = d.length, H = d.height, R = 0.4, by = 0.36;
  const wheels = w;
  for (const sx of [-1, 1]) for (const [az, front] of [[-1.55, true], [1.5, false]] as const) {
    wheels.push({ x: sx * (W / 2 - 0.12), y: R, z: az, r: R, w: 0.32, front });
    t.box(sx * (W / 2), R + 0.03, az, 0.07, R * 2 + 0.2, R * 2 + 0.34, '#0e0f12');
  }
  b.box(0, by + 0.45, 0, W, 0.9, L, WHITE, { bottom: 0.5 });                     // lower body
  b.box(0, by + 0.9 + (H - by - 0.9) / 2, 0.55, W, H - by - 0.9, L - 1.1, WHITE); // cargo + cab box
  // front nose / hood + stepped windscreen (hollow: glass)
  b.box(0, by + 1.0, -L / 2 + 0.45, W, 0.2, 0.9, WHITE);
  for (let i = 0; i < 3; i++) {
    const y = by + 1.05 + (H - by - 1.05) * ((i + 0.5) / 3), zf = -1.35 + i * 0.1;
    g.box(0, y, zf - 0.02, W - 0.3, (H - by - 1.05) / 3 * 0.96, 0.05, '#ffffff');
    for (const sx of [-1, 1]) g.box(sx * (W / 2 - 0.005), y, zf + 0.4, 0.05, (H - by - 1.05) / 3 * 0.9, 1.0, '#ffffff');
    for (const sx of [-1, 1]) b.box(sx * (W / 2 - 0.05), y, zf + 0.03, 0.1, (H - by - 1.05) / 3, 0.1, WHITE);
  }
  t.box(0, by + 0.1, -L / 2 - 0.02, W + 0.04, 0.22, 0.16, '#6c737c'); t.box(0, by + 0.1, L / 2 + 0.02, W + 0.04, 0.22, 0.16, '#6c737c');
  t.box(0, by + 0.62, -L / 2 - 0.01, W * 0.5, 0.36, 0.05, '#101216');
  for (const sx of [-1, 1]) {
    t.box(sx * W * 0.38, by + 0.72, -L / 2 - 0.02, 0.34, 0.2, 0.06, LENS);
    t.box(sx * W * 0.4, by + 0.72, L / 2 + 0.02, 0.2, 0.5, 0.06, RED);
    t.box(sx * (W / 2 + 0.12), by + 1.35, -1.1, 0.14, 0.34, 0.1, DARK);
    for (const z of [-0.95, 0.55, 2.0]) t.box(sx * (W / 2 + 0.004), by + 1.0, z, 0.012, 1.1, 0.025, '#b9bfc8'); // door seams
    t.box(sx * (W / 2 + 0.006), by + 1.5, 1.15, 0.012, 0.5, 1.2, '#2b3a4a');   // cargo side window
    t.box(sx * (W / 2 + 0.006), by + 0.55, 0.6, 0.012, 0.1, 2.4, '#2f6fd0');   // livery stripe
  }
  t.box(0, H + 0.04, 0.6, W - 0.1, 0.06, L - 1.4, '#aeb5bd'); // roof rack
  for (const z of [-0.6, 0.6, 1.8]) t.box(0, H + 0.1, z, W - 0.1, 0.06, 0.06, '#7e858e');
  t.box(0, by + 0.28, L / 2 + 0.06, 0.5, 0.14, 0.02, '#f0f0f0');
  t.box(-0.45, by + 1.18, -1.25, 0.34, 0.34, 0.06, '#0d0e10'); // steering wheel
  for (const sx of [-1, 1]) { t.box(sx * 0.5, by + 0.6, -0.9, 0.5, 0.2, 0.6, SEAT); t.box(sx * 0.5, by + 0.95, -0.6, 0.5, 0.65, 0.14, SEAT); }
  return finish(b, t, g, wheels, [d.width, d.height, d.length], false);
}
function moto(): VoxelProto {
  const d = VEHICLES.moto, b = new BoxBuilder(), t = new BoxBuilder(), w: WheelProto[] = [];
  const R = 0.36;
  // front wheel carries its fork + handlebar so it can steer
  const fork = new BoxBuilder();
  fork.box(0.09, 0.42, -0.05, 0.05, 0.84, 0.06, '#b9c0c9'); fork.box(-0.09, 0.42, -0.05, 0.05, 0.84, 0.06, '#b9c0c9');
  fork.box(0, 0.86, -0.05, 0.28, 0.1, 0.14, '#23262b');
  fork.box(0, 0.93, -0.02, 0.9, 0.06, 0.06, '#1a1c20'); fork.box(0.46, 0.93, -0.02, 0.1, 0.07, 0.12, '#0d0e10'); fork.box(-0.46, 0.93, -0.02, 0.1, 0.07, 0.12, '#0d0e10');
  fork.box(0, 0.62, -0.2, 0.24, 0.24, 0.1, '#fff4cf'); // headlight
  fork.box(0, 0.44, -0.1, 0.18, 0.06, 0.5, '#1a1c20'); // front fender (dark)
  w.push({ x: 0, y: R, z: -0.82, r: R, w: 0.18, front: true, extra: fork.build() });
  w.push({ x: 0, y: R, z: 0.85, r: R, w: 0.2, front: false });
  b.box(0, 0.82, -0.3, 0.34, 0.3, 0.6, WHITE);                 // tank
  b.box(0, 0.78, 0.95, 0.24, 0.07, 0.55, WHITE);               // tail
  b.box(0, 0.7, 0.42, 0.3, 0.12, 0.8, '#17181c');               // seat
  t.box(0, 0.5, 0.05, 0.28, 0.4, 0.62, '#4a5059');             // engine block
  t.box(0, 0.38, 0.05, 0.3, 0.12, 0.5, '#2a2d33');
  t.box(0.2, 0.36, 0.6, 0.1, 0.1, 1.0, '#9aa3ad');              // exhaust
  t.box(0, 0.62, 0.75, 0.12, 0.5, 0.12, '#23262b');              // rear stays
  t.box(0, 0.8, 0.9, 0.18, 0.1, 0.04, '#c4202a');
  t.box(0, 0.55, -0.45, 0.2, 0.55, 0.14, '#2a2d33');             // frame neck
  t.box(0, 0.3, 0.4, 0.14, 0.1, 0.9, '#23262b');
  return finish(b, t, null, w, [d.width, d.height, d.length], false);
}
function boat(): VoxelProto {
  const d = VEHICLES.boat, b = new BoxBuilder(), t = new BoxBuilder(), g = new BoxBuilder();
  const L = d.length, W = d.width;
  // hull slices from stern to bow (z from +L/2 to -L/2), 3 vertical layers (bottom narrower)
  const slices = 22, step = L / slices;
  for (let i = 0; i < slices; i++) {
    const z = L / 2 - step * (i + 0.5);
    const f = i / (slices - 1);                       // 0 stern .. 1 bow
    const wid = f < 0.62 ? W : W * (1 - ((f - 0.62) / 0.38) * 0.85);
    const lift = f > 0.55 ? ((f - 0.55) / 0.45) * 0.22 : 0;
    t.box(0, -0.42 + lift * 0.4, z, wid * 0.55, 0.3, step, '#d7dde4');                 // keel layer
    t.box(0, -0.15 + lift * 0.6, z, wid * 0.86, 0.3, step, '#e9edf2');                 // lower hull
    t.box(0, 0.12 + lift, z, wid, 0.28, step, '#1f6fb3');                              // blue stripe
    t.box(0, 0.38 + lift, z, wid * 0.98, 0.26, step, '#f4f6f9');                       // topsides
    t.box(0, 0.54 + lift, z, wid * 0.8, 0.04, step, '#c9d0d8');                        // deck
  }
  const deckY = 0.57;
  // cockpit: floor, consoles, seats, windscreen, small cabin canopy
  t.box(0, deckY + 0.02, 0.2, W * 0.7, 0.05, 2.6, '#b0885a');
  t.box(0, deckY + 0.3, -0.1, 0.6, 0.5, 0.45, '#e9edf2');                // console
  t.box(0, deckY + 0.58, -0.1, 0.5, 0.06, 0.4, '#14161a');
  t.box(0.0, deckY + 0.74, -0.18, 0.3, 0.3, 0.05, '#0d0e10');             // wheel
  g.box(0, deckY + 0.6, -0.55, W * 0.74, 0.55, 0.06, '#ffffff');          // windscreen
  for (const sx of [-1, 1]) { g.box(sx * W * 0.37, deckY + 0.55, -0.35, 0.05, 0.45, 0.55, '#ffffff'); t.box(sx * W * 0.37, deckY + 0.3, -0.55, 0.07, 0.5, 0.08, '#c9d0d8'); }
  t.box(0, deckY + 0.88, -0.55, W * 0.8, 0.07, 0.1, '#c9d0d8');
  t.box(0, deckY + 0.2, 1.3, W * 0.7, 0.28, 0.7, '#e9edf2');              // rear bench
  t.box(0, deckY + 0.45, 1.6, W * 0.7, 0.3, 0.12, '#e9edf2');
  t.box(0, deckY + 0.14, -1.1, 0.8, 0.22, 0.6, '#e9edf2');                // fore bench
  // bow rail + rear outboard
  for (const sx of [-1, 1]) for (let i = 0; i < 4; i++) t.box(sx * (W * 0.34 - i * 0.05), deckY + 0.3, -1.4 - i * 0.28, 0.05, 0.4, 0.05, '#9aa3ad');
  t.box(0, deckY + 0.5, -1.7, W * 0.32, 0.04, 1.0, '#9aa3ad');
  t.box(0, 0.45, L / 2 + 0.2, 0.34, 0.9, 0.3, '#2a2d33'); t.box(0, 0.05, L / 2 + 0.28, 0.2, 0.5, 0.12, '#9aa3ad'); t.box(0, -0.25, L / 2 + 0.3, 0.12, 0.12, 0.22, '#c4202a');
  t.box(0, deckY + 0.44, -2.45, 0.07, 0.5, 0.07, '#9aa3ad'); t.box(0, deckY + 0.7, -2.45, 0.34, 0.2, 0.04, '#c4202a'); // bow flag
  return finish(null, t, g, [], [W, d.height, L], false);
}

const BUILDERS: Partial<Record<VehicleModel, () => VoxelProto>> = { compact, sedan, sports, pickup, moto, police, van, boat };
const cache = new Map<VehicleModel, VoxelProto>();
export function getVoxelProto(m: VehicleModel): VoxelProto {
  let p = cache.get(m);
  if (!p) { p = (BUILDERS[m] ?? sedan)(); cache.set(m, p); }
  return p;
}
export function disposeVoxelProtos() {
  for (const p of cache.values()) { p.body?.dispose(); p.trim.dispose(); p.glass?.dispose(); p.wheelGeo.dispose(); for (const w of p.wheels) w.extra?.dispose(); }
  cache.clear();
}

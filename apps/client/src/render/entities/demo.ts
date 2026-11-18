/**
 * Entity renderer demo page (entities-demo.html).
 *   ?night=1    night lighting (timeOfDay 0.95)
 *   ?fp=1       first-person view model (keys 1-5 weapon, hold mouse = fire, R = reload)
 *   ?cam=veh|chars|chars2|objs|doors|markers|all|fp   camera preset (C cycles, click+WASD flies)
 *   ?voxel=1    force the procedural voxel vehicle fallbacks
 *   ?cb=1       colour-blind marker patterns
 *   ?inspect=1  raw GLB inspector (see inspect.ts)
 */
import * as THREE from 'three';
import { SOLID, type Ent, type NpcEnt, type ObjEnt, type PlayerEnt, type VehicleEnt, type DoorEnt, type VehicleModel, VEHICLES } from '@blockshore/shared';
import { GameRenderer, QUALITY_PRESETS } from '../renderer';
import { FlyCamera } from '../tour';
import { EntityRenderer, ViewModel, type LocalView } from './index';
import { runInspect } from './inspect';
import * as WM from './weaponModels';

const params = new URLSearchParams(location.search);
const canvas = document.getElementById('c') as HTMLCanvasElement;
const hud = document.getElementById('hud')!;

if (params.get('inspect')) {
  void runInspect(canvas, hud, params);
} else {
  void main();
}

type Section = { cx: number; cz: number; cam: [number, number, number]; look: [number, number, number]; fov?: number };

async function main() {
  const night = params.get('night') === '1';
  const q = QUALITY_PRESETS[(params.get('q') as 'high') ?? 'high'] ?? QUALITY_PRESETS.high;
  const r = new GameRenderer(canvas, q);
  r.timeOfDay = night ? 0.95 : 0.68;
  const ents = new EntityRenderer(r);
  const vm = new ViewModel(r);
  void WM.preloadWeaponGlbs();
  (window as unknown as { __r: unknown }).__r = { r, ents };
  hud.textContent = 'loading models...';
  const t0 = performance.now();
  await ents.preload((p) => { hud.textContent = `loading models ${(p * 100).toFixed(0)}%`; });
  if (params.get('voxel') === '1') ents.forceVoxel = true;
  const cb = params.get('cb') === '1';
  if (params.get('world') === '0') r.chunks.root.visible = false;

  // base street: camera parks at the downtown street; ground level is probed once chunks stream in
  const BASE = new THREE.Vector3(2500, 26, 3180);
  r.camera.position.copy(BASE);
  const focus = new THREE.Vector3().copy(BASE);
  let last = performance.now(), frames = 0, fps = 0, fpsAt = last;
  const ground = (x: number, z: number): number => {
    for (let y = 70; y > 12; y--) if (SOLID[r.chunks.getBlock(Math.floor(x), y, Math.floor(z))] === 1) return y + 1;
    return 22;
  };
  // wait for the street chunks
  const sky = params.get('stage') !== 'street';
  const ws = performance.now();
  let settle = sky ? 2 : 0;
  while (settle < 1.0 && performance.now() - ws < 20000) {
    const now = performance.now(); const dt = Math.min(0.1, (now - last) / 1000); last = now;
    r.update(dt, focus); r.render();
    settle = r.chunks.loadedCount > 120 ? settle + dt : 0;
    await new Promise((res) => requestAnimationFrame(res));
  }

  const sections: Record<string, Section> = {};
  const list: Ent[] = [];
  const dyn: ((t: number) => void)[] = [];
  const gy = sky ? 96 : ground(2480, 3168);
  if (sky) {
    // clean showroom platform floating above downtown (street stage: ?stage=street)
    const [pc, pctx] = [document.createElement('canvas'), null as CanvasRenderingContext2D | null];
    pc.width = pc.height = 64; const c2 = pc.getContext('2d')!; void pctx;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { c2.fillStyle = (x + y) % 2 ? '#7d838b' : '#878d95'; c2.fillRect(x * 8, y * 8, 8, 8); }
    const tex = new THREE.CanvasTexture(pc); tex.colorSpace = THREE.SRGBColorSpace; tex.magFilter = THREE.NearestFilter; tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(40, 40);
    const plat = new THREE.Mesh(new THREE.BoxGeometry(110, 1, 90), new THREE.MeshLambertMaterial({ map: tex }));
    plat.position.set(2482, gy - 0.5, 3160); r.scene.add(plat);
  }

  // ─────────── vehicles: 2 rows of 4, 3/4 view
  const vcx = 2440, vcz = 3172;
  sections.veh = { cx: vcx, cz: vcz, cam: [vcx + 12.8, gy + 3.6, vcz + 24], look: [vcx + 12.8, gy + 1.0, vcz - 3], fov: 52 };
  const models: VehicleModel[] = ['compact', 'sedan', 'sports', 'pickup', 'moto', 'police', 'van', 'boat'];
  const colors = [0xe8c32a, 0x2d8bd6, 0xd9342b, 0x2fa84f, 0xe8e8ec, 0x111418, 0xf08a24, 0xffffff];
  models.forEach((m, i) => {
    const row = Math.floor(i / 4), col = i % 4;
    const x = vcx + col * 8.5, z = vcz - row * 9;
    const v: VehicleEnt = { id: 'v' + i, k: 'v', m, x, y: gy, z, yaw: Math.PI + 0.55 - row * 0.25, sp: 0, st: 0, hp: 100, col: colors[i], occ: [], label: undefined };
    if (m === 'police') v.siren = true;
    if (m === 'compact') { v.hp = 0; }            // charred wreck
    if (m === 'sedan') { v.hp = 22; }             // smoking
    if (m === 'sports') { v.ghost = true; v.col = 0x2de2ff; }  // ghost race car
    if (m === 'boat') v.y = gy + 0.75;
    list.push(v);
    sections['v' + i] = { cx: x, cz: z, cam: [x + 4.6, gy + 2.3, z + 7.6], look: [x, gy + 0.8, z], fov: 50 };
    if (m !== 'compact') dyn.push((t) => { v.sp = 7 + Math.sin(t * 0.5 + i) * 2; v.st = Math.sin(t * 1.3 + i) * 0.8; });
  });
  // seated occupants (open vehicles show them): driver on the moto + two on the boat + a driver in the sports car
  const occ: PlayerEnt[] = [
    { id: 'pm', k: 'p', n: 'Rider', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, a: 5, v: 'v4', s: 0, hp: 100, c: 0xff7a3d, party: true },
    { id: 'pb1', k: 'p', n: 'Skipper', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, a: 5, v: 'v7', s: 0, hp: 100, c: 0x2de2ff },
    { id: 'pb2', k: 'p', n: 'Mate', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, a: 5, v: 'v7', s: 2, hp: 100, c: 0xffd23f, party: true },
  ];
  list.push(...occ);

  // ─────────── characters
  const ccx = 2488, ccz = 3140;
  sections.chars = { cx: ccx, cz: ccz, cam: [ccx, gy + 1.4, ccz + 10], look: [ccx, gy + 1.0, ccz], fov: 48 };
  sections.chars2 = { cx: ccx, cz: ccz - 3.2, cam: [ccx, gy + 1.4, ccz - 3.2 + 10], look: [ccx, gy + 1.0, ccz - 3.2], fov: 48 };
  const roles = ['guard', 'cop', 'mechanic', 'shopkeeper', 'waitress', 'contact:marisol', 'contact:kilo', 'officer', 'bouncer', 'receptionist', 'jeweler', 'ped', 'ped', 'ped'];
  roles.forEach((role, i) => {
    const n: NpcEnt = { id: 'n' + i, k: 'n', r: role, x: ccx - 9 + i * 1.35, y: gy, z: ccz, yaw: Math.PI, a: 0, sk: role === 'ped' ? i * 3 + 1 : i * 5 + 2, name: role.replace('contact:', '').toUpperCase() };
    if (role === 'guard' && i === 0) n.al = 0.55;
    if (role === 'cop') { n.a = 8; }
    list.push(n);
  });
  // a second guard pair showing the alert meter at several levels
  [0.2, 0.5, 0.8, 1].forEach((al, i) => list.push({ id: 'g' + i, k: 'n', r: 'guard', x: ccx + 9 + i * 1.3, y: gy, z: ccz - 6, yaw: Math.PI, a: i === 3 ? 7 : 0, sk: i * 3, al, name: 'GUARD' } as NpcEnt));
  // players in every anim code
  const animNames = ['idle', 'walk', 'run', 'swim', 'air', 'seated', 'down', 'cower', 'attack'];
  animNames.forEach((nm, a) => {
    const p: PlayerEnt = { id: 'pa' + a, k: 'p', n: nm, x: ccx - 6 + a * 1.4, y: gy + (a === 4 ? 0.6 : 0), z: ccz - 3.2, yaw: Math.PI + (a === 1 || a === 2 ? 0.5 : 0), pitch: 0, a, hp: 100, c: [0x2d8bd6, 0xd9342b, 0x2fa84f, 0xf08a24, 0xb066ff, 0xe8c32a, 0xff5fa2, 0x35d6ff, 0xe8e8ec][a], party: a % 2 === 0 };
    if (a === 5) { p.a = 0; }
    list.push(p);
    sections['c' + a] = { cx: p.x, cz: p.z, cam: [p.x + 1.1, gy + 1.5, p.z + 4.4], look: [p.x, gy + 0.9, p.z], fov: 45 };
  });
  // bench for the seated one (a seated player outside a vehicle uses the sit pose)
  void gy;

  // ─────────── objects: one of each kind, plus done states
  const ocx = 2446, ocz = 3150;
  sections.objs = { cx: ocx, cz: ocz, cam: [ocx, gy + 3.0, ocz + 17], look: [ocx, gy + 0.9, ocz], fov: 50 };
  const kinds = ['package', 'loot', 'keypad', 'safe', 'photo', 'target', 'lock', 'evidence'];
  kinds.forEach((m, i) => {
    const o: ObjEnt = { id: 'o' + i, k: 'o', m, x: ocx - 7.5 + i * 2.1, y: gy, z: ocz, st: 0, label: m.toUpperCase(), prog: m === 'safe' ? 0.62 : m === 'keypad' ? 0.9 : 0, yaw: Math.PI };
    list.push(o);
    sections['o' + i] = { cx: o.x, cz: ocz, cam: [o.x + 0.6, gy + 1.5, ocz + 4.2], look: [o.x, gy + 0.8, ocz], fov: 50 };
  });
  kinds.forEach((m, i) => list.push({ id: 'od' + i, k: 'o', m, x: ocx - 7.5 + i * 2.1, y: gy, z: ocz - 3.4, st: 1, yaw: Math.PI } as ObjEnt));
  dyn.push((t) => { // hold ring animates; the wall-mounted ones sit slightly forward
    const k = list.find((e) => e.id === 'o3') as ObjEnt; k.prog = (t * 0.2) % 1;
    const p = list.find((e) => e.id === 'o0') as ObjEnt; p.prog = (t * 0.3) % 1;
  });

  // ─────────── doors
  const dcx = 2512, dcz = 3138;
  sections.doors = { cx: dcx, cz: dcz, cam: [dcx + 9, gy + 2.6, dcz + 14], look: [dcx + 9, gy + 2, dcz], fov: 55 };
  const doors: DoorEnt[] = [
    { id: 'd:demo.wood', k: 'd', x: dcx - 6, y: gy, z: dcz, axis: 'x', w: 2, open: false },
    { id: 'd:demo.wood2', k: 'd', x: dcx - 2.5, y: gy, z: dcz, axis: 'x', w: 2, open: true },
    { id: 'd:demo.shopfront', k: 'd', x: dcx + 1, y: gy, z: dcz, axis: 'x', w: 3, open: false },
    { id: 'd:demo.shop2', k: 'd', x: dcx + 5, y: gy, z: dcz, axis: 'x', w: 3, open: true },
    { id: 'd:demo.garage', k: 'd', x: dcx + 10, y: gy, z: dcz, axis: 'x', w: 6, open: false },
    { id: 'd:demo.garage2', k: 'd', x: dcx + 17, y: gy, z: dcz, axis: 'x', w: 6, open: true },
  ];
  list.push(...doors);
  doors.forEach((d, i) => { sections['d' + i] = { cx: d.x, cz: d.z, cam: [d.x + d.w / 2 + 1.5, gy + 1.8, d.z + (d.w >= 6 ? 12 : 6)], look: [d.x + d.w / 2, gy + (d.w >= 6 ? 2.4 : 1.0), d.z], fov: 55 }; });
  dyn.push((t) => { doors[0].open = Math.sin(t * 0.5) > 0; doors[2].open = Math.sin(t * 0.5 + 1.5) > 0; doors[4].open = Math.sin(t * 0.35) > 0; });

  // ─────────── markers
  const mcx = 2480, mcz = 3180;
  sections.markers = { cx: mcx, cz: mcz, cam: [mcx - 6, gy + 3, mcz + 22], look: [mcx + 4, gy + 6, mcz], fov: 60 };
  const mk = (kind: 'go' | 'interact' | 'vehicle' | 'deliver' | 'checkpoint' | 'danger', shape: 'circle' | 'diamond' | 'triangle' | 'square', i: number, label: string) =>
    ({ x: mcx - 14 + i * 8.5, y: gy, z: mcz, kind, shape, label });
  ents.setMarkers([
    mk('go', 'circle', 0, 'Go here'), mk('deliver', 'square', 1, 'Deliver'), mk('vehicle', 'triangle', 2, 'Get in'), mk('interact', 'diamond', 3, 'Talk'),
    mk('checkpoint', 'circle', 4, 'Gate 1'), mk('danger', 'triangle', 5, 'Guards'),
  ], cb);
  ents.setPings([{ x: mcx - 2, y: gy, z: mcz + 8, kind: 'go', from: 'Kilo', at: 1 }, { x: mcx + 4, y: gy, z: mcz + 8, kind: 'danger', from: 'Marisol', at: 2 }, { x: mcx + 10, y: gy, z: mcz + 8, kind: 'loot', from: 'You', at: 3 }]);

  // ─────────── local player (third person) + first person
  const fp = params.get('fp') === '1';
  let weapon = params.get('weapon') ?? 'pistol';
  const local: LocalView = { id: 'me', x: 2497, y: gy, z: 3168, yaw: Math.PI + 0.4, pitch: 0, anim: 0, outfit: 0x35d6ff, firstPerson: fp, weapon, aiming: true, firing: false };
  sections.all = { cx: 2470, cz: 3168, cam: [2480, gy + 30, 3215], look: [2480, gy, 3150], fov: 62 };
  sections.fp = { cx: 2497, cz: 3168, cam: [2497, gy + 1.62, 3168], look: [2497, gy + 1.5, 3150], fov: 75 };
  let camName = params.get('cam') ?? (fp ? 'fp' : 'veh');
  const applyCam = () => {
    const s = sections[camName] ?? sections.veh;
    r.camera.position.set(...s.cam); r.camera.lookAt(...s.look);
    r.camera.fov = s.fov ?? 70; r.camera.updateProjectionMatrix();
  };
  applyCam();
  let fireHeld = false, reloading = false, reloadT = 0;
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyC') { const names = Object.keys(sections); camName = names[(names.indexOf(camName) + 1) % names.length]; applyCam(); }
    if (e.code === 'KeyN') r.timeOfDay = r.timeOfDay > 0.9 || r.timeOfDay < 0.1 ? 0.68 : 0.95;
    if (e.code === 'KeyV') ents.forceVoxel = !ents.vehicles.forceVoxel;
    if (e.code === 'KeyR') { reloading = true; reloadT = 0; }
    const d = '12345'.indexOf(e.key);
    if (d >= 0) weapon = ['stun', 'pistol', 'smg', 'shotgun', 'rifle'][d];
  });
  window.addEventListener('mousedown', () => { fireHeld = true; });
  window.addEventListener('mouseup', () => { fireHeld = false; });
  const fly = new FlyCamera(r.camera, canvas);
  if (params.get('time')) r.timeOfDay = Number(params.get('time'));

  let t = 0; let shotName = '';
  (window as unknown as { __shot: (n: string) => void }).__shot = (n) => { shotName = n; };
  (window as unknown as { __demo: unknown }).__demo = { list, sections, setCam: (n: string) => { camName = n; applyCam(); }, local, ents, r };
  // tuning hooks: __wpn.frame(dt) drives one frame (use when the pane is hidden and rAF stalls); __wpn.set(id) picks the weapon
  (window as unknown as { __wpn: unknown }).__wpn = { WM, vm, set: (id: string) => { weapon = id; }, cfg: WM.WEAPON_GLB_CONFIG, frame: () => loopBody() };
  const loopBody = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000); last = now; frames++; t += dt;
    if (now - fpsAt > 500) { fps = (frames * 1000) / (now - fpsAt); frames = 0; fpsAt = now; }
    for (const f of dyn) f(t);
    // seated occupants need current vehicle state only; they carry their own pose
    if (reloading) { reloadT += dt; if (reloadT > 1.6) reloading = false; }
    local.weapon = weapon; local.firing = fireHeld && !reloading; local.firstPerson = fp;
    local.anim = camName === 'fp' ? 0 : 0;
    fly.update(dt);
    focus.copy(r.camera.position);
    r.update(dt, focus);
    ents.update(dt, list, local);
    r.render();
    vm.update(dt, { weapon, firing: local.firing, reloading, moving: 0.0, visible: fp, outfit: local.outfit });
    vm.render();
    if (shotName) { const n = shotName; shotName = ''; fetch('http://localhost:5499/' + n, { method: 'POST', body: canvas.toDataURL('image/png') }).catch(() => {}); }
    const s = r.stats();
    hud.textContent = `entities demo · ${fps.toFixed(0)} fps · ${s.calls} draws · ${(s.tris / 1000).toFixed(0)}k tris · cam=${camName} (C cycles, N night, V voxel fallbacks, click+WASD fly)\n` +
      `GLB ok: ${[...ents.vehicles.loaded].join(',')}${ents.vehicles.failed.length ? ' FAILED: ' + ents.vehicles.failed.join(',') : ''} · load ${((performance.now() - t0) / 1000).toFixed(1)}s`;
  };
  const loop = () => { loopBody(); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  void VEHICLES;
}

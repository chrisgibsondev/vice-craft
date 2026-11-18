/** World preview (?preview): cinematic tour + free-fly, with a small perf overlay. */
import * as THREE from 'three';
import { GameRenderer, QUALITY_PRESETS, webglSupport } from './render/renderer';
import { WorldTour, FlyCamera } from './render/tour';
import { WORLD, LEONIA } from '@blockshore/shared';

export function startPreview(root: HTMLElement) {
  const sup = webglSupport();
  if (!sup.ok) { root.innerHTML = `<p style="color:#fff;padding:24px;font-family:Inter">${sup.reason}</p>`; return; }
  root.innerHTML = '';
  root.style.cssText = 'position:fixed;inset:0;background:#000';
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'width:100%;height:100%;display:block';
  root.appendChild(canvas);
  const hud = document.createElement('div');
  hud.style.cssText = 'position:fixed;left:16px;bottom:16px;color:#fff;font:600 12px "JetBrains Mono",monospace;background:#0008;padding:8px 10px;border-radius:6px;white-space:pre';
  root.appendChild(hud);

  const params = new URLSearchParams(location.search);
  const q = QUALITY_PRESETS[(params.get('q') as 'high') ?? 'high'] ?? QUALITY_PRESETS.high;
  const r = new GameRenderer(canvas, q);
  const tod = params.get('tod');
  r.timeOfDay = tod ? Number(tod) : 0.7;
  // ?wx=clear|partly|overcast|rain|storm|downpour (+ &wxi=0..100 intensity) pins the weather for screenshots
  if (params.get('wx')) r.wx.force(params.get('wx')!, params.get('wxi') ? Number(params.get('wxi')) : 100);
  const tour = new WorldTour(r);
  if (params.get('t')) tour.seek(Number(params.get('t')));
  const fly = new FlyCamera(r.camera, canvas);
  const focus = new THREE.Vector3();
  let last = performance.now(), frames = 0, fps = 0, fpsAt = last;
  const freeze = params.get('freeze') === '1';
  // ?at=x,y,z,lookx,looky,lookz pins the camera (region screenshots); __bs.at(...) moves it at runtime
  let pinned: number[] | null = params.get('at') ? params.get('at')!.split(',').map(Number) : null;
  // Leonia (?world=leonia): the Palmara tour path does not apply; start above the downtown spawn
  if (!pinned && WORLD === 'leonia') { const [sx, , sz] = LEONIA.spawn; pinned = [sx - 260, 140, sz + 220, sx + 60, 40, sz - 120]; }
  const applyPin = () => { if (pinned && pinned.length >= 6) { r.camera.position.set(pinned[0], pinned[1], pinned[2]); r.camera.lookAt(pinned[3], pinned[4], pinned[5]); } };
  const step = (dt = 0.033) => { applyPin(); focus.copy(r.camera.position); r.update(dt, focus); r.render(); };
  // ?dist=<chunks> (or __bs.dist(n)) widens the view for skyline screenshots
  const dist = (d: number) => {
    r.chunks.radius = d;
    r.L.fogNear.value = d * 16 * 0.8; r.L.fogFar.value = d * 16 + 40;
    r.camera.far = Math.max(d * 16 * 1.6 + 200, 900); r.camera.updateProjectionMatrix();
  };
  if (Number(params.get('dist')) > 0) dist(Number(params.get('dist')));
  /** pin the camera, step frames (works with a hidden pane) until every chunk in range is meshed */
  const capture = async (v: number[], d?: number, maxMs = 60000) => {
    if (d) dist(d);
    pinned = v; step();
    const t0 = performance.now(); let still = 0;
    while (performance.now() - t0 < maxMs) { step(); await new Promise((res) => setTimeout(res, 120)); if (r.stats().pending === 0 && ++still > 3) break; }
    for (let i = 0; i < 4; i++) { step(); await new Promise((res) => setTimeout(res, 50)); }
    return r.stats();
  };
  (window as unknown as { __bs: unknown }).__bs = { r, tour, step, at: (...v: number[]) => { pinned = v; step(); }, stats: () => r.stats(), world: WORLD, dist, capture, wx: r.wx };

  const loop = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    frames++;
    if (now - fpsAt > 500) { fps = (frames * 1000) / (now - fpsAt); frames = 0; fpsAt = now; }
    if (!fly.update(dt)) { if (pinned) applyPin(); else tour.update(freeze ? 0 : dt); }
    if (params.get('cycle') === '1') r.timeOfDay = (r.timeOfDay + dt / 120) % 1;
    focus.copy(r.camera.position);
    r.update(dt, focus);
    r.render();
    const s = r.stats();
    hud.textContent = `VICE CRAFT world preview — click to fly (WASD, Space/Ctrl, Shift = fast)\n${fps.toFixed(0)} fps · ${s.calls} draws · ${(s.tris / 1000).toFixed(0)}k tris · chunks ${s.chunks} (+${s.pending}) · gen ${s.genRate.toFixed(0)}/s\npos ${r.camera.position.toArray().map((v) => v.toFixed(0)).join(', ')}`;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

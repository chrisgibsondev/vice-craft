import { useEffect, useRef, useState } from 'react';
import { PALMARA, POIS, poiCenter, pointInPolygon } from '@blockshore/shared';
import { getState, useGame } from '../../state/store';
import { livePose } from '../../game/livePose';
import { getMapTexture, MAP_W, MAP_H, MAP_SCALE, onMapTexture, MAP_WORLD, getDetailTile, setMapFocus, leoniaLocation, TILE_M } from '../mapTexture';
import { getWaypoint } from '../waypoint';
import { useRaf, hex, useNow } from '../util';
import type { Blip } from '../../state/types';

export const SIZE = 200;

type Shape = 'circle' | 'diamond' | 'triangle' | 'square';

export function drawShape(ctx: CanvasRenderingContext2D, shape: Shape, x: number, y: number, r: number, fill: string, outline: string, lw = 2) {
  ctx.beginPath();
  if (shape === 'circle') ctx.arc(x, y, r, 0, Math.PI * 2);
  else if (shape === 'diamond') { ctx.moveTo(x, y - r * 1.25); ctx.lineTo(x + r * 1.1, y); ctx.lineTo(x, y + r * 1.25); ctx.lineTo(x - r * 1.1, y); ctx.closePath(); }
  else if (shape === 'triangle') { ctx.moveTo(x, y - r * 1.2); ctx.lineTo(x + r * 1.15, y + r * 0.9); ctx.lineTo(x - r * 1.15, y + r * 0.9); ctx.closePath(); }
  else ctx.rect(x - r, y - r, r * 2, r * 2);
  ctx.fillStyle = fill; ctx.fill();
  ctx.lineWidth = lw; ctx.strokeStyle = outline; ctx.stroke();
}

export const KIND_COLOR: Record<Blip['kind'], string> = {
  party: '#2ee6d6', player: '#ffffff', vehicle: '#ffd23f', mine: '#ff4fa3', objective: '#ffd23f', police: '#5aa8ff', guard: '#ff5a5a', poi: '#ffffff', ping: '#ff4fa3',
};
export const KIND_SHAPE: Record<Blip['kind'], Shape> = {
  party: 'circle', player: 'circle', vehicle: 'square', mine: 'square', objective: 'diamond', police: 'triangle', guard: 'triangle', poi: 'circle', ping: 'diamond',
};
export const MARKER_COLOR: Record<string, string> = {
  go: '#ffd23f', interact: '#2ee6d6', vehicle: '#ffd23f', deliver: '#ff4fa3', checkpoint: '#ffffff', danger: '#ff5a5a',
};

export function blipStyle(b: Blip, colorblind: boolean): { shape: Shape; color: string } {
  if (colorblind) return { shape: KIND_SHAPE[b.kind], color: b.color != null ? hex(b.color) : KIND_COLOR[b.kind] };
  return { shape: b.shape ?? KIND_SHAPE[b.kind], color: b.color != null ? hex(b.color) : KIND_COLOR[b.kind] };
}

/** Name of the county and nearest place for the player's position. */
export function locationName(x: number, z: number): { county: string; place: string } {
  if (MAP_WORLD.id === 'leonia') return leoniaLocation(x, z);
  let county = 'Open sea';
  for (const c of PALMARA.counties) if (pointInPolygon(x, z, c.points)) { county = c.name; break; }
  let place = '', best = 420 * 420;
  for (const p of PALMARA.places) {
    const d = (p.pos[0] - x) ** 2 + (p.pos[1] - z) ** 2;
    if (d < best) { best = d; place = p.name; }
  }
  return { county, place };
}

export function Minimap() {
  const ref = useRef<HTMLCanvasElement>(null);
  const radius = useRef(220);
  const interior = useGame((s) => s.hud.interior);
  const [prog, setProg] = useState(() => getMapTexture().progress);
  useEffect(() => onMapTexture((t) => setProg(t.progress)), []);
  const now = useNow(1000);
  void now;
  const hud = useGame((s) => s.hud);
  const px = livePose.active ? livePose.x : hud.x || livePose.x;
  const pz = livePose.active ? livePose.z : hud.z || livePose.z;
  const loc = locationName(px, pz);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = SIZE * dpr; c.height = SIZE * dpr;
  }, []);

  useRaf(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const s = getState();
    const dpr = c.width / SIZE;
    const h = s.hud;
    const x = livePose.active ? livePose.x : h.x || livePose.x;
    const z = livePose.active ? livePose.z : h.z || livePose.z;
    const yaw = livePose.active ? livePose.yaw : h.yaw || livePose.yaw;
    const speed = livePose.active ? livePose.speedKmh : h.speedKmh;
    const target = h.inVehicle ? Math.min(420, 230 + speed * 1.1) : 200;
    radius.current += (target - radius.current) * 0.06;
    const R = radius.current;
    const half = SIZE / 2;
    const sc = half / R;
    const cb = s.settings.colorblindMarkers;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, SIZE, SIZE);
    ctx.save();
    ctx.beginPath(); ctx.arc(half, half, half - 1, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = '#10163a'; ctx.fillRect(0, 0, SIZE, SIZE);

    // world-space layer (map rotates so the player's heading points up)
    ctx.save();
    ctx.translate(half, half); ctx.rotate(yaw); ctx.scale(sc, sc); ctx.translate(-x, -z);
    const tex = getMapTexture().canvas;
    const ext = R * 1.5;
    const x0 = Math.max(0, x - ext), x1 = Math.min(MAP_WORLD.width, x + ext), z0 = Math.max(0, z - ext), z1 = Math.min(MAP_WORLD.depth, z + ext);
    if (x1 > x0 && z1 > z0) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(tex, x0 / MAP_SCALE, z0 / MAP_SCALE, Math.min(MAP_W, (x1 - x0) / MAP_SCALE), Math.min(MAP_H, (z1 - z0) / MAP_SCALE), x0, z0, x1 - x0, z1 - z0);
    }
    if (MAP_WORLD.id === 'leonia') {
      // 2 m/px detail tiles (streets + building footprints) over the 8 m/px overview
      setMapFocus(x, z);
      for (let tz = Math.floor(z0 / TILE_M); tz <= Math.floor((z1 - 1) / TILE_M); tz++) for (let tx = Math.floor(x0 / TILE_M); tx <= Math.floor((x1 - 1) / TILE_M); tx++) {
        const b = getDetailTile(tx, tz);
        if (b) ctx.drawImage(b, tx * TILE_M, tz * TILE_M, TILE_M, TILE_M);
      }
    }
    // police search area
    if (h.searchArea) {
      const a = h.searchArea, t = performance.now() / 1000;
      ctx.beginPath(); ctx.arc(a.x, a.z, a.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,70,90,${0.12 + 0.06 * Math.sin(t * 4)})`; ctx.fill();
      ctx.lineWidth = 3 / sc; ctx.strokeStyle = Math.sin(t * 5) > 0 ? '#ff4666' : '#4a8cff'; ctx.stroke();
    }
    // guide line to waypoint
    const wp = getWaypoint();
    if (wp) {
      ctx.beginPath(); ctx.moveTo(x, z); ctx.lineTo(wp.x, wp.z);
      ctx.setLineDash([10 / sc, 7 / sc]); ctx.lineWidth = 3 / sc; ctx.strokeStyle = '#ff4fa3'; ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.restore();

    // screen-space layer
    const cos = Math.cos(yaw), sin = Math.sin(yaw);
    const place = (wx: number, wz: number, edge: boolean): { x: number; y: number; clamped: boolean } | null => {
      const dx = wx - x, dz = wz - z;
      let sx = (dx * cos - dz * sin) * sc, sy = (dx * sin + dz * cos) * sc;
      const d = Math.hypot(sx, sy), lim = half - 11;
      if (d > lim) { if (!edge) return null; sx = (sx / d) * lim; sy = (sy / d) * lim; return { x: half + sx, y: half + sy, clamped: true }; }
      return { x: half + sx, y: half + sy, clamped: false };
    };
    // POIs (enterable buildings; on Leonia at their real addresses)
    for (const p of POIS) {
      const [cx, cz] = poiCenter(p.id);
      const q = place(cx, cz, false);
      if (q) drawShape(ctx, 'circle', q.x, q.y, 4, '#12092a', '#ffffff', 1.5);
    }
    const drawMark = (wx: number, wz: number, shape: Shape, color: string, r: number, edge: boolean) => {
      const q = place(wx, wz, edge);
      if (!q) return;
      drawShape(ctx, shape, q.x, q.y, q.clamped ? r * 0.8 : r, color, cb ? '#ffffff' : '#12092a', cb ? 2.5 : 2);
    };
    for (const b of s.blips) {
      const st = blipStyle(b, cb);
      const edge = b.kind === 'objective' || b.kind === 'party' || b.kind === 'ping';
      drawMark(b.x, b.z, st.shape, st.color, b.kind === 'player' ? 4 : 5.5, edge);
    }
    if (s.activity) {
      for (const o of s.activity.objectives) {
        if (o.done) continue;
        for (const m of o.markers) drawMark(m.x, m.z, cb ? KIND_SHAPE.objective : m.shape, MARKER_COLOR[m.kind] ?? '#ffd23f', 6.5, true);
      }
    }
    if (wp) drawMark(wp.x, wp.z, 'diamond', '#ff4fa3', 7, true);

    // north marker
    const nx = half + Math.sin(yaw) * (half - 12), ny = half - Math.cos(yaw) * (half - 12);
    ctx.beginPath(); ctx.arc(nx, ny, 9, 0, Math.PI * 2); ctx.fillStyle = '#12092a'; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = '#ffd23f'; ctx.stroke();
    ctx.fillStyle = '#ffd23f'; ctx.font = '800 11px Inter, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', nx, ny + 0.5);

    // player arrow
    ctx.save();
    ctx.translate(half, half);
    const g = ctx.createRadialGradient(0, 0, 4, 0, -34, 46);
    g.addColorStop(0, 'rgba(255,255,255,0.28)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 46, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55); ctx.closePath(); ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); ctx.moveTo(0, -9); ctx.lineTo(7, 7); ctx.lineTo(0, 3.5); ctx.lineTo(-7, 7); ctx.closePath();
    ctx.fillStyle = '#ff4fa3'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
    ctx.restore();
    ctx.restore();
  });

  return (
    <div className={`minimap ${interior ? 'inside' : ''} ${prog < 1 ? 'building' : ''}`}>
      <div className="mm-ring"><canvas ref={ref} style={{ width: SIZE, height: SIZE }} /></div>
      {prog < 1 && <span className="mm-build">Mapping {Math.round(prog * 100)}%</span>}
      {interior && <span className="mm-inside">INSIDE</span>}
      <div className="mm-loc"><b>{loc.place || loc.county}</b>{loc.place && <small>{loc.county}</small>}</div>
    </div>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { PALMARA, POIS, poiCenter, type PoiDef } from '@blockshore/shared';
import { getState, useGame } from '../../state/store';
import { livePose } from '../../game/livePose';
import { closeOverlay } from '../../state/actions';
import { getMapTexture, MAP_W, MAP_H, MAP_SCALE, onMapTexture, MAP_WORLD, MAP_LABELS, getDetailTile, onDetailTile, TILE_M, DETAIL_PX } from '../mapTexture';
import { setWaypoint } from '../waypoint';
import { Btn, IconBtn, Tag } from '../components';
import { Icon } from '../Icons';
import { useRaf, useWaypoint, clamp } from '../util';
import { blipStyle, MARKER_COLOR } from '../hud/Minimap';

interface View { tx: number; ty: number; z: number }
type Sel = { type: 'poi'; poi: PoiDef } | { type: 'place'; id: string } | null;

const PLACE_ZOOM: Record<string, number> = { city: 0, district: 0.9, landmark: 1.1, town: 0.7, water: 0.5, wilderness: 0.5 };
const LEO = MAP_WORLD.id === 'leonia';
/** map px per tile in the overview */
const TILE_PX = TILE_M / MAP_SCALE;

/** one 2 m/px Leonia tile drawn into its own canvas, placed in map-pixel space */
function DetailTile({ tx, tz, bmp }: { tx: number; tz: number; bmp: ImageBitmap }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { const c = ref.current; if (c) c.getContext('2d')?.drawImage(bmp, 0, 0); }, [bmp]);
  return <canvas ref={ref} width={DETAIL_PX} height={DETAIL_PX} className="map-tex" style={{ position: 'absolute', left: tx * TILE_PX, top: tz * TILE_PX, width: TILE_PX, height: TILE_PX, pointerEvents: 'none' }} />;
}

/** detail tiles (streets + building footprints) for the visible part of the map at close zoom */
function DetailLayer({ view, stage }: { view: View; stage: { w: number; h: number } }) {
  const [, setTick] = useState(0);
  useEffect(() => onDetailTile(() => setTick((t) => t + 1)), []);
  if (!LEO || view.z < 1.6) return null;
  const mx0 = -view.tx / view.z, mx1 = (stage.w - view.tx) / view.z, my0 = -view.ty / view.z, my1 = (stage.h - view.ty) / view.z;
  const t0x = Math.max(0, Math.floor(mx0 / TILE_PX)), t1x = Math.min(Math.ceil(MAP_W / TILE_PX) - 1, Math.floor(mx1 / TILE_PX));
  const t0z = Math.max(0, Math.floor(my0 / TILE_PX)), t1z = Math.min(Math.ceil(MAP_H / TILE_PX) - 1, Math.floor(my1 / TILE_PX));
  const out: React.ReactElement[] = [];
  if ((t1x - t0x + 1) * (t1z - t0z + 1) > 64) return null;
  for (let tz = t0z; tz <= t1z; tz++) for (let tx = t0x; tx <= t1x; tx++) {
    const b = getDetailTile(tx, tz);
    if (b) out.push(<DetailTile key={`${tx},${tz}`} tx={tx} tz={tz} bmp={b} />);
  }
  return <>{out}</>;
}

export function MapOverlay({ leaving }: { leaving: boolean }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const texRef = useRef<HTMLCanvasElement>(null);
  const meRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>({ tx: 0, ty: 0, z: 0.5 });
  const [sel, setSel] = useState<Sel>(null);
  const [cursor, setCursor] = useState<{ x: number; z: number } | null>(null);
  const [legend, setLegend] = useState(true);
  const wp = useWaypoint();
  const blips = useGame((s) => s.blips);
  const activity = useGame((s) => s.activity);
  const cb = useGame((s) => s.settings.colorblindMarkers);
  const viewRef = useRef(view);
  viewRef.current = view;
  const drag = useRef<{ x: number; y: number; tx: number; ty: number; moved: boolean } | null>(null);
  const [stageSize, setStageSize] = useState({ w: 1600, h: 900 });
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const upd = () => { const r = el.getBoundingClientRect(); setStageSize({ w: r.width, h: r.height }); };
    upd();
    const ro = new ResizeObserver(upd); ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // draw the pre-rendered texture into this overlay's canvas
  const paint = useCallback(() => {
    const c = texRef.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    ctx?.drawImage(getMapTexture().canvas, 0, 0);
  }, []);
  useEffect(() => { paint(); return onMapTexture(() => paint()); }, [paint]);

  const fitZoom = () => {
    const r = stageRef.current?.getBoundingClientRect();
    return r ? Math.min(r.width / MAP_W, r.height / MAP_H) * 0.96 : 0.4;
  };
  const centerOn = useCallback((wx: number, wz: number, z: number) => {
    const r = stageRef.current?.getBoundingClientRect();
    if (!r) return;
    setView({ z, tx: r.width / 2 - (wx / MAP_SCALE) * z, ty: r.height / 2 - (wz / MAP_SCALE) * z });
  }, []);

  useEffect(() => {
    const h = getState().hud;
    const x = livePose.active ? livePose.x : h.x || livePose.x;
    const z = livePose.active ? livePose.z : h.z || livePose.z;
    centerOn(x, z, Math.max(1.4, fitZoom() * 2.5));
  }, [centerOn]);

  const zoomAt = useCallback((factor: number, px: number, py: number) => {
    setView((v) => {
      const z = clamp(v.z * factor, fitZoom() * 0.9, 7);
      const k = z / v.z;
      return { z, tx: px - (px - v.tx) * k, ty: py - (py - v.ty) * k };
    });
  }, []);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [zoomAt]);

  useRaf(() => {
    const el = meRef.current;
    if (!el) return;
    const h = getState().hud;
    const x = livePose.active ? livePose.x : h.x || livePose.x;
    const z = livePose.active ? livePose.z : h.z || livePose.z;
    const yaw = livePose.active ? livePose.yaw : h.yaw || livePose.yaw;
    el.style.left = `${x / MAP_SCALE}px`; el.style.top = `${z / MAP_SCALE}px`;
    el.style.setProperty('--yaw', `${-yaw}rad`);
  });

  const toWorld = (clientX: number, clientY: number) => {
    const r = stageRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return { x: ((clientX - r.left - v.tx) / v.z) * MAP_SCALE, z: ((clientY - r.top - v.ty) / v.z) * MAP_SCALE };
  };
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty, moved: false };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (d) {
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
      if (d.moved) setView((v) => ({ ...v, tx: d.tx + dx, ty: d.ty + dy }));
    }
    const w = toWorld(e.clientX, e.clientY);
    if (w.x >= 0 && w.z >= 0 && w.x < MAP_WORLD.width && w.z < MAP_WORLD.depth) setCursor(w); else setCursor(null);
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d || d.moved) return;
    const w = toWorld(e.clientX, e.clientY);
    if (w.x < 0 || w.z < 0 || w.x > MAP_WORLD.width || w.z > MAP_WORLD.depth) return;
    setSel(null);
    setWaypoint({ x: Math.round(w.x), z: Math.round(w.z) });
  };

  const objMarkers = useMemo(() => (activity?.objectives ?? []).filter((o) => !o.done).flatMap((o) => o.markers.map((m, i) => ({ ...m, key: `${o.id}${i}`, text: m.label ?? o.text }))), [activity]);
  const selPos: [number, number] | null = sel ? (sel.type === 'poi' ? poiCenter(sel.poi.id) : (() => { const p = PALMARA.places.find((q) => q.id === sel.id); return p ? p.pos : null; })()) : null;
  const selInfo = sel ? (sel.type === 'poi' ? { name: sel.poi.name, text: sel.poi.blurb, icon: sel.poi.icon } : (() => { const p = PALMARA.places.find((q) => q.id === sel.id); return { name: p?.name ?? '', text: `A ${p?.kind ?? 'place'} in Palmara.`, icon: 'pin' }; })()) : null;

  const z = view.z;
  const world: CSSProperties = { transform: `translate(${view.tx}px, ${view.ty}px) scale(${z})`, ['--z' as string]: z, width: MAP_W, height: MAP_H };
  const px = (x: number) => x / MAP_SCALE;

  return (
    <div className={`scrim mapfull ${leaving ? 'out' : ''}`}>
      <div className="map-stage" ref={stageRef} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerLeave={() => setCursor(null)}>
        <div className="map-world" style={world}>
          <canvas ref={texRef} width={MAP_W} height={MAP_H} className="map-tex" />
          <DetailLayer view={view} stage={stageSize} />
          {MAP_LABELS.filter((l) => l.big || z > 0.9).map((l) => (
            <div key={l.id} className="mk county" style={{ left: px(l.x), top: px(l.z), opacity: z > 2.4 ? 0.3 : 0.9 }}><span>{l.name}</span></div>
          ))}
          {!LEO && PALMARA.counties.map((c) => (
            <div key={c.id} className="mk county" style={{ left: px(c.label[0]), top: px(c.label[1]), opacity: z > 1.7 ? 0.25 : 0.85 }}><span>{c.name}</span></div>
          ))}
          {!LEO && PALMARA.places.filter((p) => z >= (PLACE_ZOOM[p.kind] ?? 1)).map((p) => (
            <button key={p.id} type="button" className={`mk place k-${p.kind} ${sel?.type === 'place' && sel.id === p.id ? 'on' : ''}`} style={{ left: px(p.pos[0]), top: px(p.pos[1]) }}
              onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setSel({ type: 'place', id: p.id }); }}>
              <i /><span>{p.name}</span>
            </button>
          ))}
          {(LEO || z > 1.3) && POIS.map((p) => {
            const [x, zz] = poiCenter(p.id);
            return (
              <button key={p.id} type="button" className={`mk poi ${sel?.type === 'poi' && sel.poi.id === p.id ? 'on' : ''}`} style={{ left: px(x), top: px(zz) }} title={`${p.name} — ${p.blurb}`}
                onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setSel({ type: 'poi', poi: p }); }}>
                <span className="poi-ico"><Icon name={p.icon} size={14} /></span>
                {z > (LEO ? 0.9 : 2.2) && <span className="poi-name">{p.name.split(' — ')[0]}</span>}
              </button>
            );
          })}
          {blips.map((b) => {
            const st = blipStyle(b, cb);
            return <div key={b.id} className={`mk blip sh-${st.shape} ${cb ? 'cb' : ''}`} style={{ left: px(b.x), top: px(b.z), ['--c' as string]: st.color }} title={b.label}><i /></div>;
          })}
          {objMarkers.map((m) => (
            <div key={m.key} className={`mk blip sh-${cb ? 'diamond' : m.shape} obj ${cb ? 'cb' : ''}`} style={{ left: px(m.x), top: px(m.z), ['--c' as string]: MARKER_COLOR[m.kind] ?? '#ffd23f' }} title={m.text}><i /><span className="mk-lab">{m.text}</span></div>
          ))}
          {wp && (
            <button type="button" className="mk waypoint" style={{ left: px(wp.x), top: px(wp.z) }} title="Click to clear waypoint"
              onPointerDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setWaypoint(null); }}>
              <Icon name="pin" size={30} fill />
            </button>
          )}
          <div className="mk me" ref={meRef}><svg viewBox="0 0 24 24" width="26" height="26"><path d="M12 2 20 21 12 16.5 4 21z" /></svg></div>
        </div>
        <div className="map-vignette" />
      </div>

      <aside className="map-side glass">
        <header><h2><Icon name="map" size={20} /> {MAP_WORLD.name}</h2><IconBtn icon="close" onClick={closeOverlay} title="Close (Esc)" /></header>
        <p className="muted small">Drag to pan, scroll to zoom. <b>Click the map</b> to set a waypoint; click the pin to clear it.</p>
        <div className="map-actions">
          <Btn size="sm" variant="aqua" icon="pin" onClick={() => centerOn(livePose.active ? livePose.x : getState().hud.x || livePose.x, livePose.active ? livePose.z : getState().hud.z || livePose.z, Math.max(z, 1.4))}>Find me</Btn>
          <Btn size="sm" variant="ghost" onClick={() => setView((v) => ({ ...v, z: fitZoom(), tx: ((stageRef.current?.clientWidth ?? 0) - MAP_W * fitZoom()) / 2, ty: ((stageRef.current?.clientHeight ?? 0) - MAP_H * fitZoom()) / 2 }))}>Whole state</Btn>
          <Btn size="sm" variant="danger" icon="close" disabled={!wp} why="No waypoint set" onClick={() => setWaypoint(null)}>Clear waypoint</Btn>
        </div>
        {selInfo && selPos && (
          <div className="map-card">
            <span className="mc-ico"><Icon name={selInfo.icon} size={20} /></span>
            <div className="grow"><b>{selInfo.name}</b><p>{selInfo.text}</p></div>
            <div className="mc-actions">
              <Btn size="sm" icon="pin" onClick={() => setWaypoint({ x: selPos[0], z: selPos[1] })}>Set waypoint</Btn>
              <Btn size="sm" variant="ghost" onClick={() => centerOn(selPos[0], selPos[1], Math.max(z, 2))}>Zoom to</Btn>
            </div>
          </div>
        )}
        <h3 className="map-h">Places</h3>
        <div className="map-places">
          {LEO && MAP_LABELS.map((l) => (
            <button key={l.id} type="button" onClick={() => { setSel(null); centerOn(l.x, l.z, 1.8); }}>
              <Icon name="pin" size={15} /><span>{l.name}</span>
            </button>
          ))}
          {POIS.map((p) => (
            <button key={p.id} type="button" onClick={() => { const c = poiCenter(p.id); setSel({ type: 'poi', poi: p }); centerOn(c[0], c[1], LEO ? 3 : 2.8); }}>
              <Icon name={p.icon} size={15} /><span>{p.name.split(' — ')[0]}</span>
            </button>
          ))}
          {!LEO && PALMARA.places.filter((p) => p.kind === 'city' || p.kind === 'town' || p.kind === 'district').map((p) => (
            <button key={p.id} type="button" onClick={() => { setSel({ type: 'place', id: p.id }); centerOn(p.pos[0], p.pos[1], 1.6); }}>
              <Icon name="pin" size={15} /><span>{p.name}</span>
            </button>
          ))}
        </div>
        <button type="button" className="map-h toggle-h" onClick={() => setLegend((l) => !l)}>Legend <Icon name="back" size={12} style={{ transform: legend ? 'rotate(-90deg)' : 'rotate(180deg)' }} /></button>
        {legend && (
          <ul className="legend">
            <li><span className="lgd me" /> You</li>
            <li><span className="lgd sh-circle" style={{ ['--c' as string]: '#2ee6d6' }} /> Party member</li>
            <li><span className="lgd sh-diamond" style={{ ['--c' as string]: '#ffd23f' }} /> Objective</li>
            <li><span className="lgd sh-square" style={{ ['--c' as string]: '#ffd23f' }} /> Vehicle</li>
            <li><span className="lgd sh-triangle" style={{ ['--c' as string]: '#5aa8ff' }} /> Police</li>
            <li><span className="lgd sh-triangle" style={{ ['--c' as string]: '#ff5a5a' }} /> Guard</li>
            <li><span className="lgd pin"><Icon name="pin" size={14} fill /></span> Waypoint</li>
            <li><span className="lgd road hwy" /> Highway</li>
            <li><span className="lgd road art" /> Main road</li>
            {LEO ? <>
              <li><span className="lgd zone" style={{ background: '#7d74ac' }} /> Buildings (close zoom)</li>
              <li><span className="lgd zone" style={{ background: '#a9a9b8' }} /> Commercial</li>
              <li><span className="lgd zone" style={{ background: '#8fb06a' }} /> Residential</li>
              <li><span className="lgd zone" style={{ background: '#5fa850' }} /> Parks</li>
            </> : <>
              <li><span className="lgd zone" style={{ background: '#c4b8d8' }} /> Downtown</li>
              <li><span className="lgd zone" style={{ background: '#8fb06a' }} /> Suburbs</li>
              <li><span className="lgd zone" style={{ background: '#3f8a63' }} /> Wetlands</li>
            </>}
          </ul>
        )}
      </aside>

      <div className="map-foot glass">
        <Tag tone="grey">Zoom {z.toFixed(1)}×</Tag>
        {cursor ? <span className="mono">x {Math.round(cursor.x)} · z {Math.round(cursor.z)}</span> : <span className="muted">Move over the map to read coordinates</span>}
        {wp && <Tag tone="pink" icon="pin">Waypoint set</Tag>}
        {MAP_WORLD.attribution && <span className="muted small">Map data {MAP_WORLD.attribution}</span>}
      </div>
    </div>
  );
}

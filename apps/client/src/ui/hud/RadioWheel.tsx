/**
 * Car radio wheel (hold TAB in a vehicle): stations around a ring, flick the mouse or scroll,
 * release to tune in. Plus a small "now playing" card when the station changes.
 */
import { useEffect, useState } from 'react';
import { useGame } from '../../state/store';
import { audio } from '../../audio';

export function RadioWheel() {
  const wheel = useGame((s) => s.wheel);
  if (!wheel.open || wheel.mode !== 'radio') return null;
  const stations = audio.radio.list();
  const items = [...stations.map((st) => ({ name: st.name, freq: st.freq, genre: st.genre, color: st.color })), { name: 'Radio off', freq: '', genre: 'Silence', color: '#8a8aa0' }];
  const n = items.length;
  const sel = Number(wheel.selected ?? 0);
  const cur = audio.radio.index();
  const R = 150;
  const it = items[sel] ?? items[0];
  return (
    <div className="wwheel rwheel" role="dialog" aria-label="Radio stations">
      <svg className="wwheel-ring" width={420} height={420} viewBox="-210 -210 420 420" aria-hidden>
        <defs>
          <radialGradient id="rwg" r="1"><stop offset="0.45" stopColor="rgba(18,9,42,0)" /><stop offset="0.5" stopColor="rgba(18,9,42,.78)" /><stop offset="1" stopColor="rgba(18,9,42,.92)" /></radialGradient>
        </defs>
        <circle r={205} fill="url(#rwg)" />
        {items.map((s, i) => {
          const a0 = (i / n) * Math.PI * 2 - Math.PI / 2 - Math.PI / n, a1 = a0 + (Math.PI * 2) / n;
          const r0 = 95, r1 = 200;
          const p = (r: number, a: number) => `${(Math.cos(a) * r).toFixed(1)} ${(Math.sin(a) * r).toFixed(1)}`;
          return (
            <path key={i} d={`M ${p(r0, a0 + 0.02)} L ${p(r1, a0 + 0.02)} A ${r1} ${r1} 0 0 1 ${p(r1, a1 - 0.02)} L ${p(r0, a1 - 0.02)} A ${r0} ${r0} 0 0 0 ${p(r0, a0 + 0.02)} Z`}
              className={`wseg ${sel === i ? 'on' : ''}`} style={sel === i ? { fill: s.color } : undefined} />
          );
        })}
        <circle r={92} className="wcore" />
      </svg>
      {items.map((s, i) => {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        return (
          <div key={i} className={`wslot rslot ${sel === i ? 'on' : ''} ${cur === i ? 'eq' : ''}`} style={{ transform: `translate(calc(-50% + ${Math.cos(a) * R}px), calc(-50% + ${Math.sin(a) * R}px))` }}>
            <RadioIcon color={sel === i ? '#12092a' : s.color} off={i === n - 1} />
            <span className="wslot-ammo">{s.freq || 'OFF'}</span>
          </div>
        );
      })}
      <div className="wcenter">
        <b>{it.name}</b>
        <small>{it.genre}</small>
        <small className="rhint">Move the mouse or scroll<br />release TAB to tune</small>
      </div>
    </div>
  );
}

function RadioIcon({ color, off }: { color: string; off: boolean }) {
  const rows = off ? ['#......#', '.#....#.', '..#..#..', '...##...', '..#..#..', '.#....#.', '#......#'] : ['......#.', '.....#..', '########', '#c#c#..#', '#####.##', '#c#c#..#', '########'];
  const s = 5, w = 8;
  return (
    <svg width={w * s} height={rows.length * s} viewBox={`0 0 ${w * s} ${rows.length * s}`} shapeRendering="crispEdges" aria-hidden>
      {rows.flatMap((r, y) => [...r].map((c, x) => c === '.' ? null : <rect key={`${x}-${y}`} x={x * s} y={y * s} width={s} height={s} fill={c === 'c' ? 'rgba(255,255,255,.85)' : color} />))}
    </svg>
  );
}

/** "Now playing" card, bottom-left above the minimap, for 4 seconds after a station change. */
export function RadioCard() {
  const card = useGame((s) => s.radioCard);
  const [, tick] = useState(0);
  useEffect(() => { if (!card) return; const id = setTimeout(() => tick((x) => x + 1), 4100); return () => clearTimeout(id); }, [card]);
  if (!card || Date.now() - card.at > 4000) return null;
  return (
    <div className="radio-card" key={card.at}>
      <b>{card.station}</b>
      {card.title && <span>{card.title}{card.artist ? ` · ${card.artist}` : ''}</span>}
    </div>
  );
}

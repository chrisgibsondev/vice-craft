/**
 * Weapon wheel: hold TAB, flick the mouse toward a slot, release to equip.
 * Original art: chunky pixel icons on a neon ring. The game loop decides the
 * highlighted slot from mouse movement (works with pointer lock and without).
 */
import { WEAPONS } from '@blockshore/shared';
import { useGame } from '../../state/store';

export const WHEEL_SLOTS = ['stun', 'pistol', 'smg', 'shotgun', 'rifle', 'medkit'] as const;
export type WheelSlot = (typeof WHEEL_SLOTS)[number];

/** pixel-art icons (8×8-ish grids scaled), one per weapon class */
const ICONS: Record<WheelSlot, string[]> = {
  stun: ['..######', '.#cccc##', '########', '##.#....', '##.#....', '###.....'],
  pistol: ['########', '########', '###.....', '###.....', '###.....', '....', ],
  smg: ['..#.......', '##########', '##########', '#####.#...', '##.#..#...', '##.#......'],
  shotgun: ['##############', '##############', '#####..###....', '####..........', '###...........'],
  rifle: ['......#.......', '##############', '###############', '####.##.#.....', '###..##.......', '##............'],
  medkit: ['.######.', '#######.', '###cc###', '##cccc##', '##cccc##', '###cc###', '########'],
};

function PixelIcon({ rows, color, accent }: { rows: string[]; color: string; accent: string }) {
  const w = Math.max(...rows.map((r) => r.length));
  const s = 5;
  return (
    <svg width={w * s} height={rows.length * s} viewBox={`0 0 ${w * s} ${rows.length * s}`} shapeRendering="crispEdges" aria-hidden>
      {rows.flatMap((r, y) => [...r].map((c, x) => c === '.' ? null : <rect key={`${x}-${y}`} x={x * s} y={y * s} width={s} height={s} fill={c === 'c' ? accent : color} />))}
    </svg>
  );
}

export function WeaponWheel() {
  const wheel = useGame((s) => s.wheel);
  const profile = useGame((s) => s.profile);
  const equipped = useGame((s) => s.hud.ammo?.weapon);
  if (!wheel.open || wheel.mode === 'radio') return null;
  const owned = new Map((profile?.weapons ?? [{ id: 'stun', ammo: 999 }]).map((w) => [w.id, w.ammo]));
  const medkits = profile?.inventory?.medkit ?? 0;
  const n = WHEEL_SLOTS.length;
  const R = 150;
  const sel = wheel.selected;
  const selDef = sel && sel !== 'medkit' ? WEAPONS[sel] : null;
  return (
    <div className="wwheel" role="dialog" aria-label="Weapon wheel">
      <svg className="wwheel-ring" width={420} height={420} viewBox="-210 -210 420 420" aria-hidden>
        <defs>
          <radialGradient id="wwg" r="1"><stop offset="0.45" stopColor="rgba(18,9,42,0)" /><stop offset="0.5" stopColor="rgba(18,9,42,.78)" /><stop offset="1" stopColor="rgba(18,9,42,.92)" /></radialGradient>
        </defs>
        <circle r={205} fill="url(#wwg)" />
        {WHEEL_SLOTS.map((id, i) => {
          const a0 = (i / n) * Math.PI * 2 - Math.PI / 2 - Math.PI / n, a1 = a0 + (Math.PI * 2) / n;
          const r0 = 95, r1 = 200;
          const p = (r: number, a: number) => `${(Math.cos(a) * r).toFixed(1)} ${(Math.sin(a) * r).toFixed(1)}`;
          const on = sel === id;
          const has = id === 'medkit' ? medkits > 0 : owned.has(id);
          return (
            <path key={id} d={`M ${p(r0, a0 + 0.02)} L ${p(r1, a0 + 0.02)} A ${r1} ${r1} 0 0 1 ${p(r1, a1 - 0.02)} L ${p(r0, a1 - 0.02)} A ${r0} ${r0} 0 0 0 ${p(r0, a0 + 0.02)} Z`}
              className={`wseg ${on ? 'on' : ''} ${has ? '' : 'locked'}`} />
          );
        })}
        <circle r={92} className="wcore" />
      </svg>
      {WHEEL_SLOTS.map((id, i) => {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        const x = Math.cos(a) * R, y = Math.sin(a) * R;
        const has = id === 'medkit' ? medkits > 0 : owned.has(id);
        const name = id === 'medkit' ? 'First-aid kit' : WEAPONS[id].name;
        const ammo = id === 'medkit' ? `${medkits}/3` : id === 'stun' ? '∞' : has ? String(owned.get(id)) : '—';
        return (
          <div key={id} className={`wslot ${sel === id ? 'on' : ''} ${has ? '' : 'locked'} ${equipped && WEAPONS[id] && WEAPONS[id].name === equipped ? 'eq' : ''}`} style={{ transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))` }}>
            <PixelIcon rows={ICONS[id]} color={has ? (sel === id ? '#12092a' : '#ffffff') : 'rgba(255,255,255,.28)'} accent={id === 'medkit' ? '#ff4f6d' : '#2ee6d6'} />
            <span className="wslot-ammo">{ammo}</span>
          </div>
        );
      })}
      <div className="wcenter">
        {sel ? (
          <>
            <b>{sel === 'medkit' ? 'First-aid kit' : WEAPONS[sel].name}</b>
            {selDef ? (
              <div className="wstats">
                <Stat label="Damage" v={selDef.stun ? 0.35 : Math.min(1, (selDef.damage * selDef.pellets) / 130)} />
                <Stat label="Fire rate" v={Math.min(1, selDef.rate / 11)} />
                <Stat label="Range" v={Math.min(1, selDef.range / 90)} />
                <Stat label="Accuracy" v={Math.max(0.1, 1 - selDef.spread / 0.1)} />
              </div>
            ) : <small>Restores full health</small>}
            {!(sel === 'medkit' ? medkits > 0 : owned.has(sel)) && <small className="wlock">{sel === 'medkit' ? 'Buy at Quik Pelican' : 'Buy at Bullseye Arms'}</small>}
          </>
        ) : <small>Move the mouse toward a weapon<br />release TAB to equip</small>}
      </div>
    </div>
  );
}

function Stat({ label, v }: { label: string; v: number }) {
  return (
    <div className="wstat"><span>{label}</span><i><em style={{ width: `${Math.round(v * 100)}%` }} /></i></div>
  );
}

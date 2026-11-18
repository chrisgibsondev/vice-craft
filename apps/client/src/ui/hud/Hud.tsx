import { useEffect, useRef, useState } from 'react';
import { WeaponWheel } from './WeaponWheel';
import { RadioWheel, RadioCard } from './RadioWheel';
import { VEHICLES, type VehicleModel } from '@blockshore/shared';
import { getState, useGame } from '../../state/store';
import { livePose } from '../../game/livePose';
import { liveFeel, onFeelFrame } from '../../game/feel';
import { retryActivity, leaveActivity } from '../../state/actions';
import { Minimap } from './Minimap';
import { Icon, Star } from '../Icons';
import { Btn, Bar, Avatar, KeyCap, Spinner } from '../components';
import { money, fmtClock, useNow, useRaf, keyLabel, clamp } from '../util';

// ───────────────────────────────────────────── status column (cash / wanted / ammo)
function CashBlock() {
  const cash = useGame((s) => s.profile?.cash ?? 0);
  const prev = useRef(cash);
  const [deltas, setDeltas] = useState<{ id: number; v: number }[]>([]);
  useEffect(() => {
    const d = cash - prev.current;
    prev.current = cash;
    if (d === 0) return;
    const id = Date.now() + Math.random();
    setDeltas((l) => [...l.slice(-3), { id, v: d }]);
    const t = setTimeout(() => setDeltas((l) => l.filter((x) => x.id !== id)), 2600);
    return () => clearTimeout(t);
  }, [cash]);
  return (
    <div className="hud-cash">
      <span className="cash-amt"><i>$</i>{Math.round(cash).toLocaleString('en-US')}</span>
      <div className="cash-deltas">
        {deltas.map((d) => <span key={d.id} className={`cash-delta ${d.v > 0 ? 'up' : 'down'}`}>{d.v > 0 ? '+' : '−'}{money(Math.abs(d.v))}</span>)}
      </div>
    </div>
  );
}

function Wanted() {
  const wanted = useGame((s) => s.hud.wanted);
  const seen = useGame((s) => s.hud.wantedSeen);
  if (wanted <= 0) return null;
  const slots = Math.max(3, wanted);
  return (
    <div className={`hud-wanted ${seen ? 'seen' : 'search'}`} role="status" aria-label={`Wanted level ${wanted}`}>
      <div className="stars">{Array.from({ length: slots }, (_, i) => <Star key={i} on={i < wanted} flash={seen} />)}</div>
      <small>{seen ? 'WANTED · SPOTTED' : 'SEARCHING…'}</small>
    </div>
  );
}

function Ammo() {
  const ammo = useGame((s) => s.hud.ammo);
  if (!ammo) return null;
  return (
    <div className={`hud-ammo ${liveFeel.reload >= 0 ? 'reloading' : ''}`}>
      <Icon name="bolt" size={16} />
      <span className="ammo-name">{ammo.weapon}</span>
      <span className="ammo-count"><b className={ammo.mag === 0 ? 'dry' : liveFeel.lowAmmo ? 'low' : ''}>{ammo.mag}</b><i>/</i>{ammo.reserve < 0 ? "∞" : ammo.reserve}</span>
      {liveFeel.reload >= 0 && <span className="ammo-reload">RELOADING</span>}
    </div>
  );
}

// ───────────────────────────────────────────── health
function Health() {
  const hp = useGame((s) => s.hud.hp);
  const max = useGame((s) => s.hud.maxHp);
  const low = hp / Math.max(1, max) < 0.3;
  return (
    <div className={`hud-health ${low ? 'low' : ''}`}>
      <Icon name="heart" size={16} fill />
      <span className="hbar"><i style={{ width: `${clamp((hp / Math.max(1, max)) * 100, 0, 100)}%` }} /><b>{Math.ceil(hp)}</b></span>
      {max > 100 && <em title="Muscle role: +50% health">{max} max</em>}
    </div>
  );
}

// ───────────────────────────────────────────── speedometer
const R = 50;
const C = 2 * Math.PI * R;
function Speedo() {
  const inV = useGame((s) => s.hud.inVehicle);
  const model = useGame((s) => s.hud.vehicleModel);
  const vhp = useGame((s) => s.hud.vehicleHp);
  const arc = useRef<SVGCircleElement>(null);
  const num = useRef<HTMLSpanElement>(null);
  const def = model ? VEHICLES[model as VehicleModel] : undefined;
  const topKmh = def ? Math.max(120, def.maxSpeed * 3.6 * 1.05) : 200;
  const smooth = useRef(0);
  useRaf(() => {
    const target = Math.abs(livePose.active ? livePose.speedKmh : getState().hud.speedKmh);
    smooth.current += (target - smooth.current) * 0.25;
    const p = clamp(smooth.current / topKmh, 0, 1);
    if (arc.current) arc.current.setAttribute('stroke-dasharray', `${C * 0.75 * p} ${C}`);
    if (num.current) num.current.textContent = String(Math.round(smooth.current));
  }, [topKmh]);
  if (!inV) return null;
  const maxHp = def?.health ?? 100;
  const ratio = clamp(vhp / maxHp, 0, 1);
  return (
    <div className="hud-speedo">
      <svg viewBox="0 0 120 120" width="150" height="150" aria-hidden="true">
        <circle cx="60" cy="60" r={R} className="sp-track" strokeDasharray={`${C * 0.75} ${C}`} transform="rotate(135 60 60)" />
        <circle ref={arc} cx="60" cy="60" r={R} className="sp-fill" strokeDasharray={`0 ${C}`} transform="rotate(135 60 60)" />
      </svg>
      <div className="sp-read"><span ref={num} className="sp-num">0</span><small>km/h</small></div>
      <div className="sp-veh">
        <b>{def?.name ?? 'Vehicle'}</b>
        <Bar value={ratio * 100} tone={ratio < 0.3 ? 'red' : 'aqua'} />
      </div>
    </div>
  );
}

// ───────────────────────────────────────────── objective panel
export function ObjectivePanel() {
  const act = useGame((s) => s.activity);
  const user = useGame((s) => s.user);
  const party = useGame((s) => s.party);
  const now = useNow(250);
  const isLeader = !party || party.leader === user?.id;
  if (!act) return null;
  const left = act.timer ? act.timer.endsAt - now : null;
  const failed = act.phase === 'failed';
  const done = act.phase === 'complete';
  const playing = act.phase === 'playing' || failed || done;
  return (
    <div className={`hud-obj ${failed ? 'failed' : ''} ${done ? 'done' : ''} kind-${act.kind}`}>
      <div className="obj-head">
        <span className="obj-kind">{act.kind.replace('_', ' ')}</span>
        <b>{act.name}</b>
        {playing && act.stageCount > 1 && <span className="obj-stage">{Math.min(act.stageCount, act.stageIndex + 1)}/{act.stageCount}</span>}
      </div>
      {failed ? (
        <div className="obj-fail">
          <h4><Icon name="skull" size={18} /> {act.kind === 'minigame' ? 'Run over' : 'Mission failed'}</h4>
          <p>{act.failReason || 'The crew could not finish the job.'}</p>
          <div className="obj-actions">
            <Btn size="sm" variant="aqua" onClick={retryActivity} disabled={!isLeader} why="Only the party leader can retry">Retry <KeyCap>Enter</KeyCap></Btn>
            <Btn size="sm" variant="ghost" onClick={leaveActivity}>Leave <KeyCap>L</KeyCap></Btn>
          </div>
        </div>
      ) : done ? (
        <div className="obj-done"><Icon name="check" size={18} /> Complete</div>
      ) : (
        <>
          {playing && <div className="obj-stagetitle">{act.stageTitle}</div>}
          <ul className="obj-list">
            {act.objectives.map((o) => (
              <li key={o.id} className={o.done ? 'ok' : ''}>
                <span className="obj-box">{o.done && <Icon name="check" size={12} />}</span>
                <span className="obj-text">{o.text}</span>
                {o.progress && <span className="obj-prog">{o.progress}</span>}
              </li>
            ))}
          </ul>
          {left !== null && act.timer && (
            <div className={`obj-timer ${left < 30000 ? 'hot' : ''}`}><Icon name="bolt" size={14} /> <span>{act.timer.label}</span><b>{fmtClock(left)}</b></div>
          )}
          {act.roster.length > 1 && (
            <div className="obj-roster">
              {act.roster.map((r) => (
                <span key={r.userId} className={`rost ${r.down ? 'down' : ''} ${r.connected ? '' : 'off'}`} title={`${r.name}${r.down ? ' — down' : ''}${r.connected ? '' : ' — disconnected'}`}>
                  <Avatar name={r.name} size={22} />
                  {r.down && <Icon name="skull" size={11} className="rost-x" />}
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ───────────────────────────────────────────── race
function RaceHud() {
  const race = useGame((s) => s.activity?.race);
  const now = useNow(100);
  const [goUntil, setGoUntil] = useState(0);
  const startAt = race?.startAt;
  useEffect(() => { if (startAt) setGoUntil(startAt + 1100); }, [startAt]);
  if (!race) return null;
  const rem = startAt ? startAt - now : 0;
  const count = rem > 0 ? Math.ceil(rem / 1000) : 0;
  const showGo = !count && now < goUntil;
  return (
    <>
      <div className="hud-race">
        <div className="race-pos"><b>{race.position}</b><span>/{race.racers}</span><small>POS</small></div>
        <div className="race-cell"><small>LAP</small><b>{Math.min(race.lap, race.laps)}/{race.laps}</b></div>
        <div className="race-cell"><small>CHECKPOINT</small><b>{race.cp}/{race.cps}</b></div>
      </div>
      {count > 0 && <div className="race-count" key={count}>{count}</div>}
      {showGo && <div className="race-count go" key="go">GO!</div>}
    </>
  );
}

// ───────────────────────────────────────────── prompts
function Interact() {
  const p = useGame((s) => s.hud.interactPrompt);
  const keys = useGame((s) => s.settings.keys);
  if (!p) return null;
  const prog = clamp(p.progress ?? 0, 0, 1);
  const label = p.key.length > 1 && keys[p.key] ? keyLabel(keys[p.key]) : p.key.replace(/^Key/, '');
  const ring = 2 * Math.PI * 19;
  return (
    <div className="hud-interact" key={p.label}>
      <span className="ip-key">
        <svg viewBox="0 0 44 44" width="52" height="52" aria-hidden="true"><circle cx="22" cy="22" r="19" className="ip-track" /><circle cx="22" cy="22" r="19" className="ip-prog" strokeDasharray={`${ring * prog} ${ring}`} transform="rotate(-90 22 22)" /></svg>
        <kbd>{label}</kbd>
      </span>
      <span className="ip-label">{p.label}{p.hold ? <small>Hold {p.hold}s</small> : null}</span>
    </div>
  );
}

/**
 * Crosshair (blooms with movement/firing, tightens on aim), hit markers, reload ring,
 * low-ammo cue, damage-direction wedges, hurt flash and the underwater tint.
 * Driven every game frame through onFeelFrame (no React re-renders).
 */
function Crosshair() {
  const xh = useRef<HTMLDivElement>(null);
  const hit = useRef<HTMLDivElement>(null);
  const ring = useRef<SVGCircleElement>(null);
  const ringWrap = useRef<SVGSVGElement>(null);
  const note = useRef<HTMLDivElement>(null);
  const flash = useRef<HTMLDivElement>(null);
  const water = useRef<HTMLDivElement>(null);
  const wedges = useRef<(HTMLDivElement | null)[]>([]);
  useEffect(() => onFeelFrame(() => {
    const f = liveFeel, now = performance.now();
    const c = xh.current, h = hit.current;
    if (!c || !h) return;
    c.style.display = f.show ? '' : 'none';
    if (f.show) {
      const g = Math.max(2, f.spreadPx);
      const ticks = c.children as HTMLCollectionOf<HTMLElement>;
      ticks[0].style.transform = `translate(-1px, ${(-g - 7).toFixed(1)}px)`;
      ticks[1].style.transform = `translate(-1px, ${g.toFixed(1)}px)`;
      ticks[2].style.transform = `translate(${(-g - 7).toFixed(1)}px, -1px)`;
      ticks[3].style.transform = `translate(${g.toFixed(1)}px, -1px)`;
      ticks[4].style.opacity = String(0.3 + f.aiming * 0.7);
      const cls = `crosshair ${f.armed ? 'armed' : ''} ${f.stun ? 'stun' : ''} ${f.empty ? 'empty' : ''}`;
      if (c.className !== cls) c.className = cls;
    }
    // hit marker: pops in, holds briefly, fades (kills are red and larger)
    const ht = (now - f.hitAt) / 1000;
    if (ht < 0.32) {
      const k = ht < 0.03 ? ht / 0.03 : 1 - Math.max(0, (ht - 0.12) / 0.2);
      const sc = (f.hitKill ? 1.35 : 1) * (1.3 - Math.min(1, ht / 0.08) * 0.3);
      h.style.display = ''; h.style.opacity = String(Math.max(0, k)); h.style.transform = `translate(-50%, -50%) scale(${sc.toFixed(3)})`;
      const cls = `hitmarker ${f.hitKill ? 'kill' : ''} ${f.hitVeh ? 'veh' : ''}`;
      if (h.className !== cls) h.className = cls;
    } else if (h.style.display !== 'none') h.style.display = 'none';
    // reload ring
    if (ring.current && ringWrap.current) {
      const on = f.reload >= 0 && f.show;
      ringWrap.current.style.display = on ? '' : 'none';
      if (on) ring.current.style.strokeDasharray = `${(f.reload * 75.4).toFixed(1)} 75.4`;
    }
    if (note.current) {
      const t = f.reload >= 0 ? '' : f.empty ? 'RELOAD [R]' : f.lowAmmo ? 'LOW AMMO' : '';
      if (note.current.textContent !== t) note.current.textContent = t;
      note.current.style.display = f.show && t ? '' : 'none';
    }
    // damage direction: wedge points toward the attacker relative to the camera
    for (let i = 0; i < wedges.current.length; i++) {
      const el = wedges.current[i];
      if (!el) continue;
      const m = f.hurts[f.hurts.length - 1 - i];
      const age = m ? (now - m.at) / 1000 : 99;
      if (!m || age > 1.6 || Number.isNaN(m.bearing)) { if (el.style.display !== 'none') el.style.display = 'none'; continue; }
      const rel = f.camYaw - m.bearing; // screen angle, clockwise from up
      el.style.display = '';
      el.style.opacity = String(Math.min(1, (1.6 - age) / 0.6) * Math.min(1, 0.45 + m.amt / 25));
      el.style.transform = `translate(-50%, -50%) rotate(${rel.toFixed(3)}rad) translateY(-150px)`;
    }
    if (flash.current) {
      const a = Math.max(0, 1 - (now - f.flashAt) / 450) * f.flashAmt;
      flash.current.style.opacity = a.toFixed(3);
    }
    if (water.current) water.current.style.opacity = f.underwater ? '1' : '0';
  }), []);
  return (
    <div className="feel-layer" aria-hidden="true">
      <div className="water-tint" ref={water} />
      <div className="hurt-flash" ref={flash} />
      {[0, 1, 2, 3].map((i) => <div key={i} className="dmg-wedge" style={{ display: 'none' }} ref={(el) => { wedges.current[i] = el; }} />)}
      <div className="crosshair" ref={xh} style={{ display: 'none' }}><i /><i /><i /><i /><b /></div>
      <div className="hitmarker" ref={hit} style={{ display: 'none' }}><i /><i /><i /><i /></div>
      <svg className="reload-ring" ref={ringWrap} viewBox="0 0 30 30" width="44" height="44" style={{ display: 'none' }}><circle cx="15" cy="15" r="12" className="rr-track" /><circle ref={ring} cx="15" cy="15" r="12" className="rr-fill" transform="rotate(-90 15 15)" /></svg>
      <div className="xh-note" ref={note} style={{ display: 'none' }} />
    </div>
  );
}

export function Subtitles() {
  const story = useGame((s) => s.dialogue);
  const bark = useGame((s) => s.barkSub);
  const on = useGame((s) => s.settings.subtitlesOn);
  const size = useGame((s) => s.settings.subtitleSize);
  const now = useNow(250);
  const d = story && now <= story.until ? story : bark;
  if (!d || !on || now > d.until) return null;
  return (
    <div className={`subtitle sz-${size}`} key={d.text}>
      <b>{d.speaker}</b><span>{d.text}</span>
    </div>
  );
}

function Down() {
  const down = useGame((s) => s.hud.down);
  const now = useNow(250);
  if (down === null || down === undefined) return null;
  const secs = down > 1e11 ? Math.max(0, Math.ceil((down - now) / 1000)) : Math.max(0, Math.ceil(down));
  return (
    <div className="hud-down">
      <div className="down-card">
        <Icon name="skull" size={36} />
        <h2>KNOCKED OUT</h2>
        <p>{secs > 0 ? <>Waking up in <b>{secs}</b>…</> : 'Getting back up…'}</p>
      </div>
    </div>
  );
}

function PartyStrip() {
  const party = useGame((s) => s.party);
  const roster = useGame((s) => s.activity?.roster);
  const activeActivity = useGame((s) => !!s.activity); // own status in the party view lags: trust the local activity state
  const ents = useGame((s) => s.entities);
  const me = useGame((s) => s.user?.id);
  if (!party || party.members.length < 2) return null;
  const downNames = new Set<string>();
  for (const e of ents) if (e.k === 'p' && e.a === 6) downNames.add(e.n);
  return (
    <div className="hud-party">
      {party.members.filter((m) => m.id !== me || party.members.length > 1).map((m) => {
        const down = downNames.has(m.name) || roster?.find((r) => r.userId === m.id)?.down;
        return (
          <div key={m.id} className={`pp ${m.online ? '' : 'off'} ${down ? 'down' : ''}`}>
            <Avatar name={m.name} size={26} ring={m.leader ? 'var(--sun)' : undefined} />
            <span className="pp-name">{m.leader && <Icon name="crown" size={11} fill />}{m.name}</span>
            <span className="pp-state">{!m.online ? 'offline' : down ? 'down' : m.status === 'in_activity' && !(m.id === me && !activeActivity) ? 'on job' : m.status === 'in_interior' ? 'inside' : 'ok'}</span>
          </div>
        );
      })}
    </div>
  );
}

function PingFps() {
  const ping = useGame((s) => s.pingMs);
  const fps = useGame((s) => s.fps);
  const show = useGame((s) => s.settings.showFps);
  return (
    <div className="hud-ping">
      {show && <span className="fps"><b>{Math.round(fps)}</b> FPS</span>}
      <span className={`ping ${ping > 200 ? 'bad' : ping > 100 ? 'mid' : ''}`}><Icon name="wifi" size={12} /> {Math.round(ping)} ms</span>
    </div>
  );
}

function RecentChat() {
  const chat = useGame((s) => s.chat);
  const overlay = useGame((s) => s.overlay);
  const now = useNow(1000);
  if (overlay === 'chat') return null;
  const recent = chat.filter((c) => now - c.at < 14000).slice(-6);
  if (!recent.length) return null;
  return (
    <div className="hud-chat">
      {recent.map((c) => (
        <p key={c.id} className={`ch-${c.ch}`} style={{ opacity: clamp(1 - (now - c.at - 9000) / 5000, 0.2, 1) }}>
          <i>{c.ch}</i><b>{c.from}</b> {c.text}
        </p>
      ))}
    </div>
  );
}

function VignetteLow() {
  const hp = useGame((s) => s.hud.hp / Math.max(1, s.hud.maxHp));
  if (hp >= 0.3) return null;
  return <div className="low-vignette" style={{ opacity: clamp(1 - hp / 0.3, 0.25, 1) }} />;
}

export function Hud() {
  return (
    <div className="hud">
      <VignetteLow />
      <div className="hud-tl"><ObjectivePanel /><PartyStrip /></div>
      <div className="hud-tr"><CashBlock /><Wanted /><Ammo /></div>
      <RaceHud />
      <div className="hud-bl"><RecentChat /><Minimap /><Health /></div>
      <div className="hud-br"><Speedo /><PingFps /></div>
      <Crosshair />
      <WeaponWheel />
      <RadioWheel />
      <RadioCard />
      <Interact />
      <Subtitles />
      <Down />
    </div>
  );
}

// ───────────────────────────────────────────── global bits
export function Toasts() {
  const notices = useGame((s) => s.notices);
  return (
    <div className="toasts" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className={`toast ${n.kind}`}>
          <Icon name={n.kind === 'good' ? 'check' : n.kind === 'bad' ? 'info' : n.kind === 'mission' ? 'flag' : 'info'} size={16} />
          <span>{n.text}</span>
        </div>
      ))}
    </div>
  );
}

export function ConnBanner() {
  const conn = useGame((s) => s.conn);
  const msg = useGame((s) => s.connMessage);
  const user = useGame((s) => s.user);
  if (!user || conn === 'online' || conn === 'idle' || conn === 'connecting') return null;
  const text = msg || ({ reconnecting: 'Connection lost — trying to reconnect…', offline: 'You are offline. Check your connection.', version: 'A new version of VICE CRAFT is out. Refresh to update.', kicked: 'You were disconnected from the server.' } as Record<string, string>)[conn] || conn;
  const bad = conn !== 'reconnecting';
  return (
    <div className={`conn-banner ${bad ? 'bad' : 'warn'}`} role="alert">
      {conn === 'reconnecting' ? <Spinner size={16} /> : <Icon name="wifi" size={16} />}
      <span>{text}</span>
      {(conn === 'version' || conn === 'offline' || conn === 'kicked') && <Btn size="sm" variant="sun" onClick={() => location.reload()}>Refresh</Btn>}
    </div>
  );
}

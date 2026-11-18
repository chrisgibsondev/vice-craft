import { WORLD } from '@blockshore/shared';
import { useEffect, useState, type FormEvent } from 'react';
import { useGame } from '../../state/store';
import { api, ApiError } from '../../net/api';
import { login, register, autoLogin, joinWorld, openOverlay, logout, acceptPartyInvite, declinePartyInvite } from '../../state/actions';
import { setState } from '../../state/store';
import { getProviders, mountGoogleButton, startX } from '../../net/oauth';
import { useRef } from 'react';
import { Btn, Spinner, Tag, Bar, Avatar } from '../components';
import { Icon } from '../Icons';
import { money, fmtClock, useNow } from '../util';

export function Logo({ small }: { small?: boolean }) {
  return (
    <div className={`logo ${small ? 'small' : ''}`}>
      <div className="logo-sun" aria-hidden="true">
        <svg viewBox="0 0 120 120" width="100%" height="100%">
          <defs>
            <linearGradient id="lg-sun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#ffd23f" /><stop offset="1" stopColor="#ff4fa3" /></linearGradient>
            <clipPath id="lg-cl"><circle cx="60" cy="60" r="52" /></clipPath>
          </defs>
          <circle cx="60" cy="60" r="52" fill="url(#lg-sun)" />
          <g clipPath="url(#lg-cl)" fill="#12092a">
            <rect x="0" y="70" width="120" height="4" /><rect x="0" y="80" width="120" height="6" /><rect x="0" y="92" width="120" height="8" /><rect x="0" y="106" width="120" height="12" />
          </g>
        </svg>
      </div>
      <h1 className="logo-word" aria-label="Vice Craft">
        <span className="logo-top">VICE</span>
        <span className="logo-bot">CRAFT</span>
      </h1>
      {!small && <p className="logo-tag"><i /> {WORLD === 'leonia' ? <>LEONIA &nbsp;·&nbsp; MIAMI</> : <>PALMARA &nbsp;·&nbsp; PORT SOLANO</>} <i /></p>}
    </div>
  );
}

export function Boot() {
  return (
    <div className="screen center boot">
      <div className="boot-card"><Logo small /><Spinner size={34} /><p>Warming up the sunshine state…</p></div>
    </div>
  );
}

const USER_RE = /^[a-zA-Z0-9_]{3,16}$/;

export function Login() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const joinToken = useGame((s) => s.joinToken);
  const guest = useGame((s) => s.user);
  const [inviter, setInviter] = useState<string | null>(null);
  const [prov, setProv] = useState<{ google: string | null; x: string | null } | null>(null);
  const gRef = useRef<HTMLDivElement>(null);
  useEffect(() => { void getProviders().then(setProv); }, []);
  useEffect(() => {
    if (prov?.google && gRef.current) mountGoogleButton(gRef.current, prov.google, setErr).catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [prov?.google]);

  useEffect(() => {
    if (!joinToken) return;
    api.partyLinkInfo(joinToken).then((r) => setInviter(r.leaderName)).catch(() => setInviter(null));
  }, [joinToken]);

  const uErr = user && !USER_RE.test(user) ? 'Usernames are 3–16 characters: letters, numbers and underscores.' : '';
  const pErr = mode === 'register' && pass && pass.length < 8 ? 'Password must be at least 8 characters.' : '';
  const p2Err = mode === 'register' && pass2 && pass2 !== pass ? 'Passwords do not match.' : '';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr('');
    if (!USER_RE.test(user)) { setErr('Usernames are 3–16 characters: letters, numbers and underscores.'); return; }
    if (pass.length < 8) { setErr('Password must be at least 8 characters.'); return; }
    if (mode === 'register' && pass !== pass2) { setErr('Passwords do not match.'); return; }
    setBusy(true);
    try {
      if (mode === 'login') await login(user, pass); else await register(user, pass);
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : e2 instanceof Error ? e2.message : String(e2));
    } finally { setBusy(false); }
  }

  return (
    <div className="screen login">
      <div className="login-hero">
        <Logo />
        <ul className="pitch">
          <li><Icon name="car" size={18} /> Free-roam a sun-soaked blocky state</li>
          <li><Icon name="briefcase" size={18} /> Co-op heists with your crew</li>
          <li><Icon name="flag" size={18} /> Street races, jobs, shops &amp; heat</li>
        </ul>
      </div>
      <form className="glass login-card" onSubmit={submit} noValidate>
        <div className="login-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'on' : ''} onClick={() => { setMode('login'); setErr(''); }}>Log in</button>
          <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'on' : ''} onClick={() => { setMode('register'); setErr(''); }}>Create account</button>
          <i className={`login-ink ${mode}`} />
        </div>
        {(prov?.google || prov?.x) && (
          <div className="oauth-row">
            {prov.google && <div className="oauth-google" ref={gRef} />}
            {prov.x && <button type="button" className="oauth-x" onClick={() => void startX(prov.x!)}><svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M17.75 3h3.07l-6.7 7.66L22 21h-6.17l-4.83-6.32L5.47 21H2.4l7.17-8.2L2 3h6.33l4.37 5.78L17.75 3Zm-1.08 16.2h1.7L7.4 4.73H5.58l11.09 14.47Z"/></svg> Continue with X</button>}
            <div className="oauth-or"><span>or use a username</span></div>
          </div>
        )}
        {joinToken && (
          <div className="invite-note"><Icon name="link" size={16} /><span>{inviter ? <><b>{inviter}</b> invited you to their party.</> : 'You have a party invite link.'} Log in to join.</span></div>
        )}
        <label className="field">
          <span>Username</span>
          <input autoFocus autoComplete="username" value={user} maxLength={16} onChange={(e) => setUser(e.target.value)} placeholder="palm_pilot" className={uErr ? 'bad' : ''} />
          {uErr && <small className="ferr">{uErr}</small>}
        </label>
        <label className="field">
          <span>Password</span>
          <input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={pass} onChange={(e) => setPass(e.target.value)} placeholder="at least 8 characters" className={pErr ? 'bad' : ''} />
          {pErr && <small className="ferr">{pErr}</small>}
        </label>
        {mode === 'register' && (
          <label className="field">
            <span>Confirm password</span>
            <input type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} className={p2Err ? 'bad' : ''} />
            {p2Err && <small className="ferr">{p2Err}</small>}
          </label>
        )}
        {err && <div className="form-error" role="alert"><Icon name="info" size={16} /> {err}</div>}
        <Btn type="submit" size="lg" block disabled={busy} why="Working…" icon={busy ? undefined : 'play'}>{busy ? 'One moment…' : mode === 'login' ? 'Log in' : guest ? 'Save my account' : 'Create account'}</Btn>
        {guest
          ? <Btn type="button" variant="ghost" block onClick={() => setState({ screen: 'menu' })}>Back to menu</Btn>
          : <Btn type="button" variant="ghost" block disabled={busy} why="Working…" onClick={() => { setErr(''); setBusy(true); autoLogin().catch((e2) => setErr(e2 instanceof Error ? e2.message : String(e2))).finally(() => setBusy(false)); }}>Play without an account</Btn>}
        <p className="fine">{guest ? (mode === 'login' ? 'Logging in switches to that account. This guest account stays on this network.' : 'Optional. Keeps your progress and lets you play from any device.') : 'No email needed. Your progress is saved to your account.'}</p>
      </form>
    </div>
  );
}

function ConnPill() {
  const conn = useGame((s) => s.conn);
  const msg = useGame((s) => s.connMessage);
  const map: Record<string, { label: string; tone: 'green' | 'sun' | 'red' | 'grey' }> = {
    online: { label: 'Online', tone: 'green' }, connecting: { label: 'Connecting…', tone: 'sun' }, reconnecting: { label: 'Loading…', tone: 'sun' },
    offline: { label: 'Loading…', tone: 'sun' }, version: { label: 'Update needed', tone: 'red' }, kicked: { label: 'Disconnected', tone: 'red' }, idle: { label: 'Not connected', tone: 'grey' },
  };
  const m = map[conn] ?? map.idle;
  return <Tag tone={m.tone} icon="wifi" title={msg}>{m.label}</Tag>;
}

function Invites() {
  const invites = useGame((s) => s.partyInvites);
  const now = useNow(1000);
  if (!invites.length) return null;
  return (
    <div className="glass invites">
      <h3><Icon name="users" size={16} /> Party invites</h3>
      {invites.map((i) => (
        <div className="invite-row" key={i.partyId}>
          <Avatar name={i.fromName} size={32} />
          <div className="grow"><b>{i.fromName}</b><small>{i.size} in party · expires in {fmtClock(i.expires - now)}</small></div>
          <Btn size="sm" variant="aqua" onClick={() => void acceptPartyInvite(i.partyId)}>Accept</Btn>
          <Btn size="sm" variant="ghost" onClick={() => void declinePartyInvite(i.partyId)}>Decline</Btn>
        </div>
      ))}
    </div>
  );
}

export function Menu() {
  const user = useGame((s) => s.user);
  const profile = useGame((s) => s.profile);
  const party = useGame((s) => s.party);
  const conn = useGame((s) => s.conn);
  const online = conn === 'online';
  const off = online ? undefined : 'Waiting for the game server…';
  return (
    <div className="screen menu">
      <div className="menu-left">
        <Logo />
        <nav className="menu-list" aria-label="Main menu">
          <Btn size="lg" icon="play" onClick={() => joinWorld('auto')} disabled={!online} why={off} className="menu-btn big">Play</Btn>
          {party && <Btn size="lg" variant="aqua" icon="users" onClick={() => joinWorld('party')} disabled={!online} why={off} className="menu-btn">Join party&apos;s world</Btn>}
          <Btn size="lg" variant="ghost" icon="globe" onClick={() => openOverlay('worlds')} className="menu-btn">Choose world</Btn>
          <Btn size="lg" variant="ghost" icon="users" onClick={() => openOverlay('social')} className="menu-btn">Friends &amp; Party</Btn>
          <Btn size="lg" variant="ghost" icon="gear" onClick={() => openOverlay('settings')} className="menu-btn">Settings</Btn>
          <Btn size="lg" variant="ghost" icon="star" onClick={() => openOverlay('credits')} className="menu-btn">Credits</Btn>
          {user?.admin && <Btn size="lg" variant="sun" icon="shield" onClick={() => openOverlay('admin')} className="menu-btn">Admin</Btn>}
          {user?.guest
            ? <Btn size="lg" variant="ghost" icon="users" onClick={() => setState({ screen: 'login' })} className="menu-btn">Sign in (optional)</Btn>
            : <Btn size="lg" variant="ghost" icon="logout" onClick={() => void logout()} className="menu-btn">Log out</Btn>}
        </nav>
      </div>
      <aside className="menu-right">
        <div className="glass me-card">
          <Avatar name={user?.name ?? '?'} size={52} />
          <div className="grow">
            <b className="me-name">{user?.name ?? '—'}</b>
            <div className="me-stats">
              <span><Icon name="coin" size={15} /> {money(profile?.cash ?? 0)}</span>
              <span><Icon name="star" size={15} /> {profile?.rep ?? 0} rep</span>
            </div>
          </div>
          <ConnPill />
        </div>
        <Invites />
        {party && (
          <div className="glass party-mini">
            <h3><Icon name="users" size={16} /> Your party</h3>
            <div className="party-avatars">
              {party.members.map((m) => (
                <span key={m.id} className={`pm ${m.online ? '' : 'off'}`} title={`${m.name}${m.leader ? ' (leader)' : ''}${m.online ? '' : ' (offline)'}`}>
                  <Avatar name={m.name} size={38} ring={m.leader ? 'var(--sun)' : undefined} />
                  {m.leader && <Icon name="crown" size={13} className="pm-crown" fill />}
                </span>
              ))}
            </div>
            <small>Press <b>Play</b> or <b>Join party&apos;s world</b> to drop in together.</small>
          </div>
        )}
        <div className="menu-hint glass"><Icon name="info" size={16} /><span>Tip: <b>Arrow Up</b> opens your phone, <b>M</b> the map, <b>P</b> friends &amp; party, <b>T</b> chat.</span></div>
      </aside>
    </div>
  );
}

const TIPS = [
  'Press ↑ to open your phone. Contacts hand out jobs, and your garage delivers your car.',
  'Heists pay best with a full crew. Share the take any way you like in the lobby.',
  'Police search where they last saw you. Break line of sight and stay out of the glowing circle.',
  'You can set a waypoint on the map. Click anywhere to drop it, click it again to clear it.',
  'Party members can always join your world, and invite links work for friends who have no account yet.',
  'Hold the interact key near objectives, shops and doors. The ring fills as you hold.',
  'Replaying a finished story job still pays, just a bit less, and never changes your story progress.',
];

export function Loading() {
  const loading = useGame((s) => s.loading);
  const [tip, setTip] = useState(() => Math.floor(Math.random() * TIPS.length));
  useEffect(() => { const id = setInterval(() => setTip((t) => (t + 1) % TIPS.length), 4500); return () => clearInterval(id); }, []);
  const raw = loading?.progress ?? 0;
  const p = Math.max(0, Math.min(1, raw > 1 ? raw / 100 : raw));
  return (
    <div className="screen center loading">
      <div className="loading-card">
        <Logo small />
        <div className="load-bar"><Bar value={p * 100} tone="aqua" className="thick" /><span className="load-pct">{Math.round(p * 100)}%</span></div>
        <p className="load-label"><Spinner size={16} /> {loading?.label ?? 'Loading…'}</p>
        <p className="tip" key={tip}><b>TIP</b> {TIPS[tip]}</p>
      </div>
    </div>
  );
}

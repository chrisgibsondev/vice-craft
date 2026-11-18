/* eslint-disable @typescript-eslint/no-explicit-any */
import { WORLD } from '@blockshore/shared';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useGame } from '../../state/store';
import { api, ApiError } from '../../net/api';
import {
  closeOverlay, openOverlay, leaveWorld, logout, joinWorld, refreshWorlds, sendChat,
} from '../../state/actions';
import { pushNotice } from '../../state/store';
import { Modal, Btn, Tag, Bar, Empty, Spinner, Tabs, Avatar, SectionTitle } from '../components';
import { Icon } from '../Icons';
import { useNow, money } from '../util';

// ───────────────────────────────────────────── pause
export function Pause({ leaving }: { leaving: boolean }) {
  const user = useGame((s) => s.user);
  const profile = useGame((s) => s.profile);
  const world = useGame((s) => s.world);
  const party = useGame((s) => s.party);
  return (
    <div className={`scrim pause ${leaving ? 'out' : ''}`}>
      <div className="pause-wrap">
        <div className="pause-head">
          <h2>PAUSED</h2>
          <p>{world ? <><Icon name="globe" size={14} /> {world.label} · {world.players}/{world.capacity} players</> : 'Not in a world'}</p>
          <div className="pause-me">
            <Avatar name={user?.name ?? '?'} size={30} /> <b>{user?.name}</b>
            <span><Icon name="coin" size={14} /> {money(profile?.cash ?? 0)}</span>
            {party && <Tag tone="aqua" icon="users">Party of {party.members.length}</Tag>}
          </div>
        </div>
        <div className="pause-list">
          <Btn size="lg" icon="play" onClick={closeOverlay} className="menu-btn big">Resume</Btn>
          <Btn size="lg" variant="ghost" icon="gear" onClick={() => openOverlay('settings')} className="menu-btn">Settings</Btn>
          <Btn size="lg" variant="ghost" icon="map" onClick={() => openOverlay('map')} className="menu-btn">Map</Btn>
          <Btn size="lg" variant="ghost" icon="users" onClick={() => openOverlay('social')} className="menu-btn">Friends &amp; Party</Btn>
          <Btn size="lg" variant="ghost" icon="globe" onClick={() => openOverlay('worlds')} className="menu-btn">Choose world</Btn>
          <Btn size="lg" variant="danger" icon="logout" onClick={leaveWorld} className="menu-btn" disabled={!world} why="You are not in a world">Leave world</Btn>
          <Btn size="lg" variant="ghost" icon="logout" onClick={() => void logout()} className="menu-btn">Log out</Btn>
        </div>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────── lobbies (worlds)
const ACCESS_LABEL: Record<string, { label: string; tone: 'aqua' | 'pink' | 'sun'; icon: string; desc: string }> = {
  public: { label: 'Public', tone: 'aqua', icon: 'globe', desc: 'Anyone can join from the lobby browser.' },
  friends: { label: 'Friends only', tone: 'pink', icon: 'heart', desc: 'Your friends (and your party) can join. Others need the code.' },
  invite: { label: 'Invite only', tone: 'sun', icon: 'lock', desc: 'Hidden from the browser. Share the 6-letter code with your friends.' },
};

export function Worlds({ leaving }: { leaving: boolean }) {
  const worlds = useGame((s) => s.worlds);
  const party = useGame((s) => s.party);
  const current = useGame((s) => s.world);
  const user = useGame((s) => s.user);
  const conn = useGame((s) => s.conn);
  const [tab, setTab] = useState<'browse' | 'create' | 'code'>('browse');
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState('');
  const [access, setAccess] = useState<'public' | 'friends' | 'invite'>('friends');
  const [cap, setCap] = useState(8);
  const [code, setCode] = useState('');
  const online = conn === 'online';
  const off = online ? undefined : 'Waiting for the game server…';
  useEffect(() => {
    setLoading(true);
    void refreshWorlds().finally(() => setLoading(false));
    const id = setInterval(() => void refreshWorlds(), 6000);
    return () => clearInterval(id);
  }, []);
  const create = (e?: FormEvent) => {
    e?.preventDefault();
    joinWorld({ create: { name: name.trim() || `${user?.name ?? 'My'}'s lobby`, access, capacity: cap } });
  };
  const byCode = (e?: FormEvent) => {
    e?.preventDefault();
    const c = code.trim().toUpperCase();
    if (c.length < 4) { pushNotice('Enter the lobby code (6 letters/numbers).', 'bad'); return; }
    joinWorld({ code: c });
  };
  const publicCount = worlds.filter((w: any) => (w.access ?? 'public') === 'public').length;
  return (
    <Modal title="Lobbies" icon="globe" leaving={leaving} accent="aqua"
      subtitle="Every lobby has a hard player cap (max 16). Create your own for you and your friends, or jump into an online lobby with other players."
      footer={
        <>
          <Btn variant="aqua" icon="play" onClick={() => joinWorld('auto')} disabled={!online} why={off}>Quick join</Btn>
          <Btn variant="primary" icon="users" onClick={() => joinWorld('party')} disabled={!party || !online} why={!party ? 'You are not in a party' : off}>Join my party</Btn>
          <span className="grow" />
          <Btn variant="ghost" icon="search" onClick={() => void refreshWorlds()}>Refresh</Btn>
        </>
      }>
      {current && (current as any).code && current.kind === 'world' && (
        <div className="lobby-current">
          <Icon name="globe" size={18} />
          <div className="grow"><b>{current.label}</b> · {current.players}/{current.capacity} players · {ACCESS_LABEL[(current as any).access ?? 'public']?.label}</div>
          <span className="lobby-code" title="Share this code so friends can join">CODE <b>{(current as any).code}</b></span>
          <Btn size="sm" variant="ghost" onClick={() => { void navigator.clipboard?.writeText((current as any).code); pushNotice('Lobby code copied.', 'good'); }}>Copy</Btn>
        </div>
      )}
      <div className="lobby-tabs">
        <button className={tab === 'browse' ? 'on' : ''} onClick={() => setTab('browse')}><Icon name="globe" size={15} /> Browse ({worlds.length})</button>
        <button className={tab === 'create' ? 'on' : ''} onClick={() => setTab('create')}><Icon name="plus" size={15} /> Create lobby</button>
        <button className={tab === 'code' ? 'on' : ''} onClick={() => setTab('code')}><Icon name="lock" size={15} /> Join with code</button>
      </div>

      {tab === 'browse' && (loading && !worlds.length ? <div className="center-pad"><Spinner /></div> : !worlds.length ? <Empty icon="globe">No lobbies open right now. <b>Quick join</b> starts one, or create your own.</Empty> : (
        <>
          <p className="muted small">{publicCount} public lobb{publicCount === 1 ? 'y' : 'ies'} online{worlds.length > publicCount ? ` · ${worlds.length - publicCount} from friends/party` : ''}</p>
          <ul className="list worlds">
            {worlds.map((w: any) => {
              const here = current?.instance === w.id;
              const acc = ACCESS_LABEL[w.access ?? 'public'];
              const blocked = !here && w.joinable === false;
              return (
                <li key={w.id} className={here ? 'here' : ''}>
                  <span className="w-ico"><Icon name={acc.icon as any} size={22} /></span>
                  <div className="grow">
                    <b>{w.label}</b>{w.host && <span className="muted small"> · hosted by {w.host}</span>}
                    <div className="w-meta">
                      <span className="w-pop"><Bar value={w.players} max={w.capacity} tone={w.full ? 'red' : 'aqua'} /> {w.players}/{w.capacity}</span>
                      <Tag tone={acc.tone} icon={acc.icon as any}>{acc.label}</Tag>
                      {w.friends > 0 && <Tag tone="pink" icon="heart">{w.friends} friend{w.friends > 1 ? 's' : ''}</Tag>}
                      {w.full && <Tag tone="red">Full</Tag>}
                      {here && <Tag tone="green">You are here</Tag>}
                      {w.code && <Tag tone="sun">Code {w.code}</Tag>}
                    </div>
                  </div>
                  <Btn size="sm" variant={w.friends > 0 ? 'primary' : 'aqua'} disabled={here || w.full || blocked || !online}
                    why={here ? 'You are already here' : w.full ? 'This lobby is full' : blocked ? 'Needs an invite code' : off}
                    onClick={() => joinWorld({ instance: w.id })}>Join</Btn>
                </li>
              );
            })}
          </ul>
        </>
      ))}

      {tab === 'create' && (
        <form className="lobby-create" onSubmit={create}>
          <label>Lobby name
            <input value={name} maxLength={32} placeholder={`${user?.name ?? 'My'}'s lobby`} onChange={(e) => setName(e.target.value)} />
          </label>
          <div className="lobby-access">
            {(['public', 'friends', 'invite'] as const).map((a) => (
              <button type="button" key={a} className={access === a ? 'on' : ''} onClick={() => setAccess(a)}>
                <Icon name={ACCESS_LABEL[a].icon as any} size={18} />
                <b>{ACCESS_LABEL[a].label}</b>
                <small>{ACCESS_LABEL[a].desc}</small>
              </button>
            ))}
          </div>
          <label>Max players: <b>{cap}</b>
            <input type="range" min={2} max={16} value={cap} onChange={(e) => setCap(Number(e.target.value))} />
            <small className="muted">The cap can never be exceeded — when the lobby is full, nobody else can join until someone leaves.</small>
          </label>
          <Btn variant="sun" icon="plus" disabled={!online} why={off} onClick={() => create()}>Create &amp; enter lobby</Btn>
        </form>
      )}

      {tab === 'code' && (
        <form className="lobby-code-form" onSubmit={byCode}>
          <p className="muted">Got a code from a friend? Enter it to join their lobby — even if it&apos;s invite-only.</p>
          <input className="code-input" value={code} maxLength={8} placeholder="K7Q2MD" onChange={(e) => setCode(e.target.value.toUpperCase())} />
          <Btn variant="primary" icon="play" disabled={!online} why={off} onClick={() => byCode()}>Join lobby</Btn>
        </form>
      )}
    </Modal>
  );
}

// ───────────────────────────────────────────── chat
export function ChatDock({ leaving }: { leaving: boolean }) {
  const chat = useGame((s) => s.chat);
  const party = useGame((s) => s.party);
  const activity = useGame((s) => s.activity);
  const world = useGame((s) => s.world);
  const inAct = !!activity || world?.kind === 'activity';
  const [ch, setCh] = useState<'party' | 'world' | 'activity'>(party ? 'party' : 'world');
  const [text, setText] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const lines = chat.filter((c) => c.ch === ch);
  useEffect(() => { logRef.current?.scrollTo({ top: 1e6 }); }, [lines.length, ch]);
  const disabledWhy = ch === 'party' && !party ? 'Join a party to use party chat' : ch === 'activity' && !inAct ? 'You are not in an activity' : '';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (disabledWhy) return;
    if (text.trim()) sendChat(ch, text);
    setText('');
    closeOverlay();
  };
  return (
    <div className={`chatdock ${leaving ? 'out' : ''}`}>
      <Tabs value={ch} onChange={setCh} tabs={[{ id: 'party', label: 'Party', icon: 'users' }, { id: 'world', label: 'World', icon: 'globe' }, { id: 'activity', label: 'Activity', icon: 'flag' }]} />
      <div className="chat-log" ref={logRef}>
        {lines.length === 0 && <p className="muted">No messages in this channel yet.</p>}
        {lines.map((c) => <p key={c.id}><b>{c.from}</b> {c.text}</p>)}
      </div>
      <form onSubmit={submit} className="chat-form">
        <input autoFocus value={text} onChange={(e) => setText(e.target.value)} maxLength={200} placeholder={disabledWhy || `Message ${ch}…  (Enter to send, Esc to close)`} disabled={!!disabledWhy} />
        <Btn type="submit" size="sm" icon="chat" disabled={!!disabledWhy || !text.trim()} why={disabledWhy || 'Type a message first'}>Send</Btn>
      </form>
    </div>
  );
}

// ───────────────────────────────────────────── credits
function CreditCard({ item }: { item: any }) {
  if (item == null) return null;
  if (typeof item === 'string') return <li className="credit"><span>{item}</span></li>;
  const title = item.title ?? item.name ?? item.id ?? 'Untitled';
  const author = item.author ?? item.creator ?? item.artist ?? item.by;
  const license = item.license ?? item.licence;
  const src = item.source ?? item.url ?? item.link ?? item.href;
  return (
    <li className="credit">
      <b>{String(title)}</b>
      {author && <span>by {String(author)}</span>}
      <span className="credit-tags">
        {license && <Tag tone="aqua">{String(license)}</Tag>}
        {typeof src === 'string' && /^https?:/.test(src) && <a href={src} target="_blank" rel="noreferrer noopener">Source <Icon name="link" size={12} /></a>}
        {typeof src === 'string' && !/^https?:/.test(src) && <small>{src}</small>}
      </span>
    </li>
  );
}

export function Credits({ leaving }: { leaving: boolean }) {
  const [data, setData] = useState<{ models: any[]; audio: any } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.credits().then((d) => setData(d as any)).catch((e) => setErr(e instanceof ApiError ? e.message : String(e)));
  }, []);
  const audioList: any[] = useMemo(() => {
    const a = data?.audio;
    if (!a) return [];
    if (Array.isArray(a)) return a;
    if (Array.isArray(a.tracks) || Array.isArray(a.sfx) || Array.isArray(a.music)) return [...(a.tracks ?? []), ...(a.music ?? []), ...(a.sfx ?? [])];
    if (typeof a === 'object') return Object.entries(a).map(([k, v]) => (typeof v === 'string' ? { title: k, license: v } : { title: k, ...(v as object) }));
    return [];
  }, [data]);
  return (
    <Modal title="Credits" icon="star" leaving={leaving} wide subtitle="VICE CRAFT is built with the help of many creators. Thank you.">
      <div className="credits-grid">
        <section>
          <SectionTitle>Game by</SectionTitle>
          <p className="muted">{WORLD === 'leonia' ? 'VICE CRAFT — an original blocky open world set in Leonia, a fictional state built on the real streets, coastline and buildings of Miami. Characters and businesses are fictional. Map data © OpenStreetMap contributors (ODbL 1.0).' : 'VICE CRAFT — an original blocky open world set in the sunny state of Palmara. All names, places and characters are fictional.'}</p>
          <SectionTitle>Fonts</SectionTitle>
          <ul className="credit-list">
            <CreditCard item={{ title: 'Bungee', author: 'David Jonathan Ross', license: 'SIL OFL 1.1', source: 'https://fonts.google.com/specimen/Bungee' }} />
            <CreditCard item={{ title: 'Inter', author: 'Rasmus Andersson', license: 'SIL OFL 1.1', source: 'https://rsms.me/inter/' }} />
            <CreditCard item={{ title: 'JetBrains Mono', author: 'JetBrains', license: 'SIL OFL 1.1', source: 'https://www.jetbrains.com/lp/mono/' }} />
          </ul>
        </section>
        <section>
          <SectionTitle>3D models</SectionTitle>
          {!data && !err && <div className="center-pad"><Spinner /></div>}
          {err && <p className="form-error"><Icon name="info" size={16} /> {err}</p>}
          {data && (data.models.length ? <ul className="credit-list">{data.models.map((m, i) => <CreditCard key={i} item={m} />)}</ul> : <p className="muted">No third-party models are used.</p>)}
          <SectionTitle>Audio</SectionTitle>
          {data && (audioList.length ? <ul className="credit-list">{audioList.map((m, i) => <CreditCard key={i} item={m} />)}</ul> : <p className="muted">No third-party audio is used.</p>)}
        </section>
      </div>
    </Modal>
  );
}

// ───────────────────────────────────────────── admin
export function Admin({ leaving }: { leaving: boolean }) {
  const [tab, setTab] = useState<'live' | 'reports' | 'broadcast'>('live');
  const [ov, setOv] = useState<any>(null);
  const [reports, setReports] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [banFor, setBanFor] = useState<string | null>(null);
  const [banHours, setBanHours] = useState(24);
  const [banReason, setBanReason] = useState('');
  const now = useNow(1000);
  void now;
  const load = useCallback(async () => {
    try {
      const [o, r] = await Promise.all([api.adminOverview(), api.adminReports()]);
      setOv(o); setReports(r.reports as any[]); setErr('');
    } catch (e) { setErr(e instanceof ApiError ? e.message : String(e)); }
  }, []);
  useEffect(() => { void load(); const id = setInterval(() => void load(), 6000); return () => clearInterval(id); }, [load]);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); pushNotice(ok, 'good'); await load(); } catch (e) { pushNotice(e instanceof ApiError ? e.message : String(e), 'bad'); }
  };
  const instances: any[] = ov?.instances ?? [];
  const openReports = reports.filter((r) => !r.resolved && r.status !== 'resolved');
  return (
    <Modal title="Admin" icon="shield" leaving={leaving} wide accent="sun"
      subtitle={ov ? `${ov.online ?? 0} online · ${instances.length} instance${instances.length === 1 ? '' : 's'}` : 'Loading…'}>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'live', label: 'Live', icon: 'globe' }, { id: 'reports', label: 'Reports', icon: 'flag', badge: openReports.length }, { id: 'broadcast', label: 'Broadcast', icon: 'chat' }]} />
      {err && <p className="form-error"><Icon name="info" size={16} /> {err}</p>}
      {tab === 'live' && (
        instances.length === 0 ? <Empty icon="globe">No running instances.</Empty> : (
          <div className="admin-grid">
            {instances.map((inst, i) => {
              const players: any[] = Array.isArray(inst.players) ? inst.players : Array.isArray(inst.users) ? inst.users : [];
              const count = Array.isArray(inst.players) ? players.length : typeof inst.players === 'number' ? inst.players : (inst.count ?? players.length);
              const id = String(inst.id ?? inst.instance ?? i);
              return (
                <div className="glass inst" key={id}>
                  <div className="inst-head">
                    <b>{inst.label ?? id}</b>
                    <Tag tone={inst.kind === 'activity' ? 'violet' : 'aqua'}>{inst.kind ?? 'world'}</Tag>
                    <span className="grow" />
                    <small>{count} player{count === 1 ? '' : 's'}</small>
                    <Btn size="sm" variant="danger" onClick={() => void run(() => api.adminClose(id), 'Instance closed.')}>Close</Btn>
                  </div>
                  {players.length === 0 ? <p className="muted">No player details available.</p> : (
                    <ul className="list compact">
                      {players.map((p, j) => {
                        const pid = String(p.id ?? p.userId ?? j);
                        return (
                          <li key={pid}>
                            <Avatar name={String(p.name ?? p.n ?? '?')} size={26} />
                            <span className="grow">{p.name ?? p.n ?? pid}</span>
                            <Btn size="sm" variant="ghost" onClick={() => void run(() => api.adminKick(pid), 'Player kicked.')}>Kick</Btn>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}
      {tab === 'reports' && (
        reports.length === 0 ? <Empty icon="check">No reports. Nice and quiet.</Empty> : (
          <ul className="list reports">
            {reports.map((r, i) => {
              const rid = Number(r.id ?? i);
              const target = String(r.userId ?? r.targetId ?? r.reportedId ?? '');
              const resolved = r.resolved || r.status === 'resolved';
              return (
                <li key={rid} className={resolved ? 'resolved' : ''}>
                  <div className="grow">
                    <b>{r.targetName ?? r.reportedName ?? r.name ?? target}</b> <small>reported by {r.reporterName ?? r.fromName ?? r.reporter ?? 'unknown'}</small>
                    <p>{r.reason}</p>
                    {r.context && <small className="muted">{r.context}</small>}
                    {banFor === String(rid) && (
                      <div className="ban-form">
                        <input type="number" min={1} max={24 * 365} value={banHours} onChange={(e) => setBanHours(Number(e.target.value))} aria-label="Ban hours" />
                        <span>hours</span>
                        <input placeholder="Reason" value={banReason} onChange={(e) => setBanReason(e.target.value)} />
                        <Btn size="sm" variant="danger" disabled={!target || !banReason.trim()} why={!target ? 'Report has no target id' : 'Add a reason'} onClick={() => void run(async () => { await api.adminBan(target, banHours, banReason); await api.adminResolve(rid); setBanFor(null); setBanReason(''); }, 'Player banned.')}>Confirm ban</Btn>
                        <Btn size="sm" variant="ghost" onClick={() => setBanFor(null)}>Cancel</Btn>
                      </div>
                    )}
                  </div>
                  {resolved ? <Tag tone="green">Resolved</Tag> : (
                    <>
                      <Btn size="sm" variant="aqua" onClick={() => void run(() => api.adminResolve(rid), 'Report resolved.')}>Resolve</Btn>
                      <Btn size="sm" variant="danger" onClick={() => setBanFor(String(rid))}>Ban…</Btn>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )
      )}
      {tab === 'broadcast' && (
        <form className="broadcast" onSubmit={(e) => { e.preventDefault(); if (msg.trim()) void run(async () => { await api.adminBroadcast(msg.trim()); setMsg(''); }, 'Broadcast sent.'); }}>
          <label className="field"><span>Message to every player online</span><textarea value={msg} maxLength={240} onChange={(e) => setMsg(e.target.value)} rows={4} placeholder="Server restarts in 5 minutes…" /></label>
          <Btn type="submit" variant="sun" icon="chat" disabled={!msg.trim()} why="Write a message first">Send broadcast</Btn>
        </form>
      )}
    </Modal>
  );
}

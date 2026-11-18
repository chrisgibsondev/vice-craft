import { useEffect, useMemo, useRef, useState } from 'react';
import { ACTIVITIES, CONTACTS, DELIVERY_PRICE, VEHICLES, type ActivityDef, type VehicleModel } from '@blockshore/shared';
import { getState, setState, useGame } from '../../state/store';
import { closeOverlay, openBrief, openContact, openOverlay, garage, updateSettings } from '../../state/actions';
import { livePose } from '../../game/livePose';
import { getMapTexture, MAP_SCALE, onMapTexture } from '../mapTexture';
import { setWaypoint } from '../waypoint';
import { Icon } from '../Icons';
import { Btn, Tag, Spinner, Empty, Avatar, Slider } from '../components';
import { hex, money, useWaypoint, useNow } from '../util';
import { Browser } from '../web/Browser';

type App = 'home' | 'contacts' | 'contact' | 'jobs' | 'social' | 'browser' | 'garage' | 'map' | 'settings';

const APPS: { id: Exclude<App, 'home' | 'contact'>; label: string; icon: string; color: string }[] = [
  { id: 'contacts', label: 'Contacts', icon: 'phone', color: '#2ee6d6' },
  { id: 'jobs', label: 'Jobs', icon: 'briefcase', color: '#ffd23f' },
  { id: 'social', label: 'Social', icon: 'users', color: '#ff4fa3' },
  { id: 'browser', label: 'Browser', icon: 'globe', color: '#4c8dff' },
  { id: 'garage', label: 'Garage', icon: 'car', color: '#9b5de5' },
  { id: 'map', label: 'Map', icon: 'map', color: '#06d6a0' },
  { id: 'settings', label: 'Settings', icon: 'gear', color: '#8d99ae' },
];

function jobStatus(a: ActivityDef, completed: Record<string, number>, rep: number): 'locked' | 'available' | 'done' {
  if ((completed[a.id] ?? 0) > 0) return 'done';
  const req = a.unlock.requires ?? [];
  if (req.some((r) => !(completed[r] > 0))) return 'locked';
  if ((a.unlock.rep ?? 0) > rep) return 'locked';
  return 'available';
}

function StatusTag({ s }: { s: 'locked' | 'available' | 'done' }) {
  return s === 'done' ? <Tag tone="green" icon="check">Done</Tag> : s === 'locked' ? <Tag tone="grey" icon="lock">Locked</Tag> : <Tag tone="sun">New</Tag>;
}

function MapPreview() {
  const ref = useRef<HTMLCanvasElement>(null);
  const draw = () => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d')!;
    const h = getState().hud;
    const x = (livePose.active ? livePose.x : h.x || livePose.x) / MAP_SCALE;
    const z = (livePose.active ? livePose.z : h.z || livePose.z) / MAP_SCALE;
    const w = c.width, hh = c.height, span = 140;
    ctx.fillStyle = '#16356f'; ctx.fillRect(0, 0, w, hh);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(getMapTexture().canvas, x - span / 2, z - (span * hh) / w / 2, span, (span * hh) / w, 0, 0, w, hh);
    ctx.beginPath(); ctx.arc(w / 2, hh / 2, 7, 0, Math.PI * 2); ctx.fillStyle = '#ff4fa3'; ctx.fill(); ctx.lineWidth = 2.5; ctx.strokeStyle = '#fff'; ctx.stroke();
  };
  useEffect(() => { draw(); return onMapTexture(draw); });
  return <canvas ref={ref} className="ph-mapprev" width={280} height={170} />;
}

/** dev/demo hook: open the phone straight into an app */
export const phoneLaunch: { app: App | null } = { app: null };

export function Phone({ leaving }: { leaving: boolean }) {
  const [app, setApp] = useState<App>(() => { const a = phoneLaunch.app ?? 'home'; phoneLaunch.app = null; return a; });
  const [contactId, setContactId] = useState<string | null>(null);
  const profile = useGame((s) => s.profile);
  const contact = useGame((s) => s.contact);
  const social = useGame((s) => s.social);
  const party = useGame((s) => s.party);
  const settings = useGame((s) => s.settings);
  const wanted = useGame((s) => s.hud.wanted);
  const wp = useWaypoint();
  const now = useNow(15000);
  const d = new Date(now);
  const clock = `${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')}`;
  const completed = profile?.completed ?? {};
  const rep = profile?.rep ?? 0;

  useEffect(() => { setState({ contact: null }); }, []);

  const groups = useMemo(() => {
    const kinds: { id: string; title: string; test: (a: ActivityDef) => boolean }[] = [
      { id: 'mission', title: 'Story missions', test: (a) => a.kind === 'mission' },
      { id: 'heist', title: 'Heists', test: (a) => a.kind === 'heist' },
      { id: 'prep', title: 'Heist preps', test: (a) => a.kind === 'heist_prep' },
      { id: 'mini', title: 'Races & minigames', test: (a) => a.kind === 'minigame' },
    ];
    return kinds.map((k) => ({ ...k, items: ACTIVITIES.filter(k.test) })).filter((g) => g.items.length);
  }, []);

  const goBack = () => {
    if (app === 'contact') { setApp('contacts'); setContactId(null); setState({ contact: null }); } else setApp('home');
  };
  const title = app === 'home' ? '' : app === 'contact' ? (contactId ? CONTACTS[contactId]?.name ?? 'Contact' : 'Contact') : APPS.find((a) => a.id === app)?.label ?? '';
  const vehicles = profile?.vehicles ?? [];
  const friendsOn = social.friends.filter((f) => f.status !== 'offline');

  return (
    <div className={`scrim phone-scrim ${leaving ? 'out' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget) closeOverlay(); }}>
      <div className="phone" role="dialog" aria-label="Phone">
        <div className="ph-notch" />
        <div className="ph-status"><b>{clock}</b><span><Icon name="wifi" size={13} /> <span className="batt"><i /></span></span></div>
        <div className={`ph-screen app-${app}`}>
          {app !== 'home' && (
            <div className="ph-bar">
              <button type="button" onClick={goBack} aria-label="Back"><Icon name="back" size={18} /></button>
              <b>{title}</b>
            </div>
          )}
          <div className="ph-content" key={app + (contactId ?? '')}>
            {app === 'home' && (
              <>
                <div className="ph-widget">
                  <span className="ph-time">{clock}</span>
                  <span className="ph-date">{d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</span>
                  <span className="ph-cash"><Icon name="coin" size={14} /> {money(profile?.cash ?? 0)}</span>
                </div>
                <div className="ph-grid">
                  {APPS.map((a) => (
                    <button key={a.id} type="button" className="ph-app" onClick={() => setApp(a.id)} style={{ ['--ac' as string]: a.color }}>
                      <span className="ph-ico"><Icon name={a.icon} size={26} /></span><span>{a.label}</span>
                    </button>
                  ))}
                </div>
                <div className="ph-hint">Press <kbd className="keycap">Esc</kbd> to put the phone away</div>
              </>
            )}
            {app === 'browser' && <Browser />}
            {app === 'contacts' && (
              <ul className="ph-list">
                {Object.entries(CONTACTS).map(([id, c]) => (
                  <li key={id}>
                    <button type="button" onClick={() => { setContactId(id); setApp('contact'); setState({ contact: null }); openContact(id); }}>
                      <Avatar name={c.name} size={42} color={hex(c.color)} />
                      <span className="grow"><b>{c.name}</b><small>{c.role}</small></span>
                      <Icon name="phone" size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {app === 'contact' && contactId && (
              contact && contact.contact === contactId ? (
                <>
                  <div className="ph-contact">
                    <Avatar name={contact.name} size={56} color={hex(CONTACTS[contactId]?.color ?? 0xffffff)} />
                    <b>{contact.name}</b><small>{contact.role}</small>
                    <p>{contact.blurb}</p>
                  </div>
                  {contact.jobs.length === 0 ? <Empty icon="briefcase">No work for you right now.</Empty> : (
                    <ul className="ph-list">
                      {contact.jobs.map((j) => (
                        <li key={j.id}>
                          <button type="button" disabled={j.status === 'locked'} onClick={() => openBrief(j.id)} title={j.status === 'locked' ? 'Finish earlier jobs to unlock this' : undefined}>
                            <span className="grow"><b>{j.name}</b><small>{j.blurb}</small></span>
                            <StatusTag s={j.status} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              ) : <div className="center-pad"><Spinner /><p className="muted">Calling {CONTACTS[contactId]?.name ?? 'contact'}…</p></div>
            )}
            {app === 'jobs' && (
              <div className="ph-jobs">
                {groups.map((g) => (
                  <div key={g.id}>
                    <h4 className="ph-h">{g.title}</h4>
                    <ul className="ph-list">
                      {g.items.map((a) => {
                        const st = jobStatus(a, completed, rep);
                        const giver = CONTACTS[a.giver];
                        return (
                          <li key={a.id}>
                            <button type="button" disabled={st === 'locked'} onClick={() => openBrief(a.id)} title={st === 'locked' ? 'Locked: finish earlier jobs first' : undefined}>
                              <Avatar name={giver?.name ?? a.giver} size={32} color={giver ? hex(giver.color) : undefined} />
                              <span className="grow"><b>{a.name}</b><small>{giver?.name ?? a.giver}</small></span>
                              <StatusTag s={st} />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ))}
                <Btn size="sm" variant="ghost" icon="briefcase" block onClick={() => openOverlay('heistboard')}>Open the heist board</Btn>
              </div>
            )}
            {app === 'social' && (
              <>
                <div className="ph-social-head">
                  <Tag tone="pink" icon="heart">{social.friends.length} {social.friends.length === 1 ? "friend" : "friends"}</Tag>
                  <Tag tone={party ? 'aqua' : 'grey'} icon="users">{party ? `Party of ${party.members.length}` : 'No party'}</Tag>
                </div>
                {friendsOn.length === 0 ? <Empty icon="users">No friends online right now.</Empty> : (
                  <ul className="ph-list">
                    {friendsOn.map((f) => (
                      <li key={f.id}><div className="ph-row">
                        <Avatar name={f.name} size={34} ring={f.inMyParty ? 'var(--aqua)' : undefined} />
                        <span className="grow"><b>{f.name}</b><small>{f.where ?? f.status.replace('_', ' ')}</small></span>
                        {f.inMyParty && <Tag tone="aqua">Party</Tag>}
                      </div></li>
                    ))}
                  </ul>
                )}
                <Btn block icon="users" onClick={() => openOverlay('social')}>Friends &amp; Party</Btn>
              </>
            )}
            {app === 'garage' && (
              <>
                <div className="ph-garage-cta">
                  <Btn block icon="car" disabled={vehicles.length === 0 || wanted > 0} why={wanted > 0 ? 'Not while the police are after you' : 'You do not own a vehicle yet'} onClick={() => garage('deliver')}>Request my vehicle</Btn>
                  <small className="muted">Delivered to you for {money(DELIVERY_PRICE)}.</small>
                </div>
                {vehicles.length === 0 ? <Empty icon="car">Your garage is empty. Visit Torque &amp; Tide to buy a ride.</Empty> : (
                  <ul className="ph-list">
                    {vehicles.map((v) => (
                      <li key={v.id}><div className="ph-row">
                        <span className="swatch" style={{ background: hex(v.color) }} />
                        <span className="grow"><b>{VEHICLES[v.model as VehicleModel]?.name ?? v.model}</b><small>{v.state === 'stored' ? 'In garage' : v.state === 'out' ? 'Out in the world' : 'Wrecked'} · {Math.round(v.health)} hp</small></span>
                        <Btn size="sm" variant="ghost" disabled={wanted > 0} why="Not while the police are after you" onClick={() => garage('deliver', { vehicle: v.id })}>Deliver</Btn>
                      </div></li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {app === 'map' && (
              <>
                <MapPreview />
                <Btn block icon="map" onClick={() => openOverlay('map')}>Open full map</Btn>
                <Btn block variant="ghost" icon="close" disabled={!wp} why="No waypoint set" onClick={() => setWaypoint(null)}>Clear waypoint</Btn>
                {wp && <p className="muted small center">Waypoint at {Math.round(wp.x)}, {Math.round(wp.z)}</p>}
              </>
            )}
            {app === 'settings' && (
              <>
                <Slider label="Master volume" value={settings.volume.master} min={0} max={1} step={0.01} onChange={(v) => updateSettings({ volume: { ...settings.volume, master: v } })} format={(v) => `${Math.round(v * 100)}%`} />
                <Slider label="Radio" value={settings.volume.radio} min={0} max={1} step={0.01} onChange={(v) => updateSettings({ volume: { ...settings.volume, radio: v } })} format={(v) => `${Math.round(v * 100)}%`} />
                <Btn block icon="gear" onClick={() => openOverlay('settings')}>All settings</Btn>
              </>
            )}
          </div>
        </div>
        <button type="button" className="ph-home" onClick={() => (app === 'home' ? closeOverlay() : setApp('home'))} aria-label={app === 'home' ? 'Close phone' : 'Home'} />
      </div>
    </div>
  );
}

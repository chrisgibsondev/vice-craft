/* DEV ONLY: renders <App/> against a mocked store so the UI can be reviewed without a server.
   Open /ui-demo.html?scene=hud  (scenes listed in the bar at the bottom). */
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { ACTIVITY_BY_ID } from '@blockshore/shared';
import { setState, getState } from '../state/store';
import { livePose } from '../game/livePose';
import { setWaypoint } from './waypoint';
import App from './App';
import type { GameState, FriendView } from '../state/types';
import { mockWeb } from './web/demoMock';
import { phoneLaunch } from './overlays/Phone';
import { preloadBrowser } from './web/Browser';

// ── mock REST ──────────────────────────────────────────────────────────────
const realFetch = window.fetch.bind(window);
const json = (o: unknown) => Promise.resolve(new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } }));
window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.startsWith('/api')) return realFetch(input, init);
  const web = mockWeb(url, init);
  if (web) return web;
  if (url.startsWith('/api/credits')) return json({
    models: [
      { title: 'Low-poly palm tree', author: 'Quaternius', license: 'CC0', source: 'https://quaternius.com' },
      { title: 'Blocky sedan', author: 'Kenney', license: 'CC0', source: 'https://kenney.nl' },
      { title: 'Neon sign pack', author: 'Example Artist', license: 'CC-BY 4.0', source: 'https://example.com/neon' },
    ],
    audio: { tracks: [{ title: 'Sunset Drive', author: 'Example Composer', license: 'CC-BY 4.0', source: 'https://example.com/music' }, { title: 'Engine loops', author: 'Sound Lab', license: 'CC0' }] },
  });
  if (url.startsWith('/api/admin/overview')) return json({ online: 5, tick: {}, instances: [
    { id: 'w1', label: 'Port Solano #1', kind: 'world', players: [{ id: 'u2', name: 'Marlow' }, { id: 'u3', name: 'Kira' }, { id: 'u1', name: 'PalmPilot' }] },
    { id: 'a1', label: 'The Sundial Job', kind: 'activity', players: [{ id: 'u4', name: 'Dex' }, { id: 'u5', name: 'Nova' }] },
  ] });
  if (url.startsWith('/api/admin/reports')) return json({ reports: [{ id: 1, userId: 'u9', targetName: 'LoudGuy', reporterName: 'Kira', reason: 'Spamming chat with insults', context: 'World chat, 2 min ago', resolved: false }, { id: 2, userId: 'u8', targetName: 'Grief42', reporterName: 'Dex', reason: 'Blocking the garage door', resolved: true }] });
  if (url.startsWith('/api/users/search')) return json({ users: [{ id: 'u20', name: 'Marina', friend: false, pending: false }, { id: 'u21', name: 'Marcus_B', friend: true, pending: false }, { id: 'u22', name: 'Mara', friend: false, pending: true }] });
  if (url.startsWith('/api/party/link/')) return json({ leaderName: 'Marlow', size: 2, expires: Date.now() + 600000 });
  if (url === '/api/friends') { const so = getState().social; return json({ ...so }); }
  if (url === '/api/party') return json({ party: getState().party, invites: getState().partyInvites });
  if (url === '/api/worlds') return json({ worlds: getState().worlds });
  return json({ ok: true });
}) as typeof fetch;

// ── mock data ──────────────────────────────────────────────────────────────
const now = Date.now();
const friends: FriendView[] = [
  { id: 'u2', name: 'Marlow', status: 'in_activity', where: 'The Sundial Job', joinable: false, inMyParty: true },
  { id: 'u3', name: 'Kira', status: 'in_world', where: 'Port Solano #1', joinable: true, inMyParty: true },
  { id: 'u6', name: 'Dex_Drift', status: 'in_world', where: 'Port Solano #1', joinable: true, inMyParty: false },
  { id: 'u7', name: 'Nova', status: 'in_world', where: 'Port Solano #3', joinable: true, inMyParty: false },
  { id: 'u8', name: 'Tidewalker', status: 'online', joinable: false, inMyParty: false },
  { id: 'u9', name: 'SunnyJ', status: 'offline', joinable: false, inMyParty: false },
];
const heist = ACTIVITY_BY_ID.heist_sundial;
const base: Partial<GameState> = {
  screen: 'game', overlay: null, conn: 'online', connMessage: '',
  user: { id: 'u1', name: 'PalmPilot', admin: true },
  profile: {
    cash: 18450, rep: 240, completed: { story_1: 1, prep_sundial_scout: 1 }, unlocks: [], preps: { heist_sundial: ['prep_sundial_scout'] }, checkpoints: {}, inventory: {}, outfit: 0,
    vehicles: [{ id: 'v1', model: 'compact', color: 0xf2c14e, health: 820, state: 'stored' }, { id: 'v2', model: 'sports', color: 0xd7263d, health: 310, state: 'out' }, { id: 'v3', model: 'pickup', color: 0x2e86ab, health: 0, state: 'destroyed' }],
    bests: { race_downtown: 71230 }, weapons: [], equipped: 'stun',
  },
  social: { friends, incoming: [{ id: 'u30', name: 'BeachBum' }], outgoing: [{ id: 'u31', name: 'Pixelfish' }], blocked: [{ id: 'u40', name: 'LoudGuy' }], privacy: { presence: 'friends', invites: 'friends' } },
  party: {
    id: 'p1', leader: 'u1',
    members: [
      { id: 'u1', name: 'PalmPilot', online: true, status: 'in_world', where: 'Port Solano #1', leader: true },
      { id: 'u2', name: 'Marlow', online: true, status: 'in_activity', where: 'The Sundial Job', leader: false },
      { id: 'u3', name: 'Kira', online: true, status: 'in_world', where: 'Port Solano #1', leader: false },
    ],
    invites: [{ id: 'u6', name: 'Dex_Drift', expires: now + 8 * 60000 }],
    link: { token: 'k3f9a2xq', expires: now + 14 * 60000 },
    chat: [{ from: 'u2', name: 'Marlow', text: 'meet at the diner in 2', at: now - 30000 }, { from: 'u3', name: 'Kira', text: 'bringing the getaway car', at: now - 12000 }],
  },
  partyInvites: [{ partyId: 'p9', fromName: 'Tidewalker', expires: now + 12 * 60000, size: 2 }],
  world: { instance: 'w1', kind: 'world', label: 'Port Solano #1', players: 7, capacity: 16 },
  worlds: [
    { id: 'w1', label: 'Port Solano #1', players: 7, capacity: 16, friends: 3 },
    { id: 'w2', label: 'Port Solano #2', players: 16, capacity: 16, friends: 0 },
    { id: 'w3', label: 'Port Solano #3', players: 2, capacity: 16, friends: 1 },
  ],
  hud: { hp: 82, maxHp: 100, wanted: 0, wantedSeen: false, inVehicle: false, speedKmh: 0, vehicleHp: 0, vehicleModel: null, seat: 0, down: null, interior: null, x: 2472, y: 22, z: 3204, yaw: 0.6, searchArea: null, interactPrompt: null, ammo: null },
  blips: [
    { id: 'b1', x: 2512, z: 3150, kind: 'party', label: 'Kira' }, { id: 'b2', x: 2440, z: 3240, kind: 'party', label: 'Marlow' },
    { id: 'b3', x: 2490, z: 3170, kind: 'vehicle', label: 'Your car' }, { id: 'b4', x: 2420, z: 3190, kind: 'police' }, { id: 'b5', x: 2560, z: 3260, kind: 'guard' }, { id: 'b6', x: 2430, z: 3150, kind: 'player' },
  ],
  pingMs: 42, fps: 118, loading: null,
  entities: [{ id: 'p-dex', k: 'p', n: 'Dex_Drift', x: 0, y: 0, z: 0, yaw: 0, pitch: 0, a: 1, hp: 100, c: 0 }],
};

const actBase = {
  runId: 'r1', activity: 'story_1', name: 'Welcome to Port Solano', kind: 'mission', phase: 'playing' as const, stage: 'pickup', stageTitle: 'Collect the packages', stageIndex: 2, stageCount: 5,
  objectives: [
    { id: 'o1', text: 'Get in the Dart Hatch', done: true, markers: [] },
    { id: 'o2', text: 'Pick up the packages', done: false, progress: '1/2', markers: [{ x: 2405, y: 22, z: 3246, kind: 'interact' as const, label: 'Package', shape: 'circle' as const }, { x: 2549, y: 22, z: 3110, kind: 'interact' as const, shape: 'diamond' as const }] },
  ],
  timer: { endsAt: now + 4 * 60000 + 12000, label: 'Time left' },
  roster: [{ userId: 'u1', name: 'PalmPilot', role: 'none', connected: true, down: false }, { userId: 'u2', name: 'Marlow', role: 'none', connected: true, down: true }],
};

const lobby = {
  activity: 'heist_sundial', name: 'The Sundial Job', kind: 'heist', leader: 'u1',
  members: [
    { userId: 'u1', name: 'PalmPilot', ready: true, role: 'hacker', eligible: 'story', connected: true },
    { userId: 'u2', name: 'Marlow', ready: false, role: 'driver', eligible: 'replay', connected: true },
    { userId: 'u3', name: 'Kira', ready: true, role: 'none', eligible: 'ahead', connected: false },
  ],
  config: { approach: 'quiet', equipment: ['lockpick', 'drill'], split: { u1: 40, u2: 30, u3: 30 } },
  payout: ['PalmPilot: $3,600', 'Marlow: $2,700', 'Kira: $2,700'], canLaunch: false, blockers: ['Marlow is not ready.', 'Kira is disconnected.'],
};

const SCENES: Record<string, () => Partial<GameState>> = {
  boot: () => ({ screen: 'boot' }),
  login: () => ({ screen: 'login', user: null, joinToken: 'k3f9a2xq' }),
  menu: () => ({ screen: 'menu', world: null }),
  loading: () => ({ screen: 'loading', loading: { progress: 0.62, label: 'Streaming Port Solano…' } }),
  hud: () => ({ activity: actBase as GameState['activity'], hud: { ...base.hud!, wanted: 2, wantedSeen: true, ammo: { weapon: 'Marlin 9', mag: 8, reserve: 48 }, interactPrompt: { key: 'interact', label: 'Pick up package', hold: 1.2, progress: 0.6 }, searchArea: { x: 2430, z: 3200, r: 160 } },
    dialogue: { speaker: 'Marisol', text: "Packages are marked on your map. Don't open them. Don't shake them.", until: Date.now() + 3600000 },
    notices: [{ id: 1, text: 'Mission: Collect the packages', kind: 'mission', at: Date.now() }, { id: 2, text: 'Welcome back, PalmPilot', kind: 'info', at: Date.now() }] }),
  vehicle: () => ({ hud: { ...base.hud!, inVehicle: true, speedKmh: 96, vehicleHp: 640, vehicleModel: 'sports', wanted: 1, wantedSeen: false }, activity: null,
    chat: [{ id: 1, ch: 'party', from: 'Kira', text: 'Right behind you!', at: Date.now() }, { id: 2, ch: 'world', from: 'Dex_Drift', text: 'who wants a race?', at: Date.now() }] }),
  race: () => ({ activity: { ...actBase, activity: 'race_downtown', name: 'Downtown Sprint', kind: 'minigame', stageTitle: 'Race', objectives: [{ id: 'o', text: 'Race', done: false, markers: [{ x: 2544, y: 22, z: 3168, kind: 'checkpoint', shape: 'circle' }] }], timer: undefined, race: { lap: 1, laps: 2, cp: 3, cps: 9, position: 2, racers: 4, startAt: Date.now() + 2400 } } as GameState['activity'], hud: { ...base.hud!, inVehicle: true, speedKmh: 142, vehicleHp: 880, vehicleModel: 'sports' } }),
  failed: () => ({ activity: { ...actBase, phase: 'failed', failReason: 'The Dart Hatch was destroyed.' } as GameState['activity'] }),
  cutscene: () => ({ cutscene: { id: 'diner_meet', phase: 'playing', startAt: Date.now(), loaded: 2, total: 3, deadline: Date.now() + 8000, skipRule: 'Everyone in the crew must vote to skip.', votes: 1, needed: 3, voted: true }, dialogue: { speaker: 'Marisol', text: 'You made it. Sunny Side Diner, corner booth. Do not make me wait.', until: Date.now() + 3600000 } }),
  waiting: () => ({ cutscene: { id: 'diner_meet', phase: 'waiting', startAt: 0, loaded: 2, total: 4, deadline: Date.now() + 6000, skipRule: 'Everyone in the crew must vote to skip.', votes: 0, needed: 4, voted: false } }),
  down: () => ({ hud: { ...base.hud!, hp: 0, down: 7 } }),
  offline: () => ({ conn: 'reconnecting', connMessage: '' }),
  pause: () => ({ overlay: 'pause' }),
  phone: () => ({ overlay: 'phone' }),
  browser: () => { phoneLaunch.app = 'browser'; const site = new URLSearchParams(location.search).get('site'); if (site) preloadBrowser(site); return { overlay: 'phone' }; },
  map: () => ({ overlay: 'map', activity: actBase as GameState['activity'], hud: { ...base.hud!, x: 2500, z: 3160 } }),
  social: () => ({ overlay: 'social' }),
  worlds: () => ({ overlay: 'worlds' }),
  brief: () => ({ overlay: 'brief', brief: {
    activity: 'heist_sundial', name: 'The Sundial Job', kind: 'heist', giver: 'lena', blurb: heist.blurb, notes: heist.notes.slice(0, 3), unlocked: true,
    eligibility: [{ userId: 'u1', name: 'PalmPilot', eligibility: 'story', reward: 'Full take share' }, { userId: 'u2', name: 'Marlow', eligibility: 'replay', reward: 'Reduced cash' }, { userId: 'u3', name: 'Kira', eligibility: 'ahead', reward: 'Cash only' }],
    preps: [{ id: 'prep_sundial_scout', name: 'Case the Joint', done: true }, { id: 'prep_sundial_wheels', name: 'Getaway Wheels', done: false }],
    heist: { approaches: ['quiet', 'loud'], equipment: [], roles: ['driver', 'hacker', 'muscle', 'lookout'], baseTake: 9000 }, checkpoint: { stage: 3, title: 'The take' }, personalBest: 91230,
  } }),
  lobby: () => ({ overlay: 'lobby', lobby }),
  heistboard: () => ({ overlay: 'heistboard' }),
  shop: () => ({ overlay: 'shop', shop: { shop: 'store', name: 'Quik Pelican', items: [
    { id: 'snack', name: 'Pelican Crunch bar', price: 15, desc: 'Restores 25 health now.' }, { id: 'medkit', name: 'First-aid kit', price: 150, desc: 'Carry up to 3. Use with [Q] to fully heal.' },
    { id: 'soda', name: 'Glacier Fizz', price: 5, desc: 'Restores 10 health.' }, { id: 'gold', name: 'Gold-wrapped Mystery', price: 99999, desc: 'Cannot be afforded.' }, { id: 'lock', name: 'Staff only', price: 10, desc: 'Not for sale.', disabled: 'Staff only' }, { id: 'own', name: 'Lucky Pelican keyring', price: 40, desc: 'A small souvenir.', owned: true },
  ] } }),
  garage: () => ({ overlay: 'shop', shop: { shop: 'garage', name: 'Torque & Tide Garage', items: [], nearbyVehicle: { id: 'v2', model: 'sports', hp: 310, repairCost: 354, mine: true } } }),
  results: () => ({ overlay: 'results', results: { activity: 'story_1', name: 'Welcome to Port Solano', kind: 'mission', lines: [
    { userId: 'u1', name: 'PalmPilot', cash: 1500, rep: 100, note: 'Quick delivery bonus', status: 'passed' }, { userId: 'u2', name: 'Marlow', cash: 400, rep: 0, note: 'Replay', status: 'passed' }], race: [{ userId: 'u1', name: 'PalmPilot', ms: 71230 }, { userId: 'u2', name: 'Marlow', ms: 74560 }, { userId: 'u3', name: 'Kira', ms: null }] } }),
  settings: () => ({ overlay: 'settings' }),
  credits: () => ({ overlay: 'credits' }),
  admin: () => ({ overlay: 'admin' }),
  chat: () => ({ overlay: 'chat', chat: [{ id: 1, ch: 'party', from: 'Kira', text: 'Right behind you!', at: Date.now() }, { id: 2, ch: 'party', from: 'Marlow', text: 'Parking at the diner now', at: Date.now() }] }),
};

function applyScene(name: string) {
  const mk = SCENES[name] ?? SCENES.hud;
  setState({ ...(base as GameState), overlay: null, cutscene: null, activity: null, shop: null, brief: null, lobby: null, results: null, dialogue: null, notices: [], chat: [], contact: null, joinToken: null, loading: null, conn: 'online', ...mk() });
}

// animate the live pose so the minimap / speedometer move
livePose.active = true; livePose.x = 2472; livePose.z = 3204;
setInterval(() => {
  const t = performance.now() / 1000;
  livePose.yaw = 0.6 + Math.sin(t * 0.4) * 0.5;
  const s = getState();
  livePose.speedKmh = s.hud.inVehicle ? 96 + Math.sin(t) * 40 : 0;
}, 16);
setWaypoint({ x: 2600, z: 3100 });

const first = new URLSearchParams(location.search).get('scene') ?? 'hud';
applyScene(first);

const BG = "url('/@fs/D:/Claude/blockshore/docs/progress/01-downtown.jpg')";

function Demo() {
  const [scene, setScene] = useState(first);
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, background: `linear-gradient(180deg, rgba(255,150,100,.0), rgba(18,9,42,.4)), ${BG} center/cover, linear-gradient(180deg,#ff9a6a,#c0307c 55%,#2a1658)` }} />
      <div id="overlay-root" style={{ position: 'fixed', inset: 0, zIndex: 2, pointerEvents: 'none' }}><App /></div>
      {new URLSearchParams(location.search).get('bar') !== '0' && <div style={{ position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 100, display: 'flex', flexWrap: 'wrap', gap: 4, padding: 6, background: 'rgba(0,0,0,.85)', font: '12px Inter, sans-serif' }}>
        {Object.keys(SCENES).map((s) => (
          <button key={s} onClick={() => { setScene(s); applyScene(s); }} style={{ padding: '4px 8px', background: scene === s ? '#ff4fa3' : '#2a1a5c', color: scene === s ? '#12092a' : '#fff', border: 0, borderRadius: 4, cursor: 'pointer' }}>{s}</button>
        ))}
      </div>}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<Demo />);

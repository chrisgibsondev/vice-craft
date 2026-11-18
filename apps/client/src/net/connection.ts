/**
 * WebSocket connection: hello/auth, automatic reconnect with backoff, message
 * dispatch. Snapshots are forwarded to the game loop via `onSnapshot`; everything
 * else updates the store.
 */
import { tts } from '../audio/tts';
import { PROTOCOL_VERSION, GAME_VERSION, WORLD, type C2SMsg, type S2CMsg, type Snapshot } from '@blockshore/shared';
import { getToken, SERVER_URL } from './api';
import { getState, setState, pushNotice, pushChat } from '../state/store';
import type { ProfileView, PartyView, ShopView, BriefView, ContactJobs, ResultsView } from '../state/types';

type Listener = (m: S2CMsg) => void;

class Connection {
  private ws: WebSocket | null = null;
  private wanted = false;
  private retry = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: C2SMsg[] = [];
  private listeners = new Set<Listener>();
  onSnapshot: ((s: Snapshot) => void) | null = null;
  ready = false;
  /** server time offset (server - local) */
  clockOffset = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  connect() {
    this.wanted = true;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    const token = getToken();
    if (!token) return;
    setState({ conn: this.retry ? 'reconnecting' : 'connecting' });
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(SERVER_URL ? `${SERVER_URL.replace(/^http/, 'ws')}/ws` : `${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION, gv: GAME_VERSION, token, resume: this.retry > 0 }));
    };
    ws.onmessage = (e) => {
      let m: S2CMsg;
      try { m = JSON.parse(e.data as string); } catch { return; }
      this.dispatch(m);
    };
    ws.onclose = (e) => {
      this.ready = false;
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (e.code === 4003) { setState({ conn: 'version', connMessage: e.reason || 'Your game is out of date. Refresh the page to update.' }); return; }
      if (e.code === 4004) { setState({ conn: 'kicked', connMessage: e.reason || 'You were disconnected.' }); this.wanted = false; return; }
      if (e.code === 4001) pushNotice('Loading the game…', 'info');
      if (!this.wanted) { setState({ conn: 'offline' }); return; }
      this.scheduleReconnect();
    };
    ws.onerror = () => { /* onclose follows */ };
  }

  private scheduleReconnect() {
    setState({ conn: 'reconnecting', connMessage: 'Loading the game…' });
    const delay = Math.min(10_000, 500 * 2 ** Math.min(this.retry, 5)) + Math.random() * 400;
    this.retry++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), delay);
  }

  disconnect() {
    this.wanted = false;
    this.ws?.close(1000, 'bye');
    this.ws = null;
    this.ready = false;
  }

  send(m: C2SMsg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && (this.ready || m.t === 'hello')) this.ws.send(JSON.stringify(m));
    else if (m.t !== 'input' && m.t !== 'ping') this.queue.push(m);
  }

  on(l: Listener) { this.listeners.add(l); return () => this.listeners.delete(l); }

  serverNow() { return Date.now() + this.clockOffset; }

  private dispatch(m: S2CMsg) {
    switch (m.t) {
      case 'snap': this.onSnapshot?.(m); return;
      case 'welcome': {
        this.ready = true;
        this.retry = 0;
        this.clockOffset = m.serverTime - Date.now();
        setState({ conn: 'online', connMessage: '', user: { ...(getState().user?.id === m.userId ? getState().user : {}), id: m.userId, name: m.name, admin: m.admin } });
        const q = this.queue; this.queue = [];
        for (const x of q) this.send(x);
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.send({ t: 'ping', c: performance.now() }), 2000);
        break;
      }
      case 'pong': {
        const rtt = performance.now() - m.c;
        this.clockOffset = m.s + rtt / 2 - Date.now();
        setState({ pingMs: Math.round(rtt) });
        break;
      }
      case 'error':
        pushNotice(m.message, 'bad');
        if (m.code === 'auth') { this.wanted = false; setState({ screen: 'boot', user: null }); void import('../state/actions').then((a) => a.autoLogin()).catch(() => setState({ screen: 'login' })); }
        if (m.code === 'world_full' || m.code === 'party_world_full' || m.code === 'no_world') setState({ screen: getState().world ? 'game' : 'menu', loading: null });
        break;
      case 'world':
        setState({ world: { instance: m.instance, kind: m.kind, label: m.label, players: m.players, capacity: m.capacity, access: m.access, code: m.code, host: m.host } });
        break;
      case 'world.left': setState({ world: null, screen: 'menu', activity: null }); if (m.reason) pushNotice(m.reason, 'info'); break;
      case 'notify': pushNotice(m.text, m.kind); break;
      case 'chat': pushChat(m.ch, m.from, m.text, m.at); break;
      case 'profile': setState({ profile: m.profile as ProfileView }); break;
      case 'social': this.onSocial(m.event, m.data); break;
      case 'act': setState({ activity: m.view }); break;
      case 'lobby': setState((s) => ({ lobby: m.view, overlay: m.view ? (s.overlay === 'brief' || s.overlay === 'heistboard' || s.overlay === 'phone' || s.overlay === 'lobby' || !s.overlay ? 'lobby' : s.overlay) : (s.overlay === 'lobby' ? null : s.overlay) })); break;
      case 'brief': {
        const d = m.data as BriefView | ContactJobs;
        if ('jobs' in d) setState({ contact: d, overlay: 'phone' });
        else setState({ brief: d, overlay: 'brief' });
        break;
      }
      case 'shop': setState({ shop: { ...(m.data as ShopView), shop: m.shop }, overlay: 'shop' }); break;
      case 'results': setState({ results: m.data as ResultsView, overlay: 'results' }); break;
      case 'cs.waiting': setState((s) => ({ cutscene: { id: m.cs, phase: 'waiting', startAt: 0, loaded: m.loaded, total: m.total, deadline: m.deadline, skipRule: '', votes: 0, needed: 0, voted: s.cutscene?.voted ?? false } })); break;
      case 'cs.start': setState((s) => ({ cutscene: { id: m.cs, phase: 'playing', startAt: m.startAt, loaded: s.cutscene?.loaded ?? 0, total: m.participants, deadline: 0, skipRule: m.skipRule, votes: 0, needed: m.participants <= 1 ? 1 : Math.floor(m.participants / 2) + 1, voted: false } })); break;
      case 'cs.votes': setState((s) => ({ cutscene: s.cutscene ? { ...s.cutscene, votes: m.votes, needed: m.needed } : null })); break;
      case 'cs.end': setState({ cutscene: null }); break;
      case 'ui': setState({ overlay: m.open }); document.exitPointerLock?.(); break;
      case 'dialogue': setState({ dialogue: { speaker: m.speaker, text: m.text, until: Date.now() + m.ms } }); if (m.speaker) tts.say(m.speaker, m.text, 'dialogue'); break;
      default: break;
    }
    for (const l of this.listeners) l(m);
  }

  private onSocial(event: string, data: unknown) {
    switch (event) {
      case 'party': setState({ party: data as PartyView | null }); break;
      case 'party_invite': {
        const inv = data as { partyId: string; fromName: string; expires: number; size: number };
        setState((s) => ({ partyInvites: [...s.partyInvites.filter((i) => i.partyId !== inv.partyId), inv] }));
        pushNotice(`${inv.fromName} invited you to their party (P to open).`, 'info');
        break;
      }
      case 'friend_request': pushNotice(`${(data as { name: string }).name} sent you a friend request.`, 'info'); void import('../state/actions').then((a) => a.refreshFriends()); break;
      case 'friend_accepted': pushNotice(`${(data as { name: string }).name} accepted your friend request.`, 'good'); void import('../state/actions').then((a) => a.refreshFriends()); break;
      case 'friends': void import('../state/actions').then((a) => a.refreshFriends()); break;
      case 'party_kicked': setState({ party: null }); pushNotice('You were removed from the party.', 'bad'); break;
      case 'leader_moved': pushNotice(`${(data as { name: string }).name} moved to another world. Open the party panel (P) to follow.`, 'info'); break;
      default: break;
    }
  }
}

export const net = new Connection();

/**
 * The map is fixed when the page loads (terrain workers, minimap, prediction). When the server runs a different
 * world than this page was started with, reload once with ?world=<server world> so both generate the same city.
 * Returns true when a reload was started.
 */
export function followServerWorld(serverWorld: string): boolean {
  try {
    const key = 'bs_world_follow';
    if (sessionStorage.getItem(key) === serverWorld) return false; // already tried: do not loop
    sessionStorage.setItem(key, serverWorld);
    const u = new URL(location.href);
    u.searchParams.set('world', serverWorld);
    location.replace(u.toString());
    return true;
  } catch { return false; }
}

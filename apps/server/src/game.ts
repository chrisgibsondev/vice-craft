/**
 * Game coordinator: sessions, presence, world/activity/interior instances, lobbies,
 * interactions, shops, garage and the fixed-step tick loop.
 */
import type { WebSocket } from 'ws';
import {
  B, C2S, PROTOCOL_VERSION, TICK_RATE, RECONNECT_GRACE_MS, MAX_PLAYERS_PER_INSTANCE, INTERACT_RANGE,
  ACTIVITY_BY_ID, CONTACTS, SHOPS, WEAPONS, VEHICLES, MAX_MEDKITS, PAINT_PRICE, REPAIR_PRICE_PER_HP, DELIVERY_PRICE,
  WANTED_FINE, DEALER_MODELS, PAINT_COLORS, CUTSCENES, worldAnchors, anchor, poiCenter, PALMARA, LEONIA, WORLD, worldText, setupsDone,
  type C2SMsg, type S2CMsg, type VehicleModel, type WorldTarget,
} from '@blockshore/shared';
import { Store, type Profile, type User } from './store.ts';
import { PartyManager, PARTY_ERRORS, type Party, type PartyError } from './social/parties.ts';
import { Instance, PLAZA_SPAWN, interactRangeOk } from './world/instance.ts';
import { voxels } from './world/voxels.ts';
import { nav } from './world/nav.ts';
import { PROPERTY_BY_ID } from './webcontent.ts';
import { ActivityRun, type RosterEntry } from './activities/runner.ts';
import { Lobby, eligibilityOf, isUnlocked, contactJobs } from './activities/lobby.ts';
import { RateLimiter } from './ratelimit.ts';
import { config } from './config.ts';
import { log } from './log.ts';
import { newId } from './auth.ts';
import { barkEvent } from './world/barks.ts';
import type { PlayerEnt, VehicleEnt } from './world/entities.ts';

export class Session {
  user: User | null = null;
  inst: Instance | null = null;
  closed = false;
  readonly msgLimiter = new RateLimiter(90, 60);
  readonly chatLimiter = new RateLimiter(5, 1);
  readonly actLimiter = new RateLimiter(20, 4);
  blocked = new Set<string>();
  invalidCount = 0;
  constructor(readonly ws: WebSocket, readonly ip: string) {}
  get userId() { return this.user!.id; }
  get name() { return this.user!.display_name; }
}

/** selected hair colour (0xRRGGBB, 0 = default look): lives in the profile inventory as hair_sel; owned colours are hair:<hex6> = 1 */
function hairOf(prof: { inventory: Record<string, number> }): number { return Math.max(0, Math.floor(prof.inventory.hair_sel ?? 0)) & 0xffffff; }
/** colour of a barber item's give id (hair:<hex6>), or null when it is not one */
function hairColourOf(give: string | undefined): number | null { const m = give ? /^hair:([0-9a-f]{6})$/.exec(give) : null; return m ? parseInt(m[1], 16) : null; }

/** downtown marina: open water in the bay (Palmara: between downtown and Port Island; Leonia: off Bayfront Park) */
const MARINA = WORLD === 'leonia'
  ? (() => { const c = poiCenter('plaza'); const b = nav.boatSpot(c[0] + 60, c[1]); return b ? { x: b.x, z: b.z } : { x: c[0] + 120, z: c[1] }; })()
  : { x: 2652, z: 3140 };
const MARINA_NAME = WORLD === 'leonia' ? 'the Bayfront Park marina (Biscayne Bay)' : 'the downtown marina (east of the Neon Lagoon)';

const NEWS = WORLD === 'leonia' ? [
  'Channel 6: Sunline Motors announces "the year of the convertible". Again.',
  'Channel 6: Iguana drops out of a palm onto Brickell Avenue. Traffic takes it personally.',
  'Channel 6: Miami Beach approves a fourth new rooftop pool this month.',
  'Channel 6: MacArthur Causeway closed for twenty minutes so a pelican could finish its thought.',
  'Channel 6: Wynwood mural repainted overnight. Nobody admits to owning a ladder.',
  'Channel 6: Virginia Key ferry schedule replaced by a vibe.',
] : [
  'Channel 6: Sunline Motors announces "the year of the convertible". Again.',
  'Channel 6: Lake Mirabel gator spotted wearing a hat. Experts baffled.',
  'Channel 6: Port Solano council approves fourth new rooftop pool this month.',
  'Channel 6: Cape Halcyon launch delayed — "the rocket had a feeling".',
  'Channel 6: Coral Keys ferry schedule replaced by a vibe.',
];
/** world bounds for saved positions */
const WORLD_W = WORLD === 'leonia' ? LEONIA.width : PALMARA.width, WORLD_D = WORLD === 'leonia' ? LEONIA.depth : PALMARA.depth;

export class Game {
  readonly sessions = new Map<string, Session>();
  readonly instances = new Map<string, Instance>();
  readonly lobbies = new Map<string, Lobby>();
  readonly profiles = new Map<string, Profile>();
  readonly parties: PartyManager;
  /** where to put a player when they leave a safehouse interior */
  private interiorReturn = new Map<string, { instance: string | null; pos: { x: number; y: number; z: number } }>();
  private worldCounter = 0;
  readonly startedAt = Date.now();
  tickStats = { avg: 0, max: 0, count: 0 };
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private housekeepingTimer: ReturnType<typeof setInterval> | null = null;
  interruptedRuns: { id: string; activity: string; roster: unknown }[] = [];
  private lastSessionPurge = 0;

  constructor(readonly store: Store) {
    this.parties = new PartyManager(store, (p, affected) => this.onPartyChange(p, affected));
  }

  async init() {
    this.interruptedRuns = await this.store.interruptActiveRuns();
    if (this.interruptedRuns.length) log.warn('runs interrupted by restart', { count: this.interruptedRuns.length });
    await this.store.recoverVehicles();
    await this.parties.restore();
    this.createWorld();
  }

  start() {
    let next = performance.now();
    const step = 1000 / TICK_RATE;
    const loop = () => {
      const now = performance.now();
      let n = 0;
      while (now >= next && n < 4) {
        const t0 = performance.now();
        this.tickAll();
        const ms = performance.now() - t0;
        this.tickStats.avg = this.tickStats.avg * 0.98 + ms * 0.02;
        this.tickStats.max = Math.max(this.tickStats.max * 0.999, ms);
        this.tickStats.count++;
        next += step; n++;
      }
      if (now - next > 1000) next = now; // fell far behind: resync instead of spiralling
      this.loopTimer = setTimeout(loop, Math.max(0, next - performance.now()));
    };
    loop();
    this.housekeepingTimer = setInterval(() => void this.housekeeping(), 5000);
  }

  async shutdown(reason = 'Server restarting') {
    if (this.loopTimer) clearTimeout(this.loopTimer);
    if (this.housekeepingTimer) clearInterval(this.housekeepingTimer);
    for (const inst of this.instances.values()) {
      for (const p of inst.players.values()) {
        await this.persistPlayer(p, inst).catch(() => {});
        // running activities stay 'active' here; the next boot marks them interrupted (same path as a crash)
      }
      for (const v of inst.vehicles.values()) if (v.owner) await this.store.updateVehicle(v.owner.vehicleId, { health: v.hp, state: 'stored' }).catch(() => {});
    }
    for (const s of this.sessions.values()) { try { s.ws.close(4001, reason); } catch { /* ignore */ } }
  }

  private tickAll() {
    for (const inst of this.instances.values()) {
      try { inst.tick(); } catch (e) { log.error('instance tick failed', { inst: inst.id, err: String((e as Error).stack ?? e) }); }
    }
  }

  // ───────────────────────────────────────────────────────── messaging
  send(userId: string, m: S2CMsg) {
    const s = this.sessions.get(userId);
    if (!s || s.closed || s.ws.readyState !== 1) return;
    s.ws.send(JSON.stringify(m));
  }
  notify(userId: string, text: string, kind: 'info' | 'good' | 'bad' | 'mission' = 'info', sfx?: string) { this.send(userId, { t: 'notify', text, kind, sfx }); }
  error(s: Session, code: string, message: string, fatal = false) {
    if (s.ws.readyState === 1) s.ws.send(JSON.stringify({ t: 'error', code, message, fatal }));
  }
  sfx(inst: Instance, id: string, x?: number, y?: number, z?: number, vol = 1, only?: string) {
    for (const p of inst.players.values()) {
      if (p.linkdeadAt) continue;
      if (only && p.userId !== only) continue;
      if (x !== undefined && (p.phys.x - x) ** 2 + (p.phys.z - z!) ** 2 > 140 * 140) continue;
      this.send(p.userId, { t: 'sfx', id, x, y, z, vol });
    }
  }
  broadcastSfx(ps: PlayerEnt[], id: string) { for (const p of ps) this.send(p.userId, { t: 'sfx', id }); }
  shot(inst: Instance, p: PlayerEnt, x: number, y: number, z: number, tx: number, ty: number, tz: number, w: string, hit: boolean) {
    for (const o of inst.players.values()) {
      if (o.linkdeadAt || (o.phys.x - x) ** 2 + (o.phys.z - z) ** 2 > 160 * 160) continue;
      this.send(o.userId, { t: 'shot', from: p.id, x, y, z, tx, ty, tz, w, hit });
    }
  }
  shotFromNpc(inst: Instance, from: string, x: number, y: number, z: number, tx: number, ty: number, tz: number) {
    for (const o of inst.players.values()) {
      if (o.linkdeadAt || (o.phys.x - x) ** 2 + (o.phys.z - z) ** 2 > 160 * 160) continue;
      this.send(o.userId, { t: 'shot', from, x, y, z, tx, ty, tz, w: 'pistol' });
    }
  }
  /** push an authoritative state correction (teleports, ejections) — the next snapshot carries it */
  sendCorrection(p: PlayerEnt, _inst: Instance) { p.inputs.length = 0; }

  // ───────────────────────────────────────────────────────── connections
  attach(ws: WebSocket, ip: string) {
    const s = new Session(ws, ip);
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const raw = data.toString();
      if (raw.length > 4096) { this.error(s, 'too_big', 'Message too large.'); return; }
      if (!s.msgLimiter.take(s.ip + (s.user?.id ?? ''))) { if (++s.invalidCount > 200) ws.close(4008, 'Rate limited'); return; }
      let parsed: unknown;
      try { parsed = JSON.parse(raw); } catch { return; }
      const r = C2S.safeParse(parsed);
      if (!r.success) {
        if (++s.invalidCount > 50) ws.close(4008, 'Too many invalid messages');
        return;
      }
      this.handle(s, r.data).catch((e) => log.error('handler failed', { t: r.data.t, err: String((e as Error).stack ?? e) }));
    });
    ws.on('close', () => this.onClose(s));
    ws.on('error', () => {});
    setTimeout(() => { if (!s.user && !s.closed) ws.close(4004, 'Login timeout'); }, 10_000);
  }

  private async handle(s: Session, m: C2SMsg) {
    if (!s.user) {
      if (m.t !== 'hello') return;
      return this.hello(s, m);
    }
    const p = s.inst?.players.get(s.userId);
    switch (m.t) {
      case 'hello': return;
      case 'ping': this.send(s.userId, { t: 'pong', c: m.c, s: Date.now() }); return;
      case 'input':
        if (!p) return;
        if (m.seq <= p.lastSeq && p.inputs.length === 0 && m.seq < p.lastSeq - 1000) return;
        if (p.inputs.length >= 30) p.inputs.splice(0, p.inputs.length - 20);
        p.inputs.push(m);
        return;
      case 'world.join': return this.joinWorld(s, m.target);
      case 'world.leave': return this.leaveWorld(s, 'Left the world.');
      case 'interact': if (p && s.inst) return this.interact(s, p, s.inst, m.target); return;
      case 'interact.stop': if (p) { p.holding = null; } return;
      case 'veh.enter': if (p && s.inst) { const e = s.inst.enterVehicle(p, m.vehicle, m.seat); if (e) this.notify(s.userId, e, 'bad'); } return;
      case 'veh.exit': if (p && s.inst && p.veh) { const v = s.inst.vehicles.get(p.veh); if (v && Math.abs(v.phys.speed) > 12 && !v.def.boat) { this.notify(s.userId, 'Slow down before getting out.', 'info'); return; } s.inst.exitVehicle(p); } return;
      case 'veh.horn': if (p?.veh && s.inst) { const v = s.inst.vehicles.get(p.veh); if (v && p.seat === 0) { v.horn = m.on; if (v.model === 'police') v.siren = m.on ? !v.siren : v.siren; } } return;
      case 'fire': if (p && s.inst) s.inst.fire(p, m.yaw, m.pitch, !!m.aim); return;
      case 'weapon': if (p) this.equip(s, p, m.id); return;
      case 'reload': if (p && s.inst) s.inst.reload(p); return;
      case 'chat': return this.chat(s, m.ch, m.text);
      case 'ping.mark': return this.pingMark(s, p, m);
      case 'act.brief': if (s.actLimiter.take(s.userId)) return this.brief(s, m.activity); return;
      case 'act.lobby': if (s.actLimiter.take(s.userId)) return this.openLobby(s, m.activity); return;
      case 'act.ready': return this.lobbyReady(s, m.ready);
      case 'act.config': return this.lobbyConfig(s, m);
      case 'act.role': return this.lobbyRole(s, m.role);
      case 'act.launch': if (s.actLimiter.take(s.userId)) return this.launch(s); return;
      case 'act.cancel': return this.lobbyCancel(s);
      case 'act.leave': s.inst?.run?.leave(s.userId); return;
      case 'act.retry': s.inst?.run?.retry(s.userId); return;
      case 'act.continue': s.inst?.run?.continueAfterResults(s.userId); return;
      case 'cs.loaded': s.inst?.run?.csLoaded(s.userId, m.cs); return;
      case 'cs.skip': s.inst?.run?.csSkip(s.userId); return;
      case 'shop.buy': if (s.actLimiter.take(s.userId)) return this.buy(s, p, m.shop, m.item); return;
      case 'item.use': return this.useItem(s, p, m.item);
      case 'garage': if (s.actLimiter.take(s.userId)) return this.garage(s, p, m); return;
      case 'wanted.pay': return this.payWanted(s, p);
      case 'dev': return this.dev(s, p, m);
    }
  }

  private async hello(s: Session, m: Extract<C2SMsg, { t: 'hello' }>) {
    if (m.v !== PROTOCOL_VERSION) {
      this.error(s, 'version', 'Your game client is out of date. Refresh the page to update.', true);
      s.ws.close(4003, 'Client out of date — refresh the page');
      return;
    }
    const user = await this.store.sessionUser(m.token);
    if (!user) { this.error(s, 'auth', 'Your session has expired. Please log in again.', true); s.ws.close(4004, 'Session expired'); return; }
    const old = this.sessions.get(user.id);
    if (old && old !== s) { old.closed = true; try { old.ws.close(4004, 'Signed in from another window'); } catch { /* ignore */ } }
    s.user = user;
    this.sessions.set(user.id, s);
    s.blocked = new Set((await this.store.db.query<{ id: string }>('SELECT blocked_id AS id FROM blocks WHERE blocker_id = $1 UNION SELECT blocker_id FROM blocks WHERE blocked_id = $1', [user.id])).map((r) => r.id));
    const profile = await this.store.profile(user.id);
    this.profiles.set(user.id, profile);
    this.send(user.id, { t: 'welcome', userId: user.id, name: user.display_name, serverTime: Date.now(), tickRate: TICK_RATE, admin: user.is_admin, dev: config.devCommands, world: WORLD });
    await this.refreshProfile(user.id);
    this.send(user.id, { t: 'social', event: 'party', data: this.partyView(this.parties.of(user.id)) });
    for (const inv of this.parties.invitesFor(user.id)) this.send(user.id, { t: 'social', event: 'party_invite', data: inv });
    // reconnect: reattach to the reserved slot
    for (const inst of this.instances.values()) {
      const p = inst.players.get(user.id);
      if (!p) continue;
      p.linkdeadAt = 0; p.sent.clear(); p.inputs.length = 0; p.lastSeq = -1;
      s.inst = inst;
      this.sendWorld(s, inst, p);
      if (inst.run) { inst.run.resendView(user.id); this.notify(user.id, 'Reconnected — you are back in the activity.', 'good'); }
      break;
    }
    if (!s.inst) {
      const lost = this.interruptedRuns.find((r) => (r.roster as { userId: string }[]).some((x) => x.userId === user.id));
      if (lost) this.notify(user.id, `Your ${ACTIVITY_BY_ID[lost.activity]?.name ?? 'activity'} was interrupted by a server restart. No rewards were lost — story checkpoints are kept.`, 'info');
    }
    const lobby = this.lobbyOf(user.id);
    if (lobby) { const l = lobby.members.get(user.id); if (l) l.connected = true; this.broadcastLobby(lobby); }
    this.pushPresence(user.id);
    log.info('player online', { user: user.id, name: user.display_name });
  }

  private onClose(s: Session) {
    s.closed = true;
    if (!s.user) return;
    if (this.sessions.get(s.userId) === s) this.sessions.delete(s.userId);
    else return; // superseded by a newer session
    const inst = s.inst;
    if (inst) {
      const p = inst.players.get(s.userId);
      if (p) {
        p.linkdeadAt = Date.now(); p.holding = null; p.inputs.length = 0;
        if (p.veh) inst.exitVehicle(p, true);
        void this.persistPlayer(p, inst);
      }
    }
    const lobby = this.lobbyOf(s.userId);
    if (lobby) { const l = lobby.members.get(s.userId); if (l) { l.connected = false; l.ready = false; } this.broadcastLobby(lobby); }
    this.pushPresence(s.userId);
    log.info('player offline', { user: s.userId });
  }

  private async housekeeping() {
    const now = Date.now();
    for (const inst of [...this.instances.values()]) {
      if (inst.kind !== 'activity') {
        for (const p of [...inst.players.values()]) {
          if (p.linkdeadAt && now - p.linkdeadAt > RECONNECT_GRACE_MS) {
            await this.persistPlayer(p, inst);
            inst.removePlayer(p.userId);
          } else if (!p.linkdeadAt && inst.kind === 'world' && inst.tickNo % 600 < 100) {
            void this.persistPlayer(p, inst);
          }
        }
      }
      if (inst.players.size === 0 && inst.kind === 'interior') this.closeInstance(inst);
      if (inst.players.size === 0 && inst.kind === 'world' && now - inst.emptySince > 60_000 && (inst.custom || [...this.instances.values()].filter((i) => i.kind === 'world' && i.access === 'public').length > 1)) this.closeInstance(inst);
    }
    this.parties.sweep();
    if (now - this.lastSessionPurge > 3_600_000) { this.lastSessionPurge = now; void this.store.db.query('DELETE FROM sessions WHERE expires_at < NOW()').catch(() => {}); }
    for (const [k, l] of this.lobbies) if (now - l.createdAt > 3_600_000) this.lobbies.delete(k);
  }

  private async persistPlayer(p: PlayerEnt, inst: Instance) {
    if (inst.kind === 'world' && !p.downUntil) await this.store.savePos(p.userId, { x: p.phys.x, y: p.phys.y, z: p.phys.z, yaw: p.yaw });
    else if (inst.kind === 'interior') { const out = anchor('safehouse.outside'); await this.store.savePos(p.userId, { x: out.wx, y: out.wy, z: out.wz, yaw: 0 }); }
    if (p.ammoDirty) {
      p.ammoDirty = false;
      const prof = await this.store.profile(p.userId);
      for (const [id, a] of Object.entries(p.ammo)) if (id !== 'stun') prof.inventory[`ammo:${id}`] = a.mag + a.reserve;
      await this.store.db.query('UPDATE profiles SET inventory = $2 WHERE user_id = $1', [p.userId, JSON.stringify(prof.inventory)]);
    }
  }

  // ───────────────────────────────────────────────────────── instances
  createWorld(label?: string, opts: { access?: 'public' | 'friends' | 'invite'; capacity?: number; host?: string; hostName?: string } = {}): Instance {
    const n = ++this.worldCounter;
    const inst = new Instance(this, newId(), 'world', label ?? `${WORLD === 'leonia' ? 'Leonia' : 'Palmara'} #${n}`, opts.capacity ?? MAX_PLAYERS_PER_INSTANCE);
    inst.access = opts.access ?? 'public';
    inst.hostId = opts.host ?? null;
    inst.hostName = opts.hostName ?? '';
    inst.custom = !!opts.host;
    inst.code = this.lobbyCode();
    this.instances.set(inst.id, inst);
    log.info('world created', { id: inst.id, label: inst.label });
    return inst;
  }

  closeInstance(inst: Instance) {
    if (inst.closed) return;
    inst.closed = true;
    for (const p of [...inst.players.values()]) {
      if (inst.kind === 'interior') { const r = this.interiorReturn.get(p.userId); this.returnToWorld(p.userId, r ?? { instance: null, pos: PLAZA_SPAWN }); }
      else if (inst.kind === 'world') { const s = this.sessions.get(p.userId); if (s) { s.inst = null; this.send(p.userId, { t: 'world.left', reason: 'This world was closed by an administrator.' }); } }
      inst.removePlayer(p.userId);
    }
    this.instances.delete(inst.id);
    log.info('instance closed', { id: inst.id, kind: inst.kind });
  }

  worldList(viewer: string) {
    const friends = new Set<string>();
    void this.store.friendIds(viewer).then((ids) => ids.forEach((i) => friends.add(i)));
    return [...this.instances.values()].filter((i) => i.kind === 'world').map((i) => ({
      id: i.id, label: i.label, players: i.occupancy(), capacity: i.capacity,
      friends: [...i.players.keys()].filter((u) => friends.has(u)).length,
    }));
  }

  private profileOf(userId: string) { return this.profiles.get(userId) ?? null; }

  /** chosen spawn property -> a validated standable spot (cached per user; used on join and free-roam respawn) */
  private spawnSpots = new Map<string, { x: number; y: number; z: number }>();
  spawnSpotFor(userId: string) { return this.spawnSpots.get(userId) ?? null; }
  async refreshSpawn(userId: string) {
    this.spawnSpots.delete(userId);
    try {
      const id = (await this.store.ownedProperties(userId)).spawn;
      const def = id ? PROPERTY_BY_ID[id] : null;
      if (!def?.perks.spawn) return;
      const standable = (x: number, z: number) => {
        const y = voxels.groundY(x, z, 40);
        const bx = Math.floor(x), bz = Math.floor(z);
        if (y <= 1 || voxels.getBlock(bx, y - 1, bz) === B.WATER || voxels.getBlock(bx, y - 1, bz) === B.AIR) return null;
        const open = (id: number) => id === B.AIR || id === B.TALL_GRASS || id === B.FLOWERS || id === B.REEDS || id === B.CANE;
        if (!open(voxels.getBlock(bx, y, bz)) || !open(voxels.getBlock(bx, y + 1, bz))) return null;
        return y;
      };
      // the property's anchor may sit inside a building or on water: search a small ring for open ground
      for (let r = 0; r <= 40; r += 2) for (let k = 0; k < (r ? 12 : 1); k++) {
        const a = (k / 12) * Math.PI * 2, x = def.pos[0] + 0.5 + Math.cos(a) * r, z = def.pos[1] + 0.5 + Math.sin(a) * r;
        const y = standable(x, z);
        if (y !== null) { this.spawnSpots.set(userId, { x, y, z }); return; }
      }
    } catch (e) { log.warn('spawn property lookup failed', { err: String(e) }); }
  }

  async refreshProfile(userId: string) {
    const prof = await this.store.profile(userId);
    this.profiles.set(userId, prof);
    const vehicles = await this.store.vehicles(userId);
    const bests = Object.fromEntries((await this.store.db.query<{ activity: string; value_ms: number }>('SELECT activity, value_ms FROM personal_bests WHERE user_id = $1', [userId])).map((r) => [r.activity, r.value_ms]));
    const p = this.playerEnt(userId);
    const weapons = ['stun', ...Object.keys(WEAPONS).filter((w) => prof.inventory[`weapon:${w}`])].map((id) => ({ id, ammo: id === 'stun' ? 999 : (p?.ammo[id] ? p.ammo[id].mag + p.ammo[id].reserve : prof.inventory[`ammo:${id}`] ?? 0) }));
    this.send(userId, { t: 'profile', profile: { cash: prof.cash, rep: prof.rep, completed: prof.completed, unlocks: prof.unlocks, preps: prof.preps, checkpoints: prof.checkpoints, inventory: prof.inventory, outfit: prof.outfit, hair: hairOf(prof), vehicles: vehicles.map((v) => ({ id: v.id, model: v.model, color: v.color, health: v.health, state: v.state })), bests, weapons, equipped: p?.weapon ?? 'stun' } });
  }

  private playerEnt(userId: string): PlayerEnt | null {
    const s = this.sessions.get(userId);
    return s?.inst?.players.get(userId) ?? null;
  }

  private loadWeapons(p: PlayerEnt, prof: Profile) {
    p.ammo = { stun: { mag: 6, reserve: 999 } };
    for (const [id, w] of Object.entries(WEAPONS)) {
      if (id === 'stun' || !prof.inventory[`weapon:${id}`]) continue;
      const total = prof.inventory[`ammo:${id}`] ?? 0;
      const mag = Math.min(w.mag, total);
      p.ammo[id] = { mag, reserve: total - mag };
    }
    if (!p.ammo[p.weapon]) p.weapon = 'stun';
  }

  private equip(s: Session, p: PlayerEnt, id: string) {
    if (!p.ammo[id]) { this.notify(s.userId, 'You don\'t own that weapon. Visit Bullseye Arms.', 'info'); return; }
    p.weapon = id; p.reloadUntil = 0;
    const a = p.ammo[id];
    this.send(s.userId, { t: 'weapon', id, mag: a.mag, reserve: a.reserve });
  }

  private sendWorld(s: Session, inst: Instance, p: PlayerEnt) {
    this.send(s.userId, { t: 'world', instance: inst.id, kind: inst.kind, label: inst.label, entity: p.id, pos: [p.phys.x, p.phys.y, p.phys.z], yaw: p.yaw, players: inst.connectedCount(), capacity: inst.capacity, access: inst.kind === 'world' ? inst.access : undefined, code: inst.kind === 'world' ? inst.code : undefined, host: inst.hostName || undefined });
    const a = p.ammo[p.weapon];
    this.send(s.userId, { t: 'weapon', id: p.weapon, mag: a?.mag ?? 0, reserve: a?.reserve ?? 0 });
    if (!inst.run) this.send(s.userId, { t: 'act', view: null });
    this.send(s.userId, inst.weather.message(Date.now()));
  }

  /** put a connected player into an instance at a position */
  private placeIn(s: Session, inst: Instance, pos: { x: number; y: number; z: number }, yaw: number): PlayerEnt {
    const prof = this.profileOf(s.userId)!;
    if (s.inst && s.inst !== inst) { const old = s.inst.players.get(s.userId); if (old) void this.persistPlayer(old, s.inst); s.inst.removePlayer(s.userId); }
    const party = this.parties.of(s.userId);
    let p = inst.players.get(s.userId);
    if (!p) p = inst.addPlayer({ userId: s.userId, name: s.name, partyId: party?.id ?? null, outfit: prof.outfit, hair: hairOf(prof) }, pos, yaw);
    else { p.linkdeadAt = 0; p.sent.clear(); inst.teleport(p, pos.x, pos.y, pos.z, yaw); }
    this.loadWeapons(p, prof);
    s.inst = inst;
    this.sendWorld(s, inst, p);
    this.pushPresence(s.userId);
    return p;
  }

  /** Can this user enter this free-roam lobby? Returns an error message or null. */
  canEnter(userId: string, inst: Instance, viaCode = false): string | null {
    if (inst.kind !== 'world' || inst.closed) return 'That lobby no longer exists.';
    if (inst.players.has(userId)) return null;
    if (!inst.hasRoom()) return `${inst.label} is full (${inst.occupancy()}/${inst.capacity}).`;
    if (inst.access === 'public' || inst.hostId === userId) return null;
    // party members of anyone inside may always follow their party
    const party = this.parties.of(userId);
    if (party && [...inst.players.keys()].some((u) => party.members.includes(u))) return null;
    if (viaCode) return null;
    if (inst.access === 'friends' && inst.hostId && this.friendCache.get(inst.hostId)?.has(userId)) return null;
    return inst.access === 'invite' ? 'That lobby is invite-only. Ask the host for the code.' : 'That lobby is friends-only.';
  }

  /** friend lists of custom-lobby hosts (refreshed when they create a lobby) */
  readonly friendCache = new Map<string, Set<string>>();

  private lobbyCode(): string {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (;;) {
      let c = '';
      for (let i = 0; i < 6; i++) c += A[Math.floor(Math.random() * A.length)];
      if (![...this.instances.values()].some((x) => x.code === c)) return c;
    }
  }

  async joinWorld(s: Session, target: WorldTarget) {
    if (s.inst?.kind === 'activity') { this.error(s, 'busy', 'Finish or leave your activity first.'); return; }
    const party = this.parties.of(s.userId);
    let inst: Instance | null = null;
    const worlds = [...this.instances.values()].filter((i) => i.kind === 'world');
    let viaCode = false;
    const partyWorld = () => {
      if (!party) return null;
      const ids = [party.leader, ...party.members.filter((m) => m !== party.leader)];
      for (const id of ids) {
        if (id === s.userId) continue;
        const other = this.sessions.get(id)?.inst;
        if (other?.kind === 'world') return other;
      }
      return null;
    };
    if (typeof target === 'object' && 'create' in target) {
      if (worlds.length >= config.maxInstances) { this.error(s, 'capacity', 'The server is at capacity. Join an existing lobby.'); return; }
      const c = target.create;
      const name = c.name.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 32) || `${s.name}'s lobby`;
      this.friendCache.set(s.userId, new Set(await this.store.friendIds(s.userId)));
      inst = this.createWorld(name, { access: c.access, capacity: c.capacity, host: s.userId, hostName: s.name });
    } else if (typeof target === 'object' && 'code' in target) {
      inst = worlds.find((w) => w.code === target.code.toUpperCase()) ?? null;
      if (!inst) { this.error(s, 'no_world', 'No lobby with that code. Codes look like K7Q2MD.'); return; }
      viaCode = true;
    } else if (typeof target === 'object') {
      inst = this.instances.get(target.instance) ?? null;
      if (!inst || inst.kind !== 'world') { this.error(s, 'no_world', 'That lobby no longer exists.'); return; }
    } else if (target === 'party') {
      inst = partyWorld();
      if (!inst) { this.error(s, 'no_world', party ? 'Nobody in your party is in a lobby right now. Press Play to start one — they can join you.' : 'You are not in a party.'); return; }
    } else if (target === 'new') {
      if (worlds.length >= config.maxInstances) { this.error(s, 'capacity', 'The server is at capacity. Join an existing lobby.'); return; }
      inst = this.createWorld();
    } else {
      // matchmaking: your party's lobby first, then the fullest public lobby with room, else a fresh one
      inst = partyWorld();
      if (inst && this.canEnter(s.userId, inst)) inst = null;
      if (!inst) inst = worlds.filter((w) => w.access === 'public' && w.hasRoom()).sort((a, b) => b.occupancy() - a.occupancy())[0] ?? null;
      if (!inst) inst = this.createWorld();
    }
    if (s.inst === inst) { const p = inst.players.get(s.userId)!; this.sendWorld(s, inst, p); return; }
    const deny = this.canEnter(s.userId, inst, viaCode);
    if (deny) { this.error(s, target === 'party' ? 'party_world_full' : 'world_full', deny); return; }
    const prof = this.profileOf(s.userId)!;
    await this.refreshSpawn(s.userId);
    let pos = this.spawnSpotFor(s.userId) ?? PLAZA_SPAWN, yaw = 0;
    // saved positions are tagged with their world; untagged saves are from Palmara (before Leonia became the default)
    const posWorld = prof.pos?.world ?? 'palmara';
    if (prof.pos && posWorld === WORLD && prof.pos.x > 0 && prof.pos.x < WORLD_W && prof.pos.z > 0 && prof.pos.z < WORLD_D) {
      const gy = voxels.groundY(prof.pos.x, prof.pos.z, prof.pos.y + 1.5);
      if (Math.abs(gy - prof.pos.y) < 3) { pos = { x: prof.pos.x, y: gy, z: prof.pos.z }; yaw = prof.pos.yaw; }
    }
    if (typeof target === 'object' || target === 'party') {
      const anchorP = party ? [...inst.players.values()].find((x) => party.members.includes(x.userId) && !x.linkdeadAt) : null;
      if (anchorP) pos = { x: anchorP.phys.x + 1.5, y: anchorP.phys.y, z: anchorP.phys.z + 1.5 };
    }
    this.placeIn(s, inst, pos, yaw);
    if (party && party.leader === s.userId && (target === 'new' || (typeof target === 'object' && 'create' in target))) for (const m of party.members) if (m !== s.userId) this.send(m, { t: 'social', event: 'leader_moved', data: { name: s.name, instance: inst.id } });
  }

  /** lobbies this user may see in the lobby browser */
  lobbyList(userId: string, friends: Set<string>) {
    const party = this.parties.of(userId);
    return [...this.instances.values()].filter((i) => i.kind === 'world' && !i.closed).filter((i) => {
      if (i.access === 'public' || i.hostId === userId || i.players.has(userId)) return true;
      if (party && [...i.players.keys()].some((u) => party.members.includes(u))) return true;
      return i.access === 'friends' && !!i.hostId && friends.has(i.hostId);
    }).map((i) => ({
      id: i.id, label: i.label, players: i.occupancy(), capacity: i.capacity, friends: [...i.players.keys()].filter((x) => friends.has(x)).length,
      access: i.access, host: i.hostName || null, custom: i.custom, full: !i.hasRoom(),
      code: i.hostId === userId || i.players.has(userId) ? i.code : undefined,
      joinable: !this.canEnter(userId, i),
    })).sort((a, b) => Number(b.friends > 0) - Number(a.friends > 0) || b.players - a.players);
  }

  async leaveWorld(s: Session, reason: string) {
    const inst = s.inst;
    if (!inst) return;
    if (inst.kind === 'activity') { inst.run?.leave(s.userId); }
    const p = inst.players.get(s.userId);
    if (p) await this.persistPlayer(p, inst);
    inst.removePlayer(s.userId);
    s.inst = null;
    this.send(s.userId, { t: 'world.left', reason });
    this.pushPresence(s.userId);
  }

  returnToWorld(userId: string, to: { instance: string | null; pos: { x: number; y: number; z: number } }) {
    const s = this.sessions.get(userId);
    const cur = s?.inst;
    if (cur && cur.kind !== 'world') { const p = cur.players.get(userId); if (p && cur.kind === 'activity') { p.frozen = false; } cur.removePlayer(userId); if (s) s.inst = null; }
    else if (!s) {
      for (const inst of this.instances.values()) if (inst.kind !== 'world' && inst.players.has(userId)) inst.removePlayer(userId);
      void this.store.savePos(userId, { ...to.pos, yaw: 0 });
      return;
    }
    if (!s) return;
    let inst = to.instance ? this.instances.get(to.instance) ?? null : null;
    if (!inst || inst.closed || !inst.hasRoom()) inst = [...this.instances.values()].filter((i) => i.kind === 'world' && i.access === 'public' && i.hasRoom()).sort((a, b) => b.occupancy() - a.occupancy())[0] ?? this.createWorld();
    this.placeIn(s, inst, to.pos, 0);
    void this.refreshProfile(userId);
  }

  // ───────────────────────────────────────────────────────── interactions
  private async interact(s: Session, p: PlayerEnt, inst: Instance, target: string) {
    if (p.downUntil || p.frozen) return;
    if (target.startsWith('o:')) {
      const o = inst.objects.get(target);
      if (!o || o.state !== 0) return;
      if (!interactRangeOk(p, o.x, o.y, o.z)) { this.notify(s.userId, 'Get closer.', 'info'); return; }
      if (o.kind === 'target') return;
      const secs = inst.run?.holdTime(o, p) ?? o.hold;
      if (inst.run && !inst.run.roster.has(p.userId)) return;
      if (secs <= 0.05) { o.state = 1; o.doneBy = p.userId; o.doneAt = inst.now; inst.run?.onObjectDone(o, p); return; }
      p.holding = { target, started: Date.now(), required: secs };
      this.send(s.userId, { t: 'hold', target, seconds: secs, label: o.label });
      if (o.kind === 'safe') this.sfx(inst, 'drill', o.x, o.y + 1, o.z, 0.6);
      return;
    }
    if (target.startsWith('d:')) {
      const d = inst.doors.get(target);
      if (!d) return;
      const cx = d.x + (d.axis === 'x' ? d.w / 2 : 0.5), cz = d.z + (d.axis === 'z' ? d.w / 2 : 0.5);
      if (!interactRangeOk(p, cx, d.y, cz, 1.2)) { this.notify(s.userId, 'Get closer.', 'info'); return; }
      if (d.rule === 'portal:safehouse') { if (inst.kind === 'interior') return this.exitInterior(s, p, inst); return this.enterSafehouse(s, p, inst); }
      if (d.locked) { this.notify(s.userId, `${d.label}: locked.`, 'info', 'ui_click'); return; }
      d.open = !d.open; d.closeAt = d.open ? Date.now() + 7000 : 0;
      this.sfx(inst, d.open ? 'door_open' : 'door_close', cx, d.y + 1, cz, 0.8);
      inst.setDoor(d.key, d.open ? 'open' : 'closed');
      d.closeAt = d.open ? Date.now() + 7000 : 0;
      return;
    }
    if (target.startsWith('n:')) {
      const n = inst.npcs.get(target);
      if (!n || n.role !== 'static' || !interactRangeOk(p, n.x, n.y, n.z, 1.5)) return;
      barkEvent(inst, 'shopGreet', n.x, n.z);
      return this.talkTo(s, p, n.label, n.name ?? '');
    }
    const a = worldAnchors().find((x) => x.key === target && x.kind === 'interact');
    if (!a) return;
    if (!interactRangeOk(p, a.wx, a.wy, a.wz, 1.2)) { this.notify(s.userId, 'Get closer.', 'info'); return; }
    const rule = a.rule ?? '';
    if (rule === 'safehouse_bed') {
      if (inst.kind !== 'interior') { this.notify(s.userId, 'This isn\'t your bed.', 'info'); return; }
      p.hp = p.maxHp;
      const out = anchor('safehouse.outside');
      await this.store.savePos(s.userId, { x: out.wx, y: out.wy, z: out.wz, yaw: 0 });
      await this.persistPlayer(p, inst);
      this.notify(s.userId, 'You rested. Health restored and progress saved.', 'good', 'notify');
      return;
    }
    if (rule === 'safehouse_wardrobe') return this.openShop(s, 'wardrobe');
    if (rule === 'heist_board') { this.send(s.userId, { t: 'ui', open: 'heistboard' }); return; }
    if (rule === 'safehouse_tv') { this.notify(s.userId, NEWS[Math.floor(Math.random() * NEWS.length)], 'info'); return; }
    if (rule === 'garage_service') return this.openGarage(s, p, inst);
    if (rule === 'shop_counter') return this.openShop(s, 'store');
    if (rule === 'diner_counter') return this.openShop(s, 'diner');
    if (rule === 'club_bar') return this.openShop(s, 'club');
    if (rule === 'police_desk') return this.openPoliceDesk(s, p, inst);
    if (rule.startsWith('talk:')) return this.talkTo(s, p, `contact:${rule.slice(5)}`, '');
    if (rule === 'shop:dealer' || rule === 'shop:sunline') return this.openGarage(s, p, inst);
    if (rule.startsWith('shop:')) return this.openShop(s, rule.slice(5));
    if (rule === 'mission_object') { this.notify(s.userId, 'Nothing useful here right now.', 'info'); return; }
  }

  private talkTo(s: Session, _p: PlayerEnt | undefined, role: string, name: string) {
    if (role.startsWith('contact:')) {
      const c = role.slice(8);
      if (CONTACTS[c]) { void this.brief(s, `contact:${c}`); return; }
      if (c === 'reception') { this.notify(s.userId, 'Receptionist: "Vega & Sons is closed to visitors today. And tomorrow."', 'info'); return; }
    }
    const lines: Record<string, string> = {
      mechanic: '__garage', shopkeeper: '__store', waitress: '__diner', officer: '__police',
      bouncer: 'Bouncer: "Club\'s open. Keep it friendly in there."', receptionist: 'Receptionist: "Do you have an appointment? No? Then no."',
    };
    const l = lines[role];
    if (l === '__garage') { const inst = s.inst!; return this.openGarage(s, inst.players.get(s.userId)!, inst); }
    if (l === '__store') {
      // the clerk belongs to whichever shop counter is closest (gunstore, clothes, ...), not always Quik Pelican
      const pp = _p; let best: { rule: string; d: number } | null = null;
      if (pp) for (const a of worldAnchors()) {
        if (a.kind !== 'interact' || !a.rule || !(a.rule === 'shop_counter' || (a.rule.startsWith('shop:') && a.rule !== 'shop:dealer' && a.rule !== 'shop:sunline'))) continue;
        const d = Math.hypot(a.wx - pp.phys.x, a.wz - pp.phys.z);
        if (d < 14 && (!best || d < best.d)) best = { rule: a.rule, d };
      }
      if (best && best.rule.startsWith('shop:')) return this.openShop(s, best.rule.slice(5));
      return this.openShop(s, 'store');
    }
    if (l === '__diner') return this.openShop(s, 'diner');
    if (l === '__police') { const inst = s.inst!; return this.openPoliceDesk(s, inst.players.get(s.userId)!, inst); }
    this.notify(s.userId, l ?? `${name || 'They'} nod at you.`, 'info');
  }

  private enterSafehouse(s: Session, p: PlayerEnt, inst: Instance) {
    if (inst.kind !== 'world') return;
    // personal interior; party members join the owner's interior if one is open
    const party = this.parties.of(s.userId);
    let interior: Instance | null = null;
    for (const i of this.instances.values()) {
      if (i.kind !== 'interior' || i.closed) continue;
      if (i.ownerId === s.userId || (party && party.members.includes(i.ownerId!) && i.players.has(i.ownerId!))) { interior = i; break; }
    }
    if (!interior) {
      interior = new Instance(this, newId(), 'interior', `${s.name}'s apartment`, 4, inst.weather);
      interior.ownerId = s.userId;
      this.instances.set(interior.id, interior);
    }
    if (!interior.hasRoom()) { this.notify(s.userId, 'The apartment is full.', 'info'); return; }
    this.interiorReturn.set(s.userId, { instance: inst.id, pos: { x: p.phys.x, y: p.phys.y, z: p.phys.z } });
    const sp = anchor('safehouse.inside');
    this.placeIn(s, interior, { x: sp.wx, y: sp.wy, z: sp.wz }, sp.yaw ?? Math.PI);
    this.notify(s.userId, interior.ownerId === s.userId ? 'Home sweet home. Bed = save & heal. Board = heists.' : `You're visiting ${interior.label}.`, 'info', 'door_open');
  }

  private exitInterior(s: Session, _p: PlayerEnt, _inst: Instance) {
    const r = this.interiorReturn.get(s.userId);
    const out = anchor('safehouse.outside');
    this.returnToWorld(s.userId, { instance: r?.instance ?? null, pos: { x: out.wx, y: out.wy, z: out.wz } });
    this.sfx(s.inst!, 'door_close', out.wx, out.wy + 1, out.wz, 0.7, s.userId);
  }

  // ───────────────────────────────────────────────────────── shops & economy
  private shopNear(p: PlayerEnt, shop: string): boolean {
    const rules: Record<string, string[]> = { store: ['shop_counter'], diner: ['diner_counter'], club: ['club_bar'], wardrobe: ['safehouse_wardrobe'] };
    const want = rules[shop] ?? [`shop:${shop}`];
    for (const a of worldAnchors()) if (a.kind === 'interact' && want.includes(a.rule ?? '') && interactRangeOk(p, a.wx, a.wy, a.wz, 4)) return true;
    // shopkeeper NPC proximity counts too
    return false;
  }

  private openShop(s: Session, shop: string) {
    const def = SHOPS[shop];
    if (!def) { this.notify(s.userId, 'Closed.', 'info'); return; }
    const prof = this.profileOf(s.userId)!;
    const items = def.items.map((it) => {
      let owned = false, disabled: string | undefined;
      if (it.id.startsWith('weapon:')) owned = !!prof.inventory[it.id];
      if (it.id.startsWith('ammo:') && !prof.inventory[`weapon:${it.id.slice(5)}`]) disabled = 'Buy the weapon first';
      if (it.effect.outfit !== undefined) owned = prof.outfit === it.effect.outfit;
      let have: boolean | undefined, colour = it.effect.outfit;
      const hc = hairColourOf(it.effect.give);
      if (hc !== null) { colour = hc; have = !!prof.inventory[it.effect.give!]; owned = hairOf(prof) === hc; }
      if (it.effect.give === 'medkit' && (prof.inventory.medkit ?? 0) >= MAX_MEDKITS) disabled = `Carrying the maximum (${MAX_MEDKITS})`;
      if (it.price > prof.cash && !owned && !have) disabled = disabled ?? 'Not enough cash';
      return { id: it.id, name: it.name, price: it.price, desc: it.desc, owned, have, disabled, color: colour, category: (it as { category?: string }).category };
    });
    this.send(s.userId, { t: 'shop', shop, data: { name: def.name, items } });
  }

  private async buy(s: Session, p: PlayerEnt | undefined, shop: string, itemId: string) {
    const def = SHOPS[shop];
    const item = def?.items.find((i) => i.id === itemId);
    if (!def || !item || !p) { this.notify(s.userId, 'That item isn\'t available.', 'bad'); return; }
    if (!this.shopNear(p, shop)) { this.notify(s.userId, 'You need to be at the shop to buy that.', 'bad'); return; }
    const prof = this.profileOf(s.userId)!;
    let res: { ok: true; cash: number } | { ok: false; error: string };
    if (item.id.startsWith('weapon:')) {
      if (prof.inventory[item.id]) { this.notify(s.userId, 'You already own that.', 'info'); return; }
      res = await this.store.purchase(s.userId, item.price, `buy ${item.id}`, { item: item.id, delta: 1, max: 1 });
      if (res.ok) { const wid = item.id.slice(7); const w = WEAPONS[wid]; await this.store.purchase(s.userId, 0, 'starter ammo', { item: `ammo:${wid}`, delta: w.ammoPack, max: w.maxAmmo }); }
    } else if (item.id.startsWith('ammo:')) {
      const wid = item.id.slice(5), w = WEAPONS[wid];
      if (!w || !prof.inventory[`weapon:${wid}`]) { this.notify(s.userId, 'Buy the weapon first.', 'bad'); return; }
      const cur = p.ammo[wid] ? p.ammo[wid].mag + p.ammo[wid].reserve : prof.inventory[item.id] ?? 0;
      if (cur >= w.maxAmmo) { this.notify(s.userId, 'You can\'t carry more ammo for that.', 'info'); return; }
      const add = Math.min(w.ammoPack, w.maxAmmo - cur);
      res = await this.store.purchase(s.userId, item.price, `buy ${item.id}`);
      if (res.ok) { if (p.ammo[wid]) p.ammo[wid].reserve += add; p.ammoDirty = true; }
    } else if (hairColourOf(item.effect.give) !== null) {
      // barber: owning a colour is permanent, wearing it is free to switch; the choice is stored in the profile inventory (hair_sel)
      const hc = hairColourOf(item.effect.give)!;
      if (hairOf(prof) === hc) { this.notify(s.userId, 'You already have that hair colour.', 'info'); return; }
      if (prof.inventory[item.effect.give!]) { await this.store.setInventoryValue(s.userId, 'hair_sel', hc); res = { ok: true, cash: prof.cash }; }
      else res = await this.store.purchase(s.userId, item.price, `buy ${item.id}`, { item: item.effect.give!, delta: 1, max: 1 }, { hair_sel: hc });
      if (res.ok) p.hair = hc;
    } else if (item.effect.give) {
      res = await this.store.purchase(s.userId, item.price, `buy ${item.id}`, { item: item.effect.give, delta: 1, max: item.effect.give === 'medkit' ? MAX_MEDKITS : 99 });
    } else if (item.effect.outfit !== undefined) {
      res = await this.store.purchase(s.userId, item.price, `buy ${item.id}`);
      if (res.ok) { await this.store.setOutfit(s.userId, item.effect.outfit); p.outfit = item.effect.outfit; }
    } else {
      res = await this.store.purchase(s.userId, item.price, `buy ${item.id}`);
      if (res.ok && item.effect.heal) p.hp = Math.min(p.maxHp, p.hp + item.effect.heal);
    }
    if (!res.ok) { this.notify(s.userId, res.error, 'bad'); return; }
    this.notify(s.userId, hairColourOf(item.effect.give) !== null ? `Hair colour: ${item.name}.` : `Bought ${item.name}.`, 'good', 'cash');
    if (s.inst) barkEvent(s.inst, 'shopThanks', p.phys.x, p.phys.z);
    if (item.id.startsWith('weapon:')) await this.persistPlayer(p, s.inst!);
    await this.refreshProfile(s.userId);
    if (item.id.startsWith('weapon:')) { this.loadWeapons(p, this.profileOf(s.userId)!); }
    this.openShop(s, shop);
  }

  private async useItem(s: Session, p: PlayerEnt | undefined, item: string) {
    if (!p || p.downUntil) return;
    if (item !== 'medkit') return;
    if (p.hp >= p.maxHp) { this.notify(s.userId, 'Already at full health.', 'info'); return; }
    if (!(await this.store.useItem(s.userId, 'medkit'))) { this.notify(s.userId, 'No first-aid kits. Buy them at Quik Pelican.', 'bad'); return; }
    p.hp = p.maxHp;
    this.notify(s.userId, 'Used a first-aid kit.', 'good', 'pickup');
    await this.refreshProfile(s.userId);
  }

  private garageZone(p: PlayerEnt) { const c = poiCenter('garage'); return Math.hypot(p.phys.x - c[0], p.phys.z - c[1]) < 32; }

  private nearbyVehicle(p: PlayerEnt, inst: Instance): VehicleEnt | null {
    if (p.veh) return inst.vehicles.get(p.veh) ?? null;
    let best: VehicleEnt | null = null, bd = 12 * 12;
    for (const v of inst.vehicles.values()) {
      if (v.destroyedAt || v.ai) continue;
      const d = (v.phys.x - p.phys.x) ** 2 + (v.phys.z - p.phys.z) ** 2;
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }

  private async openGarage(s: Session, p: PlayerEnt, inst: Instance) {
    const vehicles = await this.store.vehicles(s.userId);
    const near = this.garageZone(p) ? this.nearbyVehicle(p, inst) : null;
    const prof = this.profileOf(s.userId)!;
    const items = [
      ...PAINT_COLORS.map((c) => ({ id: `paint:${c}`, name: 'Paint job', price: PAINT_PRICE, desc: 'Respray your nearby vehicle.', color: c, category: 'Paint', disabled: !near?.owner || near.owner.userId !== s.userId ? 'Park one of YOUR vehicles in the garage' : undefined })),
      ...DEALER_MODELS.map((m) => ({ id: `buy:${m}`, name: VEHICLES[m].name, price: VEHICLES[m].price, desc: `${VEHICLES[m].seats} seats · top speed ${Math.round(VEHICLES[m].maxSpeed * 3.6)} km/h`, category: 'Sunline Motors', disabled: prof.cash < VEHICLES[m].price ? 'Not enough cash' : undefined })),
    ];
    this.send(s.userId, {
      t: 'shop', shop: 'garage', data: {
        name: 'Torque & Tide Garage', items,
        vehicles: vehicles.map((v) => ({ id: v.id, model: v.model, color: v.color, health: v.health, state: v.state })),
        nearbyVehicle: near ? { id: near.id, model: near.model, hp: Math.round((near.hp / near.def.health) * 100), repairCost: Math.ceil((near.def.health - near.hp) * REPAIR_PRICE_PER_HP), mine: near.owner?.userId === s.userId } : null,
      },
    });
  }

  private async garage(s: Session, p: PlayerEnt | undefined, m: Extract<C2SMsg, { t: 'garage' }>) {
    const inst = s.inst;
    if (!p || !inst) return;
    if (inst.kind === 'activity' && m.op !== 'buy') { this.notify(s.userId, 'Not during an activity.', 'bad'); return; }
    const uid = s.userId;
    switch (m.op) {
      case 'repair': {
        if (!this.garageZone(p)) { this.notify(uid, 'Drive into Torque & Tide to repair.', 'bad'); return; }
        const v = this.nearbyVehicle(p, inst);
        if (!v) { this.notify(uid, 'No vehicle in the bay.', 'bad'); return; }
        const cost = Math.ceil((v.def.health - v.hp) * REPAIR_PRICE_PER_HP);
        if (cost <= 0) { this.notify(uid, 'It\'s already in perfect shape.', 'info'); return; }
        const r = await this.store.purchase(uid, cost, 'repair');
        if (!r.ok) { this.notify(uid, r.error, 'bad'); return; }
        v.hp = v.def.health; v.destroyedAt = 0;
        if (v.owner) await this.store.updateVehicle(v.owner.vehicleId, { health: v.hp });
        this.notify(uid, `Repaired for $${cost}.`, 'good', 'cash');
        break;
      }
      case 'paint': {
        const v = this.nearbyVehicle(p, inst);
        if (!this.garageZone(p) || !v?.owner || v.owner.userId !== uid) { this.notify(uid, 'Bring one of your own vehicles into the garage.', 'bad'); return; }
        if (m.color === undefined || !PAINT_COLORS.includes(m.color)) return;
        const r = await this.store.purchase(uid, PAINT_PRICE, 'paint');
        if (!r.ok) { this.notify(uid, r.error, 'bad'); return; }
        v.color = m.color;
        await this.store.updateVehicle(v.owner.vehicleId, { color: m.color });
        this.notify(uid, 'Fresh paint!', 'good', 'cash');
        break;
      }
      case 'store': {
        const v = [...inst.vehicles.values()].find((x) => x.owner?.userId === uid);
        if (!v) { this.notify(uid, 'You have no vehicle out.', 'info'); return; }
        if (!this.garageZone(p) && Math.hypot(v.phys.x - p.phys.x, v.phys.z - p.phys.z) > 15) { this.notify(uid, 'Bring it to the garage (or stand next to it) to store it.', 'bad'); return; }
        await this.storeVehicleFromWorld(v, inst);
        this.notify(uid, 'Vehicle stored.', 'good');
        break;
      }
      case 'spawn':
      case 'deliver': {
        const all = await this.store.vehicles(uid);
        const want = m.vehicle ? all.find((v) => v.id === m.vehicle) : all.find((v) => v.state !== 'destroyed');
        if (!want || want.owner_id !== uid) { this.notify(uid, 'Vehicle not found.', 'bad'); return; }
        for (const inst2 of this.instances.values()) for (const v of [...inst2.vehicles.values()]) if (v.owner?.userId === uid) await this.storeVehicleFromWorld(v, inst2);
        let x: number, z: number, yaw: number, y: number | undefined;
        if (m.op === 'spawn') {
          if (!this.garageZone(p)) { this.notify(uid, 'Collect vehicles at Torque & Tide, or use Request vehicle on your phone.', 'bad'); return; }
          const a = anchor('garage.vehicle_spawn'); x = a.wx; z = a.wz; yaw = a.yaw ?? 0;
          // boats launch from the downtown marina in the bay instead of the street
          if (want.model === 'boat') { x = MARINA.x; z = MARINA.z; yaw = 0; }
        } else {
          const r = await this.store.purchase(uid, DELIVERY_PRICE, 'vehicle delivery');
          if (!r.ok) { this.notify(uid, r.error, 'bad'); return; }
          // nearest street spot (WorldNav: Palmara grid formula, Leonia curb lane of the nearest real road)
          const spot = nav.deliverySpot(p.phys.x, p.phys.z);
          x = spot.x; z = spot.z; yaw = spot.yaw; y = spot.y;
          if (want.model === 'boat') {
            const b = nav.boatSpot(p.phys.x, p.phys.z);
            if (b) { x = b.x; z = b.z; yaw = b.yaw; this.notify(uid, 'Boats are delivered to the nearest open water.', 'info'); }
            else { x = MARINA.x; z = MARINA.z; yaw = 0; this.notify(uid, `Boats are delivered to ${MARINA_NAME}.`, 'info'); }
          }
        }
        const health = want.state === 'destroyed' ? VEHICLES[want.model].health : want.health;
        const v = inst.spawnVehicle(want.model as VehicleModel, x, want.model === 'boat' ? 21 : voxels.groundY(x, z, y !== undefined ? y + 2 : 40), z, yaw, { color: want.color, owner: { userId: uid, vehicleId: want.id }, allowed: this.vehicleAllowed(uid), hp: health, label: `${s.name}'s ${VEHICLES[want.model].name}` });
        p.personalVehicle = v.id;
        await this.store.updateVehicle(want.id, { state: 'out', health });
        this.notify(uid, m.op === 'deliver' ? `Your ${VEHICLES[want.model].name} was delivered nearby ($${DELIVERY_PRICE}).` : 'Your vehicle is ready out front.', 'good', 'car_door');
        break;
      }
      case 'buy': {
        const model = m.model as VehicleModel;
        if (!DEALER_MODELS.includes(model)) return;
        const r = await this.store.buyVehicle(uid, model, VEHICLES[model].price, m.color ?? 0xf6f7f8);
        if (!r.ok) { this.notify(uid, r.error, 'bad'); return; }
        this.notify(uid, `Bought a ${VEHICLES[model].name}! It's in your garage.`, 'good', 'cash');
        break;
      }
    }
    await this.refreshProfile(uid);
    if (m.op !== 'buy' && m.op !== 'deliver' && s.inst) void this.openGarage(s, p, s.inst);
  }

  /** Phone web: remote ammo order (delivery premium on the shelf price). Works online or offline. */
  async webAmmo(userId: string, wid: string, premium: number): Promise<{ ok: true; cash: number; price: number; added: number; total: number } | { ok: false; error: string }> {
    const w = WEAPONS[wid];
    if (!w || wid === 'stun') return { ok: false, error: 'Unknown weapon.' };
    const prof = await this.store.profile(userId);
    if (!prof.inventory[`weapon:${wid}`]) return { ok: false, error: `You do not own the ${w.name}. Visit Bullseye Arms in person.` };
    const p = this.playerEnt(userId);
    const live = p?.ammo[wid];
    const cur = live ? live.mag + live.reserve : prof.inventory[`ammo:${wid}`] ?? 0;
    if (cur >= w.maxAmmo) return { ok: false, error: 'You cannot carry more ammo for that weapon.' };
    const added = Math.min(w.ammoPack, w.maxAmmo - cur);
    const price = Math.ceil(w.ammoPrice * premium);
    const res = live
      ? await this.store.purchase(userId, price, `web ammo ${wid}`)
      : await this.store.purchase(userId, price, `web ammo ${wid}`, { item: `ammo:${wid}`, delta: added, max: w.maxAmmo });
    if (!res.ok) return res;
    if (live && p) { live.reserve += added; p.ammoDirty = true; }
    await this.refreshProfile(userId);
    return { ok: true, cash: res.cash, price, added, total: cur + added };
  }
  /** Phone web: outfit colour changed remotely */
  async webOutfit(userId: string, colour: number) {
    await this.store.setOutfit(userId, colour);
    const p = this.playerEnt(userId);
    if (p) p.outfit = colour;
    await this.refreshProfile(userId);
  }

  /** personal vehicles may be driven by the owner and their party */
  vehicleAllowed(owner: string): Set<string> {
    const party = this.parties.of(owner);
    return new Set(party ? party.members : [owner]);
  }

  async storeVehicleFromWorld(v: VehicleEnt, inst: Instance) {
    if (!v.owner) return;
    const id = v.owner.vehicleId;
    inst.removeVehicle(v.id);
    await this.store.updateVehicle(id, { health: v.destroyedAt ? 0 : v.hp, state: v.destroyedAt ? 'destroyed' : 'stored' });
  }

  private openPoliceDesk(s: Session, p: PlayerEnt, inst: Instance) {
    const w = inst.wantedOf(p);
    const fine = (w?.level ?? 0) * WANTED_FINE;
    this.send(s.userId, { t: 'shop', shop: 'police', data: { name: worldText('Solano PD — Front desk'), items: [{ id: 'pay_fine', name: w ? `Pay fine (${'★'.repeat(w.level)})` : 'No outstanding warrants', price: fine, desc: 'Clears your wanted level if no officers are chasing you right now.', disabled: !w ? 'You are not wanted' : inst.run ? 'Not during an activity' : undefined }] } });
  }

  private async payWanted(s: Session, p: PlayerEnt | undefined) {
    const inst = s.inst;
    if (!p || !inst || inst.run || !p.wanted) return;
    const desk = anchor('police.desk');
    if (!interactRangeOk(p, desk.wx, desk.wy, desk.wz, 3)) { this.notify(s.userId, 'Go to the police front desk.', 'bad'); return; }
    if (Date.now() - p.wanted.lastSeenAt < 4000) { this.notify(s.userId, 'Not while officers are actively chasing you.', 'bad'); return; }
    const fine = p.wanted.level * WANTED_FINE;
    const bal = await this.store.adjustCash(s.userId, -fine, 'police fine');
    if (bal === null) { this.notify(s.userId, 'Not enough cash for the fine.', 'bad'); return; }
    p.wanted = null;
    this.notify(s.userId, `Fine paid ($${fine}). Wanted level cleared.`, 'good', 'cash');
    await this.refreshProfile(s.userId);
  }

  async bustedFine(p: PlayerEnt) {
    const prof = await this.store.profile(p.userId);
    const fine = Math.min(250, prof.cash);
    if (fine > 0) await this.store.adjustCash(p.userId, -fine, 'busted');
    this.notify(p.userId, `Released from Central Precinct. Fine: $${fine}.`, 'info');
    await this.refreshProfile(p.userId);
  }

  // ───────────────────────────────────────────────────────── activities
  private async brief(s: Session, activity: string) {
    const prof = await this.store.profile(s.userId);
    this.profiles.set(s.userId, prof);
    if (activity.startsWith('contact:')) {
      const jobs = contactJobs(activity.slice(8), prof);
      if (jobs) this.send(s.userId, { t: 'brief', data: jobs });
      return;
    }
    const def = ACTIVITY_BY_ID[activity];
    if (!def) return;
    const party = this.parties.of(s.userId);
    const ids = party ? party.members : [s.userId];
    const n = ids.length;
    const eligibility = [];
    for (const id of ids) {
      const pr = id === s.userId ? prof : await this.store.profile(id);
      const e = eligibilityOf(def, pr);
      const reward = def.kind === 'heist' ? 'Share of the take' : e === 'story' ? `$${def.rewards.cash[n - 1].toLocaleString()} + ${def.rewards.rep} rep` : `$${def.rewards.replayCash.toLocaleString()} (${e === 'replay' ? 'replay' : 'guest'})`;
      eligibility.push({ userId: id, name: party?.names[id] ?? s.name, eligibility: e, reward });
    }
    const unlocked = isUnlocked(def, prof);
    const cp = prof.checkpoints[def.id];
    const best = await this.store.personalBest(s.userId, def.id);
    this.send(s.userId, {
      t: 'brief', data: {
        activity: def.id, name: def.name, kind: def.kind, giver: CONTACTS[def.giver]?.name ?? def.giver, blurb: def.blurb, notes: def.notes,
        unlocked, lockedReason: unlocked ? undefined : `Requires: ${(def.unlock.requires ?? []).map((r) => ACTIVITY_BY_ID[r]?.name ?? r).join(', ')}`,
        eligibility,
        preps: def.preps?.map((pid) => ({ id: pid, name: ACTIVITY_BY_ID[pid]?.name ?? pid, done: (prof.preps[def.id] ?? []).includes(pid), optional: !!def.heist?.setups.find((x) => x.prep === pid)?.optional })),
        heist: def.heist ? {
          approaches: def.heist.approaches, equipment: def.heist.equipment, roles: def.heist.roles, baseTake: def.heist.baseTake,
          setups: def.heist.setups.map((x) => ({ id: x.prep, name: ACTIVITY_BY_ID[x.prep]?.name ?? x.prep, optional: !!x.optional, perk: x.perk, category: x.category, done: (prof.preps[def.id] ?? []).includes(x.prep), choice: x.choice ? { label: x.choice.label, picked: x.choice.options.find((o) => (prof.preps[def.id] ?? []).includes(`choice:${x.choice!.key}=${o.id}`))?.name } : undefined })),
          elite: def.heist.elite, firstTimeBonus: def.heist.firstTimeBonus, hardMult: def.heist.hardMult ?? 1.25,
        } : undefined,
        setupOf: def.prepFor ? (() => { const h = ACTIVITY_BY_ID[def.prepFor!]; const sd = h?.heist?.setups.find((x) => x.prep === def.id); return sd ? { heist: h.id, heistName: h.name, optional: !!sd.optional, perk: sd.perk, choice: sd.choice } : undefined; })() : undefined,
        checkpoint: cp ? { stage: cp, title: def.stages[cp]?.title ?? '' } : undefined,
        personalBest: best ?? undefined,
      },
    });
  }

  private lobbyKey(userId: string) { const p = this.parties.of(userId); return p ? `party:${p.id}` : `solo:${userId}`; }
  lobbyOf(userId: string) { return this.lobbies.get(this.lobbyKey(userId)) ?? null; }

  private memberBusy(userId: string): string | null {
    const s = this.sessions.get(userId);
    if (s?.inst?.kind === 'activity') return 'in an activity';
    return null;
  }

  private async openLobby(s: Session, activity: string) {
    const def = ACTIVITY_BY_ID[activity];
    if (!def) return;
    if (s.inst?.kind === 'activity') { this.error(s, 'busy', 'Finish or leave your current activity first.'); return; }
    const party = this.parties.of(s.userId);
    if (party && party.leader !== s.userId) { this.notify(s.userId, 'Only your party leader can start activities for the party.', 'info'); return; }
    const prof = await this.store.profile(s.userId);
    this.profiles.set(s.userId, prof);
    if (!isUnlocked(def, prof)) { this.notify(s.userId, `${def.name} is locked.`, 'bad'); return; }
    const key = this.lobbyKey(s.userId);
    const lobby = new Lobby(key, activity, s.userId);
    const cp = prof.checkpoints[def.id];
    if (cp && def.kind === 'mission') lobby.resumeStage = cp;
    for (const id of party ? party.members : [s.userId]) {
      const pr = await this.store.profile(id);
      lobby.setMember({ userId: id, name: party?.names[id] ?? s.name, ready: false, role: 'none', eligibility: eligibilityOf(def, pr), connected: this.sessions.has(id), busy: this.memberBusy(id) });
    }
    this.lobbies.set(key, lobby);
    this.broadcastLobby(lobby);
  }

  broadcastLobby(l: Lobby) {
    for (const m of l.members.values()) m.busy = this.memberBusy(m.userId);
    const view = l.view(this.profileOf(l.leader));
    for (const m of l.members.values()) this.send(m.userId, { t: 'lobby', view });
  }

  private lobbyReady(s: Session, ready: boolean) {
    const l = this.lobbyOf(s.userId);
    const m = l?.members.get(s.userId);
    if (!l || !m) return;
    m.ready = ready;
    this.broadcastLobby(l);
  }
  private lobbyConfig(s: Session, cfg: Extract<C2SMsg, { t: 'act.config' }>) {
    const l = this.lobbyOf(s.userId);
    if (!l) return;
    const e = l.configure(s.userId, cfg, this.profileOf(l.leader));
    if (e) this.notify(s.userId, e, 'bad');
    this.broadcastLobby(l);
  }
  private lobbyRole(s: Session, role: 'none' | 'driver' | 'hacker' | 'muscle' | 'lookout') {
    const l = this.lobbyOf(s.userId);
    if (!l) return;
    const e = l.setRole(s.userId, role);
    if (e) this.notify(s.userId, e, 'bad');
    this.broadcastLobby(l);
  }
  private lobbyCancel(s: Session) {
    const l = this.lobbyOf(s.userId);
    if (!l) return;
    if (l.leader === s.userId) {
      this.lobbies.delete(l.key);
      for (const m of l.members.values()) this.send(m.userId, { t: 'lobby', view: null });
    } else {
      const m = l.members.get(s.userId);
      if (m) m.ready = false;
      this.broadcastLobby(l);
    }
  }

  private async launch(s: Session) {
    const l = this.lobbyOf(s.userId);
    if (!l) return;
    if (l.leader !== s.userId) { this.notify(s.userId, 'Only the leader can launch.', 'bad'); return; }
    const prof = await this.store.profile(s.userId);
    this.profiles.set(s.userId, prof);
    for (const m of l.members.values()) { m.connected = this.sessions.has(m.userId); m.busy = this.memberBusy(m.userId); }
    const blockers = l.blockers(prof);
    if (blockers.length) { this.notify(s.userId, blockers[0], 'bad'); this.broadcastLobby(l); return; }
    const def = l.def;
    // the activity keeps the sky of the world the leader launched from (not its own schedule)
    const leaderInst = this.sessions.get(l.leader)?.inst;
    const inst = new Instance(this, newId(), 'activity', def.name, 4, leaderInst?.weather ?? null);
    this.instances.set(inst.id, inst);
    const roster: RosterEntry[] = [];
    for (const m of l.members.values()) {
      const ms = this.sessions.get(m.userId)!;
      const cur = ms.inst;
      const p = cur?.players.get(m.userId);
      let returnTo = { instance: cur?.kind === 'world' ? cur.id : null, pos: p ? { x: p.phys.x, y: p.phys.y, z: p.phys.z } : { ...PLAZA_SPAWN } };
      if (cur?.kind === 'interior') { const r = this.interiorReturn.get(m.userId); if (r) returnTo = r; }
      roster.push({ userId: m.userId, name: m.name, role: m.role, eligibility: m.eligibility, connected: true, left: false, disconnectedAt: 0, returnTo });
      this.placeIn(ms, inst, { x: def.start[0], y: def.start[1], z: def.start[2] }, def.startYaw);
    }
    // terms lock here: approach, difficulty, equipment, roles, cuts and the leader's setups/choices
    const preps = prof.preps[def.id] ?? [];
    const run = new ActivityRun(this, inst, def.id, l.leader, roster, {
      approach: l.approach, equipment: [...l.equipment], split: { ...l.split }, resumeStage: l.resumeStage,
      difficulty: l.difficulty, choices: def.heist ? l.choicesOf(prof) : undefined, setups: def.heist ? setupsDone(preps) : undefined, choice: l.choice || undefined,
    });
    inst.run = run;
    this.lobbies.delete(l.key);
    for (const m of l.members.values()) this.send(m.userId, { t: 'lobby', view: null });
    await run.start();
    for (const r of roster) this.pushPresence(r.userId);
  }

  // ───────────────────────────────────────────────────────── chat & pings
  private chat(s: Session, ch: 'party' | 'world' | 'activity', text: string) {
    if (!s.chatLimiter.take(s.userId)) { this.notify(s.userId, 'You\'re sending messages too fast.', 'bad'); return; }
    const clean = text.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
    if (!clean) return;
    let to: string[] = [];
    if (ch === 'party') {
      const p = this.parties.addChat(s.userId, clean);
      if (!p) { this.notify(s.userId, 'You are not in a party.', 'info'); return; }
      to = p.members;
    } else if (ch === 'world') to = s.inst ? [...s.inst.players.keys()] : [];
    else if (ch === 'activity') to = s.inst?.run ? s.inst.run.participants().map((r) => r.userId) : [];
    for (const id of to) {
      const rs = this.sessions.get(id);
      if (!rs || rs.blocked.has(s.userId)) continue;
      this.send(id, { t: 'chat', ch, from: s.name, text: clean, at: Date.now() });
    }
  }

  private pingMark(s: Session, p: PlayerEnt | undefined, m: Extract<C2SMsg, { t: 'ping.mark' }>) {
    if (!p || !s.inst || !s.chatLimiter.take(`${s.userId}:ping`)) return;
    if (Math.hypot(m.x - p.phys.x, m.z - p.phys.z) > 250) return;
    const party = this.parties.of(s.userId);
    const crew = s.inst.run ? new Set(s.inst.run.participants().map((r) => r.userId)) : new Set(party?.members ?? [s.userId]);
    for (const o of s.inst.players.values()) if (crew.has(o.userId)) this.send(o.userId, { t: 'ping.mark', from: s.name, x: m.x, y: m.y, z: m.z, kind: m.kind });
  }

  // ───────────────────────────────────────────────────────── social glue
  presenceOf(userId: string): { status: 'offline' | 'online' | 'in_world' | 'in_activity' | 'in_interior'; where?: string; instance?: string } {
    const s = this.sessions.get(userId);
    if (!s) return { status: 'offline' };
    if (!s.inst) return { status: 'online', where: 'Menus' };
    if (s.inst.kind === 'activity') return { status: 'in_activity', where: s.inst.label, instance: s.inst.id };
    if (s.inst.kind === 'interior') return { status: 'in_interior', where: 'At home', instance: s.inst.id };
    return { status: 'in_world', where: s.inst.label, instance: s.inst.id };
  }

  partyView(p: Party | null) {
    if (!p) return null;
    return {
      id: p.id, leader: p.leader,
      members: p.members.map((id) => { const pr = this.presenceOf(id); return { id, name: p.names[id], online: pr.status !== 'offline', status: pr.status, where: pr.where, leader: id === p.leader }; }),
      invites: Object.entries(p.invites).filter(([, i]) => i.expires > Date.now()).map(([id, i]) => ({ id, name: this.sessions.get(id)?.name ?? 'Player', expires: i.expires })),
      link: p.link, chat: p.chat.slice(-40),
    };
  }

  private onPartyChange(p: Party | null, affected: string[]) {
    const view = this.partyView(p);
    for (const id of affected) {
      const inParty = p?.members.includes(id);
      if (inParty) this.send(id, { t: 'social', event: 'party', data: view });
      else if (p && p.invites[id]) this.send(id, { t: 'social', event: 'party_invite', data: { partyId: p.id, fromName: p.names[p.invites[id].by], expires: p.invites[id].expires, size: p.members.length } });
      else this.send(id, { t: 'social', event: 'party', data: this.partyView(this.parties.of(id)) });
      // party membership changes partyId on player entities (team colours / visibility)
      const ent = this.playerEnt(id);
      if (ent) ent.partyId = this.parties.of(id)?.id ?? null;
    }
    // personal vehicles follow party access
    for (const inst of this.instances.values()) for (const v of inst.vehicles.values()) if (v.owner && affected.includes(v.owner.userId)) v.allowed = this.vehicleAllowed(v.owner.userId);
    // lobby membership follows the party
    if (p) {
      const l = this.lobbies.get(`party:${p.id}`);
      if (l) {
        for (const id of [...l.members.keys()]) if (!p.members.includes(id)) l.removeMember(id);
        if (l.leader !== p.leader) { this.lobbies.delete(l.key); for (const id of p.members) this.send(id, { t: 'lobby', view: null }); }
        else {
          for (const id of p.members) if (!l.members.has(id)) {
            void this.store.profile(id).then((pr) => { l.setMember({ userId: id, name: p.names[id], ready: false, role: 'none', eligibility: eligibilityOf(l.def, pr), connected: this.sessions.has(id), busy: this.memberBusy(id) }); this.broadcastLobby(l); });
          }
          this.broadcastLobby(l);
        }
      }
    }
    for (const id of affected) { const solo = this.lobbies.get(`solo:${id}`); if (solo && this.parties.of(id)) { this.lobbies.delete(`solo:${id}`); this.send(id, { t: 'lobby', view: null }); } }
  }

  pushPresence(userId: string) {
    void this.store.friendIds(userId).then((ids) => { for (const f of ids) this.send(f, { t: 'social', event: 'friends' }); });
    const p = this.parties.of(userId);
    if (p) { const view = this.partyView(p); for (const m of p.members) if (m !== userId) this.send(m, { t: 'social', event: 'party', data: view }); }
  }

  partyError(e: PartyError) { return PARTY_ERRORS[e]; }

  // ───────────────────────────────────────────────────────── dev tools (never in production)
  private async dev(s: Session, p: PlayerEnt | undefined, m: Extract<C2SMsg, { t: 'dev' }>) {
    if (!config.devCommands) { this.notify(s.userId, 'Dev commands are disabled.', 'bad'); return; }
    const inst = s.inst;
    const n = (i: number) => Number(m.args[i]);
    switch (m.cmd) {
      case 'tp': if (p && inst) inst.teleport(p, n(0), n(1), n(2)); break;
      case 'cash': await this.store.adjustCash(s.userId, n(0), 'dev'); await this.refreshProfile(s.userId); break;
      case 'wanted': if (p && inst) inst.addWanted(p, n(0), 'dev'); break;
      case 'heal': if (p) p.hp = p.maxHp; break;
      case 'weather': if (inst) { const a = m.args[0]; inst.weather.force(a === undefined || a === 'auto' ? null : typeof a === 'string' && /^[0-9]+$/.test(a) ? Number(a) : a, Date.now(), m.args[1] !== undefined ? Number(m.args[1]) : 100); } break;
      case 'kill': if (p && inst) inst.damagePlayer(p, 999, 'dev'); break;
      case 'spawn_vehicle': if (p && inst) inst.spawnVehicle(String(m.args[0]) as VehicleModel, p.phys.x + 4, p.phys.y, p.phys.z, p.yaw); break;
      case 'stun_npcs': if (inst) for (const n of inst.npcs.values()) if (n.role === 'guard' || n.role === 'cop') { n.stunnedUntil = Date.now() + 60_000; n.alert = 0; } break;
      case 'complete_stage': {
        const run = inst?.run;
        if (!run) return;
        for (const o of inst!.objects.values()) if (o.state === 0) { o.state = 1; o.doneBy = s.userId; o.doneAt = Date.now(); }
        run.devCompleteStage();
        break;
      }
    }
  }
}

void INTERACT_RANGE; void CUTSCENES;

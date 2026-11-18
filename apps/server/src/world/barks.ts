/**
 * Street barks: decides WHEN an NPC (or traffic car) says a line and tells nearby players.
 *
 * Cheap by design: the proximity scan runs at ~5 Hz and only looks at NPCs within HEAR metres of some player (far NPCs
 * cost one distance check per scan, nothing more). Everything is rate limited:
 *   - per NPC / vehicle cooldown per situation,
 *   - per player: at most one bubble every GAP_EVENT ms for reactions (GAP_AMBIENT for idle chatter),
 *   - per player: never one of the last RECENT line ids again,
 *   - lines are only sent to players within HEAR metres of the speaker.
 * Lines live in packages/shared/src/content/barks.ts (id → text, role group, situation).
 */
import { pickBark, barkText, barkRoleGroup, barkHasPool, type BarkGroup, type BarkSituation } from '@blockshore/shared';
import { nav } from './nav.ts';
import type { Instance } from './instance.ts';
import type { NpcEnt, PlayerEnt, VehicleEnt } from './entities.ts';

const HEAR = 30, HEAR2 = HEAR * HEAR;
const GAP_EVENT = 1500, GAP_AMBIENT = 3200, RECENT = 8;
const SCAN_MS = 200;

interface PState { lastAt: number; recent: string[] }
const PS = new WeakMap<PlayerEnt, PState>();
const pstate = (p: PlayerEnt): PState => { let s = PS.get(p); if (!s) { s = { lastAt: 0, recent: [] }; PS.set(p, s); } return s; };

interface SState { nextIdle: number; cool: Map<string, number> }
const SS = new WeakMap<object, SState>();
function sstate(o: object, now: number, idleLo: number, idleHi: number): SState {
  let s = SS.get(o);
  if (!s) { s = { nextIdle: now + 1500 + Math.random() * (idleHi - idleLo) * 0.5, cool: new Map() }; SS.set(o, s); }
  return s;
}
/** true (and arm the cooldown) when `key` is off cooldown for this speaker */
function ready(s: SState, key: string, now: number, cd: number): boolean {
  if ((s.cool.get(key) ?? 0) > now) return false;
  s.cool.set(key, now + cd);
  return true;
}
const rnd = (a: number, b: number) => a + Math.random() * (b - a);

interface Pending { tries?: number; at: number; speaker: NpcEnt | VehicleEnt; kind: 'n' | 'v'; group: BarkGroup; sit: BarkSituation; prio: boolean }
const QUEUE = new WeakMap<Instance, Pending[]>();
const SCAN = new WeakMap<Instance, number>();
const EVENT_AT = new WeakMap<Instance, Map<string, number>>();

const d2 = (ax: number, az: number, bx: number, bz: number) => (ax - bx) ** 2 + (az - bz) ** 2;
const isCivilian = (g: BarkGroup) => g !== 'cop' && g !== 'guard' && g !== 'shop' && g !== 'contact' && g !== 'driver';
const speaks = (n: NpcEnt, now: number) => n.downUntil <= now && n.stunnedUntil <= now;
function groupOf(n: NpcEnt): BarkGroup | null { return barkRoleGroup(n.role, n.label); }

/** say a line now; returns 'sent', 'gated' (every listener is inside the rate-limit window: try again soon) or 'none' */
function say(inst: Instance, speaker: NpcEnt | VehicleEnt, kind: 'n' | 'v', group: BarkGroup, sit: BarkSituation, prio: boolean): 'sent' | 'gated' | 'none' {
  if (!barkHasPool(group, sit)) return 'none';
  const now = inst.now;
  const sx = kind === 'n' ? (speaker as NpcEnt).x : (speaker as VehicleEnt).phys.x;
  const sz = kind === 'n' ? (speaker as NpcEnt).z : (speaker as VehicleEnt).phys.z;
  const gap = prio ? GAP_EVENT : GAP_AMBIENT;
  let to: PlayerEnt[] | null = null, heard = false;
  for (const p of inst.players.values()) {
    if (p.linkdeadAt || d2(p.phys.x, p.phys.z, sx, sz) > HEAR2) continue;
    heard = true;
    if (now - pstate(p).lastAt < gap) continue;
    (to ??= []).push(p);
  }
  if (!to) return heard ? 'gated' : 'none';
  const avoid = new Set<string>();
  for (const p of to) for (const id of pstate(p).recent) avoid.add(id);
  const line = pickBark(group, sit, avoid);
  const text = line ? barkText(line) : null;
  if (!line || !text) return 'none';
  for (const p of to) {
    const s = pstate(p);
    s.lastAt = now; s.recent.push(line); if (s.recent.length > RECENT) s.recent.shift();
    inst.game.send(p.userId, { t: 'bark', id: speaker.id, line, text });
  }
  return 'sent';
}

function later(inst: Instance, speaker: NpcEnt | VehicleEnt, kind: 'n' | 'v', group: BarkGroup, sit: BarkSituation, delay: number, prio = true) {
  let q = QUEUE.get(inst);
  if (!q) { q = []; QUEUE.set(inst, q); }
  if (q.length < 24) q.push({ at: inst.now + delay, speaker, kind, group, sit, prio });
}

function drain(inst: Instance) {
  const q = QUEUE.get(inst);
  if (!q?.length) return;
  const now = inst.now;
  for (let i = q.length - 1; i >= 0; i--) {
    const e = q[i];
    if (e.at > now) continue;
    q.splice(i, 1);
    if (now - e.at > 4000) continue; // stale
    const alive = e.kind === 'n' ? inst.npcs.get(e.speaker.id) === e.speaker : inst.vehicles.get(e.speaker.id) === e.speaker;
    if (!alive) continue;
    // a reaction that lands inside the rate-limit window waits for the next free slot (at most twice)
    if (say(inst, e.speaker, e.kind, e.group, e.sit, e.prio) === 'gated' && e.prio && (e.tries ?? 0) < 2) q.push({ ...e, at: now + 600, tries: (e.tries ?? 0) + 1 });
  }
}

// ───────────────────────────────────────────────────────────── events (called from the existing systems)
export type BarkEvent = 'gunfire' | 'crash' | 'hit' | 'assault' | 'carjack' | 'wanted' | 'honk' | 'shopGreet' | 'shopThanks';

/** event throttle per instance (an SMG would otherwise trigger this 11×/s) */
function eventOk(inst: Instance, key: string, ms: number) {
  let m = EVENT_AT.get(inst);
  if (!m) { m = new Map(); EVENT_AT.set(inst, m); }
  if ((m.get(key) ?? 0) > inst.now) return false;
  m.set(key, inst.now + ms);
  return true;
}

/** speakers within r of (x,z) that are also within HEAR of a player, nearest first, optionally filtered */
function witnesses(inst: Instance, x: number, z: number, r: number, want: (n: NpcEnt, g: BarkGroup) => boolean): { n: NpcEnt; g: BarkGroup; d: number }[] {
  const out: { n: NpcEnt; g: BarkGroup; d: number }[] = [];
  const now = inst.now, r2 = r * r;
  const near: PlayerEnt[] = [];
  for (const p of inst.players.values()) if (!p.linkdeadAt && d2(p.phys.x, p.phys.z, x, z) < (HEAR + r) ** 2) near.push(p);
  if (!near.length) return out;
  for (const n of inst.npcs.values()) {
    const dd = d2(n.x, n.z, x, z);
    if (dd > r2 || !speaks(n, now)) continue;
    const g = groupOf(n);
    if (!g || !want(n, g)) continue;
    if (!near.some((p) => d2(p.phys.x, p.phys.z, n.x, n.z) < HEAR2)) continue;
    out.push({ n, g, d: dd });
  }
  out.sort((a, b) => a.d - b.d);
  return out;
}
function carsNear(inst: Instance, x: number, z: number, r: number, pred: (v: VehicleEnt) => boolean) {
  const out: VehicleEnt[] = [];
  for (const v of inst.vehicles.values()) if (v.destroyedAt === 0 && d2(v.phys.x, v.phys.z, x, z) < r * r && pred(v)) out.push(v);
  return out;
}

export function barkEvent(inst: Instance, ev: BarkEvent, x: number, z: number, who?: { npc?: NpcEnt; vehicle?: VehicleEnt; player?: PlayerEnt; reason?: string; vehicles?: VehicleEnt[] }) {
  if (inst.kind === 'interior') return;
  const now = inst.now;
  switch (ev) {
    case 'gunfire': {
      if (!eventOk(inst, 'gunfire', 1100)) return;
      let k = 0;
      for (const w of witnesses(inst, x, z, 28, () => true)) {
        if (k >= 3) break;
        const s = sstate(w.n, now, 10000, 25000);
        if (!ready(s, 'gunfire', now, 6000)) continue;
        // officers answer with orders, everyone else panics; a shooter's own side (stun gun) never reaches here
        later(inst, w.n, 'n', w.g, 'gunfire', 150 + k * 260 + Math.random() * 250); k++;
      }
      for (const v of carsNear(inst, x, z, 26, (c) => c.ai?.kind === 'traffic' && !c.occ[0])) {
        if (k >= 4) break;
        if (!ready(sstate(v, now, 10000, 25000), 'gunfire', now, 8000) || Math.random() < 0.5) continue;
        later(inst, v, 'v', 'driver', 'gunfire', 300 + Math.random() * 500); k++;
      }
      return;
    }
    case 'crash': {
      if (!eventOk(inst, 'crash', 1500)) return;
      let k = 0;
      for (const v of who?.vehicles ?? []) if (v.ai?.kind === 'traffic' && ready(sstate(v, now, 9000, 20000), 'crash', now, 6000)) { later(inst, v, 'v', 'driver', 'crash', 250 + k * 400); k++; }
      for (const w of witnesses(inst, x, z, 24, (_n, g) => isCivilian(g) || g === 'shop')) {
        if (k >= 3) break;
        if (!ready(sstate(w.n, now, 10000, 25000), 'crash', now, 8000)) continue;
        later(inst, w.n, 'n', w.g, 'crash', 500 + k * 350 + Math.random() * 300); k++;
      }
      return;
    }
    case 'hit': { // a pedestrian was run over (non-graphic): the victim yelps, one onlooker comments
      const n = who?.npc;
      if (n) { const g = groupOf(n); if (g && isCivilian(g) && ready(sstate(n, now, 8000, 20000), 'hit', now, 5000)) later(inst, n, 'n', g, 'hit', 180); }
      let k = 0;
      for (const w of witnesses(inst, x, z, 20, (m, g) => m !== n && isCivilian(g))) {
        if (k >= 2) break;
        if (!ready(sstate(w.n, now, 10000, 25000), 'crash', now, 8000)) continue;
        later(inst, w.n, 'n', w.g, 'crash', 600 + k * 500); k++;
      }
      return;
    }
    case 'assault': { // shot / stunned / hit on foot
      const n = who?.npc;
      if (n) { const g = groupOf(n); if (g && isCivilian(g) && ready(sstate(n, now, 8000, 20000), 'hit', now, 4000)) later(inst, n, 'n', g, 'hit', 120); }
      return;
    }
    case 'carjack': {
      const v = who?.vehicle;
      if (v && ready(sstate(v, now, 9000, 20000), 'carjack', now, 8000)) later(inst, v, 'v', 'driver', 'carjack', 250);
      return;
    }
    case 'wanted': { // wanted level raised: the nearest officer or patrol car reports it
      if (!eventOk(inst, 'wanted', 4000)) return;
      const w = witnesses(inst, x, z, 40, (_n, g) => g === 'cop')[0];
      if (w && ready(sstate(w.n, now, 10000, 25000), 'wanted', now, 7000)) { later(inst, w.n, 'n', 'cop', 'wanted', 350); return; }
      const c = carsNear(inst, x, z, 45, (v) => v.ai?.kind === 'police')[0];
      if (c && ready(sstate(c, now, 10000, 25000), 'wanted', now, 7000)) later(inst, c, 'v', 'cop', 'wanted', 350);
      return;
    }
    case 'honk': {
      const v = who?.vehicle;
      if (!v || v.ai?.kind !== 'traffic' || Math.random() > 0.6) return;
      const sit: BarkSituation = who?.reason === 'ped' ? 'honk_ped' : who?.reason === 'player' ? 'honk' : 'jam';
      if (!ready(sstate(v, now, 9000, 20000), 'honk', now, 9000)) return;
      later(inst, v, 'v', 'driver', sit, 120 + Math.random() * 300);
      return;
    }
    case 'shopGreet': case 'shopThanks': { // interacting with / buying from a counter NPC (static)
      let best: NpcEnt | null = null, bd = 8 * 8;
      for (const n of inst.npcs.values()) { if (n.role !== 'static') continue; const dd = d2(n.x, n.z, x, z); if (dd < bd) { bd = dd; best = n; } }
      if (!best) return;
      const g = groupOf(best);
      if (!g) return;
      const sit: BarkSituation = ev === 'shopThanks' ? 'thanks' : 'greet';
      if (!barkHasPool(g, sit)) return;
      if (ev === 'shopGreet' && !ready(sstate(best, now, 20000, 40000), 'greet', now, 6000)) return;
      later(inst, best, 'n', g, sit, ev === 'shopThanks' ? 200 : 150);
      return;
    }
  }
}

// ───────────────────────────────────────────────────────────── proximity + idle scan
export function barkTick(inst: Instance): void {
  if (inst.kind === 'interior') return;
  drain(inst);
  const now = inst.now;
  if (now - (SCAN.get(inst) ?? 0) < SCAN_MS) return;
  SCAN.set(inst, now);
  const players: PlayerEnt[] = [];
  for (const p of inst.players.values()) if (!p.linkdeadAt && !p.downUntil && !p.frozen) players.push(p);
  if (!players.length) return;

  let rain = false;
  try { const w = inst.weather.message(now); rain = w.s[0] >= 3 && now >= w.at + w.d * 0.5; } catch { /* no weather */ }
  const sirens: { x: number; z: number }[] = [];
  const wantedIds = new Set<string>();
  for (const p of players) if (inst.wantedOf(p)) wantedIds.add(p.id);
  for (const v of inst.vehicles.values()) if (v.siren && v.destroyedAt === 0) sirens.push({ x: v.phys.x, z: v.phys.z });

  let budget = 3; // a few speakers per scan is plenty (the per-player gap lets ~1 through anyway)
  const order = Math.random() < 0.5; // vary who gets the budget
  const consider = (n: NpcEnt) => {
    if (budget <= 0) return;
    // nearest player
    let p: PlayerEnt | null = null, pd = HEAR2;
    for (const q of players) { const dd = d2(q.phys.x, q.phys.z, n.x, n.z); if (dd < pd) { pd = dd; p = q; } }
    if (!p) return;
    const g = groupOf(n);
    if (!g || !speaks(n, now)) return;
    const stat = n.role === 'static';
    const s = sstate(n, now, stat ? 16000 : 8000, stat ? 36000 : 20000);
    const d = Math.sqrt(pd);
    const fleeing = (n.brain.fleeUntil ?? 0) > now;
    if (fleeing) return;
    const pv = p.veh ? inst.vehicles.get(p.veh) : undefined;
    const sp = pv ? Math.abs(pv.phys.speed) : Math.hypot(p.phys.vx, p.phys.vz);
    const civ = isCivilian(g);

    let sit: BarkSituation | null = null, prio = true;
    if (!pv && d < 1.1 && sp > 1.0 && ready(s, 'bump', now, 5000)) sit = 'bump';
    else if (pv && sp > 3 && d < 7 && civ && !nav.isRoad(pv.phys.x, pv.phys.z) && ready(s, 'sidewalk', now, 7000)) sit = 'sidewalk';
    else if (pv && sp > 8 && d < 3.5 && civ && ready(s, 'nearmiss', now, 7000)) sit = 'nearmiss';
    else if (!pv && sp > 6 && d < 4.5 && civ && ready(s, 'sprint', now, 9000)) sit = 'sprint';
    else if (g === 'cop' && wantedIds.has(p.id) && d < 26 && ready(s, 'chase', now, rnd(5000, 9000))) sit = 'chase';
    else if (g === 'guard' && n.alert >= 0.6 && ready(s, 'alert', now, 5000)) sit = 'alert';
    else if (!pv && p.weapon !== 'stun' && d < 12 && g !== 'contact' && ready(s, 'weapon', now, 18000)) sit = g === 'cop' ? 'warning' : 'weapon';
    else if (rain && civ && ready(s, 'rain', now, 30000) && Math.random() < 0.35) { sit = 'rain'; prio = false; }
    else if (civ && sirens.length && sirens.some((q) => d2(q.x, q.z, n.x, n.z) < 45 * 45) && ready(s, 'siren', now, 25000) && Math.random() < 0.5) sit = 'siren';
    else if (!pv && d < (stat ? 6 : 5) && ready(s, 'greet', now, stat ? 25000 : 45000) && (stat || Math.random() < 0.5) && barkHasPool(g, 'greet')) { sit = 'greet'; prio = false; }
    else if (now >= s.nextIdle && d < 26) {
      prio = false;
      sit = barkHasPool(g, 'phone') && n.anim !== 5 && Math.random() < 0.3 ? 'phone' : 'idle';
    }
    if (!sit) return;
    budget--;
    const ok = say(inst, n, 'n', g, sit, prio) === 'sent';
    if (sit === 'idle' || sit === 'phone') s.nextIdle = now + (ok ? (stat ? rnd(16000, 36000) : rnd(8000, 20000)) : 1500);
  };
  const list: NpcEnt[] = [];
  for (const n of inst.npcs.values()) list.push(n);
  if (order) for (let i = 0; i < list.length; i++) consider(list[i]); else for (let i = list.length - 1; i >= 0; i--) consider(list[i]);

  // patrol cars shouting over the loudspeaker during a chase, and traffic drivers cut off by player cars
  if (wantedIds.size || players.some((p) => p.veh)) {
    for (const v of inst.vehicles.values()) {
      if (budget <= 0 || v.destroyedAt !== 0) break;
      const cop = v.ai?.kind === 'police', traffic = v.ai?.kind === 'traffic';
      if (!cop && !traffic) continue;
      let p: PlayerEnt | null = null, pd = HEAR2;
      for (const q of players) { const dd = d2(q.phys.x, q.phys.z, v.phys.x, v.phys.z); if (dd < pd) { pd = dd; p = q; } }
      if (!p) continue;
      if (cop) {
        if (!wantedIds.has(p.id) || pd > 28 * 28) continue;
        const s = sstate(v, now, 10000, 25000);
        if (ready(s, 'chase_veh', now, rnd(6000, 10000))) { budget--; say(inst, v, 'v', 'cop', 'chase_veh', true); }
      } else if (p.veh && p.veh !== v.id) {
        const pv = inst.vehicles.get(p.veh);
        if (!pv || Math.abs(pv.phys.speed) < 7 || pd > 8 * 8 || Math.abs(v.phys.speed) > Math.abs(pv.phys.speed) * 0.5) continue;
        const s = sstate(v, now, 10000, 25000);
        if (ready(s, 'cutoff', now, 10000) && Math.random() < 0.5) { budget--; say(inst, v, 'v', 'driver', 'cutoff', true); }
      }
    }
  }
}

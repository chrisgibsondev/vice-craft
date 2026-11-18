/**
 * Play-through library: a "player" on top of tests/bot.ts that uses only real inputs (movement,
 * vehicle controls, interact, fire) and a voxel path planner, so activities can be played for real
 * on the real world map with a real server. `tp` is only used to skip long travel (and every use is
 * counted in `Player.tpCount`); everything an objective needs is done with real messages.
 * Used by scripts/playthrough.ts and the playthrough regression tests.
 */
import { Bot, sleep } from './bot.ts';
import {
  B, SOLID, raycastVoxels, ACTIVITY_BY_ID, VEHICLES, angleDiff, type ActivityView, type LobbyView, type S2CMsg, type StageDef, type ObjectiveDef, type ObjEnt as _O,
} from '../packages/shared/src/index.ts';
import { voxels } from '../apps/server/src/world/voxels.ts';
import { nav } from '../apps/server/src/world/nav.ts';
import type { Game } from '../apps/server/src/game.ts';
import type { PlayerEnt, VehicleEnt } from '../apps/server/src/world/entities.ts';
import type { Instance } from '../apps/server/src/world/instance.ts';
void (null as unknown as _O);

export const LOG: string[] = [];
export function note(kind: 'INFO' | 'WARN' | 'BUG' | 'OK', msg: string) {
  const line = `[${kind}] ${msg}`;
  LOG.push(line);
  console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
}

// ───────────────────────────────────────────────────────── voxel path planner (walking)
const sol = (x: number, y: number, z: number) => SOLID[voxels.getBlock(x, y, z)] === 1;
const wat = (x: number, y: number, z: number) => voxels.getBlock(x, y, z) === B.WATER;
/** a cell a player can stand in: solid floor below, two free cells, no water */
export function cellOk(x: number, y: number, z: number) {
  return y > 1 && sol(x, y - 1, z) && !sol(x, y, z) && !sol(x, y + 1, z) && !wat(x, y, z) && !wat(x, y - 1, z);
}
/** nearest standable y in a column around hint */
export function standY(x: number, z: number, hint: number): number | null {
  for (const dy of [0, 1, -1, 2, -2, 3, -3, 4, -4]) if (cellOk(Math.floor(x), Math.floor(hint) + dy, Math.floor(z))) return Math.floor(hint) + dy;
  return null;
}
interface Cell { x: number; y: number; z: number }
const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
export function neighboursExport(c: Cell) { return neighbours(c); }
function neighbours(c: Cell): Cell[] {
  const out: Cell[] = [];
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    if (!dx && !dz) continue;
    const nx = c.x + dx, nz = c.z + dz;
    let ny: number | null = null;
    for (const dy of [1, 0, -1, -2]) {
      if (!cellOk(nx, c.y + dy, nz)) continue;
      if (dy === 1 && sol(c.x, c.y + 2, c.z)) continue; // no headroom to hop up
      if (dy < 0 && (sol(nx, c.y + 1, nz) || sol(nx, c.y, nz))) continue;
      ny = c.y + dy; break;
    }
    if (ny === null) continue;
    if (dx && dz) { // no corner cutting
      const a = standY(c.x + dx, c.z, c.y), b = standY(c.x, c.z + dz, c.y);
      if (a === null || b === null || Math.abs(a - c.y) > 1 || Math.abs(b - c.y) > 1) continue;
    }
    out.push({ x: nx, y: ny, z: nz });
  }
  return out;
}
/** A* between two block cells; goal reached when within `tol` cells (horizontal) */
export function planWalk(from: Cell, to: Cell, tol = 0, maxNodes = 60000): Cell[] | null {
  const h = (c: Cell) => Math.hypot(c.x - to.x, c.z - to.z);
  const open = new Map<string, { c: Cell; g: number; f: number; prev: string | null }>();
  const closed = new Map<string, { c: Cell; prev: string | null }>();
  open.set(key(from.x, from.y, from.z), { c: from, g: 0, f: h(from), prev: null });
  let n = 0;
  while (open.size && n++ < maxNodes) {
    let bk = '', best = Infinity;
    for (const [k, v] of open) if (v.f < best) { best = v.f; bk = k; }
    const cur = open.get(bk)!; open.delete(bk);
    closed.set(bk, { c: cur.c, prev: cur.prev });
    if (h(cur.c) <= tol && Math.abs(cur.c.y - to.y) <= 3) {
      const path: Cell[] = [];
      let k: string | null = bk;
      while (k) { const e = closed.get(k)!; path.push(e.c); k = e.prev; }
      return path.reverse();
    }
    for (const nb of neighbours(cur.c)) {
      const nk = key(nb.x, nb.y, nb.z);
      if (closed.has(nk)) continue;
      const g = cur.g + (nb.x !== cur.c.x && nb.z !== cur.c.z ? 1.42 : 1) + Math.abs(nb.y - cur.c.y) * 0.3;
      const ex = open.get(nk);
      if (!ex || g < ex.g) open.set(nk, { c: nb, g, f: g + h(nb), prev: bk });
    }
  }
  return null;
}
/** BFS from a cell outward; returns the reachable cell nearest to distance `d` (walking metres) */
export function reachableAround(centre: Cell, d: number, maxNodes = 30000): { cell: Cell; dist: number } | null {
  const seen = new Map<string, number>([[key(centre.x, centre.y, centre.z), 0]]);
  const q: Cell[] = [centre];
  let best: { cell: Cell; dist: number } | null = null;
  for (let i = 0; i < q.length && i < maxNodes; i++) {
    const c = q[i]; const dc = seen.get(key(c.x, c.y, c.z))!;
    if (!best || Math.abs(dc - d) < Math.abs(best.dist - d)) best = { cell: c, dist: dc };
    if (dc >= d) continue;
    for (const nb of neighbours(c)) {
      const k = key(nb.x, nb.y, nb.z);
      if (seen.has(k)) continue;
      // we want cells from which one can WALK to the centre: the move nb → c must be legal too (drops are one-way)
      if (!neighbours(nb).some((m) => m.x === c.x && m.y === c.y && m.z === c.z)) continue;
      seen.set(k, dc + 1); q.push(nb);
    }
  }
  return best;
}

// ───────────────────────────────────────────────────────── player
export interface Inputs { mx: number; mz: number; yaw: number; pitch: number; jump: boolean; sprint: boolean; th: number; st: number; hb: boolean }
const NEUTRAL: Inputs = { mx: 0, mz: 0, yaw: 0, pitch: 0, jump: false, sprint: false, th: 0, st: 0, hb: false };

export class Player {
  inp: Inputs = { ...NEUTRAL };
  timer: ReturnType<typeof setInterval> | null = null;
  tpCount = 0;
  act: ActivityView | null = null;
  lobby: LobbyView | null = null;
  inWorld: { kind: string; instance: string; label: string } | null = null;
  notifies: { text: string; kind: string; at: number }[] = [];
  results: { data: unknown }[] = [];
  trail: string[] = [];
  /** bumped when the stage changes: older movement loops see it and stop fighting over the inputs */
  abortGen = 0;
  autoCs: 'load' | 'skip' | 'watch' = 'skip';
  csSeen: string[] = [];
  csAnswered = '';
  deaths = 0;
  constructor(readonly bot: Bot, readonly game: Game) {}
  get name() { return this.bot.name; }
  get uid() { return this.bot.userId; }
  get me() { return this.bot.snap!.me; }
  get sess() { return this.game.sessions.get(this.uid); }
  get inst(): Instance | null { return this.sess?.inst ?? null; }
  get ent(): PlayerEnt | undefined { return this.inst?.players.get(this.uid); }

  static async create(game: Game, base: string, name: string): Promise<Player> {
    const b = await new Bot(base, name).register();
    await b.connect();
    const p = new Player(b, game);
    p.hook();
    return p;
  }
  hook() {
    const ws = this.bot.ws!;
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as S2CMsg;
      switch (m.t) {
        case 'act': this.act = m.view; break;
        case 'lobby': this.lobby = m.view; break;
        case 'world': this.inWorld = { kind: m.kind, instance: m.instance, label: m.label }; break;
        case 'notify': this.notifies.push({ text: m.text, kind: m.kind, at: Date.now() }); break;
        case 'results': this.results.push({ data: m.data }); break;
        case 'cs.waiting': if (this.csAnswered !== m.cs) { this.csAnswered = m.cs; this.csSeen.push(m.cs); this.bot.send({ t: 'cs.loaded', cs: m.cs }); } break;
        case 'cs.end': this.csAnswered = ''; break;
        case 'cs.start': if (this.autoCs === 'skip') setTimeout(() => { try { this.bot.send({ t: 'cs.skip' }); } catch { /* closed */ } }, 400); break;
      }
    });
  }
  /** drop the socket and come back with the same session (reconnect grace) */
  async reconnect(downMs = 3000) {
    this.stop(); this.bot.close();
    await sleep(downMs);
    await this.bot.connect();
    this.hook(); this.start();
    const t0 = Date.now();
    while (!this.bot.snap && Date.now() - t0 < 6000) await sleep(50);
  }
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.bot.ws?.readyState !== 1) return;
      this.bot.send({ t: 'input', seq: this.bot.seq++, ...this.inp });
      if (this.bot.snap && (this.bot.seq % 4) === 0) { const m = this.bot.snap.me; this.trail.push(`${m.x.toFixed(1)},${m.y.toFixed(1)},${m.z.toFixed(1)}${m.veh ? ' v' + m.veh + '/' + m.seat : ''}${m.og ? '' : ' air'}`); if (this.trail.length > 40) this.trail.shift(); }
    }, 50);
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }
  idle() { this.inp = { ...NEUTRAL, yaw: this.inp.yaw, hb: !!this.ent?.veh }; }
  dev(cmd: Parameters<Bot['dev']>[0], ...a: (string | number)[]) { if (cmd === 'tp') this.tpCount++; this.bot.dev(cmd, ...a); }
  async tp(x: number, y: number, z: number) {
    this.dev('tp', x, y, z);
    const t0 = Date.now();
    while (Date.now() - t0 < 3000) { await sleep(40); if (Math.hypot(this.me.x - x, this.me.z - z) < 3) return; }
    note('WARN', `${this.name}: tp to ${x | 0},${y | 0},${z | 0} not applied (at ${this.me.x | 0},${this.me.y | 0},${this.me.z | 0})`);
  }
  hasNotify(re: RegExp, since = 0) { return this.notifies.some((n) => n.at >= since && re.test(n.text)); }
  async waitNotify(re: RegExp, ms = 5000, since = Date.now() - 200) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (this.hasNotify(re, since)) return true; await sleep(40); }
    return false;
  }
  pos() { const m = this.me; return m.vp && m.veh ? { x: m.vp.x, y: m.vp.y, z: m.vp.z } : { x: m.x, y: m.y, z: m.z }; }
  inVehicle() { return !!this.me.veh; }
  vehEnt(): VehicleEnt | undefined { const id = this.me.veh; return id ? this.inst?.vehicles.get(id) : undefined; }

  // ── walking
  /** walk with real inputs to (x,z). Returns true on arrival. Opens doors in the way. */
  async walkTo(tx: number, tz: number, o: { tol?: number; maxSec?: number; ty?: number } = {}): Promise<boolean> {
    const tol = o.tol ?? 1.2;
    const t0 = Date.now(), maxMs = (o.maxSec ?? 120) * 1000;
    let replans = 0;
    let path: Cell[] | null = null, pi = 0;
    const plan = () => {
      const me = this.me;
      const from = { x: Math.floor(me.x), y: standY(me.x, me.z, me.y) ?? Math.floor(me.y), z: Math.floor(me.z) };
      const ty = o.ty ?? standY(tx, tz, me.y) ?? from.y;
      path = planWalk(from, { x: Math.floor(tx), y: ty, z: Math.floor(tz) }, Math.max(0, tol - 0.6));
      pi = 0;
      return !!path;
    };
    if (!plan()) { this.idle(); note('WARN', `${this.name}: no walkable path from ${this.me.x.toFixed(1)},${this.me.y.toFixed(1)},${this.me.z.toFixed(1)} to ${tx.toFixed(1)},${tz.toFixed(1)}`); return false; }
    let lastProg = { x: this.me.x, z: this.me.z, at: Date.now() };
    const gen = this.abortGen;
    while (Date.now() - t0 < maxMs) {
      if (gen !== this.abortGen) return false;
      if (this.me.veh) { this.idle(); return false; }
      const me = this.me;
      if (Math.hypot(me.x - tx, me.z - tz) <= tol && Math.abs(me.y - (o.ty ?? me.y)) < 3) { this.idle(); return true; }
      if (me.down) { this.idle(); return false; }
      // advance along the path
      while (pi < path!.length - 1 && Math.hypot(me.x - (path![pi].x + 0.5), me.z - (path![pi].z + 0.5)) < 0.7) pi++;
      const tgt = path![Math.min(pi + 1, path!.length - 1)];
      const wx = tgt.x + 0.5, wz = tgt.z + 0.5;
      const dx = wx - me.x, dz = wz - me.z;
      const last = pi >= path!.length - 1;
      this.inp = { ...NEUTRAL, mz: 1, yaw: Math.atan2(-dx, -dz), sprint: !last, jump: tgt.y > me.y + 0.9 && me.og };
      if (Math.hypot(me.x - lastProg.x, me.z - lastProg.z) > 0.5) lastProg = { x: me.x, z: me.z, at: Date.now() };
      else if (Date.now() - lastProg.at > 1500) {
        // stuck: try a door, a jump, then replan; give up after a few rounds
        const door = [...(this.bot.ents.values())].find((e) => e.k === 'd' && !(e as { open: boolean }).open && Math.hypot(e.x - me.x, e.z - me.z) < 4) as { id: string; label?: string } | undefined;
        if (door) { this.bot.send({ t: 'interact', target: door.id }); note('INFO', `${this.name}: opening door ${door.label ?? door.id}`); await sleep(500); }
        else if (replans % 2 === 0) { this.inp.jump = true; await sleep(150); }
        if (++replans > 5 || !plan()) { this.idle(); note('WARN', `${this.name}: walk stuck at ${me.x.toFixed(1)},${me.y.toFixed(1)},${me.z.toFixed(1)} -> ${tx | 0},${tz | 0}`); return false; }
        lastProg = { x: me.x, z: me.z, at: Date.now() };
      }
      await sleep(50);
    }
    this.idle();
    return false;
  }

  /** go to a spot: walk when close, otherwise tp to a reachable spot ~`near` metres away and walk the rest */
  async goTo(tx: number, tz: number, o: { tol?: number; near?: number; ty?: number; maxSec?: number } = {}): Promise<boolean> {
    const near = o.near ?? 70;
    const d = Math.hypot(this.me.x - tx, this.me.z - tz);
    if (d > near + 30) {
      const ty = o.ty ?? voxels.groundY(tx, tz, 60);
      const c = { x: Math.floor(tx), y: standY(tx, tz, ty) ?? Math.floor(ty), z: Math.floor(tz) };
      const r = reachableAround(c, near);
      if (!r) { note('BUG', `${this.name}: no walkable ground around target ${tx | 0},${tz | 0}`); return false; }
      await this.tp(r.cell.x + 0.5, r.cell.y, r.cell.z + 0.5);
    }
    const ok = await this.walkTo(tx, tz, o);
    return ok;
  }

  // ── vehicles
  async enterVehicle(vid: string, seat?: number): Promise<boolean> {
    const gen = this.abortGen;
    for (let tries = 0; tries < 3 && gen === this.abortGen; tries++) {
      const v = this.bot.ents.get(vid) as { x: number; y: number; z: number } | undefined;
      if (!v) { await sleep(200); continue; }
      if (Math.hypot(this.me.x - v.x, this.me.z - v.z) > 3.2) {
        if (!(await this.goTo(v.x, v.z, { tol: 2.6, near: 25 }))) { await sleep(100); }
      }
      this.bot.send({ t: 'veh.enter', vehicle: vid, seat });
      const t0 = Date.now();
      while (Date.now() - t0 < 1500) { if (this.me.veh === vid) return true; await sleep(40); }
    }
    return this.me.veh === vid;
  }
  async exitVehicle(): Promise<boolean> {
    if (!this.me.veh) return true;
    for (let i = 0; i < 40 && Math.abs(this.me.vp?.speed ?? 0) > 6; i++) { this.inp = { ...NEUTRAL, hb: true, th: -0.3 }; await sleep(100); }
    this.idle(); this.bot.send({ t: 'veh.exit' });
    const t0 = Date.now();
    while (Date.now() - t0 < 1500) { if (!this.me.veh) return true; await sleep(40); }
    return !this.me.veh;
  }
  /** relocate the occupied vehicle (long-leg shortcut, counted like a tp) */
  relocateVehicle(x: number, z: number, yaw: number) {
    const v = this.vehEnt(); const p = this.ent;
    if (!v || !p) return;
    // street level (a groundY scan from above would put the car on a rooftop or a garage deck)
    const lane = nav.nearestRoad(x, z, 30);
    const y = lane && Math.hypot(lane.x - x, lane.z - z) < 12 ? lane.y : (standY(x, z, 22) ?? 22);
    v.phys.x = x; v.phys.z = z; v.phys.y = y; v.phys.speed = 0; v.phys.yaw = yaw;
    p.phys.x = x; p.phys.z = z; p.phys.y = y;
    this.tpCount++;
  }

  /** drive the occupied vehicle to (tx,tz) along the road graph (boats: straight lines). */
  async driveTo(tx: number, tz: number, o: { tol?: number; maxSec?: number; maxRealMetres?: number; speed?: number; stopAtEnd?: boolean } = {}): Promise<boolean> {
    if (!this.me.vp) return false;
    const tol = o.tol ?? 6, t0 = Date.now(), maxMs = (o.maxSec ?? 240) * 1000;
    const veh = this.vehEnt();
    if (!veh) return false;
    const def = VEHICLES[veh.model];
    const boat = !!def.boat;
    const vmax = Math.min(o.speed ?? 26, def.maxSpeed * 0.8);
    let route: { x: number; z: number }[] | null = null;
    let ri = 0, stuckSince = 0, reverseUntil = 0, reroutes = 0, relocs = 0, blockedFor = 0;
    const planRoute = (): boolean => {
      const vp = this.me.vp!;
      const straight = () => [{ x: vp.x, z: vp.z }, { x: tx, z: tz }];
      if (boat) { route = straight(); ri = 0; return true; }
      // nav.route searches a bounded area: for very long legs hop the car to a lane ~1.6 km short of the target first
      if (Math.hypot(tx - vp.x, tz - vp.z) > 3000 && relocs < 3) {
        const f = 1600 / Math.hypot(tx - vp.x, tz - vp.z);
        const hx = tx + (vp.x - tx) * f, hz = tz + (vp.z - tz) * f;
        const lane = nav.nearestRoad(hx, hz, 400);
        if (lane) { this.relocateVehicle(lane.x, lane.z, lane.yaw); relocs++; note('INFO', `${this.name}: long leg: hopped the car to ${lane.x | 0},${lane.z | 0} (tp)`); return planRoute(); }
      }
      const r = nav.route(vp.x, vp.z, tx, tz);
      ri = 0;
      if (!r) { route = straight(); return false; }
      route = [...r, { x: tx, z: tz }]; // the route ends at the road; append the real target so we drive up to it
      let L = 0; for (let i = 1; i < route.length; i++) L += Math.hypot(route[i].x - route[i - 1].x, route[i].z - route[i - 1].z);
      const lim = o.maxRealMetres ?? Infinity;
      if (L > lim && relocs < 3) {
        let acc = 0;
        for (let i = route.length - 1; i > 0; i--) {
          acc += Math.hypot(route[i].x - route[i - 1].x, route[i].z - route[i - 1].z);
          if (acc >= lim) { const p = route[i - 1], q = route[i]; this.relocateVehicle(p.x, p.z, Math.atan2(-(q.x - p.x), -(q.z - p.z))); relocs++; note('INFO', `${this.name}: skipped ${Math.round(L - lim)} m of a ${Math.round(L)} m drive (tp)`); break; }
        }
        return planRoute();
      }
      return true;
    };
    if (!planRoute()) note('WARN', `${this.name}: no road route to ${tx | 0},${tz | 0} (driving straight)`);
    const gen = this.abortGen;
    while (Date.now() - t0 < maxMs) {
      if (gen !== this.abortGen) return false;
      const me = this.me;
      if (!me.veh || !me.vp) { this.idle(); return false; }
      const vp = me.vp;
      const dEnd = Math.hypot(vp.x - tx, vp.z - tz);
      if (dEnd <= tol) { this.inp = { ...NEUTRAL, hb: true }; if (!o.stopAtEnd) { this.idle(); return true; } if (Math.abs(vp.speed) < 1) { this.idle(); return true; } await sleep(50); continue; }
      // closest point along the route, then lookahead
      const r = route!;
      let best = ri, bd = Infinity;
      for (let i = ri; i < Math.min(r.length, ri + 40); i++) { const d = Math.hypot(r[i].x - vp.x, r[i].z - vp.z); if (d < bd) { bd = d; best = i; } }
      ri = best;
      const look = Math.max(7, Math.abs(vp.speed) * 0.55);
      let li = ri, acc = 0;
      while (li < r.length - 1 && acc < look) { acc += Math.hypot(r[li + 1].x - r[li].x, r[li + 1].z - r[li].z); li++; }
      const tgt = r[li];
      const want = Math.atan2(-(tgt.x - vp.x), -(tgt.z - vp.z));
      const err = angleDiff(want, vp.yaw);
      // bend ahead: angle between the heading now and the heading further on
      let far = li, acc2 = 0; while (far < r.length - 1 && acc2 < 35) { acc2 += Math.hypot(r[far + 1].x - r[far].x, r[far + 1].z - r[far].z); far++; }
      const bend = Math.abs(angleDiff(Math.atan2(-(r[far].x - tgt.x), -(r[far].z - tgt.z)), want));
      let vt = boat ? vmax : Math.max(5, vmax * (1 - Math.min(0.75, bend * 0.8)) * (1 - Math.min(0.6, Math.abs(err) * 0.6)));
      vt = Math.min(vt, Math.max(4, dEnd * 0.9));
      const now = Date.now();
      // other cars, bikes and people in the lane ahead: brake like a driver would
      let blocked = false; let lead = Infinity;
      const fx = -Math.sin(vp.yaw), fz = -Math.cos(vp.yaw);
      for (const e of this.bot.ents.values()) {
        if (e.id === me.veh || (e.k !== 'v' && e.k !== 'n')) continue;
        const rx = e.x - vp.x, rz = e.z - vp.z; const fwd = rx * fx + rz * fz; const lat = Math.abs(rx * fz - rz * fx);
        if (fwd > 1 && fwd < 6 + Math.max(0, vp.speed) * 1.1 && lat < (e.k === 'v' ? 2.6 : 1.6)) { blocked = true; lead = Math.min(lead, fwd); }
      }
      let th = vp.speed < vt ? 1 : vp.speed > vt + 3 ? -0.6 : 0.15;
      if (blocked) th = vp.speed > 3 ? -1 : (lead < 3 ? -0.3 : 0);
      // Stanley term: pull the car back onto the lane centre line (lamp posts and parked cars sit just off it)
      let cte = 0;
      { const a = r[Math.min(ri, r.length - 2)], b = r[Math.min(ri + 1, r.length - 1)]; const sdx = b.x - a.x, sdz = b.z - a.z, L = Math.hypot(sdx, sdz); if (L > 0.5) cte = (vp.x - a.x) * (-sdz / L) + (vp.z - a.z) * (sdx / L); }
      let st = Math.max(-1, Math.min(1, -err * 1.8 - Math.atan2(cte, Math.abs(vp.speed) + 3) * 1.4));
      if (reverseUntil > now) { th = -1; st = -st; }
      this.inp = { ...NEUTRAL, th, st, hb: false, yaw: vp.yaw };
      if (this.ent?.frozen) { stuckSince = 0; await sleep(50); continue; }
      if (blocked && lead < 14) { stuckSince = 0; blockedFor += 50; if (blockedFor > 6000) { blocked = false; blockedFor = 0; reverseUntil = now + 1200; } } else blockedFor = 0;
      if (reverseUntil <= now && Math.abs(vp.speed) < 0.6 && Date.now() - t0 > 1500) {
        if (!stuckSince) stuckSince = now;
        if (now - stuckSince > 1800) {
          stuckSince = 0; reverseUntil = now + 1500; reroutes++;
          if (reroutes % 3 === 0) planRoute();
          if (reroutes > 8) { note('WARN', `${this.name}: drive stuck at ${vp.x.toFixed(1)},${vp.y.toFixed(1)},${vp.z.toFixed(1)} yaw ${vp.yaw.toFixed(2)} heading to ${tx | 0},${tz | 0} (${veh.model}); ahead: ${aheadBlocks(vp.x, vp.y, vp.z, vp.yaw)}; route pts ${route?.length} ri ${ri} hp=${veh.hp} occ=${JSON.stringify(veh.occ)} frozen=${this.ent?.frozen} th=${this.inp.th} st=${this.inp.st} vpspeed=${vp.speed}`); if (route && ri + 8 < route.length) { const a = route[ri + 6], b = route[ri + 7]; this.relocateVehicle(a.x, a.z, Math.atan2(-(b.x - a.x), -(b.z - a.z))); } reroutes = 0; }
        }
      } else if (Math.abs(vp.speed) > 1.5) stuckSince = 0;
      await sleep(50);
    }
    this.idle();
    note('WARN', `${this.name}: drive to ${tx | 0},${tz | 0} timed out (at ${this.me.vp?.x | 0},${this.me.vp?.z | 0})`);
    return false;
  }
}

// ───────────────────────────────────────────────────────── crew / activity autopilot
export interface PlayOpts {
  /** cutscenes: 'skip' (vote), 'watch' (play them out) */ cutscenes?: 'skip' | 'watch';
  maxRealMetres?: number; maxSec?: number;
  /** called each time a stage starts (stage id) */ onStage?: (stage: string, crew: Crew) => Promise<void> | void;
  /** hook called before the autopilot handles an objective; return true to take over */
  override?: (o: ObjectiveDef, stage: StageDef, crew: Crew, who: Player, idx: number) => Promise<boolean> | boolean;
  verbose?: boolean;
  /** loud heists: the bots only carry stun pistols, so keep the guards and police stunned and the crew healed (dev commands) */
  support?: boolean;
}

export class Crew {
  stagesSeen: string[] = [];
  failed: string | null = null;
  done = false;
  constructor(readonly game: Game, readonly players: Player[], readonly activity: string, readonly opts: PlayOpts = {}) {}
  get lead() { return this.players[0]; }
  view(): ActivityView | null { return this.lead.act; }
  def() { return ACTIVITY_BY_ID[this.activity]; }
  run(): Instance | null { return this.lead.inst?.run ? this.lead.inst : null; }
  keyedEntity(key: string): string | null { const r = this.lead.inst?.run as unknown as { keyed: Map<string, string> } | undefined; return r?.keyed.get(key) ?? null; }
}

const BLOCKING = new Set(['cutscene', 'starting', 'lobby']);

/** Plays the activity the crew has just launched until results / failure. Real inputs only. */
export async function autopilot(crew: Crew): Promise<'complete' | 'failed' | 'timeout'> {
  const { players, opts } = crew;
  const def = crew.def();
  for (const p of players) p.autoCs = opts.cutscenes === 'watch' ? 'watch' : 'skip';
  const t0 = Date.now();
  const maxMs = (opts.maxSec ?? 900) * 1000;
  let lastStage = ''; let lastBeat = 0;
  const sup = opts.support ? setInterval(() => { players[0].dev('stun_npcs'); for (const p of players) if ((p.me.hp ?? 100) < 60 && !p.me.down) p.dev('heal'); }, 15_000) : null;
  if (sup) players[0].dev('stun_npcs');
  try {
  const stageTasks = new Map<string, Promise<void>>();
  while (Date.now() - t0 < maxMs) {
    const v = crew.view();
    if (!v) { await sleep(100); continue; }
    if (v.phase === 'complete' || players[0].results.length) return 'complete';
    if (v.phase === 'failed') { crew.failed = v.failReason ?? 'failed'; return 'failed'; }
    if (v.stage !== lastStage) { lastStage = v.stage; for (const p of players) { p.abortGen++; p.idle(); } crew.stagesSeen.push(v.stage); if (opts.verbose) note('INFO', `${crew.activity}: stage ${v.stage} (${v.stageIndex + 1}/${v.stageCount}) ${v.stageTitle}`); await opts.onStage?.(v.stage, crew); }
    if (opts.verbose && Date.now() - lastBeat > 15000) { lastBeat = Date.now(); note('INFO', `  .. ${crew.activity}/${v.stage}: ${players.map((p) => `${p.name.slice(-4)}@${p.pos().x | 0},${p.pos().z | 0}${p.me.veh ? '(' + p.me.veh + '/' + p.me.seat + ' ' + Math.round(p.me.vp?.speed ?? -1) + ')' : ''}`).join(' ')} phase=${v.phase} obj=${v.objectives.map((o) => o.id + (o.done ? '+' : '-') + (o.progress ?? '')).join(',')}`); }
    if (BLOCKING.has(v.phase)) { await sleep(100); continue; }
    const stage = def.stages.find((s) => s.id === v.stage);
    if (!stage) { await sleep(100); continue; }
    const pending = stage.objectives.filter((o) => !v.objectives.find((x) => x.id === o.id)?.done);
    if (!pending.length) { await sleep(80); continue; }
    const o = pending[0];
    const sk = `${v.stage}:${o.id}`;
    if (!stageTasks.has(sk)) {
      const task = (async () => {
        try {
          await Promise.all(players.map((p, i) => handle(crew, p, i, o, stage)));
        } catch (e) { note('BUG', `${crew.activity}/${v.stage}/${o.id}: autopilot error ${(e as Error).stack ?? e}`); }
      })();
      stageTasks.set(sk, task);
      task.finally(() => setTimeout(() => stageTasks.delete(sk), 600));
    }
    await sleep(100);
  }
  return 'timeout';
  } finally { if (sup) clearInterval(sup); }
}

function objectsFor(p: Player, targetKeys: string[], crew: Crew) {
  const out: { key: string; id: string; x: number; y: number; z: number; st: number; hold: number }[] = [];
  for (const k of targetKeys) {
    const id = crew.keyedEntity(k);
    const e = id ? p.bot.ents.get(id) as { x: number; y: number; z: number; st: number; hold?: number } | undefined : undefined;
    if (id && e) out.push({ key: k, id, x: e.x, y: e.y, z: e.z, st: e.st, hold: e.hold ?? 0 });
  }
  return out;
}

async function handle(crew: Crew, p: Player, idx: number, o: ObjectiveDef, stage: StageDef): Promise<void> {
  if (await crew.opts.override?.(o, stage, crew, p, idx)) return;
  const maxReal = crew.opts.maxRealMetres ?? 1400;
  const g0 = p.abortGen; const dead = () => p.abortGen !== g0;
  const view = () => crew.view();
  // passengers just ride along with the driver
  const passenger = () => !!p.me.veh && !p.me.vp;
  const driverless = () => { const v = p.vehEnt(); return !!v && !v.occ[0]; };
  const leaveCar = async () => { for (let i = 0; i < 12 && p.me.veh; i++) { p.bot.send({ t: 'veh.exit' }); await sleep(250); } };
  const stillPending = () => { const v = view(); return !!v && v.phase === 'playing' && v.stage === stage.id && !v.objectives.find((x) => x.id === o.id)?.done; };
  switch (o.type) {
    case 'wait': await sleep(300); return;
    case 'enter_vehicle': {
      const ids = o.vehicles.map((k) => crew.keyedEntity(k)).filter(Boolean) as string[];
      if (p.me.veh && ids.includes(p.me.veh)) return;
      // each crew member takes a different vehicle where there are enough, else shares (seat by index)
      const mine = ids.length > 1 ? ids[idx % ids.length] : ids[0];
      if (!mine) return;
      const seat = ids.length > 1 ? 0 : idx;
      if (!(await p.enterVehicle(mine, seat === 0 ? undefined : seat))) note('WARN', `${crew.activity}/${stage.id}: ${p.name} could not enter ${mine}`);
      return;
    }
    case 'reach': {
      const [x, y, z] = o.pos;
      if (o.vehicle) {
        const vid = crew.keyedEntity(o.vehicle);
        if (!vid) return;
        if (idx === 0) {
          if (p.me.veh !== vid && !(await p.enterVehicle(vid))) return;
          await p.driveTo(x, z, { tol: Math.max(2, o.r - 2), maxRealMetres: maxReal, maxSec: 400 });
        } else if (p.me.veh !== vid) {
          const v = crew.lead.inst?.vehicles.get(vid);
          if (v && v.def.seats > 1) await p.enterVehicle(vid, 1);
        }
        return;
      }
      if (passenger() && driverless()) await leaveCar();
      if (passenger()) { await sleep(300); return; }
      if (p.me.veh) {
        const veh = p.vehEnt();
        if (veh?.def.boat) await p.driveTo(x, z, { tol: Math.max(2, o.r - 2), maxSec: 400 });
        else await p.driveTo(x, z, { tol: Math.max(2, o.r - 2), maxRealMetres: maxReal, maxSec: 400 });
        return;
      }
      await p.goTo(x, z, { tol: Math.max(0.8, o.r - 1.5), ty: y, maxSec: 90 });
      return;
    }
    case 'interact': {
      const targets = objectsFor(p, o.targets, crew).filter((t) => t.st === 0);
      if (!targets.length) { await sleep(200); return; }
      if (o.simultaneous) {
        // each player takes its own target; press together once everyone stands at theirs
        const mine = targets[idx % targets.length];
        if (p.me.veh) await p.exitVehicle();
        await p.goTo(mine.x, mine.z, { tol: 1.0, ty: mine.y, maxSec: 90 });
        await syncAt(crew, `sim:${o.id}`, crew.players.length);
        p.bot.send({ t: 'interact', target: mine.id });
        await sleep(Math.max(300, mine.hold * 1000 + 700));
        return;
      }
      // split targets between players by index, nearest first
      const list = targets.filter((_, i) => i % crew.players.length === idx % crew.players.length);
      const todo = (list.length ? list : targets).sort((a, b) => Math.hypot(a.x - p.me.x, a.z - p.me.z) - Math.hypot(b.x - p.me.x, b.z - p.me.z));
      for (const t of todo) {
        if (!stillPending() || dead()) return;
        const cur = p.bot.ents.get(t.id) as { st: number } | undefined;
        if (!cur || cur.st !== 0) continue;
        if (passenger()) await leaveCar();
        if (p.me.veh) {
          const veh = p.vehEnt();
          if (veh && Math.hypot(veh.phys.x - t.x, veh.phys.z - t.z) > 40) {
            // drive to the street in front of the object, then walk the rest (objects can be inside buildings)
            const lane = veh.def.boat ? { x: t.x, z: t.z } : nav.nearestRoad(t.x, t.z, 200) ?? { x: t.x, z: t.z };
            await p.driveTo(lane.x, lane.z, { tol: 7, maxRealMetres: maxReal, maxSec: 300, stopAtEnd: true });
          }
          await p.exitVehicle();
        }
        if (!(await p.goTo(t.x, t.z, { tol: 1.1, ty: t.y, maxSec: 90 }))) { note('WARN', `${crew.activity}/${stage.id}: ${p.name} cannot reach object ${t.key} at ${t.x | 0},${t.y | 0},${t.z | 0}`); continue; }
        p.bot.send({ t: 'interact', target: t.id });
        const hold = await waitObj(p, t.id, Math.max(3, t.hold * 1.6 + 3));
        if (!hold && stillPending()) {
          const e = p.ent;
          note('WARN', `${crew.activity}/${stage.id}: ${p.name} object ${t.key} not done after hold: dist ${Math.hypot(p.me.x - t.x, p.me.z - t.z).toFixed(1)} dy ${(p.me.y - t.y).toFixed(1)} holding=${JSON.stringify(e?.holding)} hold=${t.hold} frozen=${e?.frozen} notifies=${JSON.stringify(p.notifies.slice(-3).map((n) => n.text))} trail=${p.trail.slice(-14).join(' | ')}`);
        }
      }
      return;
    }
    case 'shoot': {
      // everyone shoots, each player takes every n-th target; shoot from where you stand when it is in range, step closer when not
      const targets = objectsFor(p, o.targets, crew).filter((t) => t.st === 0).filter((_, i) => i % crew.players.length === idx % crew.players.length);
      if (p.me.veh) await p.exitVehicle();
      const shootAt = async (t: { id: string; x: number; y: number; z: number }) => {
        const dx = t.x - p.me.x, dz = t.z - p.me.z, dy = t.y + 0.9 - (p.me.y + 1.62);
        const yaw = Math.atan2(-dx, -dz), pitch = Math.atan2(dy, Math.hypot(dx, dz));
        p.inp = { ...NEUTRAL, yaw, pitch };
        // like the real client: reload when the magazine is empty
        const a = p.ent ? p.ent.ammo[p.ent.weapon] : undefined;
        if (a && a.mag <= 0) { p.bot.send({ t: 'reload' }); await sleep(1600); }
        p.bot.send({ t: 'fire', yaw, pitch, aim: true });
        await sleep(660);
      };
      for (const t of targets) {
        for (let round = 0; round < 4 && stillPending() && !dead(); round++) {
          const e = p.bot.ents.get(t.id) as { st: number } | undefined;
          if (!e || e.st !== 0) break;
          {
            const eyeNow = { x: p.me.x, y: p.me.y + 1.62, z: p.me.z };
            const dx0 = t.x - eyeNow.x, dy0 = t.y + 0.9 - eyeNow.y, dz0 = t.z - eyeNow.z, L0 = Math.hypot(dx0, dy0, dz0);
            const clear = L0 <= 24 && raycastVoxels(voxels, eyeNow.x, eyeNow.y, eyeNow.z, dx0 / L0, dy0 / L0, dz0 / L0, L0) >= L0;
            if (!clear) {
              // walk to the nearest spot that can actually see the target
              // search outward from where the player stands (walking is not symmetric: drops are allowed, climbs are not)
              const c = { x: Math.floor(p.me.x), y: standY(p.me.x, p.me.z, p.me.y) ?? Math.floor(p.me.y), z: Math.floor(p.me.z) };
              const cells = cellsWithSight(c, t.x, t.y + 0.9, t.z, 70, 22);
              if (cells[0]) { const okw = await p.goTo(cells[0].x + 0.5, cells[0].z + 0.5, { tol: 0.4, near: 60, maxSec: 20, ty: cells[0].y }); if (!okw) { note('WARN', `${crew.activity}: ${p.name} could not walk to the sight spot ${cells[0].x},${cells[0].y},${cells[0].z} for ${t.id} (from ${p.me.x.toFixed(1)},${p.me.y},${p.me.z.toFixed(1)}; ${cells.length} candidates) - tp`); await p.tp(cells[0].x + 0.5, cells[0].y, cells[0].z + 0.5); } }
              else note('WARN', `${crew.activity}/${stage.id}: no spot with a line of sight to target ${t.id}`);
            }
          }
          for (let k = 0; k < 3; k++) { const e2 = p.bot.ents.get(t.id) as { st: number } | undefined; if (!e2 || e2.st !== 0) break; await shootAt(t); }
          { const e3 = p.bot.ents.get(t.id) as { st: number } | undefined; if (e3 && e3.st === 0) note('INFO', `${crew.activity}: ${p.name} round ${round} missed ${t.id} (${t.x},${t.y},${t.z}) from ${p.me.x.toFixed(1)},${p.me.y},${p.me.z.toFixed(1)} weapon=${JSON.stringify(p.ent?.ammo)}`); }
        }
      }
      return;
    }
    case 'lose_wanted': {
      await escapeWanted(crew, p, idx);
      return;
    }
    case 'defend': {
      if (p.me.veh) await p.exitVehicle();
      if (idx === 0 || crew.players.length === 1) {
        await p.goTo(o.pos[0], o.pos[2], { tol: Math.max(1, o.r - 2), ty: o.pos[1], maxSec: 90 });
        const t0 = Date.now();
        while (stillPending() && Date.now() - t0 < 200_000) await sleep(200);
      } else await sleep(500);
      return;
    }
    case 'checkpoints': {
      if (!p.me.veh) { await sleep(200); return; }
      const r = view()?.race;
      const pts = o.points;
      for (let guard = 0; guard < pts.length * (o.laps + 1) + 4 && stillPending(); guard++) {
        const cur = view()?.race;
        const cpI = cur?.cp ?? 0;
        const pt = pts[cpI % pts.length];
        const next = pts[(cpI + 1) % pts.length];
        const ok = await p.driveTo(pt[0], pt[2], { tol: o.r - 1.5, maxSec: 120, speed: 40, stopAtEnd: false });
        void next; void r;
        if (!ok) break;
        // wait for the server to count it
        const t1 = Date.now();
        while ((view()?.race?.cp ?? 0) === cpI && (view()?.race?.lap ?? 0) === (cur?.lap ?? 0) && Date.now() - t1 < 1500 && stillPending()) await sleep(40);
      }
      return;
    }
  }
}

async function waitObj(p: Player, id: string, secs: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < secs * 1000) {
    const e = p.bot.ents.get(id) as { st: number } | undefined;
    if (!e || e.st === 1) return true;
    await sleep(60);
  }
  return false;
}

const barriers = new Map<string, { n: number; waiters: (() => void)[] }>();
export async function syncAt(_crew: Crew, name: string, n: number, timeoutMs = 90_000) {
  let b = barriers.get(name);
  if (!b) { b = { n: 0, waiters: [] }; barriers.set(name, b); }
  b.n++;
  if (b.n >= n) { const ws = b.waiters; barriers.delete(name); ws.forEach((w) => w()); return; }
  await new Promise<void>((res) => { b!.waiters.push(res); setTimeout(res, timeoutMs); });
}

/** lose the police: get out of sight and out of the search circle (drive away if in a car) */
async function escapeWanted(crew: Crew, p: Player, _idx: number) {
  const t0 = Date.now();
  const v0 = () => crew.view();
  let fleeing = 0; const gen = p.abortGen;
  while (gen === p.abortGen && Date.now() - t0 < 150_000 && v0()?.phase === 'playing' && v0()!.objectives.some((o) => o.id === 'lose' && !o.done)) {
    if (p.me.veh && !p.me.vp) { await sleep(300); continue; } // passengers ride along
    if (!p.me.veh) {
      // a sensible player jumps into the nearest free crew car instead of running from the police
      const cars = [...p.bot.ents.values()].filter((e) => e.k === 'v' && (e as { m: string }).m !== 'police' && (e as { occ: (string | null)[] }).occ.every((o) => !o) && Math.hypot(e.x - p.me.x, e.z - p.me.z) < 45) as unknown as { id: string; x: number; z: number }[];
      cars.sort((a, b) => Math.hypot(a.x - p.me.x, a.z - p.me.z) - Math.hypot(b.x - p.me.x, b.z - p.me.z));
      if (cars[0] && (await p.enterVehicle(cars[0].id))) continue;
    }
    const me = p.me;
    const act = p.act;
    const m = act?.objectives.find((o) => o.id === 'lose')?.markers[0];
    const cx = m?.x ?? me.x, cz = m?.z ?? me.z;
    const pos = p.pos();
    // flee directly away from the search centre along roads/walkable ground
    const away = Math.atan2(pos.x - cx, pos.z - cz) + (fleeing % 3 === 2 ? 1.2 : 0);
    let gx = pos.x + Math.sin(away) * 420, gz = pos.z + Math.cos(away) * 420;
    fleeing++;
    if (p.me.veh) {
      const lane = nav.randomLaneNear(pos.x, pos.z, 350, 700, { toward: { x: gx, z: gz }, noBridge: true });
      if (lane) { gx = lane.x; gz = lane.z; }
      await p.driveTo(gx, gz, { tol: 12, maxSec: 30, speed: 32 });
    }
    else if (!(await p.walkToFar(gx, gz, 12))) await sleep(200);
  }
  p.idle();
}

declare module './play.ts' { }
// walkToFar: walk towards a distant point using the nearest reachable cell (flee helper)
(Player.prototype as unknown as { walkToFar: (x: number, z: number, secs: number) => Promise<boolean> }).walkToFar = async function (this: Player, x: number, z: number, secs: number) {
  const me = this.me;
  const dx = x - me.x, dz = z - me.z, L = Math.hypot(dx, dz) || 1;
  for (let r = 60; r >= 10; r -= 10) {
    const tx = me.x + dx / L * r, tz = me.z + dz / L * r;
    const y = standY(tx, tz, me.y);
    if (y !== null) return this.walkTo(tx, tz, { tol: 2, maxSec: secs });
  }
  return false;
};
declare global { }
export interface Player { walkToFar(x: number, z: number, secs: number): Promise<boolean> }

const BN: Record<number, string> = Object.fromEntries(Object.entries(B).map(([k, v]) => [v as number, k]));
/** debug: block ids 1..8 m ahead of a vehicle at feet height and +1 (S = solid) */
export function aheadBlocks(x: number, y: number, z: number, yaw: number) {
  const out: string[] = [];
  for (let d = 1; d <= 8; d += 1.5) {
    const px = x - Math.sin(yaw) * d, pz = z - Math.cos(yaw) * d;
    const col = [0, 1, 2].map((dy) => { const id = voxels.getBlock(Math.floor(px), Math.floor(y) + dy, Math.floor(pz)); return (SOLID[id] ? 'S:' : '') + (BN[id] ?? id); }).join(',');
    out.push(`${d}m:[${col}]`);
  }
  return out.join(' ');
}

/** number of cells a walker can reach from `c` (capped): small = sealed pocket */
export function regionSize(c: Cell, cap = 4000): number {
  const seen = new Set<string>([key(c.x, c.y, c.z)]);
  const q: Cell[] = [c];
  for (let i = 0; i < q.length && q.length < cap; i++) for (const nb of neighbours(q[i])) { const k = key(nb.x, nb.y, nb.z); if (!seen.has(k)) { seen.add(k); q.push(nb); } }
  return q.length;
}

/** cells within `maxD` walking steps of `c` that have a clear line to (tx,ty,tz) at eye height and are within `range` metres */
export function cellsWithSight(c: Cell, tx: number, ty: number, tz: number, maxD = 16, range = 24): Cell[] {
  const seen = new Map<string, number>([[key(c.x, c.y, c.z), 0]]);
  const q: Cell[] = [c]; const out: Cell[] = [];
  for (let i = 0; i < q.length && i < 30000; i++) {
    const cur = q[i]; const d = seen.get(key(cur.x, cur.y, cur.z))!;
    const ex = cur.x + 0.5, ey = cur.y + 1.62, ez = cur.z + 0.5;
    const dx = tx - ex, dy = ty - ey, dz = tz - ez, L = Math.hypot(dx, dy, dz);
    if (L <= range && L > 2) {
      // stand anywhere in the cell: the ray must be clear from its centre and from the four edges (the server needs the whole path to the target's axis)
      let ok = true;
      for (const [ox, oz] of [[0, 0], [0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5], [0.5, 0.5], [-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5]]) {
        const sx = ex + ox, sz = ez + oz, ddx = tx - sx, ddz = tz - sz, LL = Math.hypot(ddx, dy, ddz);
        if (raycastVoxels(voxels, sx, ey, sz, ddx / LL, dy / LL, ddz / LL, LL) < LL) { ok = false; break; }
      }
      if (ok) out.push(cur);
    }
    if (d >= maxD) continue;
    for (const nb of neighbours(cur)) { const k = key(nb.x, nb.y, nb.z); if (!seen.has(k)) { seen.set(k, d + 1); q.push(nb); } }
  }
  return out;
}

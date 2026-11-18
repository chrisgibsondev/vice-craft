/**
 * Leonia (real road graph) variants of the NPC systems in npc.ts:
 *  - traffic: cars spawn on real lanes near players and follow graph edges kinematically with
 *    right-hand lane offsets, respecting oneway; at the end of an edge they swing through a
 *    quadratic curve onto the chosen next edge, slowing by turn angle and polyline curvature;
 *    signalised junctions run a simple two-phase cycle, other junctions are first-come
 *    reservations (cars queue behind the car holding the junction); highways are fast, side
 *    streets slow; height follows the edge's bridge-deck profile (feet y = 22 + deck).
 *  - pedestrians: walk sidewalk lines (1 m outside the carriageway) and footways along the graph,
 *    cross at junctions, plus park / beach / plaza / pier wanderers (stepWander in npc.ts);
 *    roles from the district style and land use (business downtown/Brickell, tourists and beach
 *    people on Miami Beach, workers in the port, ...).
 *  - wildlife: herons/egrets/gators in wetlands and waterside parks, gulls and pelicans on
 *    beaches, piers and shores, dolphins in open water.
 */
import { RC, GF, GN, B, angleDiff, type VehicleModel } from '@blockshore/shared';
import { leoniaNav } from './nav.ts';
import { voxels } from './voxels.ts';
import type { Instance } from './instance.ts';
import type { NpcEnt, VehicleEnt } from './entities.ts';
import {
  pickTraffic, pal, tooClose, honk, isPed, d2xz, rnd, pickW, footing, shallowWater, makePed, addFollowers, maybeDog, groupSize,
  PROF, URBAN_TBL, FREE_TBL, BEACH_TBL, SHORE_TBL, EXT, APROF, AEXT, makeAnimal, countKind, type Ext, type Prof,
} from './npc.ts';

const N = () => leoniaNav!;
const G = () => leoniaNav!.graph;

// ───────────────────────────────────────────────────────────── traffic
/** junction reservations per instance: node → holder */
const CLAIMS = new WeakMap<Instance, Map<number, { id: string; from: number; until: number }>>();
const claims = (inst: Instance) => { let m = CLAIMS.get(inst); if (!m) { m = new Map(); CLAIMS.set(inst, m); } return m; };
const SIGNAL_CYCLE = 26_000; // ms, two phases of 11 s green + 2 s all-red

/**
 * Is the lane free of solid blocks along its length (elevated-rail piers in the median, stamps,
 * buildings over service roads, ...)? Sampled once per (edge, direction, lane) at car height
 * on the lane line and ±0.9 m beside it; the world is static, so the answer is cached.
 */
const LANE_CLEAR = new Map<number, boolean>();
const PASS = new Set<number>([B.AIR, B.TALL_GRASS, B.FLOWERS, B.REEDS, B.CANE, B.PALM_LEAVES, B.LEAVES, B.WATER]);
export function laneClear(e: number, dir: 1 | -1, lane: number): boolean {
  const key = (e * 2 + (dir > 0 ? 1 : 0)) * 16 + Math.min(15, lane);
  let ok = LANE_CLEAR.get(key);
  if (ok !== undefined) return ok;
  const nav = N(), L = G().eLen[e];
  ok = true;
  outer: for (let s = 0.5; s < L; s += 2) {
    const p = nav.laneSpot(e, dir, s, lane);
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    const y0 = Math.round(p.y);
    for (const w of [-0.9, 0, 0.9]) {
      const x = Math.floor(p.x - fz * w), z = Math.floor(p.z + fx * w);
      for (let y = y0; y <= y0 + 1; y++) if (!PASS.has(voxels.getBlock(x, y, z))) { ok = false; break outer; }
    }
  }
  LANE_CLEAR.set(key, ok);
  return ok;
}
/** a clear lane on (e, dir), preferring `want`; −1 if none */
function clearLane(e: number, dir: 1 | -1, want: number): number {
  const n = G().lanesDir(e);
  const w = Math.max(0, Math.min(n - 1, want));
  if (laneClear(e, dir, w)) return w;
  for (let k = 1; k < n; k++) for (const l of [w + k, w - k]) if (l >= 0 && l < n && laneClear(e, dir, l)) return l;
  return -1;
}

export function spawnTrafficLeonia(inst: Instance, near: { phys: { x: number; z: number } }) {
  const nav = N(), g = G();
  for (let tries = 0; tries < 3; tries++) {
    const found = nav.randomLaneNear(near.phys.x, near.phys.z, 40, 150);
    if (!found) continue;
    const lane = clearLane(found.edge, found.dir, found.lane);
    if (lane < 0) continue;
    const spot = lane === found.lane ? found : nav.laneSpot(found.edge, found.dir, found.s, lane);
    if (tooClose(inst, spot.x, spot.z, 32)) continue;
    let blocked = false;
    for (const v of inst.vehicles.values()) if (d2xz(v.phys.x, v.phys.z, spot.x, spot.z) < 14 * 14) { blocked = true; break; }
    if (blocked) continue;
    const highway = spot.cls <= RC.TRUNK;
    const zone = highway ? 'highway' : nav.zoneAt(spot.x, spot.z);
    let k = pickTraffic(inst, zone);
    if (k.label === 'bus' && spot.cls > RC.TERTIARY) k = { model: 'sedan' as VehicleModel, speed: 1 };
    const v = inst.spawnVehicle(k.model, spot.x, spot.y, spot.z, spot.yaw, { color: k.color ?? pal(), label: k.label });
    v.ai = { kind: 'traffic', edge: spot.edge, edir: spot.dir, s: spot.s, lane: spot.lane, speed: k.speed * rnd(0.88, 1.06), next: null };
    v.phys.speed = Math.min(g.eSpeed[spot.edge], 12) * 0.6;
    planNext(v);
    return;
  }
}

/** choose the continuation at the end of the current edge and the turn geometry */
function planNext(v: VehicleEnt) {
  const nav = N(), g = G(), ai = v.ai!;
  const e = ai.edge!, dir = ai.edir!;
  let nx: { edge: number; dir: 1 | -1 } | null = null, lane2 = -1;
  for (let k = 0; k < 4 && lane2 < 0; k++) {
    nx = nav.nextEdge(e, dir);
    if (!nx) break;
    lane2 = clearLane(nx.edge, nx.dir, ai.lane!);
  }
  if (!nx || lane2 < 0) { ai.next = null; return; }
  const ang = nav.turnAngle(e, dir, nx.edge, nx.dir);
  const L1 = g.eLen[e], L2 = g.eLen[nx.edge];
  const R = ang < 0.25 ? 2.5 : Math.max(g.eWidth[e], g.eWidth[nx.edge]) / 2 + (ang > 2 ? 5 : 3.5);
  const d1 = Math.min(R, L1 * 0.45, Math.max(0.2, L1 - ai.s! - 0.2)), d2 = Math.min(R, L2 * 0.45);
  // right turns end in the kerb lane, otherwise keep the lane number (when clear)
  let lane = lane2;
  if (ang > 0.7 && angleSign(e, dir, nx.edge, nx.dir) > 0) { const kerb = g.lanesDir(nx.edge) - 1; if (laneClear(nx.edge, nx.dir, kerb)) lane = kerb; }
  ai.next = { edge: nx.edge, dir: nx.dir, lane, d1: Math.max(0.2, d1), d2: Math.max(0.2, d2), ang };
}
/** +1 for a right turn, −1 for a left turn */
function angleSign(e1: number, d1: 1 | -1, e2: number, d2: 1 | -1) {
  const nav = N();
  const [ax, az] = nav.arriveDir(e1, d1);
  const g = G(), L = g.eLen[e2], n = g.startNode(e2, d2);
  const p = g.pointAt(e2, d2 > 0 ? Math.min(L, 6) : Math.max(0, L - 6));
  const bx = p.x - g.nodeX[n], bz = p.z - g.nodeZ[n];
  // right of (ax,az) is (-az, ax)
  return bx * -az + bz * ax >= 0 ? 1 : -1;
}

/** current pose from (edge, s, next): straight lane or the junction curve */
function pose(v: VehicleEnt): { x: number; y: number; z: number; yaw: number } {
  const p = poseLane(v), sh = v.ai!.shift ?? 0;
  if (sh) { p.x += Math.cos(p.yaw) * sh; p.z += -Math.sin(p.yaw) * sh; }
  return p;
}
function poseLane(v: VehicleEnt): { x: number; y: number; z: number; yaw: number } {
  const nav = N(), g = G(), ai = v.ai!;
  const e = ai.edge!, L = g.eLen[e], nx = ai.next;
  if (!nx || ai.s! <= L - nx.d1) return nav.laneSpot(e, ai.edir!, Math.min(ai.s!, L), ai.lane!);
  const u = Math.min(1, (ai.s! - (L - nx.d1)) / (nx.d1 + nx.d2));
  const A = nav.laneSpot(e, ai.edir!, L - nx.d1, ai.lane!), C = nav.laneSpot(nx.edge, nx.dir, nx.d2, nx.lane);
  // control point: intersection of the incoming lane ray and the outgoing lane ray (back-projected)
  const fax = -Math.sin(A.yaw), faz = -Math.cos(A.yaw), fcx = -Math.sin(C.yaw), fcz = -Math.cos(C.yaw);
  const den = fax * fcz - faz * fcx;
  let px = (A.x + C.x) / 2, pz = (A.z + C.z) / 2;
  if (Math.abs(den) > 0.15) {
    const t = ((C.x - A.x) * fcz - (C.z - A.z) * fcx) / den;
    if (t > 0 && t < (nx.d1 + nx.d2) * 1.5) { px = A.x + fax * t; pz = A.z + faz * t; }
  }
  const w0 = (1 - u) * (1 - u), w1 = 2 * u * (1 - u), w2 = u * u;
  const x = w0 * A.x + w1 * px + w2 * C.x, z = w0 * A.z + w1 * pz + w2 * C.z;
  const dx = 2 * (1 - u) * (px - A.x) + 2 * u * (C.x - px), dz = 2 * (1 - u) * (pz - A.z) + 2 * u * (C.z - pz);
  const yaw = Math.hypot(dx, dz) > 1e-4 ? Math.atan2(-dx, -dz) : A.yaw;
  return { x, y: A.y + (C.y - A.y) * u, z, yaw };
}

/** distance (m) at which the car must be stopped before the junction, or Infinity */
function junctionStop(inst: Instance, v: VehicleEnt, now: number): number {
  const g = G(), ai = v.ai!, nx = ai.next;
  if (!nx) return Infinity;
  const e = ai.edge!, L = g.eLen[e];
  const node = g.endNode(e, ai.edir!);
  if (g.carDegree(node) < 3 || g.eCls[e] === RC.MOTORWAY || (g.eFlags[e] & GF.LINK && g.eCls[nx.edge] <= RC.TRUNK)) return Infinity;
  const stopAt = L - nx.d1 - 0.8; // stop line
  const toStop = stopAt - ai.s!;
  const m = claims(inst);
  if (toStop < -0.5) { const c = m.get(node); if (c?.id === v.id) c.until = now + 2500; return Infinity; } // in the junction: keep holding it
  if (toStop > 45) return Infinity;
  if (g.nodeFlags[node] & GN.SIGNAL) {
    // two phases by approach axis (north-south vs east-west), hashed per junction
    const [ax, az] = N().arriveDir(e, ai.edir!);
    const grp = Math.abs(az) >= Math.abs(ax) ? 0 : 1;
    const t = (now + (node * 7919) % SIGNAL_CYCLE) % SIGNAL_CYCLE;
    const half = SIGNAL_CYCLE / 2;
    const phase = t < half - 2000 ? 0 : t < half ? -1 : t < SIGNAL_CYCLE - 2000 ? 1 : -1;
    if (phase !== grp && toStop > 1.5) return toStop; // red / amber: stop unless too close to stop
  }
  // first-come reservation of the junction box
  const c = m.get(node);
  if (toStop < 8) {
    if (!c || c.until < now || c.id === v.id || c.from === e) { m.set(node, { id: v.id, from: e, until: now + 2500 }); return Infinity; }
    return toStop;
  }
  return Infinity;
}

export function driveTrafficLeonia(inst: Instance, v: VehicleEnt, dt: number) {
  const g = G(), ai = v.ai!, now = inst.now;
  if (ai.edge === undefined) { inst.removeVehicle(v.id); return; }
  if (ai.waitUntil && now < ai.waitUntil) { v.phys.speed = 0; return; }
  const e = ai.edge, L = g.eLen[e];
  // speed limit: class speed × driver factor, curves ahead, turn at the junction
  const vlim = Math.max(5, Math.min(30, g.eSpeed[e] * (ai.speed ?? 1)));
  let target = vlim;
  const nx = ai.next;
  if (nx) {
    const vturn = nx.ang < 0.3 ? vlim : nx.ang < 0.8 ? 10 : nx.ang < 1.7 ? 6.5 : 4.5;
    const toTurn = L - nx.d1 - ai.s!;
    target = Math.min(target, toTurn > 0 ? Math.sqrt(vturn * vturn + 2 * 3 * toTurn) : vturn);
  } else {
    const toEnd = L - ai.s!;
    target = Math.min(target, Math.sqrt(2 + 2 * 3 * Math.max(0, toEnd - 3)));
  }
  if (ai.s! < L - (nx?.d1 ?? 0) - 1) {
    // curvature within the polyline (ramps, bends): heading change over the next 18 m
    const dir = ai.edir!;
    const a = g.pointAt(e, dir > 0 ? ai.s! : L - ai.s!), b = g.pointAt(e, dir > 0 ? Math.min(L, ai.s! + 18) : Math.max(0, L - ai.s! - 18));
    const dot = a.tx * b.tx + a.tz * b.tz;
    if (dot < 0.8) target = Math.min(target, 7); else if (dot < 0.95) target = Math.min(target, 12);
  }
  // pull over for a siren coming up behind (shift toward the nearer kerb and stop)
  const fx0 = -Math.sin(v.phys.yaw), fz0 = -Math.cos(v.phys.yaw);
  for (const o of inst.vehicles.values()) {
    if (o.ai?.kind !== 'police' || !o.siren) continue;
    const ox = o.phys.x - v.phys.x, oz = o.phys.z - v.phys.z;
    if (ox * ox + oz * oz > 40 * 40) continue;
    const behind = ox * fx0 + oz * fz0 < -1, same = -Math.sin(o.phys.yaw) * fx0 + -Math.cos(o.phys.yaw) * fz0 > 0.4;
    if (behind && same) { ai.yieldUntil = now + 2500; break; }
  }
  const yielding = (ai.yieldUntil ?? 0) > now;
  const off = g.laneOffset(e, ai.lane!);
  const wantShift = yielding ? (off < -0.3 ? -2.6 : 2.6) : 0;
  ai.shift = (ai.shift ?? 0) + Math.max(-1.6 * dt, Math.min(1.6 * dt, wantShift - (ai.shift ?? 0)));
  if (yielding) target = Math.min(target, Math.abs(ai.shift) > 2 ? 0 : 4);
  const stopIn = junctionStop(inst, v, now);
  if (stopIn !== Infinity) target = Math.min(target, stopIn < 0.6 ? 0 : Math.sqrt(2 * 4 * Math.max(0, stopIn - 0.4)));
  // obstacles ahead (cars, walking players, pedestrians)
  const fx = -Math.sin(v.phys.yaw), fz = -Math.cos(v.phys.yaw);
  const range = 7 + Math.abs(v.phys.speed) * 1.1;
  let blocked = false, blockedByPlayer = false, blockedByPed = false, gap = Infinity;
  const check = (x: number, z: number, y: number, kind: 0 | 1 | 2) => {
    if (Math.abs(y - v.phys.y) > 3.5) return; // other deck level
    const ox = x - v.phys.x, oz = z - v.phys.z;
    const ahead = ox * fx + oz * fz;
    if (ahead < 0.5 || ahead > range) return;
    const side = Math.abs(ox * -fz + oz * fx);
    if (side < 1.7) { blocked = true; gap = Math.min(gap, ahead); if (kind === 1) blockedByPlayer = true; if (kind === 2) blockedByPed = true; }
  };
  for (const o of inst.vehicles.values()) if (o !== v && o.destroyedAt === 0 && !(yielding && o.ai?.kind === 'police')) check(o.phys.x, o.phys.z, o.phys.y, o.occ[0] ? 1 : 0);
  for (const p of inst.players.values()) if (!p.veh && !p.linkdeadAt) check(p.phys.x, p.phys.z, p.phys.y, 1);
  for (const n of inst.npcs.values()) if (isPed(n)) check(n.x, n.z, n.y, 2);
  if (blocked) target = Math.min(target, gap < 6 ? 0 : Math.sqrt(2 * 5 * (gap - 6)));
  v.phys.speed += Math.max(-14 * dt, Math.min(5 * dt, target - v.phys.speed));
  if (v.phys.speed < 0) v.phys.speed = 0;
  ai.stuckFor = v.phys.speed < 0.3 && (blocked || stopIn !== Infinity) ? (ai.stuckFor ?? 0) + dt : 0;
  const cool = !ai.hornAt || now - ai.hornAt > 4500;
  if (cool && ((blockedByPlayer && v.phys.speed < 0.5) || (blockedByPed && v.phys.speed < 1.5 && Math.random() < 0.05) || (blocked && (ai.stuckFor ?? 0) > 1.6 && Math.random() < 0.08) || Math.random() < 0.00006)) honk(v, now, inst, blockedByPlayer ? 'player' : blockedByPed ? 'ped' : (ai.stuckFor ?? 0) > 1.6 ? 'jam' : 'tap');
  if ((ai.stuckFor ?? 0) > 25) { inst.removeVehicle(v.id); return; }
  // advance along the edge / through the junction curve
  ai.s! += v.phys.speed * dt;
  for (let guard = 0; guard < 4; guard++) {
    const cur = ai.edge!, Lc = g.eLen[cur], n2 = ai.next;
    if (n2) {
      if (ai.s! < Lc + n2.d2) break; // the curve spans s = L − d1 … L + d2
      // finished the curve: continue on the next edge
      const over = ai.s! - (Lc + n2.d2);
      if (ai.edge !== n2.edge || ai.edir !== n2.dir) {
        const node = g.endNode(cur, ai.edir!);
        const m = claims(inst); const c = m.get(node); if (c?.id === v.id) m.delete(node);
      }
      ai.edge = n2.edge; ai.edir = n2.dir; ai.lane = n2.lane; ai.s = n2.d2 + Math.max(0, over);
      if (v.label === 'bus' && Math.random() < 0.25 && g.carDegree(g.startNode(n2.edge, n2.dir)) >= 3) ai.waitUntil = now + 2500 + Math.random() * 3000;
      planNext(v);
    } else {
      if (ai.s! < Lc) break;
      // dead end (oneway into nowhere / world edge): vanish when unobserved, else stop
      if (!tooClose(inst, v.phys.x, v.phys.z, 70)) { inst.removeVehicle(v.id); return; }
      ai.s = Lc; v.phys.speed = 0; ai.stuckFor = (ai.stuckFor ?? 0) + dt;
      break;
    }
  }
  const p = pose(v);
  v.phys.steer = Math.max(-1, Math.min(1, angleDiff(p.yaw, v.phys.yaw) / Math.max(0.02, dt) * 0.15));
  v.phys.x = p.x; v.phys.z = p.z; v.phys.y = p.y; v.phys.yaw = p.yaw;
  v.phys.vy = 0; v.phys.onGround = true;
}

// ───────────────────────────────────────────────────────────── police on the graph
/**
 * Pursuit along the A* route (centre line, siren on): accelerates to the advised bend speed,
 * overtakes blocking cars on the left, brakes for walking players / pedestrians, follows the
 * surface height (bridges). Returns false when no route is available (caller falls back to physics).
 */
export function driveRouteLeonia(inst: Instance, u: VehicleEnt, goal: { x: number; z: number }, dt: number): boolean {
  const nav = N(), ai = u.ai!;
  const st = (ai.nav ??= {});
  const wp = nav.pursuitWaypoint(st, u.phys.x, u.phys.z, goal.x, goal.z, inst.now);
  const pts = st.pts, cum = st.cum;
  if (!pts || !cum || pts.length < 2 || st.along === undefined) return false;
  const total = cum[cum.length - 1];
  const at = (s: number) => {
    s = Math.max(0, Math.min(total, s));
    let j = st.i ?? 0; while (j > 0 && cum[j] > s) j--; while (j < pts.length - 2 && cum[j + 1] < s) j++;
    const f = (s - cum[j]) / Math.max(1e-6, cum[j + 1] - cum[j]);
    return { x: pts[j].x + (pts[j + 1].x - pts[j].x) * f, z: pts[j].z + (pts[j + 1].z - pts[j].z) * f };
  };
  let vt = Math.min(26, wp.vmax ?? 26);
  // arrive slow enough for the physics hand-over at 25 m
  vt = Math.min(vt, 9 + Math.sqrt(2 * 5 * Math.max(0, Math.hypot(goal.x - u.phys.x, goal.z - u.phys.z) - 25)));
  // blocking traffic / people ahead on the route
  const fx = -Math.sin(u.phys.yaw), fz = -Math.cos(u.phys.yaw);
  const v0 = st.v ?? Math.max(0, u.phys.speed);
  const range = 6 + v0 * 0.9;
  let carAhead = Infinity, personAhead = Infinity;
  const probe = (x: number, z: number, y: number, person: boolean) => {
    if (Math.abs(y - u.phys.y) > 3.5) return;
    const ox = x - u.phys.x, oz = z - u.phys.z, ahead = ox * fx + oz * fz;
    if (ahead < 0.5 || ahead > range) return;
    const side = ox * -fz + oz * fx; // + = right of the unit
    if (Math.abs(side) < 1.8) { if (person) personAhead = Math.min(personAhead, ahead); else carAhead = Math.min(carAhead, ahead); }
  };
  // traffic pulls over for the siren (driveTrafficLeonia), so only other vehicles make the unit swerve
  for (const o of inst.vehicles.values()) if (o !== u && o.destroyedAt === 0 && o.ai?.kind !== 'traffic') probe(o.phys.x, o.phys.z, o.phys.y, false);
  for (const p of inst.players.values()) if (!p.veh && !p.linkdeadAt) probe(p.phys.x, p.phys.z, p.phys.y, true);
  for (const n of inst.npcs.values()) if (isPed(n)) probe(n.x, n.z, n.y, true);
  // overtake on the left (lateral offset eases toward 3 m left while something blocks the centre line)
  if (carAhead < range) st.passUntil = inst.now + 1500;
  const want = (st.passUntil ?? 0) > inst.now ? 3 : 0;
  if (carAhead < 6 && (ai.lane ?? 0) > 2.5) vt = Math.min(vt, 4); // both corridors busy: creep
  ai.lane = (ai.lane ?? 0) + Math.max(-2 * dt, Math.min(2 * dt, want - (ai.lane ?? 0)));
  if (personAhead < range) {
    // brake for people; after 2 s of waiting, creep on with the horn (they step aside)
    ai.stuckFor = personAhead < 7 ? (ai.stuckFor ?? 0) + dt : 0;
    vt = Math.min(vt, (ai.stuckFor ?? 0) > 2 ? 3 : personAhead < 7 ? 0 : Math.sqrt(2 * 6 * (personAhead - 7)));
    if ((ai.stuckFor ?? 0) > 2 && (!ai.hornAt || inst.now - ai.hornAt > 3000)) honk(u, inst.now);
  } else ai.stuckFor = 0;
  // own speed state: contact pushes from instance collisions must not stall the pursuit
  const vnew = Math.max(0, v0 + Math.max(-16 * dt, Math.min(9 * dt, vt - v0)));
  st.v = vnew; u.phys.speed = vnew;
  const s = st.along + vnew * dt;
  const p = at(s), q = at(s + 4);
  let tx = q.x - p.x, tz = q.z - p.z; const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
  const off = ai.lane ?? 0; // metres to the left of the centre line
  const x = p.x + tz * off, z = p.z - tx * off;
  const yaw = Math.atan2(-tx, -tz);
  u.phys.steer = Math.max(-1, Math.min(1, angleDiff(yaw, u.phys.yaw) * 3));
  u.phys.yaw += Math.max(-4 * dt, Math.min(4 * dt, angleDiff(yaw, u.phys.yaw)));
  const gy = voxels.groundY(x, z, u.phys.y + 2.2);
  u.phys.x = x; u.phys.z = z;
  if (Math.abs(gy - u.phys.y) <= 3) u.phys.y += (gy - u.phys.y) * Math.min(1, 10 * dt);
  u.phys.vy = 0; u.phys.onGround = true;
  st.along = s;
  u.input = { th: 1, st: u.phys.steer, hb: false };
  return true;
}

// ───────────────────────────────────────────────────────────── pedestrians
export function trySpawnPedLeonia(inst: Instance, p: { phys: { x: number; z: number } }, room: number): number {
  const nav = N(), g = G();
  const spot = nav.randomWalkSpot(p.phys.x, p.phys.z, 9, 114);
  if (!spot || tooClose(inst, spot.x, spot.z, 6)) return 0;
  const f = footing(spot.x, spot.z);
  if (f === null) return 0;
  if (spot.edge !== undefined && g.eFlags[spot.edge] & GF.BRIDGE && g.isCar(spot.edge)) return 0; // no sidewalk walking on bridge parapets
  const zone = nav.zoneAt(spot.x, spot.z);
  let kind: string;
  switch (spot.kind) {
    case 'beach': kind = pickW(nav.coastDist(spot.x, spot.z) <= 3 ? SHORE_TBL : BEACH_TBL); break;
    case 'pier': kind = pickW(SHORE_TBL); break;
    case 'park': kind = pickW(zone === 'downtown' ? FREE_TBL.urban! : FREE_TBL[zone] ?? FREE_TBL.suburb!); break;
    default: kind = pickW(URBAN_TBL[zone] ?? FREE_TBL[zone] ?? URBAN_TBL.urban!);
  }
  const P = PROF[kind] ?? PROF[''];
  const size = Math.min(room, groupSize(P));
  const walk = spot.edge !== undefined;
  const lead = makePed(inst, kind, spot.x, f, spot.z, walk ? 'walk' : 'wander');
  if (walk) {
    const e = EXT.get(lead)!;
    e.we = spot.edge; e.ws = spot.s; e.wd = Math.random() < 0.5 ? 1 : -1; e.wside = spot.side ?? 0;
  }
  addFollowers(inst, lead, kind, size);
  maybeDog(inst, lead, kind);
  return size;
}

/** pick the next walkable edge at node `node`, arriving from edge `from` */
function nextWalk(node: number, from: number, x: number, z: number): { e: number; d: 1 | -1; side: number } | null {
  const nav = N(), g = G();
  const opts: { e: number; d: 1 | -1 }[] = [];
  let back: { e: number; d: 1 | -1 } | null = null;
  for (let k = g.adjStart[node]; k < g.adjStart[node + 1]; k++) {
    const e = g.adjE[k], d = g.adjD[k] as 1 | -1;
    if (!nav.walkable(e) || (g.isCar(e) && g.eFlags[e] & GF.BRIDGE) || g.eFlags[e] & GF.PRIVATE) continue;
    if (e === from) { back = { e, d }; continue; }
    opts.push({ e, d });
  }
  const pick = opts.length ? opts[Math.floor(Math.random() * opts.length)] : back;
  if (!pick) return null;
  if (!g.isCar(pick.e)) return { ...pick, side: 0 };
  // keep to the same side of the street (no crossing) unless we choose to cross
  const s0 = pick.d > 0 ? 0 : g.eLen[pick.e];
  const a = nav.walkPoint(pick.e, s0, 1), b = nav.walkPoint(pick.e, s0, -1);
  let side = Math.hypot(a.x - x, a.z - z) <= Math.hypot(b.x - x, b.z - z) ? 1 : -1;
  if (Math.random() < 0.18) side = -side;
  return { ...pick, side };
}

export function stepWalker(inst: Instance, n: NpcEnt, e: Ext, P: Prof, dt: number, now: number, fleeing: boolean) {
  const nav = N(), g = G();
  const b = n.brain;
  if (e.sitUntil > now && !fleeing) { n.anim = 5; return; }
  if (b.pauseUntil && now < b.pauseUntil && !fleeing) { n.anim = 0; return; }
  const sp = n.speed * (fleeing ? (P.run ? 1.4 : 3) : 1);
  // transition (crossing / corner): walk straight to the start of the next sidewalk line
  if (e.hasT) {
    const dx = e.tx - n.x, dz = e.tz - n.z, d = Math.hypot(dx, dz);
    if (d < 0.4) { e.hasT = false; }
    else {
      const st = Math.min(d, sp * dt);
      n.x += (dx / d) * st; n.z += (dz / d) * st; n.yaw = Math.atan2(-dx, -dz); n.anim = fleeing || P.run ? 2 : 1;
      return;
    }
  }
  const ed = e.we!, L = g.eLen[ed];
  e.ws! += e.wd! * sp * dt;
  if (e.ws! < 0 || e.ws! > L) {
    const node = e.wd! > 0 ? g.eB[ed] : g.eA[ed];
    const nx = nextWalk(node, ed, n.x, n.z);
    if (!nx) { inst.npcs.delete(n.id); return; }
    e.we = nx.e; e.wd = nx.d; e.wside = nx.side; e.ws = nx.d > 0 ? 0.01 : g.eLen[nx.e] - 0.01;
    const q = nav.walkPoint(nx.e, e.ws, nx.side);
    if (Math.hypot(q.x - n.x, q.z - n.z) > 1.2) { e.tx = q.x; e.tz = q.z; e.hasT = true; }
    // pauses at corners (window shopping, waiting at the lights)
    if (!fleeing && Math.random() < P.pause * 0.6) {
      b.pauseUntil = now + rnd(P.pauseMs[0], P.pauseMs[1]) * 0.6;
      if (Math.random() < P.sit * 0.5) e.sitUntil = b.pauseUntil;
    }
    return;
  }
  const q = nav.walkPoint(ed, e.ws!, e.wside!);
  const dx = q.x - n.x, dz = q.z - n.z;
  if (dx * dx + dz * dz > 1e-6) n.yaw = Math.atan2(-dx, -dz);
  n.x = q.x; n.z = q.z;
  e.ck += sp * dt;
  if (e.ck > 2.5) { e.ck = 0; const f = footing(n.x, n.z); n.y = f !== null && Math.abs(f - q.y) <= 1.5 ? f : q.y; }
  n.anim = fleeing || P.run ? 2 : 1;
}

// ───────────────────────────────────────────────────────────── wildlife
export function trySpawnAnimalLeonia(inst: Instance, p: { phys: { x: number; z: number } }) {
  const nav = N();
  const ang = Math.random() * Math.PI * 2, d = 35 + Math.random() * 95;
  const x = p.phys.x + Math.cos(ang) * d, z = p.phys.z + Math.sin(ang) * d;
  if (!nav.inBounds(x, z) || tooClose(inst, x, z, 22)) return;
  const room = (k: string) => countKind(inst, k) < APROF[k].max;
  const water = nav.isWater(x, z);
  const kind = nav.walkKindAt(x, z);
  const zone = nav.zoneAt(x, z);
  const coast = nav.coastDist(x, z);
  if (!water && (zone === 'wetland' || zone === 'forest')) {
    const k = pickW([['gator', zone === 'wetland' ? 30 : 6], ['heron', 35], ['egret', 35]] as const);
    if (!room(k)) return;
    const f = footing(x, z), sw = k === 'gator' ? shallowWater(x, z) : null;
    if (f !== null) makeAnimal(inst, k, x, f, z); else if (sw !== null) makeAnimal(inst, k, x, sw, z);
    return;
  }
  if (water) {
    if (coast < -14 && coast > -40 && room('dolphin') && Math.random() < 0.35) {
      const R = 9;
      let ok = true;
      for (let k = 0; k < 4 && ok; k++) ok = nav.isWater(x + Math.cos(k * 1.571) * R, z + Math.sin(k * 1.571) * R);
      if (ok) { const a = makeAnimal(inst, 'dolphin', x, 20.85, z); const ax = AEXT.get(a)!; ax.cx = x; ax.cz = z; ax.rad = R * 0.8; }
      return;
    }
    if (coast > -14) {
      const f = footing(x, z); // pier / dock
      if (f !== null && room('pelican')) makeAnimal(inst, 'pelican', x, f, z);
      else if (room('gull') && Math.random() < 0.6) { const a = makeAnimal(inst, 'gull', x, 30, z); a.y = 22 + rnd(9, 20); }
    }
    return;
  }
  if (kind === 'beach' || kind === 'pier') {
    if (room('gull') && Math.random() < 0.55) { const a = makeAnimal(inst, 'gull', x, 30, z); a.y = 22 + rnd(9, 20); return; }
    const f = footing(x, z);
    if (f !== null && room('pelican')) makeAnimal(inst, 'pelican', x, f, z);
    return;
  }
  if (kind === 'park') {
    const f = footing(x, z);
    if (f === null) return;
    const k = coast < 16 ? pickW([['heron', 40], ['egret', 45], ['pelican', 15]] as const) : 'egret';
    if (room(k) && (coast < 16 || Math.random() < 0.4)) makeAnimal(inst, k, x, f, z);
    return;
  }
  if (coast < 10 && room('gull') && Math.random() < 0.3) { const a = makeAnimal(inst, 'gull', x, 30, z); a.y = 22 + rnd(9, 20); }
}

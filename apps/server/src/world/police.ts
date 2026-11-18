/**
 * Wanted + pursuit. A wanted record is owned by one player (free roam) or by an
 * activity crew (shared). Police units only hunt the owners of a wanted record —
 * bystanders are never flagged.
 *
 * Escape: stay unseen for `escapeSeconds(level)` while outside the search area
 * around the last known position (or twice as long anywhere).
 */
import { raycastVoxels, angleDiff, stepVehicle, stepPlayer, DT, VEHICLES, RC, gridWaypoint as navGridWaypoint } from '@blockshore/shared';
import { voxels } from './voxels.ts';
import { streetOk, hostileShoot } from './npc.ts';
import { nav, leoniaNav } from './nav.ts';
import { driveRouteLeonia } from './npcLeonia.ts';
import type { Instance } from './instance.ts';
import type { PlayerEnt, VehicleEnt, Wanted } from './entities.ts';

const G = 48; // Palmara grid (unit spawn snapping)
export const searchRadius = (lvl: number) => 60 + lvl * 35;
export const escapeSeconds = (lvl: number) => 6 + lvl * 4;
const SIGHT = 55;

export interface WantedOwner { key: string; wanted: Wanted; targets: PlayerEnt[] }

export function policeTick(inst: Instance, dt: number, owners: WantedOwner[], jammer: boolean) {
  const now = inst.now;
  const units = [...inst.vehicles.values()].filter((v) => v.ai?.kind === 'police');
  const active = new Set(owners.map((o) => o.key));
  // retire units whose owner is no longer wanted
  for (const u of units) {
    if (!active.has(u.ai!.owner!) && u.occ.every((o) => !o)) {
      const far = inst.activePlayers().every((p) => (p.phys.x - u.phys.x) ** 2 + (p.phys.z - u.phys.z) ** 2 > 90 * 90);
      if (far || now - u.idleSince > 25000) { inst.removeVehicle(u.id); continue; }
      u.siren = false;
      u.input = { th: 0, st: 0, hb: true };
    }
  }
  for (const n of [...inst.npcs.values()]) if (n.role === 'cop' && !active.has(n.brain.owner!)) inst.npcs.delete(n.id);

  for (const o of owners) {
    const w = o.wanted;
    const mine = units.filter((u) => u.ai!.owner === o.key && u.destroyedAt === 0);
    const want = Math.min(6, w.level * 2);
    if (mine.length < want && Math.random() < (jammer ? 0.02 : 0.05)) spawnUnit(inst, o);
    // line of sight from every unit and on-foot officer
    let seen = false;
    const eyes = [...mine.map((u) => ({ x: u.phys.x, y: u.phys.y + 1.4, z: u.phys.z })), ...[...inst.npcs.values()].filter((n) => n.role === 'cop' && n.brain.owner === o.key).map((n) => ({ x: n.x, y: n.y + 1.6, z: n.z }))];
    for (const t of o.targets) {
      if (t.downUntil || t.linkdeadAt) continue;
      for (const e of eyes) {
        const dx = t.phys.x - e.x, dy = t.phys.y + 1 - e.y, dz = t.phys.z - e.z;
        const d = Math.hypot(dx, dy, dz);
        if (d > SIGHT) continue;
        if (raycastVoxels(voxels, e.x, e.y, e.z, dx / d, dy / d, dz / d, d) < d - 1.5) continue;
        seen = true;
        w.lastKnown = { x: t.phys.x, z: t.phys.z };
        w.lastSeenAt = now;
        break;
      }
    }
    void seen;
    // drive units
    for (const u of mine) driveUnit(inst, u, o, dt);
    // officers on foot
    for (const n of inst.npcs.values()) {
      if (n.role !== 'cop' || n.brain.owner !== o.key) continue;
      if (n.stunnedUntil > now) { n.anim = 6; continue; }
      const t = nearestTarget(o.targets, n.x, n.z);
      if (!t) continue;
      const dx = t.phys.x - n.x, dz = t.phys.z - n.z, d = Math.hypot(dx, dz);
      n.yaw = Math.atan2(-dx, -dz);
      if (d > 1.6) {
        const ph = n.phys!;
        stepPlayer(ph, { mx: 0, mz: 1, yaw: n.yaw, jump: false, sprint: d > 4 }, DT, voxels);
        n.x = ph.x; n.y = ph.y; n.z = ph.z; n.anim = d > 4 ? 2 : 1;
        if (ph.vx === 0 && ph.vz === 0 && ph.onGround) ph.vy = 8; // hop obstacles
      } else n.anim = 8;
      if (o.wanted.level >= 2) hostileShoot(inst, n, 22, 1000, 5);
      else if (d < 3.2 && !t.veh) inst.damagePlayer(t, 22 * dt, 'police');
      if (d > 120) inst.npcs.delete(n.id);
    }
  }
}

function nearestTarget(ts: PlayerEnt[], x: number, z: number): PlayerEnt | null {
  let best: PlayerEnt | null = null, bd = Infinity;
  for (const t of ts) {
    if (t.downUntil || t.linkdeadAt) continue;
    const d = (t.phys.x - x) ** 2 + (t.phys.z - z) ** 2;
    if (d < bd) { bd = d; best = t; }
  }
  return best;
}

function spawnUnit(inst: Instance, o: WantedOwner) {
  const c = o.wanted.lastKnown;
  if (leoniaNav) {
    // real roads: a lane 70–110 m out, facing toward the search area
    for (let tries = 0; tries < 4; tries++) {
      const sp = leoniaNav.randomLaneNear(c.x, c.z, 70, 110, { toward: c, minClass: RC.PRIMARY, maxClass: RC.RESIDENTIAL, noBridge: true });
      if (!sp) continue;
      if (inst.activePlayers().some((p) => (p.phys.x - sp.x) ** 2 + (p.phys.z - sp.z) ** 2 < 45 * 45)) continue;
      if ([...inst.vehicles.values()].some((v) => (v.phys.x - sp.x) ** 2 + (v.phys.z - sp.z) ** 2 < 36)) continue;
      const v = inst.spawnVehicle('police', sp.x, sp.y, sp.z, sp.yaw, { color: 0xf6f7f8 });
      v.ai = { kind: 'police', owner: o.key, stuckFor: 0, lastPos: { x: sp.x, z: sp.z }, nav: {} };
      v.siren = true;
      v.idleSince = inst.now;
      return;
    }
    return;
  }
  for (let tries = 0; tries < 8; tries++) {
    const ang = Math.random() * Math.PI * 2, d = 70 + Math.random() * 40;
    const ix = Math.round((c.x + Math.cos(ang) * d) / G) * G, iz = Math.round((c.z + Math.sin(ang) * d) / G) * G;
    if (!streetOk(ix, iz)) continue;
    if (inst.activePlayers().some((p) => (p.phys.x - ix) ** 2 + (p.phys.z - iz) ** 2 < 45 * 45)) continue;
    const yaw = Math.atan2(-(c.x - ix), -(c.z - iz));
    const v = inst.spawnVehicle('police', ix, 22, iz, yaw, { color: 0xf6f7f8 });
    v.ai = { kind: 'police', owner: o.key, stuckFor: 0, lastPos: { x: ix, z: iz } };
    v.siren = true;
    v.idleSince = inst.now;
    return;
  }
}

function driveUnit(inst: Instance, u: VehicleEnt, o: WantedOwner, dt: number) {
  const ai = u.ai!;
  u.siren = true;
  const t = nearestTarget(o.targets, u.phys.x, u.phys.z);
  const goal = t && inst.now - o.wanted.lastSeenAt < 4000 ? { x: t.phys.x, z: t.phys.z } : o.wanted.lastKnown;
  const d = Math.hypot(goal.x - u.phys.x, goal.z - u.phys.z);
  // Leonia: far from the goal the unit runs its A* route along the streets; physics takes over near the goal
  if (leoniaNav && d > 25 && driveRouteLeonia(inst, u, goal, dt)) { ai.lastPos = { x: u.phys.x, z: u.phys.z }; return; }
  if (ai.nav) ai.nav.v = undefined; // physics owns the speed now
  let wp = goal;
  if (d > 30) wp = nav.pursuitWaypoint((ai.nav ??= {}), u.phys.x, u.phys.z, goal.x, goal.z, inst.now); // Palmara: grid; Leonia: A* on the road graph
  const want = Math.atan2(-(wp.x - u.phys.x), -(wp.z - u.phys.z));
  const diff = angleDiff(want, u.phys.yaw);
  let th = Math.abs(diff) > 1.2 ? 0.4 : 1;
  const vmax = (wp as { vmax?: number }).vmax;
  if (vmax !== undefined) { if (u.phys.speed > vmax + 2) th = -1; else if (u.phys.speed > vmax) th = 0; } // graph routes: brake for bends
  if (d < 12 && t && !t.veh) th = 0; // stop and let the officer out
  // stuck recovery: reverse briefly
  const moved = Math.hypot(u.phys.x - ai.lastPos!.x, u.phys.z - ai.lastPos!.z);
  ai.lastPos = { x: u.phys.x, z: u.phys.z };
  ai.stuckFor = moved < 0.05 && th > 0 ? (ai.stuckFor ?? 0) + dt : Math.max(0, (ai.stuckFor ?? 0) - dt);
  if ((ai.stuckFor ?? 0) > 1.2) { th = -1; if (ai.stuckFor! > 2.5) ai.stuckFor = 0; }
  u.input = { th, st: Math.max(-1, Math.min(1, -diff * 1.6)) * (th < 0 ? -1 : 1), hb: false };
  stepVehicle(u.phys, u.input, dt, voxels, VEHICLES.police, inst.doorColliders());
  if (u.phys.impact > 8) inst.damageVehicle(u, (u.phys.impact - 8) * 6, null);
  // deploy an officer when close to an on-foot target
  if (t && !t.veh && d < 14 && !ai.officerSpawned) {
    ai.officerSpawned = true;
    const id = inst.nextId('n');
    inst.npcs.set(id, {
      id, role: 'cop', label: 'cop', name: 'Officer', x: u.phys.x + 2, y: u.phys.y, z: u.phys.z, yaw: u.phys.yaw, anim: 2, skin: 13,
      stunnedUntil: 0, downUntil: 0, alert: 1, activityKey: null, speed: 5, brain: { owner: o.key },
      phys: { x: u.phys.x + 2, y: u.phys.y, z: u.phys.z, vx: 0, vy: 0, vz: 0, onGround: true, inWater: false },
    });
  }
}

/** Manhattan routing on the Palmara city grid (kept for callers; implementation lives in WorldNav). */
export const gridWaypoint = navGridWaypoint;

/** Advance escape logic; returns true when the wanted level should clear. */
export function wantedEscaped(w: Wanted, targets: PlayerEnt[], now: number): boolean {
  const unseen = (now - w.lastSeenAt) / 1000;
  const need = escapeSeconds(w.level);
  const r = searchRadius(w.level);
  const allOutside = targets.every((t) => t.linkdeadAt || (t.phys.x - w.lastKnown.x) ** 2 + (t.phys.z - w.lastKnown.z) ** 2 > r * r);
  return (allOutside && unseen > need) || unseen > need * 2.2;
}

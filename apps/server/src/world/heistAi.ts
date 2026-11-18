/**
 * Heist-only NPC behaviour layered on top of the stealth guards in npc.ts:
 *  - response-team "enforcers" that hunt the crew once the alarm is up (move + return fire),
 *  - guard chatter: muttering on patrol, a shout when they get suspicious, a shout when the alarm trips.
 * Called from ActivityRun.tick (apps/server/src/activities/runner.ts) before guardTick.
 */
import { isSolid } from '@blockshore/shared';
import { voxels } from './voxels.ts';
import { hostileShoot } from './npc.ts';
import type { Instance } from './instance.ts';
import type { NpcEnt, PlayerEnt } from './entities.ts';

export interface GuardMem { nextChat: number; suspicious: boolean; shouted: boolean }
export type Say = (to: PlayerEnt[], speaker: string, text: string) => void;

const PATROL = [
  'Quiet night. I hate quiet nights.',
  'Twelve more laps of this corridor and I can afford a sandwich.',
  'Who keeps leaving the back door on the latch? Every single night.',
  'If the boss asks, I checked that room. I did not check that room.',
  'My feet hurt. My feet always hurt on Thursdays.',
  'Supposed to be two of us on this shift. Budget cuts, they said.',
  'I swear that camera moved on its own.',
  'Four years of training and I guard a hallway.',
  'Radio check. Nothing. Of course nothing.',
  'Did somebody eat my yoghurt? Somebody ate my yoghurt.',
];
const SUSPICIOUS = ['Hello? Who is there?', 'Did you hear that?', 'Hey - you! Stop right there.', 'Something is not right here...', 'Show yourself!'];
const ALARM = ['Alarm! We have intruders!', 'Hands where I can see them!', 'They are inside! Lock it down!', 'Get down! Get down!', 'Call it in, call it in!'];
const ENFORCER = ['Response team, moving in!', 'Contact! Contact!', 'Flank them!', 'Drop the bags and nobody gets hurt!'];
const pick = (a: string[]) => a[Math.floor(Math.random() * a.length)];

function walkable(x: number, y: number, z: number): boolean {
  const bx = Math.floor(x), bz = Math.floor(z), by = Math.floor(y + 0.01);
  return isSolid(voxels.getBlock(bx, by - 1, bz)) && !isSolid(voxels.getBlock(bx, by, bz)) && !isSolid(voxels.getBlock(bx, by + 1, bz));
}

export function heistAiTick(inst: Instance, dt: number, alarm: boolean, crew: PlayerEnt[], mem: Map<string, GuardMem>, say: Say, opts: { hard: boolean; disguised: boolean }) {
  const now = inst.now;
  const live = crew.filter((p) => !p.linkdeadAt && !p.downUntil);
  for (const n of inst.npcs.values()) {
    if (n.role !== 'guard') continue;
    let m = mem.get(n.id);
    if (!m) { m = { nextChat: now + 6000 + Math.random() * 12000, suspicious: false, shouted: false }; mem.set(n.id, m); }
    if (n.stunnedUntil > now || n.downUntil > now) continue;
    const near = (r: number) => live.filter((p) => Math.hypot(p.phys.x - n.x, p.phys.z - n.z) < r);
    const speaker = n.name ?? 'Guard';
    if (alarm) {
      if (!m.shouted) { m.shouted = true; const to = near(24); if (to.length) say(to, speaker, n.label === 'enforcer' ? pick(ENFORCER) : pick(ALARM)); }
      if (n.label === 'enforcer') hunt(inst, n, live, dt, opts.hard);
      continue;
    }
    // suspicion shout (alert climbs in guardTick); disguised crews are ignored
    if (!opts.disguised && n.alert >= 0.5 && !m.suspicious) { m.suspicious = true; const to = near(18); if (to.length) say(to, speaker, pick(SUSPICIOUS)); }
    if (n.alert < 0.1) m.suspicious = false;
    if (now >= m.nextChat) {
      const to = near(13);
      if (to.length && n.alert < 0.3) { say(to, speaker, opts.disguised ? pick(['Evening. You lot new?', 'Mind the wet floor.', 'Night shift, huh. Welcome to the club.', 'Paperwork is in the office. Good luck finding it.']) : pick(PATROL)); m.nextChat = now + 24000 + Math.random() * 16000; }
      else m.nextChat = now + 3000;
    }
  }
}

/** enforcers close in on the nearest crew member and shoot (non-graphic: players are knocked out at 0 hp) */
function hunt(inst: Instance, n: NpcEnt, crew: PlayerEnt[], dt: number, hard: boolean) {
  let best: PlayerEnt | null = null, bd = 45;
  for (const p of crew) { const d = Math.hypot(p.phys.x - n.x, p.phys.z - n.z); if (d < bd) { bd = d; best = p; } }
  if (!best) return;
  if (bd > 7) {
    const dx = best.phys.x - n.x, dz = best.phys.z - n.z, step = Math.min(bd - 7, 3.2 * dt);
    const nx = n.x + (dx / bd) * step, nz = n.z + (dz / bd) * step;
    if (walkable(nx, n.y, nz)) { n.x = nx; n.z = nz; }
    else if (walkable(nx, n.y, n.z)) n.x = nx;
    else if (walkable(n.x, n.y, nz)) n.z = nz;
    n.yaw = Math.atan2(-dx, -dz); n.anim = 2;
  }
  hostileShoot(inst, n, 22, hard ? 850 : 1050, hard ? 9 : 7);
}

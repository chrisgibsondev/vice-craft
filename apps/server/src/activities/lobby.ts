/**
 * Pre-launch lobby: briefing, eligibility, heist planning board (approach / difficulty / equipment /
 * roles / payout split, setup checklist with choices) and the ready check. Heist setup lobbies carry
 * the setup's choice. Any change to agreed terms clears everyone's ready flag, and terms are frozen
 * into the run at launch.
 */
import {
  ACTIVITY_BY_ID, CONTACTS, condHolds, setupChoices, setupsDone,
  type ActivityDef, type LobbyView, type Role, type Approach, type Difficulty, type HeistBoardView,
} from '@blockshore/shared';
import type { Profile } from '../store.ts';
import type { Eligibility } from './runner.ts';

export interface LobbyMember { userId: string; name: string; ready: boolean; role: Role; eligibility: Eligibility; connected: boolean; busy: string | null }

const APPROACH_NAME: Record<Approach, string> = { quiet: 'Quiet (stealth)', loud: 'Loud (smash & grab)', con: 'Con (disguises)' };
export const MAX_EQUIPMENT = 3;

export class Lobby {
  readonly def: ActivityDef;
  readonly members = new Map<string, LobbyMember>();
  approach: Approach = 'quiet';
  difficulty: Difficulty = 'normal';
  equipment: string[] = [];
  split: Record<string, number> = {};
  /** heist setup lobbies: the picked option of the setup's choice */
  choice = '';
  resumeStage = 0;
  readonly createdAt = Date.now();
  constructor(readonly key: string, activityId: string, public leader: string) {
    this.def = ACTIVITY_BY_ID[activityId];
    const ch = this.setupDef()?.choice;
    if (ch) this.choice = ch.options[0].id;
  }

  /** for a setup lobby: the heist it counts towards and its SetupDef */
  heistOfSetup() { return this.def.prepFor ? ACTIVITY_BY_ID[this.def.prepFor] : undefined; }
  setupDef() { return this.heistOfSetup()?.heist?.setups.find((s) => s.prep === this.def.id); }

  setMember(m: LobbyMember) {
    const prev = this.members.get(m.userId);
    this.members.set(m.userId, { ...m, ready: prev?.ready ?? false, role: prev?.role ?? 'none' });
    this.rebalance();
  }
  removeMember(userId: string) { this.members.delete(userId); this.rebalance(); }

  private rebalance() {
    const ids = [...this.members.keys()];
    const known = ids.every((id) => id in this.split) && Object.keys(this.split).length === ids.length;
    if (!known) {
      this.split = {};
      const even = Math.floor(100 / Math.max(1, ids.length));
      ids.forEach((id, i) => (this.split[id] = i === 0 ? 100 - even * (ids.length - 1) : even));
    }
    this.unreadyAll();
  }

  unreadyAll() { for (const m of this.members.values()) m.ready = false; }

  /** why an approach cannot be picked (setup missing), or null */
  approachLock(a: Approach, leaderProfile: Profile | null): string | null {
    const h = this.def.heist;
    const need = h?.approachNeeds?.[a];
    if (!need) return null;
    const done = setupsDone(leaderProfile?.preps[this.def.id]);
    return done.includes(need) ? null : `Needs the setup "${ACTIVITY_BY_ID[need]?.name.replace(/^.*?: /, '') ?? need}"`;
  }

  configure(userId: string, cfg: { approach?: Approach; equipment?: string[]; split?: Record<string, number>; difficulty?: Difficulty; choice?: string }, leaderProfile: Profile | null = null): string | null {
    if (userId !== this.leader) return 'Only the leader can change the plan.';
    const h = this.def.heist;
    if (cfg.approach) {
      if (!h || !h.approaches.includes(cfg.approach)) return 'Invalid approach.';
      const lock = this.approachLock(cfg.approach, leaderProfile);
      if (lock) return `${APPROACH_NAME[cfg.approach]}: ${lock}.`;
      this.approach = cfg.approach;
      this.equipment = this.equipment.filter((e) => { const d = h.equipment.find((x) => x.id === e); return !d?.approach || d.approach === this.approach; });
    }
    if (cfg.difficulty) {
      if (!h) return 'Difficulty is only for heist finales.';
      this.difficulty = cfg.difficulty;
    }
    if (cfg.choice) {
      const ch = this.setupDef()?.choice;
      if (!ch || !ch.options.some((o) => o.id === cfg.choice)) return 'Invalid choice.';
      this.choice = cfg.choice;
    }
    if (cfg.equipment) {
      if (!h) return 'No equipment for this activity.';
      const ok = cfg.equipment.filter((e, i, a) => a.indexOf(e) === i && h.equipment.some((x) => x.id === e && (!x.approach || x.approach === this.approach)));
      if (ok.length > MAX_EQUIPMENT) return `Pick at most ${MAX_EQUIPMENT} pieces of equipment.`;
      this.equipment = ok;
    }
    if (cfg.split) {
      const ids = [...this.members.keys()];
      const vals = ids.map((id) => cfg.split![id] ?? 0);
      if (vals.reduce((a, b) => a + b, 0) !== 100) return 'The split must add up to 100%.';
      if (ids.length > 1 && vals.some((v) => v < 10)) return 'Everyone gets at least 10%.';
      this.split = Object.fromEntries(ids.map((id, i) => [id, vals[i]]));
    }
    // agreed terms changed → everyone must confirm again
    this.unreadyAll();
    return null;
  }

  setRole(userId: string, role: Role): string | null {
    const m = this.members.get(userId);
    if (!m) return 'Not in this lobby.';
    if (role !== 'none' && !this.def.heist?.roles.includes(role)) return 'Role not available here.';
    if (role !== 'none' && [...this.members.values()].some((x) => x.userId !== userId && x.role === role)) return 'Someone already has that role.';
    m.role = role;
    return null;
  }

  blockers(leaderProfile: Profile | null): string[] {
    const out: string[] = [];
    const def = this.def;
    if (leaderProfile && !isUnlocked(def, leaderProfile)) out.push(`The leader hasn't unlocked ${def.name}.`);
    if (def.heist && leaderProfile) {
      const done = setupsDone(leaderProfile.preps[def.id]);
      const missing = def.heist.setups.filter((s) => !s.optional && !done.includes(s.prep)).map((s) => ACTIVITY_BY_ID[s.prep]?.name.replace(/^.*?: /, '') ?? s.prep);
      if (missing.length) out.push(`Required setups still to do: ${missing.join(', ')}.`);
      const lock = this.approachLock(this.approach, leaderProfile);
      if (lock) out.push(`${APPROACH_NAME[this.approach]}: ${lock}.`);
    } else if (def.preps && leaderProfile) {
      const done = leaderProfile.preps[def.id] ?? [];
      const missing = def.preps.filter((p) => !done.includes(p)).map((p) => ACTIVITY_BY_ID[p]?.name ?? p);
      if (missing.length) out.push(`Preps still needed: ${missing.join(', ')}.`);
    }
    const members = [...this.members.values()];
    if (members.length > def.maxPlayers) out.push(`Too many players (max ${def.maxPlayers}).`);
    for (const m of members) {
      if (!m.connected) out.push(`${m.name} is offline.`);
      else if (m.busy) out.push(`${m.name} is busy (${m.busy}).`);
      else if (!m.ready && m.userId !== this.leader) out.push(`Waiting for ${m.name} to ready up.`);
    }
    return out;
  }

  /** the most loot this plan can grab with this crew (everything spawned on the stages the plan will run) */
  potentialLoot(leaderProfile: Profile | null): number {
    const ctx = { approach: this.approach, difficulty: this.difficulty, choices: this.choicesOf(leaderProfile), setups: setupsDone(leaderProfile?.preps[this.def.id]), crew: Math.max(1, this.members.size) };
    let total = 0;
    for (const s of this.def.stages) {
      if (s.when && !condHolds(s.when, ctx)) continue;
      if (s.when?.alarm === true || s.when?.wanted === true) continue;
      for (const sp of s.spawn ?? []) {
        if (sp.kind !== 'object' || !sp.value) continue;
        if (sp.minParty && ctx.crew < sp.minParty) continue;
        if (sp.hard && this.difficulty !== 'hard') continue;
        if (!condHolds(sp.if, ctx)) continue;
        total += sp.value;
      }
    }
    return total;
  }

  choicesOf(leaderProfile: Profile | null): Record<string, string> {
    const out = setupChoices(leaderProfile?.preps[this.def.id]);
    for (const s of this.def.heist?.setups ?? []) if (s.choice && !out[s.choice.key]) out[s.choice.key] = s.choice.options[0].id;
    return out;
  }

  estimate(leaderProfile: Profile | null) {
    const h = this.def.heist!;
    const base = h.baseTake;
    const loot = this.potentialLoot(leaderProfile);
    const mult = (this.approach === 'loud' ? h.loudPenalty : 1) * (this.difficulty === 'hard' ? (h.hardMult ?? 1.25) : 1);
    const total = Math.round((base + loot) * mult);
    const perMember = Object.fromEntries([...this.members.keys()].map((id) => [id, Math.round((total * (this.split[id] ?? 0)) / 100)]));
    return { base, loot, mult, total, perMember };
  }

  boardView(leaderProfile: Profile | null): HeistBoardView | undefined {
    const h = this.def.heist;
    if (!h) return undefined;
    const done = setupsDone(leaderProfile?.preps[this.def.id]);
    const choices = setupChoices(leaderProfile?.preps[this.def.id]);
    return {
      difficulty: this.difficulty,
      setups: h.setups.map((s) => {
        const picked = s.choice ? choices[s.choice.key] : undefined;
        return {
          id: s.prep, name: ACTIVITY_BY_ID[s.prep]?.name.replace(/^.*?: /, '') ?? s.prep, category: s.category, optional: !!s.optional, done: done.includes(s.prep), perk: s.perk,
          choice: s.choice ? { key: s.choice.key, label: s.choice.label, picked, pickedName: s.choice.options.find((o) => o.id === picked)?.name } : undefined,
        };
      }),
      approaches: h.approaches.map((a) => ({ id: a, name: APPROACH_NAME[a], locked: this.approachLock(a, leaderProfile) ?? undefined })),
      estimate: this.estimate(leaderProfile),
      bonuses: { firstTime: h.firstTimeBonus, firstTimers: [...this.members.values()].filter((m) => m.eligibility === 'story').map((m) => m.userId), elite: { label: h.elite.label, bonus: h.elite.bonus } },
      lives: this.difficulty === 'hard' ? h.hardLives[Math.max(1, Math.min(4, this.members.size)) - 1] + h.setups.filter((s) => s.bonus?.lives && done.includes(s.prep)).reduce((a, s) => a + (s.bonus!.lives ?? 0), 0) : null,
      hardMult: h.hardMult ?? 1.25,
    };
  }

  payoutLines(leaderProfile: Profile | null = null): string[] {
    const d = this.def;
    const n = Math.max(1, this.members.size);
    if (d.kind === 'heist') {
      const h = d.heist!;
      const e = this.estimate(leaderProfile);
      return [
        `Base take $${e.base.toLocaleString()} + up to $${e.loot.toLocaleString()} in bags${this.approach === 'loud' ? `, × ${Math.round(h.loudPenalty * 100)}% (alarm damages goods)` : ''}${this.difficulty === 'hard' ? `, × ${Math.round((h.hardMult ?? 1.25) * 100)}% on Hard` : ''}.`,
        ...[...this.members.values()].map((m) => `${m.name}: ${this.split[m.userId] ?? 0}% (≈ $${(e.perMember[m.userId] ?? 0).toLocaleString()} on a clean run${m.eligibility === 'story' ? ` + $${h.firstTimeBonus.toLocaleString()} first-time bonus` : ''})`),
        `Elite challenge: ${h.elite.label} (+$${h.elite.bonus.toLocaleString()} each).`,
        'Terms lock when the heist launches — the leader can\'t change them mid-job.',
      ];
    }
    if (d.kind === 'minigame' && d.race) return [`Party race: 1st 100% · 2nd 60% · 3rd 40% · 4th 30% of $${d.rewards.cash[n - 1]}`, `Solo: medals vs par ${d.race.parTimes.join(' / ')} s`];
    return [`$${d.rewards.cash[n - 1].toLocaleString()} each on completion · replays $${d.rewards.replayCash.toLocaleString()} · +${d.rewards.rep} rep`];
  }

  view(leaderProfile: Profile | null): LobbyView {
    const blockers = this.blockers(leaderProfile);
    const sd = this.setupDef();
    const heist = this.heistOfSetup();
    return {
      activity: this.def.id, name: this.def.name, kind: this.def.kind, leader: this.leader,
      members: [...this.members.values()].map((m) => ({ userId: m.userId, name: m.name, ready: m.ready || m.userId === this.leader, role: m.role, eligible: eligibilityText(m.eligibility, this.def), connected: m.connected })),
      config: { approach: this.approach, equipment: this.equipment, split: this.split, difficulty: this.difficulty, choice: this.choice || undefined },
      payout: this.payoutLines(leaderProfile),
      canLaunch: blockers.length === 0,
      blockers,
      heist: this.boardView(leaderProfile),
      setup: sd && heist ? { heist: heist.id, heistName: heist.name, optional: !!sd.optional, perk: sd.perk, choice: sd.choice ? { key: sd.choice.key, label: sd.choice.label, picked: this.choice, options: sd.choice.options } : undefined } : undefined,
    };
  }
}

export function isUnlocked(def: ActivityDef, p: Profile): boolean {
  if (p.unlocks.includes(def.id)) return true;
  const req = def.unlock.requires ?? [];
  if (req.length && req.every((r) => (p.completed[r] ?? 0) > 0)) return true;
  if (!req.length && !def.unlock.rep) return true;
  if (def.unlock.rep && p.rep >= def.unlock.rep && req.every((r) => (p.completed[r] ?? 0) > 0)) return true;
  return false;
}

export function eligibilityOf(def: ActivityDef, p: Profile): Eligibility {
  if ((p.completed[def.id] ?? 0) > 0) return 'replay';
  return isUnlocked(def, p) ? 'story' : 'ahead';
}

export function eligibilityText(e: Eligibility, def: ActivityDef): string {
  if (e === 'story') return def.kind === 'mission' ? 'Story progress' : 'Full rewards';
  if (e === 'replay') return 'Replay (reduced cash)';
  return 'Ahead of their story — guest: cash only, possible spoilers';
}

export function contactJobs(contact: string, p: Profile) {
  const c = CONTACTS[contact];
  if (!c) return null;
  const jobs = Object.values(ACTIVITY_BY_ID).filter((a) => a.giver === contact).map((a) => ({
    id: a.id, name: a.name, kind: a.kind, blurb: a.blurb,
    status: ((p.completed[a.id] ?? 0) > 0 && !a.replayable ? 'done' : isUnlocked(a, p) ? 'available' : 'locked') as 'done' | 'available' | 'locked',
  }));
  return { contact, name: c.name, role: c.role, blurb: c.blurb, jobs };
}

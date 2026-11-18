/**
 * Generic, data-driven activity state machine (missions, heist setups, heists, races).
 * Runs inside a private activity instance. All objective progress, timing, scoring,
 * cutscene sync and rewards are decided here — clients only send inputs/requests.
 *
 * Heist extras: the plan (approach / difficulty / setup choices / completed setups / equipment /
 * roles / cuts) is frozen into RunConfig at launch. Loot is carried in per-player bags (dropped when
 * the carrier is knocked out, picked up again), Hard runs have a shared pool of team lives,
 * stages can bring reinforcement waves, and the results carry a full take breakdown, the elite
 * challenge and the first-time bonus. Rewards stay idempotent through store.grantReward.
 */
import {
  ACTIVITY_BY_ID, CUTSCENES, cutsceneDuration, CUTSCENE_LOAD_WAIT_MS, RECONNECT_GRACE_MS, VEHICLES, DT, condHolds,
  type ActivityDef, type StageDef, type ObjectiveDef, type ActivityView, type ObjectiveView, type V3, type Role, type VehicleModel,
  type Approach, type Difficulty, type HeistDef, type DialogueLine, type SpawnDef, type StageEvents, type HeistRunView,
} from '@blockshore/shared';
import { newId } from '../auth.ts';
import { log } from '../log.ts';
import { guardTick, spawnGuard } from '../world/npc.ts';
import { heistAiTick, type GuardMem } from '../world/heistAi.ts';
import type { Instance } from '../world/instance.ts';
import type { NpcEnt, ObjEnt, PlayerEnt, VehicleEnt, Wanted } from '../world/entities.ts';
import type { Game } from '../game.ts';

export type Eligibility = 'story' | 'replay' | 'ahead';

export interface RosterEntry {
  userId: string; name: string; role: Role; eligibility: Eligibility;
  connected: boolean; left: boolean; disconnectedAt: number;
  returnTo: { instance: string | null; pos: { x: number; y: number; z: number } };
}

export interface RunConfig {
  approach: Approach; equipment: string[]; split: Record<string, number>; resumeStage: number;
  difficulty?: Difficulty;
  /** heist finale: the leader's setup choices (key → option) and completed setups, frozen at launch */
  choices?: Record<string, string>; setups?: string[];
  /** heist setup run: the option picked in the setup's lobby */
  choice?: string;
}

interface ObjState { done: boolean; required: number; targets: string[]; first?: number; progress?: number }
interface RaceProg { cp: number; lap: number; finishMs: number | null; lastCpAt: number; vehicle: string | null }
interface Drop { key: string; value: number; x: number; y: number; z: number; at: number }
interface LootSnap { carry: Map<string, number>; drops: Drop[]; lost: number; loot: number; alarm: boolean }

export class ActivityRun {
  readonly id = newId();
  readonly def: ActivityDef;
  readonly roster = new Map<string, RosterEntry>();
  leader: string;
  phase: ActivityView['phase'] = 'starting';
  stageIndex = -1;
  checkpointIndex = 0;
  stageStartedAt = 0;
  timerEndsAt = 0;
  objStates = new Map<string, ObjState>();
  alarm = false;
  /** the alarm went off at any point of this run (take penalty, elite) */
  alarmEver = false;
  wanted: Wanted | null = null;
  /** total value grabbed (bags picked up from targets, not re-pickups) */
  loot = 0;
  lootAtCheckpoint = 0;
  failReason = '';
  readonly size: number;
  readonly difficulty: Difficulty;
  readonly choices: Record<string, string>;
  readonly setups: string[];
  /** Hard: shared knockouts left (null = unlimited) */
  lives: number | null = null;
  livesMax: number | null = null;
  knockouts = 0;
  retries = 0;
  /** carried loot per player */
  carry = new Map<string, number>();
  drops: Drop[] = [];
  /** loot destroyed (damaged when a carrier went down, sank, left behind) */
  lootLost = 0;
  private finalFail = false;
  private snap: LootSnap | null = null;
  private dropSeq = 0;
  private keyed = new Map<string, string>(); // spawn key → entity id
  private cs: { id: string; loaded: Set<string>; votes: Set<string>; deadline: number; startAt: number; endsAt: number } | null = null;
  private race = new Map<string, RaceProg>();
  private raceStartAt = 0;
  private firstFinishAt = 0;
  private completeAt = 0;
  private viewDirty = true;
  private ended = false;
  private dialogueQueue: DialogueLine[] = [];
  private wavesFired = new Set<number>();
  private stageEvents = new Set<string>();
  private lastDownLineAt = 0;
  private guardMem = new Map<string, GuardMem>();
  private replaying = false;
  private lastDt = DT;

  constructor(readonly game: Game, readonly inst: Instance, activityId: string, leader: string, roster: RosterEntry[], readonly config: RunConfig) {
    this.def = ACTIVITY_BY_ID[activityId];
    this.leader = leader;
    for (const r of roster) this.roster.set(r.userId, r);
    this.size = Math.max(1, Math.min(4, roster.length));
    this.difficulty = this.def.kind === 'heist' && config.difficulty === 'hard' ? 'hard' : 'normal';
    this.setups = config.setups ?? [];
    const choices: Record<string, string> = { ...(config.choices ?? {}) };
    const plan = this.planHeist();
    if (this.def.kind === 'heist' && plan) {
      // a setup done before choices existed (or a missing choice) falls back to the first option
      for (const s of plan.setups) if (s.choice && !choices[s.choice.key]) choices[s.choice.key] = s.choice.options[0].id;
    } else if (this.def.kind === 'heist_prep' && plan) {
      const ch = plan.setups.find((s) => s.prep === this.def.id)?.choice;
      if (ch) choices[ch.key] = ch.options.some((o) => o.id === config.choice) ? config.choice! : ch.options[0].id;
    }
    this.choices = choices;
  }

  /** the heist plan this run belongs to (the heist itself, or the heist a setup counts towards) */
  private planHeist(): HeistDef | undefined {
    if (this.def.heist) return this.def.heist;
    return this.def.prepFor ? ACTIVITY_BY_ID[this.def.prepFor]?.heist : undefined;
  }
  private isHeist() { return this.def.kind === 'heist' && !!this.def.heist; }
  private ctx() { return { approach: this.config.approach, difficulty: this.difficulty, choices: this.choices, setups: this.setups, crew: this.size }; }
  private setupBonus() {
    const out = { hp: 0, lives: 0, timeMult: 1 };
    for (const s of this.def.heist?.setups ?? []) if (s.bonus && this.setups.includes(s.prep)) { out.hp += s.bonus.hp ?? 0; out.lives += s.bonus.lives ?? 0; out.timeMult *= s.bonus.timeMult ?? 1; }
    return out;
  }

  // ───────────────────────────────────────────────────────── lifecycle
  startedAt = Date.now();
  async start() {
    this.startedAt = Date.now();
    await this.game.store.createRun({ id: this.id, activity: this.def.id, kind: this.def.kind, leader: this.leader, roster: this.rosterJson(), terms: { ...this.config, difficulty: this.difficulty, choices: this.choices }, checkpoint: 0 });
    log.info('activity start', { run: this.id, activity: this.def.id, size: this.size, instance: this.inst.id });
    const bonus = this.setupBonus();
    if (this.isHeist() && this.difficulty === 'hard') { this.lives = this.livesMax = this.def.heist!.hardLives[this.size - 1] + bonus.lives; }
    // participants: place at start spots
    let i = 0;
    for (const r of this.roster.values()) {
      const p = this.inst.players.get(r.userId);
      if (!p) continue;
      p.role = r.role;
      p.maxHp = (r.role === 'muscle' ? 150 : 100) + (this.isHeist() ? bonus.hp : 0); p.hp = p.maxHp;
      const s = this.def.startSpots[i++ % this.def.startSpots.length];
      this.inst.teleport(p, s[0], s[1], s[2], this.def.startYaw);
    }
    const resume = Math.max(0, Math.min(this.config.resumeStage, this.def.stages.length - 1));
    if (resume > 0) this.restoreTo(resume, true);
    else this.enterStage(0);
  }

  participants(): RosterEntry[] { return [...this.roster.values()].filter((r) => !r.left); }
  participantEnts(): PlayerEnt[] {
    const out: PlayerEnt[] = [];
    for (const r of this.participants()) { const p = this.inst.players.get(r.userId); if (p) out.push(p); }
    return out;
  }
  private activeEnts() { return this.participantEnts().filter((p) => !p.linkdeadAt); }
  hasEquipment(id: string) { return this.config.equipment.includes(id); }
  allowsTraffic() {
    const s = this.stage();
    return this.def.kind !== 'heist' || !!s?.traffic || s?.id === 'escape' || s?.id === 'heat' || s?.id === 'drop';
  }
  stage(): StageDef | undefined { return this.def.stages[this.stageIndex]; }

  private stageApplies(s: StageDef): boolean {
    if (!s.when) return true;
    if (!condHolds(s.when, this.ctx())) return false;
    if (s.when.alarm === false && this.alarm) return false;
    if (s.when.alarm === true && !this.alarm) return false;
    if (s.when.wanted === true && !this.wanted) return false;
    return true;
  }
  private spawnApplies(sp: SpawnDef): boolean {
    if (sp.minParty && this.size < sp.minParty) return false;
    if (sp.hard && this.difficulty !== 'hard') return false;
    return condHolds(sp.if, this.ctx());
  }

  private enterStage(idx: number, opts: { skipCutscene?: boolean } = {}) {
    while (idx < this.def.stages.length && !this.stageApplies(this.def.stages[idx])) idx++;
    if (idx >= this.def.stages.length) { void this.complete(); return; }
    this.stageIndex = idx;
    const s = this.def.stages[idx];
    this.wavesFired.clear(); this.stageEvents.clear();
    this.applyStageSetup(s);
    this.stageStartedAt = this.inst.now;
    const tmul = this.isHeist() ? (this.difficulty === 'hard' ? 0.8 : 1) * this.setupBonus().timeMult : 1;
    this.timerEndsAt = s.timeLimit ? this.inst.now + s.timeLimit[this.size - 1] * tmul * 1000 : 0;
    this.initObjectives(s);
    if (s.checkpoint) {
      this.checkpointIndex = idx;
      this.lootAtCheckpoint = this.loot;
      this.snap = { carry: new Map(this.carry), drops: this.drops.map((d) => ({ ...d })), lost: this.lootLost, loot: this.loot, alarm: this.alarm };
      void this.game.store.updateRun(this.id, { checkpoint: idx });
      if (this.def.kind === 'mission') void this.game.store.setCheckpoint(this.leader, this.def.id, idx);
    }
    for (const l of s.lines ?? []) this.dialogueQueue.push(l);
    if (s.cutscene && !opts.skipCutscene) this.beginCutscene(s.cutscene);
    else { this.phase = 'playing'; this.flushDialogue(); this.onPlayingStart(s); }
    this.viewDirty = true;
  }

  private applyStageSetup(s: StageDef) {
    for (const key of s.despawn ?? []) this.despawn(key);
    if (s.onEnter?.doors) for (const [k, st] of Object.entries(s.onEnter.doors)) {
      const doorKey = this.doorKeyFor(k);
      if (doorKey) this.inst.setDoor(doorKey, st);
    }
    this.spawnAll(s.spawn ?? []);
    if (s.onEnter?.wanted) this.raiseWanted(s.onEnter.wanted, this.centroid(), 'Car alarm');
    if (s.onEnter?.alarm || (s.onEnter?.alarmIfLoud && this.config.approach === 'loud')) this.triggerAlarm('The alarm is ringing!');
  }

  private spawnAll(list: SpawnDef[]) {
    for (const sp of list) {
      if (!this.spawnApplies(sp)) continue;
      if (sp.kind === 'vehicle') {
        if (sp.perPlayer) {
          const grid = this.def.race?.startGrid ?? [sp.pos];
          const order = this.participants().map((r) => r.userId).sort(() => Math.random() - 0.5);
          order.forEach((uid, i) => {
            const g = grid[i % grid.length];
            const v = this.inst.spawnVehicle(sp.model as VehicleModel, g[0], g[1], g[2], sp.yaw, { color: [0xd7263d, 0x2e86ab, 0xffbe0b, 0x06d6a0][i % 4], activityKey: `${sp.id}:${uid}`, allowed: new Set([uid]), label: sp.label, ghost: sp.ghost });
            this.keyed.set(`${sp.id}:${uid}`, v.id);
          });
          continue;
        }
        const allowed = new Set(this.participants().map((r) => r.userId));
        let model = sp.model as VehicleModel;
        // heist driver role: faster getaway
        const upgrade = sp.driverUpgrade ?? (sp.id === 'getaway' && sp.model === 'sedan' ? 'sports' : undefined);
        if (upgrade && this.participants().some((r) => r.role === 'driver')) model = upgrade as VehicleModel;
        const v = this.inst.spawnVehicle(model, sp.pos[0], sp.pos[1], sp.pos[2], sp.yaw, { color: sp.color, activityKey: sp.id, allowed, label: sp.label, ghost: sp.ghost });
        this.keyed.set(sp.id, v.id);
      } else if (sp.kind === 'object') {
        const id = `o:${this.inst.id.slice(0, 4)}:${sp.id}`;
        this.inst.objects.set(id, { id, kind: sp.obj, x: sp.pos[0], y: sp.pos[1], z: sp.pos[2], yaw: sp.yaw ?? 0, label: sp.label, hold: sp.hold, state: 0, activityKey: sp.id, value: sp.value ?? 0, progress: 0, doneBy: null, doneAt: 0 });
        this.keyed.set(sp.id, id);
      } else if (sp.kind === 'guard') {
        const key = `${this.inst.id.slice(0, 4)}:${sp.id}`;
        spawnGuard(this.inst, key, sp.patrol);
        const n = this.inst.npcs.get(`n:${key}`);
        if (n) {
          if (sp.name) n.name = sp.name;
          if (sp.armed || sp.enforcer) n.brain.target = 'armed';
          if (sp.enforcer) { n.label = 'enforcer'; n.speed = 2.2; }
          n.hp = (sp.hp ?? 100) * (this.difficulty === 'hard' ? 1.3 : 1);
        }
        this.keyed.set(sp.id, `n:${key}`);
      } else if (sp.kind === 'door') {
        this.keyed.set(sp.id, `door:${sp.door}`);
        this.inst.setDoor(sp.door, sp.state);
      } else if (sp.kind === 'npc') {
        const id = `n:${this.inst.id.slice(0, 4)}:${sp.id}`;
        this.inst.npcs.set(id, { id, role: 'actor', label: sp.role, name: sp.name, x: sp.pos[0], y: sp.pos[1], z: sp.pos[2], yaw: sp.yaw, anim: 0, skin: 3, stunnedUntil: 0, downUntil: 0, alert: 0, activityKey: sp.id, speed: 0, brain: {} });
        this.keyed.set(sp.id, id);
      }
    }
  }

  private doorKeyFor(spawnKey: string) {
    const v = this.keyed.get(spawnKey);
    return v?.startsWith('door:') ? v.slice(5) : null;
  }

  private despawn(key: string) {
    const id = this.keyed.get(key);
    if (!id) return;
    if (id.startsWith('v:')) this.inst.removeVehicle(id);
    else if (id.startsWith('o:')) this.inst.objects.delete(id);
    else if (id.startsWith('n:')) this.inst.npcs.delete(id);
    this.keyed.delete(key);
  }

  private initObjectives(s: StageDef) {
    this.objStates.clear();
    for (const o of s.objectives) {
      if (o.type === 'interact' || o.type === 'shoot') {
        const targets = o.targets.filter((t) => this.keyed.has(t));
        const req = o.type === 'shoot' ? o.count[this.size - 1] : (o.count ? o.count[this.size - 1] : targets.length);
        this.objStates.set(o.id, { done: false, required: Math.min(req, targets.length), targets });
      } else if (o.type === 'defend') {
        this.objStates.set(o.id, { done: false, required: o.seconds[this.size - 1] * this.equipMult('defend'), targets: [], progress: 0 });
      } else this.objStates.set(o.id, { done: false, required: 1, targets: [] });
    }
  }

  private onPlayingStart(s: StageDef) {
    const race = s.objectives.find((o) => o.type === 'checkpoints');
    if (race) {
      this.raceStartAt = this.inst.now + 4200;
      this.race.clear();
      for (const r of this.participants()) {
        const p = this.inst.players.get(r.userId);
        const vid = this.keyed.get(`racecar:${r.userId}`) ?? null;
        this.race.set(r.userId, { cp: 0, lap: 1, finishMs: null, lastCpAt: this.raceStartAt, vehicle: vid });
        if (p && vid) { this.inst.enterVehicle(p, vid, 0); p.frozen = true; }
      }
      this.game.broadcastSfx(this.participantEnts(), 'countdown_beep');
    }
  }

  // ───────────────────────────────────────────────────────── dialogue
  /** event lines: the stage's own, else the heist planner's radio */
  private sayEvent(kind: keyof StageEvents, once = true) {
    if (once && this.stageEvents.has(kind)) return;
    this.stageEvents.add(kind);
    const lines = this.stage()?.events?.[kind] ?? (kind === 'done' ? undefined : this.planHeist()?.radio?.[kind]);
    if (!lines?.length) return;
    // stage-specific event lines play in full; planner radio picks one
    const list = this.stage()?.events?.[kind] ? lines : [lines[Math.floor(Math.random() * lines.length)]];
    for (const l of list) this.dialogueQueue.push(l);
    if (this.phase === 'playing') this.flushDialogue();
  }
  private sayTo(to: PlayerEnt[], speaker: string, text: string) { for (const p of to) this.game.send(p.userId, { t: 'dialogue', speaker, text, ms: 3800 }); }

  // ───────────────────────────────────────────────────────── cutscenes
  private beginCutscene(id: string) {
    const cs = CUTSCENES[id];
    if (!cs) { this.phase = 'playing'; return; }
    this.phase = 'cutscene';
    const anchor = cs.shots[0].cam.lookFrom;
    for (const p of this.participantEnts()) { p.frozen = true; p.holding = null; p.cutsceneFocus = anchor; if (p.veh) this.inst.exitVehicle(p, true); }
    const needed = this.activeEnts();
    this.cs = { id, loaded: new Set(), votes: new Set(), deadline: this.inst.now + CUTSCENE_LOAD_WAIT_MS, startAt: 0, endsAt: 0 };
    for (const p of needed) this.game.send(p.userId, { t: 'cs.waiting', cs: id, loaded: 0, total: needed.length, deadline: this.cs.deadline });
  }

  csLoaded(userId: string, id: string) {
    if (!this.cs || this.cs.id !== id || this.cs.startAt) return;
    this.cs.loaded.add(userId);
    const total = this.activeEnts().length;
    for (const p of this.activeEnts()) this.game.send(p.userId, { t: 'cs.waiting', cs: id, loaded: this.cs.loaded.size, total, deadline: this.cs.deadline });
  }

  csSkip(userId: string) {
    if (!this.cs || !this.cs.startAt) return;
    this.cs.votes.add(userId);
    const active = this.activeEnts().length;
    const needed = active <= 1 ? 1 : Math.floor(active / 2) + 1;
    for (const p of this.activeEnts()) this.game.send(p.userId, { t: 'cs.votes', votes: this.cs.votes.size, needed });
    if (this.cs.votes.size >= needed) this.endCutscene(true);
  }

  private tickCutscene() {
    const cs = this.cs!;
    const active = this.activeEnts();
    if (!cs.startAt) {
      const allLoaded = active.every((p) => cs.loaded.has(p.userId));
      if (allLoaded || this.inst.now >= cs.deadline || active.length === 0) {
        cs.startAt = this.inst.now + 350;
        cs.endsAt = cs.startAt + cutsceneDuration(cs.id) * 1000;
        const skipRule = active.length <= 1 ? 'Press SPACE to skip.' : `Skips when more than half the crew votes (${Math.floor(active.length / 2) + 1} of ${active.length}). Press SPACE to vote.`;
        for (const p of active) this.game.send(p.userId, { t: 'cs.start', cs: cs.id, startAt: cs.startAt, skipRule, participants: active.length });
      }
      return;
    }
    if (this.inst.now >= cs.endsAt) this.endCutscene(false);
  }

  private endCutscene(skipped: boolean) {
    const cs = this.cs;
    if (!cs) return;
    this.cs = null;
    const def = CUTSCENES[cs.id];
    let i = 0;
    for (const p of this.participantEnts()) {
      p.frozen = false; p.cutsceneFocus = null;
      const s = def.endSpots[i++ % def.endSpots.length];
      this.inst.teleport(p, s[0], s[1], s[2], def.endYaw);
      this.game.send(p.userId, { t: 'cs.end', cs: cs.id, skipped });
    }
    this.phase = 'playing';
    // the stage clock starts when play starts
    const s = this.stage()!;
    if (this.timerEndsAt) this.timerEndsAt += this.inst.now - this.stageStartedAt;
    this.stageStartedAt = this.inst.now;
    this.flushDialogue();
    this.onPlayingStart(s);
    this.viewDirty = true;
  }

  private flushDialogue() {
    let delay = 0;
    for (const l of this.dialogueQueue) {
      const line = l;
      setTimeout(() => { if (this.ended) return; for (const p of this.activeEnts()) this.game.send(p.userId, { t: 'dialogue', speaker: line.speaker, text: line.text, ms: 4500 }); }, delay);
      delay += 4600;
    }
    this.dialogueQueue = [];
  }

  // ───────────────────────────────────────────────────────── tick
  tick(dt: number) {
    if (this.ended) return;
    this.lastDt = dt;
    this.checkRoster();
    if (this.phase === 'cutscene' && this.cs) { this.tickCutscene(); this.pushView(); return; }
    if (this.phase === 'complete') {
      if (this.completeAt && this.inst.now - this.completeAt > 25_000) this.finishAndReturn();
      this.pushView();
      return;
    }
    if (this.phase !== 'playing') { this.pushView(); return; }

    // guards (stealth) — may escalate and change the stage, so read the stage afterwards
    if ([...this.inst.npcs.values()].some((n) => n.role === 'guard')) {
      const disguised = !!this.stage()?.disguised && !this.alarm;
      heistAiTick(this.inst, dt, this.alarm, this.activeEnts(), this.guardMem, (to, sp, tx) => this.sayTo(to, sp, tx), { hard: this.difficulty === 'hard', disguised });
      const g = guardTick(this.inst, dt, this.alarm);
      if (disguised) { for (const n of this.inst.npcs.values()) if (n.role === 'guard') n.alert = Math.min(n.alert, 0.2); }
      else if (g.tripped && !this.alarm) this.triggerAlarm('A guard spotted you! The alarm is ringing.');
    }
    if (this.phase !== 'playing') { this.pushView(); return; }
    const s = this.stage()!;
    const stageAtStart = this.stageIndex;

    // reinforcement waves
    (s.waves ?? []).forEach((w, i) => {
      if (this.wavesFired.has(i) || this.inst.now - this.stageStartedAt < w.after * 1000 || (w.alarmOnly && !this.alarm)) return;
      this.wavesFired.add(i);
      const before = this.inst.npcs.size;
      this.spawnAll(w.spawn);
      if (this.inst.npcs.size > before) {
        if (w.line) { this.dialogueQueue.push(w.line); this.flushDialogue(); } else this.sayEvent('wave', false);
        this.viewDirty = true;
      }
    });
    if (this.timerEndsAt && this.timerEndsAt - this.inst.now < 30_000 && this.timerEndsAt - this.inst.now > 0 && (s.timeLimit?.[this.size - 1] ?? 0) > 45) this.sayEvent('timeLow');

    // race freeze until GO
    if (this.raceStartAt && this.inst.now >= this.raceStartAt) {
      for (const p of this.participantEnts()) if (p.frozen && !this.cs) p.frozen = false;
      if (this.inst.now - this.raceStartAt < 100) this.game.broadcastSfx(this.participantEnts(), 'go_beep');
    }

    // objectives
    let allDone = true;
    for (const o of s.objectives) {
      const st = this.objStates.get(o.id);
      if (!st) { allDone = false; continue; }
      if (!st.done) st.done = this.evaluate(o, st);
      if (this.stageIndex !== stageAtStart || this.phase !== 'playing') { this.pushView(); return; }
      if (!st.done) allDone = false;
    }

    // failure
    for (const f of s.fail ?? []) {
      if (f.type === 'timer' && this.timerEndsAt && this.inst.now > this.timerEndsAt) {
        if (s.objectives.some((o) => o.type === 'checkpoints')) { allDone = true; break; }
        return this.fail('Time ran out.');
      }
      if (f.type === 'vehicle_destroyed') {
        const id = this.keyed.get(f.vehicle);
        const v = id ? this.inst.vehicles.get(id) : null;
        if (id && (!v || v.destroyedAt)) return this.fail(`The ${v?.label ?? 'vehicle'} was destroyed.`);
      }
      if (f.type === 'all_down') {
        const act = this.activeEnts();
        if (act.length && act.every((p) => p.downUntil)) return this.fail('The whole crew went down.');
      }
      if (f.type === 'detected' && this.alarm) return this.fail('You were spotted.');
      if (f.type === 'loot_lost' && this.drops.some((d) => this.inst.now - d.at > f.seconds * 1000)) return this.fail('A dropped bag lay on the ground too long - the police bagged the loot.');
    }

    if (allDone) { this.sayEvent('done'); this.enterStage(this.stageIndex + 1); }
    this.pushView();
  }

  private evaluate(o: ObjectiveDef, st: ObjState): boolean {
    const ents = this.activeEnts().filter((p) => !p.downUntil);
    switch (o.type) {
      case 'reach': {
        const inR = (p: PlayerEnt) => {
          const x = p.phys.x - o.pos[0], z = p.phys.z - o.pos[2];
          if (x * x + z * z > o.r * o.r || Math.abs(p.phys.y - o.pos[1]) > 4) return false;
          if (o.vehicle) return !!p.veh && p.veh === this.keyed.get(o.vehicle);
          return true;
        };
        if (o.vehicle) {
          const vid = this.keyed.get(o.vehicle);
          const v = vid ? this.inst.vehicles.get(vid) : null;
          if (!v) return false;
          const inside = v.occ.some((u) => u && this.roster.has(u));
          return inside && (v.phys.x - o.pos[0]) ** 2 + (v.phys.z - o.pos[2]) ** 2 <= o.r * o.r;
        }
        return o.who === 'all' ? ents.length > 0 && ents.every(inR) : ents.some(inR);
      }
      case 'enter_vehicle': {
        const ids = new Set(o.vehicles.map((k) => this.keyed.get(k)).filter(Boolean) as string[]);
        const inV = (p: PlayerEnt) => !!p.veh && ids.has(p.veh);
        return o.who === 'all' ? ents.length > 0 && ents.every(inV) : ents.some(inV);
      }
      case 'interact': {
        let n = 0;
        for (const t of st.targets) { const ob = this.inst.objects.get(this.keyed.get(t)!); if (ob?.state === 1) n++; }
        if (o.simultaneous) return n >= st.targets.length;
        return n >= st.required;
      }
      case 'shoot': {
        let n = 0;
        for (const t of st.targets) { const ob = this.inst.objects.get(this.keyed.get(t)!); if (ob?.state === 1) n++; }
        return n >= st.required;
      }
      case 'defend': {
        const inZone = ents.some((p) => !p.veh && (p.phys.x - o.pos[0]) ** 2 + (p.phys.z - o.pos[2]) ** 2 <= o.r * o.r && Math.abs(p.phys.y - o.pos[1]) < 4);
        if (inZone) {
          const before = Math.floor((st.progress ?? 0) / Math.max(1, st.required) * 4);
          st.progress = (st.progress ?? 0) + this.lastDt;
          if (Math.floor(st.progress / Math.max(1, st.required) * 4) !== before) this.viewDirty = true;
        }
        return (st.progress ?? 0) >= st.required;
      }
      case 'lose_wanted': return !this.wanted;
      case 'wait': return this.inst.now - this.stageStartedAt >= o.seconds * 1000;
      case 'checkpoints': return this.tickRace(o);
    }
  }

  private tickRace(o: Extract<ObjectiveDef, { type: 'checkpoints' }>): boolean {
    if (!this.raceStartAt || this.inst.now < this.raceStartAt) return false;
    let allFinished = true;
    for (const [uid, r] of this.race) {
      const p = this.inst.players.get(uid);
      const entry = this.roster.get(uid);
      if (!p || entry?.left) continue;
      if (r.finishMs !== null) continue;
      allFinished = false;
      if (!p.veh) continue;
      const v = this.inst.vehicles.get(p.veh);
      if (!v) continue;
      const cp = o.points[r.cp];
      if ((v.phys.x - cp[0]) ** 2 + (v.phys.z - cp[2]) ** 2 <= o.r * o.r) {
        // plausibility: no faster than 1.25 × top speed between checkpoints
        const prev = r.cp === 0 ? (r.lap === 1 ? (this.def.race?.startGrid[0] ?? cp) : o.points[o.points.length - 1]) : o.points[r.cp - 1];
        const dist = Math.hypot(cp[0] - prev[0], cp[2] - prev[2]) - o.r * 2;
        const minMs = (Math.max(0, dist) / (VEHICLES[v.model].maxSpeed * 1.25)) * 1000;
        if (this.inst.now - r.lastCpAt < minMs) { log.warn('race checkpoint rejected (implausible)', { uid, run: this.id }); continue; }
        r.lastCpAt = this.inst.now;
        r.cp++;
        this.game.sfx(this.inst, 'checkpoint', v.phys.x, v.phys.y, v.phys.z, 0.8, uid);
        if (r.cp >= o.points.length) {
          r.cp = 0; r.lap++;
          if (r.lap > o.laps) {
            r.finishMs = this.inst.now - this.raceStartAt;
            if (!this.firstFinishAt) this.firstFinishAt = this.inst.now;
            this.game.notify(uid, `Finished: ${(r.finishMs / 1000).toFixed(2)} s`, 'good', 'mission_pass');
          }
        }
        this.viewDirty = true;
      }
    }
    if (allFinished) return true;
    if (this.firstFinishAt && this.def.race?.competitive && this.inst.now - this.firstFinishAt > 30_000) return true;
    return false;
  }

  // ───────────────────────────────────────────────────────── equipment
  private equipMult(obj: string): number {
    let m = 1;
    for (const e of this.def.heist?.equipment ?? []) if (this.hasEquipment(e.id)) for (const ef of e.effects ?? []) if (ef.obj === obj && ef.mult) m *= ef.mult;
    return m;
  }
  private windowMult(): number {
    let m = 1;
    for (const e of this.def.heist?.equipment ?? []) if (this.hasEquipment(e.id) && e.windowMult) m = Math.max(m, e.windowMult);
    return m;
  }

  // ───────────────────────────────────────────────────────── events from the instance
  holdTime(o: ObjEnt, p: PlayerEnt): number {
    let t = o.hold;
    const role = this.roster.get(p.userId)?.role;
    for (const e of this.def.heist?.equipment ?? []) {
      if (!this.hasEquipment(e.id)) continue;
      for (const ef of e.effects ?? []) {
        if (ef.obj !== o.kind || (ef.key && ef.key !== o.activityKey)) continue;
        if (ef.hold !== undefined) t = Math.min(t, ef.hold);
        else if (ef.mult) t *= ef.mult;
      }
    }
    if ((o.kind === 'keypad' || o.kind === 'safe' || o.kind === 'lock') && role === 'hacker') t *= 0.7;
    if (o.kind === 'lock' && o.activityKey === 'smash' && role === 'muscle') t *= 0.5;
    return t;
  }

  onObjectDone(o: ObjEnt, p: PlayerEnt) {
    // a dropped bag picked up again
    if (o.activityKey?.startsWith('drop:')) {
      const d = this.drops.find((x) => x.key === o.activityKey);
      this.drops = this.drops.filter((x) => x.key !== o.activityKey);
      this.inst.objects.delete(o.id);
      this.keyed.delete(o.activityKey);
      const v = d?.value ?? o.value;
      this.carry.set(p.userId, (this.carry.get(p.userId) ?? 0) + v);
      for (const e of this.activeEnts()) this.game.notify(e.userId, `${p.name ?? 'Crew'} recovered a bag ($${v.toLocaleString()})`, 'good', 'pickup');
      this.viewDirty = true;
      return;
    }
    if (o.value) {
      this.loot += o.value;
      if (this.isHeist()) this.carry.set(p.userId, (this.carry.get(p.userId) ?? 0) + o.value);
      this.game.notify(p.userId, this.isHeist() ? `+$${o.value.toLocaleString()} in your bag` : `+$${o.value.toLocaleString()} to the take`, 'good', 'cash');
      this.sayEvent('loot');
    } else this.game.sfx(this.inst, o.kind === 'package' ? 'pickup' : 'ui_click', o.x, o.y, o.z, 0.8, p.userId);
    this.viewDirty = true;
    // simultaneous objectives (alarm keypads, clamps, GPS)
    const s = this.stage();
    if (!s) return;
    for (const obj of s.objectives) {
      if (obj.type !== 'interact' || !obj.simultaneous || !obj.targets.includes(o.activityKey!)) continue;
      const st = this.objStates.get(obj.id)!;
      const objs = st.targets.map((t) => this.inst.objects.get(this.keyed.get(t)!)!).filter(Boolean);
      const done = objs.filter((x) => x.state === 1);
      const coop = this.activeEnts().length >= objs.length;
      const window = (coop ? obj.simultaneous.window * this.windowMult() : obj.simultaneous.soloWindow) * 1000;
      if (done.length === objs.length) {
        const span = Math.max(...done.map((x) => x.doneAt)) - Math.min(...done.map((x) => x.doneAt));
        if (span > window) {
          for (const x of objs) { x.state = 0; x.progress = 0; }
          for (const e of this.activeEnts()) this.game.notify(e.userId, coop ? 'Out of sync — do them together.' : 'Too slow — it reset.', 'bad', 'alarm');
        } else for (const e of this.activeEnts()) this.game.notify(e.userId, objs.some((x) => /keypad/i.test(x.label)) ? 'Alarm disabled.' : `Done: ${obj.label}.`, 'good', 'notify');
      } else if (done.length === 1) {
        const first = done[0];
        for (const e of this.activeEnts()) this.game.notify(e.userId, coop ? `One down — the other within ${(window / 1000).toFixed(1)} s!` : `One down — reach the other within ${Math.round(window / 1000)} s.`, 'info');
        setTimeout(() => {
          if (this.ended) return;
          const still = objs.filter((x) => x.state === 1);
          if (still.length && still.length < objs.length && first.state === 1 && this.inst.now - first.doneAt >= window) {
            for (const x of objs) { x.state = 0; x.progress = 0; }
            for (const e of this.activeEnts()) this.game.notify(e.userId, 'Too slow — it reset.', 'bad', 'alarm');
            this.viewDirty = true;
          }
        }, window + 50);
      }
    }
  }

  onPlayerDown(p: PlayerEnt) {
    this.viewDirty = true;
    if (!this.isHeist() || this.phase !== 'playing' || !this.roster.has(p.userId)) return;
    this.knockouts++;
    const h = this.def.heist!;
    const bag = this.carry.get(p.userId) ?? 0;
    if (bag > 0) {
      this.carry.set(p.userId, 0);
      const damaged = Math.round(bag * h.carryLoss);
      const rest = bag - damaged;
      this.lootLost += damaged;
      if (p.phys.inWater) {
        this.lootLost += rest;
        for (const e of this.activeEnts()) this.game.notify(e.userId, `${p.name ?? 'A carrier'} went down in the water - the bag sank ($${bag.toLocaleString()} lost).`, 'bad');
      } else {
        const key = `drop:${++this.dropSeq}`;
        const id = `o:${this.inst.id.slice(0, 4)}:${key}`;
        this.inst.objects.set(id, { id, kind: 'loot', x: p.phys.x, y: p.phys.y, z: p.phys.z, yaw: 0, label: `Pick up the dropped bag ($${rest.toLocaleString()})`, hold: 1, state: 0, activityKey: key, value: rest, progress: 0, doneBy: null, doneAt: 0 });
        this.keyed.set(key, id);
        this.drops.push({ key, value: rest, x: p.phys.x, y: p.phys.y, z: p.phys.z, at: this.inst.now });
        for (const e of this.activeEnts()) this.game.notify(e.userId, `${p.name ?? 'A carrier'} dropped a bag: $${damaged.toLocaleString()} damaged, $${rest.toLocaleString()} on the floor.`, 'bad');
      }
    }
    if (this.inst.now - this.lastDownLineAt > 8000) { this.lastDownLineAt = this.inst.now; this.sayEvent('down', false); }
    if (this.lives !== null) {
      this.lives = Math.max(0, this.lives - 1);
      for (const e of this.activeEnts()) this.game.notify(e.userId, this.lives > 0 ? `Team lives left: ${this.lives}` : 'No team lives left!', 'bad');
      if (this.lives <= 0) { this.finalFail = true; this.fail('Out of team lives - the job is over.'); }
    }
  }
  onVehicleDestroyed(_v: VehicleEnt) { this.viewDirty = true; }
  onGuardHit(n: NpcEnt) { n.stunnedUntil = this.inst.now + 20000; }
  onNpcStunned(n: NpcEnt, _p: PlayerEnt) {
    if (n.role !== 'guard' || this.alarm) return;
    // another guard who sees the stunned one raises suspicion
    for (const g of this.inst.npcs.values()) if (g !== n && g.role === 'guard' && g.stunnedUntil < this.inst.now && Math.hypot(g.x - n.x, g.z - n.z) < 6) g.alert = Math.min(1, g.alert + 0.5);
  }

  triggerAlarm(msg: string) {
    if (this.alarm) return;
    this.alarm = true;
    if (this.replaying) return;
    this.alarmEver = true;
    this.raiseWanted(this.difficulty === 'hard' ? 3 : 2, this.centroid(), 'Alarm');
    const doors = this.def.heist?.alarmDoors;
    if (doors) for (const k of doors) { const dk = this.doorKeyFor(k); if (dk) this.inst.setDoor(dk, 'open'); }
    for (const p of this.activeEnts()) this.game.notify(p.userId, msg, 'bad', 'alarm');
    this.sayEvent('alarm');
    // escalation: if the current stage only makes sense while quiet, move on
    const s = this.stage();
    if (s && this.phase === 'playing' && (!this.stageApplies(s) || s.skipOnAlarm)) this.enterStage(this.stageIndex + 1);
    this.viewDirty = true;
  }

  raiseWanted(level: number, at: { x: number; z: number }, _reason: string) {
    if (this.replaying) return;
    if (!this.wanted) {
      this.wanted = { level, lastKnown: at, lastSeenAt: this.inst.now, since: this.inst.now };
      for (const p of this.activeEnts()) this.game.notify(p.userId, `The police are coming (${'★'.repeat(level)})`, 'bad', 'siren');
    } else if (level > this.wanted.level) { this.wanted.level = level; this.wanted.lastKnown = at; this.wanted.lastSeenAt = this.inst.now; }
    this.viewDirty = true;
  }
  clearWanted() {
    this.wanted = null;
    for (const p of this.activeEnts()) this.game.notify(p.userId, 'You lost the police.', 'good', 'notify');
    this.viewDirty = true;
  }

  respawnPos(p: PlayerEnt): V3 {
    const s = this.def.stages[this.checkpointIndex];
    const spots = s.respawn ?? this.def.startSpots;
    const i = [...this.roster.keys()].indexOf(p.userId);
    return spots[Math.max(0, i) % spots.length];
  }

  private centroid() {
    const ps = this.activeEnts();
    if (!ps.length) return { x: this.def.start[0], z: this.def.start[2] };
    return { x: ps.reduce((s, p) => s + p.phys.x, 0) / ps.length, z: ps.reduce((s, p) => s + p.phys.z, 0) / ps.length };
  }

  // ───────────────────────────────────────────────────────── roster / connection
  private checkRoster() {
    const now = this.inst.now;
    let anyConnected = false;
    for (const r of this.roster.values()) {
      if (r.left) continue;
      const p = this.inst.players.get(r.userId);
      const connected = !!p && !p.linkdeadAt;
      if (connected !== r.connected) { r.connected = connected; r.disconnectedAt = connected ? 0 : now; this.viewDirty = true; }
      if (connected) anyConnected = true;
      else if (now - r.disconnectedAt > RECONNECT_GRACE_MS) {
        r.left = true; this.viewDirty = true;
        this.inst.removePlayer(r.userId);
      }
    }
    if (!anyConnected && this.participants().every((r) => r.left || now - r.disconnectedAt > RECONNECT_GRACE_MS)) {
      this.abandon('Everyone left.');
    }
    if (!this.roster.get(this.leader) || this.roster.get(this.leader)!.left) {
      const next = this.participants()[0];
      if (next) { this.leader = next.userId; this.viewDirty = true; for (const p of this.activeEnts()) this.game.notify(p.userId, `${next.name} now leads this activity.`, 'info'); }
    }
  }

  leave(userId: string) {
    const r = this.roster.get(userId);
    if (!r || r.left) return;
    r.left = true;
    this.viewDirty = true;
    const p = this.inst.players.get(userId);
    if (p) { p.frozen = false; p.cutsceneFocus = null; }
    this.game.returnToWorld(userId, r.returnTo);
    if (this.participants().length === 0) this.abandon('Everyone left.');
    else if (this.cs) { /* recompute votes needed */ this.csSkip('__recount__'); this.cs?.votes.delete('__recount__'); }
  }

  // ───────────────────────────────────────────────────────── fail / retry / complete
  private fail(reason: string) {
    if (this.phase === 'failed') return;
    this.phase = 'failed';
    this.failReason = reason;
    this.timerEndsAt = 0;
    for (const p of this.activeEnts()) { this.game.notify(p.userId, `Failed: ${reason}`, 'bad', 'mission_fail'); p.holding = null; }
    void this.game.store.updateRun(this.id, { status: 'failed', result: { reason, final: this.finalFail } });
    this.viewDirty = true;
    this.pushView();
  }

  /** true once the run can no longer be retried (Hard: out of team lives) */
  get retryable() { return !this.finalFail; }

  retry(userId: string) {
    if (this.phase !== 'failed' || userId !== this.leader) return;
    if (this.finalFail) { this.game.notify(userId, 'No team lives left - this job cannot be retried.', 'bad'); return; }
    this.retries++;
    void this.game.store.updateRun(this.id, { status: 'active' });
    this.restoreTo(this.checkpointIndex, false);
  }

  /** Rebuild the instance state for a checkpoint: replay stage setups up to `idx`, then enter it. */
  private restoreTo(idx: number, fresh: boolean) {
    for (const key of [...this.keyed.keys()]) this.despawn(key);
    for (const o of [...this.inst.objects.keys()]) this.inst.objects.delete(o);
    for (const v of [...this.inst.vehicles.values()]) if (v.ai?.kind === 'police') this.inst.removeVehicle(v.id);
    for (const n of [...this.inst.npcs.values()]) if (n.role === 'guard' || n.role === 'cop') this.inst.npcs.delete(n.id);
    this.guardMem.clear();
    const snap = fresh ? null : this.snap;
    this.alarm = false; this.wanted = null;
    this.loot = snap ? snap.loot : fresh ? 0 : this.lootAtCheckpoint;
    this.carry = snap ? new Map(snap.carry) : new Map();
    this.lootLost = snap ? snap.lost : 0;
    this.drops = [];
    this.replaying = true;
    for (let i = 0; i < idx; i++) { const s = this.def.stages[i]; if (this.stageApplies(s)) this.applyStageSetup(s); }
    this.replaying = false;
    // stage setups for already-passed stages should not leave live objectives around
    for (const o of [...this.inst.objects.values()]) o.state = 2;
    this.wanted = null;
    this.alarm = snap?.alarm ?? false;
    for (const d of snap?.drops ?? []) {
      const id = `o:${this.inst.id.slice(0, 4)}:${d.key}`;
      this.inst.objects.set(id, { id, kind: 'loot', x: d.x, y: d.y, z: d.z, yaw: 0, label: `Pick up the dropped bag ($${d.value.toLocaleString()})`, hold: 1, state: 0, activityKey: d.key, value: d.value, progress: 0, doneBy: null, doneAt: 0 });
      this.keyed.set(d.key, id);
      this.drops.push({ ...d, at: this.inst.now });
    }
    const target = this.def.stages[idx];
    const spots = target.respawn ?? this.def.startSpots;
    let i = 0;
    for (const p of this.participantEnts()) {
      p.hp = p.maxHp; p.downUntil = 0; p.frozen = false; p.cutsceneFocus = null;
      const s = spots[i++ % spots.length];
      this.inst.teleport(p, s[0], s[1], s[2]);
    }
    this.phase = 'playing';
    this.enterStage(idx, { skipCutscene: !fresh });
    for (const p of this.activeEnts()) this.game.notify(p.userId, fresh ? `Resumed from checkpoint: ${target.title}` : `Retrying from checkpoint: ${target.title}`, 'info', 'checkpoint');
  }

  private async complete() {
    if (this.phase === 'complete' || this.ended) return;
    this.phase = 'complete';
    this.completeAt = this.inst.now;
    this.timerEndsAt = 0;
    this.viewDirty = true;
    const results = await this.computeAndGrantRewards();
    for (const p of this.activeEnts()) {
      this.game.send(p.userId, { t: 'results', data: results });
      this.game.sfx(this.inst, 'mission_pass', p.phys.x, p.phys.y, p.phys.z, 1, p.userId);
    }
    this.pushView();
  }

  /** the heist take: base + secured bags (− what was damaged/dropped) × approach × difficulty */
  heistTake() {
    const h = this.def.heist!;
    const finishers = new Set(this.participants().map((r) => r.userId));
    let secured = 0;
    for (const [uid, v] of this.carry) if (finishers.has(uid)) secured += v;
    const leftBehind = this.drops.reduce((a, d) => a + d.value, 0);
    const approachMult = this.alarmEver ? h.loudPenalty : 1;
    const diffMult = this.difficulty === 'hard' ? (h.hardMult ?? 1.25) : 1;
    const take = Math.round((h.baseTake + secured) * approachMult * diffMult);
    return { base: h.baseTake, grabbed: this.loot, secured, lost: this.lootLost + leftBehind, leftBehind, approachMult, diffMult, take };
  }

  private eliteChecks() {
    const e = this.def.heist!.elite;
    const secs = (this.inst.now - this.startedAt) / 1000;
    const t = this.heistTake();
    const out: { label: string; ok: boolean }[] = [];
    if (e.maxSeconds) out.push({ label: `Finish under ${Math.floor(e.maxSeconds / 60)}:${String(e.maxSeconds % 60).padStart(2, '0')} (${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')})`, ok: secs <= e.maxSeconds });
    if (e.noKnockouts) out.push({ label: `Nobody knocked out (${this.knockouts})`, ok: this.knockouts === 0 });
    if (e.noRetries) out.push({ label: `No retries (${this.retries})`, ok: this.retries === 0 });
    if (e.noAlarm) out.push({ label: 'The alarm never went off', ok: !this.alarmEver });
    if (e.maxLootLossPct !== undefined) { const pct = t.grabbed > 0 ? (t.lost / t.grabbed) * 100 : 0; out.push({ label: `Lose under ${e.maxLootLossPct}% of the loot (${pct.toFixed(0)}%)`, ok: pct < e.maxLootLossPct || t.lost === 0 }); }
    return out;
  }

  private async computeAndGrantRewards() {
    const def = this.def;
    const finishers = this.participants();
    const n = this.size;
    const lines: { userId: string; name: string; cash: number; rep: number; note: string; status: string; best?: boolean; pct?: number; cut?: number; eliteBonus?: number; firstBonus?: number }[] = [];
    let take = 0;
    let heist: Record<string, unknown> | undefined;
    const raceRows: { userId: string; name: string; ms: number | null }[] = [];
    let eliteMet = false;
    if (def.kind === 'heist' && def.heist) {
      const t = this.heistTake();
      take = t.take;
      const checks = this.eliteChecks();
      eliteMet = checks.every((c) => c.ok);
      heist = {
        difficulty: this.difficulty, approach: this.config.approach, choices: this.choices, setups: this.setups, ...t,
        knockouts: this.knockouts, retries: this.retries, seconds: Math.round((this.inst.now - this.startedAt) / 1000), alarm: this.alarmEver,
        lives: this.lives, livesMax: this.livesMax,
        elite: { label: def.heist.elite.label, bonus: def.heist.elite.bonus, met: eliteMet, checks },
        firstTimeBonus: def.heist.firstTimeBonus, split: this.config.split,
      };
    }
    if (def.race) {
      for (const [uid, r] of this.race) raceRows.push({ userId: uid, name: this.roster.get(uid)?.name ?? '?', ms: r.finishMs });
      raceRows.sort((a, b) => (a.ms ?? 1e12) - (b.ms ?? 1e12));
    }
    for (const r of finishers) {
      let cash = 0, rep = def.rewards.rep, note = '';
      const line: (typeof lines)[number] = { userId: r.userId, name: r.name, cash: 0, rep: 0, note: '', status: '' };
      const g: Parameters<Game['store']['grantReward']>[0] = { runId: this.id, userId: r.userId, cash: 0, rep: 0 };
      if (def.kind === 'mission') {
        if (r.eligibility === 'story') { cash = def.rewards.cash[n - 1]; g.complete = def.id; g.unlocks = def.rewards.unlocks; g.clearCheckpoint = def.id; note = 'Story progress saved'; }
        else if (r.eligibility === 'replay') { cash = def.rewards.replayCash; rep = Math.round(rep / 2); g.complete = def.id; note = 'Replay'; }
        else { cash = def.rewards.replayCash; rep = Math.round(rep / 2); note = 'Played as a guest — story progress unchanged'; }
      } else if (def.kind === 'heist_prep') {
        cash = r.eligibility === 'ahead' ? def.rewards.replayCash : def.rewards.cash[n - 1];
        const heistId = def.prepFor ?? Object.values(ACTIVITY_BY_ID).find((a) => a.preps?.includes(def.id))?.id;
        const ch = this.planHeist()?.setups.find((s) => s.prep === def.id)?.choice;
        if (r.userId === this.leader && heistId) {
          g.prep = { heist: heistId, prep: def.id, choice: ch ? { key: ch.key, option: this.choices[ch.key] } : undefined };
          note = `Setup counted for your ${ACTIVITY_BY_ID[heistId].name}${ch ? ` (${ch.label}: ${ch.options.find((o) => o.id === this.choices[ch.key])?.name})` : ''}`;
        } else note = `Setup counted for ${this.roster.get(this.leader)?.name}'s heist`;
      } else if (def.kind === 'heist') {
        const h = def.heist!;
        const pct = this.config.split[r.userId] ?? Math.floor(100 / finishers.length);
        const cut = Math.round((take * pct) / 100);
        const eliteBonus = eliteMet ? h.elite.bonus : 0;
        const firstBonus = r.eligibility === 'story' ? h.firstTimeBonus : 0;
        cash = cut + eliteBonus + firstBonus;
        Object.assign(line, { pct, cut, eliteBonus, firstBonus });
        note = `${pct}% of $${take.toLocaleString()}${this.alarmEver ? ' (alarm: goods damaged)' : ''}${eliteBonus ? ` + elite $${eliteBonus.toLocaleString()}` : ''}${firstBonus ? ` + first time $${firstBonus.toLocaleString()}` : ''}`;
        if (r.eligibility === 'story') { g.complete = def.id; g.unlocks = def.rewards.unlocks; } else g.complete = def.id;
      } else if (def.kind === 'minigame' && !def.race && def.minigame?.scoring === 'time') {
        const secs = (this.inst.now - this.startedAt) / 1000;
        const par = def.minigame.parScores ?? [secs, secs, secs];
        const medal = secs <= par[0] ? 'Gold' : secs <= par[1] ? 'Silver' : secs <= par[2] ? 'Bronze' : null;
        const mult = medal === 'Gold' ? 1 : medal === 'Silver' ? 0.66 : medal === 'Bronze' ? 0.4 : 0.15;
        cash = Math.round((r.eligibility === 'ahead' ? def.rewards.replayCash : def.rewards.cash[n - 1]) * mult);
        note = `${medal ?? 'No medal'} — ${secs.toFixed(1)} s (par ${par.join(' / ')} s)`;
        if (await this.game.store.submitBest(r.userId, def.id, secs * 1000, this.id)) note += ' · NEW PERSONAL BEST';
      } else if (def.race) {
        const pos = raceRows.findIndex((x) => x.userId === r.userId);
        const row = raceRows[pos];
        if (row?.ms == null) { cash = 100; rep = 5; note = 'Did not finish'; }
        else if (def.race.competitive && n > 1) {
          const share = [1, 0.6, 0.4, 0.3][pos] ?? 0.25;
          cash = Math.round(def.rewards.cash[n - 1] * share);
          note = `${ordinal(pos + 1)} place — ${(row.ms / 1000).toFixed(2)} s`;
        } else {
          const par = def.race.parTimes;
          const s = row.ms / 1000;
          const medal = s <= par[0] ? 'Gold' : s <= par[1] ? 'Silver' : s <= par[2] ? 'Bronze' : null;
          cash = medal === 'Gold' ? def.rewards.cash[0] : medal === 'Silver' ? Math.round(def.rewards.cash[0] * 0.66) : medal === 'Bronze' ? Math.round(def.rewards.cash[0] * 0.4) : 150;
          note = `${medal ?? 'No medal'} — ${s.toFixed(2)} s (par ${par.join(' / ')} s)`;
        }
        if (row?.ms != null) {
          const best = await this.game.store.submitBest(r.userId, def.id, row.ms, this.id);
          if (best) note += ' · NEW PERSONAL BEST';
        }
      }
      g.cash = cash; g.rep = rep; g.detail = { note, ...(heist ? { pct: line.pct, cut: line.cut, eliteBonus: line.eliteBonus, firstBonus: line.firstBonus, take } : {}) };
      let status = 'paid';
      try {
        status = (await this.game.store.grantReward(g)) === 'granted' ? 'paid' : 'already paid';
      } catch (e) {
        log.error('reward grant failed', { run: this.id, user: r.userId, err: String(e) });
        status = 'error — will be reconciled';
      }
      lines.push({ ...line, cash, rep, note, status });
    }
    if (def.kind === 'heist') await this.game.store.consumePreps(this.leader, def.id);
    const result = { activity: def.id, name: def.name, kind: def.kind, lines, take, loot: this.loot, loud: this.alarmEver, race: raceRows, durationMs: this.inst.now - this.startedAt, heist };
    await this.game.store.updateRun(this.id, { status: 'complete', result, roster: this.rosterJson() });
    for (const r of finishers) void this.game.refreshProfile(r.userId);
    log.info('activity complete', { run: this.id, activity: def.id, lines: lines.length });
    return result;
  }

  continueAfterResults(userId: string) {
    if (this.phase !== 'complete') return;
    const r = this.roster.get(userId);
    if (!r || r.left) return;
    r.left = true;
    this.game.returnToWorld(userId, r.returnTo);
    if (this.participants().length === 0) this.finishAndReturn();
  }

  private finishAndReturn() {
    if (this.ended) return;
    for (const r of this.participants()) { r.left = true; this.game.returnToWorld(r.userId, r.returnTo); }
    this.end();
  }

  abandon(reason: string) {
    if (this.ended) return;
    if (this.phase !== 'complete') void this.game.store.updateRun(this.id, { status: 'abandoned', result: { reason } });
    for (const r of this.participants()) { r.left = true; this.game.returnToWorld(r.userId, r.returnTo); }
    this.end();
  }

  private end() {
    this.ended = true;
    for (const r of this.roster.values()) this.game.send(r.userId, { t: 'act', view: null });
    this.game.closeInstance(this.inst);
  }

  // ───────────────────────────────────────────────────────── view
  rosterJson() { return [...this.roster.values()].map((r) => ({ userId: r.userId, name: r.name, role: r.role, eligibility: r.eligibility, left: r.left })); }

  private pushView() {
    if (!this.viewDirty && this.inst.tickNo % 10 !== 0) return;
    this.viewDirty = false;
    const shared = this.race.size ? null : this.view();
    for (const p of this.activeEnts()) {
      const view = shared ?? this.viewFor(p.userId);
      const json = JSON.stringify(view);
      if (this.lastViews.get(p.userId) === json) continue;
      this.lastViews.set(p.userId, json);
      this.game.send(p.userId, { t: 'act', view });
    }
  }
  private lastViews = new Map<string, string>();
  /** force a full view re-send to one player (reconnect) */
  resendView(userId: string) { this.lastViews.delete(userId); this.viewDirty = true; }

  private heistView(): HeistRunView | undefined {
    if (!this.isHeist()) return undefined;
    const t = this.heistTake();
    const e = this.def.heist!.elite;
    let carried = 0; for (const v of this.carry.values()) carried += v;
    return {
      difficulty: this.difficulty, approach: this.config.approach, lives: this.lives, livesMax: this.livesMax,
      carried, dropped: t.leftBehind, lost: t.lost, take: t.take, startedAt: this.startedAt, eliteLabel: e.label, eliteSeconds: e.maxSeconds,
      alarm: this.alarm, knockouts: this.knockouts,
    };
  }

  view(): ActivityView {
    const s = this.stage();
    const objectives: ObjectiveView[] = [];
    if (s) for (const o of s.objectives) {
      const st = this.objStates.get(o.id)!;
      const markers: ObjectiveView['markers'] = [];
      let progress: string | undefined;
      if (!st.done) {
        if (o.type === 'reach') markers.push({ x: o.pos[0], y: o.pos[1], z: o.pos[2], kind: o.vehicle ? 'deliver' : 'go', label: o.label, shape: 'circle' });
        if (o.type === 'defend') { markers.push({ x: o.pos[0], y: o.pos[1], z: o.pos[2], kind: 'go', label: o.label, shape: 'circle' }); progress = `${Math.min(100, Math.round(((st.progress ?? 0) / Math.max(0.1, st.required)) * 100))}%`; }
        if (o.type === 'enter_vehicle') for (const k of o.vehicles) { const v = this.inst.vehicles.get(this.keyed.get(k) ?? ''); if (v && !v.destroyedAt) markers.push({ x: v.phys.x, y: v.phys.y, z: v.phys.z, kind: 'vehicle', label: v.label ?? 'Vehicle', shape: 'triangle' }); }
        if (o.type === 'interact' || o.type === 'shoot') {
          let n = 0;
          for (const t of st.targets) {
            const ob = this.inst.objects.get(this.keyed.get(t)!);
            if (!ob) continue;
            if (ob.state === 1) n++;
            else markers.push({ x: ob.x, y: ob.y, z: ob.z, kind: 'interact', shape: 'diamond' });
          }
          progress = `${n}/${o.type === 'interact' && o.simultaneous ? st.targets.length : st.required}`;
        }
        if (o.type === 'lose_wanted' && this.wanted) markers.push({ x: this.wanted.lastKnown.x, y: 22, z: this.wanted.lastKnown.z, kind: 'danger', label: 'Search area', shape: 'square' });
        if (o.type === 'checkpoints') for (let i = 0; i < Math.min(2, o.points.length); i++) markers.push({ x: o.points[i][0], y: o.points[i][1], z: o.points[i][2], kind: 'checkpoint', shape: 'circle' });
      }
      objectives.push({ id: o.id, text: o.label, done: st.done, progress, markers });
    }
    // dropped bags are always marked
    if (this.drops.length) objectives.push({ id: 'drops', text: `Recover the dropped bag${this.drops.length > 1 ? 's' : ''}`, done: false, progress: `$${this.drops.reduce((a, d) => a + d.value, 0).toLocaleString()}`, markers: this.drops.map((d) => ({ x: d.x, y: d.y, z: d.z, kind: 'interact' as const, label: `Bag $${d.value.toLocaleString()}`, shape: 'diamond' as const })) });
    const hv = this.heistView();
    const base: ActivityView = {
      runId: this.id, activity: this.def.id, name: this.def.name, kind: this.def.kind, phase: this.phase,
      stage: s?.id ?? '', stageTitle: s?.title ?? '', stageIndex: this.stageIndex, stageCount: this.def.stages.length,
      objectives,
      timer: this.timerEndsAt ? { endsAt: this.timerEndsAt, label: s?.title ?? '' } : undefined,
      roster: [...this.roster.values()].filter((r) => !r.left).map((r) => {
        const p = this.inst.players.get(r.userId);
        const rr = this.race.get(r.userId);
        return { userId: r.userId, name: r.name, role: r.role, connected: r.connected, down: !!p?.downUntil, score: rr?.finishMs != null ? `${(rr.finishMs / 1000).toFixed(2)} s` : undefined, carry: this.isHeist() ? (this.carry.get(r.userId) ?? 0) : undefined };
      }),
      config: this.def.kind === 'heist' ? { approach: this.config.approach, equipment: this.config.equipment, split: this.config.split, difficulty: this.difficulty, choices: this.choices, setups: this.setups } : undefined,
      failReason: this.phase === 'failed' ? this.failReason + (this.finalFail ? ' (no retries left)' : '') : undefined,
      heist: hv,
      notes: [
        ...(hv ? [`Take so far: $${hv.take.toLocaleString()} · in bags $${hv.carried.toLocaleString()}${hv.lost ? ` · lost $${hv.lost.toLocaleString()}` : ''}`] : []),
        ...(hv && hv.lives !== null ? [`Team lives: ${hv.lives}/${hv.livesMax} (Hard)`] : []),
        ...(this.stage()?.disguised && !this.alarm ? ['Disguised: guards ignore you'] : []),
        ...(this.alarm ? ['ALARM TRIPPED'] : []),
      ],
    };
    // race data is per player; merged on send by the first participant's id (UI reads its own row)
    const first = this.activeEnts()[0];
    if (first && this.race.size) {
      const o = s?.objectives.find((x) => x.type === 'checkpoints') as Extract<ObjectiveDef, { type: 'checkpoints' }> | undefined;
      const r = this.race.get(first.userId);
      if (o && r) {
        const order = [...this.race.entries()].sort((a, b) => score(b[1]) - score(a[1]));
        base.race = { lap: Math.min(r.lap, o.laps), laps: o.laps, cp: r.cp, cps: o.points.length, position: order.findIndex((x) => x[0] === first.userId) + 1, racers: this.race.size, startAt: this.raceStartAt || undefined };
      }
    }
    return base;
  }

  /** per-player view (race position differs per player) */
  viewFor(userId: string): ActivityView {
    const v = this.view();
    if (this.race.size) {
      const o = this.stage()?.objectives.find((x) => x.type === 'checkpoints') as Extract<ObjectiveDef, { type: 'checkpoints' }> | undefined;
      const r = this.race.get(userId);
      if (o && r) {
        const order = [...this.race.entries()].sort((a, b) => score(b[1]) - score(a[1]));
        v.race = { lap: Math.min(r.lap, o.laps), laps: o.laps, cp: r.cp, cps: o.points.length, position: order.findIndex((x) => x[0] === userId) + 1, racers: this.race.size, startAt: this.raceStartAt || undefined };
        const next = o.points[r.cp], after = o.points[(r.cp + 1) % o.points.length];
        v.objectives = v.objectives.map((ob) => ob.id === o.id ? { ...ob, markers: r.finishMs == null ? [{ x: next[0], y: next[1], z: next[2], kind: 'checkpoint', shape: 'circle', label: 'Next' }, { x: after[0], y: after[1], z: after[2], kind: 'checkpoint', shape: 'circle', label: 'Then' }] : [] } : ob);
      }
    }
    return v;
  }

  /** dev/test only: mark the current stage's objectives complete */
  devCompleteStage() {
    if (this.phase === 'cutscene') { this.endCutscene(true); return; }
    if (this.phase !== 'playing') return;
    for (const st of this.objStates.values()) st.done = true;
    this.wanted = null;
    for (const [uid, r] of this.race) if (r.finishMs === null) { r.finishMs = 60_000 + Math.random() * 5000; void uid; }
  }

  /** dev/test only: put loot in a player's bag */
  devGiveLoot(userId: string, value: number) { if (this.isHeist()) { this.carry.set(userId, (this.carry.get(userId) ?? 0) + value); this.loot += value; this.viewDirty = true; } }

  /** the race objective needs per-player views; call from game when pushing */
  sendViews() {
    for (const p of this.activeEnts()) this.game.send(p.userId, { t: 'act', view: this.viewFor(p.userId) });
  }
}

function score(r: RaceProg) { return r.finishMs != null ? 1e9 - r.finishMs : r.lap * 1000 + r.cp; }
function ordinal(n: number) { return n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th'); }

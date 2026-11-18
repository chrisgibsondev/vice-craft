/**
 * Co-operative activity tests with several real clients: heist planning terms,
 * ready checks, group cutscene sync/skip voting, simultaneous co-op objectives,
 * payout split, leader departure, mid-activity reconnect.
 */
process.env.BLOCKSHORE_TEST = '1';
process.env.LOG_LEVEL = 'warn';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Bot, sleep, uname } from './bot.ts';
import type { S2CMsg, LobbyView, ActivityView } from '../packages/shared/src/index.ts';

let srv: Awaited<ReturnType<typeof import('../apps/server/src/index.ts').startServer>>;
let base = '';
before(async () => {
  const { startServer } = await import('../apps/server/src/index.ts');
  srv = await startServer({ port: 0, memoryDb: true });
  base = `http://127.0.0.1:${srv.port}`;
});
after(async () => { await srv.stop('test'); });

async function crew(n: number) {
  const bots: Bot[] = [];
  for (let i = 0; i < n; i++) { const b = await new Bot(base, uname(`c${i}`)).register(); await b.connect(); bots.push(b); }
  const [lead, ...rest] = bots;
  for (const b of rest) {
    await lead.api('POST', '/friends/request', { userId: b.userId });
    await b.api('POST', '/friends/respond', { userId: lead.userId, accept: true });
    await lead.api('POST', '/party/invite', { userId: b.userId });
    const inv = await b.wait((m) => m.t === 'social' && m.event === 'party_invite', 3000, true) as { data: { partyId: string } };
    await b.api('POST', '/party/accept', { partyId: inv.data.partyId });
  }
  await lead.joinWorld('new');
  for (const b of rest) await b.joinWorld('party');
  return bots;
}

const lobbyOf = (b: Bot) => (b.last('lobby')?.view ?? null) as LobbyView | null;
const actOf = (b: Bot) => (b.last('act')?.view ?? null) as ActivityView | null;

async function runActivity(bots: Bot[], activity: string, cfg?: Parameters<Bot['send']>[0]) {
  const [lead, ...rest] = bots;
  lead.send({ t: 'act.lobby', activity });
  await lead.wait((m) => m.t === 'lobby' && !!m.view, 3000);
  if (cfg) { lead.send(cfg); await sleep(150); }
  for (const b of rest) b.send({ t: 'act.ready', ready: true });
  await lead.wait((m) => m.t === 'lobby' && !!(m.view as LobbyView | null)?.canLaunch, 3000);
  lead.send({ t: 'act.launch' });
  for (const b of bots) await b.wait((m) => m.t === 'world' && m.kind === 'activity', 5000);
}

async function finishWithDev(bots: Bot[], maxSteps = 30) {
  for (let i = 0; i < maxSteps; i++) {
    for (const b of bots) { const w = b.msgs.find((m) => m.t === 'cs.waiting'); if (w) { b.send({ t: 'cs.loaded', cs: (w as { cs: string }).cs }); b.msgs.splice(b.msgs.indexOf(w), 1); } }
    bots[0].dev('complete_stage');
    await sleep(220);
    if (bots[0].msgs.some((m) => m.t === 'results')) return;
  }
  throw new Error('activity did not complete');
}

test('heist: preps, locked terms, group skip vote, simultaneous keypads, payout split', async () => {
  const [lead, mate] = await crew(2);
  // leader completes story_1 (unlocks the heist) and both preps — co-op with the mate
  for (const act of ['story_1', 'prep_sundial_scout', 'prep_sundial_wheels']) {
    await runActivity([lead, mate], act);
    await finishWithDev([lead, mate]);
    for (const b of [lead, mate]) b.send({ t: 'act.continue' });
    for (const b of [lead, mate]) await b.wait((m) => m.t === 'world' && m.kind === 'world', 6000);
    lead.msgs = []; mate.msgs = [];
  }
  const prof = await lead.api<{ profile: { preps: Record<string, string[]> } }>('GET', '/me');
  assert.deepEqual(prof.profile.preps.heist_sundial?.filter((e) => !e.startsWith('choice:')).sort(), ['prep_sundial_scout', 'prep_sundial_wheels']);
  assert.ok(prof.profile.preps.heist_sundial?.includes('choice:getaway=gt'), 'the getaway choice (default GT) is stored with the setup');
  // the mate's prep credit belongs to the leader's heist, not theirs
  const mprof = await mate.api<{ profile: { preps: Record<string, string[]> } }>('GET', '/me');
  assert.equal(mprof.profile.preps.heist_sundial, undefined);

  // lobby: mate readies, then the leader changes the split → mate is un-readied
  lead.send({ t: 'act.lobby', activity: 'heist_sundial' });
  await mate.wait((m) => m.t === 'lobby' && !!m.view, 3000);
  mate.send({ t: 'act.ready', ready: true });
  await mate.wait((m) => m.t === 'lobby' && !!(m.view as LobbyView).members.find((x) => x.userId === mate.userId)?.ready, 3000);
  lead.send({ t: 'act.config', approach: 'quiet', split: { [lead.userId]: 60, [mate.userId]: 40 } });
  const after = await mate.wait((m) => m.t === 'lobby' && (m.view as LobbyView).config.split[lead.userId] === 60, 3000) as { view: LobbyView };
  assert.equal(after.view.members.find((x) => x.userId === mate.userId)?.ready, false, 'changing terms clears ready');
  // invalid split is rejected
  lead.send({ t: 'act.config', split: { [lead.userId]: 95, [mate.userId]: 5 } });
  await lead.wait((m) => m.t === 'notify' && /at least 10%/.test(m.text), 3000);
  mate.send({ t: 'act.ready', ready: true });
  await lead.wait((m) => m.t === 'lobby' && !!(m.view as LobbyView).canLaunch, 3000);
  lead.send({ t: 'act.launch' });
  for (const b of [lead, mate]) await b.wait((m) => m.t === 'world' && m.kind === 'activity', 5000);
  // terms are frozen after launch
  lead.send({ t: 'act.config', split: { [lead.userId]: 90, [mate.userId]: 10 } });

  // group cutscene: both load; one skip vote is not enough with 2 players
  for (const b of [lead, mate]) { const w = await b.wait<{ t: 'cs.waiting'; cs: string }>((m) => m.t === 'cs.waiting', 5000, true); b.send({ t: 'cs.loaded', cs: w.cs }); }
  const start = await lead.wait<{ t: 'cs.start'; skipRule: string }>((m) => m.t === 'cs.start', 5000, true);
  assert.match(start.skipRule, /more than half/);
  lead.send({ t: 'cs.skip' });
  const votes = await mate.wait<{ t: 'cs.votes'; votes: number; needed: number }>((m) => m.t === 'cs.votes', 3000);
  assert.equal(votes.votes, 1); assert.equal(votes.needed, 2);
  await sleep(300);
  assert.ok(!lead.msgs.some((m) => m.t === 'cs.end'), 'one vote must not skip a 2-player cutscene');
  mate.send({ t: 'cs.skip' });
  await lead.wait((m) => m.t === 'cs.end', 3000, true);
  await sleep(300);

  // stage: pick the lock (dev-complete), then keypads must be done together
  await waitStage(lead, 'entry_quiet');
  lead.dev('stun_npcs');
  lead.dev('complete_stage');
  await waitStage(lead, 'keypads');
  lead.dev('stun_npcs');
  const objs = () => [...lead.ents.values()].filter((e) => e.k === 'o' && (e as { m: string }).m === 'keypad') as unknown as { id: string; x: number; y: number; z: number; st: number }[];
  await lead.waitSnap(() => objs().length === 2, 3000);
  const [ka, kb] = objs().sort((a, b) => a.x - b.x);
  lead.dev('tp', ka.x, ka.y, ka.z + 1); mate.dev('tp', kb.x, kb.y, kb.z + 1);
  await sleep(400);
  // out of sync: only the lead presses → after the window the keypad resets
  lead.send({ t: 'interact', target: ka.id });
  await lead.move(48, {});
  await lead.wait((m) => m.t === 'notify' && /sync|reset/.test(m.text), 6000);
  // together
  lead.send({ t: 'interact', target: ka.id });
  mate.send({ t: 'interact', target: kb.id });
  await Promise.all([lead.move(50, {}), mate.move(50, {})]);
  await lead.wait((m) => m.t === 'notify' && /Alarm disabled/.test(m.text), 4000, true);
  await waitStage(lead, 'loot');
  await finishWithDev([lead, mate]);
  const res = await lead.wait<{ t: 'results'; data: HeistResults }>((m) => m.t === 'results', 5000, true);
  const l = res.data.lines.find((x) => x.userId === lead.userId)!, m = res.data.lines.find((x) => x.userId === mate.userId)!;
  assert.equal(l.cut, Math.round(res.data.take * 0.6));
  assert.equal(m.cut, Math.round(res.data.take * 0.4));
  // first time pulling The Sundial Job: the first-time (and any elite) bonus is paid on top of the cut
  assert.equal(l.firstBonus, 2000);
  assert.equal(l.cash, l.cut + l.firstBonus + l.eliteBonus);
  assert.equal(res.data.heist.elite.met, l.eliteBonus > 0);
  const prof2 = await lead.api<{ profile: { preps: Record<string, string[]> } }>('GET', '/me');
  assert.equal(prof2.profile.preps.heist_sundial, undefined, 'preps are consumed by the finale');
  lead.close(); mate.close();
});

type HeistResults = {
  take: number;
  lines: { userId: string; cash: number; note: string; pct: number; cut: number; eliteBonus: number; firstBonus: number }[];
  heist: { difficulty: string; base: number; secured: number; lost: number; approachMult: number; diffMult: number; take: number; elite: { met: boolean; checks: { ok: boolean }[] }; choices: Record<string, string> };
};

/** fast-forward a leader's progression: story_1 done + the given setups (with choices) */
async function grantSetups(userId: string, heist: string, preps: string[], choices: Record<string, string> = {}) {
  const store = srv.game.store;
  const runId = async (activity: string) => { const id = `t-${Math.random()}`; await store.createRun({ id, activity, kind: 'test', leader: userId, roster: [], terms: {}, checkpoint: 0 }); return id; };
  await store.grantReward({ runId: await runId('story_1'), userId, cash: 0, rep: 0, complete: 'story_1' });
  for (const prep of preps) {
    const key = prep === 'prep_sundial_wheels' ? 'getaway' : undefined;
    await store.grantReward({ runId: await runId(prep), userId, cash: 0, rep: 0, prep: { heist, prep, choice: key && choices[key] ? { key, option: choices[key] } : undefined } });
  }
}
const runOf = (userId: string) => [...srv.game.instances.values()].find((i) => i.run && i.run.roster.has(userId))?.run ?? null;

function ackCutscenes(bots: Bot[]) {
  for (const b of bots) { const w = b.msgs.find((m) => m.t === 'cs.waiting'); if (w) { b.send({ t: 'cs.loaded', cs: (w as { cs: string }).cs }); b.msgs.splice(b.msgs.indexOf(w), 1); } }
}

/** dev-complete stages, recording every stage id seen, until results arrive */
async function playThrough(bots: Bot[], maxSteps = 50): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < maxSteps; i++) {
    ackCutscenes(bots);
    const st = actOf(bots[0])?.stage;
    if (st && seen[seen.length - 1] !== st) seen.push(st);
    bots[0].dev('stun_npcs');
    bots[0].dev('complete_stage');
    await sleep(220);
    if (bots[0].msgs.some((m) => m.t === 'results')) return seen;
  }
  throw new Error(`activity did not complete (stages: ${seen.join(',')})`);
}

async function launchSolo(b: Bot, activity: string, cfg?: Parameters<Bot['send']>[0]) {
  b.send({ t: 'act.lobby', activity });
  await b.wait((m) => m.t === 'lobby' && !!m.view, 3000);
  if (cfg) { b.send(cfg); await sleep(200); }
  const t0 = Date.now();
  while (!lobbyOf(b)?.canLaunch && Date.now() - t0 < 3000) await sleep(50);
  assert.ok(lobbyOf(b)?.canLaunch, `lobby cannot launch: ${JSON.stringify(lobbyOf(b)?.blockers)}`);
  b.send({ t: 'act.launch' });
  await b.wait((m) => m.t === 'world' && m.kind === 'activity', 5000);
}

test('heist setup choice: the van picked in Getaway Wheels changes the finale escape', async () => {
  const lead = await new Bot(base, uname('ch')).register(); await lead.connect(); await lead.joinWorld('new');
  await grantSetups(lead.userId, 'heist_sundial', ['prep_sundial_scout']);
  // a required setup is missing: the board blocks the launch
  lead.send({ t: 'act.lobby', activity: 'heist_sundial' });
  const lv = await lead.wait<{ t: 'lobby'; view: LobbyView }>((m) => m.t === 'lobby' && !!m.view, 3000);
  assert.ok(lv.view.blockers.some((b) => /Required setups/.test(b) && /Getaway Wheels/.test(b)), 'missing required setup blocks launch');
  assert.ok(lv.view.heist!.setups.some((x) => x.id === 'prep_sundial_rota' && x.optional), 'optional setups are listed as optional');
  assert.ok(lv.view.heist!.approaches.find((a) => a.id === 'con')?.locked, 'con needs the uniforms setup');
  lead.send({ t: 'act.config', approach: 'con' });
  await lead.wait((m) => m.t === 'notify' && /Needs the setup/.test(m.text), 3000);
  lead.send({ t: 'act.cancel' });
  await sleep(150);
  // play the Getaway Wheels setup choosing the van
  lead.msgs = [];
  await launchSolo(lead, 'prep_sundial_wheels', { t: 'act.config', choice: 'van' });
  const prepStages = await playThrough([lead]);
  assert.ok(prepStages.includes('go_van') && !prepStages.includes('go_gt'), `van branch of the setup ran (${prepStages.join(',')})`);
  lead.send({ t: 'act.continue' });
  await lead.wait((m) => m.t === 'world' && m.kind === 'world', 6000);
  const prof = await lead.api<{ profile: { preps: Record<string, string[]> } }>('GET', '/me');
  assert.ok(prof.profile.preps.heist_sundial.includes('choice:getaway=van'));
  // the finale now escapes in the van to Dez's garage
  lead.msgs = [];
  await launchSolo(lead, 'heist_sundial');
  const stages = await playThrough([lead]);
  assert.ok(stages.includes('escape_van') && stages.includes('drop_van') && stages.includes('debrief_van'), `van escape ran (${stages.join(',')})`);
  assert.ok(!stages.includes('drop'), 'the GT drop at Pier 9 is skipped');
  const res = await lead.wait<{ t: 'results'; data: HeistResults }>((m) => m.t === 'results', 5000, true);
  assert.equal(res.data.heist.choices.getaway, 'van');
  lead.close();
});

test('heist difficulty: Hard pays +25% on the secured take; bags drop when a carrier is knocked out', async () => {
  const lead = await new Bot(base, uname('hd')).register(); await lead.connect(); await lead.joinWorld('new');
  await grantSetups(lead.userId, 'heist_sundial', ['prep_sundial_scout', 'prep_sundial_wheels'], { getaway: 'gt' });
  lead.send({ t: 'act.lobby', activity: 'heist_sundial' });
  await lead.wait((m) => m.t === 'lobby' && !!m.view, 3000);
  lead.send({ t: 'act.config', difficulty: 'hard' });
  const lv = await lead.wait<{ t: 'lobby'; view: LobbyView }>((m) => m.t === 'lobby' && m.view?.config.difficulty === 'hard', 3000);
  assert.equal(lv.view.heist!.lives, 2, 'solo Hard: 2 team lives');
  assert.equal(lv.view.heist!.estimate.mult, 1.25);
  assert.ok(lobbyOf(lead)?.canLaunch);
  lead.send({ t: 'act.launch' });
  await lead.wait((m) => m.t === 'world' && m.kind === 'activity', 5000);
  const run = runOf(lead.userId)!;
  assert.equal(run.difficulty, 'hard');
  // skip ahead to the cases and bag some loot
  for (let i = 0; i < 20 && actOf(lead)?.stage !== 'loot'; i++) { ackCutscenes([lead]); lead.dev('stun_npcs'); lead.dev('complete_stage'); await sleep(220); }
  await waitStage(lead, 'loot');
  lead.dev('stun_npcs');
  run.devGiveLoot(lead.userId, 4000);
  await sleep(3200); // spawn protection
  lead.dev('kill');
  await sleep(300);
  assert.equal(run.drops.length, 1, 'the knocked-out carrier dropped the bag');
  assert.equal(run.drops[0].value, 3400, '15% of the bag is damaged');
  assert.equal(run.lootLost, 600);
  assert.equal(run.lives, 1);
  // solo: the crew is down, so the run fails; a retry restores the checkpoint's bag state
  const t0 = Date.now();
  while (actOf(lead)?.phase !== 'failed' && Date.now() - t0 < 4000) await sleep(50);
  assert.equal(actOf(lead)?.phase, 'failed');
  lead.send({ t: 'act.retry' });
  await waitStage(lead, 'loot');
  assert.equal(run.drops.length, 0); assert.equal(run.lootLost, 0);
  run.devGiveLoot(lead.userId, 5000);
  await playThrough([lead]);
  const res = await lead.wait<{ t: 'results'; data: HeistResults }>((m) => m.t === 'results', 5000, true);
  const h = res.data.heist;
  assert.equal(h.difficulty, 'hard');
  assert.equal(h.diffMult, 1.25);
  assert.equal(h.secured, 5000);
  assert.equal(res.data.take, Math.round((9000 + 5000) * h.approachMult * 1.25));
  lead.close();
});

test('heist Hard: team lives run out, the job is over and cannot be retried', async () => {
  const lead = await new Bot(base, uname('lv')).register(); await lead.connect(); await lead.joinWorld('new');
  await grantSetups(lead.userId, 'heist_sundial', ['prep_sundial_scout', 'prep_sundial_wheels']);
  await launchSolo(lead, 'heist_sundial', { t: 'act.config', difficulty: 'hard' });
  const w = await lead.wait<{ t: 'cs.waiting'; cs: string }>((m) => m.t === 'cs.waiting', 5000, true);
  lead.send({ t: 'cs.loaded', cs: w.cs });
  await lead.wait((m) => m.t === 'cs.start', 5000, true);
  lead.send({ t: 'cs.skip' });
  await waitStage(lead, 'entry_quiet');
  lead.dev('stun_npcs');
  await sleep(3200);
  lead.dev('kill');
  let t0 = Date.now();
  while (actOf(lead)?.phase !== 'failed' && Date.now() - t0 < 4000) await sleep(50);
  assert.equal(actOf(lead)!.heist!.lives, 1);
  lead.send({ t: 'act.retry' });
  await waitStage(lead, 'entry_quiet');
  lead.dev('kill');
  t0 = Date.now();
  while (!(actOf(lead)?.phase === 'failed' && actOf(lead)!.heist!.lives === 0) && Date.now() - t0 < 4000) await sleep(50);
  assert.equal(actOf(lead)!.heist!.lives, 0);
  assert.match(actOf(lead)!.failReason ?? '', /team lives/);
  lead.send({ t: 'act.retry' });
  await lead.wait((m) => m.t === 'notify' && /cannot be retried/.test(m.text), 3000);
  assert.equal(actOf(lead)!.phase, 'failed');
  assert.equal(runOf(lead.userId)!.retryable, false);
  lead.close();
});

test('heist cuts lock at launch: later config changes are ignored and the payout uses the launch split', async () => {
  const [lead, mate] = await crew(2);
  await grantSetups(lead.userId, 'heist_sundial', ['prep_sundial_scout', 'prep_sundial_wheels']);
  lead.send({ t: 'act.lobby', activity: 'heist_sundial' });
  await mate.wait((m) => m.t === 'lobby' && !!m.view, 3000);
  lead.send({ t: 'act.config', split: { [lead.userId]: 70, [mate.userId]: 30 }, equipment: ['jammer', 'drill'] });
  const lv = await lead.wait<{ t: 'lobby'; view: LobbyView }>((m) => m.t === 'lobby' && m.view?.config.split[lead.userId] === 70, 3000);
  assert.equal(lv.view.heist!.estimate.perMember[lead.userId], Math.round(lv.view.heist!.estimate.total * 0.7));
  mate.send({ t: 'act.ready', ready: true });
  await lead.wait((m) => m.t === 'lobby' && !!(m.view as LobbyView).canLaunch, 3000);
  lead.send({ t: 'act.launch' });
  for (const b of [lead, mate]) await b.wait((m) => m.t === 'world' && m.kind === 'activity', 5000);
  lead.send({ t: 'act.config', split: { [lead.userId]: 10, [mate.userId]: 90 }, equipment: [] });
  await sleep(300);
  const run = runOf(lead.userId)!;
  assert.deepEqual(run.config.split, { [lead.userId]: 70, [mate.userId]: 30 });
  assert.deepEqual(run.config.equipment, ['jammer', 'drill']);
  await playThrough([lead, mate]);
  const res = await lead.wait<{ t: 'results'; data: HeistResults }>((m) => m.t === 'results', 5000, true);
  const l = res.data.lines.find((x) => x.userId === lead.userId)!, m = res.data.lines.find((x) => x.userId === mate.userId)!;
  assert.equal(l.pct, 70); assert.equal(m.pct, 30);
  assert.equal(l.cut, Math.round(res.data.take * 0.7));
  assert.equal(m.cut, Math.round(res.data.take * 0.3));
  // rewards are idempotent: the grant for this run cannot be paid twice
  const again = await srv.game.store.grantReward({ runId: run.id, userId: lead.userId, cash: 999999, rep: 0 });
  assert.equal(again, 'duplicate');
  lead.close(); mate.close();
});

async function waitStage(b: Bot, stage: string) {
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) { if (actOf(b)?.stage === stage && actOf(b)?.phase === 'playing') return; await sleep(50); }
  throw new Error(`stage ${stage} not reached (at ${actOf(b)?.stage}/${actOf(b)?.phase})`);
}

test('leader leaves mid-mission → leadership passes, activity continues', async () => {
  const [lead, mate] = await crew(2);
  await runActivity([lead, mate], 'story_1');
  for (const b of [lead, mate]) { const w = await b.wait<{ t: 'cs.waiting'; cs: string }>((m) => m.t === 'cs.waiting', 5000, true); b.send({ t: 'cs.loaded', cs: w.cs }); }
  await lead.wait((m) => m.t === 'cs.start', 4000, true);
  lead.send({ t: 'act.leave' });
  await lead.wait((m) => m.t === 'world' && m.kind === 'world', 5000);
  await mate.wait((m) => m.t === 'notify' && /now leads/.test(m.text), 4000, true);
  // the remaining player alone can skip now (1 of 1)
  mate.send({ t: 'cs.skip' });
  await mate.wait((m) => m.t === 'cs.end', 3000, true);
  const v = actOf(mate)!;
  assert.equal(v.roster.length, 1);
  lead.close(); mate.close();
});

test('disconnect mid-activity → reconnect returns to the same activity; outsiders cannot join', async () => {
  const [lead, mate, third] = await crew(3);
  // third leaves the party before launch, rejoins after
  await third.api('POST', '/party/leave');
  await runActivity([lead, mate], 'story_1');
  mate.close();
  await sleep(600);
  await mate.connect();
  const w = await mate.wait<{ t: 'world'; kind: string }>((m) => m.t === 'world', 4000, true);
  assert.equal(w.kind, 'activity');
  await mate.wait((m) => m.t === 'act' && !!m.view, 4000, true);
  // a new party member can't drop into the running activity via world join
  third.send({ t: 'world.join', target: 'party' });
  const r = await third.wait((m) => m.t === 'world' || m.t === 'error', 4000);
  assert.ok(r.t === 'error' || (r as { kind: string }).kind === 'world', 'third player must not enter the activity instance');
  lead.close(); mate.close(); third.close();
});

test('cutscene starts after the bounded wait when a client never finishes loading', async () => {
  const [lead, mate] = await crew(2);
  await runActivity([lead, mate], 'story_1');
  const w = await lead.wait<{ t: 'cs.waiting'; cs: string; deadline: number }>((m) => m.t === 'cs.waiting', 5000, true);
  lead.send({ t: 'cs.loaded', cs: w.cs }); // mate never reports
  const t0 = Date.now();
  await lead.wait((m) => m.t === 'cs.start', 10_000, true);
  assert.ok(Date.now() - t0 > 4000, 'waited for the slow client');
  lead.close(); mate.close();
  void ({} as S2CMsg);
});

test('race mini-game: per-player cars, positions, personal bests', async () => {
  const [lead, mate] = await crew(2);
  // unlock via story_1 for both
  await runActivity([lead, mate], 'story_1');
  await finishWithDev([lead, mate]);
  for (const b of [lead, mate]) b.send({ t: 'act.continue' });
  for (const b of [lead, mate]) await b.wait((m) => m.t === 'world' && m.kind === 'world', 6000);
  lead.msgs = []; mate.msgs = [];
  await runActivity([lead, mate], 'race_downtown');
  for (const b of [lead, mate]) { const w = await b.wait<{ t: 'cs.waiting'; cs: string }>((m) => m.t === 'cs.waiting', 5000, true); b.send({ t: 'cs.loaded', cs: w.cs }); }
  await lead.wait((m) => m.t === 'cs.start', 4000, true);
  lead.send({ t: 'cs.skip' }); mate.send({ t: 'cs.skip' });
  await lead.wait((m) => m.t === 'cs.end', 3000, true);
  // each racer sits in their own car
  const ls = await lead.waitSnap((s) => !!s.me.veh, 3000);
  const ms = await mate.waitSnap((s) => !!s.me.veh, 3000);
  assert.notEqual(ls.me.veh, ms.me.veh);
  // inputs before GO do not move the car
  const p0 = { ...ls.me.vp! };
  await lead.move(20, { th: 1 });
  assert.ok(Math.hypot(lead.snap!.me.vp!.x - p0.x, lead.snap!.me.vp!.z - p0.z) < 0.5, 'frozen until the start lights');
  await finishWithDev([lead, mate]);
  const res = await lead.wait<{ t: 'results'; data: { race: { userId: string; ms: number | null }[]; lines: { note: string }[] } }>((m) => m.t === 'results', 5000, true);
  assert.equal(res.data.race.length, 2);
  assert.ok(res.data.lines.some((l) => /1st place/.test(l.note)));
  const me = await lead.api<{ status: number }>('GET', '/me');
  assert.equal(me.status, 200);
  const pb = await srv.game.store.personalBest(lead.userId, 'race_downtown');
  assert.ok(pb !== null && pb > 0, 'personal best stored');
  lead.close(); mate.close();
});

test('party invite link: join by link, expired/invalid links rejected', async () => {
  const a = await new Bot(base, uname('lnk')).register();
  const b = await new Bot(base, uname('lnk')).register();
  const link = await a.api<{ token: string; url: string }>('POST', '/party/link');
  assert.match(link.url, /\?join=/);
  const info = await b.api<{ leaderName: string; size: number }>('GET', `/party/link/${link.token}`);
  assert.equal(info.size, 1);
  await b.api('POST', '/party/join-link', { token: link.token });
  const p = await a.api<{ party: { members: unknown[] } }>('GET', '/party');
  assert.equal(p.party.members.length, 2);
  const bad = await b.api('POST', '/party/join-link', { token: 'nope-nope' }, false);
  assert.equal(bad.status, 400);
  // transfer leadership, then the old leader can't kick
  await a.api('POST', '/party/transfer', { userId: b.userId });
  const kick = await a.api('POST', '/party/kick', { userId: b.userId }, false);
  assert.equal(kick.status, 400);
});

test('solo: every mission, setup, heist and mini-game can be launched and finished by one player', async () => {
  const { ACTIVITIES } = await import('../packages/shared/src/content/activities.ts');
  const solo = await new Bot(base, uname('solo')).register(); await solo.connect(); await solo.joinWorld('new');
  const store = srv.game.store;
  const all = Object.values(ACTIVITIES) as { id: string; kind: string; preps?: string[]; heist?: unknown }[];
  // unlock everything: every activity completed once, every heist setup done
  for (const a of all) {
    const id = `t-${Math.random()}`;
    await store.createRun({ id, activity: a.id, kind: 'test', leader: solo.userId, roster: [], terms: {}, checkpoint: 0 });
    await store.grantReward({ runId: id, userId: solo.userId, cash: 0, rep: 0, complete: a.id });
  }
  for (const a of all) if (a.kind === 'heist_prep') {
    const heist = all.find((h) => h.kind === 'heist' && (h.preps ?? []).includes(a.id))?.id ?? (a as { heist?: string }).heist;
    if (typeof heist !== 'string') continue;
    const id = `t-${Math.random()}`;
    await store.createRun({ id, activity: a.id, kind: 'test', leader: solo.userId, roster: [], terms: {}, checkpoint: 0 });
    await store.grantReward({ runId: id, userId: solo.userId, cash: 0, rep: 0, prep: { heist, prep: a.id } });
  }
  solo.send({ t: 'world.join', target: 'new' } as never); await sleep(400); // reload the profile
  assert.ok(all.length >= 30, `expected every activity, got ${all.length}`);
  const failed: string[] = [];
  let played = 0;
  for (const a of all) {
    try {
      solo.msgs.length = 0;
      await launchSolo(solo, a.id);
      await playThrough([solo], 60);
      played++;
      solo.send({ t: 'act.leave' } as never);
      await solo.wait((m) => m.t === 'world' && m.kind === 'world', 6000).catch(() => undefined);
      await sleep(150);
    } catch (e) { failed.push(`${a.id}: ${(e as Error).message.slice(0, 120)}`); solo.send({ t: 'act.leave' } as never); await sleep(600); }
  }
  assert.equal(played + failed.length, all.length);
  assert.deepEqual(failed, [], `not soloable:\n${failed.join('\n')}`);
});

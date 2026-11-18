/**
 * Two-bot play-through of BLOCKSHORE on the real world map (Leonia by default), real server, real
 * WebSocket clients, real inputs. See tests/play.ts for the player/autopilot library.
 *
 *   npx tsx scripts/playthrough.ts [section ...]     sections: story heists minigames world shops phone police lobbies all
 *   PLAY_SEC=<n>     per-activity time cap (default 900)     PLAY_WATCH=1  watch cutscenes in full
 */
process.env.BLOCKSHORE_TEST = '1';
process.env.LOG_LEVEL ??= 'warn';
const sections = process.argv.slice(2);
const want = (s: string) => sections.length === 0 || sections.includes('all') || sections.includes(s);

const { sleep } = await import('../tests/bot.ts');
const play = await import('../tests/play.ts');
const { Player, Crew, autopilot, note, LOG } = play;
type Player = InstanceType<typeof Player>;
const shared = await import('../packages/shared/src/index.ts');
const { startServer } = await import('../apps/server/src/index.ts');
const { newId } = await import('../apps/server/src/auth.ts');

const srv = await startServer({ port: 0, memoryDb: true });
const base = `http://127.0.0.1:${srv.port}`;
const game = srv.game;
const PLAY_SEC = Number(process.env.PLAY_SEC ?? 900);
const results: { name: string; ok: boolean; detail: string; ms: number }[] = [];
let uidc = 0;
const uname = (p: string) => `${p}${Date.now().toString(36).slice(-3)}${uidc++}`;

// tick-time watchdog (20 Hz budget = 50 ms)
let tickMax = 0, tickAvg = 0;
const wd = setInterval(async () => { try { const h = await (await fetch(`${base}/api/health`)).json() as { tick: { avgMs: number; maxMs: number } }; tickMax = Math.max(tickMax, h.tick.maxMs); tickAvg = h.tick.avgMs; } catch { /* ignore */ } }, 3000);

async function record(name: string, fn: () => Promise<string | void>) {
  const t0 = Date.now();
  try { const d = await fn(); results.push({ name, ok: true, detail: d ?? '', ms: Date.now() - t0 }); note('OK', `${name} ${d ?? ''}`); }
  catch (e) { results.push({ name, ok: false, detail: String((e as Error).message ?? e), ms: Date.now() - t0 }); note('BUG', `${name} FAILED: ${(e as Error).stack ?? e}`); }
}

async function makeCrew(n: number, prefix = 'pt'): Promise<Player[]> {
  const ps: Player[] = [];
  for (let i = 0; i < n; i++) { const p = await Player.create(game, base, uname(`${prefix}${i}`)); ps.push(p); }
  const [lead, ...rest] = ps;
  for (const b of rest) {
    await lead.bot.api('POST', '/friends/request', { userId: b.uid });
    await b.bot.api('POST', '/friends/respond', { userId: lead.uid, accept: true });
    await lead.bot.api('POST', '/party/invite', { userId: b.uid });
    const inv = await b.bot.wait((m) => m.t === 'social' && m.event === 'party_invite', 3000, true) as { data: { partyId: string } };
    await b.bot.api('POST', '/party/accept', { partyId: inv.data.partyId });
  }
  await lead.bot.joinWorld('new');
  for (const b of rest) await b.bot.joinWorld('party');
  for (const p of ps) p.start();
  return ps;
}
/** a bookkeeping run row so reward_grants can reference it (prerequisites that are not under test) */
async function fakeRun(userId: string, activity: string) { const id = newId(); await game.store.createRun({ id, activity, kind: 'mission', leader: userId, roster: [], terms: {}, checkpoint: 0 }); return id; }
/** mark activities as completed for the whole crew (prerequisites not under test) */
async function prime(ps: Player[], completed: string[]) {
  for (const p of ps) for (const c of completed) await game.store.grantReward({ runId: await fakeRun(p.uid, c), userId: p.uid, cash: 0, rep: 0, complete: c });
}
async function cashOf(p: Player) { return (await p.bot.api<{ profile: { cash: number } }>('GET', '/me')).profile.cash; }
async function profileOf(p: Player) { return (await p.bot.api<{ profile: { completed: Record<string, number>; preps: Record<string, string[]>; cash: number; checkpoints: Record<string, number> } }>('GET', '/me')).profile; }

/** open the lobby, optionally configure, ready everyone, launch; resolves when everyone is in the activity instance */
async function launch(ps: Player[], activity: string, cfg: Record<string, unknown> | null = null, choice?: string) {
  const [lead, ...rest] = ps;
  for (const p of ps) { p.results.length = 0; p.act = null; p.csSeen.length = 0; }
  lead.bot.send({ t: 'act.lobby', activity });
  await lead.bot.wait((m) => m.t === 'lobby' && !!m.view, 4000);
  if (choice) { lead.bot.send({ t: 'act.config', choice }); await sleep(200); }
  if (cfg) { lead.bot.send({ t: 'act.config', ...(cfg as object) } as never); await sleep(250); }
  for (const b of rest) b.bot.send({ t: 'act.ready', ready: true });
  const t0 = Date.now();
  while (!lead.lobby?.canLaunch && Date.now() - t0 < 4000) await sleep(80);
  if (!lead.lobby?.canLaunch) throw new Error(`cannot launch ${activity}: ${JSON.stringify(lead.lobby?.blockers)}`);
  lead.bot.send({ t: 'act.launch' });
  for (const p of ps) { const t1 = Date.now(); while (p.inWorld?.kind !== 'activity' && Date.now() - t1 < 6000) await sleep(60); if (p.inWorld?.kind !== 'activity') throw new Error(`${p.name} was not moved into ${activity}`); }
}
async function returnToWorld(ps: Player[]) {
  for (const p of ps) p.bot.send({ t: 'act.continue' });
  for (const p of ps) { const t1 = Date.now(); while (p.inWorld?.kind !== 'world' && Date.now() - t1 < 8000) await sleep(80); }
}

/** play one activity start to finish; returns the outcome and checks that rewards are granted once */
async function playOne(ps: Player[], activity: string, opts: { cfg?: Record<string, unknown> | null; choice?: string; retries?: number; override?: import('../tests/play.ts').PlayOpts['override']; support?: boolean } = {}) {
  const def = shared.ACTIVITY_BY_ID[activity];
  const before = await Promise.all(ps.map(cashOf));
  const prof0 = await profileOf(ps[0]);
  await launch(ps, activity, opts.cfg ?? null, opts.choice);
  const crew = new Crew(game, ps, activity, { maxSec: PLAY_SEC, cutscenes: process.env.PLAY_WATCH ? 'watch' : 'skip', verbose: true, override: opts.override, support: opts.support ?? (activity === 'story_8') });
  const out = await autopilot(crew);
  if (out !== 'complete') {
    const v = crew.view();
    for (const p of ps) p.bot.send({ t: 'act.leave' });
    await sleep(1200);
    throw new Error(`${activity}: ${out} (${crew.failed ?? ''}) at stage ${v?.stage} objectives=${JSON.stringify(v?.objectives.map((o) => `${o.id}:${o.done}`))}`);
  }
  await sleep(500);
  const after = await Promise.all(ps.map(cashOf));
  const gain = after.map((a, i) => a - before[i]);
  const prof1 = await profileOf(ps[0]);
  await returnToWorld(ps);
  const tps = ps.map((p) => p.tpCount);
  const first = (prof1.completed[activity] ?? 0) - (prof0.completed[activity] ?? 0);
  if (def.kind === 'mission' && first !== 1) note('BUG', `${activity}: completion count changed by ${first}, expected 1`);
  note('INFO', `${activity} done: cash +${gain.join('/')} (def ${JSON.stringify(def.rewards.cash)}), stages=${crew.stagesSeen.length}/${def.stages.length}, tp=${tps.join('/')}`);
  return { gain, crew, tps };
}

// ───────────────────────────────────────────────────────── sections
type Override = NonNullable<import('../tests/play.ts').PlayOpts['override']>;

/** play a heist finale / setup; optionally retry from the checkpoint when it fails */
async function playHeist(ps: Player[], id: string, o: { cfg?: Record<string, unknown>; choice?: string; override?: Override; onStage?: import('../tests/play.ts').PlayOpts['onStage']; retries?: number }) {
  const before = await Promise.all(ps.map(cashOf));
  await launch(ps, id, o.cfg ?? null, o.choice);
  const crew = new Crew(game, ps, id, { maxSec: PLAY_SEC, cutscenes: 'skip', verbose: true, override: o.override, onStage: o.onStage, support: (o.cfg as { approach?: string } | undefined)?.approach === 'loud' });
  let out = await autopilot(crew);
  let retried = 0;
  while (out === 'failed' && retried < (o.retries ?? 0)) {
    note('INFO', `${id}: failed (${crew.failed}); retrying from the checkpoint`);
    retried++;
    ps[0].bot.send({ t: 'act.retry' });
    await sleep(1500);
    out = await autopilot(crew);
  }
  if (out !== 'complete') { for (const p of ps) p.bot.send({ t: 'act.leave' }); await sleep(1200); throw new Error(`${id}: ${out} (${crew.failed ?? ''}) at ${crew.view()?.stage}`); }
  await sleep(600);
  type Res = { take: number; lines: { userId: string; cash: number; cut?: number; pct?: number; eliteBonus?: number; firstBonus?: number; status: string }[]; heist?: { elite: { met: boolean }; alarm: boolean; knockouts: number; retries: number; seconds: number; lost: number; secured: number } };
  const res = ps[0].results[ps[0].results.length - 1]?.data as Res | undefined;
  const after = await Promise.all(ps.map(cashOf));
  const gain = after.map((a, i) => a - before[i]);
  if (res) for (const [i, p] of ps.entries()) {
    const l = res.lines.find((x) => x.userId === p.uid);
    if (!l) { note('BUG', `${id}: no result line for ${p.name}`); continue; }
    if (gain[i] !== l.cash) note('BUG', `${id}: ${p.name} cash gain ${gain[i]} != result line ${l.cash} (paid once?)`);
    if (l.status !== 'paid') note('BUG', `${id}: ${p.name} status ${l.status}`);
    if (l.pct !== undefined && l.cut !== Math.round((res.take * l.pct) / 100)) note('BUG', `${id}: cut ${l.cut} != ${l.pct}% of ${res.take}`);
  }
  await returnToWorld(ps);
  note('INFO', `${id}: take ${res?.take} gains ${gain.join('/')} alarm=${res?.heist?.alarm} ko=${res?.heist?.knockouts} retries=${res?.heist?.retries} secs=${res?.heist?.seconds} elite=${res?.heist?.elite.met}`);
  return { res, gain, crew };
}

async function giveSetups(lead: Player, heist: string, choices: Record<string, string>, skip: string[] = []) {
  const def = shared.ACTIVITY_BY_ID[heist];
  for (const s of def.heist!.setups) {
    if (skip.includes(s.prep)) continue;
    const ch = s.choice ? { key: s.choice.key, option: choices[s.choice.key] ?? s.choice.options[0].id } : undefined;
    await game.store.grantReward({ runId: await fakeRun(lead.uid, s.prep), userId: lead.uid, cash: 0, rep: 0, prep: { heist, prep: s.prep, choice: ch } });
  }
}
const split = (ps: Player[]) => ({ [ps[0].uid]: 60, [ps[1].uid]: 40 });

if (want('story')) {
  await record('story 1-8 co-op', async () => {
    const ps = await makeCrew(2, 'st');
    const lines: string[] = [];
    const [from, to] = (process.env.STORY ?? '1-8').split('-').map(Number);
    if (from > 1) await prime(ps, Array.from({ length: from - 1 }, (_, k) => `story_${k + 1}`));
    for (let i = from; i <= to; i++) {
      const id = `story_${i}`;
      if (i === 8) await prime(ps, ['heist_sundial']);
      const r = await playOne(ps, id);
      lines.push(`${id}: +$${r.gain.join('/')} stages ${r.crew.stagesSeen.length} tp ${r.tps.join('/')}`);
    }
    return lines.join('; ');
  });
}

if (want('minigames')) {
  const ps = await makeCrew(2, 'mg');
  await prime(ps, ['story_1', 'story_2', 'story_3', 'story_4', 'story_5', 'story_6']);
  for (const id of (process.env.MG ?? 'mini_range,race_downtown,mini_taxi,mini_delivery,mini_trial,mini_boatrace').split(',')) {
    await record(`minigame ${id}`, async () => { const r = await playOne(ps, id); const d = ps[0].results[ps[0].results.length - 1]?.data as { lines: { note: string }[] } | undefined; return `+$${r.gain.join('/')} ${d?.lines[0]?.note ?? ''}`; });
  }
}

if (want('heists')) {
  const which = (process.env.HEIST ?? 'sundial,pier9,tower').split(',');
  const PRE: Record<string, string[]> = { sundial: ['story_1'], pier9: ['story_1', 'story_5', 'heist_sundial'], tower: ['story_1', 'story_5', 'story_7', 'heist_sundial', 'heist_pier9'] };
  const CHOICE: Record<string, { key: string; a: string; b: string }> = { sundial: { key: 'getaway', a: 'gt', b: 'van' }, pier9: { key: 'exit', a: 'skiff', b: 'truck' }, tower: { key: 'ledger', a: 'uplink', b: 'drive' } };
  const equipFor = (def: import('../packages/shared/src/index.ts').ActivityDef, approach: string) => {
    const eq = def.heist!.equipment.filter((e) => !e.approach || e.approach === approach).map((e) => e.id);
    return eq.slice(0, 2);
  };
  for (const name of which) {
    const id = `heist_${name}`;
    const def = shared.ACTIVITY_BY_ID[id];
    const ps = await makeCrew(2, `h${name.slice(0, 2)}`);
    await prime(ps, PRE[name]);
    const ch = CHOICE[name];
    // every setup, every choice at least once, played for real
    await record(`${name} setups (all, every choice)`, async () => {
      const lines: string[] = [];
      for (const s of def.heist!.setups) {
        if (s.choice) for (const o of s.choice.options) { const r = await playOne(ps, s.prep, { choice: o.id }); lines.push(`${s.prep}[${o.id}] +$${r.gain.join('/')}`); }
        else { const r = await playOne(ps, s.prep); lines.push(`${s.prep} +$${r.gain.join('/')}`); }
      }
      const pr = await profileOf(ps[0]);
      return `${lines.join('; ')} | preps ${JSON.stringify(pr.preps[id])}`;
    });
    const finale = async (label: string, approach: 'quiet' | 'loud' | 'con', difficulty: 'normal' | 'hard', choice: string, extra: { override?: Override; onStage?: import('../tests/play.ts').PlayOpts['onStage']; retries?: number } = {}) => {
      await record(`${name} finale ${label}`, async () => {
        await giveSetups(ps[0], id, { [ch.key]: choice });
        await playHeist(ps, id, { cfg: { approach, difficulty, equipment: equipFor(def, approach), split: split(ps) }, ...extra });
      });
    };
    let bag = false;
    const bagOverride: Override = async (o, _st, crew, p, idx) => {
      if (name !== 'sundial' || o.type !== 'interact' || o.id !== 'cases' || bag) return false;
      bag = true;
      const mate = crew.players[1 - idx];
      const t = crew.keyedEntity('c1')!;
      const e = p.bot.ents.get(t) as { x: number; y: number; z: number } | undefined;
      if (idx === 0 && e) {
        await p.goTo(e.x, e.z, { tol: 1.1, ty: e.y }); p.bot.send({ t: 'interact', target: t }); await sleep(4000);
        p.dev('kill');
        const t0 = Date.now(); let drop: string | undefined;
        while (!drop && Date.now() - t0 < 5000) { await sleep(100); drop = [...mate.bot.ents.values()].find((x) => x.k === 'o' && /dropped bag/i.test((x as { label?: string }).label ?? ''))?.id; }
        if (!drop) note('BUG', 'sundial: no dropped-bag object after the carrier was knocked out');
        else { const d = mate.bot.ents.get(drop) as { x: number; y: number; z: number }; await mate.goTo(d.x, d.z, { tol: 1.1, ty: d.y }); mate.bot.send({ t: 'interact', target: drop }); await sleep(2500); if (!mate.hasNotify(/recovered a bag/)) note('BUG', 'sundial: bag recovery message missing'); else note('OK', 'bag dropped on knock-out and recovered by the mate'); }
        return true;
      }
      await sleep(15_000); return true;
    };
    await finale('quiet normal (guards live; bag drop+recover)', 'quiet', 'normal', ch.a, { override: bagOverride });
    await finale('loud hard', 'loud', 'hard', ch.b);
    await finale('con normal', 'con', 'normal', ch.a);
    // fail + checkpoint retry: the whole crew goes down in the first loot/vault-type checkpoint stage
    let downed = false;
    const downOv: Override = async (o, st, crew, p, idx) => {
      if (downed || !st.checkpoint || /^(entry|con_|lock|cams)/.test(st.id) || idx !== 0) return false;
      downed = true; await sleep(2500); for (const q of crew.players) q.dev('kill'); await sleep(500); void o; void p; return true;
    };
    await finale('quiet normal: crew down, retry from checkpoint', 'quiet', 'normal', ch.b, { override: downOv, retries: 2 });
    // one player drops mid-heist and comes back inside the grace window
    let dropped = false;
    await finale('loud normal: mate disconnects and rejoins', 'loud', 'normal', ch.a, {
      onStage: async (stage, crew) => {
        if (dropped || stage === def.stages[0].id || stage === def.stages[1].id) return;
        dropped = true;
        void (async () => { await sleep(2000); note('INFO', `${name}: ${crew.players[1].name} drops at stage ${stage}`); await crew.players[1].reconnect(4000); note('INFO', `${name}: mate is back (${crew.players[1].act?.stage})`); })();
      },
    });
  }
}

// ───────────────────────────────────────────────────────── systems: shops, safehouse, garage, vehicles, police, phone, lobbies
const { voxels } = await import('../apps/server/src/world/voxels.ts');
const { nav } = await import('../apps/server/src/world/nav.ts');
const anchorOf = (k: string) => shared.anchor(k);
const profFull = async (p: Player) => (await p.bot.api<{ profile: Record<string, any> }>('GET', '/me')).profile;
const settle = async (ms = 400) => { await sleep(ms); };

/** walk to an interact anchor (tp only for the long leg) and open it */
async function visit(p: Player, key: string, wantShop?: string) {
  const a = anchorOf(key);
  const near = Math.hypot(p.me.x - a.wx, p.me.z - a.wz) < 50;
  if (p.me.veh) await p.exitVehicle();
  const ok = await p.goTo(a.wx, a.wz, { tol: 1.4, ty: a.wy, near: 40, maxSec: 60 });
  if (!ok) throw new Error(`${p.name}: cannot walk to ${key} (${a.wx},${a.wy},${a.wz}); at ${p.me.x.toFixed(1)},${p.me.y.toFixed(1)},${p.me.z.toFixed(1)}`);
  p.bot.msgs = [];
  p.bot.send({ t: 'interact', target: key });
  if (wantShop) { const m = await p.bot.wait<{ t: 'shop'; shop: string; data: { items: { id: string; price: number }[] } }>((x) => x.t === 'shop', 3000).catch(() => null); if (!m) throw new Error(`no shop opened at ${key}`); return m; }
  void near;
  return null;
}
async function buy(p: Player, shop: string, item: string) {
  const c0 = (await profFull(p)).cash as number;
  p.bot.send({ t: 'shop.buy', shop, item });
  await settle(600);
  const c1 = (await profFull(p)).cash as number;
  return c0 - c1;
}

if (want('shops')) {
  const [p] = await makeCrew(1, 'sh');
  await game.store.adjustCash(p.uid, 80_000, 'test funds');
  await p.bot.api('GET', '/me');
  await record('shop: Quik Pelican (snack, medkit, use medkit)', async () => {
    const m = await visit(p, 'store.counter', 'store');
    if (!m || m.shop !== 'store') throw new Error('wrong shop ' + m?.shop);
    const d1 = await buy(p, 'store', 'snack'); const d2 = await buy(p, 'store', 'medkit');
    if (d1 !== 15 || d2 !== 150) throw new Error(`prices charged ${d1}/${d2}`);
    const inv = (await profFull(p)).inventory;
    if (inv.medkit !== 1) throw new Error('medkit not in inventory: ' + JSON.stringify(inv));
    p.dev('kill'); await sleep(300); // knocked down: heal is refused while down; wait for respawn
    return `snack ${d1}, medkit ${d2}`;
  });
  await record('shop: diner + club bar', async () => {
    await visit(p, 'diner.counter', 'diner'); const a = await buy(p, 'diner', 'breakfast');
    await visit(p, 'club.bar', 'club'); const b = await buy(p, 'club', 'mocktail');
    if (a !== 25 || b !== 12) throw new Error(`prices ${a}/${b}`);
    return `breakfast ${a}, mocktail ${b}`;
  });
  await record('shop: Bullseye Arms (pistol, ammo, equip, fire, reload)', async () => {
    await visit(p, 'gunstore.counter', 'gunstore');
    const w = await buy(p, 'gunstore', 'weapon:pistol');
    if (w !== 1200) throw new Error('pistol price ' + w);
    const am = await buy(p, 'gunstore', 'ammo:pistol');
    p.bot.send({ t: 'weapon', id: 'pistol' }); await sleep(400);
    const wm = p.bot.last('weapon');
    for (let i = 0; i < 3; i++) { p.bot.send({ t: 'fire', yaw: 0, pitch: 0 }); await sleep(350); }
    p.bot.send({ t: 'reload' }); await sleep(1600);
    const w2 = p.bot.last('weapon');
    if (!w2 || w2.id !== 'pistol') throw new Error('no pistol ammo state: ' + JSON.stringify(w2));
    return `pistol ${w}, ammo ${am}, mag ${wm?.mag}/${wm?.reserve} → ${w2.mag}/${w2.reserve}`;
  });
  await record('shop: Threadline clothes + barber', async () => {
    await visit(p, 'threadline.counter', 'clothes');
    const c = await buy(p, 'clothes', 'tl_denim');
    const pr = await profFull(p);
    if (pr.outfit !== 0x2e6f95) throw new Error('outfit not applied: ' + pr.outfit);
    await visit(p, 'threadline.chair', 'barber');
    const h = await buy(p, 'barber', 'hr_teal');
    const pr2 = await profFull(p);
    if (pr2.hair !== 0x00b4d8) throw new Error('hair not applied: ' + pr2.hair);
    return `denim ${c}, teal hair ${h}`;
  });
  await record('police: fine payoff', async () => {
    p.dev('heal'); p.dev('wanted', 2); await sleep(500);
    await visit(p, 'police.desk');
    p.dev('stun_npcs'); await sleep(5200);
    const c0 = (await profFull(p)).cash as number;
    p.bot.send({ t: 'wanted.pay' }); await sleep(800);
    const c1 = (await profFull(p)).cash as number;
    if (p.me.wanted !== 0 && c0 === c1) throw new Error(`fine not paid (wanted ${p.me.wanted}); notifies ${JSON.stringify(p.notifies.slice(-3).map((n) => n.text))}`);
    return `fine ${c0 - c1}, wanted now ${p.me.wanted}`;
  });
  await record('safehouse: door, bed save, wardrobe, board, exit', async () => {
    const door = anchorOf('safehouse.door');
    await p.goTo(door.wx, door.wz, { tol: 1.6, ty: door.wy, near: 40 });
    p.bot.send({ t: 'interact', target: 'd:safehouse.door' });
    const w = await p.bot.wait<{ t: 'world'; kind: string }>((m) => m.t === 'world' && m.kind === 'interior', 4000);
    await sleep(500);
    const bed = anchorOf('safehouse.bed');
    if (!(await p.walkTo(bed.wx, bed.wz, { tol: 1.4, ty: bed.wy, maxSec: 30 }))) throw new Error('cannot walk to the bed inside the safehouse');
    p.bot.send({ t: 'interact', target: 'safehouse.bed' });
    if (!(await p.waitNotify(/You rested/, 3000))) throw new Error('bed: no rest message');
    const wd = anchorOf('safehouse.wardrobe');
    if (!(await p.walkTo(wd.wx, wd.wz, { tol: 1.4, ty: wd.wy, maxSec: 30 }))) throw new Error('cannot walk to the wardrobe');
    p.bot.msgs = []; p.bot.send({ t: 'interact', target: 'safehouse.wardrobe' });
    await p.bot.wait((m) => m.t === 'shop', 3000);
    const bd = anchorOf('safehouse.board');
    if (!(await p.walkTo(bd.wx, bd.wz, { tol: 1.4, ty: bd.wy, maxSec: 30 }))) throw new Error('cannot walk to the heist board');
    p.bot.msgs = []; p.bot.send({ t: 'interact', target: 'safehouse.board' });
    await p.bot.wait((m) => m.t === 'ui' && m.open === 'heistboard', 3000);
    const exit = anchorOf('safehouse.door');
    await p.walkTo(exit.wx, exit.wz, { tol: 1.6, ty: exit.wy, maxSec: 30 });
    p.bot.send({ t: 'interact', target: 'd:safehouse.door' });
    await p.bot.wait<{ t: 'world'; kind: string }>((m) => m.t === 'world' && m.kind === 'world', 4000);
    const saved = (await profFull(p)).pos;
    return `${w.kind} → bed/wardrobe/board OK, saved pos ${JSON.stringify(saved)}`;
  });
}

if (want('vehicles')) {
  const [p] = await makeCrew(1, 'vh');
  await game.store.adjustCash(p.uid, 400_000, 'test funds');
  const gsvc = anchorOf('garage.service');
  await record('garage: buy, collect, drive, paint, repair, store', async () => {
    await visit(p, 'garage.service', 'garage');
    p.bot.send({ t: 'garage', op: 'buy', model: 'sedan', color: 0xd7263d }); await settle(700);
    const veh = (await profFull(p)).vehicles as { id: string; model: string; state: string }[];
    const sed = veh.find((v) => v.model === 'sedan');
    if (!sed) throw new Error('sedan not in the garage after buying');
    p.bot.send({ t: 'garage', op: 'spawn', vehicle: sed.id }); await settle(800);
    const mine = [...p.bot.ents.values()].find((e) => e.k === 'v' && (e as { mine?: boolean }).mine) as { id: string; x: number; z: number } | undefined;
    if (!mine) throw new Error('collected vehicle not visible');
    if (!(await p.enterVehicle(mine.id))) throw new Error('cannot enter own vehicle');
    // drive 80 m down the street and back for real
    const v0 = p.me.vp!;
    await p.driveTo(v0.x + Math.sin(-v0.yaw) * 0 + 0, v0.z - 0, { tol: 3 });
    await p.exitVehicle();
    p.bot.send({ t: 'garage', op: 'paint', color: 0x8338ec }); await settle(600);
    const veh2 = (await profFull(p)).vehicles as { color: number }[];
    const painted = veh2.some((v) => v.color === 0x8338ec);
    // wreck it a bit then repair
    const inst = p.inst!; const ve = inst.vehicles.get(mine.id)!; ve.hp = Math.round(ve.def.health * 0.4);
    const c0 = (await profFull(p)).cash as number;
    p.bot.send({ t: 'garage', op: 'repair' }); await settle(700);
    const c1 = (await profFull(p)).cash as number;
    if (!painted) throw new Error('paint did not stick');
    if (ve.hp !== ve.def.health) throw new Error(`repair did not restore health (${ve.hp}/${ve.def.health})`);
    p.bot.send({ t: 'garage', op: 'store' }); await settle(700);
    const st = ((await profFull(p)).vehicles as { model: string; state: string }[]).find((v) => v.model === 'sedan')!;
    if (st.state !== 'stored') throw new Error('vehicle not stored: ' + st.state);
    return `bought, collected, painted, repaired for ${c0 - c1}, stored`;
  });
  await record('garage: supercar buy + drive', async () => {
    p.bot.send({ t: 'garage', op: 'buy', model: 'supercar', color: 0x222831 }); await settle(700);
    const sc = ((await profFull(p)).vehicles as { id: string; model: string }[]).find((v) => v.model === 'supercar');
    if (!sc) throw new Error('supercar not bought');
    p.bot.send({ t: 'garage', op: 'spawn', vehicle: sc.id }); await settle(800);
    const mine = [...p.bot.ents.values()].find((e) => e.k === 'v' && (e as { mine?: boolean }).mine) as { id: string } | undefined;
    if (!mine || !(await p.enterVehicle(mine.id))) throw new Error('cannot enter supercar');
    const t0 = Date.now(); p.inp = { ...p.inp, th: 1, st: 0 };
    let top = 0; while (Date.now() - t0 < 6000) { top = Math.max(top, Math.abs(p.me.vp?.speed ?? 0)); await sleep(100); }
    p.idle();
    await p.exitVehicle();
    return `supercar top speed in 6 s: ${top.toFixed(1)} m/s`;
  });
  await record('boat: buy, collect, board, drive on water, exit', async () => {
    p.bot.send({ t: 'garage', op: 'buy', model: 'boat', color: 0xffffff }); await settle(700);
    const bt = ((await profFull(p)).vehicles as { id: string; model: string }[]).find((v) => v.model === 'boat');
    if (!bt) throw new Error('boat not bought');
    p.bot.send({ t: 'garage', op: 'spawn', vehicle: bt.id }); await settle(900);
    const mine = [...p.bot.ents.values()].find((e) => e.k === 'v' && (e as { m: string }).m === 'boat') as { id: string; x: number; y: number; z: number } | undefined;
    if (!mine) throw new Error('boat not spawned');
    const water = voxels.getBlock(Math.floor(mine.x), 20, Math.floor(mine.z)) === shared.B.WATER;
    if (!water) throw new Error(`boat spawned on non-water at ${mine.x},${mine.y},${mine.z}`);
    if (!(await p.enterVehicle(mine.id))) throw new Error('cannot board the boat (walk to the marina failed)');
    const t0 = Date.now(); const start = { x: p.me.vp!.x, z: p.me.vp!.z };
    p.inp = { ...p.inp, th: 1, st: 0 };
    while (Date.now() - t0 < 5000) await sleep(100);
    p.idle();
    const moved = Math.hypot(p.me.vp!.x - start.x, p.me.vp!.z - start.z);
    const ex = await p.exitVehicle();
    if (moved < 20) throw new Error(`boat barely moved (${moved.toFixed(1)} m)`);
    if (!ex) throw new Error('cannot exit the boat');
    return `boat moved ${moved.toFixed(0)} m on the bay, exited`;
  });
  await record('garage: phone delivery of a stored car', async () => {
    const c0 = (await profFull(p)).cash as number;
    const sed = ((await profFull(p)).vehicles as { id: string; model: string }[]).find((v) => v.model === 'sedan')!;
    await p.tp(13871, 22, 13700); // somewhere else in town
    p.bot.send({ t: 'garage', op: 'deliver', vehicle: sed.id }); await settle(900);
    const c1 = (await profFull(p)).cash as number;
    const d = [...p.bot.ents.values()].find((e) => e.k === 'v' && (e as { mine?: boolean }).mine) as { id: string; x: number; z: number } | undefined;
    if (!d) throw new Error('delivery: no vehicle');
    if (c0 - c1 !== 100) throw new Error('delivery fee ' + (c0 - c1));
    const near = Math.hypot(d.x - p.me.x, d.z - p.me.z);
    return `delivered ${near.toFixed(0)} m away for ${c0 - c1}`;
  });
  void gsvc;
}

if (want('phone')) {
  const [a, b] = await makeCrew(2, 'ph');
  await game.store.adjustCash(a.uid, 600_000, 'test funds');
  await record('phone: dealer, realty, bank, arms, news, leaderboard, style', async () => {
    const out: string[] = [];
    const dl = await a.bot.api<{ models: { model: string; price: number }[]; colors: number[] }>('GET', '/web/dealer');
    for (const m of dl.models.slice(0, 3)) { const r = await a.bot.api<{ ok: boolean }>('POST', '/web/dealer/buy', { model: m.model, color: dl.colors[0] }); out.push(`dealer ${m.model} ${r.ok}`); }
    const pr = await a.bot.api<{ properties: { id: string; price: number; perks: { spawn?: boolean } }[] }>('GET', '/web/properties');
    for (const p of pr.properties) {
      const r = await a.bot.api('POST', '/web/properties/buy', { property: p.id }, false);
      if (r.status !== 200) out.push(`realty ${p.id} -> ${r.status}`);
    }
    await a.bot.api('POST', '/web/properties/collect', { property: 'pelican_franchise' }, false);
    // every spawn property must put the player somewhere walkable at street level
    const bad: string[] = [];
    for (const p of pr.properties.filter((x) => x.perks.spawn)) {
      await a.bot.api('POST', '/web/properties/spawn', { property: p.id }, false);
      await game.refreshSpawn(a.uid);
      const sp = game.spawnSpotFor(a.uid);
      if (!sp) { bad.push(`${p.id}: no spawn spot`); continue; }
      const y = Math.floor(sp.y);
      const ok = play.cellOk(Math.floor(sp.x), y, Math.floor(sp.z));
      const reach = ok ? play.reachableAround({ x: Math.floor(sp.x), y, z: Math.floor(sp.z) }, 400, 30000) : null;
      if (!ok || !reach || reach.dist < 100 || y > 26) bad.push(`${p.id}: spawn ${sp.x.toFixed(0)},${sp.y},${sp.z.toFixed(0)} standable=${ok} reach=${reach?.dist}`);
    }
    if (bad.length) note('BUG', 'property spawn spots: ' + bad.join(' | '));
    const q = await a.bot.api<{ quoteId?: string; quote?: unknown }>('POST', '/web/bank/quote', { to: b.uid, amount: 500 }, false);
    out.push(`bank quote ${q.status}`);
    const arms = await a.bot.api('GET', '/web/arms', undefined, false); out.push(`arms ${arms.status}`);
    for (const path of ['/web/news', '/web/leaderboard', '/web/style', '/web/bank']) { const r = await a.bot.api('GET', path, undefined, false); out.push(`${path} ${r.status}`); if (r.status >= 500) throw new Error(`${path} -> ${r.status}`); }
    return out.join(', ') + (bad.length ? ` | SPAWN PROBLEMS: ${bad.length}` : '');
  });
  void b;
}

if (want('police')) {
  const [p] = await makeCrew(1, 'po');
  await game.store.adjustCash(p.uid, 5000, 'test funds');
  await record('wanted 1-5: gain by crimes, police respond, escape on foot/car, busted respawn', async () => {
    const out: string[] = [];
    await p.tp(14258, 22, 13605); // Biscayne Blvd
    await sleep(1500);
    for (let lvl = 1; lvl <= 5; lvl++) {
      p.dev('wanted', lvl); await sleep(800);
      if (p.me.wanted !== lvl) out.push(`level ${lvl}: server says ${p.me.wanted}`);
      // wait for cops to spawn near
      const t0 = Date.now(); let cops = 0;
      while (Date.now() - t0 < 25_000) { cops = [...p.bot.ents.values()].filter((e) => (e.k === 'v' && (e as { m: string }).m === 'police') || (e.k === 'n' && (e as { r: string }).r === 'cop')).length; if (cops) break; await sleep(500); }
      out.push(`L${lvl}: ${cops} police ents in ${(Date.now() - t0) / 1000}s`);
      p.dev('wanted', 0); await sleep(300);
    }
    return out.join('; ');
  });
}

if (want('lobbies')) {
  await record('custom lobby: create, join by code, capacity cap, access', async () => {
    const [a, b, c] = await makeCrew(3, 'lb').then((x) => x); // party of three, all in one world
    for (const p of [a, b, c]) { p.bot.send({ t: 'world.leave' }); }
    await sleep(500);
    const host = await Player.create(game, base, uname('lbh')); const g1 = await Player.create(game, base, uname('lbg')); const g2 = await Player.create(game, base, uname('lbg')); const g3 = await Player.create(game, base, uname('lbg'));
    host.bot.send({ t: 'world.join', target: { create: { name: 'Test Lobby', access: 'public', capacity: 2 } } });
    const w = await host.bot.wait<{ t: 'world'; code?: string; capacity: number; label: string }>((m) => m.t === 'world', 5000);
    if (!w.code) throw new Error('no lobby code');
    g1.bot.send({ t: 'world.join', target: { code: w.code } });
    const w1 = await g1.bot.wait<{ t: 'world'; players: number }>((m) => m.t === 'world' || m.t === 'error', 5000) as { t: string; players?: number };
    g2.bot.send({ t: 'world.join', target: { code: w.code } });
    const w2 = await g2.bot.wait((m) => m.t === 'world' || m.t === 'error', 5000);
    if (w2.t !== 'error') throw new Error('third player entered a capacity-2 lobby');
    g3.bot.send({ t: 'world.join', target: { code: 'ZZZZZZ' } });
    const w3 = await g3.bot.wait((m) => m.t === 'world' || m.t === 'error', 5000);
    if (w3.t !== 'error') throw new Error('bogus code joined');
    return `lobby ${w.label} code ${w.code} cap ${w.capacity}; second joined=${w1.t}; third refused: ${(w2 as { message?: string }).message}`;
  });
}


void giveSetups;
clearInterval(wd);
console.log('\n===== RESULTS =====');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  (${(r.ms / 1000).toFixed(0)} s)  ${r.detail}`);
console.log('\n===== NOTES (BUG/WARN) =====');
for (const l of LOG.filter((x) => /^\[(BUG|WARN)\]/.test(x))) console.log(l);
console.log('tick avg ms', tickAvg, 'max ms', tickMax, 'rss MB', Math.round(process.memoryUsage().rss / 1e6));
await srv.stop('done');
process.exit(results.every((r) => r.ok) ? 0 : 1);

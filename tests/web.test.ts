/**
 * Phone web (in-game internet): dealership, realty, bank, arms, news, leaderboard.
 * Real server in-process, in-memory PostgreSQL, real REST + WebSocket clients.
 */
process.env.BLOCKSHORE_TEST = '1';
process.env.LOG_LEVEL = 'warn';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Bot, uname } from './bot.ts';

let srv: Awaited<ReturnType<typeof import('../apps/server/src/index.ts').startServer>>;
let base = '';

before(async () => {
  const { startServer } = await import('../apps/server/src/index.ts');
  srv = await startServer({ port: 0, memoryDb: true });
  base = `http://127.0.0.1:${srv.port}`;
});
after(async () => { await srv.stop('test'); });

const cash = async (b: Bot) => (await b.api<{ profile: { cash: number } }>('GET', '/me')).profile.cash;
const fund = (b: Bot, n: number) => srv.game.store.adjustCash(b.userId, n, 'test funds');
async function befriend(a: Bot, b: Bot) {
  await a.api('POST', '/friends/request', { userId: b.userId });
  await b.api('POST', '/friends/respond', { userId: a.userId, accept: true });
}

test('web: requires login', async () => {
  const r = await new Bot(base, uname('anon')).api('GET', '/web/dealer', undefined, false);
  assert.equal(r.status, 401);
});

test('dealership: buy a car online, ledger row, garage cap, invalid input', async () => {
  const a = await new Bot(base, uname('dlr')).register();
  const list = await a.api<{ models: { model: string; price: number }[]; colors: number[]; garage: { used: number; cap: number } }>('GET', '/web/dealer');
  assert.ok(list.models.length >= 7);
  assert.equal(list.garage.cap, 10);
  const sedan = list.models.find((m) => m.model === 'sedan')!;
  // 2000 starting cash: cannot afford yet
  const poor = await a.api('POST', '/web/dealer/buy', { model: 'sedan', color: list.colors[0] }, false);
  assert.equal(poor.status, 409);
  assert.equal(await cash(a), 2000);
  await fund(a, 20_000);
  const bad = await a.api('POST', '/web/dealer/buy', { model: 'police', color: list.colors[0] }, false);
  assert.equal(bad.status, 400);
  const badColour = await a.api('POST', '/web/dealer/buy', { model: 'sedan', color: 123 }, false);
  assert.equal(badColour.status, 400);
  const ok = await a.api<{ ok: boolean; cash: number }>('POST', '/web/dealer/buy', { model: 'sedan', color: list.colors[2] });
  assert.equal(ok.ok, true);
  assert.equal(ok.cash, 22_000 - sedan.price);
  assert.equal(await cash(a), 22_000 - sedan.price);
  const me = await a.api<{ profile: { vehicles: { model: string; color: number; state: string }[] } }>('GET', '/me');
  const v = me.profile.vehicles.find((x) => x.model === 'sedan')!;
  assert.equal(v.color, list.colors[2]);
  assert.equal(v.state, 'stored');
  const led = await srv.game.store.ledgerRows(a.userId);
  assert.equal(led[0].reason, 'buy sedan');
  assert.equal(led[0].amount, -sedan.price);
});

test('realty: buy, double-buy rejected, funds, garage slots, income once per day, spawn', async () => {
  const a = await new Bot(base, uname('rlt')).register();
  const cat = await a.api<{ properties: { id: string; price: number; perks: { garageSlots?: number; dailyIncome?: number; spawn?: boolean } }[]; garage: { cap: number } }>('GET', '/web/properties');
  assert.ok(cat.properties.length >= 6 && cat.properties.length <= 8);
  const lockup = cat.properties.find((p) => p.id === 'torque_lockup')!;
  const poor = await a.api('POST', '/web/properties/buy', { property: lockup.id }, false);
  assert.equal(poor.status, 409);
  assert.equal((await srv.game.store.ownedProperties(a.userId)).owned.length, 0);
  await fund(a, 400_000);
  const c0 = await cash(a);
  const buy = await a.api<{ cash: number; garage: { cap: number } }>('POST', '/web/properties/buy', { property: lockup.id });
  assert.equal(buy.cash, c0 - lockup.price);
  assert.equal(buy.garage.cap, 10 + (lockup.perks.garageSlots ?? 0));
  // second purchase of the same property is rejected and costs nothing
  const dup = await a.api<{ error: string }>('POST', '/web/properties/buy', { property: lockup.id }, false);
  assert.equal(dup.status, 409);
  assert.equal(await cash(a), c0 - lockup.price);
  assert.equal((await srv.game.store.db.query('SELECT 1 FROM properties WHERE user_id = $1', [a.userId])).length, 1);
  assert.equal((await a.api('POST', '/web/properties/buy', { property: 'nope' }, false)).status, 404);
});

test('realty: raised garage cap lets the player exceed 10 vehicles', async () => {
  const a = await new Bot(base, uname('cap')).register();
  await fund(a, 600_000);
  for (let i = 0; i < 9; i++) assert.equal((await srv.game.store.buyVehicle(a.userId, 'compact', 1, 0xffffff)).ok, true); // 10 owned
  const full = await a.api<{ error: string }>('POST', '/web/dealer/buy', { model: 'compact', color: 0xf6f7f8 }, false);
  assert.equal(full.status, 409);
  assert.match(full.error, /Garage full/);
  await a.api('POST', '/web/properties/buy', { property: 'torque_lockup' });
  const ok = await a.api('POST', '/web/dealer/buy', { model: 'compact', color: 0xf6f7f8 });
  assert.equal(ok.status, 200);
});

test('realty: daily income is collectable once per day, spawn point needs ownership', async () => {
  const a = await new Bot(base, uname('inc')).register();
  await fund(a, 300_000);
  const early = await a.api('POST', '/web/properties/collect', { property: 'pelican_franchise' }, false);
  assert.equal(early.status, 409); // not owned
  await a.api('POST', '/web/properties/buy', { property: 'pelican_franchise' });
  const tooSoon = await a.api('POST', '/web/properties/collect', { property: 'pelican_franchise' }, false);
  assert.equal(tooSoon.status, 409); // bought just now: first payout in 24 h
  const c0 = await cash(a);
  // pretend a day has passed
  await srv.game.store.db.query(`UPDATE properties SET last_collected_at = NOW() - INTERVAL '25 hours' WHERE user_id = $1`, [a.userId]);
  const got = await a.api<{ amount: number; cash: number }>('POST', '/web/properties/collect', { property: 'pelican_franchise' });
  assert.equal(got.amount, 1500);
  assert.equal(await cash(a), c0 + 1500);
  const again = await a.api('POST', '/web/properties/collect', { property: 'pelican_franchise' }, false);
  assert.equal(again.status, 409);
  assert.equal(await cash(a), c0 + 1500);
  // businesses without income / non-owned spawn
  const noInc = await a.api('POST', '/web/properties/collect', { property: 'torque_lockup' }, false);
  assert.equal(noInc.status, 409);
  assert.equal((await a.api('POST', '/web/properties/spawn', { property: 'plaza_loft' }, false)).status, 409);
  await a.api('POST', '/web/properties/buy', { property: 'plaza_loft' });
  const sp = await a.api<{ spawn: string }>('POST', '/web/properties/spawn', { property: 'plaza_loft' });
  assert.equal(sp.spawn, 'plaza_loft');
  assert.equal((await a.api('POST', '/web/properties/spawn', { property: 'pelican_franchise' }, false)).status, 400); // no spawn perk
  const view = await a.api<{ spawn: string | null }>('GET', '/web/properties');
  assert.equal(view.spawn, 'plaza_loft');
});

test('bank: friend transfer with confirmation, ledger rows on both sides', async () => {
  const a = await new Bot(base, uname('bka')).register();
  const b = await new Bot(base, uname('bkb')).register();
  await befriend(a, b);
  const bank = await a.api<{ cash: number; friends: { id: string }[]; ledger: unknown[]; limits: { dailyCap: number } }>('GET', '/web/bank');
  assert.equal(bank.friends[0].id, b.userId);
  assert.equal(bank.cash, 2000);
  assert.ok(bank.ledger.length >= 1);
  const q = await a.api<{ token: string; cashAfter: number }>('POST', '/web/bank/quote', { to: b.userId, amount: 500 });
  assert.equal(q.cashAfter, 1500);
  assert.equal(await cash(a), 2000); // quoting moves nothing
  const done = await a.api<{ ok: boolean; cash: number }>('POST', '/web/bank/transfer', { token: q.token });
  assert.equal(done.cash, 1500);
  assert.equal(await cash(a), 1500);
  assert.equal(await cash(b), 2500);
  assert.equal((await srv.game.store.ledgerRows(a.userId))[0].amount, -500);
  assert.equal((await srv.game.store.ledgerRows(b.userId))[0].amount, 500);
  // the confirmation token is single use
  const replay = await a.api('POST', '/web/bank/transfer', { token: q.token }, false);
  assert.equal(replay.status, 410);
  assert.equal(await cash(b), 2500);
  // someone else's token does not work
  const q2 = await a.api<{ token: string }>('POST', '/web/bank/quote', { to: b.userId, amount: 20 });
  assert.equal((await b.api('POST', '/web/bank/transfer', { token: q2.token }, false)).status, 410);
});

test('bank: insufficient funds, non-friend, blocked, bad amounts, daily cap', async () => {
  const a = await new Bot(base, uname('bfa')).register();
  const b = await new Bot(base, uname('bfb')).register();
  const c = await new Bot(base, uname('bfc')).register();
  await befriend(a, b);
  // not a friend
  assert.equal((await a.api('POST', '/web/bank/quote', { to: c.userId, amount: 100 }, false)).status, 403);
  // insufficient funds
  const poor = await a.api('POST', '/web/bank/quote', { to: b.userId, amount: 5000 }, false);
  assert.equal(poor.status, 409);
  // validation
  assert.equal((await a.api('POST', '/web/bank/quote', { to: b.userId, amount: -5 }, false)).status, 400);
  assert.equal((await a.api('POST', '/web/bank/quote', { to: b.userId, amount: 12.5 }, false)).status, 400);
  assert.equal((await a.api('POST', '/web/bank/quote', { to: a.userId, amount: 100 }, false)).status, 404);
  // friendship removed between quote and confirm: the transaction re-checks and moves nothing
  const q = await a.api<{ token: string }>('POST', '/web/bank/quote', { to: b.userId, amount: 100 });
  await a.api('POST', '/friends/remove', { userId: b.userId });
  assert.equal((await a.api('POST', '/web/bank/transfer', { token: q.token }, false)).status, 403);
  assert.equal(await cash(a), 2000); assert.equal(await cash(b), 2000);
  // daily cap
  await befriend(a, b);
  await fund(a, 100_000);
  for (let i = 0; i < 2; i++) {
    const t = await a.api<{ token: string }>('POST', '/web/bank/quote', { to: b.userId, amount: 10_000 });
    await a.api('POST', '/web/bank/transfer', { token: t.token });
  }
  const over = await a.api<{ error: string }>('POST', '/web/bank/quote', { to: b.userId, amount: 10 }, false);
  assert.equal(over.status, 409);
  assert.match(over.error, /Daily limit/);
  assert.equal(await cash(b), 22_000);
  // blocked users are excluded
  await a.api('POST', '/blocks', { userId: b.userId, block: true });
  const bank = await a.api<{ friends: unknown[] }>('GET', '/web/bank');
  assert.equal(bank.friends.length, 0);
  assert.equal((await a.api('POST', '/web/bank/quote', { to: b.userId, amount: 10 }, false)).status, 403);
});

test('arms: remote ammo at a 15% premium; weapons must be bought in person', async () => {
  const a = await new Bot(base, uname('arm')).register();
  const none = await a.api('POST', '/web/arms/ammo', { weapon: 'pistol' }, false);
  assert.equal(none.status, 409); // does not own a pistol
  assert.equal((await a.api('POST', '/web/arms/ammo', { weapon: 'stun' }, false)).status, 409);
  assert.equal((await a.api('POST', '/web/arms/ammo', { weapon: 'bazooka' }, false)).status, 409);
  // grant ownership the way the shop does (weapon + starter ammo)
  await srv.game.store.purchase(a.userId, 0, 'test weapon', { item: 'weapon:pistol', delta: 1, max: 1 });
  await srv.game.store.purchase(a.userId, 0, 'test ammo', { item: 'ammo:pistol', delta: 24, max: 180 });
  const c0 = await cash(a);
  const r = await a.api<{ price: number; added: number; ammo: number; cash: number }>('POST', '/web/arms/ammo', { weapon: 'pistol' });
  assert.equal(r.price, Math.ceil(60 * 1.15));
  assert.equal(r.added, 24);
  assert.equal(r.ammo, 48);
  assert.equal(await cash(a), c0 - r.price);
  assert.equal((await srv.game.store.ledgerRows(a.userId))[0].reason, 'web ammo pistol');
  // cannot exceed the carry limit
  await srv.game.store.purchase(a.userId, 0, 'fill', { item: 'ammo:pistol', delta: 180 - 48, max: 180 });
  assert.equal((await a.api('POST', '/web/arms/ammo', { weapon: 'pistol' }, false)).status, 409);
  // insufficient funds
  const b = await new Bot(base, uname('arb')).register();
  await srv.game.store.purchase(b.userId, 0, 'w', { item: 'weapon:rifle', delta: 1, max: 1 });
  await srv.game.store.adjustCash(b.userId, -1990, 'spend');
  assert.equal((await b.api('POST', '/web/arms/ammo', { weapon: 'rifle' }, false)).status, 409);
});

test('arms: ammo order while connected and in the world updates live ammo', async () => {
  const a = await new Bot(base, uname('arl')).register();
  await srv.game.store.purchase(a.userId, 0, 'w', { item: 'weapon:smg', delta: 1, max: 1 });
  await srv.game.store.purchase(a.userId, 0, 'a', { item: 'ammo:smg', delta: 60, max: 360 });
  await a.connect();
  await a.joinWorld('auto');
  const r = await a.api<{ added: number }>('POST', '/web/arms/ammo', { weapon: 'smg' });
  assert.equal(r.added, 60);
  const pr = await a.wait<{ t: 'profile'; profile: { weapons: { id: string; ammo: number }[] } }>((m) => m.t === 'profile' && (m as { profile: { weapons: { id: string; ammo: number }[] } }).profile.weapons.some((w) => w.id === 'smg' && w.ammo === 120), 4000, true);
  assert.ok(pr);
  a.close();
});

test('news + leaderboards: ticker is anonymous-safe, richest top 20, bests ranked', async () => {
  const a = await new Bot(base, uname('nws')).register();
  const b = await new Bot(base, uname('nwb')).register();
  const store = srv.game.store;
  // a completed heist run paying big, and a race best for each player
  const runId = 'run_web_test_' + Date.now();
  await store.createRun({ id: runId, activity: 'heist_sundial', kind: 'heist', leader: a.userId, roster: [], terms: {}, checkpoint: 0 });
  await store.updateRun(runId, { status: 'complete' });
  await store.grantReward({ runId, userId: a.userId, cash: 4200, rep: 10, complete: 'heist_sundial' });
  await store.submitBest(a.userId, 'race_downtown', 71_000, 'x'); await store.submitBest(b.userId, 'race_downtown', 69_500, 'y');
  const news = await a.api<{ ticker: { name: string; cash: number; activity: string }[]; mine: { cash: number }[] }>('GET', '/web/news');
  assert.ok(news.ticker.some((t) => t.cash === 4200 && t.activity === 'heist_sundial'));
  assert.ok(!JSON.stringify(news).includes(a.userId)); // names only, no ids
  assert.equal(news.mine[0].cash, 4200);
  const other = await b.api<{ mine: unknown[] }>('GET', '/web/news');
  assert.equal(other.mine.length, 0);
  const lb = await a.api<{ boards: Record<string, { name: string; ms: number }[]>; richest: { name: string; cash: number }[] }>('GET', '/web/leaderboard');
  assert.equal(lb.boards.race_downtown[0].name, b.name);
  assert.ok(lb.boards.race_downtown[0].ms < lb.boards.race_downtown[1].ms);
  assert.ok(lb.richest.length <= 20);
  assert.ok(lb.richest.every((r, i, arr) => i === 0 || arr[i - 1].cash >= r.cash));
  assert.ok(!JSON.stringify(lb).includes(a.userId));
});

test('style: remote outfit purchase', async () => {
  const a = await new Bot(base, uname('sty')).register();
  const s = await a.api<{ items: { id: string; price: number; color: number }[] }>('GET', '/web/style');
  assert.ok(s.items.length >= 6);
  const it = s.items.find((i) => i.id === 'tl_denim')!;
  const r = await a.api<{ cash: number; outfit: number }>('POST', '/web/style/buy', { item: it.id });
  assert.equal(r.outfit, it.color);
  assert.equal(r.cash, 2000 - it.price);
  assert.equal((await a.api('POST', '/web/style/buy', { item: it.id }, false)).status, 409); // already wearing
  await srv.game.store.adjustCash(a.userId, -1800, 'spend');
  assert.equal((await a.api('POST', '/web/style/buy', { item: 'tl_gold' }, false)).status, 409); // 1500 > cash left
  assert.equal((await a.api('POST', '/web/style/buy', { item: 'nope' }, false)).status, 404);
});

/**
 * End-to-end tests against the real server (in-process, in-memory PostgreSQL via
 * PGlite) using real WebSocket/REST clients.
 */
process.env.BLOCKSHORE_TEST = '1';
process.env.LOG_LEVEL = 'warn';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Bot, sleep, uname } from './bot.ts';
import { STREET, PLAZA, OPEN, storeCounter } from './spots.ts';

let srv: Awaited<ReturnType<typeof import('../apps/server/src/index.ts').startServer>>;
let base = '';

before(async () => {
  const { startServer } = await import('../apps/server/src/index.ts');
  srv = await startServer({ port: 0, memoryDb: true });
  base = `http://127.0.0.1:${srv.port}`;
});
after(async () => { await srv.stop('test'); });

test('accounts: register, duplicate, bad password, login', async () => {
  const name = uname('acc');
  const a = await new Bot(base, name).register();
  assert.ok(a.token.length > 20);
  const dup = await new Bot(base, name).api('POST', '/auth/register', { username: name, password: 'whatever123' }, false);
  assert.equal(dup.status, 409);
  const bad = await new Bot(base, uname('pw')).api('POST', '/auth/register', { username: uname('pw'), password: 'short' }, false);
  assert.equal(bad.status, 400);
  const wrong = await new Bot(base, name, 'nope-nope-nope').api('POST', '/auth/login', { username: name, password: 'nope-nope-nope' }, false);
  assert.equal(wrong.status, 401);
  const b = await new Bot(base, name).login();
  const me = await b.api<{ profile: { cash: number } }>('GET', '/me');
  assert.equal(me.profile.cash, 2000);
});

test('incompatible client version is rejected with a clear close code', async () => {
  const a = await new Bot(base, uname('ver')).register();
  await a.connect({ version: 999 });
  await sleep(300);
  assert.equal(a.closed?.code, 4003);
});

test('friends → party → same world; see each other moving', async () => {
  const a = await new Bot(base, uname('ana')).register();
  const b = await new Bot(base, uname('ben')).register();
  await a.connect(); await b.connect();
  // party invites require friendship
  const notFriends = await a.api('POST', '/party/invite', { userId: b.userId }, false);
  assert.equal(notFriends.status, 400);
  const req = await a.api<{ result: string }>('POST', '/friends/request', { userId: b.userId });
  assert.equal(req.result, 'sent');
  await b.wait((m) => m.t === 'social' && m.event === 'friend_request', 3000, true);
  await b.api('POST', '/friends/respond', { userId: a.userId, accept: true });
  const fl = await a.api<{ friends: { id: string; status: string }[] }>('GET', '/friends');
  assert.equal(fl.friends[0].id, b.userId);
  assert.equal(fl.friends[0].status, 'online');
  // party
  await a.api('POST', '/party/invite', { userId: b.userId });
  const inv = await b.wait((m) => m.t === 'social' && m.event === 'party_invite', 3000, true) as { data: { partyId: string } };
  await b.api('POST', '/party/accept', { partyId: inv.data.partyId });
  const party = await a.api<{ party: { members: { id: string }[] } }>('GET', '/party');
  assert.equal(party.party.members.length, 2);
  // same world
  const wa = await a.joinWorld('auto');
  const wb = await b.joinWorld('party');
  assert.equal(wa.instance, wb.instance);
  // B sees A, then A walks north and B observes the authoritative position change
  await b.waitSnap(() => b.ents.has(`p:${a.userId}`), 3000);
  const z0 = (b.ents.get(`p:${a.userId}`) as { z: number }).z;
  await a.move(30, { mz: 1, yaw: 0 });
  await sleep(300);
  const z1 = (b.ents.get(`p:${a.userId}`) as { z: number }).z;
  assert.ok(z0 - z1 > 3, `A should have moved north (z ${z0} → ${z1})`);
  // party chat reaches the other member
  a.send({ t: 'chat', ch: 'party', text: 'hello crew' });
  const chat = await b.wait((m) => m.t === 'chat' && m.text === 'hello crew', 3000);
  assert.ok(chat);
  a.close(); b.close();
});

test('blocked users cannot send friend requests or party invites', async () => {
  const a = await new Bot(base, uname('blk')).register();
  const b = await new Bot(base, uname('blk')).register();
  await b.api('POST', '/blocks', { userId: a.userId, block: true });
  const r = await a.api<{ result: string }>('POST', '/friends/request', { userId: b.userId });
  assert.equal(r.result, 'blocked');
  const i = await a.api('POST', '/party/invite', { userId: b.userId }, false);
  assert.equal(i.status, 400);
});

test('shared vehicle: driver controls, passenger rides, no seat conflict', async () => {
  const a = await new Bot(base, uname('drv')).register();
  const b = await new Bot(base, uname('pas')).register();
  await a.connect(); await b.connect();
  await a.api('POST', '/friends/request', { userId: b.userId });
  await b.api('POST', '/friends/respond', { userId: a.userId, accept: true });
  await a.api('POST', '/party/invite', { userId: b.userId });
  const inv = await b.wait((m) => m.t === 'social' && m.event === 'party_invite', 3000, true) as { data: { partyId: string } };
  await b.api('POST', '/party/accept', { partyId: inv.data.partyId });
  await a.joinWorld('new');
  await b.joinWorld('party');
  // put both on a straight street and spawn a car
  a.dev('tp', STREET.x, STREET.y, STREET.z); b.dev('tp', STREET.x + 2, STREET.y, STREET.z + 2);
  await sleep(300);
  a.dev('spawn_vehicle', 'sedan');
  const near = (e: { k?: string; x?: number; z?: number }) => e.k === 'v' && Math.hypot(e.x! - (STREET.x + 4), e.z! - STREET.z) < 3;
  await a.waitSnap(() => [...a.ents.values()].some((e) => near(e as never)), 3000);
  const car = [...a.ents.values()].find((e) => near(e as never))!;
  a.send({ t: 'veh.enter', vehicle: car.id, seat: 0 });
  await a.waitSnap((s) => s.me.veh === car.id && s.me.seat === 0, 3000);
  // B asks for the driver seat — gets a passenger seat instead
  b.send({ t: 'veh.enter', vehicle: car.id, seat: 0 });
  const bs = await b.waitSnap((s) => s.me.veh === car.id, 3000);
  assert.notEqual(bs.me.seat, 0);
  // B's throttle input must not move the car; A's must
  const before = { ...(a.snap!.me.vp!) };
  await b.move(20, { th: 1 });
  await sleep(200);
  const mid = a.snap!.me.vp!;
  assert.ok(Math.hypot(mid.x - before.x, mid.z - before.z) < 0.5, 'passenger input must not drive the car');
  await a.move(40, { th: 1 });
  await sleep(200);
  const after = a.snap!.me.vp!;
  assert.ok(Math.hypot(after.x - before.x, after.z - before.z) > 5, 'driver input moves the car');
  // passenger rides along
  const bMe = b.snap!.me;
  assert.ok(Math.hypot(bMe.x - after.x, bMe.z - after.z) < 4, 'passenger position follows the vehicle');
  // driver disconnects → car stops safely, seat freed
  a.close();
  await sleep(800);
  const ent = b.ents.get(car.id) as { occ: (string | null)[]; sp: number };
  assert.equal(ent.occ[0], null);
  b.close();
});

test('purchases are validated on the server', async () => {
  const a = await new Bot(base, uname('buy')).register();
  await a.connect();
  await a.joinWorld('auto');
  // far from the store
  a.dev('tp', PLAZA.x, PLAZA.y, PLAZA.z);
  await sleep(200);
  a.send({ t: 'shop.buy', shop: 'store', item: 'medkit' });
  const n = await a.wait((m) => m.t === 'notify' && /at the shop/.test(m.text), 3000);
  assert.ok(n);
  a.send({ t: 'shop.buy', shop: 'store', item: 'does-not-exist' });
  await a.wait((m) => m.t === 'notify' && /isn't available/.test(m.text), 3000);
  // at the counter: works, cash decreases by exactly the price
  { const c = storeCounter(); a.dev('tp', c.x, c.y, c.z); }
  await sleep(300);
  const me0 = await a.api<{ profile: { cash: number } }>('GET', '/me');
  a.send({ t: 'shop.buy', shop: 'store', item: 'medkit' });
  await a.wait((m) => m.t === 'notify' && /Bought/.test(m.text), 3000);
  const me1 = await a.api<{ profile: { cash: number; inventory: Record<string, number> } }>('GET', '/me');
  assert.equal(me0.profile.cash - me1.profile.cash, 150);
  assert.equal(me1.profile.inventory.medkit, 1);
  a.close();
});

test('mission: solo run completes once, rewards are idempotent', async () => {
  const a = await new Bot(base, uname('mis')).register();
  await a.connect();
  await a.joinWorld('auto');
  a.send({ t: 'act.lobby', activity: 'story_1' });
  await a.wait((m) => m.t === 'lobby' && !!m.view, 3000);
  a.send({ t: 'act.launch' });
  await a.wait((m) => m.t === 'world' && m.kind === 'activity', 5000);
  // cutscene sync: report loaded, then the server starts it
  const w = await a.wait<{ t: 'cs.waiting'; cs: string }>((m) => m.t === 'cs.waiting', 5000, true);
  a.send({ t: 'cs.loaded', cs: w.cs });
  await a.wait((m) => m.t === 'cs.start', 3000);
  a.send({ t: 'cs.skip' }); // solo: skips immediately
  await a.wait((m) => m.t === 'cs.end', 3000);
  // advance through the stages with the dev helper (cutscenes are skipped as they come)
  for (let i = 0; i < 12; i++) {
    a.dev('complete_stage');
    await sleep(250);
    const r = a.msgs.find((m) => m.t === 'results');
    if (r) break;
  }
  const res = await a.wait<{ t: 'results'; data: { lines: { cash: number; status: string }[] } }>((m) => m.t === 'results', 5000, true);
  assert.equal(res.data.lines[0].cash, 1500);
  assert.equal(res.data.lines[0].status, 'paid');
  const me = await a.api<{ profile: { cash: number; completed: Record<string, number>; unlocks: string[] } }>('GET', '/me');
  assert.equal(me.profile.cash, 3500);
  assert.equal(me.profile.completed.story_1, 1);
  assert.ok(me.profile.unlocks.includes('heist_sundial'));
  // replaying the grant for the same run is a no-op
  const { game } = srv;
  const runId = (await game.store.db.query<{ id: string }>(`SELECT id FROM activity_runs WHERE leader_id = $1 AND status = 'complete'`, [a.userId]))[0].id;
  const dup = await game.store.grantReward({ runId, userId: a.userId, cash: 1500, rep: 100 });
  assert.equal(dup, 'duplicate');
  const me2 = await a.api<{ profile: { cash: number } }>('GET', '/me');
  assert.equal(me2.profile.cash, 3500);
  a.send({ t: 'act.continue' });
  await a.wait((m) => m.t === 'world' && m.kind === 'world', 5000);
  a.close();
});

test('disconnect + reconnect restores the same world slot', async () => {
  const a = await new Bot(base, uname('rec')).register();
  await a.connect();
  const w = await a.joinWorld('auto');
  a.dev('tp', OPEN.x, OPEN.y, OPEN.z);
  await sleep(300);
  a.close();
  await sleep(500);
  await a.connect();
  const w2 = await a.wait<{ t: 'world'; instance: string; pos: number[] }>((m) => m.t === 'world', 3000, true);
  assert.equal(w2.instance, w.instance);
  assert.ok(Math.abs(w2.pos[0] - OPEN.x) < 1 && Math.abs(w2.pos[2] - OPEN.z) < 1);
  a.close();
});

test('lobbies: custom caps are hard limits; invite-only needs the code; friends-only admits friends', async () => {
  const host = await new Bot(base, uname('hst')).register();
  const friend = await new Bot(base, uname('frd')).register();
  const stranger = await new Bot(base, uname('str')).register();
  const extra = await new Bot(base, uname('xtr')).register();
  for (const b of [host, friend, stranger, extra]) await b.connect();
  await host.api('POST', '/friends/request', { userId: friend.userId });
  await friend.api('POST', '/friends/respond', { userId: host.userId, accept: true });
  // invite-only lobby, max 2 players
  host.send({ t: 'world.join', target: { create: { name: 'Crew night', access: 'invite', capacity: 2 } } });
  const w = await host.wait<{ t: 'world'; instance: string; code: string; capacity: number; access: string }>((m) => m.t === 'world', 4000);
  assert.equal(w.capacity, 2); assert.equal(w.access, 'invite'); assert.match(w.code, /^[A-Z0-9]{6}$/);
  // hidden from strangers' browser, refused by id
  const list = await stranger.api<{ worlds: { id: string }[] }>('GET', '/worlds');
  assert.ok(!list.worlds.some((x) => x.id === w.instance), 'invite-only lobby is hidden');
  stranger.send({ t: 'world.join', target: { instance: w.instance } });
  const deny = await stranger.wait<{ t: 'error'; message: string }>((m) => m.t === 'error', 3000);
  assert.match(deny.message, /invite-only/);
  // with the code → allowed (fills the lobby to 2/2)
  stranger.send({ t: 'world.join', target: { code: w.code } });
  const sw = await stranger.wait<{ t: 'world'; instance: string }>((m) => m.t === 'world', 3000);
  assert.equal(sw.instance, w.instance);
  // cap: a third player is refused even with the code
  extra.send({ t: 'world.join', target: { code: w.code } });
  const full = await extra.wait<{ t: 'error'; message: string }>((m) => m.t === 'error', 3000);
  assert.match(full.message, /full \(2\/2\)/);
  // friends-only lobby: the host's friend gets in by id, a stranger does not
  const host2 = await new Bot(base, uname('hs2')).register();
  await host2.connect();
  await host2.api('POST', '/friends/request', { userId: friend.userId });
  await friend.api('POST', '/friends/respond', { userId: host2.userId, accept: true });
  host2.send({ t: 'world.join', target: { create: { name: 'Friends', access: 'friends', capacity: 8 } } });
  const w2 = await host2.wait<{ t: 'world'; instance: string }>((m) => m.t === 'world', 4000);
  const fl = await friend.api<{ worlds: { id: string; joinable: boolean }[] }>('GET', '/worlds');
  assert.ok(fl.worlds.find((x) => x.id === w2.instance)?.joinable, 'friend sees a joinable friends-only lobby');
  friend.send({ t: 'world.join', target: { instance: w2.instance } });
  const fw = await friend.wait<{ t: 'world'; instance: string }>((m) => m.t === 'world', 3000);
  assert.equal(fw.instance, w2.instance);
  extra.msgs = [];
  extra.send({ t: 'world.join', target: { instance: w2.instance } });
  const deny2 = await extra.wait<{ t: 'error'; message: string }>((m) => m.t === 'error', 3000);
  assert.match(deny2.message, /friends-only/);
  // quick join never drops strangers into private lobbies
  extra.msgs = [];
  extra.send({ t: 'world.join', target: 'auto' });
  const aw = await extra.wait<{ t: 'world'; instance: string; access: string }>((m) => m.t === 'world', 3000);
  assert.equal(aw.access, 'public');
  for (const b of [host, friend, stranger, extra, host2]) b.close();
});

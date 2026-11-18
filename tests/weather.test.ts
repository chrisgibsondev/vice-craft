/**
 * Weather + hair colour, end to end against the real server: two players in one instance get the
 * same weather messages (and a forced change reaches both), and a barber purchase sets a persistent
 * hair colour that other players see in their snapshots.
 */
process.env.BLOCKSHORE_TEST = '1';
process.env.LOG_LEVEL = 'warn';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Bot, sleep, uname } from './bot.ts';
import { worldAnchors, SHOPS, type WxMsg, type PlayerEnt, type Ent } from '../packages/shared/src/index.ts';

let srv: Awaited<ReturnType<typeof import('../apps/server/src/index.ts').startServer>>;
let base = '';

before(async () => {
  const { startServer } = await import('../apps/server/src/index.ts');
  srv = await startServer({ port: 0, memoryDb: true });
  base = `http://127.0.0.1:${srv.port}`;
});
after(async () => { await srv.stop('test'); });

async function pair(prefix: string) {
  const a = await new Bot(base, uname(`${prefix}a`)).register();
  const b = await new Bot(base, uname(`${prefix}b`)).register();
  await a.connect(); await b.connect();
  await a.api('POST', '/friends/request', { userId: b.userId });
  await b.api('POST', '/friends/respond', { userId: a.userId, accept: true });
  await a.api('POST', '/party/invite', { userId: b.userId });
  const inv = await b.wait((m) => m.t === 'social' && m.event === 'party_invite', 3000, true) as { data: { partyId: string } };
  await b.api('POST', '/party/accept', { partyId: inv.data.partyId });
  await a.joinWorld('new');
  await b.joinWorld('party');
  return { a, b };
}

const wxOf = (m: WxMsg) => JSON.stringify([m.s, m.p, m.at, m.d]);

test('weather: both players in an instance get the same state, a forced change reaches both', async () => {
  const { a, b } = await pair('wx');
  const wa = await a.wait<WxMsg>((m) => m.t === 'wx', 3000, true);
  const wb = await b.wait<WxMsg>((m) => m.t === 'wx', 3000, true);
  assert.equal(wxOf(wa), wxOf(wb), 'same schedule for the same instance');
  assert.ok(wa.s[0] >= 0 && wa.s[0] <= 5 && wa.s[1] >= 0 && wa.s[1] <= 100 && wa.s[2] >= 0 && wa.s[2] <= 100, 'compact triple in range');
  assert.ok(wa.d >= 25_000 && wa.d <= 65_000 || wa.d === 8000, 'transition lasts 30-60 s');
  // dev: force a thunderstorm, then a downpour
  const n = a.msgs.filter((m) => m.t === 'wx').length;
  a.dev('weather', 'storm');
  const sa = await a.wait<WxMsg>((m) => m.t === 'wx' && a.msgs.filter((x) => x.t === 'wx').length > n && m.s[0] === 4, 3000);
  const sb = await b.wait<WxMsg>((m) => m.t === 'wx' && m.s[0] === 4, 3000);
  assert.equal(wxOf(sa), wxOf(sb));
  a.dev('weather', 'downpour');
  const da = await a.wait<WxMsg>((m) => m.t === 'wx' && m.s[0] === 5, 3000);
  const db = await b.wait<WxMsg>((m) => m.t === 'wx' && m.s[0] === 5, 3000);
  assert.equal(wxOf(da), wxOf(db));
  a.dev('weather', 'auto');
  const back = await a.wait<WxMsg>((m) => m.t === 'wx' && m.at !== da.at, 3000);
  assert.notEqual(back.s[0], 5, 'released to the schedule');
  assert.equal(wxOf(back), wxOf(await b.wait<WxMsg>((m) => m.t === 'wx' && m.at === back.at, 3000, true)));
  a.close(); b.close();
});

test('weather schedule: deterministic, mostly fair weather, changes every few minutes', async () => {
  const { scheduleAt, SLOT_MS } = await import('../apps/server/src/world/weather.ts');
  const seed = 12345;
  assert.deepEqual(scheduleAt(seed, 1_000_000), scheduleAt(seed, 1_000_000));
  let fair = 0, total = 0, changes = 0, last = -1;
  for (let k = 0; k < 600; k++) {
    const s = scheduleAt(seed, 1.7e12 + k * SLOT_MS + 1000);
    total++; if (s.cur[0] <= 1) fair++;
    if (s.cur[0] !== last) changes++;
    last = s.cur[0];
  }
  assert.ok(fair / total > 0.5, `fair weather share ${(fair / total).toFixed(2)}`);
  assert.ok(changes > total * 0.3, 'state changes regularly');
});

test('hair colour: barber purchase persists and other players see it', async () => {
  const { a, b } = await pair('hr');
  const chair = worldAnchors().find((x) => x.kind === 'interact' && x.rule === 'shop:barber');
  assert.ok(chair, 'a barber chair exists in this world');
  a.dev('tp', chair!.wx, chair!.wy, chair!.wz); b.dev('tp', chair!.wx + 1.5, chair!.wy, chair!.wz);
  await sleep(400);
  const hairOf = (bot: Bot, id: string) => (bot.ents.get(id) as PlayerEnt | undefined)?.hr;
  const aId = a.snap!.me && [...b.ents.values()].find((e: Ent) => e.k === 'p')!.id;
  assert.equal(hairOf(b, aId), undefined, 'default look before buying');
  const item = SHOPS.barber.items.find((i) => i.id === 'hr_pink')!;
  const cash0 = (await a.api<{ profile: { cash: number } }>('GET', '/me')).profile.cash;
  a.send({ t: 'shop.buy', shop: 'barber', item: 'hr_pink' });
  await a.wait((m) => m.t === 'notify' && /Hair colour/.test(m.text), 3000);
  await b.waitSnap(() => hairOf(b, aId) === 0xff6bab, 3000);
  const me = await a.api<{ profile: { cash: number; inventory: Record<string, number> } }>('GET', '/me');
  assert.equal(cash0 - me.profile.cash, item.price);
  assert.equal(me.profile.inventory.hair_sel, 0xff6bab);
  assert.equal(me.profile.inventory['hair:ff6bab'], 1);
  // the shop shows the worn colour as owned, the rest as buyable
  a.send({ t: 'shop.buy', shop: 'barber', item: 'hr_black' });
  await b.waitSnap(() => hairOf(b, aId) === 0x151515, 3000);
  const cash1 = (await a.api<{ profile: { cash: number } }>('GET', '/me')).profile.cash;
  // switching back to a colour you already bought is free
  a.send({ t: 'shop.buy', shop: 'barber', item: 'hr_pink' });
  await b.waitSnap(() => hairOf(b, aId) === 0xff6bab, 3000);
  assert.equal((await a.api<{ profile: { cash: number } }>('GET', '/me')).profile.cash, cash1);
  // persists: log in again and the profile carries it
  a.close();
  const a2 = await new Bot(base, a.name).login();
  const me2 = await a2.api<{ profile: { inventory: Record<string, number> } }>('GET', '/me');
  assert.equal(me2.profile.inventory.hair_sel, 0xff6bab);
  b.close();
});

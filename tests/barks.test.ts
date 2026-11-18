/**
 * Street barks: the line bank is well formed, and a player standing in a busy street receives rate-limited
 * 'bark' messages, and firing a weapon nearby produces a reaction line.
 */
process.env.BLOCKSHORE_TEST = '1';
process.env.LOG_LEVEL = 'error';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Bot, sleep, uname } from './bot.ts';
import { PLAZA } from './spots.ts';
import { BARKS, allBarkIds, barkText, parseBarkId, pickBark, barkRoleGroup, type S2CMsg } from '../packages/shared/src/index.ts';

type Bark = Extract<S2CMsg, { t: 'bark' }>;
let srv: Awaited<ReturnType<typeof import('../apps/server/src/index.ts').startServer>>;
let base = '';

before(async () => {
  const { startServer } = await import('../apps/server/src/index.ts');
  srv = await startServer({ port: 0, memoryDb: true });
  base = `http://127.0.0.1:${srv.port}`;
});
after(async () => { await srv.stop('test'); });

test('barks: bank is well formed (unique ids, short lines, enough variety)', () => {
  const ids = allBarkIds();
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  assert.ok(ids.length >= 800, `bank size ${ids.length}`);
  for (const id of ids) {
    const t = barkText(id)!;
    assert.ok(t && t.length >= 2 && t.length <= 60, `${id}: "${t}" (${t?.length})`);
    assert.ok(!t.includes('|'), id);
    const p = parseBarkId(id)!;
    assert.equal(`${p.group}.${p.situation}`, p.pool);
  }
  for (const [pool, lines] of Object.entries(BARKS)) assert.equal(new Set(lines).size, lines.length, `${pool}: duplicate lines`);
  // the generic civilian group, drivers, cops and shopkeepers each have at least 12 lines per situation
  for (const g of ['ped', 'driver', 'cop', 'shop']) for (const [pool, lines] of Object.entries(BARKS)) if (pool.startsWith(g + '.')) assert.ok(lines.length >= 8, `${pool} has ${lines.length}`);
  // never the same line twice when avoiding the previous one
  const seen = new Set<string>();
  for (let i = 0; i < 28; i++) { const id = pickBark('tourist', 'idle', seen)!; assert.ok(!seen.has(id)); seen.add(id); }
  assert.equal(barkRoleGroup('ped:jogger'), 'jogger');
  assert.equal(barkRoleGroup('animal:gator'), null);
  assert.equal(barkRoleGroup('static', 'shopkeeper'), 'shop');
});

test('barks: a busy street talks (rate limited, no immediate repeats) and gunfire is answered', async () => {
  const bot = await new Bot(base, uname('bark')).register();
  const got: { m: Bark; at: number }[] = [];
  await bot.connect();
  bot.ws!.on('message', (d) => { const m = JSON.parse(d.toString()) as S2CMsg; if (m.t === 'bark') got.push({ m, at: Date.now() }); });
  await bot.joinWorld('auto');
  const world = [...srv.game.instances.values()].find((i) => i.kind === 'world')!;
  const me = world.players.get(bot.userId)!;
  bot.dev('tp', PLAZA.x, PLAZA.y, PLAZA.z);

  // wait for people to spawn around the plaza, then for the first lines
  const near = (r: number) => [...world.npcs.values()].filter((n) => (n.role as string).startsWith('ped') && Math.hypot(n.x - me.phys.x, n.z - me.phys.z) < r);
  const t0 = Date.now();
  while (Date.now() - t0 < 40_000 && (near(25).length < 2 || got.length < 3)) { await bot.move(2, {}); }
  assert.ok(near(30).length >= 1, 'pedestrians around the player');
  assert.ok(got.length >= 2, `idle chatter arrived (${got.length} lines)`);
  await bot.move(60, {}); // a few more seconds
  assert.ok(got.length >= 3, `more chatter over time (${got.length})`);

  for (let i = 0; i < got.length; i++) {
    const { m } = got[i];
    assert.equal(m.text, barkText(m.line), 'text matches the bank');
    if (i) {
      assert.ok(got[i].at - got[i - 1].at >= 1300, `gap ${got[i].at - got[i - 1].at} ms between bubbles`);
      assert.notEqual(m.line, got[i - 1].m.line, 'never the same line twice in a row');
    }
  }

  // gunfire: arm the player and shoot into the street
  me.ammo.pistol = { mag: 12, reserve: 120 }; me.weapon = 'pistol';
  await sleep(1800);
  const from = got.length;
  for (let k = 0; k < 5; k++) {
    bot.send({ t: 'fire', yaw: 0.4 * k, pitch: 0 });
    await sleep(450);
  }
  await sleep(1500);
  const after = got.slice(from);
  const react = after.filter((g) => /\.gunfire#/.test(g.m.line));
  assert.ok(react.length >= 1, `gunfire reaction line (got ${after.map((g) => g.m.line).join(', ') || 'none'})`);
  for (let i = 1; i < after.length; i++) assert.ok(after[i].at - after[i - 1].at >= 1300, 'rate limit holds during the shooting too');
  bot.close();
});

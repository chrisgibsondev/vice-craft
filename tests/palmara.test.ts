/**
 * Palmara (the hand-authored world) stays selectable with BLOCKSHORE_WORLD=palmara: the server boots
 * on it, the content keeps its Palmara coordinates (lot-grid anchors), and a shop + mission work there.
 * WORLD is read at import time, so this file runs in its own process and imports dynamically.
 */
process.env.BLOCKSHORE_TEST = '1';
process.env.BLOCKSHORE_WORLD = 'palmara';
process.env.LOG_LEVEL = 'error';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { Bot, sleep, uname } = await import('./bot.ts');
const shared = await import('../packages/shared/src/index.ts');
const { PLAZA, storeCounter } = await import('./spots.ts');
type Srv = Awaited<ReturnType<typeof import('../apps/server/src/index.ts').startServer>>;
let srv: Srv;
let base = '';

before(async () => {
  const { startServer } = await import('../apps/server/src/index.ts');
  srv = await startServer({ port: 0, memoryDb: true });
  base = `http://127.0.0.1:${srv.port}`;
});
after(async () => { await srv.stop('test'); });

test('palmara: world selection, content and anchors stay on the lot grid', () => {
  assert.equal(shared.WORLD, 'palmara');
  assert.equal(shared.WORLD_H, 128);
  // anchors: lot i,j + local offset, unrotated
  const d = shared.anchor('diner.counter');
  assert.equal(d.wx, 52 * 48 + 24.5); assert.equal(d.wz, 66 * 48 + 20);
  // activities keep their authored Palmara coordinates
  assert.deepEqual(shared.ACTIVITY_BY_ID.story_1.start, [2472, 22, 3204]);
  assert.equal(shared.ACTIVITY_BY_ID.story_1.name, 'Welcome to Port Solano');
  assert.deepEqual(PLAZA, { x: 2472, y: 22, z: 3204 });
});

test('palmara: join, label, buy at the store counter, start a mission', async () => {
  const a = await new Bot(base, uname('pal')).register();
  await a.connect();
  const w = await a.joinWorld('auto') as { label?: string };
  assert.match(String(w.label ?? [...srv.game.instances.values()].find((i) => i.kind === 'world')!.label), /^Palmara #/);
  const c = storeCounter();
  a.dev('tp', c.x, c.y, c.z);
  await sleep(300);
  a.send({ t: 'shop.buy', shop: 'store', item: 'medkit' });
  await a.wait((m) => m.t === 'notify' && /Bought/.test(m.text), 3000);
  a.send({ t: 'act.lobby', activity: 'story_1' });
  await a.wait((m) => m.t === 'lobby' && !!m.view, 3000);
  a.send({ t: 'act.launch' });
  await a.wait((m) => m.t === 'world' && m.kind === 'activity', 5000);
  a.close();
});

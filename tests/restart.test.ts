/**
 * Server restart with persistent storage: progress, cash and vehicles survive;
 * an activity that was running is marked interrupted (never paid twice); the
 * party survives; clients reconnect and get a clear message.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'bs-restart-'));
process.env.BLOCKSHORE_TEST = '1';
process.env.PGLITE_DIR = dir;
process.env.LOG_LEVEL = 'error';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Bot, sleep, uname } from './bot.ts';

after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* windows file locks */ } });

test('restart: progress persists, running activity is interrupted, party survives', async () => {
  const { startServer } = await import('../apps/server/src/index.ts');
  let srv = await startServer({ port: 0 });
  let base = `http://127.0.0.1:${srv.port}`;
  const a = await new Bot(base, uname('rsa')).register();
  const b = await new Bot(base, uname('rsb')).register();
  await a.connect(); await b.connect();
  await a.api('POST', '/friends/request', { userId: b.userId });
  await b.api('POST', '/friends/respond', { userId: a.userId, accept: true });
  await a.api('POST', '/party/invite', { userId: b.userId });
  const inv = await b.wait((m) => m.t === 'social' && m.event === 'party_invite', 3000, true) as { data: { partyId: string } };
  await b.api('POST', '/party/accept', { partyId: inv.data.partyId });
  await a.joinWorld('auto');
  a.dev('cash', 777);
  await sleep(300);
  // start a mission and stop the server mid-run
  a.send({ t: 'act.lobby', activity: 'story_1' });
  await a.wait((m) => m.t === 'lobby' && !!m.view, 3000);
  b.send({ t: 'act.ready', ready: true });
  await sleep(200);
  a.send({ t: 'act.launch' });
  await a.wait((m) => m.t === 'world' && m.kind === 'activity', 5000);
  await srv.stop('test-restart');
  await sleep(300);
  assert.equal(a.closed?.code, 4001, 'clients are told the server is restarting');

  srv = await startServer({ port: 0 });
  base = `http://127.0.0.1:${srv.port}`;
  const a2 = new Bot(base, a.name); a2.token = a.token; a2.userId = a.userId;
  await a2.connect();
  const n = await a2.wait((m) => m.t === 'notify' && /interrupted by a server restart/.test(m.text), 3000, true);
  assert.ok(n);
  const me = await a2.api<{ profile: { cash: number; completed: Record<string, number> } }>('GET', '/me');
  assert.equal(me.profile.cash, 2777, 'cash persisted');
  assert.equal(me.profile.completed.story_1 ?? 0, 0, 'interrupted run paid nothing');
  const runs = await srv.game.store.db.query<{ status: string }>('SELECT status FROM activity_runs');
  assert.ok(runs.every((r) => r.status === 'interrupted'));
  const party = await a2.api<{ party: { members: unknown[] } | null }>('GET', '/party');
  assert.equal(party.party?.members.length, 2, 'party restored');
  const veh = await srv.game.store.vehicles(a.userId);
  assert.ok(veh.length >= 1 && veh.every((v) => v.state !== 'out'));
  a2.close();
  await srv.stop('done');
});

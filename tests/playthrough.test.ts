/**
 * Regression tests for bugs found by the play-through (scripts/playthrough.ts). Each test names the bug.
 */
process.env.BLOCKSHORE_TEST = '1';
process.env.LOG_LEVEL = 'warn';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Bot, sleep, uname } from './bot.ts';
import { WeatherClock } from '../apps/server/src/world/weather.ts';

let srv: Awaited<ReturnType<typeof import('../apps/server/src/index.ts').startServer>>;
let base = '';
before(async () => {
  const { startServer } = await import('../apps/server/src/index.ts');
  srv = await startServer({ port: 0, memoryDb: true });
  base = `http://127.0.0.1:${srv.port}`;
});
after(async () => { await srv.stop('test'); });

test('weather: activity and interior instances show the sky of the world they came from', () => {
  const world = new WeatherClock('world-a');
  const act = new WeatherClock('activity-b', world);
  const t = Date.now();
  assert.deepEqual(act.message(t), world.message(t));
  world.force('storm', t, 90);
  assert.deepEqual(act.message(t + 100), world.message(t + 100));
  assert.equal(act.message(t + 100).s[0], 4);
  // a dev force issued inside the activity changes the shared sky
  act.force('clear', t + 200, 50);
  assert.equal(world.message(t + 300).s[0], 0);
  // independent clocks still differ in general
  let differ = 0;
  for (let i = 0; i < 20; i++) { const a = new WeatherClock(`x${i}`), b = new WeatherClock(`y${i}`); if (JSON.stringify(a.message(t).s) !== JSON.stringify(b.message(t).s)) differ++; }
  assert.ok(differ > 3);
});

test('welcome tells the client which world the server runs', async () => {
  const b = await new Bot(base, uname('wld')).register();
  await b.connect();
  const w = b.msgs.find((m) => m.t === 'welcome') as { world?: string } | undefined;
  assert.ok(w?.world === 'leonia' || w?.world === 'palmara');
  b.close();
  await sleep(50);
});

test('an activity launched from a world uses that world\'s weather', async () => {
  const b = await new Bot(base, uname('wx')).register();
  await b.connect(); await b.joinWorld('new');
  b.dev('weather', 'storm', 80); await sleep(200);
  b.send({ t: 'act.lobby', activity: 'story_1' });
  await b.wait((m) => m.t === 'lobby' && !!m.view, 3000);
  b.send({ t: 'act.launch' });
  await b.wait((m) => m.t === 'world' && m.kind === 'activity', 5000);
  await sleep(300);
  const wx = b.last('wx')!;
  assert.equal(wx.s[0], 4, 'the activity instance must show the storm of the lobby world');
  b.close();
});

test('content: every on-foot objective spot (objects, drive-less reach, defend zones) is standable and not in a sealed pocket', async () => {
  const { ACTIVITIES } = await import('../packages/shared/src/index.ts');
  const { cellOk, standY, regionSize } = await import('./play.ts');
  const bad: string[] = [];
  const check = (act: string, what: string, p: [number, number, number]) => {
    const y = standY(p[0], p[2], p[1]);
    if (y === null || Math.abs(y - p[1]) > 2.5) { bad.push(`${act} ${what} ${p.map((n) => n.toFixed(1))}: not standable`); return; }
    if (!cellOk(Math.floor(p[0]), y, Math.floor(p[2]))) { bad.push(`${act} ${what}: not standable`); return; }
    if (regionSize({ x: Math.floor(p[0]), y, z: Math.floor(p[2]) }, 1500) < 1500) bad.push(`${act} ${what} ${p.map((n) => n.toFixed(1))}: sealed pocket`);
  };
  for (const a of ACTIVITIES) {
    for (const s of a.stages) {
      for (const sp of s.spawn ?? []) if (sp.kind === 'object') check(a.id, `${s.id}/${sp.id}`, sp.pos);
      for (const o of s.objectives) if ((o.type === 'reach' && !o.vehicle && o.pos[1] > 21.5) || o.type === 'defend') check(a.id, `${s.id}/${o.id}`, o.pos);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('content: every stage time limit, race par time and minigame par is a finite positive number (story_7 legs had NaN limits and failed at once)', async () => {
  const { ACTIVITIES } = await import('../packages/shared/src/index.ts');
  const bad: string[] = [];
  for (const a of ACTIVITIES) {
    for (const s of a.stages) if (s.timeLimit && !s.timeLimit.every((t) => Number.isFinite(t) && t > 0)) bad.push(`${a.id}/${s.id} timeLimit ${JSON.stringify(s.timeLimit)}`);
    if (a.race && !a.race.parTimes.every((t) => Number.isFinite(t) && t > 0)) bad.push(`${a.id} race par ${JSON.stringify(a.race.parTimes)}`);
    if (a.minigame?.parScores && !a.minigame.parScores.every((t) => Number.isFinite(t) && t > 0)) bad.push(`${a.id} parScores`);
  }
  assert.deepEqual(bad, [], bad.join(' | '));
});

test('content: taxi shift stays inside downtown (legs under 1.3 km by road, bronze par under 15 minutes)', async () => {
  const { ACTIVITY_BY_ID } = await import('../packages/shared/src/index.ts');
  const { nav } = await import('../apps/server/src/world/nav.ts');
  const taxi = ACTIVITY_BY_ID.mini_taxi;
  assert.ok(taxi.minigame!.parScores![2] < 900, 'bronze par ' + taxi.minigame!.parScores);
  const pts: [number, number][] = [[taxi.start[0], taxi.start[2]]];
  for (const s of taxi.stages) { const o = s.spawn?.find((x) => x.kind === 'object') as { pos?: number[] } | undefined; if (o?.pos) pts.push([o.pos[0], o.pos[2]]); }
  for (let i = 1; i < pts.length; i++) {
    const r = nav.route(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    let L = 0; if (r) for (let j = 1; j < r.length; j++) L += Math.hypot(r[j].x - r[j - 1].x, r[j].z - r[j - 1].z);
    assert.ok(r && L < 1500, `leg ${i}: ${Math.round(L)} m`);
  }
});

/**
 * Leonia (real OSM Miami) world: the server boots on the road graph, and traffic, pedestrians
 * and police use real streets. WORLD is read from the env at import time, so this file runs in
 * its own process (node --test runs each file separately) and imports everything dynamically.
 */
process.env.BLOCKSHORE_TEST = '1';
process.env.BLOCKSHORE_WORLD = 'leonia';
process.env.LOG_LEVEL = 'error';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

const { Bot, sleep, uname } = await import('./bot.ts');
const shared = await import('../packages/shared/src/index.ts');
const { leoniaNav } = await import('../apps/server/src/world/nav.ts');
const { voxels } = await import('../apps/server/src/world/voxels.ts');
type Srv = Awaited<ReturnType<typeof import('../apps/server/src/index.ts').startServer>>;
let srv: Srv;
let base = '';

before(async () => {
  const { startServer } = await import('../apps/server/src/index.ts');
  srv = await startServer({ port: 0, memoryDb: true });
  base = `http://127.0.0.1:${srv.port}`;
});
after(async () => { await srv.stop('test'); });

const nav = () => { assert.ok(leoniaNav, 'Leonia nav loaded'); return leoniaNav!; };
/** lateral distance of (x,z) outside the carriageway of the nearest car edge (0 = on the asphalt) */
function offRoad(x: number, z: number): number {
  const g = nav().graph;
  const h = g.nearest(x, z, 40, (e) => g.isCar(e));
  return h ? Math.max(0, h.d - g.eWidth[h.e] / 2) : 99;
}

test('leonia: world + road graph load', () => {
  assert.equal(shared.WORLD, 'leonia');
  const g = nav().graph;
  assert.ok(g.nNodes > 100_000 && g.nEdges > 150_000, `graph ${g.nNodes} nodes / ${g.nEdges} edges`);
  assert.ok(g.loadMs < 1500, `graph decode ${g.loadMs.toFixed(0)} ms`);
  const [sx, , sz] = shared.LEONIA.spawn;
  // A* between downtown and Brickell stays on roads
  const [bx, bz] = shared.lonLatToWorld(-80.1925, 25.7617);
  const r = nav().route(sx, sz, bx, bz);
  assert.ok(r && r.length > 5, 'downtown → Brickell route');
  const len = r!.reduce((s, p, i) => (i ? s + Math.hypot(p.x - r![i - 1].x, p.z - r![i - 1].z) : 0), 0);
  const crow = Math.hypot(bx - sx, bz - sz);
  assert.ok(len >= crow * 0.98 && len < crow * 2.2, `route ${len.toFixed(0)} m vs ${crow.toFixed(0)} m straight`);
  for (let i = 0; i < r!.length; i += 3) assert.ok(offRoad(r![i].x, r![i].z) < 1.5, 'route points lie on roads');
  const d = nav().deliverySpot(sx, sz);
  assert.ok(offRoad(d.x, d.z) < 0.5 && Math.hypot(d.x - sx, d.z - sz) < 60, 'delivery spot on the nearest street');
  const b = nav().boatSpot(sx, sz);
  assert.ok(b && nav().isWater(b.x, b.z), 'boat spot in open water');
});

test('leonia: traffic, pedestrians and police on real streets', async (t) => {
  const bot = await new Bot(base, uname('leo')).register();
  await bot.connect();
  await bot.joinWorld('auto');
  const [sx, sy, sz] = shared.LEONIA.spawn;
  bot.dev('tp', sx, sy, sz);
  const world = [...srv.game.instances.values()].find((i) => i.kind === 'world')!;
  const g = nav().graph;
  const near = (x: number, z: number, r: number) => (x - sx) ** 2 + (z - sz) ** 2 < r * r;
  const traffic = () => [...world.vehicles.values()].filter((v) => v.ai?.kind === 'traffic');
  await sleep(5000);
  srv.game.tickStats.max = 0; // ignore the initial chunk generation burst

  // spawned near the player
  const cars = traffic().filter((v) => near(v.phys.x, v.phys.z, 200));
  const peds = [...world.npcs.values()].filter((n) => (n.role as string).startsWith('ped') && near(n.x, n.z, 140));
  assert.ok(cars.length >= 8, `traffic near the player: ${cars.length}`);
  assert.ok(peds.length >= 20, `pedestrians near the player: ${peds.length}`);
  const walkOk = peds.filter((n) => nav().walkKindAt(n.x, n.z) !== null).length;
  assert.ok(walkOk >= peds.length * 0.8, `pedestrians on sidewalks/footways/parks: ${walkOk}/${peds.length}`);

  // cars sit on road edges at road height and move along them
  const first = new Map(cars.map((v) => [v.id, { x: v.phys.x, z: v.phys.z }]));
  let samples = 0, onLane = 0, worst = 0;
  for (let k = 0; k < 8; k++) {
    for (const v of traffic()) {
      if (v.ai?.edge === undefined) continue;
      const off = offRoad(v.phys.x, v.phys.z);
      samples++; if (off <= 1) onLane++; worst = Math.max(worst, off);
      const gy = voxels.groundY(v.phys.x, v.phys.z, v.phys.y + 1.2);
      assert.ok(Math.abs(gy - v.phys.y) <= 1.01 && v.phys.y >= 21.9 && v.phys.y < 60, `car ${v.id} at y ${v.phys.y.toFixed(2)} (surface ${gy})`);
    }
    await sleep(500);
  }
  assert.ok(worst <= 2.5, `worst lateral offset off the asphalt ${worst.toFixed(2)} m`);
  assert.ok(onLane >= samples * 0.95, `samples on the carriageway: ${onLane}/${samples}`);
  let moved = 0, still = 0;
  for (const v of traffic()) {
    const p = first.get(v.id);
    if (!p) continue;
    still++;
    if (Math.hypot(v.phys.x - p.x, v.phys.z - p.z) > 3) moved++;
  }
  assert.ok(still >= 4 && moved >= still * 0.4, `cars moved along their edges: ${moved}/${still}`);
  for (const v of traffic()) if (v.ai?.edge !== undefined && g.eFlags[v.ai.edge] & shared.GF.ONEWAY) assert.equal(v.ai.edir, 1, 'oneway edges are driven forward');

  // wanted → police spawn on roads and approach via the road graph
  bot.dev('wanted', 1);
  let minD = Infinity, firstD = 0, polSamples = 0, polOnRoad = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 24_000) {
    await sleep(400);
    const pol = [...world.vehicles.values()].filter((v) => v.ai?.kind === 'police');
    for (const u of pol) {
      const d = Math.hypot(u.phys.x - sx, u.phys.z - sz);
      if (!firstD) firstD = d;
      minD = Math.min(minD, d);
      if (d > 25) { polSamples++; if (offRoad(u.phys.x, u.phys.z) <= 3) polOnRoad++; }
    }
    if (minD < 25 && polSamples > 20) break;
  }
  assert.ok(firstD > 0, 'police units spawned');
  assert.ok(firstD >= 45, `units spawn away from the player (${firstD.toFixed(0)} m)`);
  assert.ok(minD < 35, `police reached the search area (closest ${minD.toFixed(0)} m, spawned ${firstD.toFixed(0)} m)`);
  assert.ok(polOnRoad >= polSamples * 0.75, `police samples on roads: ${polOnRoad}/${polSamples}`);

  t.diagnostic(`cars ${cars.length}, peds ${peds.length} (${walkOk} on walkable), lane samples ${onLane}/${samples} (worst ${worst.toFixed(2)} m), moved ${moved}/${still}, police ${firstD.toFixed(0)} → ${minD.toFixed(0)} m, on roads ${polOnRoad}/${polSamples}, tick avg ${srv.game.tickStats.avg.toFixed(2)} ms max ${srv.game.tickStats.max.toFixed(1)} ms`);
  // tick budget (20 Hz → 50 ms)
  assert.ok(srv.game.tickStats.avg < 20, `tick avg ${srv.game.tickStats.avg.toFixed(2)} ms`);
  assert.ok(srv.game.tickStats.max < 250, `tick max ${srv.game.tickStats.max.toFixed(1)} ms`);
  bot.close();
});

/**
 * Load test: N real WebSocket clients join one world, walk/drive around downtown and
 * trigger wanted levels, while we measure server tick time, snapshot bandwidth and
 * memory. Usage: npx tsx scripts/loadtest.ts [players=16] [seconds=40] [--world palmara]   (default leonia)
 * With --world leonia the players are spread over 16 real neighbourhoods across the city
 * (traffic, pedestrians and police then run on the OSM road graph around each of them).
 */
const argv = process.argv.slice(2);
const wi = argv.indexOf('--world');
const WORLD_ARG = wi >= 0 ? argv.splice(wi, 2)[1] : 'leonia';
process.env.BLOCKSHORE_TEST = '1';
process.env.LOG_LEVEL = 'error';
process.env.BLOCKSHORE_WORLD = WORLD_ARG;
// WORLD is read at import time: import everything after the env is set
const { Bot, sleep, uname } = await import('../tests/bot.ts');
type Bot = InstanceType<typeof Bot>;

const N = Number(argv[0] ?? 16);
const SECONDS = Number(argv[1] ?? 40);

const { startServer } = await import('../apps/server/src/index.ts');
const srv = await startServer({ port: 0, memoryDb: true });
const base = `http://127.0.0.1:${srv.port}`;
const bots: Bot[] = [];
let bytes = 0, snaps = 0;
for (let i = 0; i < N; i++) {
  const b = await new Bot(base, uname('load')).register();
  await b.connect();
  b.ws!.on('message', (d: Buffer) => { bytes += d.length; if (d[6] === 0x73 /* "s" of snap */) snaps++; });
  await b.joinWorld('auto');
  bots.push(b);
}
const world = [...srv.game.instances.values()].find((i) => i.kind === 'world')!;
console.log(`${N} clients in ${world.label} (${world.connectedCount()} connected)`);
// half of them get a car, a few become wanted
if (WORLD_ARG === 'leonia') {
  const { lonLatToWorld } = await import('../packages/shared/src/index.ts');
  const { leoniaNav } = await import('../apps/server/src/world/nav.ts');
  // downtown, Brickell, Wynwood, Little Havana, Coral Gables, Coconut Grove, South Beach, Mid Beach,
  // North Beach, MIA, Key Biscayne, Design District, Edgewater, Allapattah, North Miami, Doral
  const LL: [number, number][] = [[-80.1887, 25.7743], [-80.1925, 25.7617], [-80.1993, 25.8010], [-80.2200, 25.7680], [-80.2680, 25.7490], [-80.2400, 25.7280],
    [-80.1320, 25.7810], [-80.1280, 25.8180], [-80.1220, 25.8700], [-80.2870, 25.7950], [-80.1600, 25.6930], [-80.1920, 25.8130],
    [-80.1880, 25.8000], [-80.2300, 25.7990], [-80.1900, 25.8850], [-80.3100, 25.8300]];
  for (let i = 0; i < N; i++) {
    const [x0, z0] = lonLatToWorld(...LL[i % LL.length]);
    let spot = null;
    for (let k = 0; k < 30 && !spot; k++) spot = leoniaNav!.randomWalkSpot(x0, z0, 0, 60);
    const r = spot ?? leoniaNav!.nearestRoad(x0, z0, 300) ?? { x: x0, z: z0 };
    bots[i].dev('tp', r.x, 23, r.z);
  }
} else for (let i = 0; i < N; i++) {
  const b = bots[i];
  b.dev('tp', 2420 + (i % 8) * 24, 22, 3166 + Math.floor(i / 8) * 48 + 2);
}
await sleep(500);
for (let i = 0; i < N; i += 2) bots[i].dev('spawn_vehicle', 'sedan');
await sleep(500);
for (let i = 0; i < N; i += 2) {
  const b = bots[i];
  const v = [...b.ents.values()].filter((e) => e.k === 'v').sort((a, c) => Math.hypot(a.x - b.snap!.me.x, a.z - b.snap!.me.z) - Math.hypot(c.x - b.snap!.me.x, c.z - b.snap!.me.z))[0];
  if (v) b.send({ t: 'veh.enter', vehicle: v.id, seat: 0 });
}
for (let i = 1; i < N; i += 5) bots[i].dev('wanted', 1);
srv.game.tickStats.max = 0;
const t0 = Date.now();
bytes = 0; snaps = 0;
const movers = bots.map((b, i) => (async () => {
  let yaw = (i * 1.3) % (Math.PI * 2);
  while (Date.now() - t0 < SECONDS * 1000) {
    yaw += (Math.random() - 0.5) * 0.3;
    await b.move(10, { mz: 1, sprint: true, yaw, th: 0.8, st: Math.sin(Date.now() / 1500 + i) * 0.6 });
  }
})());
const samples: number[] = [];
const sampler = setInterval(() => samples.push(srv.game.tickStats.avg), 1000);
await Promise.all(movers);
clearInterval(sampler);
const secs = (Date.now() - t0) / 1000;
const counts = { vehicles: world.vehicles.size, npcs: world.npcs.size, traffic: [...world.vehicles.values()].filter((v) => v.ai?.kind === 'traffic').length, police: [...world.vehicles.values()].filter((v) => v.ai?.kind === 'police').length, peds: [...world.npcs.values()].filter((n) => n.role === 'ped' || n.role.startsWith('ped:')).length, animals: [...world.npcs.values()].filter((n) => n.role.startsWith('animal:')).length };
const result = {
  world: WORLD_ARG, players: N, seconds: Math.round(secs),
  tickBudgetMs: 50,
  tickAvgMs: +(samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length)).toFixed(2),
  tickMaxMs: +srv.game.tickStats.max.toFixed(2),
  downKBpsPerClient: +((bytes / secs / N) / 1024).toFixed(1),
  snapshotsPerClientPerSec: +(snaps / secs / N).toFixed(1),
  entities: counts,
  rssMb: Math.round(process.memoryUsage().rss / 1e6),
  chunksCached: (await import('../apps/server/src/world/voxels.ts')).voxels.size(),
};
console.log(JSON.stringify(result, null, 2));
for (const b of bots) b.close();
await srv.stop('loadtest');
process.exit(0);
export {};

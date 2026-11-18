/** VICE CRAFT server entry: HTTP (REST + static) and WebSocket on one port. */
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { config, originAllowed } from './config.ts';
import { log } from './log.ts';
import { openDb, migrate } from './db/index.ts';
import { Store } from './store.ts';
import { Game } from './game.ts';
import { makeHttpHandler, clientIp } from './http.ts';
import { voxels } from './world/voxels.ts';

export async function startServer(opts: { port?: number; memoryDb?: boolean } = {}) {
  const db = await openDb({ memory: opts.memoryDb });
  await migrate(db);
  const store = new Store(db);
  const game = new Game(store);
  await game.init();
  // warm the chunk cache around the spawn district
  for (let cz = 190; cz <= 210; cz++) for (let cx = 148; cx <= 172; cx++) voxels.chunk(cx, cz);

  const server = createServer(makeHttpHandler(game));
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    // production: only accept game connections from our own origin (blocks cross-site WebSocket hijacking)
    if (config.isProd) {
      const origin = req.headers.origin;
      try { if (origin && new URL(origin).host !== req.headers.host && !originAllowed(origin)) { socket.destroy(); return; } } catch { socket.destroy(); return; }
    }
    wss.handleUpgrade(req, socket, head, (ws) => game.attach(ws, clientIp(req)));
  });
  const port = opts.port ?? config.port;
  await new Promise<void>((resolve) => server.listen(port, config.host, resolve));
  const actual = (server.address() as { port: number }).port;
  game.start();
  log.info('server listening', { port: actual, host: config.host, db: db.kind, env: config.env, devCommands: config.devCommands });

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    await game.shutdown();
    wss.close();
    server.close();
    await new Promise((r) => setTimeout(r, 300));
    await db.close().catch(() => {});
  };
  return { game, server, stop, port: actual };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()!);
if (isMain) {
  const s = await startServer();
  const bye = async (sig: string) => { await s.stop(sig); process.exit(0); };
  process.on('SIGINT', () => void bye('SIGINT'));
  process.on('SIGTERM', () => void bye('SIGTERM'));
  process.on('unhandledRejection', (e) => log.error('unhandled rejection', { err: String(e) }));
}

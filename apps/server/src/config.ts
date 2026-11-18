/** Explicit runtime configuration. Everything comes from env vars; see .env.example. */
import { resolve, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** apps/server */
const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(SERVER_DIR, '..', '..');
// load .env from the repo root (or apps/server) when present; real env vars win
for (const f of [resolve(REPO_ROOT, '.env'), resolve(SERVER_DIR, '.env')]) {
  if (existsSync(f) && !process.env.BLOCKSHORE_TEST) { try { (process as unknown as { loadEnvFile(p: string): void }).loadEnvFile(f); } catch { /* ignore */ } }
}

const env = process.env;
const NODE_ENV = env.NODE_ENV ?? 'development';
const isProd = NODE_ENV === 'production';

export const config = {
  env: NODE_ENV,
  isProd,
  port: Number(env.PORT ?? 5421),
  host: env.HOST ?? (isProd ? '0.0.0.0' : '127.0.0.1'),
  /** Real PostgreSQL in production. When unset (dev only) an embedded PGlite database is used. */
  databaseUrl: env.DATABASE_URL ?? '',
  pgliteDir: resolve(REPO_ROOT, env.PGLITE_DIR ?? '.data/pglite'),
  /** Dev commands (teleport, give cash, force stage) — never enabled in production. */
  devCommands: !isProd && env.DEV_COMMANDS !== '0',
  /** Comma-separated usernames that are administrators. */
  adminUsers: (env.ADMIN_USERS ?? (isProd ? '' : 'admin')).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  /** Static client build to serve (production single-origin deploy). */
  clientDist: resolve(REPO_ROOT, env.CLIENT_DIST ?? 'apps/client/dist'),
  sessionDays: Number(env.SESSION_DAYS ?? 30),
  trustProxy: env.TRUST_PROXY === '1',
  /** extra browser origins allowed to call the API / open the game socket (client hosted elsewhere, e.g. Vercel) */
  allowedOrigins: [env.ALLOWED_ORIGINS ?? '', env.ALLOWED_ORIGINS_EXTRA ?? ''].join(',').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean),
  maxInstances: Number(env.MAX_INSTANCES ?? 40),
  /** test mode: in-memory database, faster timers */
  test: env.BLOCKSHORE_TEST === '1',
};

/**
 * Is this browser origin allowed to use the API / game socket? ALLOWED_ORIGINS entries may use `*`
 * as a wildcard inside the host, e.g. `https://blockshore-*.vercel.app` (every Vercel address of the project).
 */
export function originAllowed(origin: string): boolean {
  return config.allowedOrigins.some((p) => p === origin || (p.includes('*') && new RegExp('^' + p.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('[a-z0-9-]*') + '$', 'i').test(origin)));
}

if (isProd && !config.databaseUrl) {
  // Fail fast: production must never silently fall back to the embedded dev database.
  console.error('FATAL: DATABASE_URL is required in production');
  process.exit(1);
}

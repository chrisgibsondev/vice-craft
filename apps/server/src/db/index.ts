/**
 * Database access. Production: PostgreSQL via `pg`. Development (no DATABASE_URL):
 * embedded PGlite — the same PostgreSQL engine compiled to WASM, persisted under
 * .data/pglite. Tests use an in-memory PGlite.
 */
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.ts';
import { log } from '../log.ts';

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}
export interface Db extends Queryable {
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  kind: 'postgres' | 'pglite';
}

export async function openDb(opts: { memory?: boolean } = {}): Promise<Db> {
  if (config.databaseUrl && !opts.memory) {
    const pg = await import('pg');
    const pool = new pg.default.Pool({ connectionString: config.databaseUrl, max: 10, ssl: config.databaseUrl.includes('sslmode=require') ? { rejectUnauthorized: false } : undefined });
    pool.on('error', (e) => log.error('pg pool error', { err: String(e) }));
    return {
      kind: 'postgres',
      async query(sql, params) { const r = await pool.query(sql, params as unknown[]); return r.rows; },
      async tx(fn) {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const out = await fn({ async query(sql, params) { const r = await c.query(sql, params as unknown[]); return r.rows; } });
          await c.query('COMMIT');
          return out;
        } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
      },
      async close() { await pool.end(); },
    };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  let pgl: InstanceType<typeof PGlite>;
  if (opts.memory || (config.test && !process.env.PGLITE_DIR)) pgl = new PGlite();
  else { mkdirSync(config.pgliteDir, { recursive: true }); pgl = new PGlite(config.pgliteDir); }
  await pgl.waitReady;
  // PGlite is a single connection: serialise every statement/transaction through one queue.
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };
  return {
    kind: 'pglite',
    query(sql, params) { return enqueue(async () => (await pgl.query(sql, params as unknown[])).rows as never[]); },
    tx(fn) {
      return enqueue(() => pgl.transaction(async (t) => fn({ async query(sql, params) { return (await t.query(sql, params as unknown[])).rows as never[]; } })));
    },
    async close() { await chain; await pgl.close(); },
  };
}

function splitSql(sql: string): string[] {
  return sql.replace(/--.*$/gm, '').split(';').map((s) => s.trim()).filter(Boolean);
}

export async function migrate(db: Db) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  const done = new Set((await db.query<{ version: number }>('SELECT version FROM schema_migrations')).map((r) => r.version));
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
  const files = readdirSync(dir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  for (const f of files) {
    const v = parseInt(f, 10);
    if (done.has(v)) continue;
    const stmts = splitSql(readFileSync(join(dir, f), 'utf8'));
    await db.tx(async (q) => {
      for (const s of stmts) await q.query(s);
      await q.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [v, f]);
    });
    log.info('migration applied', { version: v, file: f });
  }
}

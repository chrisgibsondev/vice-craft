# Operations

How to deploy, configure, observe, back up and recover a VICE CRAFT server. Everything
here reflects the code in `apps/server`; recommendations that are not enforced by the
code are labelled as such.

## 1. External services

| Need | Production | Development substitute |
| --- | --- | --- |
| Database | A managed PostgreSQL instance, reachable through `DATABASE_URL`. The server fails fast at start-up if `NODE_ENV=production` and `DATABASE_URL` is empty. | Embedded **PGlite** (PostgreSQL compiled to WASM), files in the PGlite directory, used automatically when `DATABASE_URL` is unset. Tests use an in-memory PGlite. |
| TLS termination and public hostname | A reverse proxy (nginx, Caddy, a cloud load balancer) in front of the Node process, providing HTTPS and secure WebSockets (`wss://`). | Plain `http://localhost:5420` (Vite) and `ws://`. |
| Process supervision | systemd, a container orchestrator or similar that restarts the process on exit. | `npm run dev` (`tsx watch` restarts on file change). |
| Static client hosting | The Node server itself serves `apps/client/dist` (single origin). A CDN in front is optional. | Vite dev server on port 5420, proxying `/api` and `/ws` to port 5421. |

Not used by the code: Redis, message queues, e-mail, object storage, third-party auth.
There is **no password-reset flow and no account-deletion route**, because there is no
e-mail address on accounts.

The server is a single stateful process (instances live in memory). Run exactly one
process per database. Do not put several game servers behind a load balancer
expecting them to share worlds.

## 2. Production deployment

### Build and run

```bash
# on the server, from the repository root
npm ci                    # must include dev dependencies: `tsx` runs the server
npm run build             # builds the client into apps/client/dist
export NODE_ENV=production
export DATABASE_URL='postgres://user:pass@host:5432/blockshore?sslmode=require'
export ADMIN_USERS='youradminname'
export TRUST_PROXY=1
export HOST=127.0.0.1     # if the proxy runs on the same machine
npm run migrate           # optional, the server also migrates at start-up
npm start                 # tsx apps/server/src/index.ts
```

Points that matter:

- **There is no server build step.** `npm start` runs the TypeScript source through
  `tsx`, and `tsx` is declared as a root *dev* dependency. Installing with
  `npm ci --omit=dev` would remove it and the server would not start. Either install dev
  dependencies on the server or move `tsx` into `dependencies`.
- `npm start` (a workspace script) runs with the working directory set to `apps/server`.
  The defaults `CLIENT_DIST=../client/dist` and `PGLITE_DIR=.data/pglite` are resolved
  against that directory. If you start the server another way, set `CLIENT_DIST` to an
  absolute path.
- **Single origin.** In production the same process serves the REST API (`/api/*`), the
  WebSocket (`/ws`) and the static client (everything else, falling back to
  `index.html`). Files under `/assets/` are sent with a one-year immutable cache header;
  other files with one hour; `index.html` with `no-cache`. The server does not compress
  responses, so enable gzip or brotli in the proxy.
- If `apps/client/dist` does not exist the server answers non-API requests with a
  plain-text "Client not built" message.
- Client and server must be deployed together: the client regenerates the world from
  the shared map data and runs the same physics, and the protocol check
  (`PROTOCOL_VERSION`) only rejects incompatible message formats, not different maps.
  Players whose client is out of date are disconnected with a "refresh the page" message.

### Environment variables

The server reads **process environment variables only**. It does not load `.env` files
(there is no dotenv dependency and no `--env-file` in the scripts), so copying
`.env.example` to `.env` has no effect by itself. Export the variables in your shell,
use systemd `EnvironmentFile=`, `docker run --env-file`, or `set -a; . ./.env; set +a`
before starting.

| Variable | Default | Meaning |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` enables prod behaviour: requires `DATABASE_URL`, default `HOST=0.0.0.0`, empty default admin list, registration limit 5 per hour per IP, dev commands forced off. |
| `PORT` | `5421` | HTTP and WebSocket port. |
| `HOST` | `127.0.0.1` in development, `0.0.0.0` in production | Bind address. |
| `DATABASE_URL` | empty | PostgreSQL connection string. Required in production. Empty in development selects PGlite. |
| `PGLITE_DIR` | `.data/pglite` | Directory for the embedded development database (relative to the process working directory). |
| `ADMIN_USERS` | `admin` in development, empty in production | Comma-separated user names that become administrators **when the account is registered**. |
| `TRUST_PROXY` | `0` | Set to exactly `1` to take the client IP from the first entry of `X-Forwarded-For`. |
| `DEV_COMMANDS` | on in development | `0` disables dev commands in development. Always off when `NODE_ENV=production`. |
| `SESSION_DAYS` | `30` | Session token lifetime. |
| `MAX_INSTANCES` | `40` | Maximum number of free-roam worlds that `world.join` `new` can create. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
| `CLIENT_DIST` | `../client/dist` | Directory of the built client to serve. |
| `BLOCKSHORE_TEST` | unset | `1` selects an in-memory database and relaxes rate limits. Used by the test suite; do not set in production. |
| `BLOCKSHORE_SERVER` | `http://127.0.0.1:5421` | Dev only: where the Vite dev server proxies `/api` and `/ws`. |

`.env.example` lists `NODE_ENV`, `PORT`, `HOST`, `DATABASE_URL`, `ADMIN_USERS`,
`TRUST_PROXY`, `DEV_COMMANDS`, `SESSION_DAYS`, `MAX_INSTANCES`, `LOG_LEVEL`; `PGLITE_DIR`,
`CLIENT_DIST`, `BLOCKSHORE_TEST` and `BLOCKSHORE_SERVER` exist in the code but not in the example.

PostgreSQL TLS: the pool enables TLS (`rejectUnauthorized: false`, so certificate
chains are **not** verified) only when the connection string contains
`sslmode=require`. If your provider needs a CA-verified connection, change
`apps/server/src/db/index.ts`. The pool size is 10.

### HTTPS and secure WebSockets behind a reverse proxy

The browser client picks `wss://` automatically when the page is served over HTTPS and
connects to `/ws` on the same host. The proxy must pass WebSocket upgrades for `/ws`.
Set `TRUST_PROXY=1` so rate limits and the audit log see real client IPs, and make
the proxy **overwrite** (not append to) `X-Forwarded-For`, because the server uses the
left-most entry and a client-supplied value would otherwise be trusted.

nginx:

```nginx
map $http_upgrade $connection_upgrade { default upgrade; '' close; }

server {
    listen 443 ssl http2;
    server_name play.example.com;
    ssl_certificate     /etc/letsencrypt/live/play.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/play.example.com/privkey.pem;

    client_max_body_size 64k;          # the API rejects bodies over 32 KB anyway
    gzip on;
    gzip_types text/css application/javascript application/json image/svg+xml;

    location /ws {
        proxy_pass http://127.0.0.1:5421;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;   # overwrite, do not append
        proxy_read_timeout 120s;       # the client pings every 2 s
    }

    location / {
        proxy_pass http://127.0.0.1:5421;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
server { listen 80; server_name play.example.com; return 301 https://$host$request_uri; }
```

Caddy (obtains certificates automatically and upgrades WebSockets with no extra
configuration; by default it does not trust incoming `X-Forwarded-For` from
untrusted clients, but verify this for your Caddy version):

```caddyfile
play.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:5421
}
```

Recommended extra response headers at the proxy (the Node server itself only sends
`X-Content-Type-Options: nosniff`): `Strict-Transport-Security`, and a
`Content-Security-Policy`. A CSP has to allow same-origin scripts, module workers
(`worker-src 'self'`), `blob:`/`data:` images and audio, and `connect-src 'self'` plus
the `wss://` host. Test it against the real client before enforcing it.

### systemd example

```ini
[Service]
WorkingDirectory=/srv/blockshore
EnvironmentFile=/etc/blockshore.env
ExecStart=/usr/bin/npm start
Restart=always
KillSignal=SIGTERM
TimeoutStopSec=15
```

`SIGINT` and `SIGTERM` trigger a graceful shutdown (positions saved, runs marked
interrupted, vehicles stored, sockets closed with code 4001).

## 3. Migrations

- SQL files live in `apps/server/src/db/migrations/` and are named `NNN_name.sql`.
  Applied versions are recorded in `schema_migrations`.
- `npm run migrate` opens the configured database (PostgreSQL if `DATABASE_URL` is set,
  otherwise PGlite), applies pending files in order, prints `migrations up to date` and
  exits. The server also runs the same routine on every start.
- Each file runs in a single transaction. There are no down-migrations. Add a new
  numbered file (for example `002_something.sql`) rather than editing an applied one.
  The splitter strips `--` comments and splits on `;`, so avoid semicolons inside string
  literals or function bodies.
- There is no advisory lock, so do not start two server processes against the same
  database at the same moment on a fresh schema.

## 4. Backups and restore

### PostgreSQL (production)

Everything durable is in the database (accounts, progress, vehicles, ledger, parties).

```bash
# backup (custom format, compressed, consistent snapshot while the server runs)
pg_dump --format=custom --file=blockshore-$(date +%F).dump "$DATABASE_URL"

# restore into an empty database
createdb blockshore_restore
pg_restore --no-owner --dbname=blockshore_restore blockshore-2026-11-17.dump

# restore over an existing database (stop the game server first)
pg_restore --clean --if-exists --no-owner --dbname="$DATABASE_URL" blockshore-2026-11-17.dump
```

Notes: managed PostgreSQL providers usually offer point-in-time recovery; prefer it plus
periodic `pg_dump` files stored off the machine. Dumps contain password hashes, hashed
session tokens and IP addresses (in `audit_log`), so protect them like production data.
Test a restore regularly. After restoring an older dump, active runs from the newer
period no longer exist; the server will mark any restored `active` rows as `interrupted`
on its next boot.

### PGlite (development data)

The embedded database is a plain directory. Default location: `.data/pglite` relative to
the server's working directory, which under `npm run dev` / `npm start` is
`apps/server/.data/pglite` (set `PGLITE_DIR` to an absolute path to avoid ambiguity).
To back it up, **stop the server first**, then copy the whole directory. To reset all
development data, stop the server and delete the directory. PGlite is not intended for
production: it is single-connection and single-process.

## 5. Health endpoint

`GET /api/health` (no authentication, not rate-limited beyond the general per-IP limit):

```json
{ "ok": true, "uptimeS": 3601, "db": "postgres", "instances": 3, "online": 12,
  "tick": { "avgMs": 1.84, "maxMs": 9.2, "ticks": 72040 }, "memMb": 214 }
```

| Field | Meaning |
| --- | --- |
| `ok` | Always `true` when the HTTP handler responds. It does **not** probe the database. |
| `uptimeS` | Seconds since the `Game` was created. |
| `db` | `postgres` or `pglite`. Use it to confirm production is not on PGlite. |
| `instances` | All live instances (worlds, activities and interiors). |
| `online` | Authenticated WebSocket sessions. |
| `tick.avgMs` | Exponential moving average of the time one tick (all instances) takes, in ms. |
| `tick.maxMs` | Slowly decaying maximum tick time, in ms. |
| `tick.ticks` | Total ticks since start. |
| `memMb` | Resident set size in MB. |

The tick budget is 50 ms (20 Hz). As a rule of thumb (a recommendation, not enforced by
code), investigate when `avgMs` stays above roughly 25 ms or `maxMs` approaches 50 ms.
For load-balancer or uptime checks use this endpoint and also confirm `db`. The
endpoint exposes instance and player counts publicly; restrict it at the proxy if you
do not want that.

## 6. Logs

`apps/server/src/log.ts` writes one JSON object per line: `{ "t": ISO time, "level",
"msg", ...fields }`. `debug` and `info` go to stdout, `warn` and `error` to stderr.
`LOG_LEVEL` sets the minimum. Useful messages:

| `msg` | Level | When |
| --- | --- | --- |
| `server listening` | info | Start-up, with port, host, db kind, env, devCommands. |
| `migration applied` | info | A migration ran. |
| `runs interrupted by restart` | warn | Boot found runs still `active` (usually after a crash). |
| `world created`, `instance closed` | info | Instance lifecycle. |
| `player online`, `player offline` | info | Connections (user id and display name). |
| `activity complete` | info | A run finished. |
| `reward grant failed` | error | A payout threw; see the reconciliation note in DATA_MODEL. |
| `instance tick failed`, `handler failed`, `http error`, `pg pool error`, `unhandled rejection` | error | Faults. |
| `shutting down` | info | Graceful stop. |

There is no HTTP access log; use the proxy's. Ship stdout/stderr to your log system
(journald, a container log driver, etc.).

## 7. Admin tools

### Becoming an administrator

`ADMIN_USERS` is checked **only when an account is created**. The listed name must be
registered after the variable is set; changing the variable does not promote an
existing account. Because anyone can register any free name, **register your admin
account immediately after the first deploy**, or the name could be claimed by someone
else. To promote or demote an existing account:

```sql
UPDATE users SET is_admin = TRUE WHERE username = 'someone';   -- lower-case
```

The flag is read when a session authenticates; the player must reconnect to see the
Admin button.

### In-game admin panel

Administrators get an **Admin** button on the main menu (the panel is the `admin`
overlay). It shows every instance with its players (link-dead players marked), vehicles,
NPCs and activity phase, and lets you kick a player, close an instance, broadcast a
message to everyone online, list open reports, ban the reported player with a reason
and resolve a report.

### Admin endpoints (`apps/server/src/http.ts`, `is_admin` required)

| Route | Body | Effect |
| --- | --- | --- |
| `GET /api/admin/overview` | - | Online count, tick stats, every instance with players. |
| `POST /api/admin/kick` | `{ userId }` | Closes that user's socket with code 4004 (the client does not auto-reconnect; they can log in again). |
| `POST /api/admin/close` | `{ instanceId }` | Abandons the activity (players returned to the world) or closes the world/interior (world players are returned to the menu; interior players go back to the world). |
| `POST /api/admin/broadcast` | `{ text }` (max 200) | Sends an `ADMIN: ...` notification to everyone online. |
| `GET /api/admin/reports` | - | Up to 100 open reports, newest first. |
| `POST /api/admin/ban` | `{ userId, hours (1-8760), reason }` | Sets `banned_until`, deletes all the user's sessions and closes their socket. |
| `POST /api/admin/resolve` | `{ id }` | Marks a report `resolved`. |

Kick, close, broadcast and ban are written to `audit_log`. There is **no unban
endpoint**; to lift a ban early: `UPDATE users SET banned_until = NULL, ban_reason = NULL WHERE username = '...';`.
Players report others through `POST /api/report` (rate-limited).

Moderation features present: block list, party and friend request controls, report
queue, kicks and temporary bans, chat rate limits. Not present: chat filtering, mutes,
IP bans, appeal workflow.

## 8. Recovery after a crash or restart

What the server does by itself at boot (`Game.init`):

1. Marks every `activity_runs` row with status `active` as `interrupted` (it logs
   `runs interrupted by restart`).
2. Returns every vehicle with `state='out'` to `stored`.
3. Restores parties updated within the last 6 hours.
4. Creates a fresh world.

Players with a valid session reconnect automatically (exponential backoff up to 10 s),
land on the menu and press Play. Their cash, progress, vehicles and last saved position
are intact. Positions are saved on disconnect, bed use and roughly every 30 s while
playing, so after a hard crash a player may come back a short distance from where they
were.

Operator checklist after an unplanned restart:

1. Confirm the process is up and `GET /api/health` returns `db: "postgres"`.
2. Check the logs for `runs interrupted by restart`, `reward grant failed`,
   `pg pool error`.
3. Look for completed runs that never paid (should be rare):

   ```sql
   SELECT r.id, r.activity, r.ended_at
   FROM activity_runs r
   WHERE r.status = 'complete'
     AND NOT EXISTS (SELECT 1 FROM reward_grants g WHERE g.run_id = r.id);
   ```

   There is no automatic reconciliation. Compensate manually and record it (a `ledger`
   insert with a clear `reason`, or an `INSERT INTO reward_grants` so the guard stays
   truthful).
4. A crash during a store transaction rolls it back; cash, inventory and ledger move
   together (each purchase is one transaction), so no repair is normally needed.
5. If the database itself is lost, restore from the latest backup (section 4).

A graceful restart (deploy) is lower-impact: players see "Server is restarting -
reconnecting...", positions are saved, interrupted activities pay nothing but keep
the leader's mission checkpoint.

## 9. Security notes

| Area | What the code does |
| --- | --- |
| Passwords | `scrypt` (N=16384, r=8, p=1, random 16-byte salt, 32-byte key), stored as `scrypt$N$r$p$salt$key`; compared with `timingSafeEqual`. Login always hashes, even for unknown users, to avoid a timing oracle. Length 8 to 128. |
| Session tokens | 32 random bytes (base64url). Only the **SHA-256 hash** is stored in `sessions`. Tokens expire after `SESSION_DAYS` and are deleted on logout and on ban. They are not rotated. |
| Where the token lives | Client: `localStorage` (key `blockshore.token.<slot>`); sent as a `Bearer` header for REST and in the first WebSocket message, never in a URL. Any XSS would expose it, so keep the client free of untrusted HTML. |
| Input validation | Every WebSocket message is parsed with the zod `C2S` schema; invalid messages are counted and the socket is closed after 50. Every REST body goes through a zod schema. SQL uses parameterised queries. |
| Authority | Prices, rewards, damage, ranges, hold times, vehicle seats and ownership are decided on the server. Player-versus-player damage is off in public free roam. |
| Rate limits | See ARCHITECTURE.md section 9. Registration is limited to 5 per IP per hour in production. |
| Secrets | The client bundle contains no secrets or API keys. The only secrets are `DATABASE_URL` (server environment) and user tokens. Do not commit `.env` (it is git-ignored). |
| Dev commands | Teleport, give cash, force stage and similar exist but are refused unless `NODE_ENV` is not `production` and `DEV_COMMANDS` is not `0`. |
| Headers / CORS | The API sends `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`; no CORS headers (same origin only). Add HSTS and CSP at the proxy. |
| WebSocket origin | The server does not check the `Origin` header of WebSocket upgrades. Authentication is by token in the first message (not by cookie), so a foreign site cannot piggyback a session, but you may add an Origin allow-list at the proxy. |
| Data retention | `audit_log` stores IP addresses of registrations. `sessions` rows are never purged after expiry; add a periodic `DELETE FROM sessions WHERE expires_at < NOW()` if table growth matters. |
| Accounts | No e-mail, CAPTCHA or verification. Open registration, limited by IP rate. |

### Licensing before launch

Third-party assets: Sketchfab models are CC-BY (attribution must be visible to players,
see `/api/credits`). The audio is from Epidemic Sound; **confirm your Epidemic Sound
license allows distributing the audio files inside a public web game** before launch,
as the files are served to every player.

# Data model

Covers the database schema, what is deliberately **not** persisted, the activity
content format, the WebSocket protocol and the REST routes.

## 1. Database

Source: `apps/server/src/db/migrations/001_init.sql`. `apps/server/src/db/index.ts`
applies migrations in filename order inside a transaction each and records them in
`schema_migrations (version, name, applied_at)`, which it creates itself. There is one
migration today. Ids are application-generated UUID strings (`TEXT`), except
`ledger`, `reports` and `audit_log`, which use `BIGSERIAL`. All timestamps are
`TIMESTAMPTZ`. The SQL splitter removes `--` comments and splits on `;`, so a migration
must not contain semicolons inside strings or function bodies.

### Tables

| Table | Purpose | Key constraints and notes |
| --- | --- | --- |
| `users` | Accounts. | `id` PK; `username` UNIQUE (stored lower-cased, 3-16 chars `[A-Za-z0-9_]`); `display_name` keeps the original casing; `pass_hash` is `scrypt$N$r$p$salt$key` (base64); `is_admin` set at registration from `ADMIN_USERS`; `banned_until`/`ban_reason`; `presence_visibility` (`everyone`/`friends`/`nobody`, default `friends`) and `invite_policy` (`friends`/`nobody`) are not constrained by CHECK in SQL (validated in code). |
| `sessions` | Login sessions. | PK `token_hash` = SHA-256 of the opaque token (the raw token exists only in the client); FK `user_id` ON DELETE CASCADE; `expires_at` (`SESSION_DAYS`, default 30); `last_seen` updated on use; index on `user_id`. Expired rows are ignored by lookups but **never deleted** by the server. Banning deletes the user's sessions. |
| `friend_requests` | Pending friend requests. | PK `(from_id, to_id)`; both FK to `users` cascade; index on `to_id`. A reverse request auto-accepts. At most 50 outgoing pending per user (checked in code). |
| `friendships` | Confirmed friendships, stored once per pair. | PK `(a_id, b_id)` with `CHECK (a_id < b_id)` so each pair has one canonical row; index on `b_id`. |
| `blocks` | Block list. | PK `(blocker_id, blocked_id)`. Blocking removes the friendship and pending requests, separates parties and filters chat. Blocks apply in both directions for invites and chat. |
| `profiles` | Per-user game state, one row per user. | PK/FK `user_id` cascade; `cash BIGINT CHECK (cash >= 0)`; `rep`; JSONB `completed` (activity id to completion count), `unlocks` (array of activity ids), `preps` (heist id to completed prep ids), `checkpoints` (activity id to stage index), `inventory` (e.g. `medkit`, `weapon:<id>`, `ammo:<id>`), `settings` (client settings blob, max 8000 chars); `outfit` (shirt colour int); `pos` (JSONB `{x,y,z,yaw}`, last saved world position). |
| `vehicles` | Owned vehicles. | PK `id`; FK `owner_id` cascade, indexed; `model`; `color`; `health`; `upgrades` JSONB (column exists, no code writes it: upgrades are **planned**); `state` one of `stored`, `out`, `destroyed` (text, validated in code). Max 10 per player (checked in code). New accounts get one starter `compact`. |
| `activity_runs` | One row per started activity run. | PK `id`; `activity` (content id), `kind`; `leader_id` (no FK, kept even if the user is later deleted); `roster` JSONB (user ids, names, roles, eligibility); `terms` JSONB (heist approach, equipment, split, resume stage); `status` (see below); `checkpoint` stage index; `result` JSONB; `started_at`, `ended_at`; index on `status`. |
| `reward_grants` | Payout receipts, the idempotency guard. | **PK `(run_id, user_id)`.** FKs cascade. See below. |
| `personal_bests` | Best times (race), lower is better. | PK `(user_id, activity)`; `value_ms`; `run_id` is informational (no FK). Upsert only replaces a worse value. |
| `ledger` | Append-only record of every cash change. | `id` BIGSERIAL PK; `amount` (signed), `balance` (after), `reason`, optional `ref` (the run id for activity rewards); index `(user_id, created_at)`. |
| `reports` | Player reports for moderators. | BIGSERIAL PK; `reporter_id`, `target_id` FK cascade; `reason` (max 200), `context` (max 1000), `status` `open` or `resolved`. |
| `audit_log` | Admin and account audit trail. | BIGSERIAL PK; `actor_id` (nullable, no FK); `action` (`register`, `kick`, `close_instance`, `broadcast`, `ban`); `data` JSONB. Note: `register` rows store the registrant's IP. |
| `parties` | Persisted party state. | PK `id`; `data` JSONB (the whole `Party` object); `updated_at`. |

### Reward idempotency (`reward_grants`)

`Store.grantReward` runs in one transaction:

1. `INSERT INTO reward_grants (run_id, user_id, ...) ON CONFLICT DO NOTHING RETURNING run_id`.
2. If nothing was inserted, return `duplicate` and change nothing (the player sees "already paid").
3. Otherwise update `profiles` (rep, completed, unlocks, preps, checkpoints) and credit cash through `adjustCash`, which writes the `ledger` row.

Because the receipt, the profile update and the ledger row commit or roll back together,
a run can pay a given player at most once even if completion code is reached twice.
If a grant throws, the results screen shows "error - will be reconciled"; **no
reconciliation job exists yet**, so such a case needs manual repair from `activity_runs`
and `reward_grants`.

### The ledger and money

All cash changes go through `Store.adjustCash` (`UPDATE ... WHERE cash + amount >= 0
RETURNING`), so balances cannot go negative, and each change inserts a `ledger` row with
the resulting balance. `Store.purchase` combines an inventory change and a debit in one
transaction (with `SELECT ... FOR UPDATE` on the profile). Known `ledger.reason` values:
`starting cash`, `buy <item>`, `buy <vehicle model>`, `repair`, `paint`,
`vehicle delivery`, `police fine`, `busted`, `activity reward` (with `ref` = run id), `dev`
(development only). Starting cash is $2000.

### `activity_runs.status`

Text values written by code (no CHECK constraint):

| Status | Meaning |
| --- | --- |
| `active` | Run is in progress (also set again after a retry from a checkpoint). |
| `failed` | The crew failed; waiting for retry (leader) or leave. `ended_at` is stamped when set. |
| `complete` | Finished; rewards computed and granted. |
| `abandoned` | Everyone left, an admin closed the instance, or the run was otherwise dropped. |
| `interrupted` | The server stopped while it was `active`. Never pays out. Set by graceful shutdown and by boot recovery. |

`ended_at` is set whenever status becomes `complete`, `failed`, `abandoned` or
`interrupted`; a retry sets status back to `active` without clearing it.

### Party persistence

`PartyManager` keeps parties in memory and writes the whole party object to `parties.data`
on every change (chat truncated to the last 30 lines). On boot, rows updated within the
last 6 hours are loaded and older rows are deleted; pending invites and share links are
cleared on load. Parties have 1 to 4 members; invites expire after 15 minutes
(`INVITE_TTL_MS`).

### What is in memory only (lost on restart)

| State | Where | Consequence |
| --- | --- | --- |
| Instances: free-roam worlds, activity instances, interior instances | `Game.instances` | Players are not in any world after a restart and must press Play again. |
| Live activity state (stage, objectives, timers, loot, alarm, race progress) | `ActivityRun` | The run row is marked `interrupted`; only the leader's mission checkpoint survives. |
| Lobbies (briefing/ready/plan) | `Game.lobbies` | Must be reopened. Expire after 1 hour anyway. |
| Wanted levels and police pursuit | `PlayerEnt.wanted`, `ActivityRun.wanted` | Cleared on restart. |
| NPCs: traffic, pedestrians, police units, guards, static NPCs | `Instance.npcs`, vehicles with `ai` | Regenerated per instance. |
| Vehicles out in the world (`state='out'`) | `Instance.vehicles` | Written back to `stored` at shutdown and at next boot. |
| Link-dead player slots, held interactions, down timers | `PlayerEnt` | Gone. |
| Pending party invites and share links | `Party.invites`, `Party.link` | Cleared on restore. |
| Rate-limiter buckets, WebSocket sessions | memory | Reset. |

## 2. Activity content model

Defined in `packages/shared/src/content/activityTypes.ts`; data in `activities.ts`
(and the extension files `story.ts`, `heists.ts`, `minigames.ts`, merged into
`ACTIVITIES`). One generic state machine (`apps/server/src/activities/runner.ts`) runs
every definition; adding an activity needs no server code unless it introduces a new
objective, spawn or fail type.

### Core types

- `ActivityDef`: `id`, `kind` (`mission` | `heist` | `heist_prep` | `minigame`), `name`,
  `giver` (contact id), `blurb`, `start` (marker position), `startSpots` (where the crew
  is placed, in order) and `startYaw`, `unlock` (`requires` activity ids that must be
  completed, optional `rep`), `minPlayers: 1`, `maxPlayers: 4`, `lateJoin`
  (`never` | `roster_reconnect`), `replayable`, `music`, `stages`, `rewards`, `notes`, and
  optional `preps` (heist: prep ids the leader must finish first), `heist`
  (`baseTake`, `approaches`, `equipment`, `roles`, `loudPenalty`), `race`
  (`competitive`, `parTimes` gold/silver/bronze seconds, `startGrid`, `vehicleModel`),
  `minigame`.
- `StageDef`: `id`, `title`, `checkpoint?`, `cutscene?` (id in `CUTSCENES`), `when?`,
  `timeLimit?`, `spawn?`, `despawn?`, `objectives`, `fail?`, `lines?` (dialogue shown
  when the stage starts), `onEnter?` (raise wanted, trip the alarm, set doors) and
  `respawn?` (positions used when a downed player respawns or a retry resumes here).
- `RewardDef`: `cash` per participant by party size, `rep`, `replayCash`, `unlocks`.

### Party-size scaling: `BySize<T>`

`BySize<T>` is a 4-tuple indexed by `partySize - 1`. It is used for `timeLimit`,
objective `count` and `rewards.cash`. The run's size is the number of roster members.
Individual spawns can also be gated with `minParty`: a spawn with `minParty: 3` only
exists for crews of 3 or more.

### Spawns (`spawn`)

| Kind | Fields |
| --- | --- |
| `vehicle` | `model`, `pos`, `yaw`, `color?`, `minParty?`, `label?`, `perPlayer?` (one each), `ghost?` (racers pass through each other) |
| `object` | `obj` (`package`, `loot`, `keypad`, `safe`, `photo`, `target`, `evidence`, `lock`), `pos`, `label`, `hold` (seconds the player must hold E), `minParty?`, `value?` (loot value), `yaw?` |
| `guard` | `patrol` waypoints, `minParty?` |
| `door` | `door` (anchor key such as `jewelers.back_door`), `state` (`open`/`closed`/`locked`) |
| `npc` | `role`, `pos`, `yaw`, `name?` |

### Objectives (`objectives`)

| Type | Meaning |
| --- | --- |
| `reach` | Get to `pos` within radius `r`; `who` `any` or `all`; optional `vehicle` that must be used. |
| `enter_vehicle` | Get into one of the listed spawned vehicles; `who` `any` or `all`. |
| `interact` | Interact with `targets`; optional `count` (BySize, how many are needed); optional `simultaneous { window, soloWindow }` for co-operative actions: all targets held within `window` seconds of each other, and for solo or short-handed crews sequentially within `soloWindow`. |
| `lose_wanted` | Escape the police. |
| `checkpoints` | Race: `points`, `laps`, radius `r`; server-timed, must be crossed in order. |
| `shoot` | Destroy `targets`; `count` (BySize). |
| `wait` | `seconds`. |

### Fail rules (`fail`)

`vehicle_destroyed { vehicle }`, `all_down`, `timer` (the stage `timeLimit` expired),
`detected` (guards spotted the crew).

### Conditional stages (`when`)

A stage with `when` is skipped when it does not apply: `approach` (`quiet` or `loud`,
from the lobby choice), `alarm` (true or false: whether the alarm has tripped) and
`wanted` (true: only if the crew is currently wanted). This is how the heist branches
between a quiet entry and a loud entry and only runs "lose the heat" if the police are
chasing. A quiet-run alarm trip converts the plan to loud automatically.

### Example (excerpt from `story_1`, stage `pickup`)

```ts
{
  id: 'pickup', title: 'Collect the packages', checkpoint: true,
  respawn: [[2512, Y, 3170], [2514, Y, 3170], [2516, Y, 3170], [2518, Y, 3170]],
  timeLimit: [300, 270, 240, 240],                     // BySize: seconds for 1..4 players
  spawn: [
    { id: 'pkg_a', kind: 'object', obj: 'package', pos: [2405.5, Y, 3246.5], label: 'Package', hold: 1.2 },
    { id: 'pkg_b', kind: 'object', obj: 'package', pos: [2549.5, Y, 3110.5], label: 'Package', hold: 1.2 },
    { id: 'pkg_c', kind: 'object', obj: 'package', pos: [2586.5, Y, 3236.5], label: 'Package', hold: 1.2, minParty: 3 },
    { id: 'pkg_d', kind: 'object', obj: 'package', pos: [2453.5, Y, 3290.5], label: 'Package', hold: 1.2, minParty: 4 },
  ],
  objectives: [{ type: 'interact', id: 'pkgs', label: 'Pick up the packages',
                 targets: ['pkg_a', 'pkg_b', 'pkg_c', 'pkg_d'], count: [2, 2, 3, 4] }],
  fail: [{ type: 'timer' }, { type: 'vehicle_destroyed', vehicle: 'car1' }],
  lines: [{ speaker: 'Marisol', text: 'Packages are marked on your map. ...' }],
}
```

### Eligibility, rewards and unlocks

- Per player, `eligibilityOf` returns `story` (not yet completed and unlocked), `replay`
  (already completed: reduced cash, half rep) or `ahead` (not unlocked: guest, cash only).
- A mission pays `rewards.cash[size-1]` to story players and `replayCash` otherwise.
  Completing it adds the id to `profiles.completed`, applies `rewards.unlocks` to
  `profiles.unlocks`, and clears the checkpoint.
- Heist payout: `(baseTake + loot) x (loudPenalty if the alarm tripped)`, split by the
  percentages locked in the lobby. Preps are consumed by a finished heist. **Known bug:** when a prep
  activity pays out, `runner.ts` records it against the hard-coded heist id
  `heist_sundial`, regardless of which heist the prep belongs to. That is correct for the
  Sundial preps only; the later heists' preps (`heist_pier9`, `heist_tower`) will never
  satisfy their own `preps` requirement.
- Races: solo is judged against `parTimes` (gold, silver, bronze); with 2 to 4 racers
  the order pays 100%, 60%, 40% and 30% of `rewards.cash[size-1]`; personal bests go to
  `personal_bests`.
- The unlock rule: a definition is unlocked if its id is in `profiles.unlocks`, or if all
  `unlock.requires` activities have a completion count above zero.
- Content validation: `npx tsx scripts/validate-content.ts` checks positions against the
  generated terrain and the structural rules.

Contacts (`CONTACTS` in `activities.ts`, extended by `EXTRA_CONTACTS` in `story.ts`) are
the quest givers shown on the phone: Marisol Reyes (fixer), Lena Voss (heist planner),
DJ Kilo (street racing), Dez Morales (mechanic); Nix Valdrin (hacker), Capt. Barney Quill
(boat captain) and Hollis Grebe (port inspector) are declared in `story.ts`.
At the time of writing 25 activities exist in total (the Sundial set plus story_2 to
story_8, the Pier 9 and Vega Tower heists with preps, and five mini-games); see
[MAP.md](MAP.md) for the list. That content was still being finished.

## 3. Protocol

WebSocket at `/ws`, JSON text frames. Protocol version `PROTOCOL_VERSION = 1`, game
version `0.1.0`. The first message must be `hello` within 10 s. Close codes:
4001 server restarting, 4003 client out of date, 4004 session invalid / kicked /
banned / replaced by a newer login / login timeout, 4008 rate limited or too many
invalid messages.

### Client to server (`C2S`, validated by zod)

| `t` | Fields | Purpose |
| --- | --- | --- |
| `hello` | `v`, `gv`, `token`, `resume?` | Authenticate with the session token. (`resume` is sent by the client but not read by the server.) |
| `input` | `seq`, `mx`, `mz`, `yaw`, `pitch`, `jump`, `sprint`, `th`, `st`, `hb` | One simulation step of movement or driving input (20 Hz). |
| `world.join` | `target`: `auto`, `party`, `new` or `{instance}` | Enter a free-roam world. |
| `world.leave` | - | Leave the world. |
| `interact` | `target` (entity or anchor id) | Interact (objects start a timed hold). |
| `interact.stop` | - | Cancel a hold. |
| `veh.enter` | `vehicle`, `seat?` | Enter a vehicle / change seat. |
| `veh.exit` | - | Exit. |
| `veh.horn` | `on` | Horn (sirens toggle on police vehicles). |
| `fire` | `yaw`, `pitch` | Fire the equipped weapon. |
| `weapon` | `id` | Equip. |
| `reload` | - | Reload. |
| `chat` | `ch` (`party`, `world`, `activity`), `text` (1-200) | Chat. |
| `ping.mark` | `x`, `y`, `z`, `kind` (`go`, `danger`, `loot`, `vehicle`) | Map ping for the crew or party. |
| `act.brief` | `activity` (activity id or `contact:<id>`) | Request a briefing. |
| `act.lobby` | `activity` | Open a lobby (party leader only). |
| `act.ready` | `ready` | Ready check. |
| `act.config` | `approach?`, `equipment?` (max 3 in schema, 2 in code), `split?` | Heist plan (leader). |
| `act.role` | `role` (`none`, `driver`, `hacker`, `muscle`, `lookout`) | Choose a heist role. |
| `act.launch` | - | Launch (leader). |
| `act.cancel` | - | Cancel the lobby (leader) or un-ready. |
| `act.leave` | - | Leave the running activity. |
| `act.retry` | - | Retry from checkpoint (leader, after failure). |
| `act.continue` | - | Leave the results screen and return to the world. |
| `cs.loaded` | `cs` | Cutscene assets loaded. |
| `cs.skip` | - | Vote to skip. |
| `shop.buy` | `shop`, `item` | Buy. |
| `item.use` | `item` | Use an item (only `medkit` is handled). |
| `garage` | `op` (`repair`, `paint`, `store`, `spawn`, `buy`, `deliver`), `vehicle?`, `model?`, `color?` | Garage actions. |
| `wanted.pay` | - | Pay a fine at the police desk. |
| `ping` | `c` | Latency and clock sync. |
| `dev` | `cmd` (`tp`, `cash`, `wanted`, `complete_stage`, `spawn_vehicle`, `heal`, `kill`, `stun_npcs`), `args` | Development only; rejected when `DEV_COMMANDS` is off or in production. |

### Server to client (`S2C`)

| `t` | Purpose |
| --- | --- |
| `welcome` | Auth OK: `userId`, `name`, `serverTime`, `tickRate`, `admin`, `dev`. |
| `error` | `code`, `message`, optional `fatal`. Codes seen: `version`, `auth`, `too_big`, `busy`, `no_world`, `capacity`, `world_full`, `party_world_full`. |
| `world` | You are now in an instance: id, kind (`world`/`activity`/`interior`), label, your entity id, spawn pos and yaw, occupancy. |
| `world.left` | You left or the world closed. |
| `snap` | Per-tick snapshot: `tick`, `time`, `ack`, `me` (authoritative self state), `ents` (changed entities), `gone` (removed ids). Entity kinds: player `p`, vehicle `v`, NPC `n`, object `o`, door `d`. |
| `notify` | Toast: `text`, `kind` (`info`, `good`, `bad`, `mission`), optional `sfx`. |
| `chat` | Chat line. |
| `profile` | Profile view: cash, rep, completions, unlocks, preps, checkpoints, inventory, outfit, vehicles, bests, weapons, equipped. |
| `social` | Social event (`party`, `party_invite`, `friend_request`, `friend_accepted`, `friends`, `party_kicked`, `leader_moved`). |
| `act` | Activity view (or `null`): phase, stage, objectives with world markers, timer, roster, race state. |
| `lobby` | Lobby view (or `null`). |
| `brief` | Briefing, or a contact's job list. |
| `cs.start`, `cs.waiting`, `cs.votes`, `cs.end` | Cutscene lifecycle. |
| `results` | End-of-activity payout lines. |
| `shop` | A shop or garage or police-desk menu. |
| `pong` | Reply to `ping`. |
| `ping.mark` | A crewmate's ping. |
| `sfx` | Positional or global sound event. |
| `dialogue` | Subtitle line. |
| `weapon` | Ammo state. |
| `shot` | Tracer for a shot (players and NPCs). |
| `hold`, `hold.end` | Start/end of a timed interaction. |
| `ui` | Server asks the client to open a panel (`heistboard`, `phone`, `map`, `social`). |
| `blips` | Police search area. |

Note: `hold.end` and `blips` are declared in the protocol types but the server code
never sends them (the police search area travels in `snap.me.search` instead). The `ui` message
is only sent for `heistboard` today.

## 4. REST routes (`apps/server/src/http.ts`)

JSON in and out. Authentication is `Authorization: Bearer <token>`. Errors are
`{ error, code? }`.

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /api/auth/register`, `/login`, `/logout` | none, none, bearer | Accounts and session tokens. |
| `GET /api/me` | user | User, profile, privacy settings. |
| `GET /api/users/search?q=` | user | Prefix search by username (min 2 chars, 10 results). |
| `GET /api/friends`; `POST /api/friends/request`, `/respond`, `/cancel`, `/remove` | user | Friend graph and presence. |
| `POST /api/blocks`; `POST /api/privacy` | user | Block and unblock; presence/invite privacy. |
| `GET /api/party`; `POST /api/party/create`, `/invite`, `/accept`, `/decline`, `/leave`, `/kick`, `/transfer`, `/link`, `/join-link`; `GET /api/party/link/<token>` | user (link info: none) | Parties. |
| `GET /api/worlds` | user | List free-roam worlds with occupancy and friend counts. |
| `POST /api/settings` | user | Save the client settings blob. |
| `POST /api/report` | user | Report a player. |
| `GET /api/credits` | none | Model and audio manifests for the credits screen. |
| `GET /api/health` | none | Health and tick statistics (see OPERATIONS). |
| `GET /api/admin/overview`, `/reports`; `POST /api/admin/kick`, `/close`, `/broadcast`, `/ban`, `/resolve` | admin | Moderation. |

Anything else under `/api/` returns 404; other paths serve the built client with an
`index.html` fallback.

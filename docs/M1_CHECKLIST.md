# Milestone 1 — real online vertical slice: acceptance checklist

Legend: ✅ verified by an automated end-to-end test against the real server (real WebSocket + REST clients, in-memory PostgreSQL/PGlite) · 🖥️ verified in a real browser · 🟡 implemented, not yet verified · ⬜ not done.

Run the automated suite with `npm test` (13 tests, ~45 s). Load test: `npx tsx scripts/loadtest.ts 16 40`.

## Platform
| Item | Status | Evidence |
|---|---|---|
| Browser client + authoritative Node server, one port, `/ws` upgrade | ✅ | all tests connect over real sockets |
| Persistent accounts (scrypt, hashed session tokens) | ✅ | `core.test.ts › accounts` |
| Incompatible client version rejected with a clear message (close 4003) | ✅ | `core.test.ts › incompatible client version` |
| PostgreSQL schema + migrations; PGlite dev substitute | ✅ | migrations run at every test boot |
| Server restart: progress persists, running activity marked interrupted (never paid), party restored, clients told why | ✅ | `restart.test.ts` |

## World
| Item | Status | Evidence |
|---|---|---|
| Small detailed district (downtown Port Solano, 9 hand-built buildings) inside the full generated state | 🖥️ | screenshots in `docs/progress/` |
| Chunk streaming, worker meshing, per-vertex AO, texture atlas | 🖥️ | world preview, 240 fps on the dev machine |
| Enterable safehouse (private instance, party can follow) + garage | 🟡 | server logic done; browser pass pending |

## Social
| Item | Status | Evidence |
|---|---|---|
| Friend requests (send/accept), presence | ✅ | `core.test.ts › friends → party → same world` |
| Blocking prevents requests + invites | ✅ | `core.test.ts › blocked users` |
| Party invites (friends only), accept, party chat | ✅ | `core.test.ts`, `coop.test.ts` |
| Same world via party | ✅ | instance ids compared in tests |
| Invite links, leader transfer, kick | ✅ | `coop.test.ts › party invite link` |

## Simulation & networking
| Item | Status | Evidence |
|---|---|---|
| Fixed 20 Hz server tick, input-driven movement, server-side validation | ✅ | movement observed by a second client |
| Client prediction + reconciliation, remote interpolation | 🖥️ | two browser tabs: predicted position matched the server exactly (z 3193.35) after 2.5 s walking; second client saw the move |
| Interest management (200 m) + delta snapshots | ✅ | load test |
| One car, driver + passenger; passenger input can't drive; driver disconnect frees the seat | ✅ | `core.test.ts › shared vehicle` |
| Reconnect returns the player to the same world slot | ✅ | `core.test.ts › disconnect + reconnect` |

## Activities
| Item | Status | Evidence |
|---|---|---|
| Solo/co-op mission with synchronized cutscenes | ✅ | `core.test.ts › mission`, `coop.test.ts` |
| Cutscene: bounded wait for slow clients | ✅ | `coop.test.ts › cutscene starts after the bounded wait` |
| Cutscene: group skip rule (> half), instant solo skip | ✅ | `coop.test.ts › heist` |
| Leader leaves mid-activity → leadership passes, activity continues | ✅ | `coop.test.ts › leader leaves` |
| Mid-activity disconnect → reconnect into the activity; outsiders can't join | ✅ | `coop.test.ts › disconnect mid-activity` |
| Heist: preps credited to the leader, payout split locked at launch, changing terms clears ready, invalid split rejected | ✅ | `coop.test.ts › heist` |
| Heist: simultaneous co-op keypads (out-of-sync resets; together succeeds) | ✅ | `coop.test.ts › heist` |
| Mini-game (Downtown Sprint race) | ✅ | `coop.test.ts › race mini-game` (per-player cars, frozen until GO, positions, personal bests) |
| Persistent, idempotent rewards (duplicate grant refused) | ✅ | `core.test.ts › mission … idempotent` |
| Invalid purchases rejected (not at shop, unknown item); valid purchase debits exactly | ✅ | `core.test.ts › purchases` |

## Measured performance (dev machine, in-process server)
| Scenario | Result |
|---|---|
| 16 clients in one world, 41 vehicles (22 traffic, 10 police), 30 pedestrians, 40 s | server tick avg 2.2 ms / max 4.7 ms (budget 50 ms); ~89 KB/s down per client; 516 MB RSS (incl. the test harness) |
| Chunk generation (server) | ~3,400 chunks/s single-threaded |

These are measurements on one development PC, not capacity guarantees.

## Browser playtest (2026-11-17, two tabs = two accounts, real server)
- Register → menu → Play → loading gate → in world (first person, HUD, minimap) 🖥️
- Friend request delivered live as a notification; accepted; party invite accepted from the menu's Accept button 🖥️
- "Join party's world" put both players in the same instance; each sees the other (name tag, party strip) 🖥️
- Shared car: player 2 requested the driver seat while it was taken and got seat 1; player 1 drove, player 2 rode in a third-person chase camera 🖥️
- Phone → contact → brief (per-player eligibility) → lobby → ready check → launch → both clients loaded → synced cutscene with skip-vote UI → mission HUD with objective marker 🖥️
- Note: the embedded test browser cannot capture the mouse (pointer lock) and pauses requestAnimationFrame while hidden; the game now falls back to right-drag mouse look, and frames were driven by a timer for these headless checks.

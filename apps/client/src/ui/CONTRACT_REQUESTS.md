# UI contract requests / assumptions

None of these block the UI; each has a workaround in `apps/client/src/ui`.

1. **Friend instance id for "Join friend".** `FriendView` only has `where?: string` (a label) and `joinable`. The UI can invite friends to a party but cannot call `joinWorld({ instance })` for a friend. Please add `instance?: string` to `FriendView` and the UI will add a Join button.
2. **`state.loading.progress`** is read as 0..1 (values above 1 are treated as percent).
3. **`hud.down`** is read as seconds remaining; values above 1e11 are treated as an absolute `endsAt` timestamp in ms.
4. **`hud.vehicleHp`** is read as absolute hp and divided by `VEHICLES[hud.vehicleModel].health`.
5. **Admin REST shapes** (`api.adminOverview`, `api.adminReports`) are typed `unknown`. The UI reads defensively: instances `{ id|instance, label, kind, players: [{ id|userId, name }] | number }`, reports `{ id, userId|targetId, targetName, reporterName, reason, context, resolved|status }`.
6. **`api.credits()`** shape is `unknown`. The UI renders `models[]` and `audio` (array, or object with `tracks|music|sfx` arrays, or key to license map) using `title|name`, `author|creator`, `license`, `source|url|link`.
7. **Results success/failure** is derived from `ResultsView.lines[].status` (a status matching /fail|over|wasted|down/ for every line means failed). An explicit `passed: boolean` on `ResultsView` would be better.
8. **Pointer lock on failed activities.** The Retry/Leave buttons in the objective panel need a free cursor. The UI also binds `Enter` (retry, leader only) and `L` (leave) while `activity.phase === 'failed'`. If you would rather release pointer lock on failure, the buttons already work.
9. **Waypoint GPS.** `ui/waypoint.ts` exports `getWaypoint() / setWaypoint({x,z}|null) / onWaypoint(cb)`. The game loop can read it for guidance. The UI draws the waypoint and a dashed guide line on the minimap.
10. **Escape / pause.** The UI opens `pause` on Escape when no overlay is open (`screen === 'game'`). If the game also opens `pause` on `pointerlockchange`, make sure it is idempotent, because browsers usually swallow the Escape keydown while pointer-locked.
11. **Overlay lifecycle.** The UI relies on the store/net layer to set `overlay` to `'brief'` when `brief` data arrives, `'lobby'` for lobby data, `'shop'` for shop data and `'results'` for results. The phone's contact view uses `state.contact` and clears it with `setState({ contact: null })`.

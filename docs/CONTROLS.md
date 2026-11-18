# Controls and new-player guide

Defaults come from `DEFAULT_KEYS` in `apps/client/src/state/types.ts`; behaviour from
`game/game.ts`, `game/input.ts` and `ui/App.tsx`. Bindings can be changed in
**Settings > Controls** (click a key, then press the new key or mouse button; "Reset all
keys" restores the defaults) and are saved with the account. Keys are stored as
`KeyboardEvent.code` values, so they refer to physical key positions.

## How input works

- Click the game canvas to capture the mouse (pointer lock). Gameplay keys only work
  while the pointer is locked **and** no panel is open. Pressing `Esc` (or losing focus)
  releases the mouse and opens the pause menu.
- Typing in a chat or text field disables gameplay hotkeys until you leave the field.
- All keys are released when the window loses focus.
- Some actions share a key on purpose because they apply in different situations
  (jump, handbrake and cutscene skip are all `Space`).

## Bindings

### On foot

| Action | Default | Notes |
| --- | --- | --- |
| Move forward / back / left / right | `W` `S` `A` `D` | |
| Look | Mouse | Sensitivity and Invert Y in Settings. |
| Jump | `Space` | Also swims upward in water. |
| Sprint | `Left Shift` | |
| Interact | `E` | Doors, shops, contacts, mission objects. Objects with a timer show a ring and a "Hold N s" label: **keep holding `E`** until it fills; releasing early cancels. |
| Enter / exit vehicle | `F` | Enters the nearest vehicle within about 5 blocks (server also checks range and permission). Cannot exit above 12 m/s (boats excepted). |
| Camera: first / third person | `V` | Also in Settings. Each player's choice is saved. |
| Fire | Left mouse | Hold for automatic weapons (SMG, carbine). Fires at the crosshair. |
| Aim | Right mouse | Raises the weapon in the viewmodel. No gameplay effect beyond the pose is implemented: the `fire` message carries only yaw and pitch. |
| Reload | `R` | Also happens automatically when the magazine empties and you have reserve ammo. |
| Select weapon | `1` to `5` | Order: stun pistol, pistol, SMG, shotgun, carbine. Only owned weapons work. These number keys are fixed (not rebindable). |
| Next weapon | `X` or mouse wheel | Cycles owned weapons. |
| Use first-aid kit | `Q` | Restores full health; needs a kit from Quik Pelican. |
| Ping | `G` | Marks the spot you are looking at (up to 120 blocks away) for your party or activity crew. Rate-limited. |

### In a vehicle

| Action | Default | Notes |
| --- | --- | --- |
| Accelerate / brake and reverse | `W` / `S` | Driver (seat 0) only. |
| Steer | `A` / `D` | |
| Handbrake | `Space` | |
| Horn | `H` | Plays a short honk; on police vehicles it toggles the siren. |
| Radio: next station | `.` (Period) | Only while in a vehicle. Radio volume is separate in Settings. |
| Look around | Mouse | Limited free-look relative to the vehicle. |
| Exit | `F` | |

Passengers (seats 1 and up) do not steer. From a vehicle only the stun pistol, pistol and
SMG can fire; other weapons are blocked by the server. If the driver leaves, the vehicle
stops and stays driverless. The server assigns the first free seat when someone enters,
so a passenger who leaves with `F` and re-enters will take the driver's seat if it is
empty. (The protocol supports requesting a specific seat, but the default client has no
key for it.)

### Menus and panels

| Action | Default | Notes |
| --- | --- | --- |
| Pause menu | `Esc` | Also opens when the mouse lock is released. `Esc` closes most open panels. |
| Phone | `Arrow Up` | Apps: Contacts, Jobs, Social, Garage, Map, Settings. Toggles. |
| Map | `M` | Toggles. |
| Party / social | `P` | Friends, party, invites, invite link. Toggles. |
| Chat | `T` | Channels: party, world, activity. |
| Skip cutscene | `Space` | During a cutscene. With a crew, it is a vote: the cutscene skips when more than half of the crew votes. |
| Retry / leave after a failed activity | `Enter` (leader only) / `L` | Shortcuts shown while the pointer is locked. |

## Combat notes

- You start with only the **Zapper stun pistol** (non-lethal, stuns NPCs for a while).
- Weapons damage NPCs (guards, police, hostiles) and mission targets. Player-versus-player
  damage is off in public free roam.
- Pistol, SMG, shotgun and carbine are sold at **Bullseye Arms** (north of the garage, lot
  centre about x 2424, z 3144). That shop was added to the content shortly before this
  document was finalised, so confirm it in game. Ammo is bought in packs there too.
  A new weapon comes with one ammo pack; carry limits are per weapon (`maxAmmo`).

## Onboarding tips

1. **Where you start.** New accounts get $2000 cash and one starter vehicle (a
   Dart Hatch, kept in your garage) and spawn in **Solano Plaza** in downtown Port
   Solano, at about x 2472, z 3204 (see [MAP.md](MAP.md)).
2. **Meet Marisol.** Walk east to the **Sunny Side Diner** (lot east of the plaza,
   about x 2520, z 3190). Marisol Reyes sits in the corner booth. Press `E` near her to
   see her jobs, then start **Welcome to Port Solano** (also reachable from the phone's
   Jobs app). It teaches driving, picking up packages and delivering to the garage, and
   ends at your apartment. Completing it unlocks the Sundial heist and its two preps
   and the Downtown Sprint race.
3. **Parties.** Missions are for 1 to 4 players. Open the party panel (`P`), add friends
   (search by user name) and invite them, or create an invite link. Only the party
   leader starts activities; everyone in the party is pulled into the activity. The main menu has
   **Join party's world** next to **Play** to land in a world where your party is.
4. **Your apartment, The Coquina** (one block north of the plaza, about x 2472, z 3144).
   Use the front door to go inside (a private instance for you and your party). The
   **bed** heals you and saves your progress and position, the **wardrobe** changes your
   shirt colour, the **board** opens heist planning, the TV shows news.
5. **Torque & Tide Garage** (west of the plaza, about x 2424, z 3192). Mechanic Dez: repair
   (cost scales with damage), respray ($400), store a vehicle, collect one, buy new
   vehicles. Vehicles are shared with your party for driving. From the phone's Garage
   app you can have a vehicle delivered near you for $100 (not boats).
6. **Quik Pelican** (south of the plaza) sells snacks and first-aid kits (carry up to
   3, use with `Q`). The diner and the Neon Lagoon bar sell food and drinks that heal.
7. **Police and wanted level.** Stealing or wrecking traffic cars in front of
   witnesses raises a wanted level (1 to 3 stars); police only chase the wanted player.
   Break line of sight and stay out of the search circle shown on the minimap to lose
   them, or pay a fine at the **Solano PD Central Precinct** desk (not while being
   actively chased). If you are busted you wake at the precinct and are fined (up to
   $250). If you are downed you respawn at the plaza.
8. **DJ Kilo** at the Neon Lagoon club runs the street race once the first mission is done.
9. **Disconnects.** If your connection drops, you have about 45 s (free roam) or 90 s
   (activity or apartment) to reconnect and keep your place; the game reconnects
   automatically. The server saves your position every so often; the bed saves
   immediately.
10. **Accessibility settings** (Settings > Accessibility): subtitles on/off and size, reduced
    screen shake, colour-blind marker shapes, FPS counter. Graphics settings include
    quality preset, render distance (4-16 chunks), field of view (50-110) and bloom.

## Known inconsistencies (for maintainers)

- The first-aid kit description in `content/economy.ts` says "Use with [H]". The
  default key is `Q` (`H` is the horn).

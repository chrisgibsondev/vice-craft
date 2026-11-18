# Requests from the entity renderer to other modules
- PlayerEnt has no skin/outfit-style or held-weapon field: skin/hair derive from a hash of the id; others' held weapons are not drawn (only the local player's, via LocalView.weapon). Add `sk?: number` and `w?: string` to PlayerEnt if you want them.
- ObjEnt `yaw` is used to face keypads/safes (front = -z at yaw 0). Please send the wall-facing yaw.
- Game loop order each frame: r.update -> entities.update -> r.render -> viewModel.update -> viewModel.render.
- Vehicle `hp` is treated as 0..100 percent (smoke < 35, wreck at 0).

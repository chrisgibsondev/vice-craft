# Leonia — real-data world (stage 1: Miami area)

Leonia is a second world generator that builds a true-scale (1 block = 1 m) recreation of
real Miami and its surroundings from OpenStreetMap, in the fictional state of "Leonia". Since
2026-11-18 it is the **default world** on server and client and carries all game content (§10);
the hand-authored Palmara world stays selectable (`BLOCKSHORE_WORLD=palmara`, `?world=palmara`).

| | |
|---|---|
| Area | lat 25.68–25.90, lon −80.33…−80.11 (Downtown, Brickell, Wynwood, Little Havana, Coral Gables, MIA airport, PortMiami, Virginia Key, Key Biscayne, Miami Beach, North Miami) |
| Size | 22 065 × 24 373 blocks (22.1 km × 24.4 km, 538 km², 34 % water) |
| Height | `WORLD_H` = 256 when Leonia is selected (128 for Palmara); street top block y = 21, sea surface y = 20 |
| Data | 2 112 tiles of 512 m, 16.9 MB raw (9.5 MB gzipped), largest tile 25 KB |
| Speed | ~1 700–2 000 chunks/s single thread (16×16, warm tiles); tile raster build 12–20 ms |

## 1. Selecting the world

* Page: `?world=leonia` (e.g. `http://localhost:5420/?preview&world=leonia`). Without `?at=`
  the preview starts above the downtown spawn. Extra preview helpers: `?dist=<chunks>` and
  `__bs.dist(n)` widen the view (fog + chunk radius); `__bs.capture([x,y,z,lx,ly,lz], dist)`
  pins the camera and steps frames until every chunk in range is meshed (works with a hidden pane).
* Server / scripts: `BLOCKSHORE_WORLD=leonia`. The server reads tiles from
  `apps/client/public/world/leonia` (override with `BLOCKSHORE_LEONIA_DATA=<dir>`).
* Chunk workers: `chunks.ts` names its workers `"chunks world=leonia"`; `constants.ts` reads
  `self.name`, so `WORLD`/`WORLD_H` are right inside the worker before anything else loads.
* `constants.ts` exports `WORLD: 'palmara' | 'leonia'` and `WORLD_H` (evaluated once at load).
* Metadata: `LEONIA` (shared) — `width`, `depth`, `seaLevel`, `proj`, `tileSize`, `dataPath`,
  `attribution`, `spawn` = `[14170.5, 22, 13931.5]` (sidewalk of E Flagler St at Biscayne Blvd,
  downtown). `index.json` repeats bounds, spawn, counts, sizes and per-district density.

Hook points touched (all minimal, default behaviour unchanged): `packages/shared/src/constants.ts`,
`packages/shared/src/index.ts` (re-export), `apps/server/src/world/voxels.ts`,
`apps/client/src/render/chunkWorker.ts`, `apps/client/src/render/chunks.ts` (worker name),
`apps/client/src/preview.ts`. Gameplay files were not edited. `voxels.ts` still exports the
Palmara `worldGen`, because NPC/traffic code queries its rasters (see stage 2).

## 2. Data sources and licence

* **OpenStreetMap**, © OpenStreetMap contributors, **ODbL 1.0**. Recorded in
  `apps/client/public/world/leonia/CREDITS.txt` and `index.json → attribution`. Any build that
  ships these tiles must show "© OpenStreetMap contributors" (e.g. on the map screen / credits).
  The tiles are a derivative database; the ODbL share-alike clause applies to the tile data
  (not to the game code).
* Primary snapshot: **Geofabrik `florida-latest.osm.pbf`** (661 MB, 2026-11-17), filtered to the
  bbox + 0.02° while parsing (`scripts/osm/pbf.ts`, a dependency-free PBF reader).
* The Overpass API was the first choice (`scripts/osm/fetch.ts`: 0.02° tiles, strictly sequential,
  1.5 s pause, exponential backoff, three mirrors, every response cached under `.cache/osm/raw/`).
  On 2026-11-18 all three Overpass instances were at capacity (502/504 for ~30 min), so only
  6 tiles were fetched; the build merges whatever is cached (dedupe by element id, larger
  geometry wins). A BBBike "Miami" extract (19 MB) was also downloaded; it misses the north
  strip (lat > 25.86) and is only used if the Geofabrik file is absent.
* Raw downloads live in `.cache/osm/` (git-ignored, never served, parsed as data only).
* No Google/Bing/Mapbox data or imagery, no game maps. District boxes (`districts.ts`) are
  hand-typed coarse lat/lon rectangles, only used to pick architecture styles and labels.

## 3. Projection (exact and reversible)

Local equirectangular projection, origin = NW corner (lat 25.90, lon −80.33):

```
x = (lon − lonW) · mPerDegLon        lon = lonW + x / mPerDegLon
z = (latN − lat) · mPerDegLat        lat = latN − z / mPerDegLat
```

with WGS84 metres-per-degree at the centre latitude φ = 25.79°:
`mPerDegLat = 111132.92 − 559.82 cos2φ + 1.175 cos4φ − 0.0023 cos6φ = 110 784.77`,
`mPerDegLon = 111412.84 cosφ − 93.5 cos3φ + 0.118 cos5φ = 100 295.01`.
Code: `packages/shared/src/world/leonia/proj.ts` (`lonLatToWorld`, `worldToLonLat`). Linear in
both axes, so the round trip is exact to float precision. The east–west scale drifts by
≤ 0.2 % at the north/south edges (cos-latitude change); acceptable at game scale.

## 4. Build pipeline (`scripts/osm/`)

```
npx tsx scripts/osm/fetch.ts [--gaps]                                    # optional Overpass cache
NODE_OPTIONS=--max-old-space-size=16000 npx tsx scripts/osm/build.ts      # ~105 s, ~3 GB RAM peak
BLOCKSHORE_WORLD=leonia npx tsx scripts/osm/render.ts [district …]       # verification renders
```

`build.ts` steps:

1. **Load + dedupe** PBF + cached Overpass JSON; project every node.
2. **Classify** (`classify.ts`):
   * buildings (`building=*`, `building:part=*`, multipolygon relations) → kind (house,
     apartments, office, retail, warehouse, hangar, terminal, church, school, hotel, parking,
     shed, canopy, …), roof shape (`roof:shape`), `building:colour` → palette slot, name,
     height = `height` → else `building:levels × 3.2` (+1.5 m for houses) → else a default by
     kind and footprint area; `min_height` / `building:min_level` for parts; underground dropped.
   * roads (`highway`): class, lanes (`lanes` or class default), width (`width` or
     lanes × lane width + shoulders), oneway, bridge, tunnel (dropped), link, layer,
     implicit sidewalks for urban classes unless `sidewalk=no|separate`; footways/paths/steps/
     cycleways/tracks; rail (`rail`, `light_rail`, `subway`, `tram`, `monorail`; tracks);
     aeroway runway/taxiway lines; piers and breakwaters (lines or areas).
   * water: `natural=water`, `waterway=riverbank|dock`, `landuse=reservoir|basin` polygons;
     `waterway=river|canal|stream|drain|ditch` lines buffered by `width` or a class default;
     `natural=coastline`.
   * areas: residential, commercial, retail, industrial/port, railway, construction, military,
     education, hospital, aerodrome, religious, farmland (base land use) and grass, park,
     garden, forest, scrub, wetland, cemetery, golf course + fairway/green/tee/bunker/rough,
     beach, sand, parking, pitch, playground, plaza, apron, runway, helipad, marina, pier,
     breakwater, bridge, pool, stadium, nature reserve, track, zoo, dog park (surface cover).
   * POIs as generic categories only (food, cafe, bar, shop, fuel, bank, pharmacy, hospital,
     school, police, fire, worship, hotel, museum, attraction, station, lighthouse, tree/palm,
     street lamp, traffic signal, bus stop, bench, …). Names/brands of POIs are dropped.
     Building and road names are kept.
3. **Land/water mask** on a 1 m global raster: coastline ways are drawn as barriers, seeds are
   placed 1.6/2.6 m either side of every coastline segment (water on the right of the way
   direction, per OSM convention), connected components are flood-filled and decided by
   majority vote, then inland water polygons and buffered waterways are added.
4. **Bridge decks**: bridge ways are chained through shared end nodes; each chain gets a
   clearance target (6 m + 4.5 m per extra `layer`; ≥ 8 m over water, ≥ 12–15 m for major
   roads crossing > 60/250 m of water; rail 7.5 m; footbridges 4.5 m; cap 30 m) and a ramp
   profile (8 % for roads, 14 % for footbridges) measured from the chain's free ends by a
   multi-source shortest-path. Per-vertex deck heights are stored in the tile.
5. **Junctions** (nodes shared by ≥ 2 car roads, ≥ 2 of them residential or above) are stored
   as POIs with a radius, for crosswalks and marking suppression.
6. **Procedural infill** (density requirement): an occupancy raster marks water, buildings
   (+2 m), roads (+ sidewalks + 1.5 m) and open land use (parks, golf, cemeteries, beaches,
   airport, rail yards, parking, construction, …). Every trunk…living-street road is walked on
   both sides; a rotated lot rectangle is placed facing the road where it is completely free:
   houses (10–14 × 11–16 m, 5–7 m setback, second back-row house in deep residential blocks),
   commercial frontage on major roads / commercial land use (14–28 m frontage, 1–3 floors, 3–6
   floors in the dense districts), warehouses in industrial land use. Each try shrinks to 80 %
   and 62 % before giving up. Result: **88 240 synthetic buildings**, flagged `SYNTHETIC`.
7. **Tiling**: Douglas–Peucker simplification at 0.5 m, then quantisation to integer metres
   (so the worst-case vertex error is 0.5 m simplification + 0.71 m rounding); areas are
   clipped (Sutherland–Hodgman) to tile + 16 m, buildings are stored whole in every tile their
   bbox (+3 m) touches, roads as clipped runs within half-width + 24 m, POIs in their owning tile.

### Tile format (`packages/shared/src/world/leonia/format.ts`)

`t_<tx>_<tz>.bin`, 512 m × 512 m, little-endian, LEB128 varints, delta + zigzag coordinates:

```
"LEO1" u8 version  v tx  v tz
water   v mode (0 all land | 1 all water | 2 RLE rows: per row v nRuns + alternating land/water runs)
strings v n × (v len, utf8)
areas   v n × (u8 kind, u8 angle 0..π, rings)                          sorted by area desc
blds    v n × (u8 kind, u8 roof, u8 flags, v height dm, v minHeight dm, u8 levels,
               v name+1, v seed, u8 colour, rings)                     parts first
roads   v n × (u8 class, u8 lanes, v width dm, u8 flags, u8 layer+8, v name+1, line,
               [v deck dm per point if BRIDGE])
pois    v n × (u8 cat, u8 arg, point)                                  delta-coded
rings = v nRings × line;  line = v nPts, first point absolute, rest zigzag deltas
```

`index.json` holds projection, tile grid (44 × 48), sizes, counts, density and spawn.

### Sizes

| Section | Bytes |
|---|---|
| Buildings | 10.6 MB |
| Roads | 3.0 MB |
| Water RLE | 2.0 MB |
| Areas | 0.41 MB |
| POIs | 0.42 MB |
| Strings | 0.41 MB |
| **Total** | **16.9 MB** raw, **9.5 MB** gzip (static hosts gzip `.bin` automatically when configured; Vercel does) |

484 tiles are open sea or empty (< 100 B each).

## 5. Runtime (`packages/shared/src/world/leonia/`)

* `tiles.ts` — `LeoniaTiles`: LRU cache of `TileRaster`s (48 tiles in the server's `voxels.ts`,
  12 per client worker, 16 by default). Sources: `readSync` (server, scripts: `fs`) or async
  `read` (client workers: `fetch('/world/leonia/t_x_z.bin')`). `TileRaster` decodes a tile and
  rasterises it once into 1 m grids with a 4 m apron: base land use (+ angle), surface cover
  (+ angle), building id + chamfer distance to wall, ground road/rail segment id, bridge-deck
  segment id (topmost deck wins), junction core/crosswalk bands, driveways. It also derives a
  deterministic stamp list (trees, palms, lamps, cars, boats, yachts, umbrellas, lifeguard
  towers, bus shelters, benches, port cranes, airliners). Memory: ~2.2 MB per resident tile.
* `gen.ts` — `LeoniaGen.generateRegion(x0, z0, w, d, out)` (same contract as `WorldGen`). The
  client must `await gen.prepare(x0, z0, w, d)` first (the worker serialises jobs); the server
  loads synchronously. Output depends only on tile bytes → identical on server and client.

### Generator rules

* **Water**: tile mask; depth from a per-region distance-to-land field (1 m at the shore, 9 m
  offshore), sand/seagrass floor, stone below. Seawall docks along residential canals and
  marinas; moored boats/yachts 3.5–7 m off residential shores; boat grids in marinas; piers
  and breakwaters; a road over water without a deck becomes a causeway fill.
* **Roads**: asphalt to the real width; yellow centre line on two-way roads, dashed white lane
  dividers from the lane count, edge lines on motorways/trunks; zebra crosswalk bands around
  junctions; 2.5 m sidewalks; front-yard hedges/picket fences with gaps on residential streets;
  runways (RUNWAY block, centre dashes, edge lines), taxiways (yellow centre line); rail with
  gravel bed, sleepers and 2-block gauge per track; pedestrian streets cobbled.
* **Bridges**: deck slab + surface at 21 + deck height, concrete parapets, two-column piers every
  32 m. The MacArthur and Venetian high points reach 15 m clearance; boats pass under them.
* **Buildings**: real footprint extruded to the real height (cap: 226 m above street with
  `WORLD_H` 256; Panorama Tower etc. are capped). Facade family by kind, height and district:
  glass curtain-wall towers (fins/bands, lobby glazing, neon crowns, penthouse rings, masts,
  helipads), white condo towers with balcony rails and rooftop pools (Brickell, Edgewater,
  beaches), Art Deco pastels with white eyebrow bands and neon (South Beach), mid-rises with
  window grids and storefront glazing (palettes per district; murals in Wynwood), houses with
  hip roofs from the distance-to-wall field (barrel tile in Coral Gables/Grove/Key Biscayne,
  mixed elsewhere), warehouses with roll-up doors and solar roofs, hangars with vaulted roofs,
  terminals in white panel + glass bands, churches with stained glass, parking garages with
  open decks and parked cars, canopies (gas stations), sheds. `roof:shape` and
  `building:colour` are honoured where tagged. Building parts override their outline.
* **Ground**: per surface/land-use: parks (grass, flowers, paths, benches, dense trees),
  forest/nature (trees + palmettos), golf (fairway/putting/bunker blocks, rough with trees),
  cemetery (grave rows), pitches with lines, tracks, playgrounds, pools, plazas, parking lots
  (white bays aligned to the lot's dominant edge, ~55 % filled with block cars), aprons, beaches
  (sand, umbrellas, lifeguard towers every ~160 m), port land (container blocks aligned to the
  terminal, straddle lanes, gantry cranes on the quays), wetlands, construction, farmland.
  Vacant lots in the dense districts become surface parking; yards get grass and trees.
* **Vegetation**: OSM trees/palms where mapped, street trees every 13 m on sidewalks, lamps
  every 31 m, jittered 6 m grid elsewhere with per-surface probability; palm share by
  district (85 % beach, 75 % downtown, 35 % Gables/Grove).

### Performance (measured)

* Node, single thread, warm tiles, downtown: **~2 000 chunks/s** (16 × 16 server chunks),
  **~1 400–1 700 chunks/s** (20 × 20 padded client regions). Including cold tile builds:
  1 700–2 300 chunks/s over whole districts. Tile build 12–20 ms average.
* Server (`BLOCKSHORE_WORLD=leonia`): 400 chunks around spawn in 0.3 s, 207 MB RSS.
* Browser: the chunk workers spend most of their time meshing 256-high columns with tall
  towers: 25–60 chunks/s per page with 4 workers (radius 24 ≈ 1 800 chunks in ~35 s). This is
  the mesher, not the generator; see stage 2.

## 6. What is and is not captured

Captured (from OSM, at ≤ 1.2 m positional error):
* coastline, bay, ocean, canals, lakes, rivers (34 % of the area is water);
* 222 204 real building footprints; **91.1 % have a real `height` tag** (Miami-Dade import),
  0.4 % `building:levels`, 8.5 % default heights;
* 68 925 car-road ways (motorway 2 059, trunk 1 246, primary 4 244, secondary 5 613, tertiary
  4 287, residential 15 246, service 35 084, …), 58 893 paths, 897 rail ways (Metrorail,
  Metromover, Brightline/freight), 548 runways/taxiways, 1 689 bridge ways;
* land use / surface polygons (10 563), 58 273 POI nodes (generic categories), 34 289 junctions.

Density (buildings per km² of land, real + synthetic, from `index.json`):

| District | Land km² | Real | Synthetic | per km² |
|---|---|---|---|---|
| Little Havana | 11.1 | 12 044 | 2 087 | 1 278 |
| Design District | 5.6 | 4 615 | 1 983 | 1 186 |
| Coconut Grove | 8.5 | 6 799 | 2 550 | 1 099 |
| North Shore | 43.7 | 32 221 | 14 137 | 1 061 |
| Coral Gables | 45.2 | 28 423 | 16 411 | 992 |
| Wynwood | 3.2 | 1 473 | 1 170 | 824 |
| Mid Beach | 7.5 | 3 706 | 2 024 | 763 |
| Brickell | 4.2 | 2 150 | 694 | 676 |
| South Beach | 5.8 | 2 742 | 695 | 591 |
| Downtown | 4.8 | 958 | 1 049 | 421 |
| Key Biscayne | 7.1 | 1 786 | 1 165 | 417 |
| Airport box | 21.3 | 2 305 | 2 236 | 213 |

(Downtown and Brickell have few, very large footprints, so counts per km² understate built-up
coverage there.)

Not captured / approximated — be aware:
* **Terrain is flat.** Miami's 0–7 m relief, embankments and seawall heights are ignored.
* **Tunnels are dropped** (PortMiami tunnel, underpasses): 103 ways.
* **Synthetic infill** (28 % of all buildings) is procedural, not real: placed where OSM has no
  footprint along a street. In downtown/Brickell some of it stands on what are really surface
  parking lots or vacant land; in residential areas it fills unmapped houses plausibly but the
  exact lots differ from reality. Synthetic buildings carry the `SYNTHETIC` flag.
* **Facades are generic**: styles are chosen by kind/height/district, not from photos; famous
  buildings are recognisable only by footprint, height and roof shape (no spires, crowns or
  special geometry beyond `roof:shape`). Heights above 226 m are capped.
* **Bridge profiles are estimated** from `layer` and water crossings, not from real clearances:
  the Venetian Causeway (really a low bascule bridge) gets 15 m; the Rickenbacker high span
  only reaches ~8 m because its OSM ways are split with free ends. Elevated expressways are
  separated by layer but ramps are 8 % straight grades; decks step 1 block per ~12 m.
* Lanes/sidewalks use defaults where untagged; separately-mapped sidewalks double up with
  implicit ones; turn lanes, medians, traffic lights and road signs are not drawn.
* Vegetation, cars, boats, umbrellas, cranes and aircraft are procedural decoration.
* The district boxes are coarse rectangles; style changes abruptly at their edges.
* The client view distance (fog) is still the game's 8–14 chunks in normal play.

## 7. Verification artefacts

* Top-down generator renders beside the decoded OSM vectors (synthetic footprints in orange):
  `docs/progress/leonia-topdown-{downtown,brickell,sobe,causeway,port,airport,residential,keybiscayne,wynwood,havana,northmiami}.png`.
* 3D captures from the preview page: `docs/progress/leonia-{downtown-skyline,downtown-street,brickell,brickell-street,miami-beach,beach-umbrellas,causeway,port,port-cranes,airport,residential,key-biscayne,wynwood}.jpg`.

## 8. Stage 2 plan

### 8.1 Moving gameplay onto real locations
1. Build a **Leonia content layer** parallel to `content/pois.ts`, `activities.ts`,
   `cutscenes.ts`: every authored position becomes `{ lat, lon, floor? }` (resolved with
   `lonLatToWorld`) or an OSM anchor (`way id` / named building), so it survives re-builds.
2. **12 enterable buildings**: pick real buildings of the right type (e.g. a Brickell bank
   tower for the bank, a Wynwood warehouse for the club, a Little Havana storefront for the
   cigar shop, a South Beach Deco hotel, a Coral Gables villa, a Doral hangar). Interiors stay
   prefab rooms (`structures.ts`) stamped inside the real footprint at street level; the
   generator gets an `interiors` list per tile that carves the shell and places the door on the
   street-facing wall (the facade code already knows wall orientation).
3. **Shops / spawn / safehouses**: map each to a real address-level spot on a sidewalk; a
   validator checks every spot is walkable (`groundY` = 22, air above) like the Palmara one.
4. **32 activities**: races re-routed on real roads (store as road-graph node lists, not
   coordinates), boat races in Biscayne Bay/canals, flight/air activities from MIA/Opa-locka,
   on-foot activities in parks. `validate-content.ts` gets a Leonia mode that generates the
   route chunks and checks drivability (deck steps ≤ 1 block, no water, no buildings).
5. **Cutscenes**: camera paths re-authored against real landmarks (downtown skyline from the
   bay, MacArthur Causeway, Ocean Drive); reuse `__bs.capture` to preview them headless.

### 8.2 Systems that assume the Palmara 48-block grid (must change for Leonia)
* `apps/server/src/world/npc.ts`: `G = 48`; street pedestrians/traffic use `streetOk()` with
  `worldGen.r.isLand/zoneAt` (Palmara rasters), `spawnHighway()` walks Palmara `r.segs`
  polylines, and city traffic waypoints snap to `Math.round(x / 48) * 48` intersections;
  `worldGen.lotPlan(i, j)` (48-block lots) chooses ped spawns; bounds checks use `PALMARA.width/depth`.
* `apps/server/src/world/police.ts`: `G = 48` and `gridWaypoint()` (Manhattan routing to the
  next 48-grid intersection) for pursuit routing.
* `apps/server/src/game.ts:832`: player position snapped to the 48 grid.
* `apps/client/src/ui/mapTexture.ts`, `Minimap.tsx`, `MapOverlay.tsx`: draw Palmara rasters,
  counties and places, and a `% 48` street grid.
* `apps/client/src/game/game.ts` builds `getRaster(PALMARA)` for client logic.
Plan: add a **road graph** to the build (nodes = OSM junction nodes, edges = road ways with
class, lanes, oneway, length, bridge deck heights; ~70 k edges, a few MB) stored as a
separate `graph.bin`. Server systems get a `WorldNav` interface (`nearestRoad`, `laneFrame`,
`route(a, b)` with A*, `randomEdgeNear`, `sidewalkPoint`) with two implementations: the
existing grid one for Palmara and a graph one for Leonia. Traffic then follows edge polylines
with lane offsets from `lanes/width/oneway`; peds walk sidewalk offsets of the same edges;
police use A* on the graph instead of `gridWaypoint`. The minimap draws from a low-res
pre-rendered map image per tile (generated by `render.ts`) plus the vector road layer.

### 8.3 Performance work
* Client meshing of 256-high columns dominates: skip empty sections (mesh in 16-high
  sub-chunks), add a far-field LOD (pre-rendered tile impostors or a low-res height mesh from
  the tile rasters) so the skyline is visible beyond the fog distance.
* `WORLD_H` 256 doubles chunk memory (64 KB per 16×16 column instead of 32 KB; the server's
  1 600-chunk cache grows from ~51 MB to ~105 MB). Sub-chunk storage would recover this.

### 8.4 Extending Leonia beyond Miami
* The pipeline is bbox-driven: widen `proj.ts` bounds (keep one global origin so coordinates
  never move). The varint format has no fixed coordinate width, but first points are stored
  unsigned, so the origin must stay at the NW corner of everything ever built (features west
  or north of x/z = 0 are currently clamped to 0 at the world edge). Next rings: Hialeah,
  Doral, Coral Gables south, Kendall, Homestead + the Everglades edge (needs terrain and
  wetland rules), north to Fort Lauderdale; the Keys as a separate island chain.
* For areas with sparse OSM building coverage (Everglades, rural Homestead), the infill step
  needs land-cover data (e.g. ESA WorldCover, CC-BY 4.0) to avoid inventing suburbs where there
  are farms; keep each source's attribution in `CREDITS.txt`.
* Re-fetch: `fetch.ts` when Overpass is healthy, or the Geofabrik extract for full rebuilds
  (deterministic: same input bytes → same tiles).

## 9. Road graph + navigation (stage 2, server AI)

```
NODE_OPTIONS=--max-old-space-size=8000 npx tsx scripts/osm/graph.ts   # ~80 s, after build.ts
```

`graph.bin` (format `LEOG` v1, `packages/shared/src/world/nav/graph.ts`) sits next to the tiles:
191 189 nodes (junctions + way ends), 263 958 edges (car roads minus driveways/parking aisles, plus
footways/paths/steps/pedestrian/piers in the same graph), 0.1 m polylines (DP 0.5 m), class, lanes,
width, oneway (oneway=-1 reversed), speed (maxspeed or class default), bridge deck profile (same
`scripts/osm/decks.ts` code and inputs as the tiles; mean deviation 0.14 m), sidewalk/private/
roundabout flags, 2 739 signalised junctions. 4.0 MB raw / 1.7 MB gzip, decoded + indexed in ~90 ms.
`graph.json` holds the stats.

`WorldNav` (`packages/shared/src/world/nav/`) is the AI-facing interface: `PalmaraNav` wraps the
48-grid logic unchanged, `LeoniaNav` works on the graph + tile rasters. Server instance:
`apps/server/src/world/nav.ts`; Leonia traffic / pedestrians / wildlife / police pursuit:
`apps/server/src/world/npcLeonia.ts`. Load test: `npx tsx scripts/loadtest.ts 16 40 --world leonia`.

## 10. Game content on Leonia (default world since 2026-11-18)

### 10.1 Placement layer for the enterable prefabs

The 13 prefabs of `world/structures.ts` are still built in 48 × 48 lot-local coordinates
(front = local −z). `world/placement.ts` stamps them anywhere with a **frame** = world
position of the lot centre (`ox, oz`, integers so cells map 1:1) + `rot` in clockwise quarter
turns (front faces 0 north, 1 east, 2 south, 3 west). Local `(u, v) = (lx − 24, lz − 24)` maps to
`O + R(u, v)`; yaws rotate by `−rot·π/2`; door anchors are re-cornered and swap axis on odd turns.

* `content/pois.ts`: every POI has `lot` (Palmara) and `leonia: { ox, oz, rot, street, district }`.
  `poiFrame(p, world)`, `worldAnchors(world)`, `anchor(key, world)`, `poiCenter(id, world)` return
  the selected world's coordinates (Palmara lots are unrotated frames, so Palmara is unchanged);
  `plazaSpawn()` / `policeSpawn()` give the per-world arrival / release spots.
* `world/leonia/gen.ts` (`leoniaPlaced`, `prefabs`): on the pad (lot-local x 5–42, z 4–42) the
  ground becomes a sidewalk slab with air above and the rotated prefab is stamped; every generated
  building (real or synthetic) whose bbox touches the pad is dropped (`leoniaBuildingRemoved`, also
  used by the far-city LOD and the map tiles); the real street in front (local z 0–3) keeps its
  road/sidewalk but loses street trees, lamps and shelters so the entrance is clear. Pure function of
  the frame list, so server and client agree.
* Site finder: `npx tsx scripts/osm/sites.ts <lon> <lat> [radius] [streetRegex] [--avoid=ox,oz;…]`
  walks the frontage of nearby car streets, snaps the curb to the road graph, and rejects pads
  crossed by car roads, rail, bridge decks or water; `--check ox oz rot` inspects one frame.

| Business (fictional) | Prefab | District | Street (real) | lat, lon (lot centre) | World x, z | rot |
|---|---|---|---|---|---|---|
| The Coquina (safehouse) | safehouse | Downtown | NE 3rd Street | 25.77733, −80.19170 | 13871, 13590 | 2 (faces south) |
| Bayfront Plaza (spawn) | plaza | Downtown | Biscayne Blvd, Bayfront Park | 25.77498, −80.18705 | 14337, 13850 | 3 (faces west) |
| Torque & Tide Garage | garage | Downtown | NE 1st Avenue | 25.77635, −80.19227 | 13814, 13698 | 1 (faces east) |
| Quik Pelican | store | Downtown | SE 1st Street | 25.77369, −80.18940 | 14101, 13993 | 2 (faces south) |
| Sunny Side Diner | diner | Downtown | NE 2nd Avenue | 25.77676, −80.19008 | 14033, 13653 | 3 (faces west) |
| Leonia PD — Central Precinct | police | Downtown (Overtown edge) | NW 3rd Avenue | 25.77922, −80.19931 | 13108, 13381 | 3 (faces west) |
| Neon Lagoon (nightclub) | club | Wynwood | NW 2nd Avenue | 25.80169, −80.19938 | 13101, 10891 | 1 (faces east) |
| Bullseye Arms (gun store) | gunstore | Wynwood | NW 22nd Street | 25.79788, −80.20409 | 12628, 11313 | 0 (faces north) |
| Vega & Sons Imports (office) | office | Brickell | SW 10th Street | 25.76421, −80.19489 | 13551, 15043 | 0 (faces north) |
| Sundial Jewelers | jewelers | Brickell | South Miami Avenue | 25.76420, −80.19348 | 13692, 15045 | 1 (faces east) |
| Pier 9 Warehouse | warehouse | PortMiami (Dodge Island) | cargo yard road | 25.77267, −80.16271 | 16778, 14106 | 0 (faces north) |
| Threadline (clothes + barber) | threadline | South Beach | Euclid Avenue | 25.77853, −80.13530 | 19527, 13457 | 1 (faces east) |
| Sunline Motors (showroom) | sunline | South Beach | 5th Street (by Alton Rd / the marina) | 25.77405, −80.13803 | 19254, 13953 | 0 (faces north) |

The early game (plaza, diner, safehouse, garage, store) sits within ~550 m in downtown. Pads were
chosen on surface lots and small buildings: the police station replaces one real 15 m building on
NW 3rd Ave, the store one 6 m building on SE 1st St, the jewellers one 10 m building on
S Miami Ave; the others clear only synthetic infill or nothing. Spawn `plazaSpawn()` =
(14325.5, 22, 13849.5); busted release `policeSpawn()` = (13089.5, 22, 13381).

### 10.2 Activities and cutscenes (`content/leonia/`)

Content stays authored in Palmara coordinates. `scripts/leonia-content.ts` writes
`content/leonia/positions.gen.ts` (~1 690 positions, 240 headings, ~50 overrides: race routes,
grids, par times, re-timed limits, blurbs) keyed by stable walk paths (`content/leonia/walk.ts`,
e.g. `story_1/stages/2/spawn/0/pos`). `activities.ts` applies it at load when `WORLD === 'leonia'`
(`content/leonia/apply.ts`), together with ordered place-name rewrites (Port Solano → Miami,
Solano Beach → South Beach, Port Island → Dodge Island, Flamingo/Tarpon causeways →
MacArthur/Venetian, Conch Harbor / Last Key → Virginia Key, …; characters and businesses keep
their names). Re-run the script after any content or generator change, then the validator.

How positions move:
1. **Building frames.** Points inside a prefab pad or at its entrance move with that building's
   frame (rotation included): interiors, doors, guards, loot, safes, NPCs, close camera work. Only
   the buildings an activity is *about* (interior hits / scripted doors, shared with its cutscenes)
   use frames, so a stray spot on a neighbouring Palmara lot does not jump to another district.
2. **Places.** Port Island → the warehouse frame on Dodge Island; Solano Beach / Ocean Drive →
   South Beach's Ocean Drive (same N–S shape, Atlantic to the east); Solano Airfield → the MIA
   hangar apron off NW 36th St; Conch Harbor → Virginia Key Beach; the lagoon → Biscayne Bay off
   Bayfront Park. Loose downtown streets: Palmara's compact grid ×2.2 over downtown Miami, or
   around the activity's home building when that is outside downtown (e.g. Wynwood for the club).
3. **Snapping** against the generated blocks: on foot → nearest standable cell (sidewalk and
   ground level preferred); cars → nearest lane of the road graph, heading = lane direction
   (closest to the authored heading on two-way roads), vehicles of one activity kept 7.5 m apart,
   footprint clear of lamps/trees (vans/trucks 5 × 5); drive-to targets on the carriageway; boats →
   open water (11 × 11), and every boat leg must be a straight clear run (blocked targets slide to
   the nearest spot with a clear run); cutscene cameras are placed relative to what they look at and
   whole camera moves are lifted clear of buildings and palm/tree crowns.
4. **Hand-authored routes.** Downtown Sprint: 2 × 1.97 km round NE 1st Ave – Flagler – Biscayne Blvd
   – NE 5th St (par 153/183/222 s); Neon Warm-Up (story 4): 2 × 1.0 km round the club's Wynwood block
   (NW 2nd/3rd Ave, NW 26th/28th St); Palm Mile Time Trial: 6.6 km South Beach ring from Sunline
   Motors — Alton Rd, 17th St, Collins Ave, Ocean Drive, 5th St (par 279/333/430 s); Lagoon Cup:
   3 × 670 m buoy loop in Biscayne Bay off Bayfront Park; story 7's island trip: Atlantic side of
   South Beach → round South Pointe → off Fisher Island → Norris Cut → Virginia Key Beach (no
   bridges). Race routes are A* on the road graph ignoring one-way rules (racers may), with
   checkpoints every 110–260 m and at turns; par times keep the Palmara average speeds.
5. **Re-timing.** Stage time limits grow by the extra distance (16 m/s driving, 15 m/s by boat,
   4.5 m/s on foot); taxi / delivery par scores likewise. E.g. story_3's drive back from MIA
   150 → 940 s, taxi drop 2 (downtown → South Beach) 130 → 610 s.

Server: world label `Leonia #n`; `PLAZA_SPAWN` / `POLICE_SPAWN` per world; the boat marina is open
water off Bayfront Park; saved positions are tagged with their world (untagged = Palmara, ignored
on Leonia); properties in `apps/server/src/webcontent.ts` have real addresses (Ocean Drive at 9th
St, Grove Isle, NW 36th St hangars, NW 7th St, …); news ticker per world. The voxel cache is sized
from a memory budget (`BLOCKSHORE_CHUNK_CACHE_MB`, default 512 MB on Leonia = 8 192 chunks of 64 KB;
50 MB = 1 600 chunks on Palmara). Load test (16 players over 16 neighbourhoods, 40 s): 2 666 chunks
resident, tick avg 4.2 ms / max 30 ms, RSS 949 MB for the whole process incl. 16 in-process clients.

### 10.3 Generator changes for navigation

* Bridge decks of car roads with sidewalks are widened by the sidewalk (2.5 m each side, walkable
  `SIDEWALK` blocks) inside the parapets (`tiles.ts` deck raster, `gen.ts deck()`).
* Deck piers on land never stand on a ground-level carriageway: such a column moves 16 m along the
  deck to the next gap (elevated Metrorail / Metromover and flyovers over streets).
* No tile or graph rebuild is needed (runtime generator only).

### 10.4 Validation and tests

`npx tsx scripts/validate-content.ts` validates the selected world (Leonia by default,
`BLOCKSHORE_WORLD=palmara` for Palmara): standable spots, car spawns on a real carriageway facing a
legal direction (road graph), boats and boat legs in open water, race checkpoint chains connected by
drivable routes (≤ 3× straight distance), cutscene cameras and whole camera moves outside blocks and
foliage, and every placement pad (no water / car road / rail; street within 8 m of the entrance).
`npm test` runs on Leonia; `tests/spots.ts` holds the per-world test locations, `tests/leonia.test.ts`
keeps the traffic/police checks and `tests/palmara.test.ts` keeps Palmara covered.
Screenshots: `docs/progress/move-*.jpg`.

## 11. Visual polish pass (2026-11-18)

Generator (`gen.ts`), tiles/format (`POI.PORTAL`), pipeline (`scripts/osm/decks.ts`, `build.ts`, `graph.ts`), LOD (`lod/*`).
Before/after captures: `docs/progress/polish-{before,after}-*.jpg` (+ `polish-after-landmark-*.jpg`).

* **Rooftops** (`roofItems`, seeded by building seed, same on server and client): membrane variants
  (`ROOF_WHITE` / `ROOF_DARK` / concrete) with tar seams, parapets (1–2 blocks, stepped corners on Deco,
  guard rail on tall condo/glass), AC condensers / chillers with fans / vent stacks / solar rows on a 6 m grid,
  stair bulkhead with door, wooden water tanks on truss stands, antennas, set-back penthouses on towers,
  helipads and masts (existing), pool decks with umbrellas + loungers on hotels and condos, Mediterranean tile
  hip roofs on low residential, chimneys on hip houses, parking-garage top decks with cars and light poles.
  Nothing is placed at street level or inside the `dist == 1` wall ring, so doors and streets are untouched.
* **Facades**: glass towers get a podium band + storefront glazing and mullion grids / spandrel lines / fins;
  Deco gets eyebrow bands, arched portholes, stepped corners and neon bands (Ocean Drive strip);
  ground-floor storefront glass with piers and an awning band on mid/deco/civic blocks in commercial districts;
  balcony rails on apartments/hotels; Wynwood walls are abstract mosaics from five mural blocks
  (`MURAL_A..E`, new `MURAL_C/D/E`, `ROOF_WHITE`, `ROOF_DARK` appended to `blocks.ts`; painters in `atlas.ts`).
* **Landmarks** (shapes only): stepped tower with a lantern (the downtown "Freedom Tower"), airport control
  tower (plinth, shaft, glazed cab, mast), ribbed dome arena on Biscayne Bay, ballpark dome with an open roof
  slot, airport concourse skylights, Ocean Drive hotel row (pastel Deco, neon bands). Matched by mapped name
  (`Freedom Tower`, `Control Tower`, `Concourse`) or by position (arena, ballpark, Ocean Drive strip).
* **LOD**: far boxes use the same `facadeFor` choice, plus parapet band in the trim colour, setback
  penthouse / bulkhead / antenna boxes and the landmark tiers, murals averaged into the wall colour, and a
  per-block grain in the shader; the voxel world already dithers out across `fogNear..fogFar` over the LOD.
* **Bridges**: bridge ways are densified (≤ 9 m) before the deck profile is computed, free ends within 2.5 m are
  joined into one chain, ramps are eased (smoothstep) with 18 m clearance on long high-level crossings
  (Venetian capped at 6 m); tiles and graph use a deck-aware Douglas–Peucker so the profile survives
  simplification. Decks have a jersey barrier + iron rail, lamps every 24 m on main roads, fascia girders,
  3-wide pier bents with a cap beam.
* **Tunnels**: still not modelled, but each surface road that runs into a dropped tunnel ends in a closed,
  covered portal (concrete box, orange lintel strip, sealed dark end) — `POI.PORTAL` (85 portals), stamped by
  `gen.ts portal()`. The road graph does not enter tunnels.
* **Tiles/graph must be rebuilt together**: `build.ts` (wipes the output folder, including `graph.bin`) then `graph.ts`.
* Wording: `activities.ts` now also rewrites `CONTACTS` through `leoniaRewrite()`; the rest of the content goes through
  `applyLeonia`. Client phone pages (`ui/web/*`) still contain Palmara / Solano strings (not part of this pass).

/**
 * Content validator. Run from the repo root:  npx tsx scripts/validate-content.ts
 *
 * Checks every activity / cutscene / POI position against the real generated world
 * (worldgen.generateRegion) and the structural rules of the activity data model.
 * Exit code 1 on any ERROR; warnings are informational.
 */
import { PALMARA } from '../packages/shared/src/content/map/palmara.map.ts';
import { getWorldGen } from '../packages/shared/src/world/worldgen.ts';
import { B, isSolid, isWater } from '../packages/shared/src/world/blocks.ts';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { WORLD_H, WORLD } from '../packages/shared/src/constants.ts';
import { LeoniaGen } from '../packages/shared/src/world/leonia/gen.ts';
import { RoadGraph, GF } from '../packages/shared/src/world/nav/graph.ts';
import { LeoniaNav } from '../packages/shared/src/world/nav/leonia.ts';
import { LEONIA_PROJ } from '../packages/shared/src/world/leonia/proj.ts';
import { isCarRoad, isRail } from '../packages/shared/src/world/leonia/format.ts';
import { poiFrame } from '../packages/shared/src/content/pois.ts';
import { frameRect, frameToWorld, frameFront, PAD } from '../packages/shared/src/world/placement.ts';
import { angleDiff } from '../packages/shared/src/physics.ts';
import { ACTIVITIES, ACTIVITY_BY_ID, CONTACTS } from '../packages/shared/src/content/activities.ts';
import { STORY_ACTIVITIES, EXTRA_CONTACTS } from '../packages/shared/src/content/story.ts';
import { HEISTS_ACTIVITIES, SUNDIAL_ACTIVITIES } from '../packages/shared/src/content/heists.ts';
import { MINIGAMES_ACTIVITIES } from '../packages/shared/src/content/minigames.ts';
import { CUTSCENES } from '../packages/shared/src/content/cutscenes.ts';
import { EXTRA_CUTSCENES } from '../packages/shared/src/content/cutscenes2.ts';
import { POIS, worldAnchors } from '../packages/shared/src/content/pois.ts';
import { PREFABS } from '../packages/shared/src/world/structures.ts';
import { SHOPS } from '../packages/shared/src/content/economy.ts';
import { WEAPONS } from '../packages/shared/src/content/weapons.ts';
import { VEHICLES } from '../packages/shared/src/physics.ts';
import type { ActivityDef, V3, SpawnDef, StageDef, Cond } from '../packages/shared/src/content/activityTypes.ts';

const LEO = WORLD === 'leonia';
const LEONIA_DIR = process.env.BLOCKSHORE_LEONIA_DATA ?? join(process.cwd(), 'apps/client/public/world/leonia');
const leoGen = LEO ? new LeoniaGen({ readSync: (tx, tz) => { const f = join(LEONIA_DIR, `t_${tx}_${tz}.bin`); return existsSync(f) ? new Uint8Array(readFileSync(f)) : null; } }, 128) : null;
const gen: { generateRegion(x0: number, z0: number, w: number, d: number, out: Uint8Array): void } = leoGen ?? getWorldGen(PALMARA);
console.log(`validating against world: ${WORLD}`);
const vox = {
  getBlock: (x: number, y: number, z: number) => block(Math.floor(x), y, Math.floor(z)),
  groundY: (x: number, z: number, fromY = 60) => { for (let y = Math.floor(fromY); y > 0; y--) { const id = block(Math.floor(x), y, Math.floor(z)); if (isSolid(id) || isWater(id)) return y + 1; } return 22; },
};
const graph = LEO ? new RoadGraph(new Uint8Array(readFileSync(join(LEONIA_DIR, 'graph.bin'))), LEONIA_PROJ.width, LEONIA_PROJ.depth) : null;
const lnav = LEO && leoGen ? new LeoniaNav(graph!, leoGen.tiles, vox) : null;
/** Leonia: a car spawn must sit on a real carriageway and face a legal direction of travel */
function laneCheck(p: V3, yaw: number | null): string | null {
  if (!graph) return null;
  const h = graph.nearest(p[0], p[2], 30, (e) => graph.isCar(e));
  if (!h) return `no road within 30 m of (${p[0]},${p[2]})`;
  const off = h.d - graph.eWidth[h.e] / 2;
  if (off > 0.8) return `${off.toFixed(1)} m off the carriageway of ${graph.name(h.e) || 'an unnamed road'}`;
  if (yaw !== null) {
    const pt = graph.pointAt(h.e, h.s);
    const fwd = Math.atan2(-pt.tx, -pt.tz), back = Math.atan2(pt.tx, pt.tz);
    const okF = Math.abs(angleDiff(yaw, fwd)) < 0.6, okB = Math.abs(angleDiff(yaw, back)) < 0.6 && !(graph.eFlags[h.e] & GF.ONEWAY);
    if (!okF && !okB) return `heading ${yaw.toFixed(2)} does not follow ${graph.name(h.e) || 'the road'}`;
  }
  return null;
}
/** Leonia: route length between two road points (ignoring one-way rules, as racers do) */
function roadDist(a: V3, b: V3): number | null {
  if (!graph) return null;
  const node = (x: number, z: number) => { const h = graph.nearest(x, z, 40, (e) => graph.isCar(e)); if (!h) return -1; const A = graph.eA[h.e], Bn = graph.eB[h.e]; return Math.hypot(graph.nodeX[A] - x, graph.nodeZ[A] - z) < Math.hypot(graph.nodeX[Bn] - x, graph.nodeZ[Bn] - z) ? A : Bn; };
  const na = node(a[0], a[2]), nb = node(b[0], b[2]);
  if (na < 0 || nb < 0) return null;
  const r = graph.route(na, nb, { car: true, oneway: 'ignore', maxExpand: 200000 });
  if (!r) return null;
  return r.edges.reduce((s, e) => s + graph.eLen[e], 0);
}
void lnav;
const T = 64;
const cache = new Map<number, Uint8Array>();
export function block(x: number, y: number, z: number): number {
  if (y < 0 || y >= WORLD_H) return 0;
  const tx = Math.floor(x / T), tz = Math.floor(z / T);
  if (tx < 0 || tz < 0) return 0;
  const k = tz * 100000 + tx;
  let r = cache.get(k);
  if (!r) { r = new Uint8Array(T * T * WORLD_H); gen.generateRegion(tx * T, tz * T, T, T, r); cache.set(k, r); }
  return r[(x - tx * T) + (z - tz * T) * T + y * T * T];
}
const bl = (x: number, y: number, z: number) => block(Math.floor(x), Math.floor(y), Math.floor(z));

let errors = 0, warns = 0;
let ownedIds = new Set<string>();
let owned = true;
const err = (ctx: string, msg: string) => { if (owned) { errors++; console.log(`ERROR ${ctx}: ${msg}`); } else { warns++; console.log(`warn  ${ctx}: ${msg} (pre-existing content)`); } };
const warn = (ctx: string, msg: string) => { warns++; console.log(`warn  ${ctx}: ${msg}`); };

const ROADISH = new Set<number>([B.ASPHALT, B.LINE_WHITE, B.LINE_YELLOW, B.SIDEWALK, B.RUNWAY, B.CONCRETE, B.GRAVEL]);

function standable(p: V3): string | null {
  const [x, y, z] = p;
  const by = Math.floor(y + 0.01);
  const floor = bl(x, by - 1, z), feet = bl(x, by, z), head = bl(x, by + 1, z);
  if (!isSolid(floor) || isWater(floor)) return `no floor under (${x},${y},${z}) [${floor}]`;
  if (isSolid(feet) || isSolid(head)) return `blocked at (${x},${y},${z}) feet=${feet} head=${head}`;
  if (isWater(feet)) return `in water at (${x},${y},${z})`;
  return null;
}
function carSpot(p: V3, big = false): string | null {
  const [x, y, z] = p;
  const by = Math.floor(y + 0.01);
  const floor = bl(x, by - 1, z);
  if (!ROADISH.has(floor)) return `not road-ish at (${x},${y},${z}) floor block ${floor}`;
  const r = big ? 2 : 1;
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
    const f = bl(x + dx, by - 1, z + dz);
    if (!isSolid(f) || isWater(f)) return `footprint without floor at (${x + dx},${z + dz})`;
    if (isSolid(bl(x + dx, by, z + dz)) || isSolid(bl(x + dx, by + 1, z + dz))) return `footprint blocked at (${x + dx},${z + dz})`;
  }
  return null;
}
function boatSpot(p: V3, r = 3): string | null {
  const [x, , z] = p;
  for (const dx of [-r, 0, r]) for (const dz of [-r, 0, r]) {
    if (!isWater(bl(x + dx, 20, z + dz))) return `no water at y=20 (${x + dx},${z + dz})`;
    if (isSolid(bl(x + dx, 21, z + dz)) || isSolid(bl(x + dx, 22, z + dz))) return `solid above water (${x + dx},${z + dz}) (bridge/pier?)`;
  }
  return null;
}
function boatLeg(a: V3, b: V3): string | null {
  const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
  const n = Math.ceil(len / 2);
  const nx = (b[2] - a[2]) / (len || 1), nz = -(b[0] - a[0]) / (len || 1);
  for (let i = 0; i <= n; i++) {
    const x = a[0] + ((b[0] - a[0]) * i) / n, z = a[2] + ((b[2] - a[2]) * i) / n;
    for (const o of [-2, 0, 2]) {
      const px = x + nx * o, pz = z + nz * o;
      if (!isWater(bl(px, 20, pz)) || isSolid(bl(px, 21, pz))) return `leg (${a[0]},${a[2]})→(${b[0]},${b[2]}) blocked near (${px.toFixed(0)},${pz.toFixed(0)})`;
    }
  }
  return null;
}
function suggest(p: V3, f: (q: V3) => string | null): string {
  for (let r = 1; r <= 16; r++) {
    let best: V3 | null = null, bd = 1e9;
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const q: V3 = [Math.floor(p[0]) + dx + 0.5, p[1], Math.floor(p[2]) + dz + 0.5];
      const d = dx * dx + dz * dz;
      if (d < bd && f(q) === null) { bd = d; best = q; }
    }
    if (best) return ` → nearest valid [${best[0]}, ${best[1]}, ${best[2]}]`;
  }
  return '';
}
let curFn: ((q: V3) => string | null) | null = null;
const chk = (ctx: string, what: string, r: string | null, p?: V3, f?: (q: V3) => string | null) => { if (r) err(ctx, `${what}: ${r}${p && f ? suggest(p, f) : ''}`); };
void curFn;

// ───────────────────────────────────────────────────────────── activities
function isBoatModel(m: string) { return m === 'boat'; }

function checkSpawn(ctx: string, sp: SpawnDef, anchorKeys: Set<string>) {
  switch (sp.kind) {
    case 'vehicle':
      if (isBoatModel(sp.model)) { lastBoat.set(ctx.split('/')[0], sp.pos); chk(ctx, `boat spawn ${sp.id}`, boatSpot(sp.pos), sp.pos, (q) => boatSpot(q)); }
      else { const big = sp.model === 'van' || sp.model === 'pickup'; chk(ctx, `car spawn ${sp.id}`, carSpot(sp.pos, big), sp.pos, (q) => carSpot(q, big)); if (LEO && !sp.perPlayer) chk(ctx, `car spawn ${sp.id} lane`, laneCheck(sp.pos, sp.yaw)); }
      break;
    case 'object': chk(ctx, `object ${sp.id}`, standable(sp.pos), sp.pos, standable); break;
    case 'guard': sp.patrol.forEach((p, i) => chk(ctx, `guard ${sp.id} patrol ${i}`, standable(p), p, standable)); break;
    case 'npc': chk(ctx, `npc ${sp.id}`, standable(sp.pos), sp.pos, standable); break;
    case 'door': if (!anchorKeys.has(sp.door)) err(ctx, `door ${sp.id}: unknown door anchor '${sp.door}'`); break;
  }
}

function checkActivity(a: ActivityDef) {
  const ctx = a.id;
  const anchorKeys = new Set(worldAnchors().map((x) => x.key));
  if (!CONTACTS[a.giver] && !EXTRA_CONTACTS[a.giver]) err(ctx, `unknown giver '${a.giver}'`);
  chk(ctx, 'start', standable(a.start), a.start, standable);
  a.startSpots.forEach((s, i) => chk(ctx, `startSpot ${i}`, standable(s), s, standable));
  if (a.startSpots.length < 4) err(ctx, 'needs 4 startSpots');
  for (const r of a.unlock.requires ?? []) if (!ACTIVITY_BY_ID[r]) err(ctx, `unlock requires unknown '${r}'`);
  for (const u of a.rewards.unlocks ?? []) if (!ACTIVITY_BY_ID[u]) err(ctx, `reward unlocks unknown '${u}'`);
  for (const p of a.preps ?? []) { if (!ACTIVITY_BY_ID[p]) err(ctx, `unknown prep '${p}'`); else if (ACTIVITY_BY_ID[p].kind !== 'heist_prep') err(ctx, `prep '${p}' is not a heist_prep`); }
  if (a.rewards.cash.length !== 4) err(ctx, 'rewards.cash length != 4');
  if (a.kind === 'heist' && !a.heist) err(ctx, 'heist without heist config');
  if (a.kind === 'heist' && (!a.preps || a.preps.length < 4 || a.preps.length > 6)) err(ctx, 'heist needs 4-6 setups');
  if (a.kind === 'heist' && a.heist) checkHeistPlan(a);
  if (a.kind === 'heist_prep') {
    const h = a.prepFor ? ACTIVITY_BY_ID[a.prepFor] : undefined;
    if (!h || h.kind !== 'heist') err(ctx, `prepFor '${a.prepFor}' is not a heist`);
    else if (!h.heist?.setups.some((x) => x.prep === a.id)) err(ctx, `not listed in ${h.id}.heist.setups`);
    else checkConds(a, h);
    const cs = a.stages.filter((s) => s.cutscene).map((s) => s.cutscene!);
    if (cs.length < 2) err(ctx, 'setup needs an intro and an outro cutscene');
  }
  if (a.kind === 'minigame' && !a.race && !a.minigame) err(ctx, 'minigame needs race or minigame config');
  if (a.notes.length < 2) warn(ctx, 'few notes');
  const stageIds = new Set<string>();
  const spawned = new Map<string, SpawnDef>(); // id -> def (accumulated in stage order, for reference checks)
  let hasRaceBoat = a.race?.vehicleModel === 'boat';
  for (const s of a.stages) {
    if (stageIds.has(s.id)) err(ctx, `duplicate stage id ${s.id}`);
    stageIds.add(s.id);
    checkStage(ctx, a, s, spawned, anchorKeys, hasRaceBoat);
  }
  if (a.kind === 'mission' || a.kind === 'heist_prep') {
    // at least one checkpoint stage after the first, for retries
    if (a.kind === 'mission' && a.stages.filter((s) => s.checkpoint).length < 1) warn(ctx, 'no checkpoints');
  }
  if (a.kind === 'heist') {
    const has = (ap: string) => a.stages.filter((s) => { const w = s.when?.approach; return Array.isArray(w) ? w.includes(ap as never) : w === ap; }).length;
    const quiet = has('quiet'), loud = has('loud');
    if (a.heist!.approaches.includes('con') && !has('con')) err(ctx, 'heist offers con but has no con stages');
    const sc = new Set<string>();
    for (const s of a.stages) if (s.cutscene) sc.add(s.cutscene);
    if (sc.size < 2) err(ctx, 'heist needs intro and outro cutscenes');
    const realStages = a.stages.filter((s) => !s.cutscene || s.objectives.some((o) => o.type !== 'wait')).length;
    if (realStages < 8) err(ctx, `finale only has ${realStages} playable stages`);
    if (!quiet || !loud) err(ctx, 'heist needs distinct quiet and loud stages');
    if (!a.heist!.baseTake) err(ctx, 'no baseTake');
  }
}

function checkHeistPlan(a: ActivityDef) {
  const h = a.heist!;
  const ids = new Set(h.setups.map((x) => x.prep));
  for (const p of a.preps ?? []) if (!ids.has(p)) err(a.id, `prep ${p} missing from heist.setups`);
  for (const x of h.setups) {
    if (!(a.preps ?? []).includes(x.prep)) err(a.id, `setup ${x.prep} missing from preps`);
    if (x.choice && x.choice.options.length < 2) err(a.id, `setup ${x.prep}: choice needs 2+ options`);
  }
  if (!h.setups.some((x) => x.choice)) err(a.id, 'heist needs at least one setup with a choice');
  if (!h.setups.some((x) => x.optional)) err(a.id, 'heist needs at least one optional setup');
  for (const [ap, need] of Object.entries(h.approachNeeds ?? {})) if (!ids.has(need!)) err(a.id, `approach ${ap} needs unknown setup ${need}`);
  if (h.hardLives.length !== 4) err(a.id, 'hardLives length != 4');
  for (const e of h.equipment) if (e.approach && !h.approaches.includes(e.approach)) err(a.id, `equipment ${e.id}: approach ${e.approach} not offered`);
  checkConds(a, a);
  // every choice option must lead somewhere in the finale
  for (const x of h.setups) if (x.choice) for (const o of x.choice.options) {
    const used = a.stages.some((s) => s.when?.choice?.[x.choice!.key] === o.id || (s.spawn ?? []).some((sp) => sp.if?.choice?.[x.choice!.key] === o.id));
    if (!used) err(a.id, `choice ${x.choice.key}=${o.id} changes nothing in the finale`);
  }
}
/** `when`/`if` conditions must reference real setups, choice keys and options of the heist */
function checkConds(a: ActivityDef, heist: ActivityDef) {
  const setups = heist.heist?.setups ?? [];
  const chk1 = (ctx: string, c: Cond | undefined) => {
    if (!c) return;
    for (const k of ['setup', 'noSetup'] as const) if (c[k] && !setups.some((x) => x.prep === c[k])) err(ctx, `${k} '${c[k]}' is not a setup of ${heist.id}`);
    for (const [k, v] of Object.entries(c.choice ?? {})) {
      const ch = setups.find((x) => x.choice?.key === k)?.choice;
      if (!ch) err(ctx, `choice key '${k}' unknown for ${heist.id}`);
      else if (!ch.options.some((o) => o.id === v)) err(ctx, `choice ${k}=${v}: unknown option`);
    }
  };
  for (const s of a.stages) { chk1(`${a.id}/${s.id}`, s.when); for (const sp of s.spawn ?? []) chk1(`${a.id}/${s.id}/${sp.id}`, sp.if); for (const w of s.waves ?? []) for (const sp of w.spawn) chk1(`${a.id}/${s.id}/${sp.id}`, sp.if); }
}

const lastBoat = new Map<string, V3>();
function checkStage(ctx0: string, a: ActivityDef, s: StageDef, spawned: Map<string, SpawnDef>, anchorKeys: Set<string>, raceBoat: boolean) {
  const ctx = `${ctx0}/${s.id}`;
  if (s.cutscene && !CUTSCENES[s.cutscene]) err(ctx, `unknown cutscene '${s.cutscene}'`);
  if (s.timeLimit && s.timeLimit.length !== 4) err(ctx, 'timeLimit length != 4');
  if (s.timeLimit && !s.fail?.some((f) => f.type === 'timer')) warn(ctx, 'timeLimit without timer fail');
  if (s.fail?.some((f) => f.type === 'timer') && !s.timeLimit) err(ctx, 'timer fail without timeLimit');
  if (s.checkpoint) {
    if (!s.respawn || s.respawn.length < 4) err(ctx, 'checkpoint stage needs 4 respawn spots');
  }
  s.respawn?.forEach((p, i) => chk(ctx, `respawn ${i}`, standable(p), p, standable));
  const own = new Set<string>();
  for (const sp of s.spawn ?? []) {
    if (spawned.has(sp.id)) err(ctx, `duplicate spawn id ${sp.id}`);
    spawned.set(sp.id, sp); own.add(sp.id);
    checkSpawn(ctx, sp, anchorKeys);
    if ('minParty' in sp && sp.minParty && (sp.minParty < 2 || sp.minParty > 4)) err(ctx, `${sp.id}: minParty out of range`);
    if (sp.kind === 'object' && ['loot', 'safe'].includes(sp.obj) && !sp.value) warn(ctx, `${sp.id}: loot without value`);
  }
  for (const w of s.waves ?? []) for (const sp of w.spawn) {
    if (spawned.has(sp.id)) err(ctx, `duplicate wave spawn id ${sp.id}`);
    spawned.set(sp.id, sp);
    checkSpawn(`${ctx}/wave`, sp, anchorKeys);
    if (sp.kind !== 'guard') warn(ctx, `wave ${sp.id} is not a guard`);
  }
  for (const d of s.despawn ?? []) if (!spawned.has(d)) err(ctx, `despawn of unknown '${d}'`);
  const doorIds = new Set([...spawned.values()].filter((x) => x.kind === 'door').map((x) => x.id));
  for (const k of Object.keys(s.onEnter?.doors ?? {})) if (!doorIds.has(k)) err(ctx, `onEnter.doors refers to unknown door spawn '${k}'`);
  const objIds = new Set<string>();
  const avail = (n: number, targets: string[]) => targets.filter((t) => { const sp = spawned.get(t); return sp && (!('minParty' in sp) || !sp.minParty || sp.minParty <= n); });
  for (const o of s.objectives) {
    if (objIds.has(o.id)) err(ctx, `duplicate objective id ${o.id}`);
    objIds.add(o.id);
    switch (o.type) {
      case 'reach': {
        if (o.vehicle) {
          const sp = spawned.get(o.vehicle);
          if (!sp || sp.kind !== 'vehicle') err(ctx, `reach ${o.id}: vehicle '${o.vehicle}' not spawned before`);
          else if (isBoatModel(sp.model)) { chk(ctx, `reach ${o.id} (boat)`, boatSpot(o.pos, 1), o.pos, (q) => boatSpot(q, 1)); const prev = lastBoat.get(a.id); if (prev) chk(ctx, `boat leg to ${o.id}`, boatLeg(prev, o.pos)); lastBoat.set(a.id, o.pos); }
          else chk(ctx, `reach ${o.id} (vehicle)`, carSpot(o.pos), o.pos, (q) => carSpot(q));
        } else if (isWater(bl(o.pos[0], 20, o.pos[2]))) { chk(ctx, `reach ${o.id} (water)`, boatSpot(o.pos, Math.min(4, Math.floor(o.r / 2))), o.pos, (q) => boatSpot(q, Math.min(4, Math.floor(o.r / 2)))); const prev = lastBoat.get(a.id); if (prev) chk(ctx, `boat leg to ${o.id}`, boatLeg(prev, o.pos)); lastBoat.set(a.id, o.pos); }
        else chk(ctx, `reach ${o.id}`, standable(o.pos), o.pos, standable);
        break;
      }
      case 'enter_vehicle':
        for (const v of o.vehicles) { const sp = spawned.get(v); if (!sp || sp.kind !== 'vehicle') err(ctx, `enter_vehicle ${o.id}: '${v}' not a spawned vehicle`); }
        break;
      case 'interact': case 'shoot': {
        for (const t of o.targets) { const sp = spawned.get(t); if (!sp || sp.kind !== 'object') err(ctx, `${o.type} ${o.id}: target '${t}' is not a spawned object`); else if (o.type === 'shoot' && sp.obj !== 'target') err(ctx, `shoot ${o.id}: '${t}' is not obj 'target'`); }
        const count = o.type === 'shoot' ? o.count : o.count;
        if (o.type === 'shoot' && o.count.length !== 4) err(ctx, `${o.id}: count length != 4`);
        if (o.type === 'interact' && o.count && o.count.length !== 4) err(ctx, `${o.id}: count length != 4`);
        for (let n = 1; n <= 4; n++) {
          const av = avail(n, o.targets).length;
          if (av === 0) err(ctx, `${o.id}: no targets available for party size ${n}`);
          if (count && count[n - 1] > av) err(ctx, `${o.id}: needs ${count[n - 1]} but only ${av} targets for party size ${n}`);
        }
        if (o.type === 'interact' && o.simultaneous) {
          if (o.targets.length < 2) err(ctx, `${o.id}: simultaneous needs 2+ targets`);
          if (o.simultaneous.soloWindow < o.simultaneous.window) err(ctx, `${o.id}: soloWindow < window`);
        }
        break;
      }
      case 'checkpoints': {
        const boat = raceBoat || [...spawned.values()].some((x) => x.kind === 'vehicle' && x.perPlayer && isBoatModel(x.model));
        o.points.forEach((p, i) => chk(ctx, `checkpoint ${i}`, boat ? boatSpot(p, Math.min(4, Math.floor(o.r / 2))) : carSpot(p), p, (q) => (boat ? boatSpot(q, Math.min(4, Math.floor(o.r / 2))) : carSpot(q))));
        if (boat) for (let i = 0; i < o.points.length; i++) chk(ctx, `boat leg ${i}`, boatLeg(o.points[i], o.points[(i + 1) % o.points.length]));
        if (boat && a.race) chk(ctx, 'boat grid→cp0', boatLeg(a.race.startGrid[0], o.points[0]));
        if (o.laps < 1) err(ctx, 'laps < 1');
        // Leonia: the chain must be drivable on real roads (no detours over 3x the straight line)
        if (LEO && !boat) {
          const chain = [...(a.race ? [a.race.startGrid[0]] : []), ...o.points, ...(o.laps > 1 ? [o.points[0]] : [])];
          for (let i = 0; i + 1 < chain.length; i++) {
            const d = roadDist(chain[i], chain[i + 1]), st = Math.hypot(chain[i + 1][0] - chain[i][0], chain[i + 1][2] - chain[i][2]);
            if (d === null) err(ctx, `checkpoint ${i}→${i + 1}: no road route`);
            else if (d > Math.max(3 * st, st + 300)) err(ctx, `checkpoint ${i}→${i + 1}: route ${d.toFixed(0)} m for ${st.toFixed(0)} m straight`);
          }
        }
        break;
      }
      case 'defend':
        chk(ctx, `defend ${o.id}`, standable(o.pos), o.pos, standable);
        if (o.seconds.length !== 4) err(ctx, `${o.id}: seconds length != 4`);
        if (o.r < 2) err(ctx, `${o.id}: zone radius < 2`);
        break;
      case 'wait': case 'lose_wanted': break;
    }
  }
  for (const f of s.fail ?? []) if (f.type === 'vehicle_destroyed' && !spawned.get(f.vehicle)) err(ctx, `fail vehicle_destroyed: '${f.vehicle}' unknown`);
  if (s.objectives.length === 0) err(ctx, 'no objectives');
  void own;
}

function checkRace(a: ActivityDef) {
  if (!a.race) return;
  const boat = a.race.vehicleModel === 'boat';
  a.race.startGrid.forEach((g, i) => chk(a.id, `race grid ${i}`, boat ? boatSpot(g, 2) : carSpot(g), g, (q) => (boat ? boatSpot(q, 2) : carSpot(q))));
  if (LEO && !boat) a.race.startGrid.forEach((g, i) => chk(a.id, `race grid ${i} lane`, laneCheck(g, null)));
  if (a.race.startGrid.length < 4) err(a.id, 'race needs 4 grid slots');
  // feasibility: gold par must not need more than 70% of top speed averaged over the whole run
  const cpo = a.stages.flatMap((s) => s.objectives).find((o) => o.type === 'checkpoints');
  if (cpo && cpo.type === 'checkpoints') {
    const pts = cpo.points;
    let lap = 0;
    for (let i = 0; i < pts.length; i++) { const b = pts[(i + 1) % pts.length]; lap += Math.hypot(b[0] - pts[i][0], b[2] - pts[i][2]); }
    const total = lap * cpo.laps, vmax = VEHICLES[a.race.vehicleModel as keyof typeof VEHICLES].maxSpeed;
    const avg = total / a.race.parTimes[0];
    console.log(`  race ${a.id}: ${Math.round(lap)} m/lap x ${cpo.laps} = ${Math.round(total)} m; gold avg ${avg.toFixed(1)} m/s (${Math.round((avg / vmax) * 100)}% of top speed); time limit ${a.stages[0].timeLimit?.[0]} s`);
    if (avg > vmax * 0.62) err(a.id, `gold par needs ${Math.round((avg / vmax) * 100)}% of top speed - too tight (the shipped Downtown Sprint is 52%)`);
    if (avg < vmax * 0.3) warn(a.id, 'gold par looks very loose');
  }
  const pt = a.race.parTimes;
  if (!(pt[0] < pt[1] && pt[1] < pt[2])) err(a.id, 'parTimes must be ascending');
}

// ───────────────────────────────────────────────────────────── cutscenes
function checkCutscene(id: string, strict: boolean) {
  owned = strict;
  const c = CUTSCENES[id];
  if (!c) { err(id, 'missing'); return; }
  if (c.id !== id) err(id, `cutscene.id '${c.id}' does not match key`);
  if (c.shots.length < 2 || c.shots.length > 4) { if (strict) err(id, `${c.shots.length} shots (want 2-4)`); }
  c.endSpots.forEach((p, i) => chk(`cs:${id}`, `endSpot ${i}`, standable(p), p, standable));
  if (c.endSpots.length < 4) err(`cs:${id}`, 'needs 4 endSpots');
  for (const a of c.actors) { chk(`cs:${id}`, `actor ${a.id}`, standable(a.pos), a.pos, standable); if (a.walkTo) chk(`cs:${id}`, `actor ${a.id} walkTo`, standable(a.walkTo)); }
  c.shots.forEach((s, i) => {
    for (const k of ['from', 'to'] as const) {
      const p = s.cam[k];
      if (isSolid(bl(p[0], p[1], p[2]))) err(`cs:${id}`, `shot ${i} cam.${k} inside a solid block (${p.join(',')})`);
    }
    // Leonia: the whole camera move stays out of buildings and foliage (the client interpolates from → to)
    if (LEO) for (let j = 1; j < 16; j++) {
      const f = j / 16, a = s.cam.from, b = s.cam.to;
      const q = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
      const id2 = bl(q[0], q[1], q[2]);
      if (isSolid(id2) || id2 === B.LEAVES || id2 === B.PALM_LEAVES || id2 === B.MANGROVE_LEAVES) { err(`cs:${id}`, `shot ${i} camera path passes through block ${id2} at (${q.map((n) => n.toFixed(0)).join(',')})`); break; }
    }
    if (s.dur <= 0) err(`cs:${id}`, `shot ${i} dur <= 0`);
  });
}

// ───────────────────────────────────────────────────────────── main
const mine = [...STORY_ACTIVITIES, ...SUNDIAL_ACTIVITIES, ...HEISTS_ACTIVITIES, ...MINIGAMES_ACTIVITIES];
ownedIds = new Set(mine.map((a) => a.id));
const ids = new Set<string>();
for (const a of ACTIVITIES) { if (ids.has(a.id)) { owned = true; err(a.id, 'duplicate activity id'); } ids.add(a.id); }

for (const a of ACTIVITIES) {
  owned = ownedIds.has(a.id);
  checkActivity(a);
  checkRace(a);
  // all referenced cutscenes were already checked per stage
}
// cutscene geometry
for (const id of Object.keys(CUTSCENES)) checkCutscene(id, id in EXTRA_CUTSCENES);
owned = true;
// every cutscene of mine is used
const usedCs = new Set(ACTIVITIES.flatMap((a) => a.stages.map((s) => s.cutscene).filter(Boolean) as string[]));
for (const id of Object.keys(EXTRA_CUTSCENES)) if (!usedCs.has(id)) warn(`cs:${id}`, 'not referenced by any stage');

// unlock graph: everything mine reachable from story_1 / initial unlocks
{
  const unlocked = new Set<string>(['story_1']);
  let changed = true;
  const completed = new Set<string>();
  while (changed) {
    changed = false;
    for (const a of ACTIVITIES) {
      const ok = unlocked.has(a.id) || ((a.unlock.requires ?? []).every((r) => completed.has(r)) && !a.unlock.rep) || ((a.unlock.requires ?? []).length === 0 && !a.unlock.rep) || ((a.unlock.requires ?? []).every((r) => completed.has(r)));
      if (ok && !completed.has(a.id)) { completed.add(a.id); for (const u of a.rewards.unlocks ?? []) unlocked.add(u); changed = true; }
    }
  }
  for (const a of mine) if (!completed.has(a.id)) { owned = true; err(a.id, 'not reachable via the unlock chain'); }
}

// shops, POIs
owned = true;
for (const [sid, shop] of Object.entries(SHOPS)) {
  const seen = new Set<string>();
  for (const it of shop.items) {
    if (seen.has(it.id)) err(`shop:${sid}`, `duplicate item id ${it.id}`);
    seen.add(it.id);
    if (it.price < 0) err(`shop:${sid}`, `${it.id}: negative price`);
    const g = it.effect.give;
    if (g?.startsWith('weapon:') && !WEAPONS[g.slice(7)]) err(`shop:${sid}`, `${it.id}: unknown weapon ${g}`);
    if (g?.startsWith('ammo:') && !WEAPONS[g.slice(5)]) err(`shop:${sid}`, `${it.id}: unknown ammo ${g}`);
  }
}


// Leonia prefab placements: a clean pad on dry land, no car road / rail through it, entrance on the street
if (LEO && graph) {
  for (const p of POIS) {
    const f = poiFrame(p, 'leonia');
    const ctx = `place:${p.id}`;
    const rect = frameRect(f, PAD.x0, PAD.z0, PAD.x1, PAD.z1);
    let water = 0;
    for (let z = Math.floor(rect[1]); z < rect[3]; z += 2) for (let x = Math.floor(rect[0]); x < rect[2]; x += 2) if (isWater(bl(x, 20, z))) water++; // sea level (the plaza fountain at y 21+ is part of the prefab)
    if (water) err(ctx, `${water} water samples inside the pad`);
    for (const e of graph.edgesNear((rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2, 40)) {
      if (!isCarRoad(graph.eCls[e]) && !isRail(graph.eCls[e])) continue;
      const p0 = graph.eP0[e], n = graph.eN[e], hw = graph.eWidth[e] / 2;
      for (let k = 0; k < n; k++) {
        const x = graph.px[p0 + k], z = graph.pz[p0 + k];
        const dx = Math.max(rect[0] - x, 0, x - rect[2]), dz = Math.max(rect[1] - z, 0, z - rect[3]);
        if (Math.hypot(dx, dz) < hw - 0.5) { err(ctx, `${isRail(graph.eCls[e]) ? 'rail' : 'road'} ${graph.name(e) || '(unnamed)'} crosses the pad`); break; }
      }
    }
    // from the entrance outward: the street must start within 8 m
    const [fx, fz] = frameFront(f), [sx, sz] = frameToWorld(f, 24, 4.5);
    let road = -1;
    for (let k = 0; k < 12 && road < 0; k++) { const id = bl(sx + fx * k, 21, sz + fz * k); if (id === B.ASPHALT || id === B.LINE_WHITE || id === B.LINE_YELLOW) road = k; }
    if (road < 0 || road > 8) err(ctx, `no street within 8 m of the entrance (${road})`);
    console.log(`  ${p.id.padEnd(11)} frame (${f.ox}, ${f.oz}) rot ${f.rot}  ${p.leonia.street}, ${p.leonia.district}; street ${road} m from the pad edge`);
  }
}

const lotSeen = new Map<string, string>();
for (const p of POIS) {
  const k = p.lot.join(',');
  if (lotSeen.has(k)) err(`poi:${p.id}`, `lot ${k} also used by ${lotSeen.get(k)}`);
  lotSeen.set(k, p.id);
  if (!PREFABS[p.prefab]) err(`poi:${p.id}`, `unknown prefab ${p.prefab}`);
}
for (const a of worldAnchors()) {
  const poi = POIS.find((p) => p.id === a.poi)!;
  const isNew = !['safehouse', 'plaza', 'garage', 'store', 'diner', 'club', 'police', 'warehouse', 'office', 'jewelers'].includes(poi.id);
  owned = isNew;
  const ctx = `poi:${a.key}`;
  if (a.kind === 'door' || a.kind === 'marker' && false) continue;
  if (a.kind === 'door') continue;
  // anchors on cell corners: fine if one of the touching cells is standable (rotated placements flip corners)
  const near = [[0, 0], [-0.3, 0], [0.3, 0], [0, -0.3], [0, 0.3], [-0.3, -0.3], [0.3, 0.3], [-0.3, 0.3], [0.3, -0.3]].map(([dx, dz]) => standable([a.wx + dx, a.wy, a.wz + dz]));
  chk(ctx, `anchor ${a.kind}`, near.some((r) => r === null) ? null : near[0]);
  if (a.rule?.startsWith('shop:') && !SHOPS[a.rule.slice(5)] && a.rule !== 'shop:dealer') err(ctx, `rule ${a.rule}: unknown shop`);
}
owned = true;

console.log(`\nvalidated ${ACTIVITIES.length} activities (${mine.length} new), ${Object.keys(CUTSCENES).length} cutscenes (${Object.keys(EXTRA_CUTSCENES).length} new), ${POIS.length} POIs, ${Object.keys(SHOPS).length} shops`);
console.log(`${errors} error(s), ${warns} warning(s)`);
process.exit(errors ? 1 : 0);

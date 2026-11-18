/**
 * Fetch + cache OpenStreetMap data for the Leonia stage-1 area via the Overpass API.
 *   npx tsx scripts/osm/fetch.ts            (resumable: cached tiles are skipped)
 * Requests are strictly sequential with a pause between them, retries back off
 * exponentially and rotate mirrors. Every response is written verbatim to
 * .cache/osm/raw/ (untrusted data: parsed as JSON only, never executed).
 * Data © OpenStreetMap contributors, ODbL 1.0.
 */
import { mkdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BBOX, FETCH_STEP, ENDPOINTS, USER_AGENT, RAW_DIR } from './config.ts';

mkdirSync(RAW_DIR, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function tileQuery(s: number, w: number, n: number, e: number) {
  return `[out:json][timeout:600][maxsize:1073741824][bbox:${s},${w},${n},${e}];
(
  way[building]; way["building:part"];
  way[highway]; way[railway]; way[aeroway]; way[waterway];
  way[natural]; way[landuse]; way[leisure]; way[amenity]; way[man_made];
  way[tourism]; way[golf]; way[place]; way[bridge]; way[barrier=fence];
  node[amenity]; node[shop]; node[tourism]; node[leisure]; node[natural=tree];
  node[highway~"^(traffic_signals|bus_stop|crossing|street_lamp|stop)$"];
  node[railway~"^(station|halt|level_crossing)$"]; node[public_transport=platform];
  node[man_made~"^(lighthouse|tower|water_tower|mast)$"];
);
out geom qt;`;
}
function relQuery() {
  const { s, w, n, e } = BBOX;
  return `[out:json][timeout:900][maxsize:1073741824][bbox:${s},${w},${n},${e}];
(
  rel[type=multipolygon][building]; rel[type=multipolygon][landuse]; rel[type=multipolygon][leisure];
  rel[type=multipolygon][natural]; rel[type=multipolygon][water]; rel[type=multipolygon][waterway];
  rel[type=multipolygon][amenity]; rel[type=multipolygon][aeroway]; rel[type=multipolygon][place];
  rel[type=multipolygon][man_made]; rel[type=multipolygon][golf]; rel[type=multipolygon][tourism];
  rel[type=building];
);
out geom qt;`;
}

async function fetchTo(file: string, query: string) {
  if (existsSync(file) && statSync(file).size > 64) return 'cached';
  let delay = 5000;
  for (let attempt = 0; attempt < 10; attempt++) {
    const ep = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      const res = await fetch(ep, {
        method: 'POST',
        headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(15 * 60_000),
      });
      const text = await res.text();
      if (res.ok && text.startsWith('{') && !text.includes('"remark": "runtime error')) {
        JSON.parse(text); // validate only
        writeFileSync(file, text);
        return `ok ${(text.length / 1e6).toFixed(1)} MB via ${new URL(ep).host}`;
      }
      console.warn(`  ${res.status} from ${new URL(ep).host}: ${text.slice(0, 160).replace(/\s+/g, ' ')}`);
    } catch (err) {
      console.warn(`  error from ${new URL(ep).host}: ${(err as Error).message}`);
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 120_000);
  }
  throw new Error('giving up on ' + file);
}

const tiles: [number, number][] = [];
const ns = Math.round((BBOX.n - BBOX.s) / FETCH_STEP), nw = Math.round((BBOX.e - BBOX.w) / FETCH_STEP);
// --gaps: only tiles not fully inside the BBBike "Miami" extract (lon -80.32..-80.05, lat 25.65..25.86)
const gapsOnly = process.argv.includes('--gaps');
const covered = (s: number, w: number, n: number, e: number) => s >= 25.65 && n <= 25.86 + 1e-9 && w >= -80.32 - 1e-9 && e <= -80.05;
for (let j = 0; j < ns; j++) for (let i = 0; i < nw; i++) {
  const s = BBOX.s + j * FETCH_STEP, w = BBOX.w + i * FETCH_STEP;
  if (gapsOnly && covered(s, w, s + FETCH_STEP, w + FETCH_STEP)) continue;
  tiles.push([i, j]);
}
// downtown first so the first district is usable early
const cI = Math.floor((-80.19 - BBOX.w) / FETCH_STEP), cJ = Math.floor((25.77 - BBOX.s) / FETCH_STEP);
tiles.sort((a, b) => Math.hypot(a[0] - cI, a[1] - cJ) - Math.hypot(b[0] - cI, b[1] - cJ));

const t0 = Date.now();
let k = 0;
for (const [i, j] of tiles) {
  k++;
  const s = +(BBOX.s + j * FETCH_STEP).toFixed(4), w = +(BBOX.w + i * FETCH_STEP).toFixed(4);
  const n = +(s + FETCH_STEP).toFixed(4), e = +(w + FETCH_STEP).toFixed(4);
  const file = join(RAW_DIR, `t_${i}_${j}.json`);
  const r = await fetchTo(file, tileQuery(s, w, n, e));
  console.log(`[${k}/${tiles.length}] tile ${i},${j} (${s},${w}) ${r}  ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  if (r !== 'cached') await sleep(1500);
}
try { console.log('relations:', await fetchTo(join(RAW_DIR, 'relations.json'), relQuery())); }
catch (e) { console.warn('relations query failed (PBF relations will be used):', (e as Error).message); }
console.log('done in', ((Date.now() - t0) / 60000).toFixed(1), 'min');

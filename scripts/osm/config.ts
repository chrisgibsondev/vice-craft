/**
 * Leonia stage-1 build configuration: the real-world bbox, the local projection and
 * where raw downloads / built tiles live. Raw OSM responses are untrusted data and are
 * kept in their own cache folder outside anything the client serves.
 */
import { resolve } from 'node:path';
import { LEONIA_PROJ } from '../../packages/shared/src/world/leonia/proj.ts';

export const ROOT = resolve(import.meta.dirname, '../..');
/** raw Overpass responses (never served, never executed) */
export const RAW_DIR = resolve(ROOT, '.cache/osm/raw');
/** intermediate extracted features */
export const WORK_DIR = resolve(ROOT, '.cache/osm/work');
/** built binary tiles, fetched statically by the client and read from disk by the server */
export const OUT_DIR = resolve(ROOT, 'apps/client/public/world/leonia');

export const BBOX = { s: LEONIA_PROJ.latS, n: LEONIA_PROJ.latN, w: LEONIA_PROJ.lonW, e: LEONIA_PROJ.lonE };
/** fetch tile size in degrees */
export const FETCH_STEP = 0.02;
export const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
export const USER_AGENT = 'blockshore-osm-pipeline/0.1 (game world builder)';

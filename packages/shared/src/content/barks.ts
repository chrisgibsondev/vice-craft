/**
 * Street "barks": short original lines NPCs say out loud (speech bubbles, optional subtitles).
 *
 * The bank itself lives in barkLines.ts (pools keyed `${group}.${situation}`). Every line has a stable id
 * `${group}.${situation}#NN` (NN = 1-based index in its pool; pools are append-only). Recorded audio can be attached
 * later without touching code: put a clip URL into BARK_CLIPS keyed by that id and the client plays it.
 */
import { BARK_POOLS } from './barkLines.ts';

export type BarkGroup =
  | 'ped' | 'business' | 'tourist' | 'beach' | 'jogger' | 'worker' | 'elder' | 'student' | 'skater' | 'outdoor'
  | 'driver' | 'cop' | 'shop' | 'guard' | 'contact';

export type BarkSituation =
  | 'idle' | 'phone' | 'greet' | 'bump' | 'sprint' | 'sidewalk' | 'nearmiss' | 'gunfire' | 'crash' | 'siren' | 'weapon' | 'rain' | 'hit'
  | 'honk' | 'honk_ped' | 'jam' | 'cutoff' | 'carjack'
  | 'chase' | 'chase_veh' | 'warning' | 'wanted' | 'thanks' | 'alert';

export const BARKS = BARK_POOLS;

/** speaker caption shown in subtitles */
export const BARK_SPEAKER: Readonly<Record<BarkGroup, string>> = {
  ped: 'Pedestrian', business: 'Commuter', tourist: 'Tourist', beach: 'Beachgoer', jogger: 'Jogger', worker: 'Worker', elder: 'Local',
  student: 'Student', skater: 'Skater', outdoor: 'Local', driver: 'Driver', cop: 'Officer', shop: 'Shopkeeper', guard: 'Guard', contact: 'Contact',
};

/** flavoured civilians use their own pool for ~60% of picks and fall back to the generic `ped` pool for the rest */
const FLAVOURED = new Set<BarkGroup>(['business', 'tourist', 'beach', 'jogger', 'worker', 'elder', 'student', 'skater', 'outdoor']);
const FLAVOUR_SHARE = 0.6;

/**
 * Optional recorded audio, keyed by line id (e.g. 'tourist.idle#03' → '/audio/barks/tourist_idle_03.ogg').
 * Empty on purpose: attach clips here (or fill it from a generated manifest) and the client will play them.
 */
export const BARK_CLIPS: Record<string, string> = {};
export function barkClip(id: string): string | undefined { return BARK_CLIPS[id]; }

export function barkId(pool: string, index: number): string { return `${pool}#${String(index + 1).padStart(2, '0')}`; }
export function parseBarkId(id: string): { pool: string; group: BarkGroup; situation: BarkSituation; index: number } | null {
  const h = id.lastIndexOf('#');
  if (h < 0) return null;
  const pool = id.slice(0, h), index = Number(id.slice(h + 1)) - 1;
  const dot = pool.indexOf('.');
  if (dot < 0 || !Number.isInteger(index) || index < 0) return null;
  return { pool, group: pool.slice(0, dot) as BarkGroup, situation: pool.slice(dot + 1) as BarkSituation, index };
}
export function barkText(id: string): string | null {
  const p = parseBarkId(id);
  return p ? BARKS[p.pool]?.[p.index] ?? null : null;
}
export function barkGroupOf(id: string): BarkGroup | null { return parseBarkId(id)?.group ?? null; }
export function barkHasPool(group: BarkGroup, situation: BarkSituation): boolean {
  return !!BARKS[`${group}.${situation}`] || (FLAVOURED.has(group) && !!BARKS[`ped.${situation}`]);
}

/**
 * Pick a line id for (group, situation), avoiding ids in `avoid`. Returns null when no pool has the situation
 * (or every line is excluded). `rnd` is Math.random by default (tests pass a seeded one).
 */
export function pickBark(group: BarkGroup, situation: BarkSituation, avoid?: ReadonlySet<string> | readonly string[], rnd: () => number = Math.random): string | null {
  const own = BARKS[`${group}.${situation}`];
  const generic = FLAVOURED.has(group) ? BARKS[`ped.${situation}`] : undefined;
  const pools: { key: string; lines: readonly string[] }[] = [];
  if (own && generic) {
    pools.push({ key: `${group}.${situation}`, lines: own }, { key: `ped.${situation}`, lines: generic });
    if (rnd() >= FLAVOUR_SHARE) pools.reverse();
  } else if (own) pools.push({ key: `${group}.${situation}`, lines: own });
  else if (generic) pools.push({ key: `ped.${situation}`, lines: generic });
  const has = (id: string) => (avoid instanceof Set ? avoid.has(id) : !!avoid && (avoid as readonly string[]).includes(id));
  for (const p of pools) {
    const n = p.lines.length;
    const start = Math.floor(rnd() * n);
    for (let k = 0; k < n; k++) {
      const id = barkId(p.key, (start + k) % n);
      if (!has(id)) return id;
    }
  }
  return null;
}

/** map a server role string (+ static NPC label) to the voice group; null = does not speak (animals, unknown) */
export function barkRoleGroup(role: string, label?: string): BarkGroup | null {
  if (role === 'ped') return 'ped';
  if (role.startsWith('ped:')) {
    const k = role.slice(4);
    switch (k) {
      case 'business': case 'tourist': case 'beach': case 'jogger': case 'worker': case 'elder': case 'student': case 'skater': return k;
      case 'farmer': case 'fisher': case 'ranger': return 'outdoor';
      default: return 'ped';
    }
  }
  if (role === 'cop') return 'cop';
  if (role === 'guard') return 'guard';
  if (role.startsWith('animal:')) return null;
  if (role === 'static' || role === 'actor') {
    const l = label ?? '';
    if (l === 'officer') return 'cop';
    if (l.startsWith('contact') || l.startsWith('talk')) return 'contact';
    return 'shop';
  }
  return null;
}

export function allBarkIds(): string[] {
  const out: string[] = [];
  for (const [pool, lines] of Object.entries(BARKS)) for (let i = 0; i < lines.length; i++) out.push(barkId(pool, i));
  return out;
}

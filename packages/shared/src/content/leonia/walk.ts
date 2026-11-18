/**
 * Deterministic walk over authored content (activities + cutscenes) that visits every world
 * position (V3), heading (yaw) and time limit by a stable path such as
 * `story_1/stages/2/spawn/0/pos`. The Leonia position table (positions.gen.ts) is keyed by these
 * paths; scripts/leonia-content.ts writes it, apply.ts reads it. Arrays shared between several
 * places are visited once (first path wins) so a shared literal is only moved once.
 */
import type { V3 } from '../activityTypes.ts';

export type Visit =
  | { kind: 'v3'; path: string; value: V3; holder: unknown[] | Record<string, unknown>; key: string | number; ctx: unknown[] }
  | { kind: 'yaw'; path: string; value: number; holder: Record<string, unknown>; key: string; ctx: unknown[] };

const NOT_V3 = new Set(['parTimes', 'parScores', 'count', 'cash', 'seconds', 'timeLimit', 'bonus']);
const YAW = new Set(['yaw', 'startYaw', 'endYaw']);
const isV3 = (a: unknown): a is V3 => Array.isArray(a) && a.length === 3 && typeof a[0] === 'number' && typeof a[1] === 'number' && typeof a[2] === 'number';

/** walk roots in order; `cb` sees every position / yaw once */
export function walkContent(roots: [string, unknown][], cb: (v: Visit) => void) {
  const seen = new WeakSet<object>();
  const walk = (o: unknown, path: string, key: string, ctx: unknown[]) => {
    if (!o || typeof o !== 'object') return;
    if (seen.has(o)) return;
    seen.add(o);
    if (Array.isArray(o)) {
      o.forEach((v, i) => {
        if (isV3(v) && !NOT_V3.has(key)) { if (!seen.has(v)) { seen.add(v); cb({ kind: 'v3', path: `${path}/${i}`, value: v, holder: o, key: i, ctx }); } }
        else walk(v, `${path}/${i}`, key, ctx);
      });
      return;
    }
    const rec = o as Record<string, unknown>;
    const c2 = [...ctx, rec];
    for (const k of Object.keys(rec)) {
      const v = rec[k];
      if (YAW.has(k) && typeof v === 'number') cb({ kind: 'yaw', path: `${path}/${k}`, value: v, holder: rec, key: k, ctx: c2 });
      else if (isV3(v) && !NOT_V3.has(k)) { if (!seen.has(v)) { seen.add(v); cb({ kind: 'v3', path: `${path}/${k}`, value: v, holder: rec, key: k, ctx: c2 }); } }
      else walk(v, `${path}/${k}`, k, c2);
    }
  };
  for (const [name, root] of roots) walk(root, name, '', []);
}

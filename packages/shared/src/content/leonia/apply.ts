/**
 * Moves the authored content onto Leonia (real Miami) when that world is selected. The content
 * files stay authored in Palmara coordinates; positions.gen.ts (written by
 * scripts/leonia-content.ts from the tile data + road graph) holds the Leonia position of every
 * V3, heading and the re-timed limits / par times / race routes, keyed by walk path (walk.ts).
 * Place names in text are rewritten to the real districts and streets; fictional characters and
 * businesses keep their names.
 */
import { walkContent } from './walk.ts';
import { LEONIA_POS, LEONIA_YAW, LEONIA_SET } from './positions.gen.ts';

/** ordered place-name rewrites (Palmara → Leonia / real Miami) */
export const LEONIA_NAMES: [RegExp, string][] = [
  // lines whose geography changed shape, not just name
  [/Sunny Side Diner, two blocks east\./g, 'Sunny Side Diner, up NE 2nd Avenue.'],
  [/Hangar apron, south side of the field\./g, 'Hangar apron, north side of the field, off NW 36th Street.'],
  [/Solano Airfield, south apron\./g, 'Leonia International, north apron.'],
  [/The lagoon's a bathtub - causeway dams at both ends\. Real water is out here on the Atlantic side\./g, "The bay's a bathtub full of bridges. Real water is out here on the Atlantic side."],
  [/Conch Harbor, Last Key\. A hundred seconds of open sea\./g, 'Virginia Key Beach, round South Pointe and through Norris Cut. A few minutes of open sea.'],
  [/The Port Solano lagoon is sealed by causeways - the open sea is on the Atlantic side of Solano Beach, which is where Barney keeps his boat\./g, 'Barney keeps his boat on the Atlantic side of South Beach. The run goes round South Pointe, down the ocean side of Fisher Island and through Norris Cut to Virginia Key.'],
  [/About 90 seconds of open water each way at full throttle\. Keep clear of the Overseas Causeway piers; the course marks a safe lane\./g, 'A few minutes of open water at full throttle. No bridges on this run; the course marks a safe lane.'],
  [/Across Florida Bay/g, 'Past Fisher Island'],
  [/Follow the keys south-west/g, 'Make for Norris Cut'],
  [/Into the Keys/g, 'Norris Cut'],
  [/Under the causeway/g, 'Along Virginia Key'],
  [/Keep clear of the causeway piers/g, 'Hug the Virginia Key shore'],
  [/Round the south tip of Solano Beach/g, 'Round South Pointe'],
  [/Skiff: the lagoon is closed by the causeways - a short run, but boats are slow to turn\./g, 'Skiff: round Dodge Island by the Main Channel and Government Cut - boats are slow to turn.'],
  [/Palm Mile\. The whole ring: downtown, causeway, beach, causeway, home\./g, 'Palm Mile. The South Beach ring: Alton Road, 17th Street, Collins, Ocean Drive, home.'],
  [/Fresh off the bus/g, 'Fresh off the Metrorail'],
  [/Welcome to Port Solano/g, 'Welcome to Miami'],
  [/Port Solano lagoon/g, 'Biscayne Bay'],
  [/Port Solano ring/g, 'Miami–Miami Beach ring'],
  [/Port Solano grid/g, 'downtown Miami grid'],
  [/PORT SOLANO — Solano County, Palmara/g, 'MIAMI — Miami-Dade County, Leonia'],
  [/Port Solano/g, 'Miami'],
  [/Solano Beach/g, 'South Beach'],
  [/Solano Plaza/g, 'Bayfront Plaza'],
  [/Solano PD/g, 'Leonia PD'],
  [/Solano County/g, 'Miami-Dade County'],
  [/Solano Airfield/g, 'Leonia International'],
  [/Solano Signal/g, 'Leonia Signal'],
  [/Solano Marine/g, 'Biscayne Marine'],
  [/Port Island/g, 'Dodge Island'],
  [/Port Bridge/g, 'Port Boulevard bridge'],
  [/Flamingo Causeway/g, 'MacArthur Causeway'],
  [/Tarpon Causeway/g, 'Venetian Causeway'],
  [/Overseas Causeway/g, 'Rickenbacker Causeway'],
  [/Coral Keys/g, 'Virginia Key'],
  [/Conch Harbor/g, 'Virginia Key Beach'],
  [/Last Key/g, 'Virginia Key'],
  [/Florida Bay/g, 'the Atlantic'],
  [/Airport Road/g, 'NW 36th Street'],
  [/Coastal Highway/g, 'Biscayne Boulevard'],
  [/the lagoon/g, 'the bay'],
  [/The lagoon/g, 'The bay'],
  [/Solano/g, 'Miami'],
  [/Palmara/g, 'Leonia'],
];
export function leoniaText(s: string): string {
  for (const [re, to] of LEONIA_NAMES) s = s.replace(re, to);
  return s;
}

function setPath(roots: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split('/');
  let o = roots[parts[0]] as Record<string, unknown> | unknown[] | undefined;
  for (let i = 1; i < parts.length - 1 && o; i++) o = (o as Record<string, unknown>)[parts[i]] as Record<string, unknown> | undefined;
  if (!o) throw new Error(`leonia content: no path ${path}`);
  (o as Record<string, unknown>)[parts[parts.length - 1]] = value;
}
/** rewrite every string in an object tree in place (place names → Leonia) */
export function leoniaRewrite(o: unknown) { rewriteText(o); }
function rewriteText(o: unknown, seen = new WeakSet<object>()) {
  if (!o || typeof o !== 'object' || seen.has(o)) return;
  seen.add(o);
  const rec = o as Record<string, unknown>;
  for (const k of Object.keys(rec)) {
    const v = rec[k];
    if (typeof v === 'string') { if (k !== 'id' && k !== 'model' && k !== 'music' && k !== 'cutscene' && k !== 'role') rec[k] = leoniaText(v); }
    else rewriteText(v, seen);
  }
}

/** move activities + cutscenes onto Leonia in place (idempotent per process: call once) */
export function applyLeonia(roots: [string, unknown][]) {
  walkContent(roots, (v) => {
    if (v.kind === 'v3') {
      const p = LEONIA_POS[v.path];
      if (p) { v.value[0] = p[0]; v.value[1] = p[1]; v.value[2] = p[2]; }
    } else {
      const y = LEONIA_YAW[v.path];
      if (y !== undefined) v.holder[v.key] = y;
    }
  });
  const byName = Object.fromEntries(roots);
  for (const [path, value] of Object.entries(LEONIA_SET)) setPath(byName, path, structuredClone(value));
  for (const [, r] of roots) rewriteText(r);
}

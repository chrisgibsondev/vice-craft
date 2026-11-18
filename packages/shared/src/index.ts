export * from './constants.ts';
export * from './protocol.ts';
export * from './physics.ts';
export * from './world/blocks.ts';
export * from './world/mapTypes.ts';
export * from './world/noise.ts';
export * from './world/raster.ts';
export * from './world/structures.ts';
export * from './world/worldgen.ts';
export * from './world/leonia/index.ts';
export * from './world/nav/index.ts';
export * from './content/map/palmara.map.ts';
export * from './content/pois.ts';
export * from './content/activityTypes.ts';
export * from './content/activities.ts';
export * from './content/cutscenes.ts';
export * from './content/economy.ts';
export * from './content/weapons.ts';
export * from './content/barks.ts';
export * from './world/placement.ts';
export { leoniaText } from './content/leonia/apply.ts';
import { WORLD as _W } from './constants.ts';
import { leoniaText as _lt } from './content/leonia/apply.ts';
/** world-specific place names in text (Leonia: real districts/streets; Palmara unchanged) */
export function worldText(s: string): string { return _W === 'leonia' ? _lt(s) : s; }

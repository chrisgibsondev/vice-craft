/**
 * Block registry. Ids are stable (they are stored in chunk arrays) — append only.
 * `tiles` name the procedural texture tiles the client paints into its atlas.
 */
export type RenderKind = 'none' | 'opaque' | 'cutout' | 'cross' | 'translucent' | 'water';

export interface BlockDef {
  id: number;
  name: string;
  solid: boolean;
  render: RenderKind;
  /** [top, side, bottom] tile names */
  tiles: [string, string, string];
  emissive?: number;
  /** footstep material */
  step?: 'grass' | 'concrete' | 'wood' | 'sand';
  /** average colour (top-down map renders) */
  color?: number;
}

const defs: BlockDef[] = [];
function b(name: string, solid: boolean, render: RenderKind, tiles: string | [string, string, string], extra: Partial<BlockDef> = {}): number {
  const id = defs.length;
  const t: [string, string, string] = typeof tiles === 'string' ? [tiles, tiles, tiles] : tiles;
  defs.push({ id, name, solid, render, tiles: t, ...extra });
  return id;
}

export const B = {
  AIR: b('air', false, 'none', 'none'),
  GRASS: b('grass', true, 'opaque', ['grass_top', 'grass_side', 'dirt'], { step: 'grass' }),
  DIRT: b('dirt', true, 'opaque', 'dirt', { step: 'grass' }),
  SAND: b('sand', true, 'opaque', 'sand', { step: 'sand' }),
  STONE: b('stone', true, 'opaque', 'stone'),
  WATER: b('water', false, 'water', 'water'),
  ASPHALT: b('asphalt', true, 'opaque', ['asphalt', 'asphalt', 'asphalt'], { step: 'concrete' }),
  LINE_WHITE: b('line_white', true, 'opaque', ['line_white', 'asphalt', 'asphalt'], { step: 'concrete' }),
  LINE_YELLOW: b('line_yellow', true, 'opaque', ['line_yellow', 'asphalt', 'asphalt'], { step: 'concrete' }),
  SIDEWALK: b('sidewalk', true, 'opaque', ['sidewalk', 'concrete', 'concrete'], { step: 'concrete' }),
  CONCRETE: b('concrete', true, 'opaque', 'concrete', { step: 'concrete' }),
  BRICK: b('brick', true, 'opaque', 'brick'),
  GLASS: b('glass', true, 'translucent', 'glass'),
  PLANK: b('plank', true, 'opaque', 'plank', { step: 'wood' }),
  PALM_LOG: b('palm_log', true, 'opaque', ['palm_log_top', 'palm_log', 'palm_log_top'], { step: 'wood' }),
  LEAVES: b('leaves', true, 'cutout', 'leaves'),
  PALM_LEAVES: b('palm_leaves', false, 'cutout', 'palm_leaves'),
  STUCCO_WHITE: b('stucco_white', true, 'opaque', 'stucco_white'),
  STUCCO_PINK: b('stucco_pink', true, 'opaque', 'stucco_pink'),
  STUCCO_TEAL: b('stucco_teal', true, 'opaque', 'stucco_teal'),
  STUCCO_YELLOW: b('stucco_yellow', true, 'opaque', 'stucco_yellow'),
  STUCCO_PEACH: b('stucco_peach', true, 'opaque', 'stucco_peach'),
  METAL: b('metal', true, 'opaque', 'metal'),
  ROOF_TILE: b('roof_tile', true, 'opaque', 'roof_tile'),
  TILE_FLOOR: b('tile_floor', true, 'opaque', 'tile_floor', { step: 'concrete' }),
  CARPET: b('carpet', true, 'opaque', 'carpet'),
  NEON_PINK: b('neon_pink', true, 'opaque', 'neon_pink', { emissive: 1 }),
  NEON_CYAN: b('neon_cyan', true, 'opaque', 'neon_cyan', { emissive: 1 }),
  MUD: b('mud', true, 'opaque', 'mud', { step: 'grass' }),
  REEDS: b('reeds', false, 'cross', 'reeds'),
  LAMP: b('lamp', true, 'opaque', 'lamp', { emissive: 1 }),
  RAIL: b('rail', true, 'opaque', 'rail'),
  WINDOW: b('window', true, 'opaque', 'window'),
  GRAVEL: b('gravel', true, 'opaque', 'gravel', { step: 'sand' }),
  RUNWAY: b('runway', true, 'opaque', ['runway', 'asphalt', 'asphalt'], { step: 'concrete' }),
  PINE_LEAVES: b('pine_leaves', true, 'cutout', 'pine_leaves'),
  COUNTER: b('counter', true, 'opaque', ['counter_top', 'counter_side', 'plank']),
  SHELF: b('shelf', true, 'opaque', ['plank', 'shelf', 'plank']),
  BED: b('bed', true, 'opaque', ['bed_top', 'bed_side', 'plank']),
  SOFA: b('sofa', true, 'opaque', ['sofa_top', 'sofa_side', 'plank']),
  CRATE: b('crate', true, 'opaque', 'crate', { step: 'wood' }),
  CONTAINER_RED: b('container_red', true, 'opaque', 'container_red'),
  CONTAINER_BLUE: b('container_blue', true, 'opaque', 'container_blue'),
  SHUTTER: b('shutter', true, 'opaque', 'shutter'),
  HEDGE: b('hedge', true, 'cutout', 'hedge'),
  FLOWERS: b('flowers', false, 'cross', 'flowers'),
  CANE: b('cane', false, 'cross', 'cane'),
  CLUB_FLOOR: b('club_floor', true, 'opaque', 'club_floor', { emissive: 0.35, step: 'concrete' }),
  MARBLE: b('marble', true, 'opaque', 'marble', { step: 'concrete' }),
  POLICE_BLUE: b('police_blue', true, 'opaque', 'police_blue'),
  CHROME: b('chrome', true, 'opaque', 'chrome'),
  SCREEN: b('screen', true, 'opaque', ['metal', 'screen', 'metal'], { emissive: 0.8 }),
  FRIDGE: b('fridge', true, 'opaque', ['chrome', 'fridge', 'chrome']),
  STOVE: b('stove', true, 'opaque', ['stove_top', 'stove_side', 'metal']),
  DOCK: b('dock', true, 'opaque', 'dock', { step: 'wood' }),
  FARMLAND: b('farmland', true, 'opaque', ['farmland', 'dirt', 'dirt'], { step: 'grass' }),
  TALL_GRASS: b('tall_grass', false, 'cross', 'tall_grass'),
  DARK_PLANK: b('dark_plank', true, 'opaque', 'dark_plank', { step: 'wood' }),
  SAFE: b('safe', true, 'opaque', ['metal', 'safe_front', 'metal']),
  ARCADE: b('arcade', true, 'opaque', ['metal', 'arcade', 'metal'], { emissive: 0.6 }),
  STOOL: b('stool', true, 'opaque', ['stool_top', 'chrome', 'chrome']),
  RED_STUCCO: b('red_stucco', true, 'opaque', 'red_stucco'),
  STRIPE: b('stripe', true, 'opaque', 'stripe'),

  // ── regions pack (2026-11): per-region architecture, landmarks, terrain variety ──
  CURTAIN_TEAL: b('curtain_teal', true, 'opaque', 'curtain_teal', { color: 0x4fa9a8 }),
  CURTAIN_BLUE: b('curtain_blue', true, 'opaque', 'curtain_blue', { color: 0x3f6fb0 }),
  CURTAIN_GOLD: b('curtain_gold', true, 'opaque', 'curtain_gold', { color: 0xc49a52 }),
  CURTAIN_DARK: b('curtain_dark', true, 'opaque', 'curtain_dark', { color: 0x2c3846 }),
  HELIPAD: b('helipad', true, 'opaque', ['helipad', 'concrete', 'concrete'], { color: 0x50545c, step: 'concrete' }),
  LIMESTONE: b('limestone', true, 'opaque', 'limestone', { color: 0xd6cbb0 }),
  COBBLE: b('cobble', true, 'opaque', ['cobble', 'stone', 'stone'], { color: 0x8a847a, step: 'concrete' }),
  BRICK_DARK: b('brick_dark', true, 'opaque', 'brick_dark', { color: 0x7a3a2c }),
  BRICK_TAN: b('brick_tan', true, 'opaque', 'brick_tan', { color: 0xc9a46a }),
  ARCH_WINDOW: b('arch_window', true, 'opaque', ['brick', 'arch_window', 'brick'], { color: 0x8a4b3a }),
  AWNING_RED: b('awning_red', true, 'opaque', 'awning_red', { color: 0xd8463e }),
  AWNING_GREEN: b('awning_green', true, 'opaque', 'awning_green', { color: 0x3f9a5a }),
  AWNING_BLUE: b('awning_blue', true, 'opaque', 'awning_blue', { color: 0x3d6fc0 }),
  AWNING_YELLOW: b('awning_yellow', true, 'opaque', 'awning_yellow', { color: 0xf0c33c }),
  IRON_RAIL: b('iron_rail', true, 'cutout', 'iron_rail', { color: 0x2a2a2e }),
  SIDING_MINT: b('siding_mint', true, 'opaque', 'siding_mint', { color: 0x9fe0c4, step: 'wood' }),
  SIDING_CORAL: b('siding_coral', true, 'opaque', 'siding_coral', { color: 0xf28b7a, step: 'wood' }),
  SIDING_LEMON: b('siding_lemon', true, 'opaque', 'siding_lemon', { color: 0xf5e07a, step: 'wood' }),
  SIDING_SKY: b('siding_sky', true, 'opaque', 'siding_sky', { color: 0x8cc8ee, step: 'wood' }),
  SIDING_LILAC: b('siding_lilac', true, 'opaque', 'siding_lilac', { color: 0xc7a6e0, step: 'wood' }),
  SIDING_WHITE: b('siding_white', true, 'opaque', 'siding_white', { color: 0xf2f0ea, step: 'wood' }),
  TIN_ROOF: b('tin_roof', true, 'opaque', 'tin_roof', { color: 0xb4bcc2 }),
  PICKET: b('picket', true, 'cutout', 'picket', { color: 0xf4f4f0 }),
  BARN_RED: b('barn_red', true, 'opaque', 'barn_red', { color: 0xa8322a, step: 'wood' }),
  SILO_BLUE: b('silo_blue', true, 'opaque', 'silo_blue', { color: 0x2e4f7a }),
  SILO_STAVE: b('silo_stave', true, 'opaque', 'silo_stave', { color: 0xcfc8b8 }),
  HAY_BALE: b('hay_bale', true, 'opaque', ['hay_top', 'hay_side', 'hay_top'], { color: 0xd9b65a, step: 'grass' }),
  FENCE: b('fence', true, 'cutout', 'fence', { color: 0x8a6a48, step: 'wood' }),
  ORANGE_LEAVES: b('orange_leaves', true, 'cutout', 'orange_leaves', { color: 0x3f8a36 }),
  CORN: b('corn', false, 'cross', 'corn', { color: 0x9cc24e }),
  VEG: b('veg', false, 'cross', 'veg', { color: 0x4f9a3c }),
  FLOWERS_BLUE: b('flowers_blue', false, 'cross', 'flowers_blue', { color: 0x6f7fd8 }),
  FLOWERS_WHITE: b('flowers_white', false, 'cross', 'flowers_white', { color: 0xf0eed0 }),
  MOSSY_STONE: b('mossy_stone', true, 'opaque', ['mossy_stone_top', 'mossy_stone', 'stone'], { color: 0x6f8466 }),
  GRANITE: b('granite', true, 'opaque', 'granite', { color: 0x9c8f88 }),
  MANGROVE_ROOT: b('mangrove_root', true, 'cutout', 'mangrove_root', { color: 0x6a4a30, step: 'wood' }),
  MANGROVE_LEAVES: b('mangrove_leaves', true, 'cutout', 'mangrove_leaves', { color: 0x2f6a34 }),
  SEAGRASS: b('seagrass', true, 'opaque', ['seagrass', 'sand', 'sand'], { color: 0x7a9a58, step: 'sand' }),
  CORAL_PINK: b('coral_pink', true, 'opaque', 'coral_pink', { color: 0xf07aa0 }),
  CORAL_ORANGE: b('coral_orange', true, 'opaque', 'coral_orange', { color: 0xf09a4a }),
  CORAL_PURPLE: b('coral_purple', true, 'opaque', 'coral_purple', { color: 0x9a5ad0 }),
  BARK: b('bark', true, 'opaque', ['bark_top', 'bark', 'bark_top'], { color: 0x5b4330, step: 'wood' }),
  SPRUCE_LEAVES: b('spruce_leaves', true, 'cutout', 'spruce_leaves', { color: 0x24503a }),
  MOSS: b('moss', false, 'cross', 'moss', { color: 0x9aa58a }),
  CRANE_YELLOW: b('crane_yellow', true, 'cutout', 'crane_yellow', { color: 0xf0b428 }),
  TRUSS: b('truss', true, 'cutout', 'truss', { color: 0xa8b0b8 }),
  TRUSS_RED: b('truss_red', true, 'cutout', 'truss_red', { color: 0xc8462e }),
  COASTER_TRACK: b('coaster_track', true, 'opaque', ['coaster_top', 'coaster_side', 'coaster_side'], { color: 0xd23a5a }),
  ROCKET_WHITE: b('rocket_white', true, 'opaque', 'rocket_white', { color: 0xf0f0ee }),
  ROCKET_BAND: b('rocket_band', true, 'opaque', 'rocket_band', { color: 0x5a5a5a }),
  ROCKET_TANK: b('rocket_tank', true, 'opaque', 'rocket_tank', { color: 0xd9772e }),
  DISH: b('dish', true, 'opaque', 'dish', { color: 0xe8ecef }),
  CHAINLINK: b('chainlink', true, 'cutout', 'chainlink', { color: 0x9aa2a8 }),
  COURT_GREEN: b('court_green', true, 'opaque', ['court_green', 'concrete', 'concrete'], { color: 0x3f8a5a, step: 'concrete' }),
  COURT_BLUE: b('court_blue', true, 'opaque', ['court_blue', 'concrete', 'concrete'], { color: 0x3a6ab0, step: 'concrete' }),
  COURT_RED: b('court_red', true, 'opaque', ['court_red', 'concrete', 'concrete'], { color: 0xb05a40, step: 'concrete' }),
  COURT_LINE: b('court_line', true, 'opaque', ['court_line', 'concrete', 'concrete'], { color: 0xf2f2f2, step: 'concrete' }),
  PUMP: b('pump', true, 'opaque', ['metal', 'pump', 'metal'], { color: 0xd84a3a }),
  NEON_YELLOW: b('neon_yellow', true, 'opaque', 'neon_yellow', { emissive: 1, color: 0xffe24a }),
  NEON_GREEN: b('neon_green', true, 'opaque', 'neon_green', { emissive: 1, color: 0x5aff8a }),
  NEON_ORANGE: b('neon_orange', true, 'opaque', 'neon_orange', { emissive: 1, color: 0xff8a3a }),
  NEON_PURPLE: b('neon_purple', true, 'opaque', 'neon_purple', { emissive: 1, color: 0xb05aff }),
  CLOCK: b('clock', true, 'opaque', ['limestone', 'clock', 'limestone'], { color: 0xeee8d8 }),
  STAINED_GLASS: b('stained_glass', true, 'opaque', 'stained_glass', { emissive: 0.3, color: 0x7a5ab0 }),
  COPPER_ROOF: b('copper_roof', true, 'opaque', 'copper_roof', { color: 0x6fae9a }),
  SLATE_ROOF: b('slate_roof', true, 'opaque', 'slate_roof', { color: 0x4a4f58 }),
  SHINGLE_BROWN: b('shingle_brown', true, 'opaque', 'shingle_brown', { color: 0x7a5640 }),
  SHINGLE_GREY: b('shingle_grey', true, 'opaque', 'shingle_grey', { color: 0x6c7076 }),
  SHINGLE_GREEN: b('shingle_green', true, 'opaque', 'shingle_green', { color: 0x4a6a4a }),
  STUCCO_CREAM: b('stucco_cream', true, 'opaque', 'stucco_cream', { color: 0xf0e1c0 }),
  STUCCO_OCHRE: b('stucco_ochre', true, 'opaque', 'stucco_ochre', { color: 0xdca85a }),
  STUCCO_LAVENDER: b('stucco_lavender', true, 'opaque', 'stucco_lavender', { color: 0xc9b4ea }),
  STUCCO_MINT: b('stucco_mint', true, 'opaque', 'stucco_mint', { color: 0xa8ecd0 }),
  STUCCO_SKY: b('stucco_sky', true, 'opaque', 'stucco_sky', { color: 0x9cd4f4 }),
  FAIRWAY: b('fairway', true, 'opaque', ['fairway', 'grass_side', 'dirt'], { color: 0x5fb04a, step: 'grass' }),
  PUTTING: b('putting', true, 'opaque', ['putting', 'grass_side', 'dirt'], { color: 0x7ad05a, step: 'grass' }),
  FLAG: b('flag', false, 'cutout', 'flag', { color: 0xe03a3a }),
  FAN_CAGE: b('fan_cage', true, 'cutout', 'fan_cage', { color: 0x40444a }),
  HULL_WHITE: b('hull_white', true, 'opaque', ['boat_deck', 'hull_white', 'hull_white'], { color: 0xf2f2f0, step: 'wood' }),
  HULL_BLUE: b('hull_blue', true, 'opaque', ['boat_deck', 'hull_blue', 'hull_blue'], { color: 0x2a5aa8, step: 'wood' }),
  FUSELAGE: b('fuselage', true, 'opaque', ['plane_top', 'fuselage', 'plane_top'], { color: 0xf4f4f6 }),
  PLANE_TAIL: b('plane_tail', true, 'opaque', 'plane_tail', { color: 0x2a6ad0 }),
  LIGHT_BLUE: b('light_blue', false, 'cross', 'light_blue', { emissive: 1, color: 0x4a8aff }),
  LIGHT_RED: b('light_red', false, 'cross', 'light_red', { emissive: 1, color: 0xff3a3a }),
  LIGHT_GREEN: b('light_green', false, 'cross', 'light_green', { emissive: 1, color: 0x3aff6a }),
  MURAL_A: b('mural_a', true, 'opaque', 'mural_a', { color: 0xf08a5a }),
  MURAL_B: b('mural_b', true, 'opaque', 'mural_b', { color: 0x5ab0d0 }),
  CASTLE_STONE: b('castle_stone', true, 'opaque', 'castle_stone', { color: 0xe8e0f0 }),
  CASTLE_ROOF: b('castle_roof', true, 'opaque', 'castle_roof', { color: 0x3d5fc4 }),
  GOLD_TRIM: b('gold_trim', true, 'opaque', 'gold_trim', { color: 0xe0b33a, emissive: 0.15 }),
  PANEL_WHITE: b('panel_white', true, 'opaque', 'panel_white', { color: 0xe6e8ea }),
  PANEL_GREY: b('panel_grey', true, 'opaque', 'panel_grey', { color: 0x9aa0a8 }),
  LOG_WALL: b('log_wall', true, 'opaque', ['log_top', 'log_wall', 'log_top'], { color: 0x8a5a33, step: 'wood' }),
  CEDAR_SHINGLE: b('cedar_shingle', true, 'opaque', 'cedar_shingle', { color: 0x6a4630, step: 'wood' }),
  LUMBER: b('lumber', true, 'opaque', ['lumber_top', 'lumber_side', 'lumber_top'], { color: 0xd2a868, step: 'wood' }),
  POOL_TILE: b('pool_tile', true, 'opaque', 'pool_tile', { color: 0x8fd3e8, step: 'concrete' }),
  PATH: b('path', true, 'opaque', ['path', 'dirt', 'dirt'], { color: 0xb89a6a, step: 'sand' }),
  SEA_OATS: b('sea_oats', false, 'cross', 'sea_oats', { color: 0xd8c890 }),
  PALMETTO: b('palmetto', false, 'cross', 'palmetto', { color: 0x4f8a40 }),
  CONTAINER_GREEN: b('container_green', true, 'opaque', 'container_green', { color: 0x2f7a4a }),
  CONTAINER_ORANGE: b('container_orange', true, 'opaque', 'container_orange', { color: 0xe07a2a }),
  CONTAINER_WHITE: b('container_white', true, 'opaque', 'container_white', { color: 0xdcdcd6 }),
  CONTAINER_YELLOW: b('container_yellow', true, 'opaque', 'container_yellow', { color: 0xe8c030 }),
  FOOD_TRUCK: b('food_truck', true, 'opaque', ['metal', 'food_truck', 'metal'], { color: 0xf0f0f0 }),
  TIRE: b('tire', true, 'opaque', 'tire', { color: 0x222226 }),
  SCAFFOLD: b('scaffold', true, 'cutout', 'scaffold', { color: 0x8a96a0 }),
  SOLAR: b('solar', true, 'opaque', ['solar', 'metal', 'metal'], { color: 0x1f3460 }),
  AC_UNIT: b('ac_unit', true, 'opaque', ['ac_top', 'ac_side', 'metal'], { color: 0xc8ccd0 }),
  SIGN_PANEL: b('sign_panel', true, 'opaque', 'sign_panel', { color: 0x1c2440 }),
  LETTER_A: b('letter_a', true, 'opaque', ['sign_panel', 'letter_a', 'sign_panel'], { emissive: 0.55, color: 0x1c2440 }),
  LETTER_B: b('letter_b', true, 'opaque', ['sign_panel', 'letter_b', 'sign_panel'], { emissive: 0.55, color: 0x1c2440 }),
  LETTER_C: b('letter_c', true, 'opaque', ['sign_panel', 'letter_c', 'sign_panel'], { emissive: 0.55, color: 0x1c2440 }),
  LETTER_D: b('letter_d', true, 'opaque', ['sign_panel', 'letter_d', 'sign_panel'], { emissive: 0.55, color: 0x1c2440 }),
  LETTER_E: b('letter_e', true, 'opaque', ['sign_panel', 'letter_e', 'sign_panel'], { emissive: 0.55, color: 0x1c2440 }),
  LETTER_F: b('letter_f', true, 'opaque', ['sign_panel', 'letter_f', 'sign_panel'], { emissive: 0.55, color: 0x1c2440 }),
  LETTER_G: b('letter_g', true, 'opaque', ['sign_panel', 'letter_g', 'sign_panel'], { emissive: 0.55, color: 0x1c2440 }),
  LETTER_H: b('letter_h', true, 'opaque', ['sign_panel', 'letter_h', 'sign_panel'], { emissive: 0.55, color: 0x1c2440 }),
  LETTER_I: b('letter_i', true, 'opaque', ['sign_panel', 'letter_i', 'sign_panel'], { emissive: 0.55, color: 0x1c2440 }),
  LETTER_J: b('letter_j', true, 'opaque', ['sign_panel', 'letter_j', 'sign_panel'], { emissive: 0.55, color: 0x1c2440 }),
  LETTER_K: b('letter_k', true, 'opaque', ['sign_panel', 'letter_k', 'sign_panel'], { emissive: 0.55, color: 0x1c2440 }),
  LETTER_L: b('letter_l', true, 'opaque', ['sign_panel', 'letter_l', 'sign_panel'], { emissive: 0.55, color: 0x1c2440 }),
  LETTER_M: b('letter_m', true, 'opaque', ['sign_panel', 'letter_m', 'sign_panel'], { emissive: 0.55, color: 0x1c2440 }),
  LETTER_N: b('letter_n', true, 'opaque', ['sign_panel', 'letter_n', 'sign_panel'], { emissive: 0.55, color: 0x1c2440 }),
  LETTER_O: b('letter_o', true, 'opaque', ['sign_panel', 'letter_o', 'sign_panel'], { emissive: 0.55, color: 0x1c2440 }),
  LETTER_P: b('letter_p', true, 'opaque', ['sign_panel', 'letter_p', 'sign_panel'], { emissive: 0.55, color: 0x1c2440 }),
  LETTER_Q: b('letter_q', true, 'opaque', ['sign_panel', 'letter_q', 'sign_panel'], { emissive: 0.55, color: 0x1c2440 }),
  LETTER_R: b('letter_r', true, 'opaque', ['sign_panel', 'letter_r', 'sign_panel'], { emissive: 0.55, color: 0x1c2440 }),
  LETTER_S: b('letter_s', true, 'opaque', ['sign_panel', 'letter_s', 'sign_panel'], { emissive: 0.55, color: 0x1c2440 }),
  LETTER_T: b('letter_t', true, 'opaque', ['sign_panel', 'letter_t', 'sign_panel'], { emissive: 0.55, color: 0x1c2440 }),
  LETTER_U: b('letter_u', true, 'opaque', ['sign_panel', 'letter_u', 'sign_panel'], { emissive: 0.55, color: 0x1c2440 }),
  LETTER_V: b('letter_v', true, 'opaque', ['sign_panel', 'letter_v', 'sign_panel'], { emissive: 0.55, color: 0x1c2440 }),
  LETTER_W: b('letter_w', true, 'opaque', ['sign_panel', 'letter_w', 'sign_panel'], { emissive: 0.55, color: 0x1c2440 }),
  LETTER_X: b('letter_x', true, 'opaque', ['sign_panel', 'letter_x', 'sign_panel'], { emissive: 0.55, color: 0x1c2440 }),
  LETTER_Y: b('letter_y', true, 'opaque', ['sign_panel', 'letter_y', 'sign_panel'], { emissive: 0.55, color: 0x1c2440 }),
  LETTER_Z: b('letter_z', true, 'opaque', ['sign_panel', 'letter_z', 'sign_panel'], { emissive: 0.55, color: 0x1c2440 }),
  // ── Leonia facade polish (appended: ids of the blocks above never change) ──
  MURAL_C: b('mural_c', true, 'opaque', 'mural_c', { color: 0xe0568a }),
  MURAL_D: b('mural_d', true, 'opaque', 'mural_d', { color: 0x3fb59a }),
  MURAL_E: b('mural_e', true, 'opaque', 'mural_e', { color: 0xf2c230 }),
  ROOF_WHITE: b('roof_white', true, 'opaque', 'roof_white', { color: 0xe6e8e4 }),
  ROOF_DARK: b('roof_dark', true, 'opaque', 'roof_dark', { color: 0x4a4c50 }),
} as const;

/** Block id of the sign letter for a character (A-Z), or the plain sign panel. */
export function letterBlock(ch: string): number {
  const c = ch.toUpperCase().charCodeAt(0) - 65;
  return c >= 0 && c < 26 ? B.LETTER_A + c : B.SIGN_PANEL;
}

export const BLOCKS: readonly BlockDef[] = defs;
export const BLOCK_COUNT = defs.length;

export const SOLID = new Uint8Array(256);
export const OPAQUE = new Uint8Array(256); // fully hides neighbouring faces
for (const d of defs) {
  SOLID[d.id] = d.solid ? 1 : 0;
  OPAQUE[d.id] = d.render === 'opaque' ? 1 : 0;
}

export function isSolid(id: number): boolean { return SOLID[id] === 1; }
export function isWater(id: number): boolean { return id === B.WATER; }

/** All tile names referenced by blocks (atlas order). */
export const TILE_NAMES: string[] = (() => {
  const s = new Set<string>();
  for (const d of defs) for (const t of d.tiles) if (t !== 'none') s.add(t);
  return [...s];
})();
export const TILE_INDEX: Record<string, number> = Object.fromEntries(TILE_NAMES.map((n, i) => [n, i]));

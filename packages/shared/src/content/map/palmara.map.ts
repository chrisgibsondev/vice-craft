/**
 * PALMARA — editable map data for VICE CRAFT.
 *
 * Geography is traced (stylised) from real Florida geography: a peninsula with a
 * large inland lake, sawgrass wetlands to the south, a curved island chain off the
 * southern tip, Atlantic barrier islands, a dense south-east metro and a bay city on
 * the Gulf coast. Every name is original.
 *
 * Coordinates: x = east (blocks), z = south (blocks). North is -z. 1 block = 1 m.
 * World bounds: x 0..3072, z 0..4608. Sea level block y = 20 (water top surface y = 21).
 *
 * Everything in this file is pure data. Edit it and restart the server; the client and
 * the server both rebuild the world deterministically from it.
 */
import type { MapData } from '../../world/mapTypes.ts';

export const PALMARA: MapData = {
  name: 'Palmara',
  width: 3072,
  depth: 4608,
  seaLevel: 20,
  seed: 1977,

  // ── Land masses (closed polygons, clockwise) ─────────────────────────────
  land: [
    {
      id: 'mainland',
      points: [
        // north coast, west → east
        [560, 560], [640, 470], [760, 410], [900, 370], [1050, 345], [1200, 330], [1380, 322],
        [1560, 326], [1740, 336], [1900, 352], [2040, 380], [2160, 420], [2250, 470],
        // Atlantic coast, north → south
        [2290, 560], [2310, 700], [2330, 860], [2350, 1020], [2380, 1180], [2420, 1330],
        [2470, 1450], [2530, 1500], [2545, 1560], [2505, 1620], [2500, 1720], [2530, 1880],
        [2570, 2060], [2610, 2260], [2645, 2480], [2665, 2700], [2668, 2880], [2650, 3000],
        [2640, 3120], [2636, 3260], [2618, 3400], [2580, 3520], [2520, 3620], [2430, 3700], [2330, 3760],
        // Florida-Bay-like south coast, east → west
        [2200, 3800], [2060, 3830], [1900, 3850], [1760, 3860], [1620, 3850], [1540, 3820],
        // Gulf coast, south → north (ragged mangrove shore first)
        [1480, 3760], [1430, 3680], [1380, 3600], [1330, 3500], [1270, 3380], [1210, 3260],
        [1160, 3120], [1110, 2980], [1060, 2850], [1000, 2730], [950, 2600], [905, 2460],
        [860, 2320], [820, 2200], [790, 2090], [770, 1990], [740, 1880], [700, 1760],
        [660, 1620], [620, 1470], [575, 1300], [535, 1120], [505, 950], [495, 800], [515, 660],
      ],
    },
    // Gulf barrier islands (Coral Sands / Bayhaven beaches)
    { id: 'sandpiper_isle', points: [[700, 2000], [722, 1990], [770, 2200], [800, 2330], [784, 2340], [748, 2220]] },
    { id: 'pelican_isle', points: [[820, 2380], [838, 2372], [880, 2520], [920, 2650], [902, 2660], [858, 2530]] },
    // Gulf islands off the north-west
    { id: 'cedar_key', points: [[430, 1180], [470, 1160], [500, 1190], [480, 1240], [440, 1240]] },
    // Port Solano: cargo-port island in the bay
    { id: 'port_island', points: [[2666, 3184], [2744, 3178], [2754, 3230], [2748, 3292], [2668, 3296]] },
    // Coral Keys — curved island chain
    { id: 'key_1', points: [[2300, 3800], [2330, 3790], [2316, 3880], [2286, 3890]] },
    { id: 'key_2', points: [[2240, 3920], [2276, 3912], [2236, 3990], [2200, 3996]] },
    { id: 'key_3', points: [[2140, 4030], [2190, 4018], [2120, 4080], [2080, 4090]] },
    { id: 'key_4', points: [[1990, 4110], [2050, 4096], [1960, 4152], [1916, 4160]] },
    { id: 'key_5', points: [[1800, 4180], [1880, 4168], [1880, 4190], [1790, 4210]] },
    { id: 'key_6', points: [[1600, 4222], [1700, 4210], [1702, 4232], [1600, 4246]] },
    { id: 'key_7', points: [[1440, 4250], [1520, 4244], [1522, 4266], [1440, 4272]] },
    // Last Key — the westernmost island, with Conch Harbor and the island airport
    {
      id: 'last_key',
      points: [[1150, 4230], [1250, 4212], [1360, 4220], [1388, 4262], [1350, 4320], [1250, 4336], [1160, 4318], [1130, 4272]],
    },
  ],

  // Thin land strips (centre-line polyline + width): Atlantic barrier islands.
  barriers: [
    { id: 'north_banks', width: 22, points: [[2340, 620], [2365, 820], [2390, 1000], [2420, 1180], [2460, 1320]] },
    { id: 'halcyon_shore', width: 26, points: [[2560, 1700], [2590, 1880], [2630, 2060], [2668, 2260], [2700, 2480], [2716, 2700], [2716, 2860]] },
    // Solano Beach — the resort barrier island facing downtown Port Solano
    { id: 'solano_beach', width: 60, points: [[2770, 2930], [2790, 3040], [2800, 3150], [2802, 3260], [2794, 3380], [2770, 3480]] },
  ],

  // ── Water carved out of land ─────────────────────────────────────────────
  water: [
    // Lake Mirabel — the big inland lake
    {
      id: 'lake_mirabel', kind: 'lake',
      points: [[2060, 2560], [2160, 2520], [2280, 2540], [2350, 2620], [2360, 2740], [2310, 2840], [2200, 2880], [2090, 2860], [2020, 2780], [2010, 2660]],
    },
    // Bayhaven Bay — the big Gulf bay
    {
      id: 'bayhaven_bay', kind: 'sea',
      points: [[770, 2130], [840, 2090], [900, 2040], [960, 1990], [1000, 2010], [980, 2070], [930, 2130], [870, 2190], [820, 2230], [790, 2200]],
    },
    // Lakemont lakes
    { id: 'lake_starfall', kind: 'lake', points: [[1660, 1520], [1720, 1510], [1740, 1560], [1700, 1590], [1650, 1570]] },
    { id: 'lake_cypress', kind: 'lake', points: [[1820, 1700], [1870, 1690], [1890, 1730], [1850, 1760], [1810, 1740]] },
    { id: 'lake_north', kind: 'lake', points: [[1240, 700], [1300, 690], [1320, 740], [1270, 770], [1230, 740]] },
  ],

  rivers: [
    // St. Ives River — flows north into the sea at Cedar Bluff
    { id: 'st_ives_river', width: 18, points: [[1900, 1300], [1960, 1100], [2020, 900], [2080, 720], [2110, 560], [2130, 400]] },
    // Kissing Creek — feeds Lake Mirabel from the north
    { id: 'kissing_creek', width: 10, points: [[1880, 1800], [1960, 2050], [2040, 2300], [2120, 2530]] },
    // Solano Canal — through the city to the bay
    { id: 'solano_canal', width: 12, points: [[2300, 3040], [2400, 3046], [2480, 3050], [2560, 3052], [2660, 3050]] },
    // Glades sloughs
    { id: 'shark_slough', width: 14, points: [[2120, 2900], [2050, 3200], [1960, 3500], [1880, 3840]] },
  ],

  // ── Zones (polygons). Later entries win where they overlap. ──────────────
  zones: [
    { id: 'timberline_forest', kind: 'forest', points: [[600, 500], [2200, 440], [2260, 1200], [1500, 1350], [700, 1300]] },
    { id: 'central_farmland', kind: 'farmland', points: [[1100, 1500], [2000, 1900], [2000, 2500], [1300, 2500]] },
    { id: 'mirabel_farms', kind: 'farmland', points: [[1700, 2500], [2020, 2520], [2010, 2950], [1700, 2900]] },
    { id: 'sawgrass_glades', kind: 'wetland', points: [[1400, 2900], [2300, 2920], [2330, 3760], [1520, 3840], [1300, 3420]] },
    // cities
    { id: 'cedar_bluff', kind: 'urban', points: [[2000, 460], [2250, 480], [2280, 700], [2050, 720]] },
    { id: 'lakemont', kind: 'suburb', points: [[1560, 1440], [1950, 1440], [1960, 1820], [1580, 1820]] },
    { id: 'lakemont_core', kind: 'urban', points: [[1720, 1560], [1840, 1560], [1840, 1660], [1720, 1660]] },
    { id: 'cape_halcyon', kind: 'industrial', points: [[2440, 1440], [2540, 1480], [2540, 1610], [2470, 1620]] },
    { id: 'bayhaven', kind: 'urban', points: [[880, 1920], [1080, 1900], [1100, 2100], [960, 2140]] },
    { id: 'bayhaven_suburbs', kind: 'suburb', points: [[800, 1760], [1150, 1760], [1160, 2250], [860, 2300]] },
    { id: 'coral_sands', kind: 'suburb', points: [[880, 2380], [1060, 2380], [1080, 2620], [940, 2620]] },
    { id: 'palm_haven', kind: 'suburb', points: [[1110, 2980], [1300, 2980], [1300, 3180], [1170, 3180]] },
    // Port Solano metro (Solano County)
    { id: 'solano_suburbs', kind: 'suburb', points: [[2300, 2700], [2660, 2700], [2640, 3580], [2380, 3600], [2300, 3400]] },
    { id: 'solano_urban', kind: 'urban', points: [[2380, 2920], [2645, 2920], [2640, 3400], [2380, 3400]] },
    { id: 'solano_downtown', kind: 'downtown', points: [[2400, 3064], [2640, 3064], [2640, 3270], [2400, 3270]] },
    { id: 'solano_airport', kind: 'airport', points: [[2150, 3270], [2380, 3270], [2380, 3430], [2150, 3430]] },
    { id: 'solano_port', kind: 'industrial', points: [[2660, 3176], [2756, 3176], [2756, 3300], [2660, 3300]] },
    { id: 'solano_beach_strip', kind: 'resort', points: [[2756, 2930], [2840, 2930], [2840, 3480], [2756, 3480]] },
    // Coral Keys
    { id: 'conch_harbor', kind: 'resort', points: [[1290, 4214], [1392, 4214], [1392, 4330], [1290, 4330]] },
    { id: 'last_key_airport', kind: 'airport', points: [[1150, 4228], [1286, 4228], [1286, 4330], [1150, 4330]] },
    // ── regions pack (2026-11) ──
    // Bayhaven's historic core sits inside the suburbs polygon: restore it as urban
    { id: 'bayhaven_downtown', kind: 'urban', points: [[880, 1920], [1080, 1900], [1100, 2100], [960, 2140]] },
    // landmark grounds without a street grid
    { id: 'starfall_park', kind: 'none', points: [[1588, 1652], [1716, 1652], [1716, 1820], [1588, 1820]] },
    { id: 'halcyon_spaceport', kind: 'none', points: [[2462, 1430], [2560, 1430], [2560, 1640], [2462, 1640]] },
    // small towns along the highways (region 'smalltown')
    { id: 'town_pinewood', kind: 'suburb', points: [[1152, 868], [1292, 868], [1292, 1004], [1152, 1004]] },
    { id: 'town_cane_junction', kind: 'suburb', points: [[1384, 1684], [1520, 1684], [1520, 1820], [1384, 1820]] },
    { id: 'town_gator_crossing', kind: 'suburb', points: [[1736, 2988], [1872, 2988], [1872, 3108], [1736, 3108]] },
    { id: 'town_sandpiper', kind: 'suburb', points: [[648, 1352], [784, 1352], [784, 1476], [648, 1476]] },
    { id: 'town_mirabel_springs', kind: 'suburb', points: [[1880, 2560], [2004, 2560], [2004, 2680], [1880, 2680]] },
    { id: 'town_bluewater', kind: 'suburb', points: [[1420, 360], [1584, 360], [1584, 472], [1420, 472]] },
    { id: 'town_seagrape', kind: 'suburb', points: [[2224, 1064], [2340, 1064], [2340, 1184], [2224, 1184]] },
  ],

  // ── Roads (polylines). Where a road crosses water it becomes a causeway bridge. ──
  roads: [
    { id: 'coastal_hwy', name: 'Coastal Highway', kind: 'highway', points: [[2150, 520], [2240, 640], [2270, 900], [2300, 1100], [2340, 1300], [2400, 1430], [2450, 1520], [2440, 1640], [2460, 1800], [2510, 2050], [2560, 2300], [2600, 2560], [2610, 2760], [2604, 2904], [2580, 3000], [2544, 3060]] },
    { id: 'coastal_hwy_south', name: 'Coastal Highway', kind: 'highway', points: [[2544, 3290], [2540, 3420], [2500, 3560], [2420, 3660], [2316, 3740]] },
    { id: 'overseas_causeway', name: 'Overseas Causeway', kind: 'highway', points: [[2316, 3740], [2310, 3840], [2250, 3950], [2150, 4050], [2010, 4130], [1840, 4190], [1650, 4230], [1480, 4258], [1360, 4262], [1300, 4262]] },
    { id: 'sunstate_turnpike', name: 'Sunstate Turnpike', kind: 'highway', points: [[640, 760], [900, 980], [1200, 1200], [1500, 1400], [1700, 1500], [1900, 1700], [2100, 2050], [2300, 2380], [2400, 2560], [2440, 2800], [2420, 2960], [2400, 3020]] },
    { id: 'north_loop', name: 'North Loop', kind: 'highway', points: [[640, 760], [800, 560], [1100, 450], [1500, 430], [1900, 470], [2150, 520]] },
    { id: 'gulf_hwy', name: 'Gulf Highway', kind: 'highway', points: [[640, 760], [620, 1000], [660, 1300], [720, 1550], [800, 1800], [880, 1950], [960, 2160], [960, 2400], [1000, 2600], [1060, 2780], [1140, 2980], [1200, 3080]] },
    { id: 'cross_glades', name: 'Cross-Glades Highway', kind: 'highway', points: [[1200, 3080], [1500, 3060], [1800, 3040], [2100, 3030], [2300, 3030], [2400, 3020]] },
    { id: 'bay_interstate', name: 'Bayhaven Interstate', kind: 'highway', points: [[1000, 2000], [1300, 1840], [1600, 1640], [1760, 1560], [2000, 1520], [2300, 1500], [2450, 1520]] },
    { id: 'lake_road', name: 'Mirabel Lake Road', kind: 'arterial', points: [[2000, 2500], [2200, 2470], [2390, 2560], [2410, 2760], [2340, 2920], [2180, 2940], [2000, 2900], [1960, 2700], [2000, 2500]] },
    { id: 'beach_causeway_n', name: 'Flamingo Causeway', kind: 'arterial', points: [[2604, 3000], [2700, 3000], [2800, 3000]] },
    { id: 'beach_causeway_s', name: 'Tarpon Causeway', kind: 'arterial', points: [[2632, 3360], [2720, 3360], [2804, 3360]] },
    { id: 'port_bridge', name: 'Port Bridge', kind: 'arterial', points: [[2630, 3240], [2668, 3240], [2700, 3240]] },
    { id: 'beach_drive', name: 'Ocean Drive', kind: 'arterial', points: [[2780, 2950], [2796, 3100], [2804, 3250], [2798, 3400], [2776, 3470]] },
    { id: 'airport_road', name: 'Airport Road', kind: 'arterial', points: [[2400, 3168], [2300, 3200], [2260, 3270]] },
    { id: 'glades_road', name: 'Airboat Road', kind: 'arterial', points: [[1800, 3040], [1820, 3300], [1840, 3600], [1760, 3820]] },
    { id: 'cedar_road', name: 'Pinewood Road', kind: 'arterial', points: [[1100, 450], [1150, 800], [1300, 1100], [1500, 1400]] },
  ],

  // ── Named regions (labels on the map) ────────────────────────────────────
  counties: [
    { id: 'timberline', name: 'Timberline County', label: [1350, 600], points: [[500, 300], [2350, 300], [2350, 1250], [500, 1250]] },
    { id: 'gulf_reach', name: 'Gulf Reach County', label: [880, 1700], points: [[400, 1250], [1300, 1250], [1300, 3100], [400, 3100]] },
    { id: 'big_water', name: 'Big Water County', label: [1900, 2200], points: [[1300, 1250], [2700, 1250], [2700, 2900], [1300, 2900]] },
    { id: 'solano', name: 'Solano County', label: [2560, 2900], points: [[2300, 2900], [2900, 2900], [2900, 3800], [2300, 3800]] },
    { id: 'sawgrass', name: 'Sawgrass County', label: [1800, 3350], points: [[1100, 2900], [2300, 2900], [2300, 3900], [1100, 3900]] },
    { id: 'coral_keys', name: 'The Coral Keys', label: [1700, 4120], points: [[1100, 3900], [2400, 3900], [2400, 4400], [1100, 4400]] },
  ],

  places: [
    { id: 'port_solano', name: 'Port Solano', kind: 'city', pos: [2500, 3160] },
    { id: 'solano_beach', name: 'Solano Beach', kind: 'district', pos: [2800, 3150] },
    { id: 'bayhaven', name: 'Bayhaven', kind: 'city', pos: [990, 2020] },
    { id: 'cedar_bluff', name: 'Cedar Bluff', kind: 'city', pos: [2140, 600] },
    { id: 'lakemont', name: 'Lakemont', kind: 'city', pos: [1780, 1610] },
    { id: 'cape_halcyon', name: 'Cape Halcyon', kind: 'landmark', pos: [2500, 1540] },
    { id: 'coral_sands', name: 'Coral Sands', kind: 'town', pos: [980, 2500] },
    { id: 'palm_haven', name: 'Palm Haven', kind: 'town', pos: [1220, 3080] },
    { id: 'conch_harbor', name: 'Conch Harbor', kind: 'town', pos: [1340, 4270] },
    { id: 'lake_mirabel', name: 'Lake Mirabel', kind: 'water', pos: [2190, 2700] },
    { id: 'sawgrass', name: 'The Sawgrass', kind: 'wilderness', pos: [1850, 3400] },
    { id: 'starfall_park', name: 'Starfall Park', kind: 'landmark', pos: [1690, 1620] },
    { id: 'pinewood', name: 'Pinewood', kind: 'town', pos: [1222, 936] },
    { id: 'cane_junction', name: 'Cane Junction', kind: 'town', pos: [1452, 1752] },
    { id: 'gator_crossing', name: 'Gator Crossing', kind: 'town', pos: [1804, 3048] },
    { id: 'sandpiper', name: 'Sandpiper', kind: 'town', pos: [716, 1414] },
    { id: 'mirabel_springs', name: 'Mirabel Springs', kind: 'town', pos: [1942, 2620] },
    { id: 'bluewater', name: 'Bluewater', kind: 'town', pos: [1502, 416] },
    { id: 'seagrape', name: 'Seagrape', kind: 'town', pos: [2282, 1124] },
    { id: 'halcyon_spaceport', name: 'Halcyon Spaceport', kind: 'landmark', pos: [2500, 1530] },
  ],

  // City street grid: streets run along multiples of `spacing` inside urban-type zones.
  streetGrid: { spacing: 48, roadWidth: 8, sidewalk: 3 },
};

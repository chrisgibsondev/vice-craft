/** OSM tags → Leonia feature codes. Only generic categories are kept (no brands). */
import { AK, BK, ROOF, RC, RF, POI } from '../../packages/shared/src/world/leonia/format.ts';

export type Tags = Record<string, string>;

export function areaKind(t: Tags): number {
  const lu = t.landuse, le = t.leisure, na = t.natural, am = t.amenity, ae = t.aeroway, mm = t.man_made, g = t.golf;
  if (g === 'green') return AK.GOLF_GREEN;
  if (g === 'fairway') return AK.GOLF_FAIRWAY;
  if (g === 'tee') return AK.GOLF_TEE;
  if (g === 'bunker') return AK.GOLF_BUNKER;
  if (g === 'rough') return AK.GOLF_ROUGH;
  if (le === 'golf_course' || lu === 'golf_course') return AK.GOLF;
  if (le === 'swimming_pool') return AK.POOL;
  if (le === 'marina') return AK.MARINA;
  if (le === 'pitch') return AK.PITCH;
  if (le === 'track') return AK.TRACK;
  if (le === 'playground') return AK.PLAYGROUND;
  if (le === 'dog_park') return AK.DOG_PARK;
  if (le === 'stadium' || le === 'sports_centre') return AK.STADIUM;
  if (le === 'park' || le === 'recreation_ground' || le === 'common') return AK.PARK;
  if (le === 'garden') return AK.GARDEN;
  if (le === 'nature_reserve' || t.boundary === 'protected_area' || t.boundary === 'national_park') return AK.NATURE;
  if (t.tourism === 'zoo' || t.tourism === 'theme_park') return AK.ZOO;
  if (mm === 'pier') return AK.PIER;
  if (mm === 'breakwater' || mm === 'groyne') return AK.BREAKWATER;
  if (mm === 'bridge') return AK.BRIDGE;
  if (ae === 'runway') return AK.RUNWAY;
  if (ae === 'apron' || ae === 'taxiway') return AK.APRON;
  if (ae === 'helipad') return AK.HELIPAD;
  if (ae === 'aerodrome') return AK.AERODROME;
  if (am === 'parking' && t.parking !== 'underground' && t.parking !== 'multi-storey') return AK.PARKING;
  if (t.highway === 'pedestrian' || t.place === 'square' || (t.highway && t.area === 'yes')) return AK.PLAZA;
  if (na === 'beach') return AK.BEACH;
  if (na === 'sand') return AK.SAND;
  if (na === 'wood' || lu === 'forest') return AK.FOREST;
  if (na === 'scrub' || na === 'heath') return AK.SCRUB;
  if (na === 'wetland' || na === 'mud') return AK.WETLAND;
  if (na === 'grassland' || lu === 'grass' || lu === 'meadow' || lu === 'village_green' || lu === 'recreation_ground') return AK.GRASS;
  if (lu === 'cemetery' || am === 'grave_yard') return AK.CEMETERY;
  if (lu === 'residential') return AK.RESIDENTIAL;
  if (lu === 'commercial') return AK.COMMERCIAL;
  if (lu === 'retail') return AK.RETAIL;
  if (lu === 'industrial') return t.industrial === 'port' ? AK.PORT : AK.INDUSTRIAL;
  if (lu === 'port' || lu === 'harbour') return AK.PORT;
  if (lu === 'railway') return AK.RAILWAY;
  if (lu === 'construction' || lu === 'brownfield' || lu === 'greenfield') return AK.CONSTRUCTION;
  if (lu === 'military') return AK.MILITARY;
  if (lu === 'education' || am === 'school' || am === 'university' || am === 'college') return AK.EDUCATION;
  if (am === 'hospital') return AK.HOSPITAL;
  if (lu === 'religious' || am === 'place_of_worship') return AK.RELIGIOUS;
  if (lu === 'farmland' || lu === 'orchard' || lu === 'plant_nursery' || lu === 'allotments') return AK.FARMLAND;
  return AK.NONE;
}

export function isWaterArea(t: Tags): boolean {
  if (t.natural === 'water') return true;
  if (t.waterway === 'riverbank' || t.waterway === 'dock' || t.waterway === 'canal' && t.area === 'yes') return true;
  if (t.landuse === 'reservoir' || t.landuse === 'basin') return true;
  return false;
}
/** default width (m) for waterway centre lines */
export function waterwayWidth(t: Tags): number {
  const w = parseFloat(t.width ?? '');
  if (w > 0 && w < 200) return w;
  switch (t.waterway) {
    case 'river': return 25;
    case 'canal': return 14;
    case 'stream': return 4;
    case 'drain': case 'ditch': return 3;
    default: return 0;
  }
}

const num = (s: string | undefined) => { if (!s) return NaN; const m = /-?[\d.]+/.exec(s.replace(',', '.')); if (!m) return NaN; let v = parseFloat(m[0]); if (/ft|'/.test(s)) v *= 0.3048; return v; };

export function buildingKind(t: Tags): number {
  const b = t.building ?? t['building:part'] ?? 'yes';
  const am = t.amenity;
  if (t.aeroway === 'terminal' || b === 'terminal') return BK.TERMINAL;
  if (t.aeroway === 'hangar' || b === 'hangar') return BK.HANGAR;
  switch (b) {
    case 'house': case 'detached': case 'semidetached_house': case 'bungalow': case 'villa': case 'terrace': case 'farm': case 'cabin': case 'static_caravan': return BK.HOUSE;
    case 'residential': case 'dormitory': return BK.RESIDENTIAL;
    case 'apartments': case 'condominium': return BK.APARTMENTS;
    case 'commercial': return BK.COMMERCIAL;
    case 'retail': case 'supermarket': case 'kiosk': case 'mall': return BK.RETAIL;
    case 'office': return BK.OFFICE;
    case 'industrial': case 'manufacture': return BK.INDUSTRIAL;
    case 'warehouse': case 'storage_tank': return BK.WAREHOUSE;
    case 'church': case 'cathedral': case 'chapel': case 'mosque': case 'synagogue': case 'temple': case 'religious': return BK.CHURCH;
    case 'school': case 'university': case 'college': case 'kindergarten': return BK.SCHOOL;
    case 'hospital': return BK.HOSPITAL;
    case 'hotel': return BK.HOTEL;
    case 'parking': return BK.PARKING;
    case 'shed': case 'hut': case 'greenhouse': return BK.SHED;
    case 'garage': case 'garages': case 'carport': return BK.GARAGE;
    case 'roof': case 'canopy': return BK.ROOF;
    case 'civic': case 'public': case 'government': case 'fire_station': case 'police': case 'townhall': case 'library': case 'museum': return BK.CIVIC;
    case 'stadium': case 'sports_centre': case 'sports_hall': case 'grandstand': return BK.STADIUM;
    case 'train_station': case 'transportation': return BK.TRANSPORT;
    case 'construction': return BK.CONSTRUCTION;
    case 'service': case 'transformer_tower': return BK.SERVICE;
  }
  if (am === 'parking') return BK.PARKING;
  if (am === 'place_of_worship') return BK.CHURCH;
  if (am === 'school' || am === 'university') return BK.SCHOOL;
  if (am === 'hospital') return BK.HOSPITAL;
  if (t.tourism === 'hotel') return BK.HOTEL;
  if (t.shop) return BK.RETAIL;
  if (t.office) return BK.OFFICE;
  return BK.OTHER;
}

export function roofShape(t: Tags): number {
  switch (t['roof:shape']) {
    case 'flat': return ROOF.FLAT;
    case 'gabled': case 'side_hipped': case 'saltbox': case 'gambrel': return ROOF.GABLED;
    case 'hipped': case 'half-hipped': case 'mansard': return ROOF.HIPPED;
    case 'pyramidal': return ROOF.PYRAMIDAL;
    case 'dome': case 'onion': return ROOF.DOME;
    case 'skillion': case 'lean_to': return ROOF.SKILLION;
    case 'round': return ROOF.ROUND;
  }
  return ROOF.UNKNOWN;
}

/** Height (m) with the source: real tag, levels x 3.2, or a default by kind and footprint area. */
export function buildingHeight(t: Tags, kind: number, area: number): { h: number; min: number; levels: number; src: 'height' | 'levels' | 'default' } {
  const lv = num(t['building:levels']);
  const minLv = num(t['building:min_level']);
  let min = num(t.min_height);
  if (!(min >= 0)) min = minLv >= 0 ? minLv * 3.2 : 0;
  const h = num(t.height);
  if (h > 0 && h < 600) return { h, min, levels: lv > 0 ? lv : Math.round(h / 3.2), src: 'height' };
  if (lv > 0 && lv < 150) return { h: lv * 3.2 + (kind === BK.HOUSE ? 1.5 : 0.6), min, levels: lv, src: 'levels' };
  let d: number;
  switch (kind) {
    case BK.HOUSE: d = area > 400 ? 7 : 5; break;
    case BK.SHED: case BK.GARAGE: d = 3; break;
    case BK.ROOF: d = 5; break;
    case BK.APARTMENTS: d = area > 2500 ? 26 : area > 800 ? 13 : 8; break;
    case BK.RESIDENTIAL: d = area > 2500 ? 18 : area > 600 ? 9 : 5; break;
    case BK.OFFICE: d = area > 2000 ? 28 : 12; break;
    case BK.HOTEL: d = area > 1500 ? 30 : 14; break;
    case BK.COMMERCIAL: case BK.RETAIL: d = area > 5000 ? 9 : 6; break;
    case BK.INDUSTRIAL: case BK.WAREHOUSE: d = area > 3000 ? 10 : 7; break;
    case BK.HANGAR: d = 16; break;
    case BK.TERMINAL: d = 18; break;
    case BK.CHURCH: d = 12; break;
    case BK.SCHOOL: case BK.CIVIC: case BK.HOSPITAL: d = area > 3000 ? 14 : 9; break;
    case BK.PARKING: d = 15; break;
    case BK.STADIUM: d = 25; break;
    default: d = area > 2000 ? 9 : area > 300 ? 6 : 4;
  }
  return { h: d, min, levels: Math.max(1, Math.round(d / 3.2)), src: 'default' };
}

/** nearest palette slot for building:colour (0 = none) — see leonia gen COLOUR_BLOCKS */
export function colourCode(c: string | undefined): number {
  if (!c) return 0;
  const named: Record<string, number> = { white: 1, grey: 2, gray: 2, beige: 3, cream: 3, yellow: 4, pink: 5, red: 6, brown: 7, blue: 8, lightblue: 8, green: 9, teal: 9, black: 10, orange: 11, tan: 3 };
  if (named[c.toLowerCase()]) return named[c.toLowerCase()];
  const m = /^#?([0-9a-f]{6})$/i.exec(c);
  if (!m) return 0;
  const v = parseInt(m[1], 16), r = v >> 16, g = (v >> 8) & 255, b = v & 255;
  const l = (r + g + b) / 3;
  if (l > 220) return 1; if (l < 50) return 10;
  if (Math.abs(r - g) < 20 && Math.abs(g - b) < 20) return 2;
  if (r > g && r > b) return g > 150 ? (b > 150 ? 5 : 4) : (g > 90 ? 11 : 6);
  if (b > r && b >= g) return 8;
  return 9;
}

export function roadClass(t: Tags): number {
  const h = t.highway, rw = t.railway, ae = t.aeroway, mm = t.man_made;
  if (ae === 'runway') return RC.RUNWAY;
  if (ae === 'taxiway' || ae === 'taxilane') return RC.TAXIWAY;
  if (mm === 'pier') return RC.PIER;
  if (mm === 'breakwater' || mm === 'groyne') return RC.BREAKWATER;
  if (rw) {
    if (t.disused || t.abandoned || rw === 'abandoned' || rw === 'disused' || rw === 'razed' || rw === 'proposed' || rw === 'construction' || rw === 'platform') return 0;
    if (t.service === 'yard' || t.service === 'spur' || t.service === 'siding') { if (rw === 'rail') return RC.RAIL; }
    switch (rw) { case 'rail': case 'narrow_gauge': return RC.RAIL; case 'light_rail': return RC.LIGHT_RAIL; case 'subway': return RC.SUBWAY; case 'tram': return RC.TRAM; case 'monorail': return RC.MONORAIL; }
    return 0;
  }
  if (!h || t.area === 'yes') return 0;
  switch (h) {
    case 'motorway': case 'motorway_link': return RC.MOTORWAY;
    case 'trunk': case 'trunk_link': return RC.TRUNK;
    case 'primary': case 'primary_link': return RC.PRIMARY;
    case 'secondary': case 'secondary_link': return RC.SECONDARY;
    case 'tertiary': case 'tertiary_link': return RC.TERTIARY;
    case 'unclassified': case 'road': return RC.UNCLASSIFIED;
    case 'residential': return RC.RESIDENTIAL;
    case 'living_street': return RC.LIVING;
    case 'service': return t.service === 'parking_aisle' || t.service === 'drive-through' ? 0 : RC.SERVICE;
    case 'pedestrian': return RC.PEDESTRIAN;
    case 'footway': case 'bridleway': return RC.FOOTWAY;
    case 'cycleway': return RC.CYCLEWAY;
    case 'path': return RC.PATH;
    case 'steps': return RC.STEPS;
    case 'track': return RC.TRACK;
  }
  return 0;
}

const LANE_W: Record<number, number> = { [RC.MOTORWAY]: 3.7, [RC.TRUNK]: 3.6, [RC.PRIMARY]: 3.5, [RC.SECONDARY]: 3.4, [RC.TERTIARY]: 3.3 };
/** lanes, carriageway width (m), flags */
export function roadDims(t: Tags, cls: number): { lanes: number; width: number; flags: number } {
  let flags = 0;
  const oneway = t.oneway === 'yes' || t.oneway === '1' || t.oneway === '-1' || t.junction === 'roundabout' || (cls === RC.MOTORWAY && t.oneway !== 'no');
  if (oneway) flags |= RF.ONEWAY;
  if (t.bridge && t.bridge !== 'no') flags |= RF.BRIDGE;
  if (t.tunnel && t.tunnel !== 'no' && t.tunnel !== 'building_passage') flags |= RF.TUNNEL;
  if (t.covered === 'yes' && cls >= 30) flags |= RF.TUNNEL;
  if (/_link$/.test(t.highway ?? '')) flags |= RF.LINK;
  if (t.embankment === 'yes' || t.causeway === 'yes') flags |= RF.CAUSEWAY;
  const tw = num(t.width);
  let lanes = Math.round(num(t.lanes));
  if (cls >= 30 && cls < 40) { const tracks = Math.max(1, Math.round(num(t.tracks)) || 1); return { lanes: tracks, width: tracks * 4, flags }; }
  if (cls === RC.RUNWAY) return { lanes: 0, width: tw > 10 ? tw : 45, flags };
  if (cls === RC.TAXIWAY) return { lanes: 0, width: tw > 5 ? tw : 20, flags };
  if (cls === RC.PIER) return { lanes: 0, width: tw > 0 && tw < 40 ? tw : 3, flags };
  if (cls === RC.BREAKWATER) return { lanes: 0, width: tw > 0 && tw < 40 ? tw : 5, flags };
  if (cls >= RC.PEDESTRIAN) {
    const w = tw > 0 && tw < 30 ? tw : cls === RC.PEDESTRIAN ? 6 : cls === RC.TRACK ? 3 : cls === RC.CYCLEWAY ? 2.5 : 2;
    return { lanes: 0, width: w, flags };
  }
  if (!(lanes > 0 && lanes < 16)) {
    const link = (flags & RF.LINK) !== 0;
    switch (cls) {
      case RC.MOTORWAY: lanes = link ? 1 : oneway ? 3 : 6; break;
      case RC.TRUNK: lanes = link ? 1 : oneway ? 2 : 4; break;
      case RC.PRIMARY: lanes = link ? 1 : oneway ? 2 : 4; break;
      case RC.SECONDARY: lanes = link ? 1 : oneway ? 2 : 3; break;
      case RC.TERTIARY: lanes = oneway ? 1 : 2; break;
      case RC.SERVICE: lanes = 1; break;
      default: lanes = oneway ? 1 : 2;
    }
  }
  const lw = LANE_W[cls] ?? (cls === RC.SERVICE ? 4 : 3.1);
  let width = tw > 2 && tw < 60 ? tw : lanes * lw + (cls === RC.MOTORWAY || cls === RC.TRUNK ? 2.5 : cls <= RC.SECONDARY ? 1 : 0);
  if (cls === RC.SERVICE && !(tw > 2)) width = Math.max(4, lanes * 3.5);
  const urban = cls >= RC.PRIMARY && cls <= RC.LIVING;
  const sw = t.sidewalk;
  if (urban && sw !== 'no' && sw !== 'none' && sw !== 'separate' && !(flags & RF.LINK)) flags |= RF.SIDEWALK;
  return { lanes, width, flags };
}

export function poiCat(t: Tags): number {
  const am = t.amenity, sh = t.shop, to = t.tourism, le = t.leisure, h = t.highway;
  if (t.natural === 'tree') return /palm|arecaceae|sabal|roystonea|cocos/i.test(`${t.genus ?? ''}${t.species ?? ''}${t.taxon ?? ''}${t['leaf_type'] ?? ''}`) ? POI.PALM : POI.TREE;
  if (h === 'street_lamp') return POI.LAMP;
  if (h === 'traffic_signals') return POI.SIGNAL;
  if (h === 'bus_stop' || t.public_transport === 'platform') return POI.BUS_STOP;
  if (h === 'crossing') return POI.CROSSING;
  if (t.railway === 'station' || t.railway === 'halt') return POI.STATION;
  if (t.man_made === 'lighthouse') return POI.LIGHTHOUSE;
  if (t.man_made === 'tower' || t.man_made === 'water_tower' || t.man_made === 'mast') return POI.TOWER;
  switch (am) {
    case 'bench': return POI.BENCH;
    case 'fountain': return POI.FOUNTAIN;
    case 'restaurant': case 'fast_food': case 'food_court': case 'ice_cream': return POI.FOOD;
    case 'cafe': return POI.CAFE;
    case 'bar': case 'pub': case 'biergarten': return POI.BAR;
    case 'nightclub': return POI.NIGHTCLUB;
    case 'fuel': return POI.FUEL;
    case 'bank': case 'atm': return POI.BANK;
    case 'pharmacy': return POI.PHARMACY;
    case 'hospital': case 'clinic': return POI.HOSPITAL;
    case 'school': case 'kindergarten': case 'college': case 'university': return POI.SCHOOL;
    case 'police': return POI.POLICE;
    case 'fire_station': return POI.FIRE;
    case 'place_of_worship': return POI.WORSHIP;
    case 'cinema': case 'theatre': case 'arts_centre': return POI.CINEMA;
    case 'library': return POI.LIBRARY;
    case 'post_office': return POI.POST;
    case 'toilets': return POI.TOILETS;
  }
  if (sh) return sh === 'supermarket' || sh === 'convenience' ? POI.SUPERMARKET : POI.SHOP;
  if (to === 'hotel' || to === 'motel' || to === 'guest_house' || to === 'hostel') return POI.HOTEL;
  if (to === 'museum' || to === 'gallery') return POI.MUSEUM;
  if (to === 'attraction' || to === 'artwork') return POI.ATTRACTION;
  if (to === 'viewpoint') return POI.VIEWPOINT;
  if (le === 'playground') return POI.PLAYGROUND;
  if (le === 'marina' || le === 'slipway') return POI.MARINA;
  return 0;
}

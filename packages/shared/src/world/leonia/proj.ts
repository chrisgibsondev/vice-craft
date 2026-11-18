/**
 * Leonia projection: local equirectangular projection centred on the stage-1 area.
 * Game x grows east, z grows south, 1 block = 1 metre. The origin (x=0, z=0) is the
 * north-west corner of the bbox. Both directions are linear, so the mapping is exact
 * and reversible (up to float precision):
 *   x = (lon - lonW) * mPerDegLon,   z = (latN - lat) * mPerDegLat
 *   lon = lonW + x / mPerDegLon,      lat = latN - z / mPerDegLat
 * mPerDeg* are the WGS84 metres-per-degree at the centre latitude (25.79 N). Scale
 * error versus true ground distance stays under 0.2 % across the 24 km area.
 */
const latS = 25.68, latN = 25.90, lonW = -80.33, lonE = -80.11;
const latC = (latS + latN) / 2;
const phi = (latC * Math.PI) / 180;
/** WGS84 metres per degree of latitude / longitude at latitude phi (standard series) */
const mPerDegLat = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi) - 0.0023 * Math.cos(6 * phi);
const mPerDegLon = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi) + 0.118 * Math.cos(5 * phi);

export const LEONIA_PROJ = {
  latS, latN, lonW, lonE, latC, mPerDegLat, mPerDegLon,
  /** world size in blocks (metres) */
  width: Math.ceil((lonE - lonW) * mPerDegLon),
  depth: Math.ceil((latN - latS) * mPerDegLat),
};

export function lonLatToWorld(lon: number, lat: number): [number, number] {
  return [(lon - lonW) * mPerDegLon, (latN - lat) * mPerDegLat];
}
export function worldToLonLat(x: number, z: number): [number, number] {
  return [lonW + x / mPerDegLon, latN - z / mPerDegLat];
}

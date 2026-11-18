/**
 * Minimal OSM PBF reader (no dependencies): decodes OSMHeader/OSMData blobs (zlib or raw),
 * dense nodes, ways and relations, and yields Overpass-JSON-shaped elements with geometry
 * so the extract step treats both sources the same. The file is untrusted data: it is only
 * parsed (bounded reads, no evaluation).
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

export interface OsmEl {
  type: 'node' | 'way' | 'relation';
  id: number;
  tags?: Record<string, string>;
  lat?: number; lon?: number;
  nodes?: number[];
  /** node ids aligned with geometry (nodes outside the bbox are dropped from both) */
  gnodes?: number[];
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; ref: number; role: string; geometry?: { lat: number; lon: number }[] }[];
}

class PB {
  o: number;
  constructor(readonly b: Uint8Array, start = 0, readonly end = b.length) { this.o = start; }
  more() { return this.o < this.end; }
  v(): number {
    let r = 0, s = 1, c: number;
    do { c = this.b[this.o++]; r += (c & 0x7f) * s; s *= 128; } while (c & 0x80 && this.o < this.end);
    return r;
  }
  sv(): number { const u = this.v(); return u % 2 ? -(u + 1) / 2 : u / 2; }
  key(): [number, number] { const k = this.v(); return [Math.floor(k / 8), k & 7]; }
  bytes(): [number, number] { const n = this.v(); const s = this.o; this.o += n; return [s, s + n]; }
  skip(wt: number) {
    if (wt === 0) this.v(); else if (wt === 1) this.o += 8; else if (wt === 2) { const n = this.v(); this.o += n; } else if (wt === 5) this.o += 4;
    else throw new Error('bad wire type ' + wt);
  }
  packed(signed: boolean): number[] {
    const [s, e] = this.bytes(); const p = new PB(this.b, s, e); const out: number[] = [];
    while (p.more()) out.push(signed ? p.sv() : p.v());
    return out;
  }
}

/** bbox (degrees) keeps only nodes inside it, ways touching a kept node and relations with a kept member */
export function readPbf(file: string, bbox?: { s: number; w: number; n: number; e: number }): { nodes: OsmEl[]; ways: OsmEl[]; relations: OsmEl[] } {
  const keepNode = (lat: number, lon: number) => !bbox || (lat >= bbox.s && lat <= bbox.n && lon >= bbox.w && lon <= bbox.e);
  const nodeIndex = new Map<number, number>();
  const keptWays = new Set<number>();
  const buf = new Uint8Array(readFileSync(file));
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const td = new TextDecoder();
  const nodeIds: number[] = [], nodeLat: number[] = [], nodeLon: number[] = [];
  const tagged: OsmEl[] = [];
  const ways: OsmEl[] = [];
  const relations: OsmEl[] = [];
  let o = 0;
  while (o < buf.length) {
    const hlen = dv.getUint32(o); o += 4;
    const hp = new PB(buf, o, o + hlen);
    let type = '', dataSize = 0;
    while (hp.more()) { const [f, wt] = hp.key(); if (f === 1) { const [s, e] = hp.bytes(); type = td.decode(buf.subarray(s, e)); } else if (f === 3) dataSize = hp.v(); else hp.skip(wt); }
    o += hlen;
    const bp = new PB(buf, o, o + dataSize);
    let data: Uint8Array | null = null;
    while (bp.more()) {
      const [f, wt] = bp.key();
      if (f === 1) { const [s, e] = bp.bytes(); data = buf.subarray(s, e); }
      else if (f === 3) { const [s, e] = bp.bytes(); data = new Uint8Array(inflateSync(buf.subarray(s, e))); }
      else bp.skip(wt);
    }
    o += dataSize;
    if (type !== 'OSMData' || !data) continue;
    // PrimitiveBlock
    const pb = new PB(data);
    let strings: string[] = [];
    const groups: [number, number][] = [];
    let gran = 100, latOff = 0, lonOff = 0;
    while (pb.more()) {
      const [f, wt] = pb.key();
      if (f === 1) { const [s, e] = pb.bytes(); const sp = new PB(data, s, e); strings = []; while (sp.more()) { const [ff, w2] = sp.key(); if (ff === 1) { const [a, b] = sp.bytes(); strings.push(td.decode(data.subarray(a, b))); } else sp.skip(w2); } }
      else if (f === 2) groups.push(pb.bytes());
      else if (f === 17) gran = pb.v();
      else if (f === 19) latOff = pb.v();
      else if (f === 20) lonOff = pb.v();
      else pb.skip(wt);
    }
    const toDeg = (v: number, off: number) => (off + gran * v) * 1e-9;
    for (const [gs, ge] of groups) {
      const gp = new PB(data, gs, ge);
      while (gp.more()) {
        const [f, wt] = gp.key();
        if (f === 2) { // DenseNodes
          const [s, e] = gp.bytes(); const dp = new PB(data, s, e);
          let ids: number[] = [], lats: number[] = [], lons: number[] = [], kv: number[] = [];
          while (dp.more()) {
            const [ff, w2] = dp.key();
            if (ff === 1) ids = dp.packed(true); else if (ff === 8) lats = dp.packed(true); else if (ff === 9) lons = dp.packed(true); else if (ff === 10) kv = dp.packed(false); else dp.skip(w2);
          }
          let id = 0, la = 0, lo = 0, k = 0;
          for (let i = 0; i < ids.length; i++) {
            id += ids[i]; la += lats[i]; lo += lons[i];
            const lat = toDeg(la, latOff), lon = toDeg(lo, lonOff);
            const keep = keepNode(lat, lon);
            if (keep) { nodeIndex.set(id, nodeIds.length); nodeIds.push(id); nodeLat.push(lat); nodeLon.push(lon); }
            if (kv.length) {
              let tags: Record<string, string> | undefined;
              while (k < kv.length && kv[k] !== 0) { if (keep) (tags ??= {})[strings[kv[k]]] = strings[kv[k + 1]]; k += 2; }
              k++;
              if (tags) tagged.push({ type: 'node', id, lat, lon, tags });
            }
          }
        } else if (f === 1) { // plain Node
          const [s, e] = gp.bytes(); const np = new PB(data, s, e);
          let id = 0, la = 0, lo = 0; let keys: number[] = [], vals: number[] = [];
          while (np.more()) { const [ff, w2] = np.key(); if (ff === 1) id = np.sv(); else if (ff === 2) keys = np.packed(false); else if (ff === 3) vals = np.packed(false); else if (ff === 8) la = np.sv(); else if (ff === 9) lo = np.sv(); else np.skip(w2); }
          const lat = toDeg(la, latOff), lon = toDeg(lo, lonOff);
          if (!keepNode(lat, lon)) continue;
          nodeIndex.set(id, nodeIds.length); nodeIds.push(id); nodeLat.push(lat); nodeLon.push(lon);
          if (keys.length) { const tags: Record<string, string> = {}; keys.forEach((kk, i) => { tags[strings[kk]] = strings[vals[i]]; }); tagged.push({ type: 'node', id, lat, lon, tags }); }
        } else if (f === 3) { // Way
          const [s, e] = gp.bytes(); const wp = new PB(data, s, e);
          let id = 0; let keys: number[] = [], vals: number[] = [], refs: number[] = [];
          while (wp.more()) { const [ff, w2] = wp.key(); if (ff === 1) id = wp.v(); else if (ff === 2) keys = wp.packed(false); else if (ff === 3) vals = wp.packed(false); else if (ff === 8) refs = wp.packed(true); else wp.skip(w2); }
          const tags: Record<string, string> = {}; keys.forEach((kk, i) => { tags[strings[kk]] = strings[vals[i]]; });
          let r = 0; const nodes = refs.map((d) => (r += d));
          if (bbox && !nodes.some((n) => nodeIndex.has(n))) continue;
          keptWays.add(id);
          ways.push({ type: 'way', id, tags, nodes });
        } else if (f === 4) { // Relation
          const [s, e] = gp.bytes(); const rp = new PB(data, s, e);
          let id = 0; let keys: number[] = [], vals: number[] = [], roles: number[] = [], mids: number[] = [], types: number[] = [];
          while (rp.more()) { const [ff, w2] = rp.key(); if (ff === 1) id = rp.v(); else if (ff === 2) keys = rp.packed(false); else if (ff === 3) vals = rp.packed(false); else if (ff === 8) roles = rp.packed(false); else if (ff === 9) mids = rp.packed(true); else if (ff === 10) types = rp.packed(false); else rp.skip(w2); }
          const tags: Record<string, string> = {}; keys.forEach((kk, i) => { tags[strings[kk]] = strings[vals[i]]; });
          let m = 0;
          const members = mids.map((d, i) => ({ type: ['node', 'way', 'relation'][types[i]] ?? 'node', ref: (m += d), role: strings[roles[i]] ?? '' }));
          if (bbox && !members.some((mm) => mm.type === 'way' && keptWays.has(mm.ref))) continue;
          relations.push({ type: 'relation', id, tags, members });
        } else gp.skip(wt);
      }
    }
  }
  const wayGeom = new Map<number, { lat: number; lon: number }[]>();
  for (const w of ways) {
    const g: { lat: number; lon: number }[] = [];
    const gn: number[] = [];
    for (const n of w.nodes!) { const i = nodeIndex.get(n); if (i !== undefined) { g.push({ lat: nodeLat[i], lon: nodeLon[i] }); gn.push(n); } }
    w.geometry = g;
    w.gnodes = gn;
    wayGeom.set(w.id, g);
  }
  for (const r of relations) for (const m of r.members!) if (m.type === 'way') m.geometry = wayGeom.get(m.ref);
  return { nodes: tagged, ways, relations };
}

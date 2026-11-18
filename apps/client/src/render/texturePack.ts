/**
 * Texture pack loader: overlays the photographic material pack (apps/client/public/textures,
 * see its manifest for sources and licences) onto the block texture arrays. The pack is two
 * sheets of TILE px cells, albedo (sRGB) and material (RG normal, B roughness), baked from CC0
 * PBR scans. Tiles without a pack entry keep their procedural layer, so the arrays are always
 * complete even before (or without) the pack.
 */
import type * as THREE from 'three';
import { TILE_INDEX } from '@blockshore/shared';
import { TILE, matProps, writeLayer, type BlockAtlas } from './atlas';

interface PackManifest {
  pack: { tileSize: number; columns: number; albedo: string; material: string };
  tiles: Record<string, { index: number; repeat: number; variants?: number[] }>;
}

async function loadPixels(url: string): Promise<{ data: Uint8ClampedArray; width: number } | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(bmp, 0, 0);
    bmp.close();
    return { data: g.getImageData(0, 0, c.width, c.height).data, width: c.width };
  } catch { return null; }
}

export async function applyTexturePack(texture: THREE.Texture, base = import.meta.env.BASE_URL ?? '/'): Promise<number> {
  const atlas = (texture.userData as { atlas?: BlockAtlas }).atlas;
  if (!atlas) return 0;
  let manifest: PackManifest;
  try {
    const r = await fetch(`${base}textures/manifest.json`);
    if (!r.ok) return 0;
    manifest = await r.json();
  } catch { return 0; }
  if (!manifest.pack || manifest.pack.tileSize !== TILE) { console.warn('[blockshore] texture pack tile size mismatch, using procedural tiles'); return 0; }
  const [alb, mat] = await Promise.all([loadPixels(`${base}textures/${manifest.pack.albedo}`), loadPixels(`${base}textures/${manifest.pack.material}`)]);
  if (!alb || !mat) return 0;
  const albData = atlas.albedo.image.data as Uint8Array, matData = atlas.material.image.data as Uint8Array;
  const cols = manifest.pack.columns;
  const { layout } = atlas;
  let applied = 0;
  for (const [name, t] of Object.entries(manifest.tiles)) {
    const idx = TILE_INDEX[name];
    if (idx === undefined) continue;
    if (layout.repeat[idx] !== t.repeat) { console.warn(`[blockshore] pack tile ${name}: repeat ${t.repeat} ≠ ${layout.repeat[idx]}`); continue; }
    const gloss = Math.round(matProps(name).gloss * 255);
    const targets: [number, number][] = [[idx, t.index]];
    layout.variants[idx].forEach((layer, k) => targets.push([layer, t.variants?.[k] ?? t.index]));
    for (const [layer, cell] of targets) {
      const sx = (cell % cols) * TILE, sy = Math.floor(cell / cols) * TILE;
      writeLayer(albData, layer, alb.data, alb.width, sx, sy, 255);
      writeLayer(matData, layer, mat.data, mat.width, sx, sy, gloss);
    }
    applied++;
  }
  atlas.albedo.needsUpdate = true;
  atlas.material.needsUpdate = true;
  return applied;
}

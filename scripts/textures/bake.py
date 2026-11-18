"""
BLOCKSHORE realistic-voxel tile baker.

Turns CC0 Poly Haven PBR maps (1K JPG, downloaded into <dl>) into 128x128 block tiles:
  albedo sheet  (sRGB, palette-matched to the game's colours)
  material sheet (R,G = tangent-space normal XY (OpenGL, +Y up), B = roughness)
Each tile covers REPEAT x REPEAT blocks (2 for photographic materials = 64 px per block).
Per-block graphics (road lines, joints, borders) are painted once per block quadrant.

usage: python -P -E bake.py <dl_dir> <out_dir>
"""
import json, math, os, sys
import numpy as np
from PIL import Image, ImageFilter

DL, OUT = sys.argv[1], sys.argv[2]
L = 128           # layer size in px
COLS = 16
rng = np.random.default_rng(7)
META = json.load(open(os.path.join(DL, 'meta.json')))

# ───────────────────────────────────────────── colour helpers
def s2l(c): c = np.clip(c, 0, 1); return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
def l2s(c): c = np.clip(c, 0, 1); return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)
def hexc(h): return np.array([(h >> 16) & 255, (h >> 8) & 255, h & 255], float) / 255
def lum(lin): return lin[..., 0] * 0.2126 + lin[..., 1] * 0.7152 + lin[..., 2] * 0.0722

# ───────────────────────────────────────────── source loading
_cache = {}
def src(id_, rot=0):
    key = (id_, rot)
    if key in _cache: return _cache[key]
    d = os.path.join(DL, id_)
    def ld(n, mode):
        for ext in ('jpg', 'png'):
            p = os.path.join(d, f'{n}.{ext}')
            if os.path.exists(p): return Image.open(p).convert(mode)
        return None
    diff, nor, rough, ao, disp = ld('diff', 'RGB'), ld('nor', 'RGB'), ld('rough', 'L'), ld('ao', 'L'), ld('disp', 'L')
    S = diff.size[0]
    def arr(im, ch=3):
        if im is None: return None
        im = im.resize((S, S), Image.BICUBIC) if im.size != (S, S) else im
        return np.asarray(im).astype(np.float32) / 255
    a = {'diff': arr(diff), 'nor': arr(nor), 'rough': arr(rough), 'ao': arr(ao), 'disp': arr(disp)}
    if a['nor'] is not None: a['nor'] = a['nor'] * 2 - 1
    if rot:
        for k in a:
            if a[k] is None: continue
            a[k] = np.rot90(a[k], rot).copy()
        if a['nor'] is not None:
            # rotate the vectors too: image-space CCW rotation of (right, up) components
            n = a['nor']
            for _ in range(rot % 4):
                n = np.stack([-n[..., 1], n[..., 0], n[..., 2]], -1)
            a['nor'] = n
    _cache[key] = a
    return a

def down(arr, size):
    """area-downsample a float array (H,W[,C]) to size x size, wrap-safe (box filter in linear)."""
    H = arr.shape[0]
    if H == size: return arr.copy()
    if H % size == 0:
        f = H // size
        if arr.ndim == 2: return arr.reshape(size, f, size, f).mean((1, 3))
        return arr.reshape(size, f, size, f, arr.shape[2]).mean((1, 3))
    im = Image.fromarray(arr.astype(np.float32)) if arr.ndim == 2 else None
    if arr.ndim == 2: return np.asarray(im.resize((size, size), Image.LANCZOS))
    return np.stack([np.asarray(Image.fromarray(arr[..., c].astype(np.float32)).resize((size, size), Image.LANCZOS)) for c in range(arr.shape[2])], -1)

def sharpen(lin, amt=0.35):
    """wrap-around unsharp mask (keeps tiles seamless)"""
    blur = (np.roll(lin, 1, 0) + np.roll(lin, -1, 0) + np.roll(lin, 1, 1) + np.roll(lin, -1, 1) + lin * 4) / 8
    return lin + (lin - blur) * amt

class Tile:
    """working tile: linear albedo (L,L,3), normal (L,L,3), roughness (L,L)"""
    def __init__(self, alb, nor, rough):
        self.alb, self.nor, self.rough = alb, nor, rough

def material(id_, size=L, rot=0, reps=1, crop=None):
    """photo source → Tile at `size`, the full (tileable) texture repeated reps x reps"""
    a = src(id_, rot)
    def prep(x):
        if x is None: return None
        if crop:  # (fraction) take a top-left crop; only for non-tiling use
            n = int(x.shape[0] * crop); x = x[:n, :n]
        x = down(x, size // reps)
        if reps > 1: x = np.tile(x, (reps, reps) + ((1,) if x.ndim == 3 else ()))
        return x
    alb = prep(s2l(a['diff']))
    if a['ao'] is not None: alb = alb * (0.45 + 0.55 * prep(a['ao']))[..., None]
    nor = prep(a['nor']) if a['nor'] is not None else np.dstack([np.zeros((size, size)), np.zeros((size, size)), np.ones((size, size))])
    rough = prep(a['rough']) if a['rough'] is not None else np.full((size, size), 0.7)
    return Tile(alb, nor, rough)

def recolor(t: Tile, target, contrast=1.0, chroma=0.35, sharp=0.3):
    lin = t.alb
    m = lin.reshape(-1, 3).mean(0)
    Lm = lum(m)
    d = np.maximum(lum(lin), 1e-4) / max(Lm, 1e-4)
    c = (lin / np.maximum(m, 1e-4)) / d[..., None]
    tgt = s2l(hexc(target))
    out = tgt * (d ** contrast)[..., None] * np.clip(c, 0.2, 5) ** chroma
    t.alb = sharpen(out, sharp) if sharp else out
    return t

def keep(t: Tile, sharp=0.3, gain=1.0, sat=1.0):
    lin = t.alb * gain
    if sat != 1.0:
        g = lum(lin)[..., None]; lin = g + (lin - g) * sat
    t.alb = sharpen(lin, sharp) if sharp else lin
    return t

def nstrength(t: Tile, s):
    n = t.nor.copy(); n[..., :2] *= s
    t.nor = n / np.linalg.norm(n, axis=-1, keepdims=True)
    return t

def rmap(t: Tile, mean, spread=1.0):
    r = t.rough
    t.rough = np.clip(mean + (r - r.mean()) * spread, 0.03, 1.0)
    return t

# ───────────────────────────────────────────── procedural helpers (all periodic)
def pnoise(freq, size=L, seed=None, octaves=1):
    g = np.random.default_rng(seed)
    out = np.zeros((size, size)); amp = 1; tot = 0
    for o in range(octaves):
        f = freq * (2 ** o)
        grid = g.random((f, f)).astype(np.float32)
        big = np.tile(grid, (3, 3))
        im = Image.fromarray(big).resize((size * 3, size * 3), Image.BICUBIC)
        out += np.asarray(im)[size:2 * size, size:2 * size] * amp
        tot += amp; amp *= 0.5
    out /= tot
    return (out - out.min()) / max(out.max() - out.min(), 1e-6)

def h2n(h, strength):
    """height (L,L) → normal, wrap-around central differences; +Y = up (row 0 is the top)"""
    dx = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5
    dy = (np.roll(h, 1, 0) - np.roll(h, -1, 0)) * 0.5   # up = towards row 0
    n = np.dstack([-dx * strength, -dy * strength, np.ones_like(h)])
    return n / np.linalg.norm(n, axis=-1, keepdims=True)

def add_normal(t: Tile, nadd):
    """combine a detail normal (UDN blend)"""
    n = np.dstack([t.nor[..., 0] + nadd[..., 0], t.nor[..., 1] + nadd[..., 1], t.nor[..., 2]])
    t.nor = n / np.linalg.norm(n, axis=-1, keepdims=True)
    return t

def quad(fn, size=L, reps=2):
    """per-block mask painted once per block of a REPEAT=2 layer: fn(u, v) with u,v in [0,1) inside a block, v=0 top"""
    b = size // reps
    yy, xx = np.mgrid[0:b, 0:b].astype(np.float32)
    m = fn((xx + 0.5) / b, (yy + 0.5) / b)
    return np.tile(m, (reps, reps))

def paint(t: Tile, mask, color, rough=None, wear=0.0, seed=1):
    """paint a colour through a mask, worn by the substrate's own luminance"""
    m = np.clip(mask, 0, 1)
    if wear:
        n = pnoise(16, seed=seed, octaves=3)
        m = m * np.clip((n - wear) * 3 + 0.6, 0, 1)
    detail = lum(t.alb); detail = detail / detail.mean()
    col = s2l(hexc(color))[None, None, :] * (0.82 + 0.18 * np.clip(detail, 0, 2))[..., None]
    t.alb = t.alb * (1 - m[..., None]) + col * m[..., None]
    if rough is not None: t.rough = t.rough * (1 - m) + rough * m
    # paint fills the micro relief a little
    t.nor = t.nor * (1 - m[..., None] * 0.5) + np.array([0, 0, 1.0]) * m[..., None] * 0.5
    t.nor /= np.linalg.norm(t.nor, axis=-1, keepdims=True)
    return t

def groove(t: Tile, mask, depth=0.5, dark=0.55, strength=6):
    """cut a groove (joints, seams) into a tile: darken + normal from the mask edge"""
    m = np.clip(mask, 0, 1)
    t.alb = t.alb * (1 - m * (1 - dark))[..., None]
    soft = (m + np.roll(m, 1, 0) + np.roll(m, -1, 0) + np.roll(m, 1, 1) + np.roll(m, -1, 1)) / 5
    add_normal(t, h2n(-soft * depth, strength))
    return t

def variant(t_base: Tile, t_other: Tile, seed):
    """seamless variant: replace the interior with another texture through a noisy mask that is 0 at the borders"""
    yy, xx = np.mgrid[0:L, 0:L].astype(np.float32) / L
    edge = np.minimum(np.minimum(xx, 1 - xx), np.minimum(yy, 1 - yy))
    n = pnoise(4, seed=seed, octaves=2)
    m = np.clip((edge - 0.08) / 0.12, 0, 1) * np.clip((n - 0.25) * 2.5, 0, 1)
    m = np.clip(m, 0, 1)
    w = np.sqrt((1 - m) ** 2 + m ** 2)
    def blend(a, b):
        ma, mb = a.mean((0, 1)), b.mean((0, 1))
        mm = ma * (1 - (m if a.ndim == 2 else m[..., None])) + mb * (m if a.ndim == 2 else m[..., None])
        if a.ndim == 2: return mm + ((a - ma) * (1 - m) + (b - mb) * m) / w
        return mm + ((a - ma) * (1 - m)[..., None] + (b - mb) * m[..., None]) / w[..., None]
    out = Tile(blend(t_base.alb, t_other.alb), blend(t_base.nor, t_other.nor), blend(t_base.rough, t_other.rough))
    out.nor /= np.linalg.norm(out.nor, axis=-1, keepdims=True)
    return out

def roll(t: Tile, fx, fy, rot=0):
    sx, sy = int(L * fx), int(L * fy)
    def r(a):
        a = np.roll(np.roll(a, sy, 0), sx, 1)
        return np.rot90(a, rot).copy() if rot else a
    nor = r(t.nor)
    for _ in range(rot % 4): nor = np.stack([-nor[..., 1], nor[..., 0], nor[..., 2]], -1)
    return Tile(r(t.alb), nor, r(t.rough))

def copy(t: Tile): return Tile(t.alb.copy(), t.nor.copy(), t.rough.copy())

# ───────────────────────────────────────────── tile definitions
TILES = {}       # name → Tile
SOURCES = {}     # name → [poly haven ids]
REPEAT = {}      # name → blocks per layer
def put(name, t, ids, rep=2):
    TILES[name] = t; SOURCES[name] = ids; REPEAT[name] = rep

def mat(id_, target=None, contrast=1.0, chroma=0.35, rough=0.8, rspread=1.0, nstr=1.0, rot=0, reps=1, sharp=0.3, gain=1.0, sat=1.0):
    t = material(id_, rot=rot, reps=reps)
    if target is not None: recolor(t, target, contrast, chroma, sharp)
    else: keep(t, sharp, gain, sat)
    rmap(t, rough, rspread); nstrength(t, nstr)
    return t

# ground
put('asphalt', mat('asphalt_04', 0x46494f, contrast=1.5, chroma=0.15, rough=0.6, rspread=1.4, nstr=1.6, sharp=0.5), ['asphalt_04'])
put('runway', mat('clean_asphalt', 0x4d5158, contrast=1.2, chroma=0.15, rough=0.7, nstr=1.2), ['clean_asphalt'])
put('concrete', mat('concrete_floor_02', 0xb4b3ae, contrast=0.7, chroma=0.15, rough=0.85, nstr=1.0), ['concrete_floor_02'])
sw = mat('concrete_floor_02', 0xc4c0b7, contrast=0.38, chroma=0.12, rough=0.82, nstr=0.9, rot=1)
joint = quad(lambda u, v: ((u < 0.035) | (v < 0.035)).astype(float))
put('sidewalk', groove(sw, joint, depth=0.6, dark=0.6, strength=5), ['concrete_floor_02'])
put('sand', mat('sand_01', 0xe6d29e, contrast=0.75, chroma=0.3, rough=0.92, nstr=1.6), ['sand_01'])
put('dirt', mat('dirt', 0x86603f, contrast=1.0, chroma=0.35, rough=0.9, nstr=1.4), ['dirt'])
put('path', mat('park_dirt', 0xb39770, contrast=0.9, chroma=0.3, rough=0.9, nstr=1.3), ['park_dirt'])
put('mud', mat('brown_mud_02', 0x584430, contrast=1.0, chroma=0.3, rough=0.45, rspread=1.5, nstr=1.2), ['brown_mud_02'])
put('gravel', mat('gravel_floor_02', 0x8c867c, contrast=1.2, chroma=0.4, rough=0.9, nstr=2.0), ['gravel_floor_02'])
put('stone', mat('rock_surface', 0x8e9196, contrast=1.1, chroma=0.2, rough=0.85, nstr=1.6), ['rock_surface'])
put('cobble', mat('cobblestone_floor_08', 0x8f897f, contrast=1.1, chroma=0.35, rough=0.8, nstr=1.5), ['cobblestone_floor_08'])
put('granite', mat('granite_tile_03', 0x9c8f88, contrast=1.3, chroma=0.5, rough=0.45, nstr=1.0), ['granite_tile_03'])
put('limestone', mat('large_sandstone_blocks_01', 0xdcd2b8, contrast=0.9, chroma=0.3, rough=0.85, nstr=1.4), ['large_sandstone_blocks_01'])
put('marble', mat('marble_01', 0xeceae4, contrast=0.8, chroma=0.25, rough=0.25, rspread=0.6, nstr=0.8), ['marble_01'])
put('counter_top', mat('marble_01', 0xe9e5dc, contrast=0.6, chroma=0.2, rough=0.22, nstr=0.6, rot=1), ['marble_01'])
put('mossy_stone_top', mat('mossy_rock', None, rough=0.85, nstr=1.5, gain=1.15, sat=1.1), ['mossy_rock'])
ms = mat('rock_surface', 0x858a8c, contrast=1.1, chroma=0.2, rough=0.85, nstr=1.6)
moss_t = mat('mossy_rock', None, rough=0.9, nstr=1.5, gain=1.15, sat=1.15)
yy, xx = np.mgrid[0:L, 0:L] / L
drip = quad(lambda u, v: (v < 0.22 + 0.12 * np.sin(u * 37.0) * np.sin(u * 13.0 + 1)).astype(float))
drip = np.clip(drip * (0.4 + pnoise(8, seed=3)), 0, 1)
ms.alb = ms.alb * (1 - drip[..., None]) + moss_t.alb * drip[..., None]
put('mossy_stone', ms, ['rock_surface', 'mossy_rock'])

# grass
GRASS = 0x5a9440
def grass(target=GRASS, contrast=1.9, chroma=0.55, clumps=True):
    t = mat('leafy_grass', target, contrast=contrast, chroma=chroma, rough=0.85, nstr=1.6)
    if clumps:
        a = pnoise(3, seed=41, octaves=3); b = pnoise(5, seed=43, octaves=2)
        t.alb = t.alb * (0.78 + 0.42 * a)[..., None]
        dry = np.clip((b - 0.55) * 3, 0, 1)[..., None]
        t.alb = t.alb * (1 - dry * 0.35) + t.alb * np.array([1.35, 1.1, 0.6]) * dry * 0.35
    return t
put('grass_top', grass(), ['leafy_grass'])
fw = grass(0x5fb24a, 0.8, 0.25, clumps=False)
stripes = quad(lambda u, v: ((np.floor(u * 2) % 2) == 0).astype(float))
fw.alb *= (1 + (stripes - 0.5) * 0.14)[..., None]
put('fairway', fw, ['leafy_grass'])
pt = mat('sparse_grass', 0x78cc58, contrast=0.55, chroma=0.15, rough=0.8, nstr=0.6)
pt.alb *= (1 + (quad(lambda u, v: (((np.floor(u * 2) + np.floor(v * 2)) % 2) == 0).astype(float)) - 0.5) * 0.08)[..., None]
put('putting', pt, ['sparse_grass'])
# grass side: dirt with a hanging grass fringe at the top of every block (REPEAT 1 per block row → painted per quadrant)
gs = mat('dirt', 0x86603f, contrast=1.0, chroma=0.35, rough=0.9, nstr=1.4)
gt = grass()
B = L // 2
cols = np.arange(L)
edge = (0.16 + 0.07 * np.sin(cols / L * 2 * np.pi * 6 + 1.3) + 0.05 * np.sin(cols / L * 2 * np.pi * 17))
edge += (pnoise(32, seed=11)[0] - 0.5) * 0.12
fr = np.zeros((L, L))
for q in range(2):
    v = (np.arange(B)[:, None] + 0.5) / B
    fr[q * B:(q + 1) * B] = (v < edge[None, :]).astype(float)
shadow = np.clip(np.roll(fr, 3, 0) - fr, 0, 1)
gs.alb = gs.alb * (1 - shadow[..., None] * 0.45)
gs.alb = gs.alb * (1 - fr[..., None]) + gt.alb * fr[..., None]
gs.nor = gs.nor * (1 - fr[..., None]) + gt.nor * fr[..., None]
gs.rough = gs.rough * (1 - fr) + gt.rough * fr
add_normal(gs, h2n(fr * 0.6, 3))
put('grass_side', gs, ['dirt', 'leafy_grass'])
sg = mat('sand_01', 0xd8c896, contrast=0.75, chroma=0.3, rough=0.9, nstr=1.4)
patch = np.clip((pnoise(6, seed=5, octaves=3) - 0.45) * 4, 0, 1)
g2 = grass(0x5a8a48)
sg.alb = sg.alb * (1 - patch[..., None]) + g2.alb * patch[..., None]
sg.nor = sg.nor * (1 - patch[..., None]) + g2.nor * patch[..., None]
put('seagrass', sg, ['sand_01', 'leafy_grass'])
fm = mat('dry_mud_field_001', 0x5f4430, contrast=1.0, chroma=0.3, rough=0.92, nstr=1.2)
furrow = quad(lambda u, v: 0.5 + 0.5 * np.cos(v * 2 * np.pi * 4))
fm.alb *= (0.72 + 0.4 * furrow)[..., None]
add_normal(fm, h2n(furrow * 1.0, 4))
put('farmland', fm, ['dry_mud_field_001'])

# road paint (per block stripe, like the original tiles; lines run along the tile's v axis)
for name, col, w0, w1 in (('line_white', 0xeeeeea, 2 / 16, 14 / 16), ('line_yellow', 0xf2c230, 4 / 16, 12 / 16)):
    t = copy(TILES['asphalt'])
    m = quad(lambda u, v: np.clip((u - w0) * 64, 0, 1) * np.clip((w1 - u) * 64, 0, 1))
    put(name, paint(t, m, col, rough=0.45, wear=0.12, seed=sum(map(ord, name))), ['asphalt_04'])
hp = mat('concrete_floor_02', 0x4c5058, contrast=0.8, chroma=0.1, rough=0.7, nstr=1.0)
def hmask(u, v):
    d = np.hypot(u - 0.5, v - 0.5)
    ring = (np.abs(d - 0.44) < 0.035)
    H = (((np.abs(u - 0.32) < 0.035) | (np.abs(u - 0.68) < 0.035)) & (np.abs(v - 0.5) < 0.24)) | ((np.abs(v - 0.5) < 0.035) & (np.abs(u - 0.5) < 0.18))
    return ring.astype(float), H.astype(float)
ring = quad(lambda u, v: hmask(u, v)[0]); Hm = quad(lambda u, v: hmask(u, v)[1])
paint(hp, ring, 0xf5cf2a, rough=0.45, wear=0.25, seed=4); paint(hp, Hm, 0xf4f4f0, rough=0.45, wear=0.25, seed=5)
put('helipad', hp, ['concrete_floor_02'])
for name, col in (('court_green', 0x3f8a5a), ('court_blue', 0x3a6ab0), ('court_red', 0xb05a40), ('court_line', 0xf0f0ee)):
    put(name, mat('clean_asphalt', col, contrast=0.5, chroma=0.1, rough=0.6, nstr=0.8), ['clean_asphalt'])

# walls
STUCCO = {'stucco_white': 0xf1eee6, 'stucco_pink': 0xf4a7b9, 'stucco_teal': 0x6fd3c7, 'stucco_yellow': 0xf6d77a, 'stucco_peach': 0xf6bf98,
          'red_stucco': 0xd9443a, 'police_blue': 0x2c4f9e, 'stucco_cream': 0xf0e1c0, 'stucco_ochre': 0xdca85a, 'stucco_lavender': 0xc9b4ea,
          'stucco_mint': 0xa8ecd0, 'stucco_sky': 0x9cd4f4}
for name, col in STUCCO.items():
    st_ = mat('white_stucco', col, contrast=3.0, chroma=0.0, rough=0.9, nstr=2.0, sharp=0.5)
    st_.alb *= (0.94 + 0.1 * pnoise(6, seed=len(name), octaves=3))[..., None]
    put(name, st_, ['white_stucco'])
put('brick', mat('red_brick_03', 0xa9553f, contrast=1.0, chroma=0.55, rough=0.85, nstr=1.6), ['red_brick_03'])
put('brick_dark', mat('dark_brick_wall', 0x6e3a2e, contrast=1.0, chroma=0.5, rough=0.85, nstr=1.6), ['dark_brick_wall'])
put('brick_tan', mat('red_brick_03', 0xc9a46a, contrast=0.9, chroma=0.3, rough=0.85, nstr=1.6), ['red_brick_03'])
put('castle_stone', mat('castle_brick_02_white', 0xe6deee, contrast=0.8, chroma=0.15, rough=0.85, nstr=1.4), ['castle_brick_02_white'])
put('pool_tile', mat('blue_floor_tiles_01', 0x6ac4e2, contrast=0.9, chroma=0.3, rough=0.18, rspread=0.5, nstr=1.2), ['blue_floor_tiles_01'])
tf = mat('checkered_pavement_tiles', None, rough=0.3, rspread=0.6, nstr=0.8)
g = lum(tf.alb); gm = g.mean()
tf.alb = np.clip(((g - gm) * 2.6 + 0.32)[..., None] * np.array([1.0, 1.0, 0.98]), 0.02, 0.9)
put('tile_floor', tf, ['checkered_pavement_tiles'])

# roofs (rows horizontal)
put('roof_tile', mat('clay_roof_tiles_02', 0xbd5f3c, contrast=1.0, chroma=0.45, rough=0.75, nstr=1.6, rot=1), ['clay_roof_tiles_02'])
put('slate_roof', mat('roof_slates_02', 0x4a4f58, contrast=1.1, chroma=0.2, rough=0.7, nstr=1.6), ['roof_slates_02'])
for name, col in (('shingle_brown', 0x7a5640), ('shingle_grey', 0x6c7076), ('shingle_green', 0x4a6a4a)):
    put(name, mat('grey_roof_tiles', col, contrast=1.1, chroma=0.2, rough=0.85, nstr=1.6), ['grey_roof_tiles'])
put('cedar_shingle', mat('roof_slates_02', 0x6a4630, contrast=1.1, chroma=0.3, rough=0.85, nstr=1.6), ['roof_slates_02'])
cr = mat('corrugated_iron_02', 0x6fae9a, contrast=1.0, chroma=0.2, rough=0.5, nstr=1.4)
pat = np.clip((pnoise(8, seed=21, octaves=3) - 0.55) * 4, 0, 1)
cr.alb = cr.alb * (1 - pat[..., None] * 0.5) + s2l(hexc(0x9ad0bc)) * pat[..., None] * 0.5
put('copper_roof', cr, ['corrugated_iron_02'])

# metals
put('tin_roof', mat('corrugated_iron_02', 0xb4bcc2, contrast=1.0, chroma=0.3, rough=0.42, nstr=1.5), ['corrugated_iron_02'])
for name, col in (('container_red', 0xb33a2c), ('container_blue', 0x2b62ae), ('container_green', 0x2f7a4a), ('container_orange', 0xe07a2a),
                  ('container_white', 0xdcdcd6), ('container_yellow', 0xe8c030)):
    put(name, mat('container_side', col, contrast=1.15, chroma=0.3, rough=0.5, nstr=1.5), ['container_side'])
put('silo_blue', mat('corrugated_iron_02', 0x34598f, contrast=1.0, chroma=0.2, rough=0.5, nstr=1.4), ['corrugated_iron_02'])
put('shutter', mat('painted_metal_shutter', 0x8f98a2, contrast=1.1, chroma=0.2, rough=0.5, nstr=1.6), ['painted_metal_shutter'])
put('metal', mat('metal_plate', 0x8f9aa6, contrast=0.8, chroma=0.15, rough=0.42, nstr=1.2, reps=2), ['metal_plate'])
ss = mat('concrete_floor_02', 0xd2cbbb, contrast=0.7, chroma=0.2, rough=0.85, nstr=1.0)
band = quad(lambda u, v: (np.abs(v - 0.94) < 0.04).astype(float) + (np.abs((u * 2) % 1 - 0.5) > 0.48).astype(float) * 0.6)
put('silo_stave', groove(ss, band, depth=0.5, dark=0.75), ['concrete_floor_02'])

# wood
put('plank', mat('wood_planks', 0xb98a55, contrast=1.0, chroma=0.4, rough=0.7, nstr=1.4), ['wood_planks'])
put('dark_plank', mat('dark_wooden_planks', 0x6b4a2e, contrast=1.0, chroma=0.4, rough=0.65, nstr=1.4), ['dark_wooden_planks'])
put('dock', mat('plank_flooring_03', 0x9e7b56, contrast=1.1, chroma=0.35, rough=0.8, nstr=1.8), ['plank_flooring_03'])
put('boat_deck', mat('wood_planks', 0xc8a070, contrast=0.9, chroma=0.3, rough=0.55, nstr=1.2), ['wood_planks'])
for name, col in (('siding_mint', 0x9fe0c4), ('siding_coral', 0xf28b7a), ('siding_lemon', 0xf5e07a), ('siding_sky', 0x8cc8ee),
                  ('siding_lilac', 0xc7a6e0), ('siding_white', 0xf2f0ea)):
    put(name, mat('weathered_plank_siding', col, contrast=0.75, chroma=0.0, rough=0.7, nstr=1.6), ['weathered_plank_siding'])
put('barn_red', mat('weathered_plank_siding', 0xa8322a, contrast=0.9, chroma=0.1, rough=0.8, nstr=1.6, rot=1), ['weathered_plank_siding'])
put('bark', mat('bark_brown_02', 0x5b4330, contrast=1.2, chroma=0.3, rough=0.9, nstr=2.0), ['bark_brown_02'])
put('palm_log', mat('palm_tree_bark', 0x9b7a4e, contrast=1.1, chroma=0.3, rough=0.9, nstr=1.8), ['palm_tree_bark'])
lw = mat('bark_brown_02', 0x8a5a33, contrast=1.0, chroma=0.3, rough=0.85, nstr=1.4, rot=1)
logs = quad(lambda u, v: np.sin(((v * 3) % 1) * np.pi) ** 0.6, reps=2)
gap = quad(lambda u, v: (((v * 3) % 1) < 0.06).astype(float))
lw.alb *= (0.55 + 0.5 * logs)[..., None]
add_normal(lw, h2n(logs * 1.2, 5))
put('log_wall', groove(lw, gap, depth=0.4, dark=0.4), ['bark_brown_02'])
lu = mat('fine_grained_wood', 0xd8b070, contrast=0.9, chroma=0.3, rough=0.7, nstr=1.0, rot=1)
put('lumber_side', groove(lu, quad(lambda u, v: (((v * 4) % 1) > 0.94).astype(float)), depth=0.5, dark=0.6), ['fine_grained_wood'])
lt = mat('plywood', 0xe2c088, contrast=0.9, chroma=0.3, rough=0.75, nstr=1.0)
put('lumber_top', groove(lt, quad(lambda u, v: ((((u * 4) % 1) > 0.93) | (((v * 4) % 1) > 0.93)).astype(float)), depth=0.5, dark=0.5), ['plywood'])
cra = mat('wood_planks', 0xb58b52, contrast=1.0, chroma=0.4, rough=0.75, nstr=1.2)
frame = quad(lambda u, v: ((u < 0.12) | (u > 0.88) | (v < 0.12) | (v > 0.88) | (np.abs(u - v) < 0.07)).astype(float))
cra.alb *= (1 - frame * 0.25)[..., None]
add_normal(cra, h2n(frame * 1.0, 5))
put('crate', groove(cra, quad(lambda u, v: ((np.abs(u - 0.12) < 0.012) | (np.abs(u - 0.88) < 0.012) | (np.abs(v - 0.12) < 0.012) | (np.abs(v - 0.88) < 0.012)).astype(float)), depth=0.3, dark=0.6), ['wood_planks'])

def endgrain(target_core, target_ring, bark_col, rings=9, bark=0.08, seed=1, rough=0.8):
    def f(u, v):
        x, y = u - 0.5, v - 0.5
        d = np.hypot(x, y) * 2
        a = np.arctan2(y, x)
        wob = 0.03 * np.sin(a * 5 + seed) + 0.02 * np.sin(a * 11 + seed * 2)
        r = (d + wob) * rings
        ringv = 0.5 + 0.5 * np.cos(r * 2 * np.pi)
        return d, ringv, a
    b = L // 2
    yy, xx = np.mgrid[0:b, 0:b].astype(np.float32)
    d, ringv, a = f((xx + 0.5) / b, (yy + 0.5) / b)
    core = s2l(hexc(target_core)); ringc = s2l(hexc(target_ring)); bk = s2l(hexc(bark_col))
    col = core * (1 - ringv[..., None] * 0.6) + ringc * ringv[..., None] * 0.6
    crack = (np.abs(np.sin(a * 3 + seed)) < 0.025) & (d < 0.85)
    col = np.where(crack[..., None], col * 0.5, col)
    isb = d > (1 - bark * 2)
    col = np.where(isb[..., None], bk * (0.7 + 0.3 * np.random.default_rng(seed).random((b, b)))[..., None], col)
    h = np.where(isb, 0.4, ringv * 0.15) - crack * 0.3
    col = np.tile(col, (2, 2, 1)); h = np.tile(h, (2, 2))
    n = pnoise(32, seed=seed, octaves=2)
    col *= (0.92 + 0.16 * n)[..., None]
    t = Tile(col, h2n(h + n * 0.1, 3), np.full((L, L), rough))
    return t
put('log_top', endgrain(0xc49a64, 0x9a7044, 0x5a3a22, seed=2), [])
put('bark_top', endgrain(0xb08a5a, 0x8a6440, 0x4a3524, rings=7, bark=0.1, seed=3), [])
put('palm_log_top', endgrain(0xc6a36b, 0xa07a48, 0x7a5a36, rings=14, bark=0.06, seed=4), [])
hs = mat('thatch_roof_angled', 0xdcb85a, contrast=1.0, chroma=0.3, rough=0.95, nstr=1.6, rot=1)
put('hay_side', hs, ['thatch_roof_angled'])
ht = mat('thatch_roof_angled', 0xd4b056, contrast=1.0, chroma=0.3, rough=0.95, nstr=1.6)
swirl = quad(lambda u, v: 0.5 + 0.5 * np.cos(np.hypot(u - 0.5, v - 0.5) * 2 * np.pi * 5))
ht.alb *= (0.8 + 0.3 * swirl)[..., None]
put('hay_top', ht, ['thatch_roof_angled'])

# fabric
cp = mat('dirty_carpet', 0x8c2f39, contrast=1.0, chroma=0.2, rough=0.95, nstr=1.2, reps=2)
put('carpet', paint(cp, quad(lambda u, v: ((np.abs(u - 0.09) < 0.035) | (np.abs(u - 0.91) < 0.035) | (np.abs(v - 0.09) < 0.035) | (np.abs(v - 0.91) < 0.035)).astype(float)), 0xd6a846, rough=0.9), ['dirty_carpet'])
for name, col in (('awning_red', 0xd8463e), ('awning_green', 0x3f9a5a), ('awning_blue', 0x3d6fc0), ('awning_yellow', 0xf0c33c)):
    aw = mat('rough_linen', 0xf2efe6, contrast=1.3, chroma=0.0, rough=0.9, nstr=1.4, reps=4)
    st = quad(lambda u, v: ((np.floor(u * 4) % 2) == 1).astype(float))
    paint(aw, st, col, rough=0.85)
    hem = quad(lambda u, v: (v > 0.9).astype(float))
    aw.alb *= (1 - hem * 0.22)[..., None]
    add_normal(aw, h2n(quad(lambda u, v: np.clip((v - 0.86) * 10, 0, 1) * 0.5 + 0.05 * np.sin(u * 2 * np.pi * 4)), 3))
    put(name, aw, ['rough_linen'])
put('sofa_top', mat('rough_linen', 0xd8664f, contrast=1.2, chroma=0.1, rough=0.95, nstr=1.4, reps=4), ['rough_linen'])

# corals
for name, col in (('coral_pink', 0xf07aa0), ('coral_orange', 0xf09a4a), ('coral_purple', 0x9a5ad0)):
    put(name, mat('coral_ground_02', col, contrast=1.4, chroma=0.2, rough=0.8, nstr=2.0), ['coral_ground_02'])

# ───────────────────────────────────────────── variants for large ground surfaces
VARIANTS = {}
ROLLS = [(0.5, 0.5, 1), (0.27, 0.71, 2)]
for name, n in (('grass_top', 2), ('sand', 2), ('dirt', 2), ('asphalt', 2), ('sidewalk', 2), ('concrete', 1), ('stone', 1), ('gravel', 1), ('mud', 1), ('path', 1), ('runway', 1)):
    vs = []
    for k in range(n):
        fx, fy, rot = ROLLS[k]
        if name in ('asphalt', 'runway'): rot = 0
        if name == 'sidewalk': fx, fy, rot = (0.5, 0.5, 1) if k == 0 else (0.5, 0.0, 2)
        other = roll(TILES[name], fx, fy, rot=rot)
        vs.append(variant(TILES[name], other, seed=100 + k * 7 + len(name)))
    VARIANTS[name] = vs

# ───────────────────────────────────────────── write sheets
order = list(TILES.keys())
entries = []
for name in order:
    entries.append((name, TILES[name]))
    for k, v in enumerate(VARIANTS.get(name, [])):
        entries.append((f'{name}#{k + 1}', v))
rows = (len(entries) + COLS - 1) // COLS
alb_sheet = np.zeros((rows * L, COLS * L, 3), np.uint8)
mat_sheet = np.zeros((rows * L, COLS * L, 3), np.uint8)
layout = {}
for i, (name, t) in enumerate(entries):
    x, y = (i % COLS) * L, (i // COLS) * L
    alb_sheet[y:y + L, x:x + L] = (l2s(t.alb) * 255 + 0.5).astype(np.uint8)
    n = t.nor
    mat_sheet[y:y + L, x:x + L, 0] = np.clip((n[..., 0] * 0.5 + 0.5) * 255 + 0.5, 0, 255)
    mat_sheet[y:y + L, x:x + L, 1] = np.clip((n[..., 1] * 0.5 + 0.5) * 255 + 0.5, 0, 255)
    mat_sheet[y:y + L, x:x + L, 2] = np.clip(t.rough * 255 + 0.5, 0, 255)
    layout[name] = i
os.makedirs(OUT, exist_ok=True)
Image.fromarray(alb_sheet).save(os.path.join(OUT, 'blocks_albedo.webp'), quality=92, method=6)
Image.fromarray(mat_sheet).save(os.path.join(OUT, 'blocks_material.webp'), lossless=True, method=6)
Image.fromarray(alb_sheet).save(os.path.join(OUT, '_preview_albedo.png'))

used = sorted({s for v in SOURCES.values() for s in v})
manifest = {
    'pack': {
        'name': 'BLOCKSHORE realistic-voxel materials',
        'tileSize': L, 'pxPerBlock': L // 2, 'columns': COLS,
        'albedo': 'blocks_albedo.webp', 'material': 'blocks_material.webp',
        'materialChannels': 'R,G = tangent-space normal XY (OpenGL, +Y up); B = roughness',
        'notes': 'Photographic tiles are downsampled, palette-matched and composited from CC0 Poly Haven PBR maps. '
                 'Road paint, joints, borders, end grain and other per-block graphics are original procedural work. '
                 'Tiles not listed here are painted procedurally at runtime (src/render/atlas.ts).',
    },
    'sources': {s: {'name': META[s]['name'], 'author': ', '.join(META[s]['authors']), 'license': 'CC0 1.0',
                    'url': META[s]['url'], 'site': 'Poly Haven'} for s in used},
    'tiles': {name: {'index': layout[name], 'repeat': REPEAT[name], 'variants': [layout[f'{name}#{k + 1}'] for k in range(len(VARIANTS.get(name, [])))],
                     'sources': SOURCES[name]} for name in order},
}
json.dump(manifest, open(os.path.join(OUT, 'manifest.json'), 'w'), indent=1)
print(len(entries), 'tiles', rows, 'rows')
for f in ('blocks_albedo.webp', 'blocks_material.webp'):
    print(f, os.path.getsize(os.path.join(OUT, f)) // 1024, 'KB')

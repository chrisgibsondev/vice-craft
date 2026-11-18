"""Download 1K JPG maps (diffuse, GL normal, roughness, AO) for a list of Poly Haven texture ids.
Usage: python -I fetch.py <dl_dir> id1 id2 ...   (data only; nothing downloaded is executed)"""
import json, os, sys, urllib.request

dl = sys.argv[1]
ids = sys.argv[2:]
UA = {'User-Agent': 'texture-fetch/1.0'}

def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        return r.read()

meta_path = os.path.join(dl, 'meta.json')
meta = json.load(open(meta_path)) if os.path.exists(meta_path) else {}
for i in ids:
    d = os.path.join(dl, i)
    os.makedirs(d, exist_ok=True)
    try:
        files = json.loads(get(f'https://api.polyhaven.com/files/{i}'))
        info = json.loads(get(f'https://api.polyhaven.com/info/{i}'))
    except Exception as e:
        print('FAIL', i, e); continue
    meta[i] = {'name': info.get('name'), 'authors': list((info.get('authors') or {}).keys()),
               'dimensions': info.get('dimensions'), 'url': f'https://polyhaven.com/a/{i}'}
    want = {'Diffuse': 'diff', 'nor_gl': 'nor', 'Rough': 'rough', 'AO': 'ao', 'Displacement': 'disp'}
    for key, short in want.items():
        m = files.get(key)
        if not m or '1k' not in m: continue
        fmt = m['1k'].get('jpg') or m['1k'].get('png')
        if not fmt: continue
        url = fmt['url']
        ext = url.rsplit('.', 1)[-1]
        out = os.path.join(d, f'{short}.{ext}')
        if os.path.exists(out): continue
        try:
            open(out, 'wb').write(get(url))
        except Exception as e:
            print('FAIL', i, key, e)
    print('ok', i, meta[i]['dimensions'])
json.dump(meta, open(meta_path, 'w'), indent=1)

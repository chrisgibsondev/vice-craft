"""
Sound mix for BLOCKSHORE (run from the repo root: python scripts/audio-mix.py).

1. Normalises every sfx file to -18 LUFS (short clips by RMS), peak-limited to -1 dBFS,
   so files no longer differ by 20 dB. Originals are kept in .data/sfx-originals/ (first run only).
2. Sets each sound's manifest "volume" from one mix table: the loudness it should reach in the game
   (LUFS at close range, master 100%) given how loud the game asks for it (typical call volume).
   Reference: the car radio plays at about -20 LUFS (songs at -14 on a 50% radio slider).
"""
import json, os, re, shutil, subprocess, sys, concurrent.futures as cf

ROOT = os.path.join('apps', 'client', 'public')
MAN = os.path.join(ROOT, 'audio', 'manifest.json')
ORIG = os.path.join('.data', 'sfx-originals')
NORM = -18.0

# id: (target LUFS in game, typical call volume used by the code)
MIX = {
    # vehicles: your own engine sits right under the radio
    'engine_car': (-20, 0.6), 'engine_sports': (-19, 0.6), 'engine_moto': (-20, 0.6), 'engine_boat': (-21, 0.6),
    'horn': (-17, 0.85), 'siren': (-20, 0.55), 'tire_screech': (-21, 0.6), 'tire_skid_short': (-20, 1),
    'crash': (-14, 0.8), 'crash_heavy': (-13, 0.85), 'crash_light': (-17, 0.8), 'metal_scrape': (-20, 0.8),
    'car_door': (-21, 0.7), 'car_door_open': (-21, 0.7), 'car_door_close': (-20, 0.75),
    'engine_start': (-19, 0.6), 'engine_stop': (-22, 0.45), 'gear_shift': (-27, 0.3), 'brake_squeal': (-21, 0.45),
    'wind_speed': (-25, 0.4), 'turbo_whoosh': (-22, 1), 'car_alarm': (-24, 0.4), 'boat_horn': (-16, 0.8),
    # weapons and combat: gunshots are the loudest thing in the game
    'pistol': (-12, 0.9), 'explosion': (-10, 1), 'hit': (-21, 0.6), 'punch': (-18, 0.8),
    'bullet_impact_concrete': (-23, 0.5), 'bullet_impact_metal': (-22, 0.5), 'bullet_impact_flesh': (-22, 0.5),
    'ricochet': (-23, 0.45), 'bullet_whiz': (-20, 0.6), 'gun_reload': (-22, 1), 'gun_empty': (-24, 1), 'shell_casing': (-30, 1),
    'body_fall': (-21, 1), 'hurt_grunt': (-20, 0.55), 'heartbeat': (-24, 0.35), 'wasted': (-15, 0.8), 'busted': (-16, 0.8),
    'glass_break': (-19, 0.6),
    # player movement and water
    'step_concrete': (-28, 1), 'step_grass': (-29, 1), 'step_wood': (-28, 1), 'step_sand': (-29, 1),
    'jump': (-27, 0.32), 'land': (-25, 0.5), 'splash': (-20, 0.6), 'big_splash': (-18, 0.8), 'swim': (-27, 0.35),
    'swim_stroke': (-25, 1), 'underwater': (-25, 0.5), 'water_climb_out': (-22, 0.6),
    # ambience beds (call volume = typical bed level) and distant one-shots: quiet, under everything
    'city_ambience': (-31, 0.5), 'waves': (-30, 0.5), 'wetland_ambience': (-31, 0.5), 'wind': (-32, 0.3), 'club_bass': (-24, 0.7),
    'crowd_chatter': (-32, 0.3), 'traffic_distant': (-33, 0.28), 'seagulls': (-32, 0.3), 'birds_park': (-33, 0.15),
    'helicopter': (-25, 1), 'construction': (-31, 1), 'fountain': (-31, 1), 'distant_sirens': (-33, 0.18),
    'dog_bark': (-29, 0.35), 'plane_flyover': (-30, 0.22), 'police_radio': (-30, 0.25),
    # heist / interaction
    'drill': (-20, 1), 'alarm': (-22, 0.3), 'safe_open': (-19, 1), 'vault_door': (-17, 1), 'keypad_beep': (-25, 1), 'hack_beep': (-25, 1),
    'safe_dial': (-24, 1), 'bag_pickup': (-21, 1), 'zipper': (-24, 1), 'cash_counting': (-24, 1), 'cash_register': (-21, 1),
    'door_open': (-24, 1), 'door_close': (-24, 1), 'door_creak': (-24, 1), 'pickup': (-22, 1), 'coins': (-22, 1),
    # UI and stings
    'ui_click': (-26, 0.55), 'ui_hover': (-30, 0.35), 'ui_back': (-27, 1), 'ui_error': (-24, 1), 'notify': (-24, 0.7),
    'cash': (-21, 1), 'checkpoint': (-20, 1), 'countdown_beep': (-21, 1), 'go_beep': (-19, 1),
    'mission_pass': (-16, 1), 'mission_fail': (-17, 1), 'mission_start': (-19, 0.55), 'objective': (-23, 0.5), 'rep_up': (-20, 1),
    'phone_ring': (-22, 1), 'phone_open': (-24, 0.5), 'phone_close': (-25, 0.45), 'phone_tap': (-28, 0.4),
    'radio_static': (-25, 0.35), 'wheel_whoosh': (-26, 0.4),
}

def measure(path):
    r = subprocess.run(['ffmpeg', '-hide_banner', '-nostats', '-i', path, '-af', 'ebur128=peak=true,volumedetect', '-f', 'null', '-'], capture_output=True, text=True)
    t = r.stderr
    I = re.findall(r'I:\s+(-?[\d.]+) LUFS', t)
    mean = re.findall(r'mean_volume:\s+(-?[\d.]+) dB', t)
    i = float(I[-1]) if I else -70.0
    # clips too short for the loudness gate: use RMS (about 3 dB above LUFS for typical effects)
    return i if i > -60 else (float(mean[-1]) - 3 if mean else -30.0)

def normalise(item):
    src = os.path.join(ROOT, item['file'])
    orig = os.path.join(ORIG, os.path.basename(item['file']))
    if not os.path.exists(orig): shutil.copy2(src, orig)
    level = measure(orig)
    gain = NORM - level
    tmp = src + '.tmp.mp3'
    ch = '2' if item.get('loop') and item['id'] in ('city_ambience', 'waves', 'wetland_ambience', 'crowd_chatter', 'traffic_distant', 'seagulls', 'birds_park', 'fountain', 'construction', 'club_bass', 'wind') else '1'
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', orig, '-af', f'volume={gain:.2f}dB,alimiter=limit=0.89:level=false',
                    '-ac', ch, '-ar', '44100', '-b:a', '128k', tmp], check=True)
    os.replace(tmp, src)
    return item['id'], level, measure(src)

def main():
    os.makedirs(ORIG, exist_ok=True)
    m = json.load(open(MAN, encoding='utf-8'))
    with cf.ThreadPoolExecutor(8) as ex:
        res = list(ex.map(normalise, m['sfx']))
    after = {i: a for i, _, a in res}
    missing = []
    for it in m['sfx']:
        t = MIX.get(it['id'])
        if not t: missing.append(it['id']); continue
        target, call = t
        vol = 10 ** ((target - after[it['id']]) / 20) / call
        it['volume'] = round(min(3.0, max(0.02, vol)), 3)
    json.dump(m, open(MAN, 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
    for i, b, a in sorted(res):
        print(f'{i:24s} {b:6.1f} -> {a:6.1f} LUFS   volume {next(x["volume"] for x in m["sfx"] if x["id"] == i)}')
    if missing: print('NO MIX ENTRY (volume unchanged):', ', '.join(missing))

if __name__ == '__main__':
    main()

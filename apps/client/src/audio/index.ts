/**
 * VICE CRAFT client audio engine (Web Audio API, no libraries).
 *
 * - Music and radio stream through HTMLAudioElement -> MediaElementAudioSourceNode.
 * - One-shots, loops and footsteps are decoded once and cached as AudioBuffers.
 * - Nothing throws when audio is blocked or a file is missing: problems are
 *   logged once and the engine keeps running.
 * - Intent is queued: music / radio / ambience requested before the AudioContext
 *   exists (or before the manifest loads) are applied as soon as they can be.
 */

export type Bus = 'music' | 'sfx' | 'voice' | 'radio';

export interface SfxOpts {
  x?: number;
  y?: number;
  z?: number;
  /** Multiplies the manifest volume. */
  volume?: number;
  /** Playback rate (pitch + speed). */
  rate?: number;
  /** Bus for one-shots; defaults to 'sfx'. */
  bus?: 'sfx' | 'voice';
}

export type LoopOpts = Omit<SfxOpts, 'bus'>;

export type Material = 'grass' | 'concrete' | 'wood' | 'sand';
export type AmbienceLevels = { city: number; waves: number; wetland: number; wind: number; club: number; crowd?: number; traffic?: number; gulls?: number; birds?: number };
export type VolumeSettings = { master: number; music: number; sfx: number; voice: number; radio: number };

interface ManifestItem {
  id: string;
  file: string;
  title?: string;
  artist?: string;
  loop?: boolean;
  volume?: number;
}
interface Manifest {
  music: ManifestItem[];
  sfx: ManifestItem[];
  /** car radio playlists by station key */
  radio?: Record<string, (ManifestItem & { durationSec?: number })[]>;
}
/** A car radio station. Every station plays a fixed rotation "live": the position follows the clock,
 *  so tuning in lands mid-song (like real radio) and every player hears the same thing. */
export interface Station { key: string; name: string; freq: string; genre: string; color: string; tracks: { id: string; dur: number }[] }
type BedName = keyof AmbienceLevels;

/** A streamed music/radio track. */
interface Track {
  el: HTMLAudioElement;
  node: MediaElementAudioSourceNode;
  gain: GainNode;
  base: number;
}
/** A live one-shot, tracked for the voice limit. */
interface Voice {
  src: AudioBufferSourceNode;
  nodes: AudioNode[];
  level: number; // estimated audible level, used to pick the quietest voice to drop
  start: number;
}
/** A looping source identified by a key (engines, sirens) or an ambience bed. */
interface Loop {
  id: string;
  gain: GainNode;
  panner: PannerNode | null;
  src: AudioBufferSourceNode | null; // null until the buffer has decoded
  base: number;
  rate: number;
  stopped: boolean;
}

const MAX_VOICES = 24;
/** Every effect file is normalised and its manifest volume comes from one mix table (scripts/audio-mix.py);
 *  a limiter on the master output keeps big moments (crashes, gunfights) from distorting. */
const SFX_BOOST = 1; // levels live in the manifest now (scripts/audio-mix.py)
const LOOP_BOOST = 1;
const DUCK_GAIN = 0.316; // -10 dB
const STEP_SLICE = 0.25; // seconds of a step_* clip used per footstep
const REF_DIST = 7;
const ROLLOFF = 1.2;
const MAX_DIST = 120;
const PRELOAD = ['ui_click', 'ui_hover', 'notify', 'cash', 'checkpoint', 'countdown_beep', 'go_beep', 'engine_car', 'car_door'];
const BEDS: Record<BedName, string> = {
  city: 'city_ambience',
  waves: 'waves',
  wetland: 'wetland_ambience',
  wind: 'wind',
  club: 'club_bass',
  crowd: 'crowd_chatter',
  traffic: 'traffic_distant',
  gulls: 'seagulls',
  birds: 'birds_park',
};
/** Original station names (fictional). Order = order on the radio wheel. */
const STATION_INFO: Record<string, { name: string; freq: string; genre: string; color: string }> = {
  pop: { name: 'LEO 101.1', freq: '101.1', genre: 'Pop hits', color: '#ff4fa3' },
  hiphop: { name: 'Bayfront 97.3', freq: '97.3', genre: 'Hip hop', color: '#ffb02e' },
  latin: { name: 'Calle Ocho 104.7', freq: '104.7', genre: 'Latin & reggaeton', color: '#ff6a3d' },
  synthwave: { name: 'Neon Coast 88.9', freq: '88.9', genre: 'Retro synthwave', color: '#b26bff' },
  house: { name: 'Deep Current 92.5', freq: '92.5', genre: 'House & electronic', color: '#2ee6d6' },
  smooth: { name: 'Velvet 99.5', freq: '99.5', genre: 'Smooth jazz & soul', color: '#e8c27a' },
  rock: { name: 'Reef Rock 106.3', freq: '106.3', genre: 'Rock', color: '#ff5050' },
};
/** On foot: occasional, faint background music with long silences in between. */
const BG_LEVEL = 0.2;
const BG_GAP: [number, number] = [50, 120];
const hashStr = (t: string): number => { let h = 2166136261; for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619); return h >>> 0; };

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
/** Fade a gain node to silence from its current value over `fade` seconds. */
const rampToZero = (node: GainNode, ctx: AudioContext, fade: number): void => {
  const g = node.gain;
  const now = ctx.currentTime;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(0, now + Math.max(fade, 0.01));
};
const hasPos = (o: LoopOpts): boolean => o.x !== undefined || o.y !== undefined || o.z !== undefined;

class AudioEngine {
  private ctx: AudioContext | null = null;
  private dead = false; // true if the AudioContext cannot be created at all
  private manifest: Manifest | null = null;
  private items = new Map<string, ManifestItem>();
  private gestureBound = false;
  private preloaded = false;
  private warned = new Set<string>();

  // Graph: buses -> (music, radio) -> duckNode -> master -> destination
  private master!: GainNode;
  private duckNode!: GainNode;
  private buses!: Record<Bus, GainNode>;
  private volumes: VolumeSettings = { master: 1, music: 1, sfx: 1, voice: 1, radio: 1 };
  private duckOn = false;

  // Decoded audio: null means the file failed to load (never retried).
  private buffers = new Map<string, AudioBuffer | null>();
  private pendingLoads = new Map<string, Promise<AudioBuffer | null>>();
  private onsetCache = new WeakMap<AudioBuffer, number[]>();

  private voices: Voice[] = [];
  private loops = new Map<string, Loop>();
  private beds = new Map<BedName, Loop>();
  private bedLevels: Required<AmbienceLevels> = { city: 0, waves: 0, wetland: 0, wind: 0, club: 0, crowd: 0, traffic: 0, gulls: 0, birds: 0 };
  private listener = { x: 0, y: 0, z: 0, yaw: 0 };

  // Music: intent is what the game asked for, playing is what is actually running.
  private musicIntent: string | null = null;
  private musicPlaying: string | null = null;
  private musicFade = 1.5;
  private musicTrack: Track | null = null;

  // Radio: plays only while inVehicle, on its own bus. stationIndex === stations.length means Off.
  private stations: Station[] = [];
  private stationIndex = (() => { try { return Number(localStorage.getItem('blockshore.radio') ?? 0) || 0; } catch { return 0; } })();
  private inVehicle = false;
  private radioPlaying: string | null = null; // station key
  private radioTrack: Track | null = null;
  private radioNow: { id: string; title: string; artist: string } | null = null;
  private musicScale = 1;

  // On-foot background music (faint, rotating, never the same track twice in a row)
  private bgOn = false;
  private bgTrack: Track | null = null;
  private bgLast = '';
  private bgNextAt = 0;

  /** Fetch the manifest. Safe to call before any user gesture. */
  async init(): Promise<void> {
    if (this.manifest) return;
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}audio/manifest.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const m = (await res.json()) as Partial<Manifest>;
      this.manifest = { music: m.music ?? [], sfx: m.sfx ?? [], radio: m.radio ?? {} };
    } catch (err) {
      this.warnOnce('manifest', `audio manifest unavailable: ${err}`);
      this.manifest = { music: [], sfx: [], radio: {} };
    }
    for (const it of [...this.manifest.music, ...this.manifest.sfx]) this.items.set(it.id, it);
    const radio = this.manifest.radio ?? {};
    for (const key of Object.keys(STATION_INFO)) {
      const list = radio[key] ?? [];
      if (!list.length) continue;
      for (const it of list) this.items.set(it.id, { ...it, loop: false });
      // fixed per-station rotation order (seeded shuffle) so stations never sound alike
      const tracks = list.map((it) => ({ id: it.id, dur: Math.max(30, it.durationSec ?? 180) }));
      let seed = hashStr(key);
      for (let i = tracks.length - 1; i > 0; i--) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; const j = seed % (i + 1); [tracks[i], tracks[j]] = [tracks[j], tracks[i]]; }
      this.stations.push({ key, ...STATION_INFO[key], tracks });
    }
    if (!this.stations.length) {
      // no radio library: one station from the roaming tracks
      const roam = this.manifest.music.filter((m) => m.id.startsWith('roam_'));
      if (roam.length) this.stations.push({ key: 'roam', name: 'Palm FM 95.5', freq: '95.5', genre: 'Mixed', color: '#2ee6d6', tracks: roam.map((r) => ({ id: r.id, dur: (r as { durationSec?: number }).durationSec ?? 180 })) });
    }
    if (this.stationIndex > this.stations.length || this.stationIndex < 0) this.stationIndex = 0;
    this.bindGestures();
    this.apply();
  }

  /** Call on a user gesture. Creates/resumes the AudioContext and starts queued intent. Idempotent. */
  unlock(): void {
    this.guard('unlock', () => {
      const ctx = this.ensureContext();
      if (!ctx) return;
      if (ctx.state === 'suspended') void ctx.resume().catch(() => this.warnOnce('resume', 'AudioContext resume was refused'));
      // Retry any current element that was blocked before the first gesture (not ones that ended).
      for (const t of [this.musicTrack, this.radioTrack, this.bgTrack]) {
        if (t && t.el.paused && !t.el.ended) void t.el.play().catch(() => undefined);
      }
      this.apply();
    });
  }

  setVolumes(v: VolumeSettings): void {
    this.volumes = {
      master: clamp01(v.master),
      music: clamp01(v.music),
      sfx: clamp01(v.sfx),
      voice: clamp01(v.voice),
      radio: clamp01(v.radio),
    };
    this.guard('setVolumes', () => this.applyVolumes(0.05));
  }

  /** Crossfade to a music id. null stops. Requesting the id already playing does nothing. */
  playMusic(id: string | null, opts: { fade?: number } = {}): void {
    if (id === this.musicIntent) return;
    this.musicIntent = id;
    this.musicFade = Math.max(0, opts.fade ?? 1.5);
    this.apply();
  }

  /** Scale the music bus: 1 = full (cutscenes), ~0.3 = faint background (on foot), 0 = silent. */
  setMusicScale(scale: number): void {
    const v = clamp01(scale);
    if (Math.abs(v - this.musicScale) < 0.01) return;
    this.musicScale = v;
    this.guard('musicScale', () => this.applyVolumes(0.6));
  }

  /**
   * On foot with nothing else playing: now and then a faint track (never the same one twice in a row),
   * then a long silence. Call every frame; cheap.
   */
  background(on: boolean): void {
    if (!this.ctx) { this.bgOn = on; return; }
    const now = performance.now() / 1000;
    if (on && !this.bgOn) this.bgNextAt = Math.max(this.bgNextAt, now + 12);
    this.bgOn = on;
    this.guard('background', () => {
      if (!on) { if (this.bgTrack) { this.fadeOutTrack(this.bgTrack, 2.5, this.ctx!); this.bgTrack = null; } return; }
      if (this.bgTrack || now < this.bgNextAt) return;
      const pool = [
        ...(this.manifest?.music ?? []).filter((m) => m.id.startsWith('roam_')).map((m) => m.id),
        ...this.stations.filter((st) => st.key === 'smooth' || st.key === 'synthwave').flatMap((st) => st.tracks.map((t) => t.id)),
      ].filter((id) => id !== this.bgLast);
      if (!pool.length) return;
      const id = pool[Math.floor(Math.random() * pool.length)];
      this.bgLast = id;
      const t = this.swapTrack(null, id, 'music', 4, { loop: false, level: BG_LEVEL, onEnded: () => {
        if (this.bgTrack === t) this.bgTrack = null;
        this.bgNextAt = performance.now() / 1000 + BG_GAP[0] + Math.random() * (BG_GAP[1] - BG_GAP[0]);
      } });
      this.bgTrack = t;
      // stop after ~2 minutes even if the track is longer, then the next silence starts
      if (!t) { this.bgNextAt = now + 30; return; }
      const started = t;
      setTimeout(() => { if (this.bgTrack === started && this.ctx) { this.fadeOutTrack(started, 6, this.ctx); this.bgTrack = null; this.bgNextAt = performance.now() / 1000 + BG_GAP[0] + Math.random() * (BG_GAP[1] - BG_GAP[0]); } }, 120_000);
    });
  }

  /** Lower music and radio by about 10 dB (smoothly), or restore them. */
  duck(on: boolean): void {
    this.duckOn = on;
    this.guard('duck', () => {
      if (this.ctx) this.duckNode.gain.setTargetAtTime(on ? DUCK_GAIN : 1, this.ctx.currentTime, 0.2);
    });
  }

  /** One-shot sound. Positional when any of x/y/z is given. */
  sfx(id: string, opts: SfxOpts = {}): void {
    if (!this.ctx) return;
    this.guard('sfx', () => this.withBuffer(id, (buf, item) => this.playVoice(buf, item, opts)));
  }

  /**
   * Create or update a looping source identified by key. Call every frame.
   * Positional mode is decided when the loop is created (x/y/z present then).
   */
  loop(key: string, id: string, opts: LoopOpts = {}): void {
    if (!this.ctx) return;
    this.guard('loop', () => {
      let l = this.loops.get(key);
      if (l && l.id !== id) {
        this.loops.delete(key);
        this.killLoop(l, 0.05);
        l = undefined;
      }
      if (!l) {
        l = this.makeLoop(id, 'sfx', hasPos(opts)) ?? undefined;
        if (l) l.base *= LOOP_BOOST;
        if (!l) return;
        this.loops.set(key, l);
      }
      this.updateLoop(l, opts, 0.03);
    });
  }

  stopLoop(key: string, fade = 0.25): void {
    const l = this.loops.get(key);
    if (!l) return;
    this.loops.delete(key);
    this.killLoop(l, fade);
  }

  /** Stop every keyed loop whose key is not in the set. Call once per frame after updating loops. */
  stopLoopsExcept(keys: Set<string>): void {
    for (const key of [...this.loops.keys()]) if (!keys.has(key)) this.stopLoop(key);
  }

  /** Listener pose. yaw 0 faces -z. */
  setListener(x: number, y: number, z: number, yaw: number): void {
    this.listener = { x, y, z, yaw };
    this.guard('listener', () => this.pushListener());
  }

  readonly radio = {
    next: (): string => this.changeStation(1),
    prev: (): string => this.changeStation(-1),
    /** stations in wheel order (Off is index stations.length) */
    list: (): Station[] => this.stations,
    index: (): number => this.stationIndex,
    select: (i: number): string => this.changeStation(i - this.stationIndex),
    current: (): string => this.stations[this.stationIndex]?.name ?? 'Radio off',
    nowPlaying: () => this.radioNow,
    setInVehicle: (inVehicle: boolean): void => {
      if (inVehicle === this.inVehicle) return;
      this.inVehicle = inVehicle;
      this.apply();
    },
  };

  // ───────────────────────────────────────────────────────── weather (synthesised: the library has no rain or thunder clips)
  private noiseBuf: AudioBuffer | null = null;
  private rainNodes: { out: GainNode; tone: BiquadFilterNode; hiss: GainNode; body: GainNode; roar: GainNode } | null = null;
  private thunderBufs: AudioBuffer[] = [];
  private lastWeatherSig = '';
  private lastWeatherAt = 0;

  private noise(ctx: AudioContext): AudioBuffer {
    if (this.noiseBuf) return this.noiseBuf;
    const n = ctx.sampleRate * 4, b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    // fade the seam so the loop does not click
    const f = 2048;
    for (let i = 0; i < f; i++) { const k = i / f; d[i] = d[i] * k + d[n - f + i] * (1 - k); }
    return (this.noiseBuf = b);
  }

  /**
   * Rain bed from filtered noise (hiss + body + low roar). level 0..1; wind 0..1 adds a little roar;
   * shelter 0..1 (roof overhead) or indoor muffles it.
   */
  weather(rain: number, wind: number, shelter: number, indoor: boolean): void {
    if (!this.ctx) return;
    const level = clamp01(rain);
    if (level <= 0.005 && !this.rainNodes) return;
    // called once per frame: only touch the audio graph when the target actually moved (or every 0.5 s),
    // otherwise five AudioParam automation events pile up per frame
    const nowMs = performance.now();
    const sig = `${Math.round(level * 100)}|${Math.round(clamp01(wind) * 100)}|${Math.round((indoor ? 1 : clamp01(shelter)) * 20)}|${indoor ? 1 : 0}`;
    if (sig === this.lastWeatherSig && nowMs - this.lastWeatherAt < 500) return;
    this.lastWeatherSig = sig; this.lastWeatherAt = nowMs;
    this.guard('weather', () => {
      const ctx = this.ctx!;
      if (!this.rainNodes) {
        const src = ctx.createBufferSource();
        src.buffer = this.noise(ctx); src.loop = true;
        const mk = (type: BiquadFilterType, f: number, q: number) => { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; return n; };
        const out = ctx.createGain(); out.gain.value = 0;
        const tone = mk('lowpass', 12000, 0.5);
        const hiss = ctx.createGain(), body = ctx.createGain(), roar = ctx.createGain();
        src.connect(mk('bandpass', 6200, 0.35)).connect(hiss).connect(tone);
        src.connect(mk('bandpass', 1500, 0.5)).connect(body).connect(tone);
        src.connect(mk('lowpass', 260, 0.7)).connect(roar).connect(tone);
        tone.connect(out).connect(this.buses.sfx);
        src.start();
        this.rainNodes = { out, tone, hiss, body, roar };
      }
      const r = this.rainNodes, t = ctx.currentTime;
      const muffle = indoor ? 1 : clamp01(shelter);
      const k = level * (1 - 0.55 * muffle);
      r.out.gain.setTargetAtTime(k * 0.09, t, 0.6); // heavy rain ≈ -26 LUFS: under the radio and the car, never a wall of noise
      r.hiss.gain.setTargetAtTime(0.35 + 0.65 * level, t, 0.6);
      r.body.gain.setTargetAtTime(0.55 + 0.25 * level, t, 0.6);
      r.roar.gain.setTargetAtTime(Math.max(0, level - 0.45) * 1.6 + clamp01(wind) * 0.15, t, 0.6);
      r.tone.frequency.setTargetAtTime(12000 - muffle * 11000 + (indoor ? 0 : 0), t, 0.4);
    });
  }

  /** Thunder: a synthesised crack + long rumble, heard `delaySec` after the flash; strength 0..1 (closer = louder and brighter). */
  thunder(strength: number, delaySec: number): void {
    if (!this.ctx) return;
    this.guard('thunder', () => {
      const ctx = this.ctx!;
      if (!this.thunderBufs.length) {
        const sr = 22050;
        for (let v = 0; v < 3; v++) {
          const len = sr * 7, b = ctx.createBuffer(1, len, sr), d = b.getChannelData(0);
          let lp = 0, lp2 = 0;
          const pulses = Array.from({ length: 6 }, (_, i) => ({ at: 0.15 + i * 0.5 + Math.random() * 0.6, amp: (1 - i * 0.13) * (0.5 + Math.random() * 0.5), dec: 0.6 + Math.random() * 0.9 }));
          for (let i = 0; i < len; i++) {
            const t = i / sr;
            let env = t < 0.012 ? t / 0.012 : Math.exp(-(t - 0.012) * 9) * 1.4; // initial crack
            for (const p of pulses) if (t > p.at) env += Math.exp(-(t - p.at) / p.dec) * p.amp * Math.min(1, (t - p.at) * 12) * 0.7;
            env *= Math.min(1, (7 - t) / 1.2);
            const cut = 0.55 * Math.exp(-t * 1.1) + 0.02; // darker as it rolls
            const x = Math.random() * 2 - 1;
            lp += (x - lp) * cut; lp2 += (lp - lp2) * Math.min(1, cut * 1.6);
            d[i] = lp2 * env * 1.7;
          }
          this.thunderBufs.push(b);
        }
      }
      const s = clamp01(strength);
      const src = ctx.createBufferSource();
      src.buffer = this.thunderBufs[Math.floor(Math.random() * this.thunderBufs.length)];
      src.playbackRate.value = 0.88 + Math.random() * 0.2;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 350 + s * 5500; lp.Q.value = 0.4;
      const g = ctx.createGain(); g.gain.value = 0.12 + s * 0.6;
      src.connect(lp).connect(g).connect(this.buses.sfx);
      src.start(ctx.currentTime + Math.max(0, Math.min(12, delaySec)));
    });
  }

  /** Crossfaded ambient beds, levels 0..1. */
  ambience(levels: AmbienceLevels): void {
    for (const name of Object.keys(BEDS) as BedName[]) this.bedLevels[name] = clamp01(levels[name] ?? 0);
    this.guard('ambience', () => this.syncBeds());
  }

  /** One short slice of a step_* clip at a random onset, with slight pitch variation. */
  footstep(material: Material, x: number, y: number, z: number): void {
    if (!this.ctx) return;
    this.guard('footstep', () =>
      this.withBuffer(`step_${material}`, (buf, item) => {
        const onsets = this.onsetsOf(buf);
        const maxStart = Math.max(0, buf.duration - STEP_SLICE);
        const pick = onsets.length ? onsets[Math.floor(Math.random() * onsets.length)] : Math.random() * maxStart;
        const offset = Math.min(Math.max(0, pick - 0.01), maxStart);
        const rate = 0.94 + Math.random() * 0.12;
        this.playVoice(buf, item, { x, y, z, volume: 0.9, rate }, { offset, dur: STEP_SLICE });
      }),
    );
  }

  /** Counts for a perf overlay. */
  debug() {
    return {
      ready: !!this.ctx && !!this.manifest,
      dead: this.dead,
      ctxState: this.ctx?.state ?? 'none',
      voices: this.voices.length,
      loops: this.loops.size,
      beds: this.beds.size,
      buffers: [...this.buffers.values()].filter(Boolean).length,
      music: this.musicPlaying,
      radio: this.radio.current(), nowPlaying: this.radioNow, bg: !!this.bgTrack, musicScale: this.musicScale,
      ducked: this.duckOn,
    };
  }

  // ---------------------------------------------------------------- internals

  private bindGestures(): void {
    if (this.gestureBound || typeof window === 'undefined') return;
    this.gestureBound = true;
    const onGesture = () => this.unlock();
    window.addEventListener('pointerdown', onGesture, { passive: true });
    window.addEventListener('keydown', onGesture);
    window.addEventListener('touchend', onGesture, { passive: true });
  }

  /** Create the AudioContext and graph once. Returns null if Web Audio is unavailable. */
  private ensureContext(): AudioContext | null {
    if (this.ctx || this.dead) return this.ctx;
    try {
      const ctx = new AudioContext();
      this.master = ctx.createGain();
      this.duckNode = ctx.createGain();
      this.buses = { music: ctx.createGain(), radio: ctx.createGain(), sfx: ctx.createGain(), voice: ctx.createGain() };
      this.buses.music.connect(this.duckNode);
      this.buses.radio.connect(this.duckNode);
      this.duckNode.connect(this.master);
      this.buses.sfx.connect(this.master);
      this.buses.voice.connect(this.master);
      // limiter: catch peaks from boosted effects instead of clipping
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -8; limiter.knee.value = 6; limiter.ratio.value = 12;
      limiter.attack.value = 0.003; limiter.release.value = 0.2;
      this.master.connect(limiter);
      limiter.connect(ctx.destination);
      this.duckNode.gain.value = this.duckOn ? DUCK_GAIN : 1;
      this.ctx = ctx;
      this.applyVolumes(0);
      this.pushListener();
      return ctx;
    } catch (err) {
      this.dead = true;
      this.warnOnce('ctx', `Web Audio unavailable, audio disabled: ${err}`);
      return null;
    }
  }

  private applyVolumes(tc: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const v = this.volumes;
    this.master.gain.setTargetAtTime(v.master, t, tc);
    this.buses.music.gain.setTargetAtTime(v.music * this.musicScale, t, tc);
    this.buses.sfx.gain.setTargetAtTime(v.sfx, t, tc);
    this.buses.voice.gain.setTargetAtTime(v.voice, t, tc);
    this.buses.radio.gain.setTargetAtTime(v.radio, t, tc);
  }

  private pushListener(): void {
    if (!this.ctx) return;
    const { x, y, z, yaw } = this.listener;
    const l = this.ctx.listener;
    l.setPosition(x, y, z);
    l.setOrientation(-Math.sin(yaw), 0, -Math.cos(yaw), 0, 1, 0); // forward; up = (0,1,0)
  }

  /** Bring music and radio in line with their intent. Intent waits here until ready. */
  private apply(): void {
    this.guard('apply', () => {
      if (!this.ctx || !this.manifest) return;
      if (!this.preloaded) {
        this.preloaded = true;
        for (const id of PRELOAD) void this.loadBuffer(id);
      }
      if (this.musicPlaying !== this.musicIntent) {
        this.musicTrack = this.swapTrack(this.musicTrack, this.musicIntent, 'music', this.musicFade);
        this.musicPlaying = this.musicIntent;
      }
      const st = this.inVehicle ? this.stations[this.stationIndex] ?? null : null;
      const radioWant = st?.key ?? null;
      if (this.radioPlaying !== radioWant) {
        if (!st) { this.radioTrack = this.swapTrack(this.radioTrack, null, 'radio', 0.6); this.radioNow = null; }
        else this.tuneIn(st, 0.35);
        this.radioPlaying = radioWant;
      }
      this.syncBeds();
    });
  }

  private changeStation(step: number): string {
    const n = this.stations.length + 1; // + Off
    this.stationIndex = (((this.stationIndex + step) % n) + n) % n;
    try { localStorage.setItem('blockshore.radio', String(this.stationIndex)); } catch { /* ignore */ }
    if (this.inVehicle && step !== 0) this.sfx('radio_static', { volume: 0.35 });
    this.apply();
    return this.stations[this.stationIndex]?.name ?? 'Radio off';
  }

  /** Start a station at its "live" position: which song is on and how far into it, from the clock. */
  private tuneIn(st: Station, fade: number): void {
    const total = st.tracks.reduce((a, t) => a + t.dur, 0);
    let pos = (Date.now() / 1000 + (hashStr(st.key) % 997)) % total;
    let i = 0;
    while (i < st.tracks.length - 1 && pos >= st.tracks[i].dur) { pos -= st.tracks[i].dur; i++; }
    const tr = st.tracks[i];
    const item = this.items.get(tr.id);
    this.radioNow = item ? { id: tr.id, title: item.title ?? '', artist: item.artist ?? '' } : null;
    this.radioTrack = this.swapTrack(this.radioTrack, tr.id, 'radio', fade, {
      loop: false, offset: Math.max(0, pos - 0.5),
      onEnded: () => { if (this.radioPlaying === st.key && this.inVehicle) this.tuneIn(st, 0.05); },
    });
  }

  private url(item: ManifestItem): string {
    return `${import.meta.env.BASE_URL}${item.file}`;
  }

  /** Start a streamed track on a bus, fading in, and fade out the previous one. */
  private swapTrack(old: Track | null, id: string | null, bus: 'music' | 'radio', fade: number, o: { loop?: boolean; offset?: number; level?: number; onEnded?: () => void } = {}): Track | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    if (old) this.fadeOutTrack(old, fade, ctx);
    if (!id) return null;
    const item = this.items.get(id);
    if (!item) {
      this.warnOnce(`track:${id}`, `unknown track id "${id}"`);
      return null;
    }
    try {
      const el = new Audio(this.url(item));
      el.loop = o.loop ?? item.loop ?? true;
      el.preload = 'auto';
      if (o.offset) el.addEventListener('loadedmetadata', () => { try { el.currentTime = Math.min(o.offset!, Math.max(0, el.duration - 2)); } catch { /* ignore */ } }, { once: true });
      if (o.onEnded) el.addEventListener('ended', o.onEnded, { once: true });
      const node = ctx.createMediaElementSource(el);
      const base = (item.volume ?? 1) * (o.level ?? 1);
      const gain = ctx.createGain();
      const now = ctx.currentTime;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(base, now + Math.max(fade, 0.01));
      node.connect(gain);
      gain.connect(this.buses[bus]);
      void el.play().catch(() => this.warnOnce(`blocked:${id}`, `playback of "${id}" was blocked; it retries on the next gesture`));
      return { el, node, gain, base };
    } catch (err) {
      this.warnOnce(`track:${id}`, `could not start "${id}": ${err}`);
      return null;
    }
  }

  private fadeOutTrack(t: Track, fade: number, ctx: AudioContext): void {
    rampToZero(t.gain, ctx, fade);
    setTimeout(() => {
      t.el.pause();
      t.node.disconnect();
      t.gain.disconnect();
    }, fade * 1000 + 100);
  }

  /** Keep the ambience beds at their requested levels (created on first non-zero level). */
  private syncBeds(): void {
    if (!this.ctx) return;
    for (const name of Object.keys(BEDS) as BedName[]) {
      const level = this.bedLevels[name];
      let bed = this.beds.get(name);
      if (!bed && level > 0) {
        bed = this.makeLoop(BEDS[name], 'sfx', false) ?? undefined;
        if (bed) this.beds.set(name, bed);
      }
      if (bed) this.updateLoop(bed, { volume: level }, 0.4);
    }
  }

  /** Create a looping source. The buffer attaches when it decodes. Positional loops get a panner. */
  private makeLoop(id: string, bus: Bus, positional: boolean): Loop | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const item = this.items.get(id);
    if (!item) {
      this.warnOnce(`loop:${id}`, `unknown sfx id "${id}"`);
      return null;
    }
    const gain = ctx.createGain();
    gain.gain.value = 0;
    let panner: PannerNode | null = null;
    if (positional) {
      panner = this.makePanner();
      gain.connect(panner);
      panner.connect(this.buses[bus]);
    } else {
      gain.connect(this.buses[bus]);
    }
    const loop: Loop = { id, gain, panner, src: null, base: item.volume ?? 1, rate: 1, stopped: false };
    void this.loadBuffer(id).then((buf) => {
      if (!buf || loop.stopped || !this.ctx) return;
      this.guard('loop-start', () => {
        const src = this.ctx!.createBufferSource();
        src.buffer = buf;
        src.loop = true;
        src.playbackRate.value = loop.rate;
        src.connect(gain);
        src.start();
        loop.src = src;
      });
    });
    return loop;
  }

  private updateLoop(l: Loop, opts: LoopOpts, tc: number): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    l.gain.gain.setTargetAtTime(l.base * (opts.volume ?? 1), t, tc);
    l.rate = opts.rate ?? 1;
    if (l.src) l.src.playbackRate.setTargetAtTime(l.rate, t, 0.05);
    if (l.panner) {
      l.panner.positionX.value = opts.x ?? 0;
      l.panner.positionY.value = opts.y ?? 0;
      l.panner.positionZ.value = opts.z ?? 0;
    }
  }

  private killLoop(l: Loop, fade: number): void {
    l.stopped = true;
    if (!this.ctx) return;
    rampToZero(l.gain, this.ctx, fade);
    setTimeout(() => {
      try {
        l.src?.stop();
      } catch {
        /* never started */
      }
      l.src?.disconnect();
      l.gain.disconnect();
      l.panner?.disconnect();
    }, fade * 1000 + 50);
  }

  private makePanner(): PannerNode {
    const p = this.ctx!.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = REF_DIST;
    p.maxDistance = MAX_DIST;
    p.rolloffFactor = ROLLOFF;
    return p;
  }

  /** Play a one-shot. Applies the voice limit by dropping the quietest voice. */
  private playVoice(buf: AudioBuffer, item: ManifestItem, opts: SfxOpts, slice?: { offset: number; dur: number }): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const rate = opts.rate ?? 1;
    const positional = hasPos(opts);
    const x = opts.x ?? 0;
    const y = opts.y ?? 0;
    const z = opts.z ?? 0;
    const level = Math.min(3, (item.volume ?? 1) * (opts.volume ?? 1) * (opts.bus && opts.bus !== 'sfx' ? 1 : SFX_BOOST));
    const est = positional ? level * this.attenuation(x, y, z) : level;

    if (this.voices.length >= MAX_VOICES) {
      let q = this.voices[0];
      for (const v of this.voices) if (v.level < q.level || (v.level === q.level && v.start < q.start)) q = v;
      if (est <= q.level) return; // the new sound is the quietest: drop it
      this.killVoice(q);
    }

    const now = ctx.currentTime;
    const gain = ctx.createGain();
    const nodes: AudioNode[] = [gain];
    const bus = this.buses[opts.bus ?? 'sfx'];
    if (positional) {
      const p = this.makePanner();
      p.setPosition(x, y, z);
      gain.connect(p);
      p.connect(bus);
      nodes.push(p);
    } else {
      gain.connect(bus);
    }

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    src.connect(gain);
    if (slice) {
      // Short slice with a 10 ms attack and 40 ms release so it never clicks.
      const real = slice.dur / rate;
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(level, now + 0.01);
      gain.gain.setValueAtTime(level, now + real - 0.04);
      gain.gain.linearRampToValueAtTime(0, now + real);
      src.start(now, slice.offset, slice.dur);
    } else {
      gain.gain.value = level;
      src.start(now);
    }
    const voice: Voice = { src, nodes, level: est, start: now };
    this.voices.push(voice);
    src.onended = () => this.killVoice(voice);
  }

  private killVoice(v: Voice): void {
    const i = this.voices.indexOf(v);
    if (i < 0) return;
    this.voices.splice(i, 1);
    try {
      v.src.stop();
    } catch {
      /* already stopped */
    }
    v.src.disconnect();
    for (const n of v.nodes) n.disconnect();
  }

  /** Inverse-distance gain estimate, matching the panner settings. */
  private attenuation(x: number, y: number, z: number): number {
    const l = this.listener;
    const d = Math.max(Math.hypot(x - l.x, y - l.y, z - l.z), REF_DIST);
    return REF_DIST / (REF_DIST + ROLLOFF * (d - REF_DIST));
  }

  /** Run `play` with the decoded buffer now, or once it has loaded. */
  private withBuffer(id: string, play: (buf: AudioBuffer, item: ManifestItem) => void): void {
    const item = this.items.get(id);
    if (!item) {
      this.warnOnce(`id:${id}`, `unknown audio id "${id}"`);
      return;
    }
    const cached = this.buffers.get(id);
    if (cached !== undefined) {
      if (cached) play(cached, item);
      return;
    }
    void this.loadBuffer(id).then((buf) => {
      if (buf) this.guard(`play:${id}`, () => play(buf, item));
    });
  }

  private loadBuffer(id: string): Promise<AudioBuffer | null> {
    const cached = this.buffers.get(id);
    if (cached !== undefined) return Promise.resolve(cached);
    const item = this.items.get(id);
    const ctx = this.ctx;
    if (!item || !ctx) return Promise.resolve(null);
    let p = this.pendingLoads.get(id);
    if (!p) {
      p = fetch(this.url(item))
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.arrayBuffer();
        })
        .then((data) => ctx.decodeAudioData(data))
        .then((buf) => {
          this.buffers.set(id, buf);
          return buf;
        })
        .catch((err) => {
          this.buffers.set(id, null);
          this.warnOnce(`load:${id}`, `could not load "${id}": ${err}`);
          return null;
        })
        .finally(() => this.pendingLoads.delete(id));
      this.pendingLoads.set(id, p);
    }
    return p;
  }

  /** Times (seconds) where the clip gets loud after quiet, used to pick footstep onsets. */
  private onsetsOf(buf: AudioBuffer): number[] {
    const cached = this.onsetCache.get(buf);
    if (cached) return cached;
    const data = buf.getChannelData(0);
    const win = Math.max(1, Math.floor(buf.sampleRate * 0.01));
    const rms: number[] = [];
    for (let i = 0; i + win <= data.length; i += win) {
      let s = 0;
      for (let j = i; j < i + win; j++) s += data[j] * data[j];
      rms.push(Math.sqrt(s / win));
    }
    const peak = Math.max(1e-6, ...rms);
    const out: number[] = [];
    for (let k = 1; k < rms.length; k++) {
      if (rms[k] > 0.25 * peak && rms[k - 1] < 0.12 * peak) out.push(k * 0.01);
    }
    this.onsetCache.set(buf, out);
    return out;
  }

  private warnOnce(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(`[audio] ${msg}`);
  }

  /** Run audio work so that a Web Audio failure is logged, never thrown into the game loop. */
  private guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.warnOnce(`guard:${what}`, `${what} failed: ${err}`);
    }
  }
}

export const audio = new AudioEngine();

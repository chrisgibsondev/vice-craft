/**
 * Spoken dialogue with the browser's built-in text to speech (Web Speech API, free, no downloads).
 * Every speaker gets a stable voice + pitch + speed so characters sound different from each other.
 * Story/cutscene lines interrupt everything; street barks only speak when nothing else is talking.
 */
type Kind = 'dialogue' | 'bark' | 'radio';

/** known cast: which kind of voice suits them (pitch/rate nudges are applied on top) */
const CAST: Record<string, { g: 'f' | 'm'; pitch: number; rate: number }> = {
  marisol: { g: 'f', pitch: 1.05, rate: 1.05 },
  'lena voss': { g: 'f', pitch: 0.9, rate: 1.0 },
  lena: { g: 'f', pitch: 0.9, rate: 1.0 },
  nix: { g: 'm', pitch: 1.2, rate: 1.15 },
  'dj kilo': { g: 'm', pitch: 0.85, rate: 1.1 },
  kilo: { g: 'm', pitch: 0.85, rate: 1.1 },
  rico: { g: 'm', pitch: 0.8, rate: 1.0 },
  valentina: { g: 'f', pitch: 1.15, rate: 1.05 },
  officer: { g: 'm', pitch: 0.75, rate: 1.05 },
  cop: { g: 'm', pitch: 0.75, rate: 1.05 },
  guard: { g: 'm', pitch: 0.8, rate: 1.0 },
  dispatch: { g: 'f', pitch: 0.95, rate: 1.15 },
};
const FEMALE = /(female|woman|zira|aria|jenny|michelle|samantha|victoria|karen|moira|tessa|fiona|susan|hazel|libby|sonia|natasha|emma|ava|allison|serena|google us english$|google uk english female)/i;
const MALE = /(male|man|david|mark|guy|davis|tony|ryan|george|daniel|alex|fred|thomas|oliver|james|brian|christopher|eric|google uk english male)/i;

const hash = (t: string) => { let h = 2166136261; for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619); return h >>> 0; };

class Speech {
  private voices: SpeechSynthesisVoice[] = [];
  private enabled = true;
  private volume = 1;
  private current: { kind: Kind; until: number } | null = null;
  private lastBarkAt = 0;
  private lastText = '';
  onSpeaking: ((on: boolean) => void) | null = null;

  get supported() { return typeof window !== 'undefined' && 'speechSynthesis' in window; }

  constructor() {
    if (!this.supported) return;
    const load = () => { this.voices = speechSynthesis.getVoices().filter((v) => /^en(-|_|$)/i.test(v.lang)); };
    load();
    speechSynthesis.addEventListener?.('voiceschanged', load);
  }

  configure(o: { enabled?: boolean; volume?: number }) {
    if (o.enabled !== undefined) { this.enabled = o.enabled; if (!o.enabled) this.stop(); }
    if (o.volume !== undefined) this.volume = Math.max(0, Math.min(1, o.volume));
  }

  stop() {
    if (!this.supported) return;
    speechSynthesis.cancel();
    this.current = null;
    this.onSpeaking?.(false);
  }

  /** Speak a line. `level` (0..1) scales loudness, e.g. by distance for street barks. */
  say(speaker: string, text: string, kind: Kind = 'dialogue', level = 1) {
    if (!this.supported || !this.enabled || this.volume <= 0) return;
    const clean = text.replace(/\[[^\]]*\]|\*[^*]*\*|<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!clean || clean.length > 400) return;
    const now = Date.now();
    const busy = speechSynthesis.speaking && this.current && now < this.current.until;
    if (kind === 'bark') {
      if (busy || now - this.lastBarkAt < 2500) return; // never talk over someone, and keep chatter sparse
      this.lastBarkAt = now;
    } else {
      if (clean === this.lastText && busy) return; // same line re-sent
      speechSynthesis.cancel(); // story lines take over
    }
    this.lastText = clean;
    const u = new SpeechSynthesisUtterance(clean);
    const v = this.voiceFor(speaker);
    if (v.voice) u.voice = v.voice;
    u.pitch = v.pitch; u.rate = v.rate; u.lang = v.voice?.lang ?? 'en-US';
    u.volume = Math.max(0, Math.min(1, this.volume * level * (kind === 'bark' ? 0.75 : 1)));
    const est = 800 + (clean.length / (14 * v.rate)) * 1000;
    this.current = { kind, until: now + est };
    u.onstart = () => this.onSpeaking?.(kind !== 'bark');
    u.onend = u.onerror = () => { if (this.current && Date.now() >= this.current.until - est) { this.current = null; this.onSpeaking?.(false); } };
    speechSynthesis.speak(u);
  }

  private voiceFor(speaker: string): { voice: SpeechSynthesisVoice | null; pitch: number; rate: number } {
    const key = speaker.trim().toLowerCase();
    const h = hash(key || 'narrator');
    const cast = CAST[key] ?? Object.entries(CAST).find(([k]) => key.includes(k))?.[1];
    const g = cast?.g ?? (h % 2 ? 'm' : 'f');
    const pool = this.voices.filter((vv) => (g === 'f' ? FEMALE : MALE).test(vv.name));
    const list = pool.length ? pool : this.voices;
    const voice = list.length ? list[h % list.length] : null;
    // small per-speaker variation so two people on the same voice still differ
    const vary = ((h >>> 8) % 100) / 100 - 0.5;
    const pitch = Math.max(0.5, Math.min(1.6, (cast?.pitch ?? 1) + vary * 0.3));
    const rate = Math.max(0.8, Math.min(1.35, (cast?.rate ?? 1.05) + vary * 0.12));
    return { voice, pitch, rate };
  }
}

export const tts = new Speech();

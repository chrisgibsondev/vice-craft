import { useEffect, useState } from 'react';
import { DEFAULT_KEYS, type Settings } from '../../state/types';
import { useGame } from '../../state/store';
import { updateSettings } from '../../state/actions';
import { Modal, Tabs, Seg, Toggle, Slider, Btn, SectionTitle, Tag } from '../components';
import { ACTION_LABELS, keyLabel, uiFlags } from '../util';

type Tab = 'graphics' | 'controls' | 'audio' | 'access';

const KEY_GROUPS: { title: string; keys: string[] }[] = [
  { title: 'Movement', keys: ['forward', 'back', 'left', 'right', 'jump', 'sprint'] },
  { title: 'Actions', keys: ['interact', 'vehicle', 'fire', 'aim', 'reload', 'weaponNext', 'heal', 'ping', 'skip'] },
  { title: 'Driving', keys: ['handbrake', 'horn', 'radio', 'camera'] },
  { title: 'Menus', keys: ['phone', 'map', 'party', 'chat', 'menu'] },
];

function KeyRow({ action, code, conflicts, onSet }: { action: string; code: string; conflicts: string[]; onSet: (code: string) => void }) {
  const [listening, setListening] = useState(false);
  useEffect(() => {
    if (!listening) return;
    uiFlags.capturing = true;
    const key = (e: KeyboardEvent) => {
      e.preventDefault(); e.stopPropagation();
      if (e.code === 'Escape') { setListening(false); return; }
      onSet(e.code); setListening(false);
    };
    const mouse = (e: MouseEvent) => { e.preventDefault(); e.stopPropagation(); onSet(`Mouse${e.button}`); setListening(false); };
    const ctx = (e: Event) => e.preventDefault();
    const t = setTimeout(() => window.addEventListener('mousedown', mouse, true), 60);
    window.addEventListener('keydown', key, true);
    window.addEventListener('contextmenu', ctx, true);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('mousedown', mouse, true);
      window.removeEventListener('contextmenu', ctx, true);
      setTimeout(() => { uiFlags.capturing = false; }, 50);
    };
  }, [listening, onSet]);
  const def = DEFAULT_KEYS[action];
  return (
    <div className={`keyrow ${listening ? 'listening' : ''}`}>
      <span className="kr-name">{ACTION_LABELS[action] ?? action}</span>
      <button type="button" className="kr-key" onClick={() => setListening(true)} aria-label={`Rebind ${ACTION_LABELS[action] ?? action}`}>
        {listening ? 'Press a key… (Esc cancels)' : keyLabel(code)}
      </button>
      {conflicts.length > 0 && !listening && <Tag tone="sun" title={`Also used by ${conflicts.join(', ')}`}>shared</Tag>}
      <button type="button" className="kr-reset" disabled={code === def} onClick={() => onSet(def)} title="Reset to default">Reset</button>
    </div>
  );
}

export function SettingsOverlay({ leaving }: { leaving: boolean }) {
  const s = useGame((x) => x.settings);
  const [tab, setTab] = useState<Tab>('graphics');
  const set = (p: Partial<Settings>) => updateSettings(p);
  const setVol = (k: keyof Settings['volume'], v: number) => updateSettings({ volume: { ...s.volume, [k]: v } });
  const setKey = (action: string, code: string) => updateSettings({ keys: { ...s.keys, [action]: code } });
  const pct = (v: number) => `${Math.round(v * 100)}%`;

  return (
    <Modal title="Settings" icon="gear" leaving={leaving} accent="aqua"
      footer={tab === 'controls' ? <Btn variant="ghost" onClick={() => updateSettings({ keys: { ...DEFAULT_KEYS } })}>Reset all keys</Btn> : <span className="muted">Changes are saved automatically.</span>}>
      <Tabs value={tab} onChange={setTab} tabs={[
        { id: 'graphics', label: 'Graphics', icon: 'eye' }, { id: 'controls', label: 'Controls', icon: 'steering' },
        { id: 'audio', label: 'Audio', icon: 'music' }, { id: 'access', label: 'Accessibility', icon: 'users' },
      ]} />
      <div className="settings-pane" key={tab}>
        {tab === 'graphics' && (
          <>
            <div className="row-setting"><span className="rs-text"><b>Quality preset</b><small>Higher presets use more GPU for shadows, water and reflections.</small></span>
              <Seg value={s.quality} onChange={(v) => set({ quality: v })} options={[{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }, { id: 'ultra', label: 'Ultra' }]} /></div>
            <Slider label="Render distance" hint="Chunks loaded around you." value={s.renderDistance} min={4} max={16} onChange={(v) => set({ renderDistance: v })} format={(v) => `${v} chunks`} />
            <Slider label="Field of view" value={s.fov} min={50} max={110} onChange={(v) => set({ fov: v })} format={(v) => `${v}°`} />
            <Toggle label="Bloom" hint="Neon glow around bright lights." value={s.bloom} onChange={(v) => set({ bloom: v })} />
            <Toggle label="Show FPS" hint="Frame rate in the corner of the HUD." value={s.showFps} onChange={(v) => set({ showFps: v })} />
          </>
        )}
        {tab === 'controls' && (
          <>
            <div className="row-setting"><span className="rs-text"><b>Camera</b><small>Switch any time with {keyLabel(s.keys.camera)}.</small></span>
              <Seg value={s.camera} onChange={(v) => set({ camera: v })} options={[{ id: 'first', label: 'First person' }, { id: 'third', label: 'Third person' }]} /></div>
            <Slider label="Mouse sensitivity" value={s.mouseSensitivity} min={0.1} max={3} step={0.05} onChange={(v) => set({ mouseSensitivity: v })} format={(v) => `${v.toFixed(2)}×`} />
            <Toggle label="Invert Y axis" value={s.invertY} onChange={(v) => set({ invertY: v })} />
            <p className="muted small">Click a key, then press the new key or mouse button. Some actions share a key on purpose, because they work in different situations (for example, jump and handbrake).</p>
            <div className="keys-grid">
              {KEY_GROUPS.map((g) => (
                <div key={g.title} className="key-group">
                  <SectionTitle>{g.title}</SectionTitle>
                  {g.keys.filter((k) => k in DEFAULT_KEYS).map((k) => (
                    <KeyRow key={k} action={k} code={s.keys[k] ?? DEFAULT_KEYS[k]} onSet={(c) => setKey(k, c)}
                      conflicts={Object.keys(s.keys).filter((o) => o !== k && s.keys[o] === (s.keys[k] ?? DEFAULT_KEYS[k]) && DEFAULT_KEYS[o] !== DEFAULT_KEYS[k]).map((o) => ACTION_LABELS[o] ?? o)} />
                  ))}
                </div>
              ))}
            </div>
          </>
        )}
        {tab === 'audio' && (
          <>
            <Slider label="Master volume" value={s.volume.master} min={0} max={1} step={0.01} onChange={(v) => setVol('master', v)} format={pct} />
            <Slider label="Music" value={s.volume.music} min={0} max={1} step={0.01} onChange={(v) => setVol('music', v)} format={pct} />
            <Slider label="Sound effects" value={s.volume.sfx} min={0} max={1} step={0.01} onChange={(v) => setVol('sfx', v)} format={pct} />
            <Slider label="Voice &amp; dialogue" value={s.volume.voice} min={0} max={1} step={0.01} onChange={(v) => setVol('voice', v)} format={pct} />
            <Slider label="Car radio" value={s.volume.radio} min={0} max={1} step={0.01} onChange={(v) => setVol('radio', v)} format={pct} />
          </>
        )}
        {tab === 'access' && (
          <>
            <Toggle label="Subtitles" hint="Show dialogue as text at the bottom of the screen." value={s.subtitlesOn} onChange={(v) => set({ subtitlesOn: v })} />
            <div className="row-setting"><span className="rs-text"><b>Subtitle size</b></span>
              <Seg value={s.subtitleSize} disabled={!s.subtitlesOn} onChange={(v) => set({ subtitleSize: v })} options={[{ id: 'small', label: 'Small' }, { id: 'medium', label: 'Medium' }, { id: 'large', label: 'Large' }, { id: 'xl', label: 'Extra large' }]} /></div>
            <div className="sub-preview"><div className={`subtitle static sz-${s.subtitleSize}`}><b>Marisol</b><span>You made it. Sunny Side Diner, corner booth.</span></div></div>
            <Toggle label="Spoken dialogue" hint="Characters read their lines aloud (your browser's built-in voices)." value={s.voiceDialogue !== false} onChange={(v) => set({ voiceDialogue: v })} />
            <Toggle label="NPC speech bubbles" hint="Street chatter, honks and shouts show above people and cars." value={s.npcSpeech} onChange={(v) => set({ npcSpeech: v })} />
            <Toggle label="NPC subtitles" hint="Also show street chatter as subtitles (needs Subtitles on)." value={s.npcSubtitles} onChange={(v) => set({ npcSubtitles: v })} />
            <Toggle label="Reduce camera shake" hint="Calmer camera on impacts, explosions and sprinting." value={s.reduceShake} onChange={(v) => set({ reduceShake: v })} />
            <Toggle label="Colour-independent markers" hint="Minimap and objective markers are told apart by shape, with bold outlines." value={s.colorblindMarkers} onChange={(v) => set({ colorblindMarkers: v })} />
          </>
        )}
      </div>
    </Modal>
  );
}

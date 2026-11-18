/**
 * Tiny observable store (no dependency). `useGame(selector)` subscribes React
 * components; `setState(partial)` updates. The game loop writes HUD/blips here at
 * ~10 Hz so React never re-renders at frame rate.
 */
import { useSyncExternalStore } from 'react';
import { DEFAULT_SETTINGS, type GameState, type Settings } from './types';

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem('blockshore.settings');
    if (raw) {
      const s = JSON.parse(raw);
      return { ...DEFAULT_SETTINGS, ...s, volume: { ...DEFAULT_SETTINGS.volume, ...(s.volume ?? {}) }, keys: { ...DEFAULT_SETTINGS.keys, ...(s.keys ?? {}) } };
    }
  } catch { /* storage unavailable */ }
  return structuredClone(DEFAULT_SETTINGS);
}

let state: GameState = {
  screen: 'boot', overlay: null, conn: 'idle', connMessage: '',
  user: null, profile: null,
  social: { friends: [], incoming: [], outgoing: [], blocked: [], privacy: { presence: 'friends', invites: 'friends' } },
  party: null, partyInvites: [], world: null, worlds: [], activity: null, lobby: null, brief: null, contact: null,
  shop: null, results: null, cutscene: null, dialogue: null, barkSub: null, notices: [], chat: [],
  hud: { hp: 100, maxHp: 100, wanted: 0, wantedSeen: false, inVehicle: false, speedKmh: 0, vehicleHp: 100, vehicleModel: null, seat: 0, down: null, interior: null, x: 0, y: 0, z: 0, yaw: 0, searchArea: null, interactPrompt: null, ammo: null },
  blips: [], settings: loadSettings(), loading: null, pointerLocked: false, fps: 0, pingMs: 0,
  joinToken: new URLSearchParams(location.search).get('join'), entities: [], error: null,
  wheel: { open: false, selected: null },
};

const listeners = new Set<() => void>();

export function getState(): GameState { return state; }
export function setState(patch: Partial<GameState> | ((s: GameState) => Partial<GameState>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  for (const l of listeners) l();
}
export function subscribe(l: () => void) { listeners.add(l); return () => listeners.delete(l); }

export function useGame<T>(selector: (s: GameState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

export function saveSettings(s: Settings) {
  setState({ settings: s });
  try { localStorage.setItem('blockshore.settings', JSON.stringify(s)); } catch { /* ignore */ }
}

let noticeId = 0;
export function pushNotice(text: string, kind: 'info' | 'good' | 'bad' | 'mission' = 'info') {
  const n = { id: ++noticeId, text, kind, at: Date.now() };
  setState((s) => ({ notices: [...s.notices.slice(-5), n] }));
  setTimeout(() => setState((s) => ({ notices: s.notices.filter((x) => x.id !== n.id) })), 5200);
}
let chatId = 0;
export function pushChat(ch: string, from: string, text: string, at = Date.now()) {
  setState((s) => ({ chat: [...s.chat.slice(-80), { id: ++chatId, ch, from, text, at }] }));
}

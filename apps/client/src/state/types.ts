/**
 * Client-side state shapes. These mirror the server REST + WebSocket payloads.
 * UI components read from the store (state/store.ts) and call actions (state/actions.ts).
 */
import type { ActivityView, LobbyView, Ent } from '@blockshore/shared';

export interface UserInfo { id: string; name: string; admin: boolean; /** account assigned by network address, no login set yet */ guest?: boolean; /** 5-digit code friends type to add you */ friendCode?: string; /** linked sign-in providers, e.g. ['google'] */ linked?: string[] }

export interface ProfileView {
  cash: number;
  rep: number;
  completed: Record<string, number>;
  unlocks: string[];
  preps: Record<string, string[]>;
  checkpoints: Record<string, number>;
  inventory: Record<string, number>;
  outfit: number;
  /** selected hair colour 0xRRGGBB (0 / absent = default look) */
  hair?: number;
  vehicles: { id: string; model: string; color: number; health: number; state: 'stored' | 'out' | 'destroyed' }[];
  bests: Record<string, number>;
  weapons: { id: string; ammo: number }[];
  equipped: string;
}

export type FriendStatus = 'offline' | 'online' | 'in_world' | 'in_activity' | 'in_interior';
export interface FriendView { id: string; name: string; status: FriendStatus; where?: string; joinable: boolean; inMyParty: boolean; /** world instance id when joinable */ instance?: string }
export interface SocialState {
  friends: FriendView[];
  incoming: { id: string; name: string }[];
  outgoing: { id: string; name: string }[];
  blocked: { id: string; name: string }[];
  privacy: { presence: 'everyone' | 'friends' | 'nobody'; invites: 'friends' | 'nobody' };
}

export interface PartyMemberView { id: string; name: string; online: boolean; status: FriendStatus; where?: string; leader: boolean }
export interface PartyView {
  id: string;
  leader: string;
  members: PartyMemberView[];
  invites: { id: string; name: string; expires: number }[];
  link: { token: string; expires: number } | null;
  chat: { from: string; name: string; text: string; at: number }[];
}
export interface PartyInvite { partyId: string; fromName: string; expires: number; size: number }

export interface WorldInfo { instance: string; kind: 'world' | 'activity' | 'interior'; label: string; players: number; capacity: number; access?: 'public' | 'friends' | 'invite'; code?: string; host?: string }
export interface WorldListing { id: string; label: string; players: number; capacity: number; friends: number; access?: 'public' | 'friends' | 'invite'; host?: string | null; custom?: boolean; full?: boolean; code?: string; joinable?: boolean }

export interface Notice { id: number; text: string; kind: 'info' | 'good' | 'bad' | 'mission'; at: number }
export interface ChatLine { id: number; ch: string; from: string; text: string; at: number }

export interface ShopView {
  shop: string;
  name: string;
  items: { id: string; name: string; price: number; desc: string; owned?: boolean; /** barber: colour already bought but not worn (wearing it is free) */ have?: boolean; disabled?: string; color?: number; category?: string }[];
  /** garage-specific */
  vehicles?: ProfileView['vehicles'];
  nearbyVehicle?: { id: string; model: string; hp: number; repairCost: number; mine: boolean } | null;
}

export interface BriefView {
  activity: string;
  name: string;
  kind: string;
  giver: string;
  blurb: string;
  notes: string[];
  unlocked: boolean;
  lockedReason?: string;
  eligibility: { userId: string; name: string; eligibility: 'story' | 'replay' | 'ahead'; reward: string }[];
  preps?: { id: string; name: string; done: boolean }[];
  heist?: { approaches: string[]; equipment: { id: string; name: string; desc: string; approach?: string }[]; roles: string[]; baseTake: number };
  checkpoint?: { stage: number; title: string };
  personalBest?: number;
}

export interface ContactJobs { contact: string; name: string; role: string; blurb: string; jobs: { id: string; name: string; kind: string; status: 'locked' | 'available' | 'done'; blurb: string }[] }

export interface ResultsView {
  activity: string; name: string; kind: string;
  lines: { userId: string; name: string; cash: number; rep: number; note: string; status: string }[];
  take?: number; loot?: number; loud?: boolean;
  race?: { userId: string; name: string; ms: number | null }[];
}

export interface CutsceneState {
  id: string;
  phase: 'waiting' | 'playing';
  startAt: number;
  loaded: number;
  total: number;
  deadline: number;
  skipRule: string;
  votes: number;
  needed: number;
  voted: boolean;
}

export interface HudState {
  hp: number; maxHp: number;
  wanted: number; wantedSeen: boolean;
  inVehicle: boolean; speedKmh: number; vehicleHp: number; vehicleModel: string | null; seat: number;
  down: number | null;
  interior: string | null;
  /** player position + heading for the minimap */
  x: number; y: number; z: number; yaw: number;
  searchArea: { x: number; z: number; r: number } | null;
  interactPrompt: { key: string; label: string; hold?: number; progress?: number } | null;
  ammo: { weapon: string; mag: number; reserve: number } | null;
}

export interface Blip { id: string; x: number; z: number; kind: 'party' | 'player' | 'vehicle' | 'mine' | 'objective' | 'police' | 'guard' | 'poi' | 'ping'; label?: string; color?: number; shape?: 'circle' | 'diamond' | 'triangle' | 'square'; icon?: string }

export type ConnState = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline' | 'version' | 'kicked';

export interface Settings {
  quality: 'low' | 'medium' | 'high' | 'ultra';
  renderDistance: number;
  fov: number;
  bloom: boolean;
  mouseSensitivity: number;
  invertY: boolean;
  camera: 'first' | 'third';
  volume: { master: number; music: number; sfx: number; voice: number; radio: number };
  subtitleSize: 'small' | 'medium' | 'large' | 'xl';
  subtitlesOn: boolean;
  /** NPC street chatter: speech bubbles over heads / the same lines as subtitles (needs subtitlesOn) */
  npcSpeech: boolean;
  /** read dialogue aloud with the browser's text to speech */
  voiceDialogue: boolean;
  npcSubtitles: boolean;
  reduceShake: boolean;
  colorblindMarkers: boolean;
  showFps: boolean;
  keys: Record<string, string>;
}

export const DEFAULT_KEYS: Record<string, string> = {
  forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD', jump: 'Space', sprint: 'ShiftLeft',
  interact: 'KeyE', vehicle: 'KeyF', handbrake: 'Space', horn: 'KeyH', camera: 'KeyV', phone: 'ArrowUp',
  map: 'KeyM', chat: 'KeyT', party: 'KeyP', heal: 'KeyQ', ping: 'KeyG', skip: 'Space', fire: 'Mouse0', aim: 'Mouse2',
  weaponNext: 'KeyX', reload: 'KeyR', menu: 'Escape', radio: 'Period', wheel: 'Tab',
};

export const DEFAULT_SETTINGS: Settings = {
  quality: 'high', renderDistance: 12, fov: 75, bloom: true, mouseSensitivity: 1, invertY: false, camera: 'first',
  volume: { master: 0.9, music: 0.5, sfx: 1, voice: 1, radio: 0.5 },
  subtitleSize: 'medium', subtitlesOn: true, npcSpeech: true, voiceDialogue: true, npcSubtitles: false, reduceShake: false, colorblindMarkers: false, showFps: false, keys: { ...DEFAULT_KEYS },
};

export type Screen =
  | 'boot' | 'login' | 'menu' | 'loading' | 'game';

export type Overlay =
  | null | 'pause' | 'phone' | 'map' | 'social' | 'settings' | 'shop' | 'brief' | 'lobby' | 'heistboard' | 'results' | 'worlds' | 'credits' | 'admin' | 'chat';

export interface GameState {
  screen: Screen;
  overlay: Overlay;
  conn: ConnState;
  connMessage: string;
  user: UserInfo | null;
  profile: ProfileView | null;
  social: SocialState;
  party: PartyView | null;
  partyInvites: PartyInvite[];
  world: WorldInfo | null;
  worlds: WorldListing[];
  activity: ActivityView | null;
  lobby: LobbyView | null;
  brief: BriefView | null;
  contact: ContactJobs | null;
  shop: ShopView | null;
  results: ResultsView | null;
  cutscene: CutsceneState | null;
  dialogue: { speaker: string; text: string; until: number } | null;
  /** latest NPC street line as a subtitle (settings.npcSubtitles) */
  barkSub: { speaker: string; text: string; until: number } | null;
  notices: Notice[];
  chat: ChatLine[];
  hud: HudState;
  blips: Blip[];
  settings: Settings;
  loading: { progress: number; label: string } | null;
  pointerLocked: boolean;
  fps: number;
  pingMs: number;
  /** pending invite link token from ?join= */
  joinToken: string | null;
  /** weapon wheel (hold TAB) */
  /** car radio 'now playing' card */
  radioCard?: { station: string; title: string; artist: string; at: number } | null;
  wheel: { open: boolean; selected: string | null; /** 'radio' = car radio station wheel (selected = station index) */ mode?: 'weapon' | 'radio' };
  /** live entities snapshot for UI (read-only; updated ~5 Hz) */
  entities: Ent[];
  error: string | null;
}

/**
 * REST client for accounts, social, parties and admin. Auth token is kept per tab
 * slot (`?slot=2` lets one browser run two test accounts side by side).
 */
/** Game server origin. Empty = same origin (dev proxy / single-origin deploy). Set VITE_SERVER_URL when the client is hosted separately (e.g. Vercel). */
export const SERVER_URL = ((import.meta.env.VITE_SERVER_URL as string | undefined) ?? '').replace(/\/$/, '');

export const SLOT = new URLSearchParams(location.search).get('slot') ?? '1';
const KEY = `blockshore.token.${SLOT}`;

/** random id for this browser (+ test slot): the server gives each one its own guest account */
export function deviceId(): string | undefined {
  try {
    const k = `blockshore.device.${SLOT}`;
    let d = localStorage.getItem(k);
    if (!d) { const a = new Uint8Array(18); crypto.getRandomValues(a); d = btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); localStorage.setItem(k, d); }
    return d;
  } catch { return undefined; }
}
export function getToken(): string | null { try { return localStorage.getItem(KEY); } catch { return null; } }
export function setToken(t: string | null) { try { if (t) localStorage.setItem(KEY, t); else localStorage.removeItem(KEY); } catch { /* ignore */ } }

export class ApiError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const t = getToken();
  if (t) headers.Authorization = `Bearer ${t}`;
  // A server restart (new version going live) takes a few seconds: retry quietly before giving up.
  let res: Response | null = null;
  for (let attempt = 0; attempt < 6 && !res; attempt++) {
    try {
      const r = await fetch(`${SERVER_URL}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      if (r.status === 502 || r.status === 503 || r.status === 504) { if (attempt < 5) { await new Promise((ok) => setTimeout(ok, 1500 + attempt * 1000)); continue; } }
      res = r;
    } catch {
      if (attempt < 5) await new Promise((ok) => setTimeout(ok, 1500 + attempt * 1000));
    }
  }
  if (!res) throw new ApiError(0, 'The game is loading. Try again in a moment.');
  const data = await res.json().catch(() => null);
  if (!data) throw new ApiError(res.status, 'The game is loading. Try again in a moment.');
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`, data.code);
  return data as T;
}

export const api = {
  register: (username: string, password: string) => call<{ token: string; user: { id: string; name: string; admin: boolean } }>('POST', '/auth/register', { username, password }),
  auto: () => call<{ token: string; user: { id: string; name: string; admin: boolean; guest: boolean } }>('POST', '/auth/auto', { slot: SLOT, device: deviceId() }),
  claim: (username: string, password: string) => call<{ user: { id: string; name: string; admin: boolean; guest: boolean } }>('POST', '/auth/claim', { username, password }),
  providers: () => call<{ google: string | null; x: string | null }>('GET', '/auth/providers'),
  oauth: (b: { provider: 'google' | 'x'; idToken?: string; code?: string; verifier?: string; redirectUri?: string }) => call<{ token: string; user: { id: string; name: string; admin: boolean; guest: boolean }; switched: boolean; linked: boolean }>('POST', '/auth/oauth', b),
  login: (username: string, password: string) => call<{ token: string; user: { id: string; name: string; admin: boolean } }>('POST', '/auth/login', { username, password }),
  logout: () => call<{ ok: true }>('POST', '/auth/logout'),
  me: () => call<{ user: { id: string; name: string; admin: boolean }; profile: unknown; privacy: { presence: string; invites: string } }>('GET', '/me'),
  search: (q: string) => call<{ users: { id: string; name: string; friend: boolean; pending: boolean }[] }>('GET', `/users/search?q=${encodeURIComponent(q)}`),
  friends: () => call<{ friends: unknown[]; incoming: unknown[]; outgoing: unknown[]; blocked: unknown[]; privacy: unknown }>('GET', '/friends'),
  friendRequest: (userId: string) => call<{ result: string; message: string }>('POST', '/friends/request', { userId }),
  friendAddCode: (code: string) => call<{ result: string; message: string }>('POST', '/friends/add-code', { code }),
  friendRespond: (userId: string, accept: boolean) => call<{ ok: true }>('POST', '/friends/respond', { userId, accept }),
  friendCancel: (userId: string) => call<{ ok: true }>('POST', '/friends/cancel', { userId }),
  friendRemove: (userId: string) => call<{ ok: true }>('POST', '/friends/remove', { userId }),
  block: (userId: string, block: boolean) => call<{ ok: true }>('POST', '/blocks', { userId, block }),
  privacy: (presence: string, invites: string) => call<{ ok: true }>('POST', '/privacy', { presence, invites }),
  party: () => call<{ party: unknown; invites: unknown[] }>('GET', '/party'),
  partyCreate: () => call<{ party: unknown }>('POST', '/party/create'),
  partyInvite: (userId: string) => call<{ party: unknown }>('POST', '/party/invite', { userId }),
  partyAccept: (partyId: string) => call<{ party: unknown }>('POST', '/party/accept', { partyId }),
  partyDecline: (partyId: string) => call<{ ok: true }>('POST', '/party/decline', { partyId }),
  partyLeave: () => call<{ ok: true }>('POST', '/party/leave'),
  partyKick: (userId: string) => call<{ party: unknown }>('POST', '/party/kick', { userId }),
  partyTransfer: (userId: string) => call<{ party: unknown }>('POST', '/party/transfer', { userId }),
  partyLink: () => call<{ token: string; url: string; expires: number }>('POST', '/party/link'),
  partyLinkInfo: (token: string) => call<{ leaderName: string; size: number; expires: number }>('GET', `/party/link/${encodeURIComponent(token)}`),
  partyJoinLink: (token: string) => call<{ party: unknown }>('POST', '/party/join-link', { token }),
  worlds: () => call<{ worlds: { id: string; label: string; players: number; capacity: number; friends: number }[] }>('GET', '/worlds'),
  saveSettings: (settings: unknown) => call<{ ok: true }>('POST', '/settings', { settings }),
  report: (userId: string, reason: string, context: string) => call<{ ok: true }>('POST', '/report', { userId, reason, context }),
  credits: () => call<{ models: unknown[]; audio: unknown }>('GET', '/credits'),
  adminOverview: () => call<{ instances: unknown[]; online: number; tick: unknown }>('GET', '/admin/overview'),
  adminKick: (userId: string) => call<{ ok: true }>('POST', '/admin/kick', { userId }),
  adminClose: (instanceId: string) => call<{ ok: true }>('POST', '/admin/close', { instanceId }),
  adminBroadcast: (text: string) => call<{ ok: true }>('POST', '/admin/broadcast', { text }),
  adminReports: () => call<{ reports: unknown[] }>('GET', '/admin/reports'),
  adminBan: (userId: string, hours: number, reason: string) => call<{ ok: true }>('POST', '/admin/ban', { userId, hours, reason }),
  adminResolve: (id: number) => call<{ ok: true }>('POST', '/admin/resolve', { id }),
};

// ── in-game web (phone browser) ───────────────────────────────────────────
export interface WebGarage { used: number; cap: number }
export interface WebProperty {
  id: string; name: string; kind: 'safehouse' | 'garage' | 'business'; area: string; blurb: string; price: number;
  perks: { garageSlots?: number; dailyIncome?: number; spawn?: boolean }; pos: [number, number];
  owned: boolean; boughtAt: string | null; nextCollectAt: string | null; canCollect: boolean;
}
export interface WebProperties { cash: number; garage: WebGarage; baseSlots: number; cooldownHours: number; spawn: string | null; properties: WebProperty[] }
export interface WebLedgerRow { id: number; amount: number; balance: number; reason: string; at: string }
export interface WebBank {
  cash: number; ledger: WebLedgerRow[]; friends: { id: string; name: string }[];
  limits: { dailyCap: number; sentToday: number; remaining: number; min: number; max: number };
}
export interface WebQuote { token: string; to: { id: string; name: string }; amount: number; expires: number; cashAfter: number; remainingToday: number }
export interface WebNews { ticker: { name: string; cash: number; at: string; activity: string }[]; mine: { cash: number; at: string; activity: string; kind: string }[] }
export interface WebBoards { boards: Record<string, { name: string; ms: number }[]>; richest: { name: string; cash: number }[] }
export interface WebStyleItem { id: string; name: string; price: number; desc: string; color: number; category: string }

export const webApi = {
  dealer: () => call<{ cash: number; garage: WebGarage; models: { model: string; price: number }[]; colors: number[] }>('GET', '/web/dealer'),
  buyVehicle: (model: string, color: number) => call<{ ok: true; cash: number; garage: WebGarage }>('POST', '/web/dealer/buy', { model, color }),
  properties: () => call<WebProperties>('GET', '/web/properties'),
  buyProperty: (property: string) => call<WebProperties & { ok: true }>('POST', '/web/properties/buy', { property }),
  collectProperty: (property: string) => call<WebProperties & { ok: true; amount: number }>('POST', '/web/properties/collect', { property }),
  setSpawn: (property: string | null) => call<WebProperties & { ok: true }>('POST', '/web/properties/spawn', { property }),
  bank: () => call<WebBank>('GET', '/web/bank'),
  bankQuote: (to: string, amount: number) => call<WebQuote>('POST', '/web/bank/quote', { to, amount }),
  bankTransfer: (token: string) => call<{ ok: true; cash: number; sent: number; to: string; remainingToday: number }>('POST', '/web/bank/transfer', { token }),
  arms: () => call<{ cash: number; owned: Record<string, number>; premium: number }>('GET', '/web/arms'),
  orderAmmo: (weapon: string) => call<{ ok: true; cash: number; price: number; added: number; ammo: number }>('POST', '/web/arms/ammo', { weapon }),
  news: () => call<WebNews>('GET', '/web/news'),
  leaderboard: () => call<WebBoards>('GET', '/web/leaderboard'),
  style: () => call<{ cash: number; outfit: number; items: WebStyleItem[] }>('GET', '/web/style'),
  buyStyle: (item: string) => call<{ ok: true; cash: number; outfit: number }>('POST', '/web/style/buy', { item }),
};

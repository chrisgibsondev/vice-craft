/**
 * Actions the UI calls. They talk to the server (REST via `api`, real-time via `net`)
 * and update the store. UI code should never call fetch/WebSocket directly.
 */
import { api, setToken, getToken, ApiError } from '../net/api';
import { net } from '../net/connection';
import { getState, setState, pushNotice, saveSettings } from './store';
import type { Overlay, PartyView, Settings, SocialState, ProfileView } from './types';
import type { WorldTarget } from '@blockshore/shared';

function err(e: unknown) {
  const msg = e instanceof ApiError ? e.message : String(e);
  pushNotice(msg, 'bad');
  return msg;
}

// ── auth ───────────────────────────────────────────────────────────────────
export async function login(username: string, password: string) {
  const r = await api.login(username, password);
  setToken(r.token);
  setState({ user: r.user });
  await afterAuth();
}
export async function register(username: string, password: string) {
  // a guest keeps their progress: the same account just gets a username and password
  if (getState().user?.guest && getToken()) { await api.claim(username, password); await afterAuth(); pushNotice('Account saved. You can now sign in from any device.', 'good'); return; }
  const r = await api.register(username, password);
  setToken(r.token);
  setState({ user: r.user });
  await afterAuth();
}
/** No login screen: the server hands this network address its own account. */
export async function autoLogin() {
  const r = await api.auto();
  setToken(r.token);
  setState({ user: r.user });
  await afterAuth();
}
export async function afterAuth() {
  const me = await api.me();
  setState({ user: me.user, profile: me.profile as ProfileView, screen: 'menu' });
  net.connect();
  void refreshFriends(); void refreshParty(); void refreshWorlds();
  const t = getState().joinToken;
  if (t) {
    try { await joinByLink(t); pushNotice('Joined the party from your invite link.', 'good'); }
    catch (e) { err(e); }
    setState({ joinToken: null });
    history.replaceState(null, '', location.pathname + location.search.replace(/[?&]join=[^&]*/, ''));
  }
}
export async function logout() {
  try { await api.logout(); } catch { /* ignore */ }
  net.disconnect();
  setToken(null);
  setState({ user: null, profile: null, screen: 'boot', party: null, world: null, overlay: null });
  try { await autoLogin(); } catch { setState({ screen: 'login' }); }
}

// ── social ─────────────────────────────────────────────────────────────────
export async function refreshFriends() {
  try {
    const r = await api.friends();
    setState({ social: { friends: r.friends, incoming: r.incoming, outgoing: r.outgoing, blocked: r.blocked, privacy: r.privacy } as SocialState });
  } catch (e) { err(e); }
}
export const searchUsers = (q: string) => api.search(q).then((r) => r.users).catch((e) => { err(e); return []; });
export async function sendFriendRequest(userId: string) { try { const r = await api.friendRequest(userId); pushNotice(r.message, r.result === 'sent' || r.result === 'accepted' ? 'good' : 'info'); await refreshFriends(); } catch (e) { err(e); } }
export async function addFriendByCode(code: string) { try { const r = await api.friendAddCode(code); pushNotice(r.message, r.result === 'sent' || r.result === 'accepted' ? 'good' : 'info'); await refreshFriends(); return true; } catch (e) { err(e); return false; } }
export async function respondFriend(userId: string, accept: boolean) { try { await api.friendRespond(userId, accept); await refreshFriends(); } catch (e) { err(e); } }
export async function cancelFriendRequest(userId: string) { try { await api.friendCancel(userId); await refreshFriends(); } catch (e) { err(e); } }
export async function removeFriend(userId: string) { try { await api.friendRemove(userId); await refreshFriends(); } catch (e) { err(e); } }
export async function setBlocked(userId: string, block: boolean) { try { await api.block(userId, block); await refreshFriends(); await refreshParty(); } catch (e) { err(e); } }
export async function setPrivacy(presence: string, invites: string) { try { await api.privacy(presence, invites); await refreshFriends(); } catch (e) { err(e); } }
export async function reportPlayer(userId: string, reason: string, context = '') { try { await api.report(userId, reason, context); pushNotice('Report sent. Thank you.', 'good'); } catch (e) { err(e); } }

// ── party ──────────────────────────────────────────────────────────────────
export async function refreshParty() {
  try { const r = await api.party(); setState({ party: r.party as PartyView | null, partyInvites: r.invites as never }); } catch (e) { err(e); }
}
export async function createParty() { try { const r = await api.partyCreate(); setState({ party: r.party as PartyView }); } catch (e) { err(e); } }
export async function inviteToParty(userId: string) { try { const r = await api.partyInvite(userId); setState({ party: r.party as PartyView }); pushNotice('Invite sent.', 'good'); } catch (e) { err(e); } }
export async function acceptPartyInvite(partyId: string) {
  try {
    const r = await api.partyAccept(partyId);
    setState({ party: r.party as PartyView, partyInvites: getState().partyInvites.filter((i) => i.partyId !== partyId) });
    pushNotice('You joined the party.', 'good');
    if (getState().world) joinWorld('party');
  } catch (e) { err(e); await refreshParty(); }
}
export async function declinePartyInvite(partyId: string) { try { await api.partyDecline(partyId); setState({ partyInvites: getState().partyInvites.filter((i) => i.partyId !== partyId) }); } catch (e) { err(e); } }
export async function leaveParty() { try { await api.partyLeave(); setState({ party: null }); } catch (e) { err(e); } }
export async function kickFromParty(userId: string) { try { const r = await api.partyKick(userId); setState({ party: r.party as PartyView }); } catch (e) { err(e); } }
export async function transferLeader(userId: string) { try { const r = await api.partyTransfer(userId); setState({ party: r.party as PartyView }); } catch (e) { err(e); } }
export async function createInviteLink(): Promise<string | null> {
  try { const r = await api.partyLink(); await refreshParty(); return r.url; } catch (e) { err(e); return null; }
}
export async function joinByLink(token: string) { const r = await api.partyJoinLink(token); setState({ party: r.party as PartyView }); }
export function partyChat(text: string) { net.send({ t: 'chat', ch: 'party', text }); }

// ── worlds ─────────────────────────────────────────────────────────────────
export async function refreshWorlds() { try { const r = await api.worlds(); setState({ worlds: r.worlds }); } catch (e) { err(e); } }
export function joinWorld(target: WorldTarget) {
  setState({ screen: 'loading', overlay: null, loading: { progress: 0, label: 'Joining world…' } });
  net.send({ t: 'world.join', target });
}
export function leaveWorld() { net.send({ t: 'world.leave' }); setState({ screen: 'menu', world: null, overlay: null, activity: null }); }

// ── activities ─────────────────────────────────────────────────────────────
export function openBrief(activityId: string) { net.send({ t: 'act.brief', activity: activityId }); }
export function openContact(contactId: string) { net.send({ t: 'act.brief', activity: `contact:${contactId}` }); }
export function openLobby(activityId: string) { net.send({ t: 'act.lobby', activity: activityId }); }
export function setReady(ready: boolean) { net.send({ t: 'act.ready', ready }); }
export function configureLobby(cfg: { approach?: 'quiet' | 'loud' | 'con'; equipment?: string[]; split?: Record<string, number>; difficulty?: 'normal' | 'hard'; choice?: string }) { net.send({ t: 'act.config', ...cfg }); }
export function setRole(role: 'none' | 'driver' | 'hacker' | 'muscle' | 'lookout') { net.send({ t: 'act.role', role }); }
export function launchActivity() { net.send({ t: 'act.launch' }); }
export function cancelLobby() { net.send({ t: 'act.cancel' }); setState({ lobby: null, overlay: null }); }
export function leaveActivity() { net.send({ t: 'act.leave' }); }
export function retryActivity() { net.send({ t: 'act.retry' }); }
export function continueResults() { net.send({ t: 'act.continue' }); setState({ results: null, overlay: null }); }
export function skipCutscene() { net.send({ t: 'cs.skip' }); setState((s) => ({ cutscene: s.cutscene ? { ...s.cutscene, voted: true } : null })); }

// ── economy ────────────────────────────────────────────────────────────────
export function buy(shop: string, item: string) { net.send({ t: 'shop.buy', shop, item }); }
export function useItem(item: string) { net.send({ t: 'item.use', item }); }
export function garage(op: 'repair' | 'paint' | 'store' | 'spawn' | 'buy' | 'deliver', args: { vehicle?: string; model?: string; color?: number } = {}) { net.send({ t: 'garage', op, ...args }); }
export function payWanted() { net.send({ t: 'wanted.pay' }); }

// ── chat / pings ───────────────────────────────────────────────────────────
export function sendChat(ch: 'party' | 'world' | 'activity', text: string) { if (text.trim()) net.send({ t: 'chat', ch, text: text.trim().slice(0, 200) }); }

// ── UI ─────────────────────────────────────────────────────────────────────
export function openOverlay(o: Overlay) {
  if (o === 'phone' && getState().overlay !== 'phone') void import('../audio').then(({ audio }) => audio.sfx('phone_open', { volume: 0.5 }));
  setState({ overlay: o });
  if (o) document.exitPointerLock?.();
  if (o === 'social') { void refreshFriends(); void refreshParty(); }
  if (o === 'worlds') void refreshWorlds();
}
export function closeOverlay() {
  const s = getState();
  if (s.overlay === 'phone') void import('../audio').then(({ audio }) => audio.sfx('phone_close', { volume: 0.45 }));
  if (s.overlay === 'lobby' && s.lobby) { /* keep lobby alive; just hide */ }
  setState({ overlay: null, shop: s.overlay === 'shop' ? null : s.shop, brief: s.overlay === 'brief' ? null : s.brief });
}
export function updateSettings(patch: Partial<Settings>) {
  const s = { ...getState().settings, ...patch };
  saveSettings(s);
  void api.saveSettings(s).catch(() => { /* offline: local only */ });
}

// ── in-game web ────────────────────────────────────────────────────────────
/** Keep the phone's cash counter in step with a purchase made over REST (the server also pushes a full profile). */
export function syncCash(cash: number) { setState((s) => (s.profile ? { profile: { ...s.profile, cash } } : {})); }
/** Reflect a remote outfit change right away. */
export function syncOutfit(outfit: number) { setState((s) => (s.profile ? { profile: { ...s.profile, outfit } } : {})); }

/**
 * Sign in with Google (Google Identity Services button → ID token) and Sign in with X
 * (OAuth 2.0 + PKCE redirect). The server links the provider account to the current game account.
 */
import { api, setToken } from './api';
import { setState, pushNotice } from '../state/store';
import { afterAuth } from '../state/actions';

let providers: { google: string | null; x: string | null } | null = null;
export async function getProviders() {
  if (!providers) { try { providers = await api.providers(); } catch { return { google: null, x: null }; } }
  return providers;
}

async function finish(r: { token: string; switched: boolean; linked: boolean }, label: string) {
  setToken(r.token);
  await afterAuth();
  pushNotice(r.switched ? `Signed in with ${label}.` : r.linked ? `Account saved with ${label}. Sign in with it on any device.` : `Signed in with ${label}.`, 'good');
}

// ── Google ───────────────────────────────────────────────────────────────────
type GoogleId = { accounts: { id: { initialize(o: unknown): void; renderButton(el: HTMLElement, o: unknown): void } } };
let gisLoading: Promise<void> | null = null;
function loadGis(): Promise<void> {
  if ((window as unknown as { google?: GoogleId }).google?.accounts) return Promise.resolve();
  gisLoading ??= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = () => res(); s.onerror = () => { gisLoading = null; rej(new Error('Could not load Google sign-in.')); };
    document.head.appendChild(s);
  });
  return gisLoading;
}
/** Draws Google's own sign-in button into `el`. */
export async function mountGoogleButton(el: HTMLElement, clientId: string, onError: (m: string) => void) {
  await loadGis();
  const g = (window as unknown as { google: GoogleId }).google;
  g.accounts.id.initialize({
    client_id: clientId,
    callback: async (resp: { credential?: string }) => {
      if (!resp.credential) { onError('Google sign-in was cancelled.'); return; }
      try { await finish(await api.oauth({ provider: 'google', idToken: resp.credential }), 'Google'); }
      catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    },
  });
  el.innerHTML = '';
  g.accounts.id.renderButton(el, { theme: 'filled_black', size: 'large', shape: 'pill', text: 'continue_with', width: Math.min(360, el.clientWidth || 320) });
}

// ── X ────────────────────────────────────────────────────────────────────────
const b64url = (a: Uint8Array) => btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const redirectUri = () => `${location.origin}/`;
export async function startX(clientId: string) {
  const v = new Uint8Array(48); crypto.getRandomValues(v);
  const verifier = b64url(v);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const st = new Uint8Array(16); crypto.getRandomValues(st);
  const state = b64url(st);
  try { sessionStorage.setItem('blockshore.xauth', JSON.stringify({ state, verifier, back: location.search })); } catch { /* ignore */ }
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri(), scope: 'users.read tweet.read', state, code_challenge: challenge, code_challenge_method: 'S256' });
  location.href = `https://x.com/i/oauth2/authorize?${q}`;
}
/** Called once at boot: completes an X sign-in if we just came back from x.com. */
export async function finishXIfReturning() {
  const p = new URLSearchParams(location.search);
  const code = p.get('code'), state = p.get('state'), denied = p.get('error');
  if (!state || (!code && !denied)) return;
  let saved: { state: string; verifier: string; back: string } | null = null;
  try { saved = JSON.parse(sessionStorage.getItem('blockshore.xauth') ?? 'null'); sessionStorage.removeItem('blockshore.xauth'); } catch { /* ignore */ }
  history.replaceState(null, '', location.pathname + (saved?.back ?? ''));
  if (!saved || saved.state !== state) return;
  if (denied || !code) { pushNotice('X sign-in was cancelled.', 'info'); return; }
  try { await finish(await api.oauth({ provider: 'x', code, verifier: saved.verifier, redirectUri: redirectUri() }), 'X'); }
  catch (e) { setState({ screen: 'login' }); pushNotice(e instanceof Error ? e.message : String(e), 'bad'); }
}

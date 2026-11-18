/**
 * "Sign in with Google" and "Sign in with X". Both only need a public client id (no secret is
 * required: Google returns a signed ID token to the browser, X uses OAuth 2.0 with PKCE).
 * Env: GOOGLE_CLIENT_ID, X_CLIENT_ID, optional X_CLIENT_SECRET (for an X app set up as "confidential").
 * Returns the provider's stable account id plus a display name; the caller links it to a game account.
 */
export interface OAuthIdentity { provider: 'google' | 'x'; subject: string; name: string }

export const oauthConfig = {
  google: process.env.GOOGLE_CLIENT_ID?.trim() || null,
  x: process.env.X_CLIENT_ID?.trim() || null,
  xSecret: process.env.X_CLIENT_SECRET?.trim() || null,
};

export class OAuthError extends Error {}

/** Verify a Google ID token (the `credential` from Google Identity Services). */
export async function verifyGoogle(idToken: string): Promise<OAuthIdentity> {
  if (!oauthConfig.google) throw new OAuthError('Google sign-in is not set up on this server.');
  const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`);
  if (!r.ok) throw new OAuthError('Google sign-in failed. Try again.');
  const t = await r.json() as { aud?: string; iss?: string; sub?: string; exp?: string; name?: string; given_name?: string; email?: string };
  if (t.aud !== oauthConfig.google) throw new OAuthError('Google sign-in failed (wrong app).');
  if (t.iss !== 'accounts.google.com' && t.iss !== 'https://accounts.google.com') throw new OAuthError('Google sign-in failed.');
  if (!t.sub || Number(t.exp) * 1000 < Date.now()) throw new OAuthError('Google sign-in expired. Try again.');
  return { provider: 'google', subject: t.sub, name: t.given_name || t.name || 'Player' };
}

/** Exchange an X authorization code (PKCE) and read the signed-in X account. */
export async function verifyX(code: string, verifier: string, redirectUri: string): Promise<OAuthIdentity> {
  if (!oauthConfig.x) throw new OAuthError('X sign-in is not set up on this server.');
  const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, client_id: oauthConfig.x });
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (oauthConfig.xSecret) headers.Authorization = 'Basic ' + Buffer.from(`${oauthConfig.x}:${oauthConfig.xSecret}`).toString('base64');
  const tr = await fetch('https://api.x.com/2/oauth2/token', { method: 'POST', headers, body: form });
  if (!tr.ok) throw new OAuthError('X sign-in failed. Try again.');
  const tok = await tr.json() as { access_token?: string };
  if (!tok.access_token) throw new OAuthError('X sign-in failed.');
  const ur = await fetch('https://api.x.com/2/users/me', { headers: { Authorization: `Bearer ${tok.access_token}` } });
  if (!ur.ok) throw new OAuthError('Could not read your X account. Try again later.');
  const u = await ur.json() as { data?: { id?: string; username?: string; name?: string } };
  if (!u.data?.id) throw new OAuthError('Could not read your X account.');
  return { provider: 'x', subject: u.data.id, name: u.data.username || u.data.name || 'Player' };
}

/** A display name that is safe to show in game (letters, digits, underscore, 3–16 chars). */
export function cleanName(n: string): string {
  const s = n.normalize('NFKD').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
  return s.length >= 3 ? s : `Player_${s}`.slice(0, 16);
}

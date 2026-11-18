/**
 * REST API: accounts, social graph, parties, worlds, settings, moderation, admin,
 * health. JSON in/out, bearer-token auth, per-IP and per-user rate limits.
 * In production the same server also serves the built client (single origin).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync, readFileSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { USERNAME_RE, validatePassword } from './auth.ts';
import { RateLimiter } from './ratelimit.ts';
import { config, originAllowed } from './config.ts';
import { log } from './log.ts';
import type { Game } from './game.ts';
import type { User } from './store.ts';
import { makeWebRoutes } from './web.ts';
import { oauthConfig, verifyGoogle, verifyX, cleanName, OAuthError } from './oauth.ts';

class HttpError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }

const authLimiter = new RateLimiter(config.test ? 10_000 : 10, (config.test ? 10_000 : 10) / 60);      // per minute per IP / username
const REG_PER_HOUR = config.test ? 10_000 : config.isProd ? 5 : 60;
const registerLimiter = new RateLimiter(REG_PER_HOUR, REG_PER_HOUR / 3600);  // per IP
const socialLimiter = new RateLimiter(config.test ? 10_000 : 30, config.test ? 10_000 : 0.5);        // per user
const apiLimiter = new RateLimiter(config.test ? 100_000 : 120, config.test ? 100_000 : 20);           // per IP

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.glb': 'model/gltf-binary', '.woff2': 'font/woff2', '.map': 'application/json',
};

export function clientIp(req: IncomingMessage): string {
  if (config.trustProxy) {
    const f = req.headers['x-forwarded-for'];
    if (typeof f === 'string') return f.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? '?';
}

async function body(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > 32 * 1024) { reject(new HttpError(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}

const idBody = z.object({ userId: z.string().min(1).max(64) });

export function makeHttpHandler(game: Game) {
  const store = game.store;

  async function authed(req: IncomingMessage): Promise<User> {
    const h = req.headers.authorization ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    const u = token ? await store.sessionUser(token) : null;
    if (!u) throw new HttpError(401, 'Please log in.', 'auth');
    return u;
  }
  function admin(u: User) { if (!u.is_admin) throw new HttpError(403, 'Administrators only.'); }
  function parse<T>(schema: z.ZodType<T>, data: unknown): T {
    const r = schema.safeParse(data);
    if (!r.success) throw new HttpError(400, 'Invalid request.');
    return r.data;
  }
  function socialRate(u: User) { if (!socialLimiter.take(u.id)) throw new HttpError(429, 'Slow down a little.'); }

  async function blockedWithParty(userId: string, members: string[]) {
    for (const m of members) if (await store.isBlockedEither(userId, m)) return true;
    return false;
  }

  const routes: Record<string, (req: IncomingMessage, url: URL) => Promise<unknown>> = {
    // ── auth
    'POST /api/auth/register': async (req) => {
      const ip = clientIp(req);
      if (!registerLimiter.take(ip)) throw new HttpError(429, 'Too many new accounts from this network. Try later.');
      const b = parse(z.object({ username: z.string(), password: z.string() }), await body(req));
      if (!USERNAME_RE.test(b.username)) throw new HttpError(400, 'Username: 3–16 letters, numbers or _.');
      const pe = validatePassword(b.password);
      if (pe) throw new HttpError(400, pe);
      const u = await store.createUser(b.username, b.password);
      if (u === 'taken') throw new HttpError(409, 'That username is taken.');
      const token = await store.createSession(u.id, String(req.headers['user-agent'] ?? ''));
      await store.audit(u.id, 'register', { ip });
      return { token, user: { id: u.id, name: u.display_name, admin: u.is_admin } };
    },
    // no login needed: every network address gets its own guest account (slot = extra local players for testing)
    'POST /api/auth/auto': async (req) => {
      const ip = clientIp(req);
      if (!authLimiter.take(`auto:${ip}`)) throw new HttpError(429, 'Too many attempts. Wait a minute.');
      const b = parse(z.object({ slot: z.string().max(8).regex(/^[a-zA-Z0-9]*$/).optional(), device: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/).optional() }), await body(req).catch(() => ({})));
      // one guest account per browser/device (a random id the client keeps); the network address is only the
      // fallback when the browser can't store it, so people sharing Wi-Fi still get separate accounts
      const who = b.device ? `dev:${b.device}` : `ip:${ip}:${b.slot && b.slot !== '1' ? b.slot : ''}`;
      const ipKey = createHash('sha256').update(`blockshore-guest:${process.env.IP_ACCOUNT_SALT ?? ''}:${who}`).digest('hex').slice(0, 40);
      const u = await store.guestForIp(ipKey);
      if (u.banned_until && new Date(u.banned_until) > new Date()) throw new HttpError(403, `Account suspended until ${new Date(u.banned_until).toUTCString()}${u.ban_reason ? ` (${u.ban_reason})` : ''}.`);
      const token = await store.createSession(u.id, String(req.headers['user-agent'] ?? ''));
      return { token, user: { id: u.id, name: u.display_name, admin: u.is_admin, guest: true } };
    },
    // a guest picks a username and password: same account and progress, now usable from any device
    'POST /api/auth/claim': async (req) => {
      const u = await authed(req);
      const ip = clientIp(req);
      if (!registerLimiter.take(ip)) throw new HttpError(429, 'Too many new accounts from this network. Try later.');
      const b = parse(z.object({ username: z.string(), password: z.string() }), await body(req));
      if (!USERNAME_RE.test(b.username)) throw new HttpError(400, 'Username: 3–16 letters, numbers or _.');
      const pe = validatePassword(b.password);
      if (pe) throw new HttpError(400, pe);
      const r = await store.claimGuest(u.id, b.username, b.password);
      if (r === 'taken') throw new HttpError(409, 'That username is taken.');
      if (r === 'not_guest') throw new HttpError(400, 'This account already has a login.');
      await store.audit(u.id, 'claim', { ip });
      return { user: { id: r.id, name: r.display_name, admin: r.is_admin, guest: false } };
    },
    // which "Sign in with …" buttons to show (client ids are public)
    'GET /api/auth/providers': async () => ({ google: oauthConfig.google, x: oauthConfig.x }),
    // Sign in with Google / X. Signed in as a guest: links to that account (progress kept). Provider already
    // linked to another account: switches to it. Otherwise links to the current account.
    'POST /api/auth/oauth': async (req) => {
      const ip = clientIp(req);
      if (!authLimiter.take(`oauth:${ip}`)) throw new HttpError(429, 'Too many sign-in attempts. Wait a minute.');
      const b = parse(z.object({
        provider: z.enum(['google', 'x']),
        idToken: z.string().max(4096).optional(),
        code: z.string().max(1024).optional(), verifier: z.string().min(43).max(128).optional(), redirectUri: z.string().url().max(300).optional(),
      }), await body(req));
      let me: User | null = null;
      try { me = await authed(req); } catch { /* not signed in */ }
      let id;
      try {
        if (b.provider === 'google') { if (!b.idToken) throw new OAuthError('Missing Google credential.'); id = await verifyGoogle(b.idToken); }
        else {
          if (!b.code || !b.verifier || !b.redirectUri) throw new OAuthError('Missing X sign-in details.');
          const ru = new URL(b.redirectUri);
          const okOrigin = originAllowed(ru.origin) || (!config.isProd && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(ru.origin));
          if (!okOrigin) throw new OAuthError('Sign-in came from an unknown site.');
          id = await verifyX(b.code, b.verifier, b.redirectUri);
        }
      } catch (e) { throw new HttpError(e instanceof OAuthError ? 400 : 502, e instanceof Error ? e.message : 'Sign-in failed.'); }
      const existing = await store.userByIdentity(id.provider, id.subject);
      let u: User;
      if (existing) u = existing;
      else if (me) u = await store.linkIdentity(me.id, id.provider, id.subject, cleanName(id.name));
      else {
        const g = await store.guestForIp(createHash('sha256').update(`oauth:${id.provider}:${id.subject}`).digest('hex').slice(0, 40));
        u = await store.linkIdentity(g.id, id.provider, id.subject, cleanName(id.name));
      }
      if (u.banned_until && new Date(u.banned_until) > new Date()) throw new HttpError(403, `Account suspended until ${new Date(u.banned_until).toUTCString()}${u.ban_reason ? ` (${u.ban_reason})` : ''}.`);
      const token = await store.createSession(u.id, String(req.headers['user-agent'] ?? ''));
      await store.audit(u.id, 'oauth', { provider: id.provider, ip, switched: !!(existing && me && existing.id !== me.id) });
      return { token, user: { id: u.id, name: u.display_name, admin: u.is_admin, guest: false }, switched: !!(existing && me && existing.id !== me.id), linked: !existing };
    },
    'POST /api/auth/login': async (req) => {
      const ip = clientIp(req);
      const b = parse(z.object({ username: z.string().max(32), password: z.string().max(200) }), await body(req));
      if (!authLimiter.take(ip) || !authLimiter.take(`u:${b.username.toLowerCase()}`)) throw new HttpError(429, 'Too many login attempts. Wait a minute.');
      const u = await store.login(b.username, b.password);
      if (!u) throw new HttpError(401, 'Wrong username or password.');
      if (u.banned_until && new Date(u.banned_until) > new Date()) throw new HttpError(403, `Account suspended until ${new Date(u.banned_until).toUTCString()}${u.ban_reason ? ` (${u.ban_reason})` : ''}.`);
      const token = await store.createSession(u.id, String(req.headers['user-agent'] ?? ''));
      return { token, user: { id: u.id, name: u.display_name, admin: u.is_admin } };
    },
    'POST /api/auth/logout': async (req) => {
      const h = req.headers.authorization ?? '';
      if (h.startsWith('Bearer ')) await store.deleteSession(h.slice(7));
      return { ok: true };
    },
    'GET /api/me': async (req) => {
      const u = await authed(req);
      const p = await store.profile(u.id);
      const vehicles = await store.vehicles(u.id);
      return {
        user: { id: u.id, name: u.display_name, admin: u.is_admin, guest: u.is_guest, friendCode: await store.friendCode(u.id), linked: await store.identities(u.id) },
        profile: { ...p, vehicles: vehicles.map((v) => ({ id: v.id, model: v.model, color: v.color, health: v.health, state: v.state })), bests: {}, weapons: [{ id: 'stun', ammo: 999 }], equipped: 'stun' },
        privacy: { presence: u.presence_visibility, invites: u.invite_policy },
      };
    },
    // ── social
    'GET /api/users/search': async (req, url) => {
      const u = await authed(req);
      socialRate(u);
      const users = await store.searchUsers(url.searchParams.get('q') ?? '', u.id);
      const friends = new Set(await store.friendIds(u.id));
      const reqs = await store.friendRequests(u.id);
      const pending = new Set([...reqs.outgoing, ...reqs.incoming].map((r) => r.id));
      return { users: users.map((x) => ({ ...x, friend: friends.has(x.id), pending: pending.has(x.id) })) };
    },
    'GET /api/friends': async (req) => {
      const u = await authed(req);
      const party = game.parties.of(u.id);
      const me = game.presenceOf(u.id);
      const friends = (await store.friendsWithInfo(u.id)).map((f) => {
        const hidden = f.presence_visibility === 'nobody';
        const pr = hidden ? { status: 'offline' as const } : game.presenceOf(f.id);
        const inst = 'instance' in pr && pr.instance ? game.instances.get(pr.instance) : null;
        return {
          id: f.id, name: f.name, status: pr.status, where: 'where' in pr ? pr.where : undefined,
          joinable: !!inst && inst.kind === 'world' && inst.hasRoom() && inst.id !== ('instance' in me ? me.instance : undefined),
          inMyParty: !!party?.members.includes(f.id),
          instance: inst?.kind === 'world' ? inst.id : undefined,
        };
      });
      const r = await store.friendRequests(u.id);
      return { friends, incoming: r.incoming, outgoing: r.outgoing, blocked: await store.blockedList(u.id), privacy: { presence: u.presence_visibility, invites: u.invite_policy } };
    },
    'POST /api/friends/request': async (req) => {
      const u = await authed(req); socialRate(u);
      const b = parse(idBody, await body(req));
      const target = await store.getUser(b.userId);
      if (!target) throw new HttpError(404, 'Player not found.');
      const r = await store.sendFriendRequest(u.id, target.id);
      const msg: Record<string, string> = { sent: `Friend request sent to ${target.display_name}.`, accepted: `You and ${target.display_name} are now friends.`, self: 'That\'s you.', blocked: 'You can\'t add this player.', already: 'Already friends.', pending: 'Request already sent.', limit: 'Too many pending requests.' };
      if (r === 'sent') game.send(target.id, { t: 'social', event: 'friend_request', data: { id: u.id, name: u.display_name } });
      if (r === 'accepted') game.send(target.id, { t: 'social', event: 'friend_accepted', data: { id: u.id, name: u.display_name } });
      return { result: r, message: msg[r] };
    },
    'POST /api/friends/add-code': async (req) => {
      const u = await authed(req); socialRate(u);
      const b = parse(z.object({ code: z.string().regex(/^\d{5}$/, 'Friend codes are 5 digits.') }), await body(req));
      const target = await store.userByFriendCode(b.code);
      if (!target) throw new HttpError(404, 'No player has that friend code.');
      const r = await store.sendFriendRequest(u.id, target.id);
      const msg: Record<string, string> = { sent: `Friend request sent to ${target.display_name}.`, accepted: `You and ${target.display_name} are now friends.`, self: 'That\'s your own code.', blocked: 'You can\'t add this player.', already: 'Already friends.', pending: 'Request already sent.', limit: 'Too many pending requests.' };
      if (r === 'sent') game.send(target.id, { t: 'social', event: 'friend_request', data: { id: u.id, name: u.display_name } });
      if (r === 'accepted') game.send(target.id, { t: 'social', event: 'friend_accepted', data: { id: u.id, name: u.display_name } });
      return { result: r, message: msg[r] };
    },
    'POST /api/friends/respond': async (req) => {
      const u = await authed(req); socialRate(u);
      const b = parse(z.object({ userId: z.string().max(64), accept: z.boolean() }), await body(req));
      if (b.accept) {
        const ok = await store.acceptFriend(u.id, b.userId);
        if (!ok) throw new HttpError(404, 'That request no longer exists.');
        game.send(b.userId, { t: 'social', event: 'friend_accepted', data: { id: u.id, name: u.display_name } });
      } else await store.declineFriend(u.id, b.userId);
      return { ok: true };
    },
    'POST /api/friends/cancel': async (req) => { const u = await authed(req); const b = parse(idBody, await body(req)); await store.cancelFriendRequest(u.id, b.userId); return { ok: true }; },
    'POST /api/friends/remove': async (req) => {
      const u = await authed(req); const b = parse(idBody, await body(req));
      await store.removeFriend(u.id, b.userId);
      game.send(b.userId, { t: 'social', event: 'friends' });
      return { ok: true };
    },
    'POST /api/blocks': async (req) => {
      const u = await authed(req); socialRate(u);
      const b = parse(z.object({ userId: z.string().max(64), block: z.boolean() }), await body(req));
      if (b.userId === u.id) throw new HttpError(400, 'You can\'t block yourself.');
      if (b.block) {
        await store.block(u.id, b.userId);
        // a block also separates parties
        const p = game.parties.of(u.id);
        if (p?.members.includes(b.userId)) { if (p.leader === u.id) game.parties.kick(u.id, b.userId); else game.parties.leave(u.id); }
      } else await store.unblock(u.id, b.userId);
      for (const id of [u.id, b.userId]) { const s = game.sessions.get(id); if (s) { const other = id === u.id ? b.userId : u.id; if (b.block) s.blocked.add(other); else s.blocked.delete(other); } }
      game.send(b.userId, { t: 'social', event: 'friends' });
      return { ok: true };
    },
    'POST /api/privacy': async (req) => {
      const u = await authed(req);
      const b = parse(z.object({ presence: z.enum(['everyone', 'friends', 'nobody']), invites: z.enum(['friends', 'nobody']) }), await body(req));
      await store.setPrivacy(u.id, b.presence, b.invites);
      game.pushPresence(u.id);
      return { ok: true };
    },
    // ── parties
    'GET /api/party': async (req) => {
      const u = await authed(req);
      return { party: game.partyView(game.parties.of(u.id)), invites: game.parties.invitesFor(u.id) };
    },
    'POST /api/party/create': async (req) => { const u = await authed(req); return { party: game.partyView(game.parties.ensure(u.id, u.display_name)) }; },
    'POST /api/party/invite': async (req) => {
      const u = await authed(req); socialRate(u);
      const b = parse(idBody, await body(req));
      const target = await store.getUser(b.userId);
      if (!target) throw new HttpError(404, 'Player not found.');
      const r = await game.parties.invite(u.id, u.display_name, target.id, { friends: await store.areFriends(u.id, target.id), blocked: await store.isBlockedEither(u.id, target.id), invitePolicy: target.invite_policy });
      if (typeof r === 'string') throw new HttpError(400, game.partyError(r));
      return { party: game.partyView(r) };
    },
    'POST /api/party/accept': async (req) => {
      const u = await authed(req);
      const b = parse(z.object({ partyId: z.string().max(64) }), await body(req));
      const p = game.parties.get(b.partyId);
      const r = game.parties.accept(u.id, u.display_name, b.partyId, p ? await blockedWithParty(u.id, p.members) : false);
      if (typeof r === 'string') throw new HttpError(400, game.partyError(r));
      return { party: game.partyView(r) };
    },
    'POST /api/party/decline': async (req) => { const u = await authed(req); const b = parse(z.object({ partyId: z.string().max(64) }), await body(req)); game.parties.decline(u.id, b.partyId); return { ok: true }; },
    'POST /api/party/leave': async (req) => {
      const u = await authed(req);
      const before = game.parties.of(u.id);
      game.parties.leave(u.id);
      if (before) game.send(u.id, { t: 'social', event: 'party', data: null });
      return { ok: true };
    },
    'POST /api/party/kick': async (req) => {
      const u = await authed(req); const b = parse(idBody, await body(req));
      const r = game.parties.kick(u.id, b.userId);
      if (typeof r === 'string') throw new HttpError(400, game.partyError(r));
      game.send(b.userId, { t: 'social', event: 'party_kicked' });
      return { party: game.partyView(r) };
    },
    'POST /api/party/transfer': async (req) => {
      const u = await authed(req); const b = parse(idBody, await body(req));
      const r = game.parties.transfer(u.id, b.userId);
      if (typeof r === 'string') throw new HttpError(400, game.partyError(r));
      return { party: game.partyView(r) };
    },
    'POST /api/party/link': async (req) => {
      const u = await authed(req); socialRate(u);
      const r = game.parties.createLink(u.id, u.display_name);
      if (typeof r === 'string') throw new HttpError(400, game.partyError(r));
      const origin = String(req.headers.origin ?? `http://${req.headers.host}`);
      return { token: r.token, url: `${origin}/?join=${r.token}`, expires: r.expires };
    },
    'POST /api/party/join-link': async (req) => {
      const u = await authed(req); socialRate(u);
      const b = parse(z.object({ token: z.string().max(64) }), await body(req));
      const p = game.parties.findByLink(b.token);
      const r = game.parties.joinByLink(u.id, u.display_name, b.token, p ? await blockedWithParty(u.id, p.members) : false);
      if (typeof r === 'string') throw new HttpError(400, game.partyError(r));
      return { party: game.partyView(r) };
    },
    // ── worlds & misc
    'GET /api/worlds': async (req) => {
      const u = await authed(req);
      const friends = new Set(await store.friendIds(u.id));
      return { worlds: game.lobbyList(u.id, friends) };
    },
    'POST /api/settings': async (req) => {
      const u = await authed(req);
      const b = parse(z.object({ settings: z.record(z.string(), z.unknown()) }), await body(req));
      if (JSON.stringify(b.settings).length > 8000) throw new HttpError(400, 'Settings too large.');
      await store.saveSettings(u.id, b.settings);
      return { ok: true };
    },
    'POST /api/report': async (req) => {
      const u = await authed(req); socialRate(u);
      const b = parse(z.object({ userId: z.string().max(64), reason: z.string().min(1).max(200), context: z.string().max(1000).optional() }), await body(req));
      if (!(await store.getUser(b.userId))) throw new HttpError(404, 'Player not found.');
      await store.report(u.id, b.userId, b.reason, b.context ?? '');
      return { ok: true };
    },
    'GET /api/credits': async () => {
      const read = (p: string) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
      const base = existsSync(config.clientDist) ? config.clientDist : join(config.clientDist, '..', 'public');
      return { models: read(join(base, 'models', 'manifest.json')) ?? [], audio: read(join(base, 'audio', 'manifest.json')) ?? {} };
    },
    'GET /api/health': async () => ({
      ok: true, uptimeS: Math.round((Date.now() - game.startedAt) / 1000), db: store.db.kind,
      instances: game.instances.size, online: game.sessions.size,
      tick: { avgMs: +game.tickStats.avg.toFixed(2), maxMs: +game.tickStats.max.toFixed(2), ticks: game.tickStats.count },
      memMb: Math.round(process.memoryUsage().rss / 1e6),
    }),
    // ── admin
    'GET /api/admin/overview': async (req) => {
      admin(await authed(req));
      return {
        online: game.sessions.size,
        tick: game.tickStats,
        instances: [...game.instances.values()].map((i) => ({
          id: i.id, kind: i.kind, label: i.label, players: [...i.players.values()].map((p) => ({ id: p.userId, name: p.name, linkdead: !!p.linkdeadAt })),
          vehicles: i.vehicles.size, npcs: i.npcs.size, activity: i.run ? { id: i.run.id, name: i.run.def.name, phase: i.run.phase, stage: i.run.stage()?.title } : null,
          ageS: Math.round((Date.now() - i.createdAt) / 1000),
        })),
      };
    },
    'POST /api/admin/kick': async (req) => {
      const a = await authed(req); admin(a);
      const b = parse(idBody, await body(req));
      const s = game.sessions.get(b.userId);
      if (s) s.ws.close(4004, 'Removed by an administrator');
      await store.audit(a.id, 'kick', { target: b.userId });
      return { ok: true };
    },
    'POST /api/admin/close': async (req) => {
      const a = await authed(req); admin(a);
      const b = parse(z.object({ instanceId: z.string().max(64) }), await body(req));
      const inst = game.instances.get(b.instanceId);
      if (!inst) throw new HttpError(404, 'Instance not found.');
      if (inst.run) inst.run.abandon('Closed by an administrator');
      else game.closeInstance(inst);
      await store.audit(a.id, 'close_instance', { instance: b.instanceId });
      return { ok: true };
    },
    'POST /api/admin/broadcast': async (req) => {
      const a = await authed(req); admin(a);
      const b = parse(z.object({ text: z.string().min(1).max(200) }), await body(req));
      for (const id of game.sessions.keys()) game.notify(id, `ADMIN: ${b.text}`, 'mission', 'notify');
      await store.audit(a.id, 'broadcast', { text: b.text });
      return { ok: true };
    },
    'GET /api/admin/reports': async (req) => { admin(await authed(req)); return { reports: await store.reports() }; },
    'POST /api/admin/ban': async (req) => {
      const a = await authed(req); admin(a);
      const b = parse(z.object({ userId: z.string().max(64), hours: z.number().int().min(1).max(24 * 365), reason: z.string().max(200) }), await body(req));
      await store.ban(b.userId, b.hours, b.reason);
      const s = game.sessions.get(b.userId);
      if (s) s.ws.close(4004, 'Account suspended');
      await store.audit(a.id, 'ban', b);
      return { ok: true };
    },
    'POST /api/admin/resolve': async (req) => { const a = await authed(req); admin(a); const b = parse(z.object({ id: z.number().int() }), await body(req)); await store.resolveReport(b.id); return { ok: true }; },
    // ── in-game web (phone browser): routes live in web.ts
    ...makeWebRoutes({ game, authed, parse, body, HttpError }),
  };

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const origin = req.headers.origin;
    if (origin && originAllowed(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (url.pathname.startsWith('/api/')) {
      const ip = clientIp(req);
      if (!apiLimiter.take(ip)) return send(res, 429, { error: 'Too many requests.' });
      let key = `${req.method} ${url.pathname}`;
      if (url.pathname.startsWith('/api/party/link/') && req.method === 'GET') {
        const token = decodeURIComponent(url.pathname.slice('/api/party/link/'.length));
        const p = game.parties.findByLink(token);
        if (!p || !p.link || p.link.expires < Date.now()) return send(res, 404, { error: 'This invite link has expired.' });
        return send(res, 200, { leaderName: p.names[p.leader], size: p.members.length, expires: p.link.expires });
      }
      const h = routes[key];
      if (!h) { key = ''; return send(res, 404, { error: 'Not found.' }); }
      try {
        send(res, 200, await h(req, url));
      } catch (e) {
        if (e instanceof HttpError) send(res, e.status, { error: e.message, code: e.code });
        else { log.error('http error', { path: url.pathname, err: String((e as Error).stack ?? e) }); send(res, 500, { error: 'Something went wrong on our side.' }); }
      }
      return;
    }
    // static client (production)
    if (!existsSync(config.clientDist)) { res.writeHead(404); res.end('Client not built. In development open the Vite dev server (port 5420).'); return; }
    let rel: string;
    try { rel = decodeURIComponent(url.pathname); } catch { res.writeHead(400); res.end(); return; }
    let p = normalize(join(config.clientDist, rel));
    if (p !== config.clientDist && !p.startsWith(config.clientDist + sep)) { res.writeHead(403); res.end(); return; }
    if (!existsSync(p) || statSync(p).isDirectory()) p = join(config.clientDist, 'index.html');
    const ext = extname(p);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : url.pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
    });
    createReadStream(p).pipe(res);
  };
}

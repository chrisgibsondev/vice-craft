import { randomBytes, randomInt } from 'node:crypto';
/**
 * Persistence repository. All money/progression changes go through transactions
 * with a ledger row; activity rewards are idempotent per (run_id, user_id).
 */
import type { Db, Queryable } from './db/index.ts';
import { WORLD } from '@blockshore/shared';
import { hashPassword, verifyPassword, newToken, hashToken, newId } from './auth.ts';
import { config } from './config.ts';
import { STARTING_CASH, STARTER_VEHICLE, VEHICLES, type VehicleModel } from '@blockshore/shared';
import { PROPERTY_BY_ID, BASE_GARAGE_SLOTS, BANK, COLLECT_COOLDOWN_H, type PropertyDef } from './webcontent.ts';

export interface User {
  id: string; username: string; display_name: string; is_admin: boolean;
  banned_until: string | null; ban_reason: string | null;
  presence_visibility: 'everyone' | 'friends' | 'nobody'; invite_policy: 'friends' | 'nobody';
  is_guest: boolean; friend_code: string | null;
}
export interface Profile {
  userId: string; cash: number; rep: number;
  completed: Record<string, number>; unlocks: string[]; preps: Record<string, string[]>;
  checkpoints: Record<string, number>; inventory: Record<string, number>; outfit: number;
  pos: { x: number; y: number; z: number; yaw: number; world?: string } | null; settings: Record<string, unknown>;
}
export interface OwnedVehicle { id: string; owner_id: string; model: VehicleModel; color: number; health: number; upgrades: Record<string, unknown>; state: 'stored' | 'out' | 'destroyed' }

const USER_COLS = 'id, username, display_name, is_admin, banned_until, ban_reason, presence_visibility, invite_policy, is_guest, friend_code';

function rowToProfile(r: Record<string, unknown>): Profile {
  const j = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
  return {
    userId: r.user_id as string, cash: Number(r.cash), rep: Number(r.rep),
    completed: j(r.completed) ?? {}, unlocks: j(r.unlocks) ?? [], preps: j(r.preps) ?? {},
    checkpoints: j(r.checkpoints) ?? {}, inventory: j(r.inventory) ?? {}, outfit: Number(r.outfit),
    pos: j(r.pos) ?? null, settings: j(r.settings) ?? {},
  };
}

export class Store {
  constructor(readonly db: Db) {}

  // ── accounts ──────────────────────────────────────────────────────────────
  async createUser(username: string, password: string): Promise<User | 'taken'> {
    const lower = username.toLowerCase();
    const existing = await this.db.query('SELECT 1 FROM users WHERE username = $1', [lower]);
    if (existing.length) return 'taken';
    const id = newId();
    const hash = await hashPassword(password);
    const admin = config.adminUsers.includes(lower);
    try {
      await this.db.tx(async (q) => {
        await q.query('INSERT INTO users (id, username, display_name, pass_hash, is_admin) VALUES ($1,$2,$3,$4,$5)', [id, lower, username, hash, admin]);
        await q.query(`INSERT INTO profiles (user_id, cash, unlocks) VALUES ($1, $2, $3)`, [id, STARTING_CASH, JSON.stringify(['story_1'])]);
        await q.query('INSERT INTO ledger (user_id, amount, balance, reason) VALUES ($1,$2,$2,$3)', [id, STARTING_CASH, 'starting cash']);
        await q.query('INSERT INTO vehicles (id, owner_id, model, color, health) VALUES ($1,$2,$3,$4,$5)', [newId(), id, STARTER_VEHICLE, 0x46b1c9, VEHICLES[STARTER_VEHICLE].health]);
      });
    } catch (e) {
      if (String(e).includes('unique') || String(e).includes('duplicate')) return 'taken';
      throw e;
    }
    return (await this.getUser(id))!;
  }

  /**
   * The guest account for a network address (created on first visit). Only unclaimed guest
   * accounts are reachable this way: once a player sets a username and password the address
   * link is dropped and the account needs its session or a login.
   */
  async guestForIp(ipKey: string): Promise<User> {
    const found = await this.db.query<User>(`SELECT ${USER_COLS} FROM users WHERE ip_key = $1 AND is_guest ORDER BY created_at LIMIT 1`, [ipKey]);
    if (found[0]) return found[0];
    for (let i = 0; i < 8; i++) {
      const name = 'Player_' + randomBytes(5).toString('hex').slice(0, 9);
      const u = await this.createUser(name, randomBytes(24).toString('base64url'));
      if (u === 'taken') continue;
      await this.db.query('UPDATE users SET is_guest = TRUE, is_admin = FALSE, ip_key = $2 WHERE id = $1', [u.id, ipKey]);
      return (await this.getUser(u.id))!;
    }
    throw new Error('could not create a guest account');
  }

  /** The game account linked to a Google / X account, if any. */
  async userByIdentity(provider: string, subject: string): Promise<User | null> {
    const r = await this.db.query<{ user_id: string }>('SELECT user_id FROM oauth_identities WHERE provider = $1 AND subject = $2', [provider, subject]);
    return r[0] ? this.getUser(r[0].user_id) : null;
  }
  /** Link a Google / X account to a game account. A guest becomes a full account (progress kept, no longer tied to its device). */
  async linkIdentity(userId: string, provider: string, subject: string, name: string): Promise<User> {
    await this.db.tx(async (q) => {
      await q.query('INSERT INTO oauth_identities (provider, subject, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [provider, subject, userId]);
      await q.query('UPDATE users SET display_name = CASE WHEN is_guest THEN $2 ELSE display_name END, is_guest = FALSE, ip_key = NULL WHERE id = $1', [userId, name]);
    });
    return (await this.getUser(userId))!;
  }
  async identities(userId: string): Promise<string[]> {
    return (await this.db.query<{ provider: string }>('SELECT provider FROM oauth_identities WHERE user_id = $1 ORDER BY provider', [userId])).map((r) => r.provider);
  }

  /** Turn a guest account into a signed-in account (keeps all progress). */
  async claimGuest(userId: string, username: string, password: string): Promise<User | 'taken' | 'not_guest'> {
    const u = await this.getUser(userId);
    if (!u || !u.is_guest) return 'not_guest';
    const lower = username.toLowerCase();
    if ((await this.db.query('SELECT 1 FROM users WHERE username = $1 AND id <> $2', [lower, userId])).length) return 'taken';
    const hash = await hashPassword(password);
    try {
      await this.db.query('UPDATE users SET username = $2, display_name = $3, pass_hash = $4, is_guest = FALSE, ip_key = NULL, is_admin = $5 WHERE id = $1 AND is_guest',
        [userId, lower, username, hash, config.adminUsers.includes(lower)]);
    } catch (e) {
      if (String(e).includes('unique') || String(e).includes('duplicate')) return 'taken';
      throw e;
    }
    return (await this.getUser(userId))!;
  }

  /** The player's 5-digit friend code (assigned on first use, unique). */
  async friendCode(userId: string): Promise<string> {
    const cur = await this.db.query<{ friend_code: string | null }>('SELECT friend_code FROM users WHERE id = $1', [userId]);
    if (cur[0]?.friend_code) return cur[0].friend_code;
    for (let i = 0; i < 60; i++) {
      const code = String(10000 + randomInt(90000));
      try {
        if ((await this.db.query('SELECT 1 FROM users WHERE friend_code = $1', [code])).length) continue;
        await this.db.query('UPDATE users SET friend_code = $2 WHERE id = $1 AND friend_code IS NULL', [userId, code]);
        const now = await this.db.query<{ friend_code: string | null }>('SELECT friend_code FROM users WHERE id = $1', [userId]);
        if (now[0]?.friend_code) return now[0].friend_code;
      } catch { /* code taken in a race: try another */ }
    }
    throw new Error('no free friend codes');
  }
  async userByFriendCode(code: string): Promise<User | null> {
    return (await this.db.query<User>(`SELECT ${USER_COLS} FROM users WHERE friend_code = $1`, [code]))[0] ?? null;
  }

  async login(username: string, password: string): Promise<User | null> {
    const rows = await this.db.query<User & { pass_hash: string }>(`SELECT ${USER_COLS}, pass_hash FROM users WHERE username = $1`, [username.toLowerCase()]);
    const u = rows[0];
    // always run a hash comparison so timing does not reveal whether the user exists
    const ok = await verifyPassword(password, u?.pass_hash ?? 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
    if (!u || !ok) return null;
    await this.db.query('UPDATE users SET last_login = NOW() WHERE id = $1', [u.id]);
    const { pass_hash: _ph, ...user } = u;
    return user;
  }

  async getUser(id: string): Promise<User | null> {
    return (await this.db.query<User>(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [id]))[0] ?? null;
  }
  async getUserByName(name: string): Promise<User | null> {
    return (await this.db.query<User>(`SELECT ${USER_COLS} FROM users WHERE username = $1`, [name.toLowerCase()]))[0] ?? null;
  }

  async createSession(userId: string, ua: string): Promise<string> {
    const token = newToken();
    await this.db.query(`INSERT INTO sessions (token_hash, user_id, expires_at, user_agent) VALUES ($1,$2, NOW() + ($3 || ' days')::interval, $4)`, [hashToken(token), userId, String(config.sessionDays), ua.slice(0, 200)]);
    return token;
  }
  async sessionUser(token: string): Promise<User | null> {
    if (!token || token.length > 200) return null;
    const rows = await this.db.query<User>(`SELECT ${USER_COLS.split(', ').map((c) => 'u.' + c).join(', ')} FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > NOW()`, [hashToken(token)]);
    const u = rows[0];
    if (!u) return null;
    if (u.banned_until && new Date(u.banned_until) > new Date()) return null;
    void this.db.query('UPDATE sessions SET last_seen = NOW() WHERE token_hash = $1', [hashToken(token)]).catch(() => {});
    return u;
  }
  async deleteSession(token: string) { await this.db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]); }
  async deleteSessionsFor(userId: string) { await this.db.query('DELETE FROM sessions WHERE user_id = $1', [userId]); }

  async searchUsers(q: string, selfId: string) {
    const term = q.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (term.length < 2) return [];
    return this.db.query<{ id: string; name: string }>(
      `SELECT id, display_name AS name FROM users WHERE username LIKE $1 AND id <> $2
        AND NOT EXISTS (SELECT 1 FROM blocks WHERE (blocker_id = users.id AND blocked_id = $2))
       ORDER BY (username = $3) DESC, username LIMIT 10`, [term + '%', selfId, term]);
  }

  async setPrivacy(userId: string, presence: string, invites: string) {
    await this.db.query('UPDATE users SET presence_visibility = $2, invite_policy = $3 WHERE id = $1', [userId, presence, invites]);
  }

  // ── friends & blocks ─────────────────────────────────────────────────────
  async isBlockedEither(a: string, b: string): Promise<boolean> {
    const r = await this.db.query('SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)', [a, b]);
    return r.length > 0;
  }
  async areFriends(a: string, b: string): Promise<boolean> {
    const [x, y] = a < b ? [a, b] : [b, a];
    return (await this.db.query('SELECT 1 FROM friendships WHERE a_id = $1 AND b_id = $2', [x, y])).length > 0;
  }
  async friendIds(userId: string): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>('SELECT CASE WHEN a_id = $1 THEN b_id ELSE a_id END AS id FROM friendships WHERE a_id = $1 OR b_id = $1', [userId]);
    return rows.map((r) => r.id);
  }
  /** returns 'sent' | 'accepted' (reverse request existed) | error code */
  async sendFriendRequest(from: string, to: string): Promise<'sent' | 'accepted' | 'self' | 'blocked' | 'already' | 'pending' | 'limit'> {
    if (from === to) return 'self';
    if (await this.isBlockedEither(from, to)) return 'blocked';
    if (await this.areFriends(from, to)) return 'already';
    const reverse = await this.db.query('SELECT 1 FROM friend_requests WHERE from_id = $1 AND to_id = $2', [to, from]);
    if (reverse.length) { await this.acceptFriend(from, to); return 'accepted'; }
    const pending = await this.db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM friend_requests WHERE from_id = $1', [from]);
    if (pending[0].n >= 50) return 'limit';
    const r = await this.db.query('INSERT INTO friend_requests (from_id, to_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1', [from, to]);
    return r.length ? 'sent' : 'pending';
  }
  /** `me` accepts a request from `other` */
  async acceptFriend(me: string, other: string): Promise<boolean> {
    return this.db.tx(async (q) => {
      const del = await q.query('DELETE FROM friend_requests WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1) RETURNING 1', [other, me]);
      if (!del.length) return false;
      const [a, b] = me < other ? [me, other] : [other, me];
      await q.query('INSERT INTO friendships (a_id, b_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [a, b]);
      return true;
    });
  }
  async declineFriend(me: string, other: string) {
    await this.db.query('DELETE FROM friend_requests WHERE from_id = $1 AND to_id = $2', [other, me]);
  }
  async cancelFriendRequest(me: string, other: string) {
    await this.db.query('DELETE FROM friend_requests WHERE from_id = $1 AND to_id = $2', [me, other]);
  }
  async removeFriend(me: string, other: string) {
    const [a, b] = me < other ? [me, other] : [other, me];
    await this.db.query('DELETE FROM friendships WHERE a_id = $1 AND b_id = $2', [a, b]);
  }
  async friendRequests(userId: string) {
    const incoming = await this.db.query<{ id: string; name: string; at: string }>('SELECT u.id, u.display_name AS name, r.created_at AS at FROM friend_requests r JOIN users u ON u.id = r.from_id WHERE r.to_id = $1 ORDER BY r.created_at DESC', [userId]);
    const outgoing = await this.db.query<{ id: string; name: string; at: string }>('SELECT u.id, u.display_name AS name, r.created_at AS at FROM friend_requests r JOIN users u ON u.id = r.to_id WHERE r.from_id = $1 ORDER BY r.created_at DESC', [userId]);
    return { incoming, outgoing };
  }
  async friendsWithInfo(userId: string) {
    return this.db.query<{ id: string; name: string; presence_visibility: string; invite_policy: string }>(
      `SELECT u.id, u.display_name AS name, u.presence_visibility, u.invite_policy FROM friendships f JOIN users u ON u.id = CASE WHEN f.a_id = $1 THEN f.b_id ELSE f.a_id END WHERE f.a_id = $1 OR f.b_id = $1 ORDER BY u.username`, [userId]);
  }
  async block(me: string, other: string) {
    await this.db.tx(async (q) => {
      await q.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [me, other]);
      const [a, b] = me < other ? [me, other] : [other, me];
      await q.query('DELETE FROM friendships WHERE a_id = $1 AND b_id = $2', [a, b]);
      await q.query('DELETE FROM friend_requests WHERE (from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1)', [me, other]);
    });
  }
  async unblock(me: string, other: string) { await this.db.query('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [me, other]); }
  async blockedList(me: string) {
    return this.db.query<{ id: string; name: string }>('SELECT u.id, u.display_name AS name FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = $1', [me]);
  }

  // ── profiles & economy ───────────────────────────────────────────────────
  async profile(userId: string): Promise<Profile> {
    const r = (await this.db.query('SELECT * FROM profiles WHERE user_id = $1', [userId]))[0];
    if (!r) throw new Error('profile missing');
    return rowToProfile(r);
  }
  async savePos(userId: string, pos: Profile['pos']) {
    // tag with the world so a save from one world is never used as a position in the other
    await this.db.query('UPDATE profiles SET pos = $2, updated_at = NOW() WHERE user_id = $1', [userId, JSON.stringify(pos ? { ...pos, world: WORLD } : pos)]);
  }
  async saveSettings(userId: string, settings: Record<string, unknown>) {
    await this.db.query('UPDATE profiles SET settings = $2, updated_at = NOW() WHERE user_id = $1', [userId, JSON.stringify(settings)]);
  }
  /** set one inventory value outright (e.g. the selected hair colour) */
  async setInventoryValue(userId: string, key: string, value: number) {
    await this.db.tx(async (q) => {
      const p = rowToProfile((await q.query('SELECT * FROM profiles WHERE user_id = $1 FOR UPDATE', [userId]))[0]);
      p.inventory[key] = value;
      await q.query('UPDATE profiles SET inventory = $2 WHERE user_id = $1', [userId, JSON.stringify(p.inventory)]);
    });
  }
  async setOutfit(userId: string, color: number) { await this.db.query('UPDATE profiles SET outfit = $2 WHERE user_id = $1', [userId, color]); }

  /** Atomic cash change. Returns the new balance or null when funds are insufficient. */
  async adjustCash(userId: string, amount: number, reason: string, ref?: string, q: Queryable = this.db): Promise<number | null> {
    const run = async (t: Queryable) => {
      const r = await t.query<{ cash: string }>('UPDATE profiles SET cash = cash + $2, updated_at = NOW() WHERE user_id = $1 AND cash + $2 >= 0 RETURNING cash', [userId, Math.round(amount)]);
      if (!r.length) return null;
      const bal = Number(r[0].cash);
      await t.query('INSERT INTO ledger (user_id, amount, balance, reason, ref) VALUES ($1,$2,$3,$4,$5)', [userId, Math.round(amount), bal, reason, ref ?? null]);
      return bal;
    };
    return q === this.db ? this.db.tx(run) : run(q);
  }

  /** Purchase: debit cash and apply an inventory change in one transaction. */
  async purchase(userId: string, price: number, reason: string, inventory?: { item: string; delta: number; max: number }, also?: Record<string, number>): Promise<{ ok: true; cash: number } | { ok: false; error: string }> {
    return this.db.tx(async (q) => {
      if (inventory) {
        const p = rowToProfile((await q.query('SELECT * FROM profiles WHERE user_id = $1 FOR UPDATE', [userId]))[0]);
        const have = p.inventory[inventory.item] ?? 0;
        if (have + inventory.delta > inventory.max) return { ok: false as const, error: `You can carry at most ${inventory.max}.` };
        p.inventory[inventory.item] = have + inventory.delta;
        if (also) Object.assign(p.inventory, also);
        await q.query('UPDATE profiles SET inventory = $2 WHERE user_id = $1', [userId, JSON.stringify(p.inventory)]);
      }
      const bal = await this.adjustCash(userId, -price, reason, undefined, q);
      if (bal === null) throw new InsufficientFunds();
      return { ok: true as const, cash: bal };
    }).catch((e) => {
      if (e instanceof InsufficientFunds) return { ok: false as const, error: 'Not enough cash.' };
      throw e;
    });
  }

  async useItem(userId: string, item: string): Promise<boolean> {
    return this.db.tx(async (q) => {
      const p = rowToProfile((await q.query('SELECT * FROM profiles WHERE user_id = $1 FOR UPDATE', [userId]))[0]);
      if (!p.inventory[item]) return false;
      p.inventory[item]--;
      await q.query('UPDATE profiles SET inventory = $2 WHERE user_id = $1', [userId, JSON.stringify(p.inventory)]);
      return true;
    });
  }

  async setCheckpoint(userId: string, activity: string, stage: number | null) {
    await this.db.tx(async (q) => {
      const p = rowToProfile((await q.query('SELECT * FROM profiles WHERE user_id = $1 FOR UPDATE', [userId]))[0]);
      if (stage === null) delete p.checkpoints[activity]; else p.checkpoints[activity] = stage;
      await q.query('UPDATE profiles SET checkpoints = $2 WHERE user_id = $1', [userId, JSON.stringify(p.checkpoints)]);
    });
  }

  /**
   * Idempotent reward grant. A (run, user) pair can only ever be paid once: the
   * reward_grants primary key is the guard, inserted in the same transaction as the
   * cash/progression update.
   */
  async grantReward(g: { runId: string; userId: string; cash: number; rep: number; complete?: string; unlocks?: string[]; prep?: { heist: string; prep: string; choice?: { key: string; option: string } }; clearCheckpoint?: string; detail?: Record<string, unknown> }): Promise<'granted' | 'duplicate'> {
    return this.db.tx(async (q) => {
      const ins = await q.query('INSERT INTO reward_grants (run_id, user_id, cash, rep, detail) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING run_id', [g.runId, g.userId, Math.round(g.cash), g.rep, JSON.stringify(g.detail ?? {})]);
      if (!ins.length) return 'duplicate';
      const p = rowToProfile((await q.query('SELECT * FROM profiles WHERE user_id = $1 FOR UPDATE', [g.userId]))[0]);
      if (g.complete) p.completed[g.complete] = (p.completed[g.complete] ?? 0) + 1;
      for (const u of g.unlocks ?? []) if (!p.unlocks.includes(u)) p.unlocks.push(u);
      if (g.prep) {
        let l = p.preps[g.prep.heist] ?? [];
        if (!l.includes(g.prep.prep)) l.push(g.prep.prep);
        // a setup choice replaces any earlier choice for the same key (stored as `choice:<key>=<option>`)
        if (g.prep.choice) { l = l.filter((e) => !e.startsWith(`choice:${g.prep!.choice!.key}=`)); l.push(`choice:${g.prep.choice.key}=${g.prep.choice.option}`); }
        p.preps[g.prep.heist] = l;
      }
      if (g.clearCheckpoint) delete p.checkpoints[g.clearCheckpoint];
      await q.query('UPDATE profiles SET rep = rep + $2, completed = $3, unlocks = $4, preps = $5, checkpoints = $6, updated_at = NOW() WHERE user_id = $1',
        [g.userId, g.rep, JSON.stringify(p.completed), JSON.stringify(p.unlocks), JSON.stringify(p.preps), JSON.stringify(p.checkpoints)]);
      if (g.cash > 0) await this.adjustCash(g.userId, g.cash, 'activity reward', g.runId, q);
      return 'granted';
    });
  }

  /** consume heist preps when the finale completes */
  async consumePreps(userId: string, heist: string) {
    await this.db.tx(async (q) => {
      const p = rowToProfile((await q.query('SELECT * FROM profiles WHERE user_id = $1 FOR UPDATE', [userId]))[0]);
      delete p.preps[heist];
      await q.query('UPDATE profiles SET preps = $2 WHERE user_id = $1', [userId, JSON.stringify(p.preps)]);
    });
  }

  async personalBest(userId: string, activity: string): Promise<number | null> {
    const r = await this.db.query<{ value_ms: number }>('SELECT value_ms FROM personal_bests WHERE user_id = $1 AND activity = $2', [userId, activity]);
    return r[0]?.value_ms ?? null;
  }
  /** returns true when this is a new best (lower is better) */
  async submitBest(userId: string, activity: string, valueMs: number, runId: string): Promise<boolean> {
    const r = await this.db.query(`INSERT INTO personal_bests (user_id, activity, value_ms, run_id) VALUES ($1,$2,$3,$4)
      ON CONFLICT (user_id, activity) DO UPDATE SET value_ms = EXCLUDED.value_ms, run_id = EXCLUDED.run_id, set_at = NOW()
      WHERE personal_bests.value_ms > EXCLUDED.value_ms RETURNING 1`, [userId, activity, Math.round(valueMs), runId]);
    return r.length > 0;
  }

  // ── vehicles ─────────────────────────────────────────────────────────────
  async vehicles(userId: string): Promise<OwnedVehicle[]> {
    return this.db.query<OwnedVehicle>('SELECT id, owner_id, model, color, health, upgrades, state FROM vehicles WHERE owner_id = $1 ORDER BY created_at', [userId]);
  }
  async vehicle(id: string): Promise<OwnedVehicle | null> {
    return (await this.db.query<OwnedVehicle>('SELECT id, owner_id, model, color, health, upgrades, state FROM vehicles WHERE id = $1', [id]))[0] ?? null;
  }
  async updateVehicle(id: string, patch: Partial<Pick<OwnedVehicle, 'color' | 'health' | 'state'>>) {
    const v = await this.vehicle(id);
    if (!v) return;
    await this.db.query('UPDATE vehicles SET color = $2, health = $3, state = $4 WHERE id = $1', [id, patch.color ?? v.color, Math.round(patch.health ?? v.health), patch.state ?? v.state]);
  }
  async buyVehicle(userId: string, model: VehicleModel, price: number, color: number): Promise<{ ok: true; id: string; cash: number } | { ok: false; error: string }> {
    return this.db.tx(async (q) => {
      const owned = await q.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM vehicles WHERE owner_id = $1', [userId]);
      const cap = await this.garageCap(userId, q);
      if (owned[0].n >= cap) return { ok: false as const, error: `Garage full (${cap} vehicles).` };
      const bal = await this.adjustCash(userId, -price, `buy ${model}`, undefined, q);
      if (bal === null) throw new InsufficientFunds();
      const id = newId();
      await q.query('INSERT INTO vehicles (id, owner_id, model, color, health) VALUES ($1,$2,$3,$4,$5)', [id, userId, model, color, VEHICLES[model].health]);
      return { ok: true as const, id, cash: bal };
    }).catch((e) => {
      if (e instanceof InsufficientFunds) return { ok: false as const, error: 'Not enough cash.' };
      throw e;
    });
  }
  /** any vehicle left "out" when the server stopped goes back to storage */
  async recoverVehicles() { await this.db.query(`UPDATE vehicles SET state = 'stored' WHERE state = 'out'`); }

  // ── activity runs ────────────────────────────────────────────────────────
  async createRun(r: { id: string; activity: string; kind: string; leader: string; roster: unknown; terms: unknown; checkpoint: number }) {
    await this.db.query('INSERT INTO activity_runs (id, activity, kind, leader_id, roster, terms, status, checkpoint) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [r.id, r.activity, r.kind, r.leader, JSON.stringify(r.roster), JSON.stringify(r.terms), 'active', r.checkpoint]);
  }
  async updateRun(id: string, patch: { status?: string; checkpoint?: number; result?: unknown; roster?: unknown }) {
    await this.db.query(`UPDATE activity_runs SET status = COALESCE($2, status), checkpoint = COALESCE($3, checkpoint), result = COALESCE($4, result),
      roster = COALESCE($5, roster), ended_at = CASE WHEN $2 IN ('complete','failed','abandoned','interrupted') THEN NOW() WHEN $2 = 'active' THEN NULL ELSE ended_at END WHERE id = $1`,
      [id, patch.status ?? null, patch.checkpoint ?? null, patch.result === undefined ? null : JSON.stringify(patch.result), patch.roster === undefined ? null : JSON.stringify(patch.roster)]);
  }
  /** Called at boot: runs that were active when the server stopped can never pay out. */
  async interruptActiveRuns(): Promise<{ id: string; activity: string; roster: unknown }[]> {
    return this.db.query(`UPDATE activity_runs SET status = 'interrupted', ended_at = NOW() WHERE status = 'active' RETURNING id, activity, roster`);
  }

  // ── moderation ───────────────────────────────────────────────────────────
  async report(reporter: string, target: string, reason: string, context: string) {
    await this.db.query('INSERT INTO reports (reporter_id, target_id, reason, context) VALUES ($1,$2,$3,$4)', [reporter, target, reason.slice(0, 200), context.slice(0, 1000)]);
  }
  async reports(status = 'open') {
    return this.db.query(`SELECT r.id, r.reason, r.context, r.status, r.created_at, a.display_name AS reporter, b.display_name AS target, b.id AS target_id
      FROM reports r JOIN users a ON a.id = r.reporter_id JOIN users b ON b.id = r.target_id WHERE r.status = $1 ORDER BY r.created_at DESC LIMIT 100`, [status]);
  }
  async resolveReport(id: number) { await this.db.query(`UPDATE reports SET status = 'resolved' WHERE id = $1`, [id]); }
  async ban(userId: string, hours: number, reason: string) {
    await this.db.query(`UPDATE users SET banned_until = NOW() + ($2 || ' hours')::interval, ban_reason = $3 WHERE id = $1`, [userId, String(hours), reason]);
    await this.deleteSessionsFor(userId);
  }
  async audit(actor: string | null, action: string, data: Record<string, unknown>) {
    await this.db.query('INSERT INTO audit_log (actor_id, action, data) VALUES ($1,$2,$3)', [actor, action, JSON.stringify(data)]);
  }

  // ── parties (persisted so they survive restarts) ─────────────────────────
  async saveParty(id: string, data: unknown | null) {
    if (data === null) await this.db.query('DELETE FROM parties WHERE id = $1', [id]);
    else await this.db.query('INSERT INTO parties (id, data) VALUES ($1,$2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()', [id, JSON.stringify(data)]);
  }
  async loadParties(): Promise<{ id: string; data: unknown }[]> {
    const rows = await this.db.query<{ id: string; data: unknown }>(`SELECT id, data FROM parties WHERE updated_at > NOW() - INTERVAL '6 hours'`);
    await this.db.query(`DELETE FROM parties WHERE updated_at <= NOW() - INTERVAL '6 hours'`);
    return rows.map((r) => ({ id: r.id, data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data }));
  }

  // ── web: properties, bank, leaderboards, news ────────────────────────────
  /** vehicle cap = base slots + slots from owned properties */
  async garageCap(userId: string, q: Queryable = this.db): Promise<number> {
    const rows = await q.query<{ property_id: string }>('SELECT property_id FROM properties WHERE user_id = $1', [userId]);
    return BASE_GARAGE_SLOTS + rows.reduce((n, r) => n + (PROPERTY_BY_ID[r.property_id]?.perks.garageSlots ?? 0), 0);
  }
  async ownedProperties(userId: string) {
    const rows = await this.db.query<{ property_id: string; bought_at: string; last_collected_at: string }>('SELECT property_id, bought_at, last_collected_at FROM properties WHERE user_id = $1 ORDER BY bought_at', [userId]);
    const sp = await this.db.query<{ spawn_property: string | null }>('SELECT spawn_property FROM profiles WHERE user_id = $1', [userId]);
    return { owned: rows, spawn: sp[0]?.spawn_property ?? null };
  }
  async buyProperty(userId: string, def: PropertyDef): Promise<{ ok: true; cash: number } | { ok: false; error: string; code?: string }> {
    return this.db.tx(async (q) => {
      const ins = await q.query('INSERT INTO properties (user_id, property_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING 1', [userId, def.id]);
      if (!ins.length) return { ok: false as const, error: 'You already own this property.', code: 'owned' };
      const bal = await this.adjustCash(userId, -def.price, `buy property ${def.id}`, def.id, q);
      if (bal === null) throw new InsufficientFunds();
      return { ok: true as const, cash: bal };
    }).catch((e) => {
      if (e instanceof InsufficientFunds) return { ok: false as const, error: 'Not enough cash.', code: 'funds' };
      throw e;
    });
  }
  /** daily passive income: at most once per COLLECT_COOLDOWN_H hours per property */
  async collectProperty(userId: string, def: PropertyDef): Promise<{ ok: true; cash: number; amount: number } | { ok: false; error: string; nextAt?: string }> {
    const income = def.perks.dailyIncome ?? 0;
    if (!income) return { ok: false, error: 'This property does not pay income.' };
    return this.db.tx(async (q) => {
      const upd = await q.query(`UPDATE properties SET last_collected_at = NOW() WHERE user_id = $1 AND property_id = $2 AND last_collected_at <= NOW() - ($3 || ' hours')::interval RETURNING 1`, [userId, def.id, String(COLLECT_COOLDOWN_H)]);
      if (!upd.length) {
        const r = await q.query<{ next: string }>(`SELECT last_collected_at + ($3 || ' hours')::interval AS next FROM properties WHERE user_id = $1 AND property_id = $2`, [userId, def.id, String(COLLECT_COOLDOWN_H)]);
        if (!r.length) return { ok: false as const, error: 'You do not own this property.' };
        return { ok: false as const, error: 'Already collected today. Come back later.', nextAt: new Date(r[0].next).toISOString() };
      }
      const bal = await this.adjustCash(userId, income, `property income ${def.id}`, def.id, q);
      return { ok: true as const, cash: bal ?? 0, amount: income };
    });
  }
  async setSpawnProperty(userId: string, id: string | null): Promise<boolean> {
    return this.db.tx(async (q) => {
      if (id !== null) {
        const own = await q.query('SELECT 1 FROM properties WHERE user_id = $1 AND property_id = $2', [userId, id]);
        if (!own.length) return false;
      }
      await q.query('UPDATE profiles SET spawn_property = $2 WHERE user_id = $1', [userId, id]);
      return true;
    });
  }
  async ledgerRows(userId: string, n = BANK.ledgerRows) {
    const rows = await this.db.query<{ id: number | string; amount: number | string; balance: number | string; reason: string; created_at: string }>('SELECT id, amount, balance, reason, created_at FROM ledger WHERE user_id = $1 ORDER BY id DESC LIMIT $2', [userId, n]);
    return rows.map((r) => ({ id: Number(r.id), amount: Number(r.amount), balance: Number(r.balance), reason: r.reason, at: new Date(r.created_at).toISOString() }));
  }
  async sentLast24h(userId: string): Promise<number> {
    const r = await this.db.query<{ s: number | string }>(`SELECT COALESCE(SUM(amount), 0)::int AS s FROM transfers WHERE from_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`, [userId]);
    return Number(r[0]?.s ?? 0);
  }
  /** friends the player may send money to (blocked users excluded either way) */
  async transferableFriends(userId: string) {
    const out: { id: string; name: string }[] = [];
    for (const f of await this.friendsWithInfo(userId)) if (!(await this.isBlockedEither(userId, f.id))) out.push({ id: f.id, name: f.name });
    return out;
  }
  /** Both sides of a friend transfer in ONE transaction, with ledger rows for each. */
  async transferCash(from: { id: string; name: string }, to: { id: string; name: string }, amount: number): Promise<{ ok: true; cash: number; sentToday: number } | { ok: false; error: string; code: string }> {
    if (from.id === to.id) return { ok: false, error: 'You cannot send money to yourself.', code: 'self' };
    return this.db.tx(async (q) => {
      await q.query('SELECT 1 FROM profiles WHERE user_id = $1 FOR UPDATE', [from.id]); // serialises this sender's transfers
      const [a, b] = from.id < to.id ? [from.id, to.id] : [to.id, from.id];
      if (!(await q.query('SELECT 1 FROM friendships WHERE a_id = $1 AND b_id = $2', [a, b])).length) return { ok: false as const, error: 'You can only send money to friends.', code: 'not_friend' };
      if ((await q.query('SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)', [from.id, to.id])).length) return { ok: false as const, error: 'You cannot send money to this player.', code: 'blocked' };
      const sent = await q.query<{ s: number | string }>(`SELECT COALESCE(SUM(amount), 0)::int AS s FROM transfers WHERE from_id = $1 AND created_at > NOW() - INTERVAL '24 hours'`, [from.id]);
      const sentToday = Number(sent[0]?.s ?? 0);
      if (sentToday + amount > BANK.dailyCap) return { ok: false as const, error: `Daily transfer limit is $${BANK.dailyCap.toLocaleString('en-US')}. You can still send $${Math.max(0, BANK.dailyCap - sentToday).toLocaleString('en-US')} today.`, code: 'cap' };
      const bal = await this.adjustCash(from.id, -amount, `transfer to ${to.name}`, to.id, q);
      if (bal === null) return { ok: false as const, error: 'Not enough cash.', code: 'funds' };
      await this.adjustCash(to.id, amount, `transfer from ${from.name}`, from.id, q);
      await q.query('INSERT INTO transfers (from_id, to_id, amount) VALUES ($1,$2,$3)', [from.id, to.id, amount]);
      return { ok: true as const, cash: bal, sentToday: sentToday + amount };
    });
  }
  async leaderboards() {
    const bests = await this.db.query<{ activity: string; name: string; value_ms: number }>(
      `SELECT activity, name, value_ms FROM (
         SELECT p.activity, u.display_name AS name, p.value_ms, ROW_NUMBER() OVER (PARTITION BY p.activity ORDER BY p.value_ms, p.set_at) AS rn
           FROM personal_bests p JOIN users u ON u.id = p.user_id WHERE u.banned_until IS NULL OR u.banned_until < NOW()
       ) t WHERE rn <= 10 ORDER BY activity, value_ms`);
    const rich = await this.db.query<{ name: string; cash: number | string }>(
      `SELECT u.display_name AS name, p.cash FROM profiles p JOIN users u ON u.id = p.user_id WHERE u.banned_until IS NULL OR u.banned_until < NOW() ORDER BY p.cash DESC, u.username LIMIT 20`);
    const boards: Record<string, { name: string; ms: number }[]> = {};
    for (const b of bests) (boards[b.activity] ??= []).push({ name: b.name, ms: Number(b.value_ms) });
    return { boards, richest: rich.map((r) => ({ name: r.name, cash: Number(r.cash) })) };
  }
  async newsFeed(userId: string, bigCash: number) {
    const ticker = await this.db.query<{ name: string; cash: number | string; at: string; activity: string }>(
      `SELECT u.display_name AS name, g.cash, g.granted_at AS at, a.activity FROM reward_grants g JOIN activity_runs a ON a.id = g.run_id JOIN users u ON u.id = g.user_id
        WHERE a.kind = 'heist' AND g.cash >= $1 ORDER BY g.granted_at DESC LIMIT 8`, [bigCash]);
    const mine = await this.db.query<{ cash: number | string; at: string; activity: string; kind: string }>(
      `SELECT g.cash, g.granted_at AS at, a.activity, a.kind FROM reward_grants g JOIN activity_runs a ON a.id = g.run_id WHERE g.user_id = $1 ORDER BY g.granted_at DESC LIMIT 6`, [userId]);
    return {
      ticker: ticker.map((r) => ({ name: r.name, cash: Number(r.cash), at: new Date(r.at).toISOString(), activity: r.activity })),
      mine: mine.map((r) => ({ cash: Number(r.cash), at: new Date(r.at).toISOString(), activity: r.activity, kind: r.kind })),
    };
  }
}

class InsufficientFunds extends Error {}

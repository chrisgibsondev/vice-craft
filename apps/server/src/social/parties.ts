/**
 * Parties: 1–4 players, invite-only by default. Invitations come from the leader to
 * friends (or via an expiring share link). Party state is persisted so a server
 * restart does not dissolve groups.
 */
import { randomBytes } from 'node:crypto';
import { INVITE_TTL_MS, MAX_PARTY } from '@blockshore/shared';
import { newId } from '../auth.ts';
import type { Store } from '../store.ts';

export interface Party {
  id: string;
  leader: string;
  members: string[];
  names: Record<string, string>;
  invites: Record<string, { by: string; expires: number }>;
  link: { token: string; expires: number } | null;
  chat: { from: string; name: string; text: string; at: number }[];
}

export type PartyError = 'not_in_party' | 'not_leader' | 'full' | 'expired' | 'no_invite' | 'blocked' | 'not_friends' | 'invites_off' | 'already_member' | 'self' | 'unknown_user';

export const PARTY_ERRORS: Record<PartyError, string> = {
  not_in_party: 'You are not in a party.',
  not_leader: 'Only the party leader can do that.',
  full: `That party is full (${MAX_PARTY}/${MAX_PARTY}).`,
  expired: 'That invitation has expired. Ask for a new one.',
  no_invite: 'You have no invitation to that party.',
  blocked: 'You can\'t invite or join this player.',
  not_friends: 'You can only invite friends (or share an invite link).',
  invites_off: 'That player is not accepting party invites.',
  already_member: 'Already in the party.',
  self: 'You can\'t invite yourself.',
  unknown_user: 'Player not found.',
};

export class PartyManager {
  private parties = new Map<string, Party>();
  private byUser = new Map<string, string>();
  constructor(private store: Store, private onChange: (p: Party | null, affected: string[]) => void) {}

  async restore() {
    for (const row of await this.store.loadParties()) {
      const p = row.data as Party;
      if (!p?.members?.length) continue;
      p.invites = {}; p.link = null;
      this.parties.set(p.id, p);
      for (const m of p.members) this.byUser.set(m, p.id);
    }
  }

  of(userId: string): Party | null { const id = this.byUser.get(userId); return id ? this.parties.get(id) ?? null : null; }
  get(id: string) { return this.parties.get(id) ?? null; }
  all() { return [...this.parties.values()]; }

  private persist(p: Party | null, id: string) { void this.store.saveParty(id, p ? { ...p, chat: p.chat.slice(-30) } : null); }
  private changed(p: Party | null, affected: string[]) { if (p) this.persist(p, p.id); this.onChange(p, affected); }

  ensure(userId: string, name: string): Party {
    const cur = this.of(userId);
    if (cur) return cur;
    const p: Party = { id: newId(), leader: userId, members: [userId], names: { [userId]: name }, invites: {}, link: null, chat: [] };
    this.parties.set(p.id, p);
    this.byUser.set(userId, p.id);
    this.changed(p, [userId]);
    return p;
  }

  async invite(from: string, fromName: string, to: string, opts: { friends: boolean; blocked: boolean; invitePolicy: string }): Promise<PartyError | Party> {
    if (from === to) return 'self';
    if (opts.blocked) return 'blocked';
    if (!opts.friends) return 'not_friends';
    if (opts.invitePolicy === 'nobody') return 'invites_off';
    const p = this.ensure(from, fromName);
    if (p.leader !== from) return 'not_leader';
    if (p.members.includes(to)) return 'already_member';
    if (p.members.length >= MAX_PARTY) return 'full';
    p.invites[to] = { by: from, expires: Date.now() + INVITE_TTL_MS };
    this.changed(p, [...p.members, to]);
    return p;
  }

  accept(userId: string, name: string, partyId: string, blockedWithAnyMember: boolean): PartyError | Party {
    const p = this.parties.get(partyId);
    if (!p) return 'expired';
    const inv = p.invites[userId];
    if (!inv) return 'no_invite';
    if (inv.expires < Date.now()) { delete p.invites[userId]; return 'expired'; }
    if (blockedWithAnyMember) return 'blocked';
    if (p.members.length >= MAX_PARTY) return 'full';
    delete p.invites[userId];
    this.join(p, userId, name);
    return p;
  }

  decline(userId: string, partyId: string) {
    const p = this.parties.get(partyId);
    if (!p || !p.invites[userId]) return;
    delete p.invites[userId];
    this.changed(p, [...p.members, userId]);
  }

  createLink(userId: string, name: string): PartyError | { token: string; expires: number } {
    const p = this.ensure(userId, name);
    if (p.leader !== userId) return 'not_leader';
    p.link = { token: randomBytes(12).toString('base64url'), expires: Date.now() + INVITE_TTL_MS };
    this.changed(p, p.members);
    return p.link;
  }

  findByLink(token: string): Party | null {
    for (const p of this.parties.values()) if (p.link?.token === token) return p;
    return null;
  }

  joinByLink(userId: string, name: string, token: string, blockedWithAnyMember: boolean): PartyError | Party {
    const p = this.findByLink(token);
    if (!p || !p.link || p.link.expires < Date.now()) return 'expired';
    if (p.members.includes(userId)) return p;
    if (blockedWithAnyMember) return 'blocked';
    if (p.members.length >= MAX_PARTY) return 'full';
    this.join(p, userId, name);
    return p;
  }

  private join(p: Party, userId: string, name: string) {
    const old = this.of(userId);
    if (old && old.id !== p.id) this.leave(userId);
    p.members.push(userId);
    p.names[userId] = name;
    this.byUser.set(userId, p.id);
    this.changed(p, p.members);
  }

  leave(userId: string): Party | null {
    const p = this.of(userId);
    if (!p) return null;
    p.members = p.members.filter((m) => m !== userId);
    this.byUser.delete(userId);
    if (!p.members.length) {
      this.parties.delete(p.id);
      this.persist(null, p.id);
      this.onChange(null, [userId]);
      return null;
    }
    if (p.leader === userId) p.leader = p.members[0];
    this.changed(p, [...p.members, userId]);
    return p;
  }

  kick(leader: string, target: string): PartyError | Party {
    const p = this.of(leader);
    if (!p) return 'not_in_party';
    if (p.leader !== leader) return 'not_leader';
    if (!p.members.includes(target) || target === leader) return 'unknown_user';
    this.leave(target);
    return p;
  }

  transfer(leader: string, target: string): PartyError | Party {
    const p = this.of(leader);
    if (!p) return 'not_in_party';
    if (p.leader !== leader) return 'not_leader';
    if (!p.members.includes(target)) return 'unknown_user';
    p.leader = target;
    this.changed(p, p.members);
    return p;
  }

  addChat(userId: string, text: string): Party | null {
    const p = this.of(userId);
    if (!p) return null;
    p.chat.push({ from: userId, name: p.names[userId], text, at: Date.now() });
    if (p.chat.length > 60) p.chat.splice(0, p.chat.length - 60);
    return p;
  }

  /** pending (unexpired) invitations addressed to a user */
  invitesFor(userId: string) {
    const now = Date.now();
    const out: { partyId: string; from: string; fromName: string; expires: number; size: number }[] = [];
    for (const p of this.parties.values()) {
      const inv = p.invites[userId];
      if (inv && inv.expires > now) out.push({ partyId: p.id, from: inv.by, fromName: p.names[inv.by] ?? '?', expires: inv.expires, size: p.members.length });
    }
    return out;
  }

  sweep() {
    const now = Date.now();
    for (const p of this.parties.values()) {
      let ch = false;
      for (const [u, inv] of Object.entries(p.invites)) if (inv.expires < now) { delete p.invites[u]; ch = true; }
      if (p.link && p.link.expires < now) { p.link = null; ch = true; }
      if (ch) this.changed(p, p.members);
    }
  }
}

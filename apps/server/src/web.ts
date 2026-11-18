/**
 * REST routes behind the phone's in-game web (dealership, realty, bank, arms, news,
 * leaderboards, style). Everything that moves money goes through a Store transaction
 * that also writes ledger rows. Mounted from http.ts.
 */
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { DEALER_MODELS, PAINT_COLORS, SHOPS, VEHICLES, WEAPONS, WORLD, type VehicleModel } from '@blockshore/shared';
import { RateLimiter } from './ratelimit.ts';
import { config } from './config.ts';
import { newToken } from './auth.ts';
import type { Game } from './game.ts';
import type { User } from './store.ts';
import { AMMO_PREMIUM, BANK, BASE_GARAGE_SLOTS, BIG_HEIST_CASH, COLLECT_COOLDOWN_H, PROPERTIES, PROPERTY_BY_ID } from './webcontent.ts';

const T = config.test;
const readLimiter = new RateLimiter(T ? 100_000 : 40, T ? 100_000 : 2);        // per user: page loads
const writeLimiter = new RateLimiter(T ? 100_000 : 12, T ? 100_000 : 0.25);    // per user: purchases
const bankLimiter = new RateLimiter(T ? 100_000 : 6, T ? 100_000 : 6 / 60);    // per user: transfers (~6/min)

interface Ctx {
  game: Game;
  authed: (req: IncomingMessage) => Promise<User>;
  parse: <S>(schema: z.ZodType<S>, data: unknown) => S;
  body: (req: IncomingMessage) => Promise<unknown>;
  HttpError: new (status: number, message: string, code?: string) => Error;
}

interface Pending { from: string; to: { id: string; name: string }; amount: number; expires: number }
const pendingTransfers = new Map<string, Pending>();

export function makeWebRoutes({ game, authed, parse, body, HttpError }: Ctx): Record<string, (req: IncomingMessage, url: URL) => Promise<unknown>> {
  const store = game.store;
  const fail = (status: number, msg: string, code?: string): never => { throw new HttpError(status, msg, code); };
  const rd = (u: User) => { if (!readLimiter.take(u.id)) fail(429, 'Slow down a little.'); };
  const wr = (u: User) => { if (!writeLimiter.take(u.id)) fail(429, 'Too many orders. Try again in a moment.'); };
  async function garageInfo(userId: string) { const used = (await store.vehicles(userId)).length; return { used, cap: await store.garageCap(userId) }; }
  async function propertyView(userId: string) {
    const { owned, spawn } = await store.ownedProperties(userId);
    const by = new Map(owned.map((o) => [o.property_id, o]));
    const now = Date.now();
    return {
      spawn,
      properties: PROPERTIES.map((p) => {
        const o = by.get(p.id);
        const next = o ? new Date(o.last_collected_at).getTime() + COLLECT_COOLDOWN_H * 3_600_000 : null;
        return { ...p, owned: !!o, boughtAt: o ? new Date(o.bought_at).toISOString() : null, nextCollectAt: next ? new Date(next).toISOString() : null, canCollect: !!o && !!p.perks.dailyIncome && next !== null && next <= now };
      }),
    };
  }

  return {
    // ── Sunline Motors Online
    'GET /api/web/dealer': async (req) => {
      const u = await authed(req); rd(u);
      const prof = await store.profile(u.id);
      return { cash: prof.cash, garage: await garageInfo(u.id), models: DEALER_MODELS.map((m) => ({ model: m, price: VEHICLES[m].price })), colors: PAINT_COLORS };
    },
    'POST /api/web/dealer/buy': async (req) => {
      const u = await authed(req); wr(u);
      const b = parse(z.object({ model: z.string().max(32), color: z.number().int().min(0).max(0xffffff) }), await body(req));
      if (!DEALER_MODELS.includes(b.model as VehicleModel) || !VEHICLES[b.model as VehicleModel]) return fail(400, 'That vehicle is not for sale.');
      if (!PAINT_COLORS.includes(b.color)) return fail(400, 'That paint is not available.');
      const model = b.model as VehicleModel;
      const r = await store.buyVehicle(u.id, model, VEHICLES[model].price, b.color);
      if (!r.ok) return fail(409, r.error);
      await store.audit(u.id, 'web_buy_vehicle', { model, price: VEHICLES[model].price });
      await game.refreshProfile(u.id);
      game.notify(u.id, `Sunline Motors: your ${VEHICLES[model].name} is waiting in your garage.`, 'good', 'cash');
      return { ok: true, vehicleId: r.id, cash: r.cash, garage: await garageInfo(u.id) };
    },

    // ── Palmara Realty
    'GET /api/web/properties': async (req) => {
      const u = await authed(req); rd(u);
      const prof = await store.profile(u.id);
      return { cash: prof.cash, garage: await garageInfo(u.id), baseSlots: BASE_GARAGE_SLOTS, cooldownHours: COLLECT_COOLDOWN_H, ...(await propertyView(u.id)) };
    },
    'POST /api/web/properties/buy': async (req) => {
      const u = await authed(req); wr(u);
      const b = parse(z.object({ property: z.string().max(40) }), await body(req));
      const def = PROPERTY_BY_ID[b.property];
      if (!def) return fail(404, 'No such listing.');
      const r = await store.buyProperty(u.id, def);
      if (!r.ok) return fail(409, r.error, r.code);
      await store.audit(u.id, 'web_buy_property', { property: def.id, price: def.price });
      await game.refreshProfile(u.id);
      game.notify(u.id, `${WORLD === 'leonia' ? 'Leonia' : 'Palmara'} Realty: ${def.name} is yours.`, 'good', 'cash');
      return { ok: true, cash: r.cash, garage: await garageInfo(u.id), ...(await propertyView(u.id)) };
    },
    'POST /api/web/properties/collect': async (req) => {
      const u = await authed(req); wr(u);
      const b = parse(z.object({ property: z.string().max(40) }), await body(req));
      const def = PROPERTY_BY_ID[b.property];
      if (!def) return fail(404, 'No such listing.');
      const r = await store.collectProperty(u.id, def);
      if (!r.ok) return fail(409, r.error, r.nextAt ? 'cooldown' : undefined);
      await game.refreshProfile(u.id);
      return { ok: true, cash: r.cash, amount: r.amount, ...(await propertyView(u.id)) };
    },
    'POST /api/web/properties/spawn': async (req) => {
      const u = await authed(req); wr(u);
      const b = parse(z.object({ property: z.string().max(40).nullable() }), await body(req));
      if (b.property !== null) {
        const def = PROPERTY_BY_ID[b.property];
        if (!def?.perks.spawn) return fail(400, 'You cannot spawn at that property.');
      }
      if (!(await store.setSpawnProperty(u.id, b.property))) return fail(409, 'You do not own that property.');
      await game.refreshSpawn(u.id);
      return { ok: true, ...(await propertyView(u.id)) };
    },

    // ── First Coral Bank
    'GET /api/web/bank': async (req) => {
      const u = await authed(req); rd(u);
      const prof = await store.profile(u.id);
      const sentToday = await store.sentLast24h(u.id);
      return {
        cash: prof.cash, ledger: await store.ledgerRows(u.id), friends: await store.transferableFriends(u.id),
        limits: { dailyCap: BANK.dailyCap, sentToday, remaining: Math.max(0, BANK.dailyCap - sentToday), min: BANK.min, max: BANK.perTransferMax },
      };
    },
    'POST /api/web/bank/quote': async (req) => {
      const u = await authed(req); if (!bankLimiter.take(u.id)) fail(429, 'Too many transfers. Wait a minute.');
      const b = parse(z.object({ to: z.string().max(64), amount: z.number().int() }), await body(req));
      if (b.amount < BANK.min || b.amount > BANK.perTransferMax) return fail(400, `Transfers are $${BANK.min} to $${BANK.perTransferMax.toLocaleString('en-US')}.`);
      const target = await store.getUser(b.to);
      if (!target || target.id === u.id) return fail(404, 'Pick one of your friends.');
      if (!(await store.areFriends(u.id, target.id))) return fail(403, 'You can only send money to friends.', 'not_friend');
      if (await store.isBlockedEither(u.id, target.id)) return fail(403, 'You cannot send money to this player.', 'blocked');
      const prof = await store.profile(u.id);
      if (prof.cash < b.amount) return fail(409, 'Not enough cash.', 'funds');
      const sentToday = await store.sentLast24h(u.id);
      if (sentToday + b.amount > BANK.dailyCap) return fail(409, `Daily limit: you can still send $${Math.max(0, BANK.dailyCap - sentToday).toLocaleString('en-US')} today.`, 'cap');
      const token = newToken();
      const expires = Date.now() + BANK.confirmTtlMs;
      for (const [k, v] of pendingTransfers) if (v.expires < Date.now()) pendingTransfers.delete(k);
      pendingTransfers.set(token, { from: u.id, to: { id: target.id, name: target.display_name }, amount: b.amount, expires });
      return { token, to: { id: target.id, name: target.display_name }, amount: b.amount, expires, cashAfter: prof.cash - b.amount, remainingToday: BANK.dailyCap - sentToday - b.amount };
    },
    'POST /api/web/bank/transfer': async (req) => {
      const u = await authed(req); if (!bankLimiter.take(u.id)) fail(429, 'Too many transfers. Wait a minute.');
      const b = parse(z.object({ token: z.string().max(200) }), await body(req));
      const p = pendingTransfers.get(b.token);
      if (!p || p.from !== u.id || p.expires < Date.now()) return fail(410, 'This confirmation expired. Start the transfer again.', 'expired');
      pendingTransfers.delete(b.token); // single use
      const r = await store.transferCash({ id: u.id, name: u.display_name }, p.to, p.amount);
      if (!r.ok) return fail(r.code === 'funds' || r.code === 'cap' ? 409 : 403, r.error, r.code);
      await store.audit(u.id, 'web_transfer', { to: p.to.id, amount: p.amount });
      await game.refreshProfile(u.id);
      await game.refreshProfile(p.to.id).catch(() => {});
      game.notify(p.to.id, `First Coral Bank: ${u.display_name} sent you $${p.amount.toLocaleString('en-US')}.`, 'good', 'cash');
      return { ok: true, cash: r.cash, sent: p.amount, to: p.to.name, remainingToday: BANK.dailyCap - r.sentToday };
    },

    // ── Bullseye Arms Online
    'GET /api/web/arms': async (req) => {
      const u = await authed(req); rd(u);
      const prof = await store.profile(u.id);
      const owned: Record<string, number> = {};
      for (const id of Object.keys(WEAPONS)) if (id !== 'stun' && prof.inventory[`weapon:${id}`]) owned[id] = prof.inventory[`ammo:${id}`] ?? 0;
      return { cash: prof.cash, owned, premium: AMMO_PREMIUM };
    },
    'POST /api/web/arms/ammo': async (req) => {
      const u = await authed(req); wr(u);
      const b = parse(z.object({ weapon: z.string().max(32) }), await body(req));
      const r = await game.webAmmo(u.id, b.weapon, AMMO_PREMIUM);
      if (!r.ok) return fail(409, r.error);
      await store.audit(u.id, 'web_ammo', { weapon: b.weapon, price: r.price });
      return { ok: true, cash: r.cash, price: r.price, added: r.added, ammo: r.total };
    },

    // ── The Solano Signal
    'GET /api/web/news': async (req) => {
      const u = await authed(req); rd(u);
      return store.newsFeed(u.id, BIG_HEIST_CASH);
    },

    // ── Podium leaderboards
    'GET /api/web/leaderboard': async (req) => {
      const u = await authed(req); rd(u);
      return store.leaderboards();
    },

    // ── Threadline Online
    'GET /api/web/style': async (req) => {
      const u = await authed(req); rd(u);
      const prof = await store.profile(u.id);
      return { cash: prof.cash, outfit: prof.outfit, items: SHOPS.clothes.items.filter((i) => i.effect.outfit !== undefined).map((i) => ({ id: i.id, name: i.name, price: i.price, desc: i.desc, color: i.effect.outfit, category: (i as { category?: string }).category ?? 'Everyday' })) };
    },
    'POST /api/web/style/buy': async (req) => {
      const u = await authed(req); wr(u);
      const b = parse(z.object({ item: z.string().max(40) }), await body(req));
      const item = SHOPS.clothes.items.find((i) => i.id === b.item && i.effect.outfit !== undefined);
      if (!item) return fail(404, 'That item is not available.');
      const prof = await store.profile(u.id);
      if (prof.outfit === item.effect.outfit) return fail(409, 'You are already wearing that.');
      const r = await store.purchase(u.id, item.price, `web buy ${item.id}`);
      if (!r.ok) return fail(409, r.error);
      await game.webOutfit(u.id, item.effect.outfit!);
      return { ok: true, cash: r.cash, outfit: item.effect.outfit };
    },
  };
}

/* DEV ONLY (ui-demo.html): canned /api/web/* responses so the in-game websites can be reviewed without a server. */
import { DEALER_MODELS, PAINT_COLORS, VEHICLES, SHOPS, WEAPONS } from '@blockshore/shared';
import { getState, setState } from '../../state/store';

const json = (o: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } }));
const err = (msg: string, status = 409) => json({ error: msg }, status);
const cash = () => getState().profile?.cash ?? 0;
const pay = (n: number) => setState((s) => (s.profile ? { profile: { ...s.profile, cash: s.profile.cash - n } } : {}));

const day = 86_400_000;
const props = [
  { id: 'plaza_loft', name: 'Plaza Loft', kind: 'safehouse', area: 'Solano Plaza, Port Solano', blurb: 'Two floors above the fountain. Pigeons included, noise not.', price: 45000, perks: { spawn: true }, pos: [2448, 3168] },
  { id: 'beach_bungalow', name: 'Ocean Drive Bungalow', kind: 'safehouse', area: 'Solano Beach', blurb: 'Pastel stucco, a hammock and a carport for two.', price: 62000, perks: { spawn: true, garageSlots: 2 }, pos: [2800, 3150] },
  { id: 'torque_lockup', name: 'Torque Row Lockup', kind: 'garage', area: 'Next to Torque & Tide, Port Solano', blurb: 'Four bays, one flickering light, zero questions.', price: 30000, perks: { garageSlots: 4 }, pos: [2424, 3192] },
  { id: 'pelican_franchise', name: 'Quik Pelican Franchise', kind: 'business', area: 'Port Solano', blurb: 'You own a share of the snack bars. The snack bars own you.', price: 60000, perks: { dailyIncome: 1500 }, pos: [2448, 3240] },
  { id: 'lagoon_stake', name: 'Neon Lagoon Stake', kind: 'business', area: 'Neon Lagoon, Port Solano', blurb: 'A quiet partner in a very loud nightclub.', price: 120000, perks: { dailyIncome: 3400 }, pos: [2544, 3192] },
  { id: 'cape_hangar', name: 'Cape Halcyon Hangar', kind: 'garage', area: 'Cape Halcyon', blurb: 'Rocket-adjacent storage. The launch is delayed, the rent is not.', price: 150000, perks: { garageSlots: 6, spawn: true, dailyIncome: 1000 }, pos: [2500, 1540] },
];
const owned = new Map<string, number>([['pelican_franchise', Date.now() - 2 * day]]);
let spawn: string | null = null;
const propView = () => ({
  cash: cash(), garage: { used: getState().profile?.vehicles.length ?? 0, cap: 10 + [...owned.keys()].reduce((n, id) => n + ((props.find((p) => p.id === id)?.perks as { garageSlots?: number }).garageSlots ?? 0), 0) }, baseSlots: 10, cooldownHours: 24, spawn,
  properties: props.map((p) => { const t = owned.get(p.id); const next = t ? t + day : null; return { ...p, owned: !!t, boughtAt: t ? new Date(t - day).toISOString() : null, nextCollectAt: next ? new Date(next).toISOString() : null, canCollect: !!next && next <= Date.now() && !!(p.perks as { dailyIncome?: number }).dailyIncome }; }),
});

const ago = (m: number) => new Date(Date.now() - m * 60000).toISOString();
const ledger = [
  { id: 9, amount: 1500, balance: 18450, reason: 'activity reward', at: ago(12) }, { id: 8, amount: -69, balance: 16950, reason: 'web ammo pistol', at: ago(55) }, { id: 7, amount: -400, balance: 17019, reason: 'buy paint:15915086', at: ago(130) },
  { id: 6, amount: 500, balance: 17419, reason: 'transfer from Kira', at: ago(300) }, { id: 5, amount: -14000, balance: 16919, reason: 'buy sedan', at: ago(900) }, { id: 4, amount: 2400, balance: 30919, reason: 'activity reward', at: ago(1500) }, { id: 1, amount: 2000, balance: 2000, reason: 'starting cash', at: ago(4000) },
];
let ammo = 24;

export function mockWeb(url: string, init?: RequestInit): Promise<Response> | null {
  if (!url.startsWith('/api/web/')) return null;
  const path = url.slice(9).split('?')[0];
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  switch (path) {
    case 'dealer': return json({ cash: cash(), garage: { used: getState().profile?.vehicles.length ?? 0, cap: 10 }, models: DEALER_MODELS.map((m) => ({ model: m, price: VEHICLES[m].price })), colors: PAINT_COLORS });
    case 'dealer/buy': { const p = VEHICLES[body.model as keyof typeof VEHICLES]?.price ?? 0; if (cash() < p) return err('Not enough cash.'); pay(p); return json({ ok: true, cash: cash(), garage: { used: 4, cap: 10 } }); }
    case 'properties': return json(propView());
    case 'properties/buy': { const p = props.find((x) => x.id === body.property); if (!p) return err('No such listing.', 404); if (owned.has(p.id)) return err('You already own this property.'); if (cash() < p.price) return err('Not enough cash.'); pay(p.price); owned.set(p.id, Date.now()); return json({ ok: true, ...propView() }); }
    case 'properties/collect': { const p = props.find((x) => x.id === body.property); const inc = (p?.perks as { dailyIncome?: number } | undefined)?.dailyIncome ?? 0; owned.set(body.property, Date.now()); pay(-inc); return json({ ok: true, amount: inc, ...propView() }); }
    case 'properties/spawn': spawn = body.property; return json({ ok: true, ...propView() });
    case 'bank': return json({ cash: cash(), ledger, friends: getState().social.friends.slice(0, 4).map((f) => ({ id: f.id, name: f.name })), limits: { dailyCap: 20000, sentToday: 4500, remaining: 15500, min: 10, max: 10000 } });
    case 'bank/quote': return json({ token: 'demo', to: { id: body.to, name: getState().social.friends.find((f) => f.id === body.to)?.name ?? 'Friend' }, amount: body.amount, expires: Date.now() + 120000, cashAfter: cash() - body.amount, remainingToday: 15500 - body.amount });
    case 'bank/transfer': { pay(500); return json({ ok: true, cash: cash(), sent: 500, to: 'Kira', remainingToday: 15000 }); }
    case 'arms': return json({ cash: cash(), owned: { pistol: ammo, smg: 330 }, premium: 1.15 });
    case 'arms/ammo': { const w = WEAPONS[body.weapon]; const price = Math.ceil(w.ammoPrice * 1.15); if (cash() < price) return err('Not enough cash.'); pay(price); ammo += w.ammoPack; return json({ ok: true, cash: cash(), price, added: w.ammoPack, ammo }); }
    case 'news': return json({ ticker: [{ name: 'Marlow', cash: 4200, at: ago(18), activity: 'heist_sundial' }, { name: 'Kira', cash: 2700, at: ago(95), activity: 'heist_sundial' }, { name: 'Dex_Drift', cash: 3100, at: ago(400), activity: 'heist_sundial' }], mine: [{ cash: 1500, at: ago(12), activity: 'story_1', kind: 'mission' }] });
    case 'leaderboard': return json({ boards: { race_downtown: [{ name: 'Dex_Drift', ms: 68450 }, { name: 'Kira', ms: 69120 }, { name: 'PalmPilot', ms: 71230 }, { name: 'Marlow', ms: 74800 }, { name: 'Nova', ms: 77010 }] }, richest: ['Marlow', 'Kira', 'PalmPilot', 'Dex_Drift', 'Nova', 'Tidewalker', 'SunnyJ', 'BeachBum'].map((name, i) => ({ name, cash: 420000 - i * 41000 })) });
    case 'style': return json({ cash: cash(), outfit: getState().profile?.outfit ?? 0, items: SHOPS.clothes.items.filter((i) => i.effect.outfit !== undefined).map((i) => ({ id: i.id, name: i.name, price: i.price, desc: i.desc, color: i.effect.outfit, category: (i as { category?: string }).category ?? 'Everyday' })) });
    case 'style/buy': { const it = SHOPS.clothes.items.find((i) => i.id === body.item); if (!it) return err('Not available.', 404); if (cash() < it.price) return err('Not enough cash.'); pay(it.price); return json({ ok: true, cash: cash(), outfit: it.effect.outfit }); }
    default: return err('Not found.', 404);
  }
}

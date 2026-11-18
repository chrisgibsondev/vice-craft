/** Shops, items and garage prices. The server is the only place prices are applied. */
import type { VehicleModel } from '../physics.ts';
import { WEAPONS } from './weapons.ts';

export interface ShopItem { id: string; name: string; price: number; desc: string; effect: { heal?: number; give?: string; outfit?: number } }


// ── additions: Bullseye Arms, Threadline, Fade Away Barbers (item ids follow the server's "weapon:<id>" / "ammo:<id>" convention) ──
type CatItem = ShopItem & { category?: string };
const gunItems: CatItem[] = ['pistol', 'smg', 'shotgun', 'rifle'].flatMap((id) => {
  const w = WEAPONS[id];
  return [
    { id: `weapon:${id}`, name: w.name, price: w.price, desc: `${w.desc} Comes with one ammo pack.`, effect: {}, category: 'Weapons' },
    { id: `ammo:${id}`, name: `${w.name} ammo (${w.ammoPack})`, price: w.ammoPrice, desc: `${w.ammoPack} rounds. Carry up to ${w.maxAmmo}.`, effect: {}, category: 'Ammo' },
  ] as CatItem[];
});
const outfit = (id: string, name: string, price: number, colour: number, category: string, desc = 'A new colour for your outfit.'): CatItem => ({ id, name, price, desc, effect: { outfit: colour }, category });
const hair = (id: string, name: string, price: number, colour: number): CatItem => ({ id, name, price, desc: 'Hair colour.', effect: { give: `hair:${colour.toString(16).padStart(6, '0')}` }, category: 'Colour' });

export const SHOPS: Record<string, { name: string; items: ShopItem[] }> = {
  store: {
    name: 'Quik Pelican',
    items: [
      { id: 'snack', name: 'Pelican Crunch bar', price: 15, desc: 'Restores 25 health now.', effect: { heal: 25 } },
      { id: 'medkit', name: 'First-aid kit', price: 150, desc: 'Carry up to 3. Use with [Q] to fully heal.', effect: { give: 'medkit' } },
      { id: 'soda', name: 'Glacier Fizz', price: 5, desc: 'Restores 10 health.', effect: { heal: 10 } },
    ],
  },
  diner: {
    name: 'Sunny Side Diner',
    items: [
      { id: 'breakfast', name: 'Sunrise Platter', price: 25, desc: 'Full heal.', effect: { heal: 100 } },
      { id: 'coffee', name: 'Bottomless coffee', price: 4, desc: 'Restores 10 health.', effect: { heal: 10 } },
    ],
  },
  club: {
    name: 'Neon Lagoon bar',
    items: [{ id: 'mocktail', name: 'Lagoon Lime (alcohol-free)', price: 12, desc: 'Restores 15 health.', effect: { heal: 15 } }],
  },
  gunstore: { name: 'Bullseye Arms', items: gunItems },
  clothes: {
    name: 'Threadline',
    items: [
      outfit('tl_white', 'Salt-white linen', 90, 0xf6f7f8, 'Everyday'),
      outfit('tl_denim', 'Harbour denim', 110, 0x2e6f95, 'Everyday'),
      outfit('tl_olive', 'Mangrove olive', 110, 0x6a7a3a, 'Everyday'),
      outfit('tl_coral', 'Sunset coral', 140, 0xff5d73, 'Everyday'),
      outfit('tl_teal', 'Lagoon teal', 140, 0x0a9396, 'Everyday'),
      outfit('tl_sand', 'Dune sand', 120, 0xd9c5a0, 'Everyday'),
      outfit('tl_crimson', 'Racing crimson', 260, 0xc1121f, 'Statement'),
      outfit('tl_violet', 'Neon violet', 260, 0x7b2cbf, 'Statement'),
      outfit('tl_mint', 'Mint chrome', 300, 0x80ffdb, 'Statement'),
      outfit('tl_mustard', 'Pelican mustard', 220, 0xe9c46a, 'Statement'),
      outfit('tl_graphite', 'Graphite suit', 600, 0x343a40, 'Formal', 'Looks serious. Good for banks, bad for beaches.'),
      outfit('tl_navy', 'Midnight tux', 750, 0x0b132b, 'Formal', 'Very quiet. Very expensive.'),
      outfit('tl_gold', 'Gold lamé', 1500, 0xffd60a, 'Luxury', 'Subtle, in a loud sort of way.'),
    ],
  },
  barber: {
    name: 'Fade Away Barbers',
    items: [
      hair('hr_black', 'Jet black', 40, 0x151515),
      hair('hr_brown', 'Chestnut brown', 40, 0x5a3825),
      hair('hr_blonde', 'Sun-bleached blonde', 60, 0xe9c46a),
      hair('hr_ginger', 'Ginger', 60, 0xc4511d),
      hair('hr_silver', 'Silver fox', 80, 0xced4da),
      hair('hr_teal', 'Lagoon teal', 120, 0x00b4d8),
      hair('hr_pink', 'Flamingo pink', 120, 0xff6bab),
      hair('hr_violet', 'Neon violet', 120, 0x9d4edd),
    ],
  },
  wardrobe: {
    name: 'Wardrobe',
    items: [
      { id: 'outfit_coral', name: 'Coral shirt', price: 0, desc: 'Outfit colour.', effect: { outfit: 0xff6f59 } },
      { id: 'outfit_teal', name: 'Teal shirt', price: 0, desc: 'Outfit colour.', effect: { outfit: 0x2ec4b6 } },
      { id: 'outfit_sun', name: 'Sun-yellow shirt', price: 0, desc: 'Outfit colour.', effect: { outfit: 0xffbf00 } },
      { id: 'outfit_violet', name: 'Violet shirt', price: 0, desc: 'Outfit colour.', effect: { outfit: 0x8338ec } },
      { id: 'outfit_night', name: 'Night-black shirt', price: 0, desc: 'Outfit colour.', effect: { outfit: 0x22223b } },
      { id: 'outfit_lime', name: 'Lime shirt', price: 0, desc: 'Outfit colour.', effect: { outfit: 0x9ef01a } },
    ],
  },
};

export const MAX_MEDKITS = 3;
export const PAINT_PRICE = 400;
export const REPAIR_PRICE_PER_HP = 0.6;
export const DELIVERY_PRICE = 100;
export const WANTED_FINE = 500;
export const STARTING_CASH = 2000;
export const STARTER_VEHICLE: VehicleModel = 'compact';
export const DEALER_MODELS: VehicleModel[] = ['compact', 'sedan', 'pickup', 'moto', 'van', 'sports', 'boat', 'coupe', 'muscle', 'classic', 'luxury', 'buggy', 'jetski', 'limo', 'supercar'];
export const PAINT_COLORS = [0xf2c14e, 0xd7263d, 0x2e86ab, 0x1b998b, 0xf6f7f8, 0x222831, 0xff6f59, 0x8338ec, 0x06d6a0, 0xffbe0b];

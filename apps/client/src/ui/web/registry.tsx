/** The in-game web: every site, its address and how the browser finds it. */
import type { ComponentType } from 'react';
import type { SiteProps } from './common';
import { SunlineSite } from './Sunline';
import { RealtySite } from './Realty';
import { BankSite } from './Bank';
import { ArmsSite } from './Arms';
import { SignalSite } from './Signal';
import { GigwireSite } from './Gigwire';
import { PodiumSite } from './Podium';
import { FlockSite } from './Flock';
import { ThreadlineSite } from './Threadline';

export interface SiteDef {
  id: string; url: string; title: string; tagline: string; icon: string; color: string;
  keywords: string[]; defaultBookmark: boolean; Component: ComponentType<SiteProps>;
}

export const SITES: SiteDef[] = [
  { id: 'sunline', url: 'sunlinemotors.pal', title: 'Sunline Motors Online', tagline: 'Buy a car, delivered to your garage', icon: 'car', color: '#ff9f1c', keywords: ['car', 'cars', 'vehicle', 'dealer', 'dealership', 'boat', 'bike', 'motors'], defaultBookmark: true, Component: SunlineSite },
  { id: 'realty', url: 'palmararealty.pal', title: 'Palmara Realty', tagline: 'Safehouses, garages and businesses', icon: 'home', color: '#d4af37', keywords: ['property', 'house', 'home', 'realty', 'real estate', 'garage', 'business'], defaultBookmark: true, Component: RealtySite },
  { id: 'bank', url: 'firstcoral.pal', title: 'First Coral Bank', tagline: 'Balance, history and transfers', icon: 'wallet', color: '#17b8aa', keywords: ['bank', 'money', 'cash', 'transfer', 'balance', 'ledger', 'send'], defaultBookmark: true, Component: BankSite },
  { id: 'arms', url: 'bullseyearms.pal', title: 'Bullseye Arms Online', tagline: 'Weapon catalogue and ammo delivery', icon: 'shield', color: '#ff5a72', keywords: ['gun', 'guns', 'weapon', 'weapons', 'ammo', 'arms', 'bullseye'], defaultBookmark: true, Component: ArmsSite },
  { id: 'signal', url: 'solanosignal.pal', title: 'The Solano Signal', tagline: 'News, satire and your own headlines', icon: 'globe', color: '#e9e4d4', keywords: ['news', 'headline', 'headlines', 'paper', 'signal', 'solano'], defaultBookmark: true, Component: SignalSite },
  { id: 'gigwire', url: 'gigwire.pal', title: 'Gigwire', tagline: 'Jobs, heists and crew work', icon: 'briefcase', color: '#4c8dff', keywords: ['job', 'jobs', 'work', 'heist', 'crew', 'mission', 'gig'], defaultBookmark: true, Component: GigwireSite },
  { id: 'podium', url: 'podium.pal', title: 'Podium', tagline: 'Leaderboards and rich lists', icon: 'crown', color: '#b394ff', keywords: ['leaderboard', 'top', 'rank', 'best', 'race', 'richest', 'scores'], defaultBookmark: false, Component: PodiumSite },
  { id: 'flock', url: 'flock.pal', title: 'Flock', tagline: 'What is Palmara squawking about?', icon: 'chat', color: '#5ad2ff', keywords: ['social', 'feed', 'posts', 'friends', 'flock'], defaultBookmark: false, Component: FlockSite },
  { id: 'threadline', url: 'threadline.pal', title: 'Threadline Online', tagline: 'Outfit colours, delivered', icon: 'cart', color: '#ff8e72', keywords: ['clothes', 'outfit', 'fashion', 'shirt', 'style', 'threadline', 'shop'], defaultBookmark: false, Component: ThreadlineSite },
];

export const HOME_URL = 'tidepool.pal';

export function normalizeUrl(raw: string): string {
  return raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').split(/[?#]/)[0];
}

/** Resolve whatever the player typed: an address, a site name, or keywords. */
export function resolve(raw: string): { kind: 'home' } | { kind: 'site'; site: SiteDef } | { kind: 'search'; query: string; results: SiteDef[] } {
  const q = normalizeUrl(raw);
  if (!q || q === HOME_URL || q === 'tidepool' || q === 'home') return { kind: 'home' };
  const exact = SITES.find((s) => s.url === q || s.url.replace(/\.pal$/, '') === q || s.id === q);
  if (exact) return { kind: 'site', site: exact };
  const words = q.split(/[\s.]+/).filter(Boolean);
  const results = SITES.filter((s) => words.every((w) => s.title.toLowerCase().includes(w) || s.url.includes(w) || s.keywords.some((k) => k.includes(w)) || s.tagline.toLowerCase().includes(w)));
  return { kind: 'search', query: raw.trim(), results };
}

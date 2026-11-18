import type { CSSProperties } from 'react';

const P: Record<string, string> = {
  home: 'M3 11 12 3l9 8v10h-6v-6H9v6H3z',
  star: 'M12 2l3 7 7 .6-5.3 4.7 1.7 7.2L12 17.8 5.6 21.5l1.7-7.2L2 9.6 9 9z',
  wrench: 'M14.7 6.3a4 4 0 0 0-5 5L3 18l3 3 6.7-6.7a4 4 0 0 0 5-5l-2.7 2.7-2.3-.7-.7-2.3z',
  cart: 'M3 4h3l2.4 11h10.2l2-8H7M9.5 20.5a1.3 1.3 0 1 0 0-.01M17.5 20.5a1.3 1.3 0 1 0 0-.01',
  cup: 'M5 8h12v5a5 5 0 0 1-5 5h-2a5 5 0 0 1-5-5zM17 9h2a2 2 0 0 1 0 5h-2M7 3v2M11 3v2M15 3v2',
  music: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zm11-2a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  shield: 'M12 2l8 3v6c0 5-3.4 9-8 11-4.6-2-8-6-8-11V5z',
  box: 'M3 7l9-4 9 4v10l-9 4-9-4zM3 7l9 4 9-4M12 11v10',
  briefcase: 'M3 8h18v12H3zM8 8V5h8v3M3 13h18',
  gem: 'M6 3h12l4 6-10 12L2 9zM2 9h20M9 3l-2 6 5 12 5-12-2-6',
  phone: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM10 19h4',
  map: 'M9 4 3 6v14l6-2 6 2 6-2V4l-6 2zM9 4v14M15 6v14',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2 20c0-3.5 3-6 7-6s7 2.5 7 6M17 11a3 3 0 1 0 0-6M19 14c2 .6 3 2.4 3 5',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 3.6-7 8-7s8 3 8 7',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  car: 'M4 16v-4l2-5h12l2 5v4M3 16h18v3H3zM7 19v2M17 19v2M6 12h12',
  close: 'M5 5l14 14M19 5 5 19',
  check: 'M4 12l5 5L20 6',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  crown: 'M3 8l4.5 4L12 5l4.5 7L21 8l-2 11H5z',
  chat: 'M4 4h16v12H9l-5 4z',
  back: 'M15 5l-7 7 7 7',
  plus: 'M12 5v14M5 12h14',
  mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3',
  flag: 'M5 21V4M5 4h12l-2 4 2 4H5',
  skull: 'M12 3a8 8 0 0 0-8 8c0 3 1.5 4.5 3 5.5V20h10v-3.5c1.5-1 3-2.5 3-5.5a8 8 0 0 0-8-8zM9 12h.01M15 12h.01',
  coin: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v10M9.5 9.5C9.5 8.5 10.5 8 12 8s2.5.6 2.5 1.6S13 11 12 11.3 9.5 12 9.5 13.2s1 1.8 2.5 1.8 2.5-.6 2.5-1.6',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  wifi: 'M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0M12 19.5h.01',
  heart: 'M12 21s-8-5.5-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.5-8 11-8 11z',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7z',
  pin: 'M12 22s7-6.5 7-12a7 7 0 0 0-14 0c0 5.5 7 12 7 12zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  logout: 'M10 4H4v16h6M16 8l4 4-4 4M20 12H9',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  play: 'M7 4l13 8-13 8z',
  wallet: 'M3 7h16a2 2 0 0 1 2 2v10H5a2 2 0 0 1-2-2zM3 7l12-3v3M17 14h.01',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  steering: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 13a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM3 12h6.5M14.5 12H21M12 13v8',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 11v6M12 7.5h.01',
  paint: 'M4 4h12v6H4zM16 7h3v6H11v3M11 16v5',
  dollar: 'M12 2v20M17 6.5C17 4.5 14.8 3.5 12 3.5S7 4.7 7 6.8s2.2 3 5 3.6 5 1.4 5 3.7-2.2 3.5-5 3.5-5-1.2-5-3.2',
};

export type IconName = string;

export function Icon({ name, size = 20, className, style, fill }: { name: IconName; size?: number; className?: string; style?: CSSProperties; fill?: boolean }) {
  const d = P[name] ?? P.star;
  return (
    <svg className={className} style={style} width={size} height={size} viewBox="0 0 24 24" fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={fill ? 1 : 2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function Star({ on, flash, size = 28 }: { on: boolean; flash?: boolean; size?: number }) {
  return (
    <svg className={`wstar ${on ? 'on' : ''} ${on && flash ? 'flash' : ''}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={P.star} />
    </svg>
  );
}

/** Flock: a satirical social feed seeded with original posts, your friends' presence and your own bests. */
import { useMemo, useState } from 'react';
import { ACTIVITY_BY_ID } from '@blockshore/shared';
import { useGame } from '../../state/store';
import { Avatar } from '../components';
import { fmtRace } from '../util';
import type { SiteProps } from './common';

interface Post { id: string; name: string; handle: string; text: string; likes: number; ago: string; color: string }
const FIXED: Post[] = [
  { id: 'f1', name: 'Gus the Valet', handle: '@gus_parks', text: 'Parked a boat on the fourth floor of Bayhaven Deck. Nobody asked. Nobody will.', likes: 214, ago: '2 min', color: '#ff8fab' },
  { id: 'f2', name: 'Channel 6 Weather', handle: '@ch6wx', text: 'Today: sun. Tomorrow: sun, with a chance of the same sun. Pack accordingly.', likes: 98, ago: '9 min', color: '#2ee6d6' },
  { id: 'f3', name: 'Pelican Crunch', handle: '@crunchbar', text: 'We have not changed our recipe. We have changed what we are willing to say about it.', likes: 451, ago: '14 min', color: '#ffd23f' },
  { id: 'f4', name: 'Valentina @ Sunline', handle: '@val_sunline', text: 'Yes, the Vireo GT is "fast". No, I will not say how fast. Come in and feel it in your soul.', likes: 77, ago: '31 min', color: '#ff4fa3' },
  { id: 'f5', name: 'DJ Kilo', handle: '@kilo_spins', text: 'Drift night at the Lagoon. Bring tyres. Bring friends. Do not bring the friends\' tyres.', likes: 330, ago: '48 min', color: '#9b5de5' },
  { id: 'f6', name: 'Rico (Bullseye)', handle: '@rico_arms', text: 'Reminder: the stun pistol is not a toy. The toy is also not a toy. Please read signs.', likes: 62, ago: '1 h', color: '#ff5a72' },
  { id: 'f7', name: 'Ocean Drive Seagull', handle: '@squawk', text: 'MINE. MINE. MINE. (this is about a fry)', likes: 1204, ago: '2 h', color: '#7fc6e8' },
  { id: 'f8', name: 'Mayor of Port Solano', handle: '@mayor_ps', text: 'Rooftop pool number five is open! Not a drill. Please do drill; we need a deeper end.', likes: 19, ago: '3 h', color: '#5be584' },
];

const KEY = 'blockshore.flock.likes';
const readLikes = (): Record<string, boolean> => { try { return JSON.parse(localStorage.getItem(KEY) ?? '{}'); } catch { return {}; } };

export function FlockSite(_: SiteProps) {
  const friends = useGame((s) => s.social.friends);
  const bests = useGame((s) => s.profile?.bests ?? {});
  const user = useGame((s) => s.user?.name ?? 'you');
  const [liked, setLiked] = useState<Record<string, boolean>>(readLikes);
  const toggle = (id: string) => setLiked((l) => { const n = { ...l, [id]: !l[id] }; try { localStorage.setItem(KEY, JSON.stringify(n)); } catch { /* storage unavailable */ } return n; });

  const live = useMemo<Post[]>(() => {
    const out: Post[] = [];
    for (const f of friends.filter((x) => x.status !== 'offline').slice(0, 4)) out.push({ id: `fr${f.id}`, name: f.name, handle: `@${f.name.toLowerCase()}`, text: f.where ? `Currently at ${f.where}. Send snacks.` : 'Online and thinking about doing something.', likes: 3 + (f.name.length % 7), ago: 'now', color: '#ff4fa3' });
    for (const [id, ms] of Object.entries(bests).slice(0, 2)) out.push({ id: `b${id}`, name: user, handle: `@${user.toLowerCase()}`, text: `New personal best on ${ACTIVITY_BY_ID[id]?.name ?? id}: ${fmtRace(ms)}. Do not ask about the wall.`, likes: 12, ago: 'today', color: '#2ee6d6' });
    return out;
  }, [friends, bests, user]);
  const posts = [...live, ...FIXED];

  return (
    <div className="web wb-flock">
      <header className="wb-hero">
        <div className="wb-logo">flock<span>.</span></div>
        <p>What's happening, Palmara?</p>
      </header>
      <div className="wb-compose">
        <input type="text" disabled aria-label="Compose a post" placeholder="Posting is paused while Gus fixes the server" />
        <span className="wb-why">Reading only: the intern lost the posting button</span>
      </div>
      <ul className="wb-feed">
        {posts.map((p) => (
          <li key={p.id}>
            <Avatar name={p.name} size={34} color={p.color} />
            <div className="grow">
              <div className="wb-who"><b>{p.name}</b><small>{p.handle} · {p.ago}</small></div>
              <p>{p.text}</p>
              <button type="button" className={`wb-like ${liked[p.id] ? 'on' : ''}`} aria-pressed={!!liked[p.id]} onClick={() => toggle(p.id)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill={liked[p.id] ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2"><path d="M12 21s-8-5.5-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.5-8 11-8 11z" /></svg>
                {p.likes + (liked[p.id] ? 1 : 0)}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

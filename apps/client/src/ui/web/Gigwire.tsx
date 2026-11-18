/** Gigwire: every job in Palmara by kind, with lock state, rewards, personal bests and a button into the existing brief. */
import { useMemo, useState } from 'react';
import { ACTIVITIES, ACTIVITY_BY_ID, CONTACTS, type ActivityDef } from '@blockshore/shared';
import { useGame } from '../../state/store';
import { openBrief, openOverlay } from '../../state/actions';
import { fmtRace, money } from '../util';
import { WBtn, type SiteProps } from './common';

export function jobStatus(a: ActivityDef, completed: Record<string, number>, rep: number): 'locked' | 'available' | 'done' {
  if ((completed[a.id] ?? 0) > 0) return 'done';
  const req = a.unlock.requires ?? [];
  if (req.some((r) => !(completed[r] > 0))) return 'locked';
  if ((a.unlock.rep ?? 0) > rep) return 'locked';
  return 'available';
}
export function lockReason(a: ActivityDef, completed: Record<string, number>, rep: number): string {
  const miss = (a.unlock.requires ?? []).filter((r) => !(completed[r] > 0)).map((r) => ACTIVITY_BY_ID[r]?.name ?? r);
  if (miss.length) return `Finish first: ${miss.join(', ')}`;
  if ((a.unlock.rep ?? 0) > rep) return `Needs ${a.unlock.rep} rep (you have ${rep})`;
  return 'Locked';
}

const GROUPS: { id: string; title: string; test: (a: ActivityDef) => boolean }[] = [
  { id: 'mission', title: 'Story work', test: (a) => a.kind === 'mission' },
  { id: 'heist', title: 'Heists', test: (a) => a.kind === 'heist' },
  { id: 'prep', title: 'Heist preps', test: (a) => a.kind === 'heist_prep' },
  { id: 'mini', title: 'Races & side gigs', test: (a) => a.kind === 'minigame' },
];

export function GigwireSite(_: SiteProps) {
  const profile = useGame((s) => s.profile);
  const completed = profile?.completed ?? {};
  const rep = profile?.rep ?? 0;
  const bests = profile?.bests ?? {};
  const [only, setOnly] = useState<string>('all');
  const groups = useMemo(() => GROUPS.map((g) => ({ ...g, items: ACTIVITIES.filter(g.test) })).filter((g) => g.items.length), []);
  const done = ACTIVITIES.filter((a) => (completed[a.id] ?? 0) > 0).length;

  return (
    <div className="web wb-gig">
      <header className="wb-hero">
        <div className="wb-logo">gig<b>wire</b></div>
        <p>Work that works. Mostly. Posted by people who should not be hiring.</p>
        <div className="wb-strip"><span>Completed <b>{done}/{ACTIVITIES.length}</b></span><span>Rep <b>{rep}</b></span></div>
      </header>
      <div className="wb-chips" role="tablist">
        <button type="button" role="tab" aria-selected={only === 'all'} className={only === 'all' ? 'on' : ''} onClick={() => setOnly('all')}>All</button>
        {groups.map((g) => <button key={g.id} type="button" role="tab" aria-selected={only === g.id} className={only === g.id ? 'on' : ''} onClick={() => setOnly(g.id)}>{g.title}</button>)}
      </div>
      {groups.filter((g) => only === 'all' || only === g.id).map((g) => (
        <section key={g.id}>
          <h2 className="wb-h2">{g.title} <small>{g.items.length}</small></h2>
          {g.items.map((a) => {
            const st = jobStatus(a, completed, rep);
            const giver = CONTACTS[a.giver];
            const best = bests[a.id];
            return (
              <article key={a.id} className={`wb-job st-${st}`}>
                <div className="wb-row"><h3>{a.name}</h3><span className={`wb-pill ${st}`}>{st === 'done' ? 'Done' : st === 'locked' ? 'Locked' : 'Open'}</span></div>
                <p className="wb-from">Posted by {giver?.name ?? a.giver}{giver ? ` · ${giver.role}` : ''}</p>
                <p>{a.blurb}</p>
                <div className="wb-meta">
                  <span>{money(a.rewards.cash[0])}{a.rewards.cash[3] !== a.rewards.cash[0] ? ` – ${money(a.rewards.cash[3])}` : ''}</span>
                  <span>+{a.rewards.rep} rep</span>
                  <span>1–{a.maxPlayers} players</span>
                  {(completed[a.id] ?? 0) > 0 && <span>Done {completed[a.id]}x</span>}
                  {best != null && <span className="best">Best {fmtRace(best)}</span>}
                </div>
                <WBtn disabled={st === 'locked'} why={st === 'locked' ? lockReason(a, completed, rep) : undefined} onClick={() => openBrief(a.id)}>{st === 'done' ? 'Replay: open brief' : 'Open brief'}</WBtn>
              </article>
            );
          })}
        </section>
      ))}
      <WBtn kind="ghost" onClick={() => openOverlay('heistboard')}>Open the heist board</WBtn>
      <footer className="wb-foot">Gigwire takes no commission. The people behind the jobs take everything else.</footer>
    </div>
  );
}

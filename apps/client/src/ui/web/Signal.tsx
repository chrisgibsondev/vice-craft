/** The Solano Signal: satirical headlines plus live ones built from the player's own history and the server-wide heist ticker. */
import { useMemo } from 'react';
import { ACTIVITY_BY_ID } from '@blockshore/shared';
import { webApi } from '../../net/api';
import { useGame } from '../../state/store';
import { money } from '../util';
import { LoadGate, fmtAgo, useLoad, type SiteProps } from './common';

const SATIRE: { h: string; b: string }[] = [
  { h: 'Council Votes 9-0 to Study Whether Potholes Are "Just Texture"', b: 'Port Solano drivers will be consulted by pamphlet. Pamphlets are in the pothole.' },
  { h: 'Local Pelican Officially Elected Harbour Master', b: 'Turnout was 100 percent. The pelican abstained, then ate the ballot box.' },
  { h: 'Sunline Motors Unveils Convertible Convertible', b: 'It converts into a convertible. Engineers declined to say from what.' },
  { h: 'Cape Halcyon Launch Delayed Again: "The Rocket Wants More Time"', b: 'A spokesperson described the delay as "a feeling, but a professional one".' },
  { h: 'Lake Mirabel Gator Spotted Using Crosswalk Correctly', b: 'Witnesses say it waited for the little green man. Drivers did not.' },
  { h: 'Coral Keys Ferry Replaced by "A Strong Maybe"', b: 'Ridership is up. So is everyone\'s blood pressure.' },
  { h: 'Mayor Opens Fourth Rooftop Pool This Month, Fifth Next Week', b: 'Asked about the water table, the Mayor replied: "Which table?"' },
  { h: 'Flamingo Causeway Declared a Mood, Not a Road', b: 'Commuters are advised to arrive emotionally and not on time.' },
  { h: 'Neon Lagoon Introduces Silent Disco for Cats', b: 'The cats had no comment, but several left tips.' },
  { h: 'Study Finds Palmara Traffic Is 40 Percent Horns', b: 'The remaining 60 percent is people explaining their horn.' },
];

function personalHeadline(id: string, name: string, kind: string, count: number): string {
  if (kind === 'heist') return count > 1 ? `Serial Heister Hits "${name}" Again. Police: "We Noticed This Time"` : `Daring Raid: "${name}" Leaves City Speechless and Vault Empty`;
  if (kind === 'heist_prep') return `Suspicious Crew Seen Doing "${name}". Neighbours Say They Were "Very Polite"`;
  if (kind === 'minigame') return `Local Driver Posts Time on "${name}", Immediately Insufferable`;
  return `Newcomer Wraps Up "${name}" and Nobody Is Quite Sure How`;
}

export function SignalSite(_: SiteProps) {
  const load = useLoad(() => webApi.news());
  const completed = useGame((s) => s.profile?.completed ?? {});
  const wanted = useGame((s) => s.hud.wanted);
  const day = Math.floor(Date.now() / 86_400_000);
  const today = useMemo(() => [0, 1, 2, 3].map((i) => SATIRE[(day * 3 + i * 2 + i) % SATIRE.length]), [day]);

  const mine = useMemo(() => {
    const rows = Object.entries(completed).filter(([id, n]) => n > 0 && ACTIVITY_BY_ID[id]).map(([id, n]) => ({ id, n, def: ACTIVITY_BY_ID[id] }));
    return rows.sort((a, b) => (b.def.kind === 'heist' ? 1 : 0) - (a.def.kind === 'heist' ? 1 : 0)).slice(0, 5);
  }, [completed]);

  return (
    <div className="web wb-signal">
      <header className="wb-mast">
        <small>Est. 1974 · All the news that fits, and some that doesn't</small>
        <h1>The Solano Signal</h1>
        <div className="wb-rule" />
      </header>
      <LoadGate load={load}>{(d) => (
        <>
          <div className="wb-ticker" aria-label="Recent big heist payouts"><div>
            {d.ticker.length === 0 ? <span>NO BIG SCORES TODAY · POLICE SUSPICIOUSLY QUIET · </span> : [...d.ticker, ...d.ticker].map((t, i) => <span key={i}>{t.name.toUpperCase()} WALKED AWAY WITH {money(t.cash)} FROM {(ACTIVITY_BY_ID[t.activity]?.name ?? 'A JOB').toUpperCase()} · </span>)}
          </div></div>

          {wanted > 0 && (
            <article className="wb-lead live">
              <span className="wb-tag">BREAKING · LIVE</span>
              <h2>Police Pursue Unnamed Suspect Described as "Definitely Whoever Is Reading This"</h2>
              <p>Authorities report a level {wanted} response. Helicopters are being used for reasons of drama.</p>
            </article>
          )}

          <article className="wb-lead">
            <span className="wb-tag">FRONT PAGE</span>
            <h2>{today[0].h}</h2>
            <p>{today[0].b}</p>
          </article>

          <h3 className="wb-h3">Your headlines</h3>
          {mine.length === 0 && d.mine.length === 0 && <p className="wb-note">Nothing to report about you yet. Do something newsworthy. Or illegal. Our editors can't tell the difference.</p>}
          {d.mine.slice(0, 3).map((m, i) => {
            const def = ACTIVITY_BY_ID[m.activity];
            return <article key={`m${i}`} className="wb-story"><b>{personalHeadline(m.activity, def?.name ?? 'a job', m.kind, completed[m.activity] ?? 1)}</b><small>{money(m.cash)} reportedly changed hands · {fmtAgo(m.at)}</small></article>;
          })}
          {mine.filter((r) => !d.mine.some((m) => m.activity === r.id)).slice(0, 3).map((r) => (
            <article key={r.id} className="wb-story"><b>{personalHeadline(r.id, r.def.name, r.def.kind, r.n)}</b><small>Completed {r.n}x · {r.def.kind.replace('_', ' ')}</small></article>
          ))}

          <h3 className="wb-h3">Around Palmara</h3>
          {today.slice(1).map((s) => <article key={s.h} className="wb-story"><b>{s.h}</b><small>{s.b}</small></article>)}

          <h3 className="wb-h3">Big scores this week</h3>
          {d.ticker.length === 0 ? <p className="wb-note">No payouts over {money(1000)} yet. Crime is down, allegedly.</p> : (
            <ul className="wb-scores">{d.ticker.map((t, i) => <li key={i}><span><b>{t.name}</b> · {ACTIVITY_BY_ID[t.activity]?.name ?? 'A job'}</span><b>{money(t.cash)}</b></li>)}</ul>
          )}
          <footer className="wb-foot">Names shown are public display names only. The Signal is satire; any resemblance to a functioning city is coincidence.</footer>
        </>
      )}</LoadGate>
    </div>
  );
}

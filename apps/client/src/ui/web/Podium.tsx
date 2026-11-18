/** Podium: top personal bests for every race / mini-game and the richest players in Palmara. */
import { useState } from 'react';
import { ACTIVITIES, ACTIVITY_BY_ID } from '@blockshore/shared';
import { webApi } from '../../net/api';
import { useGame } from '../../state/store';
import { fmtRace, money } from '../util';
import { LoadGate, useLoad, type SiteProps } from './common';

export function PodiumSite(_: SiteProps) {
  const load = useLoad(() => webApi.leaderboard());
  const me = useGame((s) => s.user?.name);
  const myBests = useGame((s) => s.profile?.bests ?? {});
  const [board, setBoard] = useState<string>('rich');
  const medal = (i: number) => (i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '');

  return (
    <div className="web wb-podium">
      <header className="wb-hero">
        <h1>POD<em>IUM</em></h1>
        <p>Fastest laps. Fattest wallets. Zero participation trophies.</p>
      </header>
      <LoadGate load={load}>{(d) => {
        const ids = [...new Set([...ACTIVITIES.filter((a) => a.kind === 'minigame').map((a) => a.id), ...Object.keys(d.boards)])].filter((id) => ACTIVITY_BY_ID[id]);
        const cur = board === 'rich' ? null : d.boards[board] ?? [];
        return (
          <>
            <div className="wb-chips" role="tablist">
              <button type="button" role="tab" aria-selected={board === 'rich'} className={board === 'rich' ? 'on' : ''} onClick={() => setBoard('rich')}>Richest</button>
              {ids.map((id) => <button key={id} type="button" role="tab" aria-selected={board === id} className={board === id ? 'on' : ''} onClick={() => setBoard(id)}>{ACTIVITY_BY_ID[id].name}</button>)}
            </div>
            {board === 'rich' ? (
              <ol className="wb-rank" aria-label="Richest players">
                {d.richest.length === 0 && <li className="empty">Nobody has any money. Remarkable.</li>}
                {d.richest.map((r, i) => <li key={i} className={`${medal(i)} ${r.name === me ? 'me' : ''}`}><span className="n">{i + 1}</span><span className="grow">{r.name}{r.name === me && ' (you)'}</span><b>{money(r.cash)}</b></li>)}
              </ol>
            ) : (
              <>
                <h2 className="wb-h2">{ACTIVITY_BY_ID[board]?.name} <small>fastest first</small></h2>
                <ol className="wb-rank" aria-label="Top times">
                  {cur && cur.length === 0 && <li className="empty">No times set yet. Be the first.</li>}
                  {cur?.map((r, i) => <li key={i} className={`${medal(i)} ${r.name === me ? 'me' : ''}`}><span className="n">{i + 1}</span><span className="grow">{r.name}{r.name === me && ' (you)'}</span><b>{fmtRace(r.ms)}</b></li>)}
                </ol>
                <p className="wb-note">{myBests[board] != null ? `Your best: ${fmtRace(myBests[board])}` : 'You have not set a time here yet.'}</p>
              </>
            )}
            <footer className="wb-foot">Boards show display names and times only. Banned players are removed.</footer>
          </>
        );
      }}</LoadGate>
    </div>
  );
}

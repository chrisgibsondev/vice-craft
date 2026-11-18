/** Palmara Realty: buy safehouses, garages and businesses. Perks (garage slots, daily income, spawn) are enforced by the server. */
import { WORLD } from '@blockshore/shared';
import { useState } from 'react';
import { webApi, type WebProperties, type WebProperty } from '../../net/api';
import { useGame } from '../../state/store';
import { setWaypoint } from '../waypoint';
import { useNow, money } from '../util';
import { ConfirmBtn, Flash, LoadGate, WBtn, fmtIn, useAction, useLoad, type SiteProps } from './common';

const KIND_LABEL = { safehouse: 'Safehouse', garage: 'Garage', business: 'Business' } as const;

function Perks({ p }: { p: WebProperty }) {
  return (
    <ul className="wb-perks">
      {p.perks.garageSlots ? <li>+{p.perks.garageSlots} garage slots</li> : null}
      {p.perks.dailyIncome ? <li>{money(p.perks.dailyIncome)} / day</li> : null}
      {p.perks.spawn ? <li>Spawn point</li> : null}
    </ul>
  );
}

export function RealtySite(_: SiteProps) {
  const load = useLoad(() => webApi.properties());
  const cash = useGame((s) => s.profile?.cash ?? 0);
  const act = useAction();
  const now = useNow(30_000);
  const [filter, setFilter] = useState<'all' | 'mine' | WebProperty['kind']>('all');
  const take = (r: WebProperties) => load.patch(() => ({ cash: r.cash, garage: r.garage, baseSlots: r.baseSlots, cooldownHours: r.cooldownHours, spawn: r.spawn, properties: r.properties }));

  return (
    <div className="web wb-realty">
      <header className="wb-hero">
        <span className="wb-kicker">{WORLD === 'leonia' ? 'Leonia' : 'Palmara'} Realty &amp; Trust</span>
        <h1>Own a piece of {WORLD === 'leonia' ? 'Miami' : 'Palmara'}</h1>
        <p>Safehouses with sea views, garages with room for one more, and businesses that pay you to sleep.</p>
      </header>
      <LoadGate load={load}>{(d) => {
        const mine = d.properties.filter((p) => p.owned);
        const income = mine.reduce((n, p) => n + (p.perks.dailyIncome ?? 0), 0);
        const spawn = d.properties.find((p) => p.id === d.spawn);
        const list = d.properties.filter((p) => filter === 'all' || (filter === 'mine' ? p.owned : p.kind === filter));
        return (
          <>
            <section className="wb-profile" aria-label="Your portfolio">
              <h2>Your portfolio</h2>
              <div className="wb-grid3">
                <div><small>Properties</small><b>{mine.length}/{d.properties.length}</b></div>
                <div><small>Garage slots</small><b>{d.garage.used}/{d.garage.cap}</b></div>
                <div><small>Income / day</small><b>{money(income)}</b></div>
              </div>
              <p className="wb-note">Spawn point: <b>{spawn ? spawn.name : 'Default (Solano Plaza)'}</b>{d.spawn && <button type="button" className="wb-link" onClick={() => void act.run('spawn', () => webApi.setSpawn(null).then((r) => { take(r); return r; }), () => 'Spawn reset to the default.')}>Reset</button>}</p>
            </section>
            <div className="wb-chips" role="tablist">
              {([['all', 'All'], ['mine', 'Owned'], ['safehouse', 'Safehouses'], ['garage', 'Garages'], ['business', 'Businesses']] as const).map(([id, label]) => (
                <button key={id} type="button" role="tab" aria-selected={filter === id} className={filter === id ? 'on' : ''} onClick={() => setFilter(id)}>{label}</button>
              ))}
            </div>
            <Flash msg={act.msg} />
            {list.length === 0 && <p className="wb-note">Nothing here yet. Browse all listings.</p>}
            {list.map((p) => {
              const buyWhy = p.owned ? 'You already own this' : cash < p.price ? `You need ${money(p.price - cash)} more` : undefined;
              const collectWhy = !p.canCollect ? (p.nextCollectAt ? `Ready in ${fmtIn(p.nextCollectAt, now)}` : 'Not available') : undefined;
              return (
                <article key={p.id} className={`wb-card ${p.owned ? 'owned' : ''}`}>
                  <div className="wb-row"><span className={`wb-badge k-${p.kind}`}>{KIND_LABEL[p.kind]}</span>{p.owned && <span className="wb-badge own">Owned</span>}</div>
                  <h3>{p.name}</h3>
                  <p className="wb-area">{p.area} · {Math.round(p.pos[0])}, {Math.round(p.pos[1])}</p>
                  <p>{p.blurb}</p>
                  <Perks p={p} />
                  <div className="wb-row">
                    <b className="wb-price">{money(p.price)}</b>
                    <button type="button" className="wb-link" onClick={() => setWaypoint({ x: p.pos[0], z: p.pos[1] })}>Show on map</button>
                  </div>
                  {!p.owned && <ConfirmBtn label={`Buy for ${money(p.price)}`} confirmLabel={`Confirm ${money(p.price)}`} disabled={!!buyWhy} why={buyWhy} busy={act.busy === `buy${p.id}`}
                    onConfirm={() => void act.run(`buy${p.id}`, () => webApi.buyProperty(p.id).then((r) => { take(r); return r; }), () => `${p.name} is yours.`)} />}
                  {p.owned && p.perks.dailyIncome ? <WBtn disabled={!p.canCollect} why={collectWhy} busy={act.busy === `col${p.id}`}
                    onClick={() => void act.run(`col${p.id}`, () => webApi.collectProperty(p.id).then((r) => { take(r); return r; }), (r) => `Collected ${money(r.amount)} from ${p.name}.`)}>Collect {money(p.perks.dailyIncome)}</WBtn> : null}
                  {p.owned && p.perks.spawn ? <WBtn kind="ghost" disabled={d.spawn === p.id} why="Already your spawn point" busy={act.busy === 'spawn'}
                    onClick={() => void act.run('spawn', () => webApi.setSpawn(p.id).then((r) => { take(r); return r; }), () => `You will spawn at ${p.name}.`)}>{d.spawn === p.id ? 'Your spawn point' : 'Use as spawn point'}</WBtn> : null}
                </article>
              );
            })}
            <footer className="wb-foot">Income can be collected once every {d.cooldownHours} hours per property. Garage slots raise your vehicle limit from {d.baseSlots}.</footer>
          </>
        );
      }}</LoadGate>
    </div>
  );
}

/** Bullseye Arms Online: weapon catalogue (in-store purchase only) and remote ammo orders at a delivery premium. */
import { useMemo } from 'react';
import { WEAPONS, WEAPON_ORDER, poiCenter, worldText } from '@blockshore/shared';
import { webApi } from '../../net/api';
import { useGame } from '../../state/store';
import { setWaypoint } from '../waypoint';
import { money } from '../util';
import { ConfirmBtn, Flash, LoadGate, StatBar, WBtn, useAction, useLoad, type SiteProps } from './common';

export function ArmsSite(_: SiteProps) {
  const load = useLoad(() => webApi.arms());
  const cash = useGame((s) => s.profile?.cash ?? 0);
  const act = useAction();
  const store = poiCenter('gunstore');
  const list = useMemo(() => [...WEAPON_ORDER.filter((id) => WEAPONS[id]), ...Object.keys(WEAPONS).filter((id) => !WEAPON_ORDER.includes(id))], []);
  const max = useMemo(() => {
    const all = Object.values(WEAPONS).filter((w) => !w.stun);
    const m = (f: (w: (typeof all)[number]) => number) => Math.max(...all.map(f));
    return { dmg: m((w) => w.damage * w.pellets), rate: m((w) => w.rate), range: m((w) => w.range), mag: m((w) => w.mag) };
  }, []);

  return (
    <div className="web wb-arms">
      <header className="wb-hero">
        <span className="wb-kicker">{worldText('Licensed dealer · Port Solano')}</span>
        <h1>BULLSEYE ARMS</h1>
        <p>Browse the catalogue from anywhere. Weapons are handed over in person. Ammo can be delivered.</p>
      </header>
      <LoadGate load={load}>{(d) => (
        <>
          <Flash msg={act.msg} />
          {list.map((id) => {
            const w = WEAPONS[id];
            const owned = id === 'stun' || id in d.owned;
            const have = id === 'stun' ? 999 : d.owned[id] ?? 0;
            const price = Math.ceil(w.ammoPrice * d.premium);
            const why = id === 'stun' ? 'Stun pistols use rechargeable cells' : !owned ? 'Buy this weapon in the store first' : have >= w.maxAmmo ? 'You cannot carry more ammo' : cash < price ? `You need ${money(price - cash)} more` : undefined;
            return (
              <article key={id} className="wb-card">
                <div className="wb-row"><h3>{w.name}</h3><b className="wb-price">{w.stun ? 'Free' : money(w.price)}</b></div>
                <p>{w.desc}</p>
                <div className="wb-stats">
                  <StatBar label="Damage" value={w.damage * w.pellets} max={max.dmg} text={w.stun ? 'stun' : `${w.damage}${w.pellets > 1 ? ` x${w.pellets}` : ''}`} />
                  <StatBar label="Fire rate" value={w.rate} max={max.rate} text={`${w.rate}/s`} />
                  <StatBar label="Range" value={w.range} max={max.range} text={`${w.range} m`} />
                  <StatBar label="Magazine" value={w.mag} max={max.mag} />
                  <StatBar label="Accuracy" value={Math.max(0.02, 0.12 - w.spread)} max={0.12} text={`${Math.round(Math.max(0, 1 - w.spread / 0.12) * 100)}%`} />
                </div>
                {id !== 'stun' && (
                  <div className="wb-ammo">
                    <small>Ammo pack: {w.ammoPack} rounds · shelf {money(w.ammoPrice)} · delivered {money(price)} (+{Math.round((d.premium - 1) * 100)}%)</small>
                    {owned && <small>You carry <b>{have}</b> / {w.maxAmmo}</small>}
                    <ConfirmBtn label={`Order ${w.ammoPack} rounds · ${money(price)}`} confirmLabel={`Confirm ${money(price)}`} disabled={!!why} why={why} busy={act.busy === id}
                      onConfirm={() => void act.run(id, () => webApi.orderAmmo(id).then((r) => { load.patch((x) => ({ ...x, cash: r.cash, owned: { ...x.owned, [id]: r.ammo } })); return r; }), (r) => `+${r.added} rounds delivered for ${money(r.price)}.`)} />
                  </div>
                )}
                {!owned && (
                  <div className="wb-visit"><small>In-store purchase only: visit Bullseye Arms in {worldText('Port Solano')} ({Math.round(store[0])}, {Math.round(store[1])}).</small>
                    <WBtn kind="ghost" small onClick={() => setWaypoint({ x: store[0], z: store[1] })}>Set waypoint to the store</WBtn></div>
                )}
              </article>
            );
          })}
          <footer className="wb-foot">Ammo orders arrive instantly. Bullseye Arms is not responsible for what you do with them. Please be responsible.</footer>
        </>
      )}</LoadGate>
    </div>
  );
}

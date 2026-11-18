/** Sunline Motors Online: every dealer model with stat bars, paint choice and a server-validated purchase. */
import { useMemo, useState, type ReactNode } from 'react';
import { DEALER_MODELS, PAINT_COLORS, VEHICLES, type VehicleModel } from '@blockshore/shared';
import { webApi } from '../../net/api';
import { useGame } from '../../state/store';
import { hex, money } from '../util';
import { ConfirmBtn, Flash, LoadGate, StatBar, useAction, useLoad, type SiteProps } from './common';

export function VehicleArt({ model, color }: { model: string; color: number }) {
  const def = VEHICLES[model as VehicleModel];
  const c = hex(color);
  const wheel = (x: number, y = 44) => <g key={x}><circle cx={x} cy={y} r="7" fill="#15151c" /><circle cx={x} cy={y} r="3" fill="#aab" /></g>;
  let body: ReactNode;
  if (def?.boat) body = <><path d="M6 34h108l-14 14H22z" fill={c} /><path d="M40 34l8-14h26l10 14z" fill="#f4f7fa" /><path d="M52 32l5-9h14l6 9z" fill="#7fc6e8" /><path d="M2 50q10 5 20 0t20 0 20 0 20 0 20 0" stroke="#8fd3ff" strokeWidth="2.5" fill="none" /></>;
  else if (def?.bike) body = <><path d="M30 42l20-16h14l10 8h14" stroke={c} strokeWidth="6" fill="none" strokeLinecap="round" /><path d="M54 24h16l4 6H52z" fill="#15151c" /><path d="M86 34l10-12" stroke="#15151c" strokeWidth="3" />{wheel(32, 42)}{wheel(92, 42)}</>;
  else if (model === 'pickup') body = <><path d="M8 40V28h42l8-12h22l10 12h14q8 2 8 12z" fill={c} /><path d="M62 18h14l8 9H58z" fill="#7fc6e8" /><path d="M8 28h38v6H8z" fill="#0003" />{wheel(30)}{wheel(92)}</>;
  else if (model === 'van') body = <><path d="M8 42V14h66l22 14h16v14z" fill={c} /><path d="M80 18l14 10H80z" fill="#7fc6e8" /><path d="M14 20h56v8H14z" fill="#fff4" />{wheel(30)}{wheel(92)}</>;
  else if (model === 'sports') body = <><path d="M6 42l8-10 28-8 22-4h14l14 10 24 4v8z" fill={c} /><path d="M52 22l10-4h10l12 10H46z" fill="#7fc6e8" /><path d="M10 36h100" stroke="#fff6" strokeWidth="2" />{wheel(30)}{wheel(92)}</>;
  else body = <><path d="M8 42V34l10-10 14-8h40l16 12 18 4q6 2 6 8v2z" fill={c} /><path d="M38 20h34l12 12H34z" fill="#7fc6e8" /><path d="M10 38h104" stroke="#0003" strokeWidth="2" />{wheel(30)}{wheel(92)}</>;
  return <svg className="wb-vart" viewBox="0 0 120 56" role="img" aria-label={def?.name ?? model}><ellipse cx="60" cy="52" rx="48" ry="3" fill="#0003" />{body}</svg>;
}

const KINDS: { id: 'all' | 'car' | 'bike' | 'boat'; label: string }[] = [{ id: 'all', label: 'All' }, { id: 'car', label: 'Cars & trucks' }, { id: 'bike', label: 'Bikes' }, { id: 'boat', label: 'Boats' }];
const kindOf = (m: VehicleModel) => (VEHICLES[m].boat ? 'boat' : VEHICLES[m].bike ? 'bike' : 'car');

export function SunlineSite(_: SiteProps) {
  const load = useLoad(() => webApi.dealer());
  const cash = useGame((s) => s.profile?.cash ?? 0);
  const act = useAction();
  const [kind, setKind] = useState<'all' | 'car' | 'bike' | 'boat'>('all');
  const [picked, setPicked] = useState<Record<string, number>>({});
  // normalise bars against the best value among every vehicle, so new models scale automatically
  const max = useMemo(() => {
    const all = Object.values(VEHICLES).filter((v) => v.price > 0);
    const m = (f: (v: (typeof all)[number]) => number) => Math.max(...all.map(f));
    return { speed: m((v) => v.maxSpeed), accel: m((v) => v.accel), turn: m((v) => v.turn), brake: m((v) => v.brake), health: m((v) => v.health) };
  }, []);

  return (
    <div className="web wb-sunline">
      <header className="wb-hero">
        <span className="wb-kicker">Palmara's friendliest showroom</span>
        <h1>Sunline <em>Motors</em> Online</h1>
        <p>Pick it. Paint it. It's in your garage before the coffee cools. No haggling, no salesman named Chip.</p>
      </header>
      <LoadGate load={load}>{(d) => {
        const full = d.garage.used >= d.garage.cap;
        const models = (d.models.length ? d.models.map((m) => m.model as VehicleModel) : DEALER_MODELS).filter((m) => VEHICLES[m]);
        return (
          <>
            <div className="wb-strip"><span>Wallet <b>{money(cash)}</b></span><span>Garage <b>{d.garage.used}/{d.garage.cap}</b></span></div>
            <div className="wb-chips" role="tablist">{KINDS.map((k) => <button key={k.id} type="button" role="tab" aria-selected={kind === k.id} className={kind === k.id ? 'on' : ''} onClick={() => setKind(k.id)}>{k.label}</button>)}</div>
            <Flash msg={act.msg} />
            {models.filter((m) => kind === 'all' || kindOf(m) === kind).map((m) => {
              const v = VEHICLES[m];
              const price = d.models.find((x) => x.model === m)?.price ?? v.price;
              const colors = d.colors.length ? d.colors : PAINT_COLORS;
              const color = picked[m] ?? colors[0];
              const why = full ? `Your garage is full (${d.garage.cap}). Buy a garage on Palmara Realty.` : cash < price ? `You need ${money(price - cash)} more` : undefined;
              return (
                <article key={m} className="wb-card">
                  <VehicleArt model={m} color={color} />
                  <div className="wb-row"><h3>{v.name}</h3><b className="wb-price">{money(price)}</b></div>
                  <div className="wb-stats">
                    <StatBar label="Speed" value={v.maxSpeed} max={max.speed} text={`${Math.round(v.maxSpeed * 3.6)} km/h`} />
                    <StatBar label="Accel" value={v.accel} max={max.accel} />
                    <StatBar label="Handling" value={v.turn} max={max.turn} text={v.turn.toFixed(1)} />
                    <StatBar label="Braking" value={v.brake} max={max.brake} />
                    <StatBar label="Toughness" value={v.health} max={max.health} />
                  </div>
                  <div className="wb-meta"><span>{v.seats} seat{v.seats > 1 ? 's' : ''}</span><span>{v.boat ? 'Water' : v.bike ? 'Two wheels' : 'Road'}</span></div>
                  <div className="wb-swatches" role="radiogroup" aria-label={`${v.name} colour`}>
                    {colors.map((c) => <button key={c} type="button" role="radio" aria-checked={c === color} aria-label={`Colour ${hex(c)}`} className={c === color ? 'on' : ''} style={{ background: hex(c) }} onClick={() => setPicked((p) => ({ ...p, [m]: c }))} />)}
                  </div>
                  <ConfirmBtn label={`Buy for ${money(price)}`} confirmLabel={`Confirm ${money(price)}`} disabled={!!why} why={why} busy={act.busy === m}
                    onConfirm={() => void act.run(m, () => webApi.buyVehicle(m, color), (r) => { load.patch((x) => ({ ...x, cash: r.cash, garage: r.garage })); return `${v.name} delivered to your garage.`; })} />
                </article>
              );
            })}
            <footer className="wb-foot">Prices include delivery to your garage. Vehicles are collected from the Garage app on your phone.</footer>
          </>
        );
      }}</LoadGate>
    </div>
  );
}

import { useMemo, useState } from 'react';
import { DEALER_MODELS, PAINT_COLORS, PAINT_PRICE, VEHICLES, type VehicleModel } from '@blockshore/shared';
import { useGame } from '../../state/store';
import { buy, garage, closeOverlay } from '../../state/actions';
import { Modal, Btn, Tag, Tabs, Empty, Bar } from '../components';
import { Icon } from '../Icons';
import { hex, money } from '../util';

function CashChip() {
  const cash = useGame((s) => s.profile?.cash ?? 0);
  return <Tag tone="sun" icon="coin">{money(cash)}</Tag>;
}

function GenericShop({ leaving }: { leaving: boolean }) {
  const shop = useGame((s) => s.shop)!;
  const cash = useGame((s) => s.profile?.cash ?? 0);
  const cats = useMemo(() => [...new Set(shop.items.map((i) => i.category ?? 'Items'))], [shop]);
  const [cat, setCat] = useState<string>(cats[0] ?? 'Items');
  const items = shop.items.filter((i) => (i.category ?? 'Items') === cat);
  return (
    <Modal title={shop.name} icon="cart" leaving={leaving} accent="sun" subtitle="Browse and buy. Prices are final." footer={<><CashChip /><span className="grow" /><Btn variant="ghost" onClick={closeOverlay}>Leave shop</Btn></>}>
      {cats.length > 1 && <Tabs value={cat} onChange={setCat} tabs={cats.map((c) => ({ id: c, label: c }))} />}
      {items.length === 0 ? <Empty icon="cart">Nothing for sale right now.</Empty> : (
        <div className="shop-grid">
          {items.map((it) => {
            const poor = cash < it.price && !it.have;
            // barber colours: owned = the one you are wearing; bought-but-not-worn ones switch for free
            const why = it.owned ? (it.have !== undefined ? 'You are wearing this' : 'You already own this') : it.disabled ?? (poor ? `You need ${money(it.price - cash)} more` : undefined);
            return (
              <div key={it.id} className={`shop-card ${it.owned ? 'owned' : ''}`}>
                <div className="sc-top">
                  {it.color != null ? <span className="swatch big" style={{ background: hex(it.color) }} /> : <span className="sc-ico"><Icon name="cart" size={22} /></span>}
                  {it.owned && <Tag tone="green" icon="check">{it.have !== undefined ? 'Selected' : 'Owned'}</Tag>}
                  {!it.owned && it.have && <Tag tone="grey" icon="check">Owned</Tag>}
                </div>
                <b>{it.name}</b>
                <p>{it.desc}</p>
                <div className="sc-foot"><span className="price mono">{it.price === 0 || it.have ? 'Free' : money(it.price)}</span>
                  <Btn size="sm" variant="sun" disabled={!!why} why={why} onClick={() => buy(shop.shop, it.id)}>{it.owned ? (it.have !== undefined ? 'Selected' : 'Owned') : it.have ? 'Wear' : 'Buy'}</Btn></div>
              </div>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

type GTab = 'mine' | 'repair' | 'dealer';

function GarageShop({ leaving }: { leaving: boolean }) {
  const shop = useGame((s) => s.shop)!;
  const profile = useGame((s) => s.profile);
  const wanted = useGame((s) => s.hud.wanted);
  const [tab, setTab] = useState<GTab>('mine');
  const cash = profile?.cash ?? 0;
  const vehicles = shop.vehicles ?? profile?.vehicles ?? [];
  const near = shop.nearbyVehicle;
  const [color, setColor] = useState<number>(PAINT_COLORS[0]);
  const nameOf = (m: string) => VEHICLES[m as VehicleModel]?.name ?? m;
  const nearDef = near ? VEHICLES[near.model as VehicleModel] : undefined;
  const nearMax = nearDef?.health ?? 100;
  const police = wanted > 0 ? 'Not while the police are after you' : undefined;
  return (
    <Modal title={shop.name || 'Torque & Tide Garage'} icon="wrench" leaving={leaving} wide accent="pink" subtitle="Dez keeps your rides running." footer={<><CashChip /><span className="grow" /><Btn variant="ghost" onClick={closeOverlay}>Leave garage</Btn></>}>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'mine', label: 'My vehicles', icon: 'car', badge: vehicles.length }, { id: 'repair', label: 'Repair & paint', icon: 'paint' }, { id: 'dealer', label: 'Dealer', icon: 'dollar' }]} />
      <div className="tab-pane" key={tab}>
        {tab === 'mine' && (vehicles.length === 0 ? <Empty icon="car">You do not own any vehicles. Check out the dealer.</Empty> : (
          <ul className="list vehicles">
            {vehicles.map((v) => {
              const def = VEHICLES[v.model as VehicleModel];
              return (
                <li key={v.id}>
                  <span className="swatch big" style={{ background: hex(v.color) }} />
                  <div className="grow">
                    <b>{nameOf(v.model)}</b>
                    <small>{v.state === 'stored' ? 'Stored in garage' : v.state === 'out' ? 'Out in the world' : 'Wrecked'}</small>
                    <Bar value={v.health} max={def?.health ?? 100} tone={v.health / (def?.health ?? 100) < 0.3 ? 'red' : 'aqua'} />
                  </div>
                  {v.state === 'stored' && <Btn size="sm" variant="aqua" icon="car" disabled={!!police} why={police} onClick={() => garage('spawn', { vehicle: v.id })}>Spawn</Btn>}
                  {v.state === 'out' && <Btn size="sm" variant="ghost" onClick={() => garage('store', { vehicle: v.id })}>Store</Btn>}
                  {v.state !== 'stored' && <Btn size="sm" variant="ghost" disabled={!!police} why={police} onClick={() => garage('deliver', { vehicle: v.id })}>Deliver</Btn>}
                </li>
              );
            })}
          </ul>
        ))}
        {tab === 'repair' && (
          !near ? <Empty icon="wrench">Park a vehicle next to the garage door to repair or repaint it.</Empty> : (
            <div className="repair-grid">
              <div className="glass rep-card">
                <h4>{nameOf(near.model)} {near.mine ? <Tag tone="green">Yours</Tag> : <Tag tone="grey">Not yours</Tag>}</h4>
                <Bar value={near.hp} max={nearMax} tone={near.hp / nearMax < 0.3 ? 'red' : 'aqua'} />
                <small className="muted">{Math.round(near.hp)} / {nearMax} hp</small>
                <Btn icon="wrench" disabled={!near.mine || near.repairCost <= 0 || cash < near.repairCost} why={!near.mine ? 'You can only repair your own vehicle' : near.repairCost <= 0 ? 'No damage to repair' : `You need ${money(near.repairCost - cash)} more`} onClick={() => garage('repair', { vehicle: near.id })}>
                  Repair · {money(near.repairCost)}
                </Btn>
              </div>
              <div className="glass rep-card">
                <h4>Paint job <small className="muted">{money(PAINT_PRICE)}</small></h4>
                <div className="swatches">
                  {PAINT_COLORS.map((c) => (
                    <button key={c} type="button" className={`sw ${color === c ? 'on' : ''}`} style={{ background: hex(c) }} aria-label={`Colour ${hex(c)}`} onClick={() => setColor(c)} />
                  ))}
                </div>
                <Btn variant="sun" icon="paint" disabled={!near.mine || cash < PAINT_PRICE} why={!near.mine ? 'You can only paint your own vehicle' : `You need ${money(PAINT_PRICE - cash)} more`} onClick={() => garage('paint', { vehicle: near.id, color })}>Apply paint</Btn>
              </div>
            </div>
          )
        )}
        {tab === 'dealer' && (
          <div className="dealer-grid">
            {DEALER_MODELS.map((m) => {
              const d = VEHICLES[m];
              const poor = cash < d.price;
              return (
                <div key={m} className="shop-card dealer">
                  <div className="sc-top"><span className="sc-ico"><Icon name={d.boat ? 'wifi' : 'car'} size={22} /></span><Tag tone="grey">{d.seats} seats</Tag></div>
                  <b>{d.name}</b>
                  <div className="stat"><small>Speed</small><Bar value={d.maxSpeed} max={50} tone="aqua" /></div>
                  <div className="stat"><small>Handling</small><Bar value={d.turn} max={3} tone="pink" /></div>
                  <div className="stat"><small>Toughness</small><Bar value={d.health} max={1600} tone="sun" /></div>
                  <div className="sc-foot"><span className="price mono">{money(d.price)}</span>
                    <Btn size="sm" variant="sun" disabled={poor} why={`You need ${money(d.price - cash)} more`} onClick={() => garage('buy', { model: m })}>Buy</Btn></div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}

export function Shop({ leaving }: { leaving: boolean }) {
  const shop = useGame((s) => s.shop);
  if (!shop) return <Modal title="Shop" icon="cart" leaving={leaving}><Empty icon="cart">Loading the shop…</Empty></Modal>;
  return shop.shop === 'garage' ? <GarageShop leaving={leaving} /> : <GenericShop leaving={leaving} />;
}

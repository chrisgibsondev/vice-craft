/** Threadline Online: outfit colours delivered straight to your wardrobe (maps onto the existing outfit colour). */
import { webApi } from '../../net/api';
import { syncOutfit } from '../../state/actions';
import { useGame } from '../../state/store';
import { hex, money } from '../util';
import { ConfirmBtn, Flash, LoadGate, useAction, useLoad, type SiteProps } from './common';

function Shirt({ color }: { color: number }) {
  return <svg className="wb-shirt" viewBox="0 0 64 64" aria-hidden="true"><path d="M20 8l-14 8 6 12 8-4v30h24V24l8 4 6-12-14-8q-4 6-12 6t-12-6z" fill={hex(color)} stroke="#0002" strokeWidth="1.5" /></svg>;
}

export function ThreadlineSite(_: SiteProps) {
  const load = useLoad(() => webApi.style());
  const cash = useGame((s) => s.profile?.cash ?? 0);
  const outfit = useGame((s) => s.profile?.outfit);
  const act = useAction();

  return (
    <div className="web wb-thread">
      <header className="wb-hero">
        <h1>thread<span>line</span></h1>
        <p>Boutique colours, delivered to your wardrobe. Hair stays in the chair at Fade Away Barbers.</p>
      </header>
      <LoadGate load={load}>{(d) => {
        const wearing = outfit ?? d.outfit;
        const cats = [...new Set(d.items.map((i) => i.category))];
        return (
          <>
            <div className="wb-strip"><span>Wearing <Shirt color={wearing} /></span><span>Wallet <b>{money(cash)}</b></span></div>
            <Flash msg={act.msg} />
            {cats.map((c) => (
              <section key={c}>
                <h2 className="wb-h2">{c}</h2>
                <div className="wb-tiles">
                  {d.items.filter((i) => i.category === c).map((i) => {
                    const on = wearing === i.color;
                    const why = on ? 'You are wearing this' : cash < i.price ? `You need ${money(i.price - cash)} more` : undefined;
                    return (
                      <article key={i.id} className={`wb-tile ${on ? 'on' : ''}`}>
                        <Shirt color={i.color} />
                        <b>{i.name}</b>
                        <small>{i.desc}</small>
                        <span className="wb-price">{money(i.price)}</span>
                        <ConfirmBtn small label={on ? 'Wearing' : 'Wear it'} confirmLabel="Confirm" disabled={!!why} why={why} busy={act.busy === i.id}
                          onConfirm={() => void act.run(i.id, () => webApi.buyStyle(i.id), (r) => { syncOutfit(r.outfit); load.patch((x) => ({ ...x, cash: r.cash, outfit: r.outfit })); return `${i.name} is in your wardrobe and on your back.`; })} />
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </>
        );
      }}</LoadGate>
    </div>
  );
}

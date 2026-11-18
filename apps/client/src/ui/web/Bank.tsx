/** First Coral Bank: balance, the last 30 ledger entries and friend-to-friend transfers with a confirmation step. */
import { useEffect, useState } from 'react';
import { VEHICLES, WEAPONS, type VehicleModel } from '@blockshore/shared';
import { webApi, type WebQuote } from '../../net/api';
import { useGame } from '../../state/store';
import { money } from '../util';
import { openOverlay } from '../../state/actions';
import { Flash, LoadGate, WBtn, errText, fmtAgo, useAction, useLoad, type SiteProps } from './common';

export function prettyReason(r: string): string {
  if (r === 'starting cash') return 'Welcome deposit';
  if (r === 'activity reward') return 'Job payout';
  if (r === 'vehicle delivery') return 'Vehicle delivery fee';
  if (r.startsWith('transfer to ')) return `Sent to ${r.slice(12)}`;
  if (r.startsWith('transfer from ')) return `Received from ${r.slice(14)}`;
  if (r.startsWith('buy property ')) return `Property purchase (${r.slice(13).replace(/_/g, ' ')})`;
  if (r.startsWith('property income ')) return `Rental income (${r.slice(16).replace(/_/g, ' ')})`;
  if (r.startsWith('web ammo ')) return `Ammo delivery (${WEAPONS[r.slice(9)]?.name ?? r.slice(9)})`;
  if (r.startsWith('web buy ')) return `Threadline order (${r.slice(8).replace(/^tl_/, '')})`;
  const m = /^buy (\w+)$/.exec(r);
  if (m) return VEHICLES[m[1] as VehicleModel] ? `Vehicle: ${VEHICLES[m[1] as VehicleModel].name}` : `Purchase: ${m[1].replace(/[:_]/g, ' ')}`;
  return r.charAt(0).toUpperCase() + r.slice(1);
}

export function BankSite(_: SiteProps) {
  const load = useLoad(() => webApi.bank());
  const cash = useGame((s) => s.profile?.cash ?? 0);
  const act = useAction();
  const [tab, setTab] = useState<'activity' | 'send'>('activity');
  const [to, setTo] = useState<string | null>(null);
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<WebQuote | null>(null);
  const [left, setLeft] = useState(0);

  useEffect(() => {
    if (!quote) return;
    const t = setInterval(() => { const s = Math.max(0, Math.round((quote.expires - Date.now()) / 1000)); setLeft(s); if (s === 0) setQuote(null); }, 500);
    setLeft(Math.round((quote.expires - Date.now()) / 1000));
    return () => clearInterval(t);
  }, [quote]);

  return (
    <div className="web wb-bank">
      <header className="wb-hero">
        <span className="wb-kicker">First Coral Bank · Member of the Reef Deposit Scheme</span>
        <h1>Banking, but sunnier</h1>
        <div className="wb-balance"><small>Available balance</small><b>{money(cash)}</b></div>
      </header>
      <div className="wb-chips" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'activity'} className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}>Activity</button>
        <button type="button" role="tab" aria-selected={tab === 'send'} className={tab === 'send' ? 'on' : ''} onClick={() => setTab('send')}>Send money</button>
      </div>
      <Flash msg={act.msg} />
      <LoadGate load={load}>{(d) => (
        tab === 'activity' ? (
          <section>
            <h2 className="wb-h2">Last {d.ledger.length} transactions</h2>
            <ul className="wb-ledger">
              {d.ledger.map((r) => (
                <li key={r.id}>
                  <span className="grow"><b>{prettyReason(r.reason)}</b><small>{fmtAgo(r.at)}</small></span>
                  <span className="amt"><b className={r.amount >= 0 ? 'pos' : 'neg'}>{r.amount >= 0 ? '+' : '-'}{money(Math.abs(r.amount))}</b><small>{money(r.balance)}</small></span>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <section>
            {quote ? (
              <div className="wb-confirm" role="alertdialog" aria-label="Confirm transfer">
                <h2 className="wb-h2">Please confirm</h2>
                <dl>
                  <dt>Send to</dt><dd>{quote.to.name}</dd>
                  <dt>Amount</dt><dd>{money(quote.amount)}</dd>
                  <dt>Balance after</dt><dd>{money(quote.cashAfter)}</dd>
                  <dt>Left to send today</dt><dd>{money(quote.remainingToday)}</dd>
                </dl>
                <p className="wb-note">Transfers cannot be undone. Expires in {left}s.</p>
                <div className="wb-row">
                  <WBtn busy={act.busy === 'send'} onClick={() => void act.run('send', () => webApi.bankTransfer(quote.token), (r) => `Sent ${money(r.sent)} to ${r.to}.`).then((r) => { if (r) { setQuote(null); setAmount(''); load.reload(); } else setQuote(null); })}>Confirm and send</WBtn>
                  <WBtn kind="ghost" onClick={() => setQuote(null)}>Cancel</WBtn>
                </div>
              </div>
            ) : (
              <>
                <h2 className="wb-h2">Friends</h2>
                {d.friends.length === 0 && <p className="wb-note">You can only send money to friends. Add some from the Social app.</p>}
                <ul className="wb-friends">
                  {d.friends.map((f) => <li key={f.id}><button type="button" className={to === f.id ? 'on' : ''} aria-pressed={to === f.id} onClick={() => setTo(f.id)}>{f.name}</button></li>)}
                </ul>
                {d.friends.length === 0 && <WBtn kind="ghost" onClick={() => openOverlay('social')}>Open friends</WBtn>}
                <label className="wb-field"><span>Amount ({money(d.limits.min)} to {money(d.limits.max)})</span>
                  <input type="text" inputMode="numeric" value={amount} placeholder="0" aria-label="Amount" onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, '').slice(0, 6))} />
                </label>
                <div className="wb-presets">{[100, 500, 1000, 5000].map((n) => <button key={n} type="button" onClick={() => setAmount(String(n))}>{money(n)}</button>)}</div>
                <div className="wb-limit"><i style={{ width: `${Math.min(100, (d.limits.sentToday / d.limits.dailyCap) * 100)}%` }} /></div>
                <small className="wb-note">Daily limit {money(d.limits.sentToday)} / {money(d.limits.dailyCap)} used</small>
                {(() => {
                  const n = parseInt(amount || '0', 10);
                  const why = !to ? 'Pick a friend first' : n < d.limits.min ? `Minimum transfer is ${money(d.limits.min)}` : n > d.limits.max ? `Maximum per transfer is ${money(d.limits.max)}` : n > cash ? 'Not enough cash' : n > d.limits.remaining ? `Only ${money(d.limits.remaining)} left of today's limit` : undefined;
                  return <WBtn disabled={!!why} why={why} busy={act.busy === 'quote'} onClick={() => { act.clear(); void webApi.bankQuote(to!, n).then(setQuote).catch((e) => void act.run('x', () => Promise.reject(e), () => errText(e))); }}>Review transfer</WBtn>;
                })()}
              </>
            )}
          </section>
        )
      )}</LoadGate>
      <footer className="wb-foot">First Coral Bank will never ask for your password. We will ask for your cash, politely.</footer>
    </div>
  );
}

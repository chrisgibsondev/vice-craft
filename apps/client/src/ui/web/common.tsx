/** Shared building blocks for the in-game websites. Each site supplies its own CSS theme (see styles-overlays.css, `.wb-*`). */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../../net/api';
import { syncCash } from '../../state/actions';
import { Icon } from '../Icons';

export type Navigate = (url: string) => void;
export interface SiteProps { nav: Navigate }

export function errText(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

/** Load data from the server; `reload()` refetches, `setData` patches from a mutation response. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [st, setSt] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn); fnRef.current = fn;
  useEffect(() => {
    let dead = false;
    setSt((s) => ({ ...s, loading: true, error: null }));
    fnRef.current().then((data) => { if (!dead) setSt({ data, error: null, loading: false }); }).catch((e) => { if (!dead) setSt({ data: null, error: errText(e), loading: false }); });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, ...deps]);
  return { ...st, reload: () => setTick((t) => t + 1), patch: (f: (d: T) => T) => setSt((s) => (s.data ? { ...s, data: f(s.data) } : s)) };
}

export function Skeleton({ rows = 3, tall = false }: { rows?: number; tall?: boolean }) {
  return <div className="wb-skel" aria-busy="true" aria-label="Loading">{Array.from({ length: rows }, (_, i) => <i key={i} className={tall && i === 0 ? 'tall' : ''} style={{ width: `${100 - ((i * 17) % 40)}%` }} />)}</div>;
}

export function LoadGate<T>({ load, children, rows = 4 }: { load: { data: T | null; error: string | null; loading: boolean; reload: () => void }; children: (d: T) => ReactNode; rows?: number }) {
  if (load.error) return <div className="wb-err"><Icon name="info" size={18} /><p>{load.error}</p><button type="button" className="wb-btn ghost" onClick={load.reload}>Try again</button></div>;
  if (!load.data) return <Skeleton rows={rows} tall />;
  return <>{children(load.data)}</>;
}

/** Runs a server action with a busy flag and a success / error message. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function run<R extends { cash?: number }>(key: string, fn: () => Promise<R>, okText: (r: R) => string): Promise<R | null> {
    if (busy) return null;
    setBusy(key); setMsg(null);
    try {
      const r = await fn();
      if (typeof r.cash === 'number') syncCash(r.cash);
      setMsg({ ok: true, text: okText(r) });
      return r;
    } catch (e) { setMsg({ ok: false, text: errText(e) }); return null; }
    finally { setBusy(null); clearTimeout(timer.current); timer.current = setTimeout(() => setMsg(null), 6000); }
  }
  return { busy, msg, run, clear: () => setMsg(null) };
}

export function Flash({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <div className={`wb-flash ${msg.ok ? 'ok' : 'bad'}`} role="status"><Icon name={msg.ok ? 'check' : 'info'} size={15} /><span>{msg.text}</span></div>;
}

/** Button that is either enabled or visibly disabled with the reason printed underneath. */
export function WBtn({ children, onClick, disabled, why, kind = 'solid', busy, small }: { children: ReactNode; onClick?: () => void; disabled?: boolean; why?: string; kind?: 'solid' | 'ghost' | 'alt'; busy?: boolean; small?: boolean }) {
  return (
    <span className="wb-btnwrap">
      <button type="button" className={`wb-btn ${kind} ${small ? 'sm' : ''}`} disabled={disabled || busy} onClick={onClick} title={disabled ? why : undefined}>{busy ? 'Working…' : children}</button>
      {disabled && why && <small className="wb-why">{why}</small>}
    </span>
  );
}

/** Two-step purchase button: first click arms, second click confirms (disarms after 4 s). */
export function ConfirmBtn({ label, confirmLabel, onConfirm, disabled, why, busy, kind, small }: { label: ReactNode; confirmLabel?: ReactNode; onConfirm: () => void; disabled?: boolean; why?: string; busy?: boolean; kind?: 'solid' | 'ghost' | 'alt'; small?: boolean }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 4000); return () => clearTimeout(t); }, [armed]);
  useEffect(() => { if (disabled) setArmed(false); }, [disabled]);
  return <WBtn kind={armed ? 'alt' : kind} small={small} disabled={disabled} why={why} busy={busy} onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}>{armed ? confirmLabel ?? 'Tap again to confirm' : label}</WBtn>;
}

export function StatBar({ label, value, max, text }: { label: string; value: number; max: number; text?: string }) {
  const p = max > 0 ? Math.max(4, Math.min(100, (value / max) * 100)) : 0;
  return <div className="wb-stat"><span>{label}</span><i><b style={{ width: `${p}%` }} /></i><em>{text ?? Math.round(value)}</em></div>;
}

export function fmtAgo(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
export function fmtIn(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} h ${m} min` : `${Math.max(1, m)} min`;
}

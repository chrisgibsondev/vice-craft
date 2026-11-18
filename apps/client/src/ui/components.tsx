import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon } from './Icons';
import { closeOverlay } from '../state/actions';

// ───────────────────────────────────────────────────────── buttons
export function Btn({
  children, onClick, variant = 'primary', icon, disabled, why, size = 'md', className = '', type = 'button', title, block, autoFocus,
}: {
  children?: ReactNode; onClick?: (e: React.MouseEvent) => void; variant?: 'primary' | 'aqua' | 'sun' | 'ghost' | 'danger';
  icon?: string; disabled?: boolean; why?: string; size?: 'sm' | 'md' | 'lg'; className?: string; type?: 'button' | 'submit'; title?: string; block?: boolean; autoFocus?: boolean;
}) {
  return (
    <span className={`btnwrap ${block ? 'block' : ''} ${disabled && why ? 'has-why' : ''}`} data-why={disabled ? why : undefined}>
      <button type={type} className={`btn ${variant} ${size} ${className}`} disabled={disabled} onClick={onClick} title={disabled ? why : title} autoFocus={autoFocus}>
        {icon && <Icon name={icon} size={size === 'sm' ? 15 : 18} />}
        {children !== undefined && <span>{children}</span>}
      </button>
    </span>
  );
}

export function IconBtn({ icon, onClick, title, disabled, className = '' }: { icon: string; onClick?: () => void; title: string; disabled?: boolean; className?: string }) {
  return <button type="button" className={`iconbtn ${className}`} onClick={onClick} title={title} aria-label={title} disabled={disabled}><Icon name={icon} size={18} /></button>;
}

// ───────────────────────────────────────────────────────── layout
export function Modal({
  title, icon, onClose = closeOverlay, leaving, wide, tall, children, footer, accent = 'pink', noClose, className = '', subtitle,
}: {
  title: string; icon?: string; onClose?: () => void; leaving?: boolean; wide?: boolean; tall?: boolean; children: ReactNode; footer?: ReactNode;
  accent?: 'pink' | 'aqua' | 'sun'; noClose?: boolean; className?: string; subtitle?: string;
}) {
  return (
    <div className={`scrim ${leaving ? 'out' : ''}`} onMouseDown={(e) => { if (e.target === e.currentTarget && !noClose) onClose(); }}>
      <section className={`modal accent-${accent} ${wide ? 'wide' : ''} ${tall ? 'tall' : ''} ${className}`} role="dialog" aria-label={title}>
        <header className="modal-head">
          {icon && <span className="modal-ico"><Icon name={icon} size={22} /></span>}
          <div className="modal-titles">
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {!noClose && <IconBtn icon="close" onClick={onClose} title="Close (Esc)" />}
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </section>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, className = '' }: { tabs: { id: T; label: string; icon?: string; badge?: number | string }[]; value: T; onChange: (t: T) => void; className?: string }) {
  return (
    <div className={`tabs ${className}`} role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={`tab ${value === t.id ? 'on' : ''}`} onClick={() => onChange(t.id)} type="button">
          {t.icon && <Icon name={t.icon} size={16} />}<span>{t.label}</span>
          {t.badge !== undefined && t.badge !== 0 && t.badge !== '' && <em className="tab-badge">{t.badge}</em>}
        </button>
      ))}
    </div>
  );
}

export function Seg<T extends string | number>({ options, value, onChange, disabled }: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map((o) => (
        <button key={String(o.id)} type="button" role="radio" aria-checked={value === o.id} disabled={disabled} className={value === o.id ? 'on' : ''} onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Toggle({ value, onChange, label, hint, disabled }: { value: boolean; onChange: (v: boolean) => void; label: string; hint?: string; disabled?: boolean }) {
  return (
    <label className={`row-setting toggle ${disabled ? 'dis' : ''}`}>
      <span className="rs-text"><b>{label}</b>{hint && <small>{hint}</small>}</span>
      <input type="checkbox" checked={value} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch" aria-hidden="true"><i /></span>
    </label>
  );
}

export function Slider({ label, value, min, max, step = 1, onChange, format, hint, onCommit, disabled }: {
  label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void; format?: (v: number) => string; hint?: string; onCommit?: (v: number) => void; disabled?: boolean;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <label className={`row-setting slider ${disabled ? 'dis' : ''}`}>
      <span className="rs-text"><b>{label}</b>{hint && <small>{hint}</small>}</span>
      <span className="slider-wrap">
        <input type="range" min={min} max={max} step={step} value={value} disabled={disabled}
          style={{ '--p': `${pct}%` } as CSSProperties}
          onChange={(e) => onChange(Number(e.target.value))}
          onPointerUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))}
          onKeyUp={(e) => onCommit?.(Number((e.target as HTMLInputElement).value))} />
        <output>{format ? format(value) : value}</output>
      </span>
    </label>
  );
}

export function Tag({ children, tone = 'neutral', icon, title }: { children: ReactNode; tone?: 'neutral' | 'pink' | 'aqua' | 'sun' | 'violet' | 'green' | 'red' | 'grey'; icon?: string; title?: string }) {
  return <span className={`tag tone-${tone}`} title={title}>{icon && <Icon name={icon} size={12} />}{children}</span>;
}

export function Spinner({ size = 28 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" role="status" />;
}

export function Bar({ value, max = 100, tone = 'pink', className = '' }: { value: number; max?: number; tone?: 'pink' | 'aqua' | 'sun' | 'red' | 'green'; className?: string }) {
  const p = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return <span className={`bar tone-${tone} ${className}`}><i style={{ width: `${p}%` }} /></span>;
}

export function Empty({ icon = 'info', children }: { icon?: string; children: ReactNode }) {
  return <div className="empty"><Icon name={icon} size={26} /><p>{children}</p></div>;
}

export function KeyCap({ children }: { children: ReactNode }) { return <kbd className="keycap">{children}</kbd>; }

export function Avatar({ name, color, size = 34, ring }: { name: string; color?: string; size?: number; ring?: string }) {
  const h = [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 360;
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.45, background: color ?? `linear-gradient(135deg,hsl(${h} 80% 60%),hsl(${(h + 50) % 360} 80% 45%))`, boxShadow: ring ? `0 0 0 2px ${ring}` : undefined }}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return <div className="sec-title"><h3>{children}</h3><span className="sec-line" />{right}</div>;
}

// ───────────────────────────────────────────────────────── hooks
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const id = setTimeout(() => setV(value), ms); return () => clearTimeout(id); }, [value, ms]);
  return v;
}

/** Counts a number up/down to its target for a lively display. */
export function useCountUp(target: number, ms = 700): number {
  const [v, setV] = useState(0);
  const from = useRef(0);
  useEffect(() => {
    const a = from.current, t0 = performance.now();
    let id = 0;
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      const e = 1 - Math.pow(1 - p, 3);
      const cur = a + (target - a) * e;
      setV(cur); from.current = cur;
      if (p < 1) id = requestAnimationFrame(step);
    };
    id = requestAnimationFrame(step);
    return () => cancelAnimationFrame(id);
  }, [target, ms]);
  return Math.round(v);
}

export function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, () => fallbackCopy(text));
  return Promise.resolve(fallbackCopy(text));
}
function fallbackCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

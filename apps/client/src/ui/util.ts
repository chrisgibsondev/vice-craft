import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getWaypoint, onWaypoint, type Waypoint } from './waypoint';

export const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
export const hex = (n: number) => `#${((n >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`;
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
export function fmtRace(ms: number): string {
  const t = Math.max(0, Math.round(ms));
  const m = Math.floor(t / 60000), s = Math.floor((t % 60000) / 1000), c = Math.floor((t % 1000) / 10);
  return `${m}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

/** Re-render every `ms` and return Date.now(). */
export function useNow(ms = 500): number {
  const [n, setN] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setN(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return n;
}

export function useWaypoint(): Waypoint | null {
  return useSyncExternalStore((cb) => onWaypoint(cb), getWaypoint);
}

/** Keeps the last non-null value mounted for `ms` after it becomes null so exit animations can play. */
export function useExit<T>(value: T | null, ms = 180): { shown: T | null; leaving: boolean } {
  const [shown, setShown] = useState<T | null>(value);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (value !== null && value !== undefined) { setShown(value); setLeaving(false); return; }
    setLeaving(true);
    const id = setTimeout(() => { setShown(null); setLeaving(false); }, ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return { shown: value ?? shown, leaving: value == null && leaving };
}

export function isTyping(el: Element | null = document.activeElement): boolean {
  if (!el) return false;
  const t = el.tagName;
  return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || (el as HTMLElement).isContentEditable;
}

/** Set while a key-capture control is listening, so global UI hotkeys stay out of the way. */
export const uiFlags = { capturing: false };

export function keyLabel(code: string): string {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num' + code.slice(6);
  const map: Record<string, string> = {
    Space: 'Space', ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl',
    AltLeft: 'L-Alt', AltRight: 'R-Alt', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Escape: 'Esc', Enter: 'Enter', Tab: 'Tab', Backspace: 'Bksp', Period: '.', Comma: ',', Slash: '/', Semicolon: ';',
    Quote: "'", BracketLeft: '[', BracketRight: ']', Backquote: '`', Minus: '-', Equal: '=', Backslash: '\\',
    Mouse0: 'LMB', Mouse1: 'MMB', Mouse2: 'RMB', Mouse3: 'M4', Mouse4: 'M5',
  };
  return map[code] ?? code;
}

export const ACTION_LABELS: Record<string, string> = {
  forward: 'Move forward', back: 'Move back', left: 'Move left', right: 'Move right', jump: 'Jump', sprint: 'Sprint',
  interact: 'Interact', vehicle: 'Enter / exit vehicle', handbrake: 'Handbrake', horn: 'Horn', camera: 'Switch camera',
  phone: 'Phone', map: 'Map', chat: 'Chat', party: 'Friends & party', heal: 'Use first-aid kit', ping: 'Ping location',
  skip: 'Skip cutscene', fire: 'Fire', aim: 'Aim', weaponNext: 'Next weapon', reload: 'Reload', menu: 'Pause menu', radio: 'Radio',
};

export function useRaf(cb: (t: number) => void, deps: unknown[] = []) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    let id = 0;
    const loop = (t: number) => { ref.current(t); id = requestAnimationFrame(loop); };
    id = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export const ZONE_COLORS: Record<string, string> = {
  none: '#2f6b3c', forest: '#1f5a36', farmland: '#7aa044', wetland: '#3f8a63', suburb: '#8fb06a',
  urban: '#a9a9b8', downtown: '#c4b8d8', industrial: '#8b8896', airport: '#b8bcc4', resort: '#e8b4a8',
};

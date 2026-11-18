/**
 * Keyboard/mouse input with remappable bindings, pointer lock handling and focus
 * loss safety (all keys released when the window loses focus).
 */
import { getState, setState } from '../state/store';

export class Input {
  private down = new Set<string>();
  private pressed = new Set<string>();
  private released = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  locked = false;
  /** pointer lock unavailable (embedded frames, browser policy): keyboard + right-drag mouse look instead */
  fallback = false;
  private dragging = false;
  /** while a radial menu is open, collect mouse movement even without pointer lock */
  captureAll = false;

  constructor(private canvas: HTMLCanvasElement) {
    window.addEventListener('keydown', (e) => {
      if (this.typing(e)) return;
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
      if ((this.locked || this.fallback) && ['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'Slash', 'Quote'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => { this.down.delete(e.code); this.released.add(e.code); });
    window.addEventListener('mousedown', (e) => {
      if (this.fallback && e.button === 2 && e.target === this.canvas) this.dragging = true;
      if (!this.locked && !(this.fallback && e.target === this.canvas)) return;
      const code = `Mouse${e.button}`;
      if (!this.down.has(code)) this.pressed.add(code);
      this.down.add(code);
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 2) this.dragging = false; const code = `Mouse${e.button}`; this.down.delete(code); this.released.add(code); });
    window.addEventListener('contextmenu', (e) => { if (this.locked || (this.fallback && e.target === this.canvas)) e.preventDefault(); });
    window.addEventListener('mousemove', (e) => {
      if (!this.locked && !(this.fallback && (this.dragging || this.captureAll))) return;
      // guard against the occasional huge spike some browsers emit when locking
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      this.mouseDX += e.movementX; this.mouseDY += e.movementY;
    });
    window.addEventListener('wheel', (e) => { if (this.locked || this.captureAll || (this.fallback && e.target === this.canvas)) this.wheel += Math.sign(e.deltaY); }, { passive: true });
    window.addEventListener('blur', () => this.releaseAll());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); });
    document.addEventListener('pointerlockchange', () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === this.canvas;
      setState({ pointerLocked: this.locked });
      if (!this.locked) this.releaseAll();
      // Escape (or focus loss) released the lock while playing → show the pause menu
      const s = getState();
      if (was && !this.locked && s.screen === 'game' && !s.overlay && !s.cutscene) setState({ overlay: 'pause' });
    });
    canvas.addEventListener('click', () => this.requestLock());
  }

  private typing(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  requestLock() {
    const s = getState();
    if (s.screen !== 'game' || s.overlay) return;
    if (this.fallback) { this.canvas.focus(); return; }
    const fail = () => {
      if (this.fallback) return;
      this.fallback = true;
      setState({ pointerLocked: true });
      import('../state/store').then((m) => m.pushNotice('Mouse capture is unavailable here — hold the RIGHT mouse button and drag to look around.', 'info'));
    };
    try { const r = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined; r?.catch?.(fail); } catch { fail(); }
  }

  releaseAll() { for (const k of this.down) this.released.add(k); this.down.clear(); }

  private code(action: string) { return getState().settings.keys[action] ?? ''; }
  /** gameplay keys only count while the pointer is locked and no overlay is open */
  private live() { const s = getState(); return (this.locked || this.fallback) && !s.overlay; }
  held(action: string) { return this.live() && this.down.has(this.code(action)); }
  tapped(action: string) { return this.live() && this.pressed.has(this.code(action)); }
  releasedAction(action: string) { return this.released.has(this.code(action)); }
  heldCode(code: string) { return this.live() && this.down.has(code); }
  tappedCode(code: string) { return this.live() && this.pressed.has(code); }

  /** call at the end of every frame */
  endFrame() { this.pressed.clear(); this.released.clear(); this.mouseDX = 0; this.mouseDY = 0; this.wheel = 0; }
}

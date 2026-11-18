/**
 * Boot: capability check → WebGL canvas (always running: title-screen flythrough or
 * the live game) → React UI overlay → resume session or show login.
 */
import { createRoot } from 'react-dom/client';
import App from './ui/App';
import { GameRenderer, QUALITY_PRESETS, webglSupport } from './render/renderer';
import { ClientGame } from './game/game';
import { getState, setState } from './state/store';
import { getToken } from './net/api';
import { afterAuth, autoLogin } from './state/actions';
import { ApiError, setToken } from './net/api';
import { finishXIfReturning } from './net/oauth';
import { audio } from './audio';
import { startPreview } from './preview';
import { net } from './net/connection';

const root = document.getElementById('root')!;

function unsupported(reason: string) {
  root.innerHTML = `
    <div style="position:fixed;inset:0;display:grid;place-items:center;background:#12092a;color:#fff;font-family:Inter,sans-serif;padding:24px">
      <div style="max-width:560px">
        <h1 style="font-family:Bungee,sans-serif;color:#ff4fa3;margin:0 0 12px">VICE CRAFT can't start</h1>
        <p style="line-height:1.6">${reason}</p>
        <p style="line-height:1.6;opacity:.85">VICE CRAFT needs a desktop browser with <b>WebGL 2</b>: current Chrome, Edge, Firefox or Safari 15+.
        Make sure hardware acceleration is enabled (Chrome: Settings → System → "Use graphics acceleration when available"), then reload.
        Phones and tablets are not supported yet.</p>
      </div>
    </div>`;
}

async function boot() {
  if (new URLSearchParams(location.search).has('preview')) { startPreview(root); return; }
  const sup = webglSupport();
  if (!sup.ok) { unsupported(sup.reason ?? 'WebGL 2 is unavailable.'); return; }

  const canvas = document.createElement('canvas');
  canvas.id = 'game-canvas';
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;display:block;z-index:0;outline:none';
  canvas.tabIndex = -1;
  document.body.appendChild(canvas);
  document.body.style.cssText = 'margin:0;overflow:hidden;background:#12092a';

  const s = getState().settings;
  const preset = QUALITY_PRESETS[s.quality];
  const renderer = new GameRenderer(canvas, { renderDistance: s.renderDistance, bloom: s.bloom, pixelRatio: preset.pixelRatio, fov: s.fov });
  const game = new ClientGame(renderer, canvas);
  game.start();
  (window as unknown as { __blockshore: unknown }).__blockshore = { game, renderer, getState, net };

  root.style.cssText = 'position:fixed;inset:0;z-index:1;pointer-events:none';
  createRoot(root).render(<App />);
  void audio.init();

  // no login: resume the saved session, otherwise the server assigns this network address its account
  // If the game server is asleep or restarting, show a loading bar and keep trying until it answers.
  const t0 = performance.now();
  const offline = (e: unknown) => e instanceof ApiError && (e.status === 0 || e.status >= 500 || e.status === 404);
  for (;;) {
    try {
      if (getToken()) {
        try { await afterAuth(); break; }
        catch (e) { if (offline(e)) throw e; setToken(null); /* expired session: fall through to a fresh one */ }
      }
      await autoLogin();
      break;
    } catch (e) {
      if (!offline(e)) { setState({ screen: 'login' }); break; }
      const secs = (performance.now() - t0) / 1000;
      setState({ screen: 'loading', loading: { progress: 0.95 * (1 - Math.exp(-secs / 25)), label: secs < 8 ? 'Loading the game…' : 'Starting the game world… this can take up to a minute.' } });
      await new Promise((r) => setTimeout(r, 2500));
    }
  }
  if (getState().screen === 'loading' && !getState().world) setState({ screen: 'menu', loading: null });
  await finishXIfReturning();
}

void boot();

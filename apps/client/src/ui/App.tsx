import { useEffect } from 'react';
import './styles.css';
import { getState, useGame } from '../state/store';
import { openOverlay, closeOverlay, skipCutscene, retryActivity, leaveActivity } from '../state/actions';
import type { Overlay } from '../state/types';
import { Boot, Login, Menu, Loading } from './screens/Screens';
import { Hud, Toasts, ConnBanner } from './hud/Hud';
import { CutsceneLayer } from './hud/Cutscene';
import { Pause, Worlds, ChatDock, Credits, Admin } from './overlays/Basic';
import { SettingsOverlay } from './overlays/Settings';
import { MapOverlay } from './overlays/MapOverlay';
import { Phone } from './overlays/Phone';
import { Social } from './overlays/Social';
import { Brief, Lobby, HeistBoard, Results } from './overlays/Activity';
import { Shop } from './overlays/Shop';
import { isTyping, uiFlags, useExit } from './util';

/** Overlays that may be dismissed with Escape. */
const ESC_CLOSABLE: Overlay[] = ['pause', 'phone', 'map', 'social', 'settings', 'shop', 'brief', 'lobby', 'heistboard', 'worlds', 'credits', 'admin', 'chat'];

function OverlayHost() {
  const overlay = useGame((s) => s.overlay);
  const { shown, leaving } = useExit<Overlay>(overlay, 190);
  if (!shown) return null;
  const p = { leaving };
  switch (shown) {
    case 'pause': return <Pause {...p} />;
    case 'phone': return <Phone {...p} />;
    case 'map': return <MapOverlay {...p} />;
    case 'social': return <Social {...p} />;
    case 'worlds': return <Worlds {...p} />;
    case 'brief': return <Brief {...p} />;
    case 'lobby': return <Lobby {...p} />;
    case 'heistboard': return <HeistBoard {...p} />;
    case 'shop': return <Shop {...p} />;
    case 'results': return <Results {...p} />;
    case 'settings': return <SettingsOverlay {...p} />;
    case 'credits': return <Credits {...p} />;
    case 'admin': return <Admin {...p} />;
    case 'chat': return <ChatDock {...p} />;
    default: return null;
  }
}

/** UI-level hotkeys only. Never handles movement keys. */
function useHotkeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (uiFlags.capturing || e.repeat && e.code !== 'Escape') return;
      const s = getState();
      const keys = s.settings.keys;
      const typing = isTyping();

      // cutscene: skip vote (only while one is active)
      if (s.cutscene && !typing && e.code === (keys.skip || 'Space') && s.screen === 'game' && !s.overlay) {
        e.preventDefault();
        if (!s.cutscene.voted) skipCutscene();
        return;
      }

      if (e.code === 'Escape') {
        if (typing) { (document.activeElement as HTMLElement | null)?.blur(); if (s.overlay !== 'chat') return; }
        if (s.overlay) {
          if (s.overlay === 'results') return;
          if (ESC_CLOSABLE.includes(s.overlay)) { e.preventDefault(); closeOverlay(); }
        } else if (s.screen === 'game') {
          e.preventDefault();
          openOverlay('pause');
        }
        return;
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;

      if (s.screen === 'game') {
        // failed-activity shortcuts (pointer is usually locked, so buttons can't be clicked)
        if (!s.overlay && s.activity?.phase === 'failed') {
          const leader = !s.party || s.party.leader === s.user?.id;
          if (e.code === 'Enter' && leader) { e.preventDefault(); retryActivity(); return; }
          if (e.code === 'KeyL') { e.preventDefault(); leaveActivity(); return; }
        }
        if (s.cutscene) return;
        if (!s.overlay) {
          const map: [string, Overlay][] = [[keys.map ?? 'KeyM', 'map'], [keys.party ?? 'KeyP', 'social'], [keys.chat ?? 'KeyT', 'chat'], [keys.phone ?? 'ArrowUp', 'phone']];
          for (const [code, ov] of map) if (e.code === code) { e.preventDefault(); openOverlay(ov); return; }
        } else if (s.overlay === 'map' && e.code === (keys.map ?? 'KeyM')) { e.preventDefault(); closeOverlay(); }
        else if (s.overlay === 'social' && e.code === (keys.party ?? 'KeyP')) { e.preventDefault(); closeOverlay(); }
        else if (s.overlay === 'phone' && e.code === (keys.phone ?? 'ArrowUp')) { e.preventDefault(); closeOverlay(); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export default function App() {
  const screen = useGame((s) => s.screen);
  const overlay = useGame((s) => s.overlay);
  const cutscene = useGame((s) => !!s.cutscene);
  useHotkeys();

  return (
    <div className={`bs-root screen-${screen} ${overlay ? 'has-overlay' : ''} ${cutscene ? 'in-cutscene' : ''}`} data-screen={screen}>
      {screen === 'boot' && <Boot />}
      {screen === 'login' && <Login />}
      {screen === 'menu' && <Menu />}
      {screen === 'loading' && <Loading />}
      {screen === 'game' && !cutscene && <Hud />}
      {screen === 'game' && cutscene && <CutsceneLayer />}
      <OverlayHost />
      <Toasts />
      <ConnBanner />
    </div>
  );
}

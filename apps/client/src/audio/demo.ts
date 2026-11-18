// Test page for the audio engine. Served at /audio-demo.html (see apps/client/audio-demo.html).
import { audio } from './index';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const on = (id: string, fn: () => void): void => $(id).addEventListener('click', fn);

// Listener at the origin facing -z, so the left/right horn buttons pan clearly.
audio.setListener(0, 0, 0, 0);
void audio.init();

on('unlock', () => audio.unlock());

on('m-menu', () => audio.playMusic('menu'));
on('m-roam', () => audio.playMusic('roam_1'));
on('m-heist', () => audio.playMusic('heist_action'));
on('m-stop', () => audio.playMusic(null));
on('x-race', () => audio.playMusic('race', { fade: 4 }));
on('x-chase', () => audio.playMusic('chase', { fade: 4 }));

on('duck-on', () => audio.duck(true));
on('duck-off', () => audio.duck(false));

let inVehicle = false;
const refreshRadio = (): void => {
  $('radio-name').textContent = audio.radio.current();
  $('radio-vehicle').textContent = inVehicle ? 'leave vehicle' : 'get in vehicle';
};
on('radio-vehicle', () => {
  inVehicle = !inVehicle;
  audio.radio.setInVehicle(inVehicle);
  refreshRadio();
});
on('radio-next', () => {
  audio.radio.next();
  refreshRadio();
});
on('radio-prev', () => {
  audio.radio.prev();
  refreshRadio();
});
refreshRadio();

on('sfx-left', () => audio.sfx('horn', { x: -6, y: 0, z: 0 }));
on('sfx-right', () => audio.sfx('horn', { x: 6, y: 0, z: 0 }));
on('step', () => audio.footstep('concrete', 0, 0, -2));
on('ui', () => audio.sfx('ui_click'));

// Engine loop: must be refreshed every frame, and stopped when no longer wanted.
let engineOn = false;
let pitch = 1;
$<HTMLInputElement>('rate').addEventListener('input', (e) => {
  pitch = Number((e.target as HTMLInputElement).value);
  $('rate-out').textContent = pitch.toFixed(2);
});
on('engine', () => {
  engineOn = !engineOn;
  $('engine').textContent = engineOn ? 'Engine: stop' : 'Engine: start';
});

const frame = (): void => {
  const keep = new Set<string>();
  if (engineOn) {
    audio.loop('engine', 'engine_car', { x: 0, y: 0, z: -8, rate: pitch, volume: 1 });
    keep.add('engine');
  }
  audio.stopLoopsExcept(keep);
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);

setInterval(() => {
  $('debug').textContent = JSON.stringify(audio.debug(), null, 2);
}, 300);

import { useGame } from '../../state/store';
import { skipCutscene } from '../../state/actions';
import { Spinner, Btn, KeyCap } from '../components';
import { Icon } from '../Icons';
import { Subtitles } from './Hud';
import { fmtClock, useNow, keyLabel } from '../util';

export function CutsceneLayer() {
  const cs = useGame((s) => s.cutscene);
  const skipKey = useGame((s) => s.settings.keys.skip ?? 'Space');
  const now = useNow(250);
  if (!cs) return null;
  const waiting = cs.phase === 'waiting';
  const left = Math.max(0, cs.deadline - now);
  return (
    <div className={`cutscene ${waiting ? 'waiting' : 'playing'}`}>
      <div className="lb top" /><div className="lb bottom" />
      {waiting && (
        <div className="cs-wait">
          <Spinner size={42} />
          <h3>Waiting for your crew</h3>
          <p className="cs-count"><b>{cs.loaded}</b> / {cs.total} ready{left > 0 ? <> · starts in {fmtClock(left)} at the latest</> : null}</p>
        </div>
      )}
      <Subtitles />
      <div className="cs-skip">
        <span className="cs-rule">{cs.skipRule}</span>
        <span className="cs-votes">
          <Icon name="users" size={14} /> {cs.votes}/{cs.needed} voted to skip
        </span>
        {cs.voted ? (
          <span className="cs-voted"><Icon name="check" size={14} /> You voted to skip</span>
        ) : (
          <Btn size="sm" variant="ghost" onClick={skipCutscene}>Skip <KeyCap>{keyLabel(skipKey)}</KeyCap></Btn>
        )}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { ACTIVITIES, ACTIVITY_BY_ID, CONTACTS, setupChoices, setupsDone, type Role, type HeistBoardView, type LobbyView } from '@blockshore/shared';
import { useGame } from '../../state/store';
import {
  closeOverlay, openLobby, openBrief, setReady, setRole, configureLobby, launchActivity, cancelLobby, leaveActivity, continueResults,
} from '../../state/actions';
import type { BriefView, ResultsView } from '../../state/types';
import { Modal, Btn, Tag, Avatar, SectionTitle, Empty, Seg, useCountUp } from '../components';
import { Icon } from '../Icons';
import { hex, money, fmtRace } from '../util';

const ELIG = {
  story: { tone: 'green' as const, label: 'Story progress counts', icon: 'check' },
  replay: { tone: 'sun' as const, label: 'Replay: reduced cash, no story progress', icon: 'flag' },
  ahead: { tone: 'red' as const, label: 'Ahead of your story: spoiler warning, no story progress', icon: 'info' },
};
const ROLE_INFO: Record<string, string> = {
  none: 'No special role', driver: 'Faster getaway car', hacker: 'Keypads, locks and safes 30% faster', muscle: '+50% health', lookout: 'Sees guards through walls',
};
const KIND_LABEL: Record<string, string> = { mission: 'Story mission', heist: 'Heist', heist_prep: 'Heist setup', minigame: 'Race / minigame' };
const CAT: Record<string, { icon: string; label: string }> = {
  scout: { icon: 'eye', label: 'Scouting' }, vehicle: { icon: 'car', label: 'Getaway' }, equipment: { icon: 'wrench', label: 'Equipment' },
  security: { icon: 'shield', label: 'Security' }, disguise: { icon: 'user', label: 'Disguise' }, escape: { icon: 'steering', label: 'Escape' },
};
const APPROACH_TONE: Record<string, 'aqua' | 'pink' | 'violet'> = { quiet: 'aqua', loud: 'pink', con: 'violet' };
const fmtSecs = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** brief payload extras sent for heists and setups (see apps/server/src/game.ts brief) */
type BriefExtra = Omit<BriefView, 'preps' | 'heist'> & {
  preps?: { id: string; name: string; done: boolean; optional?: boolean }[];
  heist?: BriefView['heist'] & {
    setups?: { id: string; name: string; optional: boolean; perk: string; category: string; done: boolean; choice?: { label: string; picked?: string } }[];
    elite?: { label: string; bonus: number }; firstTimeBonus?: number; hardMult?: number;
  };
  setupOf?: { heist: string; heistName: string; optional: boolean; perk: string; choice?: { key: string; label: string; options: { id: string; name: string; desc: string }[] } };
};

// ───────────────────────────────────────────── brief
export function Brief({ leaving }: { leaving: boolean }) {
  const brief = useGame((s) => s.brief) as unknown as BriefExtra | null;
  const user = useGame((s) => s.user);
  if (!brief) return <Modal title="Briefing" icon="briefcase" leaving={leaving}><Empty icon="briefcase">Loading the briefing…</Empty></Modal>;
  const def = ACTIVITY_BY_ID[brief.activity];
  const giver = CONTACTS[brief.giver] ?? CONTACTS[def?.giver ?? ''];
  const party = Math.min(4, Math.max(1, brief.eligibility.length)) - 1;
  const cash = def ? def.rewards.cash[party] : 0;
  const ahead = brief.eligibility.filter((e) => e.eligibility === 'ahead');
  const me = brief.eligibility.find((e) => e.userId === user?.id);
  const setups = brief.heist?.setups;
  return (
    <Modal title={brief.name} icon="briefcase" leaving={leaving} wide accent="sun" subtitle={`${KIND_LABEL[brief.kind] ?? brief.kind}${giver ? ` · from ${giver.name}` : ''}`}
      footer={
        <>
          <Btn variant="ghost" onClick={closeOverlay}>Not now</Btn>
          <span className="grow" />
          {brief.checkpoint && <span className="muted small"><Icon name="flag" size={13} /> Resume point saved</span>}
          <Btn size="lg" icon="play" onClick={() => openLobby(brief.activity)} disabled={!brief.unlocked} why={brief.lockedReason ?? 'This job is locked'}>{brief.kind === 'heist' ? 'Open the planning board' : brief.checkpoint ? 'Continue crew lobby' : 'Start (open lobby)'}</Btn>
        </>
      }>
      <div className="brief-grid">
        <div>
          {giver && (
            <div className="giver"><Avatar name={giver.name} size={44} color={hex(giver.color)} /><div><b>{giver.name}</b><small>{giver.role}</small></div></div>
          )}
          <p className="blurb">{brief.blurb}</p>
          {!brief.unlocked && <div className="form-error"><Icon name="lock" size={16} /> {brief.lockedReason ?? 'Locked'}</div>}
          {ahead.length > 0 && (
            <div className="spoiler"><Icon name="info" size={18} /><div><b>Spoiler warning.</b> {ahead.map((a) => a.name).join(', ')} {ahead.length > 1 ? 'are' : 'is'} ahead of your story. Joining counts for no story progress, and the job may reveal plot details.</div></div>
          )}
          {brief.setupOf && (
            <div className="setup-of">
              <Icon name="gem" size={18} />
              <div>
                <b>{brief.setupOf.optional ? 'Optional setup' : 'Required setup'} for {brief.setupOf.heistName}</b>
                <small>{brief.setupOf.perk}</small>
                {brief.setupOf.choice && <small className="choice-hint"><Icon name="flag" size={12} /> Choice in the lobby: {brief.setupOf.choice.options.map((o) => o.name).join(' or ')}</small>}
              </div>
            </div>
          )}
          {brief.notes.length > 0 && (<><SectionTitle>Good to know</SectionTitle><ul className="notes">{brief.notes.map((n, i) => <li key={i}>{n}</li>)}</ul></>)}
          {brief.checkpoint && (<div className="cp-note"><Icon name="flag" size={16} /><span>Checkpoint reached: <b>Stage {brief.checkpoint.stage + 1} · {brief.checkpoint.title}</b>. Your crew resumes here when you start.</span></div>)}
        </div>
        <div>
          <SectionTitle>Crew &amp; eligibility</SectionTitle>
          <p className="muted small solo-note"><Icon name="users" size={14} /> Play it solo or with up to 3 friends. Guards, timers and paired switches adjust to your crew size.</p>
          <ul className="elig-list">
            {brief.eligibility.map((e) => (
              <li key={e.userId} className={e.userId === user?.id ? 'me' : ''}>
                <Avatar name={e.name} size={26} />
                <div className="grow">
                  <b>{e.name}{e.userId === user?.id && <small> (you)</small>}</b>
                  <Tag tone={ELIG[e.eligibility].tone} icon={ELIG[e.eligibility].icon}>{ELIG[e.eligibility].label}</Tag>
                </div>
                <span className="mono elig-rw">{e.reward}</span>
              </li>
            ))}
          </ul>
          <SectionTitle>Rewards</SectionTitle>
          <div className="rewards">
            {def && def.kind !== 'heist' && <div className="reward"><Icon name="coin" size={20} /><b>{money(me?.eligibility === 'story' || !me ? cash : def.rewards.replayCash)}</b><small>{brief.eligibility.length > 1 ? `each, crew of ${brief.eligibility.length}` : 'solo'}</small></div>}
            {brief.heist && <div className="reward"><Icon name="gem" size={20} /><b>{money(brief.heist.baseTake)}</b><small>base take, split by the crew</small></div>}
            {brief.heist?.firstTimeBonus != null && <div className="reward"><Icon name="star" size={20} /><b>{money(brief.heist.firstTimeBonus)}</b><small>first-time bonus each</small></div>}
            {def && <div className="reward"><Icon name="star" size={20} /><b>+{def.rewards.rep}</b><small>reputation</small></div>}
            {brief.personalBest != null && <div className="reward"><Icon name="flag" size={20} /><b className="mono">{fmtRace(brief.personalBest)}</b><small>personal best</small></div>}
          </div>
          {setups ? (
            <>
              <SectionTitle>Setups</SectionTitle>
              <SetupList setups={setups.map((x) => ({ ...x, choice: x.choice ? { label: x.choice.label, pickedName: x.choice.picked } : undefined }))} />
            </>
          ) : brief.preps && brief.preps.length > 0 && (
            <>
              <SectionTitle>Heist preps</SectionTitle>
              <SetupList setups={brief.preps.map((p) => ({ id: p.id, name: p.name, done: p.done, optional: !!p.optional }))} />
            </>
          )}
          {brief.heist && (
            <>
              <SectionTitle>Approaches &amp; roles</SectionTitle>
              <div className="chips">{brief.heist.approaches.map((a) => <Tag key={a} tone={APPROACH_TONE[a] ?? 'aqua'}>{a}</Tag>)}{brief.heist.roles.map((r) => <Tag key={r} tone="violet">{r}</Tag>)}</div>
              {brief.heist.elite && <div className="elite-mini"><Icon name="crown" size={15} /> <span><b>Elite:</b> {brief.heist.elite.label} <b className="mono">+{money(brief.heist.elite.bonus)}</b></span></div>}
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function SetupList({ setups, locked }: { setups: { id: string; name: string; done: boolean; optional: boolean; perk?: string; category?: string; choice?: { label: string; pickedName?: string } }[]; locked?: boolean }) {
  return (
    <ul className="preps setup-list">
      {setups.map((p) => (
        <li key={p.id} className={`${p.done ? 'done' : ''} ${p.optional ? 'opt' : ''}`}>
          <span className="chk">{p.done && <Icon name="check" size={13} />}</span>
          <span className="grow">
            <span className="setup-name">{p.category && CAT[p.category] && <Icon name={CAT[p.category].icon} size={13} />}{p.name.replace(/^.*?: /, '')}</span>
            {p.perk && <small>{p.perk}</small>}
            {p.choice && <small className="choice-hint"><Icon name="flag" size={11} /> {p.choice.label}: {p.done && p.choice.pickedName ? <b>{p.choice.pickedName}</b> : 'chosen in the setup'}</small>}
          </span>
          {p.optional ? <Tag tone="grey">Optional</Tag> : <Tag tone="sun">Required</Tag>}
          {p.done ? <Tag tone="green">Done</Tag> : <Btn size="sm" variant="ghost" disabled={locked} why="Finish the story missions first" onClick={() => openBrief(p.id)}>Open</Btn>}
        </li>
      ))}
    </ul>
  );
}

// ───────────────────────────────────────────── lobby
function evenSplit(ids: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  const base = Math.floor(100 / ids.length);
  ids.forEach((id, i) => { out[id] = base + (i === 0 ? 100 - base * ids.length : 0); });
  return out;
}

function redistribute(cur: Record<string, number>, id: string, v: number): Record<string, number> {
  const others = Object.keys(cur).filter((k) => k !== id);
  const out: Record<string, number> = { ...cur, [id]: v };
  if (others.length === 0) { out[id] = 100; return out; }
  const rest = 100 - v;
  const total = others.reduce((a, k) => a + cur[k], 0);
  let given = 0;
  others.forEach((k, i) => {
    const share = i === others.length - 1 ? rest - given : Math.round(total > 0 ? (cur[k] / total) * rest : rest / others.length);
    out[k] = Math.max(0, Math.min(100, share)); given += out[k];
  });
  return out;
}

export function Lobby({ leaving }: { leaving: boolean }) {
  const lobby = useGame((s) => s.lobby) as LobbyView | null;
  const me = useGame((s) => s.user);
  const [draft, setDraft] = useState<Record<string, number>>({});
  const ids = lobby?.members.map((m) => m.userId) ?? [];
  const serverSplit = JSON.stringify(lobby?.config.split ?? {});
  useEffect(() => {
    if (!lobby) return;
    const s = lobby.config.split;
    const valid = ids.every((i) => typeof s[i] === 'number') && ids.reduce((a, i) => a + s[i], 0) === 100;
    setDraft(valid ? { ...s } : evenSplit(ids));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverSplit, ids.join(',')]);
  if (!lobby) return <Modal title="Lobby" icon="users" leaving={leaving}><Empty icon="users">Lobby closed.</Empty></Modal>;
  const def = ACTIVITY_BY_ID[lobby.activity];
  const isLeader = lobby.leader === me?.id;
  const mine = lobby.members.find((m) => m.userId === me?.id);
  const heist = def?.heist;
  const board = lobby.heist;
  const approach = lobby.config.approach;
  const sum = Object.values(draft).reduce((a, b) => a + b, 0);
  const reasons = [...lobby.blockers];
  if (!isLeader) reasons.unshift('Only the leader can launch.');
  const canLaunch = isLeader && lobby.canLaunch && (!heist || sum === 100);
  if (heist && sum !== 100) reasons.push('Payout split must total 100%.');
  const setEquip = (id: string, on: boolean) => {
    const cur = lobby.config.equipment;
    configureLobby({ equipment: on ? [...cur, id].slice(0, 3) : cur.filter((x) => x !== id) });
  };
  return (
    <Modal title={lobby.name} icon={heist ? 'gem' : 'users'} leaving={leaving} wide tall={!!heist} accent={heist ? 'sun' : 'aqua'} className={heist ? 'planner-modal' : ''}
      subtitle={heist ? `Planning board · ${lobby.members.length} in crew · terms lock at launch` : `${KIND_LABEL[lobby.kind] ?? lobby.kind} lobby · ${lobby.members.length} in crew`}
      footer={
        <>
          {isLeader ? <Btn variant="danger" onClick={cancelLobby}>Cancel job</Btn> : <Btn variant="ghost" onClick={leaveActivity}>Leave lobby</Btn>}
          <Btn variant="ghost" onClick={closeOverlay}>Hide</Btn>
          <span className="grow" />
          {board && <span className="est-foot mono" title="Estimated take for a clean run">≈ {money(board.estimate.total)} take</span>}
          <Btn variant={mine?.ready ? 'ghost' : 'aqua'} icon={mine?.ready ? 'close' : 'check'} onClick={() => setReady(!mine?.ready)}>{mine?.ready ? 'Unready' : 'Ready'}</Btn>
          {isLeader && <Btn size="lg" icon="play" onClick={launchActivity} disabled={!canLaunch} why={reasons[0] ?? 'Cannot launch yet'}>{lobby.members.length === 1 ? 'Start solo' : 'Launch'}</Btn>}
        </>
      }>
      <div className="lobby-grid">
        <div>
          <SectionTitle>Crew</SectionTitle>
          <ul className="list members lobby-members">
            {lobby.members.map((m) => {
              const el = ELIG[(m.eligible.startsWith('Story') || m.eligible.startsWith('Full') ? 'story' : m.eligible.startsWith('Replay') ? 'replay' : 'ahead') as keyof typeof ELIG];
              const first = board?.bonuses.firstTimers.includes(m.userId);
              return (
                <li key={m.userId} className={`${m.ready ? 'ready' : ''} ${m.connected ? '' : 'offline'}`}>
                  <span className={`dot ${m.connected ? 'st-online' : 'st-offline'}`} title={m.connected ? 'Connected' : 'Disconnected'} />
                  <Avatar name={m.name} size={34} ring={m.ready ? 'var(--aqua)' : undefined} />
                  <div className="grow">
                    <b>{m.name} {m.userId === lobby.leader && <Icon name="crown" size={13} fill className="crown" />}</b>
                    <small>{m.connected ? (m.ready ? 'Ready' : 'Not ready') : 'Disconnected'}{board ? ` · cut ${draft[m.userId] ?? 0}%` : ''}</small>
                    {el && <Tag tone={el.tone} icon={el.icon} title={m.eligible}>{m.eligible.split(' ')[0]}</Tag>}
                    {first && <Tag tone="sun" icon="star" title="First time pulling this heist">First time +{money(board!.bonuses.firstTime)}</Tag>}
                  </div>
                  {heist && m.userId !== me?.id && <Tag tone="violet">{m.role === 'none' ? 'no role' : m.role}</Tag>}
                  <span className={`ready-box ${m.ready ? 'on' : ''}`}>{m.ready ? <Icon name="check" size={16} /> : null}</span>
                </li>
              );
            })}
          </ul>
          {heist && (
            <>
              <SectionTitle>Your role</SectionTitle>
              <div className="role-pick">
                {(['none', ...heist.roles] as Role[]).map((r) => {
                  const taken = r !== 'none' && lobby.members.some((m) => m.userId !== me?.id && m.role === r);
                  return (
                    <button key={r} type="button" className={`role ${mine?.role === r ? 'on' : ''}`} disabled={taken} onClick={() => setRole(r)} title={taken ? 'Taken by another crew member' : ROLE_INFO[r]}>
                      <b>{r === 'none' ? 'Any' : r}</b><small>{taken ? 'Taken' : ROLE_INFO[r]}</small>
                    </button>
                  );
                })}
              </div>
            </>
          )}
          {board && <><SectionTitle right={<Tag tone={board.setups.filter((x) => !x.optional).every((x) => x.done) ? 'green' : 'red'}>{board.setups.filter((x) => x.done).length}/{board.setups.length} done</Tag>}>Setups</SectionTitle><SetupList setups={board.setups} /></>}
          {lobby.setup && <SetupPanel lobby={lobby} isLeader={isLeader} />}
          {lobby.blockers.length > 0 && (
            <div className="blockers"><b><Icon name="info" size={15} /> Before you can launch</b><ul>{lobby.blockers.map((b, i) => <li key={i}>{b}</li>)}</ul></div>
          )}
        </div>
        <div>
          {heist && board ? (
            <>
              <SectionTitle right={!isLeader ? <Tag tone="grey" icon="lock">Leader sets this</Tag> : undefined}>Approach</SectionTitle>
              <div className="approach-pick">
                {board.approaches.map((a) => (
                  <button key={a.id} type="button" className={`role appr ${approach === a.id ? 'on' : ''} tone-${APPROACH_TONE[a.id] ?? 'aqua'}`} disabled={!isLeader || !!a.locked} onClick={() => configureLobby({ approach: a.id as 'quiet' | 'loud' | 'con' })} title={a.locked ?? a.name}>
                    <b>{a.locked && <Icon name="lock" size={12} />} {a.name}</b>
                    <small>{a.locked ?? (a.id === 'quiet' ? 'Stealth. Full take if nobody sees you.' : a.id === 'loud' ? `Alarm at once. ${Math.round(heist.loudPenalty * 100)}% take.` : 'Disguises. Guards ignore you while the act holds.')}</small>
                  </button>
                ))}
              </div>
              <SectionTitle>Difficulty</SectionTitle>
              <Seg value={board.difficulty as 'normal' | 'hard'} disabled={!isLeader} onChange={(v) => configureLobby({ difficulty: v })}
                options={[{ id: 'normal', label: 'Normal' }, { id: 'hard', label: `Hard (+${Math.round((board.hardMult - 1) * 100)}% take)` }]} />
              <p className="muted small diff-note">{board.difficulty === 'hard' ? `More (armed) guards, timers 20% shorter, response teams always come, and ${board.lives} team lives: every knockout costs one, at zero the job is over.` : 'Standard guards and timers. Retry from any checkpoint as often as you like.'}</p>
              <SectionTitle>Equipment <small className="muted">({lobby.config.equipment.length}/3)</small></SectionTitle>
              <div className="equip">
                {heist.equipment.map((e) => {
                  const on = lobby.config.equipment.includes(e.id);
                  const wrong = !!e.approach && e.approach !== approach;
                  const full = !on && lobby.config.equipment.length >= 3;
                  const dis = !isLeader || wrong || full;
                  return (
                    <button key={e.id} type="button" className={`equip-card ${on ? 'on' : ''}`} disabled={dis} onClick={() => setEquip(e.id, !on)}
                      title={!isLeader ? 'Only the leader can choose equipment' : wrong ? `Only for the ${e.approach} approach` : full ? 'Maximum of 3 items' : e.desc}>
                      <span className="eq-chk">{on && <Icon name="check" size={13} />}</span>
                      <span className="grow"><b>{e.name}</b><small>{e.desc}</small></span>
                      {e.approach && <Tag tone={APPROACH_TONE[e.approach] ?? 'aqua'}>{e.approach}</Tag>}
                    </button>
                  );
                })}
              </div>
              <SectionTitle right={<Tag tone={sum === 100 ? 'green' : 'red'}>{sum}% / 100%</Tag>}>Cuts</SectionTitle>
              <div className="split">
                {lobby.members.map((m) => {
                  const pct = draft[m.userId] ?? 0;
                  return (
                    <label key={m.userId} className="split-row">
                      <span className="sr-name"><Avatar name={m.name} size={22} /> {m.name}</span>
                      <input type="range" min={0} max={100} step={1} value={pct} disabled={!isLeader || lobby.members.length < 2}
                        style={{ ['--p' as string]: `${pct}%` }}
                        onChange={(e) => setDraft((d) => redistribute(d, m.userId, Number(e.target.value)))}
                        onPointerUp={() => configureLobby({ split: draft })} onKeyUp={() => configureLobby({ split: draft })} />
                      <span className="sr-pct mono">{pct}%</span>
                      <span className="sr-pay mono" title="Estimated cut on a clean run">{money(Math.round((board.estimate.total * pct) / 100))}</span>
                    </label>
                  );
                })}
                <div className="split-foot">
                  <span className="muted small">Cuts lock at launch. Everyone gets at least 10%.</span>
                  <Btn size="sm" variant="ghost" disabled={!isLeader || lobby.members.length < 2} why={!isLeader ? 'Only the leader can change the split' : 'Only one crew member'} onClick={() => { const e = evenSplit(ids); setDraft(e); configureLobby({ split: e }); }}>Even split</Btn>
                </div>
              </div>
              <TakeEstimate board={board} heist={heist} approach={approach} />
            </>
          ) : (
            <>
              <SectionTitle>Payout</SectionTitle>
              <ul className="notes">{lobby.payout.length ? lobby.payout.map((p, i) => <li key={i}>{p}</li>) : <li>Rewards are listed in the briefing.</li>}</ul>
              <p className="muted">{lobby.members.length === 1 ? <>Going in alone works: press <b>Start solo</b>. Friends can still join before you start.</> : <>Everyone in the crew needs to press <b>Ready</b>. The leader launches the job.</>}</p>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function SetupPanel({ lobby, isLeader }: { lobby: LobbyView; isLeader: boolean }) {
  const st = lobby.setup!;
  return (
    <div className="setup-panel">
      <SectionTitle>{st.optional ? 'Optional setup' : 'Required setup'}</SectionTitle>
      <p className="muted small">Counts toward <b>{st.heistName}</b> for the crew leader. {st.perk}</p>
      {st.choice && (
        <>
          <SectionTitle right={!isLeader ? <Tag tone="grey" icon="lock">Leader picks</Tag> : <Tag tone="sun">Changes the finale</Tag>}>{st.choice.label}</SectionTitle>
          <div className="choice-pick">
            {st.choice.options.map((o) => (
              <button key={o.id} type="button" className={`role ${st.choice!.picked === o.id ? 'on' : ''}`} disabled={!isLeader} onClick={() => configureLobby({ choice: o.id })}>
                <b>{o.name}</b><small>{o.desc}</small>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function TakeEstimate({ board, heist, approach }: { board: HeistBoardView; heist: NonNullable<(typeof ACTIVITIES)[number]['heist']>; approach: string }) {
  const e = board.estimate;
  return (
    <div className="take-est">
      <div className="te-row"><span>Base take</span><b className="mono">{money(e.base)}</b></div>
      <div className="te-row"><span>Loot you can bag</span><b className="mono">+ {money(e.loot)}</b></div>
      {approach === 'loud' && <div className="te-row bad"><span>Loud: goods damaged</span><b className="mono">× {Math.round(heist.loudPenalty * 100)}%</b></div>}
      {board.difficulty === 'hard' && <div className="te-row good"><span>Hard</span><b className="mono">× {Math.round(board.hardMult * 100)}%</b></div>}
      <div className="te-row total"><span>Clean-run take</span><b className="mono">{money(e.total)}</b></div>
      <div className="te-bonus"><Icon name="crown" size={14} /> <span>Elite: {board.bonuses.elite.label} <b className="mono">+{money(board.bonuses.elite.bonus)}</b> each</span></div>
      <div className="te-bonus"><Icon name="star" size={14} /> <span>First-time bonus <b className="mono">+{money(board.bonuses.firstTime)}</b> for {board.bonuses.firstTimers.length} crew</span></div>
      <small className="muted">Bags are carried. A knocked-out carrier drops theirs ({Math.round(heist.carryLoss * 100)}% damaged) - pick it back up. A quiet or con run that trips the alarm pays {Math.round(heist.loudPenalty * 100)}%.</small>
    </div>
  );
}

// ───────────────────────────────────────────── heist board
export function HeistBoard({ leaving }: { leaving: boolean }) {
  const profile = useGame((s) => s.profile);
  const heists = useMemo(() => ACTIVITIES.filter((a) => a.kind === 'heist'), []);
  const completed = profile?.completed ?? {};
  return (
    <Modal title="Heist planning board" icon="gem" leaving={leaving} wide tall accent="sun" className="board-modal" subtitle="Lena's board: do the setups, pick a plan, gather your crew.">
      {heists.length === 0 ? <Empty icon="gem">No heists to plan yet.</Empty> : (
        <div className="corkboard">
          {heists.map((h, hi) => {
            const entries = profile?.preps?.[h.id] ?? [];
            const done = setupsDone(entries);
            const choices = setupChoices(entries);
            const setups = (h.heist?.setups ?? []).map((s) => ({
              id: s.prep, name: ACTIVITY_BY_ID[s.prep]?.name ?? s.prep, done: done.includes(s.prep), optional: !!s.optional, perk: s.perk, category: s.category,
              choice: s.choice ? { label: s.choice.label, pickedName: s.choice.options.find((o) => o.id === choices[s.choice!.key])?.name } : undefined,
            }));
            const req = setups.filter((s) => !s.optional);
            const nDone = req.filter((p) => p.done).length;
            const locked = (h.unlock.requires ?? []).some((r) => !(completed[r] > 0));
            const finished = (completed[h.id] ?? 0) > 0;
            const giver = CONTACTS[h.giver];
            const ready = !locked && nDone === req.length;
            return (
              <article key={h.id} className={`heist-card ${locked ? 'locked' : ''}`} style={{ ['--rot' as string]: `${hi % 2 ? 1.2 : -1.2}deg` }}>
                <span className="pin" />
                <header>
                  <h3>{h.name}</h3>
                  {locked ? <Tag tone="grey" icon="lock">Locked</Tag> : ready ? <Tag tone="sun" icon="bolt">Ready</Tag> : <Tag tone="aqua">Setups {nDone}/{req.length}</Tag>}
                </header>
                {finished && <Tag tone="green" icon="check">Pulled off {completed[h.id]}×</Tag>}
                <p>{h.blurb}</p>
                {giver && <div className="planner"><Avatar name={giver.name} size={26} color={hex(giver.color)} /> <span>Planner: <b>{giver.name}</b></span></div>}
                {h.heist && <div className="chips"><Tag tone="sun" icon="gem">Base {money(h.heist.baseTake)}</Tag>{h.heist.approaches.map((a) => <Tag key={a} tone={APPROACH_TONE[a] ?? 'aqua'}>{a}</Tag>)}{!finished && <Tag tone="green" icon="star">First time +{money(h.heist.firstTimeBonus)}</Tag>}</div>}
                <SetupList setups={setups} locked={locked} />
                {h.heist && <div className="elite-mini"><Icon name="crown" size={14} /> <span><b>Elite:</b> {h.heist.elite.label} (+{money(h.heist.elite.bonus)})</span></div>}
                <Btn block variant={ready ? 'primary' : 'ghost'} icon="briefcase" disabled={locked} why={locked ? 'Finish the story missions first' : undefined} onClick={() => openBrief(h.id)}>{ready ? 'Brief the crew' : 'View briefing'}</Btn>
              </article>
            );
          })}
        </div>
      )}
    </Modal>
  );
}

// ───────────────────────────────────────────── results
interface HeistResult {
  difficulty: string; approach: string; base: number; grabbed: number; secured: number; lost: number; leftBehind: number; approachMult: number; diffMult: number; take: number;
  knockouts: number; retries: number; seconds: number; alarm: boolean; lives: number | null; livesMax: number | null;
  elite: { label: string; bonus: number; met: boolean; checks: { label: string; ok: boolean }[] }; firstTimeBonus: number;
}
type ResultsExtra = Omit<ResultsView, 'lines'> & { heist?: HeistResult; lines: (ResultsView['lines'][number] & { pct?: number; cut?: number; eliteBonus?: number; firstBonus?: number })[] };

export function Results({ leaving }: { leaving: boolean }) {
  const r = useGame((s) => s.results) as unknown as ResultsExtra | null;
  const me = useGame((s) => s.user);
  const mine = r?.lines.find((l) => l.userId === me?.id);
  const cash = useCountUp(mine?.cash ?? 0, 1100);
  if (!r) return <Modal title="Results" icon="flag" leaving={leaving} noClose><Empty>No results.</Empty></Modal>;
  const failed = r.lines.length > 0 && r.lines.every((l) => /fail|over|wasted|down/i.test(l.status));
  const isRace = r.kind === 'minigame';
  const isRealRace = isRace && !!(r as { race?: unknown[] }).race?.length;
  const head = failed ? (isRace ? (isRealRace ? 'RACE OVER' : 'RUN OVER') : 'MISSION FAILED') : isRace ? (isRealRace ? 'RACE COMPLETE' : 'RUN COMPLETE') : r.kind === 'heist' ? 'HEIST COMPLETE' : r.kind === 'heist_prep' ? 'SETUP DONE' : 'MISSION PASSED';
  const h = r.heist;
  return (
    <div className={`scrim results ${leaving ? 'out' : ''}`}>
      <div className={`res-wrap ${failed ? 'failed' : 'passed'} ${h ? 'res-heist' : ''}`}>
        <div className="res-banner"><h1>{head}</h1><p>{r.name}{h ? ` · ${h.approach} · ${h.difficulty}` : ''}</p></div>
        <div className="res-card glass">
          {mine && (
            <div className="res-me">
              <div><small>Your cash</small><b className="mono">{money(cash)}</b></div>
              <div><small>Reputation</small><b className="mono">+{mine.rep}</b></div>
              {r.take != null && r.kind === 'heist' && <div><small>Heist take</small><b className="mono">{money(r.take)}</b></div>}
              {h && <div><small>Time</small><b className="mono">{fmtSecs(h.seconds)}</b></div>}
              {!h && r.loot != null && r.kind === 'heist' && <div><small>Loot grabbed</small><b className="mono">{money(r.loot)}</b></div>}
            </div>
          )}
          {h && (
            <div className="res-heist-grid">
              <div className="take-est">
                <SectionTitle>The take</SectionTitle>
                <div className="te-row"><span>Base take</span><b className="mono">{money(h.base)}</b></div>
                <div className="te-row"><span>Loot bagged</span><b className="mono">+ {money(h.grabbed)}</b></div>
                {h.lost > 0 && <div className="te-row bad"><span>Damaged / dropped{h.leftBehind ? ` (left behind ${money(h.leftBehind)})` : ''}</span><b className="mono">− {money(h.lost)}</b></div>}
                {h.approachMult !== 1 && <div className="te-row bad"><span>Alarm: goods damaged</span><b className="mono">× {Math.round(h.approachMult * 100)}%</b></div>}
                {h.diffMult !== 1 && <div className="te-row good"><span>Hard</span><b className="mono">× {Math.round(h.diffMult * 100)}%</b></div>}
                <div className="te-row total"><span>Take</span><b className="mono">{money(h.take)}</b></div>
                <small className="muted">{h.knockouts} knockout{h.knockouts === 1 ? '' : 's'} · {h.retries} retr{h.retries === 1 ? 'y' : 'ies'}{h.lives !== null ? ` · ${h.lives}/${h.livesMax} team lives left` : ''}{h.alarm ? ' · alarm tripped' : ' · no alarm'}</small>
              </div>
              <div className={`elite-card ${h.elite.met ? 'met' : ''}`}>
                <SectionTitle right={<Tag tone={h.elite.met ? 'green' : 'grey'} icon={h.elite.met ? 'crown' : 'close'}>{h.elite.met ? `+${money(h.elite.bonus)} each` : 'Missed'}</Tag>}>Elite challenge</SectionTitle>
                <p className="small">{h.elite.label}</p>
                <ul>{h.elite.checks.map((c, i) => <li key={i} className={c.ok ? 'ok' : 'no'}><Icon name={c.ok ? 'check' : 'close'} size={13} /> {c.label}</li>)}</ul>
              </div>
            </div>
          )}
          <table className="table">
            <thead><tr><th>Player</th><th>Result</th>{h && <><th>Cut</th><th>Bonuses</th></>}<th>Cash</th><th>Rep</th><th>Notes</th></tr></thead>
            <tbody>
              {r.lines.map((l, i) => (
                <tr key={l.userId} className={l.userId === me?.id ? 'me' : ''} style={{ ['--i' as string]: i }}>
                  <td><Avatar name={l.name} size={24} /> {l.name}</td>
                  <td><Tag tone={/fail|down|over/i.test(l.status) ? 'red' : 'green'}>{l.status}</Tag></td>
                  {h && <><td className="mono">{l.pct ?? 0}% · {money(l.cut ?? 0)}</td><td className="mono">{l.eliteBonus ? `elite ${money(l.eliteBonus)} ` : ''}{l.firstBonus ? `first ${money(l.firstBonus)}` : ''}{!l.eliteBonus && !l.firstBonus ? '—' : ''}</td></>}
                  <td className="mono">{money(l.cash)}</td>
                  <td className="mono">+{l.rep}</td>
                  <td className="muted">{l.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {r.race && r.race.length > 0 && (
            <>
              <SectionTitle>Race results</SectionTitle>
              <ol className="race-table">
                {[...r.race].sort((a, b) => (a.ms ?? 1e12) - (b.ms ?? 1e12)).map((x, i) => (
                  <li key={x.userId} className={x.userId === me?.id ? 'me' : ''}>
                    <span className={`rplace p${i + 1}`}>{i + 1}</span><span className="grow">{x.name}</span><span className="mono">{x.ms != null ? fmtRace(x.ms) : 'DNF'}</span>
                  </li>
                ))}
              </ol>
            </>
          )}
          <div className="res-foot"><Btn size="lg" icon="play" autoFocus onClick={continueResults}>Continue</Btn></div>
        </div>
      </div>
    </div>
  );
}

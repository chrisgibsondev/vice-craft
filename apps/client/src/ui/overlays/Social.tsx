import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useGame } from '../../state/store';
import {
  refreshFriends, refreshParty, searchUsers, sendFriendRequest, addFriendByCode, respondFriend, cancelFriendRequest, removeFriend, setBlocked, setPrivacy, reportPlayer,
  createParty, inviteToParty, acceptPartyInvite, declinePartyInvite, leaveParty, kickFromParty, transferLeader, createInviteLink, partyChat,
} from '../../state/actions';
import type { FriendView, FriendStatus } from '../../state/types';
import { Modal, Tabs, Btn, Tag, Avatar, Empty, Seg, SectionTitle, copyText, useDebounced, Spinner } from '../components';
import { Icon } from '../Icons';
import { fmtClock, useNow } from '../util';
import { pushNotice } from '../../state/store';

type Tab = 'friends' | 'requests' | 'find' | 'blocked' | 'privacy';

const STATUS_TEXT: Record<FriendStatus, string> = { offline: 'Offline', online: 'Online', in_world: 'In a world', in_activity: 'On a job', in_interior: 'Inside a building' };

function useRelations() {
  const world = useGame((s) => s.world);
  const ents = useGame((s) => s.entities);
  const activity = useGame((s) => s.activity);
  const names = useMemo(() => new Set(ents.filter((e) => e.k === 'p').map((e) => (e as { n: string }).n)), [ents]);
  return (f: { id: string; name: string; where?: string; status?: FriendStatus; inMyParty?: boolean }) => {
    const here = !!world && (names.has(f.name) || (!!f.where && (f.where === world.label || f.where === world.instance)));
    const inAct = (!!activity && activity.roster.some((r) => r.userId === f.id)) || (here && world?.kind === 'activity');
    return { party: !!f.inMyParty, world: here && !inAct, activity: inAct };
  };
}

function Badges({ rel, friend = true }: { rel: { party: boolean; world: boolean; activity: boolean }; friend?: boolean }) {
  return (
    <span className="badges">
      {friend && <Tag tone="pink" icon="heart" title="On your friends list">Friend</Tag>}
      {rel.party && <Tag tone="aqua" icon="users" title="Member of your party">In my party</Tag>}
      {rel.world && <Tag tone="sun" icon="globe" title="Playing in the same world as you">In my world</Tag>}
      {rel.activity && <Tag tone="violet" icon="flag" title="In your current job or activity">In my activity</Tag>}
    </span>
  );
}

function FriendRow({ f, hasParty }: { f: FriendView; hasParty: boolean }) {
  const rel = useRelations()(f);
  const [menu, setMenu] = useState<'none' | 'more' | 'report' | 'confirm-remove' | 'confirm-block'>('none');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const online = f.status !== 'offline';
  const accent = rel.activity ? 'violet' : rel.party ? 'aqua' : rel.world ? 'sun' : 'pink';
  const invite = async () => { setBusy(true); try { if (!hasParty) await createParty(); await inviteToParty(f.id); } finally { setBusy(false); } };
  return (
    <li className={`frow acc-${accent} ${online ? '' : 'offline'}`}>
      <div className="frow-main">
        <span className={`dot st-${f.status}`} title={STATUS_TEXT[f.status]} />
        <Avatar name={f.name} size={36} />
        <div className="grow">
          <b>{f.name}</b>
          <small>{STATUS_TEXT[f.status]}{f.where && online ? ` · ${f.where}` : ''}{f.joinable ? ' · joinable' : ''}</small>
          <Badges rel={rel} />
        </div>
        <Btn size="sm" variant="aqua" icon="plus" disabled={!online || f.inMyParty || busy} why={f.inMyParty ? 'Already in your party' : !online ? `${f.name} is offline` : undefined} onClick={() => void invite()}>Invite</Btn>
        <button type="button" className="iconbtn" aria-label="More actions" title="More actions" onClick={() => setMenu(menu === 'none' ? 'more' : 'none')}>⋯</button>
      </div>
      {menu !== 'none' && (
        <div className="frow-menu">
          {menu === 'more' && (
            <>
              <Btn size="sm" variant="ghost" onClick={() => setMenu('confirm-remove')}>Remove friend</Btn>
              <Btn size="sm" variant="ghost" onClick={() => setMenu('confirm-block')}>Block</Btn>
              <Btn size="sm" variant="ghost" onClick={() => setMenu('report')}>Report</Btn>
            </>
          )}
          {menu === 'confirm-remove' && <><span>Remove {f.name} from friends?</span><Btn size="sm" variant="danger" onClick={() => void removeFriend(f.id)}>Remove</Btn><Btn size="sm" variant="ghost" onClick={() => setMenu('none')}>Keep</Btn></>}
          {menu === 'confirm-block' && <><span>Block {f.name}? They will be removed from your friends and party.</span><Btn size="sm" variant="danger" onClick={() => void setBlocked(f.id, true)}>Block</Btn><Btn size="sm" variant="ghost" onClick={() => setMenu('none')}>Cancel</Btn></>}
          {menu === 'report' && (
            <form onSubmit={(e) => { e.preventDefault(); if (reason.trim()) { void reportPlayer(f.id, reason.trim()); setMenu('none'); setReason(''); } }}>
              <input autoFocus placeholder="What happened?" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
              <Btn size="sm" type="submit" variant="danger" disabled={!reason.trim()} why="Describe the problem first">Send report</Btn>
              <Btn size="sm" variant="ghost" onClick={() => setMenu('none')}>Cancel</Btn>
            </form>
          )}
        </div>
      )}
    </li>
  );
}

function FriendsTab() {
  const friends = useGame((s) => s.social.friends);
  const party = useGame((s) => s.party);
  const rel = useRelations();
  const sorted = useMemo(() => [...friends].sort((a, b) => {
    const ra = rel(a), rb = rel(b);
    const score = (r: typeof ra, f: FriendView) => (r.activity ? 0 : r.party ? 1 : r.world ? 2 : f.status !== 'offline' ? 3 : 4);
    return score(ra, a) - score(rb, b) || a.name.localeCompare(b.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [friends]);
  return (
    <>
      <div className="rel-legend" aria-label="What the labels mean">
        <span><Tag tone="pink" icon="heart">Friend</Tag> on your friends list</span>
        <span><Tag tone="aqua" icon="users">In my party</Tag> plays with you wherever you go</span>
        <span><Tag tone="sun" icon="globe">In my world</Tag> same world right now</span>
        <span><Tag tone="violet" icon="flag">In my activity</Tag> same job or heist</span>
      </div>
      {sorted.length === 0 ? <Empty icon="heart">No friends yet. Use <b>Find players</b> to send a request.</Empty> : (
        <ul className="list friends">{sorted.map((f) => <FriendRow key={f.id} f={f} hasParty={!!party} />)}</ul>
      )}
    </>
  );
}

function FindTab() {
  const [q, setQ] = useState('');
  const dq = useDebounced(q.trim(), 350);
  const [res, setRes] = useState<{ id: string; name: string; friend: boolean; pending: boolean }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Set<string>>(new Set());
  const seq = useRef(0);
  const friendIds = useGame((st) => st.social.friends.map((f) => f.id).join(','));
  useEffect(() => {
    if (dq.length < 2) { setRes(null); return; }
    const my = ++seq.current;
    setBusy(true);
    void searchUsers(dq).then((r) => { if (my === seq.current) { setRes(r); setBusy(false); } });
  }, [dq]);
  const myCode = useGame((st) => st.user?.friendCode);
  const [code, setCode] = useState('');
  const [adding, setAdding] = useState(false);
  const [copied, setCopied] = useState(false);
  async function addCode(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{5}$/.test(code)) return;
    setAdding(true);
    if (await addFriendByCode(code)) setCode('');
    setAdding(false);
  }
  return (
    <>
      <div className="friend-code">
        <div className="fc-mine">
          <span>Your friend code</span>
          <b>{myCode ?? '-----'}</b>
          {myCode && <Btn size="sm" variant="ghost" onClick={() => { void navigator.clipboard?.writeText(myCode).catch(() => {}); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'Copied' : 'Copy'}</Btn>}
        </div>
        <form className="fc-add" onSubmit={addCode}>
          <label className="field"><span>Add a friend by their code</span>
            <input value={code} inputMode="numeric" maxLength={5} placeholder="5 digits" onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 5))} /></label>
          <Btn type="submit" icon="plus" disabled={adding || code.length !== 5} why={adding ? 'Working…' : 'Enter all 5 digits'}>Add friend</Btn>
        </form>
      </div>
      <label className="field search"><span>Find a player by username</span>
        <div className="input-ico"><Icon name="search" size={16} /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type at least 2 letters…" maxLength={16} /></div></label>
      {busy && <div className="center-pad"><Spinner size={22} /></div>}
      {!busy && res && res.length === 0 && <Empty icon="search">Nobody found for “{dq}”.</Empty>}
      {res && res.length > 0 && (
        <ul className="list">
          {res.map((u) => (
            <li key={u.id}>
              <Avatar name={u.name} size={34} /><b className="grow">{u.name}</b>
              {u.friend || friendIds.split(',').includes(u.id) ? <Tag tone="pink" icon="heart">Friends</Tag> : u.pending || sent.has(u.id) ? <Tag tone="grey">Request pending</Tag> : (
                <Btn size="sm" icon="plus" onClick={() => { setSent((s) => new Set(s).add(u.id)); void sendFriendRequest(u.id); }}>Add friend</Btn>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function RequestsTab() {
  const { incoming, outgoing } = useGame((s) => s.social);
  return (
    <>
      <SectionTitle>Incoming</SectionTitle>
      {incoming.length === 0 ? <p className="muted">No incoming requests.</p> : (
        <ul className="list">{incoming.map((u) => (
          <li key={u.id}><Avatar name={u.name} size={34} /><b className="grow">{u.name}</b>
            <Btn size="sm" variant="aqua" icon="check" onClick={() => void respondFriend(u.id, true)}>Accept</Btn>
            <Btn size="sm" variant="ghost" onClick={() => void respondFriend(u.id, false)}>Decline</Btn></li>
        ))}</ul>
      )}
      <SectionTitle>Sent</SectionTitle>
      {outgoing.length === 0 ? <p className="muted">No pending requests.</p> : (
        <ul className="list">{outgoing.map((u) => (
          <li key={u.id}><Avatar name={u.name} size={34} /><b className="grow">{u.name}</b><Tag tone="grey">Waiting</Tag>
            <Btn size="sm" variant="ghost" onClick={() => void cancelFriendRequest(u.id)}>Cancel</Btn></li>
        ))}</ul>
      )}
    </>
  );
}

function BlockedTab() {
  const blocked = useGame((s) => s.social.blocked);
  return blocked.length === 0 ? <Empty icon="shield">You have not blocked anyone.</Empty> : (
    <ul className="list">{blocked.map((u) => (
      <li key={u.id}><Avatar name={u.name} size={34} /><b className="grow">{u.name}</b>
        <Btn size="sm" variant="ghost" onClick={() => void setBlocked(u.id, false)}>Unblock</Btn></li>
    ))}</ul>
  );
}

function PrivacyTab() {
  const p = useGame((s) => s.social.privacy);
  return (
    <>
      <div className="row-setting"><span className="rs-text"><b>Who can see when I am online</b><small>Controls your presence and the world you are in.</small></span>
        <Seg value={p.presence} onChange={(v) => void setPrivacy(v, p.invites)} options={[{ id: 'everyone', label: 'Everyone' }, { id: 'friends', label: 'Friends' }, { id: 'nobody', label: 'Nobody' }]} /></div>
      <div className="row-setting"><span className="rs-text"><b>Who can invite me to a party</b><small>Invite links still work if you open them.</small></span>
        <Seg value={p.invites} onChange={(v) => void setPrivacy(p.presence, v)} options={[{ id: 'friends', label: 'Friends' }, { id: 'nobody', label: 'Nobody' }]} /></div>
    </>
  );
}

function PartyPanel() {
  const party = useGame((s) => s.party);
  const invites = useGame((s) => s.partyInvites);
  const me = useGame((s) => s.user);
  const friends = useGame((s) => s.social.friends);
  const chatState = useGame((s) => s.chat);
  const rel = useRelations();
  const now = useNow(1000);
  const [text, setText] = useState('');
  const [pick, setPick] = useState('');
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  const isLeader = !!party && party.leader === me?.id;
  const chat = party && party.chat.length ? party.chat.map((c, i) => ({ id: i, from: c.name, text: c.text })) : chatState.filter((c) => c.ch === 'party').map((c) => ({ id: c.id, from: c.from, text: c.text }));
  useEffect(() => { logRef.current?.scrollTo({ top: 1e6 }); }, [chat.length]);
  const invitable = friends.filter((f) => f.status !== 'offline' && !f.inMyParty);
  const linkUrl = party?.link && party.link.expires > now ? `${location.origin}/?join=${party.link.token}` : null;

  async function makeLink() {
    setBusy(true);
    await createInviteLink();
    await refreshParty();
    setBusy(false);
  }
  const submit = (e: FormEvent) => { e.preventDefault(); if (text.trim()) { partyChat(text.trim()); setText(''); } };

  return (
    <div className="party-panel">
      <div className="pp-head"><h3><Icon name="users" size={18} /> My party</h3>
        <Tag tone="aqua">Plays together</Tag></div>
      {invites.length > 0 && (
        <div className="pinv">
          {invites.map((i) => (
            <div className="invite-row" key={i.partyId}>
              <Avatar name={i.fromName} size={30} />
              <div className="grow"><b>{i.fromName}</b> invited you<small>{i.size} member{i.size > 1 ? 's' : ''} · expires in {fmtClock(i.expires - now)}</small></div>
              <Btn size="sm" variant="aqua" onClick={() => void acceptPartyInvite(i.partyId)}>Accept</Btn>
              <Btn size="sm" variant="ghost" onClick={() => void declinePartyInvite(i.partyId)}>Decline</Btn>
            </div>
          ))}
        </div>
      )}
      {!party ? (
        <div className="no-party">
          <Empty icon="users">You are not in a party. Create one to invite friends and drop into the same world.</Empty>
          <Btn icon="plus" onClick={() => void createParty()}>Create party</Btn>
        </div>
      ) : (
        <>
          <ul className="list members">
            {party.members.map((m) => {
              const r = rel({ id: m.id, name: m.name, where: m.where, inMyParty: true });
              return (
                <li key={m.id} className={`acc-aqua ${m.online ? '' : 'offline'}`}>
                  <Avatar name={m.name} size={34} ring={m.leader ? 'var(--sun)' : undefined} />
                  <div className="grow">
                    <b>{m.name}{m.id === me?.id ? ' (you)' : ''} {m.leader && <Icon name="crown" size={13} fill className="crown" />}</b>
                    <small>{m.online ? STATUS_TEXT[m.status] + (m.where ? ` · ${m.where}` : '') : 'Offline'}</small>
                    <span className="badges">{m.leader && <Tag tone="sun" icon="crown">Leader</Tag>}{r.world && <Tag tone="sun" icon="globe">In my world</Tag>}{r.activity && <Tag tone="violet" icon="flag">In my activity</Tag>}</span>
                  </div>
                  {isLeader && m.id !== me?.id && (
                    <>
                      <Btn size="sm" variant="ghost" icon="crown" title="Make leader" onClick={() => void transferLeader(m.id)}>Lead</Btn>
                      <Btn size="sm" variant="danger" onClick={() => void kickFromParty(m.id)}>Kick</Btn>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          {party.invites.length > 0 && (
            <div className="pending">
              <small className="muted">Pending invites</small>
              {party.invites.map((i) => <Tag key={i.id} tone="grey" icon="chat">{i.name} · {fmtClock(i.expires - now)}</Tag>)}
            </div>
          )}
          <div className="invite-pick">
            <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Friend to invite">
              <option value="">Invite an online friend…</option>
              {invitable.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
            <Btn size="sm" icon="plus" disabled={!pick} why="Pick a friend first" onClick={() => { void inviteToParty(pick); setPick(''); }}>Invite</Btn>
          </div>
          <div className="link-box">
            {linkUrl ? (
              <>
                <input readOnly value={linkUrl} onFocus={(e) => e.currentTarget.select()} aria-label="Invite link" />
                <Btn size="sm" variant={copied ? 'aqua' : 'sun'} icon={copied ? 'check' : 'link'} onClick={() => void copyText(linkUrl).then((ok) => { setCopied(ok); if (!ok) pushNotice('Could not copy. Select the link and copy it manually.', 'bad'); setTimeout(() => setCopied(false), 1800); })}>{copied ? 'Copied' : 'Copy'}</Btn>
                <small className="muted">Link expires in {fmtClock(party.link!.expires - now)}</small>
              </>
            ) : (
              <Btn size="sm" variant="sun" icon="link" disabled={busy} why="Working…" onClick={() => void makeLink()}>Create invite link</Btn>
            )}
          </div>
          <div className="pchat">
            <div className="chat-log" ref={logRef}>
              {chat.length === 0 && <p className="muted">Party chat is quiet.</p>}
              {chat.map((c) => <p key={c.id}><b>{c.from}</b> {c.text}</p>)}
            </div>
            <form onSubmit={submit} className="chat-form"><input value={text} onChange={(e) => setText(e.target.value)} maxLength={200} placeholder="Message your party…" /><Btn size="sm" type="submit" disabled={!text.trim()} why="Type a message first" icon="chat">Send</Btn></form>
          </div>
          <Btn size="sm" variant="danger" icon="logout" onClick={() => void leaveParty()}>Leave party</Btn>
        </>
      )}
    </div>
  );
}

export function Social({ leaving }: { leaving: boolean }) {
  const [tab, setTab] = useState<Tab>('friends');
  const incoming = useGame((s) => s.social.incoming?.length ?? 0);
  const online = useGame((s) => (s.social.friends ?? []).filter((f) => f.status !== "offline").length);
  useEffect(() => { void refreshFriends(); void refreshParty(); const id = setInterval(() => { void refreshFriends(); void refreshParty(); }, 10000); return () => clearInterval(id); }, []);
  return (
    <Modal title="Friends & Party" icon="users" leaving={leaving} wide tall subtitle={`${online} friend${online === 1 ? '' : 's'} online`}>
      <div className="social-cols">
        <div className="social-left">
          <Tabs value={tab} onChange={setTab} tabs={[
            { id: 'friends', label: 'Friends', icon: 'heart' }, { id: 'requests', label: 'Requests', icon: 'chat', badge: incoming }, { id: 'find', label: 'Find players', icon: 'search' },
            { id: 'blocked', label: 'Blocked', icon: 'shield' }, { id: 'privacy', label: 'Privacy', icon: 'eye' },
          ]} />
          <div className="tab-pane" key={tab}>
            {tab === 'friends' && <FriendsTab />}
            {tab === 'requests' && <RequestsTab />}
            {tab === 'find' && <FindTab />}
            {tab === 'blocked' && <BlockedTab />}
            {tab === 'privacy' && <PrivacyTab />}
          </div>
        </div>
        <PartyPanel />
      </div>
    </Modal>
  );
}

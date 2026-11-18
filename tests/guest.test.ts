/**
 * No-login guest accounts, friend codes, parties between guests, claiming an account,
 * and the Sign in with Google / X endpoints (without real providers configured).
 */
process.env.BLOCKSHORE_TEST = '1';
process.env.LOG_LEVEL = 'warn';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

let srv: Awaited<ReturnType<typeof import('../apps/server/src/index.ts').startServer>>;
let base = '';
before(async () => {
  const { startServer } = await import('../apps/server/src/index.ts');
  srv = await startServer({ port: 0, memoryDb: true });
  base = `http://127.0.0.1:${srv.port}`;
});
after(async () => { await srv.stop('test'); });

async function call(m: string, p: string, t?: string, b?: unknown) {
  const r = await fetch(`${base}/api${p}`, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: `Bearer ${t}` } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) });
  return { s: r.status, j: await r.json() as any };
}
const device = () => randomBytes(18).toString('base64url');
async function guest(dev?: string) {
  const r = await call('POST', '/auth/auto', undefined, dev ? { device: dev } : {});
  assert.equal(r.s, 200);
  const me = await call('GET', '/me', r.j.token);
  return { token: r.j.token as string, ...me.j.user };
}

test('guest: each browser on the same network gets its own account; the same browser keeps it', async () => {
  const d1 = device(), d2 = device();
  const a = await guest(d1), b = await guest(d2), a2 = await guest(d1);
  assert.notEqual(a.id, b.id, 'two browsers sharing an IP must not share an account');
  assert.equal(a2.id, a.id);
  assert.equal(a.guest, true);
  assert.match(a.friendCode, /^\d{5}$/);
  assert.notEqual(a.friendCode, b.friendCode);
});

test('guest: friend by code, then party invite and accept between two guests on one network', async () => {
  const a = await guest(device()), b = await guest(device());
  const add = await call('POST', '/friends/add-code', a.token, { code: b.friendCode });
  assert.equal(add.j.result, 'sent');
  assert.equal((await call('POST', '/friends/add-code', a.token, { code: a.friendCode })).j.result, 'self');
  assert.equal((await call('POST', '/friends/add-code', a.token, { code: '00000' })).s, 404);
  assert.equal((await call('POST', '/friends/respond', b.token, { userId: a.id, accept: true })).s, 200);
  assert.deepEqual((await call('GET', '/friends', a.token)).j.friends.map((f: any) => f.id), [b.id]);
  await call('POST', '/party/create', a.token);
  assert.equal((await call('POST', '/party/invite', a.token, { userId: b.id })).s, 200);
  const inv = (await call('GET', '/party', b.token)).j.invites;
  assert.equal(inv.length, 1);
  const acc = await call('POST', '/party/accept', b.token, { partyId: inv[0].partyId });
  assert.equal(acc.s, 200);
  assert.deepEqual(acc.j.party.members.map((m: any) => m.id).sort(), [a.id, b.id].sort());
});

test('guest: party invite link works for a brand-new guest', async () => {
  const a = await guest(device()), c = await guest(device());
  await call('POST', '/party/create', a.token);
  const link = await call('POST', '/party/link', a.token);
  assert.equal(link.s, 200);
  const j = await call('POST', '/party/join-link', c.token, { token: link.j.token });
  assert.equal(j.s, 200);
  assert.ok(j.j.party.members.some((m: any) => m.id === c.id));
});

test('guest: claiming keeps the account and its friend code; sign-in providers are off unless configured', async () => {
  const a = await guest(device());
  const name = 'g' + randomBytes(5).toString('hex');
  const pw = randomBytes(12).toString('base64url');
  const c = await call('POST', '/auth/claim', a.token, { username: name, password: pw });
  assert.equal(c.s, 200);
  assert.equal(c.j.user.id, a.id);
  const me = (await call('GET', '/me', a.token)).j.user;
  assert.equal(me.guest, false);
  assert.equal(me.friendCode, a.friendCode);
  assert.deepEqual((await call('GET', '/auth/providers')).j, { google: null, x: null });
  assert.equal((await call('POST', '/auth/oauth', a.token, { provider: 'google', idToken: 'x' })).s, 400);
});

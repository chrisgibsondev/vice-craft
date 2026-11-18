/**
 * Headless protocol client used by the automated tests. It speaks the exact same
 * REST + WebSocket protocol as the browser client (no shortcuts), so tests exercise
 * the real server end to end.
 */
import WebSocket from 'ws';
import { PROTOCOL_VERSION, GAME_VERSION, type C2SMsg, type S2CMsg, type Snapshot, type Ent } from '../packages/shared/src/index.ts';

export class Bot {
  token = '';
  userId = '';
  ws: WebSocket | null = null;
  msgs: S2CMsg[] = [];
  snap: Snapshot | null = null;
  ents = new Map<string, Ent>();
  seq = 0;
  closed: { code: number; reason: string } | null = null;
  private waiters: { pred: (m: S2CMsg) => boolean; resolve: (m: S2CMsg) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];

  constructor(readonly base: string, readonly name: string, readonly password = 'correct-horse-9') {}

  async api<T = Record<string, unknown>>(method: 'GET' | 'POST', path: string, body?: unknown, expectOk = true): Promise<T & { status: number }> {
    const res = await fetch(`${this.base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (expectOk && !res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(data)}`);
    return { ...(data as T), status: res.status };
  }

  async register() {
    const r = await this.api<{ token: string; user: { id: string } }>('POST', '/auth/register', { username: this.name, password: this.password });
    this.token = r.token; this.userId = r.user.id;
    return this;
  }
  async login() {
    const r = await this.api<{ token: string; user: { id: string } }>('POST', '/auth/login', { username: this.name, password: this.password });
    this.token = r.token; this.userId = r.user.id;
    return this;
  }

  connect(opts: { version?: number } = {}): Promise<void> {
    this.closed = null;
    this.msgs = [];
    this.snap = null;
    this.ents.clear();
    const ws = new WebSocket(this.base.replace(/^http/, 'ws') + '/ws');
    this.ws = ws;
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as S2CMsg;
      if (m.t === 'snap') {
        this.snap = m;
        for (const e of m.ents) {
          const base = this.ents.get(e.id);
          if (!base) { if ((e as { k?: string }).k) this.ents.set(e.id, e); continue; }
          const out = { ...base } as Record<string, unknown>;
          for (const [k, v] of Object.entries(e)) { if (v === null) delete out[k]; else out[k] = v; }
          this.ents.set(e.id, out as unknown as typeof e);
        }
        for (const g of m.gone) this.ents.delete(g);
      } else this.msgs.push(m);
      for (const w of [...this.waiters]) if (w.pred(m)) { clearTimeout(w.timer); this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(m); }
    });
    ws.on('close', (code, reason) => { this.closed = { code, reason: reason.toString() }; });
    return new Promise((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ t: 'hello', v: opts.version ?? PROTOCOL_VERSION, gv: GAME_VERSION, token: this.token }));
        if (opts.version !== undefined && opts.version !== PROTOCOL_VERSION) { resolve(); return; }
        this.wait((m) => m.t === 'welcome', 5000).then(() => resolve(), reject);
      });
      ws.on('error', reject);
    });
  }

  send(m: C2SMsg) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); }

  wait<T extends S2CMsg = S2CMsg>(pred: (m: S2CMsg) => boolean, ms = 5000, includePast = false): Promise<T> {
    if (includePast) { const found = this.msgs.find(pred); if (found) return Promise.resolve(found as T); }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiters = this.waiters.filter((w) => w.timer !== timer); reject(new Error(`${this.name}: timed out waiting (${pred.toString().slice(0, 120)})`)); }, ms);
      this.waiters.push({ pred, resolve: resolve as (m: S2CMsg) => void, reject, timer });
    });
  }

  async waitSnap(pred: (s: Snapshot) => boolean, ms = 5000): Promise<Snapshot> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (this.snap && pred(this.snap)) return this.snap;
      await sleep(25);
    }
    throw new Error(`${this.name}: snapshot condition timed out`);
  }

  async joinWorld(target: 'auto' | 'party' | 'new' | { instance: string } = 'auto') {
    this.send({ t: 'world.join', target });
    const w = await this.wait<Extract<S2CMsg, { t: 'world' }>>((m) => m.t === 'world' || m.t === 'error', 8000);
    if ((w as unknown as { t: string }).t === 'error') throw new Error(`${this.name}: join failed ${JSON.stringify(w)}`);
    await this.waitSnap(() => true);
    return w;
  }

  /** drive inputs for n ticks at 20 Hz */
  async move(ticks: number, inp: Partial<{ mx: number; mz: number; yaw: number; pitch: number; jump: boolean; sprint: boolean; th: number; st: number; hb: boolean }>) {
    for (let i = 0; i < ticks; i++) {
      this.send({ t: 'input', seq: this.seq++, mx: inp.mx ?? 0, mz: inp.mz ?? 0, yaw: inp.yaw ?? 0, pitch: inp.pitch ?? 0, jump: inp.jump ?? false, sprint: inp.sprint ?? false, th: inp.th ?? 0, st: inp.st ?? 0, hb: inp.hb ?? false });
      await sleep(50);
    }
  }

  dev(cmd: Extract<C2SMsg, { t: 'dev' }>['cmd'], ...args: (string | number)[]) { this.send({ t: 'dev', cmd, args }); }
  close() { this.ws?.close(); }
  last<T extends S2CMsg['t']>(t: T): Extract<S2CMsg, { t: T }> | undefined {
    for (let i = this.msgs.length - 1; i >= 0; i--) if (this.msgs[i].t === t) return this.msgs[i] as Extract<S2CMsg, { t: T }>;
    return undefined;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let counter = 0;
export function uname(prefix: string) { return `${prefix}${Date.now().toString(36).slice(-4)}${counter++}`; }

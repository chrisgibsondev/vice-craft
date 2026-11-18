/** Tidepool: the phone's web browser. Address bar, back / forward / reload / home, bookmarks and a loading shimmer. */
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Icon } from '../Icons';
import { Skeleton, type SiteProps } from './common';
import { HOME_URL, SITES, resolve, type SiteDef } from './registry';

// History survives closing and reopening the phone (module scope), but not a page reload.
let HIST: string[] = [HOME_URL];
let IDX = 0;
const BM_KEY = 'blockshore.web.bookmarks';
function readBookmarks(): string[] {
  try { const v = JSON.parse(localStorage.getItem(BM_KEY) ?? 'null'); if (Array.isArray(v)) return v.filter((x) => typeof x === 'string'); } catch { /* storage unavailable */ }
  return SITES.filter((s) => s.defaultBookmark).map((s) => s.id);
}
function writeBookmarks(v: string[]) { try { localStorage.setItem(BM_KEY, JSON.stringify(v)); } catch { /* storage unavailable */ } }

const LOAD_MS = 420;

/** open the browser on a given address next time it mounts (used by the dev demo page) */
export function preloadBrowser(url: string) { HIST = [HOME_URL, url]; IDX = 1; }

function SiteTile({ site, onOpen, marked, onMark }: { site: SiteDef; onOpen: () => void; marked: boolean; onMark: () => void }) {
  return (
    <div className="wb-tilebox" style={{ ['--ac' as string]: site.color }}>
      <button type="button" className="wb-bm" onClick={onOpen}><span className="ico"><Icon name={site.icon} size={22} /></span><b>{site.title}</b><small>{site.tagline}</small></button>
      <button type="button" className={`wb-star ${marked ? 'on' : ''}`} aria-pressed={marked} aria-label={marked ? `Remove ${site.title} from bookmarks` : `Bookmark ${site.title}`} onClick={onMark}>
        <Icon name="star" size={13} />
      </button>
    </div>
  );
}

function HomePage({ nav, bookmarks, toggle }: SiteProps & { bookmarks: string[]; toggle: (id: string) => void }) {
  const marked = SITES.filter((s) => bookmarks.includes(s.id));
  const other = SITES.filter((s) => !bookmarks.includes(s.id));
  return (
    <div className="web wb-home">
      <header className="wb-hero"><div className="wb-logo">tide<b>pool</b></div><p>Your window onto Palmara. Please do not visit at low tide.</p></header>
      <h2 className="wb-h2">Bookmarks</h2>
      {marked.length === 0 && <p className="wb-note">No bookmarks yet. Tap the star on any site to pin it here.</p>}
      <div className="wb-tilegrid">{marked.map((s) => <SiteTile key={s.id} site={s} marked onOpen={() => nav(s.url)} onMark={() => toggle(s.id)} />)}</div>
      {other.length > 0 && <>
        <h2 className="wb-h2">Discover</h2>
        <div className="wb-tilegrid">{other.map((s) => <SiteTile key={s.id} site={s} marked={false} onOpen={() => nav(s.url)} onMark={() => toggle(s.id)} />)}</div>
      </>}
    </div>
  );
}

function SearchPage({ query, results, nav }: SiteProps & { query: string; results: SiteDef[] }) {
  return (
    <div className="web wb-search">
      <h2 className="wb-h2">Results for "{query}"</h2>
      {results.length === 0 ? (
        <div className="wb-404">
          <Icon name="globe" size={34} />
          <h1>404</h1>
          <p>Tidepool could not find that page. The tide may have taken it.</p>
          <button type="button" className="wb-btn solid" onClick={() => nav(HOME_URL)}>Back to Tidepool</button>
        </div>
      ) : <ul className="wb-results">{results.map((s) => <li key={s.id}><button type="button" onClick={() => nav(s.url)}><b>{s.title}</b><small>{s.url}</small><span>{s.tagline}</span></button></li>)}</ul>}
    </div>
  );
}

export function Browser() {
  const [, force] = useState(0);
  const [loading, setLoading] = useState(false);
  const [reloads, setReloads] = useState(0);
  const [bookmarks, setBookmarks] = useState<string[]>(readBookmarks);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const view = useRef<HTMLDivElement>(null);
  const entry = HIST[IDX];
  const r = resolve(entry);
  const host = r.kind === 'site' ? r.site.url : r.kind === 'home' ? HOME_URL : entry;
  const [text, setText] = useState(host);
  useEffect(() => setText(host), [host]);

  const startLoad = useCallback(() => {
    setLoading(true); clearTimeout(timer.current);
    timer.current = setTimeout(() => { setLoading(false); view.current?.scrollTo({ top: 0 }); }, LOAD_MS);
  }, []);
  useEffect(() => { startLoad(); return () => clearTimeout(timer.current); }, [startLoad]);

  const go = useCallback((raw: string) => {
    const res = resolve(raw);
    const next = res.kind === 'site' ? res.site.url : res.kind === 'home' ? HOME_URL : raw.trim();
    if (next === HIST[IDX] && res.kind !== 'search') { setReloads((n) => n + 1); startLoad(); return; }
    HIST = [...HIST.slice(0, IDX + 1), next].slice(-40); IDX = HIST.length - 1;
    force((n) => n + 1); startLoad();
  }, [startLoad]);
  const step = (d: -1 | 1) => { const n = IDX + d; if (n < 0 || n >= HIST.length) return; IDX = n; force((x) => x + 1); startLoad(); };
  const toggleBm = (id: string) => setBookmarks((b) => { const n = b.includes(id) ? b.filter((x) => x !== id) : [...b, id]; writeBookmarks(n); return n; });
  const submit = (e: FormEvent) => { e.preventDefault(); if (text.trim()) go(text); };

  const site = r.kind === 'site' ? r.site : null;
  const marked = site ? bookmarks.includes(site.id) : false;
  const canBack = IDX > 0, canFwd = IDX < HIST.length - 1;

  return (
    <div className="wb-browser">
      <div className="wb-toolbar" role="toolbar" aria-label="Browser controls">
        <button type="button" onClick={() => step(-1)} disabled={!canBack} aria-label="Back" title={canBack ? 'Back' : 'No earlier page'}><Icon name="back" size={16} /></button>
        <button type="button" onClick={() => step(1)} disabled={!canFwd} aria-label="Forward" title={canFwd ? 'Forward' : 'No later page'}><span style={{ display: 'inline-flex', transform: 'scaleX(-1)' }}><Icon name="back" size={16} /></span></button>
        <button type="button" onClick={() => go(entry)} aria-label="Reload" title="Reload"><Icon name="bolt" size={15} /></button>
        <button type="button" onClick={() => go(HOME_URL)} aria-label="Tidepool home" title="Home" disabled={r.kind === 'home'}><Icon name="home" size={16} /></button>
        <form className="wb-addr" onSubmit={submit}>
          <Icon name={site ? 'lock' : 'search'} size={13} />
          <input type="text" value={text} onChange={(e) => setText(e.target.value)} onFocus={(e) => e.target.select()} aria-label="Address bar" placeholder="Search or type an address" spellCheck={false} autoCapitalize="off" />
        </form>
        <button type="button" className={`wb-starbtn ${marked ? 'on' : ''}`} disabled={!site} onClick={() => site && toggleBm(site.id)} aria-pressed={marked} aria-label={marked ? 'Remove bookmark' : 'Bookmark this page'} title={site ? (marked ? 'Remove bookmark' : 'Bookmark this page') : 'Open a site to bookmark it'}><Icon name="star" size={15} /></button>
      </div>
      <div className={`wb-progress ${loading ? 'on' : ''}`} aria-hidden="true"><i /></div>
      <div className="wb-view" ref={view}>
        {loading ? <div className="wb-loading" aria-busy="true" style={{ ['--ac' as string]: site?.color ?? '#2ee6d6' }}><div className="wb-loadhead"><i /></div><Skeleton rows={6} tall /></div> : (
          <div key={`${entry}:${reloads}`} className="wb-page">
            {r.kind === 'home' && <HomePage nav={go} bookmarks={bookmarks} toggle={toggleBm} />}
            {r.kind === 'site' && <r.site.Component nav={go} />}
            {r.kind === 'search' && <SearchPage nav={go} query={r.query} results={r.results} />}
          </div>
        )}
      </div>
    </div>
  );
}

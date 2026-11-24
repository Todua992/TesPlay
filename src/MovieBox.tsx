import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowRight, Clapperboard, Flame, Film, Layers, Search, Sparkles, Trophy, UserRound, X } from 'lucide-react';
import { api, errorMessage } from './api';
import { Busy, Card, Empty, Modal, Row } from './components';
import type { Connection, Library, MediaItem } from './types';
import { itemKey } from './types';
import './moviebox.css';

type Tab = 'discover' | 'movies' | 'series' | 'anime' | 'rankings' | 'search';
type Shelf = { id: string; title: string; items: MediaItem[]; tab?: Tab };
type DiscoverResponse = { shelves: Shelf[]; suggestions?: string[] };
type BrowseResponse = { items: MediaItem[]; hasMore?: boolean };

const tabs: readonly [Exclude<Tab, 'search'>, string, typeof Sparkles][] = [
  ['discover', 'Discover', Sparkles],
  ['movies', 'Movies', Clapperboard],
  ['series', 'TV Series', Layers],
  ['anime', 'Anime', Flame],
  ['rankings', 'Rankings', Trophy],
];

export default function MovieBoxHub({
  connections,
  library,
  canManage,
  onDetails,
  onFavorite,
  onConnect,
  onReloadConnections,
}: {
  connections: Connection[];
  library: Library;
  canManage: boolean;
  onDetails: (item: MediaItem) => void;
  onFavorite: (item: MediaItem) => void;
  onConnect: (type?: string) => void;
  onReloadConnections: () => Promise<void>;
}) {
  const accounts = connections.filter((c) => c.type === 'moviebox');
  const [accountId, setAccountId] = useState(accounts[0]?.id || '');
  const c = accounts.find((a) => a.id === accountId) || accounts[0];

  const [tab, setTab] = useState<Tab>('discover');
  const [returnTab, setReturnTab] = useState<Exclude<Tab, 'search'>>('discover');
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');

  const [shelves, setShelves] = useState<Shelf[]>([]);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [enabling, setEnabling] = useState(false);

  const [accountModal, setAccountModal] = useState(false);
  const [loginAccount, setLoginAccount] = useState('');
  const [loginCode, setLoginCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState('');

  const favorites = useMemo(
    () => new Set([...library.favorites, ...(library.queue || [])].map(itemKey)),
    [library.favorites, library.queue],
  );
  const progress = useMemo(
    () => new Map(library.progress.map((p) => [itemKey(p.item), p.duration ? (p.seconds / p.duration) * 100 : 0])),
    [library.progress],
  );

  useEffect(() => {
    if (!c || tab !== 'discover') return;
    const controller = new AbortController();
    setBusy(true);
    setError('');
    void api<DiscoverResponse>(`/moviebox/${c.id}/discover`, undefined, undefined, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        setShelves(res.shelves || []);
        setSuggestions(res.suggestions || []);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [c?.id, tab]);

  useEffect(() => {
    if (!c || tab === 'discover') return;
    if (tab === 'search' && !query) {
      setItems([]);
      setHasMore(false);
      return;
    }
    const controller = new AbortController();
    setBusy(true);
    setError('');
    const path =
      tab === 'search'
        ? `/moviebox/${c.id}/search?${new URLSearchParams({ q: query, page: String(page) })}`
        : `/moviebox/${c.id}/browse?${new URLSearchParams({ tab, page: String(page) })}`;
    void api<BrowseResponse>(path, undefined, undefined, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        setItems((prev) => (page === 1 ? res.items : [...new Map([...prev, ...res.items].map((i) => [i.id, i])).values()]));
        setHasMore(Boolean(res.hasMore));
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorMessage(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [c?.id, tab, page, query]);

  const changeTab = (next: Exclude<Tab, 'search'>) => {
    setTab(next);
    setPage(1);
    setItems([]);
  };

  const runSearch = (text: string) => {
    const clean = text.trim();
    if (!clean) return;
    if (tab !== 'search') setReturnTab(tab);
    setDraft(clean);
    setQuery(clean);
    setPage(1);
    setItems([]);
    setTab('search');
  };

  const submitSearch = (e: FormEvent) => {
    e.preventDefault();
    runSearch(draft);
  };

  const exitSearch = () => {
    setDraft('');
    setQuery('');
    setItems([]);
    setPage(1);
    setTab(returnTab);
  };

  async function enableGuestMovieBox() {
    setEnabling(true);
    setError('');
    try {
      await api('/connections', { type: 'moviebox', name: 'MovieBox Pro', config: { authMode: 'guest' } });
      await onReloadConnections();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setEnabling(false);
    }
  }

  async function sendLoginCode(e: FormEvent) {
    e.preventDefault();
    if (!c || !loginAccount.trim()) return;
    setLoginBusy(true);
    setLoginError('');
    try {
      await api(`/moviebox/${c.id}/request-code`, { account: loginAccount.trim() });
      setCodeSent(true);
    } catch (err) {
      setLoginError(errorMessage(err));
    } finally {
      setLoginBusy(false);
    }
  }

  async function submitAccountLogin(e: FormEvent) {
    e.preventDefault();
    if (!c) return;
    setLoginBusy(true);
    setLoginError('');
    try {
      await api(`/moviebox/${c.id}/login`, { account: loginAccount.trim(), code: loginCode.trim() });
      setLoginCode('');
      setCodeSent(false);
      await onReloadConnections();
      setAccountModal(false);
    } catch (err) {
      setLoginError(errorMessage(err));
    } finally {
      setLoginBusy(false);
    }
  }

  async function switchToGuest() {
    if (!c) return;
    setLoginBusy(true);
    setLoginError('');
    try {
      await api(`/moviebox/${c.id}/logout`, {});
      await onReloadConnections();
      setAccountModal(false);
    } catch (err) {
      setLoginError(errorMessage(err));
    } finally {
      setLoginBusy(false);
    }
  }

  if (!c) {
    return (
      <section className="page-section mb-hub">
        <div className="mb-setup-card">
          <div className="mb-brand-mark" style={{ margin: '0 auto', width: 44, height: 34, fontSize: 18 }}>
            M
          </div>
          <h2>MovieBox Pro</h2>
          <p>
            Stream movies, TV series, and anime with subtitles and quality selection right inside TesPlay.
            {canManage ? ' Start immediately with instant guest access or sign in with your account.' : ' Ask your server owner to enable MovieBox Pro.'}
          </p>
          {error && <p className="form-error" role="alert">{error}</p>}
          {canManage && (
            <div className="mb-setup-actions">
              <button className="button primary" disabled={enabling} onClick={() => void enableGuestMovieBox()}>
                <Film size={17} />
                {enabling ? 'Enabling…' : 'Enable MovieBox Pro'}
              </button>
              <button className="button ghost" onClick={() => onConnect('moviebox')}>
                Configure in Sources
              </button>
            </div>
          )}
        </div>
      </section>
    );
  }

  return (
    <section className="page-section mb-hub">
      <header className="yt-top">
        <span className="yt-brand mb-brand">
          <span className="mb-brand-mark" aria-hidden="true">M</span>
          <span>MovieBox Pro</span>
        </span>
        <form className="yt-search" role="search" onSubmit={submitSearch}>
          <Search size={19} aria-hidden="true" />
          <input
            aria-label="Search MovieBox Pro"
            placeholder="Search movies, TV series, anime…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            enterKeyHint="search"
          />
          {(draft || tab === 'search') && (
            <button type="button" className="yt-search-clear" aria-label="Clear search" onClick={exitSearch}>
              <X size={18} />
            </button>
          )}
          <button className="yt-search-go mb-search-go" aria-label="Search">
            <ArrowRight size={19} />
          </button>
        </form>
        <div className="youtube-account">
          {accounts.length > 1 && (
            <select
              aria-label="MovieBox connection"
              value={c.id}
              onChange={(e) => {
                setAccountId(e.target.value);
                setPage(1);
                setItems([]);
              }}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className="mb-account-pill"
            onClick={() => {
              setLoginError('');
              setLoginCode('');
              setCodeSent(false);
              setAccountModal(true);
            }}
            title="MovieBox account"
          >
            <span className="mb-account-dot" aria-hidden="true" />
            <UserRound size={15} />
            <span>{c.authMode === 'account' ? 'Account' : 'Guest'}</span>
          </button>
        </div>
      </header>

      {tab !== 'search' && (
        <div className="mb-tabs-row">
          <nav className="youtube-tabs yt-tabs" aria-label="MovieBox sections">
            {tabs.map(([value, label, Icon]) => (
              <button
                key={value}
                className={tab === value ? 'selected' : ''}
                aria-pressed={tab === value}
                onClick={() => changeTab(value)}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
          </nav>
        </div>
      )}

      {suggestions.length > 0 && (tab === 'discover' || tab === 'search') && (
        <div className="mb-suggestions" aria-label="Trending searches">
          <span className="mb-suggestions-label">Trending:</span>
          {suggestions.map((term) => (
            <button key={term} type="button" className="mb-chip" onClick={() => runSearch(term)}>
              {term}
            </button>
          ))}
        </div>
      )}

      {tab === 'search' && (
        <div className="yt-results-head">
          <h2>
            Results for <q>{query}</q>
          </h2>
          <button type="button" className="text-button" onClick={exitSearch}>
            Back to {tabs.find(([t]) => t === returnTab)?.[1] || 'Discover'}
          </button>
        </div>
      )}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}

      {tab === 'discover' ? (
        <>
          {busy && !shelves.length && <Busy label="Loading MovieBox Pro…" />}
          {shelves.map((shelf) => (
            <Row
              key={shelf.id}
              title={shelf.title}
              items={shelf.items}
              onOpen={onDetails}
              onFavorite={onFavorite}
              isSaved={(i) => favorites.has(itemKey(i))}
              progress={(i) => progress.get(itemKey(i))}
              more={shelf.tab && shelf.tab !== 'discover' ? () => changeTab(shelf.tab as Exclude<Tab, 'search'>) : undefined}
            />
          ))}
          {!busy && !shelves.length && !error && (
            <Empty title="Nothing loaded yet">Try refreshing or searching for a title above.</Empty>
          )}
        </>
      ) : (
        <>
          {busy && !items.length && <Busy label="Loading titles…" />}
          {items.length > 0 && (
            <div className="catalog-grid">
              {items.map((item) => (
                <Card
                  key={itemKey(item)}
                  item={item}
                  onOpen={onDetails}
                  onFavorite={onFavorite}
                  saved={favorites.has(itemKey(item))}
                  progress={progress.get(itemKey(item))}
                />
              ))}
            </div>
          )}
          {!busy && !items.length && !error && (
            <Empty title={tab === 'search' ? `No matches for “${query}”` : 'No titles found'}>
              Try another search term or switch categories above.
            </Empty>
          )}
          {hasMore && (
            <div className="mb-load-more">
              <button
                type="button"
                className="button ghost"
                disabled={busy}
                onClick={() => setPage((p) => p + 1)}
              >
                {busy ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}

      {accountModal && (
        <Modal title="MovieBox Pro Account" onClose={() => setAccountModal(false)}>
          <p className="form-help">
            {c.summary || 'Using instant Guest access.'} MovieBox signs you in with a verification code sent to your email or phone. Or continue in Guest mode.
          </p>
          {canManage ? (
            <form onSubmit={(e) => void (codeSent ? submitAccountLogin(e) : sendLoginCode(e))}>
              <label>
                Email or phone
                <input
                  value={loginAccount}
                  onChange={(e) => { setLoginAccount(e.target.value); if (codeSent) { setCodeSent(false); setLoginCode(''); } }}
                  placeholder="you@example.com"
                  autoComplete="username"
                  required
                />
              </label>
              {codeSent && (
                <label>
                  Verification code
                  <input
                    value={loginCode}
                    onChange={(e) => setLoginCode(e.target.value)}
                    placeholder="6-digit code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                    required
                  />
                </label>
              )}
              {codeSent && <p className="form-help" role="status">Code sent. Check your {loginAccount.includes('@') ? 'email' : 'phone'} and enter it above.</p>}
              {loginError && <p className="form-error" role="alert">{loginError}</p>}
              <div className="form-actions">
                {!codeSent ? (
                  <button type="submit" className="button primary" disabled={loginBusy || !loginAccount.trim()}>
                    {loginBusy ? 'Sending…' : 'Send code'}
                  </button>
                ) : (
                  <>
                    <button type="submit" className="button primary" disabled={loginBusy || !loginCode.trim()}>
                      {loginBusy ? 'Signing in…' : 'Sign in'}
                    </button>
                    <button type="button" className="button ghost" disabled={loginBusy} onClick={(e) => void sendLoginCode(e as unknown as FormEvent)}>
                      Resend code
                    </button>
                  </>
                )}
                {c.authMode === 'account' && (
                  <button type="button" className="button ghost" disabled={loginBusy} onClick={() => void switchToGuest()}>
                    Use Guest mode
                  </button>
                )}
              </div>
            </form>
          ) : (
            <p className="form-help">Your server owner manages this connection.</p>
          )}
        </Modal>
      )}
    </section>
  );
}

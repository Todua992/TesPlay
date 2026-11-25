import './home.css';
import { RefreshButton } from "./components";
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Plus, ArrowUpRight, Cable } from 'lucide-react';
import { api } from './api';
import { Busy, Card, Empty, Row, YouTubeLogo } from './components';
import { services } from './catalog';
import { itemKey } from './types';
import type { Connection, Library, MediaItem } from './types';
import HeroCarousel from './HeroCarousel';
import { bundleIptvHomeShelves, homeFeatures, loadHomeConnection, mergeHomeResult, readHomePreview, writeHomePreview } from './home-library';
import type { HomeCatalog, HomeResult, HomeShelf } from './home-library';
import { filterLibraryForYouTubeVisibility, filterYouTubeShelves } from './youtube-visibility';
export default function Home({ cacheIdentity, connections, library: rawLibrary, hideYouTubeShorts = false, signedIn, query, connectionsReady, connectionsError, onReloadConnections, canManage, onOpen, onFavorite, onDetails, onBrowse, onConnect, onNavigate, onUnavailable }: {
  cacheIdentity:string; connections: Connection[]; library: Library; hideYouTubeShorts?: boolean; signedIn: boolean; query: string; connectionsReady: boolean; connectionsError: string; onReloadConnections: () => Promise<void>; canManage: boolean;
  onOpen: (item: MediaItem) => void; onFavorite: (item: MediaItem) => void; onDetails: (item: MediaItem) => void;
  onBrowse: (c: Connection, parent?: MediaItem, kind?: string, channel?: {id:string;title:string}, category?:string) => void; onConnect: (type?: string) => void;
  onNavigate: (view: 'connections' | 'movies' | 'apps' | 'moviebox' | 'list') => void; onUnavailable: () => void;
}) {
  const library = useMemo(() => filterLibraryForYouTubeVisibility(rawLibrary, hideYouTubeShorts, connections), [rawLibrary, hideYouTubeShorts, connections]);
  const [results, setResults] = useState<Record<string, HomeResult>>({});
  const [pending, setPending] = useState<string[]>([]), [refresh, setRefresh] = useState(0);
  const lastRefresh=useRef(refresh);
  const starredChannelsKey=(library.stars||[]).map(s=>`${s.connectionId}:${s.id}`).join(',');
  const connected = signedIn && connections.length > 0;
  useEffect(() => {
    const controller = new AbortController();
    if (!connected) { setResults({}); setPending([]); return () => controller.abort(); }
    const force=refresh!==lastRefresh.current;lastRefresh.current=refresh;
    const cachedResults:Record<string,HomeResult>={};
    for(const c of connections)try{const value=readHomePreview(cacheIdentity,c,library.stars||[],sessionStorage);if(value)cachedResults[c.id]=value;}catch{/* Storage may be disabled. */}
    setResults(previous => Object.fromEntries(connections.filter(c => cachedResults[c.id]||force&&previous[c.id]).map(c => [c.id, cachedResults[c.id]||previous[c.id]])));
    const requested=connections.filter(c=>force||!cachedResults[c.id]);
    setPending(requested.map(c => c.id));
    for (const c of requested) void loadHomeConnection(c, (path, signal) => api<HomeCatalog>(path, undefined, undefined, signal), controller.signal, library.stars || [], force)
      .then(result => { if (!controller.signal.aborted) setResults(previous => {
        const merged=mergeHomeResult(previous[c.id],result);
        try{writeHomePreview(cacheIdentity,c,library.stars||[],merged,sessionStorage);}catch{/* Storage may be disabled. */}
        return { ...previous, [c.id]: merged };
      }); })
      .finally(() => { if (!controller.signal.aborted) setPending(previous => previous.filter(id => id !== c.id)); })
      .catch(() => { /* An aborted request belongs to the previous home/profile. */ });
    return () => controller.abort();
  }, [cacheIdentity, connected, connections, refresh, starredChannelsKey]);
  const visibleResults = useMemo(() => Object.fromEntries(Object.entries(results).map(([id, result]) => [id, {
    ...result, shelves: filterYouTubeShelves(result.shelves, hideYouTubeShorts, connections, rawLibrary.progress),
  }])), [results, hideYouTubeShorts, connections, rawLibrary.progress]);
  const shelves = useMemo(() => bundleIptvHomeShelves(connections.flatMap(c => visibleResults[c.id]?.shelves || []),connections), [connections, visibleResults]);
  // The spotlight leaves out titles this profile has watched or is watching.
  const featured = useMemo(() => { const seen = new Set(rawLibrary.progress.map(p => itemKey(p.item))); return connected ? homeFeatures(shelves, item => seen.has(itemKey(item))) : []; }, [connected, shelves, rawLibrary.progress]);
  const spotlight = shelves.find(shelf => shelf.featured && shelf.items.some(item => featured.includes(item)));
  const favorites = new Set([...library.favorites,...(library.queue||[])].map(itemKey));
  const progress = new Map(library.progress.map(p => [itemKey(p.item), p.duration ? p.seconds / p.duration * 100 : 0]));
  const continuing = library.progress.filter(p => p.duration > 0 && p.seconds > 5 && p.seconds / p.duration < 0.97).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 12);
  const viewAll = (shelf: HomeShelf) => { const c = connections.find(c => c.id === shelf.connectionId); if (c) onBrowse(c, shelf.parent, shelf.kind, shelf.channel, shelf.category); };
  const searchItems = [...new Map([...(connected ? shelves.flatMap(s => s.items) : []), ...library.favorites, ...library.progress.map(p => p.item)].map(i => [itemKey(i), i])).values()]
    .filter(i => `${i.title} ${i.categoryLabel || ''} ${i.source} ${i.subtitle || ''}`.toLowerCase().includes(query.toLowerCase()));
  if (signedIn && (!connectionsReady || (connectionsError && !connections.length))) return <section className="page-section home-loading">
    <span className="eyebrow">Your library</span><h1>Your collection, together</h1>
    {connectionsError ? <div className="home-source-status" role="alert"><div><strong>Your connections could not load</strong><p>{connectionsError}</p></div><button className="button ghost" onClick={() => void onReloadConnections().catch(() => {})}>Try again</button></div> : <Busy label="Loading your connections…" />}
  </section>;
  return <>
    {query ? <section className="page-section">
      <div className="page-heading"><div><span className="eyebrow">Your library</span><h1>Results for “{query}”</h1><p>Search within a connected library for its complete collection</p></div></div>
      {pending.length > 0 && <Busy label="Loading your connected libraries…" />}
      {searchItems.length ? <div className="catalog-grid">{searchItems.map(item => <Card key={itemKey(item)} item={item} onOpen={onOpen} onFavorite={onFavorite} saved={favorites.has(itemKey(item))} progress={progress.get(itemKey(item))} />)}</div> : !pending.length && <Empty title="No matches in your home collection">Browse a connected library to search all its titles.</Empty>}
    </section> : <>
      {featured.length ? <HeroCarousel items={featured} saved={item => favorites.has(itemKey(item))} onOpen={onOpen} onDetails={onDetails} onFavorite={onFavorite}
        kicker={item => spotlight?.items.includes(item) ? spotlight.title : `Featured from ${item.source}`} /> : <section className="page-section home-loading">
        <span className="eyebrow">Home</span>
        <h1>{connections.length ? 'Your library' : 'Connect your first library'}</h1>
        {pending.length ? <Busy label="Loading your collection…" /> : <p>{connections.length ? 'No featured titles yet. Browse a connection below.' : canManage ? 'Bring your films, shows and channels into TesPlay. Start with a library below.' : 'Your server owner can share connections with your account.'}</p>}
      </section>}
      <div className="home-content">
        <section className="worlds">
          <div className="section-heading"><h2>Your libraries</h2><div className="row-actions">{connected && <RefreshButton label="Refresh home libraries" disabled={pending.length > 0} onRefresh={() => setRefresh(value => value + 1)} />}<button className="text-button" onClick={() => onNavigate('connections')}>{canManage ? 'Manage connections' : 'Shared connections'} <ArrowUpRight size={16} /></button></div></div>
          <div className="service-rail">{services.filter(s => canManage || connections.some(c => c.type === s.id || s.id === 'xtream' && c.type === 'm3u')).map(s => {
            const c = connections.find(c => c.type === s.id || (s.id === 'xtream' && c.type === 'm3u'));
            return <button key={s.id} className={`service-tile service-${s.id}`} onClick={() => s.id === 'crunchyroll' ? onUnavailable() : s.id === 'youtube' ? onNavigate('apps') : s.id === 'moviebox' && !c ? onNavigate('moviebox') : c ? onBrowse(c) : onConnect(s.id)}>
              <span className={`service-logo ${s.id}`} style={{ color: s.color }}>{s.id === 'youtube' ? <YouTubeLogo /> : s.letters}</span>
              <span className="service-copy"><span className="service-label">{s.name}</span><span className="service-state">{s.id === 'crunchyroll' ? 'Unavailable' : c ? 'Connected' : s.id === 'youtube' ? 'Browse videos' : s.id === 'moviebox' ? 'Browse catalog' : 'Connect'}</span></span>
              {c ? <Check size={16} /> : <ArrowUpRight size={16} />}
            </button>;
          })}</div>
        </section>
        {continuing.length > 0 && <Row presentation="continue" title="Continue watching" items={continuing.map(p => p.item)} onOpen={onOpen} onFavorite={onFavorite} isSaved={i => favorites.has(itemKey(i))} progress={i => progress.get(itemKey(i))} />}
        {connected ? connections.map(c => <div key={c.id}>
          {visibleResults[c.id]?.issues.map((issue, index) => <div className="home-source-status" role="status" key={index}><div><strong>{c.type === 'youtube' ? 'YouTube' : c.name}</strong><p>{issue}</p></div><button className="text-button" onClick={() => onBrowse(c)}>Open connection <ArrowUpRight size={16} /></button></div>)}
          {!pending.includes(c.id) && visibleResults[c.id] && !visibleResults[c.id].issues.length && !visibleResults[c.id].shelves.some(s => s.items.length) && <div className="home-source-status"><div><strong>{c.type === 'youtube' ? 'YouTube' : c.name}</strong><p>{hideYouTubeShorts && results[c.id]?.shelves.some(s => s.items.length) ? 'Short videos are hidden. Change this in Settings or browse another library.' : c.type === 'youtube' ? 'Star subscriptions in YouTube to show their latest uploads here.' : 'No titles in this preview yet.'}</p></div><button className="text-button" onClick={() => onBrowse(c)}>Browse library <ArrowUpRight size={16} /></button></div>}
        </div>) : canManage ? null : <Empty title="No libraries shared yet">Your server owner can share connections with your account.</Empty>}
        {connected && shelves.filter(s => s.items.length).map(shelf => <Row key={shelf.id} emphasis={shelf.emphasis} title={shelf.title} items={shelf.items} onOpen={onOpen} onFavorite={onFavorite} isSaved={i => favorites.has(itemKey(i))} progress={i => progress.get(itemKey(i))} more={() => viewAll(shelf)} />)}
        {library.favorites.length > 0 && <Row title="My list" items={library.favorites} onOpen={onOpen} onFavorite={onFavorite} isSaved={i => favorites.has(itemKey(i))} more={() => onNavigate('list')} />}
        <div className="discovery-row"><button onClick={() => onNavigate('apps')} className="discovery-card"><YouTubeLogo /><div><span className="small-caps">YouTube</span><h3>Your channels, on this screen</h3><p>Browse subscriptions or play a video link</p></div><ArrowUpRight size={20} /></button></div>
        {canManage && !connections.length && <div className="connect-banner"><div><Cable size={24} /><div><h3>Add your first library</h3><p>Connect Plex, IPTV, Google Drive or Stremio</p></div></div><button className="button ghost" onClick={() => onNavigate('connections')}>Add a connection <Plus size={18} /></button></div>}
      </div>
    </>}
  </>;
}

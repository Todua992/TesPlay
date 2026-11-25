import { RefreshButton } from "./components";
import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Search, Play, Users, Clock, ListVideo, Sparkles, ArrowRight, Star, X, ChevronRight, Settings2 } from 'lucide-react';
import { api, ApiError, errorMessage, youtubeId } from './api';
import { Busy, Card, Empty, Row, YouTubeLogo } from './components';
import type { Connection, Library, MediaItem, Starred } from './types';
import { itemKey } from './types';
import { filterLibraryForYouTubeVisibility, filterYouTubeItems, filterYouTubeShelves } from './youtube-visibility';

type Pane = 'suggestions' | 'subscriptions' | 'playlists' | 'history' | 'search';
type BrowsePane = Exclude<Pane, 'search'>;
type Collection = { id:string;title:string;thumbnail?:string;videoCount?:number };
type ChannelRow = {id:string;title:string;items:MediaItem[]};
type Cursor = {token?:string;offset?:number};
type Result = {items?:MediaItem[];rows?:ChannelRow[];channels?:Collection[];playlists?:Collection[];channelRows?:ChannelRow[];nextPageToken?:string|null;nextOffset?:number|null;partial?:boolean;total?:number;totalChannels?:number};

const tabs=[['suggestions','For you',Sparkles],['subscriptions','Subscriptions',Users],['playlists','Playlists',ListVideo],['history','Watched',Clock]] as const;
const paneLabel:Record<BrowsePane,string>={suggestions:'For you',subscriptions:'Subscriptions',playlists:'Playlists',history:'Watched'};
const nextCursor=(r:Result):Cursor|null=>r.nextPageToken?{token:r.nextPageToken}:r.nextOffset!=null?{offset:r.nextOffset}:null;
const cursorParams=(cursor:Cursor|null)=>{const p=new URLSearchParams();if(cursor?.token)p.set('pageToken',cursor.token);if(cursor?.offset!==undefined)p.set('offset',String(cursor.offset));return p;};
const merge=<T extends {id:string}>(previous:T[],incoming:T[]|undefined,append:boolean)=>[...new Map([...(append?previous:[]),...(incoming||[])].map(i=>[i.id,i])).values()];

function CollectionStrip({items,kind,selectedId,onSelect,isStarred,onStar,onMore,busy}:{
  items:Collection[];kind:'channel'|'playlist';selectedId?:string;onSelect:(value:Collection)=>void;isStarred?:(id:string)=>boolean;onStar?:(value:Collection)=>void;onMore?:()=>void;busy?:boolean;
}) {
  return <div className={`yt-strip ${kind==='playlist'?'yt-strip-playlists':''}`} role="list">
    {items.map(value=>{
      const selected=value.id===selectedId,star=isStarred?.(value.id)||false;
      return <div className={`yt-chip ${selected?'selected':''}`} role="listitem" key={value.id}>
        <button className="yt-chip-main" aria-pressed={selected} title={value.title} onClick={()=>onSelect(value)}>
          {value.thumbnail?<img src={value.thumbnail} alt="" loading="lazy"/>:<span className="yt-chip-fallback">{kind==='playlist'?<ListVideo size={22}/>:<Users size={22}/>}</span>}
          <span className="yt-chip-title">{value.title}</span>
        </button>
        {onStar&&<button className={`yt-chip-star ${star?'on':''}`} aria-label={`${star?'Unstar':'Star'} ${value.title}`} aria-pressed={star} onClick={()=>onStar(value)}><Star size={13} fill={star?'currentColor':'none'}/></button>}
      </div>;
    })}
    {onMore&&<div className="yt-chip" role="listitem"><button className="yt-chip-main yt-chip-more" disabled={busy} onClick={onMore}><span className="yt-chip-fallback"><ChevronRight size={22}/></span><span className="yt-chip-title">More</span></button></div>}
  </div>;
}

export default function YouTubeHub({connections,library:rawLibrary,hideYouTubeShorts = false,onOpen,onFavorite,onConnect,onStar,onClearQueue,onRemoveQueue,initialConnectionId,initialChannel}: {
  connections:Connection[];library:Library;hideYouTubeShorts?:boolean;onOpen:(item:MediaItem)=>void;onFavorite:(item:MediaItem)=>void;onConnect:()=>void;onStar:(value:Starred)=>void;onClearQueue:()=>void;onRemoveQueue:(item:MediaItem)=>void;initialConnectionId?:string;initialChannel?:Collection;
}) {
  const library=useMemo(()=>filterLibraryForYouTubeVisibility(rawLibrary,hideYouTubeShorts,connections),[rawLibrary,hideYouTubeShorts,connections]);
  const accounts=connections.filter(c=>c.type==='youtube');
  const [accountId,setAccountId]=useState(initialConnectionId||accounts[0]?.id||'');
  const c=accounts.find(a=>a.id===accountId)||accounts[0];
  const [pane,setPane]=useState<Pane>(initialChannel?'subscriptions':'suggestions');
  const [returnPane,setReturnPane]=useState<BrowsePane>('suggestions');
  const [selection,setSelection]=useState<(Collection&{kind:'channel'|'playlist'})|null>(initialChannel?{...initialChannel,kind:'channel'}:null);
  const [draft,setDraft]=useState(''),[query,setQuery]=useState('');
  // Videos (feed, search results or the selected channel/playlist)
  const [cursor,setCursor]=useState<Cursor|null>(null),[next,setNext]=useState<Cursor|null>(null);
  const [items,setItems]=useState<MediaItem[]>([]),[channelRows,setChannelRows]=useState<ChannelRow[]>([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[partial,setPartial]=useState(false),[refresh,setRefresh]=useState(0);
  // Channel / playlist strip
  const [collections,setCollections]=useState<Collection[]>([]),[collCursor,setCollCursor]=useState<Cursor|null>(null),[collNext,setCollNext]=useState<Cursor|null>(null);
  const [collBusy,setCollBusy]=useState(false),[total,setTotal]=useState<number|null>(null);
  const [reconnect,setReconnect]=useState(false);
  // "You may like" and "Popular in Denmark" rows: charts, which need no Google account.
  const [popular,setPopular]=useState<ChannelRow[]>([]),[popularBusy,setPopularBusy]=useState(false);

  const personal=c?.authMode==='oauth'&&c.oauthAuthorized;
  const searching=pane==='search';
  const stripPane=pane==='subscriptions'||pane==='playlists';
  const needsGoogle=!selection&&['subscriptions','playlists'].includes(pane)&&!personal;
  const rawHistory=rawLibrary.progress.filter(p=>accounts.some(a=>a.id===p.item.connectionId));
  const history=library.progress.filter(p=>accounts.some(a=>a.id===p.item.connectionId));
  const queue=library.queue||[],queued=new Set(queue.map(itemKey));
  const starred=(id:string)=>library.stars?.some(s=>s.connectionId===c?.id&&s.kind==='channel'&&s.id===id)||false;
  const starredKey=(library.stars||[]).filter(s=>s.connectionId===c?.id&&s.kind==='channel').map(s=>s.id).join(',');
  const progress=new Map(history.map(p=>[itemKey(p.item),p.duration?p.seconds/p.duration*100:0]));
  const fail=(e:unknown)=>{setError(errorMessage(e));setReconnect(e instanceof ApiError&&e.status===409&&c?.authMode==='oauth');};

  useEffect(()=>{if(initialChannel){setPane('subscriptions');setSelection({...initialChannel,kind:'channel'});setCursor(null);}},[initialChannel]);

  // Load the channel/playlist strip for Subscriptions and Playlists.
  useEffect(()=>{
    const controller=new AbortController();
    if(!collCursor){setCollections([]);setTotal(null);}setCollNext(null);
    if(!c||!stripPane||!personal){setCollBusy(false);return()=>controller.abort();}
    setCollBusy(true);
    void api<Result>(`/youtube/${c.id}/${pane}?${cursorParams(collCursor)}`,undefined,undefined,controller.signal).then(r=>{
      if(controller.signal.aborted)return;
      setCollections(previous=>merge(previous,r.channels||r.playlists,!!collCursor));
      setCollNext(nextCursor(r));setTotal(r.total??r.totalChannels??null);setPartial(!!r.partial);
    }).catch(e=>{if(!controller.signal.aborted)fail(e);}).finally(()=>{if(!controller.signal.aborted)setCollBusy(false);});
    return()=>controller.abort();
  },[c?.id,c?.authMode,c?.oauthAuthorized,pane,collCursor,refresh]);

  useEffect(()=>{
    const controller=new AbortController();
    if(!c||pane!=='suggestions'){setPopularBusy(false);return()=>controller.abort();}
    setPopularBusy(true);
    void api<Result>(`/youtube/${c.id}/popular`,undefined,undefined,controller.signal).then(r=>{if(!controller.signal.aborted)setPopular(r.rows||[]);})
      .catch(e=>{if(!controller.signal.aborted)fail(e);}).finally(()=>{if(!controller.signal.aborted)setPopularBusy(false);});
    return()=>controller.abort();
  },[c?.id,pane,refresh]);

  // Load videos: feed, search results, or the selected channel/playlist.
  const feedStars=pane==='suggestions'?starredKey:'';
  useEffect(()=>{
    const controller=new AbortController();
    if(!cursor){setItems([]);setChannelRows([]);}setError('');setReconnect(false);if(!stripPane)setPartial(false);setNext(null);
    const waitingForStrip=stripPane&&!selection;
    if(!c||pane==='history'||needsGoogle||waitingForStrip||(searching&&!query&&!selection)||(pane==='suggestions'&&!personal)){setBusy(false);return()=>controller.abort();}
    const params=cursorParams(cursor);if(searching)params.set('q',query);
    const path=selection?`${selection.kind}/${encodeURIComponent(selection.id)}/videos`:searching?'search':'feed';
    setBusy(true);
    void api<Result>(`/youtube/${c.id}/${path}?${params}`,undefined,undefined,controller.signal).then(r=>{
      if(controller.signal.aborted)return;
      setItems(previous=>merge(previous,r.items,!!cursor));
      setChannelRows(previous=>merge(previous,r.channelRows,!!cursor));
      if(searching&&!selection)setCollections(previous=>merge(previous,r.channels,!!cursor));
      setNext(nextCursor(r));if(!stripPane)setPartial(!!r.partial);
    }).catch(e=>{if(!controller.signal.aborted)fail(e);}).finally(()=>{if(!controller.signal.aborted)setBusy(false);});
    return()=>controller.abort();
  },[c?.id,c?.authMode,c?.oauthAuthorized,pane,selection?.id,selection?.kind,query,cursor,refresh,needsGoogle,feedStars]);

  const ordered=useMemo(()=>[...collections].sort((a,b)=>pane==='subscriptions'?Number(starred(b.id))-Number(starred(a.id)):0),[collections,pane,starredKey]);

  // Subscriptions/Playlists: open the first (starred first) entry automatically so videos show right away.
  useEffect(()=>{if(stripPane&&!selection&&ordered.length)setSelection({...ordered[0],kind:pane==='playlists'?'playlist':'channel'});},[stripPane,selection,ordered,pane]);

  const changePane=(value:BrowsePane)=>{setPane(value);setSelection(null);setCursor(null);setCollCursor(null);setCollections([]);};
  const choose=(value:Collection,kind:'channel'|'playlist')=>{
    if(searching&&selection?.id===value.id){setSelection(null);setCursor(null);return;}
    setSelection({...value,kind});setCursor(null);
  };
  const submitSearch=(e:FormEvent)=>{
    e.preventDefault();const text=draft.trim();if(!text)return;
    const id=youtubeId(text);if(id&&c){onOpen({id,title:'YouTube video',type:'video',source:'YouTube',providerType:'youtube',connectionId:c.id});return;}
    if(!searching)setReturnPane(pane as BrowsePane);
    setPane('search');setSelection(null);setCursor(null);setCollections([]);setQuery(text);
  };
  const exitSearch=()=>{setDraft('');setQuery('');changePane(returnPane);};

  const unfiltered=pane==='history'&&!selection?rawHistory.map(p=>p.item):items;
  const visible=filterYouTubeItems(unfiltered,hideYouTubeShorts,connections,rawLibrary.progress),visibleRows=filterYouTubeShelves(channelRows,hideYouTubeShorts,connections,rawLibrary.progress);
  const showStrip=(stripPane||(searching&&!!query))&&collections.length>0;
  const stripKind:'channel'|'playlist'=pane==='playlists'?'playlist':'channel';
  const videoGrid=visible.length>0&&<div className="catalog-grid youtube-video-grid">{visible.map(item=><Card key={itemKey(item)} item={item} onOpen={onOpen} onFavorite={onFavorite} saved={queued.has(itemKey(item))} progress={progress.get(itemKey(item))}/>)}</div>;
  const forYou=pane==='suggestions'&&!selection;
  const popularRows=forYou?filterYouTubeShelves(popular,hideYouTubeShorts,connections,rawLibrary.progress).filter(row=>row.items.length):[];
  const continuing=forYou&&c?history.filter(p=>p.item.connectionId===c.id&&p.duration>0&&p.seconds>5&&p.seconds/p.duration<0.97).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).slice(0,12).map(p=>p.item):[];
  const rowProps={onOpen,onFavorite,isSaved:(i:MediaItem)=>queued.has(itemKey(i)),progress:(i:MediaItem)=>progress.get(itemKey(i))};
  const anyBusy=busy||collBusy||(pane==='suggestions'&&popularBusy);

  return <section className="page-section youtube-hub yt-hub">
    <header className="yt-top">
      <span className="yt-brand"><YouTubeLogo/><span>YouTube</span></span>
      {!searching&&<nav className="youtube-tabs yt-tabs" aria-label="YouTube sections">{tabs.map(([value,label,Icon])=><button key={value} className={pane===value?'selected':''} aria-pressed={pane===value} onClick={()=>changePane(value)}><Icon size={15}/>{label}</button>)}</nav>}
      <form className="yt-search" role="search" onSubmit={submitSearch}>
        <Search size={19} aria-hidden="true"/>
        <input aria-label="Search YouTube or paste a video link" placeholder="Search YouTube or paste a link" value={draft} onChange={e=>setDraft(e.target.value)} enterKeyHint="search"/>
        {(draft||searching)&&<button type="button" className="yt-search-clear" aria-label="Clear search" onClick={exitSearch}><X size={18}/></button>}
        <button className="yt-search-go" aria-label="Search"><ArrowRight size={19}/></button>
      </form>
      <div className="youtube-account">
        {accounts.length>1&&<select aria-label="YouTube account" value={c?.id||''} onChange={e=>{setAccountId(e.target.value);setSelection(null);setCursor(null);setCollCursor(null);}}>{accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select>}
        <button className="icon-button" aria-label={personal?'YouTube connections':'Connect Google'} title={personal?'Connections':'Connect Google'} onClick={onConnect}><Settings2 size={18}/></button>
      </div>
    </header>

    {searching&&<div className="yt-results-head"><h2>Results for <q>{query}</q></h2><button className="text-button" onClick={exitSearch}><X size={16}/>Back to {paneLabel[returnPane]}</button></div>}

    {error&&<div className="form-error" role="alert">{error}<button className="text-button" onClick={reconnect?onConnect:()=>setRefresh(n=>n+1)}>{reconnect?'Reconnect Google':'Try again'}</button></div>}
    {partial&&<p className="form-help" role="status">Some channels could not load. Your other channels are shown below.</p>}

    {!c&&pane!=='history'?<Empty icon={<YouTubeLogo/>} title="Bring your YouTube here" action={<button className="button primary" onClick={onConnect}>Connections</button>}>Connect YouTube to start watching.</Empty>
    :needsGoogle?<Empty icon={<Users size={34}/>} title="Connect Google for your channels" action={<button className="button primary" onClick={onConnect}>Connect Google<ArrowRight size={17}/></button>}>Sign in with Google to see your subscriptions and playlists. You can still search above.</Empty>
    :<>
      {showStrip&&<div className="yt-strip-wrap">
        <div className="yt-strip-head">
          <span>{searching?'Channels':pane==='playlists'?'Your playlists':total!=null?`${collections.length} of ${total} channels`:'Your channels'}</span>
          {pane==='subscriptions'&&<small><Star size={12} fill="currentColor"/> Star channels to fill For you</small>}
        </div>
        <CollectionStrip items={searching?collections:ordered} kind={searching?'channel':stripKind} selectedId={selection?.id} busy={collBusy}
          onSelect={value=>choose(value,searching?'channel':stripKind)}
          isStarred={pane==='subscriptions'?starred:undefined}
          onStar={pane==='subscriptions'&&c?value=>onStar({connectionId:c.id,kind:'channel',id:value.id,title:value.title}):undefined}
          onMore={stripPane&&collNext?()=>setCollCursor(collNext):undefined}/>
      </div>}

      {pane==='playlists'&&queue.length>0&&<section className="watch-playlist yt-queue"><div className="section-heading"><div><h2>Up next</h2><p>{queue.length} videos saved to this profile</p></div><div className="row-actions"><button className="text-button" onClick={onClearQueue}>Clear</button><button className="button primary small" onClick={()=>onOpen(queue[0])}><Play size={16} fill="currentColor"/>Play all</button></div></div><ol className="queue-list">{queue.map((item,index)=><li key={itemKey(item)}><span>{index+1}</span><button className="queue-video" onClick={()=>onOpen(item)}>{item.poster&&<img src={item.poster} alt="" loading="lazy"/>}<span><strong>{item.title}</strong><small>{item.subtitle||item.categoryLabel||'YouTube'}</small></span><Play size={17}/></button><button className="icon-button" aria-label={`Remove ${item.title} from playlist`} onClick={()=>onRemoveQueue(item)}><X size={17}/></button></li>)}</ol></section>}

      {selection&&<div className="yt-section-title"><h2>{selection.title}</h2>{searching&&<button className="text-button" onClick={()=>{setSelection(null);setCursor(null);}}><X size={15}/>All results</button>}</div>}
      {continuing.length>0&&<Row presentation="continue" title="Continue watching" items={continuing} {...rowProps}/>}
      {popularRows.map(row=><Row key={row.id} emphasis title={row.title} items={row.items} {...rowProps}/>)}
      {forYou&&visibleRows.length>0&&<div className={`yt-section-title ${continuing.length||popularRows.length?'yt-section-follows':''}`}><h2>Fresh from your starred channels</h2><RefreshButton label="Refresh YouTube" disabled={busy||popularBusy} onRefresh={()=>{setCursor(null);setRefresh(n=>n+1);}}/></div>}
      {searching&&!selection&&collections.length>0&&visible.length>0&&<div className="yt-section-title"><h2>Videos</h2></div>}

      {pane==='suggestions'&&!selection
        ?visibleRows.map(row=><Row key={row.id} title={row.title} items={row.items} onOpen={onOpen} onFavorite={onFavorite} isSaved={i=>queued.has(itemKey(i))} progress={i=>progress.get(itemKey(i))} more={()=>{setPane('subscriptions');setCollCursor(null);setCollections([]);setSelection({...row,kind:'channel'});setCursor(null);}}/>)
        :videoGrid}
      {forYou&&!anyBusy&&popularRows.length>0&&visibleRows.length===0&&<p className="form-help yt-more-hint">
        {personal?'Star channels in Subscriptions to add their newest videos here.':'Connect Google to add your starred channels here.'}
        <button className="text-button" onClick={personal?()=>changePane('subscriptions'):onConnect}>{personal?<><Star size={15}/>Star channels</>:'Connect Google'}</button>
      </p>}

      {anyBusy&&<Busy label={searching?'Searching YouTube…':'Loading your YouTube…'}/>}
      {!anyBusy&&!error&&visible.length===0&&visibleRows.length===0&&collections.length===0&&popularRows.length===0&&continuing.length===0&&<Empty icon={<YouTubeLogo/>} title={pane==='suggestions'?'Make this space yours':pane==='history'?'Your next watch starts here':searching?'No results':'Nothing here yet'} action={pane==='suggestions'?<button className="button primary" onClick={()=>changePane('subscriptions')}><Star size={17}/>Star your channels</button>:undefined}>{hideYouTubeShorts&&unfiltered.length?'Short videos are hidden. Change this in Settings or load more videos.':pane==='suggestions'?'Star subscriptions to see their latest videos here and on Home.':pane==='history'?'Videos you watch in TesPlay appear here.':searching?'Try different words or paste a video link.':'Choose another channel or playlist.'}</Empty>}
      {next&&<div className="load-more"><button className="button ghost" disabled={busy} onClick={()=>setCursor(next)}>Load more<ArrowRight size={16}/></button></div>}
    </>}
  </section>;
}

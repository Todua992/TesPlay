import { Bookmark, Cable, Clapperboard, History, House, Layers, Search, Settings, Smartphone, Tv, UserRound, Youtube } from 'lucide-react';
import { Brand } from './components';
import './navigation.css';

type NavigationView = 'home' | 'live' | 'movies' | 'series' | 'apps' | 'list' | 'history' | 'connections' | 'settings' | 'remote';
type Props = {
  view: string;
  phone: boolean;
  signedIn: boolean;
  searchOpen: boolean;
  profileOpen?: boolean;
  onNavigate: (view: NavigationView) => void;
  onSearch: () => void;
  onRemote: () => void;
  onProfile: () => void;
  onSignIn: () => void;
};

const destinations = [
  { view: 'home', label: 'Home', Icon: House },
  { view: 'live', label: 'Live TV', Icon: Tv },
  { view: 'movies', label: 'Movies', Icon: Clapperboard },
  { view: 'series', label: 'Series', Icon: Layers },
  { view: 'apps', label: 'YouTube', Icon: Youtube },
  { view: 'list', label: 'My List', Icon: Bookmark },
] as const;

const utilities = [
  { view: 'history', label: 'History', Icon: History },
  { view: 'connections', label: 'Sources', Icon: Cable },
  { view: 'settings', label: 'Settings', Icon: Settings },
] as const;

const titles: Record<string, string> = {
  home: 'Home', live: 'Live TV', movies: 'Movies', series: 'Series', apps: 'YouTube', list: 'My List',
  history: 'History', connections: 'Sources', settings: 'Settings', remote: 'Remote', catalog: 'Library',
};

export default function Navigation({ view, phone, signedIn, searchOpen, profileOpen = false, onNavigate, onSearch, onRemote, onProfile, onSignIn }: Props) {
  const item = ({ view: next, label, Icon }: { view: NavigationView; label: string; Icon: typeof House }) =>
    <button type="button" key={next} className="rail-item" aria-label={label} title={label} aria-current={view === next ? 'page' : undefined} onClick={() => onNavigate(next)}>
      <Icon aria-hidden="true" /><span>{label}</span>
    </button>;

  return <>
    <header className="app-topbar">
      <button type="button" className="topbar-brand" aria-label="TesPlay home" onClick={() => onNavigate('home')}><Brand /></button>
      <span className="topbar-divider" aria-hidden="true" />
      <h1 className="topbar-title">{titles[view] ?? ''}</h1>
      <button type="button" className="topbar-search" aria-label="Search library" aria-expanded={searchOpen} onClick={onSearch}>
        <span>Search movies, series, channels…</span><Search aria-hidden="true" />
      </button>
      <div className="topbar-actions">
        {phone && <button type="button" className="topbar-icon" aria-label="Open remote controls" title="Phone remote" onClick={onRemote}><Smartphone aria-hidden="true" /></button>}
        <button type="button" className="topbar-icon topbar-user" aria-haspopup="dialog" aria-expanded={profileOpen} aria-label={signedIn ? 'Profiles and account' : 'Sign in'} title={signedIn ? 'Profiles and account' : 'Sign in'} onClick={() => (signedIn ? onProfile() : onSignIn())}>
          <UserRound aria-hidden="true" />
        </button>
      </div>
    </header>
    <nav className="app-rail" aria-label="Main navigation">
      <div className="rail-group">{destinations.map(item)}</div>
      <div className="rail-group rail-utilities">{utilities.map(item)}</div>
    </nav>
  </>;
}

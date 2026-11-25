import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import { Play, Info, Check, Plus, ChevronLeft, ChevronRight } from 'lucide-react';
import { itemKey } from './types';
import type { MediaItem } from './types';

const SLIDE_MS = 7000; // time each title stays up
const MOVE_MS = 700; // slide animation; matches .hero-slide's transition
const SWIPE_PX = 60; // a drag this long turns the page

export type HeroMotion = {
  current: number;
  /** The slide animating out, and the side it leaves towards (-direction). */
  leaving: number | null;
  direction: 1 | -1;
  /** The slide parked on the incoming side for one frame before it slides in. */
  staged: number | null;
  /** A neighbor springing back after a cancelled swipe. */
  settling: { slide: number; side: 1 | -1 } | null;
  /** Horizontal drag offset in pixels, while a finger or pointer drags. */
  drag: number | null;
};

/** Where slide `i` sits: x as a CSS length, whether it animates there, and whether it shows. */
export function heroSlidePlacement(i: number, count: number, m: HeroMotion): { x: string; animate: boolean; visible: boolean } {
  if (m.drag !== null) {
    if (i === m.current) return { x: `${m.drag}px`, animate: false, visible: true };
    const side = m.drag < 0 ? 1 : -1;
    if (i === (m.current + side + count) % count) return { x: `calc(${side * 100}% + ${m.drag}px)`, animate: false, visible: true };
  }
  if (i === m.current) return { x: '0px', animate: true, visible: true };
  if (i === m.leaving) return { x: `${-m.direction * 100}%`, animate: true, visible: true };
  if (i === m.staged) return { x: `${m.direction * 100}%`, animate: false, visible: true };
  if (i === m.settling?.slide) return { x: `${m.settling.side * 100}%`, animate: true, visible: true };
  return { x: `${m.direction * 100}%`, animate: false, visible: false };
}

const idle = (current = 0): HeroMotion => ({ current, leaving: null, direction: 1, staged: null, settling: null, drag: null });

/** The Home spotlight: slides between titles, swipes on touch screens and advances on its own. */
export default function HeroCarousel({ items, kicker, saved, onOpen, onDetails, onFavorite }: {
  items: MediaItem[]; kicker: (item: MediaItem) => string; saved: (item: MediaItem) => boolean;
  onOpen: (item: MediaItem) => void; onDetails: (item: MediaItem) => void; onFavorite: (item: MediaItem) => void;
}) {
  const count = items.length;
  const [motion, setMotion] = useState<HeroMotion>(idle);
  const [paused, setPaused] = useState(false);
  const pointer = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const dragged = useRef(false);
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const current = count ? motion.current % count : 0;
  const hero = items[current];

  // A refreshed list can be shorter; start over rather than point past its end.
  useEffect(() => { if (motion.current >= count) setMotion(idle()); }, [count, motion.current]);
  // Park the slide that left (and a neighbor that sprang back) once their animation ends.
  useEffect(() => {
    if (motion.leaving === null && !motion.settling) return;
    const timer = window.setTimeout(() => setMotion(m => ({ ...m, leaving: null, settling: null })), MOVE_MS);
    return () => window.clearTimeout(timer);
  }, [motion.leaving, motion.settling, motion.current]);

  const go = (target: number, direction: 1 | -1) => {
    const next = (target + count) % count;
    if (count < 2 || next === current) return;
    if (reduced) return setMotion(idle(next));
    // Place the incoming slide on its side first, then slide both in the next frame.
    setMotion(m => ({ ...m, staged: next, direction, settling: null }));
    requestAnimationFrame(() => requestAnimationFrame(() => setMotion(m => ({ ...m, current: next, leaving: current, direction, staged: null }))));
  };

  const down = (e: PointerEvent<HTMLElement>) => {
    if (count < 2 || e.button > 0) return;
    pointer.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    dragged.current = false;
  };
  const move = (e: PointerEvent<HTMLElement>) => {
    const p = pointer.current;
    if (!p || p.id !== e.pointerId) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (!p.moved) {
      // Vertical movement is a page scroll; let the browser have it.
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { pointer.current = null; return; }
      if (Math.abs(dx) < 8) return;
      p.moved = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    setMotion(m => ({ ...m, drag: dx, leaving: null, settling: null }));
  };
  const release = (e: PointerEvent<HTMLElement>) => {
    const p = pointer.current;
    pointer.current = null;
    if (!p || p.id !== e.pointerId || !p.moved) return;
    dragged.current = true;
    const dx = e.clientX - p.x, direction: 1 | -1 = dx < 0 ? 1 : -1;
    const neighbor = (current + direction + count) % count;
    if (Math.abs(dx) >= Math.min(SWIPE_PX, e.currentTarget.clientWidth / 5) && e.type !== 'pointercancel')
      setMotion(m => ({ ...m, drag: null, current: neighbor, leaving: current, direction }));
    else setMotion(m => ({ ...m, drag: null, settling: { slide: neighbor, side: direction } }));
  };
  // A drag that ends over a button must not also press it.
  const swallowDragClick = (e: MouseEvent) => { if (dragged.current) { e.preventDefault(); e.stopPropagation(); dragged.current = false; } };
  const keys = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); go(current + 1, 1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(current - 1, -1); }
  };

  if (!hero) return null;
  const isSaved = saved(hero);
  return <section className="hero hero-carousel" aria-roledescription="carousel" aria-label="Featured titles" tabIndex={-1}
    onPointerEnter={() => setPaused(true)} onPointerLeave={() => setPaused(false)}
    onFocusCapture={() => setPaused(true)} onBlurCapture={e => { if (!e.currentTarget.contains(e.relatedTarget)) setPaused(false); }}
    onPointerDown={down} onPointerMove={move} onPointerUp={release} onPointerCancel={release} onClickCapture={swallowDragClick} onKeyDown={keys}>
    {items.map((item, index) => {
      const place = heroSlidePlacement(index, count, { ...motion, current });
      const active = index === current;
      const title = Array.from(item.title).length > 90 ? Array.from(item.title).slice(0, 87).join('').trimEnd() + '…' : item.title;
      return <div key={itemKey(item)} className={`hero-slide ${active ? 'active' : ''}`} inert={!active} aria-roledescription="slide" aria-label={`${index + 1} of ${count}: ${item.title}`}
        style={{ transform: `translate3d(${place.x},0,0)`, transition: place.animate && !reduced ? undefined : 'none', visibility: place.visible ? 'visible' : 'hidden' }}>
        <div className="hero-art" style={{ backgroundImage: item.backdrop || item.poster ? `url(${item.backdrop || item.poster})` : undefined }} />
        <div className="hero-vignette" />
        <div className="hero-content">
          <div className="hero-kicker">{kicker(item)}</div>
          <h1 title={item.title} className={item.title.length > 55 ? 'very-long-title' : item.title.length > 25 ? 'long-title' : ''}>{title}</h1>
          <div className="hero-meta">
            {item.year && <span>{item.year}</span>}
            {!!item.duration && <span>{Math.round(item.duration / 60)} min</span>}
            {item.type === 'live' && <span className="quality-label">Live</span>}
            <span>{item.categoryLabel || item.subtitle || item.category?.split(' · ')[0]}</span>
          </div>
          <p>{item.description || (item.type === 'series' ? 'Explore the episodes in your collection.' : `Ready to watch from ${item.source}.`)}</p>
          <div className="hero-actions">
            <button className="button primary" onClick={() => onOpen(item)}><Play size={18} fill="currentColor" />{item.type === 'series' ? 'Play series' : item.type === 'live' ? 'Watch live' : 'Play now'}</button>
            <button className="button ghost" onClick={() => onDetails(item)}><Info size={18} />More info</button>
          </div>
        </div>
      </div>;
    })}
    <div className="hero-bottom">
      <button className="text-button hero-save" onClick={() => onFavorite(hero)} aria-label={isSaved ? 'Remove featured title from My list' : 'Add featured title to My list'}>{isSaved ? <Check size={18} /> : <Plus size={18} />}{isSaved ? 'In My list' : 'Add to My list'}</button>
      {count > 1 && <div className="hero-pages">
        <button className="hero-step" aria-label="Previous featured title" onClick={() => go(current - 1, -1)}><ChevronLeft size={16} /></button>
        <span>{current + 1}<small> / {count}</small></span>
        <button className="hero-step" aria-label="Next featured title" onClick={() => go(current + 1, 1)}><ChevronRight size={16} /></button>
        <div>{items.map((item, index) => <button key={itemKey(item)} className={current === index ? 'selected' : ''} aria-label={`Feature ${item.title}`} aria-pressed={current === index} onClick={() => go(index, index > current ? 1 : -1)}><span /></button>)}</div>
      </div>}
    </div>
    {count > 1 && !reduced && <span key={current} className="hero-progress" aria-hidden="true"
      style={{ animationDuration: `${SLIDE_MS}ms`, animationPlayState: paused || motion.drag !== null ? 'paused' : 'running' }}
      onAnimationEnd={() => go(current + 1, 1)} />}
  </section>;
}

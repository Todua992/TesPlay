import { useEffect, useState } from 'react';

export type ThemePreference = 'auto' | 'light' | 'dark';
const KEY = 'tesplay-theme';
const listeners = new Set<() => void>();

export function themePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(KEY);
    if (value === 'light' || value === 'dark' || value === 'auto') return value;
  } catch { /* storage unavailable */ }
  return 'auto';
}

/** Auto: follow the system/car dark mode, otherwise dark from 19:00 to 07:00. */
export function resolveTheme(preference = themePreference(), now = new Date()): 'light' | 'dark' {
  if (preference !== 'auto') return preference;
  if (typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
  const hour = now.getHours();
  return hour >= 19 || hour < 7 ? 'dark' : 'light';
}

export function applyTheme() {
  const theme = resolveTheme();
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', theme === 'dark' ? '#0e0e10' : '#f4f4f6');
  listeners.forEach(listener => listener());
}

export function setThemePreference(value: ThemePreference) {
  try { localStorage.setItem(KEY, value); } catch { /* storage unavailable */ }
  applyTheme();
}

export function startTheme() {
  applyTheme();
  setInterval(applyTheme, 5 * 60 * 1000);
  if (typeof matchMedia === 'function') matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);
}

export function useThemePreference(): [ThemePreference, (value: ThemePreference) => void] {
  const [value, setValue] = useState(themePreference);
  useEffect(() => { const update = () => setValue(themePreference()); listeners.add(update); return () => { listeners.delete(update); }; }, []);
  return [value, setThemePreference];
}

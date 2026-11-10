import { useSyncExternalStore } from 'react';

const storageKey = 'app:theme';
export const themeOptions = ['Sistema', 'Claro', 'Oscuro'] as const;
type Theme = typeof themeOptions[number];
type ResolvedTheme = 'light' | 'dark';

function readTheme(): Theme {
  try {
    const value = window.localStorage.getItem(storageKey);
    return value === 'Claro' || value === 'Oscuro' ? value : 'Sistema';
  } catch {
    return 'Sistema';
  }
}

const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();
let snapshot: { theme: Theme; resolvedTheme: ResolvedTheme } = { theme: 'Sistema', resolvedTheme: 'light' };

function applyTheme(theme: Theme) {
  const dark = theme === 'Oscuro' || (theme === 'Sistema' && systemTheme.matches);
  const resolvedTheme = dark ? 'dark' : 'light';
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.style.colorScheme = resolvedTheme;
  if (snapshot.theme === theme && snapshot.resolvedTheme === resolvedTheme) return;
  snapshot = { theme, resolvedTheme };
  listeners.forEach((listener) => listener());
}

function setTheme(theme: Theme) {
  try {
    window.localStorage.setItem(storageKey, theme);
  } catch {
    // Keep the preference for this tab when storage is unavailable.
  }
  applyTheme(theme);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function followSystem() {
  if (snapshot.theme === 'Sistema') applyTheme('Sistema');
}

function synchronizeStorage(event: StorageEvent) {
  if (event.key !== null && event.key !== storageKey) return;
  if (event.storageArea !== window.localStorage) return;
  applyTheme(readTheme());
}

applyTheme(readTheme());
systemTheme.addEventListener('change', followSystem);
window.addEventListener('storage', synchronizeStorage);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    systemTheme.removeEventListener('change', followSystem);
    window.removeEventListener('storage', synchronizeStorage);
  });
}

const getSnapshot = () => snapshot;

export function useTheme() {
  return { ...useSyncExternalStore(subscribe, getSnapshot), setTheme };
}

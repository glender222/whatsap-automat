import { atom } from 'jotai';

export type Theme = 'Sistema' | 'Claro' | 'Oscuro';

const THEME_KEY = 'app:theme';

const isValid = (v: unknown): v is Theme => v === 'Sistema' || v === 'Claro' || v === 'Oscuro';

const readInitial = (): Theme => {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (isValid(raw)) return raw;
  } catch (e) {
    // ignore
  }
  return 'Sistema';
};

const applyTheme = (theme: Theme) => {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;

  if (theme === 'Oscuro') {
    root.classList.add('dark');
  } else if (theme === 'Claro') {
    root.classList.remove('dark');
  } else {
    // Sistema -> seguir la preferencia del sistema
    try {
      const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (prefersDark) root.classList.add('dark');
      else root.classList.remove('dark');
    } catch (e) {
      root.classList.remove('dark');
    }
  }
};

// átomo de solo lectura con valor inicial
export const themeAtom = atom<Theme>(readInitial());

// átomo con escritura que persiste y aplica el tema en el DOM
export const themeAtomWritable = atom(
  (get) => get(themeAtom),
  (_get, set, newTheme: Theme) => {
    set(themeAtom, newTheme);
    try {
      localStorage.setItem(THEME_KEY, newTheme);
    } catch (e) {
      // ignore
    }
    applyTheme(newTheme);
  }
);

// aplicar el tema inicial en carga (cliente)
try {
  applyTheme(readInitial());
} catch (e) {
  // noop
}

export default themeAtom;

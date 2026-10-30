import { useAtom } from 'jotai';
import { useEffect } from 'react';
import themeAtom, { themeAtomWritable } from '../slices/themeAtom';
import type { Theme } from '../slices/themeAtom';

/**
 * Hook para consumir y actualizar el tema via Jotai.
 * Devuelve { theme, setTheme }.
 */
export const useTheme = () => {
  const [theme] = useAtom(themeAtom);
  const [, setTheme] = useAtom(themeAtomWritable);

  // Reaplicar en montaje para sincronizar con el DOM (por si hay hidración)
  useEffect(() => {
    // la lógica de aplicación ya está en el átomo escribible, aquí solo forzamos efecto si es necesario
    setTheme(theme as Theme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    theme,
    setTheme: (t: Theme) => setTheme(t),
  } as const;
};

export default useTheme;

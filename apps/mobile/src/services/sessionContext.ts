import { createContext, useContext } from 'react';
import type { AuthSession } from './authStorage';

export const SessionContext = createContext<{
  session: AuthSession;
  signOut: () => void;
} | null>(null);

export function useSession() {
  const current = useContext(SessionContext);
  if (!current) throw new Error('La pantalla requiere una sesión iniciada.');
  return current;
}

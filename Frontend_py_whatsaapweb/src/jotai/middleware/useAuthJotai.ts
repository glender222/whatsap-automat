import { useAtomValue } from 'jotai';
import { clearSession, readSession, saveSession } from '../../shared/auth/session';
import { accessTokenAtom, refreshTokenAtom, userAtom } from '../slices/authAtoms';

export function useAuthJotai() {
  return {
    user: useAtomValue(userAtom),
    accessToken: useAtomValue(accessTokenAtom),
    refreshToken: useAtomValue(refreshTokenAtom),
    saveAuth: saveSession,
    clearAuth: () => clearSession(readSession().generation),
  };
}

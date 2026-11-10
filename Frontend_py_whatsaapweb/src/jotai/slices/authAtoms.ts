import { atom } from 'jotai';
import { readSession, subscribeSession } from '../../shared/auth/session';

const sessionVersionAtom = atom(0);
sessionVersionAtom.onMount = (setVersion) => {
  const update = () => setVersion((version) => version + 1);
  const unsubscribe = subscribeSession(update);
  update();
  return unsubscribe;
};
const sessionAtom = atom((get) => {
  get(sessionVersionAtom);
  return readSession();
});

export const accessTokenAtom = atom((get) => get(sessionAtom).accessToken);
export const refreshTokenAtom = atom((get) => get(sessionAtom).refreshToken);
export const userAtom = atom((get) => get(sessionAtom).user);

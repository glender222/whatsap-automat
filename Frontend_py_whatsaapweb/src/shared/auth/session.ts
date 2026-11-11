import type { User } from '../types/user.types';

export interface SessionSnapshot {
  generation: number;
  accessToken: string | null;
  refreshToken: string | null;
  user: User | null;
}

interface StoredSession {
  browserSessionId: string;
  accessToken: string;
  refreshToken: string | null;
  user: User | null;
}

let observed: SessionSnapshot = { generation: 0, accessToken: null, refreshToken: null, user: null };
let observedId: string | null = null;
let observedRecord: string | null = null;
const listeners = new Set<() => void>();

function parseRecord(raw: string | null): Partial<StoredSession> | null {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    return value && typeof value === 'object' ? value as Partial<StoredSession> : null;
  } catch {
    return null;
  }
}

export function readSession(): SessionSnapshot {
  if (typeof localStorage === 'undefined') return observed;
  const raw = localStorage.getItem('auth');
  if (raw === observedRecord && observedId) return observed;

  const record = parseRecord(raw);
  const stored = typeof record?.browserSessionId === 'string' && record.browserSessionId && typeof record.accessToken === 'string'
    ? { id: record.browserSessionId, accessToken: record.accessToken, refreshToken: typeof record.refreshToken === 'string' ? record.refreshToken : null }
    : null;
  const storedId = stored?.id ?? null;
  const accessToken = stored ? stored.accessToken : localStorage.getItem('accessToken');
  const refreshToken = stored ? stored.refreshToken : localStorage.getItem('refreshToken');
  if (raw === observedRecord && storedId === observedId &&
      accessToken === observed.accessToken && refreshToken === observed.refreshToken) return observed;

  const changed = storedId !== observedId || (!storedId && (refreshToken !== observed.refreshToken ||
    (!refreshToken && accessToken !== observed.accessToken)));
  observedRecord = raw;
  observedId = storedId;
  observed = {
    generation: observed.generation + Number(changed),
    accessToken,
    refreshToken,
    user: storedId || (accessToken && record?.refreshToken === refreshToken) ? record?.user ?? null : null,
  };
  return observed;
}

export function readBrowserSessionId(): string | null {
  readSession();
  return observedId;
}

function notifySession() {
  for (const listener of listeners) listener();
}

function handleStorage(event: StorageEvent) {
  if (event.key === null || event.key === 'auth' || event.key === 'accessToken' || event.key === 'refreshToken') {
    notifySession();
  }
}

export function subscribeSession(listener: () => void) {
  if (listeners.size === 0 && typeof window !== 'undefined') window.addEventListener('storage', handleStorage);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== 'undefined') window.removeEventListener('storage', handleStorage);
  };
}

function removeLegacyTokens() {
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
}

function persistSession(record: StoredSession, generation?: number) {
  const raw = JSON.stringify(record);
  localStorage.setItem('auth', raw);
  removeLegacyTokens();
  if (generation !== undefined) {
    observedRecord = raw;
    observedId = record.browserSessionId;
    observed = { generation, accessToken: record.accessToken, refreshToken: record.refreshToken, user: record.user };
  }
  notifySession();
  return readSession();
}

function newSessionId() {
  return globalThis.crypto.getRandomValues(new Uint32Array(4)).join('-');
}

export function saveSession(user: User, accessToken: string, refreshToken: string) {
  return persistSession({ browserSessionId: newSessionId(), user, accessToken, refreshToken });
}

export function saveRenewedAccess(generation: number, accessToken: string, refreshToken?: string) {
  const session = readSession();
  if (generation !== session.generation) return null;
  return persistSession({
    browserSessionId: observedId ?? newSessionId(), accessToken,
    refreshToken: refreshToken ?? session.refreshToken, user: session.user,
  }, generation);
}

export function clearSession(generation: number) {
  if (readSession().generation !== generation) return false;
  removeLegacyTokens();
  localStorage.removeItem('auth');
  localStorage.removeItem('userRole');
  readSession();
  notifySession();
  return true;
}

export function invalidateSession(generation: number) {
  if (clearSession(generation) && typeof window !== 'undefined') window.location.assign('/auth/login');
}

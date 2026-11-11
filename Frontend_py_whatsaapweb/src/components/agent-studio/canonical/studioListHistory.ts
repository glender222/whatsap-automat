import { readBrowserSessionId, readSession } from '../../../shared/auth/session';

const storageKey = 'studio:list-history';
const entryLimit = 20;
const identifier = /^[A-Za-z0-9_-]{1,128}$/;

export type StudioListPosition = {
  entryKey: string;
  after: string | null;
  graphId: string | null;
  scrollTop: number;
};

type SessionScope = { sessionId: string; userId: string; companyId: string };
type HistoryCache = { scope: SessionScope; entries: StudioListPosition[] };

export function studioReturnSession() {
  return readBrowserSessionId() ?? readSession().generation;
}

function currentScope(): SessionScope | null {
  const session = readSession();
  const sessionId = readBrowserSessionId();
  return sessionId && session.accessToken && session.user?.id && session.user.companyId
    ? { sessionId, userId: String(session.user.id), companyId: String(session.user.companyId) } : null;
}

function isPosition(value: unknown): value is StudioListPosition {
  if (!value || typeof value !== 'object') return false;
  const position = value as Partial<StudioListPosition>;
  return typeof position.entryKey === 'string' && identifier.test(position.entryKey) && position.entryKey !== 'default' &&
    (position.after === null || (typeof position.after === 'string' && identifier.test(position.after))) &&
    (position.graphId === null || (typeof position.graphId === 'string' && identifier.test(position.graphId))) &&
    typeof position.scrollTop === 'number' && Number.isFinite(position.scrollTop) && position.scrollTop >= 0 && position.scrollTop < 10_000_000;
}

function readCache(scope: SessionScope): StudioListPosition[] {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (!raw || raw.length > 32_768) return [];
    const cache = JSON.parse(raw) as Partial<HistoryCache>;
    if (cache?.scope?.sessionId !== scope.sessionId || cache.scope.userId !== scope.userId || cache.scope.companyId !== scope.companyId ||
        !Array.isArray(cache.entries) || cache.entries.length > entryLimit || !cache.entries.every(isPosition)) return [];
    return cache.entries;
  } catch { return []; }
}

export function readStudioListPosition(entryKey: string, after: string | null): StudioListPosition | undefined {
  const scope = currentScope();
  return scope ? readCache(scope).find((entry) => entry.entryKey === entryKey && entry.after === after) : undefined;
}

export function rememberStudioListPosition(position: StudioListPosition): void {
  const scope = currentScope();
  if (!scope || !isPosition(position)) return;
  const entries = [...readCache(scope).filter((entry) => entry.entryKey !== position.entryKey), position].slice(-entryLimit);
  try { sessionStorage.setItem(storageKey, JSON.stringify({ scope, entries } satisfies HistoryCache)); }
  catch { /* A blocked browser store must not prevent navigation. */ }
}

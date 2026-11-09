export interface AuthSession {
  accessToken: string;
  refreshToken?: string;
  tenantId: string;
  userId: string;
  apiUrl: string;
}

export interface AuthSessionSnapshot {
  revision: number;
  session: AuthSession;
}

export interface StorageBackend {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

class MemoryStorageBackend implements StorageBackend {
  private readonly store = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async deleteItem(key: string): Promise<void> {
    this.store.delete(key);
  }
}

function createStorageBackend(): StorageBackend {
  try {
    const secureStore: typeof import('expo-secure-store') = require('expo-secure-store');
    const { Platform } = require('react-native') as typeof import('react-native');
    if (Platform.OS === 'ios' || Platform.OS === 'android') {
      return {
        getItem: (key) => secureStore.getItemAsync(key),
        setItem: (key, value) => secureStore.setItemAsync(key, value, {
          keychainAccessible: secureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        }),
        deleteItem: (key) => secureStore.deleteItemAsync(key),
      };
    }
  } catch (error) {
    if (typeof navigator !== 'undefined' && navigator.product === 'ReactNative') throw error;
  }
  // Browser previews and Node tests keep sessions in memory.
  return new MemoryStorageBackend();
}

const SESSION_KEY = 'whatsap_automat_auth_session';
const LEGACY_KEYS = [
  'whatsap_automat_access_token',
  'whatsap_automat_refresh_token',
  'whatsap_automat_tenant_id',
  'whatsap_automat_user_id',
  'whatsap_automat_api_url',
];

export class AuthStorageService {
  private static readonly instance = new AuthStorageService();
  private backend: StorageBackend = createStorageBackend();
  private revision = 0;
  private readable = true;
  private pending: Promise<void> = Promise.resolve();

  private constructor() {}

  static getInstance(): AuthStorageService {
    return AuthStorageService.instance;
  }

  setBackendForTest(backend: StorageBackend): void {
    this.revision++;
    this.readable = true;
    this.backend = backend;
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  isCurrent(revision: number): boolean {
    return this.revision === revision;
  }

  saveAuthSession(session: AuthSession): Promise<void> {
    const revision = ++this.revision;
    this.readable = false;
    return this.serialize(async () => {
      await this.backend.setItem(SESSION_KEY, JSON.stringify(session));
      if (this.isCurrent(revision)) this.readable = true;
    });
  }

  async getAuthSession(): Promise<AuthSession | null> {
    return (await this.getSnapshot())?.session ?? null;
  }

  getSnapshot(): Promise<AuthSessionSnapshot | null> {
    const revision = this.revision;
    return this.serialize(async () => {
      if (!this.readable || !this.isCurrent(revision)) return null;
      const session = await this.readSession();
      return session && this.isCurrent(revision) ? { revision, session } : null;
    });
  }

  rotateAccessToken(previous: AuthSessionSnapshot, accessToken: string): Promise<AuthSessionSnapshot | null> {
    return this.serialize(async () => {
      if (!this.isCurrent(previous.revision)) return null;
      const session = { ...previous.session, accessToken };
      await this.backend.setItem(SESSION_KEY, JSON.stringify(session));
      return this.isCurrent(previous.revision) ? { revision: previous.revision, session } : null;
    });
  }

  private async readSession(purgeMalformed = true): Promise<AuthSession | null> {
    const raw = await this.backend.getItem(SESSION_KEY);
    if (!raw) return null;

    try {
      const session = JSON.parse(raw) as Partial<AuthSession> | null;
      if (session && typeof session.accessToken === 'string' && session.accessToken
        && session.accessToken !== 'mock_jwt_mobile_agent_token'
        && typeof session.tenantId === 'string' && session.tenantId
        && typeof session.userId === 'string' && session.userId
        && typeof session.apiUrl === 'string' && session.apiUrl) {
        return session as AuthSession;
      }
    } catch {
      // Treat stale or corrupted secure storage as a signed-out session.
    }
    if (purgeMalformed) await this.deleteSession();
    return null;
  }

  clearAuthSession(): Promise<AuthSession | null> {
    this.revision++;
    this.readable = false;
    return this.serialize(async () => {
      const previous = await this.readSession(false).catch(() => null);
      await this.deleteSession();
      return previous;
    });
  }

  private async deleteSession(): Promise<void> {
    await this.backend.deleteItem(SESSION_KEY);
    await Promise.allSettled(LEGACY_KEYS.map((key) => this.backend.deleteItem(key)));
  }
}

export const authStorage = AuthStorageService.getInstance();
export { MemoryStorageBackend };

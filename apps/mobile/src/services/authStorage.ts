export interface AuthSession {
  accessToken: string;
  refreshToken?: string;
  tenantId: string;
  userId: string;
  apiUrl: string;
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

  private constructor() {}

  static getInstance(): AuthStorageService {
    return AuthStorageService.instance;
  }

  setBackendForTest(backend: StorageBackend): void {
    this.backend = backend;
  }

  async saveAuthSession(session: AuthSession): Promise<void> {
    await this.backend.setItem(SESSION_KEY, JSON.stringify(session));
  }

  async getAuthSession(): Promise<AuthSession | null> {
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
    await this.clearAuthSession();
    return null;
  }

  async clearAuthSession(): Promise<void> {
    await this.backend.deleteItem(SESSION_KEY);
    await Promise.allSettled(LEGACY_KEYS.map((key) => this.backend.deleteItem(key)));
  }
}

export const authStorage = AuthStorageService.getInstance();
export { MemoryStorageBackend };

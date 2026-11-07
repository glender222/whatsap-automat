/**
 * Hardware-backed Secure Credential Storage Service
 * Uses Expo SecureStore on native iOS/Android, with a memory fallback for Node.js / CI tests.
 */

export interface AuthSession {
  accessToken: string;
  refreshToken?: string;
  tenantId: string;
  userId: string;
  apiUrl?: string;
}

export interface StorageBackend {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

// Memory fallback driver for testing and environments without native SecureStore
class MemoryStorageBackend implements StorageBackend {
  private store = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async setItem(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async deleteItem(key: string): Promise<void> {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }
}

// SecureStore native driver
class ExpoSecureStoreBackend implements StorageBackend {
  private secureStoreModule: any;

  constructor() {
    try {
      // Dynamic import / require to avoid crashing in pure Node.js environments
      this.secureStoreModule = require('expo-secure-store');
    } catch {
      this.secureStoreModule = null;
    }
  }

  async getItem(key: string): Promise<string | null> {
    if (this.secureStoreModule && typeof this.secureStoreModule.getItemAsync === 'function') {
      return this.secureStoreModule.getItemAsync(key);
    }
    return null;
  }

  async setItem(key: string, value: string): Promise<void> {
    if (this.secureStoreModule && typeof this.secureStoreModule.setItemAsync === 'function') {
      await this.secureStoreModule.setItemAsync(key, value, {
        keychainAccessible: this.secureStoreModule.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
    }
  }

  async deleteItem(key: string): Promise<void> {
    if (this.secureStoreModule && typeof this.secureStoreModule.deleteItemAsync === 'function') {
      await this.secureStoreModule.deleteItemAsync(key);
    }
  }
}

export class AuthStorageService {
  private static instance: AuthStorageService;
  private backend: StorageBackend;
  private static readonly STORAGE_KEYS = {
    SESSION: 'whatsap_automat_auth_session',
    ACCESS_TOKEN: 'whatsap_automat_access_token',
    REFRESH_TOKEN: 'whatsap_automat_refresh_token',
    TENANT_ID: 'whatsap_automat_tenant_id',
    USER_ID: 'whatsap_automat_user_id',
    API_URL: 'whatsap_automat_api_url',
  };

  private constructor() {
    // Determine whether native SecureStore is usable or if we fallback to MemoryStorage
    let hasNativeSecureStore = false;
    try {
      const SecureStore = require('expo-secure-store');
      if (SecureStore && typeof SecureStore.getItemAsync === 'function') {
        hasNativeSecureStore = true;
      }
    } catch {
      hasNativeSecureStore = false;
    }

    this.backend = hasNativeSecureStore
      ? new ExpoSecureStoreBackend()
      : new MemoryStorageBackend();
  }

  public static getInstance(): AuthStorageService {
    if (!AuthStorageService.instance) {
      AuthStorageService.instance = new AuthStorageService();
    }
    return AuthStorageService.instance;
  }

  /**
   * Override backend (strictly for unit tests)
   */
  public setBackendForTest(backend: StorageBackend): void {
    this.backend = backend;
  }

  public async saveAuthSession(session: AuthSession): Promise<void> {
    await this.backend.setItem(
      AuthStorageService.STORAGE_KEYS.SESSION,
      JSON.stringify(session)
    );
    await this.backend.setItem(
      AuthStorageService.STORAGE_KEYS.ACCESS_TOKEN,
      session.accessToken
    );
    if (session.refreshToken) {
      await this.backend.setItem(
        AuthStorageService.STORAGE_KEYS.REFRESH_TOKEN,
        session.refreshToken
      );
    }
    await this.backend.setItem(
      AuthStorageService.STORAGE_KEYS.TENANT_ID,
      session.tenantId
    );
    await this.backend.setItem(
      AuthStorageService.STORAGE_KEYS.USER_ID,
      session.userId
    );
    if (session.apiUrl) {
      await this.backend.setItem(
        AuthStorageService.STORAGE_KEYS.API_URL,
        session.apiUrl
      );
    }
  }

  public async getAuthSession(): Promise<AuthSession | null> {
    const raw = await this.backend.getItem(AuthStorageService.STORAGE_KEYS.SESSION);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as AuthSession;
    } catch {
      return null;
    }
  }

  public async getAccessToken(): Promise<string | null> {
    return this.backend.getItem(AuthStorageService.STORAGE_KEYS.ACCESS_TOKEN);
  }

  public async getTenantId(): Promise<string | null> {
    return this.backend.getItem(AuthStorageService.STORAGE_KEYS.TENANT_ID);
  }

  public async getUserId(): Promise<string | null> {
    return this.backend.getItem(AuthStorageService.STORAGE_KEYS.USER_ID);
  }

  public async getApiUrl(): Promise<string> {
    const stored = await this.backend.getItem(AuthStorageService.STORAGE_KEYS.API_URL);
    return stored || 'http://localhost:3000/api/v1';
  }

  public async clearAuthSession(): Promise<void> {
    await this.backend.deleteItem(AuthStorageService.STORAGE_KEYS.SESSION);
    await this.backend.deleteItem(AuthStorageService.STORAGE_KEYS.ACCESS_TOKEN);
    await this.backend.deleteItem(AuthStorageService.STORAGE_KEYS.REFRESH_TOKEN);
    await this.backend.deleteItem(AuthStorageService.STORAGE_KEYS.TENANT_ID);
    await this.backend.deleteItem(AuthStorageService.STORAGE_KEYS.USER_ID);
    await this.backend.deleteItem(AuthStorageService.STORAGE_KEYS.API_URL);
  }

  public async isAuthenticated(): Promise<boolean> {
    const token = await this.getAccessToken();
    return typeof token === 'string' && token.length > 0;
  }
}

export const authStorage = AuthStorageService.getInstance();
export { MemoryStorageBackend };

/**
 * Types para el módulo de Settings
 */

export type LoadingStatus = 'idle' | 'started' | 'fetching' | 'processing' | 'initial-loaded' | 'loading' | 'completed' | 'error';

export interface LoadingChatsState {
  isLoading: boolean;
  status: LoadingStatus;
  loaded: number;
  total: number;
  percentage: number;
  message: string;
}

export interface WhatsAppConnectionState {
  numeroAfiliado: string | null;
  qrUrl: string | null;
  afiliando: boolean;
  loggingOut: boolean;
  showLogoutAnimation: boolean;
}

export interface SettingsState {
  autoDownloadImagesFiles: boolean;
  autoDownloadDocuments: boolean;
  botModality: 'options' | 'words' | null;
}

export interface SocketEventData {
  status?: LoadingStatus;
  loaded?: number;
  total?: number;
  percentage?: number;
  message?: string;
  reason?: string;
  success?: boolean;
}

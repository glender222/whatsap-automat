/**
 * Types para gestión de sesiones de atención en chats
 */

export interface SessionStatusResponse {
  success: boolean;
  chatId: string;
  hasActiveSession: boolean;
  status: 'active' | 'pending' | 'open' | 'closed' | null;
  serviceWindowExpiresAt?: string | null;
  lastCustomerMessageAt?: string | null;
  reason?: string | null;
}

export interface CompleteSessionResponse {
  success: boolean;
  message: string;
}

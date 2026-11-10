import { createContext, useContext } from 'react';
import type { AuthSession } from './authStorage';
import type { MobileApprovalCommand, MobileSendCommand } from './apiClient';

export const SessionContext = createContext<{
  session: AuthSession;
  signOut: () => void;
  isSessionActive: () => boolean;
  pendingReplies: ReadonlyMap<string, MobileSendCommand>;
  rememberReply: (chatId: string, command: MobileSendCommand) => void;
  forgetReply: (chatId: string, command: MobileSendCommand) => void;
  approvalAttempts: Map<string, MobileApprovalCommand>;
} | null>(null);

export function useSession() {
  const current = useContext(SessionContext);
  if (!current) throw new Error('La pantalla requiere una sesión iniciada.');
  return current;
}

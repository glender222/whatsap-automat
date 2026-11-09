import { createContext, useContext } from 'react';
import type { AuthSession } from './authStorage';
import type { MobileApprovalCommand, MobileTextCommand } from './apiClient';

export const SessionContext = createContext<{
  session: AuthSession;
  signOut: () => void;
  pendingReplies: ReadonlyMap<string, MobileTextCommand>;
  rememberReply: (chatId: string, command: MobileTextCommand) => void;
  forgetReply: (chatId: string, command: MobileTextCommand) => void;
  approvalAttempts: Map<string, MobileApprovalCommand>;
} | null>(null);

export function useSession() {
  const current = useContext(SessionContext);
  if (!current) throw new Error('La pantalla requiere una sesión iniciada.');
  return current;
}

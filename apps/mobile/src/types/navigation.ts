import { ConversationV1, ConversationMessageV1 } from '@whatsap-automat/contracts';

export type RootStackParamList = {
  Inbox: undefined;
  ChatDetail: {
    conversationId: string;
    conversationTitle?: string;
    channel?: string;
    initialConversation?: ConversationV1;
  };
};

export interface MobileThemeColors {
  background: string;
  surface: string;
  surfaceLight: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  primary: string;
  primaryHover: string;
  accent: string;
  danger: string;
  warning: string;
  success: string;
  badgeAi: string;
  badgeHuman: string;
}

export const DARK_THEME: MobileThemeColors = {
  background: '#090d16',
  surface: '#0f172a',
  surfaceLight: '#1e293b',
  border: '#334155',
  textPrimary: '#f8fafc',
  textSecondary: '#cbd5e1',
  textMuted: '#64748b',
  primary: '#0d9488', // teal-600
  primaryHover: '#0f766e',
  accent: '#10b981', // emerald-500
  danger: '#f43f5e', // rose-500
  warning: '#f59e0b', // amber-500
  success: '#22c55e', // green-500
  badgeAi: '#6366f1', // indigo-500
  badgeHuman: '#0d9488', // teal-600
};

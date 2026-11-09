import type { MobileConversation } from '../services/apiClient';

export type RootStackParamList = {
  Inbox: undefined;
  ChatDetail: {
    chat: MobileConversation;
  };
};

export const DARK_THEME = {
  background: '#090d16',
  surface: '#0f172a',
  surfaceLight: '#1e293b',
  border: '#334155',
  textPrimary: '#f8fafc',
  textSecondary: '#cbd5e1',
  textMuted: '#94a3b8',
  primary: '#0d9488',
  primaryHover: '#0f766e',
  accent: '#10b981',
  danger: '#f43f5e',
} as const;

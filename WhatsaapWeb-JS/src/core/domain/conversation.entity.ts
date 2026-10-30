export interface Conversation {
  id: number;
  companyId: number;
  channel: string;
  externalConversationId: string;
  contactId: number | null;
  type: string | null;
  title: string | null;
  lastMessageAt: Date | null;
  unreadCount: number;
  createdAt: Date;
  updatedAt: Date;
}

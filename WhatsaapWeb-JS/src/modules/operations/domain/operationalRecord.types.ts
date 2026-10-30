export type OperationalContext = {
  companyId: number;
  chatId: string;
  userId: number | null;
};

export type CustomerOrder = {
  id: number;
  companyId: number;
  contactId: number | null;
  conversationId: number | null;
  sourceMessageId: number | null;
  createdBy: number | null;
  title: string;
  serviceType: string;
  status: string;
  notes: string | null;
  metadata: Record<string, unknown>;
  occurredAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type OperationalAction = {
  id: number;
  companyId: number;
  orderId: number | null;
  contactId: number | null;
  conversationId: number | null;
  messageId: number | null;
  actorUserId: number | null;
  actionType: string;
  status: string;
  description: string | null;
  metadata: Record<string, unknown>;
  occurredAt: Date;
  createdAt: Date;
};

export type ResolvedConversationContext = {
  contactId: number | null;
  conversationId: number | null;
  chatId: string;
};

export type CompleteServiceSessionResult = {
  order: CustomerOrder;
  action: OperationalAction;
};

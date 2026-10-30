export type CustomerHistoryContact = {
  id: number;
  externalContactId: string;
  phone: string | null;
  name: string | null;
  displayName: string | null;
  profileName: string | null;
  waId: string | null;
  firstSeenAt: Date | null;
  lastSeenAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

export type CustomerHistoryConversation = {
  id: number;
  chatId: string;
  title: string | null;
  status: string | null;
  unreadCount: number;
  lastMessageAt: Date | null;
  lastMessagePreview: string | null;
  lastMessageDirection: string | null;
  serviceWindowExpiresAt: Date | null;
  archivedAt: Date | null;
  closedAt: Date | null;
};

export type CustomerHistoryMessage = {
  id: number;
  providerMessageId: string | null;
  conversationId: number | null;
  chatId: string | null;
  direction: string;
  body: string | null;
  messageType: string | null;
  status: string | null;
  occurredAt: Date | null;
  hasAttachments: boolean;
};

export type CustomerHistoryTag = {
  id: string;
  name: string;
  color: string | null;
  isDefault: boolean;
  chatIds: string[];
};

export type CustomerHistoryOrder = {
  id: number;
  title: string;
  serviceType: string;
  orderType: string;
  status: string;
  notes: string | null;
  createdBy: number | null;
  agentId: number | null;
  conversationId: number | null;
  occurredAt: Date | null;
  confirmedAt: Date | null;
  reservedAt: Date | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  items: Array<{
    id: number;
    productId: number | null;
    commercialItemId: number | null;
    productName: string;
    itemTypeSnapshot: string;
    sku: string | null;
    quantity: number;
    unitPrice: number | null;
    currency: string;
    status: string;
    availabilityStatus: string;
  }>;
  stockMovements: Array<{
    id: number;
    productId: number | null;
    commercialItemId: number | null;
    movementType: string;
    quantity: number;
    occurredAt: Date | null;
  }>;
};

export type CustomerHistoryAction = {
  id: number;
  orderId: number | null;
  actionType: string;
  status: string;
  description: string | null;
  actorUserId: number | null;
  conversationId: number | null;
  messageId: number | null;
  occurredAt: Date | null;
  createdAt: Date | null;
};

export type CustomerHistory = {
  contact: CustomerHistoryContact;
  conversations: CustomerHistoryConversation[];
  recentMessages: CustomerHistoryMessage[];
  tags: CustomerHistoryTag[];
  orders: CustomerHistoryOrder[];
  actions: CustomerHistoryAction[];
  meta: {
    conversationLimit: number;
    messageLimit: number;
    generatedAt: string;
    pendingSources: string[];
  };
};

export type CustomerHistoryLimits = {
  conversationLimit: number;
  messageLimit: number;
};

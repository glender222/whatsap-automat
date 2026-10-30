export interface CustomerHistoryContact {
  id: number;
  externalContactId: string;
  phone: string | null;
  name: string | null;
  displayName: string | null;
  profileName: string | null;
  waId: string | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CustomerHistoryConversation {
  id: number;
  chatId: string;
  title: string | null;
  status: string | null;
  unreadCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastMessageDirection: string | null;
  serviceWindowExpiresAt: string | null;
  archivedAt: string | null;
  closedAt: string | null;
}

export interface CustomerHistoryMessage {
  id: number;
  providerMessageId: string | null;
  conversationId: number | null;
  chatId: string | null;
  direction: string;
  body: string | null;
  messageType: string | null;
  status: string | null;
  occurredAt: string | null;
  hasAttachments: boolean;
}

export interface CustomerHistoryTag {
  id: string;
  name: string;
  color: string | null;
  isDefault: boolean;
  chatIds: string[];
}

export interface CustomerHistoryOrder {
  id: number;
  title: string;
  serviceType: string;
  orderType?: string;
  status: string;
  notes: string | null;
  createdBy: number | null;
  agentId?: number | null;
  conversationId: number | null;
  occurredAt: string | null;
  confirmedAt?: string | null;
  reservedAt?: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  items?: Array<{
    id: number;
    productId: number | null;
    commercialItemId?: number | null;
    productName: string;
    itemTypeSnapshot?: string;
    sku: string | null;
    quantity: number;
    unitPrice: number | null;
    currency: string;
    status: string;
    availabilityStatus?: string;
  }>;
  stockMovements?: Array<{
    id: number;
    productId: number | null;
    commercialItemId?: number | null;
    movementType: string;
    quantity: number;
    occurredAt: string | null;
  }>;
}

export interface CustomerHistoryAction {
  id: number;
  orderId: number | null;
  actionType: string;
  status: string;
  description: string | null;
  actorUserId: number | null;
  conversationId: number | null;
  messageId: number | null;
  occurredAt: string | null;
  createdAt: string | null;
}

export interface CustomerHistory {
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
}

import {
  CompleteServiceSessionResult,
  CustomerOrder,
  OperationalAction,
  OperationalContext,
  ResolvedConversationContext,
} from '../../domain/operationalRecord.types';

export type CreateOrderInput = {
  companyId: number;
  contactId: number | null;
  conversationId: number | null;
  sourceMessageId?: number | null;
  createdBy: number | null;
  title: string;
  serviceType: string;
  status: string;
  notes?: string | null;
  metadata?: Record<string, unknown>;
};

export type CreateActionInput = {
  companyId: number;
  orderId?: number | null;
  contactId: number | null;
  conversationId: number | null;
  messageId?: number | null;
  actorUserId: number | null;
  actionType: string;
  status: string;
  description?: string | null;
  metadata?: Record<string, unknown>;
};

export interface OperationalRecordRepositoryPort {
  resolveConversationContext(context: OperationalContext): Promise<ResolvedConversationContext>;
  createOrder(input: CreateOrderInput): Promise<CustomerOrder>;
  createAction(input: CreateActionInput): Promise<OperationalAction>;
  completeServiceSession(context: OperationalContext): Promise<CompleteServiceSessionResult>;
}

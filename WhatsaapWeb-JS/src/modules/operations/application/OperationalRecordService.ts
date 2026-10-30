import { OperationalRecordRepositoryPort } from './ports/OperationalRecordRepositoryPort';
import { CompleteServiceSessionResult, OperationalContext, OperationalAction } from '../domain/operationalRecord.types';

export class OperationalRecordService {
  constructor(private readonly repository: OperationalRecordRepositoryPort) {}

  async completeServiceSession(context: OperationalContext): Promise<CompleteServiceSessionResult> {
    this.assertContext(context);
    return this.repository.completeServiceSession(context);
  }

  async recordMessageSent(context: OperationalContext, messageId: string | null): Promise<OperationalAction> {
    this.assertContext(context);
    const resolved = await this.repository.resolveConversationContext(context);

    return this.repository.createAction({
      companyId: context.companyId,
      contactId: resolved.contactId,
      conversationId: resolved.conversationId,
      actorUserId: context.userId,
      actionType: 'message_sent',
      status: 'completed',
      description: 'Mensaje enviado al cliente',
      metadata: {
        chatId: context.chatId,
        providerMessageId: messageId,
      },
    });
  }

  private assertContext(context: OperationalContext): void {
    if (!Number.isInteger(context.companyId) || context.companyId <= 0) {
      throw new Error('companyId invalido para registro operativo');
    }
    if (!context.chatId?.trim()) {
      throw new Error('chatId requerido para registro operativo');
    }
  }
}

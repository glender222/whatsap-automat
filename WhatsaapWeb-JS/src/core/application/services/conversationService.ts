import { InboundMessageDTO, OutboundMessageRequestDTO, MessageStatusDTO } from '../dtos/conversation.dtos';
import { ContactRepositoryPort } from '../ports/contactRepository.port';
import { ConversationRepositoryPort } from '../ports/conversationRepository.port';
import { MessageRepositoryPort } from '../ports/messageRepository.port';
import { AttachmentRepositoryPort } from '../ports/attachmentRepository.port';
import { StatusRepositoryPort } from '../ports/statusRepository.port';
import { AuditLogRepositoryPort } from '../ports/auditLogRepository.port';
import { MessageChannelPort } from '../ports/messageChannel.port';
import { UnitOfWorkPort } from '../../../shared/UnitOfWorkPort';
import { ContactRepository } from '../../infrastructure/db/repositories/contactRepository';
import { ConversationRepository } from '../../infrastructure/db/repositories/conversationRepository';
import { MessageRepository } from '../../infrastructure/db/repositories/messageRepository';
import { AttachmentRepository } from '../../infrastructure/db/repositories/attachmentRepository';
import { StatusRepository } from '../../infrastructure/db/repositories/statusRepository';
import { AuditLogRepository } from '../../infrastructure/db/repositories/auditLogRepository';
import { Message } from '../../domain/message.entity';
import { Contact } from '../../domain/contact.entity';
import { Conversation } from '../../domain/conversation.entity';
import { MessageStatus } from '../../domain/messageStatus.entity';

export interface IngestResult {
  message: Message;
  contact: Contact;
  conversation: Conversation;
  isDuplicate: boolean;
  legacyPayload?: unknown;
}

export interface OutboundResult {
  message: Message;
  providerMessageId?: string;
  status: 'sent' | 'failed';
  error?: string;
}

export interface StatusIngestResult {
  message: Message | null;
  statusRecord: MessageStatus | null;
  isDuplicate: boolean;
}

export interface LegacyEventEmitter {
  emitMessage?(companyId: number, payload: unknown): void;
  emitChatsUpdated?(companyId: number, chats: unknown[]): void;
}

/**
 * Servicio de aplicación que orquesta repositorios y canal WhatsApp
 * para persistir conversaciones, contactos, mensajes y estados.
 *
 * PR5: UnitOfWork se inyecta de forma opt-in para garantizar atomicidad
 * en operaciones multi-write (ingestInbound). Si no se provee, el flujo
 * actual sigue funcionando con el pool directo (backward compatible).
 */
export class ConversationService {
  constructor(
    private readonly contactRepository: ContactRepositoryPort,
    private readonly conversationRepository: ConversationRepositoryPort,
    private readonly messageRepository: MessageRepositoryPort,
    private readonly attachmentRepository: AttachmentRepositoryPort,
    private readonly statusRepository: StatusRepositoryPort,
    private readonly auditLogRepository: AuditLogRepositoryPort,
    private readonly channelPort: MessageChannelPort,
    private readonly legacyEmitter?: LegacyEventEmitter,
    private readonly unitOfWork?: UnitOfWorkPort,
  ) {}

  async ingestInbound(dto: InboundMessageDTO): Promise<IngestResult> {
    const companyId = dto.companyId;
    const channel = dto.channel;

    // Idempotencia: detectar duplicado ANTES de cualquier efecto secundario
    if (dto.providerMessageId) {
      const existing = await this.messageRepository.findByProviderId(companyId, channel, dto.providerMessageId);
      if (existing) {
        // Recuperar contacto y conversación para devolver un resultado consistente
        const contact = await this.contactRepository.findByExternal(companyId, channel, dto.externalContactId);
        const conversation = await this.conversationRepository.findByExternal(companyId, channel, dto.externalConversationId);
        return {
          message: existing,
          contact: contact ?? { id: 0, companyId, channel, externalContactId: dto.externalContactId, name: dto.contactName, phone: dto.contactPhone, rawProfileJson: null, createdAt: new Date(), updatedAt: new Date() },
          conversation: conversation ?? { id: 0, companyId, channel, externalConversationId: dto.externalConversationId, contactId: null, type: null, title: null, lastMessageAt: null, unreadCount: 0, createdAt: new Date(), updatedAt: new Date() },
          isDuplicate: true,
          legacyPayload: undefined,
        };
      }
    }

    let result: IngestResult;

    if (this.unitOfWork) {
      result = await this.unitOfWork.transaction(async ({ client }) => {
        const contactRepository = new ContactRepository(client);
        const conversationRepository = new ConversationRepository(client);
        const messageRepository = new MessageRepository(client);
        const attachmentRepository = new AttachmentRepository(client);
        const statusRepository = new StatusRepository(client);
        const auditLogRepository = new AuditLogRepository(client);
        return this.runInboundWrites(dto, contactRepository, conversationRepository, messageRepository, attachmentRepository, statusRepository, auditLogRepository);
      });
    } else {
      result = await this.runInboundWrites(dto, this.contactRepository, this.conversationRepository, this.messageRepository, this.attachmentRepository, this.statusRepository, this.auditLogRepository);
    }

    // 8. Payload legacy compatible con frontend actual
    const legacyPayload = {
      id: result.message.providerMessageId,
      body: result.message.body,
      fromMe: false,
      timestamp: Math.floor(dto.occurredAt.getTime() / 1000),
      sender: dto.externalContactId,
      type: result.message.messageType,
      mediaUrl: null,
      mimetype: null,
      filename: null,
      chatId: dto.externalConversationId,
    };

    if (this.legacyEmitter?.emitMessage) {
      this.legacyEmitter.emitMessage(companyId, legacyPayload);
    }
    if (this.legacyEmitter?.emitChatsUpdated) {
      this.legacyEmitter.emitChatsUpdated(companyId, [
        {
          id: result.conversation.externalConversationId,
          name: result.contact.name ?? result.contact.externalContactId,
          lastMessageTimestamp: legacyPayload.timestamp,
          unreadCount: (result.conversation.unreadCount || 0) + 1,
          isGroup: false,
          lastMessagePreview: result.message.body?.substring(0, 50) ?? null,
        },
      ]);
    }

    return {
      ...result,
      legacyPayload,
    };
  }

  private async runInboundWrites(
    dto: InboundMessageDTO,
    contactRepository: ContactRepositoryPort,
    conversationRepository: ConversationRepositoryPort,
    messageRepository: MessageRepositoryPort,
    attachmentRepository: AttachmentRepositoryPort,
    statusRepository: StatusRepositoryPort,
    auditLogRepository: AuditLogRepositoryPort,
  ): Promise<Omit<IngestResult, 'legacyPayload'>> {
    const companyId = dto.companyId;
    const channel = dto.channel;

    // 1. Contacto
    const contact = await contactRepository.findOrCreate({
      companyId,
      channel,
      externalContactId: dto.externalContactId,
      name: dto.contactName,
      phone: dto.contactPhone,
      rawProfile: undefined,
    });

    // 2. Conversación
    const conversation = await conversationRepository.upsert({
      companyId,
      channel,
      externalConversationId: dto.externalConversationId,
      contactId: contact.id,
      type: 'whatsapp',
      title: dto.contactName ?? dto.externalContactId,
    });

    // 3. Actualizar timestamp y unread
    await conversationRepository.updateLastMessage(
      conversation.id,
      dto.occurredAt,
      (conversation.unreadCount || 0) + 1
    );

    // 4. Mensaje (idempotente por constraints UNIQUE)
    const message = await messageRepository.insert({
      companyId,
      conversationId: conversation.id,
      direction: 'inbound',
      channel,
      providerMessageId: dto.providerMessageId,
      clientRequestId: null,
      body: dto.body,
      messageType: dto.messageType,
      status: 'received',
      occurredAt: dto.occurredAt,
      rawPayloadJson: dto.rawPayload,
    });

    // 5. Adjuntos
    if (dto.attachments && dto.attachments.length > 0) {
      for (const att of dto.attachments) {
        await attachmentRepository.insert({
          messageId: message.id,
          filename: att.filename,
          mimeType: att.mimeType,
          sizeBytes: att.sizeBytes,
          externalUrl: att.externalUrl,
          internalPath: att.internalPath,
          metadataJson: att.metadata ?? null,
        });
      }
    }

    // 6. Estado inicial
    await statusRepository.insert({
      messageId: message.id,
      status: 'received',
      source: 'whatsapp',
      occurredAt: dto.occurredAt,
      metadataJson: { event: 'message' },
    });

    // 7. Auditoría
    await auditLogRepository.log({
      companyId,
      actor: 'system',
      action: 'ingest_inbound',
      entityType: 'message',
      entityId: String(message.id),
      metadataJson: { providerMessageId: dto.providerMessageId },
    });

    return {
      message,
      contact,
      conversation,
      isDuplicate: false,
    };
  }

  async requestOutbound(dto: OutboundMessageRequestDTO): Promise<OutboundResult> {
    const companyId = dto.companyId;
    const channel = dto.channel;

    // 1. Persistir mensaje en estado pending
    let message = await this.messageRepository.insert({
      companyId,
      conversationId: null,
      direction: 'outbound',
      channel,
      providerMessageId: null,
      clientRequestId: dto.clientRequestId,
      body: dto.body,
      messageType: dto.messageType,
      status: 'pending',
      occurredAt: new Date(),
      rawPayloadJson: { request: dto },
    });

    try {
      // 2. Enviar vía adaptador
      const result = await this.channelPort.sendMessage(dto);

      // 3. Correlacionar ID externo y estado sent
      const updatedProvider = await this.messageRepository.updateProviderId(message.id, result.providerMessageId);
      if (updatedProvider) message = updatedProvider;

      const updatedStatus = await this.messageRepository.updateStatus(message.id, 'sent');
      if (updatedStatus) message = updatedStatus;

      await this.statusRepository.insert({
        messageId: message.id,
        status: 'sent',
        source: 'whatsapp',
        occurredAt: new Date(),
        metadataJson: result.raw ?? null,
      });

      await this.auditLogRepository.log({
        companyId,
        actor: 'system',
        action: 'outbound_sent',
        entityType: 'message',
        entityId: String(message.id),
        metadataJson: { providerMessageId: result.providerMessageId },
      });

      return {
        message,
        providerMessageId: result.providerMessageId,
        status: 'sent',
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);

      const updatedStatus = await this.messageRepository.updateStatus(message.id, 'failed');
      if (updatedStatus) message = updatedStatus;

      await this.statusRepository.insert({
        messageId: message.id,
        status: 'failed',
        source: 'whatsapp',
        occurredAt: new Date(),
        metadataJson: { error: errMsg },
      });

      await this.auditLogRepository.log({
        companyId,
        actor: 'system',
        action: 'outbound_failed',
        entityType: 'message',
        entityId: String(message.id),
        metadataJson: { error: errMsg },
      });

      return {
        message,
        status: 'failed',
        error: errMsg,
      };
    }
  }

  async ingestStatus(dto: MessageStatusDTO): Promise<StatusIngestResult> {
    const companyId = dto.companyId;
    const channel = dto.channel;

    // 1. Buscar mensaje por providerMessageId
    const message = await this.messageRepository.findByProviderId(companyId, channel, dto.providerMessageId);
    if (!message) {
      return { message: null, statusRecord: null, isDuplicate: false };
    }

    // 2. Insertar estado (el schema no impide duplicados exactos; se deja pasar por trazabilidad)
    const statusRecord = await this.statusRepository.insert({
      messageId: message.id,
      status: dto.status,
      source: dto.source ?? 'whatsapp',
      occurredAt: dto.occurredAt,
      metadataJson: dto.metadata ?? null,
    });

    // 3. Actualizar status del mensaje principal
    await this.messageRepository.updateStatus(message.id, dto.status);

    // 4. Auditoría
    await this.auditLogRepository.log({
      companyId,
      actor: 'system',
      action: 'ingest_status',
      entityType: 'message',
      entityId: String(message.id),
      metadataJson: { providerMessageId: dto.providerMessageId, status: dto.status },
    });

    return {
      message,
      statusRecord,
      isDuplicate: false,
    };
  }
}

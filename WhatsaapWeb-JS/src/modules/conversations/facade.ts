/**
 * Conversations Facade — Preparación gradual hacia src/modules/conversations
 *
 * Este archivo re-exporta todo el conversations "core" actual desde src/core,
 * actuando como puente de compatibilidad. No contiene implementación propia.
 *
 * Cuando se apruebe la migración física, estas exportaciones apuntarán a
 * archivos locales en src/modules/conversations/ en lugar de src/core.
 *
 * @deprecated Una vez migrados los archivos, este facade se convertirá en
 * barrel local o se eliminará en favor de index.ts directo.
 */

// ── Domain Entities ──
export { Message, MessageDirection } from '../../core/domain/message.entity';
export { Contact } from '../../core/domain/contact.entity';
export { Conversation } from '../../core/domain/conversation.entity';
export { MessageStatus } from '../../core/domain/messageStatus.entity';
export { Attachment } from '../../core/domain/attachment.entity';
export { Company } from '../../core/domain/company.entity';
export { AuditLog } from '../../core/domain/auditLog.entity';

// ── Application DTOs ──
export {
  ContactDTO,
  ConversationDTO,
  AttachmentDTO,
  InboundMessageDTO,
  OutboundMessageRequestDTO,
  MessageStatusDTO,
} from '../../core/application/dtos/conversation.dtos';

// ── Application Ports ──
export { ContactRepositoryPort } from '../../core/application/ports/contactRepository.port';
export { ConversationRepositoryPort } from '../../core/application/ports/conversationRepository.port';
export { MessageRepositoryPort } from '../../core/application/ports/messageRepository.port';
export { AttachmentRepositoryPort } from '../../core/application/ports/attachmentRepository.port';
export { StatusRepositoryPort } from '../../core/application/ports/statusRepository.port';
export { AuditLogRepositoryPort } from '../../core/application/ports/auditLogRepository.port';
export { CompanyRepositoryPort } from '../../core/application/ports/companyRepository.port';
export {
  MessageChannelPort,
  SendResult,
  MediaRef,
  MediaResult,
  StatusResult,
} from '../../core/application/ports/messageChannel.port';
export {
  MessageChannelPort as WhatsAppChannelPort,
  SendResult as WhatsAppSendResult,
  MediaRef as WhatsAppMediaRef,
  MediaResult as WhatsAppMediaResult,
  StatusResult as WhatsAppStatusResult,
} from '../../core/application/ports/whatsappChannel.port';

// ── Application Services ──
export {
  ConversationService,
  IngestResult,
  OutboundResult,
  StatusIngestResult,
  LegacyEventEmitter,
} from '../../core/application/services/conversationService';

// ── Application Helpers ──
export {
  resolveCompanyId,
  requireCompanyId,
} from '../../core/application/helpers/tenant.helper';
export {
  generateClientRequestId,
  generateIdempotencyKey,
} from '../../core/application/helpers/idempotency.helper';

// ── Infrastructure Repositories ──
export { ContactRepository } from '../../core/infrastructure/db/repositories/contactRepository';
export { ConversationRepository } from '../../core/infrastructure/db/repositories/conversationRepository';
export { MessageRepository } from '../../core/infrastructure/db/repositories/messageRepository';
export { AttachmentRepository } from '../../core/infrastructure/db/repositories/attachmentRepository';
export { StatusRepository } from '../../core/infrastructure/db/repositories/statusRepository';
export { AuditLogRepository } from '../../core/infrastructure/db/repositories/auditLogRepository';
export { CompanyRepository } from '../../core/infrastructure/db/repositories/companyRepository';

// ── Infrastructure Adapters ──
export { WhatsappWebAdapter } from '../../core/infrastructure/channels/whatsapp/adapters/WhatsappWebAdapter';

// ── Infrastructure Mappers ──
export { ContactMapper } from '../../core/infrastructure/db/mappers/contact.mapper';
export { ConversationMapper } from '../../core/infrastructure/db/mappers/conversation.mapper';
export { MessageMapper } from '../../core/infrastructure/db/mappers/message.mapper';
export { AttachmentMapper } from '../../core/infrastructure/db/mappers/attachment.mapper';
export { StatusMapper } from '../../core/infrastructure/db/mappers/status.mapper';
export { AuditLogMapper } from '../../core/infrastructure/db/mappers/auditLog.mapper';
export { CompanyMapper } from '../../core/infrastructure/db/mappers/company.mapper';
export {
  mapInboundMessage,
  mapMessageStatus,
} from '../../core/infrastructure/channels/whatsapp/mappers/whatsappWeb.mapper';

// ── Infrastructure Integration ──
export {
  ConversationCore,
  createConversationCore,
} from '../../core/infrastructure/integration/conversationCore';

import pool from '../../../config/database';
import { UnitOfWorkPort } from '../../../shared/UnitOfWorkPort';
import { CompanyRepository } from '../db/repositories/companyRepository';
import { ContactRepository } from '../db/repositories/contactRepository';
import { ConversationRepository } from '../db/repositories/conversationRepository';
import { MessageRepository } from '../db/repositories/messageRepository';
import { AttachmentRepository } from '../db/repositories/attachmentRepository';
import { StatusRepository } from '../db/repositories/statusRepository';
import { AuditLogRepository } from '../db/repositories/auditLogRepository';
import { WhatsappWebAdapter } from '../channels/whatsapp/adapters/WhatsappWebAdapter';
import { ConversationService, LegacyEventEmitter } from '../../application/services/conversationService';

export interface ConversationCore {
  conversationService: ConversationService;
  adapter: WhatsappWebAdapter;
  repositories: {
    companyRepository: CompanyRepository;
    contactRepository: ContactRepository;
    conversationRepository: ConversationRepository;
    messageRepository: MessageRepository;
    attachmentRepository: AttachmentRepository;
    statusRepository: StatusRepository;
    auditLogRepository: AuditLogRepository;
  };
}

export function createConversationCore(
  legacyService: any,
  io: any,
  defaultCompanyId = 1,
  unitOfWork?: UnitOfWorkPort,
): ConversationCore {
  const companyRepository = new CompanyRepository(pool);
  const contactRepository = new ContactRepository(pool);
  const conversationRepository = new ConversationRepository(pool);
  const messageRepository = new MessageRepository(pool);
  const attachmentRepository = new AttachmentRepository(pool);
  const statusRepository = new StatusRepository(pool);
  const auditLogRepository = new AuditLogRepository(pool);

  const adapter = new WhatsappWebAdapter(legacyService, defaultCompanyId);

  const legacyEmitter: LegacyEventEmitter = {
    emitMessage: (chatId: string, payload: unknown) => {
      if (io) io.to(chatId).emit('message', payload);
    },
    emitChatsUpdated: (chats: unknown[]) => {
      if (io) io.emit('chats-updated', chats);
    },
  };

  const conversationService = new ConversationService(
    contactRepository,
    conversationRepository,
    messageRepository,
    attachmentRepository,
    statusRepository,
    auditLogRepository,
    adapter,
    legacyEmitter,
    unitOfWork,
  );

  return {
    conversationService,
    adapter,
    repositories: {
      companyRepository,
      contactRepository,
      conversationRepository,
      messageRepository,
      attachmentRepository,
      statusRepository,
      auditLogRepository,
    },
  };
}

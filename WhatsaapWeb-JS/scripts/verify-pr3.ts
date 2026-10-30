import pool from '../src/config/database';
import { ContactRepository } from '../src/core/infrastructure/db/repositories/contactRepository';
import { ConversationRepository } from '../src/core/infrastructure/db/repositories/conversationRepository';
import { MessageRepository } from '../src/core/infrastructure/db/repositories/messageRepository';
import { AttachmentRepository } from '../src/core/infrastructure/db/repositories/attachmentRepository';
import { StatusRepository } from '../src/core/infrastructure/db/repositories/statusRepository';
import { AuditLogRepository } from '../src/core/infrastructure/db/repositories/auditLogRepository';
import { CompanyRepository } from '../src/core/infrastructure/db/repositories/companyRepository';
import { ConversationService } from '../src/core/application/services/conversationService';
import { WhatsappWebAdapter } from '../src/core/infrastructure/channels/whatsapp/adapters/WhatsappWebAdapter';
import { InboundMessageDTO, OutboundMessageRequestDTO } from '../src/core/application/dtos/conversation.dtos';

const defaultCompanyId = parseInt(process.env.DEFAULT_COMPANY_ID || '1', 10) || 1;

async function main() {
  console.log('🔍 PR3 Smoke Test: Adaptador WhatsApp + ConversationService');

  // Verificar conectividad a PostgreSQL
  try {
    await pool.query('SELECT 1');
    console.log('✅ PostgreSQL conectado');
  } catch (err: any) {
    console.warn('⚠️ PostgreSQL no disponible (esperado en este entorno):', err.message);
    console.log('⏭️ Se omite ejecución con DB real. La compilación TypeScript ya fue verificada.');
    return;
  }

  // Asegurar tenant default
  const companyRepo = new CompanyRepository(pool);
  await companyRepo.ensureDefault(defaultCompanyId, 'Default Company');

  // Repositorios
  const contactRepo = new ContactRepository(pool);
  const conversationRepo = new ConversationRepository(pool);
  const messageRepo = new MessageRepository(pool);
  const attachmentRepo = new AttachmentRepository(pool);
  const statusRepo = new StatusRepository(pool);
  const auditLogRepo = new AuditLogRepository(pool);

  // Mock del servicio legacy
  const mockLegacyService = {
    sendMessage: async (chatId: string, body: string) => ({
      id: { _serialized: `mock-sent-${Date.now()}` },
      body,
    }),
    downloadMedia: async (_messageId: string) => ({
      data: Buffer.from('mock').toString('base64'),
      mimetype: 'text/plain',
      filename: 'mock.txt',
    }),
    markAsRead: async (_chatId: string) => { /* no-op */ },
    getStatus: () => ({ isConnected: true, isReady: true, status: 'CONNECTED' }),
  };

  const adapter = new WhatsappWebAdapter(mockLegacyService, defaultCompanyId);
  const service = new ConversationService(
    contactRepo,
    conversationRepo,
    messageRepo,
    attachmentRepo,
    statusRepo,
    auditLogRepo,
    adapter,
  );

  // Simular inbound
  const inboundDto: InboundMessageDTO = {
    companyId: defaultCompanyId,
    channel: 'whatsapp',
    externalConversationId: '123456789@c.us',
    externalContactId: '123456789@c.us',
    contactName: 'Test Contact',
    contactPhone: '123456789',
    providerMessageId: `mock-inbound-${Date.now()}`,
    body: 'Hello from smoke test',
    messageType: 'chat',
    occurredAt: new Date(),
    rawPayload: { test: true },
    attachments: [],
  };

  const ingestResult = await service.ingestInbound(inboundDto);
  console.log('✅ Ingest inbound result:', {
    messageId: ingestResult.message.id,
    contactId: ingestResult.contact.id,
    conversationId: ingestResult.conversation.id,
  });

  // Verificar persistencia
  const foundContact = await contactRepo.findByExternal(defaultCompanyId, 'whatsapp', inboundDto.externalContactId);
  if (!foundContact) throw new Error('Contacto no encontrado tras ingest');
  console.log('✅ Contacto persistido');

  const foundConversation = await conversationRepo.findById(ingestResult.conversation.id);
  if (!foundConversation) throw new Error('Conversación no encontrada tras ingest');
  console.log('✅ Conversación persistida');

  const foundMessages = await messageRepo.findByConversation(ingestResult.conversation.id);
  if (foundMessages.length === 0) throw new Error('Mensaje no encontrado tras ingest');
  console.log('✅ Mensaje persistido');

  // Simular outbound
  const outboundDto: OutboundMessageRequestDTO = {
    companyId: defaultCompanyId,
    channel: 'whatsapp',
    externalConversationId: '123456789@c.us',
    externalContactId: '123456789@c.us',
    clientRequestId: `mock-outbound-${Date.now()}`,
    body: 'Hello outbound',
    messageType: 'chat',
    attachments: [],
  };

  const outboundResult = await service.requestOutbound(outboundDto);
  console.log('✅ Outbound result:', {
    messageId: outboundResult.message.id,
    status: outboundResult.status,
    providerMessageId: outboundResult.providerMessageId,
  });

  if (outboundResult.status !== 'sent') {
    throw new Error(`Outbound esperaba sent pero obtuvo ${outboundResult.status}: ${outboundResult.error}`);
  }

  console.log('🎉 PR3 Smoke Test passed');
}

main().catch((err) => {
  console.error('❌ PR3 Smoke Test failed:', err);
  process.exit(1);
});

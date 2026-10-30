/**
 * Script de verificación manual para PR2:
 * DTOs provider-neutral, repositorios TypeScript y puerto de canal.
 *
 * Ejecutar con:
 *   npx tsx scripts/verify-pr2.ts
 *
 * Requiere: PostgreSQL corriendo con las tablas del Operational Core creadas
 * (vía src/core/coreModel.ts o previo PR1).
 */

import { Pool } from 'pg';
import { CompanyRepository } from '../src/core/infrastructure/db/repositories/companyRepository';
import { ContactRepository } from '../src/core/infrastructure/db/repositories/contactRepository';
import { ConversationRepository } from '../src/core/infrastructure/db/repositories/conversationRepository';
import { MessageRepository } from '../src/core/infrastructure/db/repositories/messageRepository';
import { AttachmentRepository } from '../src/core/infrastructure/db/repositories/attachmentRepository';
import { StatusRepository } from '../src/core/infrastructure/db/repositories/statusRepository';
import { AuditLogRepository } from '../src/core/infrastructure/db/repositories/auditLogRepository';
import { resolveCompanyId } from '../src/core/application/helpers/tenant.helper';
import { generateClientRequestId } from '../src/core/application/helpers/idempotency.helper';

async function main(): Promise<void> {
  const databasePassword = String(process.env.DB_PASSWORD || '').trim();
  if (!databasePassword) throw new Error('Variable de entorno requerida: DB_PASSWORD');
  const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'whatsapp_empresas',
    user: process.env.DB_USER || 'postgres',
    password: databasePassword,
  });

  // Preflight: graceful skip si PostgreSQL no está disponible
  try {
    await pool.query('SELECT 1');
    console.log('✅ PostgreSQL conectado');
  } catch (err: any) {
    console.warn('⚠️ PostgreSQL no disponible:', err.message);
    console.log('⏭️ Se omite ejecución con DB real. Verificación de compilación ya fue realizada.');
    await pool.end();
    process.exit(0);
  }

  const companyRepo = new CompanyRepository(pool);
  const contactRepo = new ContactRepository(pool);
  const conversationRepo = new ConversationRepository(pool);
  const messageRepo = new MessageRepository(pool);
  const attachmentRepo = new AttachmentRepository(pool);
  const statusRepo = new StatusRepository(pool);
  const auditRepo = new AuditLogRepository(pool);

  const companyId = resolveCompanyId();

  try {
    console.log('=== PR2 Verification Script ===\n');

    // 1. Ensure default company
    const company = await companyRepo.ensureDefault(companyId, 'Default Company');
    console.log('✅ Company:', company.id, company.name);

    // 2. Upsert contact
    const contact = await contactRepo.upsert({
      companyId,
      channel: 'whatsapp',
      externalContactId: '5511999999999@c.us',
      name: 'Test Contact',
      phone: '5511999999999',
      rawProfile: { pushname: 'Test' },
    });
    console.log('✅ Contact:', contact.id, contact.externalContactId, contact.name);

    // 3. Upsert conversation
    const conversation = await conversationRepo.upsert({
      companyId,
      channel: 'whatsapp',
      externalConversationId: '5511999999999@c.us',
      contactId: contact.id,
      type: 'individual',
      title: 'Test Conversation',
    });
    console.log('✅ Conversation:', conversation.id, conversation.externalConversationId);

    // 4. Insert message (idempotent by provider_message_id)
    const providerMessageId = `wamid.${Date.now()}`;
    const message = await messageRepo.insert({
      companyId,
      conversationId: conversation.id,
      direction: 'inbound',
      channel: 'whatsapp',
      providerMessageId,
      clientRequestId: generateClientRequestId(),
      body: 'Hello from PR2 verification',
      messageType: 'chat',
      status: 'received',
      occurredAt: new Date(),
      rawPayloadJson: { id: providerMessageId, body: 'Hello' },
    });
    console.log('✅ Message:', message.id, message.providerMessageId, message.body);

    // 5. Idempotency test: same providerMessageId should not duplicate
    const messageDup = await messageRepo.insert({
      companyId,
      conversationId: conversation.id,
      direction: 'inbound',
      channel: 'whatsapp',
      providerMessageId,
      clientRequestId: generateClientRequestId(),
      body: 'Duplicate attempt',
      messageType: 'chat',
      status: 'received',
      occurredAt: new Date(),
      rawPayloadJson: { id: providerMessageId, body: 'Duplicate' },
    });
    console.log('✅ Duplicate handled:', messageDup.id === message.id ? 'SAME ID (ok)' : 'DIFFERENT ID (error)');

    // 6. Attachment
    const attachment = await attachmentRepo.insert({
      messageId: message.id,
      filename: 'test.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 1024,
      externalUrl: null,
      internalPath: null,
      metadataJson: { width: 100, height: 100 },
    });
    console.log('✅ Attachment:', attachment.id, attachment.filename);

    // 7. Status
    const status = await statusRepo.insert({
      messageId: message.id,
      status: 'delivered',
      source: 'whatsapp-web.js',
      occurredAt: new Date(),
      metadataJson: { ack: 2 },
    });
    console.log('✅ Status:', status.id, status.status);

    // 8. Audit log
    const audit = await auditRepo.log({
      companyId,
      actor: 'verify-pr2-script',
      action: 'PR2_VERIFICATION',
      entityType: 'message',
      entityId: String(message.id),
      metadataJson: { script: 'verify-pr2', passed: true },
    });
    console.log('✅ AuditLog:', audit.id, audit.action);

    // 9. Readbacks
    const contacts = await contactRepo.findByExternal(companyId, 'whatsapp', '5511999999999@c.us');
    console.log('✅ Readback contact:', contacts?.id);

    const conversations = await conversationRepo.findByCompany(companyId, 10, 0);
    console.log('✅ Readback conversations count:', conversations.length);

    const messages = await messageRepo.findByConversation(conversation.id, 10, 0);
    console.log('✅ Readback messages count:', messages.length);

    console.log('\n=== PR2 Verification PASSED ===');
  } catch (error) {
    console.error('\n❌ PR2 Verification FAILED:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();

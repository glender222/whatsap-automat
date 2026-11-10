/**
 * Script de verificación manual para PR4/Phase 5:
 * Verifica estabilización del core de conversaciones persistentes.
 *
 * Ejecutar con:
 *   npx tsx scripts/verify-conversations-core.ts
 *
 * Requiere: PostgreSQL corriendo con tablas del Operational Core.
 * Si PostgreSQL no está disponible, el script omite con mensaje claro
 * y sale con código 0 para no bloquear typecheck/smoke en entornos sin DB.
 *
 * --- Rollback / Verificación Checklist ---
 * 1) Desactivar flags: CONVERSATIONS_PERSIST_READS=false y CONVERSATIONS_PERSIST_WRITES=false (default).
 * 2) npm run start:legacy conserva un alias al backend compilado después de migrar la base.
 * 3) coreModel.createTablesIfNotExists() es additive-only; nunca borra ni altera destructivamente.
 * 4) Eliminar código nuevo (src/core/, dist/core/) no rompe endpoints legacy ni el frontend.
 * 5) company_id default está documentado en src/config/index.js (DEFAULT_COMPANY_ID env var, fallback 1).
 * 6) Errores de persistencia se loguean en consola/auditLogRepository y nunca tumban flujo legacy.
 * 7) Fallback de lectura/escritura activa automáticamente cuando persistReads/persistWrites falla.
 */

import { Pool } from 'pg';
import { coreModel } from '../src/core/coreModel';
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

  let connected = false;
  try {
    await pool.query('SELECT 1');
    connected = true;
    console.log('✅ PostgreSQL conectado');
  } catch (err: any) {
    console.warn('⚠️ PostgreSQL no disponible:', err.message);
    console.log('⏭️ Se omite ejecución con DB real. Verificación de compilación ya fue realizada.');
    await pool.end();
    process.exit(0);
  }

  if (!connected) {
    await pool.end();
    process.exit(0);
  }

  try {
    console.log('\n=== PR4/Phase 5 Verification Script ===\n');

    // 1. DDL: verificar/crear tablas (additive-only)
    console.log('🔧 Verificando tablas del Operational Core...');
    await coreModel.createTablesIfNotExists();
    console.log('✅ Tablas verificadas\n');

    const companyRepo = new CompanyRepository(pool);
    const contactRepo = new ContactRepository(pool);
    const conversationRepo = new ConversationRepository(pool);
    const messageRepo = new MessageRepository(pool);
    const attachmentRepo = new AttachmentRepository(pool);
    const statusRepo = new StatusRepository(pool);
    const auditRepo = new AuditLogRepository(pool);

    const companyId1 = resolveCompanyId();
    const companyId2 = 9999; // Tenant aislado para verificación

    // 2. Tenant default
    const company1 = await companyRepo.ensureDefault(companyId1, 'Default Company');
    console.log('✅ Tenant default:', company1.id, company1.name);

    const company2 = await companyRepo.ensureDefault(companyId2, 'Isolation Test Company');
    console.log('✅ Tenant aislado:', company2.id, company2.name);

    // 3. Contacto
    const contact = await contactRepo.upsert({
      companyId: companyId1,
      channel: 'whatsapp',
      externalContactId: '5511999999999@c.us',
      name: 'Test Contact',
      phone: '5511999999999',
      rawProfile: { pushname: 'Test' },
    });
    console.log('✅ Contact:', contact.id, contact.externalContactId);

    // 4. Conversación
    const conversation = await conversationRepo.upsert({
      companyId: companyId1,
      channel: 'whatsapp',
      externalConversationId: '5511999999999@c.us',
      contactId: contact.id,
      type: 'individual',
      title: 'Test Conversation',
    });
    console.log('✅ Conversation:', conversation.id, conversation.externalConversationId);

    // 5. Mensaje inbound
    const providerMessageId = `wamid.${Date.now()}`;
    const message = await messageRepo.insert({
      companyId: companyId1,
      conversationId: conversation.id,
      direction: 'inbound',
      channel: 'whatsapp',
      providerMessageId,
      clientRequestId: generateClientRequestId(),
      body: 'Hello from PR4 verification',
      messageType: 'chat',
      status: 'received',
      occurredAt: new Date(),
      rawPayloadJson: { id: providerMessageId, body: 'Hello' },
    });
    console.log('✅ Message:', message.id, message.providerMessageId);

    // 6. Idempotencia: mismo providerMessageId no duplica
    const messageDup = await messageRepo.insert({
      companyId: companyId1,
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
    const idempotentOk = messageDup.id === message.id;
    console.log('✅ Idempotencia:', idempotentOk ? 'SAME ID (ok)' : 'DIFFERENT ID (ERROR)');

    // 7. Tenant isolation: companyId2 no debe ver datos de companyId1
    const convsC2 = await conversationRepo.findByCompany(companyId2, 10, 0);
    const isolatedOk = convsC2.length === 0;
    console.log('✅ Tenant isolation:', isolatedOk ? 'ISOLATED (ok)' : 'LEAKED (ERROR)');

    // 8. Adjunto
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

    // 9. Estado
    const status = await statusRepo.insert({
      messageId: message.id,
      status: 'delivered',
      source: 'whatsapp-web.js',
      occurredAt: new Date(),
      metadataJson: { ack: 2 },
    });
    console.log('✅ Status:', status.id, status.status);

    // 10. Audit log
    const audit = await auditRepo.log({
      companyId: companyId1,
      actor: 'verify-conversations-core-script',
      action: 'PR4_VERIFICATION',
      entityType: 'message',
      entityId: String(message.id),
      metadataJson: { script: 'verify-conversations-core', passed: true },
    });
    console.log('✅ AuditLog:', audit.id, audit.action);

    // 11. Readbacks
    const contacts = await contactRepo.findByExternal(companyId1, 'whatsapp', '5511999999999@c.us');
    console.log('✅ Readback contact:', contacts?.id);

    const conversations = await conversationRepo.findByCompany(companyId1, 10, 0);
    console.log('✅ Readback conversations count:', conversations.length);

    const messages = await messageRepo.findByConversation(conversation.id, 10, 0);
    console.log('✅ Readback messages count:', messages.length);

    // 12. Flags sanity
    const persistReads = process.env.CONVERSATIONS_PERSIST_READS === 'true';
    const persistWrites = process.env.CONVERSATIONS_PERSIST_WRITES === 'true';
    console.log('\n📋 Feature flags:');
    console.log('   persistReads :', persistReads, '(default: false)');
    console.log('   persistWrites:', persistWrites, '(default: false)');

    const allOk = idempotentOk && isolatedOk;
    console.log('\n=== PR4/Phase 5 Verification', allOk ? 'PASSED ===' : 'FAILED ===');
    if (!allOk) process.exit(1);
  } catch (error) {
    console.error('\n❌ PR4/Phase 5 Verification FAILED:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();

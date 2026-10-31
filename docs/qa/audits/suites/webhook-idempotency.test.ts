import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

process.env.JWT_SECRET ||= 'test-jwt-secret-qa-audit-32-chars-strictly-for-testing';
process.env.DB_PASSWORD ||= 'test-db-password-strictly-mocked';
process.env.META_APP_SECRET ||= 'test-meta-app-secret-for-webhook-hmac-32';
process.env.WHATSAPP_PROVIDER ||= 'meta-cloud';

const rootDir = path.resolve(__dirname, '../../../../');
const backendDir = path.join(rootDir, 'WhatsaapWeb-JS');
const { generateClientRequestId, generateIdempotencyKey } = require(path.join(backendDir, 'src/core/application/helpers/idempotency.helper'));
const { MetaCloudClient } = require(path.join(backendDir, 'src/services/whatsapp/meta/MetaCloudClient'));

describe('QA Security Audit: Webhooks, Deduplicación e Idempotencia (PR-05 & PR-06)', () => {

  describe('1. Verificación Criptográfica de Webhooks (MSG-04)', () => {
    test('MetaCloudClient.verifySignature valida correctamente HMAC SHA-256 sobre rawBody', () => {
      const appSecret = 'super-secret-meta-app-key-1234567890';
      const client = new MetaCloudClient({
        appSecret,
        graphVersion: 'v21.0',
        accessToken: 'dummy-token',
        phoneNumberId: '100001',
        wabaId: '200002',
      });

      const rawBody = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }), 'utf8');
      const validSignature = 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');

      assert.equal(
        client.verifySignature(rawBody, validSignature),
        true,
        'Debe aceptar firma válida'
      );

      const invalidSignature = 'sha256=' + crypto.createHmac('sha256', 'wrong-secret').update(rawBody).digest('hex');
      assert.equal(
        client.verifySignature(rawBody, invalidSignature),
        false,
        'Debe rechazar firma generada con clave distinta (MSG-04)'
      );

      assert.equal(
        client.verifySignature(rawBody, 'invalid-format-signature'),
        false,
        'Debe rechazar firma con formato inválido'
      );
    });
  });

  describe('2. Deduplicación Inbound y Prevención de Doble Ejecución (MSG-01)', () => {
    test('persisted.duplicate=true impide la invocación de auto-respuesta del agente', () => {
      // Analizamos la regla en whatsappService.ts donde se comprueba persisted.duplicate
      const serviceFile = path.join(backendDir, 'src/services/whatsappService.ts');
      const content = fs.readFileSync(serviceFile, 'utf8');

      // Verificamos que existe el check estricto para evitar reejecutar agente
      assert.ok(
        content.includes('if (!persisted?.duplicate) {'),
        'whatsappService debe verificar !persisted?.duplicate antes de llamar a maybeAutoReplyWithAgent'
      );

      assert.ok(
        content.includes('Mensaje inbound duplicado recibido desde Meta; no se reejecuta el agente.'),
        'Debe registrar log seguro indicando que el mensaje duplicado fue omitido'
      );
    });

    test('HALLAZGO CRÍTICO MSG-01 / PR-06: idempotency.helper.ts carece de almacenamiento y verificación de estado', () => {
      const key1 = generateIdempotencyKey('inbound');
      const key2 = generateIdempotencyKey('inbound');

      assert.notEqual(key1, key2, 'Genera strings aleatorios sin correlación');
      assert.match(key1, /^inbound_\d+_[a-z0-9]+$/);

      // Verificamos que la función generateClientRequestId no persiste ni verifica duplicados
      const reqId1 = generateClientRequestId();
      const reqId2 = generateClientRequestId();
      assert.notEqual(reqId1, reqId2);

      // Evidencia: El archivo no importa base de datos ni caché
      const helperContent = fs.readFileSync(path.join(backendDir, 'src/core/application/helpers/idempotency.helper.ts'), 'utf8');
      assert.ok(!helperContent.includes('db'), 'No hay interacción con DB');
      assert.ok(!helperContent.includes('cache'), 'No hay interacción con cache');
      assert.ok(!helperContent.includes('table'), 'No hay tabla outbox');
    });

    test('HALLAZGO CRÍTICO MSG-02 / MSG-03: No existe tabla outbox transaccional en migraciones existentes', () => {
      const migrationsDir = path.join(backendDir, 'src/db/migrations');
      const files = fs.readdirSync(migrationsDir).filter(f => f.endsWith('.sql'));

      let outboxTableFound = false;
      let inboxTableFound = false;

      for (const file of files) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        if (/CREATE\s+TABLE[^(]+outbox/i.test(sql)) {
          outboxTableFound = true;
        }
        if (/CREATE\s+TABLE[^(]+inbox/i.test(sql) && !file.includes('expand_whatsapp_business_inbox')) {
          inboxTableFound = true;
        }
      }

      assert.equal(
        outboxTableFound,
        false,
        'EVIDENCIA: Falta tabla transactional outbox (requerida en PR-06 migración 024_)'
      );
    });
  });
});

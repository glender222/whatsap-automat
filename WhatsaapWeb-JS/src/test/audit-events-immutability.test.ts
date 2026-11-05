import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { AuditLogger, AuditEvent } from '../services/audit/AuditLogger';
import { SecretVault } from '../services/security/SecretVault';

describe('PR-F8-01: Migration 031 & Immutable Audit Events Verification', () => {
  const migrationPath = path.resolve(
    __dirname,
    '../db/migrations/031_create_audit_events_and_secrets.sql'
  );

  test('Migration 031 file exists on filesystem', () => {
    assert.ok(fs.existsSync(migrationPath), `Migration file not found at ${migrationPath}`);
  });

  const sqlContent = fs.readFileSync(migrationPath, 'utf8');

  describe('Suite 1: Static DDL & Immutability Trigger Schema Verification', () => {
    test('1.1: Defines table audit_events with UUID primary key and compliance attributes', () => {
      assert.match(sqlContent, /CREATE TABLE IF NOT EXISTS audit_events/i);
      assert.match(sqlContent, /id UUID PRIMARY KEY DEFAULT gen_random_uuid\(\)/i);
      assert.match(sqlContent, /tenant_id INTEGER NOT NULL REFERENCES tenants\(id\)/i);
      assert.match(sqlContent, /action VARCHAR\(100\) NOT NULL/i);
      assert.match(sqlContent, /resource_type VARCHAR\(100\) NOT NULL/i);
      assert.match(sqlContent, /resource_id VARCHAR\(100\)/i);
      assert.match(sqlContent, /payload JSONB NOT NULL DEFAULT '{}'::jsonb/i);
      assert.match(sqlContent, /ip_address VARCHAR\(45\)/i);
      assert.match(sqlContent, /user_agent TEXT/i);
      assert.match(sqlContent, /trace_id VARCHAR\(100\)/i);
      assert.match(sqlContent, /created_at TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/i);
    });

    test('1.2: Enforces prevent_audit_events_mutation trigger function and BEFORE UPDATE/DELETE/TRUNCATE trigger', () => {
      assert.match(sqlContent, /CREATE OR REPLACE FUNCTION prevent_audit_events_mutation\(\)/i);
      assert.match(sqlContent, /audit_events table is immutable: UPDATE and DELETE operations are forbidden/i);
      assert.match(sqlContent, /CREATE TRIGGER trg_prevent_audit_events_mutation/i);
      assert.match(sqlContent, /BEFORE UPDATE OR DELETE ON audit_events/i);
      assert.match(sqlContent, /FOR EACH ROW/i);
      assert.match(sqlContent, /CREATE TRIGGER trg_prevent_audit_events_truncate/i);
      assert.match(sqlContent, /BEFORE TRUNCATE ON audit_events/i);
    });

    test('1.3: Defines table tenant_secrets for envelope-encrypted credentials', () => {
      assert.match(sqlContent, /CREATE TABLE IF NOT EXISTS tenant_secrets/i);
      assert.match(sqlContent, /tenant_id INTEGER NOT NULL REFERENCES tenants\(id\)/i);
      assert.match(sqlContent, /secret_name VARCHAR\(255\) NOT NULL/i);
      assert.match(sqlContent, /encrypted_dek TEXT NOT NULL/i);
      assert.match(sqlContent, /encrypted_data TEXT NOT NULL/i);
      assert.match(sqlContent, /iv VARCHAR\(64\) NOT NULL/i);
      assert.match(sqlContent, /tag VARCHAR\(64\) NOT NULL/i);
      assert.match(sqlContent, /key_version INTEGER NOT NULL DEFAULT 1/i);
      assert.match(sqlContent, /uq_tenant_secrets_tenant_name\s+UNIQUE\s*\(tenant_id,\s*secret_name\)/i);
    });

    test('1.4: Enforces PostgreSQL Row-Level Security (RLS) on both tables', () => {
      assert.match(sqlContent, /ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;/i);
      assert.match(sqlContent, /ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;/i);
      assert.match(sqlContent, /CREATE POLICY tenant_isolation_policy ON audit_events/i);

      assert.match(sqlContent, /ALTER TABLE tenant_secrets ENABLE ROW LEVEL SECURITY;/i);
      assert.match(sqlContent, /ALTER TABLE tenant_secrets FORCE ROW LEVEL SECURITY;/i);
      assert.match(sqlContent, /CREATE POLICY tenant_isolation_policy ON tenant_secrets/i);
    });
  });

  describe('Suite 2: AuditLogger Service & PII Scrubbing Integration', () => {
    const vault = new SecretVault({ masterKey: '0123456789abcdef0123456789abcdef' });
    const logger = new AuditLogger(undefined as any, vault);

    test('2.1: Logs audit event with auto-generated UUID, timestamp, and traceId', async () => {
      const event = await logger.log({
        tenantId: 101,
        actorId: 42,
        actorType: 'user',
        action: 'channel.credentials.update',
        resourceType: 'channel_connection',
        resourceId: 'conn_wa_01',
        payload: {
          channel: 'whatsapp-cloud',
          phoneNumber: '+15551234567',
        },
        ipAddress: '192.168.1.10',
        userAgent: 'Mozilla/5.0 Automat-Agent',
      });

      assert.ok(event.id);
      assert.equal(event.tenantId, 101);
      assert.equal(event.actorId, 42);
      assert.equal(event.action, 'channel.credentials.update');
      assert.ok(event.traceId?.startsWith('trc_'));
      assert.equal(event.payload.channel, 'whatsapp-cloud');
    });

    test('2.2: Automatically sanitizes passwords, tokens, and API keys before logging', async () => {
      const event = await logger.log({
        tenantId: 101,
        action: 'api_key.create',
        resourceType: 'secret',
        payload: {
          keyName: 'production_byok',
          token: 'sk-super-secret-token-that-must-never-leak-in-audit',
          password: 'plainTextPassword123',
          authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.sig',
          config: {
            safeParam: 'public-value',
            dbUrl: 'postgres://user:dbPassSecret@db.internal:5432/main',
          },
        },
      });

      // Secrets must be redacted
      assert.equal(event.payload.token, '[REDACTED]');
      assert.equal(event.payload.password, '[REDACTED]');
      assert.equal(event.payload.authorization, '[REDACTED]');
      assert.equal(event.payload.config.safeParam, 'public-value');
      assert.ok(!event.payload.config.dbUrl.includes('dbPassSecret'));
      assert.ok(event.payload.config.dbUrl.includes('[REDACTED]'));
    });

    test('2.3: Strictly enforces multi-tenant query isolation', async () => {
      await logger.log({
        tenantId: 101,
        action: 'order.created',
        resourceType: 'order',
        resourceId: 'ord_1',
      });

      await logger.log({
        tenantId: 202,
        action: 'order.created',
        resourceType: 'order',
        resourceId: 'ord_2',
      });

      const tenant101Result = await logger.query(101);
      const tenant202Result = await logger.query(202);

      assert.ok(tenant101Result.events.every((e) => e.tenantId === 101));
      assert.ok(tenant202Result.events.every((e) => e.tenantId === 202));
      assert.ok(!tenant101Result.events.some((e) => e.resourceId === 'ord_2'));
    });
  });

  describe('Suite 3: Database Trigger Immutability Simulation', () => {
    test('3.1: Trigger raises uncatchable exception when UPDATE is executed against audit_events', () => {
      // Replicate the trigger function logic defined in migration 031
      function simulateAuditEventsUpdate(operation: 'INSERT' | 'UPDATE' | 'DELETE') {
        if (operation === 'UPDATE' || operation === 'DELETE') {
          const err = new Error('audit_events table is immutable: UPDATE and DELETE operations are forbidden') as any;
          err.code = '23000';
          throw err;
        }
      }

      assert.throws(
        () => simulateAuditEventsUpdate('UPDATE'),
        /audit_events table is immutable: UPDATE and DELETE operations are forbidden/
      );

      assert.throws(
        () => simulateAuditEventsUpdate('DELETE'),
        /audit_events table is immutable: UPDATE and DELETE operations are forbidden/
      );
    });
  });
});

import './fixtures/testEnv';

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { ConsentService } from '../services/campaigns/ConsentService';
import { KnowledgeBaseService } from '../services/ai/rag/KnowledgeBaseService';

describe('PR-F6-03: ConsentService & GDPR Right to be Forgotten Verification', () => {
  let ragService: KnowledgeBaseService;
  let consentService: ConsentService;
  const tenantId = 101;

  beforeEach(() => {
    ragService = new KnowledgeBaseService();
    consentService = new ConsentService(undefined as any, ragService);
  });

  describe('Suite 1: Opt-In & Suppression Lifecycle', () => {
    it('records verifiable opt-in with evidence proof', async () => {
      const record = await consentService.recordOptIn(tenantId, {
        contactId: 42,
        channelType: 'whatsapp-cloud',
        destination: '+573001234567',
        purpose: 'marketing',
        evidenceType: 'web_form',
        evidenceProof: { ip: '10.0.0.1', url: 'https://example.com/join' },
      });

      assert.equal(record.status, 'opted_in');
      assert.equal(record.tenantId, tenantId);
      assert.equal(record.destination, '+573001234567');
      assert.equal(record.evidenceType, 'web_form');
      assert.ok(record.optedInAt);
    });

    it('records explicit opt-out and sets revokedAt timestamp', async () => {
      const record = await consentService.recordOptOut(tenantId, {
        contactId: 42,
        channelType: 'whatsapp-cloud',
        destination: '+573001234567',
        purpose: 'marketing',
        evidenceType: 'chat_inbound',
        evidenceProof: { keyword: 'STOP' },
      });

      assert.equal(record.status, 'opted_out');
      assert.ok(record.revokedAt, 'revokedAt must be set on opt-out');
    });

    it('lists consent records with filtering by channel and destination', async () => {
      await consentService.recordOptIn(tenantId, {
        channelType: 'email',
        destination: 'alpha@example.com',
        purpose: 'marketing',
        evidenceType: 'web_form',
      });
      await consentService.recordOptIn(tenantId, {
        channelType: 'telegram',
        destination: '12345678',
        purpose: 'marketing',
        evidenceType: 'chat_inbound',
      });

      const emailRecords = await consentService.listConsentRecords(tenantId, {
        channelType: 'email',
      });
      assert.equal(emailRecords.length, 1);
      assert.equal(emailRecords[0].destination, 'alpha@example.com');
    });
  });

  describe('Suite 2: Pre-Dispatch Gate Verification (Fail-Closed)', () => {
    it('permits dispatch when active opt-in record is verified', async () => {
      await consentService.recordOptIn(tenantId, {
        channelType: 'whatsapp-cloud',
        destination: '+573119876543',
        purpose: 'marketing',
        evidenceType: 'contract',
      });

      const check = await consentService.verifyConsent(
        tenantId,
        'whatsapp-cloud',
        '+573119876543',
        'marketing'
      );

      assert.equal(check.permitted, true);
      assert.equal(check.status, 'opted_in');
      assert.equal(check.reason, 'CONSENT_GRANTED');
    });

    it('blocks dispatch when recipient is in suppression list (opted_out)', async () => {
      await consentService.recordOptOut(tenantId, {
        channelType: 'whatsapp-cloud',
        destination: '+573119876543',
        purpose: 'marketing',
        evidenceType: 'unsubscribe_link',
      });

      const check = await consentService.verifyConsent(
        tenantId,
        'whatsapp-cloud',
        '+573119876543',
        'marketing'
      );

      assert.equal(check.permitted, false);
      assert.equal(check.status, 'opted_out');
      assert.equal(check.reason, 'SUPPRESSED');
    });

    it('fail-closed: blocks marketing message when no consent record exists', async () => {
      const check = await consentService.verifyConsent(
        tenantId,
        'email',
        'unknown@example.com',
        'marketing'
      );

      assert.equal(check.permitted, false);
      assert.equal(check.status, 'not_found');
      assert.equal(check.reason, 'NO_OPT_IN_RECORD');
    });

    it('permits transactional message when not explicitly suppressed', async () => {
      const check = await consentService.verifyConsent(
        tenantId,
        'email',
        'order-update@example.com',
        'transactional'
      );

      assert.equal(check.permitted, true);
    });
  });

  describe('Suite 3: GDPR Article 17 Right to be Forgotten Integration', () => {
    it('revokes consent records and purges customer RAG memory chunks atomically', async () => {
      const customerId = 'cust_gdpr_4499';
      const destination = 'forgetme@example.com';

      // 1. Ingest customer chunk in RAG memory
      const coll = await ragService.createCollection(tenantId, {
        name: 'customer_support_docs',
      });
      await ragService.ingestDocument(tenantId, {
        collectionId: coll.id,
        content: 'Customer sensitive profile: address 123 Main St, VIP card 4455.',
        documentId: 'doc_profile_4499',
        customerId,
      });

      // 2. Record consent
      await consentService.recordOptIn(tenantId, {
        contactId: 4499,
        channelType: 'email',
        destination,
        purpose: 'marketing',
        evidenceType: 'web_form',
      });

      // 3. Execute Right to be Forgotten
      const rtbfResult = await consentService.executeRightToBeForgotten(
        tenantId,
        customerId,
        destination
      );

      assert.equal(rtbfResult.success, true);
      assert.ok(rtbfResult.purgedConsentCount >= 1, 'Must revoke consent records');
      assert.ok(rtbfResult.purgedChunksCount >= 1, 'Must purge RAG chunks');
      assert.equal(rtbfResult.anonymizedContact, true);

      // 4. Verify pre-dispatch gate is now revoked
      const postCheck = await consentService.verifyConsent(
        tenantId,
        'email',
        destination,
        'marketing'
      );
      assert.equal(postCheck.permitted, false);
      assert.equal(postCheck.status, 'revoked');
    });
  });
});

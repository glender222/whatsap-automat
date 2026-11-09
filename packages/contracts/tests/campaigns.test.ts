import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  consentRecordV1Schema,
  recordConsentInputV1Schema,
  consentVerificationResultV1Schema,
  rightToBeForgottenCommandV1Schema,
  rightToBeForgottenResultV1Schema,
  segmentRuleV1Schema,
  segmentCriteriaV1Schema,
  segmentDefinitionV1Schema,
  createSegmentCommandV1Schema,
  campaignDefinitionV1Schema,
  createCampaignCommandV1Schema,
  campaignDeliveryV1Schema,
  emailChannelConfigV1Schema,
  emailInboundMimeEventV1Schema,
  CHANNEL_KINDS,
  CONSENT_STATUSES,
  CONSENT_PURPOSES,
} from '../src';

describe('PR-F6-01: Campaigns, Audiences, Consent & Email Contracts', () => {
  describe('1. Channel Kinds & Email Extension', () => {
    it('includes email in CHANNEL_KINDS', () => {
      assert.ok(CHANNEL_KINDS.includes('email' as any));
      assert.ok(CHANNEL_KINDS.length >= 6);
    });
  });

  describe('2. Verifiable Consent & Right to be Forgotten Contracts', () => {
    it('validates a well-formed ConsentRecordV1', () => {
      const record = {
        id: 'cst_record_001',
        tenantId: 1,
        contactId: 42,
        channelType: 'whatsapp-cloud',
        destination: '+573001234567',
        purpose: 'marketing',
        status: 'opted_in',
        evidenceType: 'web_form',
        evidenceProof: { ip: '192.168.1.1', formUrl: 'https://example.com/signup' },
        optedInAt: new Date().toISOString(),
      };
      const parsed = consentRecordV1Schema.safeParse(record);
      assert.ok(parsed.success, `ConsentRecord validation failed: ${JSON.stringify(parsed.error?.issues)}`);
      assert.equal(parsed.data.purpose, 'marketing');
      assert.equal(parsed.data.status, 'opted_in');
    });

    it('rejects invalid consent status and unknown channel', () => {
      const invalidStatus = {
        id: 'cst_record_002',
        tenantId: 1,
        channelType: 'whatsapp-cloud',
        destination: '+573001234567',
        status: 'unsubscribed_invalid',
      };
      assert.strictEqual(consentRecordV1Schema.safeParse(invalidStatus).success, false);

      const invalidChannel = {
        id: 'cst_record_003',
        tenantId: 1,
        channelType: 'fax_legacy',
        destination: '+573001234567',
      };
      assert.strictEqual(consentRecordV1Schema.safeParse(invalidChannel).success, false);
    });

    it('validates consentVerificationResultV1Schema for permitted and suppressed states', () => {
      const permittedResult = {
        permitted: true,
        status: 'opted_in',
        reason: 'CONSENT_GRANTED',
        recordId: 'cst_record_001',
      };
      assert.ok(consentVerificationResultV1Schema.safeParse(permittedResult).success);

      const suppressedResult = {
        permitted: false,
        status: 'suppressed',
        reason: 'SUPPRESSED',
      };
      assert.ok(consentVerificationResultV1Schema.safeParse(suppressedResult).success);
    });

    it('validates Right to be Forgotten command and result schemas', () => {
      const command = {
        customerId: 'cust_uuid_9988',
        destination: 'customer@example.com',
        reason: 'GDPR Article 17 Right to be Forgotten Request',
      };
      const parsedCmd = rightToBeForgottenCommandV1Schema.safeParse(command);
      assert.ok(parsedCmd.success);

      const result = {
        success: true,
        purgedConsentCount: 3,
        purgedChunksCount: 15,
        anonymizedContact: true,
        executedAt: new Date().toISOString(),
      };
      const parsedRes = rightToBeForgottenResultV1Schema.safeParse(result);
      assert.ok(parsedRes.success);
      assert.equal(parsedRes.data.purgedChunksCount, 15);
    });
  });

  describe('3. Dynamic Audience & Segmentation Contracts', () => {
    it('validates composite segment criteria with rules and combinators', () => {
      const criteria = {
        combinator: 'AND',
        rules: [
          { field: 'tag', operator: 'includes_any', value: ['vip', 'enterprise'] },
          { field: 'last_seen_days', operator: 'lt', value: 30 },
          { field: 'metadata.industry', operator: 'equals', value: 'finance' },
        ],
      };
      const parsed = segmentCriteriaV1Schema.safeParse(criteria);
      assert.ok(parsed.success, `Criteria validation failed: ${JSON.stringify(parsed.error?.issues)}`);
      assert.equal(parsed.data.rules.length, 3);
    });

    it('validates full SegmentDefinitionV1 with defaults', () => {
      const segment = {
        id: 'seg_vip_customers',
        tenantId: 10,
        name: 'VIP Enterprise Customers',
        description: 'High value customers active in last 30 days',
        targetChannel: 'email',
        criteria: {
          combinator: 'OR',
          rules: [{ field: 'tag', operator: 'equals', value: 'vip' }],
        },
        dynamic: true,
        calculatedCount: 142,
      };
      const parsed = segmentDefinitionV1Schema.safeParse(segment);
      assert.ok(parsed.success);
      assert.equal(parsed.data.targetChannel, 'email');
      assert.equal(parsed.data.calculatedCount, 142);
    });

    it('rejects segment definition with empty name', () => {
      const emptyName = {
        id: 'seg_invalid',
        tenantId: 1,
        name: '',
      };
      assert.strictEqual(segmentDefinitionV1Schema.safeParse(emptyName).success, false);
    });
  });

  describe('4. Broadcast Campaigns & Rate Limits Contracts', () => {
    it('validates CampaignDefinitionV1 with rate limits and failure pause threshold', () => {
      const campaign = {
        id: 'cmp_promo_black_friday',
        tenantId: 1,
        name: 'Black Friday VIP Flash Sale',
        channel: 'email',
        purpose: 'marketing',
        rateLimitPerMinute: 60,
        failurePauseThresholdPercent: 5.0,
        contentSubject: 'Exclusive 50% Off Early Access',
        contentBody: 'Hello {{name}}, your exclusive access code is {{promoCode}}.',
        status: 'draft',
      };
      const parsed = campaignDefinitionV1Schema.safeParse(campaign);
      assert.ok(parsed.success, `Campaign validation failed: ${JSON.stringify(parsed.error?.issues)}`);
      assert.equal(parsed.data.rateLimitPerMinute, 60);
      assert.equal(parsed.data.failurePauseThresholdPercent, 5.0);
    });

    it('rejects rateLimitPerMinute <= 0 or > 1000', () => {
      const zeroRate = {
        id: 'cmp_01',
        tenantId: 1,
        name: 'Test',
        channel: 'telegram',
        rateLimitPerMinute: 0,
      };
      assert.strictEqual(campaignDefinitionV1Schema.safeParse(zeroRate).success, false);

      const excessiveRate = {
        id: 'cmp_02',
        tenantId: 1,
        name: 'Test',
        channel: 'telegram',
        rateLimitPerMinute: 2000,
      };
      assert.strictEqual(campaignDefinitionV1Schema.safeParse(excessiveRate).success, false);
    });

    it('rejects failurePauseThresholdPercent < 0 or > 100', () => {
      const invalidThreshold = {
        id: 'cmp_03',
        tenantId: 1,
        name: 'Test',
        channel: 'whatsapp-cloud',
        failurePauseThresholdPercent: 120,
      };
      assert.strictEqual(campaignDefinitionV1Schema.safeParse(invalidThreshold).success, false);
    });

    it('validates CampaignDeliveryV1 audit item', () => {
      const delivery = {
        id: 'del_001_88',
        campaignId: 'cmp_promo_black_friday',
        tenantId: 1,
        contactId: 101,
        destination: 'customer@example.com',
        idempotencyKey: 'idem_del_cmp_001_cust_101',
        status: 'dispatched',
        providerMessageId: '<msg_smtp_9988@domain.com>',
        dispatchedAt: new Date().toISOString(),
      };
      const parsed = campaignDeliveryV1Schema.safeParse(delivery);
      assert.ok(parsed.success);
      assert.equal(parsed.data.status, 'dispatched');
    });
  });

  describe('5. Email Adapter & MIME Threading Contracts', () => {
    it('validates EmailChannelConfigV1 with SMTP, IMAP and DKIM fields', () => {
      const config = {
        smtpHost: 'smtp.mailgun.org',
        smtpPort: 587,
        smtpSecure: false,
        smtpUser: 'postmaster@mg.example.com',
        smtpPassword: 'secret-password-123',
        fromAddress: 'notifications@example.com',
        fromName: 'Whatsap-Automat Team',
        dkimDomain: 'example.com',
        dkimSelector: 'k1',
        dkimPrivateKey: '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...',
        imapHost: 'imap.mailgun.org',
        imapPort: 993,
        imapSecure: true,
        imapUser: 'inbound@mg.example.com',
        imapPassword: 'imap-password-456',
        pollingIntervalSeconds: 30,
      };
      const parsed = emailChannelConfigV1Schema.safeParse(config);
      assert.ok(parsed.success, `Email config validation failed: ${JSON.stringify(parsed.error?.issues)}`);
      assert.equal(parsed.data.smtpPort, 587);
      assert.equal(parsed.data.fromAddress, 'notifications@example.com');
    });

    it('preserves omitted IMAP options in an SMTP-only configuration', () => {
      const config = emailChannelConfigV1Schema.parse({
        smtpHost: 'smtp.example.com',
        smtpUser: 'operator',
        smtpPassword: 'fixture-only',
        fromAddress: 'notifications@example.com',
      });
      assert.equal(config.smtpPort, 587);
      assert.equal(config.smtpSecure, false);
      assert.equal(Object.hasOwn(config, 'imapPort'), false);
      assert.equal(Object.hasOwn(config, 'imapSecure'), false);
      assert.equal(Object.hasOwn(config, 'pollingIntervalSeconds'), false);
    });

    it('rejects invalid email address in EmailChannelConfigV1', () => {
      const invalidEmail = {
        smtpHost: 'smtp.example.com',
        smtpPort: 587,
        smtpUser: 'user',
        smtpPassword: 'password',
        fromAddress: 'not-an-email-address',
      };
      assert.strictEqual(emailChannelConfigV1Schema.safeParse(invalidEmail).success, false);
    });

    it('validates Inbound Email MIME Event with threading headers', () => {
      const mimeEvent = {
        messageId: '<msg_reply_9988@customer.org>',
        inReplyTo: '<msg_outbound_123@whatsap.internal>',
        references: ['<msg_original_001@whatsap.internal>', '<msg_outbound_123@whatsap.internal>'],
        subject: 'Re: Estado de su orden #4432',
        from: 'cliente@customer.org',
        to: ['soporte@whatsap.internal'],
        textBody: 'Muchas gracias por la pronta respuesta. Quedo atento.',
        htmlBody: '<p>Muchas gracias por la pronta respuesta. Quedo atento.</p>',
        receivedAt: new Date().toISOString(),
      };
      const parsed = emailInboundMimeEventV1Schema.safeParse(mimeEvent);
      assert.ok(parsed.success);
      assert.equal(parsed.data.inReplyTo, '<msg_outbound_123@whatsap.internal>');
      assert.equal(parsed.data.references.length, 2);
    });
  });
});

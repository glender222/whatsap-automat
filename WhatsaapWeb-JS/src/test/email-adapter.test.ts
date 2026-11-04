import './fixtures/testEnv';

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import crypto from 'node:crypto';
import { EmailAdapter } from '../services/channels/EmailAdapter';
import { SendMessageCommandV1 } from '@whatsap-automat/contracts';

describe('PR-F6-05: EmailAdapter SMTP, IMAP MIME Parsing & Threading Verification', () => {
  let testKeyPair: { publicKey: string; privateKey: string };

  beforeEach(() => {
    testKeyPair = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
  });

  describe('Suite 1: ChannelAdapterV1 Port Compliance', () => {
    it('implements kind email and returns required capabilities', async () => {
      const adapter = new EmailAdapter();
      assert.equal(adapter.kind, 'email');

      const capabilities = await adapter.getCapabilities('conn_email_01');
      assert.ok(capabilities.has('text'));
      assert.ok(capabilities.has('document'));
      assert.ok(capabilities.has('template'));
      assert.ok(capabilities.has('read-receipt'));
    });

    it('resolves inbound connection and tenant from headers', async () => {
      const adapter = new EmailAdapter();
      const resolution = await adapter.resolveInboundConnection({
        headers: {
          'x-connection-id': 'conn_custom_mail',
          'x-tenant-id': '42',
        },
        pathKey: 'inbound',
        rawBody: new Uint8Array(),
      });

      assert.ok(resolution);
      assert.equal(resolution.connectionId, 'conn_custom_mail');
      assert.equal(resolution.tenantId, '42');
    });

    it('reports health accurately based on configuration', async () => {
      const adapter = new EmailAdapter();
      adapter.registerConnection('conn_active', {
        smtpHost: 'localhost',
        smtpPort: 2525,
        smtpSecure: false,
        smtpUser: 'agent',
        smtpPassword: 'secretpassword',
        fromAddress: 'agent@example.com',
      });

      const healthy = await adapter.health('conn_active');
      assert.equal(healthy.configured, true);
      assert.equal(healthy.authorized, true);
      assert.equal(healthy.lastErrorCode, null);

      const unconfigured = await adapter.health('conn_nonexistent');
      assert.equal(unconfigured.configured, false);
      assert.equal(unconfigured.lastErrorCode, 'CONFIG_MISSING');
    });
  });

  describe('Suite 2: Inbound MIME Parsing & Conversation Threading', () => {
    it('parses raw RFC 5322 MIME message into canonical ChannelEventV1', async () => {
      const adapter = new EmailAdapter();
      const rawMime = [
        'From: cliente@empresa.com',
        'To: soporte@whatsap-automat.internal',
        'Subject: Consulta sobre integracion API',
        'Message-ID: <msg_20261104_001@empresa.com>',
        'Date: Wed, 04 Nov 2026 12:00:00 GMT',
        '',
        'Hola equipo, requerimos soporte para la configuracion de webhooks.',
      ].join('\r\n');

      const events = await adapter.normalizeInbound('conn_default', rawMime);

      assert.equal(events.length, 1);
      const ev = events[0];
      assert.equal(ev.channel, 'email');
      assert.equal(ev.externalEventId, '<msg_20261104_001@empresa.com>');
      assert.equal(ev.externalIdentityId, 'cliente@empresa.com');
      assert.equal(ev.payload.kind, 'message');
      assert.equal(ev.payload.data.kind, 'text');
      assert.match(ev.payload.data.text, /soporte para la configuracion de webhooks/);
    });

    it('correlates inbound reply to existing thread via In-Reply-To header', async () => {
      const adapter = new EmailAdapter();
      const originalMessageId = '<msg_outbound_1042@whatsap-automat.internal>';

      const replyMime = [
        'From: cliente@empresa.com',
        'To: soporte@whatsap-automat.internal',
        'Subject: Re: Actualizacion de ticket #1042',
        'Message-ID: <msg_reply_9988@empresa.com>',
        `In-Reply-To: ${originalMessageId}`,
        `References: ${originalMessageId}`,
        '',
        'Confirmamos que el servicio quedo restablecido.',
      ].join('\r\n');

      const events = await adapter.normalizeInbound('conn_default', replyMime);

      assert.equal(events.length, 1);
      const ev = events[0];
      // Threading correlation binds externalConversationId to the In-Reply-To header!
      assert.equal(ev.externalConversationId, originalMessageId);
      assert.equal(ev.externalEventId, '<msg_reply_9988@empresa.com>');
    });
  });

  describe('Suite 3: Outbound SMTP Dispatch & Cryptographic DKIM Signing', () => {
    it('signs outbound email with valid RSA-SHA256 DKIM-Signature header', async () => {
      let dispatchedRawMime = '';

      const adapter = new EmailAdapter({
        customSmtpSender: async (rawMime) => {
          dispatchedRawMime = rawMime;
          return { providerMessageId: '<smtp_accepted_001>', rawResponse: '250 2.0.0 Ok: queued' };
        },
      });

      adapter.registerConnection('conn_dkim', {
        smtpHost: 'localhost',
        smtpPort: 587,
        smtpSecure: false,
        smtpUser: 'mailer',
        smtpPassword: 'secretpassword',
        fromAddress: 'notifications@domain.org',
        fromName: 'Automat Bot',
        dkimDomain: 'domain.org',
        dkimSelector: 's1',
        dkimPrivateKey: testKeyPair.privateKey,
      });

      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn_dkim',
        conversationId: 'cust@client.com',
        effectKey: 'eff_test_dkim_001',
        message: {
          kind: 'text',
          text: 'Hello from Whatsap-Automat with genuine cryptographic DKIM signature.',
        },
        expectedConversationVersion: 1,
        causedBy: { type: 'system', id: 'sys_1' },
      };

      const result = await adapter.send(cmd);

      assert.equal(result.accepted, true);
      assert.equal(result.deliveryState, 'provider_accepted');
      assert.ok(dispatchedRawMime.includes('DKIM-Signature: v=1; a=rsa-sha256;'));
      assert.ok(dispatchedRawMime.includes('d=domain.org; s=s1;'));
      assert.ok(dispatchedRawMime.includes('bh='));
      assert.ok(dispatchedRawMime.includes('b='));
      assert.ok(dispatchedRawMime.includes('Message-ID: <msg_'));
    });

    it('attaches In-Reply-To and References headers when replying to an existing conversation thread', async () => {
      let dispatchedRawMime = '';

      const adapter = new EmailAdapter({
        customSmtpSender: async (rawMime) => {
          dispatchedRawMime = rawMime;
          return { providerMessageId: '<smtp_accepted_002>', rawResponse: '250 Ok' };
        },
      });

      const threadMessageId = '<msg_incoming_8899@customer.org>';

      const cmd: SendMessageCommandV1 = {
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'default',
        conversationId: threadMessageId, // Replying to thread
        effectKey: 'eff_test_thread_001',
        message: {
          kind: 'text',
          text: 'Thank you for contacting us. We have received your request.',
        },
        expectedConversationVersion: 2,
        causedBy: { type: 'human', id: 'agent_42' },
      };

      await adapter.send(cmd);

      assert.ok(dispatchedRawMime.includes(`In-Reply-To: ${threadMessageId}`));
      assert.ok(dispatchedRawMime.includes(`References: ${threadMessageId}`));
    });
  });
});


describe('PR-F6-05 Remediation: EmailAdapter Adversarial Hardening Suites', () => {

  describe('Suite 4: RFC 2046 Multipart MIME & Inbound Attachment Isolation', () => {
    it('parses multipart/alternative isolating plain text without boundary leakage', async () => {
      const adapter = new EmailAdapter();
      const rawMime = [
        'From: sender@example.com',
        'To: support@whatsap-automat.internal',
        'Subject: Multipart Alternative Test',
        'Content-Type: multipart/alternative; boundary="boundary42"',
        '',
        '--boundary42',
        'Content-Type: text/plain; charset=UTF-8',
        '',
        'Clean plain text body.',
        '--boundary42',
        'Content-Type: text/html; charset=UTF-8',
        '',
        '<html><body><p>HTML formatted body.</p></body></html>',
        '--boundary42--',
      ].join('\r\n');

      const events = await adapter.normalizeInbound('conn_default', rawMime);
      assert.equal(events.length, 1);
      const data = events[0].payload?.data as any;
      assert.equal(data.text, 'Clean plain text body.');
      assert.equal(data.text.includes('--boundary42'), false);
      assert.equal(data.text.includes('Content-Type:'), false);
    });

    it('extracts binary attachment from multipart/mixed into InboundMessageMediaV1 and strips base64 from text', async () => {
      const adapter = new EmailAdapter();
      const rawMime = [
        'From: billing@vendor.com',
        'To: accounts@whatsap-automat.internal',
        'Subject: Invoice #1099',
        'Content-Type: multipart/mixed; boundary="boundary-mixed-99"',
        '',
        '--boundary-mixed-99',
        'Content-Type: text/plain; charset=UTF-8',
        '',
        'Please review the attached invoice.',
        '--boundary-mixed-99',
        'Content-Type: application/pdf; name="invoice.pdf"',
        'Content-Disposition: attachment; filename="invoice.pdf"',
        'Content-Transfer-Encoding: base64',
        '',
        'JVBERi0xLjQKJcTl8uXrp/...',
        '--boundary-mixed-99--',
      ].join('\r\n');

      const events = await adapter.normalizeInbound('conn_default', rawMime);
      assert.equal(events.length, 1);
      const data = events[0].payload?.data as any;
      assert.equal(data.kind, 'media');
      assert.ok(data.media, 'media property must be populated');
      assert.equal(data.media.filename, 'invoice.pdf');
      assert.equal(data.media.mimeType, 'application/pdf');
      assert.equal(data.text, 'Please review the attached invoice.');
      assert.equal(data.text.includes('JVBER'), false);
    });

    it('extracts and sanitizes htmlBody when textBody is absent without falling back to subject', async () => {
      const adapter = new EmailAdapter();
      const events = await adapter.normalizeInbound('conn_default', {
        from: 'newsletter@partner.com',
        subject: 'Weekly Digest #42',
        htmlBody: '<div><h1>Newsletter Title</h1><p>Important announcement inside.</p></div>',
      });

      assert.equal(events.length, 1);
      const data = events[0].payload?.data as any;
      assert.match(data.text, /Important announcement inside/);
      assert.notEqual(data.text, 'Weekly Digest #42');
    });
  });

  describe('Suite 5: Multi-Turn Conversation Threading Correlation', () => {
    it('preserves externalConversationId across multiple turns between customer and agent', async () => {
      const adapter = new EmailAdapter();

      // Turn 1: Customer initiates thread
      const [init] = await adapter.normalizeInbound('conn_default', [
        'From: customer@client.com',
        'Subject: Account Inquiry',
        'Message-ID: <msg_cust_001@client.com>',
        '',
        'Need help with login',
      ].join('\r\n'));
      assert.equal(init.externalConversationId, 'customer@client.com');

      // Turn 2: Agent replies
      await adapter.send({
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn_default',
        conversationId: init.externalConversationId,
        effectKey: 'eff_support_001',
        message: { kind: 'text', text: 'Please reset your password' },
        expectedConversationVersion: 1,
        causedBy: { type: 'human', id: 'agent_1' },
      });

      // Turn 3: Customer replies referencing both messages
      const [reply] = await adapter.normalizeInbound('conn_default', [
        'From: customer@client.com',
        'Subject: Re: Account Inquiry',
        'Message-ID: <msg_cust_002@client.com>',
        'In-Reply-To: <msg_outbound_reply@whatsap-automat.internal>',
        'References: <msg_cust_001@client.com> <msg_outbound_reply@whatsap-automat.internal>',
        '',
        'Password reset worked, thanks!',
      ].join('\r\n'));

      // Both events MUST share the exact same externalConversationId!
      assert.equal(reply.externalConversationId, init.externalConversationId);
    });
  });

  describe('Suite 6: RFC 5321 Outbound Addressing & Transport Resilience', () => {
    it('normalizes Message-ID conversationId to valid SMTP recipient without double brackets', async () => {
      let capturedTo = '';
      let capturedMime = '';

      const adapter = new EmailAdapter({
        customSmtpSender: async (rawMime, to) => {
          capturedMime = rawMime;
          capturedTo = to;
          return { providerMessageId: 'prov_ok', rawResponse: '250 OK' };
        },
      });

      const threadMessageId = '<msg_incoming_client@domain.org>';
      await adapter.send({
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn_default',
        conversationId: threadMessageId,
        effectKey: 'eff_addr_001',
        message: { kind: 'text', text: 'Acknowledged' },
        expectedConversationVersion: 1,
        causedBy: { type: 'human', id: 'agent_1' },
      });

      assert.equal(capturedTo, 'msg_incoming_client@domain.org');
      assert.ok(capturedMime.includes('To: <msg_incoming_client@domain.org>'));
      assert.equal(capturedMime.includes('<<'), false);
    });

    it('gracefully catches network disconnects and returns SendMessageResultV1 with accepted: false', async () => {
      const adapter = new EmailAdapter({
        customSmtpSender: async () => {
          const err = new Error('getaddrinfo ENOTFOUND smtp.mailserver.internal') as any;
          err.code = 'ENOTFOUND';
          throw err;
        },
      });

      const res = await adapter.send({
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn_default',
        conversationId: 'alice@domain.com',
        effectKey: 'eff_fail_001',
        message: { kind: 'text', text: 'Test offline' },
        expectedConversationVersion: 1,
        causedBy: { type: 'system', id: 'sys_1' },
      });

      assert.equal(res.accepted, false);
      assert.equal(res.deliveryState, 'failed');
      assert.equal(res.providerMessageId, null);
      assert.ok(res.rawStatus.includes('ENOTFOUND'));
    });

    it('dispatches media message with multipart/mixed structure and base64 encoded payload', async () => {
      let capturedMime = '';

      const adapter = new EmailAdapter({
        customSmtpSender: async (rawMime) => {
          capturedMime = rawMime;
          return { providerMessageId: 'prov_media', rawResponse: '250 OK' };
        },
      });

      await adapter.send({
        schemaVersion: 1,
        tenantId: '1',
        connectionId: 'conn_default',
        conversationId: 'alice@domain.com',
        effectKey: 'eff_media_001',
        message: {
          kind: 'media',
          mediaRef: 'data:application/pdf;base64,JVBERi0xLjQK',
          text: 'Here is your contract',
          parameters: { filename: 'contract.pdf', mimeType: 'application/pdf' },
        },
        expectedConversationVersion: 1,
        causedBy: { type: 'human', id: 'agent_1' },
      });

      assert.ok(capturedMime.includes('Content-Type: multipart/mixed; boundary='));
      assert.ok(capturedMime.includes('filename="contract.pdf"'));
      assert.ok(capturedMime.includes('JVBERi0xLjQK'));
      assert.ok(capturedMime.includes('Here is your contract'));
    });
  });
});

import './fixtures/testEnv';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ConsentService } from '../services/campaigns/ConsentService';
import { CampaignDispatcher } from '../services/campaigns/CampaignDispatcher';
import { SegmentationService, RecipientRecord } from '../services/campaigns/SegmentationService';
import { createCampaignRoutes } from '../routes/campaigns.routes';
import { ChannelAdapterV1, SendMessageCommandV1, SendMessageResultV1 } from '@whatsap-automat/contracts';

describe('CHALLENGER-F6: Adversarial Stress Test & Edge Cases', () => {

  describe('Challenge 1: Consent Hierarchy Suppression (Global Opt-Out vs Specific Opt-In)', () => {
    it('EMPIRICAL TEST: global opt-out (purpose=all) MUST suppress marketing messages even if older marketing opt-in exists', async () => {
      const consentService = new ConsentService(null);
      const tenantId = 501;
      const phone = '+573001234567';

      // Step 1: User opts in to marketing on Day 1
      await consentService.recordOptIn(tenantId, {
        channelType: 'whatsapp-cloud',
        destination: phone,
        purpose: 'marketing',
        evidenceType: 'web_form',
      });

      // Verification: marketing should be permitted
      const check1 = await consentService.verifyConsent(tenantId, 'whatsapp-cloud', phone, 'marketing');
      assert.equal(check1.permitted, true, 'Initially marketing should be permitted');

      // Step 2: User explicitly opts out of ALL communications (purpose: all) on Day 2
      await consentService.recordOptOut(tenantId, {
        channelType: 'whatsapp-cloud',
        destination: phone,
        purpose: 'all',
        evidenceType: 'chat_inbound',
        evidenceProof: { keyword: 'STOP ALL' },
      });

      // Verification: Pre-dispatch check for marketing MUST be suppressed!
      const check2 = await consentService.verifyConsent(tenantId, 'whatsapp-cloud', phone, 'marketing');
      
      // If check2.permitted is true, it is a VIOLATION of consent suppression guarantee!
      console.log('Challenge 1 Result: check2.permitted =', check2.permitted, 'reason =', check2.reason);
      assert.equal(check2.permitted, false, 'Global opt-out (all) MUST suppress marketing messages!');
    });
  });

  describe('Challenge 2: Cross-Tenant Deliveries Data Leakage', () => {
    it('EMPIRICAL TEST: deliveries endpoint must not leak recipient data to other tenants', async () => {
      let sentCount = 0;
      const mockAdapter: ChannelAdapterV1 = {
        kind: 'email',
        resolveInboundConnection: async () => null,
        verifyInbound: async () => true,
        normalizeInbound: async () => [],
        getCapabilities: async () => new Set(['text']),
        send: async () => {
          sentCount++;
          return { providerMessageId: 'msg_123', accepted: true, rawStatus: 'sent', deliveryState: 'provider_accepted' };
        },
        health: async () => ({ configured: true, authorized: true, lastErrorCode: null, lastCheckedAt: new Date().toISOString() }),
      };

      const dispatcher = new CampaignDispatcher(
        null,
        new ConsentService(null),
        new SegmentationService(null),
        { skipPacingDelay: true, channelAdapters: new Map([['email', mockAdapter]]) }
      );

      const tenant1 = 1001;
      const tenant2 = 2002;

      // Tenant 1 creates and dispatches campaign with confidential customer recipient
      const consent1 = new ConsentService(null);
      await consent1.recordOptIn(tenant1, {
        channelType: 'email',
        destination: 'confidential-customer@tenant1.com',
        purpose: 'marketing',
        evidenceType: 'contract',
      });

      const campaign = await dispatcher.createCampaign(tenant1, {
        name: 'Confidential Internal Campaign',
        channel: 'email',
        purpose: 'marketing',
        contentBody: 'Sensitive internal update',
      });

      await dispatcher.executeCampaign(tenant1, campaign.id, [
        { contactId: 999, destination: 'confidential-customer@tenant1.com', name: 'Confidential Customer' },
      ]);

      // Tenant 2 requests deliveries of Tenant 1's campaign via route
      const campaignRouter = createCampaignRoutes({ dispatcher });
      const { createTenantBToken } = await import('./fixtures/authFixtures');
      const tenant2Token = createTenantBToken(tenant2);

      // We invoke route GET /:id/deliveries with Tenant 2 token:
      let routeStatusCode = 200;
      let routeData: any = null;
      const req: any = {
        method: 'GET',
        params: { id: campaign.id },
        query: {},
        body: {},
        headers: { authorization: `Bearer ${tenant2Token}` },
      };
      const res: any = {
        setHeader() { return res; },
        status(c: number) { routeStatusCode = c; return res; },
        json(d: any) { routeData = d; return res; },
      };

      const layer = (campaignRouter.stack as any[]).find(
        (c) => c.route?.path === '/:id/deliveries' && c.route?.methods?.get
      );
      assert.ok(layer, 'Route GET /:id/deliveries must exist');
      for (const mw of layer.route.stack) {
        await mw.handle(req, res, () => {});
      }

      console.log('Challenge 2 Route-level status:', routeStatusCode, 'data count:', routeData?.data?.length);
      // Assert: Tenant 2 MUST NOT be able to view Tenant 1's confidential deliveries!
      assert.notEqual(routeStatusCode, 200, 'Cross-tenant deliveries access should be rejected with 403 or 404!');
      assert.equal(routeData?.data?.length || 0, 0, 'Tenant 2 received Tenant 1 deliveries!');
    });
  });

  describe('Challenge 3: Circuit Breaker Auto-Pause on 100% Failure with N=5', () => {
    it('EMPIRICAL TEST: campaign where 100% of messages fail (5 out of 5) should NOT be marked completed', async () => {
      const failingAdapter: ChannelAdapterV1 = {
        kind: 'whatsapp-cloud',
        resolveInboundConnection: async () => null,
        verifyInbound: async () => true,
        normalizeInbound: async () => [],
        getCapabilities: async () => new Set(['text']),
        send: async () => {
          const err = new Error('500 Meta Server Error') as any;
          err.code = 'SERVER_ERROR';
          throw err;
        },
        health: async () => ({ configured: true, authorized: true, lastErrorCode: null, lastCheckedAt: new Date().toISOString() }),
      };

      const consentService = new ConsentService(null);
      const tenantId = 777;

      for (let i = 1; i <= 5; i++) {
        await consentService.recordOptIn(tenantId, {
          channelType: 'whatsapp-cloud',
          destination: `+57300000000${i}`,
          purpose: 'marketing',
          evidenceType: 'web_form',
        });
      }

      const dispatcher = new CampaignDispatcher(
        null,
        consentService,
        new SegmentationService(null),
        { skipPacingDelay: true, channelAdapters: new Map([['whatsapp-cloud', failingAdapter]]) }
      );

      const campaign = await dispatcher.createCampaign(tenantId, {
        name: 'Failure Test Campaign',
        channel: 'whatsapp-cloud',
        purpose: 'marketing',
        failurePauseThresholdPercent: 5.0, // 5% threshold
        contentBody: 'Hello',
      });

      const recipients: RecipientRecord[] = [
        { contactId: 1, destination: '+573000000001' },
        { contactId: 2, destination: '+573000000002' },
        { contactId: 3, destination: '+573000000003' },
        { contactId: 4, destination: '+573000000004' },
        { contactId: 5, destination: '+573000000005' },
      ];

      const result = await dispatcher.executeCampaign(tenantId, campaign.id, recipients);

      console.log('Challenge 3 Result: status =', result.status, 'statsDispatched =', result.statsDispatched, 'statsFailed =', result.statsFailed);
      assert.notEqual(result.status, 'completed', 'Campaign with 100% failures must NOT be marked completed!');
    });
  });

  describe('Challenge 4: Resume of Paused Campaign Duplication Risk', () => {
    it('EMPIRICAL TEST: resuming a paused campaign dispatches from start, duplicating messages', async () => {
      let callCount = 0;
      const sentDestinations: string[] = [];

      const flakyAdapter: ChannelAdapterV1 = {
        kind: 'whatsapp-cloud',
        resolveInboundConnection: async () => null,
        verifyInbound: async () => true,
        normalizeInbound: async () => [],
        getCapabilities: async () => new Set(['text']),
        send: async (cmd) => {
          callCount++;
          // Fail after 5 attempts to trip circuit breaker
          if (callCount === 6) {
            const err = new Error('Rate limit') as any;
            err.code = 'RATE_LIMIT';
            throw err;
          }
          sentDestinations.push(cmd.conversationId);
          return { providerMessageId: `msg_${callCount}`, accepted: true, rawStatus: 'sent', deliveryState: 'provider_accepted' };
        },
        health: async () => ({ configured: true, authorized: true, lastErrorCode: null, lastCheckedAt: new Date().toISOString() }),
      };

      const consentService = new ConsentService(null);
      const tenantId = 888;

      const recipients: RecipientRecord[] = [];
      for (let i = 1; i <= 8; i++) {
        const dest = `+57310000000${i}`;
        recipients.push({ contactId: i, destination: dest });
        await consentService.recordOptIn(tenantId, {
          channelType: 'whatsapp-cloud',
          destination: dest,
          purpose: 'marketing',
          evidenceType: 'web_form',
        });
      }

      const dispatcher = new CampaignDispatcher(
        null,
        consentService,
        new SegmentationService(null),
        { skipPacingDelay: true, channelAdapters: new Map([['whatsapp-cloud', flakyAdapter]]) }
      );

      const campaign = await dispatcher.createCampaign(tenantId, {
        name: 'Flaky Campaign',
        channel: 'whatsapp-cloud',
        purpose: 'marketing',
        failurePauseThresholdPercent: 10.0,
        contentBody: 'Hello',
      });

      // First run: fails at call 6, trips breaker at call 7
      const run1 = await dispatcher.executeCampaign(tenantId, campaign.id, recipients);
      console.log('Run 1 status:', run1.status, 'pauseReason:', run1.pauseReason, 'sentDestinations count:', sentDestinations.length);

      // Now suppose operator resolves rate limit and re-executes the campaign:
      const run2 = await dispatcher.executeCampaign(tenantId, campaign.id, recipients);
      console.log('Run 2 status:', run2.status, 'sentDestinations total:', sentDestinations.length);

      // Check how many times recipient 1 was sent:
      const recipient1Sends = sentDestinations.filter(d => d === '+573100000001').length;
      console.log('Challenge 4 Result: Recipient 1 received message', recipient1Sends, 'times');
      assert.equal(recipient1Sends, 1, 'Recipient 1 should only receive the message ONCE, not duplicated on resume!');
    });
  });

  describe('Challenge 5: Dynamic Segmentation Rule Evaluation in SQL Path', () => {
    it('EMPIRICAL TEST: dynamic segmentation query against Postgres schema', async () => {
      // Test if SegmentationService resolveRecipients builds criteria in SQL
      // Inspecting code: line 260 of SegmentationService.ts:
      // "SELECT c.id, c.phone, c.display_name, c.metadata_json FROM contacts c WHERE c.tenant_id = $1"
      // 1. Column name is c.tenant_id (which does not exist in contacts table - column is company_id)
      // 2. No criteria from segment.criteria is included in SQL query!
      const segService = new SegmentationService(null);
      // In memory fallback:
      segService.seedMemoryContact({
        id: 1,
        tenantId: 999,
        phone: '+573001',
        tags: ['vip'],
      });
      segService.seedMemoryContact({
        id: 2,
        tenantId: 999,
        phone: '+573002',
        tags: ['lead'],
      });

      const segment = await segService.createSegment(999, {
        name: 'VIP Only Segment',
        targetChannel: 'whatsapp-cloud',
        dynamic: true,
        criteria: {
          combinator: 'AND',
          rules: [{ field: 'tag', operator: 'equals', value: 'vip' }],
        },
      });

      const recipients = await segService.resolveRecipients(999, segment.id);
      console.log('Challenge 5 Result (Memory): recipients resolved =', recipients.map(r => r.contactId));
      assert.equal(recipients.length, 1, 'Memory fallback filters VIP correctly');
      assert.equal(recipients[0].contactId, 1);
    });
  });

  describe('Challenge 7: Rate Limit Pacing Delay Enforcement Under Real Time', () => {
    it('EMPIRICAL TEST: rateLimitPerMinute enforces minimum pacing delay across iterations', async () => {
      let sendCount = 0;
      const timestamps: number[] = [];
      const dummyAdapter: ChannelAdapterV1 = {
        kind: 'email',
        resolveInboundConnection: async () => null,
        verifyInbound: async () => true,
        normalizeInbound: async () => [],
        getCapabilities: async () => new Set(['text']),
        send: async () => {
          timestamps.push(Date.now());
          sendCount++;
          return { providerMessageId: `msg_${sendCount}`, accepted: true, rawStatus: 'sent', deliveryState: 'provider_accepted' };
        },
        health: async () => ({ configured: true, authorized: true, lastErrorCode: null, lastCheckedAt: new Date().toISOString() }),
      };

      const consentService = new ConsentService(null);
      const tenantId = 919;
      // 5 recipients at 600 msgs/min -> 100ms delay between sends
      const recipients: RecipientRecord[] = [];
      for (let i = 1; i <= 5; i++) {
        const dest = `user${i}@example.com`;
        recipients.push({ contactId: i, destination: dest });
        await consentService.recordOptIn(tenantId, {
          channelType: 'email',
          destination: dest,
          purpose: 'marketing',
          evidenceType: 'web_form',
        });
      }

      const dispatcher = new CampaignDispatcher(
        null,
        consentService,
        new SegmentationService(null),
        { channelAdapters: new Map([['email', dummyAdapter]]) } // Real pacing delay enabled
      );

      const campaign = await dispatcher.createCampaign(tenantId, {
        name: 'Paced Campaign',
        channel: 'email',
        purpose: 'marketing',
        rateLimitPerMinute: 600, // 60,000 / 600 = 100ms delay
        contentBody: 'Paced message',
      });

      const t0 = Date.now();
      await dispatcher.executeCampaign(tenantId, campaign.id, recipients);
      const elapsed = Date.now() - t0;

      console.log('Challenge 7 Result: elapsed time =', elapsed, 'ms for 5 messages (expected >= 400ms)');
      assert.ok(elapsed >= 350, `Pacing must take at least ~400ms for 5 messages at 600/min, but took ${elapsed}ms`);
    });
  });

  describe('Challenge 8: SQL Contacts Schema Alignment & Dynamic Criteria Enforcement', () => {
    it('EMPIRICAL TEST: verify SQL string in SegmentationService queries c.company_id and enforces criteria', async () => {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const segServiceFile = fs.readFileSync(
        path.resolve(process.cwd(), 'src/services/campaigns/SegmentationService.ts'),
        'utf8'
      );

      // Verify that SQL uses c.company_id and NOT c.tenant_id
      assert.ok(
        segServiceFile.includes('c.company_id = $1'),
        'SegmentationService must query c.company_id = $1 for tenant isolation'
      );
      assert.ok(
        !segServiceFile.includes('c.tenant_id = $1'),
        'SegmentationService must NOT query non-existent column c.tenant_id'
      );

      // Verify that dynamic segment criteria filtering is evaluated on database contacts
      assert.ok(
        segServiceFile.includes('matchesCriteria'),
        'SegmentationService must apply matchesCriteria to database contacts'
      );
    });
  });
});


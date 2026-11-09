import './fixtures/testEnv';

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import { CampaignDispatcher } from '../services/campaigns/CampaignDispatcher';
import { ConsentService } from '../services/campaigns/ConsentService';
import { SegmentationService, RecipientRecord } from '../services/campaigns/SegmentationService';
import { ChannelAdapterV1, SendMessageCommandV1, SendMessageResultV1 } from '@whatsap-automat/contracts';

describe('PR-F6-04: CampaignDispatcher Pacing, Window Checks & Circuit Breaker', () => {
  let consentService: ConsentService;
  let segmentationService: SegmentationService;
  let mockAdapter: ChannelAdapterV1;
  let sentCommands: SendMessageCommandV1[];
  let emittedEvents: Array<{ event: string; payload: unknown }>;
  const tenantId = 202;

  beforeEach(() => {
    sentCommands = [];
    emittedEvents = [];
    consentService = new ConsentService(null);
    segmentationService = new SegmentationService(null);

    mockAdapter = {
      kind: 'whatsapp-cloud',
      resolveInboundConnection: async () => ({ connectionId: 'mock_conn', tenantId: String(tenantId) }),
      verifyInbound: async () => true,
      normalizeInbound: async () => [],
      getCapabilities: async () => new Set(['text', 'template', 'document', 'image', 'read-receipt']),
      send: async (cmd: SendMessageCommandV1): Promise<SendMessageResultV1> => {
        sentCommands.push(cmd);
        return {
          providerMessageId: `wamid.mock.${Date.now()}.${sentCommands.length}`,
          accepted: true,
          rawStatus: 'sent',
          deliveryState: 'provider_accepted',
        };
      },
      health: async () => ({
        configured: true,
        authorized: true,
        lastErrorCode: null,
        lastCheckedAt: new Date().toISOString(),
      }),
    };
  });

  describe('Suite 1: Campaign Creation & Paced Dispatch', () => {
    it('creates campaign with rate limit and failure pause threshold', async () => {
      const dispatcher = new CampaignDispatcher(
        null,
        consentService,
        segmentationService,
        { skipPacingDelay: true }
      );

      const campaign = await dispatcher.createCampaign(tenantId, {
        name: 'Flash Sale Broadcast',
        channel: 'email',
        purpose: 'marketing',
        rateLimitPerMinute: 60,
        failurePauseThresholdPercent: 5.0,
        contentSubject: 'Limited Time Offer',
        contentBody: 'Get 20% off your next purchase.',
      });

      assert.equal(campaign.name, 'Flash Sale Broadcast');
      assert.equal(campaign.rateLimitPerMinute, 60);
      assert.equal(campaign.failurePauseThresholdPercent, 5.0);
      assert.equal(campaign.status, 'draft');
    });

    it('dispatches campaign and generates auditable deliveries', async () => {
      const dispatcher = new CampaignDispatcher(
        null,
        consentService,
        segmentationService,
        {
          skipPacingDelay: true,
          channelAdapters: new Map([['whatsapp-cloud', mockAdapter]]),
        }
      );

      const campaign = await dispatcher.createCampaign(tenantId, {
        name: 'VIP Welcome Broadcast',
        channel: 'whatsapp-cloud',
        purpose: 'marketing',
        contentBody: 'Welcome to our VIP club!',
      });

      // Grant consent for recipients
      await consentService.recordOptIn(tenantId, {
        channelType: 'whatsapp-cloud',
        destination: '+573001110001',
        purpose: 'marketing',
        evidenceType: 'web_form',
      });
      await consentService.recordOptIn(tenantId, {
        channelType: 'whatsapp-cloud',
        destination: '+573001110002',
        purpose: 'marketing',
        evidenceType: 'web_form',
      });

      const recipients: RecipientRecord[] = [
        { contactId: 1, destination: '+573001110001', name: 'Alice' },
        { contactId: 2, destination: '+573001110002', name: 'Bob' },
      ];

      const completed = await dispatcher.executeCampaign(tenantId, campaign.id, recipients);

      assert.equal(completed.status, 'completed');
      assert.equal(completed.statsTotal, 2);
      assert.equal(completed.statsDispatched, 2);
      assert.equal(completed.statsFailed, 0);
      assert.equal(completed.statsSuppressed, 0);
      assert.equal(sentCommands.length, 2);

      const deliveries = await dispatcher.getDeliveries(campaign.id);
      assert.equal(deliveries.length, 2);
      assert.equal(deliveries[0].status, 'dispatched');
      assert.ok(deliveries[0].providerMessageId);
    });
  });

  describe('Suite 2: Pre-Dispatch Consent Integration', () => {
    it('suppresses recipients without opt-in and marks delivery as suppressed', async () => {
      const dispatcher = new CampaignDispatcher(
        null,
        consentService,
        segmentationService,
        {
          skipPacingDelay: true,
          channelAdapters: new Map([['whatsapp-cloud', mockAdapter]]),
        }
      );

      const campaign = await dispatcher.createCampaign(tenantId, {
        name: 'Compliance Test Broadcast',
        channel: 'whatsapp-cloud',
        purpose: 'marketing',
        contentBody: 'Special Offer',
      });

      // Destination 1 is opted-in
      await consentService.recordOptIn(tenantId, {
        channelType: 'whatsapp-cloud',
        destination: '+573002220001',
        purpose: 'marketing',
        evidenceType: 'contract',
      });

      // Destination 2 is in suppression list (opted-out)
      await consentService.recordOptOut(tenantId, {
        channelType: 'whatsapp-cloud',
        destination: '+573002220002',
        purpose: 'marketing',
        evidenceType: 'unsubscribe_link',
      });

      // Destination 3 has NO prior consent record (fail-closed)
      const recipients: RecipientRecord[] = [
        { contactId: 1, destination: '+573002220001', name: 'Consenting Customer' },
        { contactId: 2, destination: '+573002220002', name: 'Suppressed Customer' },
        { contactId: 3, destination: '+573002220003', name: 'Unknown Customer' },
      ];

      const result = await dispatcher.executeCampaign(tenantId, campaign.id, recipients);

      assert.equal(result.status, 'completed');
      assert.equal(result.statsTotal, 3);
      assert.equal(result.statsDispatched, 1);
      assert.equal(result.statsSuppressed, 2);
      assert.equal(sentCommands.length, 1); // Only 1 network call made!

      const deliveries = await dispatcher.getDeliveries(campaign.id);
      const suppressed = deliveries.filter((d) => d.status === 'suppressed');
      assert.equal(suppressed.length, 2);
      assert.equal(suppressed[0].destination, '+573002220002');
      assert.equal(suppressed[0].suppressionReason, 'SUPPRESSED');
      assert.equal(suppressed[1].destination, '+573002220003');
      assert.equal(suppressed[1].suppressionReason, 'NO_OPT_IN_RECORD');
    });
  });

  describe('Suite 3: WhatsApp 24-Hour Customer Care Window Enforcement', () => {
    it('blocks free-form message outside 24h window with CH_WA_WINDOW_CLOSED', async () => {
      const expiredDestination = '+573009999999';

      const dispatcher = new CampaignDispatcher(
        null,
        consentService,
        segmentationService,
        {
          skipPacingDelay: true,
          channelAdapters: new Map([['whatsapp-cloud', mockAdapter]]),
          mockServiceWindowExpired: (dest) => dest === expiredDestination,
        }
      );

      // Record consent
      await consentService.recordOptIn(tenantId, {
        channelType: 'whatsapp-cloud',
        destination: expiredDestination,
        purpose: 'marketing',
        evidenceType: 'web_form',
      });

      // Free-form campaign (no templateId)
      const campaign = await dispatcher.createCampaign(tenantId, {
        name: 'Window Enforcement Campaign',
        channel: 'whatsapp-cloud',
        purpose: 'marketing',
        contentBody: 'Free-form text message',
      });

      const recipients: RecipientRecord[] = [
        { contactId: 99, destination: expiredDestination, name: 'Expired Window User' },
      ];

      const result = await dispatcher.executeCampaign(tenantId, campaign.id, recipients);

      assert.equal(result.statsFailed, 1);
      assert.equal(result.statsDispatched, 0);
      assert.equal(sentCommands.length, 0);

      const deliveries = await dispatcher.getDeliveries(campaign.id);
      assert.equal(deliveries[0].status, 'failed');
      assert.equal(deliveries[0].errorCode, 'CH_WA_WINDOW_CLOSED');
    });

    it('permits approved template message even when 24h window is closed', async () => {
      const expiredDestination = '+573009999999';

      const dispatcher = new CampaignDispatcher(
        null,
        consentService,
        segmentationService,
        {
          skipPacingDelay: true,
          channelAdapters: new Map([['whatsapp-cloud', mockAdapter]]),
          mockServiceWindowExpired: (dest) => dest === expiredDestination,
        }
      );

      await consentService.recordOptIn(tenantId, {
        channelType: 'whatsapp-cloud',
        destination: expiredDestination,
        purpose: 'marketing',
        evidenceType: 'web_form',
      });

      // Template-based campaign
      const campaign = await dispatcher.createCampaign(tenantId, {
        name: 'Approved HSM Broadcast',
        channel: 'whatsapp-cloud',
        purpose: 'marketing',
        templateId: 'order_status_update_v2',
        templateVariables: { '1': '1042', '2': 'shipped' },
      });

      const recipients: RecipientRecord[] = [
        { contactId: 99, destination: expiredDestination, name: 'Expired Window User' },
      ];

      const result = await dispatcher.executeCampaign(tenantId, campaign.id, recipients);

      assert.equal(result.statsDispatched, 1);
      assert.equal(result.statsFailed, 0);
      assert.equal(sentCommands.length, 1);
      assert.equal(sentCommands[0].message.kind, 'template');
    });
  });

  describe('Suite 4: Circuit Breaker Auto-Pause Protection', () => {
    it('auto-pauses campaign and halts loop when provider failure rate exceeds threshold', async () => {
      let callCount = 0;
      const failingAdapter: ChannelAdapterV1 = {
        kind: 'whatsapp-cloud',
        resolveInboundConnection: async () => null,
        verifyInbound: async () => true,
        normalizeInbound: async () => [],
        getCapabilities: async () => new Set(['text']),
        send: async () => {
          callCount++;
          // Fail on 2nd and subsequent calls to exceed 5% threshold
          if (callCount >= 2) {
            const err = new Error('Meta Graph API rate limit exceeded') as any;
            err.code = 'GRAPH_API_RATE_LIMIT';
            throw err;
          }
          return {
            providerMessageId: 'prov_ok',
            accepted: true,
            rawStatus: 'sent',
            deliveryState: 'provider_accepted',
          };
        },
        health: async () => ({
          configured: true,
          authorized: true,
          lastErrorCode: null,
          lastCheckedAt: new Date().toISOString(),
        }),
      };

      const dispatcher = new CampaignDispatcher(
        null,
        consentService,
        segmentationService,
        {
          skipPacingDelay: true,
          channelAdapters: new Map([['whatsapp-cloud', failingAdapter]]),
          eventEmitter: (event, payload) => {
            emittedEvents.push({ event, payload });
          },
        }
      );

      const campaign = await dispatcher.createCampaign(tenantId, {
        name: 'Fragile Campaign',
        channel: 'whatsapp-cloud',
        purpose: 'marketing',
        contentBody: 'Test Message',
        failurePauseThresholdPercent: 5.0, // 5% auto-pause
      });

      // Prepare 10 consenting recipients
      const recipients: RecipientRecord[] = [];
      for (let i = 1; i <= 10; i++) {
        const dest = `+57300555000${i}`;
        await consentService.recordOptIn(tenantId, {
          channelType: 'whatsapp-cloud',
          destination: dest,
          purpose: 'marketing',
          evidenceType: 'web_form',
        });
        recipients.push({ contactId: i, destination: dest });
      }

      const result = await dispatcher.executeCampaign(tenantId, campaign.id, recipients);

      // Verify campaign auto-paused
      assert.equal(result.status, 'paused');
      assert.match(result.pauseReason!, /High failure rate detected/i);

      // Loop was halted early; did not process all 10 recipients
      assert.ok(result.statsDispatched + result.statsFailed < 10);

      // Emitted campaign.paused WebSocket event
      assert.equal(emittedEvents.length, 1);
      assert.equal(emittedEvents[0].event, 'campaign.paused');
    });
  });
});

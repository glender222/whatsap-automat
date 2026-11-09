import './fixtures/testEnv';

import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  createCampaignRoutes,
  createConsentRoutes,
  createSegmentRoutes,
} from '../routes/campaigns.routes';
import { EmailAdapter } from '../services/channels/EmailAdapter';
import { CampaignDispatcher } from '../services/campaigns/CampaignDispatcher';
import { ConsentService } from '../services/campaigns/ConsentService';
import { SegmentationService } from '../services/campaigns/SegmentationService';
import { createTenantAToken } from './fixtures/authFixtures';

async function invokeExpressRoute(
  router: any,
  method: 'get' | 'post',
  path: string,
  options: {
    body?: any;
    query?: any;
    params?: any;
    token?: string;
  } = {}
) {
  const layer = router.stack.find(
    (candidate: any) =>
      candidate.route?.path === path && candidate.route?.methods?.[method.toLowerCase()]
  );
  assert.ok(layer, `Route ${method.toUpperCase()} ${path} must exist in router stack`);

  let statusCode = 200;
  let jsonBody: any = null;

  const req: any = {
    method: method.toUpperCase(),
    params: options.params || {},
    query: options.query || {},
    body: options.body || {},
    headers: options.token ? { authorization: `Bearer ${options.token}` } : {},
  };

  const res: any = {
    setHeader() { return res; },
    status(code: number) {
      statusCode = code;
      return res;
    },
    json(data: any) {
      jsonBody = data;
      return res;
    },
  };

  for (const mw of layer.route.stack) {
    let nextErr: any = null;
    try {
      await mw.handle(req, res, (err: any) => {
        nextErr = err;
      });
    } catch (caughtErr) {
      nextErr = caughtErr;
    }

    if (nextErr) {
      return {
        status: nextErr.statusCode || (nextErr.name === 'JsonWebTokenError' ? 401 : 500),
        body: { success: false, error: nextErr.code || 'ERROR', message: nextErr.message },
      };
    }
  }

  return { status: statusCode, body: jsonBody };
}

describe('PR-F6-06: Campaigns, Consent & Segments REST Endpoints Verification', () => {
  let consentService: ConsentService;
  let segmentationService: SegmentationService;
  let campaignDispatcher: CampaignDispatcher;
  let validToken: string;
  const tenantId = 1;

  beforeEach(() => {
    validToken = createTenantAToken(tenantId);
    consentService = new ConsentService(null, {
      purgeKnowledge: async (_tenantId, request) => ({
        success: true,
        scope: request.scope,
        targetId: request.targetId,
        purgedChunksCount: 0,
        purgedCollectionsCount: 0,
        purgedAt: new Date().toISOString(),
      }),
    });
    segmentationService = new SegmentationService(null);
    campaignDispatcher = new CampaignDispatcher(
      null,
      consentService,
      segmentationService,
      {
        skipPacingDelay: true,
        channelAdapters: new Map([['email', new EmailAdapter({
          customSmtpSender: async () => ({ providerMessageId: 'smtp-fixture', rawResponse: '250 fixture' }),
        })]]),
      }
    );
  });

  describe('Suite 1: /api/v1/campaigns Endpoints', () => {
    it('POST / rejects unauthenticated requests with 401', async () => {
      const router = createCampaignRoutes({ dispatcher: campaignDispatcher });
      const res = await invokeExpressRoute(router, 'post', '/', {
        body: { name: 'Test Campaign', channel: 'email' },
      });
      assert.equal(res.status, 401);
    });

    it('POST / creates campaign and GET / lists campaigns for tenant', async () => {
      const router = createCampaignRoutes({ dispatcher: campaignDispatcher });
      const createRes = await invokeExpressRoute(router, 'post', '/', {
        token: validToken,
        body: {
          name: 'Spring Promotional Blast',
          channel: 'email',
          purpose: 'marketing',
          contentSubject: 'Spring Clearance',
          contentBody: 'Save up to 30%',
          rateLimitPerMinute: 50,
          failurePauseThresholdPercent: 5.0,
        },
      });

      assert.equal(createRes.status, 201);
      assert.equal(createRes.body.success, true);
      assert.equal(createRes.body.data.name, 'Spring Promotional Blast');
      const campaignId = createRes.body.data.id;

      const listRes = await invokeExpressRoute(router, 'get', '/', { token: validToken });
      assert.equal(listRes.status, 200);
      assert.ok(Array.isArray(listRes.body.data));
      assert.ok(listRes.body.data.some((c: any) => c.id === campaignId));

      const getRes = await invokeExpressRoute(router, 'get', '/:id', {
        token: validToken,
        params: { id: campaignId },
      });
      assert.equal(getRes.status, 200);
      assert.equal(getRes.body.data.id, campaignId);
    });

    it('POST /:id/dispatch executes campaign and GET /:id/deliveries returns audit', async () => {
      const router = createCampaignRoutes({ dispatcher: campaignDispatcher });
      const campaign = await campaignDispatcher.createCampaign(tenantId, {
        name: 'Immediate Dispatch Campaign',
        channel: 'email',
        purpose: 'transactional',
        contentSubject: 'Order Confirmation',
        contentBody: 'Your order is confirmed.',
      });

      const dispatchRes = await invokeExpressRoute(router, 'post', '/:id/dispatch', {
        token: validToken,
        params: { id: campaign.id },
        body: {
          recipients: [{ contactId: 10, destination: 'customer@domain.com' }],
        },
      });

      assert.equal(dispatchRes.status, 200);
      assert.equal(dispatchRes.body.data.statsDispatched, 1);

      const delivRes = await invokeExpressRoute(router, 'get', '/:id/deliveries', {
        token: validToken,
        params: { id: campaign.id },
      });
      assert.equal(delivRes.status, 200);
      assert.equal(delivRes.body.data.length, 1);
      assert.equal(delivRes.body.data[0].destination, 'customer@domain.com');
    });
  });

  describe('Suite 2: /api/v1/consent Endpoints', () => {
    it('POST / records consent and POST /verify returns pre-dispatch status', async () => {
      const router = createConsentRoutes({ consent: consentService });
      const recordRes = await invokeExpressRoute(router, 'post', '/', {
        token: validToken,
        body: {
          channelType: 'email',
          destination: 'lead@enterprise.com',
          purpose: 'marketing',
          status: 'opted_in',
          evidenceType: 'web_form',
        },
      });

      assert.equal(recordRes.status, 201);
      assert.equal(recordRes.body.data.destination, 'lead@enterprise.com');

      const verifyRes = await invokeExpressRoute(router, 'post', '/verify', {
        token: validToken,
        body: {
          channel: 'email',
          destination: 'lead@enterprise.com',
          purpose: 'marketing',
        },
      });

      assert.equal(verifyRes.status, 200);
      assert.equal(verifyRes.body.data.permitted, true);
      assert.equal(verifyRes.body.data.status, 'opted_in');
    });

    it('POST /right-to-be-forgotten executes customer GDPR purge', async () => {
      const router = createConsentRoutes({ consent: consentService });
      const rtbfRes = await invokeExpressRoute(router, 'post', '/right-to-be-forgotten', {
        token: validToken,
        body: {
          customerId: 'cust_8877',
          destination: 'purge@enterprise.com',
        },
      });

      assert.equal(rtbfRes.status, 200);
      assert.equal(rtbfRes.body.data.success, true);
      assert.equal(rtbfRes.body.data.anonymizedContact, false);
    });
  });

  describe('Suite 3: /api/v1/segments Endpoints', () => {
    it('POST / creates segment and POST /:id/calculate evaluates audience count', async () => {
      segmentationService.seedMemoryContact({
        id: 1,
        tenantId,
        phone: '+573001112233',
        email: 'vip1@example.com',
        tags: ['vip'],
      });
      segmentationService.seedMemoryContact({
        id: 2,
        tenantId,
        phone: '+573009998877',
        email: 'regular@example.com',
        tags: ['standard'],
      });

      const router = createSegmentRoutes({ segments: segmentationService });
      const createRes = await invokeExpressRoute(router, 'post', '/', {
        token: validToken,
        body: {
          name: 'VIP Segment',
          targetChannel: 'email',
          criteria: {
            combinator: 'AND',
            rules: [{ field: 'tag', operator: 'equals', value: 'vip' }],
          },
        },
      });

      assert.equal(createRes.status, 201);
      const segmentId = createRes.body.data.id;

      const calcRes = await invokeExpressRoute(router, 'post', '/:id/calculate', {
        token: validToken,
        params: { id: segmentId },
      });

      assert.equal(calcRes.status, 200);
      assert.equal(calcRes.body.data.count, 1);

      const recRes = await invokeExpressRoute(router, 'get', '/:id/recipients', {
        token: validToken,
        params: { id: segmentId },
      });

      assert.equal(recRes.status, 200);
      assert.equal(recRes.body.data.length, 1);
      assert.equal(recRes.body.data[0].destination, 'vip1@example.com');
    });
  });
});

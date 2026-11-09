import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { InternalAxiosRequestConfig } from 'axios';
import { api } from '../shared/axios/http';
import {
  calculateSegment, createCampaignDraft, createSegment, dispatchCampaign, listCampaigns, reviewCampaignDispatch,
} from '../components/campaigns/campaignApi';

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });

function mockResponse(context: TestContext, response: (request: InternalAxiosRequestConfig) => unknown) {
  const original = api.defaults.adapter;
  const adapter = context.mock.fn(async (request: InternalAxiosRequestConfig) => ({
    data: response(request),
    status: 200,
    statusText: 'OK',
    headers: {},
    config: request,
  }));
  api.defaults.adapter = adapter;
  context.after(() => { api.defaults.adapter = original; });
  return adapter;
}


test('campaign drafts use the backend endpoint and require a draft response', async (context) => {
  const draft = {
    name: 'Aviso de temporada',
    channel: 'whatsapp-cloud' as const,
    purpose: 'marketing' as const,
    segmentId: 'seg_12',
    templateId: 'aviso_1',
    rateLimitPerMinute: 50,
    failurePauseThresholdPercent: 5,
  };
  const draftResponse = { id: 'cmp_12', status: 'draft', name: draft.name };
  const adapter = mockResponse(context, (request) => {
    assert.equal(request.url, '/v1/campaigns');
    assert.equal(request.method, 'post');
    assert.deepEqual(JSON.parse(request.data), draft);
    return { success: true, data: draftResponse };
  });

  assert.equal((await createCampaignDraft(draft)).id, 'cmp_12');
  draftResponse.status = 'failed';
  await assert.rejects(createCampaignDraft(draft), /no confirmó el borrador/);
  assert.equal(adapter.mock.callCount(), 2);
});

test('campaign listing reports API errors and invalid responses without inventing campaigns', async (context) => {
  const response: { success: boolean; data: unknown; message: string } = { success: false, data: [], message: 'API no disponible' };
  mockResponse(context, (request) => {
    assert.equal(request.url, '/v1/campaigns');
    assert.equal(request.method, 'get');
    return response;
  });
  const signal = new AbortController().signal;

  await assert.rejects(listCampaigns(signal), /API no disponible/);
  response.success = true;
  response.data = {};
  await assert.rejects(listCampaigns(signal), /listado de campañas no es válido/);
  response.data = [];
  assert.deepEqual(await listCampaigns(signal), []);
});

test('segments preserve server IDs and the count must correspond to the requested segment', async (context) => {
  const draft = {
    name: 'Clientes de Lima',
    targetChannel: 'any' as const,
    criteria: { combinator: 'AND' as const, rules: [{ field: 'metadata.city', operator: 'equals', value: 'Lima' }] },
  };
  const segmentId = 'segmento/1';
  const calculation = { segmentId, count: 12 };
  mockResponse(context, (request) => {
    assert.equal(request.method, 'post');
    if (request.url === '/v1/segments') {
      assert.deepEqual(JSON.parse(request.data), draft);
      return { success: true, data: { ...draft, id: segmentId, calculatedCount: 0 } };
    }
    assert.equal(request.url, '/v1/segments/segmento%2F1/calculate');
    return { success: true, data: calculation };
  });

  assert.equal((await createSegment(draft)).id, segmentId);
  assert.equal(await calculateSegment(segmentId), 12);
  calculation.segmentId = 'another';
  await assert.rejects(calculateSegment(segmentId), /no confirmó el recuento/);
});

test('dispatch uses the reviewed audience key and preserves the actual server outcome', async (context) => {
  const campaignId = 'cmp/qa';
  const reviewKey = 'a'.repeat(64);
  const review = {
    campaignId, campaignStatus: 'draft', segmentName: 'Lima', audienceCount: 2, unattemptedCount: 2,
    audienceLimit: 1000, limitExceeded: false, reviewKey,
  };
  const campaign = { id: campaignId, status: 'queued' };
  mockResponse(context, (request) => {
    if (request.method === 'get') {
      assert.equal(request.url, '/v1/campaigns/cmp%2Fqa/dispatch-review');
      return { success: true, data: review };
    }
    assert.equal(request.url, '/v1/campaigns/cmp%2Fqa/dispatch');
    assert.deepEqual(JSON.parse(request.data), { reviewKey });
    return { success: true, data: campaign };
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await reviewCampaignDispatch(campaignId, signal), review);
  assert.equal((await dispatchCampaign(campaignId, reviewKey)).status, 'queued');
  campaign.status = 'failed';
  assert.equal((await dispatchCampaign(campaignId, reviewKey)).status, 'failed');
  campaign.status = 'draft';
  await assert.rejects(dispatchCampaign(campaignId, reviewKey), /no confirmó el estado/);
  review.unattemptedCount = 3;
  await assert.rejects(reviewCampaignDispatch(campaignId, signal), /no confirmó la revisión/);
});

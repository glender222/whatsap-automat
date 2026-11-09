import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { InternalAxiosRequestConfig } from 'axios';
import { api } from '../shared/axios/http';
import {
  catalogPageSize, getMarketplaceListing, getMarketplaceReviews, listMarketplace, listMarketplacePublications, ratingLabel, submitMarketplaceReview,
  withdrawMarketplacePublication,
} from '../components/marketplace/marketplaceApi';

Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });

function mockResponse(context: TestContext, response: (request: InternalAxiosRequestConfig) => unknown) {
  const original = api.defaults.adapter;
  api.defaults.adapter = async (request) => ({
    data: response(request), status: 200, statusText: 'OK', headers: {}, config: request,
  });
  context.after(() => { api.defaults.adapter = original; });
}

const listing = {
  id: 'ext_13', extensionId: '@empresa/facturas', displayName: 'Facturas', version: '1.0.0', type: 'tool' as const,
  description: 'Prepara facturas', license: 'MIT', categories: ['Contabilidad'], tags: [], permissions: ['tool:execute'],
  verified: false, rating: { average: 4, count: 1 },
};

test('marketplace catalog sends filters and accepts only a complete server page', async (context) => {
  const query = { q: 'facturas', category: 'Contabilidad', type: 'tool' as const, verified: true as const, offset: 12 };
  const response = { success: true, data: [listing], pagination: { total: 13 } };
  mockResponse(context, (request) => {
    assert.equal(request.method, 'get');
    assert.equal(request.url, '/v1/marketplace/extensions');
    assert.deepEqual(request.params, { ...query, limit: catalogPageSize });
    return response;
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await listMarketplace(query, signal), { items: [listing], total: 13 });
  response.pagination.total = -1;
  await assert.rejects(listMarketplace(query, signal), /catálogo incompleto/);
  assert.equal(ratingLabel(listing.rating), '4 de 5 · 1 valoración');
});

test('detail and company reviews use the canonical extension identity', async (context) => {
  const review = { id: 'rating-13', extensionId: listing.extensionId, userId: '12', score: 4, review: 'Sirve', createdAt: '2026-02-01T00:00:00.000Z' };
  mockResponse(context, (request) => {
    if (request.url === '/v1/marketplace/extensions/ext_13') return { success: true, data: listing };
    assert.match(request.url!, /\/%40empresa%2Ffacturas\/(ratings|rate)$/);
    if (request.method === 'get') return { success: true, data: [review] };
    assert.deepEqual(JSON.parse(request.data), { score: 4, review: 'Sirve' });
    return { success: true, data: { rating: review, listing } };
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await getMarketplaceListing(listing.id, signal), listing);
  assert.deepEqual(await getMarketplaceReviews(listing.extensionId, signal), [review]);
  assert.deepEqual(await submitMarketplaceReview(listing.extensionId, 4, 'Sirve'), { rating: review, listing });
  review.extensionId = 'another-extension';
  await assert.rejects(getMarketplaceReviews(listing.extensionId, signal), /reseñas incompletas/);
  await assert.rejects(submitMarketplaceReview(listing.extensionId, 4, 'Sirve'), /no confirmó la valoración/);
});


test('publisher management accepts withdrawal only when the server confirms the same listing', async (context) => {
  const published = {
    id: listing.id, extensionId: listing.extensionId, displayName: listing.displayName, type: listing.type,
    version: listing.version, state: 'published', publishedAt: '2026-02-01T00:00:00.000Z', withdrawnAt: null,
  };
  const withdrawn = { ...published, state: 'withdrawn', withdrawnAt: '2026-02-02T00:00:00.000Z' };
  mockResponse(context, (request) => {
    if (request.method === 'get') {
      assert.equal(request.url, '/v1/marketplace/publications');
      assert.deepEqual(request.params, { offset: 12, limit: catalogPageSize });
      return { success: true, data: [published], pagination: { hasMore: false } };
    }
    assert.equal(request.url, '/v1/marketplace/extensions/ext_13/withdraw');
    return { success: true, data: withdrawn };
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await listMarketplacePublications(12, signal), { items: [published], hasMore: false });
  assert.deepEqual(await withdrawMarketplacePublication(listing.id), withdrawn);
  withdrawn.id = 'another-extension';
  await assert.rejects(withdrawMarketplacePublication(listing.id), /no confirmó la retirada/);
});

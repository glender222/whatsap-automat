import { createHmac } from 'node:crypto';
import { expect, type APIRequestContext } from '@playwright/test';
import type { Company } from './provisionCompanies';

export async function postWebhook(request: APIRequestContext, company: Company, change: object) {
  const payload = JSON.stringify({ entry: [{ changes: [{ field: 'messages', value: {
    ...change, metadata: { phone_number_id: company.phoneNumberId },
  } }] }] });
  const signature = createHmac('sha256', process.env.META_APP_SECRET!).update(payload).digest('hex');
  const receipt = await request.post(`${process.env.PRODUCT_SMOKE_URL}/api/webhooks/meta/whatsapp`, {
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=' + signature },
    data: payload,
  });
  expect(receipt.status()).toBe(200);
}

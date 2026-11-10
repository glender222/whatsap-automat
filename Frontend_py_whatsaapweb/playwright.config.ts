import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.PLAYWRIGHT_PORT ?? 4178);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('PLAYWRIGHT_PORT must be a local unprivileged port');
}
const origin = `http://127.0.0.1:${port}`;
const inboxApi = process.env.PRODUCT_SMOKE_URL ? new URL(process.env.PRODUCT_SMOKE_URL) : null;
if (inboxApi && (inboxApi.protocol !== 'http:' || inboxApi.hostname !== '127.0.0.1')) {
  throw new Error('PRODUCT_SMOKE_URL must point to a local test backend');
}

export default defineConfig({
  testDir: './e2e',
  testIgnore: process.env.PRODUCT_MERCADOPAGO_FIXTURE_URL ? [] : ['**/mercadopago.integration.spec.ts'],
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  projects: [{ name: 'chromium', use: {
    ...devices['Desktop Chrome'],
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
  } }],
  use: { baseURL: origin, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    url: origin,
    env: { VITE_API_URL: (inboxApi?.origin ?? origin) + '/api' },
  },
});

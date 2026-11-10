import { defineConfig, devices } from '@playwright/test';

const origin = 'http://127.0.0.1:4178';
const inboxApi = process.env.PRODUCT_SMOKE_URL ? new URL(process.env.PRODUCT_SMOKE_URL) : null;
if (inboxApi && (inboxApi.protocol !== 'http:' || inboxApi.hostname !== '127.0.0.1')) {
  throw new Error('PRODUCT_SMOKE_URL must point to a local test backend');
}

export default defineConfig({
  testDir: './e2e',
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  projects: [{ name: 'chromium', use: {
    ...devices['Desktop Chrome'],
    channel: process.env.PLAYWRIGHT_CHANNEL || undefined,
  } }],
  use: { baseURL: origin, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4178 --strictPort',
    url: origin,
    env: { VITE_API_URL: (inboxApi?.origin ?? origin) + '/api' },
  },
});

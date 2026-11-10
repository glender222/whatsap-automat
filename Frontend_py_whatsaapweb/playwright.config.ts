import { defineConfig, devices } from '@playwright/test';

const origin = 'http://127.0.0.1:4178';

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
    env: { VITE_API_URL: origin + '/api' },
  },
});

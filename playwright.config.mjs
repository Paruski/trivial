import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : 'line',
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' },
  webServer: { command: 'python3 run.py --host 127.0.0.1 --port 4173 --database /tmp/trivial-e2e.sqlite3', url: 'http://127.0.0.1:4173/api/health', reuseExistingServer: !process.env.CI, env: { ...process.env, TRIVIAL_ADMIN_TOKEN: 'e2e-administration-token' } },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});

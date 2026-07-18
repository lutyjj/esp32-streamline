import { defineConfig, devices } from '@playwright/test';

// Journey specs for both consoles against the fake backends in src/mocks.
// `make console-e2e` runs this inside the pinned Playwright container
// (Dockerfile.e2e); the config starts its own mock-mode vite server.
export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  reporter: [['line']],
  forbidOnly: true,
  use: {
    baseURL: 'http://127.0.0.1:5173',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npx vite --host 127.0.0.1',
    url: 'http://127.0.0.1:5173/',
    reuseExistingServer: false,
    env: { VITE_MOCK: '1' },
  },
});

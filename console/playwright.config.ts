import { defineConfig, devices } from '@playwright/test';

// Journey specs: the device console against its fake backend (src/mocks),
// the bridge console against the real bridge that `make console-e2e` starts
// beside this run. The config starts its own mock-mode vite server, which
// proxies bridge routes to STREAMLINE_BRIDGE.
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
    env: { VITE_MOCK: '1', STREAMLINE_BRIDGE: process.env.STREAMLINE_BRIDGE ?? '' },
  },
});

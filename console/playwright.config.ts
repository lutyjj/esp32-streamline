import { defineConfig, devices } from '@playwright/test';

// Journey specs: the device console against its fake backend (src/device/mocks),
// the bridge console against the real bridge that `make console-e2e` starts
// beside this run, and the flasher beside the site's manifest. The config starts
// its own mock-mode vite server, which proxies bridge routes to STREAMLINE_BRIDGE.
export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  reporter: [['line']],
  forbidOnly: true,
  use: {
    baseURL: 'http://127.0.0.1:5173',
  },
  // The screenshots wait for the journeys, which change the one bridge both use, so a
  // screen never shows another test's passing state.
  projects: [
    { name: 'journeys', testIgnore: /design\.spec\.ts/, use: { ...devices['Desktop Chrome'] } },
    {
      name: 'screens',
      testMatch: /design\.spec\.ts/,
      dependencies: ['journeys'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npx vite --host 127.0.0.1',
    url: 'http://127.0.0.1:5173/',
    reuseExistingServer: false,
    env: { VITE_MOCK: '1', STREAMLINE_BRIDGE: process.env.STREAMLINE_BRIDGE ?? '' },
  },
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import preact from '@preact/preset-vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { defineConfig, type Plugin } from 'vitest/config';

const buildTarget = process.env.STREAMLINE_BUILD || 'device';
const webflasherDir =
  process.env.STREAMLINE_WEBFLASHER_DIR || resolve(import.meta.dirname, '../webflasher');

// The dev server's public dir is the read-only WebFlasher mount, so the MSW
// worker script is served from the installed msw package instead.
function mockWorkerScript(): Plugin {
  return {
    name: 'streamline-mock-worker',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/mockServiceWorker.js', (_req, res) => {
        res.setHeader('Content-Type', 'text/javascript');
        res.end(
          readFileSync(resolve(import.meta.dirname, 'node_modules/msw/lib/mockServiceWorker.js')),
        );
      });
    },
  };
}

// In mock mode the device page's requests never reach the network (MSW
// intercepts them), so `/api` can proxy to the real bridge for the bridge
// page, along with the bridge's root-level routes.
const bridge = process.env.STREAMLINE_BRIDGE;
const proxy = bridge
  ? Object.fromEntries(
      ['/api', '/status', '/health', '/streamline.wav'].map((path) => [
        path,
        { target: `http://${bridge}` },
      ]),
    )
  : { '/api': { target: `http://${process.env.STREAMLINE_DEVICE || '192.168.71.1'}` } };

// The build inlines everything into one dist/index.html so the firmware
// embeds a single asset. The WebFlasher has its own self-contained entry.
// The dev server proxies the API to a real device (`make dev DEVICE=<ip>`)
// or serves the fake device beside a real bridge (`make dev-mock`).
export default defineConfig({
  plugins: [preact(), viteSingleFile(), mockWorkerScript()],
  publicDir: webflasherDir,
  // Replaced statically so production builds drop the mock branch entirely.
  define: {
    'import.meta.env.VITE_MOCK': JSON.stringify(process.env.VITE_MOCK ?? ''),
  },
  server: { proxy },
  build: {
    outDir: buildTarget === 'device' ? 'dist' : `dist/${buildTarget}`,
    rollupOptions:
      buildTarget === 'device'
        ? undefined
        : { input: resolve(import.meta.dirname, `${buildTarget}.html`) },
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['tests/setup.ts'],
    // Playwright owns tests/e2e; vitest must not collect its specs.
    exclude: ['tests/e2e/**', 'node_modules/**'],
  },
});

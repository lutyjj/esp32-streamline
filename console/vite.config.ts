import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import preact from '@preact/preset-vite';
import { msw } from 'msw/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { defineConfig, type Plugin } from 'vitest/config';

const buildTarget = process.env.STREAMLINE_BUILD || 'device';
const webflasherDir =
  process.env.STREAMLINE_WEBFLASHER_DIR || resolve(import.meta.dirname, '../webflasher');

// The font and its license travel together in every self-contained console.
const fontLicense = readFileSync(
  resolve(import.meta.dirname, 'node_modules/@fontsource-variable/nunito-sans/LICENSE'),
  'utf8',
);
const embeddedFontLicense: Plugin = {
  name: 'embedded-font-license',
  transformIndexHtml: {
    order: 'post',
    handler: () => [
      {
        tag: 'script',
        attrs: { type: 'text/plain', id: 'font-license' },
        children: fontLicense,
        injectTo: 'body',
      },
    ],
  },
};

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
  // MSW serves its worker script on the dev server, whose public dir is the
  // read-only WebFlasher mount. It emits the script only beside a bundle that
  // imports `virtual:msw`, which no console entry does.
  plugins: [preact(), viteSingleFile(), msw(), embeddedFontLicense],
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

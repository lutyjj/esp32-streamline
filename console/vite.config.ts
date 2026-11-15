import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import preact from '@preact/preset-vite';
import tailwindcss from '@tailwindcss/vite';
import { msw } from 'msw/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { defineConfig, type Plugin } from 'vitest/config';

const buildTarget = process.env.STREAMLINE_BUILD || 'device';
const webflasherDir =
  process.env.STREAMLINE_WEBFLASHER_DIR || resolve(import.meta.dirname, '../webflasher');

// Vite never inlines `<link rel="icon">`, so each self-contained page carries the
// icon as a data URL.
const icon = readFileSync(resolve(import.meta.dirname, 'src/icon.svg'), 'utf8');
const inlineIcon: Plugin = {
  name: 'inline-icon',
  transformIndexHtml: () => [
    {
      tag: 'link',
      attrs: { rel: 'icon', href: `data:image/svg+xml,${encodeURIComponent(icon)}` },
      injectTo: 'head',
    },
  ],
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

// Tests compile every dependency from its module build, so each one that
// imports React meets preact/compat, as the browser bundle has it. Base UI's
// store shim ships only as CommonJS, which Node would load past the aliases.
const testResolution = {
  alias: [
    {
      find: /^@testing-library\/react$/,
      replacement: '@testing-library/react/dist/@testing-library/react.esm.js',
    },
    {
      find: /^use-sync-external-store\/shim(\/with-selector)?(\/index)?(\.js)?$/,
      replacement: resolve(import.meta.dirname, 'tests/use-sync-external-store.ts'),
    },
  ],
  conditions: ['module', 'browser', 'development', 'import'],
  noExternal: true as const,
};

// The build inlines everything into one dist/index.html so the firmware
// embeds a single asset. The WebFlasher has its own self-contained entry.
// The dev server proxies the API to a real device (`make dev DEVICE=<ip>`)
// or serves the fake device beside a real bridge (`make dev-mock`).
export default defineConfig(({ mode }) => ({
  // MSW serves its worker script on the dev server, whose public dir is the
  // read-only WebFlasher mount. It emits the script only beside a bundle that
  // imports `virtual:msw`, which no console entry does.
  plugins: [preact(), tailwindcss(), viteSingleFile(), msw(), inlineIcon],
  publicDir: webflasherDir,
  // preact() resolves React to preact/compat; linen's Motion resolves to its
  // stand-in, so only the animations its stylesheet runs remain.
  resolve: {
    ...(mode === 'test' ? testResolution : {}),
    alias: [
      { find: /^motion(\/react)?$/, replacement: 'linen/still' },
      ...(mode === 'test' ? testResolution.alias : []),
    ],
  },
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
}));

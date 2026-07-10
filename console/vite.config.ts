import { resolve } from 'node:path';
import preact from '@preact/preset-vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { defineConfig } from 'vitest/config';

const flasherBuild = process.env.STREAMLINE_BUILD === 'flasher';
const webflasherDir =
  process.env.STREAMLINE_WEBFLASHER_DIR || resolve(import.meta.dirname, '../webflasher');

// The build inlines everything into one dist/index.html so the firmware
// embeds a single asset. The WebFlasher has its own self-contained entry.
// The dev server proxies the API to a real device: `make dev DEVICE=<ip>`.
export default defineConfig({
  plugins: [preact(), viteSingleFile()],
  publicDir: webflasherDir,
  server: {
    proxy: {
      '/api': { target: `http://${process.env.STREAMLINE_DEVICE || '192.168.71.1'}` },
    },
  },
  build: {
    outDir: flasherBuild ? 'dist/flasher' : 'dist',
    rollupOptions: flasherBuild
      ? { input: resolve(import.meta.dirname, 'flasher.html') }
      : undefined,
  },
  test: {
    environment: 'happy-dom',
  },
});

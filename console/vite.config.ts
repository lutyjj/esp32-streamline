import preact from '@preact/preset-vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { defineConfig } from 'vitest/config';

// The build inlines everything into one dist/index.html so the firmware
// embeds a single asset. The dev server proxies the API to a real device:
// `make dev DEVICE=<ip>`.
export default defineConfig({
  plugins: [preact(), viteSingleFile()],
  server: {
    proxy: {
      '/api': { target: `http://${process.env.STREAMLINE_DEVICE || '192.168.71.1'}` },
    },
  },
  test: {
    environment: 'happy-dom',
  },
});

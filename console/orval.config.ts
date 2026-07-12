import { defineConfig } from 'orval';

export default defineConfig({
  device: {
    input: {
      target: '../docs/openapi.json',
    },
    output: {
      client: 'fetch',
      mode: 'single',
      override: {
        fetch: {
          includeHttpResponseReturnType: false,
        },
        mutator: {
          name: 'deviceFetch',
          path: './src/lib/http.ts',
        },
      },
      target: './src/generated/api.ts',
    },
  },
});

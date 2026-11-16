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
          path: './src/device/lib/http.ts',
        },
      },
      target: './src/generated/api.ts',
    },
  },
  deviceRules: {
    input: {
      target: '../docs/openapi.json',
    },
    output: {
      client: 'valibot',
      mode: 'single',
      override: {
        valibot: {
          generate: { param: false, query: false, header: false, body: false, response: false },
          generateReusableSchemas: true,
        },
      },
      target: './src/generated/rules.ts',
    },
  },
  bridge: {
    input: {
      target: '../docs/bridge-openapi.json',
    },
    output: {
      client: 'fetch',
      mode: 'single',
      override: {
        fetch: {
          includeHttpResponseReturnType: false,
        },
        mutator: {
          name: 'bridgeFetch',
          path: './src/bridge/http.ts',
        },
      },
      target: './src/generated/bridge.ts',
    },
  },
});

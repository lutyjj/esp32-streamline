import { defineConfig } from 'orval';

export default defineConfig({
  device: {
    input: {
      target: '../docs/openapi.json',
    },
    output: {
      client: 'fetch',
      mode: 'single',
      // A handler for every operation, the base under the fake device.
      mock: { generators: [{ type: 'msw', useExamples: true }] },
      override: {
        // Workaround: Orval 8.48 types a binary response's mock as a Blob but
        // draws it as an array of numbers, which fails tsc. The fake answers
        // this route itself; remove once Orval draws binary mocks as a Blob.
        operations: { get_coredump_image: { mock: { data: () => new Blob() } } },
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

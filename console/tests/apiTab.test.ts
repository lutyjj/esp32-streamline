import { describe, expect, it } from 'vitest';
import { collectOperations } from '../src/components/ApiTab';
import type { OpenApiDocument } from '../src/lib/api';

describe('API page model', () => {
  it('summarizes operations from the served OpenAPI contract', () => {
    const spec: OpenApiDocument = {
      openapi: '3.1.0',
      info: { title: 'StreamLine Device API', version: '0.4.0' },
      paths: {
        '/api/status': {
          get: {
            summary: 'Get runtime status.',
            operationId: 'getStatus',
            responses: { '200': { description: 'ok' } },
          },
        },
        '/api/settings/network': {
          post: {
            summary: 'Save Wi-Fi and stream target settings.',
            operationId: 'setNetworkSettings',
            security: [{ adminKey: [] }],
            requestBody: {
              content: {
                'application/x-www-form-urlencoded': {
                  schema: { $ref: '#/components/schemas/NetworkSettingsForm' },
                },
              },
            },
            responses: {
              '200': { description: 'ok' },
              '400': { description: 'bad request' },
              '401': { description: 'unauthorized' },
            },
          },
        },
      },
      components: {
        schemas: {
          NetworkSettingsForm: {
            type: 'object',
            required: ['ssid', 'target_port'],
            properties: {
              ssid: { type: 'string' },
              password: { type: 'string' },
              target_port: { type: 'integer' },
            },
          },
        },
      },
    };

    expect(collectOperations(spec)).toEqual([
      {
        path: '/api/status',
        method: 'get',
        summary: 'Get runtime status.',
        operationId: 'getStatus',
        secured: false,
        requestContent: [],
        requestFields: [],
        responses: ['200'],
      },
      {
        path: '/api/settings/network',
        method: 'post',
        summary: 'Save Wi-Fi and stream target settings.',
        operationId: 'setNetworkSettings',
        secured: true,
        requestContent: ['application/x-www-form-urlencoded'],
        requestFields: ['ssid*', 'password', 'target_port*'],
        responses: ['200', '400', '401'],
      },
    ]);
  });
});

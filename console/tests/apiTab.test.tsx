import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiTab } from '../src/components/ApiTab';
import { setTransport } from '../src/lib/api';

afterEach(() => setTransport((request) => fetch(request)));

describe('ApiTab', () => {
  it('renders operations and form constraints from the served contract', async () => {
    setTransport(async () =>
      Response.json({
        info: { title: 'StreamLine device API', version: '1.0.0' },
        paths: {
          '/api/settings/name': {
            post: {
              summary: 'Set device name',
              security: [{ bearer_auth: [] }],
              requestBody: {
                content: {
                  'application/x-www-form-urlencoded': {
                    schema: { $ref: '#/components/schemas/NameSettingsRequest' },
                  },
                },
              },
              responses: { 200: {}, 400: {} },
            },
          },
        },
        components: {
          schemas: {
            NameSettingsRequest: {
              type: 'object',
              properties: { name: { type: ['string', 'null'], maxLength: 32 } },
              required: ['name'],
            },
          },
        },
      }),
    );
    const host = document.createElement('div');
    render(<ApiTab />, host);

    await vi.waitFor(() => expect(host.textContent).toContain('/api/settings/name'));
    expect(host.textContent).toContain('Set device name');
    expect(host.textContent).toContain('max length 32');
    expect(host.textContent).toContain('string | null');
    expect(host.textContent).toContain('required');
    expect(host.querySelector('.api-auth')?.textContent).toBe('key');
    expect(host.querySelector('.api-copy')?.className).toContain('btn secondary');
  });
});

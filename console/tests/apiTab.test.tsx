import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiTab, curlCommand } from '../src/components/ApiTab';
import { setTransport } from '../src/lib/api';
import { type ApiDocument, resolveSchema } from '../src/lib/contract';

afterEach(() => setTransport((request) => fetch(request)));

describe('ApiTab', () => {
  it('renders operations and form constraints from the served contract', async () => {
    setTransport(async () =>
      Response.json({
        info: { title: 'StreamLine device API', version: '1.0.0' },
        paths: {
          '/api/status': {
            get: {
              summary: 'Read device status',
              responses: { 200: {} },
            },
          },
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
    expect(host.querySelectorAll('.api-operation > summary > .api-auth-slot')).toHaveLength(2);
  });
});

describe('curl example disposition for every served operation', () => {
  // The committed device contract is the input, so a contract change reruns
  // every disposition here instead of leaving stale examples silently passing.
  const artifact = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../../docs/openapi.json'), 'utf8'),
  ) as ApiDocument;

  const operations = Object.entries(artifact.paths ?? {}).flatMap(([path, item]) =>
    (['get', 'post'] as const).flatMap((method) =>
      item[method]
        ? [{ path, method: method.toUpperCase() as 'GET' | 'POST', op: item[method] }]
        : [],
    ),
  );

  it('covers the whole contract', () => {
    expect(operations.length).toBeGreaterThan(0);
  });

  it.each(operations.map((o) => [o.method, o.path, o] as const))(
    '%s %s authenticates when secured and sends only required fields',
    (_method, _path, entry) => {
      const media = entry.op.requestBody?.content?.['application/x-www-form-urlencoded'];
      const body = resolveSchema(artifact, media?.schema);
      const command = curlCommand(entry.method, entry.path, entry.op, body, 'http://192.0.2.1');

      if (entry.op.security) {
        // Double quotes, so a real shell expands the environment token.
        expect(command).toContain('-H "Authorization: Bearer $STREAMLINE_ADMIN_KEY"');
      } else {
        expect(command).not.toContain('Authorization');
      }

      const required = new Set(body?.required ?? []);
      const sent = [...command.matchAll(/--data-urlencode '([^=]+)=/g)].map((m) => m[1]);
      for (const field of sent) {
        expect(required.has(field), `optional field ${field} must not be invented`).toBe(true);
      }
      expect(new Set(sent).size).toBe(sent.length);
    },
  );
});

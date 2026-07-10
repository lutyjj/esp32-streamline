import { afterEach, describe, expect, it } from 'vitest';
import { forgetAdminKey, isUnlocked, unlockSettings } from '../src/lib/adminKey';
import { apiClient, setTransport, unwrap } from '../src/lib/api';

function respond(status: number, body: string): Response {
  return new Response(body, { status });
}

afterEach(() => {
  forgetAdminKey();
  setTransport((request) => fetch(request));
});

describe('api transport', () => {
  it('attaches the bearer key to mutating requests while unlocked', async () => {
    unlockSettings('secret-key', false);
    let seen: Request | undefined;
    setTransport(async (request) => {
      seen = request;
      return respond(200, '{"ok":true}');
    });

    await unwrap(apiClient.POST('/api/restart'));
    expect(seen?.headers.get('Authorization')).toBe('Bearer secret-key');
  });

  it('sends reads without credentials', async () => {
    unlockSettings('secret-key', false);
    let seen: Request | undefined;
    setTransport(async (request) => {
      seen = request;
      return respond(200, '{}');
    });

    await unwrap(apiClient.GET('/api/status'));
    expect(seen?.headers.has('Authorization')).toBe(false);
  });

  it('a 401 closes the unlock window everywhere', async () => {
    unlockSettings('stale-key', false);
    setTransport(async () => respond(401, '{"error":"unauthorized"}'));

    await expect(unwrap(apiClient.POST('/api/restart'))).rejects.toThrow(/unlock settings/);
    expect(isUnlocked()).toBe(false);
  });

  it('surfaces the device error message on a rejected write', async () => {
    setTransport(async () => respond(400, '{"error":"ssid is required"}'));
    await expect(
      unwrap(apiClient.POST('/api/settings/wifi', { body: { ssid: '' } })),
    ).rejects.toThrow('ssid is required');
  });

  it('falls back to raw text when the error body is not JSON', async () => {
    setTransport(async () => respond(500, 'boom'));
    await expect(unwrap(apiClient.GET('/api/status'))).rejects.toThrow('boom');
  });
});

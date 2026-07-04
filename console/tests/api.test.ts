import { afterEach, describe, expect, it } from 'vitest';
import { forgetAdminKey, isUnlocked, unlockSettings } from '../src/lib/adminKey';
import { api, setTransport } from '../src/lib/api';

function respond(status: number, body: string): Response {
  return new Response(body, { status });
}

afterEach(() => {
  forgetAdminKey();
  setTransport((input, init) => fetch(input, init));
});

describe('api transport', () => {
  it('attaches the bearer key to mutating requests while unlocked', async () => {
    unlockSettings('secret-key', false);
    let seen: RequestInit | undefined;
    setTransport(async (_input, init) => {
      seen = init;
      return respond(200, '{"ok":true}');
    });

    await api('/api/restart', { method: 'POST' });
    expect((seen?.headers as Record<string, string>).Authorization).toBe('Bearer secret-key');
  });

  it('sends reads without credentials', async () => {
    unlockSettings('secret-key', false);
    let seen: RequestInit | undefined;
    setTransport(async (_input, init) => {
      seen = init;
      return respond(200, '{}');
    });

    await api('/api/status');
    expect((seen?.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it('a 401 closes the unlock window everywhere', async () => {
    unlockSettings('stale-key', false);
    setTransport(async () => respond(401, '{"error":"unauthorized"}'));

    await expect(api('/api/restart', { method: 'POST' })).rejects.toThrow(/unlock settings/);
    expect(isUnlocked()).toBe(false);
  });

  it('surfaces the device error message on a rejected write', async () => {
    setTransport(async () => respond(400, '{"error":"ssid is required"}'));
    await expect(api('/api/settings/network', { method: 'POST' })).rejects.toThrow(
      'ssid is required',
    );
  });

  it('falls back to raw text when the error body is not JSON', async () => {
    setTransport(async () => respond(500, 'boom'));
    await expect(api('/api/status')).rejects.toThrow('boom');
  });
});

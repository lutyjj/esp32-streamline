import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { forgetAdminKey, isUnlocked, unlockSettings } from '../src/lib/adminKey';
import { getLogs, getStatus, restart, setTransport, setWifi } from '../src/lib/api';
import { digestResponse, parseDigestFields } from '../src/lib/digest';
import { AUTHENTICATED_READS, verifyAdminKey } from '../src/lib/http';

function respond(status: number, body: string): Response {
  return new Response(body, { status });
}

function challenge(nonce: string): Response {
  return new Response('{"error":"unauthorized"}', {
    status: 401,
    headers: {
      'WWW-Authenticate': `Digest realm="streamline", qop="auth", algorithm=SHA-256, nonce="${nonce}"`,
    },
  });
}

/**
 * A transport standing in for the provisioned device: challenges a request
 * without credentials and verifies the digest answer exactly as the
 * firmware computes it.
 */
function deviceTransport(key: string, ok: (request: Request) => Response) {
  const seen: Request[] = [];
  const transport = async (request: Request): Promise<Response> => {
    seen.push(request);
    const fields = parseDigestFields(request.headers.get('Authorization'));
    if (!fields) return challenge('nonce-1');
    const uri = new URL(request.url).pathname;
    const expected = digestResponse(
      'admin',
      'streamline',
      key,
      request.method,
      uri,
      fields.get('nonce') ?? '',
      fields.get('nc') ?? '',
      fields.get('cnonce') ?? '',
    );
    if (fields.get('response') !== expected) return challenge('nonce-2');
    return ok(request);
  };
  return { seen, transport };
}

afterEach(() => {
  forgetAdminKey();
  setTransport((request) => fetch(request));
});

describe('api transport', () => {
  it('answers the digest challenge on a mutating request while unlocked', async () => {
    unlockSettings('secret-key', false);
    const device = deviceTransport('secret-key', () => respond(200, '{"ok":true}'));
    setTransport(device.transport);

    await restart();

    // One challenge, one authorized retry; the key itself never appears.
    expect(device.seen).toHaveLength(2);
    const fields = parseDigestFields(device.seen[1].headers.get('Authorization'));
    expect(fields?.get('username')).toBe('admin');
    expect(fields?.get('uri')).toBe('/api/restart');
    expect(device.seen[1].headers.get('Authorization')).not.toContain('secret-key');
  });

  it('reuses the accepted challenge so the next write costs one round trip', async () => {
    unlockSettings('secret-key', false);
    const device = deviceTransport('secret-key', () => respond(200, '{"ok":true}'));
    setTransport(device.transport);

    await restart();
    await restart();

    // challenge + retry, then one straight-through authorized request.
    expect(device.seen).toHaveLength(3);
    const fields = parseDigestFields(device.seen[2].headers.get('Authorization'));
    expect(fields?.get('nc')).toBe('00000002');
  });

  it('never lets the browser answer a challenge on the console behalf', async () => {
    // A same-origin request carrying credentials makes the browser pop its
    // own username/password dialog on the 401 instead of letting the console
    // answer the digest challenge.
    unlockSettings('secret-key', false);
    const device = deviceTransport('secret-key', () => respond(200, '{"ok":true}'));
    setTransport(device.transport);

    await restart();
    await verifyAdminKey('secret-key');

    expect(device.seen.length).toBeGreaterThan(0);
    for (const request of device.seen) expect(request.credentials).toBe('omit');
  });

  it('sends reads without credentials', async () => {
    unlockSettings('secret-key', false);
    let seen: Request | undefined;
    setTransport(async (request) => {
      seen = request;
      return respond(200, '{}');
    });

    await getStatus();
    expect(seen?.headers.has('Authorization')).toBe(false);
  });

  it('answers the challenge on a read the contract gates', async () => {
    unlockSettings('secret-key', false);
    const device = deviceTransport('secret-key', () =>
      respond(200, '{"current":{"lines":[],"dropped":0},"previous":null}'),
    );
    setTransport(device.transport);

    await getLogs();
    expect(device.seen).toHaveLength(2);
    expect(parseDigestFields(device.seen[1].headers.get('Authorization'))?.get('uri')).toBe(
      '/api/logs',
    );
  });

  it('gates exactly the reads the contract marks as authenticated', () => {
    // vitest runs with the console package as its working directory.
    const contract = JSON.parse(readFileSync(resolve('..', 'docs', 'openapi.json'), 'utf8')) as {
      paths: Record<string, Record<string, { security?: unknown[] }>>;
    };
    const gated = Object.entries(contract.paths)
      .filter(([, operations]) => operations.get?.security?.length)
      .map(([path]) => path);

    expect([...AUTHENTICATED_READS].sort()).toEqual(gated.sort());
  });

  it('serializes form bodies and returns response data directly', async () => {
    let seen: Request | undefined;
    setTransport(async (request) => {
      seen = request;
      return respond(200, '{"rebooting":true}');
    });

    const ack = await setWifi({ ssid: 'Study Wi-Fi', target_port: 39000 });

    expect(ack.rebooting).toBe(true);
    expect(seen?.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
    await expect(seen?.text()).resolves.toBe('ssid=Study+Wi-Fi&target_port=39000');
  });

  it('a retried challenge with the wrong key closes the unlock window', async () => {
    unlockSettings('stale-key', false);
    const device = deviceTransport('the-real-key', () => respond(200, '{"ok":true}'));
    setTransport(device.transport);

    await expect(restart()).rejects.toThrow(/unlock settings/);
    expect(isUnlocked()).toBe(false);
  });

  it('a bare 401 closes the unlock window everywhere', async () => {
    unlockSettings('stale-key', false);
    setTransport(async () => respond(401, '{"error":"unauthorized"}'));

    await expect(restart()).rejects.toThrow(/unlock settings/);
    expect(isUnlocked()).toBe(false);
  });

  it('surfaces the device error message on a rejected write', async () => {
    setTransport(async () => respond(400, '{"error":"ssid is required"}'));
    await expect(setWifi({ ssid: '' })).rejects.toThrow('ssid is required');
  });

  it('falls back to raw text when the error body is not JSON', async () => {
    setTransport(async () => respond(500, 'boom'));
    await expect(getStatus()).rejects.toThrow('boom');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetAdminKey, isUnlocked, unlockSettings } from '../../src/device/lib/adminKey';
import { digestResponse, parseDigestFields } from '../../src/device/lib/digest';
import { ANSWER_WITHIN_MS, setTransport, verifyAdminKey } from '../../src/device/lib/http';
import {
  getBridges,
  getLogs,
  getSettings,
  getStatus,
  restart,
  setWifi,
} from '../../src/generated/api';

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

/** A device that never answers: the request settles only when its signal ends it. */
function silentDevice(request: Request): Promise<Response> {
  return new Promise((_, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
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

  it('surfaces the device’s reason, and the field it names, on a refused write', async () => {
    setTransport(async () =>
      respond(400, '{"error":"A network name is required.","field":"ssid"}'),
    );
    await expect(setWifi({ ssid: '' })).rejects.toMatchObject({
      message: 'A network name is required.',
      field: 'ssid',
    });
  });

  it('falls back to raw text when the error body is not JSON', async () => {
    setTransport(async () => respond(500, 'boom'));
    await expect(getStatus()).rejects.toThrow('boom');
  });

  it('ends a request the device leaves unanswered, in words, at the bound', async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    // The bound shrinks to a millisecond so the test does not wait out ten seconds.
    const bound = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(1));
    setTransport(silentDevice);
    await expect(getStatus()).rejects.toThrow('the device did not answer in time');
    await expect(verifyAdminKey('a'.repeat(48))).rejects.toThrow('did not answer in time');
    expect(bound).toHaveBeenCalledWith(ANSWER_WITHIN_MS);
  });

  it('sends status reads in their own lane, so a slow request never holds up the poll', async () => {
    const sent: string[] = [];
    let release = () => {};
    setTransport(async (request) => {
      const path = new URL(request.url).pathname;
      sent.push(path);
      if (path === '/api/bridges') await new Promise<void>((done) => (release = done));
      return respond(200, '{"bridges":[]}');
    });

    const search = getBridges();
    const settings = getSettings();
    await getStatus();
    // The device keeps two connections: the search holds one, the poll the other.
    expect(sent).toEqual(['/api/bridges', '/api/status']);
    release();
    await Promise.all([search, settings]);
    expect(sent).toEqual(['/api/bridges', '/api/status', '/api/settings']);
  });

  it('keeps the bound a caller sets for itself', async () => {
    const bound = vi.spyOn(AbortSignal, 'timeout');
    const caller = new AbortController();
    setTransport(silentDevice);
    const read = getStatus({ signal: caller.signal });
    caller.abort(new Error('the search was stopped'));
    await expect(read).rejects.toThrow('the search was stopped');
    expect(bound).not.toHaveBeenCalled();
  });
});

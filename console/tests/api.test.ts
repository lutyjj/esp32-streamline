import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { forgetAdminKey, isUnlocked, unlockSettings } from '../src/lib/adminKey';
import { getLogs, getStatus, restart, setTransport, setWifi } from '../src/lib/api';
import { AUTHENTICATED_READS } from '../src/lib/http';

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

    await restart();
    expect(seen?.headers.get('Authorization')).toBe('Bearer secret-key');
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

  it('attaches the bearer key to a read the contract gates', async () => {
    unlockSettings('secret-key', false);
    let seen: Request | undefined;
    setTransport(async (request) => {
      seen = request;
      return respond(200, '{"current":{"lines":[],"dropped":0},"previous":null}');
    });

    await getLogs();
    expect(seen?.headers.get('Authorization')).toBe('Bearer secret-key');
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

  it('a 401 closes the unlock window everywhere', async () => {
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

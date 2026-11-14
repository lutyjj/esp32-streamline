import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetAdminKey, isUnlocked } from '../src/lib/adminKey';
import { setTransport } from '../src/lib/api';
import type { WifiCredentials } from '../src/lib/wifi';
import { deviceStatus } from '../src/mocks/fixtures';
import { status } from '../src/state/device';
import { expectedHostname, handoff, handoffMessage, joinNetwork } from '../src/state/join';
import { rebootWait } from '../src/state/rebootWait';
import { setupKey } from '../src/state/setupKey';

/** A protected network with a typed password. */
const PW: WifiCredentials = { password: 'pw', open_network: false };

beforeEach(() => {
  status.value = null;
  handoff.value = null;
  rebootWait.value = null;
  forgetAdminKey();
  setupKey.value = 'generated-key';
});

afterEach(() => {
  setTransport((request) => fetch(request));
});

describe('joinNetwork', () => {
  it('sends the credentials with the generated admin key', async () => {
    let body = '';
    setTransport(async (request) => {
      body = await request.text();
      return new Response('{"rebooting":true}', { status: 200 });
    });

    await joinNetwork({
      ssid: '  studio ',
      credentials: PW,
      target: { host: ' bridge.local ', port: '' },
      rememberKey: false,
    });
    const fields = new URLSearchParams(body);
    expect(fields.get('ssid')).toBe('studio');
    expect(fields.get('password')).toBe('pw');
    expect(fields.get('open_network')).toBe('false');
    expect(fields.get('admin_key')).toBe('generated-key');
    expect(fields.get('target_host')).toBe('bridge.local');
    expect(fields.get('target_port')).toBe('39000');
  });

  it('leaves the stored target and key alone when it carries none', async () => {
    // Recovery: the device keeps a target the owner did not touch, and an
    // empty key keeps its stored one.
    let body = '';
    setTransport(async (request) => {
      body = await request.text();
      return new Response('{"rebooting":true}', { status: 200 });
    });
    setupKey.value = '';

    await joinNetwork({
      ssid: 'studio',
      credentials: { password: '', open_network: false },
      rememberKey: false,
    });
    const fields = new URLSearchParams(body);
    expect(fields.has('target_host')).toBe(false);
    expect(fields.has('target_port')).toBe(false);
    expect(fields.get('password')).toBe('');
    expect(fields.get('admin_key')).toBe('');
    expect(handoff.value).toBe('confirmed');
    expect(isUnlocked()).toBe(false);
  });

  it('unlocks this browser and flags the handoff, without a reboot wait', async () => {
    setTransport(async () => new Response('{"rebooting":true}', { status: 200 }));

    await expect(
      joinNetwork({ ssid: 'studio', credentials: PW, rememberKey: false }),
    ).resolves.toBe('confirmed');
    expect(isUnlocked()).toBe(true);
    expect(handoff.value).toBe('confirmed');
    // The fallback escalation lives in rebootWait; a first join must never
    // arm it, because this browser stays on the vanished setup network.
    expect(rebootWait.value).toBeNull();
  });

  it('changes nothing when the device rejects the save', async () => {
    setTransport(async () => new Response('{"error":"ssid is required"}', { status: 400 }));

    await expect(joinNetwork({ ssid: '', credentials: PW, rememberKey: true })).rejects.toThrow(
      'ssid is required',
    );
    expect(isUnlocked()).toBe(false);
    expect(handoff.value).toBeNull();
  });

  it('preserves access but marks a dropped connection as unconfirmed', async () => {
    // The device flushed its response, then tore down the setup AP as it
    // rebooted — so the fetch rejects with a transport error after the save
    // already succeeded. The join must land on the handoff, not "Not saved".
    setTransport(async () => {
      throw new TypeError('NetworkError when attempting to fetch resource.');
    });

    await expect(joinNetwork({ ssid: 'studio', credentials: PW, rememberKey: true })).resolves.toBe(
      'unconfirmed',
    );
    expect(handoff.value).toBe('unconfirmed');
    expect(handoffMessage()).toContain('before the save could be confirmed');
    expect(isUnlocked()).toBe(true);
    // Still a first join: never arm the fallback escalation.
    expect(rebootWait.value).toBeNull();
  });
});

describe('expectedHostname', () => {
  it('uses the advertised hostname and falls back to the placeholder', () => {
    expect(expectedHostname()).toBe('streamline-xxxx.local');
    status.value = deviceStatus();
    expect(expectedHostname()).toBe('streamline-0000.local');
  });
});

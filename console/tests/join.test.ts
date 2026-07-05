import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetAdminKey, isUnlocked } from '../src/lib/adminKey';
import { setTransport } from '../src/lib/api';
import { status } from '../src/state/device';
import { expectedHostname, handoff, joinNetwork } from '../src/state/join';
import { rebootWait } from '../src/state/rebootWait';
import { setupKey } from '../src/state/setupKey';
import { deviceStatus } from './fixtures';

beforeEach(() => {
  status.value = null;
  handoff.value = false;
  rebootWait.value = null;
  forgetAdminKey();
  setupKey.value = 'generated-key';
});

afterEach(() => {
  setTransport((input, init) => fetch(input, init));
});

describe('joinNetwork', () => {
  it('sends the credentials with the generated admin key', async () => {
    let body = '';
    setTransport(async (_input, init) => {
      body = String(init?.body);
      return new Response('{"rebooting":true}', { status: 200 });
    });

    await joinNetwork({ ssid: '  studio ', password: 'pw', rememberKey: false });
    const fields = new URLSearchParams(body);
    expect(fields.get('ssid')).toBe('studio');
    expect(fields.get('password')).toBe('pw');
    expect(fields.get('admin_secret')).toBe('generated-key');
    expect(fields.get('target_host')).toBe('');
    expect(fields.get('target_port')).toBe('39000');
  });

  it('unlocks this browser and flags the handoff, without a reboot wait', async () => {
    setTransport(async () => new Response('{"rebooting":true}', { status: 200 }));

    await joinNetwork({ ssid: 'studio', password: 'pw', rememberKey: false });
    expect(isUnlocked()).toBe(true);
    expect(handoff.value).toBe(true);
    // The fallback escalation lives in rebootWait; a first join must never
    // arm it, because this browser stays on the vanished setup network.
    expect(rebootWait.value).toBeNull();
  });

  it('changes nothing when the device rejects the save', async () => {
    setTransport(async () => new Response('{"error":"ssid is required"}', { status: 400 }));

    await expect(joinNetwork({ ssid: '', password: 'pw', rememberKey: true })).rejects.toThrow(
      'ssid is required',
    );
    expect(isUnlocked()).toBe(false);
    expect(handoff.value).toBe(false);
  });
});

describe('expectedHostname', () => {
  it('uses the advertised hostname and falls back to the placeholder', () => {
    expect(expectedHostname()).toBe('streamline-xxxx.local');
    status.value = deviceStatus();
    expect(expectedHostname()).toBe('streamline-0000.local');
  });
});

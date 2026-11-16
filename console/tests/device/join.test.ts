import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetAdminKey, isUnlocked } from '../../src/device/lib/adminKey';
import { setTransport } from '../../src/device/lib/http';
import type { WifiEntry } from '../../src/device/lib/wifi';
import { deviceStatus } from '../../src/device/mocks/fixtures';
import { JOIN_GRACE_MS } from '../../src/device/state/connection';
import { connection, joinUntaken, report } from '../../src/device/state/device';
import { joinNetwork, keyUnconfirmed, untakenJoinNews } from '../../src/device/state/join';
import { setupKey } from '../../src/device/state/setupKey';
import { answering } from './answering';

/** The handoff the join reported, or null. */
function handoff() {
  const now = connection.value;
  return now.phase === 'handoff' ? now.handoff : null;
}

const HOME: WifiEntry = { ssid: '  studio ', password: 'correct horse', open: false };

/** Answer every request as the device would to a saved Wi-Fi, keeping the body. */
function accepting(): { body: URLSearchParams } {
  const sent = { body: new URLSearchParams() };
  setTransport(async (request) => {
    sent.body = new URLSearchParams(await request.text());
    return new Response('{"rebooting":true}', { status: 200 });
  });
  return sent;
}

beforeEach(() => {
  answering(null);
  forgetAdminKey();
  setupKey.value = 'generated-key';
});

afterEach(() => {
  setTransport((request) => fetch(request));
});

describe('keyUnconfirmed', () => {
  it('holds first contact until the owner confirms the key is kept elsewhere', () => {
    expect(keyUnconfirmed(false)).toBe(true);
    expect(keyUnconfirmed(true)).toBe(false);
  });

  it('asks no confirmation of a device that keeps its own key', () => {
    setupKey.value = '';
    expect(keyUnconfirmed(false)).toBe(false);
  });
});

describe('a join the device never took', () => {
  it('names the network it is still on, or its setup network', () => {
    const setup = deviceStatus({ mode: 'setup', wifi: { ssid: '' } });
    report({ type: 'answered', status: setup, at: 0 });
    report({
      type: 'handoff',
      handoff: { kind: 'join', ssid: 'home', confirmed: false },
      at: 1000,
    });
    report({ type: 'answered', status: setup, at: 1000 + JOIN_GRACE_MS });

    const untaken = joinUntaken.value;
    expect(untaken).toEqual({ ssid: 'home', still: null });
    expect(untaken && untakenJoinNews(untaken)).toBe(
      'The device did not join home. It is still on its setup network; try the join again.',
    );
    expect(untakenJoinNews({ ssid: 'home', still: 'Study Wi-Fi' })).toContain(
      'It is still on Study Wi-Fi',
    );
    joinUntaken.value = null;
  });
});

describe('joinNetwork', () => {
  it('sends the network with the generated admin key, and no bridge', async () => {
    const sent = accepting();
    await expect(joinNetwork(HOME)).resolves.toBe('confirmed');
    expect(sent.body.get('ssid')).toBe('studio');
    expect(sent.body.get('password')).toBe('correct horse');
    expect(sent.body.get('open_network')).toBe('false');
    expect(sent.body.get('admin_key')).toBe('generated-key');
    expect(sent.body.has('target_host')).toBe(false);
  });

  it('hands off instead of waiting for a restart, and unlocks for a failed join', async () => {
    accepting();
    await joinNetwork(HOME);
    // This browser stays on the setup network the device just closed.
    expect(handoff()).toEqual({ kind: 'join', ssid: 'studio', confirmed: true });
    expect(isUnlocked()).toBe(true);
  });

  it('keeps the stored key and password on a recovery change', async () => {
    setupKey.value = '';
    const sent = accepting();
    await joinNetwork({ ssid: 'studio', password: '', open: false });
    expect(sent.body.get('password')).toBe('');
    expect(sent.body.get('admin_key')).toBe('');
    expect(isUnlocked()).toBe(false);
  });

  it('changes nothing when the device refuses the save, and passes on the field it names', async () => {
    setTransport(
      async () =>
        new Response('{"error":"A protected network needs its password.","field":"password"}', {
          status: 400,
        }),
    );
    await expect(joinNetwork(HOME)).rejects.toMatchObject({ field: 'password' });
    expect(isUnlocked()).toBe(false);
    expect(handoff()).toBeNull();
  });

  it('marks a connection that dropped before the answer as unconfirmed', async () => {
    // The device flushed its answer, then closed the setup network as it
    // restarted, so the request fails after a save that may have succeeded.
    setTransport(async () => {
      throw new TypeError('NetworkError when attempting to fetch resource.');
    });
    await expect(joinNetwork(HOME)).resolves.toBe('unconfirmed');
    expect(handoff()).toEqual({ kind: 'join', ssid: 'studio', confirmed: false });
    expect(isUnlocked()).toBe(true);
  });
});

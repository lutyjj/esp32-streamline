import { getResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { forgetAdminKey, unlockSettings } from '../../src/device/lib/adminKey';
import { getStatus, type StatusResponse, setTransport, setWifi } from '../../src/device/lib/api';
import { type DeviceScenario, FakeDevice, MOCK_ADMIN_KEY } from '../../src/device/mocks/device';

// The fake device leaves the network it was reached on after a join, as the
// firmware does, so a handoff is what the console sees.
function reach(scenario: DeviceScenario): void {
  const device = new FakeDevice(scenario);
  setTransport(async (request) => {
    const response = await getResponse(device.handlers, request, {
      baseUrl: window.location.origin,
    });
    if (!response) throw new Error(`No mock handler for ${request.url}`);
    if (response.type === 'error') throw new TypeError('Failed to fetch');
    return response;
  });
}

/** Read status `times` times; the last answer, or null when every read failed. */
async function readStatus(times: number): Promise<StatusResponse | null> {
  let last: StatusResponse | null = null;
  for (let read = 0; read < times; read += 1) {
    last = await getStatus().catch(() => null);
  }
  return last;
}

afterEach(() => {
  forgetAdminKey();
  setTransport((request) => fetch(request));
});

describe('a join from the setup network', () => {
  it('that works leaves this network for good', async () => {
    reach('first-boot');
    await setWifi({ ssid: 'home', password: 'correct horse', admin_key: MOCK_ADMIN_KEY });
    await expect(getStatus()).rejects.toThrow(TypeError);
    expect(await readStatus(20)).toBeNull();
  });

  it.each([
    ['Nowhere', 'correct horse', false, 'network-not-found'],
    ['home', 'wrong password', false, 'credentials-rejected'],
    ['Cafe guest', 'correct horse', false, 'security-mismatch'],
  ] as const)('to %s comes back in recovery: %s', async (ssid, password, open, failure) => {
    reach('first-boot');
    await setWifi({ ssid, password, open_network: open, admin_key: MOCK_ADMIN_KEY });
    await expect(getStatus()).rejects.toThrow(TypeError);
    const back = await readStatus(4);
    expect(back).toMatchObject({
      mode: 'recovery',
      auth_required: true,
      wifi: { ssid, join_failure: failure, ap_ip: '192.168.71.1' },
    });
  });

  it('from recovery to a network in range leaves for good', async () => {
    reach('recovery');
    unlockSettings(MOCK_ADMIN_KEY, false);
    await setWifi({ ssid: 'home', password: 'correct horse' });
    expect(await readStatus(10)).toBeNull();
  });
});

describe('a Wi-Fi change from the home network', () => {
  it('to a new password for the same network answers here after the restart', async () => {
    reach('steady');
    unlockSettings(MOCK_ADMIN_KEY, false);
    const before = await getStatus();
    await setWifi({ ssid: before.wifi.ssid, password: 'correct horse' });
    const after = await getStatus();
    expect(after.mode).toBe('provisioned');
    expect(after.system.uptime_seconds).toBeLessThan(before.system.uptime_seconds);
  });

  it('to another network leaves this browser for good', async () => {
    reach('steady');
    unlockSettings(MOCK_ADMIN_KEY, false);
    await setWifi({ ssid: 'Cafe guest', open_network: true });
    expect(await readStatus(10)).toBeNull();
  });
});

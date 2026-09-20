import { getResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetAdminKey, unlockSettings } from '../src/lib/adminKey';
import { getStatus, setStream, setTransport, setWifi } from '../src/lib/api';
import { FakeDevice, MOCK_ADMIN_KEY } from '../src/mocks/device';

describe('mock audio transport', () => {
  beforeEach(() => {
    const device = new FakeDevice('first-boot');
    setTransport(async (request) => {
      const response = await getResponse(device.handlers, request, {
        baseUrl: window.location.origin,
      });
      if (!response) throw new Error(`No mock handler for ${request.url}`);
      return response;
    });
    unlockSettings(MOCK_ADMIN_KEY, false);
  });

  afterEach(() => {
    forgetAdminKey();
    setTransport((request) => fetch(request));
  });

  it('streams a quiet commissioned input until transmission is paused', async () => {
    await setWifi({
      ssid: 'Example network',
      password: 'example-password',
      admin_key: MOCK_ADMIN_KEY,
      target_host: '192.0.2.20',
      target_port: 39000,
    });
    const before = await getStatus();
    const flowing = await getStatus();
    expect(flowing.metrics.playing).toBe(false);
    expect(flowing.metrics.packets_total).toBeGreaterThan(before.metrics.packets_total);
    expect(flowing.metrics.bytes_total).toBeGreaterThan(before.metrics.bytes_total);

    await setStream({ enabled: false });
    const paused = await getStatus();
    const stillPaused = await getStatus();
    expect(stillPaused.metrics.packets_total).toBe(paused.metrics.packets_total);
    expect(stillPaused.metrics.sequence).toBeGreaterThan(paused.metrics.sequence);
  });

  it('does not transmit during setup or without a bridge target', async () => {
    const setup = await getStatus();
    expect((await getStatus()).metrics.packets_total).toBe(setup.metrics.packets_total);
    await setWifi({ ssid: 'Example network', admin_key: MOCK_ADMIN_KEY });
    const untargeted = await getStatus();
    expect(untargeted.mode).toBe('provisioned');
    expect((await getStatus()).metrics.packets_total).toBe(untargeted.metrics.packets_total);
  });
});

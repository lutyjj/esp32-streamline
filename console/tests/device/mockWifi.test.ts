import { getResponse } from 'msw';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { setTransport } from '../../src/device/lib/http';
import { FakeDevice, MOCK_ADMIN_KEY } from '../../src/device/mocks/device';
import { setWifi } from '../../src/generated/api';

// The fake device refuses the Wi-Fi writes the firmware refuses, by the same error.
beforeEach(() => {
  const device = new FakeDevice('first-boot');
  setTransport(async (request) => {
    const response = await getResponse(device.handlers, request, {
      baseUrl: window.location.origin,
    });
    if (!response) throw new Error(`No mock handler for ${request.url}`);
    return response;
  });
});

afterEach(() => {
  setTransport((request) => fetch(request));
});

it.each([
  [{ password: '' }, 'needs its password'],
  [{ password: 'correct horse', open_network: true }, 'has no password'],
  [{ password: 'short' }, '8 to 63 bytes'],
])('refuses %o with %s', async (credentials, error) => {
  await expect(
    setWifi({ ssid: 'Cafe', admin_key: MOCK_ADMIN_KEY, ...credentials }),
  ).rejects.toThrow(error);
});

import { getResponse } from 'msw';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { setTransport, setWifi } from '../src/lib/api';
import { FakeDevice, MOCK_ADMIN_KEY } from '../src/mocks/device';

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
  [{ password: '' }, 'MissingWifiPassword'],
  [{ password: 'correct horse', open_network: true }, 'PasswordForOpenNetwork'],
  [{ password: 'short' }, 'MalformedWifiPassword'],
])('refuses %o with %s', async (credentials, error) => {
  await expect(
    setWifi({ ssid: 'Cafe', admin_key: MOCK_ADMIN_KEY, ...credentials }),
  ).rejects.toThrow(error);
});

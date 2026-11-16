import { getResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  forgetAdminKey,
  isUnlocked,
  keyRemembered,
  storedAdminKey,
  unlockSettings,
} from '../../src/device/lib/adminKey';
import { setTransport, verifyAdminKey } from '../../src/device/lib/http';
import { FakeDevice, MOCK_ADMIN_KEY } from '../../src/device/mocks/device';
import { changeAdminKey } from '../../src/device/state/access';
import { refresh, status } from '../../src/device/state/device';
import {
  assignButton,
  assignLed,
  nameProblem,
  renameDevice,
} from '../../src/device/state/hardware';
import { queryClient, settingsQuery } from '../../src/device/state/queries';
import { answering } from './answering';

let device: FakeDevice;

beforeEach(async () => {
  device = new FakeDevice('steady');
  setTransport(async (request) => {
    const response = await getResponse(device.handlers, request, {
      baseUrl: window.location.origin,
    });
    if (!response) throw new Error(`No mock handler for ${request.url}`);
    return response;
  });
  unlockSettings(MOCK_ADMIN_KEY, true);
  queryClient.clear();
  await Promise.all([refresh(), queryClient.fetchQuery(settingsQuery)]);
});

afterEach(() => {
  forgetAdminKey();
  answering(null);
  setTransport((request) => fetch(request));
});

const settings = () => queryClient.getQueryData(settingsQuery.queryKey);

describe('hardware writes', () => {
  it('show what the device holds once a button or a light changes', async () => {
    await assignButton('key3', 'factory_reset');
    await assignLed('status', 'off');
    expect(settings()?.button_actions.find((entry) => entry.id === 'key3')?.action).toBe(
      'factory_reset',
    );
    expect(settings()?.led_roles).toEqual([{ id: 'status', role: 'off' }]);
  });

  it('carry a new name to the status the rail reads', async () => {
    await renameDevice('  Turntable  ');
    expect(status.value?.device_name).toBe('Turntable');
  });

  it('refuse a name past the contract limit before it is sent', () => {
    expect(nameProblem('x'.repeat(32))).toBeNull();
    expect(nameProblem('x'.repeat(33))).toBe('A name has at most 32 characters.');
  });
});

describe('replacing the admin key', () => {
  const next = 'b'.repeat(48);

  it('keeps this browser unlocked on the new key, remembered as the old one was', async () => {
    await expect(changeAdminKey(next)).resolves.toMatchObject({ ok: true });
    expect(storedAdminKey()).toBe(next);
    expect(keyRemembered()).toBe(true);
    expect(isUnlocked()).toBe(true);
    await expect(verifyAdminKey(MOCK_ADMIN_KEY)).resolves.toBe(false);
    await expect(verifyAdminKey(next)).resolves.toBe(true);
  });
});

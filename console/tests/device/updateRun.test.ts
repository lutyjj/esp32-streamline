import { getResponse } from 'msw';
import { afterEach, expect, it } from 'vitest';
import { forgetAdminKey, unlockSettings } from '../../src/device/lib/adminKey';
import { setTransport } from '../../src/device/lib/http';
import { FakeDevice, MOCK_ADMIN_KEY } from '../../src/device/mocks/device';
import { connection, refresh, restartSettled } from '../../src/device/state/device';
import { install, rollBack } from '../../src/device/state/ota';
import { answering } from './answering';

afterEach(() => {
  forgetAdminKey();
  answering(null);
  restartSettled.value = null;
  setTransport((request) => fetch(request));
});

it('hands the page to the image an install or a rollback boots', async () => {
  const device = new FakeDevice('steady');
  let reads = 0;
  setTransport(async (request) => {
    reads += 1;
    const response = await getResponse(device.handlers, request, {
      baseUrl: window.location.origin,
    });
    if (!response) throw new Error(`No mock handler for ${request.url}`);
    return response;
  });
  unlockSettings(MOCK_ADMIN_KEY, false);
  await refresh();

  await expect(install()).resolves.toBe(true);
  const phases = new Set<string>();
  for (let read = 0; read < 12 && connection.value.phase !== 'replaced'; read += 1) {
    await refresh();
    phases.add(connection.value.phase);
  }

  expect(phases).toContain('waiting');
  expect(connection.value.phase).toBe('replaced');
  expect(restartSettled.value).toBeNull();
  const sent = reads;
  await refresh();
  expect(reads).toBe(sent);

  // The page the installed image serves rolls back to the image before it.
  answering(null);
  await refresh();
  await expect(rollBack()).resolves.not.toBeNull();
  expect(connection.value).toMatchObject({ phase: 'waiting', operation: 'the rollback' });
  for (let read = 0; read < 6 && connection.value.phase !== 'replaced'; read += 1) await refresh();
  expect(connection.value.phase).toBe('replaced');
});

import { getResponse } from 'msw';
import { afterEach, expect, it } from 'vitest';
import { forgetAdminKey, unlockSettings } from '../../src/device/lib/adminKey';
import { setTransport } from '../../src/device/lib/http';
import { FakeDevice, MOCK_ADMIN_KEY } from '../../src/device/mocks/device';
import { UPDATE_OPERATION } from '../../src/device/state/connection';
import { connection, refresh, restartSettled } from '../../src/device/state/device';
import { install, updateNews } from '../../src/device/state/ota';
import { answering } from './answering';

afterEach(() => {
  forgetAdminKey();
  answering(null);
  restartSettled.value = null;
  setTransport((request) => fetch(request));
});

it('follows a release install through its restart to the version it reached', async () => {
  const device = new FakeDevice('steady');
  setTransport(async (request) => {
    const response = await getResponse(device.handlers, request, {
      baseUrl: window.location.origin,
    });
    if (!response) throw new Error(`No mock handler for ${request.url}`);
    return response;
  });
  unlockSettings(MOCK_ADMIN_KEY, false);
  await refresh();
  const before = connection.value.phase === 'live' ? connection.value.seen.status : null;

  await expect(install()).resolves.toBe(true);
  const phases = new Set<string>();
  for (let read = 0; read < 12 && !restartSettled.value; read += 1) {
    await refresh();
    phases.add(connection.value.phase);
  }

  expect(phases).toContain('waiting');
  const settled = restartSettled.value;
  expect(settled?.operation).toBe(UPDATE_OPERATION);
  expect(settled && updateNews(settled).text).toBe(
    `Updated to ${settled?.after.firmware_version}.`,
  );
  expect(settled?.after.firmware_version).not.toBe(before?.firmware_version);
});

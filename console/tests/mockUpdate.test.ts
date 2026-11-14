import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { forgetAdminKey, unlockSettings } from '../src/lib/adminKey';
import { getStatus, otaUpdate, restart, setName, setTransport } from '../src/lib/api';
import { deviceFetch } from '../src/lib/http';
import { FakeDevice, MOCK_ADMIN_KEY } from '../src/mocks/device';

/** The operations the device contract marks as refused while an update is busy. */
function restartingOperations(): string[] {
  // vitest runs with the console package as its working directory.
  const api = JSON.parse(readFileSync(resolve('..', 'docs', 'openapi.json'), 'utf8')) as {
    paths: Record<string, { post?: Record<string, unknown> }>;
  };
  return Object.entries(api.paths)
    .filter(([, operations]) => operations.post?.['x-restarting'] === true)
    .map(([path]) => path);
}

describe('mock firmware update', () => {
  beforeEach(() => {
    const device = new FakeDevice();
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

  it('refuses every restarting operation with 409 until the update finishes', async () => {
    const restarting = restartingOperations();
    expect(restarting).toEqual(expect.arrayContaining(['/api/restart', '/api/factory-reset']));

    await otaUpdate({ url: 'http://192.0.2.30/streamline-ota.bin', sha256: 'a'.repeat(64) });
    for (const path of restarting) {
      await expect(deviceFetch(path, { method: 'POST' }), path).rejects.toMatchObject({
        status: 409,
      });
    }
    // A write that cannot restart the device still lands, as on the device.
    await expect(setName({ name: 'Listening room' })).resolves.toMatchObject({ ok: true });

    // Each status poll plays out one update phase.
    await vi.waitFor(async () => expect((await getStatus()).ota.busy).toBe(false));
    await expect(restart()).resolves.toMatchObject({ rebooting: true });
  });
});

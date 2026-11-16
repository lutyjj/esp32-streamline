import { getResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { forgetAdminKey, unlockSettings } from '../../src/device/lib/adminKey';
import { setTransport } from '../../src/device/lib/http';
import { FakeDevice, MOCK_ADMIN_KEY } from '../../src/device/mocks/device';
import { coredumpImage, coredumpQuery, eraseCoredump } from '../../src/device/state/coredump';
import { connection, refresh, status } from '../../src/device/state/device';
import { resetToSetup } from '../../src/device/state/handoff';
import {
  checkForUpdate,
  imageDigestProblem,
  imageUrlProblem,
  scheduleUpdates,
} from '../../src/device/state/ota';
import { queryClient, settingsQuery } from '../../src/device/state/queries';
import { answering } from './answering';

beforeEach(async () => {
  const device = new FakeDevice('steady');
  setTransport(async (request) => {
    const response = await getResponse(device.handlers, request, {
      baseUrl: window.location.origin,
    });
    if (!response) throw new Error(`No mock handler for ${request.url}`);
    return response;
  });
  unlockSettings(MOCK_ADMIN_KEY, false);
  queryClient.clear();
  await refresh();
});

afterEach(() => {
  forgetAdminKey();
  answering(null);
  setTransport((request) => fetch(request));
});

describe('updates', () => {
  it('follow a check to the release it found', async () => {
    await expect(checkForUpdate()).resolves.toBe(true);
    await refresh();
    expect(status.value?.ota.phase).toBe('checking');
    await refresh();
    expect(status.value?.ota).toMatchObject({ phase: 'update-available', busy: false });
  });

  it('show the schedule the device holds once it changes', async () => {
    await queryClient.query(settingsQuery);
    await scheduleUpdates('weekly');
    expect(queryClient.getQueryData(settingsQuery.queryKey)?.auto_update_schedule).toBe('weekly');
  });

  it('refuse a custom image the contract refuses, before it is sent', () => {
    expect(imageUrlProblem('http://192.0.2.5:8000/streamline-dev-ota.bin')).toBeNull();
    expect(imageUrlProblem('http://user@192.0.2.5/image.bin')).not.toBeNull();
    expect(imageUrlProblem('http://192.0.2.5/image.bin#top')).not.toBeNull();
    expect(imageDigestProblem('A'.repeat(64))).toBeNull();
    expect(imageDigestProblem('a'.repeat(63))).not.toBeNull();
  });
});

describe('the crash dump', () => {
  it('downloads as the bytes the device stored', async () => {
    const image = await coredumpImage();
    expect(image).toBeInstanceOf(Blob);
    const bytes = new Uint8Array(await (image as Blob).arrayBuffer());
    expect(bytes.length).toBe(23_972);
    expect([...bytes.slice(0, 4)]).toEqual([0x7f, 0x45, 0x4c, 0x46]);
  });

  it('reads as gone once erased', async () => {
    await expect(queryClient.query(coredumpQuery)).resolves.toMatchObject({ present: true });
    await eraseCoredump();
    expect(queryClient.getQueryData(coredumpQuery.queryKey)).toEqual({
      present: false,
      size_bytes: 0,
    });
  });
});

it('a factory reset hands off with the setup network the device named', async () => {
  await expect(resetToSetup()).resolves.toBe(true);
  const now = connection.value;
  expect(
    now.phase === 'handoff' && now.handoff.kind === 'reset' && now.handoff.setupNetwork,
  ).toEqual(expect.objectContaining({ ssid: expect.any(String), password: expect.any(String) }));
});

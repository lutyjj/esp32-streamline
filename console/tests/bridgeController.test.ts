import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type BridgeApi, BridgeController } from '../src/bridge/controller';
import type {
  BridgeStatus,
  DownloadTicket,
  RecordingCapabilities,
  RecordingList,
} from '../src/generated/bridge';

const capabilities: RecordingCapabilities = {
  enabled: true,
  format: {
    container: 'wav',
    codec: 'pcm_s16le',
    sample_rate: 48000,
    channels: 2,
    bits_per_sample: 16,
    bytes_per_second: 192000,
  },
  limits: {
    max_duration_seconds: 14400,
    max_gap_seconds: 300,
    min_free_bytes: 1,
    queue_chunks: 4,
    max_title_chars: 80,
  },
};

const emptyRecordings: RecordingList = { active: [], saved: [], storage: { free_bytes: 1000 } };
const status: BridgeStatus = {
  bridge_version: 'test',
  api_token_configured: true,
  sources: {},
  transport: {
    contract_version: 1,
    mode: 'tls-psk',
    configurable: true,
    port: 39000,
    key_ids: [],
    auth_successes: 0,
    auth_failures: 0,
  },
};

function fakeApi(overrides: Partial<BridgeApi> = {}): BridgeApi {
  return {
    status: vi.fn(async () => status),
    capabilities: vi.fn(async () => capabilities),
    recordings: vi.fn(async () => emptyRecordings),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    ticket: vi.fn(async (): Promise<DownloadTicket> => ({ url: '/file', expires_in_seconds: 60 })),
    unlock: vi.fn(async () => undefined),
    setTransportMode: vi.fn(async () => undefined),
    putTransportKey: vi.fn(async () => undefined),
    deleteTransportKey: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('bridge controller', () => {
  beforeEach(() => sessionStorage.clear());

  it('polls source status continuously but leaves idle recordings stable', async () => {
    const api = fakeApi();
    const scheduled: Array<() => void> = [];
    const controller = new BridgeController(api, (callback) => {
      scheduled.push(callback);
      return scheduled.length;
    });

    await controller.pollStatus();
    await controller.loadCapabilities();
    await controller.unlock('bridge-api-token');

    expect(controller.status.value).toEqual(status);
    expect(api.recordings).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveLength(1);
    scheduled[0]();
    await vi.waitFor(() => expect(api.status).toHaveBeenCalledTimes(2));
    expect(api.recordings).toHaveBeenCalledTimes(1);
  });

  it('polls recordings only while an active session exists', async () => {
    const active = {
      ...emptyRecordings,
      active: [{ id: 'one' } as RecordingList['active'][number]],
    };
    const api = fakeApi({ recordings: vi.fn(async () => active) });
    const scheduled: Array<() => void> = [];
    const controller = new BridgeController(api, (callback) => {
      scheduled.push(callback);
      return scheduled.length;
    });

    await controller.loadCapabilities();
    await controller.unlock('bridge-api-token');

    expect(scheduled).toHaveLength(1);
    scheduled[0]();
    await vi.waitFor(() => expect(api.recordings).toHaveBeenCalledTimes(2));
  });

  it('keeps polling an active recording after a transient list failure', async () => {
    const active = {
      ...emptyRecordings,
      active: [{ id: 'one' } as RecordingList['active'][number]],
    };
    const recordings = vi
      .fn<BridgeApi['recordings']>()
      .mockResolvedValueOnce(active)
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue(emptyRecordings);
    const scheduled: Array<() => void> = [];
    const controller = new BridgeController(fakeApi({ recordings }), (callback) => {
      scheduled.push(callback);
      return scheduled.length;
    });

    await controller.loadCapabilities();
    await controller.unlock('bridge-api-token');
    scheduled.shift()?.();
    await vi.waitFor(() => expect(recordings).toHaveBeenCalledTimes(2));

    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    await vi.waitFor(() => expect(recordings).toHaveBeenCalledTimes(3));
    expect(scheduled).toHaveLength(0);
  });

  it('unlocks the whole console only after the bridge accepts the token', async () => {
    const controller = new BridgeController(fakeApi());

    await controller.pollStatus();
    expect(controller.access.value).toBe('locked');

    await controller.unlock('secret');
    expect(sessionStorage.getItem('streamline.bridgeToken')).toBe('secret');
    expect(controller.access.value).toBe('unlocked');

    controller.lock();
    expect(sessionStorage.getItem('streamline.bridgeToken')).toBeNull();
    expect(controller.access.value).toBe('locked');
  });

  it('forgets a rejected token and remains locked', async () => {
    const api = fakeApi({
      unlock: vi.fn(async () => Promise.reject(new Error('unauthorized'))),
    });
    const controller = new BridgeController(api);

    await expect(controller.unlock('wrong')).rejects.toThrow('unauthorized');

    expect(sessionStorage.getItem('streamline.bridgeToken')).toBeNull();
    expect(controller.access.value).toBe('locked');
    expect(controller.error.value).toBe('unauthorized');
  });

  it('reports a deployment without a token instead of offering an unlock', async () => {
    const unconfigured = { ...status, api_token_configured: false };
    const controller = new BridgeController(fakeApi({ status: vi.fn(async () => unconfigured) }));

    await controller.pollStatus();

    expect(controller.access.value).toBe('no-token');
  });

  it('resumes an unlocked session from a token the tab already holds', async () => {
    const api = fakeApi();
    const controller = new BridgeController(
      api,
      () => 0,
      () => undefined,
      () => 'held-token',
    );

    controller.start();
    await vi.waitFor(() => expect(controller.access.value).toBe('unlocked'));
    expect(api.unlock).toHaveBeenCalledTimes(1);
  });

  it('switches the listener mode and reports a failure without unlocking state loss', async () => {
    const setTransportMode = vi
      .fn<BridgeApi['setTransportMode']>()
      .mockRejectedValueOnce(new Error('transport-unavailable'))
      .mockResolvedValueOnce(undefined);
    const api = fakeApi({ setTransportMode });
    const controller = new BridgeController(api);
    await controller.unlock('bridge-api-token');

    await expect(controller.setEncryption(true)).resolves.toBe(false);
    expect(controller.error.value).toBe('transport-unavailable');
    expect(controller.access.value).toBe('unlocked');

    await expect(controller.setEncryption(true)).resolves.toBe(true);
    expect(setTransportMode).toHaveBeenLastCalledWith('tls-psk');
  });

  it('reports recording action failures without rejecting into the view', async () => {
    const api = fakeApi({ start: vi.fn(async () => Promise.reject(new Error('storage full'))) });
    const controller = new BridgeController(api);

    const succeeded = await controller.startRecording({ source: '192.0.2.10', title: 'Album' });

    expect(succeeded).toBe(false);
    expect(controller.error.value).toBe('storage full');
    expect(api.recordings).not.toHaveBeenCalled();
  });

  it('keeps the console unlocked after a rejected key so provisioning can be retried', async () => {
    const putTransportKey = vi
      .fn<BridgeApi['putTransportKey']>()
      .mockRejectedValueOnce(new Error('transport-key-rejected'))
      .mockResolvedValueOnce(undefined);
    const controller = new BridgeController(fakeApi({ putTransportKey }));
    await controller.unlock('bridge-api-token');

    await expect(
      controller.provisionTransportKey('eli1-a'.padEnd(37, 'a'), '01'.repeat(32)),
    ).resolves.toBe(false);
    expect(controller.access.value).toBe('unlocked');
    expect(controller.error.value).toBe('transport-key-rejected');
    await expect(
      controller.provisionTransportKey('eli1-a'.padEnd(37, 'a'), '01'.repeat(32)),
    ).resolves.toBe(true);
  });
});

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
const status: BridgeStatus = { bridge_version: 'test', sources: {} };

function fakeApi(overrides: Partial<BridgeApi> = {}): BridgeApi {
  return {
    status: vi.fn(async () => status),
    capabilities: vi.fn(async () => capabilities),
    recordings: vi.fn(async () => emptyRecordings),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    ticket: vi.fn(async (): Promise<DownloadTicket> => ({ url: '/file', expires_in_seconds: 60 })),
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
    await controller.unlock('recording-token');

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

    await controller.unlock('recording-token');

    expect(scheduled).toHaveLength(1);
    scheduled[0]();
    await vi.waitFor(() => expect(api.recordings).toHaveBeenCalledTimes(2));
  });

  it('forgets a rejected token and remains locked', async () => {
    const api = fakeApi({
      recordings: vi.fn(async () => Promise.reject(new Error('unauthorized'))),
    });
    const controller = new BridgeController(api);

    await expect(controller.unlock('wrong')).rejects.toThrow('unauthorized');

    expect(sessionStorage.getItem('streamline.recordingToken')).toBeNull();
    expect(controller.recordingState.value).toBe('locked');
  });

  it('reports recording action failures without rejecting into the view', async () => {
    const api = fakeApi({ start: vi.fn(async () => Promise.reject(new Error('storage full'))) });
    const controller = new BridgeController(api);

    const succeeded = await controller.startRecording({ source: '192.0.2.10', title: 'Album' });

    expect(succeeded).toBe(false);
    expect(controller.error.value).toBe('storage full');
    expect(api.recordings).not.toHaveBeenCalled();
  });
});

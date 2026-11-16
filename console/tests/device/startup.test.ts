import { QueryObserver } from '@tanstack/preact-query';
import { getResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTransport } from '../../src/device/lib/http';
import { FakeDevice } from '../../src/device/mocks/device';
import { deviceStatus } from '../../src/device/mocks/fixtures';
import { report, startPolling } from '../../src/device/state/device';
import { audioProfilesQuery, queryClient, settingsQuery } from '../../src/device/state/queries';
import { answering } from './answering';

/**
 * A device that keeps two connections: a request that arrives while two are
 * open is reset, as the firmware's server does when a browser opens more.
 * `resets` names paths whose first read is reset regardless.
 */
function keepsTwoConnections(resets: string[] = []): { peak: () => number; answered: string[] } {
  const device = new FakeDevice('steady');
  const pending = new Set(resets);
  const answered: string[] = [];
  let open = 0;
  let peak = 0;
  setTransport(async (request) => {
    const path = new URL(request.url).pathname;
    if (open >= 2 || pending.delete(path)) throw new TypeError('connection reset');
    open += 1;
    peak = Math.max(peak, open);
    answered.push(path);
    try {
      await new Promise((done) => setTimeout(done, 5));
      const response = await getResponse(device.handlers, request, {
        baseUrl: window.location.origin,
      });
      if (!response) throw new Error(`No mock handler for ${request.url}`);
      return response;
    } finally {
      open -= 1;
    }
  });
  return { peak: () => peak, answered };
}

const loaded = (query: { queryKey: readonly unknown[] }) =>
  queryClient.getQueryState(query.queryKey)?.status;

// A fresh page: nothing has loaded yet.
beforeEach(() => {
  queryClient.clear();
});

afterEach(() => {
  answering(null);
  setTransport((request) => fetch(request));
});

describe('opening the console', () => {
  it('reads everything it starts with without opening more connections than the device keeps', async () => {
    const device = keepsTwoConnections();
    (await startPolling())();
    expect(device.answered).toEqual(['/api/status', '/api/settings', '/api/audio-profiles']);
    expect(device.peak()).toBeLessThanOrEqual(2);
    expect(loaded(settingsQuery)).toBe('success');
    expect(loaded(audioProfilesQuery)).toBe('success');
  });

  it('reads a reset startup read again', async () => {
    const device = keepsTwoConnections(['/api/settings']);
    (await startPolling())();
    expect(device.answered).toContain('/api/settings');
    expect(loaded(settingsQuery)).toBe('success');
  });

  it('reads shown settings again after a restart, and again if that read is reset', async () => {
    // A screen that shows the settings, as Device or Bridge does.
    const shown = new QueryObserver(queryClient, settingsQuery).subscribe(() => undefined);
    const device = keepsTwoConnections(['/api/settings']);
    const inBoot = (boot: number) => {
      const s = deviceStatus();
      return { ...s, system: { ...s.system, boot } };
    };
    report({ type: 'answered', status: inBoot(1), at: 0 });
    report({ type: 'restarting', operation: 'the board', at: 1000 });
    report({ type: 'answered', status: inBoot(2), at: 9000 });
    // The reset read is read again after the pause between reads.
    await vi.waitFor(
      () => expect(device.answered.filter((path) => path === '/api/settings')).toHaveLength(1),
      { timeout: 3000 },
    );
    await vi.waitFor(() => expect(loaded(settingsQuery)).toBe('success'));
    shown();
  });
});

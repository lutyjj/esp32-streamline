import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setTransport } from '../../src/device/lib/http';
import { deviceStatus } from '../../src/device/mocks/fixtures';
import { audioActivity } from '../../src/device/state/activity';
import {
  audioMoving,
  connection,
  deliveryObserved,
  refresh,
  STATUS_TIMEOUT_MS,
} from '../../src/device/state/device';
import { answering } from './answering';

describe('audioActivity', () => {
  beforeEach(() => {
    answering(null);
    audioMoving.value = false;
    deliveryObserved.value = true;
  });
  afterEach(() => setTransport((request) => fetch(request)));

  it('reports an unavailable device even when the first poll fails', async () => {
    setTransport(async () => {
      throw new TypeError('offline');
    });
    await refresh();
    expect(connection.value.phase).toBe('lost');
    expect(audioActivity.value).toBe('unavailable');
  });

  it('turns a status read that never answers into an unavailable device', async () => {
    // A connection the network drops silently: no response, no error, until aborted.
    setTransport(
      (request) =>
        new Promise((_, reject) =>
          request.signal.addEventListener('abort', () => reject(request.signal.reason)),
        ),
    );
    // The test owns the clock: the platform deadline runs on fake timers.
    vi.useFakeTimers();
    const deadline = vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('timed out', 'TimeoutError')), ms);
      return controller.signal;
    });
    try {
      const poll = refresh();
      await vi.advanceTimersByTimeAsync(STATUS_TIMEOUT_MS - 1);
      expect(connection.value.phase).toBe('opening');
      await vi.advanceTimersByTimeAsync(1);
      await poll;
      expect(deadline).toHaveBeenCalledWith(STATUS_TIMEOUT_MS);
    } finally {
      deadline.mockRestore();
      vi.useRealTimers();
    }
    expect(connection.value.phase).toBe('lost');
  });

  it('keeps sending through a restart quicker than a poll, from the new boot’s count', async () => {
    let bytes = 10240;
    let boot = 1;
    setTransport(
      async () =>
        new Response(
          JSON.stringify(deviceStatus({ metrics: { bytes_total: bytes }, system: { boot } })),
        ),
    );
    await refresh();
    bytes += 1024;
    await refresh();
    expect(audioMoving.value).toBe(true);
    // The device restarted between two polls; the new boot counts again from zero.
    boot = 2;
    bytes = 2048;
    await refresh();
    expect(audioMoving.value).toBe(true);
    bytes = 0;
    await refresh();
    expect(audioMoving.value).toBe(false);
  });

  it('clears live transmission evidence on failure and establishes a new baseline after recovery', async () => {
    let bytes = 10240;
    setTransport(
      async () => new Response(JSON.stringify(deviceStatus({ metrics: { bytes_total: bytes++ } }))),
    );
    await refresh();
    await refresh();
    expect(audioMoving.value).toBe(true);
    setTransport(async () => {
      throw new TypeError('offline');
    });
    await refresh();
    expect(audioMoving.value).toBe(false);
    expect(audioActivity.value).toBe('unavailable');
    setTransport(
      async () => new Response(JSON.stringify(deviceStatus({ metrics: { bytes_total: 99999 } }))),
    );
    await refresh();
    expect(connection.value.phase).toBe('live');
    expect(audioMoving.value).toBe(false);
  });

  it('claims nothing before the first status', () => {
    expect(audioActivity.value).toBe('opening');
  });

  it('reads setup while the device runs its own network', () => {
    answering(deviceStatus({ mode: 'setup' }));
    expect(audioActivity.value).toBe('setup');
  });

  it('reads a fault while a startup check blocks, before any delivery state', () => {
    answering(
      deviceStatus({
        metrics: { playing: true },
        health: {
          status: 'blocking',
          checks: [
            {
              id: 'codec',
              severity: 'blocking',
              status: 'fail',
              detail: 'The codec did not answer.',
              fixable: false,
            },
          ],
        },
      }),
    );
    audioMoving.value = true;
    expect(audioActivity.value).toBe('fault');
  });

  it('reads no bridge when provisioned without a target, paused or not', () => {
    answering(deviceStatus({ target: { target_host: '' }, stream: { enabled: false } }));
    expect(audioActivity.value).toBe('no-bridge');
  });

  it('reads paused while transmission is paused, even when audio plays', () => {
    answering(deviceStatus({ metrics: { playing: true }, stream: { enabled: false } }));
    audioMoving.value = true;
    expect(audioActivity.value).toBe('paused');
  });

  it('reads quiet when a target is set but the input is silent', () => {
    answering(deviceStatus({ metrics: { playing: false } }));
    expect(audioActivity.value).toBe('quiet');
  });

  it('reads connecting when audio plays before any packet moves', () => {
    answering(deviceStatus({ metrics: { playing: true } }));
    expect(audioActivity.value).toBe('connecting');
  });

  it('reads sending once PCM bytes move between polls', () => {
    answering(deviceStatus({ metrics: { playing: true } }));
    audioMoving.value = true;
    expect(audioActivity.value).toBe('sending');
  });

  it('claims no connection attempt before a second answer can show bytes moving', () => {
    answering(deviceStatus({ metrics: { playing: true } }));
    deliveryObserved.value = false;
    expect(audioActivity.value).toBe('checking');
  });
});

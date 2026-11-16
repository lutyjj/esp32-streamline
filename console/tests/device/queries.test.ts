import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTransport } from '../../src/device/lib/http';
import { settingsQuery } from '../../src/device/state/queries';
import { queryClient } from '../../src/shared/queries';

afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
  setTransport((request) => fetch(request));
});

describe('device reads', () => {
  it('fail once the device leaves a read unanswered past its bound, without asking again', async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(1));
    const sent = vi.fn();
    setTransport((request) => {
      sent();
      return new Promise((_, reject) =>
        request.signal.addEventListener('abort', () => reject(request.signal.reason)),
      );
    });

    await expect(queryClient.query(settingsQuery)).rejects.toThrow(
      'the device did not answer in time',
    );
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('read again a read whose connection the device dropped', async () => {
    let reads = 0;
    setTransport(async () => {
      reads += 1;
      if (reads === 1) throw new TypeError('connection reset');
      return Response.json({ ssid: 'home' });
    });

    await expect(queryClient.query(settingsQuery)).resolves.toMatchObject({ ssid: 'home' });
    expect(reads).toBe(2);
  });
});

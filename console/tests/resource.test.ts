import { describe, expect, it, vi } from 'vitest';
import { resource } from '../src/lib/resource';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('resource', () => {
  it('reports error with a retry that recovers', async () => {
    const fetch = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce('value');
    const r = resource('thing', fetch);

    await r.load();
    expect(r.state.value).toBe('error');
    expect(r.error.value).toContain('down');
    expect(r.data.value).toBeNull();

    await r.load();
    expect(r.state.value).toBe('ready');
    expect(r.data.value).toBe('value');
    expect(r.error.value).toBe('');
  });

  it('keeps a loaded snapshot usable through a failed refresh', async () => {
    const fetch = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce('first')
      .mockRejectedValueOnce(new Error('flaky'));
    const r = resource('thing', fetch);

    await r.load();
    await r.load();
    // The device's last known truth beats an empty error screen.
    expect(r.state.value).toBe('ready');
    expect(r.data.value).toBe('first');
    expect(r.error.value).toContain('flaky');
  });

  it('awaits a fresh snapshot when reloads arrive during an older read', async () => {
    const stale = deferred<string>();
    const fresh = deferred<string>();
    const fetch = vi.fn().mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise);
    const r = resource('thing', fetch);

    const first = r.load();
    await Promise.resolve();
    let reloaded = false;
    const second = r.load().then(() => {
      reloaded = true;
    });
    const third = r.load();
    await Promise.resolve();
    expect(reloaded).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);

    stale.resolve('before write');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(reloaded).toBe(false);
    fresh.resolve('after write');
    await Promise.all([first, second, third]);
    expect(r.data.value).toBe('after write');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('honors a queued reload even when the older read fails', async () => {
    const stale = deferred<string>();
    const fetch = vi.fn().mockReturnValueOnce(stale.promise).mockResolvedValueOnce('fresh');
    const r = resource('thing', fetch);
    const first = r.load();
    await Promise.resolve();
    const second = r.load();
    stale.reject(new Error('down'));
    await Promise.all([first, second]);
    expect(r.data.value).toBe('fresh');
    expect(r.state.value).toBe('ready');
    expect(r.error.value).toBe('');
  });

  it('allows retry after a fetch throws before returning a promise', async () => {
    const fetch = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(() => {
        throw new Error('request setup failed');
      })
      .mockResolvedValueOnce('recovered');
    const r = resource('thing', fetch);
    await r.load();
    expect(r.state.value).toBe('error');
    await r.load();
    expect(r.data.value).toBe('recovered');
    expect(r.error.value).toBe('');
  });
});

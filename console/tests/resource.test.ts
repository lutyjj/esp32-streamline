import { describe, expect, it, vi } from 'vitest';
import { resource } from '../src/lib/resource';

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

  it('collapses overlapping loads into one request', async () => {
    let release: (value: string) => void = () => {};
    const fetch = vi.fn(() => new Promise<string>((res) => (release = res)));
    const r = resource('thing', fetch);

    const first = r.load();
    const second = r.load();
    release('value');
    await Promise.all([first, second]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(r.data.value).toBe('value');
  });
});

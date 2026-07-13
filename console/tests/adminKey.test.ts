import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  forgetAdminKey,
  isUnlocked,
  lockSettings,
  rememberAdminKey,
  replaceAdminKey,
  storedAdminKey,
  UNLOCK_WINDOW_MS,
  unlockSettings,
} from '../src/lib/adminKey';

afterEach(() => {
  forgetAdminKey();
  vi.useRealTimers();
});

describe('admin key custody', () => {
  it('remembers across sessions only when asked to', () => {
    rememberAdminKey('key-a', false);
    expect(sessionStorage.getItem('streamline_admin_key')).toBe('key-a');
    expect(localStorage.getItem('streamline_admin_key')).toBeNull();

    rememberAdminKey('key-b', true);
    expect(localStorage.getItem('streamline_admin_key')).toBe('key-b');
  });

  it('falls back to the legacy token slot', () => {
    localStorage.setItem('streamline_token', 'legacy');
    expect(storedAdminKey()).toBe('legacy');
  });

  it('forgetting clears every slot and the unlock window', () => {
    unlockSettings('key', true);
    forgetAdminKey();
    expect(storedAdminKey()).toBe('');
    expect(isUnlocked()).toBe(false);
  });
});

describe('unlock window', () => {
  it('opens for fifteen minutes and then expires', () => {
    vi.useFakeTimers();
    unlockSettings('key', false);
    expect(isUnlocked()).toBe(true);

    vi.advanceTimersByTime(UNLOCK_WINDOW_MS - 1000);
    expect(isUnlocked()).toBe(true);

    vi.advanceTimersByTime(2000);
    expect(isUnlocked()).toBe(false);
  });

  it('locking closes the window but keeps the key', () => {
    unlockSettings('key', false);
    lockSettings();
    expect(isUnlocked()).toBe(false);
    expect(storedAdminKey()).toBe('key');
  });

  it('a stored key alone does not unlock anything', () => {
    rememberAdminKey('key', true);
    expect(isUnlocked()).toBe(false);
  });
});

// Stage 6: replacing the admin key must not lock the owner out. The new secret
// takes effect at once, so this browser re-opens its window on it — but only
// after the device confirms the write.
describe('replaceAdminKey', () => {
  it('writes the new key and re-unlocks this browser on it', async () => {
    unlockSettings('old', true);
    const seen: string[] = [];
    const ack = await replaceAdminKey(
      (secret) => {
        seen.push(secret);
        return Promise.resolve({ rebooting: false });
      },
      'new',
      true,
    );
    expect(ack).toEqual({ rebooting: false });
    expect(seen).toEqual(['new']);
    expect(storedAdminKey()).toBe('new');
    expect(isUnlocked()).toBe(true);
  });

  it('refuses to write when the settings window is closed', async () => {
    rememberAdminKey('old', true); // stored but not unlocked
    let wrote = false;
    await expect(
      replaceAdminKey(
        () => {
          wrote = true;
          return Promise.resolve({ rebooting: false });
        },
        'new',
        true,
      ),
    ).rejects.toThrow(/unlock settings/);
    expect(wrote).toBe(false);
    expect(storedAdminKey()).toBe('old');
  });

  it('leaves custody on the old key when the device rejects the write', async () => {
    unlockSettings('old', true);
    await expect(
      replaceAdminKey(() => Promise.reject(new Error('device rejected')), 'new', true),
    ).rejects.toThrow(/device rejected/);
    expect(storedAdminKey()).toBe('old');
  });
});

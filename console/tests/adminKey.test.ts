import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  forgetAdminKey,
  isUnlocked,
  lockSettings,
  rememberAdminKey,
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

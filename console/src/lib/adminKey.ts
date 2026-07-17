/**
 * Admin-key custody and the unlock window.
 *
 * The key lives in sessionStorage for the tab and optionally in localStorage
 * across restarts ("remember on this browser"). Unlocking opens a 15-minute
 * window during which mutating requests carry the key.
 */

import { signal } from '@preact/signals';
import type { Ack } from './api';
import { localStore, sessionStore } from './custody';

const ADMIN_KEY_STORAGE = 'streamline_admin_key';
const LEGACY_TOKEN_STORAGE = 'streamline_token';
const UNLOCK_UNTIL_STORAGE = 'streamline_unlock_until';
export const UNLOCK_WINDOW_MS = 15 * 60 * 1000;

/** Bumped on every custody change so components re-read storage. */
const authEpoch = signal(0);

function touch(): void {
  authEpoch.value += 1;
}

/** Subscribe a component to custody changes; returns the current epoch. */
export function useAuthEpoch(): number {
  return authEpoch.value;
}

export function storedAdminKey(): string {
  return (
    sessionStore.get(ADMIN_KEY_STORAGE) ||
    localStore.get(ADMIN_KEY_STORAGE) ||
    localStore.get(LEGACY_TOKEN_STORAGE) ||
    ''
  );
}

/** Returns true when the key reached the storage the caller asked for. */
export function rememberAdminKey(key: string, remember: boolean): boolean {
  const tabHeld = sessionStore.set(ADMIN_KEY_STORAGE, key);
  let persisted = tabHeld;
  if (remember) {
    persisted = localStore.set(ADMIN_KEY_STORAGE, key);
  } else {
    localStore.remove(ADMIN_KEY_STORAGE);
    localStore.remove(LEGACY_TOKEN_STORAGE);
  }
  touch();
  return persisted;
}

export function keyRemembered(): boolean {
  return Boolean(localStore.get(ADMIN_KEY_STORAGE));
}

export function unlockUntil(): number {
  return Number(sessionStore.get(UNLOCK_UNTIL_STORAGE) || '0');
}

export function isUnlocked(): boolean {
  return Boolean(storedAdminKey()) && unlockUntil() > Date.now();
}

/** Returns true when the key reached the storage the caller asked for. */
export function unlockSettings(key: string, remember: boolean): boolean {
  const persisted = rememberAdminKey(key, remember);
  sessionStore.set(UNLOCK_UNTIL_STORAGE, String(Date.now() + UNLOCK_WINDOW_MS));
  touch();
  return persisted;
}

export function lockSettings(): void {
  sessionStore.remove(UNLOCK_UNTIL_STORAGE);
  touch();
}

export function forgetAdminKey(): void {
  sessionStore.remove(ADMIN_KEY_STORAGE);
  localStore.remove(ADMIN_KEY_STORAGE);
  localStore.remove(LEGACY_TOKEN_STORAGE);
  sessionStore.remove(UNLOCK_UNTIL_STORAGE);
  touch();
}

/**
 * Replace the admin key from an open settings window. The guard, the write, and
 * the re-unlock are one step: the new key takes effect immediately, so this
 * browser must re-open its window on the new secret or the owner locks
 * themselves out mid-session. A rejected write leaves custody untouched.
 */
export async function replaceAdminKey(
  write: (secret: string) => Promise<Ack>,
  next: string,
  remember: boolean,
): Promise<Ack> {
  if (!isUnlocked()) throw new Error('unlock settings before replacing the admin key');
  const ack = await write(next);
  unlockSettings(next, remember);
  return ack;
}

export function generateAdminKey(): string {
  if (!window.crypto?.getRandomValues) {
    throw new Error('secure random generation is unavailable in this browser');
  }
  const bytes = new Uint8Array(24);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

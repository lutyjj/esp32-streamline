/**
 * Admin-key custody and the unlock window.
 *
 * The key lives in sessionStorage for the tab and optionally in localStorage
 * across restarts ("remember on this browser"). Unlocking opens a 15-minute
 * window during which mutating requests carry the key.
 */

import { signal } from '@preact/signals';

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
    sessionStorage.getItem(ADMIN_KEY_STORAGE) ||
    localStorage.getItem(ADMIN_KEY_STORAGE) ||
    localStorage.getItem(LEGACY_TOKEN_STORAGE) ||
    ''
  );
}

export function rememberAdminKey(key: string, remember: boolean): void {
  sessionStorage.setItem(ADMIN_KEY_STORAGE, key);
  if (remember) {
    localStorage.setItem(ADMIN_KEY_STORAGE, key);
  } else {
    localStorage.removeItem(ADMIN_KEY_STORAGE);
    localStorage.removeItem(LEGACY_TOKEN_STORAGE);
  }
  touch();
}

export function keyRemembered(): boolean {
  return Boolean(localStorage.getItem(ADMIN_KEY_STORAGE));
}

export function unlockUntil(): number {
  return Number(sessionStorage.getItem(UNLOCK_UNTIL_STORAGE) || '0');
}

export function isUnlocked(): boolean {
  return Boolean(storedAdminKey()) && unlockUntil() > Date.now();
}

export function unlockSettings(key: string, remember: boolean): void {
  rememberAdminKey(key, remember);
  sessionStorage.setItem(UNLOCK_UNTIL_STORAGE, String(Date.now() + UNLOCK_WINDOW_MS));
  touch();
}

export function lockSettings(): void {
  sessionStorage.removeItem(UNLOCK_UNTIL_STORAGE);
  touch();
}

export function forgetAdminKey(): void {
  sessionStorage.removeItem(ADMIN_KEY_STORAGE);
  localStorage.removeItem(ADMIN_KEY_STORAGE);
  localStorage.removeItem(LEGACY_TOKEN_STORAGE);
  sessionStorage.removeItem(UNLOCK_UNTIL_STORAGE);
  touch();
}

export function generateAdminKey(): string {
  if (!window.crypto?.getRandomValues) {
    throw new Error('secure random generation is unavailable in this browser');
  }
  const bytes = new Uint8Array(24);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function copyText(value: string): Promise<void> {
  if (!value) return;
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }
  // The device serves plain HTTP, so the async clipboard API is unavailable
  // and the deprecated fallback is the only path that works.
  const scratch = document.createElement('textarea');
  scratch.value = value;
  scratch.setAttribute('readonly', '');
  scratch.style.position = 'fixed';
  scratch.style.opacity = '0';
  document.body.appendChild(scratch);
  scratch.select();
  document.execCommand('copy');
  scratch.remove();
}

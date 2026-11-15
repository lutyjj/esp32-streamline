/**
 * Failure-aware custody adapters for the browser boundaries the console
 * cannot trust: storage (private mode, quota, sandboxing can make any call
 * throw) and the clipboard (the fallback path can fail silently). Remote
 * outcomes must never look failed because local custody degraded, and a
 * value accepted for custody must stay readable for the life of the tab.
 */

import { signal } from '@preact/signals';

/** A key-value slot that never throws; tab memory backs a failing store. */
export interface CustodyStore {
  get(key: string): string | null;
  /** Returns true when the value reached durable browser storage. */
  set(key: string, value: string): boolean;
  remove(key: string): void;
}

/**
 * True once any write failed to reach durable browser storage: the key or
 * token lives only in this tab and vanishes with it. Surfaces render the
 * warning from here instead of threading outcomes through every flow.
 */
export const custodyDegraded = signal(false);

export function custodyStore(backing: () => Storage): CustodyStore {
  // Tab-memory mirror of every write, so reads survive a throwing backing
  // store and a value written under quota pressure stays available.
  const memory = new Map<string, string>();
  return {
    get(key) {
      if (memory.has(key)) return memory.get(key) ?? null;
      try {
        return backing().getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      memory.set(key, value);
      try {
        backing().setItem(key, value);
        return true;
      } catch {
        custodyDegraded.value = true;
        return false;
      }
    },
    remove(key) {
      memory.delete(key);
      try {
        backing().removeItem(key);
      } catch {
        // Removal from a store that cannot be read back loses nothing.
      }
    },
  };
}

export const sessionStore = custodyStore(() => sessionStorage);
export const localStore = custodyStore(() => localStorage);

/**
 * Copy to the clipboard or reject — never claim success silently. The device
 * serves plain HTTP, so the async clipboard API is often unavailable and the
 * deprecated selection fallback is the only path that works there.
 */
export async function copyText(value: string): Promise<void> {
  if (!value) return;
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const scratch = document.createElement('textarea');
  scratch.value = value;
  scratch.setAttribute('readonly', '');
  scratch.style.position = 'fixed';
  scratch.style.opacity = '0';
  document.body.appendChild(scratch);
  try {
    scratch.select();
    if (!document.execCommand('copy')) {
      throw new Error('copying is blocked here — select the value and copy it manually');
    }
  } finally {
    scratch.remove();
  }
}

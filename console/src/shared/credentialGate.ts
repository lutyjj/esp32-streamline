/**
 * Unlocking on demand: a write that finds the console locked asks here and
 * waits, the one credential dialog answers, and every write that asked
 * meanwhile shares that answer.
 */

import { signal } from '@preact/signals';
import { ApiError } from './http';

/** True while a credential is asked for. */
export const credentialAsked = signal(false);
/** Counts the questions, so each one starts with empty fields. */
export const credentialAsks = signal(0);

let answer: ((accepted: boolean) => void) | null = null;
let pending: Promise<boolean> | null = null;

/** Resolves true once a credential is accepted, false when the person declines. */
export function requestCredential(): Promise<boolean> {
  if (!pending) {
    pending = new Promise((resolve) => {
      answer = resolve;
    });
    credentialAsks.value += 1;
    credentialAsked.value = true;
  }
  return pending;
}

/** The dialog's answer to every waiting request. */
export function answerCredential(accepted: boolean): void {
  const resolve = answer;
  answer = null;
  pending = null;
  credentialAsked.value = false;
  resolve?.(accepted);
}

/** How a console holds its credential, for a write that needs it. */
export interface CredentialHold {
  /** The server takes writes only with the credential. */
  required(): boolean;
  /** This console holds a credential its writes may use now. */
  unlocked(): boolean;
  /** Stop using the held credential. */
  lock(): void;
}

/**
 * Run `write` with the credential, asking for it first when the console is
 * locked, and once more when the server refuses it. Resolves null when the
 * person declines to unlock.
 */
export async function withCredential<T>(
  hold: CredentialHold,
  write: () => Promise<T>,
): Promise<T | null> {
  if (hold.required() && !hold.unlocked() && !(await requestCredential())) return null;
  try {
    return await write();
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) throw error;
    // The credential changed, or the unlock ended while the write was on its way.
    hold.lock();
    if (!(await requestCredential())) return null;
    return write();
  }
}

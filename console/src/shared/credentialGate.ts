/**
 * Unlocking on demand: a write that finds the console locked asks here and
 * waits, the one credential dialog answers, and every write that asked
 * meanwhile shares that answer.
 */

import { signal } from '@preact/signals';

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

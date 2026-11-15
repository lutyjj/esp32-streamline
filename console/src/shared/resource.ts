/**
 * A failure-aware remote resource on signals: independent loading/ready/error
 * state, a named retry, and one rule — data that loaded once stays usable
 * while a refresh fails, but a resource that never loaded reports the error
 * instead of letting consumers render defaults.
 */

import { type Signal, signal } from '@preact/signals';
import { errorMessage } from './errors';

export type ResourceState = 'loading' | 'ready' | 'error';

export interface Resource<T> {
  /** Human name for retry affordances ("device settings"). */
  name: string;
  data: Signal<T | null>;
  state: Signal<ResourceState>;
  error: Signal<string>;
  /** Await fresh data; reloads during a read coalesce into a subsequent read. */
  load(): Promise<void>;
}

export function resource<T>(name: string, fetch: () => Promise<T>): Resource<T> {
  const data = signal<T | null>(null);
  const state = signal<ResourceState>('loading');
  const error = signal('');
  let inflight: Promise<void> | null = null;
  let requested = false;

  async function drain(): Promise<void> {
    try {
      while (requested) {
        requested = false;
        if (state.value === 'error') state.value = 'loading';
        try {
          data.value = await fetch();
          state.value = 'ready';
          error.value = '';
        } catch (cause) {
          error.value = errorMessage(cause);
          // Keep a loaded snapshot usable when a refresh fails.
          if (data.value === null) state.value = 'error';
        }
      }
    } finally {
      inflight = null;
    }
  }

  function load(): Promise<void> {
    requested = true;
    inflight ??= Promise.resolve().then(drain);
    return inflight;
  }

  return { name, data, state, error, load };
}

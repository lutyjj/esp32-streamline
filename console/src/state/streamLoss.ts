/**
 * Stream-loss policy: dropped audio is the one failure a listener always
 * notices, so any growth in the drop counters raises a critical callout. It
 * stays up until the stream has been clean long enough to call the episode
 * over, rather than flickering with each burst.
 */

import { computed, effect, signal } from '@preact/signals';
import { setupMode, status } from './device';

/** Consecutive clean polls (~1.5 s each) before a loss episode is declared over. */
export const CLEAR_AFTER_POLLS = 20;

/** Drop total on the previous status poll; null until the first poll lands. */
export const lastDropTotal = signal<number | null>(null);
/** Packets dropped during the current loss episode. */
export const episodeDrops = signal(0);
/** Consecutive polls without new drops since the episode started. */
export const cleanPolls = signal(0);

export const lossCalloutVisible = computed(
  () => episodeDrops.value > 0 && !setupMode.value && status.value !== null,
);

// The effect tracks only the status poll; the bookkeeping signals are peeked
// so writing them back does not cycle the effect.
effect(() => {
  const s = status.value;
  if (!s) return;
  const total = s.metrics.queue_drops_total + s.metrics.stale_drops_total;
  const last = lastDropTotal.peek();
  lastDropTotal.value = total;
  // First sample, or a counter that shrank (the device rebooted): nothing to
  // charge to an episode — boot-window drops are already behind us.
  if (last === null || total < last) return;
  if (total > last) {
    episodeDrops.value = episodeDrops.peek() + (total - last);
    cleanPolls.value = 0;
  } else if (episodeDrops.peek() > 0) {
    const clean = cleanPolls.peek() + 1;
    if (clean >= CLEAR_AFTER_POLLS) {
      episodeDrops.value = 0;
      cleanPolls.value = 0;
    } else {
      cleanPolls.value = clean;
    }
  }
});

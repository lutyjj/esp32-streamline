/**
 * Clip-callout policy: surface recorded clipping on a provisioned device
 * until the user dismisses it. A clip-counter reset (the levels were re-set)
 * re-arms the callout, because clipping after that is news again.
 */

import { computed, effect, signal } from '@preact/signals';
import { setupMode, status } from './device';

/** True while the user has dismissed the callout for the current counter run. */
export const clipDismissed = signal(false);

export const clipCalloutVisible = computed(() => {
  const s = status.value;
  if (!s || setupMode.value) return false;
  return s.metrics.clipped_samples_total > 0 && !clipDismissed.value;
});

export function dismissClipCallout(): void {
  clipDismissed.value = true;
}

/** Clip count on the previous status, to notice the counter resetting. */
let lastClips = 0;

effect(() => {
  const clips = status.value?.metrics.clipped_samples_total ?? 0;
  if (clips < lastClips) clipDismissed.value = false;
  lastClips = clips;
});

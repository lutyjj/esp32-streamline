/**
 * What the audio is doing now, as one word every surface shares. Input
 * activity, transmission and bridge reception are separate facts: `sending`
 * means bytes left the device between two reads, nothing more.
 */

import { computed } from '@preact/signals';
import { audioMoving, connection, liveStatus } from './device';
import { blockingHealth } from './health';

export type AudioActivity =
  /** Nothing has answered yet. */
  | 'opening'
  /** Contact is lost or a restart is under way, so no live fact holds. */
  | 'unavailable'
  /** On its setup network, where capture does not run. */
  | 'setup'
  /** A startup check failed, such as a codec that did not answer. */
  | 'fault'
  /** Capture runs with nowhere to send it. */
  | 'no-bridge'
  /** Streaming was paused from a console, a button or the API. */
  | 'paused'
  /** The input is silent; the device sends silence records instead. */
  | 'quiet'
  /** Audio plays but no bytes have left for the bridge since the last read. */
  | 'connecting'
  | 'sending';

export const audioActivity = computed<AudioActivity>(() => {
  if (connection.value.phase === 'opening') return 'opening';
  const s = liveStatus.value;
  if (!s) return 'unavailable';
  if (s.mode !== 'provisioned') return 'setup';
  if (blockingHealth.value) return 'fault';
  if (!s.target.target_host) return 'no-bridge';
  if (!s.stream.enabled) return 'paused';
  if (!s.metrics.playing) return 'quiet';
  return audioMoving.value ? 'sending' : 'connecting';
});

/**
 * How a source reaches the bridge and its players, in words. The quality
 * target is the console's (docs/pcm-protocol.md#quality-measurements): at
 * most one missing interval, no underrun and no interruption in a full
 * minute of observed audio.
 */

import type { StatusTone } from 'linen';
import type { SourceSnapshot } from '../../generated/bridge';

/** The share of a player's queue past which it is falling behind. */
const PLAYER_QUEUE_PRESSURE = 0.75;

export interface Reading {
  tone: StatusTone;
  label: string;
}

/** The source's lifecycle state, for a list row or a screen's head. */
export function sourceState(source: SourceSnapshot): Reading {
  switch (source.lifecycle.state) {
    case 'connected':
      return { tone: 'positive', label: source.signal === 'absent' ? 'Quiet input' : 'Receiving' };
    case 'http-selected':
      return { tone: 'neutral', label: 'Waiting for the device' };
    case 'pending':
    case 'allowlisted':
      return { tone: 'neutral', label: 'Not connected yet' };
    case 'disconnected':
      return { tone: 'warn', label: 'Disconnected' };
  }
}

/** Whether the last minute met the quality target, or why it cannot say. */
export function quality(source: SourceSnapshot): Reading {
  const window = source.quality;
  if (window.missing_packets > 1 || window.underruns || window.disconnects)
    return { tone: 'warn', label: 'Target not met' };
  if (source.lifecycle.state !== 'connected' || source.buffer_ready_at === null)
    return { tone: 'unknown', label: 'Waiting for a stream' };
  if (window.observed_seconds < window.window_seconds)
    return {
      tone: 'unknown',
      label: `Measuring, ${Math.floor(window.observed_seconds)} of ${window.window_seconds} s`,
    };
  if (window.audio_packets === 0) return { tone: 'neutral', label: 'Quiet input, not measured' };
  return { tone: 'positive', label: 'Target met' };
}

/** What reception means for listening now, and what to do about it. */
export function receptionAdvice(source: SourceSnapshot): string {
  const window = source.quality;
  if (
    source.client_streams.some(
      (client) => client.queue_depth >= source.client_buffer_chunks * PLAYER_QUEUE_PRESSURE,
    )
  )
    return 'A player is falling behind. Check its connection or reconnect it.';
  if (window.missing_packets || window.late_packets || window.underruns)
    return 'Playback had gaps in the last minute. The device’s diagnostics show whether capture, its queue or the network caused them.';
  if (window.disconnects) return 'The device’s connection dropped in the last minute.';
  if (source.lifecycle.state !== 'connected')
    return 'Waiting for the device. Check that it streams to this bridge.';
  if (source.buffer_ready_at === null) return 'Buffering audio before players get it.';
  if (window.audio_packets === 0 && window.silence_packets > 0)
    return 'The device reports a quiet input. Silence it marks is not lost audio.';
  return source.clients
    ? 'Players are receiving it. Only a player can confirm the sound.'
    : 'Ready for a player.';
}

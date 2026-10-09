import type { SourceSnapshot } from '../generated/bridge';

const PLAYER_QUEUE_PRESSURE = 0.75;

/** Current queue pressure and changes since the last observation explain delivery. */
export function receptionSummary(current: SourceSnapshot, previous?: SourceSnapshot): string {
  const comparable = previous && previous.started_at === current.started_at;
  if (
    current.client_streams.some(
      (client) => client.queue_depth >= current.client_buffer_chunks * PLAYER_QUEUE_PRESSURE,
    ) ||
    (comparable &&
      (current.client_queue_drops > previous.client_queue_drops ||
        current.slow_clients > previous.slow_clients))
  ) {
    return 'A player is falling behind. Check its connection or reconnect the player.';
  }
  const quality = current.quality;
  if (quality.missing_packets || quality.late_packets || quality.underruns) {
    return 'Playback gaps in the last minute. Check capture, queue, and connection diagnostics.';
  }
  if (quality.disconnects) {
    return 'The device connection was interrupted in the last minute.';
  }
  if (current.buffer_ready_at === null && current.lifecycle.state === 'connected')
    return 'Buffering audio before sending it to players.';
  if (current.lifecycle.state !== 'connected')
    return 'Waiting for this device. Play its source and check its connection if audio does not arrive.';
  if (quality.observed_seconds < quality.window_seconds)
    return 'Measuring reception. A full minute of observations is not available yet.';
  if (quality.audio_packets === 0 && quality.silence_packets > 0)
    return 'The device reports a quiet input. Intentional silence is not packet loss.';
  return current.clients
    ? 'Audio is available to connected players. Check your player to confirm sound.'
    : 'Ready for a player. Copy the stream address to begin listening.';
}

/** The gate applies to observed playout intervals, not inferred Wi-Fi packet loss. */
export function qualitySummary(source: SourceSnapshot): string {
  const q = source.quality;
  if (q.missing_packets > 1 || q.underruns || q.disconnects) return 'Quality target not met';
  if (source.lifecycle.state !== 'connected' || source.buffer_ready_at === null)
    return 'Waiting for a stream';
  if (q.observed_seconds < q.window_seconds)
    return `Measuring (${Math.floor(q.observed_seconds)} / ${q.window_seconds} seconds)`;
  if (q.audio_packets === 0) return 'Quiet input; audio quality not measured';
  return 'Quality target met';
}

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
  if (
    comparable &&
    (current.concealed > previous.concealed ||
      current.underruns > previous.underruns ||
      current.late > previous.late)
  ) {
    return 'Audio gaps detected. Check the device’s Wi-Fi and its connection to the bridge.';
  }
  if (current.buffer_ready_at === null && current.lifecycle.state === 'connected')
    return 'Buffering audio before sending it to players.';
  if (current.lifecycle.state !== 'connected')
    return 'Waiting for this device. Play its source and check its connection if audio does not arrive.';
  return current.clients
    ? 'Audio is available to connected players. Check your player to confirm sound.'
    : 'Ready for a player. Copy the stream address to begin listening.';
}

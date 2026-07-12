import { render } from 'preact';
import { describe, expect, it } from 'vitest';
import { SourceCard } from '../src/bridge/BridgeApp';
import type { SourceSnapshot } from '../src/generated/bridge';

function source(rms: number): SourceSnapshot {
  return {
    packets: 1,
    lost: 0,
    concealed: 0,
    late: 0,
    reordered: 0,
    duplicate: 0,
    underruns: 0,
    buffered_packets: 0,
    playout_buffer_packets: 1,
    max_outage_silence_packets: 1,
    bytes: 1024,
    frames: 256,
    played_frames: 0,
    rate: 48000,
    packet_frames: 256,
    playout_seq: 1,
    last_seq: 1,
    highest_seq: 1,
    last_packet_at: 1,
    last_playout_at: null,
    buffer_ready_at: null,
    started_at: 1,
    tcp_connections: 1,
    tcp_disconnects: 0,
    tcp_errors: 0,
    uptime_seconds: 1,
    clients: 0,
    client_buffer_chunks: 4,
    client_queue_drops: 0,
    slow_clients: 0,
    client_streams: [],
    levels: { peak_left: rms, peak_right: rms, rms_left: rms, rms_right: rms },
    lifecycle: {
      state: 'connected',
      dynamic: true,
      http_clients: 0,
      recording_sessions: 0,
      idle_seconds: 0,
      eviction_idle_seconds: 300,
    },
  };
}

describe('bridge source view', () => {
  it('updates a keyed meter without replacing its card DOM node', () => {
    const host = document.createElement('div');
    render(<SourceCard ip="192.0.2.10" source={source(100)} />, host);
    const card = host.querySelector('.source-card');

    render(<SourceCard ip="192.0.2.10" source={source(10000)} />, host);

    expect(host.querySelector('.source-card')).toBe(card);
    expect(host.textContent).toContain('-10.3 / -10.3 dBFS');
  });
});
